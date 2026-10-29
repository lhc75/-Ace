function createOverlayChromeOptions(platform, preferredResizable) {
  const isWindows = platform === 'win32';

  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // macOS panels are explicitly allowed to float above fullscreen apps and
    // are visible across Spaces.
    ...(platform === 'darwin' ? { type: 'panel' } : {}),
    // macOS: a frameless window with roundedCorners keeps NSWindowStyleMaskTitled,
    // so an invisible native title bar still covers the top ~28px. Clicking it is
    // handled by the window frame (drag tracking / ordering) and deactivates the
    // app underneath (its traffic lights turn grey) even though the panel cannot
    // become key. roundedCorners:false makes the panel truly borderless; the
    // visible rounded corners come from CSS (.ov-shell border-radius).
    ...(platform === 'darwin' ? { roundedCorners: false } : {}),
    // Windows transparent frameless windows can expose the native thick frame as
    // a white title strip. Removing it also removes native edge resizing there.
    resizable: isWindows ? false : Boolean(preferredResizable),
    ...(isWindows ? { thickFrame: false } : {}),
  };
}

// Windows: the renderer sandbox conflicts with some graphics stacks and
// security software, killing the page process ("Renderer process crashed",
// "eglCreateWindowSurface failed with error EGL_BAD_ALLOC", "SwapChain11 ...
// HRESULT: 0x887A0001") even though the window itself is created. That shows up
// as a blank white window. Only the main window and the overlay opt out of the
// sandbox, and only on Windows; contextIsolation / nodeIntegration stay locked
// down and no global Chromium switch is touched.
function createWindowWebPreferences(platform, preloadPath, overrides = {}) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: platform !== 'win32',
    ...overrides,
  };
}

// Windows: launching from a downloads / security-managed directory (for example
// a NetDisk download folder) can get the standalone GPU child process killed by
// OS policy or third-party security software ("GPU process exited unexpectedly:
// exit_code=-2147483645", "GPU process isn't usable. Goodbye."), leaving the app
// without a window. Running the GPU service inside the browser process keeps
// DWM hardware acceleration (required by the transparent overlay and
// setContentProtection) without spawning that child process.
// Escape hatch: ELECTRON_INPROCESS_GPU=0 restores the separate GPU process.
//
// The legacy --enable-transparent-visuals switch is off by default: on some
// Windows graphics stacks it crashes the renderer (same EGL_BAD_ALLOC /
// SwapChain11 errors as above). Opt back in with
// ELECTRON_TRANSPARENT_VISUALS=1 when an older machine needs it for the
// transparent overlay.
function getWindowsStartupSwitches(env = {}) {
  const switches = [];
  if (env.ELECTRON_INPROCESS_GPU !== '0') {
    switches.push('in-process-gpu');
  }
  if (env.ELECTRON_TRANSPARENT_VISUALS === '1') {
    switches.push('enable-transparent-visuals');
  }
  return switches;
}

const PROMPT_OVERLAY_DEFAULT_WIDTH = 820;
const PROMPT_OVERLAY_MAX_WIDTH = 820;

function getPromptOverlayInitialWidth(promptMaxWidth, fallbackWidth = PROMPT_OVERLAY_DEFAULT_WIDTH) {
  const value = Number(promptMaxWidth);
  const fallback = Number(fallbackWidth);
  const effective = Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.max(180, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Math.round(effective)));
}

function consumePendingOverlayShow(win, visible) {
  if (!win) return false;
  const shouldShow = Boolean(win._pendingShow && visible);
  win._pendingShow = false;
  return shouldShow;
}

// --- 悬浮窗置顶/定时重申 --------------------------------------------------
// macOS 上 moveTop() 会把已隐藏的窗口重新 orderFront 到前台；隐藏窗口上的
// 任何"置顶重申"都必须跳过，否则快捷键关闭悬浮窗后会被定时器又顶出来。

let _frontReassertTimer = null;

function applyOverlayWorkspacePolicy(win) {
  if (!win || win.isDestroyed() || typeof win.setVisibleOnAllWorkspaces !== 'function') {
    return;
  }
  if (win._overlayWorkspacePolicyApplied) return;

  try {
    if (process.platform === 'darwin') {
      // Do not skip Electron's process-type transformation here. A normal
      // foreground app needs that transformation for macOS to place the
      // window in every Space, including another app's fullscreen Space.
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else if (process.platform === 'linux') {
      win.setVisibleOnAllWorkspaces(true);
    } else {
      return;
    }
    if (typeof win.setFullScreenable === 'function') {
      // Electron maps fullscreenable=false to the auxiliary fullscreen
      // collection behavior on macOS. Apply it after the workspace policy so
      // a hidden preheated window gets the same native state as a shown one.
      win.setFullScreenable(false);
    }
    win._overlayWorkspacePolicyApplied = true;
  } catch (error) {
    console.warn('overlay workspace policy failed:', error?.message || error);
  }
}

function applyTopMost(win) {
  // 已隐藏的窗口不能 moveTop/重申置顶：macOS 会把它们当作"再次显示"的指令，
  // 这正是"快捷键关掉悬浮窗后它又自己弹出来"的来源。
  if (!win || win.isDestroyed() || (typeof win.isVisible === 'function' && !win.isVisible())) {
    return;
  }
  applyOverlayWorkspacePolicy(win);
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setContentProtection(true);
  win.moveTop();
}

function keepWindowInFront(win, { durationMs = 5000, intervalMs = 500 } = {}) {
  stopFrontReassert();
  if (!win || win.isDestroyed()) return;
  const start = Date.now();
  applyTopMost(win);
  _frontReassertTimer = setInterval(() => {
    if (!win || win.isDestroyed() || Date.now() - start > durationMs) {
      stopFrontReassert();
      return;
    }
    applyTopMost(win);
  }, intervalMs);
}

function stopFrontReassert() {
  if (_frontReassertTimer) {
    clearInterval(_frontReassertTimer);
    _frontReassertTimer = null;
  }
}

function writeToStreamSafely(stream, chunk) {
  if (!stream || typeof stream.write !== 'function') return false;
  if (stream.destroyed || stream.writable === false) return false;
  try {
    stream.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function relayChildOutput(childStream, targetStream, prefix = '') {
  if (!childStream || typeof childStream.on !== 'function') return () => {};
  const onData = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    writeToStreamSafely(targetStream, `${prefix}${text}`);
  };
  childStream.on('data', onData);
  return () => {
    if (typeof childStream.off === 'function') childStream.off('data', onData);
    else if (typeof childStream.removeListener === 'function') childStream.removeListener('data', onData);
  };
}

// 笔试隐身时悬浮窗是否应鼠标穿透：隐身开启且光标不在面板上时穿透（点击落到
// 下方考试窗口，不抢焦点）；光标进入面板本体则放行点击（拖动/按钮/滚动可用）；
// 非隐身永远可交互。这个纯布尔是“可交互”与“不抢焦点”兼得的核心判定。
function shouldOverlayPassthrough(stealthActive, interactiveHover) {
  return Boolean(stealthActive) && !interactiveHover;
}

module.exports = {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  applyOverlayWorkspacePolicy,
  shouldOverlayPassthrough,
  applyTopMost,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  createWindowWebPreferences,
  getPromptOverlayInitialWidth,
  getWindowsStartupSwitches,
  keepWindowInFront,
  relayChildOutput,
  stopFrontReassert,
  writeToStreamSafely,
};
