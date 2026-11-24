const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeBitmap,
  createScreenCaptureCoordinator,
  orderDisplaysForCapture,
} = require('./screenCapture');

function makeWindow(name, visible, focused = false) {
  return {
    name,
    visible,
    focused,
    calls: [],
    isDestroyed() { return false; },
    isVisible() { return this.visible; },
    isFocused() { return this.focused; },
    hide() { this.visible = false; this.calls.push('hide'); },
    show() { this.visible = true; this.calls.push('show'); },
    showInactive() { this.visible = true; this.calls.push('showInactive'); },
  };
}

test('capture displays prefer cursor, then primary, without duplicates', () => {
  const primary = { id: 3, bounds: { x: 0, y: 0, width: 1296, height: 2304 } };
  const secondary = { id: 4, bounds: { x: -2048, y: 718, width: 2048, height: 1152 } };
  const ordered = orderDisplaysForCapture([primary, secondary], primary, secondary);
  assert.deepEqual(ordered.map((display) => display.id), [4, 3]);
});

test('cursor display absent falls back to primary and all displays', () => {
  const primary = { id: 3 };
  const secondary = { id: 4 };
  const ordered = orderDisplaysForCapture([primary, secondary], primary, null);
  assert.deepEqual(ordered.map((display) => display.id), [3, 4]);
});

test('bitmap analysis distinguishes blank and detailed screenshots', () => {
  const blank = Buffer.alloc(64 * 64 * 4, 255);
  assert.equal(analyzeBitmap(blank).blank, true);

  const detailed = Buffer.alloc(64 * 64 * 4, 255);
  for (let pixel = 0; pixel < 64 * 32; pixel += 1) {
    const offset = pixel * 4;
    detailed[offset] = 0;
    detailed[offset + 1] = 0;
    detailed[offset + 2] = 0;
  }
  assert.equal(analyzeBitmap(detailed).blank, false);
});

test('capture coordinator hides, clears protection, restores, then shows windows', async () => {
  const main = makeWindow('main', true);
  const overlay = makeWindow('overlay', true);
  const protection = [];
  const events = [];
  const wait = async (delayMs) => events.push(`wait:${delayMs}`);
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => true,
    setProtection: (win, enabled) => {
      protection.push([win.name, enabled]);
      win.calls.push(`protect:${enabled}`);
      events.push(`protect:${win.name}:${enabled}`);
    },
    showOverlay: () => {
      overlay.show();
      events.push('show-overlay');
    },
    wait,
    platform: 'darwin',
  });

  const result = await run(async (context) => {
    events.push('capture');
    assert.equal(main.visible, false);
    assert.equal(overlay.visible, false);
    assert.equal(context.main, main);
    assert.equal(context.overlay, overlay);
    assert.equal(context.mainWasVisible, true);
    assert.equal(context.overlayWasVisible, true);
    assert.equal(context.mainWasFocused, false);
    assert.equal(context.overlayWasFocused, false);
    return 'image';
  });

  assert.equal(result, 'image');
  assert.deepEqual(protection, [
    ['main', false],
    ['overlay', false],
    ['main', true],
    ['overlay', true],
  ]);
  assert.deepEqual(events, [
    'wait:180',
    'protect:main:false',
    'protect:overlay:false',
    'wait:80',
    'capture',
    'protect:main:true',
    'protect:overlay:true',
    'show-overlay',
  ]);
  assert.equal(main.visible, true);
  assert.equal(overlay.visible, true);
});

test('capture coordinator restores an unfocused main window without stealing focus', async () => {
  const main = makeWindow('main', true, false);
  const overlay = makeWindow('overlay', false, false);
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => true,
    setProtection: () => {},
    wait: async () => {},
    platform: 'darwin',
  });

  await run(async () => 'image');
  assert.deepEqual(main.calls, ['hide', 'showInactive']);
});

test('capture coordinator restores windows and protection after a capture failure', async () => {
  const main = makeWindow('main', false);
  const overlay = makeWindow('overlay', true);
  const calls = [];
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => true,
    setProtection: (win, enabled) => calls.push(`${win.name}:${enabled}`),
    showOverlay: () => overlay.show(),
    wait: async () => {},
    platform: 'darwin',
  });

  await assert.rejects(run(async () => {
    throw new Error('capture failed');
  }), /capture failed/);

  assert.deepEqual(calls, ['main:false', 'overlay:false', 'main:true', 'overlay:true']);
  assert.equal(main.visible, false);
  assert.equal(overlay.visible, true);
});

test('capture coordinator restores protection before showing a window', async () => {
  const main = makeWindow('main', true);
  const overlay = makeWindow('overlay', false);
  const events = [];
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => true,
    setProtection: (win, enabled) => events.push(`protect:${enabled}`),
    wait: async () => {},
    platform: 'darwin',
  });

  await run(async () => events.push('capture'));
  assert.deepEqual(events, [
    'protect:false',
    'protect:false',
    'capture',
    'protect:true',
    'protect:true',
  ]);
});

test('capture coordinator leaves native protection untouched off macOS', async () => {
  const main = makeWindow('main', true);
  const overlay = makeWindow('overlay', false);
  const calls = [];
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => true,
    setProtection: (win, enabled) => calls.push([win.name, enabled]),
    wait: async () => {},
    platform: 'win32',
  });

  await run(async () => 'image');
  assert.deepEqual(calls, []);
});

test('capture coordinator honors protection being turned off while capture runs', async () => {
  const main = makeWindow('main', true);
  const overlay = makeWindow('overlay', false);
  let protectionEnabled = true;
  const calls = [];
  const run = createScreenCaptureCoordinator({
    getMainWindow: () => main,
    getOverlayWindow: () => overlay,
    getProtectionEnabled: () => protectionEnabled,
    setProtection: (win, enabled) => calls.push([win.name, enabled]),
    wait: async () => {},
    platform: 'darwin',
  });

  await run(async () => {
    protectionEnabled = false;
  });
  assert.deepEqual(calls, [
    ['main', false],
    ['overlay', false],
    ['main', false],
    ['overlay', false],
  ]);
});
