// Windows 自动安装：下载好的 NSIS 安装包在应用退出后静默执行，再重新拉起应用。
//
// NSIS（electron-builder 的 assisted installer）支持 /S 静默安装，并且会从注册表
// 读取上一次的 InstallLocation，因此不需要用 /D 指定目录，能原地升级。
// 应用本身必须先退出，否则安装包无法替换被锁定的文件，所以由一个 detached 的
// PowerShell 助手等待当前进程结束后再操作。
//
// 这里只放纯函数，便于 node --test；spawn 在 updater.js。

const path = require('path');

/** 便携版（electron-builder portable target）运行在临时解包目录，不能原地覆盖安装 */
function isPortableInstall(env = {}) {
  return Boolean(env.PORTABLE_EXECUTABLE_DIR);
}

/** PowerShell 单引号字符串转义：内部单引号写两遍 */
function quotePowerShell(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/**
 * 生成静默安装助手脚本：
 * 1. 等待当前应用进程退出；
 * 2. 运行安装包 /S（静默、原地升级，无需 /D）；
 * 3. 无论安装成功与否都重新拉起应用（失败时至少能把旧版本打开）。
 * 全过程写 <userData>/update-install.log，便于现场排查。
 */
function buildInstallHelperScript({ pid, installerPath, appExePath, logPath }) {
  const q = quotePowerShell;
  const safePid = Number.isFinite(Number(pid)) && Number(pid) > 0 ? Math.floor(Number(pid)) : 0;
  return [
    '$ErrorActionPreference = "Stop"',
    `$log = ${q(logPath)}`,
    'function Write-Log($m) { try { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) } catch {} }',
    'try {',
    safePid > 0
      ? `  Wait-Process -Id ${safePid} -ErrorAction SilentlyContinue`
      : '  Start-Sleep -Milliseconds 300',
    '  Start-Sleep -Milliseconds 1500',
    `  Write-Log ("app exited, running installer: " + ${q(installerPath)})`,
    `  $p = Start-Process -FilePath ${q(installerPath)} -ArgumentList '/S' -PassThru -Wait`,
    '  Write-Log ("installer exit code " + $p.ExitCode)',
    '} catch {',
    '  Write-Log ("install failed: " + $_.Exception.Message)',
    '}',
    'Start-Sleep -Milliseconds 500',
    'try {',
    `  Start-Process -FilePath ${q(appExePath)}`,
    '  Write-Log "relaunched app"',
    '} catch {',
    '  Write-Log ("relaunch failed: " + $_.Exception.Message)',
    '}',
  ].join('\r\n');
}

/** 静默安装助手脚本的落盘位置（放在 userData 下，安装/卸载不会清掉） */
function helperScriptPath(userDataDir) {
  return path.join(userDataDir, 'update-install.ps1');
}

function helperLogPath(userDataDir) {
  return path.join(userDataDir, 'update-install.log');
}

module.exports = {
  buildInstallHelperScript,
  helperLogPath,
  helperScriptPath,
  isPortableInstall,
  quotePowerShell,
};
