/**
 * Crypto Market — live USD quotes for a house watchlist.
 *
 * Prices come from CoinGecko's public markets endpoint (no API key): one
 * request covers the largest coins, and the watchlist is matched by symbol.
 * The default list is the ten largest by market cap as of 2026-09-23, skipping
 * tokenized products that are not a coin (Figure HELOC). Settings live in
 * data/crypto-market-settings.json. There is no cap on how many the house tracks.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');
const { formatChange } = require('./stock-market');

const TYPE = 'crypto.market';
const MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets';
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0)';
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_MS = 60 * 1000;
const PAGE_SIZE = 250;

const DEFAULT_SYMBOLS = Object.freeze([
  'BTC', 'ETH', 'USDT', 'BNB', 'XRP', 'USDC', 'SOL', 'TRX', 'ZEC', 'HYPE',
]);

const DEFAULT_SETTINGS = Object.freeze({
  symbols: [...DEFAULT_SYMBOLS],
  changeMode: 'percent', // percent | points — 24h move
});

function cleanSymbol(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

function cleanSymbols(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const symbol = cleanSymbol(raw);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

function parseSymbols(value) {
  if (Array.isArray(value)) {
    return cleanSymbols(value);
  }
  return cleanSymbols(String(value || '').split(/[\s,;|]+/));
}

function sanitiseSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const symbols = incoming.symbols != null
    ? parseSymbols(incoming.symbols)
    : cleanSymbols(base.symbols);
  const changeMode = String(incoming.changeMode != null ? incoming.changeMode : base.changeMode)
    .trim()
    .toLowerCase() === 'points'
    ? 'points'
    : 'percent';
  return {
    symbols: symbols.length ? symbols : [...DEFAULT_SYMBOLS],
    changeMode,
  };
}

function createCryptoMarketSettings(config = {}, log = console) {
  const settingsPath = config.cryptoMarketSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'crypto-market-settings.json');
  let current = sanitiseSettings({}, DEFAULT_SETTINGS);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, DEFAULT_SETTINGS);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), DEFAULT_SETTINGS);
    } catch (error) {
      log?.warn?.('Could not read Crypto Market settings', error?.message || error);
      current = sanitiseSettings({}, DEFAULT_SETTINGS);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Crypto Market settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current, symbols: [...current.symbols] }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
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

function formatCryptoPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  const abs = Math.abs(number);
  let text;
  if (abs >= 10000) {
    text = String(Math.round(number));
  } else if (abs >= 100) {
    text = number.toFixed(1).replace(/\.0$/, '');
  } else if (abs >= 1) {
    text = number.toFixed(2);
  } else if (abs >= 0.0001) {
    text = number.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  } else {
    text = number.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }
  return text.slice(0, 10);
}

function boardSymbol(symbol) {
  return fold(cleanSymbol(symbol)).slice(0, 5);
}

async function fetchMarketsPage(page, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const url = `${MARKETS_URL}?vs_currency=usd&order=market_cap_desc&per_page=${PAGE_SIZE}&page=${page}&sparkline=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (response.status === 429) {
      throw new Error('CoinGecko rate limit — try again in a minute');
    }
    if (!response.ok) {
      throw new Error(`CoinGecko HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

function indexBySymbol(rows, into = new Map()) {
  for (const row of rows) {
    const symbol = cleanSymbol(row?.symbol);
    if (!symbol || into.has(symbol)) {
      continue;
    }
    into.set(symbol, row);
  }
  return into;
}

function quoteFromRow(row) {
  const price = Number(row?.current_price);
  if (!Number.isFinite(price)) {
    return null;
  }
  const change = Number(row?.price_change_24h);
  const percent = Number(row?.price_change_percentage_24h);
  return {
    symbol: cleanSymbol(row.symbol),
    name: String(row.name || ''),
    rank: Number(row.market_cap_rank) || null,
    price,
    change: Number.isFinite(change) ? change : null,
    percent: Number.isFinite(percent) ? percent : null,
    currency: 'USD',
    source: 'coingecko',
  };
}

function quoteForBoard(quote, { changeMode = 'percent' } = {}) {
  const price = formatCryptoPrice(quote.price);
  const change = changeMode === 'points'
    ? (Number.isFinite(Number(quote.change))
      ? `${Number(quote.change) >= 0 ? '+' : '-'}${formatCryptoPrice(Math.abs(quote.change))}`
      : '')
    : formatChange(quote.change, quote.percent, 'percent');
  const direction = Number(quote.change) > 0 || Number(quote.percent) > 0
    ? 'up'
    : (Number(quote.change) < 0 || Number(quote.percent) < 0 ? 'down' : 'flat');
  return {
    symbol: quote.symbol,
    boardSymbol: boardSymbol(quote.symbol),
    name: quote.name || '',
    rank: quote.rank,
    price: quote.price,
    change: quote.change,
    percent: quote.percent,
    priceLabel: price,
    changeLabel: change,
    direction,
    currency: 'USD',
    source: quote.source || 'coingecko',
  };
}

function buildCryptoMarketPayload({
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
      symbols: cfg.symbols,
      changeMode: cfg.changeMode,
    },
    quotes: rows,
    errors: errors.slice(0, 20),
  };
}

async function loadCryptoMarketPayload({
  settings = DEFAULT_SETTINGS,
  fetchImpl,
  timeoutMs,
  cache,
} = {}) {
  const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
  const now = Date.now();
  let index = cache?.index;
  if (!index || !cache.at || now - cache.at > CACHE_MS) {
    const page1 = await fetchMarketsPage(1, { fetchImpl, timeoutMs });
    index = indexBySymbol(page1);
    if (cache) {
      cache.index = index;
      cache.at = now;
      cache.pages = 1;
    }
  }

  const missing = cfg.symbols.filter((symbol) => !index.has(symbol));
  if (missing.length && (!cache || cache.pages < 2)) {
    const page2 = await fetchMarketsPage(2, { fetchImpl, timeoutMs });
    indexBySymbol(page2, index);
    if (cache) {
      cache.pages = 2;
      cache.at = now;
    }
  }

  const quotes = [];
  const errors = [];
  for (const symbol of cfg.symbols) {
    const row = index.get(symbol);
    const quote = row ? quoteFromRow(row) : null;
    if (!quote) {
      errors.push(`${symbol}: not in the CoinGecko top ${PAGE_SIZE * 2}`);
      continue;
    }
    quotes.push(quote);
  }
  return buildCryptoMarketPayload({ quotes, settings: cfg, errors });
}

function createCryptoMarket(config = {}, log = console) {
  const settingsApi = createCryptoMarketSettings(config, log);
  const defaultFetch = typeof config.cryptoMarketFetchImpl === 'function'
    ? config.cryptoMarketFetchImpl
    : fetch;
  const cache = { index: null, at: 0, pages: 0 };

  return {
    getSettings: () => settingsApi.get(),
    updateSettings: (patch) => settingsApi.update(patch),
    resetSettings: () => settingsApi.reset(),
    statusSnapshot() {
      const settings = settingsApi.get();
      return {
        settings,
        symbolCount: settings.symbols.length,
        defaults: {
          symbols: [...DEFAULT_SYMBOLS],
          changeMode: DEFAULT_SETTINGS.changeMode,
        },
        source: 'CoinGecko',
      };
    },
    async nextPayload(options = {}) {
      return loadCryptoMarketPayload({
        settings: settingsApi.get(),
        fetchImpl: options.fetchImpl || defaultFetch,
        timeoutMs: options.timeoutMs,
        cache,
      });
    },
  };
}

module.exports = {
  TYPE,
  DEFAULT_SYMBOLS,
  DEFAULT_SETTINGS,
  cleanSymbol,
  parseSymbols,
  sanitiseSettings,
  formatCryptoPrice,
  boardSymbol,
  quoteForBoard,
  buildCryptoMarketPayload,
  loadCryptoMarketPayload,
  createCryptoMarketSettings,
  createCryptoMarket,
};
