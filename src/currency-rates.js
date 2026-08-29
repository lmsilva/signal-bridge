/**
 * World Currency Rates — live FX for a house watchlist against the locale base.
 *
 * Free sources (no API key): open.er-api.com first, then Frankfurter (ECB),
 * then the fawazahmed0 CDN mirror. Base currency lives on locale settings;
 * which quotes to show live in data/currency-rates-settings.json.
 *
 * Day-over-day % change uses a local rate cache when available, otherwise a
 * Frankfurter historical snapshot for the previous business day. Green/red
 * direction chips on the Vestaboard follow that change.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');

const TYPE = 'fx.rates';
const MAX_QUOTES = 12;
const PER_PAGE = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0)';
const DEFAULT_TIMEOUT_MS = 8000;

const OPEN_ER_URL = 'https://open.er-api.com/v6/latest';
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest';
const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const FAWAZ_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies';

/** Marketplace-style defaults: USD → the currencies you asked for. */
const DEFAULT_QUOTES = Object.freeze([
  'EUR', 'GBP', 'JPY', 'CAD', 'MXN', 'ARS', 'BSD', 'CNY',
]);

const CURRENCY_NAMES = Object.freeze({
  USD: 'US DOLLAR',
  EUR: 'EURO',
  GBP: 'POUND',
  JPY: 'YEN',
  CAD: 'CANADIAN',
  MXN: 'MEXICO',
  ARS: 'ARGENTINA',
  BSD: 'BAHAMAS',
  CNY: 'YUAN',
  RMB: 'YUAN',
  AUD: 'AUSTRALIAN',
  CHF: 'FRANC',
  INR: 'RUPEE',
  BRL: 'REAL',
  KRW: 'WON',
  HKD: 'HK DOLLAR',
  SGD: 'SINGAPORE',
  NZD: 'NZ DOLLAR',
  SEK: 'KRONA',
  NOK: 'KRONE',
  DKK: 'KRONE',
  PLN: 'ZLOTY',
  TRY: 'LIRA',
  ZAR: 'RAND',
  AED: 'DIRHAM',
});

function cleanCode(value) {
  let code = String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  if (code === 'RMB') {
    code = 'CNY';
  }
  return code;
}

function cleanQuotes(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const code = cleanCode(raw);
    if (!code || seen.has(code)) {
      continue;
    }
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_QUOTES) {
      break;
    }
  }
  return out;
}

function parseQuotes(value) {
  if (Array.isArray(value)) {
    return cleanQuotes(value);
  }
  return cleanQuotes(String(value || '').split(/[\s,;|/]+/));
}

function sanitiseSettings(raw = {}, base = { quotes: DEFAULT_QUOTES }) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const quotes = incoming.quotes != null
    ? parseQuotes(incoming.quotes)
    : cleanQuotes(base.quotes || DEFAULT_QUOTES);
  return {
    quotes: quotes.length ? quotes : [...DEFAULT_QUOTES],
  };
}

