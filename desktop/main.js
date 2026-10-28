const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  desktopCapturer,
  dialog,
} = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// 跨平台：阻止系统 occlusion / window list 计算把 overlay 暴露给屏幕共享 / 录屏 API。
// 与 BrowserWindow 的 setContentProtection(true) (+ macOS type:'panel') 形成多重防御。
//
// macOS 真正生效的方案 (Electron PR #34362, refs issue #19880):
// 1. enable ScreenCaptureKitMac —— 切换到 macOS 12.3+ 的 ScreenCaptureKit 实现，
//    PR #34362 在这个 capturer 路径里 *硬编码* 跳过 setContentProtection(true) 的窗口，
//    是目前唯一让 overlay 在「always-on-top + transparent」配置下真正隐身的方案。
// 2. disable IOSurfaceCapturer / DesktopCaptureMacV2 —— 关掉旧 capturer 防回退,
//    它们绕过 NSWindowSharingNone 让 setContentProtection 失效 (这正是 overlay 截图可见的根因)。
// 3. disable CalculateNativeWinOcclusion —— 防 OS 把 overlay 列入 window list,
//    被 CGWindowListCreateImage 类老 API 抓到。
//
// 三件齐备后, ScreenCaptureKit / CGWindowListCreateImage / Lark/钉钉/Zoom 屏幕共享、
// macOS 系统截图 (Cmd+Shift+5) 都不再录到 overlay。
app.commandLine.appendSwitch('enable-features', 'ScreenCaptureKitMac');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,IOSurfaceCapturer,DesktopCaptureMacV2',
);
const {
  ShortcutStatus,
  createShortcutState,
  loadShortcutConfig,
  saveShortcutConfig,
  validateShortcutMap,
} = require('./shortcuts');
const {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  applyOverlayWorkspacePolicy,
  applyTopMost,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  createWindowWebPreferences,
  getPromptOverlayInitialWidth,
  getWindowsStartupSwitches,
  keepWindowInFront,
  relayChildOutput,
  shouldOverlayPassthrough,
  stopFrontReassert,
} = require('./windowOptions');
const { createMultiScreenBatch } = require('./multiScreenBatch');
const { stopBackendProcess } = require('./backendShutdown');
const { registerUpdater } = require('./updater');
const { pickBackendPort } = require('./portPicker');

// Windows: 透明 BrowserWindow 需要 DWM 硬件加速。
// 历史遗留 disableHardwareAcceleration() 已移除 ——
// 它会让 setContentProtection 退化成「窗口被捕获时显示黑色」(WDA_MONITOR)，
// 而非 Win10 2004+ 才支持的「直接从屏幕捕获中排除」(WDA_EXCLUDEFROMCAPTURE)，
// 后者才是真正的屏幕共享隐身。
// 如个别老 Win7/Win8 设备透明窗口出现渲染异常，可设环境变量 ELECTRON_DISABLE_HW_ACCEL=1 回退。
// 默认启用进程内 GPU (in-process-gpu): 从下载目录 / 受管控目录启动时, 系统安全策略或
// 安全软件会终止独立 GPU 子进程 (日志: "GPU process exited unexpectedly:
// exit_code=-2147483645" / "GPU process isn't usable. Goodbye."), 界面因此不出现。
// 进程内 GPU 不再派生该子进程, 同时保留透明浮窗与 setContentProtection 所需的硬件加速。
// 个别显卡驱动在进程内 GPU 下渲染异常时, 可设环境变量 ELECTRON_INPROCESS_GPU=0 回退。
// 旧版透明视觉兼容开关 (enable-transparent-visuals) 默认关闭: 部分 Windows 图形栈下
// 它会连累渲染进程崩溃 (日志: "Renderer process crashed" /
// "eglCreateWindowSurface failed with error EGL_BAD_ALLOC" /
// "SwapChain11 ... HRESULT: 0x887A0001"), 表现为白屏窗口;
// 老机器需要时为透明浮窗设 ELECTRON_TRANSPARENT_VISUALS=1 重新开启。
// 另: Windows 上仅主窗口与浮窗关闭渲染器沙箱 (createWindowWebPreferences),
// 缓解图形环境 / 安全软件与渲染沙箱的冲突, 其余 Chromium 安全机制不受影响。
if (process.platform === 'win32') {
  for (const flag of getWindowsStartupSwitches(process.env)) {
    app.commandLine.appendSwitch(flag);
  }
  if (process.env.ELECTRON_DISABLE_HW_ACCEL === '1') {
    app.disableHardwareAcceleration();
  }
}

const pkg = require('./package.json');

/** 应用显示名：环境变量 ELECTRON_APP_DISPLAY_NAME > desktop/app-title.json > package.json appDisplayName > 默认 */
function loadAppDisplayName() {
  const env = process.env.ELECTRON_APP_DISPLAY_NAME;
  if (env && String(env).trim()) return String(env).trim();
  const titlePath = path.join(__dirname, 'app-title.json');
  try {
    const raw = fs.readFileSync(titlePath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j.appDisplayName === 'string' && j.appDisplayName.trim()) {
      return j.appDisplayName.trim();
    }
  } catch {
    /* 无文件或解析失败 */
  }
  if (pkg.appDisplayName && String(pkg.appDisplayName).trim()) {
    return String(pkg.appDisplayName).trim();
  }
  return '面试Ace';
}

const APP_DISPLAY_NAME = loadAppDisplayName();

const ROOT = path.resolve(__dirname, '..');
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : ROOT;
const BACKEND_DIR = path.join(RESOURCE_ROOT, 'backend');
const FRONTEND_DIR = path.join(RESOURCE_ROOT, 'frontend', 'dist');
// 端口启动时解析: 优先 18080, 被占用则回退到系统分配的空闲端口 (见 portPicker.js)
let PORT = parseInt(process.env.PORT || '18080', 10);
let SERVER_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let overlayWindow = null;
let tray = null;
// 笔试隐身模式（前端在 笔试模式+录制中 时通过 sync-stealth-mode 同步）：
// 隐藏托盘图标、悬浮窗默认鼠标穿透，结束笔试恢复。
let stealthModeActive = false;
// 隐身期间悬浮窗是否临时可交互：悬浮窗渲染进程检测到光标进入面板时置 true
// （放行点击/滚动/拖动到面板本身），光标离开置 false（点击重新穿透到考试窗口）。
// 悬浮窗是 focusable:false 的非激活 panel，点击它不会让考试窗口失去 key 焦点，
// 所以“可交互”与“不抢焦点”可以同时成立。
let overlayInteractiveHover = false;
let pythonProcess = null;
let isQuitting = false;
let shortcuts = {};
let _blurTimer = null;
let overlayAutoResizeUntil = 0;
let overlayPositionSaveTimer = null;
let overlayToggleBlockedUntil = 0;
let lastOverlayState = {
  initialized: false,
  enabled: false,
  visible: false,
  opacity: 0.88,
  fontSize: 14,
  fontColor: '#e2e8f0',
  showBg: true,
  mode: 'glass',
  focusWidthPct: 96,
  focusHeightPct: 90,
  promptMaxWidth: PROMPT_OVERLAY_DEFAULT_WIDTH,
  promptAutoFollow: false,
  maxLines: 0,
};

const OVERLAY_PRESET = { width: 480, height: 320, minWidth: 300, minHeight: 100, resizable: true };
const PROMPT_OVERLAY_MIN_SIZE = { width: 180, height: 72 };
const PROMPT_OVERLAY_MAX_SIZE = { heightRatio: 0.48 };
const FOCUS_OVERLAY_MARGIN = 14;

