const fs = require('fs');
const path = require('path');

const AUTH_ERROR_PATTERNS = [
  { category: 'http_unauthorized', pattern: /\b401\b|unauthorized|not authenticated/i },
  { category: 'http_forbidden', pattern: /\b403\b|forbidden/i },
  { category: 'csrf_missing', pattern: /no csrf|csrf/i },
  { category: 'refresh_token_rejected', pattern: /no new access token|refresh token|refresh.*fail|former registration/i },
  { category: 'session_expired', pattern: /expired|invalid.*session|authentication invalid|login unsuccess/i },
  { category: 'rate_limited', pattern: /rate limit|too many requests|429/i },
  { category: 'network_error', pattern: /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|timeout|socket hang up/i },
  { category: 'amazon_api_change', pattern: /no body|unexpected|parse|html/i },
];

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

function createSessionAuthJournal({ config, log }) {
  const filePath = config.sessionAuthJournalPath || defaultJournalPath(config);
  let lastEvent = null;

  function ensureParentDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function append(event) {
    const entry = {
      ts: new Date().toISOString(),
      ...event,
    };
    lastEvent = entry;

    try {
      ensureParentDir();
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
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
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const lines = fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit);
      return lines.map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function getSummary() {
    const recent = readRecent(10);
    const failures = recent.filter((e) => e.level === 'warn' || e.level === 'error');
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
  };
}

module.exports = {
  createSessionAuthJournal,
  classifyAuthFailure,
  describeLikelyCause,
};