function createCurrencyRatesSettings(config = {}, log = console) {
  const settingsPath = config.currencyRatesSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'currency-rates-settings.json');
  let current = sanitiseSettings({}, { quotes: DEFAULT_QUOTES });

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, { quotes: DEFAULT_QUOTES });
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), current);
    } catch (error) {
      log?.warn?.('Could not read Currency Rates settings', error?.message || error);
      current = sanitiseSettings({}, { quotes: DEFAULT_QUOTES });
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Currency Rates settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ quotes: [...current.quotes] }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    reset() {
      current = sanitiseSettings({}, { quotes: DEFAULT_QUOTES });
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

function calendarDate(value = new Date()) {
  if (typeof value === 'string') {
    const isoDay = value.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) {
      return isoDay;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  const date = value instanceof Date ? value : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function previousBusinessDate(from = new Date()) {
  const date = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (Number.isNaN(date.getTime())) {
    return previousBusinessDate(new Date());
  }
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return '';
  }
  if (number >= 1000) {
    return number.toFixed(0);
  }
  if (number >= 100) {
    return number.toFixed(1).replace(/\.0$/, '');
  }
  if (number >= 10) {
    return number.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
  }
  if (number >= 1) {
    return number.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  return number.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Marketplace mock style: "+0.20%" / "-0.09%". The sign hugs the number so the
 * label is six cells wide, which lands the decimal point under the board's
 * `+/-%` header (see fxQuoteRow).
 */
function formatChangePercent(percent) {
  if (!Number.isFinite(Number(percent))) {
    return { changeLabel: '', changePercent: null, direction: 'flat' };
  }
  const value = Number(percent);
  const direction = value > 0.005 ? 'up' : value < -0.005 ? 'down' : 'flat';
  const abs = Math.abs(value);
  const body = abs >= 10
    ? abs.toFixed(1).replace(/\.0$/, '')
    : abs.toFixed(2);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const changeLabel = `${sign}${body}%`;
  return { changeLabel, changePercent: value, direction };
}

function computeChange(current, previous) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) {
    return formatChangePercent(null);
  }
  return formatChangePercent(((cur - prev) / prev) * 100);
}

function currencyLabel(code) {
  const key = cleanCode(code);
  return CURRENCY_NAMES[key] || key;
}

function createRateCache(cachePath, log = console) {
  function empty() {
    return { base: '', current: null, previous: null };
  }

  function read() {
    try {
      if (!fs.existsSync(cachePath)) {
        return empty();
      }
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      return {
        base: cleanCode(raw.base) || '',
        current: raw.current && typeof raw.current === 'object' ? raw.current : null,
        previous: raw.previous && typeof raw.previous === 'object' ? raw.previous : null,
      };
    } catch (error) {
      log?.warn?.('Could not read FX rate cache', error?.message || error);
      return empty();
    }
  }

  function write(state) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save FX rate cache', error?.message || error);
    }
  }

  function snapshotRates(rates = {}) {
    const out = {};
    for (const [code, value] of Object.entries(rates || {})) {
      const key = cleanCode(code);
      const number = Number(value);
      if (key && Number.isFinite(number) && number > 0) {
        out[key] = number;
      }
    }
    return out;
  }

  /**
   * Resolve the rates to compare against for day-over-day change.
   */
  function resolvePrevious(base, today = calendarDate()) {
    const state = read();
    if (cleanCode(base) !== state.base) {
      return null;
    }
    if (state.previous?.rates && typeof state.previous.rates === 'object') {
      return snapshotRates(state.previous.rates);
    }
    if (
      state.current?.rates
      && state.current.date
      && state.current.date !== today
    ) {
      return snapshotRates(state.current.rates);
    }
    return null;
  }

  /**
   * Persist today's rates. When the calendar day rolls, the prior "current"
   * becomes "previous". Optionally seed previous from a historical fetch.
   */
  function remember(base, rates, date, { seedPrevious } = {}) {
    const today = calendarDate(date);
    const baseCode = cleanCode(base) || 'USD';
    const state = read();
    const next = {
      base: baseCode,
      current: {
        date: today,
        rates: snapshotRates(rates),
        asOf: new Date().toISOString(),
      },
      previous: null,
    };

    if (state.base === baseCode && state.current?.date && state.current.date !== today) {
      next.previous = state.current;
    } else if (state.base === baseCode && state.previous?.rates) {
      next.previous = state.previous;
    }

    if (!next.previous && seedPrevious && typeof seedPrevious === 'object') {
      next.previous = {
        date: previousBusinessDate(`${today}T12:00:00Z`),
        rates: snapshotRates(seedPrevious),
        asOf: new Date().toISOString(),
      };
    }

    write(next);
    return next;
  }

  return {
    path: cachePath,
    read,
    write,
    resolvePrevious,
    remember,
  };
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenErRates(base, { fetchImpl, timeoutMs } = {}) {
  const data = await fetchJson(`${OPEN_ER_URL}/${encodeURIComponent(base)}`, {
    fetchImpl,
    timeoutMs,
  });
  if (data?.result !== 'success' || !data?.rates) {
    throw new Error('open.er-api returned no rates');
  }
  return {
    base: cleanCode(data.base_code || base),
    date: data.time_last_update_utc || data.date || '',
    rates: data.rates,
    source: 'open-er-api',
  };
}

async function fetchFrankfurterRates(base, quotes, { fetchImpl, timeoutMs } = {}) {
  const want = quotes.filter((code) => code !== base);
  const url = `${FRANKFURTER_URL}?from=${encodeURIComponent(base)}`
    + (want.length ? `&to=${encodeURIComponent(want.join(','))}` : '');
  const data = await fetchJson(url, { fetchImpl, timeoutMs });
  if (!data?.rates) {
    throw new Error('Frankfurter returned no rates');
  }
  return {
    base: cleanCode(data.base || base),
    date: data.date || '',
    rates: data.rates,
    source: 'frankfurter',
  };
}

async function fetchFrankfurterRatesOnDate(base, quotes, date, { fetchImpl, timeoutMs } = {}) {
  const day = calendarDate(date);
  const want = quotes.filter((code) => code !== base);
  const url = `${FRANKFURTER_BASE}/${encodeURIComponent(day)}?from=${encodeURIComponent(base)}`
    + (want.length ? `&to=${encodeURIComponent(want.join(','))}` : '');
  const data = await fetchJson(url, { fetchImpl, timeoutMs });
  if (!data?.rates) {
    throw new Error('Frankfurter historical returned no rates');
  }
  return {
    base: cleanCode(data.base || base),
    date: data.date || day,
    rates: data.rates,
    source: 'frankfurter-historical',
  };
}

async function fetchFawazRates(base, { fetchImpl, timeoutMs } = {}) {
  const key = cleanCode(base).toLowerCase();
  const data = await fetchJson(`${FAWAZ_URL}/${encodeURIComponent(key)}.min.json`, {
    fetchImpl,
    timeoutMs,
  });
  const rates = data?.[key];
  if (!rates || typeof rates !== 'object') {
    throw new Error('fawaz currency API returned no rates');
  }
  const upper = {};
  for (const [code, value] of Object.entries(rates)) {
    upper[cleanCode(code)] = Number(value);
  }
  return {
    base: cleanCode(base),
    date: data.date || '',
    rates: upper,
    source: 'fawaz',
  };
}

async function fetchRates(base, quotes, options = {}) {
  const errors = [];
  try {
    return await fetchOpenErRates(base, options);
  } catch (error) {
    errors.push(`open-er-api: ${error?.message || error}`);
  }
  try {
    return await fetchFrankfurterRates(base, quotes, options);
  } catch (error) {
    errors.push(`frankfurter: ${error?.message || error}`);
  }
  try {
    return await fetchFawazRates(base, options);
  } catch (error) {
    errors.push(`fawaz: ${error?.message || error}`);
  }
  const err = new Error(errors.join('; ') || 'Currency rates unavailable');
  err.details = errors;
  throw err;
}

function buildCurrencyRatesPayload({
  base = 'USD',
  quotes = DEFAULT_QUOTES,
  rates = {},
  previousRates = null,
  asOf,
  source = '',
  date = '',
} = {}) {
  const baseCode = cleanCode(base) || 'USD';
  const wanted = cleanQuotes(quotes).filter((code) => code !== baseCode);
  const prior = previousRates && typeof previousRates === 'object' ? previousRates : null;
  const rows = [];
  for (const code of wanted) {
    const rate = Number(rates[code]);
    if (!Number.isFinite(rate) || rate <= 0) {
      continue;
    }
    const change = computeChange(rate, prior?.[code]);
    const previousRate = Number(prior?.[code]);
    rows.push({
      code,
      name: currencyLabel(code),
      rate,
      rateLabel: formatRate(rate),
      previousRate: Number.isFinite(previousRate) && previousRate > 0 ? previousRate : null,
      changePercent: change.changePercent,
      changeLabel: change.changeLabel,
      direction: change.direction,
    });
  }
  if (!rows.length) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    base: baseCode,
    baseName: currencyLabel(baseCode),
    date: String(date || '').slice(0, 40),
    source,
    quotes: rows,
  };
}

