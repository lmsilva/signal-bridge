const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROUTE_PREFIX = '/roll-credits-media/';
const THUMB_MAX_EDGE = 360;
// The wall cannot decode video, so every clip is reduced to a short silent
// animated WebP it can loop inside the card, plus a poster still for fallback.
const PREVIEW_MAX_EDGE = 512;
const PREVIEW_SECONDS = 5;
const PREVIEW_FPS = 24;
const PREVIEW_SKIP_SECONDS = 3;
// Automatic snippets stay at PREVIEW_SECONDS. A hand-set start/end is the
// whole range, with this only as a last-resort cap so a two-hour file cannot
// become a wall flipbook.
const PREVIEW_MAX_SECONDS = 600;
const PREVIEW_MAX_RAW_BYTES = 96 * 1024 * 1024;
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

/** Reads `width=`/`height=`/`duration=` lines out of an ffprobe default dump. */
function parseProbeOutput(text) {
  const fields = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([a-z_]+)=(.*)$/i.exec(line.trim());
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }
  const number = (key) => {
    const value = Number(fields.get(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    width: number('width'),
    height: number('height'),
    durationSeconds: number('duration'),
  };
}

/** Scales a clip into the preview box, keeping both edges even for the encoder. */
function previewFrameSize(width, height, maxEdge = PREVIEW_MAX_EDGE) {
  const sourceW = Number(width) > 0 ? Number(width) : maxEdge;
  const sourceH = Number(height) > 0 ? Number(height) : maxEdge;
  const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
  const even = (value) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(sourceW), height: even(sourceH) };
}

/**
 * Picks the slice of a video the wall loop is built from. A hand-set trim wins;
 * otherwise we skip a few seconds to dodge fade-ins and black title cards, but
 * never past the end of a short clip.
 */
function previewWindow(durationSeconds, {
  skip = PREVIEW_SKIP_SECONDS,
  seconds = PREVIEW_SECONDS,
  trimStart = null,
  trimEnd = null,
  maxSeconds = PREVIEW_MAX_SECONDS,
} = {}) {
  const total = Number(durationSeconds);
  const hasTotal = Number.isFinite(total) && total > 0;
  // Number(null) and Number('') are both 0, so an unset bound has to be
  // rejected before it looks like a deliberate "start at zero".
  const bound = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const rawStart = bound(trimStart);
  const rawEnd = bound(trimEnd);
  const trimmedStart = rawStart === null
    ? null
    : (hasTotal ? Math.min(rawStart, Math.max(0, total - 0.1)) : rawStart);
  const trimmedEnd = rawEnd === null || rawEnd <= 0
    ? null
    : (hasTotal ? Math.min(rawEnd, total) : rawEnd);

  if (trimmedStart !== null || trimmedEnd !== null) {
    const from = trimmedStart ?? 0;
    let to;
    if (trimmedEnd !== null && trimmedEnd > from) {
      to = trimmedEnd;
    } else {
      // Start only (or a backwards end): default-length snippet from there.
      to = from + seconds;
    }
    if (hasTotal) to = Math.min(to, total);
    const span = Math.min(Math.max(0, to - from), maxSeconds);
    if (span > 0) return { start: from, seconds: span };
  }

  if (!hasTotal) return { start: 0, seconds };
  if (total <= seconds) return { start: 0, seconds: total };
  return { start: Math.min(skip, Math.max(0, total - seconds)), seconds };
}

function splitRawFrames(buffer, width, height, channels = 4) {
  const frameBytes = width * height * channels;
  if (!Buffer.isBuffer(buffer) || frameBytes <= 0) return [];
  const count = Math.floor(buffer.length / frameBytes);
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(buffer.subarray(index * frameBytes, (index + 1) * frameBytes));
  }
  return frames;
}

/**
 * Stacks raw RGBA frames into an animated WebP. libvips reads a multi-page raw
 * buffer when `pageHeight` is set inside the raw options — encoding through
 * sharp keeps this independent of how ffmpeg happens to be compiled.
 */
async function encodeAnimatedWebp(frames, { width, height, delayMs = 100 }, sharpImpl = defaultSharp) {
  if (!sharpImpl || !Array.isArray(frames) || frames.length < 2) return null;
  try {
    return await sharpImpl(Buffer.concat(frames), {
      raw: {
        width, height: height * frames.length, channels: 4, pageHeight: height,
      },
    })
      .webp({ loop: 0, delay: Math.max(20, Math.round(delayMs)), quality: 72, effort: 4 })
      .toBuffer();
  } catch {
    return null;
  }
}

