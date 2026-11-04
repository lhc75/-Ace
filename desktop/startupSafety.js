// Windows 启动安全级别（启动哨兵）。
//
// 现场问题：个别 Windows 机器上双击后托盘图标一闪就消失，主窗口从未出现，也没有
// 任何报错。这类现象是主进程在启动阶段被系统级原因直接干掉（显卡驱动 / GPU 服务
// / 安全软件），JS 层来不及弹窗。这里不猜测具体是哪一种，而是让应用自己记住
// "上次启动有没有走到窗口显示并稳定运行"，没走到就换一套更保守的图形栈再试：
//
//   L0（默认）：GPU 留在独立子进程 + 关闭 GPU 沙箱。现场 A/B 证明把 GPU 塞进
//        主进程（--in-process-gpu）会在部分多显卡/虚拟显示器驱动环境里让整个
//        主进程原生崩溃，所以默认不用它。
//   L1：再关掉 GPU 合成（软件合成，保留 GPU 进程）。
//   L2：纯软件渲染（--disable-gpu）。牺牲透明浮窗性能与部分隐身效果，但几乎
//        在任何显卡/虚拟机/远程桌面环境下都能启动。
//
// 稳定运行 STABLE_RUNS_BEFORE_RECOVERY 次后自动回升一级，避免一次偶发崩溃让用户
// 永远停留在降级模式。

const fs = require('fs');
const path = require('path');

const MAX_SAFETY_LEVEL = 2;
const STABLE_RUNS_BEFORE_RECOVERY = 10;
const STATE_FILE_NAME = 'startup-safety.json';

function clampLevel(level) {
  const value = Math.floor(Number(level));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_SAFETY_LEVEL, value);
}

function stateFilePath(dir) {
  return path.join(dir, STATE_FILE_NAME);
}

function readStartupState(dir) {
  try {
    const raw = fs.readFileSync(stateFilePath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        level: clampLevel(parsed.level),
        pendingAttempt: parsed.pendingAttempt === true,
        stableRuns: Number.isFinite(parsed.stableRuns) ? Math.max(0, Math.floor(parsed.stableRuns)) : 0,
        lastAttemptAt: Number.isFinite(parsed.lastAttemptAt) ? parsed.lastAttemptAt : 0,
        lastStableAt: Number.isFinite(parsed.lastStableAt) ? parsed.lastStableAt : 0,
      };
    }
  } catch {
    /* 首次启动或文件损坏：从默认值开始 */
  }
  return { level: 0, pendingAttempt: false, stableRuns: 0, lastAttemptAt: 0, lastStableAt: 0 };
}

function writeStartupState(dir, state) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFilePath(dir), JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 开始一次启动尝试，返回本次应使用的安全级别。
 * - 上次启动留下了未清除的 pendingAttempt（进程在窗口稳定前消失），级别 +1；
 * - 否则沿用已保存的级别。
 * 无论哪种情况都先写入 pendingAttempt=true，等窗口稳定后再清除。
 */
function beginStartupAttempt(dir, now = Date.now()) {
  const state = readStartupState(dir);
  const previousFailed = state.pendingAttempt === true;
  const level = clampLevel(previousFailed ? state.level + 1 : state.level);
  writeStartupState(dir, {
    ...state,
    level,
    pendingAttempt: true,
    lastAttemptAt: now,
  });
  return { level, previousFailed, escalated: previousFailed && level > state.level };
}

/** 窗口已显示并稳定运行：清除哨兵；降级模式下连续稳定若干次后回升一级 */
function markStartupStable(dir, now = Date.now()) {
  const state = readStartupState(dir);
  let level = clampLevel(state.level);
  let stableRuns = state.stableRuns + 1;
  if (level > 0 && stableRuns >= STABLE_RUNS_BEFORE_RECOVERY) {
    level -= 1;
    stableRuns = 0;
  }
  writeStartupState(dir, {
    ...state,
    level,
    stableRuns,
    pendingAttempt: false,
    lastStableAt: now,
  });
  return { level, stableRuns };
}

/** 主动退出（含启动失败后我们自己的退出）：不算启动崩溃，不升级级别 */
function markCleanExit(dir) {
  const state = readStartupState(dir);
  if (!state.pendingAttempt) return state;
  writeStartupState(dir, { ...state, pendingAttempt: false });
  return { ...state, pendingAttempt: false };
}

/** 运行中检测到图形子进程崩溃：立刻提升一级，供 relaunch 后使用 */
function escalateStartupLevel(dir) {
  const state = readStartupState(dir);
  const next = clampLevel(state.level + 1);
  writeStartupState(dir, { ...state, level: next, pendingAttempt: false });
  return { level: next, changed: next > state.level };
}

/** 强制安全模式（支持人员让用户用环境变量/命令行启动时使用） */
function resolveStartupSafetyLevel(dir, { env = {}, argv = [], now = Date.now() } = {}) {
  if (env.IA_SAFE_MODE === '1' || argv.includes('--safe-mode')) {
    writeStartupState(dir, {
      ...readStartupState(dir),
      level: MAX_SAFETY_LEVEL,
      pendingAttempt: false,
      lastAttemptAt: now,
    });
    return { level: MAX_SAFETY_LEVEL, previousFailed: false, escalated: false, forced: true };
  }
  return { ...beginStartupAttempt(dir, now), forced: false };
}

/** 该级别是否需要 app.disableHardwareAcceleration()（必须在 ready 之前调用） */
function shouldDisableHardwareAcceleration(level, env = {}) {
  if (env.ELECTRON_DISABLE_HW_ACCEL === '1') return true;
  return clampLevel(level) >= 2;
}

module.exports = {
  MAX_SAFETY_LEVEL,
  STABLE_RUNS_BEFORE_RECOVERY,
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
};