const FOCUS_OVERLAY_SHORTCUT_ACTIONS = new Set(['focusPrevTab', 'focusNextTab']);
const VISIBLE_OVERLAY_SHORTCUT_ACTIONS = new Set(['cancelAnswer', 'overlayPrevQuestion', 'overlayNextQuestion']);
const SCREEN_CAPTURE_FALLBACK_SHORTCUT = 'CommandOrControl+Shift+S';
const MACOS_SCREEN_CAPTURE_ATTEMPTS = 3;
const MACOS_SCREEN_CAPTURE_RETRY_DELAY_MS = 220;
const MACOS_SCREEN_CAPTURE_MIN_INTERVAL_MS = 180;
const MACOS_SCREEN_CAPTURE_PERMISSION_MESSAGE =
  'macOS 屏幕录制权限不足：请在“系统设置 > 隐私与安全性 > 屏幕录制”中开启当前启动本程序的终端（终端/iTerm2/IDE），然后完全退出并重新运行。';

function applyOverlayWorkspacePolicyForMain(win, force = false) {
  // main.js 侧包装：force=true 用于窗口可见后重新声明 workspace 策略。
  if (!win || win.isDestroyed()) return;
  if (force) win._overlayWorkspacePolicyApplied = false;
  applyOverlayWorkspacePolicy(win);
}

const FRONT_REASSERT_LEVEL = 1;

function getOverlayStateFilePath() {
  return path.join(app.getPath('userData'), 'overlay-window.json');
}

function loadOverlayWindowState() {
  try {
    const raw = fs.readFileSync(getOverlayStateFilePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch {
    /* ignore */
  }
  return { positions: {} };
}

function saveOverlayWindowState(data) {
  try {
    fs.writeFileSync(getOverlayStateFilePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.warn('saveOverlayWindowState failed:', error);
  }
}

function resolveOverlayMode() {
  return lastOverlayState?.mode || (lastOverlayState?.showBg === false ? 'prompt' : 'glass');
}

function getStoredOverlayPosition(saved = loadOverlayWindowState()) {
  const pos = saved?.position;
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
  const displays = screen.getAllDisplays();
  const fitsSomeDisplay = displays.some((display) => {
    const area = display.workArea;
    return (
      pos.x >= area.x - 40
      && pos.x <= area.x + area.width - 80
      && pos.y >= area.y - 40
      && pos.y <= area.y + area.height - 60
    );
  });
  if (fitsSomeDisplay) return { x: pos.x, y: pos.y };
  const { x, y } = getDefaultOverlayBounds();
  return { x, y };
}

function getDefaultOverlayBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    x: primary.x + Math.max(16, Math.round((primary.width - OVERLAY_PRESET.width) / 2)),
    y: primary.y + Math.max(16, Math.round((primary.height - OVERLAY_PRESET.height) * 0.18)),
    width: OVERLAY_PRESET.width,
    height: OVERLAY_PRESET.height,
  };
}

function getFocusOverlayBounds() {
  const canUseOverlayBounds = overlayWindow
    && !overlayWindow.isDestroyed()
    && (typeof overlayWindow.isVisible !== 'function' || overlayWindow.isVisible());
  const point = canUseOverlayBounds
    ? {
        x: overlayWindow.getBounds().x + Math.round(overlayWindow.getBounds().width / 2),
        y: overlayWindow.getBounds().y + Math.round(overlayWindow.getBounds().height / 2),
      }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const margin = FOCUS_OVERLAY_MARGIN;
  const widthPct = Math.max(50, Math.min(100, Number(lastOverlayState?.focusWidthPct) || 96));
  const heightPct = Math.max(35, Math.min(100, Number(lastOverlayState?.focusHeightPct) || 90));
  const width = Math.round((area.width - margin * 2) * (widthPct / 100));
  const height = Math.round((area.height - margin * 2) * (heightPct / 100));
  return {
    x: area.x + margin + Math.max(0, Math.round(((area.width - margin * 2) - width) / 2)),
    y: area.y + margin + Math.max(0, Math.round(((area.height - margin * 2) - height) / 2)),
    width: Math.max(OVERLAY_PRESET.minWidth, width),
    height: Math.max(OVERLAY_PRESET.minHeight, height),
  };
}

function getNormalOverlayBounds(mode) {
  const saved = loadOverlayWindowState();
  const storedPos = getStoredOverlayPosition(saved);
  const storedSize = saved?.position;
  // prompt 模式宽度由内容自适应驱动 (受 promptMaxWidth 约束), 旧物理 position.w 无意义;
  // 直接用 promptMaxWidth 作初始宽, 避免重开时先显示旧值再被前端收窄/撑开。
  let width;
  let height;
  if (mode === 'prompt') {
    width = getPromptOverlayInitialWidth(lastOverlayState?.promptMaxWidth);
    height = Math.max((storedSize?.h > 0) ? storedSize.h : OVERLAY_PRESET.height, OVERLAY_PRESET.minHeight);
  } else {
    width = Math.max((storedSize?.w > 0) ? storedSize.w : OVERLAY_PRESET.width, OVERLAY_PRESET.minWidth);
    height = Math.max((storedSize?.h > 0) ? storedSize.h : OVERLAY_PRESET.height, OVERLAY_PRESET.minHeight);
  }
  return {
    ...(storedPos ? storedPos : getDefaultOverlayBounds()),
    width,
    height,
  };
}

function applyOverlayModeBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const mode = resolveOverlayMode();
  overlayWindow.setMinimumSize(
    mode === 'prompt' ? PROMPT_OVERLAY_MIN_SIZE.width : OVERLAY_PRESET.minWidth,
    mode === 'prompt' ? PROMPT_OVERLAY_MIN_SIZE.height : OVERLAY_PRESET.minHeight,
  );
  const bounds = mode === 'focus' ? getFocusOverlayBounds() : getNormalOverlayBounds(mode);
  overlayWindow.setBounds(bounds, false);
}

function persistOverlayPosition(force = false) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (lastOverlayState?.mode === 'focus') return;
  // fuse 屏蔽窗口 resize/moved 事件在程序化 setBounds 后 500ms 内的频繁写盘;
  // force=true 用于程序化设尺寸后的显式落盘 (来自 resize-overlay-window IPC), 绕过 fuse。
  if (!force && Date.now() < overlayAutoResizeUntil) return;
  const bounds = overlayWindow.getBounds();
  const saved = loadOverlayWindowState();
  saved.position = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
  saveOverlayWindowState(saved);
}

let overlayPositionSaveForce = false;

function schedulePersistOverlayPosition(force = false) {
  // 已有 force 落盘在排队时, 非 force 的调度只能延后不能降级,
  // 否则 resize 事件会把 resize-overlay-window 的显式落盘冲掉, 程序化尺寸永不写入。
  if (overlayPositionSaveTimer) {
    clearTimeout(overlayPositionSaveTimer);
    force = force || overlayPositionSaveForce;
  }
  overlayPositionSaveForce = force;
  overlayPositionSaveTimer = setTimeout(() => {
    overlayPositionSaveTimer = null;
    overlayPositionSaveForce = false;
    persistOverlayPosition(force);
  }, 180);
}

