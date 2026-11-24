const { performance } = require('node:perf_hooks');

// Round up so the scheduled interval never exceeds 30 submissions per second.
const FRAME_INTERVAL_MS = Math.ceil(1000 / 30);

function createProtectedOverlay(win, { url, loadGuard, onFailure }) {
  const contents = win.webContents;
  let guard;
  let pending;
  let latest;
  let timer;
  let healthCheck;
  let loading = true;
  let failed = false;
  let lastSubmission = -Infinity;

  function clearFrame() {
    clearTimeout(timer);
    clearInterval(healthCheck);
    timer = healthCheck = pending = undefined;
    if (!win.isDestroyed()) guard?.clearProtectedOverlay?.(win.getNativeWindowHandle());
  }

  function fail() {
    if (failed) return;
    failed = true;
    latest = undefined;
    try {
      clearFrame();
    } finally {
      if (!win.isDestroyed()) win.hide();
      onFailure();
    }
  }

  function render() {
    timer = undefined;
    if (!pending || failed || win.isDestroyed() || !win.isVisible() || loading) return;
    const frame = pending;
    pending = undefined;
    try {
      guard ??= loadGuard();
      const handle = win.getNativeWindowHandle();
      lastSubmission = performance.now();
      if (!guard?.updateProtectedOverlay?.(handle, frame)) {
        fail();
        return;
      }
      healthCheck ??= setInterval(() => {
        try {
          if (!guard.isProtectedOverlayHealthy(win.getNativeWindowHandle())) fail();
        } catch {
          fail();
        }
      }, 500);
    } catch {
      fail();
    }
  }

  function scheduleFrame() {
    if (timer || loading || failed || !latest || !win.isVisible()) return;
    pending = latest;
    const delay = Math.ceil(FRAME_INTERVAL_MS - (performance.now() - lastSubmission));
    if (delay > 0) timer = setTimeout(render, delay);
    else render();
  }

  contents.on('will-navigate', (event) => {
    if (event.url !== url) event.preventDefault();
  });
  contents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    loading = true;
    latest = undefined;
    clearFrame();
  });
  contents.on('did-finish-load', () => {
    loading = false;
    scheduleFrame();
  });
  contents.on('render-process-gone', () => {
    loading = true;
    latest = undefined;
    clearFrame();
    onFailure();
  });
  win.on('show', scheduleFrame);
  win.on('hide', clearFrame);
  win.once('closed', () => {
    latest = undefined;
    clearFrame();
  });

  return {
    canShow: () => !failed,
    submit(event, frame) {
      if (failed || event.sender !== contents || event.senderFrame !== contents.mainFrame
          || event.senderFrame?.url !== url || typeof frame?.text !== 'string') return;
      if (!frame.text) {
        latest = undefined;
        clearFrame();
        return;
      }
      latest = {
        id: typeof frame.id === 'string' ? frame.id.slice(0, 128) : '',
        text: frame.text,
        streaming: frame.streaming === true,
        follow: frame.follow === true,
        fontSize: Number.isFinite(frame.fontSize) ? Math.max(10, Math.min(48, frame.fontSize)) : 14,
        fontColor: /^#[0-9a-f]{6}$/i.test(frame.fontColor) ? frame.fontColor : '#e2e8f0',
        opacity: Number.isFinite(frame.opacity) ? Math.max(0, Math.min(1, frame.opacity)) : 0.88,
      };
      if (timer) pending = latest;
      else scheduleFrame();
    },
  };
}

module.exports = { createProtectedOverlay };
