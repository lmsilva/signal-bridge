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
  assert.ok(result.expiresAt);

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

test('get() returns null for unknown, tampered, or expired tokens', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  const routeTail = result.path.slice(cache.routePrefix.length);

  assert.equal(cache.get('deadbeef.png'), null);
  assert.equal(cache.get('../../etc/passwd'), null);

  // Expired: manually rewrite the index entry to look already-expired.
  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const token = routeTail.replace(/\.[^.]+$/, '');
  index[token].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  assert.equal(cache.get(routeTail), null);
  // Lazily invalidated: the file should be gone too, not just index-hidden.
  assert.equal(fs.existsSync(path.join(cache.cacheDir, path.basename(routeTail))), false);
});

test('sweep() removes only expired entries and their files', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const fresh = cache.store(TINY_PNG_DATA_URL);
  const stale = cache.store(TINY_PNG_DATA_URL);

  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const staleToken = stale.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  index[staleToken].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  const removed = cache.sweep();
  assert.deepEqual(removed, [staleToken]);

  const freshRouteTail = fresh.path.slice(cache.routePrefix.length);
  assert.ok(cache.get(freshRouteTail));
  assert.equal(fs.existsSync(path.join(cache.cacheDir, `${staleToken}.png`)), false);
});

test('default cache lifetime is 7 days', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  const expiresInMs = Date.parse(result.expiresAt) - Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(expiresInMs - sevenDaysMs) < 5000);
});

test('cache lifetime is configurable', () => {
  const cache = createQrImageCache(makeConfig({ qrImage: { cacheDir: 'qr-image-cache', cacheDays: 1 } }), silentLog);
  const result = cache.store(TINY_PNG_DATA_URL);
  const expiresInMs = Date.parse(result.expiresAt) - Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(expiresInMs - oneDayMs) < 5000);
});

test('list() returns non-expired photos newest-first', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  const first = cache.store(TINY_PNG_DATA_URL);
  const second = cache.store(TINY_PNG_DATA_URL);
  const expired = cache.store(TINY_PNG_DATA_URL);

  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const expiredToken = expired.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  index[expiredToken].expiresAt = new Date(Date.now() - 1000).toISOString();
  // Force distinct createdAt ordering so newest-first sorting is verifiable.
  const secondToken = second.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  index[secondToken].createdAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  const list = cache.list();
  assert.deepEqual(list.map((entry) => entry.path), [second.path, first.path]);
  assert.ok(list.every((entry) => entry.expiresAt && entry.createdAt));
});

test('list() is empty when the cache has nothing (or only expired) photos', () => {
  const cache = createQrImageCache(makeConfig(), silentLog);
  assert.deepEqual(cache.list(), []);

  const stale = cache.store(TINY_PNG_DATA_URL);
  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const token = stale.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  index[token].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  assert.deepEqual(cache.list(), []);
});

test('startSweeper/stopSweeper do not keep the process alive', () => {
  const cache = createQrImageCache(makeConfig({ qrImage: { cacheDir: 'qr-image-cache', sweepIntervalMs: 50 } }), silentLog);
  cache.startSweeper();
  cache.stopSweeper();
  // No assertion needed beyond "this test process exits" (--test-force-exit
  // covers any regression, but unref() means we shouldn't even need it here).
});
