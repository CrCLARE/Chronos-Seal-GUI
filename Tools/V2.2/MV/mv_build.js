#!/usr/bin/env node
/**
 * Chronos Seal - MV Plugin Generator (Multi-Shell)
 *
 * 由 GUI 主进程调用。也可单独 CLI 运行：
 *   node mv_build.js --shell <1-5> --name <n> --version <v> --date <d> --seed <hex> --salt <n>
 *
 * 输出:
 *   - www/js/plugins/<ShellName>.js   插件
 *   - encrypt_config.json              加密工具输入
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = 'CLARE_Shell.mv.tmpl';
const OUTPUT_DIR = path.join('www', 'js', 'plugins');
const OUTPUT_CONFIG = 'encrypt_config.json';

const LOG = '[MVBuild]';
function logInfo(m)  { console.log(LOG + ' [INFO] ' + m); }
function logError(m) { console.error(LOG + ' [ERROR] ' + m); }

// ============================================================
// Shell definitions
// ============================================================

const SHELLS = {
    '1': {
        name: 'CLARE_LocalizationCore',
        header: `//=============================================================================
// CLARE_LocalizationCore.js
//=============================================================================
/*:
 * @plugindesc v1.1.4 Multi-language core with lazy loading.
 * @author CLARE
 * @target MV
 * @url https://crclare.top
 *
 * @param DefaultLocale
 * @text Default Locale
 * @desc Locale code used when none is set by the player.
 * @default en
 * @type string
 *
 * @param FallbackLocale
 * @text Fallback Locale
 * @desc Locale code used when a key is missing in the active locale.
 * @default en
 * @type string
 *
 * @help
 * CLARE_LocalizationCore
 *
 * Minimal multi-language layer with lazy loading support.
 */`
    },
    '2': {
        name: 'CLARE_ImageCache',
        header: `//=============================================================================
// CLARE_ImageCache.js
//=============================================================================
/*:
 * @plugindesc v1.0.4 Bitmap & audio LRU cache with memory guard.
 * @author CLARE
 * @target MV
 * @url https://crclare.top
 *
 * @param BitmapCacheSize
 * @text Bitmap Cache Size
 * @desc Maximum number of decoded bitmaps kept in memory.
 * @default 150
 * @type number
 *
 * @param AudioCacheSize
 * @text Audio Cache Size
 * @desc Maximum number of decoded audio buffers kept in memory.
 * @default 30
 * @type number
 *
 * @help
 * CLARE_ImageCache
 *
 * Provides an LRU cache for decoded bitmaps and audio buffers.
 */`
    },
    '3': {
        name: 'CLARE_AssetPreloader',
        header: `//=============================================================================
// CLARE_AssetPreloader.js
//=============================================================================
/*:
 * @plugindesc v1.0.7 Background asset preloader with priority scheduling.
 * @author CLARE
 * @target MV
 * @url https://crclare.top
 *
 * @param MaxConcurrent
 * @text Max Concurrent Tasks
 * @desc Maximum number of preload tasks running in parallel.
 * @default 4
 * @type number
 *
 * @param PriorityThreshold
 * @text Priority Threshold
 * @desc Resources above this size (KB) are deprioritized.
 * @default 512
 * @type number
 *
 * @help
 * CLARE_AssetPreloader
 *
 * Preloads frequently-used assets during idle time.
 */`
    },
    '4': {
        name: 'CLARE_SaveIntegrity',
        header: `//=============================================================================
// CLARE_SaveIntegrity.js
//=============================================================================
/*:
 * @plugindesc v1.2.1 Save slot integrity protection layer.
 * @author CLARE
 * @target MV
 * @url https://crclare.top
 *
 * @param EnableSigning
 * @text Enable Slot Signing
 * @desc Attach a signature to every save slot write.
 * @default true
 * @type boolean
 *
 * @param BackupSlots
 * @text Backup Slot Count
 * @desc Number of rolling backup copies kept per slot.
 * @default 3
 * @type number
 *
 * @help
 * CLARE_SaveIntegrity
 *
 * Protects save slots from manual tampering.
 */`
    },
    '5': {
        name: 'CLARE_DLCManager',
        header: `//=============================================================================
