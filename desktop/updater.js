// 应用更新：启动后定时检查 Gitee 最新 Release，发现新版本经 IPC 通知渲染进程，
// 用户确认后下载 dmg 并打开安装包（macOS 未签名包无法走 Squirrel 自动替换，
// 因此采用「下载 + 打开 dmg + 提示拖入应用程序」的半自动升级）。
const { app, ipcMain, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  RELEASE_SOURCES,
  GITHUB_SOURCE,
  parseReleasePayload,
  resolveDownloadPlan,
  shouldNotify,
  compareVersions,
} = require('./updateCore');

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 自动检查间隔 6 小时
const STARTUP_CHECK_DELAY_MS = 8 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;

let mainWindowRef = null;
let stateFilePath = null;
let state = { skippedVersion: null, lastCheckAt: 0 };
let downloading = false;

function loadState() {
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.skippedVersion = typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion : null;
      state.lastCheckAt = Number.isFinite(parsed.lastCheckAt) ? parsed.lastCheckAt : 0;
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
function fetchJson(url) {
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
        clearTimeout(timer);
        fetchJson(response.headers.location).then(resolve, reject);
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
          file.destroy();
          fail('下载地址重定向次数过多');
          return;
        }
        startPart(response.headers.location, redirectDepth + 1);
        return;
      }
      if (response.statusCode !== 200) {
        file.destroy();
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
        file.destroy();
        fail(err.message);
      });
    });
    request.on('error', (err) => {
      file.destroy();
      fail(err.message);
    });
    request.end();
  };

  emit({ phase: 'downloading', version, percent: 0 });
  startPart(plan.urls[0]);
}

function registerUpdater(mainWindow) {
  mainWindowRef = mainWindow;
  stateFilePath = path.join(app.getPath('userData'), 'update-state.json');
  loadState();

  ipcMain.handle('update-check', (_event, opts = {}) => { void checkForUpdates({ manual: Boolean(opts.manual) }); });
  ipcMain.handle('update-download', (_event, payload = {}) => downloadUpdate(payload.plan, payload.version));
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

  // 启动后延迟自动检查一次；之后按间隔检查
  setTimeout(() => {
    if (Date.now() - state.lastCheckAt >= AUTO_CHECK_INTERVAL_MS) {
      void checkForUpdates({ manual: false });
    }
  }, STARTUP_CHECK_DELAY_MS);
}

module.exports = { registerUpdater };
