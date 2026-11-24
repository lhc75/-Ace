#!/usr/bin/env node
/**
 * Capture an Electron renderer through the Chrome DevTools Protocol.
 *
 * The target app must be launched with a remote-debugging port, for example:
 *   /Applications/SomeApp.app/Contents/MacOS/SomeApp --remote-debugging-port=9222
 *
 * This captures webContents pixels, not the macOS display framebuffer, so an
 * Electron window using setContentProtection(true) can still be captured.
 * Only use this with applications you own or are authorized to inspect.
 */
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  return [
    'Usage: node capture-electron-cdp.mjs [options]',
    '',
    'Options:',
    '  --port <number>       Remote debugging port (default: 9222)',
    '  --out <file>          Output PNG path (default: ./electron-capture.png)',
    '  --title <text>        Select a page whose title contains this text',
    '  --url <text>          Select a page whose URL contains this text',
    '  --index <number>      Select page by index after filtering (default: 0)',
    '  --timeout <ms>        Total timeout (default: 15000)',
    '  --help                Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    port: 9222,
    out: path.resolve('electron-capture.png'),
    title: '',
    url: '',
    index: 0,
    timeout: 15000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[i + 1];
    if (arg === '--port') options.port = Number(value);
    else if (arg === '--out') options.out = path.resolve(value || '');
    else if (arg === '--title') options.title = String(value || '');
    else if (arg === '--url') options.url = String(value || '');
    else if (arg === '--index') options.index = Number(value);
    else if (arg === '--timeout') options.timeout = Number(value);
    else throw new Error(`unknown option: ${arg}`);
    i += 1;
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('--port must be a valid TCP port');
  }
  if (!Number.isInteger(options.index) || options.index < 0) {
    throw new Error('--index must be a non-negative integer');
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1000) {
    throw new Error('--timeout must be at least 1000 ms');
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools endpoint returned HTTP ${response.status}`);
  return response.json();
}

function chooseTarget(targets, options) {
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  return pages
    .filter((target) => !options.title || String(target.title || '').includes(options.title))
    .filter((target) => !options.url || String(target.url || '').includes(options.url))[options.index];
}

function capturePng(webSocketUrl, timeoutMs) {
  if (typeof WebSocket !== 'function') {
    throw new Error('This script requires a Node.js version with global WebSocket support (Node 22+)');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketUrl);
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('DevTools capture timed out')), timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Page.captureScreenshot',
        params: { format: 'png', fromSurface: true, captureBeyondViewport: false },
      }));
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
        finish(new Error('DevTools returned no screenshot data'));
        return;
      }
      finish(null, Buffer.from(data, 'base64'));
    });
    ws.addEventListener('error', () => finish(new Error('DevTools WebSocket connection failed')));
    ws.addEventListener('close', () => {
      if (!settled) finish(new Error('DevTools WebSocket closed before capture completed'));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const deadline = Date.now() + options.timeout;
  let lastError = null;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(options.port);
      target = chooseTarget(targets, options);
      if (target) break;
      lastError = new Error('no matching Electron page target');
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (!target) {
    throw new Error(
      `无法连接 Electron 调试端口 ${options.port}：${lastError?.message || 'no target'}。` +
      '请先用 --remote-debugging-port 启动目标应用。',
    );
  }

  const png = await capturePng(target.webSocketDebuggerUrl, Math.max(1000, deadline - Date.now()));
  if (png.length < 100) throw new Error('captured PNG is unexpectedly small');
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, png);
  console.log(JSON.stringify({
    ok: true,
    out: options.out,
    bytes: png.length,
    title: target.title || '',
    url: target.url || '',
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
