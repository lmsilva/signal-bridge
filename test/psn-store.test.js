const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stripHtml,
  cleanStoreDescription,
  pickFullGameProductId,
  parseProductEnrichment,
  fetchStoreEnrichmentForTitle,
  clearStoreEnrichmentCache,
  regionForProductId,
  CACHE_TTL_MS,
  MISS_CACHE_TTL_MS,
} = require('../src/psn-store');

test('a product id names its own storefront', () => {
  assert.deepEqual(regionForProductId('EP6959-PPSA17732_00-0265718801274251'), { country: 'GB', lang: 'en' });
  assert.deepEqual(regionForProductId('UP0177-PPSA01668_00-FLASH20000000005'), { country: 'US', lang: 'en' });
  assert.equal(regionForProductId('ZZ1234-X'), null);
  assert.equal(regionForProductId(''), null);
});

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

/** Mimics a real Response closely enough for `fetchJson` — body read as text. */
function reply(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

test('fetchStoreEnrichmentForTitle resolves title → product and soft-fails', async () => {
  clearStoreEnrichmentCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/container/') && url.endsWith('/PPSA01668_00')) {
      return reply({
        links: [
          { id: 'UP0177-PPSA01668_00-FLASH20000000005', game_contentType: 'Full Game' },
        ],
      });
    }
    if (url.includes('UP0177-PPSA01668_00-FLASH20000000005')) {
      return reply({
        id: 'UP0177-PPSA01668_00-FLASH20000000005',
        long_desc: '<p>Roll through wondrous worlds!</p>',
        mediaList: {
          screenshots: [
            { url: 'https://vulcan.example/1.jpg' },
            { url: 'https://vulcan.example/2.jpg' },
          ],
        },
        star_rating: { score: '4.04', total: '10' },
      });
    }
    return { ok: false, status: 404 };
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
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(missing, null);
});

test('a 204 product falls through to the storefront the product id belongs to', async () => {
  clearStoreEnrichmentCache();
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith('/PPSA17732_00')) {
      return reply({ links: [{ id: 'EP6959-PPSA17732_00-0265718801274251', game_contentType: 'Full Game' }] });
    }
    // The US storefront no longer serves this European product.
    if (url.includes('/US/en/') && url.includes('EP6959-')) {
      return { ok: true, status: 204, text: async () => '' };
    }
    if (url.includes('/GB/en/') && url.includes('EP6959-')) {
      return reply({
        id: 'EP6959-PPSA17732_00-0265718801274251',
        long_desc: '<p>Clean up Averno City as a rookie cop.</p>',
        mediaList: { screenshots: [{ url: 'https://vulcan.example/precinct.jpg' }] },
      });
    }
    return { ok: false, status: 404 };
  };

  const value = await fetchStoreEnrichmentForTitle({ titleId: 'PPSA17732_00', fetchImpl });
  assert.match(value.shortDescription, /Averno City/);
  assert.equal(value.screenshots.length, 1);
  assert.ok(asked.some((url) => url.includes('/GB/en/')), 'should retry on the European storefront');
});

test('a miss is retried sooner than a hit is refreshed', async () => {
  clearStoreEnrichmentCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404 };
  };
  const at = (ms) => fetchStoreEnrichmentForTitle({ titleId: 'GONE_00', fetchImpl, now: () => ms });

  assert.equal(await at(0), null);
  assert.equal(calls, 1);
  await at(MISS_CACHE_TTL_MS - 1000);
  assert.equal(calls, 1, 'still inside the miss window');
  await at(MISS_CACHE_TTL_MS + 1000);
  assert.equal(calls, 2, 'past the miss window it asks again');
  assert.ok(MISS_CACHE_TTL_MS < CACHE_TTL_MS);
});
