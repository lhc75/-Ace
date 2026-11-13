const { app, BrowserWindow } = require('electron');
const { loadNativeGuard } = require('../captureProtection');

if (process.platform !== 'win32') {
  console.log('Windows capture check skipped on', process.platform);
  process.exit(0);
}

app.whenReady().then(() => {
  const guard = loadNativeGuard();
  if (!guard?.setClickThrough || !guard?.getCaptureState) {
    console.error('native capture guard unavailable');
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({
    width: 240,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
  });

  win.webContents.once('did-finish-load', () => {
    win.setContentProtection(true);
    win.showInactive();

    setTimeout(() => {
      try {
        const handle = win.getNativeWindowHandle();
        const clickThroughResult = guard.setClickThrough(handle, true);
        const passingState = guard.getCaptureState(handle);
        const interactiveResult = guard.setClickThrough(handle, false);
        const interactiveState = guard.getCaptureState(handle);

        console.log('WINDOWS_CAPTURE_CHECK', JSON.stringify({
          clickThroughResult,
          passingState,
          interactiveResult,
          interactiveState,
        }));

        const ok = clickThroughResult?.ok
          && interactiveResult?.ok
          && passingState?.captureExcluded
          && passingState?.clickThrough
          && interactiveState?.captureExcluded
          && !interactiveState?.clickThrough;
        win.destroy();
        app.exit(ok ? 0 : 1);
      } catch (error) {
        console.error('Windows capture check failed:', error);
        win.destroy();
        app.exit(1);
      }
    }, 500);
  });

  win.loadURL('data:text/html,<body style="background:transparent"></body>').catch((error) => {
    console.error('Windows capture check load failed:', error);
    app.exit(1);
  });
});
