const fs = require('fs');
const path = require('path');

const AUTH_ERROR_PATTERNS = [
  { category: 'cookie_renew_failed', pattern: /cookie invalid.*renew unsuccessful/i },
  { category: 'refresh_noop', pattern: /no tokens in register response/i },
  { category: 'http_unauthorized', pattern: /\b401\b|unauthorized|not authenticated/i },
  { category: 'http_forbidden', pattern: /\b403\b|forbidden/i },
  { category: 'csrf_missing', pattern: /no csrf|csrf/i },
  { category: 'refresh_token_rejected', pattern: /no new access token|refresh token|refresh.*fail|former registration/i },
  { category: 'network_error', pattern: /aggregateerror|enotfound|etimedout|econnreset|econnrefused|network|timeout|socket hang up/i },
  { category: 'session_expired', pattern: /expired|invalid.*session|authentication invalid|login unsuccess/i },
  { category: 'rate_limited', pattern: /rate limit|too many requests|429/i },
  { category: 'amazon_api_change', pattern: /no body|unexpected|parse|html/i },
];

/** Keep enough history for auth-status / health without unbounded RAM. */
const DEFAULT_RECENT_CAP = 40;
/** Soft cap before rewrite — a multi-year keepalive log used to hit tens of MB. */
const DEFAULT_MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const DEFAULT_MAX_KEEP_LINES = 3000;
/** First-pass tail window; grow if we still need more lines. */
const DEFAULT_TAIL_CHUNK = 256 * 1024;

function classifyAuthFailure(message, context = {}) {
  const text = String(message || '');
  for (const { category, pattern } of AUTH_ERROR_PATTERNS) {
    if (pattern.test(text)) {
      return {
        category,
        likelyCause: describeLikelyCause(category, context),
      };
    }
  }

  if (context.authenticated === false) {
    return {
      category: 'auth_check_failed',
      likelyCause: 'Amazon rejected the session cookie (checkAuthentication returned false).',
    };
  }

  return {
    category: 'unknown',
    likelyCause: 'Unclassified auth/API failure — inspect message and recent Amazon changes.',
  };
}

function describeLikelyCause(category, context = {}) {
  switch (category) {
    case 'http_unauthorized':
    case 'session_expired':
    case 'auth_check_failed':
      return 'Session cookie or refresh token is no longer valid; full re-auth via ./reauth.sh may be required.';
    case 'refresh_noop':
      return 'Amazon Register returned no new tokens — existing session is usually still valid.';
    case 'cookie_renew_failed':
      return 'Amazon could not renew the session cookie automatically; plan to re-auth before voice/history APIs stop working.';
    case 'refresh_token_rejected':
      return 'Automatic token refresh failed — refresh token revoked, password change, or Amazon security action.';
    case 'csrf_missing':
      return 'Session file is corrupt or incomplete; re-authenticate to obtain a fresh cookie.';
    case 'rate_limited':
      return 'Too many API requests; backoff may help but repeated failures need investigation.';
    case 'network_error':
      return 'Transient network/DNS issue between NAS and Amazon — not necessarily a dead session.';
    case 'http_forbidden':
      return 'Amazon blocked the request (WAF, IP flag, or API policy change).';
    case 'amazon_api_change':
      return 'Amazon may have changed an API response shape; library update or re-auth might be needed.';
    default:
      if (context.source === 'history_poll') {
        return 'Voice history API failed — often indicates auth drift if push also disconnected.';
      }
      return 'See journal message and surrounding health logs for context.';
  }
}

function defaultJournalPath(config) {
  return path.join(path.dirname(config.sessionPath), 'session-auth-journal.jsonl');
}

/**
 * Read the last `maxLines` of a JSONL file without loading the whole file.
 * Used for seed + rotation — never use a full-file read for recent summaries.
 */
