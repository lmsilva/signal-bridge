const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROUTE_PREFIX = '/roll-credits-media/';
const THUMB_MAX_EDGE = 360;
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const VIDEO_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};
const DATA_URL_RE = /^data:([\w+.-]+\/[\w+.-]+);base64,(.+)$/s;

/** Keep admin statusDetail readable — yt-dlp stderr can be multi-KB of retries. */
function summariseYtDlpFailure(stderr, code) {
  const text = String(stderr || '').replace(/\r/g, '\n').trim();
  if (!text) {
    return `yt-dlp failed (exit ${code == null ? '?' : code})`;
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line))
    || lines.find((line) => /HTTP Error 400|Precondition check failed|page needs to be reloaded/i.test(line))
    || lines[lines.length - 1];
  let detail = String(errorLine || text).replace(/^ERROR:\s*/i, '').trim();
  if (detail.length > 280) {
    detail = `${detail.slice(0, 277)}…`;
  }
  const looksStale = /HTTP Error 400|Precondition check failed|page needs to be reloaded/i.test(text);
  if (looksStale) {
    return `yt-dlp failed (YouTube rejected the request — usually an outdated yt-dlp; rebuild with ./recreate.sh --build): ${detail}`;
  }
  return `yt-dlp failed: ${detail}`;
}

let defaultSharp = null;
try {
  defaultSharp = require('sharp');
} catch {
  defaultSharp = null;
}

function cleanGameId(gameId) {
  const value = String(gameId || '').trim();
  if (!/^rc_[a-z0-9_-]+$/i.test(value)) throw new Error('Invalid Roll Credits game id');
  return value;
}

function cleanRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Invalid Roll Credits media path');
  }
  return normalized;
}

function parseImageDataUrl(dataUrl) {
  const match = DATA_URL_RE.exec(String(dataUrl || '').trim());
  if (!match || !MIME_EXT[match[1].toLowerCase()]) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return null;
  return {
    mimeType: match[1].toLowerCase(),
    ext: MIME_EXT[match[1].toLowerCase()],
    buffer,
  };
}

async function renderThumbnail(buffer, sharpImpl = defaultSharp) {
  if (!sharpImpl) return null;
  try {
    return await sharpImpl(buffer)
      .rotate()
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70, chromaSubsampling: '4:2:0' })
      .toBuffer();
  } catch {
    return null;
  }
}

function resolveMediaPriority(game = {}, settings = {}) {
  const priority = Array.isArray(game.mediaPriorityOverride) && game.mediaPriorityOverride.length
    ? game.mediaPriorityOverride
    : (settings.mediaPriority || ['video', 'screenshot', 'cover']);
  const ready = (Array.isArray(game.media) ? game.media : [])
    .filter((item) => item && item.hidden !== true && item.status === 'ready' && item.path)
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
  const selectedKind = priority.find((kind) => ready.some((item) => item.kind === kind)) || null;
  const selected = selectedKind ? ready.filter((item) => item.kind === selectedKind) : [];
  const hero = selected[0] || null;
  return {
    priority: [...priority],
    selectedKind,
    hero,
    selected,
    screenshots: ready.filter((item) => item.kind === 'screenshot' && item.id !== hero?.id),
    ready,
  };
}

