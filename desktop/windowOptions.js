const { protectWindowFromCapture } = require('./captureProtection');

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

// Windows 启动开关：默认把 GPU 留在独立子进程里。
//
// 历史：因为安全软件/系统策略会结束独立 GPU 子进程（"GPU process exited
// unexpectedly" / "GPU process isn't usable. Goodbye."），这里曾默认开启
// --in-process-gpu。但现场 A/B 证明该开关本身是更大的坑：在 Intel Iris Xe +
// NVIDIA MX450 + 虚拟显示器驱动（GameViewer Virtual Display Adapter）这类
// 多显卡环境下，创建主窗口/透明悬浮窗时整个浏览器进程会原生崩溃——没有
// 弹窗、没有日志、1 秒内消失。独立 GPU 子进程即使被杀也只是渲染降级，主进程
// 还活着，配合 main.js 的 child-process-gone 监听可以自动切到软件渲染重启。
//
// 需要旧的 in-process-gpu 行为时显式设 ELECTRON_INPROCESS_GPU=1；设 0 与默认相同。
//
// 安全级别（startupSafety.js 的启动哨兵）：
//   0（默认）— 独立 GPU + 关闭 GPU 沙箱：规避 in-process 崩溃，也绕开沙箱
//               初始化失败导致的 GPU 子进程不可用
//   1        — 再关掉 GPU 合成（软件合成，保留 GPU 进程）
//   2        — 纯软件渲染（--disable-gpu），几乎在任何显卡/虚拟机/远程桌面下都能启动
//
// 旧版 --enable-transparent-visuals 默认关闭：部分 Windows 图形栈下它会连累
// 渲染进程崩溃（EGL_BAD_ALLOC / SwapChain11 错误）。需要时为透明浮窗设
// ELECTRON_TRANSPARENT_VISUALS=1 重新开启。
function getWindowsStartupSwitches(env = {}, safetyLevel = 0) {
  const level = Number.isFinite(Number(safetyLevel)) && Number(safetyLevel) > 0
    ? Math.floor(Number(safetyLevel))
    : 0;
  if (level >= 2) {
    return ['disable-gpu', 'disable-gpu-compositing'];
  }
  const switches = [];
  if (level === 0 && env.ELECTRON_INPROCESS_GPU === '1') {
    switches.push('in-process-gpu');
  } else {
    switches.push('disable-gpu-sandbox');
  }
  if (level >= 1) {
    switches.push('disable-gpu-compositing');
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
  protectWindowFromCapture(win);
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

function isPointInsideBounds(point, bounds) {
  return point.x >= bounds.x
    && point.y >= bounds.y
    && point.x < bounds.x + bounds.width
    && point.y < bounds.y + bounds.height;
}

// Windows 的 setIgnoreMouseEvents(true) 会让 Electron 的 content protection
// 在透明置顶窗上失效，导致共享屏幕时重新看到悬浮窗。最早的 Windows 版本没有
// 使用鼠标穿透，因此始终能隐身。Windows 继续使用 focusable:false +
// showInactive()，不再设置 ignore mouse events；其他平台保留悬停穿透能力。
function shouldApplyOverlayPassthrough(platform, stealthActive, interactiveHover) {
  if (platform === 'win32') return false;
  return shouldOverlayPassthrough(stealthActive, interactiveHover);
}

module.exports = {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  applyOverlayWorkspacePolicy,
  shouldApplyOverlayPassthrough,
  shouldOverlayPassthrough,
  applyTopMost,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  createWindowWebPreferences,
  getPromptOverlayInitialWidth,
  getWindowsStartupSwitches,
  isPointInsideBounds,
  keepWindowInFront,
  relayChildOutput,
  stopFrontReassert,
  writeToStreamSafely,
};
