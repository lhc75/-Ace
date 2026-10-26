// 应用更新：启动后定时检查 Gitee 最新 Release，发现新版本经 IPC 通知渲染进程，
// 用户确认后下载 dmg 并自动安装: 挂载镜像 → ditto 覆盖 .app → relaunch 重启。
// 自动安装失败(权限/非常规安装位置)时回退「打开 dmg 手动拖装」。
const { app, ipcMain, shell, net } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  RELEASE_SOURCES,
  GITHUB_SOURCE,
  parseReleasePayload,
  resolveDownloadPlan,
  shouldNotify,
  compareVersions,
  parseHdiutilMountPoint,
} = require('./updateCore');

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 自动检查间隔 6 小时
const STARTUP_CHECK_DELAY_MS = 8 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;

let mainWindowRef = null;
let stateFilePath = null;
let state = { skippedVersion: null, lastCheckAt: 0, autoCheckEnabled: true };
let downloading = false;

function loadState() {
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.skippedVersion = typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion : null;
      state.lastCheckAt = Number.isFinite(parsed.lastCheckAt) ? parsed.lastCheckAt : 0;
      state.autoCheckEnabled = parsed.autoCheckEnabled !== false;
    }
  } catch {
    /* 首次运行没有状态文件 */
  }
}

function saveState() {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
  } catch {
    /* 状态写失败不影响主流程 */
  }
}

function emit(payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('update-state', payload);
  }
}

/** GET JSON（跟随重定向），超时或失败抛错。GitHub API 要求显式 User-Agent。 */
function fetchJson(url, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      method: 'GET',
      headers: { 'User-Agent': 'interview-ace-updater', Accept: 'application/json' },
    });
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('检查更新超时，请检查网络'));
    }, REQUEST_TIMEOUT_MS);
    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // 消费旧响应释放 socket, 且限制重定向深度防止无限循环
        response.resume();
        clearTimeout(timer);
        if (redirectDepth >= 5) {
          reject(new Error('更新接口重定向次数过多'));
          return;
        }
        fetchJson(response.headers.location, redirectDepth + 1).then(resolve, reject);
        return;
      }
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { clearTimeout(timer); resolve({ statusCode: response.statusCode, body }); });
    });
    request.on('error', (err) => { clearTimeout(timer); reject(err); });
    request.end();
  });
}

/** 按优先级依次尝试各 Release 源，返回第一个可用的 release；某源 404(还没有 Release) 则试下一个；全部失败抛错 */
async function fetchLatestRelease() {
  let lastError = null;
  for (const source of RELEASE_SOURCES) {
    try {
      const { statusCode, body } = await fetchJson(source.latestApi);
      if (statusCode === 404) continue; // 该源还没有任何 Release
      if (statusCode !== 200) throw new Error(`${source.name} 更新接口返回 ${statusCode}`);
      const release = parseReleasePayload(JSON.parse(body), source);
      if (!release) throw new Error(`${source.name} 更新信息格式异常`);
      return { release, source };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { release: null, source: RELEASE_SOURCES[0] };
}

async function checkForUpdates({ manual = false } = {}) {
  if (downloading) return;
  emit({ phase: 'checking' });
  try {
    const { release, source } = await fetchLatestRelease();
    if (!release) {
      emit({ phase: 'none' });
      return;
    }
    state.lastCheckAt = Date.now();
    saveState();
    const current = app.getVersion();
    if (compareVersions(release.version, current) <= 0) {
      emit({ phase: 'none', version: release.version });
      return;
    }
    if (!manual && !shouldNotify(current, release, state.skippedVersion)) {
      emit({ phase: 'idle' });
      return;
    }
    emit({
      phase: 'available',
      version: release.version,
      notes: release.notes,
      plan: resolveDownloadPlan(release, '面试Ace'),
      pageUrl: source.releasesPage,
    });
  } catch (error) {
    // 自动检查失败静默（不打断使用），手动检查才提示
    emit({ phase: manual ? 'error' : 'idle', error: error instanceof Error ? error.message : String(error) });
  }
}

/** 依次下载所有分卷并写入同一个 dmg；进度按 (已完成卷 + 当前卷进度) / 总卷数 计算 */
function downloadUpdate(plan, version) {
  if (downloading) return;
  if (!plan || !Array.isArray(plan.urls) || plan.urls.length === 0 || !plan.fileName) return;
  downloading = true;
  const targetPath = path.join(app.getPath('downloads'), plan.fileName);

  const fail = (message) => {
    downloading = false;
    file.destroy();
    // 清掉半成品, 避免 Downloads 里残留损坏的同名 dmg
    try { fs.unlinkSync(targetPath); } catch { /* 文件可能还没创建 */ }
    emit({ phase: 'error', version, error: message });
  };

  const partCount = plan.urls.length;
  let partIndex = 0;
  const file = fs.createWriteStream(targetPath);

  const startPart = (url, redirectDepth = 0) => {
    const request = net.request({ url, method: 'GET' });
    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        if (redirectDepth >= 5) {
          fail('下载地址重定向次数过多');
          return;
        }
        startPart(response.headers.location, redirectDepth + 1);
        return;
      }
      if (response.statusCode !== 200) {
        fail(`下载失败 (HTTP ${response.statusCode})`);
        return;
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        file.write(chunk);
        const partFraction = total > 0 ? received / total : 0;
        const percent = Math.min(99, Math.round(((partIndex + partFraction) / partCount) * 100));
        emit({ phase: 'downloading', version, percent });
      });
      response.on('end', () => {
        partIndex += 1;
        if (partIndex < partCount) {
          startPart(plan.urls[partIndex]);
        } else {
          file.end(() => {
            downloading = false;
            emit({ phase: 'ready', version, percent: 100, dmgPath: targetPath });
          });
        }
      });
      response.on('error', (err) => {
        fail(err.message);
      });
    });
    request.on('error', (err) => {
      fail(err.message);
    });
    request.end();
  };

  emit({ phase: 'downloading', version, percent: 0 });
  startPart(plan.urls[0]);
}


