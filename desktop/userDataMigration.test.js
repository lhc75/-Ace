const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  USER_DATA_DIR_NAME,
  isExampleConfig,
  migrateLegacyUserData,
  resolveUserDataDir,
  shouldMigrate,
} = require('./userDataMigration');

function mkAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ia-userdata-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const EXAMPLE = JSON.stringify({ models: [{ name: 'Example-Model', api_key: 'YOUR_API_KEY_HERE' }] });
const REAL = JSON.stringify({ models: [{ name: 'Qwen', api_key: 'sk-real', api_base_url: 'http://x' }] });

function setup() {
  const appData = mkAppData();
  const legacy = path.join(appData, 'interview-assistant-desktop');
  const current = path.join(appData, '面试Ace');
  const example = path.join(appData, 'config.example.json');
  fs.writeFileSync(example, EXAMPLE);
  write(path.join(legacy, 'config.json'), REAL);
  write(path.join(legacy, 'data', 'knowledge.db'), 'old-db');
  write(path.join(legacy, 'shortcuts.json'), '{"k":"v"}');
  write(path.join(legacy, 'logs', 'desktop.log'), 'noise');
  write(path.join(legacy, 'Cache', 'cache.bin'), 'cache');
  write(path.join(legacy, 'Local Storage', 'leveldb', '000001.log'), 'ui-state');
  write(path.join(current, 'config.json'), EXAMPLE); // 首次启动拷贝的示例配置
  write(path.join(current, 'data', 'knowledge.db'), 'fresh-db');
  return { appData, legacy, current, example };
}

test('新目录只有示例配置时，把旧目录的配置与数据迁移过来', () => {
  const { appData, legacy, current, example } = setup();

  const result = migrateLegacyUserData({
    appDataDir: appData,
    newUserDataDir: current,
    exampleConfigPath: example,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.from, legacy);
  assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'), REAL);
  assert.equal(fs.readFileSync(path.join(current, 'data', 'knowledge.db'), 'utf8'), 'old-db');
  assert.equal(fs.readFileSync(path.join(current, 'shortcuts.json'), 'utf8'), '{"k":"v"}');
  // UI 的 localStorage 也要保住
  assert.equal(fs.readFileSync(path.join(current, 'Local Storage', 'leveldb', '000001.log'), 'utf8'), 'ui-state');
  // 日志与缓存不搬
  assert.equal(fs.existsSync(path.join(current, 'logs')), false);
  assert.equal(fs.existsSync(path.join(current, 'Cache')), false);
});

test('迁移前会备份新目录里原有的状态文件', () => {
  const { appData, current, example } = setup();

  const result = migrateLegacyUserData({
    appDataDir: appData,
    newUserDataDir: current,
    exampleConfigPath: example,
  });

  assert.ok(result.backupDir);
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'config.json'), 'utf8'), EXAMPLE);
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'data', 'knowledge.db'), 'utf8'), 'fresh-db');
});

test('新目录已有真实配置时不迁移，避免覆盖用户最新设置', () => {
  const { appData, current, example } = setup();
  write(path.join(current, 'config.json'), REAL);

  assert.equal(shouldMigrate({
    legacyDir: path.join(appData, 'interview-assistant-desktop'),
    newUserDataDir: current,
    exampleConfigPath: example,
  }), false);

  const result = migrateLegacyUserData({ appDataDir: appData, newUserDataDir: current, exampleConfigPath: example });
  assert.equal(result.migrated, false);
  assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'), REAL);
});

test('旧目录没有 config.json 时不迁移', () => {
  const { appData, legacy, current, example } = setup();
  fs.rmSync(path.join(legacy, 'config.json'));

  const result = migrateLegacyUserData({ appDataDir: appData, newUserDataDir: current, exampleConfigPath: example });
  assert.equal(result.migrated, false);
});

test('新目录还没有 config.json 时也迁移', () => {
  const { appData, current, example } = setup();
  fs.rmSync(path.join(current, 'config.json'));

  const result = migrateLegacyUserData({ appDataDir: appData, newUserDataDir: current, exampleConfigPath: example });
  assert.equal(result.migrated, true);
  assert.equal(fs.readFileSync(path.join(current, 'config.json'), 'utf8'), REAL);
});

test('isExampleConfig 按字节比较 example，退化为占位符判断', () => {
  const dir = mkAppData();
  const example = path.join(dir, 'example.json');
  fs.writeFileSync(example, EXAMPLE);
  const same = path.join(dir, 'same.json');
  fs.writeFileSync(same, EXAMPLE);
  const real = path.join(dir, 'real.json');
  fs.writeFileSync(real, REAL);
  const missing = path.join(dir, 'missing.json');

  assert.equal(isExampleConfig(same, example), true);
  assert.equal(isExampleConfig(real, example), false);
  assert.equal(isExampleConfig(missing, example), true);
  assert.equal(isExampleConfig(real, null), false);
  fs.writeFileSync(real, JSON.stringify({ models: [{ name: 'Example-Model', api_key: 'YOUR_API_KEY_HERE' }] }));
  assert.equal(isExampleConfig(real, null), true);
});

test('旧目录保持原样，不做删除', () => {
  const { appData, legacy, current, example } = setup();
  migrateLegacyUserData({ appDataDir: appData, newUserDataDir: current, exampleConfigPath: example });
  assert.equal(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8'), REAL);
});

test('用户数据目录固定与展示名解耦，且常量不可随意更改', () => {
  // 这个断言是防呆：改目录名等于所有老用户配置丢失，必须同时补迁移逻辑。
  assert.equal(USER_DATA_DIR_NAME, '面试Ace');
  assert.equal(resolveUserDataDir({ appDataDir: '/appdata' }), path.join('/appdata', '面试Ace'));
  assert.equal(
    resolveUserDataDir({ appDataDir: '/appdata', override: '/tmp/test-profile' }),
    path.resolve('/tmp/test-profile'),
  );
  assert.equal(
    resolveUserDataDir({ appDataDir: '/appdata', override: 'relative-dir' }),
    path.resolve('relative-dir'),
  );
  assert.throws(() => resolveUserDataDir({}), /appDataDir/);
});
