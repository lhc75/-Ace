const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_SAFETY_LEVEL,
  STATE_FILE_NAME,
  beginStartupAttempt,
  clampLevel,
  escalateStartupLevel,
  markCleanExit,
  markStartupStable,
  readStartupState,
  resolveStartupSafetyLevel,
  shouldDisableHardwareAcceleration,
  stateFilePath,
  writeStartupState,
} = require('./startupSafety');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ia-startup-'));
}

test('首次启动从 L0 开始并留下未完成的哨兵', () => {
  const dir = tempDir();
  const attempt = beginStartupAttempt(dir, 1000);
  assert.equal(attempt.level, 0);
  assert.equal(attempt.previousFailed, false);
  assert.equal(readStartupState(dir).pendingAttempt, true);
});

test('上次启动没走到窗口稳定：下次自动降一级图形栈', () => {
  const dir = tempDir();
  beginStartupAttempt(dir, 1000); // 进程随后被杀死，没 markStartupStable
  const second = beginStartupAttempt(dir, 2000);
  assert.equal(second.level, 1);
  assert.equal(second.previousFailed, true);
  assert.equal(second.escalated, true);

  const third = beginStartupAttempt(dir, 3000);
  assert.equal(third.level, 2);

  const fourth = beginStartupAttempt(dir, 4000);
  assert.equal(fourth.level, MAX_SAFETY_LEVEL, '到顶后不再升级');
  assert.equal(fourth.escalated, false);
});

test('窗口稳定后清除哨兵，下次启动不再升级', () => {
  const dir = tempDir();
  beginStartupAttempt(dir, 1000);
  markStartupStable(dir, 2000);
  const next = beginStartupAttempt(dir, 3000);
  assert.equal(next.level, 0);
  assert.equal(next.previousFailed, false);
});

test('降级模式下连续稳定若干次后回升一级', () => {
  const dir = tempDir();
  writeStartupState(dir, { level: 2, pendingAttempt: true, stableRuns: 0, lastAttemptAt: 0, lastStableAt: 0 });
  beginStartupAttempt(dir, 1000); // 升到 2（已是上限）
  let level = 2;
  for (let i = 0; i < 10; i += 1) {
    level = markStartupStable(dir, 2000 + i).level;
  }
  assert.equal(level, 1, '稳定 10 次后回到 L1');
  for (let i = 0; i < 10; i += 1) {
    level = markStartupStable(dir, 3000 + i).level;
  }
  assert.equal(level, 0, '再稳定 10 次后回到 L0');
});

test('主动退出清除哨兵但不改变级别', () => {
  const dir = tempDir();
  writeStartupState(dir, { level: 1, pendingAttempt: true, stableRuns: 3, lastAttemptAt: 0, lastStableAt: 0 });
  markCleanExit(dir);
  const state = readStartupState(dir);
  assert.equal(state.pendingAttempt, false);
  assert.equal(state.level, 1);
  const next = beginStartupAttempt(dir, 5000);
  assert.equal(next.level, 1, '主动退出不应触发升级');
});

test('运行中 GPU 崩溃立即提升一级供重启使用', () => {
  const dir = tempDir();
  const first = escalateStartupLevel(dir);
  assert.deepEqual(first, { level: 1, changed: true });
  const second = escalateStartupLevel(dir);
  assert.deepEqual(second, { level: 2, changed: true });
  const third = escalateStartupLevel(dir);
  assert.deepEqual(third, { level: 2, changed: false });
  assert.equal(readStartupState(dir).pendingAttempt, false);
});

test('安全模式可由环境变量或命令行强制打开', () => {
  const dir = tempDir();
  const byEnv = resolveStartupSafetyLevel(dir, { env: { IA_SAFE_MODE: '1' }, argv: [] });
  assert.equal(byEnv.level, MAX_SAFETY_LEVEL);
  assert.equal(byEnv.forced, true);

  const dir2 = tempDir();
  const byArgv = resolveStartupSafetyLevel(dir2, { env: {}, argv: ['electron', '.', '--safe-mode'] });
  assert.equal(byArgv.level, MAX_SAFETY_LEVEL);
  assert.equal(byArgv.forced, true);
});

test('状态文件损坏时回退到 L0', () => {
  const dir = tempDir();
  fs.writeFileSync(stateFilePath(dir), '{ not json', 'utf8');
  assert.deepEqual(
    { level: readStartupState(dir).level, pending: readStartupState(dir).pendingAttempt },
    { level: 0, pending: false },
  );
  assert.equal(beginStartupAttempt(dir).level, 0);
  assert.ok(fs.existsSync(path.join(dir, STATE_FILE_NAME)));
});

test('clampLevel 处理越界与非法值', () => {
  assert.equal(clampLevel(-3), 0);
  assert.equal(clampLevel(99), MAX_SAFETY_LEVEL);
  assert.equal(clampLevel('1'), 1);
  assert.equal(clampLevel('abc'), 0);
});

test('只有 L2（或显式环境变量）关闭硬件加速', () => {
  assert.equal(shouldDisableHardwareAcceleration(0, {}), false);
  assert.equal(shouldDisableHardwareAcceleration(1, {}), false);
  assert.equal(shouldDisableHardwareAcceleration(2, {}), true);
  assert.equal(shouldDisableHardwareAcceleration(0, { ELECTRON_DISABLE_HW_ACCEL: '1' }), true);
});
