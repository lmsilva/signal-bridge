/**
 * Per-game settings. Re-read from disk on every get(), like Word Riddles.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  scramble: Object.freeze({
    lobbySeconds: 45,
    roundSeconds: 180,
    intermissionSeconds: 20,
    rounds: 3,
    inviteTtlMinutes: 60,
    idleTimeoutSeconds: 120,
    maxPlayers: 12,
    minSolutions: 30,
    duplicateRule: 'everyone',
    preferredAlias: 'WITTYGAME',
  }),
});

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitiseGame(id, raw = {}, base = DEFAULTS[id] || {}) {
  if (id !== 'scramble') {
    return { ...(base || {}), ...(raw && typeof raw === 'object' ? raw : {}) };
  }
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const alias = String(incoming.preferredAlias != null ? incoming.preferredAlias : base.preferredAlias || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return {
    lobbySeconds: clampInt(incoming.lobbySeconds, 10, 180, base.lobbySeconds),
    roundSeconds: clampInt(incoming.roundSeconds, 30, 600, base.roundSeconds),
    intermissionSeconds: clampInt(incoming.intermissionSeconds, 5, 120, base.intermissionSeconds),
    rounds: clampInt(incoming.rounds, 1, 8, base.rounds),
    inviteTtlMinutes: clampInt(incoming.inviteTtlMinutes, 5, 240, base.inviteTtlMinutes),
    idleTimeoutSeconds: clampInt(incoming.idleTimeoutSeconds, 30, 600, base.idleTimeoutSeconds),
    maxPlayers: clampInt(incoming.maxPlayers, 2, 24, base.maxPlayers),
    minSolutions: clampInt(incoming.minSolutions, 10, 80, base.minSolutions),
    duplicateRule: incoming.duplicateRule === 'cancel' ? 'cancel' : 'everyone',
    preferredAlias: alias.length >= 5 ? alias : (base.preferredAlias || 'WITTYGAME'),
  };
}

function createGameSettings(config = {}, log = console) {
  const settingsPath = config.gameSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '../..'), 'data', 'game-settings.json');

  function readFile() {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function writeFile(next) {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      log?.warn?.('Could not save game settings', error?.message || error);
    }
  }

  function get(gameId = '') {
    const raw = readFile();
    if (gameId) {
      return sanitiseGame(gameId, raw[gameId], DEFAULTS[gameId]);
    }
    const out = {};
    for (const id of Object.keys(DEFAULTS)) {
      out[id] = sanitiseGame(id, raw[id], DEFAULTS[id]);
    }
    return out;
  }

  function update(gameId, patch = {}) {
    const raw = readFile();
    const next = {
      ...raw,
      [gameId]: sanitiseGame(gameId, { ...raw[gameId], ...patch }, DEFAULTS[gameId]),
    };
    writeFile(next);
    return get(gameId);
  }

  return {
    get,
    update,
    path: settingsPath,
    DEFAULTS,
  };
}

module.exports = {
  DEFAULTS,
  sanitiseGame,
  createGameSettings,
};
