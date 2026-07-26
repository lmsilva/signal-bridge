const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024; // raw (decoded) image bytes
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
 * Stores photos uploaded through the "QR code → embedded photo" flow (and
 * shared via the Slideshow Manager) so they can be served back from an
 * unguessable URL embedded in the QR code or the Shared Photo Slideshow.
 * Images live under `config.qrImage.cacheDir` (default `data/qr-image-cache/`)
 * and are kept **indefinitely** — there is no automatic expiry; the user
 * manages what's kept from the web page's Slideshow Manager tab, which calls
 * `delete()` to remove a photo on request.
 */
function createQrImageCache(config = {}, log = console) {
  const maxBytes = Number(config?.qrImage?.maxBytes) > 0
    ? Number(config.qrImage.maxBytes)
    : DEFAULT_MAX_BYTES;
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.qrImageCacheDir
    || path.resolve(root, config?.qrImage?.cacheDir || 'data/qr-image-cache');
  const indexPath = path.join(cacheDir, 'index.json');
  /** @type {Set<(reason: string, photos: object[]) => void>} */
  const listeners = new Set();

  function ensureDir() {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  /** Notifies subscribers (the Slideshow Manager's `/api/photos/events` SSE
   * stream) that a photo was added or removed, so every open browser tab —
   * not just the one that triggered the change — can refresh its camera
   * roll without polling. */
  function notify(reason) {
    if (!listeners.size) {
      return;
    }
    const photos = list();
    for (const listener of listeners) {
      try {
        listener(reason, photos);
      } catch (error) {
        log.warn?.('QR image cache listener failed', error?.message || error);
      }
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
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
    const index = loadIndex(indexPath);
    index[token] = {
      fileName,
      mimeType: parsed.mimeType,
      createdAt: new Date(now).toISOString(),
    };
    saveIndex(indexPath, index);
    notify('store');

    return {
      ok: true,
      token,
      path: `${ROUTE_PREFIX}${fileName}`,
      createdAt: index[token].createdAt,
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
    const filePath = path.join(cacheDir, entry.fileName);
    if (!fs.existsSync(filePath)) {
      removeEntry(index, token);
      return null;
    }
    return { filePath, mimeType: entry.mimeType, createdAt: entry.createdAt };
  }

  /**
   * Permanently removes a stored photo (file + index entry). Returns `true`
   * if a photo was found and removed, `false` if the token was unknown.
   */
  function deletePhoto(token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      return false;
    }
    const index = loadIndex(indexPath);
    if (!index[cleanToken]) {
      return false;
    }
    removeEntry(index, cleanToken);
    notify('delete');
    return true;
  }

  /**
   * All stored photos, newest first — the full "camera roll" the Slideshow
   * Manager and Shared Photo Slideshow draw from. Nothing expires on its own
   * any more; photos stay until a user deletes them.
   */
  function list() {
    const index = loadIndex(indexPath);
    return Object.entries(index)
      .sort(([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(([token, entry]) => ({
        token,
        path: `${ROUTE_PREFIX}${entry.fileName}`,
        createdAt: entry.createdAt,
      }));
  }

  return {
    store,
    get,
    delete: deletePhoto,
    list,
    onChange,
    cacheDir,
    maxBytes,
    routePrefix: ROUTE_PREFIX,
  };
}

module.exports = {
  createQrImageCache,
  parseDataUrl,
  ROUTE_PREFIX,
};
