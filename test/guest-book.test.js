const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createGuestBookSettings } = require('../src/guest-book-settings');
const { createGuestBook, guestClientIp, wordBlocked } = require('../src/guest-book');
const { blankBoard } = require('../src/guest-book-compose');
const { CHIPS, decodeCodes } = require('../src/vestaboard/encoder');

function makeBook(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-book-'));
  const settings = createGuestBookSettings({
    ROOT: root,
    guestBookSettingsPath: path.join(root, 'settings.json'),
  });
  if (overrides.settings) {
    settings.update(overrides.settings);
  }
  const pushed = [];
  const book = createGuestBook({
    ROOT: root,
    guestBookPath: path.join(root, 'book.json'),
  }, { warn() {} }, {
    now: overrides.now || (() => Date.now()),
    getSettings: () => settings.get(),
    getShortlink: () => ({ flapLabel: 'TINYURL.COM/WITTYBOARD', display: 'tinyurl.com/WITTYBOARD' }),
    pushToBoard: (payload, options) => {
      pushed.push({ payload, options });
      return overrides.pushResult || { boards: [{ accepted: 1, pending: 0 }] };
    },
    getTimeZone: () => 'America/Denver',
    getQuietHours: () => overrides.quietHours || null,
    randomInt: () => 0,
  });
  return { book, settings, pushed, root };
}

test('guest book settings no longer keep a dwell', () => {
  const { settings } = makeBook();
  assert.equal(settings.get().dwellSeconds, undefined);
});

