// userData 目录迁移。
//
// 背景：1.4.3 及更早版本的 Electron userData 目录取自 package.json 的 name
// （interview-assistant-desktop），因为 app.setName() 直到 ready 之后才调用，
// 此时 userData 路径已经固定。1.4.4 把 setName 提前到 ready 之前，目录变成
// 展示名（面试Ace），老配置就“消失”了。
//
// 这里在新目录还没有真实配置（不存在 config.json，或它仍是 config.example.json
// 的原样拷贝）时，把旧目录的数据一次性搬过来；已有真实配置则完全不动。
// 旧目录保留不删，出问题还能手工找回。
//
// 纯 node 模块，便于单元测试。

const fs = require('fs');
const path = require('path');

/**
 * 用户数据目录名：**永远不要再改**。
 * 改这个名字 = 所有用户升级后配置“消失”（1.4.4 的事故就是这么来的）。
 * 展示名（窗口标题/托盘）可以改，数据目录必须保持不变；main.js 会显式
 * app.setPath('userData', ...) 固定它，不再依赖 app.getName()。
 */
const USER_DATA_DIR_NAME = '面试Ace';

/** 1.4.3 及更早版本实际使用的 userData 目录名（package.json name） */
const LEGACY_DIR_NAMES = ['interview-assistant-desktop'];

// 重新生成即可的大缓存/日志，不迁移；Chromium 自身的 profile 内部状态也不搬
// （旧版可能用的 Electron 版本不同，搬过去没有好处）。真正属于用户的数据——配置、
// 数据库、Local Storage 里的界面偏好——都会保留。
const SKIP_ENTRIES = new Set([
  'logs',
  'log',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DawnWebGPUInfoCache',
  'ShaderCache',
  'GrShaderCache',
  'Crashpad',
  'blob_storage',
  'Service Worker',
  'Local State',
  'Preferences',
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
  'TransportSecurity',
  'DIPS',
  'Trust Tokens',
  'Trust Tokens-journal',
  'SharedStorage',
  'Session Storage',
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
]);

function safeRead(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/** 新目录里的 config.json 是否只是首次启动时从 config.example.json 拷贝的模板 */
function isExampleConfig(configPath, exampleConfigPath) {
  const current = safeRead(configPath);
  if (current === null) return true; // 没有配置：视作可迁移
  const example = exampleConfigPath ? safeRead(exampleConfigPath) : null;
  if (example) return current.equals(example);
  // 没有 example 文件时退化为占位符判断
  try {
    const parsed = JSON.parse(current.toString('utf8'));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    if (models.length === 0) return true;
    return models.every((m) => (
      m && (m.name === 'Example-Model' || m.api_key === 'YOUR_API_KEY_HERE')
    ));
  } catch {
    return false; // 解析不了就当作用户数据，别覆盖
  }
}

/** 是否需要迁移：旧目录有真实配置，且新目录还没有真实配置 */
function shouldMigrate({ legacyDir, newUserDataDir, exampleConfigPath }) {
  const legacyConfig = path.join(legacyDir, 'config.json');
  if (!fs.existsSync(legacyConfig)) return false;

  const newConfig = path.join(newUserDataDir, 'config.json');
  const newDataDir = path.join(newUserDataDir, 'data');

  // 如果新目录已经有数据文件夹，说明是已有安装，不应该迁移
  if (fs.existsSync(newDataDir)) {
    try {
      const dataEntries = fs.readdirSync(newDataDir);
      // 如果data目录有任何.db文件，说明是真实数据，不迁移
      if (dataEntries.some(name => name.endsWith('.db') || name.endsWith('.sqlite'))) {
        return false;
      }
    } catch {
      // 读取失败时保守处理：不迁移
      return false;
    }
  }

  return isExampleConfig(newConfig, exampleConfigPath);
}

/** 迁移前把新目录里可能存在的少量状态文件备份到 appData/<name>.pre-migration-<时间> */
function backupCurrentState(newUserDataDir, backupDir) {
  const entries = ['config.json', 'shortcuts.json', 'overlay-window.json', 'update-state.json', 'data', 'Local Storage'];
  let copied = 0;
  for (const name of entries) {
    const src = path.join(newUserDataDir, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.cpSync(src, path.join(backupDir, name), { recursive: true, force: true });
      copied += 1;
    } catch {
      /* 备份失败不阻断迁移 */
    }
  }
  // 如果备份了任何文件，在备份目录创建说明文件
  if (copied > 0) {
    try {
      const readmePath = path.join(backupDir, 'README.txt');
      const content = `这是数据迁移前的备份目录

创建时间: ${new Date().toISOString()}
原因: 从旧版本(interview-assistant-desktop)迁移到新版本(面试Ace)

如果迁移后发现数据有问题，可以手动从这个目录恢复文件到:
${newUserDataDir}

备份的文件数量: ${copied}
`;
      fs.writeFileSync(readmePath, content, 'utf8');
    } catch {
      /* 写入说明文件失败不影响备份 */
    }
  }
  return copied > 0 ? backupDir : null;
}

/**
 * 把 legacyDir 的内容搬进 newUserDataDir。
 * 返回 { migrated, from, to, backupDir, errors }。
 */
function migrateLegacyUserData({
  appDataDir,
  newUserDataDir,
  exampleConfigPath = null,
  legacyNames = LEGACY_DIR_NAMES,
  now = new Date(),
} = {}) {
  if (!appDataDir || !newUserDataDir) return { migrated: false, errors: [] };
  const newDirName = path.basename(newUserDataDir);
  for (const legacyName of legacyNames) {
    if (legacyName === newDirName) continue;
    const legacyDir = path.join(appDataDir, legacyName);
    if (!shouldMigrate({ legacyDir, newUserDataDir, exampleConfigPath })) continue;

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(appDataDir, `${newDirName}.pre-migration-${stamp}`);
    let backup = null;
    try {
      backup = backupCurrentState(newUserDataDir, backupDir);
    } catch {
      backup = null;
    }

    const errors = [];
    let entries = [];
    try {
      entries = fs.readdirSync(legacyDir);
    } catch (error) {
      errors.push(`${legacyDir}: ${error.message}`);
    }
    for (const name of entries) {
      if (SKIP_ENTRIES.has(name)) continue;
      try {
        fs.mkdirSync(newUserDataDir, { recursive: true });
        fs.cpSync(path.join(legacyDir, name), path.join(newUserDataDir, name), {
          recursive: true,
          force: true,
          errorOnExist: false,
        });
      } catch (error) {
        // 旧进程仍占用文件时可能失败：记录后继续搬其它条目
        errors.push(`${name}: ${error.message}`);
      }
    }
    return { migrated: true, from: legacyDir, to: newUserDataDir, backupDir: backup, errors };
  }
  return { migrated: false, errors: [] };
}

/**
 * 计算 userData 目录。默认固定为 <appData>/面试Ace，与应用展示名完全解耦；
 * 开发/测试可用 IA_USER_DATA_DIR 显式指定其它目录，避免污染真实数据。
 */
function resolveUserDataDir({ appDataDir, override = null, dirName = USER_DATA_DIR_NAME } = {}) {
  if (!appDataDir) throw new Error('resolveUserDataDir 需要 appDataDir');
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed) return path.resolve(trimmed);
  return path.join(appDataDir, dirName);
}

module.exports = {
  LEGACY_DIR_NAMES,
  SKIP_ENTRIES,
  USER_DATA_DIR_NAME,
  isExampleConfig,
  migrateLegacyUserData,
  resolveUserDataDir,
  shouldMigrate,
};
