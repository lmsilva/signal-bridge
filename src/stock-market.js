/**
 * Stock Market — live quotes for a house watchlist.
 * The default list is 10 tickers; there is no cap on how many the house tracks.
 *
 * Quotes come from Yahoo Finance's public chart endpoint (no API key). An
 * optional Finnhub token under Settings can be used instead when configured.
 * Settings live in data/stock-market-settings.json.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');

const TYPE = 'stocks.market';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const FINNHUB_QUOTE = 'https://finnhub.io/api/v1/quote';
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0)';
const DEFAULT_TIMEOUT_MS = 8000;

const DEFAULT_TICKERS = Object.freeze([
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'SPY', 'QQQ', 'DIA',
]);

const CHANGE_WINDOWS = Object.freeze(['hour', 'day', 'week', 'month']);

const DEFAULT_SETTINGS = Object.freeze({
  tickers: [...DEFAULT_TICKERS],
  changeMode: 'percent', // percent | points
  changeWindow: 'week', // hour | day | week | month
  provider: 'auto', // auto | yahoo | finnhub
  finnhubApiKey: '',
});

function sanitiseChangeWindow(value, fallback = 'week') {
  const raw = String(value || '').trim().toLowerCase();
  return CHANGE_WINDOWS.includes(raw) ? raw : (CHANGE_WINDOWS.includes(fallback) ? fallback : 'week');
}

/** Title that fits the 18 flaps between the corner chips. */
function marketWindowTitle(kind, changeWindow, page = 1, pages = 1) {
  const windowId = sanitiseChangeWindow(changeWindow);
  const word = { hour: 'HOURLY', day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY' }[windowId];
  const base = kind === 'crypto' ? 'CRYPTO' : 'STOCKS';
  const single = `${base} ${word}`;
  if (pages <= 1) {
    return single.slice(0, 18);
  }
  const paged = `${single} ${page}/${pages}`;
  if (paged.length <= 18) {
    return paged;
  }
  const short = { hour: 'HR', day: 'DAY', week: 'WK', month: 'MO' }[windowId];
  return `${base} ${short} ${page}/${pages}`.slice(0, 18);
}

function cleanTicker(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^_=-]/g, '')
    .slice(0, 12);
}

