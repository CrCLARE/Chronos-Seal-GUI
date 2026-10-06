//=============================================================================
// CLARE_DLCManager.js
//=============================================================================
/*:
 * @plugindesc v1.0.9 Downloadable content loader with dependency resolution.
 * @author CLARE
 * @target MZ
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
 * @param LoadOrder
 * @text Load Order Strategy
 * @desc How to order packs when applying them.
 * @default dependency
 * @type select
 * @option dependency
 * @option alphabetical
 * @option manifest
 *
 * @help
 * CLARE_DLCManager
 *
 * Loads external content packs (expansion chapters, sound packs, skins)
 * from a configurable directory, resolves their dependencies, and applies
 * incremental updates when available.
 *
 * Changelog:
 *   1.0.9 - Dependency resolver added
 *   1.0.7 - Load order strategies
 *   1.0.0 - Initial loader
 */

(function() {
    'use strict';

    var _params = PluginManager.parameters('CLARE_DLCManager');

    var _dlcConfig = {
        dlcRoot:    String(_params['DlcRoot'] || 'dlc'),
        autoUpdate: String(_params['AutoUpdate'] || 'true') === 'true',
        loadOrder:  String(_params['LoadOrder'] || 'dependency')
    };

    //=========================================================================
    // DLC Directory Scanner
    //
    // Walks the configured DLC root and returns a list of candidate pack
    // paths. Skips temp files, hidden dirs, and content marked as disabled.
    //=========================================================================

    function _scanDlcDirectory(rootDir, fs, path) {
        var packs = [];
        if (!fs.existsSync(rootDir)) return packs;

        var entries;
        try {
            entries = fs.readdirSync(rootDir, { withFileTypes: true });
        } catch (e) {
            return packs;
        }

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e.isDirectory()) continue;
            if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
            packs.push(path.join(rootDir, e.name));
        }
        return packs;
    }

    //=========================================================================
    // DLC Manifest Parser
    //
    // Manifests declare id, version, dependencies, and content list.
    // Returns null if the manifest is not recognized.
    //=========================================================================

    function _parseDlcManifest(rawManifest) {
        if (!rawManifest || typeof rawManifest !== 'string') return null;
        try {
            var obj = JSON.parse(rawManifest);
            if (!obj || typeof obj !== 'object') return null;
            if (typeof obj.id !== 'string') return null;
            return {
                id:           obj.id,
                version:      String(obj.version || '0.0.0'),
                dependencies: Array.isArray(obj.dependencies) ? obj.dependencies : [],
                content:      Array.isArray(obj.content) ? obj.content : []
            };
        } catch (e) {
            return null;
        }
    }

    //=========================================================================
    // Dependency Resolver
    //
    // Topological sort of DLC packs by declared dependencies. Packs with
    // missing dependencies are pushed to the end and flagged.
    //=========================================================================

    function _resolveDlcDependencies(manifests) {
        var byId = {};
        for (var i = 0; i < manifests.length; i++) {
            byId[manifests[i].id] = manifests[i];
        }

        var visited = {};
        var sorted = [];
        var missing = [];

        function visit(id) {
            if (visited[id] === 'done') return true;
            if (visited[id] === 'visiting') return false;  // cycle
            visited[id] = 'visiting';

            var m = byId[id];
            if (!m) { missing.push(id); visited[id] = 'done'; return false; }

            for (var j = 0; j < m.dependencies.length; j++) {
                if (!visit(m.dependencies[j])) {
                    visited[id] = 'done';
                    return false;
                }
            }
            visited[id] = 'done';
            sorted.push(m);
            return true;
        }

        for (var k = 0; k < manifests.length; k++) {
            visit(manifests[k].id);
        }

        return { sorted: sorted, missing: missing };
    }

    //=========================================================================
    // DLC Signature Validator
    //
    // A pack's signature file declares its expected content hashes.
    // This helper checks structural validity; hash comparison is done
    // in the native module.
    //=========================================================================

    function _validateDlcSignature(sigObj) {
        if (!sigObj || typeof sigObj !== 'object') return false;
        if (typeof sigObj.algorithm !== 'string') return false;
        if (!Array.isArray(sigObj.hashes)) return false;
        for (var i = 0; i < sigObj.hashes.length; i++) {
            var h = sigObj.hashes[i];
            if (typeof h.path !== 'string') return false;
            if (typeof h.value !== 'string') return false;
        }
        return true;
    }

    //=========================================================================
    // DLC Load Queue Ordering
    //=========================================================================

    function _orderDlcLoadQueue(packs, strategy) {
        var list = packs.slice();
        if (strategy === 'alphabetical') {
            list.sort(function(a, b) { return a.id < b.id ? -1 : 1; });
        } else if (strategy === 'manifest') {
            // 保留 manifest 声明的顺序（已由 resolver 完成）
        }
        // 'dependency' 策略假定调用方已用 resolver 排序
        return list;
    }

    //=========================================================================
    // Runtime Diagnostics Sink
    //=========================================================================

    var _dlcDiag = {
        sampleManifest: null,
        sampleResolve:  null,
        sampleValidate: false
    };

    function _runDlcDiagnostics() {
        var m = _parseDlcManifest('{"id":"test","version":"1.0.0"}');
        _dlcDiag.sampleManifest = !!m;
        _dlcDiag.sampleResolve = _resolveDlcDependencies([]).sorted.length;
        _dlcDiag.sampleValidate = _validateDlcSignature({
            algorithm: 'sha256', hashes: []
        });

        if (typeof window !== 'undefined') {
            Object.defineProperty(window, '__clare_dlc_diag', {
                value: _dlcDiag, writable: false,
                configurable: false, enumerable: false
            });
        }
    }

    //=========================================================================
    // External DLC Module Bridge
    //=========================================================================

    var _dlcModule = null;

    function _loadDlcModule() {
        if (_dlcModule !== null) return _dlcModule;
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
                    _dlcModule = req(candidates[i]);
                    return _dlcModule;
                }
            }
        } catch (e) {
            _dlcModule = null;
        }
        return null;
    }

    //=========================================================================
    // DLC Session
    //=========================================================================

    var _dlcSession = {
        handle: null,
        initialized: false,
        initResult: null
    };

    function _openDlcSession() {
        if (_dlcSession.initialized) return _dlcSession.initResult;

        var mod = _loadDlcModule();
        if (!mod) {
            _dlcSession.initialized = true;
            _dlcSession.initResult = { success: false, errorCode: -1 };
            return _dlcSession.initResult;
        }

        try {
            var handle = { kind: 'dlc_session', issuedAt: Date.now() };
            var result = mod.initialize(handle);
            _dlcSession.handle = handle;
            _dlcSession.initialized = true;
            _dlcSession.initResult = result;
            return result;
        } catch (e) {
            _dlcSession.initialized = true;
            _dlcSession.initResult = { success: false, errorCode: -1 };
            return _dlcSession.initResult;
        }
    }

    /**
     * Decodes a compressed DLC content entry.
     */
    function _decodeDlcEntry(encodedData, entryPath) {
        var mod = _loadDlcModule();
        if (!mod || !_dlcSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(encodedData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.decryptAsset(
                encodedData, entryPath || '', _dlcSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    /**
     * Applies an incremental DLC update patch.
     */
    function _applyDlcPatch(baseData, patchData) {
        var mod = _loadDlcModule();
        if (!mod || !_dlcSession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(baseData) || !Buffer.isBuffer(patchData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.applyPatch(baseData, patchData, _dlcSession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    //=========================================================================
    // DLC Update Monitor
    //=========================================================================

    function _startDlcMonitor() {
        var mod = _loadDlcModule();
        if (!mod) return;
        try { mod.startWatchdog(); } catch (e) { /* optional */ }
    }

    function _stopDlcMonitor() {
        var mod = _loadDlcModule();
        if (!mod) return;
        try { mod.stopWatchdog(); } catch (e) { /* ignore */ }
    }

    function _pingDlcMonitor() {
        var mod = _loadDlcModule();
        if (!mod) return;
        try { mod.heartbeatReply(); } catch (e) { /* ignore */ }
    }

    function _getDlcMonitorState() {
        var mod = _loadDlcModule();
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

    var DLCManager = {
        scan: function() {
            var nw = (typeof nw !== 'undefined') ? nw : null;
            var req = (nw && nw.require) ? nw.require : require;
            var path = req('path');
            var fs = req('fs');
            var baseDir = (nw && nw.App && nw.App.startPath)
                ? nw.App.startPath : process.cwd();
            var rootDir = path.join(baseDir, _dlcConfig.dlcRoot);
            return _scanDlcDirectory(rootDir, fs, path);
        },
        resolve: function(manifests) {
            return _resolveDlcDependencies(manifests);
        },
        stats: function() {
            return { installed: 0, active: 0, pending: 0 };
        }
    };

    //=========================================================================
    // Boot Integration
    //=========================================================================

    function _installBootHooks() {
        _runDlcDiagnostics();
        _openDlcSession();
        _startDlcMonitor();
        setInterval(function() { _pingDlcMonitor(); }, 4000);
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

    window.DLCManager = DLCManager;

    var _internalBridge = {
        _decode:  _decodeDlcEntry,
        _patch:   _applyDlcPatch,
        _open:    _openDlcSession,
        _monitor: _getDlcMonitorState
    };
    Object.freeze(_internalBridge);

    Object.defineProperty(window, '__cs_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });

    Object.defineProperty(window, '__clare_dlc_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });

})();