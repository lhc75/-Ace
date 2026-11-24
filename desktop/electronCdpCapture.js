const DEFAULT_TARGET_TIMEOUT_MS = 3500;
const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;
const DEFAULT_LIST_TIMEOUT_MS = 1200;
const DEFAULT_POLL_MS = 200;

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error('CDP 端口必须是 1-65535 之间的整数');
  }
  return value;
}

function normalizeFilter(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength).toLowerCase();
}

function targetMatches(target, { title = '', url = '' } = {}) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const titleNeedle = normalizeFilter(title, 200);
  const urlNeedle = normalizeFilter(url, 500);
  if (titleNeedle && !String(target.title || '').toLowerCase().includes(titleNeedle)) return false;
  if (urlNeedle && !String(target.url || '').toLowerCase().includes(urlNeedle)) return false;
  return true;
}

function chooseCdpTarget(targets, filters = {}) {
  return (Array.isArray(targets) ? targets : []).find((target) => targetMatches(target, filters)) || null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listCdpTargets(port, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 fetch');
  const normalizedPort = normalizePort(port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(200, timeoutMs));
  try {
    const response = await fetchImpl(`http://127.0.0.1:${normalizedPort}/json/list`, {
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`CDP 调试端口返回 HTTP ${response?.status ?? 'unknown'}`);
    }
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('CDP 调试端口返回了无效的 target 列表');
    return targets;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdpTarget({
  port,
  title = '',
  url = '',
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
} = {}) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || DEFAULT_TARGET_TIMEOUT_MS);
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const targets = await listCdpTargets(port, { fetchImpl });
      const target = chooseCdpTarget(targets, { title, url });
      if (target) return target;
      lastError = new Error('没有匹配的 Electron 页面 target');
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.max(50, Number(pollMs) || DEFAULT_POLL_MS));
  }
  throw new Error(
    `无法连接本机 Electron 调试端口 ${normalizePort(port)}：${lastError?.message || 'no target'}。` +
    '请给目标应用加上 --remote-debugging-port=<端口> 后重新启动。',
  );
}

function captureCdpPng(webSocketUrl, {
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!webSocketUrl) return Promise.reject(new Error('CDP target 缺少 webSocketDebuggerUrl'));
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new Error('当前运行环境不支持 WebSocket'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(
      () => finish(new Error('CDP 截图超时')),
      Math.max(500, Number(timeoutMs) || DEFAULT_CAPTURE_TIMEOUT_MS),
    );
    try {
      ws = new WebSocketImpl(webSocketUrl);
    } catch (error) {
      finish(error);
      return;
    }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Page.captureScreenshot',
          params: { format: 'png', fromSurface: true, captureBeyondViewport: false },
        }));
      } catch (error) {
        finish(error);
      }
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        finish(error);
        return;
      }
      if (message.id !== 1) return;
      if (message.error) {
        finish(new Error(message.error.message || JSON.stringify(message.error)));
        return;
      }
      const data = message.result?.data;
      if (!data) {
        finish(new Error('CDP 没有返回截图数据'));
        return;
      }
      const png = Buffer.from(data, 'base64');
      if (png.length < 100) {
        finish(new Error('CDP 截图数据异常'));
        return;
      }
      finish(null, png);
    });
    ws.addEventListener('error', () => finish(new Error('CDP WebSocket 连接失败')));
    ws.addEventListener('close', () => {
      if (!settled) finish(new Error('CDP 连接在截图完成前关闭'));
    });
  });
}

async function captureElectronCdpImage({
  port,
  title = '',
  url = '',
  targetTimeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
  captureTimeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  sleep = defaultSleep,
} = {}) {
  const normalizedPort = normalizePort(port);
  const target = await waitForCdpTarget({
    port: normalizedPort,
    title,
    url,
    timeoutMs: targetTimeoutMs,
    fetchImpl,
    sleep,
  });
  const png = await captureCdpPng(target.webSocketDebuggerUrl, {
    timeoutMs: captureTimeoutMs,
    WebSocketImpl,
  });
  return {
    png,
    target: {
      title: String(target.title || ''),
      url: String(target.url || ''),
      id: String(target.id || ''),
    },
  };
}

module.exports = {
  captureCdpPng,
  captureElectronCdpImage,
  chooseCdpTarget,
  listCdpTargets,
  normalizePort,
  targetMatches,
  waitForCdpTarget,
};
