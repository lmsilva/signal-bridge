const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  parseSymbols,
  formatCryptoPrice,
  buildCryptoMarketPayload,
  createCryptoMarket,
  DEFAULT_SYMBOLS,
} = require('../src/crypto-market');
const { cryptoMarketFrames } = require('../src/vestaboard/formatters/feeds');

function markets(rows) {
  return {
    ok: true,
    async json() { return rows; },
  };
}

test('parseSymbols keeps every unique coin and the default list is the top ten', () => {
  const symbols = parseSymbols('btc, eth, BTC, sol, xrp');
  assert.deepEqual(symbols, ['BTC', 'ETH', 'SOL', 'XRP']);
  assert.equal(DEFAULT_SYMBOLS.length, 10);
  assert.equal(DEFAULT_SYMBOLS[0], 'BTC');
  assert.equal(DEFAULT_SYMBOLS[1], 'ETH');
});

test('formatCryptoPrice stays short enough for a quote row', () => {
  assert.equal(formatCryptoPrice(84278), '84278');
  assert.equal(formatCryptoPrice(2684.41), '2684.4');
  assert.equal(formatCryptoPrice(1.5), '1.50');
  assert.equal(formatCryptoPrice(0.093088), '0.0931');
});

test('buildCryptoMarketPayload is a vestaboard crypto.market card', () => {
  const payload = buildCryptoMarketPayload({
    quotes: [
      { symbol: 'BTC', price: 84278, change: -2323, percent: -2.68 },
      { symbol: 'ETH', price: 2684.41, change: 37, percent: 1.4 },
    ],
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.quotes[0].direction, 'down');
  assert.equal(payload.quotes[1].direction, 'up');
  const frames = cryptoMarketFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'crypto.market');
  assert.equal(frames[0].rows.length, 6);
});

test('cryptoMarketFrames page after five coins', () => {
  const quotes = DEFAULT_SYMBOLS.map((symbol, index) => ({
    symbol,
    price: 100 + index,
    change: 1,
    percent: 1,
  }));
  const frames = cryptoMarketFrames(buildCryptoMarketPayload({ quotes }));
  assert.equal(frames.length, 2);
});

test('createCryptoMarket matches symbols from one CoinGecko page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-market-'));
  let calls = 0;
  const api = createCryptoMarket({
    cryptoMarketSettingsPath: path.join(dir, 'crypto-market-settings.json'),
    cryptoMarketFetchImpl: async () => {
      calls += 1;
      return markets([
        { symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1, current_price: 84278, price_change_24h: -1, price_change_percentage_24h: -0.1 },
        { symbol: 'eth', name: 'Ethereum', market_cap_rank: 2, current_price: 2684, price_change_24h: 10, price_change_percentage_24h: 0.4 },
      ]);
    },
  });
  api.updateSettings({ symbols: ['ETH', 'BTC', 'DOGE'] });
  const payload = await api.nextPayload();
  assert.equal(payload.quotes.length, 2);
  assert.deepEqual(payload.quotes.map((row) => row.symbol), ['ETH', 'BTC']);
  assert.ok(payload.errors.some((line) => line.startsWith('DOGE:')));
  assert.equal(calls, 2, 'a missing symbol asks for the second page once');
  const again = await api.nextPayload();
  assert.equal(again.quotes.length, 2);
  assert.equal(calls, 2, 'the market page is reused inside the cache window');
});