function createTrayIcon() {
  const size = 16;
  const canvas = nativeImage.createFromBuffer(
    Buffer.alloc(size * size * 4, 0),
    { width: size, height: size }
  );
  return canvas;
}

function waitForServer(timeout = 40000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`${SERVER_URL}/api/options`, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeout) return reject(new Error('Server start timeout'));
      setTimeout(check, 300);
    };
    check();
  });
}

function startPythonBackend() {
  let executable;
  let args;
  if (app.isPackaged) {
    const executableName = process.platform === 'win32'
      ? 'interview-assistant-backend.exe'
      : 'interview-assistant-backend';
    executable = path.join(BACKEND_DIR, executableName);
    if (!fs.existsSync(executable)) {
      throw new Error(`安装包缺少后端文件: ${executable}`);
    }
    args = ['--port', String(PORT)];
  } else {
    const projectPython = process.platform === 'win32'
      ? path.join(ROOT, 'env', 'Scripts', 'python.exe')
      : path.join(ROOT, 'env', 'bin', 'python');
    executable = process.env.IA_PYTHON_EXECUTABLE
      || (fs.existsSync(projectPython) ? projectPython : null)
      || (process.platform === 'win32' ? 'python' : 'python3');
    args = [
      path.join(ROOT, 'start.py'),
      '--mode', 'network',
      '--no-build',
      '--port', String(PORT),
    ];
  }

  const backendEnv = { ...process.env };
  if (app.isPackaged) {
    const appDataDir = app.getPath('userData');
    backendEnv.PORT = String(PORT);
    backendEnv.IA_APP_DATA_DIR = appDataDir;
    backendEnv.IA_CONFIG_PATH = path.join(appDataDir, 'config.json');
    backendEnv.IA_CONFIG_EXAMPLE_PATH = path.join(BACKEND_DIR, 'config.example.json');
    backendEnv.IA_FRONTEND_DIR = FRONTEND_DIR;
    backendEnv.IA_LOG_DIR = path.join(appDataDir, 'log');
    backendEnv.IA_PREFLIGHT_AUDIO_PATH = path.join(BACKEND_DIR, 'assets', 'preflight_phrase.wav');
  }

  console.log(`[py] interpreter=${executable}`);
  pythonProcess = spawn(executable, args, {
    cwd: app.isPackaged ? app.getPath('userData') : ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: backendEnv,
    windowsHide: true,
  });

  relayChildOutput(pythonProcess.stdout, process.stdout, '[py] ');
  relayChildOutput(pythonProcess.stderr, process.stderr, '[py] ');
  pythonProcess.on('close', (code) => {
    console.log(`[py] exited with code ${code}`);
    pythonProcess = null;
    if (!isQuitting) {
      if (mainWindow) {
        dialog.showErrorBox('后端已退出', `Python 后端进程异常退出 (code ${code})。\n请查看日志确认原因后重试。`);
      }
      app.quit();
    }
  });
}

function createWindow() {
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: APP_DISPLAY_NAME,
    frame: false,
    show: false,
    // Windows 下不在任务栏显示，只在托盘
    skipTaskbar: isWindows,
    webPreferences: createWindowWebPreferences(process.platform, path.join(__dirname, 'preload.js')),
  });

  mainWindow.setContentProtection(true);

  // 每次启动清除缓存，确保加载到最新的前端构建（避免设置里识别引擎等不更新）
  mainWindow.webContents.session.clearCache().then(() => {
    mainWindow.loadURL(SERVER_URL);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const t = JSON.stringify(APP_DISPLAY_NAME);
    mainWindow.webContents.executeJavaScript(`document.title = ${t}`).catch(() => {});
    mainWindow.setTitle(APP_DISPLAY_NAME);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Windows 下最小化 = 隐藏到托盘
  mainWindow.on('minimize', (e) => {
    if (process.platform === 'win32') {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // macOS Dock 图标跟随主窗口显隐：窗口隐藏（笔试/面试隐蔽场景只留悬浮窗）时
  // Dock 里也不出现本软件；窗口重新显示（托盘点击/快捷键）时恢复。
  // Windows 主窗口本就 skipTaskbar，无需处理。
  if (process.platform === 'darwin' && app.dock) {
    mainWindow.on('hide', () => { app.dock.hide(); });
    mainWindow.on('show', () => { app.dock.show(); });
  }

  // 关闭按钮 = 真正退出
  mainWindow.on('close', () => {
    isQuitting = true;
  });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const initialMode = resolveOverlayMode();
  const initialBounds = initialMode === 'focus' ? getFocusOverlayBounds() : getNormalOverlayBounds(initialMode);

  // 透明浮窗: 视觉上能看到桌面, 需要 transparent: true + alpha=0 背景.
  // 注意: setContentProtection 在 macOS 的透明窗口上只是 best effort,
  // 对部分截图路径 (尤其是 ScreenCaptureKit) 可能无效; 这是 OS 级限制.
  overlayWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    minWidth: OVERLAY_PRESET.minWidth,
    minHeight: OVERLAY_PRESET.minHeight,
    ...createOverlayChromeOptions(process.platform, OVERLAY_PRESET.resizable),
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    show: false,
    autoHideMenuBar: true,
    roundedCorners: true,
    title: `${APP_DISPLAY_NAME} Overlay`,
    webPreferences: createWindowWebPreferences(process.platform, path.join(__dirname, 'preload.js'), {
      backgroundThrottling: false,
    }),
  });

  // Content protection 必须尽早调用 —— 等到 ready-to-show 时,
  // 窗口可能已经被 window server 登记过一次, 导致 NSWindowSharingNone 漏掉初始帧
  overlayWindow.setContentProtection(true);
  overlayWindow.setBackgroundColor('#00000000');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', FRONT_REASSERT_LEVEL);
  if (stealthModeActive) {
    // 笔试隐身期间新建的悬浮窗同样默认鼠标穿透（光标进入面板时再临时放行）
    applyOverlayMousePassthrough();
  }
  if (process.platform === 'darwin') {
    // macOS: NSWindowCollectionBehaviorCanJoinAllSpaces + Transient
    // 让窗口不进入 Cmd+Tab, Mission Control, Exposé, 以及 CGWindowList
    try {
      overlayWindow.setHiddenInMissionControl(true);
    } catch { /* older electron */ }
  }

// Content protection / 透明背景 / 禁用焦点需要在多个时机重复断言 (防御纵深)
function assertOverlayChrome(withAlwaysOnTop = false) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setContentProtection(true);
  overlayWindow.setBackgroundColor('#00000000');
  overlayWindow.setFocusable(false);
  if (withAlwaysOnTop) overlayWindow.setAlwaysOnTop(true, 'screen-saver', FRONT_REASSERT_LEVEL);
}

  overlayWindow._overlayReady = false;

  overlayWindow.once('ready-to-show', () => {
    assertOverlayChrome(true);
  });
  overlayWindow.loadURL(`${SERVER_URL}?overlay=1`);
  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    assertOverlayChrome();
    if (lastOverlayState) {
      overlayWindow.webContents.send('overlay-state', lastOverlayState);
    }
    setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      overlayWindow._overlayReady = true;
      if (consumePendingOverlayShow(overlayWindow, lastOverlayState?.visible)) {
        showOverlayWindow();
      }
    }, process.platform === 'win32' ? 120 : 0);
  });
  overlayWindow.on('show', () => {
    assertOverlayChrome(true);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
    stopFrontReassert();
  });
  overlayWindow.on('moved', () => schedulePersistOverlayPosition());
  overlayWindow.on('resize', () => schedulePersistOverlayPosition());
  overlayWindow.on('focus', () => {
    if (_blurTimer) clearTimeout(_blurTimer);
    _blurTimer = setTimeout(() => {
      _blurTimer = null;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.blur();
      }
    }, 150);
  });

  return overlayWindow;
}

