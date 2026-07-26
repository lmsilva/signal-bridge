const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CACHE_DAYS = 7;
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024; // raw (decoded) image bytes
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const ROUTE_PREFIX = '/qr-images/';

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const DATA_URL_RE = /^data:([\w+.-]+\/[\w+.-]+);base64,(.+)$/s;

/** Parses a `data:image/...;base64,...` string into `{mimeType, ext, buffer}`, or null if invalid/unsupported. */
function parseDataUrl(dataUrl) {
  const match = DATA_URL_RE.exec(String(dataUrl || '').trim());
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  const ext = MIME_EXT[mimeType];
  if (!ext) {
    return null;
  }
  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
  if (!buffer.length) {
    return null;
  }
  return { mimeType, ext, buffer };
}

function loadIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveIndex(indexPath, index) {
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/**
 * Stores photos uploaded through the "QR code → embedded photo" flow so they
 * can be served back from a short-lived, unguessable URL embedded in the QR
 * code. Images live under `config.qrImage.cacheDir` (default
 * `data/qr-image-cache/`) and expire after `config.qrImage.cacheDays`
 * (default 7) — once expired the URL 404s permanently (until re-uploaded).
 */
function createQrImageCache(config = {}, log = console) {
  const cacheDays = Number(config?.qrImage?.cacheDays) > 0
    ? Number(config.qrImage.cacheDays)
    : DEFAULT_CACHE_DAYS;
  const maxBytes = Number(config?.qrImage?.maxBytes) > 0
    ? Number(config.qrImage.maxBytes)
    : DEFAULT_MAX_BYTES;
  const sweepIntervalMs = Number(config?.qrImage?.sweepIntervalMs) > 0
    ? Number(config.qrImage.sweepIntervalMs)
    : DEFAULT_SWEEP_INTERVAL_MS;
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.qrImageCacheDir
    || path.resolve(root, config?.qrImage?.cacheDir || 'data/qr-image-cache');
  const indexPath = path.join(cacheDir, 'index.json');

  let sweepTimer = null;

  function ensureDir() {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  function removeEntry(index, token) {
    const entry = index[token];
    if (entry) {
      try {
        fs.unlinkSync(path.join(cacheDir, entry.fileName));
      } catch {
        // already gone
      }
    }
    delete index[token];
    saveIndex(indexPath, index);
  }

  function store(dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) {
      return {
        ok: false,
        error: 'Image must be a JPEG, PNG, or WebP photo',
      };
    }
    if (parsed.buffer.length > maxBytes) {
      return {
        ok: false,
        error: `Photo is too large (max ${Math.round(maxBytes / (1024 * 1024))}MB) — try a smaller photo`,
      };
    }

    ensureDir();
    const token = crypto.randomBytes(16).toString('hex');
    const fileName = `${token}${parsed.ext}`;
    fs.writeFileSync(path.join(cacheDir, fileName), parsed.buffer);

    const now = Date.now();
    const expiresAt = new Date(now + cacheDays * 24 * 60 * 60 * 1000).toISOString();
    const index = loadIndex(indexPath);
    index[token] = {
      fileName,
      mimeType: parsed.mimeType,
      createdAt: new Date(now).toISOString(),
      expiresAt,
    };
    saveIndex(indexPath, index);

    return {
      ok: true,
      token,
      path: `${ROUTE_PREFIX}${fileName}`,
      expiresAt,
    };
  }

  /** `routeTail` is the URL segment after ROUTE_PREFIX, e.g. `"<token>.jpg"`. */
  function get(routeTail) {
    const fileName = String(routeTail || '').replace(/^\/+/, '');
    const token = fileName.replace(/\.[^./]+$/, '');
    if (!fileName || !token) {
      return null;
    }
    const index = loadIndex(indexPath);
    const entry = index[token];
    if (!entry || entry.fileName !== fileName) {
      return null;
    }
    if (Date.parse(entry.expiresAt) <= Date.now()) {
      // Invalidate immediately on first access past expiry — don't wait for
      // the hourly sweep to make the URL start 404ing.
      removeEntry(index, token);
      return null;
    }
    const filePath = path.join(cacheDir, entry.fileName);
    if (!fs.existsSync(filePath)) {
      removeEntry(index, token);
      return null;
    }
    return { filePath, mimeType: entry.mimeType, expiresAt: entry.expiresAt };
  }

  /**
   * Non-expired photos currently in the cache, newest first — this is the
   * "pictures shared in the last `cacheDays` days" pool used by the Shared
   * Photo Slideshow push tile. Anything uploaded through the QR "Photo" mode
   * lands here automatically until it expires (or is swept).
   */
  function list() {
    const index = loadIndex(indexPath);
    const now = Date.now();
    return Object.values(index)
      .filter((entry) => Date.parse(entry.expiresAt) > now)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((entry) => ({
        path: `${ROUTE_PREFIX}${entry.fileName}`,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      }));
  }

  function sweep() {
    const index = loadIndex(indexPath);
    const now = Date.now();
    const removed = [];
    for (const [token, entry] of Object.entries(index)) {
      if (Date.parse(entry.expiresAt) <= now) {
        try {
          fs.unlinkSync(path.join(cacheDir, entry.fileName));
        } catch {
          // already gone
        }
        delete index[token];
        removed.push(token);
      }
    }
    if (removed.length) {
      saveIndex(indexPath, index);
      log?.info?.(`QR image cache sweep removed ${removed.length} expired photo(s)`);
    }
    return removed;
  }

  function startSweeper() {
    stopSweeper();
    sweepTimer = setInterval(() => {
      try {
        sweep();
      } catch (error) {
        log?.warn?.('QR image cache sweep failed', error?.message || error);
      }
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function stopSweeper() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return {
    store,
    get,
    list,
    sweep,
    startSweeper,
    stopSweeper,
    cacheDir,
    cacheDays,
    maxBytes,
    routePrefix: ROUTE_PREFIX,
  };
}

module.exports = {
  createQrImageCache,
  parseDataUrl,
  ROUTE_PREFIX,
};