function readLastLines(filePath, maxLines, {
  chunkBytes = DEFAULT_TAIL_CHUNK,
} = {}) {
  const want = Math.max(1, Number(maxLines) || 1);
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) {
      return [];
    }

    let pos = size;
    let collected = '';

    while (pos > 0) {
      const start = Math.max(0, pos - chunkBytes);
      const len = pos - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      collected = buf.toString('utf8') + collected;
      pos = start;

      // When we have not reached BOF, the leading fragment may be a partial line.
      const usableText = pos > 0
        ? (collected.includes('\n') ? collected.slice(collected.indexOf('\n') + 1) : '')
        : collected;
      const lines = usableText.split('\n').filter(Boolean);
      if (lines.length >= want || pos === 0) {
        return lines.slice(-want);
      }
    }

    return [];
  } catch {
    return [];
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function createSessionAuthJournal({
  config,
  log,
  recentCap = DEFAULT_RECENT_CAP,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxKeepLines = DEFAULT_MAX_KEEP_LINES,
} = {}) {
  const filePath = config.sessionAuthJournalPath || defaultJournalPath(config);
  const cap = Math.max(10, Number(recentCap) || DEFAULT_RECENT_CAP);
  const keepLines = Math.max(cap, Number(maxKeepLines) || DEFAULT_MAX_KEEP_LINES);
  const sizeCap = Math.max(64 * 1024, Number(maxFileBytes) || DEFAULT_MAX_FILE_BYTES);

  /** @type {object[]} */
  const recent = [];
  let lastEvent = null;
  let rotateInFlight = false;

  function ensureParentDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function pushRecent(entry) {
    recent.push(entry);
    while (recent.length > cap) {
      recent.shift();
    }
    lastEvent = entry;
  }

  function parseLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  function seedFromDisk() {
    const lines = readLastLines(filePath, cap);
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry) {
        pushRecent(entry);
      }
    }
  }

  function rotateIfNeeded() {
    if (rotateInFlight || !fs.existsSync(filePath)) {
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size < sizeCap) {
      return;
    }

    rotateInFlight = true;
    try {
      const lines = readLastLines(filePath, keepLines);
      ensureParentDir();
      const body = lines.length ? `${lines.join('\n')}\n` : '';
      fs.writeFileSync(filePath, body, 'utf8');
      log?.warn?.('Session auth journal rotated', {
        path: filePath,
        previousBytes: size,
        keptLines: lines.length,
      });
    } catch (err) {
      log?.error?.('Failed to rotate session auth journal', err.message || err);
    } finally {
      rotateInFlight = false;
    }
  }

  seedFromDisk();
  rotateIfNeeded();

  function append(event) {
    const entry = {
      ts: new Date().toISOString(),
      ...event,
    };
    pushRecent(entry);

    try {
      ensureParentDir();
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      rotateIfNeeded();
    } catch (err) {
      log?.error?.('Failed to write session auth journal', err.message || err);
    }

    const level = event.level || 'info';
    const summary = `[session-auth] ${entry.type}${entry.category ? ` (${entry.category})` : ''}: ${entry.message || entry.likelyCause || ''}`;
    if (level === 'error') {
      log?.error?.(summary, entry);
    } else if (level === 'warn') {
      log?.warn?.(summary, entry);
    } else {
      log?.info?.(summary, entry);
    }

    return entry;
  }

  function recordFailure({
    type,
    source,
    reason,
    message,
    context = {},
    sessionMeta = null,
    level = 'warn',
  }) {
    const classification = classifyAuthFailure(message || reason, { ...context, source });
    return append({
      type,
      level,
      source,
      reason,
      message: message || reason,
      category: classification.category,
      likelyCause: classification.likelyCause,
      context,
      sessionMeta,
    });
  }

  function recordSuccess({
    type,
    source,
    message,
    context = {},
    sessionMeta = null,
  }) {
    return append({
      type,
      level: 'info',
      source,
      message,
      context,
      sessionMeta,
    });
  }

  function readRecent(limit = 20) {
    const n = Math.max(1, Number(limit) || 20);
    if (recent.length) {
      return recent.slice(-n);
    }
    // Cold path if memory was empty (e.g. tests that wipe state) — still O(tail).
    return readLastLines(filePath, n).map(parseLine).filter(Boolean);
  }

  function getSummary() {
    const slice = readRecent(10);
    const failures = slice.filter((e) => e.level === 'warn' || e.level === 'error');
    return {
      path: filePath,
      lastEvent,
      recentFailureCount: failures.length,
      lastFailure: failures.length ? failures[failures.length - 1] : null,
    };
  }

  return {
    path: filePath,
    append,
    recordFailure,
    recordSuccess,
    readRecent,
    getSummary,
    classifyAuthFailure,
    /** @internal test/ops */
    rotateIfNeeded,
  };
}

module.exports = {
  createSessionAuthJournal,
  classifyAuthFailure,
  describeLikelyCause,
  readLastLines,
  DEFAULT_RECENT_CAP,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_KEEP_LINES,
};
