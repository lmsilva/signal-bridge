const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSteamArtworkCache,
  ROUTE_PREFIX,
} = require('../src/steam-artwork-cache');

test('steam artwork cache stores details and serves local URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-art-'));
  const cache = createSteamArtworkCache({
    ROOT: root,
    steam: { artworkCacheDir: 'cache' },
  }, { info() {}, warn() {} });

  cache.saveDetails(570, {
    appId: 570,
    name: 'Dota 2',
    posterCandidates: ['https://example.com/poster.jpg'],
    screenshots: ['https://example.com/s1.jpg'],
  });
  assert.equal(cache.getDetails(570).name, 'Dota 2');

  const dir = path.join(root, 'cache', '570');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'poster.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(path.join(dir, 'shot-0.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  assert.equal(cache.hasImages(570), true);
  const urls = cache.getServedImageUrls(570, 'https://192.168.1.10:47810');
  assert.deepEqual(urls.posterCandidates, [
    `https://192.168.1.10:47810${ROUTE_PREFIX}570/poster.jpg`,
  ]);
  assert.equal(urls.screenshots.length, 1);

  const served = cache.resolveServePath(`${ROUTE_PREFIX}570/poster.jpg`);
  assert.ok(served.filePath.endsWith(`${path.sep}poster.jpg`));
  assert.equal(served.mimeType, 'image/jpeg');
  assert.equal(cache.resolveServePath(`${ROUTE_PREFIX}570/../evil.jpg`), null);

  const cleared = cache.clear();
  assert.equal(cleared.ok, true);
  assert.equal(cache.hasImages(570), false);
  assert.equal(cache.stats().apps, 0);
});
