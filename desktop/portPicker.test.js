const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { isPortFree, pickFreePort, pickBackendPort, PREFERRED_PORT } = require('./portPicker');

function occupy(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

test('isPortFree reports a listening port as occupied and a closed one as free', async () => {
  const server = await occupy(0);
  const taken = server.address().port;
  assert.equal(await isPortFree(taken), false);
  const free = await pickFreePort();
  assert.equal(await isPortFree(free), true);
  server.close();
});

test('pickFreePort returns a usable port', async () => {
  const port = await pickFreePort();
  assert.ok(port > 0 && port < 65536);
  assert.equal(await isPortFree(port), true);
});

test('pickBackendPort keeps the preferred port when free', async () => {
  const free = await pickFreePort();
  const result = await pickBackendPort(free);
  assert.deepEqual(result, { port: free, fallback: false });
});

test('pickBackendPort falls back to a free port when preferred is occupied', async () => {
  const server = await occupy(0);
  const taken = server.address().port;
  const result = await pickBackendPort(taken);
  assert.equal(result.fallback, true);
  assert.notEqual(result.port, taken);
  assert.equal(await isPortFree(result.port), true);
  server.close();
});

test('preferred port constant stays 18080', () => {
  assert.equal(PREFERRED_PORT, 18080);
});
