/**
 * Shared Autodarts cloud rate-limit coordinator.
 *
 * All HTTP traffic through autodarts-api should honour pauses here so history
 * sync, board polling, token refresh, and WS tickets do not stampede the API.
 */

function messageLooksRateLimited(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('too many requests')
    || text.includes('rate limit')
    || text.includes('try again later');
}

function createAutodartsRateLimit({
  now = () => Date.now(),
  log = console,
  minIntervalMs = 500,
  defaultCooldownMs = 5 * 60 * 1000,
  maxCooldownMs = 60 * 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let pausedUntil = 0;
  let pauseReason = null;
  let lastRequestAt = 0;
  let consecutive429 = 0;

  function isRateLimitedStatus(status, json, text) {
    if (Number(status) === 429) return true;
    if (json && typeof json === 'object') {
      if (messageLooksRateLimited(json.message)) return true;
      if (typeof json.error === 'string' && messageLooksRateLimited(json.error)) return true;
      if (json.error && typeof json.error === 'object') {
        if (messageLooksRateLimited(json.error.message || json.error.code)) return true;
      }
    }
    return messageLooksRateLimited(text);
  }

  function parseRetryAfter(headers) {
    if (!headers) return null;
    const raw = typeof headers.get === 'function'
      ? (headers.get('retry-after') || headers.get('Retry-After'))
      : (headers['retry-after'] || headers['Retry-After']);
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const dateMs = Date.parse(String(raw));
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now());
    return null;
  }

  function cooldownMsFor429(headers) {
    const retryMs = parseRetryAfter(headers);
    if (retryMs != null && retryMs > 0) return Math.min(maxCooldownMs, retryMs);
    const scaled = defaultCooldownMs * (2 ** Math.min(Math.max(0, consecutive429 - 1), 4));
    return Math.min(maxCooldownMs, scaled);
  }

  function noteResponse({ status, json, text, headers } = {}) {
    if (!isRateLimitedStatus(status, json, text)) {
      if (Number(status) >= 200 && Number(status) < 300) consecutive429 = 0;
      return false;
    }
    consecutive429 += 1;
    const backoffMs = cooldownMsFor429(headers);
    pausedUntil = Math.max(pausedUntil, now() + backoffMs);
    pauseReason = String(
      json?.message
      || json?.error_description
      || (typeof json?.error === 'string' ? json.error : json?.error?.message)
      || text
      || 'Too many requests — try again later',
    ).trim().slice(0, 240);
    log?.warn?.('Autodarts API rate limited — pausing cloud requests', {
      status,
      backoffMs,
      until: new Date(pausedUntil).toISOString(),
    });
    return true;
  }

  function isPaused() {
    return now() < pausedUntil;
  }

  function snapshot() {
    return {
      paused: isPaused(),
      pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : null,
      reason: isPaused() ? pauseReason : null,
      consecutive429,
      minIntervalMs,
    };
  }

  function buildPausedError() {
    const err = new Error(pauseReason || 'Autodarts API paused — too many requests');
    err.code = 'AUTODARTS_RATE_LIMITED';
    err.pausedUntil = pausedUntil;
    return err;
  }

  function assertNotPaused() {
    if (isPaused()) throw buildPausedError();
  }

  async function waitForSlot() {
    while (isPaused()) {
      const remaining = pausedUntil - now();
      if (remaining <= 0) break;
      await sleep(Math.min(30_000, remaining));
    }
    const gap = minIntervalMs - (now() - lastRequestAt);
    if (gap > 0) await sleep(gap);
    lastRequestAt = now();
  }

  return {
    noteResponse,
    isPaused,
    snapshot,
    waitForSlot,
    assertNotPaused,
    isRateLimitedStatus,
    messageLooksRateLimited,
  };
}

module.exports = {
  createAutodartsRateLimit,
  messageLooksRateLimited,
};
