const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { createProtectedOverlay } = require('./protectedOverlay');

function setup(update = () => true) {
  const url = 'http://127.0.0.1:18080/?overlay=1&presentation=protected';
  const contents = new EventEmitter();
  contents.mainFrame = { url };
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    visible: true,
    isVisible() { return this.visible; },
    isDestroyed() { return false; },
    getNativeWindowHandle() { return Buffer.alloc(8); },
    hide() {
      this.visible = false;
      this.emit('hide');
    },
  });
  const received = [];
  let clears = 0;
  let failures = 0;
  const controller = createProtectedOverlay(win, {
    url,
    loadGuard: () => ({
      updateProtectedOverlay(_, frame) { received.push(frame.text); return update(frame); },
      clearProtectedOverlay() { clears++; },
      isProtectedOverlayHealthy() { return true; },
    }),
    onFailure() { failures++; },
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  contents.emit('did-finish-load');
  return { win, contents, event, controller, received, get clears() { return clears; }, get failures() { return failures; } };
}

test('only the current overlay main frame can submit protected text', (t) => {
  const { contents, win, event, controller, received } = setup();
  t.after(() => win.hide());
  controller.submit({ ...event, sender: {} }, { text: 'unrelated window' });
  controller.submit({ ...event, senderFrame: { url: event.senderFrame.url } }, { text: 'child frame' });
  contents.mainFrame.url = 'https://example.com';
  controller.submit(event, { text: 'different document' });
  contents.mainFrame.url = 'http://127.0.0.1:18080/?overlay=1&presentation=protected';
  controller.submit(event, { text: '  中文\n    code' });
  assert.deepEqual(received, ['  中文\n    code']);
});

test('keeps only the newest pending text and clears the old document on reload', async (t) => {
  let showLatest;
  const latestShown = new Promise((resolve) => { showLatest = resolve; });
  const s = setup((frame) => {
    if (frame.text === 'latest') showLatest();
    return true;
  });
  t.after(() => s.win.hide());
  for (const text of ['first', 'intermediate', 'latest']) s.controller.submit(s.event, { text });
  assert.deepEqual(s.received, ['first']);
  await latestShown;
  assert.deepEqual(s.received, ['first', 'latest']);
  s.controller.submit(s.event, { text: 'stale' });
  s.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  s.contents.emit('did-finish-load');
  await delay(70);
  assert.deepEqual(s.received, ['first', 'latest']);
  assert.equal(s.clears, 1);
});

test('native rendering failure hides the overlay and reports once', (t) => {
  const s = setup(() => false);
  t.after(() => s.win.hide());
  s.controller.submit(s.event, { text: 'fixture' });
  s.controller.submit(s.event, { text: 'fixture continued' });
  assert.equal(s.controller.canShow(), false);
  assert.equal(s.win.isVisible(), false);
  assert.equal(s.failures, 1);
  assert.deepEqual(s.received, ['fixture']);
});
