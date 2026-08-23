const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createRollCreditsMedia,
  resolveMediaPriority,
  summariseYtDlpFailure,
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
