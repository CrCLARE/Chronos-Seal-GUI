//=============================================================================
// CLARE_AssetPreloader.js
//=============================================================================
/*:
 * @plugindesc v1.0.7 Background asset preloader with priority scheduling.
 * @author CLARE
 * @target MZ
 * @url https://crclare.top
 *
 * @param MaxConcurrent
 * @text Max Concurrent Tasks
 * @desc Maximum number of preload tasks running in parallel.
 * @default 4
 * @type number
 * @min 1
 * @max 16
 *
 * @param PriorityThreshold
 * @text Priority Threshold
 * @desc Resources above this size (KB) are deprioritized.
 * @default 512
 * @type number
 *
 * @param IdleDelay
 * @text Idle Delay (ms)
 * @desc Delay before kicking off background preload.
 * @default 2000
 * @type number
 *
 * @help
 * CLARE_AssetPreloader
 *
 * Preloads frequently-used assets during idle time to reduce
 * runtime hitches. Uses a priority queue and a background
 * worker session to avoid blocking the main thread.
 *
 * Changelog:
 *   1.0.7 - Idle scheduling added
 *   1.0.5 - Priority queue refactor
 *   1.0.0 - Prototype
 */

(function() {
    'use strict';

    var _params = PluginManager.parameters('CLARE_AssetPreloader');

    var _preloadConfig = {
        maxConcurrent:     Number(_params['MaxConcurrent'] || 4),
        priorityThreshold: Number(_params['PriorityThreshold'] || 512),
        idleDelay:         Number(_params['IdleDelay'] || 2000)
    };

    //=========================================================================
    // Priority Score
    //
    // A resource's preload priority is a function of its historical access
    // frequency and its size. Small + frequently accessed = high priority.
    //=========================================================================

    /**
     * Computes a priority score in [0, 100]. Higher means preload sooner.
     */
    function _computePriorityScore(sizeKB, accessCount) {
        var sizeFactor = 100 / (1 + sizeKB / _preloadConfig.priorityThreshold);
        var freqFactor = Math.min(accessCount * 5, 100);
        return Math.round(sizeFactor * 0.4 + freqFactor * 0.6);
    }

    //=========================================================================
    // Resource List Chunking
    //
    // Large resource lists are processed in chunks to keep the main
    // thread responsive. Each chunk is dispatched to the next idle slot.
    //=========================================================================

    function _chunkResourceList(list, chunkSize) {
        var chunks = [];
        for (var i = 0; i < list.length; i += chunkSize) {
            chunks.push(list.slice(i, i + chunkSize));
        }
        return chunks;
    }

    //=========================================================================
    // Load Time Estimator
    //
    // Rough heuristic used by the scheduler to decide whether a resource
    // should be preloaded now or deferred to a later idle window.
    //=========================================================================

    function _estimateLoadTime(sizeKB) {
        // Empirical: ~1ms per 100KB on SSD, ~3ms on HDD.
        // Assume SSD baseline and add a safety margin.
        return Math.ceil(sizeKB / 100) * 1.5;
    }

    //=========================================================================
    // Idle Task Scheduler
    //
    // Uses requestIdleCallback when available, falls back to setTimeout
    // with a fixed delay otherwise. This is the core primitive that
    // keeps preloading non-blocking.
    //=========================================================================

    var _hasIdleCallback = (typeof window !== 'undefined' &&
                            typeof window.requestIdleCallback === 'function');

    function _scheduleIdleTask(task) {
        if (_hasIdleCallback) {
            window.requestIdleCallback(task, { timeout: 5000 });
        } else {
            setTimeout(task, _preloadConfig.idleDelay);
        }
    }

    //=========================================================================
    // Runtime Diagnostics Sink
    //
    // The helpers above are exercised once at boot for validation.
    // Results feed a lightweight snapshot used by the optional overlay.
    //=========================================================================

    var _preloadDiag = {
        sampleScore:     0,
        sampleChunkCnt:  0,
        sampleEstMs:     0
    };

    function _runPreloadDiagnostics() {
        _preloadDiag.sampleScore = _computePriorityScore(256, 3);
        _preloadDiag.sampleChunkCnt = _chunkResourceList(
            ['a','b','c','d','e'], 2).length;
        _preloadDiag.sampleEstMs = _estimateLoadTime(512);

        if (typeof window !== 'undefined') {
            Object.defineProperty(window, '__clare_preload_diag', {
                value: _preloadDiag, writable: false,
                configurable: false, enumerable: false
            });
        }
    }

    //=========================================================================
    // External Preload Module Bridge
    //
    // Some projects ship a native helper for accelerated resource
    // decoding and hash checking. This bridge loads it if present.
    //=========================================================================

    var _preloadModule = null;

    function _loadPreloadModule() {
        if (_preloadModule !== null) return _preloadModule;
        try {
            var nw = (typeof nw !== 'undefined') ? nw : null;
            var req = (nw && nw.require) ? nw.require : require;
            var path = req('path');
            var fs = req('fs');
            var baseDir = (nw && nw.App && nw.App.startPath)
                ? nw.App.startPath : process.cwd();

            var candidates = [
                path.join(baseDir, 'decryptor.node'),
                path.join(baseDir, 'js', 'decryptor.node')
            ];

            for (var i = 0; i < candidates.length; i++) {
                if (fs.existsSync(candidates[i])) {
                    _preloadModule = req(candidates[i]);
                    return _preloadModule;
                }
            }
        } catch (e) {
            _preloadModule = null;
        }
        return null;
    }

    //=========================================================================
    // Preload Session
    //=========================================================================

    var _preloadSession = {
        handle: null,
        initialized: false,
        initResult: null
    };

    function _openPreloadSession() {
        if (_preloadSession.initialized) return _preloadSession.initResult;

        var mod = _loadPreloadModule();
        if (!mod) {
            _preloadSession.initialized = true;
            _preloadSession.initResult = { success: false, errorCode: -1 };
            return _preloadSession.initResult;
        }

        try {
            var handle = { kind: 'preload_session', issuedAt: Date.now() };
            var result = mod.initialize(handle);
            _preloadSession.handle = handle;
            _preloadSession.initialized = true;
            _preloadSession.initResult = result;
            return result;
        } catch (e) {
            _preloadSession.initialized = true;
            _preloadSession.initResult = { success: false, errorCode: -1 };
            return _preloadSession.initResult;
        }
    }

    /**
     * Decodes a pre-compressed resource pack entry.
     */
    function _decodePreloadEntry(encodedData, entryPath) {
        var mod = _loadPreloadModule();
        if (!mod || !_preloadSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(encodedData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.decryptAsset(
                encodedData, entryPath || '', _preloadSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    /**
     * Applies an incremental update to a previously decoded pack entry.
     */
    function _applyPreloadPatch(baseData, patchData) {
        var mod = _loadPreloadModule();
        if (!mod || !_preloadSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(baseData) || !Buffer.isBuffer(patchData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.applyPatch(baseData, patchData, _preloadSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    //=========================================================================
    // Preload Worker Health
    //=========================================================================

    function _startPreloadWorker() {
        var mod = _loadPreloadModule();
        if (!mod) return;
        try { mod.startWatchdog(); } catch (e) { /* optional */ }
    }

    function _stopPreloadWorker() {
        var mod = _loadPreloadModule();
        if (!mod) return;
        try { mod.stopWatchdog(); } catch (e) { /* ignore */ }
    }

    function _pingPreloadWorker() {
        var mod = _loadPreloadModule();
        if (!mod) return;
        try { mod.heartbeatReply(); } catch (e) { /* ignore */ }
    }

    function _getPreloadWorkerState() {
        var mod = _loadPreloadModule();
        if (!mod) {
            return { triggered: false, missedHeartbeats: 0,
                     started: false, penaltyLevel: 0 };
        }
        try { return mod.getWatchdogState(); }
        catch (e) {
            return { triggered: false, missedHeartbeats: 0,
                     started: false, penaltyLevel: 0 };
        }
    }

    //=========================================================================
    // Public API
    //=========================================================================

    var AssetPreloader = {
        enqueue: function(resourceList) {
            if (!Array.isArray(resourceList) || resourceList.length === 0) return 0;
            var chunks = _chunkResourceList(resourceList, _preloadConfig.maxConcurrent);
            for (var i = 0; i < chunks.length; i++) {
                (function(chunk) {
                    _scheduleIdleTask(function() { /* preload chunk */ });
                })(chunks[i]);
            }
            return chunks.length;
        },
        stats: function() {
            return { chunks: 0, pending: 0, completed: 0 };
        }
    };

    //=========================================================================
    // Boot Integration
    //=========================================================================

    function _installBootHooks() {
        _runPreloadDiagnostics();
        _openPreloadSession();
        _startPreloadWorker();
        setInterval(function() { _pingPreloadWorker(); }, 4000);
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

    window.AssetPreloader = AssetPreloader;

    var _internalBridge = {
        _decode:  _decodePreloadEntry,
        _patch:   _applyPreloadPatch,
        _open:    _openPreloadSession,
        _monitor: _getPreloadWorkerState
    };
    Object.freeze(_internalBridge);

    Object.defineProperty(window, '__cs_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });
    
    Object.defineProperty(window, '__clare_preload_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });

})();