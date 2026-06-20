// Voice commands that start a household broadcast / announcement flow
const BROADCAST_VERB_RE = /\b(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)\b/i;

// Alexa follow-up prompts (two-step: "Alexa, broadcast" → "what's the message?")
const BROADCAST_PROMPT_RE = /(?:what(?:'s| is|'d)? (?:the |your )?(?:announcement|broadcast|message)|what would you like to (?:announce|broadcast)|say your (?:announcement|broadcast|message))/i;

const WAKE_WORD_ONLY_RE = /^(alexa|echo|computer|amazon|ziggy)$/i;

// Inline message after the command verb
const INLINE_MESSAGE_PATTERNS = [
  /\b(?:announce(?:ment)?|broadcast(?:ing)?)\s+(?:that\s+)?(.+)$/i,
  /\bmake an announcement(?: that)?\s+(.+)$/i,
  /\bsend an announcement(?: that)?\s+(.+)$/i,
];

// Command only — waits for a follow-up utterance
const COMMAND_ONLY_PATTERNS = [
  /^(?:announce(?:ment)?|broadcast(?:ing)?)(?:\s+to(?:\s+[\w\s]+)?)?$/i,
  /^(?:make|send) an announcement$/i,
];

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

function extractInlineBroadcastMessage(summary) {
  for (const pattern of INLINE_MESSAGE_PATTERNS) {
    const match = summary.match(pattern);
    if (!match) {
      continue;
    }

    const message = normalizeText(match[1]);
    if (message) {
      return message;
    }
  }

  return null;
}

function isBroadcastCommandOnly(summary) {
  return COMMAND_ONLY_PATTERNS.some((pattern) => pattern.test(summary));
}

function isBroadcastPrompt(response) {
  return BROADCAST_PROMPT_RE.test(response);
}

function createBroadcastRecord({
  message,
  device,
  source,
  trigger,
  timestamp,
  rawSummary,
  rawResponse,
}) {
  return {
    message: normalizeText(message),
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
    this.pendingAnnounceStartedAt = 0;
    this.seenActivityIds = new Set(seenActivityIds);
    this.seenOrder = [...seenActivityIds];
    this.lastRecordedTimestamp = lastRecordedTimestamp || 0;
    this.recordedFingerprints = new Set(recordedFingerprints);
    this.fingerprintFn = fingerprintFn;
  }

  getState() {
    return {
      seenActivityIds: [...this.seenOrder],
      lastRecordedTimestamp: this.lastRecordedTimestamp,
      recordedFingerprints: [...this.recordedFingerprints],
    };
  }

  isDuplicateContent(message, device) {
    if (!this.fingerprintFn) {
      return false;
    }
    return this.recordedFingerprints.has(this.fingerprintFn(message, device));
  }

  markRecorded(activityId, record) {
    if (activityId) {
      this.rememberActivity(activityId);
    }
    if (record?.timestamp > this.lastRecordedTimestamp) {
      this.lastRecordedTimestamp = record.timestamp;
    }
    if (this.fingerprintFn && record?.message) {
      this.recordedFingerprints.add(this.fingerprintFn(record.message, record.device));
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
    this.pendingAnnounceStartedAt = 0;
  }

  recordIfNew({ message, device, source, trigger, timestamp, rawSummary, rawResponse, activityId }) {
    if (this.isDuplicateContent(message, device)) {
      this.rememberActivity(activityId);
      return null;
    }

    this.clearPendingAnnounce();
    return createBroadcastRecord({
      message,
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

    const summary = normalizeText(activity?.description?.summary);
    const response = normalizeText(activity?.alexaResponse);
    const device = getDeviceName(activity);
    const utteranceType = activity?.data?.utteranceType;

    if (!summary && !response) {
      return null;
    }

    if (utteranceType === 'WAKE_WORD_ONLY' || WAKE_WORD_ONLY_RE.test(summary)) {
      return null;
    }

    if (BROADCAST_VERB_RE.test(summary)) {
      const inlineMessage = extractInlineBroadcastMessage(summary);
      if (inlineMessage) {
        return this.recordIfNew({
          message: inlineMessage,
          device,
          source: 'voice',
          trigger: 'broadcast-inline',
          timestamp,
          rawSummary: summary,
          rawResponse: response,
          activityId,
        });
      }

      if (isBroadcastCommandOnly(summary)) {
        this.pendingAnnounceDevice = device;
        this.pendingAnnounceStartedAt = timestamp;
        return null;
      }

      // Verb present but message shape unknown — still wait for follow-up
      this.pendingAnnounceDevice = device;
      this.pendingAnnounceStartedAt = timestamp;
      return null;
    }

    if (isBroadcastPrompt(response)) {
      this.pendingAnnounceDevice = device;
      this.pendingAnnounceStartedAt = timestamp;
      return null;
    }

    if (
      this.pendingAnnounceDevice
      && device === this.pendingAnnounceDevice
      && summary
      && timestamp >= this.pendingAnnounceStartedAt - 5000
      && Date.now() - this.pendingAnnounceStartedAt < 120000
    ) {
      return this.recordIfNew({
        message: summary,
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

module.exports = {
  BroadcastParser,
  getActivityId,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  isBroadcastPrompt,
};
