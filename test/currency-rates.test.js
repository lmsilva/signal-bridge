const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  DEFAULT_QUOTES,
  formatRate,
  formatChangePercent,
  computeChange,
  parseQuotes,
  sanitiseSettings,
  buildCurrencyRatesPayload,
  createCurrencyRates,
  createRateCache,
  loadCurrencyRatesPayload,
} = require('../src/currency-rates');
const { currencyRatesFrames } = require('../src/vestaboard/formatters/feeds');
const { decodeCodes, CHIPS } = require('../src/vestaboard/encoder');

test('formatRate picks board-friendly precision', () => {
  assert.equal(formatRate(0.8589), '0.8589');
  assert.equal(formatRate(1.3854), '1.385');
  assert.equal(formatRate(12.34), '12.34');
  assert.equal(formatRate(159.68), '159.7');
  assert.equal(formatRate(1512.4), '1512');
});

test('formatChangePercent matches marketplace spacing', () => {
  // The sign hugs the number: six cells wide puts the decimal point under the
  // board's `+/-%` header. A space after the sign pushed it one cell left.
  assert.deepEqual(formatChangePercent(0.2), {
    changeLabel: '+0.20%',
    changePercent: 0.2,
    direction: 'up',
  });
  assert.deepEqual(formatChangePercent(-0.09), {
    changeLabel: '-0.09%',
    changePercent: -0.09,
    direction: 'down',
  });
  assert.equal(formatChangePercent(0).direction, 'flat');
  assert.equal(computeChange(1.1, 1).direction, 'up');
  assert.equal(computeChange(0.9, 1).direction, 'down');
});

test('parseQuotes normalises ISO codes and RMB→CNY', () => {
  assert.deepEqual(parseQuotes('eur, gbp;JPY RMB'), ['EUR', 'GBP', 'JPY', 'CNY']);
  assert.deepEqual(sanitiseSettings({ quotes: [] }).quotes, [...DEFAULT_QUOTES]);
});

test('buildCurrencyRatesPayload includes day-over-day change', () => {
  const payload = buildCurrencyRatesPayload({
    base: 'USD',
    quotes: ['EUR', 'GBP', 'JPY', 'CAD'],
    rates: { EUR: 0.86, GBP: 0.74, JPY: 160, CAD: 1.39 },
    previousRates: { EUR: 0.85, GBP: 0.75, JPY: 160, CAD: 1.4 },
    source: 'open-er-api',
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.base, 'USD');
  assert.equal(payload.quotes.length, 4);
  assert.equal(payload.quotes[0].code, 'EUR');
  assert.ok(payload.quotes[0].rateLabel);
  assert.equal(payload.quotes[0].direction, 'up');
  assert.match(payload.quotes[0].changeLabel, /^\+\d/);
  assert.equal(payload.quotes[1].direction, 'down');
  assert.equal(payload.quotes[2].direction, 'flat');

  const frames = currencyRatesFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'fx.rates');
  assert.equal(frames[0].rows.length, 6);
  assert.match(decodeCodes(frames[0].rows[0]), /USD CONVERSIONS/);
  assert.match(decodeCodes(frames[0].rows[1]), /\$/);
  assert.match(decodeCodes(frames[0].rows[1]), /\+\/-%/);
  assert.match(decodeCodes(frames[0].rows[2]), /EUR/);
  assert.match(decodeCodes(frames[0].rows[2]), /\+/);
  assert.equal(frames[0].rows[2][21], CHIPS.green);
  assert.equal(frames[0].rows[3][21], CHIPS.red);
});

