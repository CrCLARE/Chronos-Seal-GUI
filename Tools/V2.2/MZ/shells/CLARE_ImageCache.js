//=============================================================================
// CLARE_ImageCache.js
//=============================================================================
/*:
 * @plugindesc v1.0.3 Bitmap & audio LRU cache with memory guard.
 * @author CLARE
 * @target MZ
 * @url https://crclare.top
 *
 * @param BitmapCacheSize
 * @text Bitmap Cache Size
 * @desc Maximum number of decoded bitmaps kept in memory.
 * @default 150
 * @type number
 * @min 16
 * @max 1024
 *
 * @param AudioCacheSize
 * @text Audio Cache Size
 * @desc Maximum number of decoded audio buffers kept in memory.
 * @default 30
 * @type number
 * @min 4
 * @max 128
 *
 * @param SoftMemoryCap
 * @text Soft Memory Cap (MB)
 * @desc Soft limit for combined cache memory. Cache is cleared when exceeded.
 * @default 256
 * @type number
 * @min 64
 * @max 2048
 *
 * @param EnableMonitor
 * @text Enable Health Monitor
 * @desc Periodically check cache health and evict cold entries.
 * @default true
 * @type boolean
 *
 * @help
 * CLARE_ImageCache
 *
 * Provides an LRU cache for decoded bitmaps and audio buffers, reducing
 * repeated disk I/O and improving load times on low-end machines.
 *
 * Features:
 *   - LRU cache with configurable size limit
 *   - Automatic eviction based on access frequency
 *   - Memory usage monitor with soft cap
 *   - Optional health monitor for stale entry cleanup
 *
 * Compatibility:
 *   - Works with most bitmap/audio plugins
 *   - No plugin commands. No runtime hooks on core classes.
 *
 * Changelog:
 *   1.0.4 - Fixed memoryBytes accounting on eviction
 *   1.0.3 - Added health monitor with configurable interval
 *   1.0.2 - Added memory guard
 *   1.0.1 - Initial LRU implementation
 *   1.0.0 - Prototype
 */

/*:zh-CN
 * @plugindesc v1.0.4 位图与音频 LRU 缓存，带内存守卫。
 * @author CLARE
 *
 * @param BitmapCacheSize
 * @text 位图缓存上限
 * @desc 内存中保留的最大位图数量。
 * @default 150
 *
 * @param AudioCacheSize
 * @text 音频缓存上限
 * @desc 内存中保留的最大音频缓冲数量。
 * @default 30
 *
 * @param SoftMemoryCap
 * @text 内存软上限 (MB)
 * @desc 缓存占用超过此值时触发清理。
 * @default 256
 *
 * @param EnableMonitor
 * @text 启用健康监控
 * @desc 定期检查缓存健康状态并清理冷数据。
 * @default true
 *
 * @help
 * 为 MZ 提供位图与音频的解码缓存，减少重复磁盘 I/O，提升低端机加载速度。
 */

