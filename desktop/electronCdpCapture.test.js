const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureElectronCdpImage,
  chooseCdpTarget,
  listCdpTargets,
  normalizePort,
} = require('./electronCdpCapture');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('normalizes CDP ports and rejects invalid values', () => {
  assert.equal(normalizePort('9222'), 9222);
  assert.throws(() => normalizePort(0), /1-65535/);
  assert.throws(() => normalizePort(70000), /1-65535/);
  assert.throws(() => normalizePort('abc'), /1-65535/);
});

test('chooses the first page matching title and URL filters', () => {
  const targets = [
    { id: '1', type: 'page', title: '登录页', url: 'app://login', webSocketDebuggerUrl: 'ws://1' },
    { id: '2', type: 'page', title: '国考云在线考试', url: 'app://index#basic', webSocketDebuggerUrl: 'ws://2' },
    { id: '3', type: 'page', title: '国考云在线考试', url: 'app://index#exam', webSocketDebuggerUrl: 'ws://3' },
  ];
  assert.equal(chooseCdpTarget(targets, { title: '国考云', url: '#basic' }).id, '2');
  assert.equal(chooseCdpTarget(targets, { title: '考试' }).id, '2');
  assert.equal(chooseCdpTarget(targets, { title: '不存在' }), null);
});

test('lists targets only from loopback CDP endpoint', async () => {
  let requestedUrl = '';
  const targets = await listCdpTargets(9333, {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse([{ id: '1', type: 'page' }]);
    },
  });
  assert.equal(requestedUrl, 'http://127.0.0.1:9333/json/list');
  assert.equal(targets.length, 1);
});

test('captures a PNG through CDP', async () => {
  const png = Buffer.alloc(200, 7);
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      setTimeout(() => this.emit('open'), 0);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type, event) {
      this.listeners.get(type)?.(event);
    }
    send(raw) {
      const message = JSON.parse(raw);
      assert.equal(message.method, 'Page.captureScreenshot');
      setTimeout(() => this.emit('message', {
        data: JSON.stringify({ id: 1, result: { data: png.toString('base64') } }),
      }), 0);
    }
    close() {}
  }
  const result = await captureElectronCdpImage({
    port: 9222,
    fetchImpl: async () => jsonResponse([
      { id: 'page-1', type: 'page', title: '在线考试', url: 'app://index#basic', webSocketDebuggerUrl: 'ws://target' },
    ]),
    WebSocketImpl: FakeWebSocket,
    targetTimeoutMs: 1000,
    captureTimeoutMs: 1000,
  });
  assert.deepEqual(result.png, png);
  assert.deepEqual(result.target, { title: '在线考试', url: 'app://index#basic', id: 'page-1' });
});

test('returns a clear error when no matching target exists', async () => {
  await assert.rejects(captureElectronCdpImage({
    port: 9222,
    fetchImpl: async () => jsonResponse([]),
    targetTimeoutMs: 600,
    captureTimeoutMs: 600,
    sleep: async () => {},
  }), /无法连接本机 Electron 调试端口 9222/);
});
