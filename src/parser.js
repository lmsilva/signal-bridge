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
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
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

    if (timestamp <= this.lastRecordedTimestamp) {
      this.rememberActivity(activityId);
      return null;
    }

    if (!this.rememberActivity(activityId)) {
      return null;
    }

    const fields = extractActivityFields(activity);
    const summary = fields.summary || fields.allText;
    const response = fields.response;
    const device = getDeviceName(activity);
    const utteranceType = fields.utteranceType || activity?.data?.utteranceType;

    if (!summary && !response) {
      return null;
    }

    if (utteranceType === 'WAKE_WORD_ONLY' || WAKE_WORD_ONLY_RE.test(summary)) {
      return null;
    }

    if (BROADCAST_VERB_RE.test(summary)) {
      const parsed = parseBroadcastUtterance(summary);
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

    if (
      this.pendingAnnounceDevice
      && device === this.pendingAnnounceDevice
      && summary
      && messageLooksLikeFollowUp(summary)
      && timestamp >= this.pendingAnnounceStartedAt - 5000
      && Date.now() - this.pendingAnnounceStartedAt < 120000
    ) {
      return this.recordIfNew({
        message: summary,
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

    if (this.pendingAnnounceDevice && Date.now() - this.pendingAnnounceStartedAt > 120000) {
      this.clearPendingAnnounce();
    }

    return null;
  }
}

function messageLooksLikeFollowUp(summary) {
  const text = normalizeText(summary);
  if (!text) {
    return false;
  }
  if (BROADCAST_VERB_RE.test(text)) {
    return false;
  }
  if (WAKE_WORD_ONLY_RE.test(text)) {
    return false;
  }
  return true;
}

module.exports = {
  BroadcastParser,
  getActivityId,
  getDeviceName,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  isBroadcastPrompt,
  parseBroadcastUtterance,
};
