// Voice commands that start a household broadcast / announcement flow
const BROADCAST_VERB_RE = /\b(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)\b/i;

// Alexa follow-up prompts (two-step: "Alexa, broadcast" → "what's the message?")
const BROADCAST_PROMPT_RE = /(?:what(?:'s| is|'d)? (?:the |your )?(?:announcement|broadcast|message)|what would you like to (?:announce|broadcast|say)|say your (?:announcement|broadcast|message))/i;

const WAKE_WORD_ONLY_RE = /^(alexa|echo|computer|amazon|ziggy)$/i;

// How long an identical message+device fingerprint is treated as a duplicate.
// This only needs to bridge the gap between a push event and the later
// history-poll record of the *same* utterance (usually seconds); it must
// NOT be permanent or a deliberately repeated broadcast (e.g. "this is a
// test", sent again minutes/hours later) would never display again.
const DUPLICATE_CONTENT_WINDOW_MS = 2 * 60 * 1000;

const {
  parseBroadcastUtterance,
  resolveBroadcastUtterance,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  cleanBroadcastMessage,
  isAnnounceCompleteResponse,
} = require('./broadcast-parse');
const { extractActivityFields } = require('./activity-fields');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getActivityId(activity) {
  return (
    activity?.data?.recordKey
    || activity?.id
    || `${activity?.creationTimestamp || 0}:${activity?.description?.summary || ''}:${activity?.alexaResponse || ''}`
  );
}

function getDeviceName(activity) {
  return activity?.name || activity?.deviceSerialNumber || 'unknown-device';
}

function isBroadcastPrompt(response) {
  return BROADCAST_PROMPT_RE.test(response);
}

function createBroadcastRecord({
  message,
  destination,
  device,
  source,
  trigger,
  timestamp,
  rawSummary,
  rawResponse,
}) {
  return {
    message: normalizeText(message),
    destination: destination ? normalizeText(destination) : null,
    device,
    source,
    trigger,
    timestamp: timestamp || Date.now(),
    rawSummary: normalizeText(rawSummary),
    rawResponse: normalizeText(rawResponse),
  };
}

class BroadcastParser {
  constructor({
    seenActivityIds = [],
    lastRecordedTimestamp = 0,
    recordedFingerprints = [],
    fingerprintFn = null,
  } = {}) {
    this.pendingAnnounceDevice = null;
    this.pendingAnnounceDestination = null;
    this.pendingAnnounceStartedAt = 0;
    this.seenActivityIds = new Set(seenActivityIds);
    this.seenOrder = [...seenActivityIds];
    this.lastRecordedTimestamp = lastRecordedTimestamp || 0;
    // Map<fingerprint, lastSeenAtMs> — see DUPLICATE_CONTENT_WINDOW_MS.
    this.recordedFingerprints = new Map();
    for (const entry of recordedFingerprints) {
      if (typeof entry === 'string') {
        // Legacy persisted shape (no per-fingerprint timestamp) — treat as
        // already-expired rather than guessing a recent time.
        this.recordedFingerprints.set(entry, 0);
      } else if (entry?.fp) {
        this.recordedFingerprints.set(entry.fp, entry.ts || 0);
      }
    }
    this.fingerprintFn = fingerprintFn;
  }

  getState() {
    return {
      seenActivityIds: [...this.seenOrder],
      lastRecordedTimestamp: this.lastRecordedTimestamp,
      recordedFingerprints: [...this.recordedFingerprints.entries()].map(([fp, ts]) => ({ fp, ts })),
    };
  }

  isDuplicateContent(message, device, timestamp = Date.now()) {
    if (!this.fingerprintFn) {
      return false;
    }
    const lastSeenAt = this.recordedFingerprints.get(this.fingerprintFn(message, device));
    if (lastSeenAt === undefined) {
      return false;
    }
    return Math.abs(timestamp - lastSeenAt) < DUPLICATE_CONTENT_WINDOW_MS;
  }

