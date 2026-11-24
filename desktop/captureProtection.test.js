const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getNativeWindowCaptureState,
  protectWindowFromCapture,
  reassertNativeWindowCaptureProtection,
  setNativeWindowClickThrough,
  setWindowCaptureProtection,
} = require('./captureProtection');

function makeWindow() {
  return {
    calls: [],
    setContentProtection(value) { this.calls.push(['contentProtection', value]); },
    getNativeWindowHandle() { this.calls.push(['nativeHandle']); return Buffer.from('handle'); },
    isDestroyed() { return false; },
  };
}

test('protection applies Electron protection before native exclusion', () => {
  const win = makeWindow();
  const guard = {
    calls: [],
    setCaptureExclusion(handle, exclude) {
      this.calls.push([handle.toString(), exclude]);
      return { ok: true, supported: true };
    },
  };

  const result = protectWindowFromCapture(win, { platform: 'win32', nativeGuard: guard });

  assert.equal(result.electron, true);
  assert.equal(result.native, true);
  assert.equal(result.nativeSupported, true);
  assert.deepEqual(win.calls, [['contentProtection', true], ['nativeHandle']]);
  assert.deepEqual(guard.calls, [['handle', true]]);
});

test('macOS toggles Electron protection without applying a native exclusion shape', () => {
  const main = makeWindow();
  const overlay = makeWindow();
  let nativeCalls = 0;
  const options = {
    platform: 'darwin',
    nativeGuard: { setCaptureExclusion() { nativeCalls++; } },
  };

  for (const win of [main, overlay]) {
    assert.equal(protectWindowFromCapture(win, options).electron, true);
    assert.equal(reassertNativeWindowCaptureProtection(win, options).native, false);
    assert.equal(setWindowCaptureProtection(win, false, options).electron, true);
    assert.deepEqual(win.calls, [['contentProtection', true], ['contentProtection', false]]);
  }
  assert.equal(nativeCalls, 0);
});

test('Electron protection remains the fallback when the native guard is absent', () => {
  const win = makeWindow();
  const result = protectWindowFromCapture(win, { platform: 'win32', nativeGuard: null });

  assert.equal(result.electron, true);
  assert.equal(result.native, false);
  assert.deepEqual(win.calls, [['contentProtection', true]]);
});

test('native failures never break window operations', () => {
  const win = makeWindow();
  const guard = {
    setCaptureExclusion() {
      throw new Error('native failure');
    },
  };

  const result = protectWindowFromCapture(win, { platform: 'win32', nativeGuard: guard });
  assert.equal(result.electron, true);
  assert.equal(result.native, false);
  assert.equal(result.nativeError, 'native failure');
});

test('native click-through is delegated without invoking setIgnoreMouseEvents', () => {
  const win = makeWindow();
  const guard = {
    calls: [],
    setClickThrough(handle, enabled) {
      this.calls.push([handle.toString(), enabled]);
      return { ok: true, supported: true };
    },
  };

  const result = setNativeWindowClickThrough(win, true, { nativeGuard: guard });

  assert.equal(result.ok, true);
  assert.deepEqual(guard.calls, [['handle', true]]);
  assert.deepEqual(win.calls, [['nativeHandle']]);
});

test('native capture state can be queried for Windows diagnostics', () => {
  const win = makeWindow();
  const guard = {
    getCaptureState(handle) {
      return { affinity: 17, captureExcluded: true, clickThrough: true, handle: handle.toString() };
    },
  };

  assert.deepEqual(getNativeWindowCaptureState(win, { nativeGuard: guard }), {
    affinity: 17,
    captureExcluded: true,
    clickThrough: true,
    handle: 'handle',
  });
});

test('disabling protection clears both Electron and native exclusions', () => {
  const win = makeWindow();
  const guard = {
    calls: [],
    setCaptureExclusion(handle, exclude) {
      this.calls.push([handle.toString(), exclude]);
      return { ok: true, supported: true };
    },
  };

  setWindowCaptureProtection(win, false, { platform: 'win32', nativeGuard: guard });

  assert.deepEqual(win.calls, [['contentProtection', false], ['nativeHandle']]);
  assert.deepEqual(guard.calls, [['handle', false]]);
  assert.equal(win._captureProtectionEnabled, false);
});

test('destroyed windows are left untouched', () => {
  const win = makeWindow();
  win.isDestroyed = () => true;
  const guard = { setCaptureExclusion() { throw new Error('must not be called'); } };

  const result = protectWindowFromCapture(win, { platform: 'win32', nativeGuard: guard });

  assert.deepEqual(result, { electron: false, native: false, nativeSupported: false });
  assert.deepEqual(win.calls, []);
});


test('native protection can be reasserted without touching Electron protection', () => {
  const win = makeWindow();
  win._captureProtectionEnabled = true;
  const guard = {
    calls: [],
    setCaptureExclusion(handle, exclude) {
      this.calls.push([handle.toString(), exclude]);
      return { ok: true, supported: true };
    },
  };

  const result = reassertNativeWindowCaptureProtection(win, { platform: 'win32', nativeGuard: guard });

  assert.equal(result.native, true);
  assert.deepEqual(win.calls, [['nativeHandle']]);
  assert.deepEqual(guard.calls, [['handle', true]]);
});