// CLARE_DLCManager.js
//=============================================================================
/*:
 * @plugindesc v1.0.9 Downloadable content loader with dependency resolution.
 * @author CLARE
 * @target MV
 * @url https://crclare.top
 *
 * @param DlcRoot
 * @text DLC Root Directory
 * @desc Directory scanned for installed content packs.
 * @default dlc
 * @type string
 *
 * @param AutoUpdate
 * @text Auto Update Check
 * @desc Periodically check for content pack updates.
 * @default true
 * @type boolean
 *
 * @help
 * CLARE_DLCManager
 *
 * Loads external content packs from a configurable directory.
 */`
    }
};

// ============================================================
// Utilities
// ============================================================

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--shell'   && i + 1 < argv.length) out.shell = argv[++i];
        else if (a === '--name'    && i + 1 < argv.length) out.name = argv[++i];
        else if (a === '--version' && i + 1 < argv.length) out.version = argv[++i];
        else if (a === '--date'    && i + 1 < argv.length) out.date = argv[++i];
        else if (a === '--seed'    && i + 1 < argv.length) out.seed = argv[++i];
        else if (a === '--salt'    && i + 1 < argv.length) out.salt = argv[++i];
    }
    return out;
}

function escapeJs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function ensureDir(p) {
    const d = path.dirname(p);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ============================================================
// Main
// ============================================================

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.shell || !SHELLS[args.shell]) {
        logError('Invalid or missing --shell (1-5)');
        process.exit(1);
    }

    if (!args.version || !args.date || !args.seed || !args.salt) {
        logError('Missing required arguments');
        logError('Usage: node mv_build.js --shell <1-5> --name <n> --version <v> --date <d> --seed <hex> --salt <n>');
        process.exit(1);
    }

    if (!/^[0-9a-fA-F]+$/.test(args.seed)) {
        logError('Seed must be hex string');
        process.exit(1);
    }

    if (!fs.existsSync(TEMPLATE)) {
        logError('Template not found: ' + TEMPLATE);
        process.exit(1);
    }

    const shell = SHELLS[args.shell];
    logInfo('Shell: ' + shell.name);

    // ★ 进度标记：开始
    console.log('[CS_PROGRESS] 0');
    console.log('[CS_STEP] 2');

    // 1. 读模板
    let tmpl = fs.readFileSync(TEMPLATE, 'utf8');

    // 2. 注入
    tmpl = tmpl.replace(/@@SHELL_HEADER@@/g, shell.header);
    tmpl = tmpl.replace(/@@PLUGIN_NAME_VALUE@@/g, '"' + escapeJs(shell.name) + '"');
    tmpl = tmpl.replace(/@@GAME_VERSION_VALUE@@/g, '"' + escapeJs(args.version) + '"');
    tmpl = tmpl.replace(/@@RELEASE_DATE_VALUE@@/g, '"' + escapeJs(args.date) + '"');
    tmpl = tmpl.replace(/@@SEED_HEX_VALUE@@/g, '"' + escapeJs(args.seed) + '"');
    tmpl = tmpl.replace(/@@SEED_SALT_VALUE@@/g, String(parseInt(args.salt, 10) >>> 0));

    const remaining = tmpl.match(/@@[A-Z_]+@@/g);
    if (remaining) {
        logError('Unreplaced placeholders: ' + remaining.join(', '));
        console.log('[CS_ERROR] Unreplaced placeholders');
        process.exit(1);
    }

    // ★ 进度标记：写入前
    console.log('[CS_PROGRESS] 50');

    // 3. 写插件
    const outputPath = path.join(OUTPUT_DIR, shell.name + '.js');
    ensureDir(outputPath);
    fs.writeFileSync(outputPath, tmpl, 'utf8');

    // 4. 写 encrypt_config.json
    const config = {
        gameName: args.name || '',
        version: args.version,
        date: args.date,
        seed: args.seed,
        seedSalt: parseInt(args.salt, 10) >>> 0
    };
    fs.writeFileSync(OUTPUT_CONFIG,
        Buffer.from(JSON.stringify(config, null, 2), 'utf8'));

    logInfo('Plugin:  ' + outputPath + ' (' + fs.statSync(outputPath).size + ' bytes)');
    logInfo('Config:  ' + OUTPUT_CONFIG);
    logInfo('Version: ' + args.version);
    logInfo('Date:    ' + args.date);
    logInfo('Seed:    ' + args.seed.slice(0, 16) + '...');
    logInfo('Salt:    ' + args.salt);

    // ★ 进度标记：完成
    console.log('[CS_PROGRESS] 100');
}

main();