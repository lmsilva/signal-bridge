/**
 * Plex Media Server session client.
 *
 * One GET to /status/sessions. The token never logs. Failures return a
 * classified error (auth / http / network) so a dead server is not a stop.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;
const PRODUCT = 'Signal Bridge';
const CLIENT_ID = 'signal-bridge';

function bridgeVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function normaliseServerUrl(serverUrl) {
  return String(serverUrl || '').trim().replace(/\/+$/, '');
}

function plexError(message, { status = 0, kind = 'network' } = {}) {
  const error = new Error(message);
  error.status = status;
  error.kind = kind;
  return error;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status >= 500) {
    return 'http';
  }
  return 'http';
}

function sessionsUrl(serverUrl) {
  return `${normaliseServerUrl(serverUrl)}/status/sessions`;
}

function plexHeaders(token, { version = bridgeVersion() } = {}) {
  return {
    Accept: 'application/json',
    'X-Plex-Token': String(token || ''),
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': version,
  };
}

function asArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function playerOf(entry) {
  const player = entry?.Player || entry?.player || {};
  return {
    address: String(player.address || '').trim(),
    name: String(player.title || player.name || '').trim(),
    product: String(player.product || '').trim(),
    state: String(player.state || '').trim().toLowerCase(),
  };
}

function criticScoreOf(entry) {
  const rating = Number(entry?.rating);
  if (Number.isFinite(rating)) {
    return rating;
  }
  const audience = Number(entry?.audienceRating);
  return Number.isFinite(audience) ? audience : null;
}

function parseSession(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const player = playerOf(entry);
  const duration = Number(entry.duration);
  const viewOffset = Number(entry.viewOffset);
  return {
    sessionKey: String(entry.sessionKey || '').trim(),
    type: String(entry.type || '').trim().toLowerCase(),
    title: String(entry.title || '').trim(),
    contentRating: entry.contentRating ? String(entry.contentRating).trim() : null,
    criticScore: criticScoreOf(entry),
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
    viewOffsetMs: Number.isFinite(viewOffset) && viewOffset >= 0 ? viewOffset : 0,
    player,
  };
}

function parseSessions(body) {
  const container = body?.MediaContainer || body?.mediacontainer || body || {};
  const metadata = asArray(container.Metadata || container.metadata);
  return metadata.map(parseSession).filter(Boolean);
}

async function fetchSessions({
  serverUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  version = bridgeVersion(),
} = {}) {
  const base = normaliseServerUrl(serverUrl);
  if (!base) {
    throw plexError('Plex server URL is empty', { kind: 'config' });
  }
  if (!String(token || '').trim()) {
    throw plexError('Plex token is empty', { kind: 'auth', status: 401 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(sessionsUrl(base), {
      method: 'GET',
      headers: plexHeaders(token, { version }),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      throw plexError(`Plex HTTP ${response.status}`, {
        status: response.status,
        kind: classifyStatus(response.status),
      });
    }
    return parseSessions(data);
  } catch (error) {
    if (error?.kind) {
      throw error;
    }
    if (error?.name === 'AbortError') {
      throw plexError('Plex request timed out', { kind: 'network' });
    }
    throw plexError(error?.message || 'Plex request failed', { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  PRODUCT,
  CLIENT_ID,
  bridgeVersion,
  normaliseServerUrl,
  sessionsUrl,
  plexHeaders,
  parseSession,
  parseSessions,
  fetchSessions,
};
