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

  const fingerprints = new Set();

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

    fingerprints.add(fingerprint(message, device));
  }

  result.recordedFingerprints = [...fingerprints];
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

  const fingerprints = new Set();
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
    const message = entry.message;
    const device = entry.device;

    if (!Number.isNaN(timestamp)) {
      result.lastRecordedTimestamp = Math.max(result.lastRecordedTimestamp, timestamp);
    }

    if (message && device) {
      fingerprints.add(fingerprint(message, device));
    }
  }

  result.recordedFingerprints = [...fingerprints];
  return result;
}

function mergeLogState(...sources) {
  const mergedFingerprints = new Set();
  let lastRecordedTimestamp = 0;

  for (const source of sources) {
    if (!source) {
      continue;
    }
    lastRecordedTimestamp = Math.max(lastRecordedTimestamp, source.lastRecordedTimestamp || 0);
    for (const fp of source.recordedFingerprints || []) {
      mergedFingerprints.add(fp);
    }
  }

  return {
    lastRecordedTimestamp,
    recordedFingerprints: [...mergedFingerprints],
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
  const mergedFingerprints = new Set([
    ...(saved.recordedFingerprints || []),
    ...fromLogs.recordedFingerprints,
  ]);

  return {
    seenActivityIds: Array.isArray(saved.seenActivityIds) ? saved.seenActivityIds : [],
    lastRecordedTimestamp: Math.max(saved.lastRecordedTimestamp || 0, fromLogs.lastRecordedTimestamp),
    recordedFingerprints: [...mergedFingerprints],
  };
}

function saveBridgeState(statePath, state) {
  ensureParentDir(statePath);

  const payload = {
    lastRecordedTimestamp: state.lastRecordedTimestamp || 0,
    seenActivityIds: (state.seenActivityIds || []).slice(-MAX_SEEN_IDS),
    recordedFingerprints: (state.recordedFingerprints || []).slice(-MAX_FINGERPRINTS),
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