function sendOverlayState(payload) {
  lastOverlayState = payload;
  [mainWindow, overlayWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('overlay-state', payload);
  });
}

function sendShortcutsState() {
  [mainWindow, overlayWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('shortcuts-state', shortcuts);
  });
}

function registerScreenCaptureFallback() {
  const configuredKey = shortcuts.askFromServerScreen?.key;
  if (configuredKey === SCREEN_CAPTURE_FALLBACK_SHORTCUT) return;
  const callback = shortcutCallbacks.askFromServerScreen;
  if (!callback) return;
  if (globalShortcut.register(SCREEN_CAPTURE_FALLBACK_SHORTCUT, callback)) {
    console.log(`[shortcut] registered fallback action=askFromServerScreen key=${SCREEN_CAPTURE_FALLBACK_SHORTCUT}`);
  } else {
    console.warn(`[shortcut] failed fallback action=askFromServerScreen key=${SCREEN_CAPTURE_FALLBACK_SHORTCUT}`);
  }
}

function unregisterScreenCaptureFallback() {
  if (shortcuts.askFromServerScreen?.key !== SCREEN_CAPTURE_FALLBACK_SHORTCUT) {
    globalShortcut.unregister(SCREEN_CAPTURE_FALLBACK_SHORTCUT);
  }
}

function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!lastOverlayState?.visible) {
    overlayWindow._pendingShow = false;
    overlayWindow.hide();
    return;
  }
  if (!overlayWindow._overlayReady) {
    overlayWindow._pendingShow = true;
    return;
  }
  applyOverlayModeBounds();
  overlayWindow.setFocusable(false);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    overlayWindow.showInactive();
  } else {
    overlayWindow.show();
  }
  // Apply this after the native window is visible. On macOS, applying the
  // fullscreen workspace policy while the window is preheated/hidden can
  // leave it behind an already fullscreen Safari Space.
  applyOverlayWorkspacePolicyForMain(overlayWindow, true);
  overlayWindow.setContentProtection(true);
  keepWindowInFront(overlayWindow);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function notifyMainWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function notifyDesktopToast(message, level = 'info') {
  if (!message) return;
  notifyMainWindow('desktop-toast', { message: String(message), level });
}

function notifyConfigUpdated(config) {
  if (config && typeof config === 'object') {
    notifyMainWindow('config-updated', config);
  }
}

function requestBackend(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(`${SERVER_URL}${pathname}`, { method, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          const emptyFallback = method === 'POST' ? { ok: true } : {};
          if (!raw) { resolve(emptyFallback); return; }
          try { resolve(JSON.parse(raw)); } catch { resolve(emptyFallback); }
          return;
        }
        const backendError = new Error(raw || res.statusMessage || `HTTP ${res.statusCode}`);
        backendError.statusCode = res.statusCode;
        backendError.responseBody = raw;
        reject(backendError);
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function postBackend(pathname, body = '{}') {
  return requestBackend(pathname, { method: 'POST', body });
}

function describeBackendError(error, fallback = '未知错误') {
  const raw = error?.message || error;
  if (!raw) return fallback;
  if (typeof raw !== 'string') return String(raw);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail;
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error;
  } catch {
    // Keep the original response when it is not JSON.
  }
  return raw;
}

function describeHttpFailure(error) {
  const status = Number.isFinite(error?.statusCode) ? ` status=${error.statusCode}` : '';
  const response = typeof error?.responseBody === 'string'
    ? error.responseBody.replace(/\s+/g, ' ').slice(0, 500)
    : '';
  return `${status}${response ? ` response=${response}` : ''}`;
}

let screenCaptureInFlight = null;

function waitMs(delayMs = 180) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Electron windows use content protection, so a protected window is omitted
 * from macOS screenshots while still physically covering the browser behind it.
 * Hide our windows for one capture frame, then restore only what was visible.
 */
function withWindowsHiddenForScreenCapture(task) {
  if (screenCaptureInFlight) return screenCaptureInFlight;

  const operation = (async () => {
    const mainWasVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
    const overlayWasVisible = Boolean(
      overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible(),
    );

    if (overlayWasVisible) overlayWindow.hide();
    if (mainWasVisible) mainWindow.hide();
    await waitMs();

    try {
      return await task();
    } finally {
      if (mainWasVisible && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
      if (overlayWasVisible && overlayWindow && !overlayWindow.isDestroyed()) {
        showOverlayWindow();
      }
    }
  })();

  screenCaptureInFlight = operation;
  operation.finally(() => {
    if (screenCaptureInFlight === operation) screenCaptureInFlight = null;
  }).catch(() => {});
  return operation;
}

function normalizeScreenRegion(region) {
  const valid = new Set(['full', 'left_half', 'right_half', 'top_half', 'bottom_half']);
  return valid.has(region) ? region : 'left_half';
}

function cropNativeImage(image, region) {
  const size = image.getSize();
  const halfWidth = Math.floor(size.width / 2);
  const halfHeight = Math.floor(size.height / 2);
  switch (normalizeScreenRegion(region)) {
    case 'full':
      return image;
    case 'right_half':
      return image.crop({
        x: halfWidth,
        y: 0,
        width: Math.max(1, size.width - halfWidth),
        height: size.height,
      });
    case 'top_half':
      return image.crop({
        x: 0,
        y: 0,
        width: size.width,
        height: Math.max(1, halfHeight),
      });
    case 'bottom_half':
      return image.crop({
        x: 0,
        y: halfHeight,
        width: size.width,
        height: Math.max(1, size.height - halfHeight),
      });
    case 'left_half':
    default:
      return image.crop({
        x: 0,
        y: 0,
        width: Math.max(1, halfWidth),
        height: size.height,
      });
  }
}

function isMacOSScreenCapturePermissionError(detail) {
  const text = String(detail || '').toLowerCase();
  return (
    text.includes('could not create image from display')
    || text.includes('tcc')
    || text.includes('screen recording')
    || text.includes('permission')
    || text.includes('拒绝了应用程序、窗口、显示器捕捉')
  );
}

function captureMacOSScreenImageOnce() {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(
      app.getPath('temp'),
      `interview-assistant-screen-${process.pid}-${Date.now()}.jpg`,
    );
    const capture = spawn('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', outputPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const finish = (error, image) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { fs.unlinkSync(outputPath); } catch {}
      if (error) {
        reject(error);
      } else {
        resolve(image);
      }
    };
    const timeout = setTimeout(() => {
      capture.kill('SIGTERM');
      finish(new Error('macOS 系统截图超时'));
    }, 15000);

    capture.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    capture.on('error', (error) => finish(error));
    capture.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim();
        const error = new Error(
          isMacOSScreenCapturePermissionError(detail)
            ? MACOS_SCREEN_CAPTURE_PERMISSION_MESSAGE
            : (detail || `macOS 系统截图失败，退出码 ${code}`),
        );
        error.exitCode = code;
        error.stderr = detail;
        error.isMacOSScreenCapturePermission = isMacOSScreenCapturePermissionError(detail);
        finish(error);
        return;
      }
      try {
        if (!fs.existsSync(outputPath)) {
          finish(new Error('macOS 系统截图未生成输出文件'));
          return;
        }
        const imageBuffer = fs.readFileSync(outputPath);
        if (!imageBuffer.length) {
          finish(new Error('macOS 系统截图输出文件为空'));
          return;
        }
        const image = nativeImage.createFromBuffer(imageBuffer);
        if (!image || image.isEmpty()) {
          finish(new Error('macOS 系统截图返回空图片'));
          return;
        }
        console.log(`[screen-capture] source=macos-screencapture size=${image.getSize().width}x${image.getSize().height}`);
        finish(null, image);
      } catch (error) {
        finish(error);
      }
    });
  });
}

