#!/usr/bin/env node
/**
 * Chronos Seal V2.2 - Asset Encryption Tool (MV Edition)
 *
 * 由 GUI 主进程调用，也可单独 CLI 运行。
 *
 * 支持三种模式：
 *   --scan      扫描 www/ 下的待加密资源，写 _cs_scan.txt
 *   --encrypt   加密资源，写 _cs_result.txt 和 _cs_originals.txt
 *   --verify    抽样解密验证，写 _cs_verify.txt
 *   无参数      交互式模式
 *
 * 进度协议（供 GUI 主进程解析）：
 *   [CS_PROGRESS] N     进度百分比 0-100
 *   [CS_ERROR] msg      致命错误
 *   其他 stdout 行       普通日志
 *
 * 密码学约定（必须与 MV 插件严格一致）：
 *   - 文件格式: MAGIC(8) + VERSION(1) + IV(16) + HMAC(32) + ciphertext
 *   - HMAC 覆盖 VERSION + IV + ciphertext
 *   - 种子重建: 64 hex 字符 → 32 字节，8 轮 LCG 混合
 *   - 主密钥派生: 4 层链式 HMAC
 *   - 子密钥派生: 4 层链式 HMAC（按路径）
 *   - 路径归一化: 反斜杠转正斜杠，ASCII 大写转小写
 *   - 单文件上限: 50 MB
 *
 * MV 版差异：
 *   - 种子是 64 字符 hex（不是 MZ 的 96 字符 ASCII 拼接）
 *   - verify 用内嵌 Node.js crypto 解密，不调 .node
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// 常量
// ============================================================

const ASSET_VERSION = 0x01;
const MAGIC = Buffer.from('CHRNSLSE', 'ascii');
const IV_LEN = 16;
const HMAC_LEN = 32;
const AES_KEY_LEN = 32;
const MAX_ASSET_SIZE = 50 * 1024 * 1024;

const TARGET_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif',
    '.ogg', '.m4a', '.mp3', '.wav'
];

const WWW_DIR_NAME = 'www';

const SCAN_FILE = '_cs_scan.txt';
const RESULT_FILE = '_cs_result.txt';
const VERIFY_FILE = '_cs_verify.txt';
const ORIGINALS_FILE = '_cs_originals.txt';
const BACKUP_DIR_NAME = '_source_backup';

const VERIFY_SAMPLE_MAX = 10;

const LOG_PREFIX = '[ChronosSeal-MV]';

// ============================================================
// 日志
// ============================================================

function logInfo(msg)  { console.log(LOG_PREFIX + ' [INFO] ' + msg); }
function logWarn(msg)  { console.log(LOG_PREFIX + ' [WARN] ' + msg); }
function logError(msg) { console.error(LOG_PREFIX + ' [ERROR] ' + msg); }

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
        if (c === 0x5C) {
            out += '/';
        } else if (c >= 0x41 && c <= 0x5A) {
            out += String.fromCharCode(c + 0x20);
        } else {
            out += String.fromCharCode(c);
        }
    }
    return out;
}

function toBatchPath(rootDir, fullPath) {
    const rel = path.relative(rootDir, fullPath);
    return rel.replace(/\//g, '\\');
}

function toDerivationPath(wwwRelative) {
    return normalizePath(wwwRelative);
}

// ============================================================
// 种子重建（MV 版：64 hex → 32 字节）
// ============================================================

function reconstructSeed(hexSeed, salt) {
    if (!/^[0-9a-fA-F]+$/.test(hexSeed)) {
        throw new Error('Seed must be hex string');
    }

    const buf = Buffer.from(hexSeed, 'hex');

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

    return crypto.createHmac('sha256', k3)
        .update('MASTER:FINAL').digest();
}

// ============================================================
// 子密钥派生
// ============================================================

function deriveSubKeys(masterKey, relativePath) {
    const norm = normalizePath(relativePath);

    const as1 = crypto.createHmac('sha256', masterKey)
        .update('AES:S1:' + norm).digest();
    const as2 = crypto.createHmac('sha256', masterKey)
        .update(Buffer.concat([Buffer.from('AES:S2:'), as1])).digest();
    const as3 = crypto.createHmac('sha256', as1)
        .update(Buffer.concat([Buffer.from('AES:S3:'), as2])).digest();
    const aesKey = crypto.createHmac('sha256', as3)
        .update('AES:FINAL:' + norm).digest();

    const hs1 = crypto.createHmac('sha256', masterKey)
        .update('HMAC:S1:' + norm).digest();
    const hs2 = crypto.createHmac('sha256', masterKey)
        .update(Buffer.concat([Buffer.from('HMAC:S2:'), hs1])).digest();
    const hs3 = crypto.createHmac('sha256', hs1)
        .update(Buffer.concat([Buffer.from('HMAC:S3:'), hs2])).digest();
    const hmacKey = crypto.createHmac('sha256', hs3)
        .update('HMAC:FINAL:' + norm).digest();

    return { aesKey, hmacKey };
}

// ============================================================
// 单文件加密
// ============================================================

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
// 单文件解密（供 --verify 用）
// ============================================================

function decryptAsset(encodedData, relativePath, masterKey) {
    if (!Buffer.isBuffer(encodedData)) {
        return { ok: false, data: null, errCode: 63 };
    }
    if (encodedData.length < MAGIC.length + 1 + IV_LEN + HMAC_LEN) {
        return { ok: false, data: null, errCode: 63 };
    }

    for (let i = 0; i < MAGIC.length; i++) {
        if (encodedData[i] !== MAGIC[i]) {
            return { ok: false, data: null, errCode: 63 };
        }
    }
    if (encodedData[MAGIC.length] !== ASSET_VERSION) {
        return { ok: false, data: null, errCode: 63 };
    }

    let offset = MAGIC.length + 1;
    const iv = encodedData.slice(offset, offset + IV_LEN);
    offset += IV_LEN;
    const storedHmac = encodedData.slice(offset, offset + HMAC_LEN);
    offset += HMAC_LEN;
    const ciphertext = encodedData.slice(offset);

    const { aesKey, hmacKey } = deriveSubKeys(masterKey, relativePath);

    const hmacInput = Buffer.concat([
        Buffer.from([ASSET_VERSION]),
        iv,
        ciphertext
    ]);
    const computedHmac = crypto.createHmac('sha256', hmacKey)
        .update(hmacInput).digest();

    let diff = 0;
    for (let i = 0; i < HMAC_LEN; i++) {
        diff |= computedHmac[i] ^ storedHmac[i];
    }
    if (diff !== 0) {
        return { ok: false, data: null, errCode: 61 };
    }

    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
        return { ok: true, data: plaintext, errCode: 0 };
    } catch (e) {
        return { ok: false, data: null, errCode: 60 };
    }
}

// ============================================================
// 配置加载
// ============================================================

function loadConfig(rootDir) {
    const configPath = path.join(rootDir, 'encrypt_config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('encrypt_config.json not found');
    }

    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        throw new Error('encrypt_config.json parse failed: ' + e.message);
    }

    const required = ['seed', 'seedSalt', 'version', 'date'];
    for (const field of required) {
        if (cfg[field] === undefined || cfg[field] === null) {
            throw new Error('encrypt_config.json missing field: ' + field);
        }
    }

    if (!/^[0-9a-fA-F]+$/.test(cfg.seed)) {
        throw new Error('encrypt_config.json seed must be hex');
    }

    return cfg;
}

// ============================================================
// 文件扫描
// ============================================================

function shouldEncrypt(fullPath) {
    if (fullPath.endsWith('.enc')) return false;

    const ext = path.extname(fullPath).toLowerCase();
    if (TARGET_EXTENSIONS.indexOf(ext) < 0) return false;

    if (fs.existsSync(fullPath + '.enc')) return false;

    return true;
}

function walkDir(dir, results) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkDir(fullPath, results);
        } else if (entry.isFile()) {
            if (shouldEncrypt(fullPath)) {
                results.push(fullPath);
            }
        }
    }
}

function scanAssets(rootDir) {
    const wwwDir = path.join(rootDir, WWW_DIR_NAME);
    if (!fs.existsSync(wwwDir)) {
        throw new Error(WWW_DIR_NAME + '/ not found');
    }

    const results = [];
    walkDir(wwwDir, results);
    return results;
}

// ============================================================
// 模式：--scan
// ============================================================

function modeScan() {
    const rootDir = process.cwd();

    logInfo('Scanning ' + WWW_DIR_NAME + '/ for asset files...');
    emitProgress(0);

    let files;
    try {
        files = scanAssets(rootDir);
    } catch (e) {
        logError(e.message);
        emitError(e.message);
        process.exit(1);
    }

    logInfo('Found ' + files.length + ' candidate file(s).');

    const scanPath = path.join(rootDir, SCAN_FILE);
    fs.writeFileSync(scanPath, String(files.length), 'utf8');
    logInfo('Scan result written to ' + SCAN_FILE + '.');

    emitProgress(100);
    process.exit(0);
}

// ============================================================
// 模式：--encrypt
// ============================================================

function modeEncrypt() {
    const rootDir = process.cwd();

    emitProgress(0);

    let cfg;
    try {
        cfg = loadConfig(rootDir);
    } catch (e) {
        logError(e.message);
        emitError(e.message);
        process.exit(1);
    }

    logInfo('Game: ' + (cfg.gameName || '(unnamed)'));
    logInfo('Version: ' + cfg.version);
    logInfo('Date: ' + cfg.date);
    logInfo('Seed length: ' + cfg.seed.length + ' hex chars');

    let masterKey;
    try {
        const seedBuf = reconstructSeed(cfg.seed, cfg.seedSalt);
        logInfo('Seed buffer: ' + seedBuf.length + ' bytes');
        masterKey = deriveMasterKey(seedBuf, cfg.version, cfg.date);
    } catch (e) {
        logError('Key derivation failed: ' + e.message);
        emitError('Key derivation failed');
        process.exit(1);
    }

    const fingerprint = crypto.createHash('sha256')
        .update(masterKey).digest('hex').slice(0, 16);
    logInfo('Master key fingerprint: ' + fingerprint);

    emitProgress(5);

    let files;
    try {
        files = scanAssets(rootDir);
    } catch (e) {
        logError(e.message);
        emitError(e.message);
        process.exit(1);
    }

    if (files.length === 0) {
        logWarn('No files to encrypt.');
        fs.writeFileSync(path.join(rootDir, RESULT_FILE), '0,0', 'utf8');
        fs.writeFileSync(path.join(rootDir, ORIGINALS_FILE), '', 'utf8');
        emitProgress(100);
        process.exit(0);
    }

    logInfo('Encrypting ' + files.length + ' file(s)...');

    const wwwDir = path.join(rootDir, WWW_DIR_NAME);
    const originals = [];
    let success = 0;
    let fail = 0;

    const progressStep = files.length >= 100
        ? 100
        : Math.max(1, Math.floor(files.length / 10));

    // ★ 记录上次上报的百分比，只在变化时上报
    let lastPercent = -1;

    for (const fullPath of files) {
        const wwwRel = path.relative(wwwDir, fullPath).replace(/\\/g, '/');
        const batchRel = toBatchPath(rootDir, fullPath);

        try {
            const plaintext = fs.readFileSync(fullPath);
            const encrypted = encryptAsset(plaintext, wwwRel, masterKey);

            const encPath = fullPath + '.enc';
            fs.writeFileSync(encPath, encrypted);

            originals.push(batchRel);
            success++;

            if (success % progressStep === 0 && success < files.length) {
                logInfo('Encrypted ' + success + '/' + files.length);
            }

            // ★ 进度上报（阶段 5-80）
            const percent = 5 + Math.round((success / files.length) * 75);
            if (percent !== lastPercent) {
                lastPercent = percent;
                emitProgress(percent);
            }
        } catch (e) {
            fail++;
            logError('Failed: ' + wwwRel + ' - ' + e.message);
        }
    }

    logInfo('Encrypted ' + success + '/' + files.length + ' file(s).');

    // ============================================================
    // 备份原始文件（阶段 80-90）
    // ============================================================
    if (originals.length > 0) {
        const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
        logInfo('Backing up original assets to ' + BACKUP_DIR_NAME + '/...');

        let backupCount = 0;
        let backupLastPercent = -1;

        for (const rel of originals) {
            const src = path.join(rootDir, rel);
            const dst = path.join(backupDir, rel);

            try {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);
                backupCount++;

                const bp = 80 + Math.round((backupCount / originals.length) * 10);
                if (bp !== backupLastPercent) {
                    backupLastPercent = bp;
                    emitProgress(bp);
                }
            } catch (e) {
                logError('Backup failed for: ' + rel + ' - ' + e.message);
                emitError('Backup failed: ' + rel);
                process.exit(1);
            }
        }

        if (backupCount !== originals.length) {
            logError('Backup incomplete: expected ' + originals.length +
                ', got ' + backupCount);
            emitError('Backup incomplete');
            process.exit(1);
        }

        logInfo('Source backup written to ' + BACKUP_DIR_NAME + '/ (' +
            backupCount + ' file(s)).');
    }

    fs.writeFileSync(path.join(rootDir, RESULT_FILE),
        success + ',' + fail, 'utf8');
    fs.writeFileSync(path.join(rootDir, ORIGINALS_FILE),
        originals.join('\r\n'), 'utf8');

    logInfo('Result written to ' + RESULT_FILE + '.');
    logInfo('Original file list written to ' + ORIGINALS_FILE + '.');

    if (fail > 0) {
        emitError(fail + ' file(s) failed');
        process.exit(1);
    }

    emitProgress(100);
    process.exit(0);
}

// ============================================================
// 模式：--verify
// ============================================================

function modeVerify() {
    const rootDir = process.cwd();

    emitProgress(0);

    let cfg;
    try {
        cfg = loadConfig(rootDir);
    } catch (e) {
        logError(e.message);
        emitError(e.message);
        process.exit(1);
    }

    let masterKey;
    try {
        const seedBuf = reconstructSeed(cfg.seed, cfg.seedSalt);
        masterKey = deriveMasterKey(seedBuf, cfg.version, cfg.date);
    } catch (e) {
        logError('Key derivation failed: ' + e.message);
        emitError('Key derivation failed');
        process.exit(1);
    }

    const originalsPath = path.join(rootDir, ORIGINALS_FILE);
    if (!fs.existsSync(originalsPath)) {
        logError('Original file list not found: ' + ORIGINALS_FILE);
        emitError('Original file list not found');
        process.exit(1);
    }

    const raw = fs.readFileSync(originalsPath, 'utf8');
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);

    if (lines.length === 0) {
        logWarn('No original files listed. Skipping verification.');
        fs.writeFileSync(path.join(rootDir, VERIFY_FILE), '0/0 passed', 'utf8');
        emitProgress(100);
        process.exit(0);
    }

    const sampleCount = Math.min(VERIFY_SAMPLE_MAX, lines.length);
    logInfo('Verifying ' + sampleCount + ' of ' + lines.length + ' file(s)...');

    let indices;
    if (sampleCount >= lines.length) {
        indices = [];
        for (let i = 0; i < lines.length; i++) indices.push(i);
    } else {
        indices = [0];
        if (sampleCount > 1) {
            const pool = new Set();
            while (pool.size < sampleCount - 1) {
                const idx = 1 + Math.floor(Math.random() * (lines.length - 1));
                pool.add(idx);
            }
            for (const idx of pool) indices.push(idx);
        }
    }

    const wwwDir = path.join(rootDir, WWW_DIR_NAME);
    let passed = 0;
    let lastPercent = -1;

    for (const idx of indices) {
        const batchRel = lines[idx];
        const fullPath = path.join(rootDir, batchRel);
        const encPath = fullPath + '.enc';

        if (!fs.existsSync(fullPath)) {
            logError('Original missing: ' + batchRel);
            emitError('Original missing: ' + batchRel);
            process.exit(1);
        }
        if (!fs.existsSync(encPath)) {
            logError('Encrypted missing: ' + batchRel + '.enc');
            emitError('Encrypted missing: ' + batchRel);
            process.exit(1);
        }

        const wwwRel = path.relative(wwwDir, fullPath).replace(/\\/g, '/');
        const derivationPath = toDerivationPath(wwwRel);

        logInfo('Verifying [' + (passed + 1) + '/' + indices.length + ']: ' + wwwRel);

        try {
            const encrypted = fs.readFileSync(encPath);
            const result = decryptAsset(encrypted, derivationPath, masterKey);

            if (!result || !result.ok || !result.data) {
                logError('  Decrypt failed, errCode=' +
                    (result ? result.errCode : 'unknown'));
                emitError('Decrypt failed');
                process.exit(1);
            }

            const original = fs.readFileSync(fullPath);
            const hashA = crypto.createHash('sha256').update(original).digest('hex');
            const hashB = crypto.createHash('sha256').update(result.data).digest('hex');

            if (hashA !== hashB) {
                logError('  Hash mismatch.');
                logError('    Original: ' + hashA);
                logError('    Decrypted: ' + hashB);
                emitError('Hash mismatch');
                process.exit(1);
            }

            logInfo('  Decrypt OK, hash match.');
            passed++;

            const percent = Math.round((passed / indices.length) * 100);
            if (percent !== lastPercent) {
                lastPercent = percent;
                emitProgress(percent);
            }
        } catch (e) {
            logError('  Exception: ' + e.message);
            emitError('Verify exception');
            process.exit(1);
        }
    }

    logInfo('All ' + passed + ' sample(s) verified.');

    fs.writeFileSync(path.join(rootDir, VERIFY_FILE),
        passed + '/' + indices.length + ' passed', 'utf8');

    emitProgress(100);
    process.exit(0);
}

// ============================================================
// 交互模式
// ============================================================

function modeInteractive() {
    console.log('');
    console.log('Chronos Seal V2.2 - MV Asset Encryption Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node encrypt_assets_mv.js --scan      Scan for asset files');
    console.log('  node encrypt_assets_mv.js --encrypt   Encrypt all assets');
    console.log('  node encrypt_assets_mv.js --verify    Verify encrypted assets');
    console.log('');
    console.log('For guided operation, run through the GUI instead.');
    console.log('');
    process.exit(0);
}

// ============================================================
// 入口
// ============================================================

function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) return modeInteractive();
    if (args.indexOf('--scan') >= 0) return modeScan();
    if (args.indexOf('--encrypt') >= 0) return modeEncrypt();
    if (args.indexOf('--verify') >= 0) return modeVerify();
    if (args.indexOf('--help') >= 0 || args.indexOf('-h') >= 0) return modeInteractive();

    logError('Unknown mode: ' + args.join(' '));
    emitError('Unknown mode');
    process.exit(1);
}

main();