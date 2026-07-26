const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createQrImageCache, parseDataUrl } = require('../src/qr-image-cache');

// 1x1 transparent PNG.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-image-cache-'));
  return {
    ROOT: dataDir,
    qrImage: { cacheDir: 'qr-image-cache' },
    ...overrides,
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('parseDataUrl decodes supported image mime types', () => {
  const parsed = parseDataUrl(TINY_PNG_DATA_URL);
  assert.ok(parsed);
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.ext, '.png');
  assert.ok(parsed.buffer.length > 0);
});

test('parseDataUrl rejects malformed or unsupported input', () => {
  assert.equal(parseDataUrl('not-a-data-url'), null);
  assert.equal(parseDataUrl('data:text/plain;base64,aGVsbG8='), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl(null), null);
});

test('store writes a file, returns a route path, and get() serves it back', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  assert.equal(result.ok, true);
  assert.match(result.path, /^\/qr-images\/[0-9a-f]{32}\.png$/);
  assert.ok(result.createdAt);
  assert.ok(result.token);

  const routeTail = result.path.slice(cache.routePrefix.length);
  const entry = cache.get(routeTail);
  assert.ok(entry);
  assert.equal(entry.mimeType, 'image/png');
  assert.ok(fs.existsSync(entry.filePath));
});

test('store rejects images larger than the configured max size', () => {
  const cache = createQrImageCache(makeConfig({ qrImage: { cacheDir: 'qr-image-cache', maxBytes: 8 } }), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  assert.equal(result.ok, false);
  assert.match(result.error, /too large/);
});

test('get() returns null for unknown or tampered tokens, and never expires on its own', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  const routeTail = result.path.slice(cache.routePrefix.length);

  assert.equal(cache.get('deadbeef.png'), null);
  assert.equal(cache.get('../../etc/passwd'), null);

  // No automatic expiry any more — a photo stored long ago is still served.
  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const token = routeTail.replace(/\.[^.]+$/, '');
  index[token].createdAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  assert.ok(cache.get(routeTail));
});

test('delete() removes the file and index entry, and is idempotent for unknown tokens', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const stored = cache.store(TINY_PNG_DATA_URL);
  const routeTail = stored.path.slice(cache.routePrefix.length);
  const token = routeTail.replace(/\.[^.]+$/, '');

  assert.equal(cache.delete(token), true);
  assert.equal(cache.get(routeTail), null);
  assert.equal(fs.existsSync(path.join(cache.cacheDir, path.basename(routeTail))), false);

  // Already gone — a second delete (or an unknown token) reports false, not an error.
  assert.equal(cache.delete(token), false);
  assert.equal(cache.delete('not-a-real-token'), false);
  assert.equal(cache.delete(''), false);
});

test('list() returns every stored photo newest-first, with tokens', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const first = cache.store(TINY_PNG_DATA_URL);
  const second = cache.store(TINY_PNG_DATA_URL);

  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const secondToken = second.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  // Force distinct createdAt ordering so newest-first sorting is verifiable.
  index[secondToken].createdAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  const list = cache.list();
  assert.deepEqual(list.map((entry) => entry.path), [second.path, first.path]);
  assert.deepEqual(list.map((entry) => entry.token), [second.token, first.token]);
  assert.ok(list.every((entry) => entry.createdAt));
});

test('onChange notifies subscribers on store and delete, with the current photo list', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const events = [];
  const unsubscribe = cache.onChange((reason, photos) => events.push({ reason, count: photos.length }));

  const stored = cache.store(TINY_PNG_DATA_URL);
  cache.delete(stored.token);

  assert.deepEqual(events, [
    { reason: 'store', count: 1 },
    { reason: 'delete', count: 0 },
  ]);

  unsubscribe();
  cache.store(TINY_PNG_DATA_URL);
  assert.equal(events.length, 2, 'no further notifications after unsubscribe');
});

test('onChange tolerates a non-function listener and a listener that throws', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  assert.doesNotThrow(() => cache.onChange(null)());
  cache.onChange(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => cache.store(TINY_PNG_DATA_URL));
});

test('list() is empty for a fresh cache and reflects deletions', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  assert.deepEqual(cache.list(), []);

  const stored = cache.store(TINY_PNG_DATA_URL);
  assert.equal(cache.list().length, 1);

  cache.delete(stored.token);
  assert.deepEqual(cache.list(), []);
});
