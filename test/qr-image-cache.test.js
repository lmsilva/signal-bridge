const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createQrImageCache,
  parseDataUrl,
  renderThumbnail,
  THUMB_MAX_EDGE,
  THUMB_SUBDIR,
} = require('../src/qr-image-cache');

// 1x1 transparent PNG.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

// Tiny valid JPEG (1x1) — used as a stub thumb payload in unit tests.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS'
  + 'Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJ'
  + 'CQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy'
  + 'MjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAA'
  + 'AAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAA'
  + 'AAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/8QAFBAB'
  + 'AAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA'
  + '/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//'
  + 'xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Av/EABQQAQAAAAAAAAAAAAA'
  + 'AAAAAAAAB/9oACAEBAAE/IX//2Q==',
  'base64',
);

function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-image-cache-'));
  return {
    ROOT: dataDir,
    qrImage: { cacheDir: 'qr-image-cache' },
    ...overrides,
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Instant thumb writer so store/backfill tests stay deterministic. */
async function stubRenderThumb() {
  return Buffer.from(TINY_JPEG);
}

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

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
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
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
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const result = cache.store(TINY_PNG_DATA_URL);
  const routeTail = result.path.slice(cache.routePrefix.length);

  assert.equal(cache.get('deadbeef.png'), null);
  assert.equal(cache.get('../../etc/passwd'), null);
  assert.equal(cache.get('thumbs/../../etc/passwd'), null);

  // No automatic expiry any more — a photo stored long ago is still served.
  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const token = routeTail.replace(/\.[^.]+$/, '');
  index[token].createdAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  assert.ok(cache.get(routeTail));
});

test('delete() removes the file, thumbnail, and index entry', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const stored = cache.store(TINY_PNG_DATA_URL);
  const routeTail = stored.path.slice(cache.routePrefix.length);
  const token = routeTail.replace(/\.[^.]+$/, '');

  await waitFor(() => cache.list()[0]?.thumbReady);

  const thumbTail = `${THUMB_SUBDIR}/${token}.${THUMB_MAX_EDGE}.jpg`;
  assert.ok(cache.get(thumbTail));
  assert.equal(cache.delete(token), true);
  assert.equal(cache.get(routeTail), null);
  assert.equal(cache.get(thumbTail), null);
  assert.equal(fs.existsSync(path.join(cache.cacheDir, path.basename(routeTail))), false);
  assert.equal(
    fs.existsSync(path.join(cache.cacheDir, THUMB_SUBDIR, `${token}.${THUMB_MAX_EDGE}.jpg`)),
    false,
  );

  assert.equal(cache.delete(token), false);
  assert.equal(cache.delete('not-a-real-token'), false);
  assert.equal(cache.delete(''), false);
});

test('list() returns every stored photo newest-first, with tokens and thumb paths', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const first = cache.store(TINY_PNG_DATA_URL);
  const second = cache.store(TINY_PNG_DATA_URL);

  const indexPath = path.join(cache.cacheDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const secondToken = second.path.slice(cache.routePrefix.length).replace(/\.[^.]+$/, '');
  // Force distinct createdAt ordering so newest-first sorting is verifiable.
  index[secondToken].createdAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  await waitFor(() => cache.list().every((entry) => entry.thumbReady));

  const list = cache.list();
  assert.deepEqual(list.map((entry) => entry.path), [second.path, first.path]);
  assert.deepEqual(list.map((entry) => entry.token), [second.token, first.token]);
  assert.ok(list.every((entry) => entry.createdAt));
  assert.ok(list.every((entry) => (
    entry.thumbPath === `/qr-images/thumbs/${entry.token}.${THUMB_MAX_EDGE}.jpg`
  )));
  assert.ok(list.every((entry) => entry.thumbReady));
});

test('onChange notifies subscribers on store, thumb, and delete', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const events = [];
  const unsubscribe = cache.onChange((reason, photos) => events.push({ reason, count: photos.length }));

  const stored = cache.store(TINY_PNG_DATA_URL);
  await waitFor(() => events.some((event) => event.reason === 'thumb'));
  cache.delete(stored.token);

  assert.deepEqual(
    events.map((event) => event.reason),
    ['store', 'thumb', 'delete'],
  );
  assert.deepEqual(
    events.map((event) => event.count),
    [1, 1, 0],
  );

  unsubscribe();
  cache.store(TINY_PNG_DATA_URL);
  assert.equal(events.length, 3, 'no further notifications after unsubscribe');
});

