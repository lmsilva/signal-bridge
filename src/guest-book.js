/**
 * Guest Book — send a message to the Vestaboard from a phone.
 *
 * Public page is /guestbook/. Entries live in data/guest-book.json (The Book).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  layoutMessage,
  layoutRows,
  rowsToText,
  footerRows,
  stampInviteFooter,
  inviteScreenRows,
  blankBoard,
  CHARSET_HINT,
} = require('./guest-book-compose');
const { verifyPassword } = require('./guest-book-settings');
const { inQuietHours } = require('./vestaboard/queue');
const { clientIpFromRequest, normalizeClientIp } = require('./web-admin-auth');

function guestClientIp(req) {
  const cf = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  if (cf) {
    return normalizeClientIp(cf);
  }
  return clientIpFromRequest(req);
}

const COOKIE_NAME = 'signal_guestbook';
const SESSION_MS = 24 * 60 * 60 * 1000;
const LOCK_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function redactIp(ip) {
  const raw = String(ip || '');
  if (raw.includes('.')) {
    const parts = raw.split('.');
    return `${parts.slice(0, 2).join('.')}.■.■`;
  }
  if (raw.includes(':')) {
    return `${raw.split(':').slice(0, 3).join(':')}:■`;
  }
  return '■';
}

function waitCopy(seconds) {
  const minutes = Math.max(1, Math.ceil(Math.max(1, Number(seconds) || 1) / 60));
  return minutes === 1
    ? 'You can send again in about a minute.'
    : `You can send again in ${minutes} minutes.`;
}

function dayKey(nowMs, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

function wordBlocked(text, words) {
  const hay = ` ${String(text || '').toLowerCase()} `;
  return (words || []).some((word) => {
    const needle = String(word || '').trim().toLowerCase();
    return needle && hay.includes(` ${needle} `);
  });
}

function createGuestBook(config = {}, log = console, deps = {}) {
  const bookPath = config.guestBookPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'guest-book.json');
  const nowFn = deps.now || (() => Date.now());
  const getSettings = deps.getSettings || (() => ({}));
  const getShortlink = deps.getShortlink || (() => ({}));
  const pushToBoard = deps.pushToBoard || (() => ({ boards: [] }));
  const getTimeZone = deps.getTimeZone || (() => 'America/Denver');
  const getQuietHours = deps.getQuietHours || (() => null);
  const randomInt = deps.randomInt || ((max) => crypto.randomInt(max));

  let book = { entries: [], sends: [] };
  const sessions = new Map();
  const unlockFails = new Map();
  let boardCode = null;

  function load() {
    try {
      if (!fs.existsSync(bookPath)) {
        book = { entries: [], sends: [] };
        return;
      }
      const raw = JSON.parse(fs.readFileSync(bookPath, 'utf8'));
      book = {
        entries: Array.isArray(raw?.entries) ? raw.entries : [],
        sends: Array.isArray(raw?.sends) ? raw.sends : [],
      };
    } catch (error) {
      log?.warn?.('Could not read The Book', error?.message || error);
      book = { entries: [], sends: [] };
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(bookPath), { recursive: true });
      fs.writeFileSync(bookPath, `${JSON.stringify(book, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save The Book', error?.message || error);
    }
  }

  load();

  function currentCode() {
    const now = nowFn();
    if (boardCode && boardCode.expiresAt > now) {
      return boardCode;
    }
    const pin = String(100000 + (randomInt(900000))).slice(0, 6);
    boardCode = {
      pin,
      issuedAt: now,
      expiresAt: now + SESSION_MS,
    };
    return boardCode;
  }

  function publicStatus() {
    const settings = getSettings();
    const shortlink = getShortlink() || {};
    const enabled = settings.enabled !== false;
    const paused = Boolean(settings.paused);
    const shortLabel = shortlink.flapLabel || shortlink.display || '';
    const inviteFooter = settings.inviteFooter !== false && Boolean(shortLabel);
    return {
      enabled,
      paused,
      closed: !enabled || paused,
      closedReason: (!enabled || paused) ? 'The guest book is closed right now.' : '',
      whoCanSend: settings.whoCanSend || 'anyone',
      charsetHint: CHARSET_HINT,
      shortLabel,
      inviteFooter,
      editableRows: inviteFooter ? 4 : 6,
      footerRows: inviteFooter ? stampInviteFooter(blankBoard(), shortLabel) : null,
      inviteReady: Boolean(shortLabel),
      hasPassword: Boolean(settings.passwordHash),
    };
  }

  function sessionFromRequest(req) {
    const cookie = String(req?.headers?.cookie || '');
    const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    const token = match ? decodeURIComponent(match[1]) : '';
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt <= nowFn()) {
      if (token) sessions.delete(token);
      return null;
    }
    return session;
  }

  function issueSession() {
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = nowFn() + SESSION_MS;
    sessions.set(token, { expiresAt });
    return { token, expiresAt, setCookie: `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(SESSION_MS / 1000)}` };
  }

  function unlockAllowed(ip) {
    const row = unlockFails.get(ip);
    if (row && row.lockedUntil > nowFn()) {
      return { ok: false, error: 'Too many tries — wait 15 minutes', locked: true };
    }
    return { ok: true };
  }

  function recordUnlockFail(ip) {
    const row = unlockFails.get(ip) || { fails: 0, lockedUntil: 0 };
    row.fails += 1;
    if (row.fails >= LOCK_FAILS) {
      row.lockedUntil = nowFn() + LOCK_MS;
    }
    unlockFails.set(ip, row);
    return row;
  }

  function unlock({ password, code }, ip) {
    const settings = getSettings();
    const gate = unlockAllowed(ip);
    if (!gate.ok) {
      return gate;
    }
    const who = settings.whoCanSend || 'anyone';
    if (who === 'password') {
      if (!verifyPassword(password, settings.passwordHash)) {
        recordUnlockFail(ip);
        return { ok: false, error: 'That password is not right' };
      }
    } else if (who === 'code') {
      const want = currentCode().pin;
      if (String(code || '').replace(/\D/g, '') !== want) {
        recordUnlockFail(ip);
        return { ok: false, error: 'That code is not right' };
      }
    }
    unlockFails.delete(ip);
    return { ok: true, ...issueSession() };
  }

  function guestAllowed(req, ip) {
    const settings = getSettings();
    const who = settings.whoCanSend || 'anyone';
    if (who === 'anyone') {
      return { ok: true };
    }
    if (sessionFromRequest(req)) {
      return { ok: true };
    }
    return { ok: false, needsUnlock: true, error: 'This guest book is protected.' };
  }

  function rateState(ip, sessionId) {
    const settings = getSettings();
    const now = nowFn();
    const windowMs = (settings.rateWindowMinutes || 10) * 60 * 1000;
    const day = dayKey(now, getTimeZone());
    book.sends = book.sends.filter((row) => now - Number(row.at || 0) < 36 * 60 * 60 * 1000);
    const mine = book.sends.filter((row) => (
      now - Number(row.at || 0) < windowMs
      && (row.ip === ip || (sessionId && row.sessionId === sessionId))
    ));
    const today = book.sends.filter((row) => row.day === day);
    const remaining = Math.max(0, (settings.ratePerGuest || 3) - mine.length);
    let retryAfterSeconds = 0;
    if (remaining <= 0 && mine.length) {
      const oldest = Math.min(...mine.map((row) => Number(row.at) || 0));
      retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    }
    return {
      remaining,
      dailyLeft: Math.max(0, (settings.dailyCap || 100) - today.length),
      day,
      retryAfterSeconds,
      unlimited: settings.rateLimitEnabled === false,
    };
  }

  function appendEntry(entry) {
    book.entries.unshift(entry);
    book.entries = book.entries.slice(0, 2000);
    save();
    return entry;
  }

  function preview(body = {}) {
    if (Array.isArray(body.rows)) {
      const settings = getSettings();
      const shortlink = getShortlink() || {};
      const label = shortlink.flapLabel || shortlink.display || '';
      const lockFooter = settings.inviteFooter !== false && Boolean(label);
      return layoutRows(body.rows, { editableRows: lockFooter ? 4 : 6 });
    }
    return layoutMessage({
      text: body.text || body.message,
      name: body.name,
      align: body.align,
      valign: body.valign,
    });
  }

  function quietNow() {
    const hours = getQuietHours();
    if (!hours) {
      return false;
    }
    return inQuietHours(new Date(nowFn()), hours, getTimeZone());
  }

  function currentShortLabel() {
    const shortlink = getShortlink() || {};
    return shortlink.flapLabel || shortlink.display || '';
  }

  /**
   * Apply today's invite chrome to guest flaps. Design stamps in place;
   * message mode keeps a second page when the text is short enough.
   */
  function boardFramesFor(guestRows, source) {
    const settings = getSettings();
    const label = currentShortLabel();
    if (settings.inviteFooter === false || !label || !Array.isArray(guestRows)) {
      return { rows: guestRows, footerRows: null };
    }
    if (source === 'design') {
      return {
        rows: stampInviteFooter(guestRows, label) || guestRows,
        footerRows: null,
      };
    }
    return {
      rows: guestRows,
      footerRows: footerRows(guestRows, label),
    };
  }

  function previewRowsFor(entry) {
    const board = boardFramesFor(entry?.rows, entry?.source || 'design');
    if (board.footerRows) {
      return board.footerRows;
    }
    return board.rows;
  }

  function send(body, { ip, req } = {}) {
    const settings = getSettings();
    if (settings.enabled === false || settings.paused) {
      return { ok: false, error: 'The guest book is closed right now.', closed: true };
    }
    const gate = guestAllowed(req, ip);
    if (!gate.ok) {
      return gate;
    }
    const painted = Array.isArray(body.rows);
    const layout = preview(body);
    if (!layout.ok) {
      return { ok: false, error: layout.error || 'That message cannot be shown' };
    }
    const spoken = painted
      ? `${rowsToText(layout.rows)} ${body.name || ''}`
      : `${body.text || ''} ${body.name || ''}`;
    if (settings.blockedWordsEnabled && wordBlocked(spoken, settings.blockedWords)) {
      return { ok: false, error: "That message can't be shown" };
    }

    const session = sessionFromRequest(req);
    const rates = rateState(ip, session?.token);
    if (!rates.unlimited) {
      if (rates.remaining <= 0) {
        return {
          ok: false,
          error: waitCopy(rates.retryAfterSeconds),
          remaining: 0,
          retryAfterSeconds: rates.retryAfterSeconds,
        };
      }
      if (rates.dailyLeft <= 0) {
        return { ok: false, error: 'The guest book is full for today.', remaining: 0 };
      }
    }

    // Store the guest's flaps only. The invite chips/URL are house chrome —
    // stamped with the *current* short link when we push, preview, or replay.
    const guestRows = layout.rows;
    const source = painted ? 'design' : 'message';
    const board = boardFramesFor(guestRows, source);
    const quiet = quietNow();
    const wake = Boolean(settings.guestsMayWake);
    const waiting = Boolean(settings.approval);
    let status = 'shown';
    let guestMessage = 'Your message is up.';
    let vestaboard = null;

    if (waiting) {
      status = 'waiting';
      guestMessage = 'Your message is waiting for the host.';
    } else if (quiet && !wake) {
      status = 'held';
      guestMessage = 'Held until quiet hours end — it will appear in the morning.';
    } else {
      vestaboard = pushToBoard({
        type: 'guest.book',
        rows: board.rows,
        footerRows: board.footerRows,
        name: String(body.name || '').trim(),
      }, { quietHoursExempt: wake || !quiet });
      const accepted = (vestaboard?.boards || []).some((row) => Number(row.accepted) > 0);
      if (!accepted) {
        status = 'queued';
        guestMessage = 'The board is taking a nap — your message will appear when it wakes.';
      } else if ((vestaboard?.boards || []).some((row) => row.reason === 'queued' && Number(row.accepted) > 0)) {
        const pending = (vestaboard.boards || []).reduce((sum, row) => sum + (Number(row.pending) || 0), 0);
        if (pending > 1) {
          status = 'queued';
          guestMessage = 'Queued behind another message — it will flip up next.';
        }
      }
    }

    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      at: new Date(nowFn()).toISOString(),
      name: String(body.name || '').trim() || 'Anonymous',
      source,
      status,
      ip: redactIp(ip),
      ipRaw: ip,
      rows: guestRows,
      footerRows: null,
      text: painted ? rowsToText(guestRows) : String(body.text || body.message || ''),
      remaining: rates.unlimited ? null : Math.max(0, rates.remaining - 1),
    };
    book.sends.push({
      at: nowFn(),
      ip,
      sessionId: session?.token || '',
      day: rates.day,
    });
    appendEntry(entry);

    return {
      ok: true,
      status,
      message: guestMessage,
      remaining: entry.remaining,
      rows: board.rows,
      used: layout.used,
      entryId: entry.id,
      vestaboard,
    };
  }

  function list({ limit = 50 } = {}) {
    return book.entries.slice(0, Math.min(200, Number(limit) || 50)).map((entry) => ({
      id: entry.id,
      at: entry.at,
      name: entry.name,
      source: entry.source,
      status: entry.status,
      ip: entry.ip || '',
      rows: entry.rows,
      previewRows: previewRowsFor(entry),
    }));
  }

  function invitePayload() {
    const settings = getSettings();
    const shortlink = getShortlink() || {};
    const shortLabel = shortlink.flapLabel || shortlink.display || '';
    const pin = settings.whoCanSend === 'code' ? currentCode().pin : '';
    const rows = inviteScreenRows(shortLabel, { boardCode: pin });
    if (!rows) {
      return {
        ok: false,
        error: 'The guest book needs a short link before the invite can go up',
      };
    }
    return {
      ok: true,
      type: 'guest.book.invite',
      rows,
      shortLabel,
    };
  }

  function replay(id) {
    const entry = book.entries.find((row) => row.id === id);
    if (!entry) {
      return { ok: false, error: 'Unknown entry' };
    }
    const board = boardFramesFor(entry.rows, entry.source);
    const vestaboard = pushToBoard({
      type: 'guest.book',
      rows: board.rows,
      footerRows: board.footerRows,
      name: entry.name,
    }, { quietHoursExempt: true, explicit: true });
    entry.status = 'shown';
    save();
    return { ok: true, vestaboard, entry: { id: entry.id, status: entry.status } };
  }

  function remove(id) {
    const before = book.entries.length;
    book.entries = book.entries.filter((row) => row.id !== id);
    if (book.entries.length === before) {
      return { ok: false, error: 'Unknown entry' };
    }
    save();
    return { ok: true };
  }

  function flushHeld() {
    if (quietNow()) {
      return { flushed: 0 };
    }
    let flushed = 0;
    for (const entry of book.entries) {
      if (entry.status !== 'held') {
        continue;
      }
      const board = boardFramesFor(entry.rows, entry.source);
      pushToBoard({
        type: 'guest.book',
        rows: board.rows,
        footerRows: board.footerRows,
        name: entry.name,
      }, { quietHoursExempt: false });
      entry.status = 'shown';
      flushed += 1;
    }
    if (flushed) {
      save();
    }
    return { flushed };
  }

  let flushTimer = null;
  function start() {
    if (flushTimer || process.env.NODE_TEST_CONTEXT) {
      return;
    }
    flushTimer = setInterval(() => flushHeld(), 60_000);
    if (typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  }

  function stop() {
    if (!flushTimer) {
      return;
    }
    clearInterval(flushTimer);
    flushTimer = null;
  }

  return {
    publicStatus,
    preview,
    send,
    unlock,
    sessionFromRequest,
    list,
    invitePayload,
    replay,
    remove,
    flushHeld,
    currentCode,
    start,
    stop,
    COOKIE_NAME,
  };
}

module.exports = {
  createGuestBook,
  guestClientIp,
  redactIp,
  dayKey,
  wordBlocked,
  waitCopy,
  COOKIE_NAME,
};
