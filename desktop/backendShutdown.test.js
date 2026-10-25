const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const { stopBackendProcess } = require('./backendShutdown');

const quietLogger = { warn() {} };

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.signals = [];
  proc.kill = (signal) => {
    proc.signals.push(signal);
    proc.killed = true;
    proc.signalCode = signal;
    proc.emit('exit', null, signal);
    return true;
  };
  return proc;
}

test('does not signal a process that already exited', async () => {
  const proc = fakeProcess();
  proc.exitCode = 0;
  await stopBackendProcess(proc, () => assert.fail('stop request should not run'));
  assert.deepEqual(proc.signals, []);
});

test('does not signal a backend that exits while its stop request is pending', async () => {
  const proc = fakeProcess();
  await stopBackendProcess(proc, () => proc.emit('exit', 0, null), 20000, quietLogger);
  assert.deepEqual(proc.signals, []);
  assert.equal(proc.listenerCount('exit'), 0);
});

test('still terminates the backend after a failed stop request', async () => {
  const proc = fakeProcess();
  await stopBackendProcess(proc, () => Promise.reject(new Error('offline')), 20000, quietLogger);
  assert.deepEqual(proc.signals, ['SIGTERM']);
  assert.equal(proc.listenerCount('exit'), 0);
});

test('escalates to SIGKILL when a real backend ignores SIGTERM', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (t) => {
  const proc = spawn(process.execPath, ['-e', [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('ready\\n');",
    'setInterval(() => {}, 100);',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  await once(proc.stdout, 'data');
  const exit = once(proc, 'exit');
  await stopBackendProcess(proc, () => Promise.resolve(), 1000, quietLogger);
  const [code, signal] = await exit;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
});
