const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  parseTickers,
  formatPrice,
  formatChange,
  buildStockMarketPayload,
  createStockMarket,
  DEFAULT_TICKERS,
} = require('../src/stock-market');
const { stockMarketFrames } = require('../src/vestaboard/formatters/feeds');

function yahooChart(symbol, price, previous) {
  return {
    ok: true,
    async json() {
      return {
        chart: {
          result: [{
            meta: {
              symbol,
              regularMarketPrice: price,
              chartPreviousClose: previous,
              currency: 'USD',
            },
          }],
        },
      };
    },
  };
}

test('parseTickers caps at ten unique symbols', () => {
  const tickers = parseTickers('aapl, MSFT, aapl, goog, amzn, nvda, meta, tsla, spy, qqq, dia, ibm');
  assert.equal(tickers.length, 10);
  assert.equal(tickers[0], 'AAPL');
  assert.ok(!tickers.includes('IBM'));
});

test('formatPrice and formatChange stay board-short', () => {
  assert.equal(formatPrice(319.7), '319.70');
  assert.equal(formatPrice(1234.5), '1234.5');
  assert.equal(formatChange(10.35, 3.346, 'percent'), '+3.3%');
  assert.equal(formatChange(-1.2, -0.4, 'points'), '-1.20');
});

test('buildStockMarketPayload is a vestaboard stocks.market card', () => {
  const payload = buildStockMarketPayload({
    quotes: [
      { symbol: 'AAPL', price: 319.7, previous: 309.35, change: 10.35, percent: 3.35 },
      { symbol: 'MSFT', price: 513.53, previous: 483.24, change: 30.29, percent: 6.27 },
    ],
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.quotes.length, 2);
  assert.equal(payload.quotes[0].direction, 'up');
  assert.match(payload.quotes[0].changeLabel, /\+/);

  const frames = stockMarketFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'stocks.market');
  assert.equal(frames[0].rows.length, 6);
});

test('stockMarketFrames page after five quotes', () => {
  const quotes = DEFAULT_TICKERS.map((symbol, index) => ({
    symbol,
    price: 100 + index,
    previous: 99,
    change: 1,
    percent: 1,
  }));
  const payload = buildStockMarketPayload({ quotes });
  const frames = stockMarketFrames(payload);
  assert.equal(frames.length, 2);
});

test('stockMarketFrames refuse an empty payload', () => {
  assert.deepEqual(stockMarketFrames({ type: 'stocks.market' }), []);
  assert.deepEqual(stockMarketFrames({}), []);
});

test('createStockMarket fetches Yahoo quotes through an injected fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-market-'));
  const api = createStockMarket({
    stockMarketSettingsPath: path.join(dir, 'stock-market-settings.json'),
    stockMarketFetchImpl: async (url) => {
      if (String(url).includes('/AAPL')) {
        return yahooChart('AAPL', 319.7, 309.35);
      }
      if (String(url).includes('/MSFT')) {
        return yahooChart('MSFT', 513.53, 483.24);
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
  });
  api.updateSettings({ tickers: ['AAPL', 'MSFT'] });
  const payload = await api.nextPayload();
  assert.equal(payload.type, 'stocks.market');
  assert.equal(payload.quotes.length, 2);
  assert.equal(payload.quotes[0].symbol, 'AAPL');
  assert.equal(api.statusSnapshot().tickerCount, 2);
});