async function encodeRawPoster(frame, { width, height }, sharpImpl = defaultSharp) {
  if (!sharpImpl || !frame) return null;
  try {
    return await sharpImpl(frame, { raw: { width, height, channels: 4 } })
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 72, chromaSubsampling: '4:2:0' })
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
      const preview = await renderVideoPreview(relative);
      return {
        path: relative,
        thumbPath: preview.posterPath,
        previewPath: preview.previewPath,
        durationSeconds: preview.durationSeconds,
        previewRevision: preview.previewRevision || null,
        frameCount: preview.frameCount || null,
        previewError: preview.error,
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

  function ffmpegBinary(name) {
    const key = name === 'ffprobe' ? 'FFPROBE_BIN' : 'FFMPEG_BIN';
    return config[key] || process.env[key] || name;
  }

  /**
   * Runs an ffmpeg/ffprobe command that writes a file (stdout ignored).
   * Used for long wall previews so we never buffer every RGBA frame in RAM.
   */
  function runFfmpegToFile(name, args) {
    const binary = ffmpegBinary(name);
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawnImpl(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        reject(new Error(`${name} could not start: ${error.message}`));
        return;
      }
      let stderr = '';
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new Error(error?.code === 'ENOENT'
          ? `${name} is missing — rebuild the image with ./recreate.sh --build`
          : `${name} failed: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const detail = String(stderr).trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${code}`;
          reject(new Error(`${name} failed: ${detail.slice(0, 240)}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Runs an ffmpeg/ffprobe command, buffering stdout. Rejects with a short
   * message so a broken clip never writes multi-KB of ffmpeg chatter into the
   * admin status line.
   */
  function runFfmpeg(name, args, { maxStdoutBytes = PREVIEW_MAX_RAW_BYTES } = {}) {
    const binary = ffmpegBinary(name);
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawnImpl(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(new Error(`${name} could not start: ${error.message}`));
        return;
      }
      const chunks = [];
      let stdoutBytes = 0;
      let stderr = '';
      child.stdout?.on?.('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          reject(new Error(`${name} produced more data than the preview budget allows`));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk;
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new Error(error?.code === 'ENOENT'
          ? `${name} is missing — rebuild the image with ./recreate.sh --build`
          : `${name} failed: ${error.message}`));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const detail = String(stderr).trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${code}`;
          reject(new Error(`${name} failed: ${detail.slice(0, 240)}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async function probeVideo(absoluteVideoPath) {
    const output = await runFfmpeg('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1',
      absoluteVideoPath,
    ], { maxStdoutBytes: 64 * 1024 });
    return parseProbeOutput(output.toString('utf8'));
  }

  /**
   * Builds the wall-facing artefacts for a stored clip: a poster still and a
   * looping animated WebP. Never throws — a clip that cannot be decoded
   * simply keeps its cover art on the display, and the reason is returned for
   * the admin status line.
   *
   * Long trims write WebP with ffmpeg so every RGBA frame is not held in RAM.
   * The old raw→sharp path is only the fallback when libwebp is missing and
   * the window still fits PREVIEW_MAX_RAW_BYTES.
   */
  async function renderVideoPreview(relativeVideoPath, {
    seconds = PREVIEW_SECONDS,
    fps = PREVIEW_FPS,
    maxEdge = PREVIEW_MAX_EDGE,
    trimStart = null,
    trimEnd = null,
  } = {}) {
    const empty = {
      posterPath: null, previewPath: null, durationSeconds: null, frameCount: 0, error: null,
    };
    let relative;
    try {
      relative = cleanRelativePath(relativeVideoPath);
    } catch (error) {
      return { ...empty, error: error.message };
    }
    const source = absolutePath(relative);
    const gameId = relative.split('/')[0];
    const stem = path.basename(relative).replace(/\.[^.]+$/, '');
    const posterPath = `${gameId}/thumbs/${stem}.poster.jpg`;
    const previewPath = `${gameId}/thumbs/${stem}.preview.webp`;
    try {
      const probe = await probeVideo(source);
      const frame = previewFrameSize(probe.width, probe.height, maxEdge);
      const window = previewWindow(probe.durationSeconds, { seconds, trimStart, trimEnd });
      const start = String(Math.round(window.start * 1000) / 1000);
      const length = String(Math.round(window.seconds * 1000) / 1000);
      fs.mkdirSync(path.dirname(absolutePath(posterPath)), { recursive: true });

      let wrotePoster = false;
      let wrotePreview = false;
      try {
        await runFfmpegToFile('ffmpeg', [
          '-y', '-v', 'error',
          '-ss', start, '-i', source, '-frames:v', '1',
          '-vf', `scale=${THUMB_MAX_EDGE}:${THUMB_MAX_EDGE}:force_original_aspect_ratio=decrease`,
          absolutePath(posterPath),
        ]);
        wrotePoster = fs.existsSync(absolutePath(posterPath));
      } catch {
        wrotePoster = false;
      }

      const webpArgs = (codec) => ([
        '-y', '-v', 'error',
        '-ss', start, '-i', source, '-t', length,
        '-an',
        '-vf', `fps=${fps},scale=${frame.width}:${frame.height}`,
        '-loop', '0',
        '-c:v', codec,
        '-quality', '72',
        absolutePath(previewPath),
      ]);
      for (const codec of ['libwebp', 'webp']) {
        try {
          await runFfmpegToFile('ffmpeg', webpArgs(codec));
          wrotePreview = fs.existsSync(absolutePath(previewPath))
            && fs.statSync(absolutePath(previewPath)).size > 0;
          if (wrotePreview) break;
        } catch {
          wrotePreview = false;
        }
      }

      if (!wrotePreview) {
        const fallback = await renderVideoPreviewRaw(source, {
          frame, window, fps, posterPath, previewPath, wrotePoster,
        });
        wrotePoster = fallback.wrotePoster;
        wrotePreview = fallback.wrotePreview;
        if (!wrotePreview && fallback.error) {
          return {
            ...empty,
            posterPath: wrotePoster ? posterPath : null,
            durationSeconds: probe.durationSeconds,
            previewStart: window.start,
            previewSeconds: window.seconds,
            error: fallback.error,
          };
        }
      }

      return {
        posterPath: wrotePoster ? posterPath : null,
        previewPath: wrotePreview ? previewPath : null,
        durationSeconds: probe.durationSeconds,
        previewStart: window.start,
        previewSeconds: window.seconds,
        previewRevision: Date.now(),
        frameCount: Math.max(2, Math.round(window.seconds * Math.max(1, fps))),
        error: wrotePoster || wrotePreview ? null : 'preview encoding failed',
      };
    } catch (error) {
      return { ...empty, error: error?.message || String(error) };
    }
  }

  async function renderVideoPreviewRaw(source, {
    frame, window, fps, posterPath, previewPath, wrotePoster,
  }) {
    if (!sharpImpl) return { wrotePoster, wrotePreview: false, error: 'sharp is unavailable' };
    const frameBytes = frame.width * frame.height * 4;
    const estimated = frameBytes * Math.max(2, Math.round(window.seconds * Math.max(1, fps)));
    if (estimated > PREVIEW_MAX_RAW_BYTES) {
      return {
        wrotePoster,
        wrotePreview: false,
        error: 'clip is too long for the in-memory preview fallback',
      };
    }
    try {
      const raw = await runFfmpeg('ffmpeg', [
        '-v', 'error',
        '-ss', String(Math.round(window.start * 1000) / 1000),
        '-i', source,
        '-t', String(Math.round(window.seconds * 1000) / 1000),
        '-an',
        '-vf', `fps=${fps},scale=${frame.width}:${frame.height}`,
        '-pix_fmt', 'rgba',
        '-f', 'rawvideo',
        '-',
      ]);
      const frames = splitRawFrames(raw, frame.width, frame.height);
      if (!frames.length) return { wrotePoster, wrotePreview: false, error: 'no frames decoded' };
      if (!wrotePoster) {
        const poster = await encodeRawPoster(frames[0], frame, sharpImpl);
        if (poster) {
          fs.writeFileSync(absolutePath(posterPath), poster);
          wrotePoster = true;
        }
      }
      const animation = await encodeAnimatedWebp(
        frames, { ...frame, delayMs: 1000 / Math.max(1, fps) }, sharpImpl,
      );
      if (!animation) return { wrotePoster, wrotePreview: false, error: 'preview encoding failed' };
      fs.writeFileSync(absolutePath(previewPath), animation);
      return { wrotePoster, wrotePreview: true, error: null };
    } catch (error) {
      return { wrotePoster, wrotePreview: false, error: error?.message || String(error) };
    }
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
    probeVideo,
    renderVideoPreview,
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
  parseProbeOutput,
  previewFrameSize,
  previewWindow,
  splitRawFrames,
  encodeAnimatedWebp,
  renderThumbnail,
  summariseYtDlpFailure,
  ROUTE_PREFIX,
  THUMB_MAX_EDGE,
  PREVIEW_MAX_EDGE,
  PREVIEW_SECONDS,
  PREVIEW_FPS,
  PREVIEW_MAX_SECONDS,
};
