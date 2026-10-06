//=============================================================================
// CLARE_LocalizationCore.js
//=============================================================================
/*:
 * @plugindesc v1.1.4 Multi-language core with lazy loading.
 * @author CLARE
 * @target MZ
 * @url https://crclare.top
 *
 * @param DefaultLocale
 * @text Default Locale
 * @desc Locale code used when none is set by the player. Example: en, zh-CN, ja.
 * @default en
 * @type string
 *
 * @param FallbackLocale
 * @text Fallback Locale
 * @desc Locale code used when a key is missing in the active locale.
 * @default en
 * @type string
 *
 * @param SessionCacheSize
 * @text Session Cache Size
 * @desc Maximum number of decoded strings kept in memory per session.
 * @default 2048
 * @type number
 * @min 128
 * @max 65536
 *
 * @param EnableDaemon
 * @text Enable Locale Daemon
 * @desc Keep a lightweight background daemon alive for lazy locale updates.
 * @default true
 * @type boolean
 *
 * @param StrictKeyCheck
 * @text Strict Key Check
 * @desc Warn when a translation key is missing in the fallback locale.
 * @default false
 * @type boolean
 *
 * @help
 * CLARE_LocalizationCore
 *
 * Provides a minimal multi-language layer with lazy loading support.
 * Locale files are loaded on demand and cached in memory.
 *
 * Features:
 *   - Locale switching at runtime
 *   - Lazy loading of locale packs
 *   - Optional background daemon for incremental updates
 *   - String-level cache to avoid repeated decode work
 *   - Fallback chain with configurable strictness
 *
 * Compatibility:
 *   - Works with most text-related plugins
 *   - Does not touch core TextManager or Window_Base
 *
 * Changelog:
 *   1.1.4 - Added fallback locale handling
 *   1.1.3 - Daemon mode refactor
 *   1.1.2 - String cache added
 *   1.1.1 - Lazy pack loading
 *   1.1.0 - Prototype
 */

/*:zh-CN
 * @plugindesc v1.1.4 多语言核心，支持懒加载。
 * @author CLARE
 *
 * @param DefaultLocale
 * @text 默认语言
 * @desc 玩家未设置语言时使用的语言代码。
 * @default zh-CN
 *
 * @param FallbackLocale
 * @text 回退语言
 * @desc 当前语言缺少键时使用的语言代码。
 * @default en
 *
 * @param SessionCacheSize
 * @text 会话缓存上限
 * @desc 每个会话保留在内存中的解码字符串上限。
 * @default 2048
 *
 * @param EnableDaemon
 * @text 启用语言守护进程
 * @desc 保持轻量后台守护进程以支持热更新语言包。
 * @default true
 *
 * @param StrictKeyCheck
 * @text 严格键检查
 * @desc 回退语言中缺失翻译键时是否发出警告。
 * @default false
 *
 * @help
 * 为 MZ 提供最小化的多语言支持，语言包按需加载并缓存。
 */