let lastMacOSScreenCaptureAt = 0;

async function captureMacOSScreenImage() {
  const elapsed = Date.now() - lastMacOSScreenCaptureAt;
  if (elapsed < MACOS_SCREEN_CAPTURE_MIN_INTERVAL_MS) {
    await waitMs(MACOS_SCREEN_CAPTURE_MIN_INTERVAL_MS - elapsed);
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MACOS_SCREEN_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      const image = await captureMacOSScreenImageOnce();
      lastMacOSScreenCaptureAt = Date.now();
      if (attempt > 1) {
        console.log(`[screen-capture] macos retry succeeded attempt=${attempt}`);
      }
      return image;
    } catch (error) {
      lastError = error;
      console.warn(
        `[screen-capture] macos attempt=${attempt}/${MACOS_SCREEN_CAPTURE_ATTEMPTS}` +
        ` exitCode=${error?.exitCode ?? 'n/a'}` +
        `${error?.stderr ? ` stderr=${error.stderr}` : ''} failed:`,
        error?.message || error,
      );
      if (error?.isMacOSScreenCapturePermission) break;
      if (attempt < MACOS_SCREEN_CAPTURE_ATTEMPTS) {
        await waitMs(MACOS_SCREEN_CAPTURE_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    lastError?.isMacOSScreenCapturePermission
      ? lastError.message
      : `macOS 系统截图失败（已重试 ${MACOS_SCREEN_CAPTURE_ATTEMPTS} 次）：${lastError?.message || '未知错误'}`,
  );
}

async function captureDesktopScreenDataUrl() {
  let cfg = {};
  try {
    cfg = await getBackend('/api/config');
  } catch {
    // Keep the native capture usable if configuration refresh is temporarily unavailable.
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  let image;
  if (process.platform === 'darwin') {
    // Electron 41 can leave desktopCapturer.getSources() pending on some macOS
    // ScreenCaptureKit configurations. The system capture command is reliable
    // here and uses the same screen-recording permission.
    image = await captureMacOSScreenImage();
  } else {
    if (!desktopCapturer || typeof desktopCapturer.getSources !== 'function') {
      throw new Error('当前 Electron 不支持桌面屏幕采集');
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, primaryDisplay.size.width),
        height: Math.max(1, primaryDisplay.size.height),
      },
      fetchWindowIcons: false,
    });
    if (!sources.length) throw new Error('未检测到可用的屏幕采集源');

    const displayId = String(primaryDisplay.id);
    const source = sources.find((item) => String(item.display_id) === displayId) || sources[0];
    image = source.thumbnail;
    if (!image || image.isEmpty()) throw new Error('屏幕采集返回空图片');
  }

  image = cropNativeImage(image, cfg.screen_capture_region || 'left_half');
  const maxLongEdge = Math.max(0, Math.min(4000, Number(cfg.screen_capture_max_long_edge) || 1600));
  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height);
  if (maxLongEdge > 0 && longEdge > maxLongEdge) {
    const scale = maxLongEdge / longEdge;
    image = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best',
    });
  }
  return `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`;
}

function askFromServerScreenThroughDesktop(body = '{}') {
  return withWindowsHiddenForScreenCapture(async () => {
    let image;
    try {
      image = await captureDesktopScreenDataUrl();
    } catch (error) {
      const detail = describeBackendError(error, '无法获取桌面截图');
      console.error(`[screen-capture] capture failed platform=${process.platform}: ${detail}`);
      if (process.platform === 'darwin') {
        throw new Error(`macOS 桌面截图失败：${detail}`);
      }
      console.warn(`[screen-capture] native capture failed, fallback=backend detail=${detail}`);
      try {
        return await postBackend('/api/ask-from-server-screen', body);
      } catch (fallbackError) {
        const fallbackDetail = describeBackendError(fallbackError, '后端截图接口失败');
        console.error(
          `[screen-capture] backend fallback failed endpoint=/api/ask-from-server-screen${describeHttpFailure(fallbackError)}: ${fallbackDetail}`,
        );
        throw new Error(`桌面截图失败，后备接口也失败：${fallbackDetail}`);
      }
    }

    let overrideThinkMode;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.override_think_mode === 'boolean') {
        overrideThinkMode = parsed.override_think_mode;
      }
    } catch {
      // Use the default think mode for malformed or empty override payloads.
    }
    const requestBody = { images: [image] };
    if (overrideThinkMode !== undefined) {
      requestBody.override_think_mode = overrideThinkMode;
    }
    const requestPath = '/api/ask-from-server-screens';
    const requestPayload = JSON.stringify(requestBody);
    console.log(`[screen-capture] submit endpoint=${requestPath} images=1 bytes=${Buffer.byteLength(requestPayload)}`);
    try {
      return await postBackend(requestPath, requestPayload);
    } catch (error) {
      const detail = describeBackendError(error, '视觉模型接口失败');
      console.error(
        `[screen-capture] submit failed endpoint=${requestPath}${describeHttpFailure(error)}: ${detail}`,
      );
      throw new Error(`截图已获取，但提交视觉模型失败：${detail}`);
    }
  });
}

function captureServerScreenThroughDesktop() {
  return withWindowsHiddenForScreenCapture(async () => {
    try {
      return { ok: true, image: await captureDesktopScreenDataUrl() };
    } catch (error) {
      const detail = describeBackendError(error, '无法获取桌面截图');
      console.error(`[screen-capture] capture-only failed platform=${process.platform}: ${detail}`);
      if (process.platform === 'darwin') {
        throw new Error(`macOS 桌面截图失败：${detail}`);
      }
      console.warn(`[screen-capture] native capture-only failed, fallback=backend detail=${detail}`);
      try {
        return await postBackend('/api/capture-server-screen');
      } catch (fallbackError) {
        const fallbackDetail = describeBackendError(fallbackError, '后端截图接口失败');
        console.error(
          `[screen-capture] capture-only backend fallback failed endpoint=/api/capture-server-screen${describeHttpFailure(fallbackError)}: ${fallbackDetail}`,
        );
        throw new Error(`桌面截图失败，后备接口也失败：${fallbackDetail}`);
      }
    }
  });
}

function getBackend(pathname) {
  return requestBackend(pathname);
}

async function getMultiScreenIdleMs() {
  try {
    const cfg = await getBackend('/api/config');
    const sec = Number(cfg?.multi_screen_capture_idle_sec ?? 10);
    return Math.max(1, Math.min(60, Number.isFinite(sec) ? sec : 10)) * 1000;
  } catch {
    return 10000;
  }
}

const multiServerScreenBatch = createMultiScreenBatch({
  submitImages: (images) => (
    postBackend('/api/ask-from-server-screens', JSON.stringify({ images }))
  ),
  onError: (error) => {
    console.error('flushMultiServerScreenBatch failed:', error);
  },
});

