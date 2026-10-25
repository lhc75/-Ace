// 端口分配：优先使用约定端口(18080)，被占用时让系统分配空闲端口——
// 与其它桌面软件(Jupyter 等)一致，不再强杀占用者。
const net = require('net');

const PREFERRED_PORT = 18080;

/** 探测端口是否空闲(尝试 listen, 立即关闭) */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 让操作系统分配一个空闲端口 */
function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('系统未能分配空闲端口'));
      });
    });
  });
}

/** 优先 preferred；被占用则回退到系统分配的空闲端口 */
async function pickBackendPort(preferred = PREFERRED_PORT, host = '127.0.0.1') {
  if (await isPortFree(preferred, host)) return { port: preferred, fallback: false };
  const port = await pickFreePort(host);
  return { port, fallback: true };
}

module.exports = { PREFERRED_PORT, isPortFree, pickFreePort, pickBackendPort };
