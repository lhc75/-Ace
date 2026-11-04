const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BACKUP_FILE_NAME,
  formatLine,
  initFileLogger,
  rotateIfNeeded,
  toText,
} = require('./appLogger');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ia-log-'));
}

test('日志行带时间、级别和完整错误堆栈', () => {
  const line = formatLine(new Date('2026-11-04T00:00:00.000Z'), 'ERROR', [
    'boom',
    Object.assign(new Error('accident'), { stack: 'Error: accident\n  at x' }),
  ]);
  assert.match(line, /^2026-11-04T00:00:00\.000Z \[ERROR\] boom Error: accident\n {2}at x\n$/);
});

test('toText 兼容字符串、错误与普通对象', () => {
  assert.equal(toText('hi'), 'hi');
  assert.match(toText(new Error('x')), /^Error: x/);
  assert.equal(toText({ a: 1 }), '{"a":1}');
  const circular = {};
  circular.self = circular;
  assert.equal(typeof toText(circular), 'string');
});

test('初始化后日志同步写盘，可被崩溃后的取证读取', () => {
  const dir = tempDir();
  const logger = initFileLogger({ dir });
  try {
    logger.log('hello', 42);
    logger.raw('INFO', 'raw line');
    const content = fs.readFileSync(logger.logPath, 'utf8');
    assert.match(content, /\[INFO\] hello 42/);
    assert.match(content, /\[INFO\] raw line/);
  } finally {
    logger.restore();
  }
});

test('日志超过上限时滚动为 desktop.log.1', () => {
  const dir = tempDir();
  const file = path.join(dir, 'desktop.log');
  fs.writeFileSync(file, 'x'.repeat(2048), 'utf8');
  assert.equal(rotateIfNeeded(file, 1024), true);
  assert.ok(fs.existsSync(path.join(dir, BACKUP_FILE_NAME)));
  assert.equal(fs.statSync(file, { throwIfNoEntry: false }), undefined);
});

test('未超上限不滚动', () => {
  const dir = tempDir();
  const file = path.join(dir, 'desktop.log');
  fs.writeFileSync(file, 'x'.repeat(100), 'utf8');
  assert.equal(rotateIfNeeded(file, 1024), false);
  assert.ok(fs.existsSync(file));
});
