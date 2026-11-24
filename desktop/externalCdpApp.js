const path = require('path');
const { spawn, execFile } = require('child_process');

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error('CDP 端口必须是 1-65535 之间的整数');
  }
  return value;
}

function appNameFromPath(appPath, platform = process.platform) {
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const base = pathImpl.basename(String(appPath || '').trim());
  return base.toLowerCase().endsWith('.app')
    ? base.slice(0, -4)
    : pathImpl.basename(base, pathImpl.extname(base));
}

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function executablePathForMacApp(appPath) {
  const name = appNameFromPath(appPath);
  return path.join(appPath, 'Contents', 'MacOS', name);
}

function buildRestartPlan({ appPath, port, platform = process.platform } = {}) {
  const normalizedPath = String(appPath || '').trim();
  if (!normalizedPath) throw new Error('请先选择目标应用');
  const normalizedPort = normalizePort(port);
  const debugArg = `--remote-debugging-port=${normalizedPort}`;
  const macScreenCaptureArgs = platform === 'darwin'
    ? [
        '--enable-features=ScreenCaptureKitMac',
        '--disable-features=DesktopCaptureMacV2,IOSurfaceCapturer',
      ]
    : [];
  const launchArgs = [debugArg, ...macScreenCaptureArgs];
  const name = appNameFromPath(normalizedPath, platform);
  const isMacAppBundle = platform === 'darwin' && normalizedPath.toLowerCase().endsWith('.app');

  if (platform === 'darwin') {
    const quitCommands = [];
    if (isMacAppBundle) {
      quitCommands.push({
        cmd: 'osascript',
        args: ['-e', `tell application "${escapeAppleScriptString(name)}" to quit`],
      });
      quitCommands.push({
        cmd: 'pkill',
        args: ['-TERM', '-f', executablePathForMacApp(normalizedPath)],
      });
    } else {
      quitCommands.push({ cmd: 'pkill', args: ['-TERM', '-f', normalizedPath] });
    }
    return {
      platform,
      appName: name,
      quitCommands,
      launch: isMacAppBundle
        ? { cmd: 'open', args: ['-na', normalizedPath, '--args', ...launchArgs] }
        : { cmd: normalizedPath, args: launchArgs },
      quitWaitMs: 2000,
    };
  }

  if (platform === 'win32') {
    const exeName = path.win32.basename(normalizedPath);
    return {
      platform,
      appName: name,
      quitCommands: [{ cmd: 'taskkill', args: ['/IM', exeName, '/T', '/F'] }],
      launch: { cmd: normalizedPath, args: launchArgs },
      quitWaitMs: 1200,
    };
  }

  return {
    platform,
    appName: name,
    quitCommands: [{ cmd: 'pkill', args: ['-TERM', '-f', normalizedPath] }],
    launch: { cmd: normalizedPath, args: launchArgs },
    quitWaitMs: 1200,
  };
}

function runIgnoringErrors(execFileImpl, cmd, args) {
  return new Promise((resolve) => {
    try {
      execFileImpl(cmd, args, { timeout: 5000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function restartExternalCdpApp({
  appPath,
  port,
  platform = process.platform,
  execFileImpl = execFile,
  spawnImpl = spawn,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const plan = buildRestartPlan({ appPath, port, platform });
  for (const quit of plan.quitCommands) {
    await runIgnoringErrors(execFileImpl, quit.cmd, quit.args);
  }
  await sleep(plan.quitWaitMs);
  const child = spawnImpl(plan.launch.cmd, plan.launch.args, {
    detached: true,
    stdio: 'ignore',
  });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    ok: true,
    appName: plan.appName,
    launchCommand: plan.launch.cmd,
    args: plan.launch.args,
  };
}

module.exports = {
  appNameFromPath,
  buildRestartPlan,
  restartExternalCdpApp,
};