async function addMultiServerScreenShot() {
  try {
    const res = await captureServerScreenThroughDesktop();
    if (!res?.image) throw new Error('capture response missing image');
    const idleMs = await getMultiScreenIdleMs();
    multiServerScreenBatch.add(res.image, idleMs);
  } catch (error) {
    const detail = describeBackendError(error, '连续截图失败');
    console.error(`[shortcut] addMultiServerScreenShot failed: ${detail}`);
    notifyDesktopToast(detail, 'error');
  }
}

function createTray() {
  if (stealthModeActive) return; // 笔试隐身期间不创建托盘图标
  const iconPath = path.join(__dirname, 'icon.png');
  let icon;
  icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = createTrayIcon();
  icon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip(APP_DISPLAY_NAME);

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '隐藏到托盘', click: () => toggleWindow() },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: false,
      click: (menuItem) => {
        mainWindow?.setAlwaysOnTop(menuItem.checked, 'floating');
      },
    },
    {
      label: '屏幕共享隐身',
      type: 'checkbox',
      checked: true,
      click: (menuItem) => {
        mainWindow?.setContentProtection(menuItem.checked);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  // Windows 双击托盘图标也能显示
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// 悬浮窗的鼠标穿透由两个状态合成：
// - 隐身开启时默认穿透（点击落到下方考试窗口，不抢焦点、不触发失焦检测）；
// - 但光标进入面板本体时临时放行（overlayInteractiveHover=true），让拖动/按钮/
//   滚动在面板上照常可用。forward:true 保证穿透期间 move 事件仍送到渲染进程，
//   渲染进程才能在光标进入/离开时翻转 overlayInteractiveHover。
// 非隐身时永远可交互。
function applyOverlayMousePassthrough() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const passthrough = shouldOverlayPassthrough(stealthModeActive, overlayInteractiveHover);
  overlayWindow.setIgnoreMouseEvents(passthrough, { forward: true });
}

// 笔试隐身模式（前端在 笔试模式+录制中 时同步）：
// 1) 销毁菜单栏/系统托盘图标——全屏考试时菜单栏不再暴露本软件；
// 2) 悬浮窗默认鼠标穿透——空白处点击落到下方考试窗口，不抢焦点、不触发失焦检测；
//    光标移到面板上时临时放行点击（见 applyOverlayMousePassthrough），拖动/按钮/
//    滚动照常可用，且因悬浮窗是非激活 panel，点击它不会让考试窗口失去焦点。
// 结束笔试即恢复：重建托盘、悬浮窗恢复常规可交互。
function applyStealthMode(active) {
  const next = Boolean(active);
  if (next === stealthModeActive) return;
  stealthModeActive = next;
  overlayInteractiveHover = false; // 进/出隐身都从“默认穿透”重新开始
  if (next && tray) {
    tray.destroy();
    tray = null;
  } else if (!next && !tray) {
    createTray();
  }
  applyOverlayMousePassthrough();
}

function isFocusOverlayActive() {
  const mode = resolveOverlayMode();
  return Boolean(lastOverlayState?.visible) && mode === 'focus';
}

function isOverlayShortcutActive(action) {
  if (FOCUS_OVERLAY_SHORTCUT_ACTIONS.has(action)) return isFocusOverlayActive();
  if (VISIBLE_OVERLAY_SHORTCUT_ACTIONS.has(action)) return Boolean(lastOverlayState?.visible);
  // Non-overlay shortcuts are intentionally global and should stay registered.
  return true;
}

function registerManagedShortcut(shortcut) {
  const callback = shortcutCallbacks[shortcut.action];
  if (!callback) {
    shortcut.status = ShortcutStatus.Available;
    console.warn(`[shortcut] no callback action=${shortcut.action} key=${shortcut.key}`);
    return false;
  }
  if (globalShortcut.register(shortcut.key, callback)) {
    shortcut.status = ShortcutStatus.Registered;
    console.log(`[shortcut] registered action=${shortcut.action} key=${shortcut.key}`);
    return true;
  }
  shortcut.status = ShortcutStatus.Failed;
  console.warn(`[shortcut] failed action=${shortcut.action} key=${shortcut.key}`);
  return false;
}

function registerShortcuts() {
  shortcuts = loadShortcutConfig(app);
  Object.values(shortcuts).forEach((shortcut) => {
    if (!isOverlayShortcutActive(shortcut.action)) {
      shortcut.status = ShortcutStatus.Available;
      return;
    }
    registerManagedShortcut(shortcut);
  });
  registerScreenCaptureFallback();
  syncFocusOverlayShortcuts();
}

function unregisterShortcut(action) {
  const shortcut = shortcuts[action];
  if (!shortcut) return;
  globalShortcut.unregister(shortcut.key);
  shortcut.status = ShortcutStatus.Available;
}

function unregisterAllManagedShortcuts() {
  Object.keys(shortcuts).forEach((action) => unregisterShortcut(action));
  unregisterScreenCaptureFallback();
}

function syncFocusOverlayShortcuts() {
  for (const action of new Set([...FOCUS_OVERLAY_SHORTCUT_ACTIONS, ...VISIBLE_OVERLAY_SHORTCUT_ACTIONS])) {
    const shortcut = shortcuts[action];
    if (!shortcut) continue;
    if (isOverlayShortcutActive(action)) {
      if (shortcut.status !== ShortcutStatus.Registered) registerManagedShortcut(shortcut);
    } else if (shortcut.status === ShortcutStatus.Registered || shortcut.status === ShortcutStatus.Failed) {
      unregisterShortcut(action);
    }
  }
  sendShortcutsState();
}

function registerShortcutSet(nextShortcuts) {
  const validation = validateShortcutMap(nextShortcuts);
  if (!validation.ok) {
    return { ok: false, error: validation.error, shortcuts };
  }

  const prevShortcuts = shortcuts;
  unregisterAllManagedShortcuts();

  const nextState = JSON.parse(JSON.stringify(nextShortcuts));
  let failedKey = null;
  for (const shortcut of Object.values(nextState)) {
    if (!isOverlayShortcutActive(shortcut.action)) {
      shortcut.status = ShortcutStatus.Available;
      continue;
    }
    if (!shortcutCallbacks[shortcut.action]) continue;
    if (!registerManagedShortcut(shortcut)) {
      failedKey = shortcut.key;
      break;
    }
  }

  if (failedKey) {
    Object.values(nextState).forEach((shortcut) => globalShortcut.unregister(shortcut.key));
    shortcuts = prevShortcuts;
    for (const shortcut of Object.values(shortcuts)) {
      if (!isOverlayShortcutActive(shortcut.action)) {
        shortcut.status = ShortcutStatus.Available;
        continue;
      }
      if (!shortcutCallbacks[shortcut.action]) continue;
      registerManagedShortcut(shortcut);
    }
    return { ok: false, error: `快捷键注册失败：${failedKey}`, shortcuts };
  }

  shortcuts = nextState;
  registerScreenCaptureFallback();
  syncFocusOverlayShortcuts();
  saveShortcutConfig(app, shortcuts);
  return { ok: true, shortcuts };
}

const shortcutCallbacks = {
  hideOrShowWindow: () => toggleWindow(),
  hardClearSession: async () => {
    try {
      await postBackend('/api/clear');
    } catch (error) {
      console.error('hardClearSession failed:', error);
    }
  },
  askFromServerScreen: async () => {
    console.log('[shortcut] triggered action=askFromServerScreen');
    try {
      await askFromServerScreenThroughDesktop();
    } catch (error) {
      const detail = describeBackendError(error, '截图审题失败');
      console.error(`[shortcut] askFromServerScreen failed: ${detail}`);
      notifyDesktopToast(detail, 'error');
    }
  },
  askScreenForceThink: async () => {
    try {
      await askFromServerScreenThroughDesktop(JSON.stringify({ override_think_mode: true }));
      notifyDesktopToast('已提交强制思考截图审题', 'success');
    } catch (error) {
      console.error('askScreenForceThink failed:', error);
      notifyDesktopToast(error?.message || '强制思考截图失败', 'error');
    }
  },
  askScreenForceNoThink: async () => {
    try {
      await askFromServerScreenThroughDesktop(JSON.stringify({ override_think_mode: false }));
      notifyDesktopToast('已提交强制非思考截图审题', 'success');
    } catch (error) {
      console.error('askScreenForceNoThink failed:', error);
      notifyDesktopToast(error?.message || '强制非思考截图失败', 'error');
    }
  },
  toggleThinkMode: async () => {
    try {
      const cfg = await getBackend('/api/config');
      let nextPayload;
      let toastMsg;
      if (cfg?.written_exam_mode) {
        const next = !Boolean(cfg.written_exam_think);
        nextPayload = await postBackend('/api/config', JSON.stringify({
          written_exam_think: next,
        }));
        toastMsg = next ? '笔试思考模式已开启' : '笔试思考模式已关闭';
      } else {
        const next = !Boolean(cfg?.think_mode);
        nextPayload = await postBackend('/api/config', JSON.stringify({
          think_mode: next,
          think_effort: next ? 'xhigh' : 'off',
        }));
        toastMsg = next ? '全局思考模式已开启' : '全局思考模式已关闭';
      }
      notifyConfigUpdated(nextPayload);
      notifyDesktopToast(toastMsg, 'success');
    } catch (error) {
      console.error('toggleThinkMode failed:', error);
      notifyDesktopToast(error?.message || '切换思考模式失败', 'error');
    }
  },
  cancelAnswer: async () => {
    try {
      await postBackend('/api/ask/cancel');
    } catch (error) {
      console.error('cancelAnswer failed:', error);
    }
  },
  addMultiServerScreenShot,
  toggleInterviewOverlay: () => {
    // Electron may repeat a global shortcut while the key is held. Debounce
    // the toggle so one physical press cannot hide and immediately re-show it.
    if (Date.now() < overlayToggleBlockedUntil) return;
    overlayToggleBlockedUntil = Date.now() + 350;
    // 不能只看 lastOverlayState.visible：主窗口的 useOverlayWindowSync 每次
    // 渲染都会回推一份不带 visible 的状态并隐藏窗口，overlay 实际已隐藏时
    // lastOverlayState.visible 可能仍停留在 true，按一次快捷键会被误判为
    // "关闭"，出现"按第一次没反应、第二次才打开/关不上"的双按现象。
    // 显隐状态以真实窗口为准（就绪期间看 _pendingShow 待显示标志），
    // lastOverlayState 只用于窗口已被销毁等兜底场景。
    const windowVisible = Boolean(
      overlayWindow
      && !overlayWindow.isDestroyed()
      && (overlayWindow._overlayReady ? overlayWindow.isVisible() : overlayWindow._pendingShow),
    );
    const nextVisible = !(windowVisible || (lastOverlayState.visible && (!overlayWindow || overlayWindow.isDestroyed())));
    const nextState = {
      ...lastOverlayState,
      initialized: true,
      enabled: nextVisible || lastOverlayState.enabled,
      visible: nextVisible,
    };
    sendOverlayState(nextState);
    syncFocusOverlayShortcuts();

    if (nextVisible) {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow._hiddenByOverlay = true;
        mainWindow.hide();
      }
      createOverlayWindow();
      showOverlayWindow();
    } else {
      // 快捷键仅切换 overlay 可见性, 主窗口保持原状 (用户可通过 Cmd+B 或托盘唤回).
      // 只有 ControlBar 的 "结束面试" 按钮会走 sync-overlay-window IPC 恢复主窗口.
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow._pendingShow = false;
        overlayWindow.hide();
      }
    }
  },
  moveOverlayToMouse: () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const offsetX = 20;
    const offsetY = 20;
    const nextX = Math.round(cursor.x - offsetX);
    const nextY = Math.round(cursor.y - offsetY);
    overlayWindow.setPosition(nextX, nextY);
    schedulePersistOverlayPosition();
  },
  focusPrevTab: () => sendFocusTabCommand('prev'),
  focusNextTab: () => sendFocusTabCommand('next'),
  overlayPrevQuestion: () => sendOverlayQuestionCommand('prev'),
  overlayNextQuestion: () => sendOverlayQuestionCommand('next'),
};

