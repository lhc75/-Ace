const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  createWindowWebPreferences,
  getPromptOverlayInitialWidth,
  getWindowsStartupSwitches,
  relayChildOutput,
  shouldOverlayPassthrough,
  writeToStreamSafely,
} = require('./windowOptions');

test('overlay stays interactive when stealth is off, regardless of hover', () => {
  assert.equal(shouldOverlayPassthrough(false, false), false);
  assert.equal(shouldOverlayPassthrough(false, true), false);
});

test('stealth overlay passes clicks through only while the cursor is off the panel', () => {
  // 光标不在面板上：穿透，点击落到考试窗口，不抢焦点
  assert.equal(shouldOverlayPassthrough(true, false), true);
  // 光标在面板上：放行点击，拖动/按钮/滚动可用（兼得的核心）
  assert.equal(shouldOverlayPassthrough(true, true), false);
});

test('Windows overlay disables the native thick frame that can expose a white title strip', () => {
  const options = createOverlayChromeOptions('win32', true);

  assert.equal(options.frame, false);
  assert.equal(options.transparent, true);
  assert.equal(options.thickFrame, false);
  assert.equal(options.resizable, false);
});

test('non-Windows overlay keeps the existing native resize behavior', () => {
  const options = createOverlayChromeOptions('darwin', true);

  assert.equal(options.frame, false);
  assert.equal(options.transparent, true);
  assert.equal(options.type, 'panel');
  assert.equal(options.thickFrame, undefined);
  assert.equal(options.resizable, true);
});

test('macOS overlay is borderless so its top edge has no hidden title bar that deactivates the app below', () => {
  assert.equal(createOverlayChromeOptions('darwin', true).roundedCorners, false);
  assert.equal(createOverlayChromeOptions('win32', true).roundedCorners, undefined);
});

test('Windows startup enables in-process GPU so security software cannot kill a separate GPU child process', () => {
  assert.deepEqual(getWindowsStartupSwitches({}), ['in-process-gpu']);
  assert.deepEqual(getWindowsStartupSwitches(), ['in-process-gpu']);
});

test('Windows startup restores a separate GPU process when ELECTRON_INPROCESS_GPU=0', () => {
  assert.deepEqual(getWindowsStartupSwitches({ ELECTRON_INPROCESS_GPU: '0' }), []);
});

test('Windows startup keeps the legacy transparent-visuals switch off unless requested', () => {
  assert.deepEqual(getWindowsStartupSwitches({ ELECTRON_TRANSPARENT_VISUALS: '0' }), ['in-process-gpu']);
  assert.deepEqual(
    getWindowsStartupSwitches({ ELECTRON_TRANSPARENT_VISUALS: '1' }),
    ['in-process-gpu', 'enable-transparent-visuals'],
  );
});

test('Windows windows opt out of the renderer sandbox while keeping context isolation', () => {
  const prefs = createWindowWebPreferences('win32', '/tmp/preload.js');

  assert.equal(prefs.preload, '/tmp/preload.js');
  assert.equal(prefs.sandbox, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
});

test('non-Windows windows keep the renderer sandbox and merge overrides', () => {
  const prefs = createWindowWebPreferences('darwin', '/tmp/preload.js', { backgroundThrottling: false });

  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.backgroundThrottling, false);
});

test('prompt overlay width falls back safely when persisted width is invalid', () => {
  assert.equal(getPromptOverlayInitialWidth(undefined), PROMPT_OVERLAY_DEFAULT_WIDTH);
  assert.equal(getPromptOverlayInitialWidth('not-a-number'), PROMPT_OVERLAY_DEFAULT_WIDTH);
  assert.equal(getPromptOverlayInitialWidth('780.6'), 781);
  assert.equal(getPromptOverlayInitialWidth(10), 180);
  assert.equal(getPromptOverlayInitialWidth(9999), PROMPT_OVERLAY_MAX_WIDTH);
  assert.equal(getPromptOverlayInitialWidth(undefined, 9999), PROMPT_OVERLAY_MAX_WIDTH);
});

