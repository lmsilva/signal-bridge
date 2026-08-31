const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRollCreditsMedia,
  resolveMediaPriority,
  summariseYtDlpFailure,
  parseProbeOutput,
  previewFrameSize,
  previewWindow,
  splitRawFrames,
  PREVIEW_SECONDS,
  PREVIEW_MAX_SECONDS,
} = require('../src/roll-credits-media');

function fakeSharp() {
  const chain = {
    rotate: () => chain,
    resize: () => chain,
    jpeg: () => chain,
    toBuffer: async () => Buffer.from('thumbnail'),
  };
  return chain;
}

test('yt-dlp failures keep a short YouTube-stale hint', () => {
  const message = summariseYtDlpFailure([
    'WARNING: [youtube] YouTube said: ERROR - Precondition check failed.',
    'WARNING: [youtube] HTTP Error 400: Bad Request. Retrying (1/3)...',
    'ERROR: [youtube] kV-8Of14gD0: The page needs to be reloaded.',
  ].join('\n'), 1);
  assert.match(message, /outdated yt-dlp/i);
  assert.match(message, /recreate\.sh --build/);
  assert.match(message, /page needs to be reloaded/i);
  assert.ok(message.length < 400);
});

test('media priority uses override and skips hidden or failed rows', () => {
  const game = {
    mediaPriorityOverride: ['screenshot', 'cover', 'video'],
    media: [
      { id: 'video', kind: 'video', status: 'ready', path: 'video.mp4' },
      { id: 'hidden', kind: 'screenshot', status: 'ready', hidden: true, path: 'hidden.jpg' },
      { id: 'failed', kind: 'screenshot', status: 'failed', path: 'failed.jpg' },
      { id: 'cover', kind: 'cover', status: 'ready', path: 'cover.jpg' },
    ],
  };
  const resolved = resolveMediaPriority(game, { mediaPriority: ['video', 'cover', 'screenshot'] });
  assert.equal(resolved.selectedKind, 'cover');
  assert.equal(resolved.hero.id, 'cover');
});

test('image writes generate a 360px thumb only when sharp exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-media-'));
  const withSharp = createRollCreditsMedia({ ROOT: root }, console, { sharpImpl: fakeSharp });
  const written = await withSharp.writeImageBuffer('rc_test', 'cover.jpg', Buffer.from('image'));
  assert.equal(written.thumbPath, 'rc_test/thumbs/cover.360.jpg');
  assert.equal(fs.existsSync(withSharp.absolutePath(written.thumbPath)), true);

  const withoutSharp = createRollCreditsMedia({
    rollCreditsMediaRoot: path.join(root, 'no-sharp'),
  }, console, { sharpImpl: null });
  const fallback = await withoutSharp.writeImageBuffer('rc_test', 'cover.jpg', Buffer.from('image'));
  assert.equal(fallback.thumbPath, null);
  assert.equal(fallback.thumbUrl, null);
});

test('ffprobe output becomes width, height and duration', () => {
  assert.deepEqual(parseProbeOutput('width=1920\nheight=1080\nduration=63.400000\n'), {
    width: 1920, height: 1080, durationSeconds: 63.4,
  });
  assert.deepEqual(parseProbeOutput('width=N/A\nduration=0\n'), {
    width: null, height: null, durationSeconds: null,
  });
});

test('preview frames shrink into the box on even edges', () => {
  assert.deepEqual(previewFrameSize(1920, 1080, 512), { width: 512, height: 288 });
  assert.deepEqual(previewFrameSize(320, 240, 512), { width: 320, height: 240 });
  const odd = previewFrameSize(1001, 667, 512);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
});

test('preview window skips the intro unless a clip range is set', () => {
  assert.deepEqual(previewWindow(60), { start: 3, seconds: PREVIEW_SECONDS });
  // A clip shorter than the loop is used whole.
  assert.deepEqual(previewWindow(2), { start: 0, seconds: 2 });
  // Unknown duration still yields a usable request for ffmpeg.
  assert.deepEqual(previewWindow(null), { start: 0, seconds: PREVIEW_SECONDS });
});

test('a hand-picked clip range wins over the automatic window', () => {
  assert.deepEqual(previewWindow(120, { trimStart: 42, trimEnd: 50 }), { start: 42, seconds: 8 });
  // Start only: take the default length from there rather than the intro skip.
  assert.deepEqual(previewWindow(120, { trimStart: 42 }), { start: 42, seconds: PREVIEW_SECONDS });
  // The range is clamped to the real file, not a 15s wall snippet.
  assert.deepEqual(previewWindow(30, { trimStart: 10, trimEnd: 900 }), { start: 10, seconds: 20 });
  assert.deepEqual(previewWindow(30, { trimStart: 22, trimEnd: 900 }), { start: 22, seconds: 8 });
  assert.deepEqual(
    previewWindow(600, { trimStart: 0, trimEnd: 500 }),
    { start: 0, seconds: 500 },
  );
  // A last-resort cap still stops a feature-length file becoming a flipbook.
  assert.deepEqual(
    previewWindow(2000, { trimStart: 0, trimEnd: 1800 }),
    { start: 0, seconds: PREVIEW_MAX_SECONDS },
  );
  // A backwards range falls back to the automatic window.
  assert.deepEqual(previewWindow(60, { trimStart: 50, trimEnd: 20 }), { start: 50, seconds: PREVIEW_SECONDS });
});

test('raw ffmpeg output splits into whole frames', () => {
  const frame = 2 * 2 * 4;
  const frames = splitRawFrames(Buffer.alloc(frame * 3 + 5), 2, 2);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].length, frame);
  assert.deepEqual(splitRawFrames(null, 2, 2), []);
});

test('uploaded image cap and orphan pruning are enforced', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-upload-'));
  const media = createRollCreditsMedia({ ROOT: root }, console, { sharpImpl: null });
  const dataUrl = `data:image/png;base64,${Buffer.from('too large').toString('base64')}`;
  await assert.rejects(
    media.saveUploadedImage('rc_known', dataUrl, { maxImageBytes: 2 }),
    /too large/i,
  );
  media.ensureGameDir('rc_known');
  media.ensureGameDir('rc_orphan');
  assert.deepEqual(media.pruneOrphans(['rc_known']).removed, ['rc_orphan']);
  assert.equal(fs.existsSync(path.join(media.mediaRoot, 'rc_known')), true);
});