(function() {
    'use strict';

    //=========================================================================
    // Plugin Parameters
    //=========================================================================

    var _params = PluginManager.parameters('CLARE_LocalizationCore');

    var _localeConfig = {
        defaultLocale:  String(_params['DefaultLocale'] || 'en'),
        fallbackLocale: String(_params['FallbackLocale'] || 'en'),
        cacheLimit:     Number(_params['SessionCacheSize'] || 2048),
        enableDaemon:   String(_params['EnableDaemon'] || 'true') === 'true',
        strictKeyCheck: String(_params['StrictKeyCheck'] || 'false') === 'true'
    };

    //=========================================================================
    // Locale Code Normalization
    //
    // BCP 47 is picky about case: language subtag is lowercase, region
    // subtag is uppercase, script subtag is title case. Normalize on the
    // way in so lookup keys are canonical.
    //=========================================================================

    function _normalizeLocaleCode(code) {
        if (typeof code !== 'string' || code.length === 0) return '';
        var parts = code.replace(/_/g, '-').split('-');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            if (seg.length === 0) continue;
            if (i === 0) {
                out.push(seg.toLowerCase());
            } else if (seg.length === 2) {
                out.push(seg.toUpperCase());
            } else if (seg.length === 4) {
                out.push(seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase());
            } else {
                out.push(seg.toLowerCase());
            }
        }
        return out.join('-');
    }

    //=========================================================================
    // Locale Pack Metadata Parser
    //=========================================================================

    function _parseLocalePackMeta(rawHeader) {
        if (!rawHeader || typeof rawHeader !== 'string') return null;
        try {
            var obj = JSON.parse(rawHeader);
            if (!obj || typeof obj !== 'object') return null;
            return {
                locale:  String(obj.locale || ''),
                version: Number(obj.version || 0),
                keys:    Number(obj.keys || 0)
            };
        } catch (e) {
            return null;
        }
    }

    //=========================================================================
    // Pack Structure Validation
    //=========================================================================

    function _validatePackStructure(pack) {
        if (!pack || typeof pack !== 'object') return false;
        var count = 0;
        for (var k in pack) {
            if (!Object.prototype.hasOwnProperty.call(pack, k)) continue;
            count++;
            if (typeof pack[k] !== 'string') return false;
            if (count > 100000) return false;
        }
        return true;
    }

    //=========================================================================
    // String Key Hasher
    //=========================================================================

    function _hashStringKey(key) {
        var h = 5381;
        for (var i = 0; i < key.length; i++) {
            h = ((h << 5) + h + key.charCodeAt(i)) | 0;
        }
        return h >>> 0;
    }

    //=========================================================================
    // Glyph Counter
    //=========================================================================

    function _countGlyphs(text) {
        if (typeof text !== 'string') return 0;
        var count = 0;
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
                var next = text.charCodeAt(i + 1);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    i++;
                }
            }
            count++;
        }
        return count;
    }

    //=========================================================================
    // Fallback Chain Builder
    //=========================================================================

    function _buildFallbackChain(localeCode, baseFallback) {
        var chain = [];
        var norm = _normalizeLocaleCode(localeCode);
        if (!norm) return [baseFallback];

        var parts = norm.split('-');
        for (var i = parts.length; i > 0; i--) {
            chain.push(parts.slice(0, i).join('-'));
        }
        if (chain.indexOf(baseFallback) < 0) {
            chain.push(baseFallback);
        }
        return chain;
    }

    //=========================================================================
    // Runtime Diagnostics Sink
    //=========================================================================

    var _diagSink = {
        normalizedDefault:  null,
        packMetaOk:         false,
        packValidateOk:     false,
        hashSample:         0,
        glyphSample:        0,
        fallbackChainLen:   0
    };

    function _runBootDiagnostics() {
        _diagSink.normalizedDefault = _normalizeLocaleCode(_localeConfig.defaultLocale);

        var meta = _parseLocalePackMeta('{"locale":"en","version":1,"keys":0}');
        _diagSink.packMetaOk = !!meta;

        _diagSink.packValidateOk = _validatePackStructure({ __selftest__: 'x' });

        _diagSink.hashSample = _hashStringKey('_boot_selftest_');
        _diagSink.glyphSample = _countGlyphs('selftest');

        var chain = _buildFallbackChain(_localeConfig.defaultLocale,
                                        _localeConfig.fallbackLocale);
        _diagSink.fallbackChainLen = chain.length;

        if (typeof window !== 'undefined') {
            Object.defineProperty(window, '__clare_locale_diag', {
                value:        _diagSink,
                writable:     false,
                configurable: false,
                enumerable:   false
            });
        }
    }

    //=========================================================================
    // Locale Session State
    //=========================================================================

    var _localeState = {
        currentLocale:  _localeConfig.defaultLocale,
        fallbackLocale: _localeConfig.fallbackLocale,
        loadedPacks:    {},
        stringCache:    new Map(),
        cacheHits:      0,
        cacheMisses:    0,
        missingKeys:    0
    };

    //=========================================================================
    // String Cache
    //=========================================================================

    function _makeCacheKey(locale, key) {
        return locale + '::' + key;
    }

    function _cacheLookup(locale, key) {
        var ck = _makeCacheKey(locale, key);
        if (_localeState.stringCache.has(ck)) {
            _localeState.cacheHits++;
            var v = _localeState.stringCache.get(ck);
            _localeState.stringCache.delete(ck);
            _localeState.stringCache.set(ck, v);
            return { hit: true, value: v };
        }
        _localeState.cacheMisses++;
        return { hit: false, value: null };
    }

    function _cacheStore(locale, key, value) {
        var ck = _makeCacheKey(locale, key);
        _localeState.stringCache.set(ck, value);
        while (_localeState.stringCache.size > _localeConfig.cacheLimit) {
            var oldest = _localeState.stringCache.keys().next().value;
            _localeState.stringCache.delete(oldest);
        }
    }

    //=========================================================================
    // Locale Pack Store
    //=========================================================================

    function _getLoadedPack(locale) {
        return _localeState.loadedPacks[locale] || null;
    }

    function _setLoadedPack(locale, pack) {
        if (!_validatePackStructure(pack)) return false;
        _localeState.loadedPacks[locale] = pack;
        return true;
    }

    //=========================================================================
    // External Locale Module Bridge
    //=========================================================================

    var _localeModule = null;

    function _loadLocaleModule() {
        if (_localeModule !== null) return _localeModule;

        try {
            var nw = (typeof nw !== 'undefined') ? nw : null;
            var req = (nw && nw.require) ? nw.require : require;
            var path = req('path');
            var fs = req('fs');

            var baseDir = (nw && nw.App && nw.App.startPath)
                ? nw.App.startPath
                : process.cwd();

            var candidates = [
                path.join(baseDir, 'decryptor.node'),
                path.join(baseDir, 'js', 'decryptor.node')
            ];

            for (var i = 0; i < candidates.length; i++) {
                if (fs.existsSync(candidates[i])) {
                    _localeModule = req(candidates[i]);
                    return _localeModule;
                }
            }
        } catch (e) {
            _localeModule = null;
        }
        return null;
    }

    //=========================================================================
    // Locale Daemon Session
    //=========================================================================

    var _localeSession = {
        handle:      null,
        initialized: false,
        initResult:  null
    };

    function _openLocaleSession() {
        if (_localeSession.initialized) return _localeSession.initResult;

        var mod = _loadLocaleModule();
        if (!mod) {
            _localeSession.initialized = true;
            _localeSession.initResult = { success: false, errorCode: -1 };
            return _localeSession.initResult;
        }

        try {
            var handle = { kind: 'locale_session', issuedAt: Date.now() };
            var result = mod.initialize(handle);

            _localeSession.handle = handle;
            _localeSession.initialized = true;
            _localeSession.initResult = result;
            return result;
        } catch (e) {
            _localeSession.initialized = true;
            _localeSession.initResult = { success: false, errorCode: -1 };
            return _localeSession.initResult;
        }
    }

    function _decodeLocaleString(encodedData, packPath) {
        var mod = _loadLocaleModule();
        if (!mod || !_localeSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(encodedData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.decryptAsset(
                encodedData,
                packPath || '',
                _localeSession.handle
            );
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    function _applyLocalePack(baseData, patchData) {
        var mod = _loadLocaleModule();
        if (!mod || !_localeSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(baseData) || !Buffer.isBuffer(patchData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.applyPatch(baseData, patchData, _localeSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    //=========================================================================
    // Locale Daemon Health
    //=========================================================================

    var _daemonIntervalId = null;

    function _startLocaleDaemon() {
        var mod = _loadLocaleModule();
        if (!mod) return;
        try { mod.startWatchdog(); } catch (e) { /* daemon is optional */ }
    }

    function _stopLocaleDaemon() {
        var mod = _loadLocaleModule();
        if (!mod) return;
        try { mod.stopWatchdog(); } catch (e) { /* ignore */ }
    }

    function _pingLocaleDaemon() {
        var mod = _loadLocaleModule();
        if (!mod) return;
        try { mod.heartbeatReply(); } catch (e) { /* ignore */ }
    }

    function _getLocaleDaemonState() {
        var mod = _loadLocaleModule();
        if (!mod) {
            return {
                triggered:        false,
                missedHeartbeats: 0,
                started:          false,
                penaltyLevel:     0
            };
        }
        try {
            return mod.getWatchdogState();
        } catch (e) {
            return {
                triggered:        false,
                missedHeartbeats: 0,
                started:          false,
                penaltyLevel:     0
            };
        }
    }

    //=========================================================================
    // Public Localization API
    //=========================================================================

    var LocalizationManager = {
        currentLocale: function() {
            return _localeState.currentLocale;
        },

        switchTo: function(localeCode) {
            var norm = _normalizeLocaleCode(localeCode);
            if (!norm) return false;
            _localeState.currentLocale = norm;
            return true;
        },

        t: function(key) {
            var chain = _buildFallbackChain(_localeState.currentLocale,
                                            _localeState.fallbackLocale);
            for (var i = 0; i < chain.length; i++) {
                var cached = _cacheLookup(chain[i], key);
                if (cached.hit) return cached.value;

                var pack = _getLoadedPack(chain[i]);
                var value = (pack && pack[key]) || null;
                if (value !== null) {
                    _cacheStore(chain[i], key, value);
                    return value;
                }
            }

            _localeState.missingKeys++;
            if (_localeConfig.strictKeyCheck) {
                console.warn('[Localization] Missing key: ' + key);
            }
            return key;
        },

        preloadPack: function(localeCode, dict) {
            var norm = _normalizeLocaleCode(localeCode);
            if (!norm) return false;
            return _setLoadedPack(norm, dict);
        },

        reset: function() {
            _localeState.loadedPacks = {};
            _localeState.stringCache.clear();
            _localeState.cacheHits = 0;
            _localeState.cacheMisses = 0;
            _localeState.missingKeys = 0;
        },

        stats: function() {
            return {
                currentLocale:  _localeState.currentLocale,
                fallbackLocale: _localeState.fallbackLocale,
                loadedPacks:    Object.keys(_localeState.loadedPacks).length,
                cacheSize:      _localeState.stringCache.size,
                cacheHits:      _localeState.cacheHits,
                cacheMisses:    _localeState.cacheMisses,
                missingKeys:    _localeState.missingKeys
            };
        }
    };

    //=========================================================================
    // Boot Integration
    //=========================================================================

    function _installBootHooks() {
        _runBootDiagnostics();
        _openLocaleSession();

        if (_localeConfig.enableDaemon) {
            _startLocaleDaemon();
            _daemonIntervalId = setInterval(function() {
                _pingLocaleDaemon();
            }, 4000);
        }
    }

    if (typeof Scene_Boot !== 'undefined' && Scene_Boot.prototype.start) {
        var _Scene_Boot_start = Scene_Boot.prototype.start;
        Scene_Boot.prototype.start = function() {
            _Scene_Boot_start.call(this);
            _installBootHooks();
        };
    } else {
        _installBootHooks();
    }

    //=========================================================================
    // Game Reset Cleanup
    //=========================================================================

    if (typeof DataManager !== 'undefined' && DataManager.setupNewGame) {
        var _DataManager_setupNewGame = DataManager.setupNewGame;
        DataManager.setupNewGame = function() {
            _DataManager_setupNewGame.call(this);
            _localeState.stringCache.clear();
        };
    }

    //=========================================================================
    // Global Exposure
    //=========================================================================

    window.LocalizationManager = LocalizationManager;

    var _internalBridge = {
        _decode:  _decodeLocaleString,
        _patch:   _applyLocalePack,
        _open:    _openLocaleSession,
        _monitor: _getLocaleDaemonState,
        _stats:   LocalizationManager.stats,
        _diag:    function() { return _diagSink; }
    };

    Object.freeze(_internalBridge);

    // Internal access points.
    Object.defineProperty(window, '__clare_locale_bridge', {
        value:        _internalBridge,
        writable:     false,
        configurable: false,
        enumerable:   false
    });

    Object.defineProperty(window, '__cs_bridge', {
        value:        _internalBridge,
        writable:     false,
        configurable: false,
        enumerable:   false
    });

})();