function sendFocusTabCommand(direction) {
  if (!isFocusOverlayActive()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('focus-tab-command', direction);
}

function sendOverlayQuestionCommand(direction) {
  if (!lastOverlayState?.visible) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay-question-command', direction);
}

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('quit-app', () => { isQuitting = true; app.quit(); });
ipcMain.handle('ask-from-server-screen', (_event, payload = {}) => (
  askFromServerScreenThroughDesktop(JSON.stringify(payload || {}))
));
ipcMain.handle('get-shortcuts', () => shortcuts);
ipcMain.handle('update-shortcuts', (_event, updates) => {
  const next = JSON.parse(JSON.stringify(shortcuts));
  for (const update of updates || []) {
    if (!update || typeof update.action !== 'string' || typeof update.key !== 'string') continue;
    if (!next[update.action]) continue;
    next[update.action].key = update.key;
  }
  const result = registerShortcutSet(next);
  if (result.ok) sendShortcutsState();
  return result;
});
ipcMain.handle('reset-shortcuts', () => {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'shortcuts.json')); } catch {}
  const defaults = createShortcutState();
  const result = registerShortcutSet(defaults);
  if (result.ok) sendShortcutsState();
  return result;
});
ipcMain.handle('sync-stealth-mode', (_event, payload = {}) => {
  applyStealthMode(Boolean(payload?.active));
  return { ok: true, active: stealthModeActive };
});

// 隐身期间悬浮窗渲染进程上报光标是否在面板上：在面板上则临时放行点击，
// 离开则恢复穿透。非隐身时该标志不影响（applyOverlayMousePassthrough 只在隐身时穿透）。
ipcMain.handle('set-overlay-interactive', (_event, payload = {}) => {
  overlayInteractiveHover = Boolean(payload?.interactive);
  applyOverlayMousePassthrough();
  return { ok: true, interactive: overlayInteractiveHover };
});