async function resolvePreviousRates({
  base,
  quotes,
  rateCache = null,
  fetchImpl,
  timeoutMs,
  previousRates = null,
} = {}) {
  if (previousRates && typeof previousRates === 'object') {
    return previousRates;
  }
  const today = calendarDate();
  if (rateCache) {
    const cached = rateCache.resolvePrevious(base, today);
    if (cached) {
      return cached;
    }
  }
  try {
    const hist = await fetchFrankfurterRatesOnDate(
      base,
      quotes,
      previousBusinessDate(),
      { fetchImpl, timeoutMs },
    );
    return hist.rates;
  } catch (_error) {
    return null;
  }
}

async function loadCurrencyRatesPayload({
  base = 'USD',
  settings = { quotes: DEFAULT_QUOTES },
  fetchImpl,
  timeoutMs,
  previousRates = null,
  rateCache = null,
} = {}) {
  const cfg = sanitiseSettings(settings, { quotes: DEFAULT_QUOTES });
  const baseCode = cleanCode(base) || 'USD';
  const bundle = await fetchRates(baseCode, cfg.quotes, { fetchImpl, timeoutMs });
  const prior = await resolvePreviousRates({
    base: baseCode,
    quotes: cfg.quotes,
    rateCache,
    fetchImpl,
    timeoutMs,
    previousRates,
  });
  const payload = buildCurrencyRatesPayload({
    base: baseCode,
    quotes: cfg.quotes,
    rates: bundle.rates,
    previousRates: prior,
    source: bundle.source,
    date: bundle.date,
  });
  if (rateCache && payload) {
    rateCache.remember(baseCode, bundle.rates, calendarDate(bundle.date) || calendarDate(), {
      seedPrevious: prior,
    });
  }
  return payload;
}

