const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSuppressSteamForPayload, mergeBoardFanout } = require('../src/listener');
const { buildSmartHomePayload, buildPhotoSlideshowPayload } = require('../src/udp-payload');
const { sealJson } = require('../src/lan-crypto');
const { extractActivityFields } = require('../src/activity-fields');

test('a voice event that sent a preview and then a live card reports the boards that took either', () => {
  // The bug: the scheduler read only the *last* fan-out, so a Tesla airing
  // whose preview flipped the board and whose live reading was then refused
  // ("gap") was recorded as never reaching a board — and its closing artwork
  // never queued.
  const preview = { boards: [
    { boardId: 'sim', skipped: false, reason: 'queued', accepted: 1 },
    { boardId: 'home', skipped: false, reason: 'queued', accepted: 1 },
  ] };
  const live = { boards: [
    { boardId: 'sim', skipped: true, reason: 'gap', accepted: 0 },
    { boardId: 'home', skipped: false, reason: 'queued', accepted: 1 },
  ] };
  const merged = mergeBoardFanout(preview, live);
  assert.deepEqual(merged.boards.map((row) => [row.boardId, row.accepted, row.reason]), [
    ['sim', 1, 'queued'],
    ['home', 1, 'queued'],
  ]);

  // A board that took neither still reads as refused, with the latest reason.
  const neither = mergeBoardFanout(
    { boards: [{ boardId: 'sim', skipped: true, reason: 'quiet', accepted: 0 }] },
    { boards: [{ boardId: 'sim', skipped: true, reason: 'gap', accepted: 0 }] },
  );
  assert.deepEqual(neither.boards, [{ boardId: 'sim', skipped: true, reason: 'gap', accepted: 0 }]);

  // Only one card sent, or a card that never reached the hub: nothing to merge.
  assert.equal(mergeBoardFanout(null, live), live);
  assert.equal(mergeBoardFanout(preview, null), preview);
  assert.equal(mergeBoardFanout(null, null), null);
});

test('shouldSuppressSteamForPayload suppresses display overlays but not control traffic', () => {
  assert.equal(shouldSuppressSteamForPayload({ type: 'weather.query' }), true);
  assert.equal(shouldSuppressSteamForPayload({ type: 'music.playing' }), true);
  assert.equal(shouldSuppressSteamForPayload({ type: 'steam.now-playing' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'steam.now-playing.close' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'input.pointer' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'input.text' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'display.discover' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'display.auth' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'system.command' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'web.close' }), false);
  assert.equal(shouldSuppressSteamForPayload({ type: 'web.open' }), true);
});

test('buildSmartHomePayload shapes on/off command card', () => {
  const payload = buildSmartHomePayload(
    {
      device: 'Office Echo',
      timestamp: Date.now(),
      trigger: 'smart-home-command',
      query: 'turn on the lamp',
      spokenResponse: 'Okay',
      command: { action: 'on', target: 'lamp' },
    },
    { udpBroadcast: { defaultDisplaySeconds: 45 } },
    { deviceType: 'light', matchedName: 'Office Lamp' },
  );
  assert.equal(payload.type, 'smart-home.command');
  assert.equal(payload.command.action, 'on');
  assert.equal(payload.command.target, 'lamp');
  assert.equal(payload.command.matchedName, 'Office Lamp');
  assert.equal(payload.command.deviceType, 'light');
  assert.ok(payload.displaySeconds <= 15);
});

test('buildSmartHomePayload keeps spokenTarget free of ASR echo commas', () => {
  const { parseSmartHomeCommand } = require('../src/smart-home-command');
  const command = parseSmartHomeCommand('lights off, lights off');
  const payload = buildSmartHomePayload(
    {
      device: 'Office Echo',
      timestamp: Date.now(),
      trigger: 'smart-home-command',
      query: 'lights off, lights off',
      command,
    },
    { udpBroadcast: { defaultDisplaySeconds: 45 } },
    { deviceType: 'light' },
  );
  assert.equal(payload.command.target, 'lights');
  assert.equal(payload.command.spokenTarget, 'lights');
  assert.ok(!/,/.test(payload.command.target));
});

test('buildPhotoSlideshowPayload accepts guest-snaps-slideshow-query trigger', () => {
  const payload = buildPhotoSlideshowPayload({
    photos: [
      { url: 'https://192.168.1.10:47810/qr-images/a.jpg', uploadedAt: '2026-07-26T12:00:00.000Z' },
      { url: 'https://192.168.1.10:47810/qr-images/b.jpg', uploadedAt: '2026-07-25T12:00:00.000Z' },
    ],
    secondsPerPhoto: 5,
    order: 'oldest',
    trigger: 'guest-snaps-slideshow-query',
    device: 'Kitchen Echo',
  });
  assert.equal(payload.type, 'photo.slideshow');
  assert.equal(payload.trigger, 'guest-snaps-slideshow-query');
  assert.equal(payload.slideshow.photos[0].url.endsWith('/b.jpg'), true);
  assert.equal(payload.displaySeconds, 10);
});

test('sealJson stamps sentAt distinct from stale Alexa activity timestamp', () => {
  const oldActivity = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sealNow = Date.now();
  const envelope = sealJson({
    version: 2,
    type: 'weather.query',
    timestamp: oldActivity,
    query: 'weather',
  }, 'sentAt-regression-secret', { now: sealNow });

  const { openEnvelope } = require('../src/lan-crypto');
  const opened = openEnvelope(envelope, 'sentAt-regression-secret', { now: sealNow });
  assert.ok(opened);
  assert.equal(opened.timestamp, oldActivity);
  assert.equal(opened.sentAt, new Date(sealNow).toISOString());
  assert.notEqual(opened.sentAt, opened.timestamp);
});

test('extractActivityFields joins multiple CUSTOMER_TRANSCRIPT parts (wake + repeat)', () => {
  const fields = extractActivityFields({
    description: { summary: '' },
    alexaResponse: '',
    conversionDetails: {
      CUSTOMER_TRANSCRIPT: [
        { transcriptText: 'alexa next' },
        { transcriptText: 'next' },
      ],
      ALEXA_RESPONSE: [{ transcriptText: 'Okay' }],
    },
  });
  assert.match(fields.summary, /alexa next/i);
  assert.match(fields.summary, /\bnext\b/i);
  assert.match(fields.allText, /alexa next/i);
});
