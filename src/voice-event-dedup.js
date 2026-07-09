const { parseAlarmStatusFromSpeech } = require('./vivint-alarm');const { parseNotificationsFromSpeech } = require('./alexa-notifications');
const { parseShoppingListFromSpeech } = require('./shopping-list');

const DEFAULT_DEDUP_MS = 120000;
const MAX_ENTRIES = 400;

function normalizePart(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Kinds that flow through the pending-response upgrade path can surface the
// same command under several activity ids (push event, history record, and the
// separate response record), so fingerprint them by content instead.
const CONTENT_FINGERPRINT_KINDS = new Set(['vivint-alarm', 'alexa-notifications']);

function voiceEventFingerprint(event) {
  if (!CONTENT_FINGERPRINT_KINDS.has(event?.kind)) {
    const activityId = normalizePart(event?.activityId);
    if (activityId) {
      return activityId;
    }
  }

  return [
    normalizePart(event?.kind),
    normalizePart(event?.device),
    normalizePart(event?.query),
  ].join('|');
}

function hasSpokenResponse(event) {
  return Boolean(normalizePart(event?.spokenResponse));
}

function contentSignature(event) {
  if (event?.kind === 'tesla-battery') {
    return normalizePart(event?.query) || 'tesla-battery';
  }

  if (event?.kind === 'tesla-dashboard') {
    return normalizePart(event?.query) || 'tesla-dashboard';
  }

  if (event?.kind === 'shopping-list') {
    const parsed = parseShoppingListFromSpeech(event?.spokenResponse, { query: event?.query });
    return String(parsed?.items?.length ?? '');
  }

  if (event?.kind === 'vivint-alarm') {
    const parsed = parseAlarmStatusFromSpeech(event?.spokenResponse, event?.query);
    return [parsed?.status || '', parsed?.mode || ''].join('|');
  }

  if (event?.kind === 'alexa-notifications') {
    const parsed = parseNotificationsFromSpeech(event?.spokenResponse);
    return String(parsed?.items?.length ?? '') + '|' + String(parsed?.empty ?? '');
  }

  return '';
}

function createVoiceEventDedup({ dedupMs = DEFAULT_DEDUP_MS } = {}) {
  const recent = new Map();

  function prune(now) {
    if (recent.size <= MAX_ENTRIES) {
      return;
    }

    const cutoff = now - dedupMs;
    for (const [key, entry] of recent) {
      if (entry.at < cutoff) {
        recent.delete(key);
      }
    }

    if (recent.size > MAX_ENTRIES) {
      const overflow = recent.size - MAX_ENTRIES;
      const keys = [...recent.keys()].slice(0, overflow);
      keys.forEach((key) => recent.delete(key));
    }
  }

  function shouldEmit(event, now = Date.now()) {
    const fingerprint = voiceEventFingerprint(event);
    if (!fingerprint || fingerprint === '||') {
      return true;
    }

    const spoken = hasSpokenResponse(event);
    const signature = contentSignature(event);
    const lastSeen = recent.get(fingerprint);
    if (lastSeen && now - lastSeen.at < dedupMs) {
      if (!lastSeen.hadResponse && spoken) {
        recent.set(fingerprint, { at: now, hadResponse: true, signature });
        // For content-fingerprinted kinds the signature fully describes the
        // rendered panel; a spoken-response upgrade that changes nothing on
        // screen would just replay the same display.
        if (CONTENT_FINGERPRINT_KINDS.has(event?.kind) && signature && signature === lastSeen.signature) {
          return false;
        }
        return true;
      }

      if (signature && signature !== lastSeen.signature) {
        recent.set(fingerprint, { at: now, hadResponse: spoken, signature });
        return true;
      }

      return false;
    }

    recent.set(fingerprint, { at: now, hadResponse: spoken, signature });
    prune(now);
    return true;
  }

  return {
    shouldEmit,
    voiceEventFingerprint,
    contentSignature,
  };
}

module.exports = {
  createVoiceEventDedup,
  voiceEventFingerprint,
  contentSignature,
  DEFAULT_DEDUP_MS,
};