function createRollCreditsMedia(config = {}, log = console, {
  sharpImpl = defaultSharp,
  fetch: fetchImpl = global.fetch,
  spawnImpl = spawn,
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const mediaRoot = path.resolve(
    config.rollCreditsMediaRoot || path.join(root, 'data', 'roll-credits-media'),
  );

  function ensureGameDir(gameId) {
    const id = cleanGameId(gameId);
    const directory = path.join(mediaRoot, id);
    fs.mkdirSync(path.join(directory, 'thumbs'), { recursive: true });
    return directory;
  }

  function absolutePath(relativePath, fileName = null) {
    const clean = cleanRelativePath(fileName == null
      ? relativePath
      : `${cleanGameId(relativePath)}/${fileName}`);
    const resolved = path.resolve(mediaRoot, ...clean.split('/'));
    if (resolved !== mediaRoot && !resolved.startsWith(`${mediaRoot}${path.sep}`)) {
      throw new Error('Media path leaves the Roll Credits directory');
    }
    return resolved;
  }

  function publicUrl(relativePath) {
    const clean = cleanRelativePath(relativePath);
    return `${ROUTE_PREFIX}${clean.split('/').map(encodeURIComponent).join('/')}`;
  }

  async function writeImageBuffer(gameId, fileName, buffer) {
    const id = cleanGameId(gameId);
    const name = path.basename(String(fileName || 'image.jpg'));
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Image is empty');
    ensureGameDir(id);
    const relativePath = `${id}/${name}`;
    fs.writeFileSync(absolutePath(relativePath), buffer);
    let thumbPath = null;
    const thumbnail = await renderThumbnail(buffer, sharpImpl);
    if (thumbnail) {
      const stem = name.replace(/\.[^.]+$/, '');
      thumbPath = `${id}/thumbs/${stem}.360.jpg`;
      fs.writeFileSync(absolutePath(thumbPath), thumbnail);
    }
    return {
      path: relativePath,
      thumbPath,
      url: publicUrl(relativePath),
      thumbUrl: thumbPath ? publicUrl(thumbPath) : null,
    };
  }

  async function downloadUrlToFile(url, outPath, options = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Media downloader needs fetch');
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Media download failed (HTTP ${response.status})`);
    const body = typeof response.arrayBuffer === 'function'
      ? await response.arrayBuffer()
      : await response.buffer();
    const buffer = Buffer.from(body);
    if (options.maxBytes && buffer.length > options.maxBytes) {
      throw new Error(`Downloaded media exceeds the ${options.maxBytes} byte limit`);
    }
    const relative = cleanRelativePath(outPath);
    fs.mkdirSync(path.dirname(absolutePath(relative)), { recursive: true });
    if (options.image === true) {
      const [gameId, fileName] = relative.split('/');
      return writeImageBuffer(gameId, fileName, buffer);
    }
    fs.writeFileSync(absolutePath(relative), buffer);
    return { path: relative, thumbPath: null, url: publicUrl(relative) };
  }

  async function saveUploadedImage(gameId, dataUrl, limits = {}) {
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) throw new Error('Image must be a JPEG, PNG, or WebP file');
    const maxBytes = Number(limits.maxImageBytes || limits.maxBytes || 10_485_760);
    if (parsed.buffer.length > maxBytes) {
      throw new Error(`Image is too large (max ${Math.round(maxBytes / 1_048_576)}MB)`);
    }
    const fileName = `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${parsed.ext}`;
    return {
      ...(await writeImageBuffer(gameId, fileName, parsed.buffer)),
      mimeType: parsed.mimeType,
      bytes: parsed.buffer.length,
    };
  }

  async function saveUploadedVideo(gameId, input, {
    mimeType,
    contentLength,
    maxBytes = 314_572_800,
  } = {}) {
    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    const ext = VIDEO_EXT[normalizedMime];
    if (!ext) throw new Error('Video must be an MP4 or WebM file');
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`Video is too large (max ${Math.round(maxBytes / 1_048_576)}MB)`);
    }

    const id = cleanGameId(gameId);
    const directory = ensureGameDir(id);
    const fileName = `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    const finalPath = path.join(directory, fileName);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    let bytes = 0;

    try {
      if (Buffer.isBuffer(input)) {
        bytes = input.length;
        if (bytes > maxBytes) {
          throw new Error(`Video is too large (max ${Math.round(maxBytes / 1_048_576)}MB)`);
        }
        fs.writeFileSync(temporaryPath, input);
      } else if (input && typeof input.pipe === 'function') {
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
          let settled = false;
          const fail = (error) => {
            if (settled) return;
            settled = true;
            input.unpipe?.(output);
            output.destroy();
            input.resume?.();
            reject(error);
          };
          input.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              fail(new Error(`Video is too large (max ${Math.round(maxBytes / 1_048_576)}MB)`));
            }
          });
          input.once('error', fail);
          output.once('error', fail);
          output.once('finish', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          input.pipe(output);
        });
      } else {
        throw new Error('Video upload body is required');
      }
      if (!bytes) throw new Error('Video upload is empty');
      fs.renameSync(temporaryPath, finalPath);
      const relative = `${id}/${fileName}`;
      return {
        path: relative,
        thumbPath: null,
        url: publicUrl(relative),
        mimeType: normalizedMime,
        bytes,
      };
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  function diskUsage() {
    const totals = {
      totalBytes: 0,
      imageBytes: 0,
      videoBytes: 0,
      otherBytes: 0,
      imageCount: 0,
      videoCount: 0,
      fileCount: 0,
    };
    if (!fs.existsSync(mediaRoot)) return totals;
    const stack = [mediaRoot];
    while (stack.length) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(filePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const bytes = fs.statSync(filePath).size;
        const ext = path.extname(entry.name).toLowerCase();
        totals.totalBytes += bytes;
        totals.fileCount += 1;
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          totals.imageBytes += bytes;
          totals.imageCount += 1;
        } else if (['.mp4', '.webm', '.mkv'].includes(ext)) {
          totals.videoBytes += bytes;
          totals.videoCount += 1;
        } else {
          totals.otherBytes += bytes;
        }
      }
    }
    return totals;
  }

  function pruneOrphans(knownGameIds = []) {
    const known = new Set([...knownGameIds].map((value) => (
      typeof value === 'object' ? value.id : value
    )).filter(Boolean).map(String));
    const removed = [];
    if (!fs.existsSync(mediaRoot)) return { removed, count: 0 };
    for (const entry of fs.readdirSync(mediaRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^rc_/i.test(entry.name) && !known.has(entry.name)) {
        fs.rmSync(path.join(mediaRoot, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
    return { removed, count: removed.length };
  }

  function downloadYoutube(url, resolution, outPath) {
    const target = absolutePath(outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const binary = config.YT_DLP_BIN || process.env.YT_DLP_BIN || 'yt-dlp';
    const height = Math.max(144, Number(resolution) || 720);
    return new Promise((resolve, reject) => {
      let settled = false;
      // Prefer progressive mp4 when possible; fall back to merge. Android
      // client often survives YouTube API churn better than the default web
      // client on an aging yt-dlp pin — keep the pin current in
      // requirements-roll-credits.txt when downloads start failing with 400.
      const child = spawnImpl(binary, [
        '--no-playlist',
        '--no-progress',
        '--extractor-args', 'youtube:player_client=android,web',
        '--format', `best[height<=${height}][ext=mp4]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
        '--merge-output-format', 'mp4',
        '--output', target,
        String(url),
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        const missing = error?.code === 'ENOENT';
        reject(new Error(missing
          ? 'yt-dlp is missing — rebuild the image with ./recreate.sh --build'
          : `yt-dlp failed: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(summariseYtDlpFailure(stderr, code)));
          return;
        }
        resolve({ path: cleanRelativePath(outPath), thumbPath: null, url: publicUrl(outPath) });
      });
    });
  }

  return {
    ensureGameDir,
    absolutePath,
    publicUrl,
    writeImageBuffer,
    downloadUrlToFile,
    saveUploadedImage,
    saveUploadedVideo,
    downloadYoutube,
    diskUsage,
    pruneOrphans,
    mediaRoot,
    routePrefix: ROUTE_PREFIX,
    canEncodeThumbs: Boolean(sharpImpl),
  };
}

module.exports = {
  createRollCreditsMedia,
  resolveMediaPriority,
  parseImageDataUrl,
  renderThumbnail,
  summariseYtDlpFailure,
  ROUTE_PREFIX,
  THUMB_MAX_EDGE,
};
