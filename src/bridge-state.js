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

function loadBridgeState(statePath, broadcastLogPath) {
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

  const fromLog = readBroadcastLog(broadcastLogPath);
  const mergedFingerprints = new Set([
    ...(saved.recordedFingerprints || []),
    ...fromLog.recordedFingerprints,
  ]);

  return {
    seenActivityIds: Array.isArray(saved.seenActivityIds) ? saved.seenActivityIds : [],
    lastRecordedTimestamp: Math.max(saved.lastRecordedTimestamp || 0, fromLog.lastRecordedTimestamp),
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
};
