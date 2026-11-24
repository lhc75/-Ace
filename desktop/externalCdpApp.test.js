const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appNameFromPath,
  buildRestartPlan,
  restartExternalCdpApp,
} = require('./externalCdpApp');

test('derives app names from macOS and Windows paths', () => {
  assert.equal(appNameFromPath('/Applications/国考云.app'), '国考云');
  assert.equal(appNameFromPath('C:\\Apps\\国考云.exe', 'win32'), '国考云');
});

test('builds a macOS app restart plan with debug port', () => {
  const plan = buildRestartPlan({
    appPath: '/Applications/国考云.app',
    port: 9222,
    platform: 'darwin',
  });
  assert.equal(plan.quitCommands[0].cmd, 'osascript');
  assert.match(plan.quitCommands[0].args[1], /国考云/);
  assert.deepEqual(plan.launch, {
    cmd: 'open',
    args: ['-na', '/Applications/国考云.app', '--args', '--remote-debugging-port=9222'],
  });
});

test('builds a Windows restart plan', () => {
  const plan = buildRestartPlan({
    appPath: 'C:\\Apps\\国考云.exe',
    port: 9333,
    platform: 'win32',
  });
  assert.deepEqual(plan.quitCommands, [
    { cmd: 'taskkill', args: ['/IM', '国考云.exe', '/T', '/F'] },
  ]);
  assert.deepEqual(plan.launch, {
    cmd: 'C:\\Apps\\国考云.exe',
    args: ['--remote-debugging-port=9333'],
  });
});

test('restarts the target with injected process helpers', async () => {
  const execCalls = [];
  const spawnCalls = [];
  const sleeps = [];
  let unrefCalled = false;
  const result = await restartExternalCdpApp({
    appPath: '/Applications/国考云.app',
    port: 9222,
    platform: 'darwin',
    execFileImpl: (cmd, args, options, callback) => {
      execCalls.push([cmd, args, options]);
      callback(null, '', '');
    },
    spawnImpl: (cmd, args, options) => {
      spawnCalls.push([cmd, args, options]);
      return { unref() { unrefCalled = true; } };
    },
    sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal(result.ok, true);
  assert.equal(result.appName, '国考云');
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0][0], 'osascript');
  assert.deepEqual(spawnCalls[0][0], 'open');
  assert.deepEqual(spawnCalls[0][1], [
    '-na',
    '/Applications/国考云.app',
    '--args',
    '--remote-debugging-port=9222',
  ]);
  assert.equal(sleeps[0], 2000);
  assert.equal(unrefCalled, true);
});