ipcMain.handle('sync-overlay-window', (_event, payload = {}) => {
  const style = {};
  if ('opacity' in payload) {
    const opacity = Number(payload.opacity);
    if (Number.isFinite(opacity)) style.opacity = Math.max(0, Math.min(1, opacity));
  }
  if ('fontSize' in payload) {
    const fontSize = Number(payload.fontSize);
    if (Number.isFinite(fontSize)) style.fontSize = Math.max(10, Math.min(48, Math.round(fontSize)));
  }
  if ('fontColor' in payload && typeof payload.fontColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.fontColor)) {
    style.fontColor = payload.fontColor;
  }
  if ('showBg' in payload && typeof payload.showBg === 'boolean') {
    style.showBg = payload.showBg;
  }
  if ('mode' in payload && ['glass', 'prompt', 'focus'].includes(payload.mode)) {
    style.mode = payload.mode;
    style.showBg = payload.mode !== 'prompt';
  } else if ('showBg' in style && !('mode' in payload)) {
    style.mode = style.showBg ? 'glass' : 'prompt';
  }
  if ('focusWidthPct' in payload) {
    const focusWidthPct = Number(payload.focusWidthPct);
    if (Number.isFinite(focusWidthPct)) style.focusWidthPct = Math.max(50, Math.min(100, Math.round(focusWidthPct)));
  }
  if ('focusHeightPct' in payload) {
    const focusHeightPct = Number(payload.focusHeightPct);
    if (Number.isFinite(focusHeightPct)) style.focusHeightPct = Math.max(35, Math.min(100, Math.round(focusHeightPct)));
  }
  if ('promptMaxWidth' in payload) {
    const promptMaxWidth = Number(payload.promptMaxWidth);
    if (Number.isFinite(promptMaxWidth)) style.promptMaxWidth = Math.max(200, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Math.round(promptMaxWidth)));
  }
  if ('promptAutoFollow' in payload && typeof payload.promptAutoFollow === 'boolean') {
    style.promptAutoFollow = payload.promptAutoFollow;
  }
  if ('maxLines' in payload) {
    const maxLines = Number(payload.maxLines);
    if (Number.isFinite(maxLines)) style.maxLines = Math.max(0, Math.min(50, Math.round(maxLines)));
  }

  const nextEnabled = typeof payload.enabled === 'boolean' ? payload.enabled : Boolean(lastOverlayState.enabled);
  const nextVisible = typeof payload.visible === 'boolean' ? payload.visible : Boolean(lastOverlayState.visible);

  const state = { ...lastOverlayState, ...style, enabled: nextEnabled, visible: nextVisible };
  state.initialized = true;
  const visibleChanged = Boolean(lastOverlayState.visible) !== state.visible;

  lastOverlayState = state;
  sendOverlayState(state);
  syncFocusOverlayShortcuts();

  if (visibleChanged) {
    if (state.visible) {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow._hiddenByOverlay = true;
        mainWindow.hide();
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow._hiddenByOverlay) {
        mainWindow._hiddenByOverlay = false;
        mainWindow.show();
        mainWindow.focus();
      }
    }
  }

  if (!state.visible) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow._pendingShow = false;
      overlayWindow.hide();
    }
    return { ok: true, visible: false };
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }

  showOverlayWindow();
  return { ok: true, visible: true };
});
ipcMain.handle('get-overlay-state', () => lastOverlayState);
ipcMain.handle('resize-overlay-window', (_event, payload = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false };
  const mode = resolveOverlayMode();
  if (mode !== 'prompt') return { ok: true, skipped: true };

  const bounds = overlayWindow.getBounds();
  const center = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  const area = screen.getDisplayNearestPoint(center).workArea;
  const nextWidth = Number(payload.width);
  const nextHeight = Number(payload.height);
  const promptMaxWidth = Math.max(200, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Number(lastOverlayState?.promptMaxWidth) || PROMPT_OVERLAY_DEFAULT_WIDTH));
  const width = Number.isFinite(nextWidth)
    ? Math.max(PROMPT_OVERLAY_MIN_SIZE.width, Math.min(promptMaxWidth, area.width - 16, Math.round(nextWidth)))
    : bounds.width;
  const height = Number.isFinite(nextHeight)
    ? Math.max(PROMPT_OVERLAY_MIN_SIZE.height, Math.min(Math.round(area.height * PROMPT_OVERLAY_MAX_SIZE.heightRatio), Math.round(nextHeight)))
    : bounds.height;
  const x = Math.max(area.x + 8, Math.min(bounds.x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(bounds.y, area.y + area.height - height - 8));

  overlayAutoResizeUntil = Date.now() + 500;
  overlayWindow.setBounds({ x, y, width, height }, false);
  // 程序化设的尺寸是 prompt 自适应的权威值, 显式落盘 (绕过 fuse), 使重开时生效。
  schedulePersistOverlayPosition(true);
  return { ok: true, width, height };
});
// M3: 添加 destroyOverlay 接口，支持显式销毁悬浮窗
ipcMain.handle('destroy-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  return { ok: true };
});

function createAppMenu() {
  if (process.platform !== 'darwin') return;
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { label: '隐藏/显示窗口', click: () => toggleWindow() },
        { type: 'separator' },
        { role: 'hide', label: '隐藏应用' },
        { role: 'unhide', label: '显示应用' },
        { type: 'separator' },
        { label: '退出', accelerator: 'CommandOrControl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function requestAssistStop(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = http.request(`${SERVER_URL}/api/assist/stop`, {
      method: 'POST',
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', finish);
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      finish();
    });
    req.end();
  });
}

// 优雅停止后端：先主动请求 assist stop，让复盘归档和 SQLite 刷盘完成；
// 再发 SIGTERM，超时后兜底 SIGKILL。
let pythonStopPromise = null;
function gracefulStopPython(timeoutMs = 20000) {
  if (pythonStopPromise) return pythonStopPromise;
  const proc = pythonProcess;
  if (!proc) return Promise.resolve();
  pythonStopPromise = stopBackendProcess(proc, requestAssistStop, timeoutMs);
  return pythonStopPromise;
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!pythonProcess || pythonStopPromise) return;
  event.preventDefault();
  gracefulStopPython().then(() => {
    pythonProcess = null;
    app.quit();
  });
});

app.whenReady().then(async () => {
  try {
    app.setName(APP_DISPLAY_NAME);
  } catch {
    /* 个别平台/版本可能不支持 */
  }
  createAppMenu();
  console.log('Starting Python backend...');
  try {
    const picked = await pickBackendPort(PORT);
    PORT = picked.port;
    SERVER_URL = `http://127.0.0.1:${PORT}`;
    if (picked.fallback) {
      console.log(`[port] 首选端口被占用, 回退到空闲端口 ${PORT}`);
    }
  } catch (error) {
    console.warn('[port] 端口探测失败, 继续使用首选端口:', error?.message || error);
  }
  try {
    startPythonBackend();
  } catch (error) {
    dialog.showErrorBox('后端启动失败', error?.message || String(error));
    app.quit();
    return;
  }

  try {
    await waitForServer();
    console.log('Backend ready, creating window...');
  } catch (err) {
    console.error('Failed to start backend:', err.message);
    app.quit();
    return;
  }

  createWindow();
  createTray();
  registerShortcuts();
  registerUpdater(mainWindow);

  setImmediate(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) return;
    try {
      createOverlayWindow();
    } catch (error) {
      console.warn('overlay preheat failed:', error?.message || error);
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  mainWindow?.show();
  mainWindow?.focus();
  if (overlayWindow && !overlayWindow.isDestroyed() && lastOverlayState?.visible) {
    applyTopMost(overlayWindow);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (overlayPositionSaveTimer) {
    clearTimeout(overlayPositionSaveTimer);
    overlayPositionSaveTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  // 兜底:before-quit 通常已经 graceful 停过 pythonProcess,
  // 这里 fallback 防止异常路径泄漏子进程。
  if (pythonProcess) {
    try { pythonProcess.kill('SIGKILL'); } catch (_) { /* ignore */ }
    pythonProcess = null;
  }
});
