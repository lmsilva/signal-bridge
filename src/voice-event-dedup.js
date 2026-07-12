const { parseAlarmStatusFromSpeech } = require('./vivint-alarm');const { parseNotificationsFromSpeech } = require('./alexa-notifications');
const { parseShoppingListFromSpeech } = require('./shopping-list');

const DEFAULT_DEDUP_MS = 120000;
const MAX_ENTRIES = 400;
// History polls re-read the same activity records for the whole lookback
// window (15 min periodic), long after the rolling dedup window expires.
// Emitted activity *instants* (fingerprint + creation timestamp) are
// remembered longer so a re-read never re-displays, while a genuinely
// repeated command (new record → new timestamp) still shows.
const INSTANT_RETENTION_MS = 30 * 60 * 1000;
const MAX_INSTANT_ENTRIES = 800;

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

function activityInstantKey(event) {
  const ts = Number(event?.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return null;
  }
  return `${voiceEventFingerprint(event)}@${ts}`;
}

function createVoiceEventDedup({ dedupMs = DEFAULT_DEDUP_MS } = {}) {
  const recent = new Map();
  const seenInstants = new Map();

  function prune(now) {
    if (recent.size > MAX_ENTRIES) {
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

    if (seenInstants.size > MAX_INSTANT_ENTRIES) {
      const cutoff = now - INSTANT_RETENTION_MS;
      for (const [key, entry] of seenInstants) {
        if (entry.at < cutoff) {
          seenInstants.delete(key);
        }
      }
      if (seenInstants.size > MAX_INSTANT_ENTRIES) {
        const overflow = seenInstants.size - MAX_INSTANT_ENTRIES;
        const keys = [...seenInstants.keys()].slice(0, overflow);
        keys.forEach((key) => seenInstants.delete(key));
      }
    }
  }

  function rememberInstant(instantKey, entry) {
    if (instantKey) {
      seenInstants.set(instantKey, entry);
    }
  }

  function shouldEmit(event, now = Date.now()) {
    const fingerprint = voiceEventFingerprint(event);
    if (!fingerprint || fingerprint === '||') {
      return true;
    }

    const spoken = hasSpokenResponse(event);
    const signature = contentSignature(event);
    const instantKey = activityInstantKey(event);

    // A record we've already handled (same fingerprint AND same creation
    // timestamp) is a re-read from a later history poll, NOT the user asking
    // again — a genuine repeat produces a new record with a new timestamp.
    // Never re-display re-reads, however long ago the original was shown.
    // The only exception: a spoken-response upgrade shortly after the first
    // display, when Alexa's answer changes what's on screen.
    const priorSighting = instantKey ? seenInstants.get(instantKey) : null;
    if (priorSighting && now - priorSighting.at <= INSTANT_RETENTION_MS) {
      const upgrade = !priorSighting.hadResponse
        && spoken
        && now - priorSighting.at <= dedupMs
        && signature !== priorSighting.signature;
      if (!upgrade) {
        return false;
      }
      rememberInstant(instantKey, { at: priorSighting.at, hadResponse: true, signature });
      recent.set(fingerprint, { at: now, hadResponse: true, signature });
      return true;
    }

    const lastSeen = recent.get(fingerprint);
    if (lastSeen && now - lastSeen.at < dedupMs) {
      if (!lastSeen.hadResponse && spoken) {
        recent.set(fingerprint, { at: now, hadResponse: true, signature });
        rememberInstant(instantKey, { at: now, hadResponse: true, signature });
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
        rememberInstant(instantKey, { at: now, hadResponse: spoken, signature });
        return true;
      }

      // Suppressed duplicate — remember its instant so a post-window re-read
      // of this same record can't slip through and re-display later.
      rememberInstant(instantKey, { at: now, hadResponse: spoken, signature });
      return false;
    }

    recent.set(fingerprint, { at: now, hadResponse: spoken, signature });
    rememberInstant(instantKey, { at: now, hadResponse: spoken, signature });
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