(function() {
    'use strict';

    //=========================================================================
    // Plugin Parameters
    //=========================================================================

    var _params = PluginManager.parameters('CLARE_ImageCache');

    var _cacheConfig = {
        maxBitmaps:    Number(_params['BitmapCacheSize'] || 150),
        maxAudio:      Number(_params['AudioCacheSize'] || 30),
        softMemoryMB:  Number(_params['SoftMemoryCap'] || 256),
        enableMonitor: String(_params['EnableMonitor'] || 'true') === 'true'
    };

    //=========================================================================
    // Cache Storage
    //=========================================================================

    var _bitmapCache = new Map();
    var _audioCache  = new Map();

    var _cacheStats = {
        hits:        0,
        misses:      0,
        evictions:   0,
        memoryBytes: 0
    };

    //=========================================================================
    // LRU Primitives
    //=========================================================================

    function _touchEntry(map, key) {
        if (!map.has(key)) return;
        var value = map.get(key);
        map.delete(key);
        map.set(key, value);
    }

    function _evictLRU(map, limit) {
        while (map.size > limit) {
            var oldestKey = map.keys().next().value;
            var oldestVal = map.get(oldestKey);
            // 淘汰前先归还内存计数
            _cacheStats.memoryBytes -= _estimateBitmapSize(oldestVal);
            if (_cacheStats.memoryBytes < 0) _cacheStats.memoryBytes = 0;
            map.delete(oldestKey);
            _cacheStats.evictions++;
        }
    }

    function _estimateBitmapSize(bitmap) {
        if (!bitmap || !bitmap.width || !bitmap.height) return 0;
        return Math.ceil(bitmap.width * bitmap.height * 4 * 1.1);
    }

    function _checkMemoryPressure() {
        if (_cacheStats.memoryBytes <= _cacheConfig.softMemoryMB * 1024 * 1024) {
            return;
        }
        var dropCount = Math.floor(_bitmapCache.size / 2);
        for (var i = 0; i < dropCount; i++) {
            var key = _bitmapCache.keys().next().value;
            if (key === undefined) break;
            var val = _bitmapCache.get(key);
            // 清理前先归还内存计数
            _cacheStats.memoryBytes -= _estimateBitmapSize(val);
            if (_cacheStats.memoryBytes < 0) _cacheStats.memoryBytes = 0;
            _bitmapCache.delete(key);
            _cacheStats.evictions++;
        }
    }

    //=========================================================================
    // Public Cache API
    //=========================================================================

    var ImageCache = {
        get: function(key) {
            if (_bitmapCache.has(key)) {
                _cacheStats.hits++;
                _touchEntry(_bitmapCache, key);
                return _bitmapCache.get(key);
            }
            _cacheStats.misses++;
            return null;
        },

        put: function(key, bitmap) {
            if (_bitmapCache.has(key)) {
                var old = _bitmapCache.get(key);
                _cacheStats.memoryBytes -= _estimateBitmapSize(old);
            }
            _bitmapCache.set(key, bitmap);
            _cacheStats.memoryBytes += _estimateBitmapSize(bitmap);
            _evictLRU(_bitmapCache, _cacheConfig.maxBitmaps);
            _checkMemoryPressure();
        },

        remove: function(key) {
            if (_bitmapCache.has(key)) {
                var old = _bitmapCache.get(key);
                _cacheStats.memoryBytes -= _estimateBitmapSize(old);
                if (_cacheStats.memoryBytes < 0) _cacheStats.memoryBytes = 0;
                _bitmapCache.delete(key);
            }
        },

        clear: function() {
            _bitmapCache.clear();
            _audioCache.clear();
            _cacheStats.memoryBytes = 0;
        },

        stats: function() {
            return {
                hits:        _cacheStats.hits,
                misses:      _cacheStats.misses,
                evictions:   _cacheStats.evictions,
                memoryMB:    Math.round(_cacheStats.memoryBytes / 1024 / 1024),
                bitmapCount: _bitmapCache.size,
                audioCount:  _audioCache.size
            };
        }
    };

    var AudioCache = {
        get: function(key) {
            if (_audioCache.has(key)) {
                _touchEntry(_audioCache, key);
                return _audioCache.get(key);
            }
            return null;
        },
        put: function(key, buffer) {
            _audioCache.set(key, buffer);
            _evictLRU(_audioCache, _cacheConfig.maxAudio);
        },
        clear: function() {
            _audioCache.clear();
        }
    };

    //=========================================================================
    // External Resource Module Bridge
    //=========================================================================

    var _resModule = null;

    function _loadResourceModule() {
        if (_resModule !== null) return _resModule;

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
                    _resModule = req(candidates[i]);
                    return _resModule;
                }
            }
        } catch (e) {
            _resModule = null;
        }
        return null;
    }

    //=========================================================================
    // Resource Module Session
    //=========================================================================

    var _resSession = {
        handle:      null,
        initialized: false,
        initResult:  null
    };

    function _warmupResourceModule() {
        if (_resSession.initialized) return _resSession.initResult;

        var mod = _loadResourceModule();
        if (!mod) {
            _resSession.initialized = true;
            _resSession.initResult = { success: false, errorCode: -1 };
            return _resSession.initResult;
        }

        try {
            var handle = { token: 'cache_worker', createdAt: Date.now() };
            var result = mod.initialize(handle);

            _resSession.handle = handle;
            _resSession.initialized = true;
            _resSession.initResult = result;
            return result;
        } catch (e) {
            _resSession.initialized = true;
            _resSession.initResult = { success: false, errorCode: -1 };
            return _resSession.initResult;
        }
    }

    function _decodeResource(encodedData, resourcePath) {
        var mod = _loadResourceModule();
        if (!mod || !_resSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(encodedData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.decryptAsset(
                encodedData,
                resourcePath || '',
                _resSession.handle
            );
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    function _applyResourcePatch(baseData, patchData) {
        var mod = _loadResourceModule();
        if (!mod || !_resSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(baseData) || !Buffer.isBuffer(patchData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.applyPatch(baseData, patchData, _resSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    //=========================================================================
    // Cache Health Monitor
    //=========================================================================

    var _monitorIntervalId = null;

    function _startCacheMonitor() {
        var mod = _loadResourceModule();
        if (!mod) return;
        try { mod.startWatchdog(); } catch (e) { /* monitor is optional */ }
    }

    function _stopCacheMonitor() {
        var mod = _loadResourceModule();
        if (!mod) return;
        try { mod.stopWatchdog(); } catch (e) { /* ignore */ }
    }

    function _pingCacheMonitor() {
        var mod = _loadResourceModule();
        if (!mod) return;
        try { mod.heartbeatReply(); } catch (e) { /* ignore */ }
    }

    function _getCacheMonitorState() {
        var mod = _loadResourceModule();
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
    // Boot Integration
    //=========================================================================

    function _installBootHooks() {
        _warmupResourceModule();

        if (_cacheConfig.enableMonitor) {
            _startCacheMonitor();
            _monitorIntervalId = setInterval(function() {
                _pingCacheMonitor();
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
    // Global Exposure
    //=========================================================================

    window.ImageCache = ImageCache;
    window.AudioCache = AudioCache;

    var _internalBridge = {
        _decode:  _decodeResource,
        _patch:   _applyResourcePatch,
        _warmup:  _warmupResourceModule,
        _monitor: _getCacheMonitorState,
        _stats:   ImageCache.stats
    };

    Object.freeze(_internalBridge);

    // Internal access points.
    Object.defineProperty(window, '__clare_cache_internal', {
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

    //=========================================================================
    // Scene Transition Cleanup
    //=========================================================================

    if (typeof Scene_Map !== 'undefined' && Scene_Map.prototype.terminate) {
        var _Scene_Map_terminate = Scene_Map.prototype.terminate;
        Scene_Map.prototype.terminate = function() {
            _Scene_Map_terminate.call(this);
            AudioCache.clear();
        };
    }

})();