test('currency columns line up: $ over the rates, +/-% over the change', () => {
  // The header used to read `+ / - %` starting five cells left of the numbers
  // it labelled, and the rates started two cells left of the `$`.
  const payload = buildCurrencyRatesPayload({
    base: 'USD',
    quotes: ['AUD', 'GBP', 'ARS', 'BSD'],
    // A five-char rate, a four-digit rate, a bare integer, and a flat quote
    // (no sign) — the alignment has to survive all of them.
    rates: {
      AUD: 1.487, GBP: 0.767, ARS: 1513, BSD: 1,
    },
    previousRates: {
      AUD: 1.4883, GBP: 0.76547, ARS: 1513, BSD: 1,
    },
  });
  const [header, ...body] = currencyRatesFrames(payload)[0].rows.slice(1);
  const headerText = decodeCodes(header);

  assert.equal(headerText.indexOf('$'), 7);
  assert.equal(headerText.indexOf('+/-%'), 17);
  // `%` of the header over `%` of every row.
  assert.equal(headerText.indexOf('%'), 20);

  for (const row of body) {
    const text = decodeCodes(row);
    assert.equal(text[20], '%', `${text.trim()} ends its percent at column 20`);
    // The `+` of the header sits on the decimal point below it.
    assert.equal(text[17], '.', `${text.trim()} puts its point at column 17`);
    // Rates start under the `$` rather than two cells to its left.
    assert.match(text.slice(7, 8), /\d/, `${text.trim()} starts its rate at column 7`);
    assert.equal(text.slice(3, 7).trim(), '', `${text.trim()} leaves the code column clear`);
  }
});

test('currencyRatesFrames page after four quotes', () => {
  const payload = buildCurrencyRatesPayload({
    base: 'USD',
    quotes: DEFAULT_QUOTES,
    rates: Object.fromEntries(DEFAULT_QUOTES.map((code, index) => [code, 1 + index * 0.1])),
  });
  const frames = currencyRatesFrames(payload);
  assert.equal(frames.length, 2);
  assert.match(decodeCodes(frames[0].rows[0]), /USD CONV 1\/2/);
});

test('currencyRatesFrames refuse an empty payload', () => {
  assert.deepEqual(currencyRatesFrames({ type: 'fx.rates' }), []);
  assert.deepEqual(currencyRatesFrames({}), []);
});

test('rate cache rolls previous day for change %', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-cache-'));
  const cache = createRateCache(path.join(dir, 'cache.json'));
  cache.remember('USD', { EUR: 0.85 }, '2026-08-28');
  cache.remember('USD', { EUR: 0.86 }, '2026-08-29');
  const prior = cache.resolvePrevious('USD', '2026-08-29');
  assert.equal(prior.EUR, 0.85);
});

test('createCurrencyRates loads quotes from a free source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-rates-'));
  const api = createCurrencyRates({
    currencyRatesSettingsPath: path.join(dir, 'currency-rates-settings.json'),
    currencyRatesCachePath: path.join(dir, 'currency-rates-cache.json'),
    currencyRatesFetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('open.er-api')) {
        return {
          ok: true,
          async json() {
            return {
              result: 'success',
              base_code: 'USD',
              rates: {
                EUR: 0.86,
                GBP: 0.74,
                JPY: 160,
                CAD: 1.39,
                MXN: 18.5,
                ARS: 1400,
                BSD: 1,
                CNY: 7.2,
              },
            };
          },
        };
      }
      // Historical prior (optional).
      if (href.includes('frankfurter.app/') && !href.includes('/latest')) {
        return {
          ok: true,
          async json() {
            return {
              base: 'USD',
              date: '2026-08-28',
              rates: { EUR: 0.85, GBP: 0.75, JPY: 159, CAD: 1.4 },
            };
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    },
  }, console);
  api.updateSettings({ quotes: 'EUR, GBP, JPY, CAD' });
  const payload = await api.nextPayload({ base: 'USD' });
  assert.equal(payload.type, 'fx.rates');
  assert.equal(payload.quotes.length, 4);
  assert.equal(payload.source, 'open-er-api');
  assert.equal(payload.quotes[0].direction, 'up');
  assert.equal(payload.quotes[1].direction, 'down');
});

test('loadCurrencyRatesPayload falls back when open.er-api fails', async () => {
  let calls = 0;
  const payload = await loadCurrencyRatesPayload({
    base: 'USD',
    settings: { quotes: ['EUR', 'GBP'] },
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('open.er-api')) {
        throw new Error('down');
      }
      if (String(url).includes('frankfurter')) {
        return {
          ok: true,
          async json() {
            return { base: 'USD', date: '2026-08-28', rates: { EUR: 0.85, GBP: 0.73 } };
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(payload.source, 'frankfurter');
  assert.equal(payload.quotes.length, 2);
  assert.ok(calls >= 2);
});