function createCurrencyRates(config = {}, log = console) {
  const settingsApi = createCurrencyRatesSettings(config, log);
  const cachePath = config.currencyRatesCachePath
    || path.resolve(
      path.dirname(settingsApi.path),
      'currency-rates-cache.json',
    );
  const rateCache = createRateCache(cachePath, log);
  const defaultFetch = typeof config.currencyRatesFetchImpl === 'function'
    ? config.currencyRatesFetchImpl
    : fetch;

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot(locale = {}) {
      const settings = settingsApi.get();
      return {
        settings,
        quoteCount: settings.quotes.length,
        baseCurrency: cleanCode(locale.currencyCode) || 'USD',
        defaults: { quotes: [...DEFAULT_QUOTES] },
        maxQuotes: MAX_QUOTES,
        perPage: PER_PAGE,
        names: CURRENCY_NAMES,
      };
    },
    async nextPayload({ base, fetchImpl, timeoutMs } = {}) {
      return loadCurrencyRatesPayload({
        base: base || 'USD',
        settings: settingsApi.get(),
        fetchImpl: fetchImpl || defaultFetch,
        timeoutMs,
        rateCache,
      });
    },
  };
}

module.exports = {
  TYPE,
  MAX_QUOTES,
  PER_PAGE,
  DEFAULT_QUOTES,
  CURRENCY_NAMES,
  cleanCode,
  parseQuotes,
  sanitiseSettings,
  calendarDate,
  previousBusinessDate,
  formatRate,
  formatChangePercent,
  computeChange,
  currencyLabel,
  fetchOpenErRates,
  fetchFrankfurterRates,
  fetchFrankfurterRatesOnDate,
  fetchFawazRates,
  fetchRates,
  buildCurrencyRatesPayload,
  loadCurrencyRatesPayload,
  createRateCache,
  createCurrencyRatesSettings,
  createCurrencyRates,
};
