const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInstallHelperScript,
  helperLogPath,
  helperScriptPath,
  isPortableInstall,
  quotePowerShell,
} = require('./windowsInstaller');

test('便携版通过 PORTABLE_EXECUTABLE_DIR 识别，不能原地覆盖安装', () => {
  assert.equal(isPortableInstall({}), false);
  assert.equal(isPortableInstall({ PORTABLE_EXECUTABLE_DIR: 'D:\\tools' }), true);
});

test('PowerShell 单引号字符串会转义内部单引号', () => {
  assert.equal(quotePowerShell("C:\\a'b\\x.exe"), "'C:\\a''b\\x.exe'");
  assert.equal(quotePowerShell(undefined), "''");
});

test('静默安装助手先等待进程退出，再 /S 安装并重新拉起应用', () => {
  const script = buildInstallHelperScript({
    pid: 4321,
    installerPath: 'C:\\Users\\me\\Downloads\\InterviewAce-Setup-1.5.0.exe',
    appExePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\面试Ace\\面试Ace.exe',
    logPath: 'C:\\Users\\me\\AppData\\Roaming\\面试Ace\\update-install.log',
  });

  assert.match(script, /Wait-Process -Id 4321/);
  assert.match(script, /Start-Process -FilePath 'C:\\Users\\me\\Downloads\\InterviewAce-Setup-1\.5\.0\.exe' -ArgumentList '\/S' -PassThru -Wait/);
  assert.match(script, /Start-Process -FilePath 'C:\\Users\\me\\AppData\\Local\\Programs\\面试Ace\\面试Ace\.exe'/);
  // 安装前必须给旧进程退出/文件解锁留时间
  assert.match(script, /Start-Sleep -Milliseconds 1500/);
  assert.ok(
    script.indexOf('Wait-Process') < script.indexOf("-ArgumentList '/S'"),
    '必须先等应用退出再安装',
  );
  assert.ok(
    script.indexOf("-ArgumentList '/S'") < script.lastIndexOf('Start-Process -FilePath'),
    '安装完成后才重新拉起应用',
  );
});

test('非法 pid 时退化为短暂等待，不会卡住安装', () => {
  const script = buildInstallHelperScript({
    pid: 'abc',
    installerPath: 'C:\\setup.exe',
    appExePath: 'C:\\app\\app.exe',
    logPath: 'C:\\log.txt',
  });
  assert.doesNotMatch(script, /Wait-Process/);
  assert.match(script, /Start-Sleep -Milliseconds 300/);
});

test('助手脚本与日志路径落在 userData 目录', () => {
  assert.equal(helperScriptPath('/data'), '/data/update-install.ps1');
  assert.equal(helperLogPath('/data'), '/data/update-install.log');
});