  markRecorded(activityId, record) {
    if (activityId) {
      this.rememberActivity(activityId);
    }
    if (record?.timestamp > this.lastRecordedTimestamp) {
      this.lastRecordedTimestamp = record.timestamp;
    }
    if (this.fingerprintFn && record?.message) {
      this.recordedFingerprints.set(
        this.fingerprintFn(record.message, record.device),
        record.timestamp || Date.now(),
      );
    }
  }

  rememberActivity(activityId) {
    if (!activityId || this.seenActivityIds.has(activityId)) {
      return false;
    }

    this.seenActivityIds.add(activityId);
    this.seenOrder.push(activityId);

    while (this.seenOrder.length > 200) {
      const oldest = this.seenOrder.shift();
      this.seenActivityIds.delete(oldest);
    }

    return true;
  }

  clearPendingAnnounce() {
    this.pendingAnnounceDevice = null;
    this.pendingAnnounceDestination = null;
    this.pendingAnnounceStartedAt = 0;
  }

  setPendingAnnounce(device, timestamp, destination = null) {
    this.pendingAnnounceDevice = device;
    this.pendingAnnounceDestination = destination || null;
    this.pendingAnnounceStartedAt = timestamp;
  }

  recordIfNew({
    message,
    destination,
    device,
    source,
    trigger,
    timestamp,
    rawSummary,
    rawResponse,
    activityId,
  }) {
    if (this.isDuplicateContent(message, device, timestamp)) {
      this.rememberActivity(activityId);
      return null;
    }

    this.clearPendingAnnounce();
    return createBroadcastRecord({
      message,
      destination,
      device,
      source,
      trigger,
      timestamp,
      rawSummary,
      rawResponse,
    });
  }

  parseActivity(activity) {
    const activityId = getActivityId(activity);
    const timestamp = activity?.creationTimestamp || Date.now();
    const fields = extractActivityFields(activity);
    // Customer ASR only — never fall back to allText. That string includes
    // Alexa TTS, so a two-step completion ("Announcing on all devices") was
    // recorded as the household message and then hid the real follow-up.
    const summary = fields.summary;
    const response = fields.response;
    const customerParts = fields.customerParts || [];
    const device = getDeviceName(activity);
    const utteranceType = fields.utteranceType || activity?.data?.utteranceType;
    const announceComplete = isAnnounceCompleteResponse(response);

    const looksLikeBroadcast = Boolean(
      BROADCAST_VERB_RE.test(summary)
      || customerParts.some((part) => BROADCAST_VERB_RE.test(part))
      || isBroadcastPrompt(response)
      || announceComplete
      || (this.pendingAnnounceDevice && messageLooksLikeFollowUp(summary, customerParts))
    );

    // lastRecordedTimestamp is a history-window hint, not a hard gate for
    // in-flight two-step follow-ups. A later one-shot (or Date.now() stamp)
    // used to drop earlier announce completions.
    if (timestamp <= this.lastRecordedTimestamp && !looksLikeBroadcast) {
      this.rememberActivity(activityId);
      return null;
    }

    if (!this.rememberActivity(activityId)) {
      return null;
    }

    if (!summary && !response && customerParts.length === 0) {
      return null;
    }

    if (utteranceType === 'WAKE_WORD_ONLY' || WAKE_WORD_ONLY_RE.test(summary)) {
      return null;
    }

    const pendingFresh = Boolean(
      this.pendingAnnounceDevice
      && timestamp >= this.pendingAnnounceStartedAt - 5000
      && Date.now() - this.pendingAnnounceStartedAt < 120000
    );
    // Household arbitration often attributes the spoken message to a
    // different Echo than the one that asked "what would you like to announce?"
    const pendingDeviceOk = pendingFresh && (
      device === this.pendingAnnounceDevice
      || announceComplete
    );
    const pendingFollowUp = Boolean(
      pendingDeviceOk
      && messageLooksLikeFollowUp(summary, customerParts)
    );

    // Prefer completing a pending two-step announce before treating a
    // comma-joined ", broadcast …" echo as a new broadcast verb utterance.
    if (pendingFollowUp) {
      const message = extractFollowUpMessage(summary, customerParts);
      if (!message) {
        return null;
      }
      return this.recordIfNew({
        message,
        destination: this.pendingAnnounceDestination,
        device,
        source: 'voice',
        trigger: 'broadcast-followup',
        timestamp,
        rawSummary: summary,
        rawResponse: response,
        activityId,
      });
    }

    if (BROADCAST_VERB_RE.test(summary) || customerParts.some((part) => BROADCAST_VERB_RE.test(part))) {
      const parsed = resolveBroadcastUtterance(summary, customerParts);
      if (parsed?.kind === 'inline' && parsed.message) {
        return this.recordIfNew({
          message: parsed.message,
          destination: parsed.destination,
          device,
          source: 'voice',
          trigger: 'broadcast-inline',
          timestamp,
          rawSummary: summary,
          rawResponse: response,
          activityId,
        });
      }

      if (parsed?.kind === 'command-only') {
        this.setPendingAnnounce(device, timestamp, parsed.destination);
        return null;
      }

      this.setPendingAnnounce(device, timestamp);
      return null;
    }

    if (isBroadcastPrompt(response)) {
      this.setPendingAnnounce(device, timestamp);
      return null;
    }

    // Completed announce whose customer text has no broadcast verb — the
    // follow-up arrived before the prompt, pending was cleared by a later
    // one-shot, or arbitration used a different device.
    if (announceComplete) {
      const message = extractFollowUpMessage(summary, customerParts);
      if (message) {
        return this.recordIfNew({
          message,
          destination: this.pendingAnnounceDestination,
          device,
          source: 'voice',
          trigger: this.pendingAnnounceDevice ? 'broadcast-followup' : 'broadcast-complete',
          timestamp,
          rawSummary: summary,
          rawResponse: response,
          activityId,
        });
      }
    }

    if (this.pendingAnnounceDevice && Date.now() - this.pendingAnnounceStartedAt > 120000) {
      this.clearPendingAnnounce();
    }

    return null;
  }
}