test('onChange tolerates a non-function listener and a listener that throws', () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  assert.doesNotThrow(() => cache.onChange(null)());
  cache.onChange(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => cache.store(TINY_PNG_DATA_URL));
});

test('list() is empty for a fresh cache and reflects deletions', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  assert.deepEqual(cache.list(), []);

  const stored = cache.store(TINY_PNG_DATA_URL);
  assert.equal(cache.list().length, 1);

  cache.delete(stored.token);
  assert.deepEqual(cache.list(), []);
});

test('backfillThumbnails writes missing thumbs for legacy photos', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const stored = cache.store(TINY_PNG_DATA_URL);
  await waitFor(() => cache.list()[0]?.thumbReady);

  // Simulate a legacy photo that only has the original on disk.
  fs.unlinkSync(path.join(cache.cacheDir, THUMB_SUBDIR, `${stored.token}.${THUMB_MAX_EDGE}.jpg`));
  assert.equal(cache.list()[0].thumbReady, false);
  assert.equal(
    cache.list()[0].thumbPath,
    `/qr-images/thumbs/${stored.token}.${THUMB_MAX_EDGE}.jpg`,
  );

  const result = await cache.backfillThumbnails({ concurrency: 1 });
  assert.equal(result.generated, 1);
  assert.equal(cache.list()[0].thumbReady, true);
  assert.ok(cache.get(`${THUMB_SUBDIR}/${stored.token}.${THUMB_MAX_EDGE}.jpg`)?.isThumb);
});

test('get() serves thumbs with image/jpeg and rejects path traversal', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const stored = cache.store(TINY_PNG_DATA_URL);
  await waitFor(() => cache.list()[0]?.thumbReady);
  const entry = cache.get(`${THUMB_SUBDIR}/${stored.token}.${THUMB_MAX_EDGE}.jpg`);
  assert.ok(entry);
  assert.equal(entry.mimeType, 'image/jpeg');
  assert.equal(entry.isThumb, true);
});

test('ensureThumb builds a missing thumb on demand', async () => {
  const cache = createQrImageCache(makeConfig(), silentLog, { renderThumb: stubRenderThumb });
  const stored = cache.store(TINY_PNG_DATA_URL);
  await waitFor(() => cache.list()[0]?.thumbReady);
  fs.unlinkSync(path.join(cache.cacheDir, THUMB_SUBDIR, `${stored.token}.${THUMB_MAX_EDGE}.jpg`));
  assert.equal(cache.get(`${THUMB_SUBDIR}/${stored.token}.${THUMB_MAX_EDGE}.jpg`), null);

  const entry = await cache.ensureThumb(stored.token);
  assert.ok(entry?.isThumb);
  assert.equal(entry.mimeType, 'image/jpeg');
  assert.ok(cache.list()[0].thumbReady);
});

test('without sharp, list omits thumbPath so the admin grid can use originals', () => {
  const cache = createQrImageCache(makeConfig(), silentLog, {
    sharpImpl: null,
    renderThumb: async () => null,
  });
  const stored = cache.store(TINY_PNG_DATA_URL);
  assert.equal(stored.thumbPath, null);
  assert.equal(cache.list()[0].thumbPath, null);
  assert.equal(cache.canEncodeThumbs, false);
});

test('renderThumbnail returns null without sharp and a buffer when sharp works', async () => {
  assert.equal(await renderThumbnail(Buffer.from('nope'), { sharpImpl: null }), null);
  let sharpImpl = null;
  try {
    sharpImpl = require('sharp');
  } catch {
    // Environment without sharp — skip the live encode assertion.
  }
  if (!sharpImpl) {
    return;
  }
  const out = await renderThumbnail(Buffer.from(TINY_PNG_BASE64, 'base64'), { sharpImpl });
  assert.ok(out);
  assert.ok(out.length > 0);
  // JPEG SOI marker
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
});
