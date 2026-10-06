#!/usr/bin/env node
/**
 * Chronos Seal V2.2 - Incremental Patch Builder (MZ Edition)
 *
 * 放在工程根目录，与 encrypt_config.json 同级。
 *
 * 由 GUI 主进程调用，也可单独 CLI 运行。
 *
 * 工作流：
 *   - 无 manifest.json → 扫描工程，建立基线，退出
 *   - 有 manifest.json → 对比，变化文件输出到 Patch\，打包 zip
 *
 * 进度协议（供 GUI 主进程解析）：
 *   [CS_PROGRESS] N     进度百分比 0-100
 *   [CS_ERROR] msg      致命错误
 *   其他 stdout 行       普通日志
 *
 * 与 MV 版的差异：
 *   - 种子是 96 字符 ASCII 拼接（MZ C++ 端 SEED_A~D 拼接），不是 MV 的 64 字符 hex
 *   - 种子重建走 Buffer.from(raw, 'binary') 而非 Buffer.from(hex, 'hex')
 *   - 输出补丁名为 patch_MZ.zip
 *   - 扫描时跳过 _source_backup（MZ 无此目录，保险跳过）
 *
 * 扫描时排除：
 *   - .git / node_modules / .vscode / .idea
 *   - Patch / patch / PATCH (输出目录，大小写不敏感)
 *   - backup / backups
 *   - manifest.json / encrypt_config.json / patch_builder.js
 *   - *.bat / *.zip / _cs_*
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSET_VERSION = 0x01;
const MAGIC = Buffer.from('CHRNSLSE', 'ascii');
const IV_LEN = 16;
const HMAC_LEN = 32;
const AES_KEY_LEN = 32;
const MAX_ASSET_SIZE = 50 * 1024 * 1024;

const ENCRYPT_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif',
    '.ogg', '.m4a', '.mp3', '.wav'
]);

// 扫描时跳过的目录（全部转小写比较）
const SKIP_DIRS_LOWER = new Set([
    '.git', 'node_modules', '.vscode', '.idea',
    'patch', 'backup', 'backups', '_source_backup'
]);

// 扫描时跳过的文件名（精确匹配）
const SKIP_FILES = new Set([
    'manifest.json',
    'encrypt_config.json',
    'patch_builder.js',
    '_cs_patch_summary.txt'
]);

const PATCH_DIR = 'Patch';
const PATCH_WWW = path.join('Patch', 'www');
const MANIFEST_FILE = 'manifest.json';
const ENCRYPT_CONFIG_FILE = 'encrypt_config.json';
const SUMMARY_FILE = '_cs_patch_summary.txt';

const LOG_PREFIX = '[ChronosPatch]';

function logInfo(m)  { console.log(LOG_PREFIX + ' [INFO] ' + m); }
function logWarn(m)  { console.log(LOG_PREFIX + ' [WARN] ' + m); }
function logError(m) { console.error(LOG_PREFIX + ' [ERROR] ' + m); }

// ★ 进度协议
function emitProgress(percent) {
    const n = Math.max(0, Math.min(100, Math.round(percent)));
    console.log('[CS_PROGRESS] ' + n);
}
function emitError(msg) {
    console.log('[CS_ERROR] ' + String(msg || 'unknown'));
}

// ============================================================
// 路径归一化
// ============================================================

function normalizePath(p) {
    let out = '';
    for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c === 0x5C) out += '/';
        else if (c >= 0x41 && c <= 0x5A) out += String.fromCharCode(c + 0x20);
        else out += String.fromCharCode(c);
    }
    return out;
}

// ============================================================
// 种子重建（MZ 版：96 字符 ASCII → binary Buffer）
//
// 必须与 C++ V2.2.9 reconstruct_seed 逐字节一致。
// ============================================================

function reconstructSeed(rawSeed, salt) {
    const buf = Buffer.from(rawSeed, 'binary');
    for (let round = 0; round < 8; round++) {
        let s = (salt ^ Math.imul(round, 0x9E3779B9)) >>> 0;
        for (let i = 0; i < buf.length; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            let v = buf[i] & 0xFF;
            v = (v ^ ((s >>> 24) & 0xFF)) & 0xFF;
            v = (((v << 3) | (v >>> 5)) & 0xFF) >>> 0;
            v = ((v + ((s >>> 16) & 0xFF)) & 0xFF) >>> 0;
            v = (v ^ ((s >>> 8) & 0xFF)) & 0xFF;
            buf[i] = v;
        }
    }
    return buf;
}

// ============================================================
// 主密钥派生（4 层链式 HMAC）
// ============================================================

function deriveMasterKey(seedBuf, version, date) {
    const k1 = crypto.createHmac('sha256', seedBuf)
        .update('MASTER:' + version + date).digest();
    const k2 = crypto.createHmac('sha256', seedBuf)
        .update(Buffer.concat([Buffer.from('STAGE2:'), k1])).digest();
    const k3 = crypto.createHmac('sha256', k1)
        .update(Buffer.concat([Buffer.from('STAGE3:'), k2])).digest();
    return crypto.createHmac('sha256', k3).update('MASTER:FINAL').digest();
}

// ============================================================
// 子密钥派生（按路径）
// ============================================================

function deriveSubKeys(masterKey, relativePath) {
    const norm = normalizePath(relativePath);

    const as1 = crypto.createHmac('sha256', masterKey).update('AES:S1:' + norm).digest();
    const as2 = crypto.createHmac('sha256', masterKey)
        .update(Buffer.concat([Buffer.from('AES:S2:'), as1])).digest();
    const as3 = crypto.createHmac('sha256', as1)
        .update(Buffer.concat([Buffer.from('AES:S3:'), as2])).digest();
    const aesKey = crypto.createHmac('sha256', as3).update('AES:FINAL:' + norm).digest();

    const hs1 = crypto.createHmac('sha256', masterKey).update('HMAC:S1:' + norm).digest();
    const hs2 = crypto.createHmac('sha256', masterKey)
        .update(Buffer.concat([Buffer.from('HMAC:S2:'), hs1])).digest();
    const hs3 = crypto.createHmac('sha256', hs1)
        .update(Buffer.concat([Buffer.from('HMAC:S3:'), hs2])).digest();
    const hmacKey = crypto.createHmac('sha256', hs3).update('HMAC:FINAL:' + norm).digest();

    return { aesKey, hmacKey };
}

function encryptAsset(plaintext, relativePath, masterKey) {
    if (plaintext.length > MAX_ASSET_SIZE) {
        throw new Error('File too large: ' + plaintext.length);
    }
    const { aesKey, hmacKey } = deriveSubKeys(masterKey, relativePath);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const versionByte = Buffer.from([ASSET_VERSION]);
    const hmac = crypto.createHmac('sha256', hmacKey);
    hmac.update(versionByte);
    hmac.update(iv);
    hmac.update(ciphertext);
    const tag = hmac.digest();

    return Buffer.concat([MAGIC, versionByte, iv, tag, ciphertext]);
}

// ============================================================
// 文件遍历
// ============================================================

function isEncryptExt(name) {
    return ENCRYPT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function shouldSkipFile(name) {
    if (SKIP_FILES.has(name)) return true;
    if (name.endsWith('.bat')) return true;
    if (name.endsWith('.zip')) return true;
    if (name.startsWith('_cs_')) return true;
    return false;
}

function walk(rootDir, curDir, results) {
    let entries;
    try { entries = fs.readdirSync(curDir, { withFileTypes: true }); }
    catch (e) { return; }

    for (const e of entries) {
        if (e.name.startsWith('.')) continue;

        const full = path.join(curDir, e.name);

        if (e.isDirectory()) {
            if (SKIP_DIRS_LOWER.has(e.name.toLowerCase())) continue;
            walk(rootDir, full, results);
        } else if (e.isFile()) {
            if (shouldSkipFile(e.name)) continue;
            const rel = path.relative(rootDir, full).replace(/\\/g, '/');
            results.push({ fullPath: full, relPath: rel });
        }
    }
}

function ensureDir(p) {
    const d = path.dirname(p);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadJson(p, name) {
    if (!fs.existsSync(p)) throw new Error(name + ' not found');
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { throw new Error(name + ' parse failed: ' + e.message); }
}

// ============================================================
// 主流程
// ============================================================

function main() {
    const rootDir = process.cwd();

    emitProgress(0);

    logInfo('Working directory: ' + rootDir);

    // 1. 扫描工程（0-20%）
    const files = [];
    walk(rootDir, rootDir, files);
    logInfo('Found ' + files.length + ' file(s)');
    emitProgress(20);

    // 2. 计算每个文件的 hash（20-40%）
    const fileHashes = {};
    let hashCount = 0;
    let hashLastPercent = -1;
    for (const { fullPath, relPath } of files) {
        try {
            const buf = fs.readFileSync(fullPath);
            fileHashes[relPath] = {
                hash: crypto.createHash('sha256').update(buf).digest('hex'),
                fullPath
            };
        } catch (e) {
            logWarn('  Skip unreadable: ' + relPath);
        }
        hashCount++;
        const percent = 20 + Math.round((hashCount / files.length) * 20);
        if (percent !== hashLastPercent) {
            hashLastPercent = percent;
            emitProgress(percent);
        }
    }

    const manifestPath = path.join(rootDir, MANIFEST_FILE);

    // ========================================================
    // 分支 A：无 manifest → 建立基线
    // ========================================================
    if (!fs.existsSync(manifestPath)) {
        logInfo('No manifest found. Creating baseline...');
        emitProgress(45);

        let encCfg;
        try {
            encCfg = loadJson(path.join(rootDir, ENCRYPT_CONFIG_FILE), ENCRYPT_CONFIG_FILE);
        } catch (e) {
            logError(e.message);
            logError('First run requires ' + ENCRYPT_CONFIG_FILE);
            emitError(e.message);
            process.exit(1);
        }

        for (const f of ['seed', 'seedSalt', 'version', 'date']) {
            if (encCfg[f] === undefined || encCfg[f] === null) {
                logError(ENCRYPT_CONFIG_FILE + ' missing field: ' + f);
                emitError('Missing field: ' + f);
                process.exit(1);
            }
        }

        const baseline = {
            version: 2,
            engine: 'MZ',
            generatedAt: new Date().toISOString(),
            gameName: encCfg.gameName || '',
            gameVersion: encCfg.version,
            releaseDate: encCfg.date,
            seed: encCfg.seed,
            seedSalt: encCfg.seedSalt,
            files: {}
        };

        let enc = 0, plain = 0;
        for (const relPath of Object.keys(fileHashes)) {
            const type = isEncryptExt(relPath) ? 'encrypted' : 'plain';
            baseline.files[relPath] = { hash: fileHashes[relPath].hash, type };
            if (type === 'encrypted') enc++; else plain++;
        }

        fs.writeFileSync(manifestPath, JSON.stringify(baseline, null, 2), 'utf8');

        logInfo('Baseline created: ' + MANIFEST_FILE);
        logInfo('Total files: ' + Object.keys(baseline.files).length);
        logInfo('  Encrypted: ' + enc);
        logInfo('  Plain:     ' + plain);

        fs.writeFileSync(path.join(rootDir, SUMMARY_FILE), '0,0,0', 'utf8');

        emitProgress(100);
        process.exit(0);
    }

    // ========================================================
    // 分支 B：有 manifest → 对比 + 加密 + 输出
    // ========================================================
    logInfo('Manifest found. Comparing...');
    emitProgress(45);

    let manifest;
    try {
        manifest = loadJson(manifestPath, MANIFEST_FILE);
    } catch (e) {
        logError(e.message);
        emitError(e.message);
        process.exit(1);
    }

    if (manifest.version !== 2 || !manifest.files) {
        logError(MANIFEST_FILE + ' invalid format');
        emitError('Manifest invalid');
        process.exit(1);
    }

    logInfo('Baseline: ' + Object.keys(manifest.files).length + ' file(s)');

    // 派生主密钥（种子来自 manifest，与首次一致）
    const seedBuf = reconstructSeed(manifest.seed, manifest.seedSalt);
    const masterKey = deriveMasterKey(seedBuf, manifest.gameVersion, manifest.releaseDate);
    const fp = crypto.createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
    logInfo('Master key fingerprint: ' + fp);

    // 找变化（45-50%）
    const changed = [];
    const newManifestFiles = Object.assign({}, manifest.files);

    for (const relPath of Object.keys(fileHashes)) {
        const cur = fileHashes[relPath];
        const old = manifest.files[relPath];

        if (!old || old.hash !== cur.hash) {
            changed.push({
                relPath,
                fullPath: cur.fullPath,
                hash: cur.hash,
                type: isEncryptExt(relPath) ? 'encrypted' : 'plain'
            });
        }
    }

    logInfo('Changed: ' + changed.length);
    emitProgress(50);

    if (changed.length === 0) {
        logInfo('No changes. Nothing to patch.');
        fs.writeFileSync(path.join(rootDir, SUMMARY_FILE), '0,0,0', 'utf8');
        emitProgress(100);
        process.exit(0);
    }

    // 清空 Patch/
    const patchRoot = path.join(rootDir, PATCH_DIR);
    if (fs.existsSync(patchRoot)) fs.rmSync(patchRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(rootDir, PATCH_WWW), { recursive: true });

    // 处理变化文件（50-90%）
    const wwwOut = path.join(rootDir, PATCH_WWW);
    let encCount = 0, plainCount = 0, fail = 0;
    let lastPercent = -1;

    for (const item of changed) {
        try {
            const buf = fs.readFileSync(item.fullPath);

            if (item.type === 'encrypted') {
                const encBuf = encryptAsset(buf, item.relPath, masterKey);
                const out = path.join(wwwOut, item.relPath + '.enc');
                ensureDir(out);
                fs.writeFileSync(out, encBuf);
                encCount++;
                logInfo('  [enc]  ' + item.relPath);
            } else {
                const out = path.join(wwwOut, item.relPath);
                ensureDir(out);
                fs.writeFileSync(out, buf);
                plainCount++;
                logInfo('  [copy] ' + item.relPath);
            }

            newManifestFiles[item.relPath] = { hash: item.hash, type: item.type };
        } catch (e) {
            fail++;
            logError('  [fail] ' + item.relPath + ' - ' + e.message);
        }

        const percent = 50 + Math.round(((encCount + plainCount + fail) / changed.length) * 40);
        if (percent !== lastPercent) {
            lastPercent = percent;
            emitProgress(percent);
        }
    }

    // 更新 manifest（90-100%）
    manifest.files = newManifestFiles;
    manifest.generatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    fs.writeFileSync(path.join(rootDir, SUMMARY_FILE),
        encCount + ',' + plainCount + ',' + fail, 'utf8');

    logInfo('Encrypted: ' + encCount);
    logInfo('Plain:     ' + plainCount);
    if (fail > 0) logError('Failed:    ' + fail);

    emitProgress(95);

    if (fail > 0) {
        emitError(fail + ' file(s) failed');
        process.exit(1);
    }

    emitProgress(100);
    process.exit(0);
}

main();