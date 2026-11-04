// 桌面端文件日志。
//
// 打包后的 Windows 应用没有控制台：主进程一旦在启动阶段被系统/驱动/安全软件杀掉，
// 用户看不到任何信息，我们也无从定位。这里把主进程日志、启动上下文和崩溃事件
// 同步写入 <userData>/logs/desktop.log（同步写入保证进程被杀前内容已经落盘），
// 出问题时让用户把这一个文件发回来即可。
//
// 只依赖 node 内置模块，便于单元测试。

const fs = require('fs');
const path = require('path');

const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'desktop.log';
const BACKUP_FILE_NAME = 'desktop.log.1';
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function toText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLine(now, level, parts) {
  return `${now.toISOString()} [${level}] ${parts.map(toText).join(' ')}\n`;
}

/** 日志超过上限时滚动成 desktop.log.1（只保留一份备份，总占用有界） */
function rotateIfNeeded(filePath, maxBytes = MAX_LOG_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return false;
    const backup = path.join(path.dirname(filePath), BACKUP_FILE_NAME);
    try {
      fs.rmSync(backup, { force: true });
    } catch {
      /* 备份删不掉也继续：覆盖写入即可 */
    }
    fs.renameSync(filePath, backup);
    return true;
  } catch {
    return false;
  }
}

/**
 * 初始化文件日志，并把 console.log/warn/error 同时写到文件。
 * 返回 { logPath, log, warn, error, logStartupContext }。
 * 任何文件系统异常都静默降级为“只输出控制台”，不影响应用启动。
 */
function initFileLogger({ dir, maxBytes = MAX_LOG_BYTES } = {}) {
  const logDir = path.join(dir || '.', LOG_DIR_NAME);
  const logPath = path.join(logDir, LOG_FILE_NAME);
  let enabled = true;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    rotateIfNeeded(logPath, maxBytes);
  } catch {
    enabled = false;
  }

  const append = (level, parts) => {
    if (!enabled) return;
    try {
      fs.appendFileSync(logPath, formatLine(new Date(), level, parts), 'utf8');
    } catch {
      enabled = false; // 写不进去就别每次都重试，保持应用可运行
    }
  };

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  console.log = (...parts) => { append('INFO', parts); originalConsole.log(...parts); };
  console.info = (...parts) => { append('INFO', parts); originalConsole.info(...parts); };
  console.warn = (...parts) => { append('WARN', parts); originalConsole.warn(...parts); };
  console.error = (...parts) => { append('ERROR', parts); originalConsole.error(...parts); };

  const logger = {
    logPath,
    log: (...parts) => console.log(...parts),
    warn: (...parts) => console.warn(...parts),
    error: (...parts) => console.error(...parts),
    raw: (level, ...parts) => append(level, parts),
    // 仅用于测试：恢复 console 原方法
    restore: () => {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    },
  };

  logger.logStartupContext = (context = {}) => {
    logger.raw('INFO', '===== app start =====');
    for (const [key, value] of Object.entries(context)) {
      logger.raw('INFO', `  ${key}: ${toText(value)}`);
    }
  };

  return logger;
}

module.exports = {
  BACKUP_FILE_NAME,
  LOG_DIR_NAME,
  LOG_FILE_NAME,
  MAX_LOG_BYTES,
  formatLine,
  initFileLogger,
  rotateIfNeeded,
  toText,
};