function cleanTickers(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const ticker = cleanTicker(raw);
    if (!ticker || seen.has(ticker)) {
      continue;
    }
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

/** Accept an array or comma / space / newline separated string. */
function parseTickers(value) {
  if (Array.isArray(value)) {
    return cleanTickers(value);
  }
  return cleanTickers(String(value || '').split(/[\s,;|]+/));
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const tickers = incoming.tickers != null
    ? parseTickers(incoming.tickers)
    : cleanTickers(base.tickers);
  const changeMode = String(incoming.changeMode != null ? incoming.changeMode : base.changeMode)
    .trim()
    .toLowerCase() === 'points'
    ? 'points'
    : 'percent';
  const changeWindow = sanitiseChangeWindow(
    incoming.changeWindow != null ? incoming.changeWindow : base.changeWindow,
  );
  let provider = String(incoming.provider != null ? incoming.provider : base.provider)
    .trim()
    .toLowerCase();
  if (!['auto', 'yahoo', 'finnhub'].includes(provider)) {
    provider = 'auto';
  }
  const finnhubApiKey = String(
    incoming.finnhubApiKey != null ? incoming.finnhubApiKey : base.finnhubApiKey || '',
  ).trim().slice(0, 128);
  return {
    tickers: tickers.length ? tickers : [...DEFAULT_TICKERS],
    changeMode,
    changeWindow,
    provider,
    finnhubApiKey,
  };
}

function createStockMarketSettings(config = {}, log = console) {
  const settingsPath = config.stockMarketSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'stock-market-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Stock Market settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const serialised = {
        ...current,
        // Never echo a blank overwrite of a stored key from a partial form miss
        finnhubApiKey: current.finnhubApiKey,
      };
      fs.writeFileSync(settingsPath, `${JSON.stringify(serialised, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Stock Market settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current, tickers: [...current.tickers] }),
    update(patch = {}) {
      const next = { ...current, ...patch };
      // Empty string from the form means "leave the stored key alone".
      if (Object.prototype.hasOwnProperty.call(patch, 'finnhubApiKey')
        && String(patch.finnhubApiKey || '').trim() === ''
        && current.finnhubApiKey) {
        next.finnhubApiKey = current.finnhubApiKey;
      }
      if (patch.clearFinnhubApiKey) {
        next.finnhubApiKey = '';
      }
      current = sanitiseSettings(next, current);
      save();
      return this.get();
    },
    reset() {
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  const abs = Math.abs(number);
  if (abs >= 10000) {
    return String(Math.round(number));
  }
  if (abs >= 1000) {
    return number.toFixed(1).replace(/\.0$/, '');
  }
  return number.toFixed(2);
}

function formatChange(change, percent, mode = 'percent') {
  if (mode === 'points') {
    if (!Number.isFinite(Number(change))) {
      return '';
    }
    const value = Number(change);
    const body = formatPrice(Math.abs(value));
    if (!body) {
      return '';
    }
    return `${value >= 0 ? '+' : '-'}${body}`;
  }
  if (!Number.isFinite(Number(percent))) {
    return '';
  }
  const value = Number(percent);
  const body = Math.abs(value).toFixed(1).replace(/\.0$/, '');
  return `${value >= 0 ? '+' : '-'}${body}%`;
}

function boardSymbol(symbol) {
  return fold(String(symbol || '').replace(/^\^/, '')).slice(0, 5);
}

async function fetchText(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  headers = {},
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

const YAHOO_WINDOW = Object.freeze({
  hour: { range: '1d', interval: '5m', ms: 60 * 60 * 1000 },
  day: { range: '5d', interval: '1d', ms: 0 },
  week: { range: '1mo', interval: '1d', ms: 7 * 24 * 60 * 60 * 1000 },
  month: { range: '3mo', interval: '1d', ms: 30 * 24 * 60 * 60 * 1000 },
});

function closeAtOrBefore(result, targetSec) {
  const stamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  let chosen = null;
  for (let i = 0; i < stamps.length; i += 1) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close)) {
      continue;
    }
    if (Number(stamps[i]) <= targetSec) {
      chosen = close;
    }
  }
  return chosen;
}

async function fetchYahooQuote(symbol, { fetchImpl, timeoutMs, changeWindow = 'week' } = {}) {
  const windowId = sanitiseChangeWindow(changeWindow);
  const spec = YAHOO_WINDOW[windowId];
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${spec.interval}&range=${spec.range}`;
  const response = await fetchText(url, { fetchImpl, timeoutMs });
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || !Number.isFinite(Number(meta.regularMarketPrice))) {
    throw new Error(`Yahoo has no quote for ${symbol}`);
  }
  const price = Number(meta.regularMarketPrice);
  let previous = null;
  if (windowId === 'day') {
    previous = Number(meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose);
  } else {
    const nowSec = Number(meta.regularMarketTime) || Math.floor(Date.now() / 1000);
    previous = closeAtOrBefore(result, nowSec - Math.floor(spec.ms / 1000));
  }
  const change = Number.isFinite(previous) ? price - previous : null;
  const percent = Number.isFinite(previous) && previous !== 0
    ? (change / previous) * 100
    : null;
  return {
    symbol: cleanTicker(meta.symbol || symbol),
    price,
    previous: Number.isFinite(previous) ? previous : null,
    change,
    percent,
    currency: String(meta.currency || 'USD'),
    source: 'yahoo',
    changeWindow: windowId,
  };
}

async function fetchFinnhubQuote(symbol, apiKey, { fetchImpl, timeoutMs } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new Error('Finnhub API key is not set');
  }
  const url = `${FINNHUB_QUOTE}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
  const response = await fetchText(url, { fetchImpl, timeoutMs });
  const data = await response.json();
  const price = Number(data?.c);
  const previous = Number(data?.pc);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Finnhub has no quote for ${symbol}`);
  }
  const change = Number.isFinite(previous) ? price - previous : Number(data?.d);
  const percent = Number.isFinite(Number(data?.dp))
    ? Number(data.dp)
    : (Number.isFinite(previous) && previous !== 0 ? (change / previous) * 100 : null);
  return {
    symbol: cleanTicker(symbol),
    price,
    previous: Number.isFinite(previous) ? previous : null,
    change: Number.isFinite(change) ? change : null,
    percent,
    currency: 'USD',
    source: 'finnhub',
  };
}

