const assert = require('node:assert/strict');
const test = require('node:test');
const {
  protectWindowFromCapture,
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

  const result = protectWindowFromCapture(win, { nativeGuard: guard });

  assert.equal(result.electron, true);
  assert.equal(result.native, true);
  assert.equal(result.nativeSupported, true);
  assert.deepEqual(win.calls, [['contentProtection', true], ['nativeHandle']]);
  assert.deepEqual(guard.calls, [['handle', true]]);
});

test('Electron protection remains the fallback when the native guard is absent', () => {
  const win = makeWindow();
  const result = protectWindowFromCapture(win, { nativeGuard: null });

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

  assert.doesNotThrow(() => protectWindowFromCapture(win, { nativeGuard: guard }));
  const result = protectWindowFromCapture(win, { nativeGuard: guard });
  assert.equal(result.electron, true);
  assert.equal(result.native, false);
  assert.equal(result.nativeError, 'native failure');
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

  setWindowCaptureProtection(win, false, { nativeGuard: guard });

  assert.deepEqual(win.calls, [['contentProtection', false], ['nativeHandle']]);
  assert.deepEqual(guard.calls, [['handle', false]]);
  assert.equal(win._captureProtectionEnabled, false);
});

test('destroyed windows are left untouched', () => {
  const win = makeWindow();
  win.isDestroyed = () => true;
  const guard = { setCaptureExclusion() { throw new Error('must not be called'); } };

  const result = protectWindowFromCapture(win, { nativeGuard: guard });

  assert.deepEqual(result, { electron: false, native: false, nativeSupported: false });
  assert.deepEqual(win.calls, []);
});
