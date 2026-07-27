/**
 * Disk cache for Steam Now Playing artwork (poster + screenshots) and store
 * appdetails JSON. Served at /steam-artwork/<appId>/… so displays can load from
 * the LAN instead of Steam CDN after the first warm.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ROUTE_PREFIX = '/steam-artwork/';
const DETAILS_FILE = 'details.json';
const META_FILE = 'meta.json';
const MAX_SHOTS = 3;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function extForContentType(contentType, fallbackUrl = '') {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  const fromUrl = String(fallbackUrl).toLowerCase();
  if (fromUrl.includes('.png')) return '.png';
  if (fromUrl.includes('.webp')) return '.webp';
  return '.jpg';
}

function mimeForExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function httpsGetBuffer(urlString, { timeoutMs = 15_000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Accept: 'image/*,*/*',
        'User-Agent': 'signal-bridge-steam-artwork/1.0',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGetBuffer(res.headers.location, { timeoutMs, maxBytes }).then(resolve, reject);
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error('Image too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || '',
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Artwork download timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function createSteamArtworkCache(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = config.steamArtworkCacheDir
    || path.resolve(root, config?.steam?.artworkCacheDir || 'data/steam-artwork-cache');
  /** @type {Set<number>} */
  const warming = new Set();

  function ensureRoot() {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  function appDir(appId) {
    return path.join(cacheDir, String(Number(appId)));
  }

  function readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeJson(filePath, data) {
    ensureRoot();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  function getDetails(appId) {
    const id = Number(appId);
    if (!Number.isFinite(id) || id <= 0) {
      return null;
    }
    const details = readJson(path.join(appDir(id), DETAILS_FILE));
    if (!details || typeof details !== 'object') {
      return null;
    }
    return details;
  }

  function saveDetails(appId, details) {
    const id = Number(appId);
    if (!Number.isFinite(id) || id <= 0 || !details) {
      return;
    }
    writeJson(path.join(appDir(id), DETAILS_FILE), {
      ...details,
      cachedAt: new Date().toISOString(),
    });
  }

  function readMeta(appId) {
    return readJson(path.join(appDir(appId), META_FILE));
  }

  function listImageFiles(appId) {
    const dir = appDir(appId);
    if (!fs.existsSync(dir)) {
      return { poster: null, shots: [] };
    }
    const names = fs.readdirSync(dir);
    const poster = names.find((name) => /^poster\./i.test(name)) || null;
    const shots = names
      .filter((name) => /^shot-\d+\./i.test(name))
      .sort((a, b) => {
        const ai = Number((/^shot-(\d+)/i.exec(a) || [])[1]);
        const bi = Number((/^shot-(\d+)/i.exec(b) || [])[1]);
        return ai - bi;
      });
    return { poster, shots };
  }

  function hasImages(appId) {
    const { poster, shots } = listImageFiles(appId);
    return Boolean(poster || shots.length);
  }

  /**
   * Absolute LAN URLs for UDP payloads when images are on disk.
   * Falls back to null when the public origin is unknown or nothing cached.
   */
  function getServedImageUrls(appId, publicOrigin) {
    const id = Number(appId);
    const origin = String(publicOrigin || '').replace(/\/$/, '');
    if (!Number.isFinite(id) || id <= 0 || !origin) {
      return null;
    }
    const { poster, shots } = listImageFiles(id);
    if (!poster && !shots.length) {
      return null;
    }
    const base = `${origin}${ROUTE_PREFIX}${id}/`;
    return {
      posterCandidates: poster ? [`${base}${poster}`] : [],
      headerImage: poster ? `${base}${poster}` : null,
      screenshots: shots.map((name) => `${base}${name}`),
    };
  }

  async function downloadFirst(urls) {
    for (const url of urls || []) {
      if (!url || String(url).includes('/steam-artwork/')) {
        continue;
      }
      try {
        const result = await httpsGetBuffer(url);
        if (result.buffer?.length) {
          return { ...result, sourceUrl: url };
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async function warmImages(appId, details, { force = false } = {}) {
    const id = Number(appId);
    if (!Number.isFinite(id) || id <= 0 || !details) {
      return { warmed: false, ready: false };
    }
    if (warming.has(id)) {
      return { warmed: false, ready: hasImages(id) };
    }
    if (!force && hasImages(id)) {
      return { warmed: false, ready: true };
    }
    warming.add(id);
    try {
      ensureRoot();
      const dir = appDir(id);
      fs.mkdirSync(dir, { recursive: true });

      if (force) {
        for (const name of fs.readdirSync(dir)) {
          if (/^(poster|shot-\d+)\./i.test(name)) {
            try {
              fs.unlinkSync(path.join(dir, name));
            } catch {
              // ignore
            }
          }
        }
      }

      const posterUrls = [
        ...(Array.isArray(details.posterCandidates) ? details.posterCandidates : []),
        details.headerImage,
        details.capsuleImage,
      ].filter(Boolean);
      const poster = await downloadFirst(posterUrls);
      if (poster) {
        const ext = extForContentType(poster.contentType, poster.sourceUrl);
        fs.writeFileSync(path.join(dir, `poster${ext}`), poster.buffer);
      }

      const shotUrls = (Array.isArray(details.screenshots) ? details.screenshots : [])
        .filter(Boolean)
        .slice(0, MAX_SHOTS);
      let shotIndex = 0;
      for (const url of shotUrls) {
        try {
          const shot = await httpsGetBuffer(url);
          if (!shot.buffer?.length) {
            continue;
          }
          const ext = extForContentType(shot.contentType, url);
          fs.writeFileSync(path.join(dir, `shot-${shotIndex}${ext}`), shot.buffer);
          shotIndex += 1;
        } catch {
          // skip failed screenshot
        }
      }

      writeJson(path.join(dir, META_FILE), {
        appId: id,
        name: details.name || null,
        warmedAt: new Date().toISOString(),
        poster: Boolean(poster),
        screenshots: shotIndex,
      });
      const ready = hasImages(id);
      log?.info?.('Steam artwork cached', { appId: id, poster: Boolean(poster), screenshots: shotIndex });
      return { warmed: ready, ready };
    } catch (error) {
      log?.warn?.('Steam artwork warm failed', error?.message || String(error));
      return { warmed: false, ready: false };
    } finally {
      warming.delete(id);
    }
  }

  function resolveServePath(pathname) {
    if (!String(pathname || '').startsWith(ROUTE_PREFIX)) {
      return null;
    }
    const rel = pathname.slice(ROUTE_PREFIX.length);
    const parts = rel.split('/').filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }
    const appId = Number(parts[0]);
    const fileName = parts[1];
    if (!Number.isFinite(appId) || appId <= 0) {
      return null;
    }
    if (!/^(poster|shot-\d+)\.(jpg|jpeg|png|webp)$/i.test(fileName)) {
      return null;
    }
    const filePath = path.join(appDir(appId), fileName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(appDir(appId)))) {
      return null;
    }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return null;
    }
    return {
      filePath: resolved,
      mimeType: mimeForExt(path.extname(resolved).toLowerCase()),
    };
  }

  function clear() {
    if (!fs.existsSync(cacheDir)) {
      return { ok: true, removedApps: 0 };
    }
    let removedApps = 0;
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        try {
          fs.unlinkSync(path.join(cacheDir, entry.name));
        } catch {
          // ignore
        }
        continue;
      }
      const dir = path.join(cacheDir, entry.name);
      for (const name of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // ignore
        }
      }
      try {
        fs.rmdirSync(dir);
        removedApps += 1;
      } catch {
        // ignore
      }
    }
    return { ok: true, removedApps };
  }

  function stats() {
    if (!fs.existsSync(cacheDir)) {
      return { apps: 0, bytes: 0, cacheDir };
    }
    let apps = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      apps += 1;
      const dir = path.join(cacheDir, entry.name);
      for (const name of fs.readdirSync(dir)) {
        try {
          bytes += fs.statSync(path.join(dir, name)).size;
        } catch {
          // ignore
        }
      }
    }
    return { apps, bytes, cacheDir };
  }

  return {
    routePrefix: ROUTE_PREFIX,
    cacheDir,
    getDetails,
    saveDetails,
    readMeta,
    hasImages,
    getServedImageUrls,
    warmImages,
    resolveServePath,
    clear,
    stats,
  };
}

module.exports = {
  ROUTE_PREFIX,
  createSteamArtworkCache,
  httpsGetBuffer,
  extForContentType,
};