test('pending overlay show is discarded after the overlay was hidden', () => {
  const win = { _pendingShow: true };

  assert.equal(consumePendingOverlayShow(win, false), false);
  assert.equal(win._pendingShow, false);
});

test('pending overlay show is consumed once while the overlay remains visible', () => {
  const win = { _pendingShow: true };

  assert.equal(consumePendingOverlayShow(win, true), true);
  assert.equal(win._pendingShow, false);
  assert.equal(consumePendingOverlayShow(win, true), false);
});

test('writeToStreamSafely swallows broken pipe writes', () => {
  const stream = {
    writable: true,
    destroyed: false,
    write() {
      const error = new Error('broken pipe');
      error.code = 'EPIPE';
      throw error;
    },
  };

  assert.equal(writeToStreamSafely(stream, 'hello'), false);
});

test('relayChildOutput prefixes text and never throws on target write failure', () => {
  const childStream = new EventEmitter();
  const writes = [];
  let shouldThrow = false;
  const stream = {
    writable: true,
    destroyed: false,
    write(chunk) {
      if (shouldThrow) {
        throw new Error('boom');
      }
      writes.push(chunk);
      return true;
    },
  };

  const dispose = relayChildOutput(childStream, stream, '[py] ');
  childStream.emit('data', Buffer.from('line 1'));
  shouldThrow = true;
  assert.doesNotThrow(() => childStream.emit('data', 'line 2'));
  dispose();
  shouldThrow = false;
  childStream.emit('data', 'line 3');

  assert.deepEqual(writes, ['[py] line 1']);
});

// --- 悬浮窗置顶/定时重申 --------------------------------------------------
// macOS 上 moveTop() 会把已隐藏的窗口重新 orderFront 到前台；隐藏窗口上的
// 任何“置顶重申”都必须跳过，否则快捷键关闭悬浮窗后会被定时器又顶出来。

const {
  applyTopMost,
  keepWindowInFront,
  stopFrontReassert,
} = require('./windowOptions');

function makeFakeWin({ visible = true } = {}) {
  return {
    visible,
    destroyed: false,
    calls: [],
    isVisible() { return this.visible; },
    isDestroyed() { return this.destroyed; },
    setVisibleOnAllWorkspaces() { this.calls.push('setVisibleOnAllWorkspaces'); },
    setFullScreenable() { this.calls.push('setFullScreenable'); },
    setAlwaysOnTop() { this.calls.push('setAlwaysOnTop'); },
    setContentProtection() { this.calls.push('setContentProtection'); },
    // 模拟 macOS 行为: moveTop 会把隐藏窗口重新显示出来
    moveTop() { this.calls.push('moveTop'); this.visible = true; },
  };
}

test('applyTopMost never touches a hidden window (moveTop would re-show it)', () => {
  const win = makeFakeWin({ visible: false });
  applyTopMost(win);
  assert.deepEqual(win.calls, []);
  assert.equal(win.visible, false);
});

test('applyTopMost reasserts z-order on a visible window', () => {
  const win = makeFakeWin({ visible: true });
  applyTopMost(win);
  assert.ok(win.calls.includes('setAlwaysOnTop'));
  assert.ok(win.calls.includes('moveTop'));
  assert.equal(win.visible, true);
});

test('keepWindowInFront stops reasserting once the window is hidden', async () => {
  const win = makeFakeWin({ visible: true });
  keepWindowInFront(win, { durationMs: 200, intervalMs: 20 });
  assert.ok(win.calls.includes('moveTop'));

  win.visible = false; // 用户用快捷键关闭了悬浮窗
  await new Promise((resolve) => setTimeout(resolve, 90));
  const callsAfterHide = win.calls.length;
  assert.equal(win.visible, false);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(win.calls.length, callsAfterHide, '定时器在窗口隐藏后必须停止');
  assert.equal(win.visible, false);
});

test('keepWindowInFront keeps reasserting while the window stays visible', async () => {
  const win = makeFakeWin({ visible: true });
  keepWindowInFront(win, { durationMs: 120, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 90));
  const reasserts = win.calls.filter((c) => c === 'moveTop').length;
  assert.ok(reasserts >= 2, `expected repeated reasserts, got ${reasserts}`);
  stopFrontReassert();
});
