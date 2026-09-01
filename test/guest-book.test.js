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
  assert.equal(result.message, 'Your message has been pushed and will be displayed if outside quiet hours.');
  assert.equal(result.dwellSeconds, undefined);
  assert.equal(pushed[0].payload.type, 'guest.book');
  assert.equal(pushed[0].payload.dwellSeconds, undefined);
  assert.equal(book.list()[0].name, 'Ada');
  assert.equal(book.list()[0].ip, '1.2.3.4');
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
  assert.equal(listed.ip, '4.4.4.4');
  assert.equal(listed.rows[0][0], CHIPS.yellow);
  assert.equal(listed.rows[2][10], 8);
  assert.equal(listed.rows[4][8] || 0, 0, 'The Book keeps guest flaps without the house footer');
  assert.equal(listed.previewRows[4][8], CHIPS.red, 'preview shows the current invite footer');
  assert.equal(pushed[0].payload.rows[0][0], CHIPS.yellow);
  assert.equal(pushed[0].payload.rows[2][10], 8);
  assert.equal(pushed[0].payload.rows[4][8], CHIPS.red);
  assert.equal(pushed[0].payload.footerRows, null);
});

test('approval holds a message until the host releases it', () => {
  const { book, pushed } = makeBook({ settings: { approval: true } });
  const result = book.send({ text: 'Please post me', name: 'Ada' }, { ip: '1.2.3.4' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'waiting');
  assert.match(result.message, /waiting for the host/i);
  assert.equal(pushed.length, 0);
  assert.equal(book.count({ status: 'waiting' }), 1);
  assert.equal(book.list({ status: 'waiting' })[0].name, 'Ada');

  const released = book.release(result.entryId);
  assert.equal(released.ok, true);
  assert.equal(released.entry.status, 'released');
  assert.ok(released.entry.releasedAt);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.type, 'guest.book');
  assert.equal(book.count({ status: 'waiting' }), 0);
  assert.equal(book.count({ status: 'released' }), 1);
  assert.equal(book.release(result.entryId).ok, false);
  assert.equal(book.replay(result.entryId).ok, true);
});

test('replay refuses a waiting message — release it first', () => {
  const { book, pushed } = makeBook({ settings: { approval: true } });
  const result = book.send({ text: 'Hold me', name: 'Bea' }, { ip: '2.2.2.2' });
  assert.equal(result.status, 'waiting');
  const blocked = book.replay(result.entryId);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Release this message/i);
  assert.equal(pushed.length, 0);
});

test('three live guest messages each push without replacing the others', () => {
  const { book, pushed } = makeBook();
  assert.equal(book.send({ text: 'Hello one', name: 'A' }, { ip: '1.1.1.1' }).ok, true);
  assert.equal(book.send({ text: 'Hello two', name: 'B' }, { ip: '1.1.1.2' }).ok, true);
  assert.equal(book.send({ text: 'Hello three', name: 'C' }, { ip: '1.1.1.3' }).ok, true);
  assert.equal(pushed.length, 3);
  assert.equal(pushed[0].options.replaceSource, undefined);
  assert.equal(pushed[1].options.replaceSource, undefined);
  assert.equal(pushed[2].options.replaceSource, undefined);
  assert.match(String(pushed[0].payload.name), /A/);
  assert.match(String(pushed[1].payload.name), /B/);
  assert.match(String(pushed[2].payload.name), /C/);
});

test('releaseMany and replayMany queue older messages before newer ones', () => {
  let now = 1_000_000;
  const { book, pushed } = makeBook({
    settings: { approval: true },
    now: () => now,
  });
  const first = book.send({ text: 'Oldest', name: 'A' }, { ip: '1.1.1.1' });
  now += 60_000;
  const second = book.send({ text: 'Middle', name: 'B' }, { ip: '1.1.1.2' });
  now += 60_000;
  const third = book.send({ text: 'Newest', name: 'C' }, { ip: '1.1.1.3' });
  assert.equal(book.count({ status: 'waiting' }), 3);

  // Select newest-first in the request; the board still gets oldest first.
  const released = book.releaseMany([third.entryId, first.entryId, second.entryId]);
  assert.equal(released.ok, true);
  assert.equal(released.released, 3);
  assert.equal(pushed.length, 3);
  assert.match(String(pushed[0].payload.name), /A/);
  assert.match(String(pushed[1].payload.name), /B/);
  assert.match(String(pushed[2].payload.name), /C/);
  assert.equal(pushed[0].options.replaceSource, 'guest.book');
  assert.equal(pushed[0].options.breakHold, true);
  assert.equal(pushed[1].options.replaceSource, false);
  assert.equal(pushed[1].options.breakHold, false);
  assert.equal(pushed[2].options.replaceSource, false);

  pushed.length = 0;
  const again = book.replayMany([third.entryId, first.entryId]);
  assert.equal(again.ok, true);
  assert.equal(again.pushed, 2);
  assert.match(String(pushed[0].payload.name), /A/);
  assert.match(String(pushed[1].payload.name), /C/);
});

test('list paginates and remove can delete several entries at once', () => {
  const { book } = makeBook();
  for (let i = 0; i < 12; i += 1) {
    const rows = blankBoard();
    rows[0][0] = 1 + (i % 26);
    assert.equal(book.send({ rows, name: `Guest ${i}` }, { ip: `1.1.1.${i + 1}` }).ok, true);
  }
  assert.equal(book.count(), 12);
  assert.equal(book.list({ limit: 5, offset: 0 }).length, 5);
  assert.equal(book.list({ limit: 5, offset: 5 }).length, 5);
  assert.equal(book.list({ limit: 5, offset: 10 }).length, 2);

  const firstPage = book.list({ limit: 3, offset: 0 });
  const ids = firstPage.map((entry) => entry.id);
  const removed = book.remove(ids);
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, 3);
  assert.equal(book.count(), 9);
  assert.equal(book.remove('missing-id').ok, false);
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

test('always invite footer locks the last two rows on the public status', () => {
  const { book } = makeBook({ settings: { inviteFooter: 'always' } });
  const status = book.publicStatus();
  assert.equal(status.inviteFooterMode, 'always');
  assert.equal(status.editableRows, 4);
  assert.ok(status.footerRows);
});

test('whenRoom design leaves overwritten footer rows alone', () => {
  const { book, pushed } = makeBook({ settings: { inviteFooter: 'whenRoom' } });
  const rows = blankBoard();
  rows[0][0] = 8;
  rows[5][0] = 8; // guest wrote over the invite row
  const result = book.send({ rows, name: 'Luis' }, { ip: '4.4.4.4' });
  assert.equal(result.ok, true);
  assert.equal(pushed[0].payload.rows[5][0], 8);
  assert.equal(pushed[0].payload.rows[4][8] || 0, 0);
});

test('always invite footer stamps over the last two rows on send', () => {
  const { book, pushed } = makeBook({ settings: { inviteFooter: 'always' } });
  const rows = blankBoard();
  rows[0][0] = 8;
  rows[5][0] = 8;
  const result = book.send({ rows, name: 'Luis' }, { ip: '4.4.4.4' });
  assert.equal(result.ok, true);
  assert.equal(pushed[0].payload.rows[4][8], CHIPS.red);
  assert.notEqual(pushed[0].payload.rows[5][0], 8);
});

test('public status exposes the locked invite so the guest page can preview it', () => {
  const { book } = makeBook();
  const status = book.publicStatus();
  assert.equal(status.inviteFooter, true);
  assert.equal(status.inviteFooterMode, 'whenRoom');
  assert.equal(status.inviteReady, true);
  assert.equal(status.editableRows, 6);
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
