const fs = require('fs');
const path = require('path');

const MAX_SEEN_IDS = 500;
const MAX_FINGERPRINTS = 300;

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizePart(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fingerprint(message, device) {
  return `${normalizePart(device)}|${normalizePart(message)}`;
}

// `recordedFingerprints` entries carry the timestamp of the most recent
// occurrence (`{ fp, ts }`) so `BroadcastParser` can treat identical
// message+device content as a duplicate only within a short window (catches
// the same utterance being reported twice via push event + history poll)
// instead of forever — otherwise a deliberately repeated broadcast (e.g. a
// common test message like "this is a test") would never display again.
function addFingerprint(map, message, device, timestampMs) {
  if (!message || !device || Number.isNaN(timestampMs)) {
    return;
  }
  const fp = fingerprint(message, device);
  const existing = map.get(fp);
  if (existing === undefined || timestampMs > existing) {
    map.set(fp, timestampMs);
  }
}

function toFingerprintEntries(map) {
  return [...map.entries()].map(([fp, ts]) => ({ fp, ts }));
}

function readBroadcastLog(broadcastLogPath) {
  const result = {
    lastRecordedTimestamp: 0,
    recordedFingerprints: [],
  };

  if (!fs.existsSync(broadcastLogPath)) {
    return result;
  }

  const stats = fs.statSync(broadcastLogPath);
  if (stats.isDirectory()) {
    return result;
  }

  const lines = fs.readFileSync(broadcastLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const fingerprints = new Map();

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) {
      continue;
    }

    const timestamp = Date.parse(parts[0]);
    const message = parts[1];
    const device = parts[2];

    if (!Number.isNaN(timestamp)) {
      result.lastRecordedTimestamp = Math.max(result.lastRecordedTimestamp, timestamp);
    }

    addFingerprint(fingerprints, message, device, Number.isNaN(timestamp) ? 0 : timestamp);
  }

  result.recordedFingerprints = toFingerprintEntries(fingerprints);
  return result;
}

function readVoiceEventsLog(voiceEventsLogPath) {
  const result = {
    lastRecordedTimestamp: 0,
    recordedFingerprints: [],
  };

  if (!voiceEventsLogPath || !fs.existsSync(voiceEventsLogPath)) {
    return result;
  }

  const stats = fs.statSync(voiceEventsLogPath);
  if (stats.isDirectory()) {
    return result;
  }

  const fingerprints = new Map();
  const lines = fs.readFileSync(voiceEventsLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type !== 'broadcast') {
      continue;
    }

    const timestamp = Date.parse(entry.ts || entry.timestamp || '');

    if (!Number.isNaN(timestamp)) {
      result.lastRecordedTimestamp = Math.max(result.lastRecordedTimestamp, timestamp);
    }

    addFingerprint(fingerprints, entry.message, entry.device, Number.isNaN(timestamp) ? 0 : timestamp);
  }

  result.recordedFingerprints = toFingerprintEntries(fingerprints);
  return result;
}

function mergeLogState(...sources) {
  const mergedFingerprints = new Map();
  let lastRecordedTimestamp = 0;

  for (const source of sources) {
    if (!source) {
      continue;
    }
    lastRecordedTimestamp = Math.max(lastRecordedTimestamp, source.lastRecordedTimestamp || 0);
    for (const entry of source.recordedFingerprints || []) {
      const fp = typeof entry === 'string' ? entry : entry?.fp;
      const ts = typeof entry === 'string' ? 0 : (entry?.ts || 0);
      if (!fp) {
        continue;
      }
      const existing = mergedFingerprints.get(fp);
      if (existing === undefined || ts > existing) {
        mergedFingerprints.set(fp, ts);
      }
    }
  }

  return {
    lastRecordedTimestamp,
    recordedFingerprints: toFingerprintEntries(mergedFingerprints),
  };
}

function loadBridgeState(statePath, voiceEventsLogPath, { legacyBroadcastLogPaths = [] } = {}) {
  let saved = {
    seenActivityIds: [],
    lastRecordedTimestamp: 0,
    recordedFingerprints: [],
  };

  if (fs.existsSync(statePath)) {
    try {
      saved = { ...saved, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    } catch {
      // ignore corrupt state; rebuild from log
    }
  }

  const fromEventsLog = readVoiceEventsLog(voiceEventsLogPath);
  const legacySources = legacyBroadcastLogPaths.map((logPath) => readBroadcastLog(logPath));
  const fromLogs = mergeLogState(fromEventsLog, ...legacySources);
  const merged = mergeLogState(
    { recordedFingerprints: saved.recordedFingerprints || [] },
    fromLogs,
  );

  return {
    seenActivityIds: Array.isArray(saved.seenActivityIds) ? saved.seenActivityIds : [],
    lastRecordedTimestamp: Math.max(saved.lastRecordedTimestamp || 0, fromLogs.lastRecordedTimestamp),
    recordedFingerprints: merged.recordedFingerprints,
  };
}

function saveBridgeState(statePath, state) {
  ensureParentDir(statePath);

  // Keep only the most recently-seen fingerprints — with a short dedup
  // window (see parser.js) anything older is already inert, but capping
  // here still bounds file growth over the bridge's lifetime.
  const trimmedFingerprints = (state.recordedFingerprints || [])
    .slice()
    .sort((a, b) => (b?.ts || 0) - (a?.ts || 0))
    .slice(0, MAX_FINGERPRINTS);

  const payload = {
    lastRecordedTimestamp: state.lastRecordedTimestamp || 0,
    seenActivityIds: (state.seenActivityIds || []).slice(-MAX_SEEN_IDS),
    recordedFingerprints: trimmedFingerprints,
    savedAt: new Date().toISOString(),
  };

  fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = {
  loadBridgeState,
  saveBridgeState,
  fingerprint,
  readBroadcastLog,
  readVoiceEventsLog,
  mergeLogState,
};