function extractFollowUpMessage(summary, customerParts = []) {
  const followUp = resolveBroadcastUtterance(summary, customerParts);
  if (followUp?.message && (followUp.kind === 'follow-up' || followUp.kind === 'inline')) {
    return followUp.message;
  }
  return cleanBroadcastMessage(summary);
}

function messageLooksLikeFollowUp(summary, customerParts = []) {
  const candidates = [normalizeText(summary), ...(customerParts || []).map((part) => normalizeText(part))]
    .filter(Boolean);
  for (const text of candidates) {
    if (!text || WAKE_WORD_ONLY_RE.test(text)) {
      continue;
    }
    // A trailing ", broadcast …" echo must not disqualify a real follow-up message.
    const cleaned = cleanBroadcastMessage(text);
    if (cleaned && !BROADCAST_VERB_RE.test(cleaned)) {
      return true;
    }
    if (!BROADCAST_VERB_RE.test(text) && cleaned) {
      return true;
    }
  }
  return false;
}

/**
 * History fetch start: keep the requested lookback, but never jump forward
 * to lastRecorded+1. After a newer one-shot, that collapse dropped earlier
 * two-step follow-ups still inside the lookback window.
 */
function historyPollStartMs(
  now,
  lookbackMs,
  lastRecordedTimestamp = 0,
  overlapMs = DUPLICATE_CONTENT_WINDOW_MS,
) {
  const lookbackStart = now - lookbackMs;
  if (!lastRecordedTimestamp) {
    return lookbackStart;
  }
  return Math.max(lookbackStart, lastRecordedTimestamp - overlapMs);
}

module.exports = {
  BroadcastParser,
  getActivityId,
  getDeviceName,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  isBroadcastPrompt,
  parseBroadcastUtterance,
  resolveBroadcastUtterance,
  cleanBroadcastMessage,
  historyPollStartMs,
  isAnnounceCompleteResponse,
};
