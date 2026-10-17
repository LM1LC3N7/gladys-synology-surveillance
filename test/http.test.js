// -----------------------------------------------------------------------------
// The real transport (node:http / node:https) against loopback servers only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNasUrl } from '../src/config.js';
import { Store } from '../src/store.js';
import { SynologyClient } from '../src/synology/client.js';
import { CODES } from '../src/synology/errors.js';
import { httpRequest } from '../src/synology/http.js';
import { createFakeNas } from './helpers/fakeNas.js';

const tlsFile = (name) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));

async function serve(handler, { secure = false } = {}) {
  const requests = [];
  const listener = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  };
  const server = secure
    ? https.createServer({ key: tlsFile('server.key'), cert: tlsFile('server.pem') }, listener)
    : http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const okJson = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"success":true,"data":{}}');
};

test('GET and POST, the form body, the size cap', async () => {
  const server = await serve((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200);
      res.end(Buffer.alloc(5000));
      return;
    }
    okJson(req, res);
  });
  try {
    const get = await httpRequest(`${server.url}/a?b=1`, { timeout: 2000, maxBytes: 1000 });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString(), '{"success":true,"data":{}}');
    await httpRequest(`${server.url}/p`, {
      method: 'POST',
      body: 'x=1&y=%20',
      timeout: 2000,
      maxBytes: 1000,
    });
    assert.deepEqual(server.requests.at(-1), { method: 'POST', url: '/p', body: 'x=1&y=%20' });
    await assert.rejects(
      httpRequest(`${server.url}/big`, { timeout: 2000, maxBytes: 1000 }),
      (err) => err.code === CODES.TOO_LARGE,
    );
  } finally {
    await server.close();
  }
});

test('no answer in time, nobody listening', async () => {
  const server = await serve(() => {}); // never answers
  try {
    await assert.rejects(
      httpRequest(server.url, { timeout: 200, maxBytes: 1000 }),
      (err) => err.code === CODES.TIMEOUT,
    );
  } finally {
    await server.close();
  }
  await assert.rejects(
    httpRequest(server.url, { timeout: 2000, maxBytes: 1000 }),
    (err) => err.code === CODES.UNREACHABLE,
  );
});

test('https: an untrusted certificate is refused by default', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    await assert.rejects(
      httpRequest(server.url, { timeout: 2000, maxBytes: 1000 }),
      (err) => err.code === CODES.TLS_UNTRUSTED,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('https, trust on first use: pinned, then a different certificate refused before any request', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    const pins = [];
    const first = await httpRequest(`${server.url}/x`, {
      timeout: 2000,
      maxBytes: 1000,
      tls: { trustOnFirstUse: true, pin: null, onPin: (fp) => pins.push(fp) },
    });
    assert.equal(first.status, 200);
    assert.equal(pins.length, 1);
    assert.match(pins[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    await httpRequest(`${server.url}/y`, {
      method: 'POST',
      body: 'passwd=secret',
      timeout: 2000,
      maxBytes: 1000,
      tls: { trustOnFirstUse: true, pin: pins[0] },
    });
    assert.equal(server.requests.length, 2);
    await assert.rejects(
      httpRequest(`${server.url}/z`, {
        method: 'POST',
        body: 'passwd=secret',
        timeout: 2000,
        maxBytes: 1000,
        tls: { trustOnFirstUse: true, pin: 'AA:BB' },
      }),
      (err) => err.code === CODES.TLS_CHANGED,
    );
    assert.equal(server.requests.length, 2, 'the password never left');
  } finally {
    await server.close();
  }
});

test('the client over the real transport, against the fake NAS on loopback', async () => {
  const nas = createFakeNas();
  const server = await nas.listen();
  try {
    const store = new Store({ filePath: join(mkdtempSync(join(tmpdir(), 'syno-')), 's.json') });
    await store.load();
    const client = new SynologyClient({
      nas: parseNasUrl(server.url),
      username: 'gladys',
      password: 's3cret pass&=',
      store,
    });
    assert.equal((await client.listCameras()).length, 3);
    const jpeg = await client.snapshot(1);
    assert.equal(jpeg.length, nas.snapshotSizes[1]);
    await client.logout();
    assert.equal(nas.sessions.size, 0);
  } finally {
    await server.close();
  }
});
