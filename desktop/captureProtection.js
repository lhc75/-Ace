const fs = require('fs');
const path = require('path');

let nativeGuard;
let nativeGuardLoaded = false;
let loadWarningShown = false;

function getNativeGuardCandidates() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'capture_guard.node'));
  }
  candidates.push(path.join(__dirname, 'build', 'Release', 'capture_guard.node'));
  return candidates;
}

function loadNativeGuard() {
  if (nativeGuardLoaded) return nativeGuard;
  nativeGuardLoaded = true;

  for (const candidate of getNativeGuardCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // N-API keeps this addon compatible with the Node runtime embedded in Electron.
      nativeGuard = require(candidate);
      return nativeGuard;
    } catch (error) {
      if (!loadWarningShown) {
        loadWarningShown = true;
        console.warn('native capture guard load failed:', error?.message || error);
      }
    }
  }
  return null;
}

function resetNativeGuardForTests() {
  nativeGuard = null;
  nativeGuardLoaded = false;
  loadWarningShown = false;
}

/**
 * Apply Electron's window protection and restore native affinity on Windows.
 * On macOS the private capture-exclusion shape can produce an opaque window
 * during display capture. Use Electron's public window setting there.
 */
function setWindowCaptureProtection(win, enabled = true, options = {}) {
  const result = {
    electron: false,
    native: false,
    nativeSupported: false,
  };
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return result;

  win._captureProtectionEnabled = Boolean(enabled);
  try {
    win.setContentProtection(Boolean(enabled));
    result.electron = true;
  } catch (error) {
    result.electronError = error?.message || String(error);
  }

  if ((options.platform ?? process.platform) !== 'win32') return result;

  const guard = Object.prototype.hasOwnProperty.call(options, 'nativeGuard')
    ? options.nativeGuard
    : loadNativeGuard();

  if (!guard || typeof guard.setCaptureExclusion !== 'function'
      || typeof win.getNativeWindowHandle !== 'function') {
    return result;
  }

  try {
    const nativeResult = guard.setCaptureExclusion(win.getNativeWindowHandle(), Boolean(enabled));
    result.native = Boolean(nativeResult?.ok);
    result.nativeSupported = Boolean(nativeResult?.supported);
    if (nativeResult?.error) result.nativeError = nativeResult.error;
  } catch (error) {
    result.nativeError = error?.message || String(error);
  }
  return result;
}

/**
 * Toggle cross-process click-through without Electron's setIgnoreMouseEvents.
 * The Windows addon changes only WS_EX_TRANSPARENT/Layered and immediately
 * reapplies WDA_EXCLUDEFROMCAPTURE, so mouse passthrough cannot disable the
 * overlay's screen-sharing protection.
 */
function setNativeWindowClickThrough(win, enabled, options = {}) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    return { ok: false, supported: false, error: 'window unavailable' };
  }
  const guard = Object.prototype.hasOwnProperty.call(options, 'nativeGuard')
    ? options.nativeGuard
    : loadNativeGuard();
  if (!guard || typeof guard.setClickThrough !== 'function'
      || typeof win.getNativeWindowHandle !== 'function') {
    return { ok: false, supported: false, error: 'native click-through unavailable' };
  }
  try {
    return guard.setClickThrough(win.getNativeWindowHandle(), Boolean(enabled)) || {
      ok: false,
      supported: false,
      error: 'native click-through returned no result',
    };
  } catch (error) {
    return { ok: false, supported: false, error: error?.message || String(error) };
  }
}

function getNativeWindowCaptureState(win, options = {}) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  const guard = Object.prototype.hasOwnProperty.call(options, 'nativeGuard')
    ? options.nativeGuard
    : loadNativeGuard();
  if (!guard || typeof guard.getCaptureState !== 'function'
      || typeof win.getNativeWindowHandle !== 'function') {
    return null;
  }
  try {
    return guard.getCaptureState(win.getNativeWindowHandle());
  } catch {
    return null;
  }
}

function protectWindowFromCapture(win, options = {}) {
  const enabled = options.enabled === false ? false : win?._captureProtectionEnabled !== false;
  return setWindowCaptureProtection(win, enabled, options);
}

/**
 * Re-apply only the platform capture exclusion without touching Electron's
 * content protection. Some screen-sharing apps rebuild their capture surface
 * after sharing starts, which can drop the private native exclusion.
 */
function reassertNativeWindowCaptureProtection(win, options = {}) {
  const result = { native: false, nativeSupported: false };
  if ((options.platform ?? process.platform) !== 'win32') return result;
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return result;
  if (win._captureProtectionEnabled === false) return result;
  const guard = Object.prototype.hasOwnProperty.call(options, 'nativeGuard')
    ? options.nativeGuard
    : loadNativeGuard();
  if (!guard || typeof guard.setCaptureExclusion !== 'function'
      || typeof win.getNativeWindowHandle !== 'function') {
    return result;
  }
  try {
    const nativeResult = guard.setCaptureExclusion(win.getNativeWindowHandle(), true);
    result.native = Boolean(nativeResult?.ok);
    result.nativeSupported = Boolean(nativeResult?.supported);
    if (nativeResult?.error) result.nativeError = nativeResult.error;
  } catch (error) {
    result.nativeError = error?.message || String(error);
  }
  return result;
}

module.exports = {
  getNativeWindowCaptureState,
  loadNativeGuard,
  protectWindowFromCapture,
  reassertNativeWindowCaptureProtection,
  resetNativeGuardForTests,
  setNativeWindowClickThrough,
  setWindowCaptureProtection,
};
