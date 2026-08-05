const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024; // raw (decoded) image bytes
const ROUTE_PREFIX = '/qr-images/';
const THUMB_SUBDIR = 'thumbs';
const THUMB_EXT = '.jpg';
/** Grid cells are ~100–140px CSS; keep files tiny for snappy phone/admin loads. */
const THUMB_MAX_EDGE = 180;
const THUMB_JPEG_QUALITY = 58;
/** Filename stamp so a size/quality bump invalidates older larger thumbs. */
const THUMB_NAME_TAG = String(THUMB_MAX_EDGE);

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const DATA_URL_RE = /^data:([\w+.-]+\/[\w+.-]+);base64,(.+)$/s;

let sharp = null;
try {
  // Optional at require-time so unit tests can stub; production installs sharp.
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  sharp = require('sharp');
} catch {
  sharp = null;
}

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

function thumbFileName(token) {
  return `${THUMB_SUBDIR}/${token}.${THUMB_NAME_TAG}${THUMB_EXT}`;
}

function thumbRoutePath(token) {
  return `${ROUTE_PREFIX}${thumbFileName(token)}`;
}

function parseThumbRouteTail(fileName) {
  const match = new RegExp(
    `^${THUMB_SUBDIR}/([0-9a-f]{32})(?:\\.\\d+)?\\${THUMB_EXT}$`,
    'i',
  ).exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resize/re-encode an image buffer to a small JPEG for the admin camera roll.
 * Returns null when sharp is unavailable or the source cannot be decoded.
 */
async function renderThumbnail(buffer, {
  maxEdge = THUMB_MAX_EDGE,
  quality = THUMB_JPEG_QUALITY,
  sharpImpl = sharp,
} = {}) {
  if (!sharpImpl || !buffer || !buffer.length) {
    return null;
  }
  try {
    return await sharpImpl(buffer)
      .rotate() // honour EXIF orientation from phone cameras
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, chromaSubsampling: '4:2:0' })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Stores photos uploaded through the "QR code → embedded photo" flow (and
 * shared via the Slideshow Manager) so they can be served back from an
 * unguessable URL embedded in the QR code or the Shared Photo Slideshow.
 * Images live under `config.qrImage.cacheDir` (default `data/qr-image-cache/`)
 * and are kept **indefinitely** — there is no automatic expiry; the user
 * manages what's kept from the web page's Slideshow Manager tab, which calls
 * `delete()` to remove a photo on request.
 *
 * A compact JPEG thumbnail is written beside each original for the admin
 * Slideshow grid (`/qr-images/thumbs/<token>.180.jpg`). Full originals stay on
 * `path` for the lightbox and display slideshow.
 */
function createQrImageCache(config = {}, log = console, {
  sharpImpl = sharp,
  renderThumb = renderThumbnail,
} = {}) {
  const maxBytes = Number(config?.qrImage?.maxBytes) > 0
    ? Number(config.qrImage.maxBytes)
    : DEFAULT_MAX_BYTES;
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.qrImageCacheDir
    || path.resolve(root, config?.qrImage?.cacheDir || 'data/qr-image-cache');
  const indexPath = path.join(cacheDir, 'index.json');
  const thumbsDir = path.join(cacheDir, THUMB_SUBDIR);
  /** @type {Set<(reason: string, photos: object[]) => void>} */
  const listeners = new Set();
  /** @type {Map<string, Promise<object|null>>} */
  const ensuringThumbs = new Map();
  let backfillPromise = null;
  const canEncodeThumbs = Boolean(sharpImpl);

  if (!canEncodeThumbs) {
    log.warn?.(
      'QR image thumbnails disabled — sharp is not installed in this runtime. '
      + 'Rebuild the Docker image (`./recreate.sh --build`) so the Slideshow '
      + 'grid can use small JPEGs instead of full originals.',
    );
  }

  function ensureDir() {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });
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

  function thumbDiskPath(token) {
    return path.join(cacheDir, thumbFileName(token));
  }

  function thumbExists(token) {
    try {
      return fs.existsSync(thumbDiskPath(token));
    } catch {
      return false;
    }
  }

  function unlinkThumb(token) {
    try {
      fs.unlinkSync(thumbDiskPath(token));
    } catch {
      // already gone
    }
    // Drop legacy untagged thumbs from the first thumbnail pass.
    try {
      fs.unlinkSync(path.join(thumbsDir, `${token}${THUMB_EXT}`));
    } catch {
      // already gone
    }
  }

  async function writeThumbFromBuffer(token, buffer) {
    const jpeg = await renderThumb(buffer, {
      sharpImpl,
      maxEdge: THUMB_MAX_EDGE,
      quality: THUMB_JPEG_QUALITY,
    });
    if (!jpeg || !jpeg.length) {
      return false;
    }
    ensureDir();
    fs.writeFileSync(thumbDiskPath(token), jpeg);
    return true;
  }

  function thumbEntryFor(token, createdAt) {
    const filePath = thumbDiskPath(token);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return {
      filePath,
      mimeType: 'image/jpeg',
      createdAt: createdAt || null,
      isThumb: true,
    };
  }

  /**
   * Return an existing thumb, or build one from the original on demand.
   * Concurrent callers for the same token share one encode.
   */
  async function ensureThumb(token) {
    const clean = String(token || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(clean)) {
      return null;
    }
    const index = loadIndex(indexPath);
    const meta = index[clean];
    if (!meta) {
      return null;
    }
    const existing = thumbEntryFor(clean, meta.createdAt);
    if (existing) {
      return existing;
    }
    if (ensuringThumbs.has(clean)) {
      return ensuringThumbs.get(clean);
    }
    const job = (async () => {
      try {
        const originalPath = path.join(cacheDir, meta.fileName);
        const buffer = fs.readFileSync(originalPath);
        const ok = await writeThumbFromBuffer(clean, buffer);
        if (!ok) {
          return null;
        }
        return thumbEntryFor(clean, meta.createdAt);
      } catch (error) {
        log.warn?.('QR image ensureThumb failed', { token: clean, error: error?.message || error });
        return null;
      } finally {
        ensuringThumbs.delete(clean);
      }
    })();
    ensuringThumbs.set(clean, job);
    return job;
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
    unlinkThumb(token);
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

    // Fire-and-forget thumb so the upload response stays snappy; SSE refreshes
    // the admin grid when the small JPEG lands.
    Promise.resolve()
      .then(() => writeThumbFromBuffer(token, parsed.buffer))
      .then((ok) => {
        if (ok) {
          notify('thumb');
        }
      })
      .catch((error) => {
        log.warn?.('QR image thumbnail failed', error?.message || error);
      });

    notify('store');

    return {
      ok: true,
      token,
      path: `${ROUTE_PREFIX}${fileName}`,
      thumbPath: canEncodeThumbs ? thumbRoutePath(token) : null,
      createdAt: index[token].createdAt,
    };
  }

  /** `routeTail` is the URL segment after ROUTE_PREFIX, e.g. `"<token>.jpg"`
   * or `"thumbs/<token>.180.jpg"`. */
  function get(routeTail) {
    const fileName = String(routeTail || '').replace(/^\/+/, '');
    if (!fileName || fileName.includes('..')) {
      return null;
    }

    const thumbToken = parseThumbRouteTail(fileName);
    if (thumbToken) {
      const index = loadIndex(indexPath);
      if (!index[thumbToken]) {
        return null;
      }
      return thumbEntryFor(thumbToken, index[thumbToken].createdAt);
    }

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
    return { filePath, mimeType: entry.mimeType, createdAt: entry.createdAt, isThumb: false };
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
      .map(([token, entry]) => {
        const ready = thumbExists(token);
        // When sharp is missing, omit thumbPath so the admin grid loads the
        // original instead of a guaranteed 404. With sharp, always advertise
        // the thumb URL — GET will generate on demand if the file is absent.
        const thumbPath = canEncodeThumbs ? thumbRoutePath(token) : null;
        return {
          token,
          path: `${ROUTE_PREFIX}${entry.fileName}`,
          thumbPath,
          thumbReady: ready,
          createdAt: entry.createdAt,
        };
      });
  }

  /**
   * Generate missing thumbs for photos uploaded before thumbnail support.
   * Runs once in the background; safe to call repeatedly.
   */
  function backfillThumbnails({ concurrency = 2 } = {}) {
    if (backfillPromise) {
      return backfillPromise;
    }
    backfillPromise = (async () => {
      const index = loadIndex(indexPath);
      const missing = Object.entries(index)
        .filter(([token]) => !thumbExists(token))
        .map(([token, entry]) => ({ token, entry }));
      if (!missing.length) {
        return { generated: 0, failed: 0 };
      }

      let generated = 0;
      let failed = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < missing.length) {
          const current = missing[cursor];
          cursor += 1;
          try {
            const filePath = path.join(cacheDir, current.entry.fileName);
            const buffer = fs.readFileSync(filePath);
            const ok = await writeThumbFromBuffer(current.token, buffer);
            if (ok) {
              generated += 1;
            } else {
              failed += 1;
            }
          } catch (error) {
            failed += 1;
            log.warn?.('QR image thumb backfill failed', {
              token: current.token,
              error: error?.message || error,
            });
          }
        }
      }

      const workers = Array.from(
        { length: Math.max(1, Math.min(concurrency, missing.length)) },
        () => worker(),
      );
      await Promise.all(workers);
      if (generated > 0) {
        notify('thumb-backfill');
      }
      log.info?.('QR image thumbnail backfill complete', { generated, failed, pending: 0 });
      return { generated, failed };
    })().finally(() => {
      // Allow a later call if new photos somehow lack thumbs.
      backfillPromise = null;
    });
    return backfillPromise;
  }

  return {
    store,
    get,
    ensureThumb,
    delete: deletePhoto,
    list,
    onChange,
    backfillThumbnails,
    cacheDir,
    maxBytes,
    routePrefix: ROUTE_PREFIX,
    thumbMaxEdge: THUMB_MAX_EDGE,
    canEncodeThumbs,
  };
}

module.exports = {
  createQrImageCache,
  parseDataUrl,
  renderThumbnail,
  parseThumbRouteTail,
  ROUTE_PREFIX,
  THUMB_MAX_EDGE,
  THUMB_NAME_TAG,
  THUMB_SUBDIR,
};