/** 以超时+ promise 化跑一个外部命令 */
function runCmd(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} 失败: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 用下载好的 dmg 自动完成安装并重启。
 * 步骤: hdiutil 挂载(只读) → 找到唯一 .app → ditto 覆盖当前运行的 bundle
 * → 去掉 quarantine → 卸载 → relaunch + quit(走 before-quit 的优雅停机)。
 * 任何一步失败都抛错, 由前端回退到手动安装。
 */
async function installFromDmg(dmgPath) {
  if (process.platform !== 'darwin') throw new Error('仅 macOS 支持自动安装');
  if (typeof dmgPath !== 'string' || !dmgPath.endsWith('.dmg') || !fs.existsSync(dmgPath)) {
    throw new Error('安装包不存在');
  }
  // 用当前可执行文件路径推导 bundle 位置: /X/面试Ace.app/Contents/MacOS/面试Ace
  const marker = '.app/Contents/MacOS/';
  const exePath = app.getPath('exe');
  const idx = exePath.indexOf(marker);
  if (idx < 0) throw new Error('当前未从 .app 运行(可能在直接挂载运行), 请手动安装');
  const destApp = exePath.slice(0, idx + 4);

  const { stdout } = await runCmd('hdiutil', ['attach', '-nobrowse', '-readonly', '-plist', dmgPath]);
  const mountPoint = parseHdiutilMountPoint(stdout);
  if (!mountPoint) throw new Error('挂载安装包失败');
  try {
    const entries = fs.readdirSync(mountPoint).filter((name) => name.endsWith('.app'));
    if (entries.length !== 1) throw new Error('安装包内容异常');
    const srcApp = path.join(mountPoint, entries[0]);
    // 目标目录与旧包都要可写, 否则替换必然失败(比如非管理员账户)
    fs.accessSync(path.dirname(destApp), fs.constants.W_OK);
    if (fs.existsSync(destApp)) fs.accessSync(destApp, fs.constants.W_OK);
    // macOS 允许删除正在运行的 .app(文件句柄仍有效); 先删再拷贝最干净
    await runCmd('rm', ['-rf', destApp]);
    await runCmd('ditto', [srcApp, destApp]);
    // 防御: 去掉隔离属性, 避免重启后被 Gatekeeper 拦
    await runCmd('xattr', ['-dr', 'com.apple.quarantine', destApp]).catch(() => {});
  } finally {
    await runCmd('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {});
  }
}

function registerUpdater(mainWindow) {
  mainWindowRef = mainWindow;
  stateFilePath = path.join(app.getPath('userData'), 'update-state.json');
  loadState();

  ipcMain.handle('update-check', (_event, opts = {}) => { void checkForUpdates({ manual: Boolean(opts.manual) }); });
  ipcMain.handle('update-download', (_event, payload = {}) => downloadUpdate(payload.plan, payload.version));
  ipcMain.handle('update-install', async (_event, payload = {}) => {
    const dmgPath = typeof payload === 'string' ? payload : payload.dmgPath;
    const version = typeof payload === 'object' && payload ? payload.version : undefined;
    try {
      emit({ phase: 'installing' });
      await installFromDmg(dmgPath);
      downloading = false;
      emit({ phase: 'restarting' });
      // 先标记重启再退出; quit 会走 main.js before-quit 的优雅停机(停后端)
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 400);
      return { ok: true };
    } catch (error) {
      downloading = false;
      const message = error?.message || String(error);
      // 回到 ready 卡片并带上错误, 前端可再尝试或改用手动安装
      emit({ phase: 'ready', version, dmgPath, error: message });
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('update-open-installer', (_event, dmgPath) => {
    if (typeof dmgPath === 'string' && dmgPath.endsWith('.dmg') && fs.existsSync(dmgPath)) {
      return shell.openPath(dmgPath);
    }
    return 'invalid path';
  });
  ipcMain.handle('update-open-release-page', (_event, pageUrl) => {
    const target = typeof pageUrl === 'string' && /^https:\/\//.test(pageUrl) ? pageUrl : GITHUB_SOURCE.releasesPage;
    return shell.openExternal(target);
  });
  ipcMain.handle('update-skip-version', (_event, version) => {
    state.skippedVersion = typeof version === 'string' ? version : null;
    saveState();
    emit({ phase: 'idle' });
  });
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('update-get-auto-check', () => state.autoCheckEnabled !== false);
  ipcMain.handle('update-set-auto-check', (_event, enabled) => {
    state.autoCheckEnabled = Boolean(enabled);
    saveState();
    return state.autoCheckEnabled;
  });

  // 启动后延迟自动检查一次；之后按间隔检查
  setTimeout(() => {
    if (state.autoCheckEnabled === false) return;
    if (Date.now() - state.lastCheckAt >= AUTO_CHECK_INTERVAL_MS) {
      void checkForUpdates({ manual: false });
    }
  }, STARTUP_CHECK_DELAY_MS);
}

module.exports = { registerUpdater };
