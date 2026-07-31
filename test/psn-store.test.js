const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripHtml,
  cleanStoreDescription,
  pickFullGameProductId,
  parseProductEnrichment,
  fetchStoreEnrichmentForTitle,
  clearStoreEnrichmentCache,
} = require('../src/psn-store');

test('cleanStoreDescription strips HTML and PS5 preamble', () => {
  const html = [
    '<p>To play this game on PS5, your system may need to be updated.</p>',
    '<p>Roll through wondrous worlds with AiAi and friends as you race!</p>',
    '<p>Features:</p><ul><li>Fun</li></ul>',
  ].join('');
  const text = cleanStoreDescription(html);
  assert.match(text, /^Roll through/);
  assert.doesNotMatch(text, /To play this game on PS5/);
  assert.ok(stripHtml('<b>Hi</b> &amp; bye').includes('Hi'));
});

test('pickFullGameProductId prefers Full Game link', () => {
  const id = pickFullGameProductId({
    links: [
      { id: 'BUNDLE-1', game_contentType: 'Bundle', name: 'Bundle' },
      { id: 'UP0177-PPSA01668_00-FLASH20000000005', game_contentType: 'Full Game', name: 'Mania' },
    ],
  });
  assert.equal(id, 'UP0177-PPSA01668_00-FLASH20000000005');
});

test('parseProductEnrichment extracts screenshots and stars', () => {
  const parsed = parseProductEnrichment({
    id: 'UP0177-PPSA01668_00-FLASH20000000005',
    long_desc: '<p>Roll through wondrous worlds with AiAi!</p>',
    mediaList: {
      screenshots: [
        { url: 'https://vulcan.example/a.jpg', type: 'SCREENSHOT' },
        { url: 'https://vulcan.example/b.jpg', type: 'SCREENSHOT' },
        { url: 'https://vulcan.example/c.jpg', type: 'SCREENSHOT' },
        { url: 'https://vulcan.example/d.jpg', type: 'SCREENSHOT' },
      ],
    },
    star_rating: { score: '4.04', total: '466' },
    content_rating: { description: 'ESRB Everyone 10+' },
    provider_name: 'SEGA of America, Inc.',
  });
  assert.equal(parsed.screenshots.length, 3);
  assert.equal(parsed.starRating, 4.04);
  assert.equal(parsed.contentRating, 'ESRB Everyone 10+');
  assert.match(parsed.shortDescription, /Roll through/);
});

test('fetchStoreEnrichmentForTitle resolves title → product and soft-fails', async () => {
  clearStoreEnrichmentCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/container/') && url.endsWith('/PPSA01668_00')) {
      return {
        ok: true,
        json: async () => ({
          links: [
            { id: 'UP0177-PPSA01668_00-FLASH20000000005', game_contentType: 'Full Game' },
          ],
        }),
      };
    }
    if (url.includes('UP0177-PPSA01668_00-FLASH20000000005')) {
      return {
        ok: true,
        json: async () => ({
          id: 'UP0177-PPSA01668_00-FLASH20000000005',
          long_desc: '<p>Roll through wondrous worlds!</p>',
          mediaList: {
            screenshots: [
              { url: 'https://vulcan.example/1.jpg' },
              { url: 'https://vulcan.example/2.jpg' },
            ],
          },
          star_rating: { score: '4.04', total: '10' },
        }),
      };
    }
    return { ok: false };
  };

  const first = await fetchStoreEnrichmentForTitle({
    titleId: 'PPSA01668_00',
    name: 'Super Monkey Ball Banana Mania',
    fetchImpl,
  });
  assert.equal(first.screenshots.length, 2);
  assert.equal(first.starRating, 4.04);

  // Cached — no extra network.
  const before = calls.length;
  const second = await fetchStoreEnrichmentForTitle({
    titleId: 'PPSA01668_00',
    fetchImpl,
  });
  assert.equal(calls.length, before);
  assert.equal(second.productId, first.productId);

  clearStoreEnrichmentCache();
  const missing = await fetchStoreEnrichmentForTitle({
    titleId: 'MISSING_00',
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(missing, null);
});