async function fetchQuote(symbol, settings = DEFAULT_SETTINGS, options = {}) {
  const windowId = sanitiseChangeWindow(settings.changeWindow);
  // Finnhub's quote is the session change. Hour, week, and month come from
  // Yahoo's chart so the number matches the window on the title.
  if (windowId !== 'day') {
    return fetchYahooQuote(symbol, { ...options, changeWindow: windowId });
  }
  const provider = settings.provider || 'auto';
  const preferFinnhub = provider === 'finnhub'
    || (provider === 'auto' && settings.finnhubApiKey);
  const errors = [];

  if (preferFinnhub && settings.finnhubApiKey) {
    try {
      return await fetchFinnhubQuote(symbol, settings.finnhubApiKey, options);
    } catch (error) {
      errors.push(error?.message || String(error));
      if (provider === 'finnhub') {
        throw error;
      }
    }
  }

  if (provider !== 'finnhub') {
    try {
      return await fetchYahooQuote(symbol, { ...options, changeWindow: 'day' });
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  if (settings.finnhubApiKey && !preferFinnhub) {
    try {
      return await fetchFinnhubQuote(symbol, settings.finnhubApiKey, options);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  throw new Error(errors[0] || `No quote for ${symbol}`);
}

function quoteForBoard(quote, { changeMode = 'percent' } = {}) {
  const symbol = boardSymbol(quote.symbol);
  const price = formatPrice(quote.price);
  const change = formatChange(quote.change, quote.percent, changeMode);
  const direction = Number(quote.change) > 0 || Number(quote.percent) > 0
    ? 'up'
    : (Number(quote.change) < 0 || Number(quote.percent) < 0 ? 'down' : 'flat');
  return {
    symbol: quote.symbol,
    boardSymbol: symbol,
    price: quote.price,
    previous: quote.previous,
    change: quote.change,
    percent: quote.percent,
    priceLabel: price,
    changeLabel: change,
    direction,
    currency: quote.currency || 'USD',
    source: quote.source || '',
  };
}

function buildStockMarketPayload({
  quotes = [],
  settings = DEFAULT_SETTINGS,
  asOf,
  errors = [],
} = {}) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const rows = quotes
    .filter((quote) => quote && Number.isFinite(Number(quote.price)))
    .map((quote) => quoteForBoard(quote, { changeMode: cfg.changeMode }));
  if (!rows.length) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    settings: {
      tickers: cfg.tickers,
      changeMode: cfg.changeMode,
      changeWindow: cfg.changeWindow,
      provider: cfg.provider,
      hasFinnhubKey: Boolean(cfg.finnhubApiKey),
    },
    quotes: rows,
    errors: errors.slice(0, 10),
  };
}

async function loadStockMarketPayload({
  settings = DEFAULT_SETTINGS,
  fetchImpl,
  timeoutMs,
} = {}) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const quotes = [];
  const errors = [];
  for (const ticker of cfg.tickers) {
    try {
      // Sequential keeps Yahoo happier than a burst of 10.
      // eslint-disable-next-line no-await-in-loop
      const quote = await fetchQuote(ticker, cfg, { fetchImpl, timeoutMs });
      quotes.push(quote);
    } catch (error) {
      errors.push(`${ticker}: ${error?.message || error}`);
    }
  }
  return buildStockMarketPayload({ quotes, settings: cfg, errors });
}

function createStockMarket(config = {}, log = console) {
  const settingsApi = createStockMarketSettings(config, log);
  const defaultFetch = typeof config.stockMarketFetchImpl === 'function'
    ? config.stockMarketFetchImpl
    : fetch;

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot() {
      const settings = settingsApi.get();
      return {
        settings: {
          ...settings,
          finnhubApiKey: settings.finnhubApiKey ? '••••••••' : '',
          hasFinnhubKey: Boolean(settings.finnhubApiKey),
        },
        tickerCount: settings.tickers.length,
        defaults: {
          tickers: [...DEFAULT_TICKERS],
          changeMode: DEFAULT_SETTINGS.changeMode,
          changeWindow: DEFAULT_SETTINGS.changeWindow,
          provider: DEFAULT_SETTINGS.provider,
        },
        providers: ['auto', 'yahoo', 'finnhub'],
      };
    },
    async nextPayload(options = {}) {
      return loadStockMarketPayload({
        settings: settingsApi.get(),
        fetchImpl: options.fetchImpl || defaultFetch,
        timeoutMs: options.timeoutMs,
      });
    },
  };
}

module.exports = {
  TYPE,
  DEFAULT_TICKERS,
  DEFAULT_SETTINGS,
  cleanTicker,
  parseTickers,
  sanitiseSettings,
  CHANGE_WINDOWS,
  sanitiseChangeWindow,
  marketWindowTitle,
  formatPrice,
  formatChange,
  closeAtOrBefore,
  boardSymbol,
  quoteForBoard,
  fetchYahooQuote,
  fetchFinnhubQuote,
  fetchQuote,
  buildStockMarketPayload,
  loadStockMarketPayload,
  createStockMarketSettings,
  createStockMarket,
};
