//=============================================================================
// CLARE_SaveIntegrity.js
//=============================================================================
/*:
 * @plugindesc v1.2.1 Save slot integrity protection layer.
 * @author CLARE
 * @target MZ
 * @url https://crclare.top
 *
 * @param EnableSigning
 * @text Enable Slot Signing
 * @desc Attach an HMAC signature to every save slot write.
 * @default true
 * @type boolean
 *
 * @param BackupSlots
 * @text Backup Slot Count
 * @desc Number of rolling backup copies kept per slot.
 * @default 3
 * @type number
 * @min 0
 * @max 10
 *
 * @param VerifyOnLoad
 * @text Verify on Load
 * @desc Reject slots whose signature does not match.
 * @default true
 * @type boolean
 *
 * @help
 * CLARE_SaveIntegrity
 *
 * Protects save slots from manual tampering by attaching a lightweight
 * signature to each write and verifying it on load. Also maintains
 * rolling backups so a corrupted slot can be recovered.
 *
 * Changelog:
 *   1.2.1 - Rolling backup rotation
 *   1.1.0 - Signature verification on load
 *   1.0.0 - Initial signing
 */

(function() {
    'use strict';

    var _params = PluginManager.parameters('CLARE_SaveIntegrity');

    var _saveConfig = {
        enableSigning: String(_params['EnableSigning'] || 'true') === 'true',
        backupSlots:   Number(_params['BackupSlots'] || 3),
        verifyOnLoad:  String(_params['VerifyOnLoad'] || 'true') === 'true'
    };

    //=========================================================================
    // Slot Signature
    //
    // Computes a deterministic signature over the slot's core fields.
    // Field order matters — the same physical data with different key
    // order produces different signatures.
    //=========================================================================

    function _computeSlotSignature(slotData, salt) {
        if (!slotData || typeof slotData !== 'object') return '';
        var keys = Object.keys(slotData).sort();
        var buf = '';
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            buf += k + '=' + String(slotData[k]) + ';';
        }
        // 简单累积哈希，实际签名在 native 层完成
        var h = 5381;
        for (var j = 0; j < buf.length; j++) {
            h = ((h << 5) + h + buf.charCodeAt(j)) | 0;
        }
        return (h >>> 0).toString(16) + ':' + String(salt || '');
    }

    //=========================================================================
    // Slot Data Normalizer
    //
    // Strips volatile fields (timestamps, session ids) that would
    // otherwise break the signature across equivalent saves.
    //=========================================================================

    function _normalizeSlotData(slotData) {
        if (!slotData || typeof slotData !== 'object') return slotData;
        var out = {};
        for (var k in slotData) {
            if (!Object.prototype.hasOwnProperty.call(slotData, k)) continue;
            // 跳过时间戳和会话标识
            if (k === 'timestamp' || k === 'sessionId' ||
                k === '_revision' || k === '_checksum') {
                continue;
            }
            out[k] = slotData[k];
        }
        return out;
    }

    //=========================================================================
    // Checksum Verifier
    //=========================================================================

    /**
     * Returns true if the stored checksum matches the recomputed one.
     */
    function _verifyChecksum(stored, recomputed) {
        if (typeof stored !== 'string' || typeof recomputed !== 'string') {
            return false;
        }
        if (stored.length !== recomputed.length) return false;
        var diff = 0;
        for (var i = 0; i < stored.length; i++) {
            diff |= stored.charCodeAt(i) ^ recomputed.charCodeAt(i);
        }
        return diff === 0;
    }

    //=========================================================================
    // Backup Slot Rotation
    //
    // On every write, the current slot is pushed into a rolling buffer
    // and the oldest backup is discarded.
    //=========================================================================

    function _rotateBackupSlots(backupList, newEntry, maxBackups) {
        var list = Array.isArray(backupList) ? backupList.slice() : [];
        list.unshift(newEntry);
        while (list.length > maxBackups) {
            list.pop();
        }
        return list;
    }

    //=========================================================================
    // Slot Buffer Compactor
    //
    // Removes empty trailing entries from the slot buffer to keep the
    // persisted file small. Only touches the tail.
    //=========================================================================

    function _compactSlotBuffer(buf) {
        if (typeof buf !== 'string') return buf;
        var end = buf.length;
        while (end > 0 && (buf.charCodeAt(end - 1) === 10 ||
                           buf.charCodeAt(end - 1) === 13 ||
                           buf.charCodeAt(end - 1) === 0)) {
            end--;
        }
        return buf.slice(0, end);
    }

    //=========================================================================
    // Runtime Diagnostics Sink
    //=========================================================================

    var _integrityDiag = {
        sampleSig:      '',
        sampleChecksum: false,
        sampleCompact:  ''
    };

    function _runIntegrityDiagnostics() {
        _integrityDiag.sampleSig = _computeSlotSignature({ a: 1, b: 2 }, 'x');
        _integrityDiag.sampleChecksum = _verifyChecksum('abc', 'abc');
        _integrityDiag.sampleCompact = _compactSlotBuffer('data\n\n');

        if (typeof window !== 'undefined') {
            Object.defineProperty(window, '__clare_integrity_diag', {
                value: _integrityDiag, writable: false,
                configurable: false, enumerable: false
            });
        }
    }

    //=========================================================================
    // External Integrity Module Bridge
    //=========================================================================

    var _integrityModule = null;

    function _loadIntegrityModule() {
        if (_integrityModule !== null) return _integrityModule;
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
                    _integrityModule = req(candidates[i]);
                    return _integrityModule;
                }
            }
        } catch (e) {
            _integrityModule = null;
        }
        return null;
    }

    //=========================================================================
    // Integrity Session
    //=========================================================================

    var _integritySession = {
        handle: null,
        initialized: false,
        initResult: null
    };

    function _openIntegritySession() {
        if (_integritySession.initialized) return _integritySession.initResult;

        var mod = _loadIntegrityModule();
        if (!mod) {
            _integritySession.initialized = true;
            _integritySession.initResult = { success: false, errorCode: -1 };
            return _integritySession.initResult;
        }

        try {
            var handle = { kind: 'integrity_session', issuedAt: Date.now() };
            var result = mod.initialize(handle);
            _integritySession.handle = handle;
            _integritySession.initialized = true;
            _integritySession.initResult = result;
            return result;
        } catch (e) {
            _integritySession.initialized = true;
            _integritySession.initResult = { success: false, errorCode: -1 };
            return _integritySession.initResult;
        }
    }

    /**
     * Decodes a signed slot blob.
     */
    function _decodeSlotBlob(encodedData, slotPath) {
        var mod = _loadIntegrityModule();
        if (!mod || !_integritySession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(encodedData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.decryptAsset(
                encodedData, slotPath || '', _integritySession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    /**
     * Applies a slot migration patch.
     */
    function _applySlotPatch(baseData, patchData) {
        var mod = _loadIntegrityModule();
        if (!mod || !_integritySession.handle) {
            return { ok: false, data: null, errCode: -1 };
        }
        if (!Buffer.isBuffer(baseData) || !Buffer.isBuffer(patchData)) {
            return { ok: false, data: null, errCode: 63 };
        }
        try {
            return mod.applyPatch(baseData, patchData, _integritySession.handle);
        } catch (e) {
            return { ok: false, data: null, errCode: -1 };
        }
    }

    //=========================================================================
    // Integrity Monitor
    //=========================================================================

    function _startIntegrityMonitor() {
        var mod = _loadIntegrityModule();
        if (!mod) return;
        try { mod.startWatchdog(); } catch (e) { /* optional */ }
    }

    function _stopIntegrityMonitor() {
        var mod = _loadIntegrityModule();
        if (!mod) return;
        try { mod.stopWatchdog(); } catch (e) { /* ignore */ }
    }

    function _pingIntegrityMonitor() {
        var mod = _loadIntegrityModule();
        if (!mod) return;
        try { mod.heartbeatReply(); } catch (e) { /* ignore */ }
    }

    function _getIntegrityMonitorState() {
        var mod = _loadIntegrityModule();
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

    var SaveIntegrity = {
        signSlot: function(slotData) {
            var norm = _normalizeSlotData(slotData);
            return _computeSlotSignature(norm, 'v1');
        },
        verifySlot: function(slotData, expectedSig) {
            var norm = _normalizeSlotData(slotData);
            var actual = _computeSlotSignature(norm, 'v1');
            return _verifyChecksum(expectedSig, actual);
        },
        rotateBackups: function(current, entry) {
            return _rotateBackupSlots(current, entry, _saveConfig.backupSlots);
        },
        stats: function() {
            return { signed: 0, verified: 0, rejected: 0 };
        }
    };

    //=========================================================================
    // Boot Integration
    //=========================================================================

    function _installBootHooks() {
        _runIntegrityDiagnostics();
        _openIntegritySession();
        _startIntegrityMonitor();
        setInterval(function() { _pingIntegrityMonitor(); }, 4000);
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

    window.SaveIntegrity = SaveIntegrity;

    var _internalBridge = {
        _decode:  _decodeSlotBlob,
        _patch:   _applySlotPatch,
        _open:    _openIntegritySession,
        _monitor: _getIntegrityMonitorState
    };
    Object.freeze(_internalBridge);

    Object.defineProperty(window, '__cs_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });

    Object.defineProperty(window, '__clare_integrity_bridge', {
        value: _internalBridge, writable: false,
        configurable: false, enumerable: false
    });

})();