test('an open book accepts a message and records it in The Book', () => {
  const { book, pushed } = makeBook();
  const result = book.send({ text: 'Thanks for dinner', name: 'Ada' }, { ip: '1.2.3.4' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'shown');
  assert.equal(result.message, 'Your message is up.');
  assert.equal(result.dwellSeconds, undefined);
  assert.equal(pushed[0].payload.type, 'guest.book');
  assert.equal(pushed[0].payload.dwellSeconds, undefined);
  assert.equal(book.list()[0].name, 'Ada');
  assert.equal(book.list()[0].ip.includes('1.2'), true);
  assert.equal(book.list()[0].ip.includes('3.4'), false);
});

test('pause closes the page and refuses sends', () => {
  const { book, settings } = makeBook({ settings: { paused: true } });
  assert.equal(book.publicStatus().closed, true);
  const result = book.send({ text: 'Hello' }, { ip: '1.2.3.4' });
  assert.equal(result.ok, false);
  assert.match(result.error, /closed/i);
  assert.equal(settings.get().paused, true);
});

test('turning the rate limit off lets a guest send again immediately', () => {
  const { book } = makeBook({ settings: { rateLimitEnabled: false } });
  for (let i = 0; i < 4; i += 1) {
    const result = book.send({ text: `Hi ${i}` }, { ip: '9.9.9.9' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.remaining, null);
  }
});

test('the per-guest rate says how long to wait, without publishing the cap', () => {
  let now = 1_000_000;
  const { book } = makeBook({ now: () => now });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(book.send({ text: `Hi ${i}` }, { ip: '9.9.9.9' }).ok, true);
  }
  const blocked = book.send({ text: 'Too many' }, { ip: '9.9.9.9' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSeconds, 600);
  assert.match(blocked.error, /10 minutes/i);
  assert.doesNotMatch(blocked.error, /\b3\b/);
  now += 120_000;
  const later = book.send({ text: 'Still waiting' }, { ip: '9.9.9.9' });
  assert.equal(later.retryAfterSeconds, 480);
  assert.match(later.error, /8 minutes/i);
});

test('a blocked word is refused without naming it', () => {
  const { book } = makeBook({
    settings: { blockedWordsEnabled: true, blockedWords: ['secret'] },
  });
  const result = book.send({ text: 'the secret plan' }, { ip: '1.1.1.1' });
  assert.equal(result.ok, false);
  assert.equal(result.error, "That message can't be shown");
  assert.equal(wordBlocked('the secret plan', ['secret']), true);
});

test('password mode needs an unlock cookie before send', () => {
  const { book, settings } = makeBook({ settings: { whoCanSend: 'password', password: 'house' } });
  assert.ok(settings.get().passwordHash);
  const locked = book.send({ text: 'Hi' }, { ip: '8.8.8.8', req: { headers: {} } });
  assert.equal(locked.needsUnlock, true);
  const unlock = book.unlock({ password: 'house' }, '8.8.8.8');
  assert.equal(unlock.ok, true);
  const sent = book.send({ text: 'Hi again' }, {
    ip: '8.8.8.8',
    req: { headers: { cookie: `${book.COOKIE_NAME}=${unlock.token}` } },
  });
  assert.equal(sent.ok, true);
});

test('quiet hours hold a message until the house wakes', () => {
  const { book, pushed } = makeBook({
    quietHours: { enabled: true, start: '22:00', end: '07:00' },
    now: () => Date.parse('2026-08-29T06:00:00-06:00'),
  });
  const result = book.send({ text: 'Late note' }, { ip: '2.2.2.2' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'held');
  assert.equal(pushed.length, 0);
  assert.equal(book.list()[0].status, 'held');
});

test('a painted grid is stored as design and keeps cell placement', () => {
  const { book, pushed } = makeBook();
  const rows = blankBoard();
  rows[0][0] = CHIPS.yellow;
  rows[2][10] = 8;
  const result = book.send({ rows, name: 'Luis' }, { ip: '4.4.4.4' });
  assert.equal(result.ok, true);
  const listed = book.list()[0];
  assert.equal(listed.source, 'design');
  assert.equal(listed.name, 'Luis');
  assert.match(listed.ip, /4\.4/);
  assert.equal(listed.rows[0][0], CHIPS.yellow);
  assert.equal(listed.rows[2][10], 8);
  assert.equal(listed.rows[4][8] || 0, 0, 'The Book keeps guest flaps without the house footer');
  assert.equal(listed.previewRows[4][8], CHIPS.red, 'preview shows the current invite footer');
  assert.equal(pushed[0].payload.rows[0][0], CHIPS.yellow);
  assert.equal(pushed[0].payload.rows[2][10], 8);
  assert.equal(pushed[0].payload.rows[4][8], CHIPS.red);
  assert.equal(pushed[0].payload.footerRows, null);
});

test('replay stamps the current short link onto a stored message', () => {
  let flapLabel = 'TINYURL.COM/OLDALIAS';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-book-'));
  const settings = createGuestBookSettings({
    ROOT: root,
    guestBookSettingsPath: path.join(root, 'settings.json'),
  });
  const pushed = [];
  const book = createGuestBook({
    ROOT: root,
    guestBookPath: path.join(root, 'book.json'),
  }, { warn() {} }, {
    getSettings: () => settings.get(),
    getShortlink: () => ({ flapLabel, display: flapLabel.toLowerCase() }),
    pushToBoard: (payload, options) => {
      pushed.push({ payload, options });
      return { boards: [{ accepted: 1, pending: 0 }] };
    },
    getTimeZone: () => 'America/Denver',
    getQuietHours: () => null,
    randomInt: () => 0,
  });
  const rows = blankBoard();
  rows[1][1] = 8;
  const sent = book.send({ rows, name: 'Luis' }, { ip: '5.5.5.5' });
  assert.equal(sent.ok, true);
  flapLabel = 'TINYURL.COM/WITTYBOARD';
  const replayed = book.replay(sent.entryId);
  assert.equal(replayed.ok, true);
  assert.equal(pushed[1].payload.rows[4][8], CHIPS.red);
  const { decodeCodes } = require('../src/vestaboard/encoder');
  assert.match(decodeCodes(pushed[1].payload.rows[5]), /WITTYBOARD/);
  assert.doesNotMatch(decodeCodes(pushed[1].payload.rows[5]), /OLDALIAS/);
});

test('public status exposes the locked invite so the guest page can preview it', () => {
  const { book } = makeBook();
  const status = book.publicStatus();
  assert.equal(status.inviteFooter, true);
  assert.equal(status.inviteReady, true);
  assert.equal(status.editableRows, 4);
  assert.equal(status.shortLabel, 'TINYURL.COM/WITTYBOARD');
  assert.equal(status.footerRows[4][8], CHIPS.red);
  assert.ok(status.footerRows[5].some((code) => code !== 0));
  assert.equal(status.dwellSeconds, undefined);
});

test('the invite payload is a full board with the short link', () => {
  const { book } = makeBook();
  const payload = book.invitePayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.type, 'guest.book.invite');
  assert.equal(payload.shortLabel, 'TINYURL.COM/WITTYBOARD');
  assert.equal(payload.rows[4][8], CHIPS.red);
  assert.doesNotMatch(decodeCodes(payload.rows[2]), /CODE/);
});

test('a board-code invite prints CODE and the pin on the board', () => {
  const { book } = makeBook({ settings: { whoCanSend: 'code' } });
  const payload = book.invitePayload();
  assert.equal(payload.ok, true);
  assert.match(decodeCodes(payload.rows[2]), /CODE 100000/);
  assert.equal(book.currentCode().pin, '100000');
});

test('guestClientIp prefers CF-Connecting-IP', () => {
  assert.equal(guestClientIp({
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '10.0.0.2' },
  }), '203.0.113.9');
});
