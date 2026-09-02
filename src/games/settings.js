/**
 * Per-game settings. Re-read from disk on every get(), like Word Riddles.
 *
 * The short-link alias is deliberately *not* per game. Every game sends phones
 * to the same `/games/` page and they sort themselves out by code, so one
 * alias is stored (under `scramble`, where it has always lived) and shared.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ALIAS = 'WITTYGAME';

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
    allowLateJoin: true,
    preferredAlias: DEFAULT_ALIAS,
  }),
  prompts: Object.freeze({
    // A longer lobby than Word Scramble on purpose: this one needs three
    // people before it can start, so the room gets more time to fill up.
    lobbySeconds: 90,
    roundSeconds: 90,
    votingSeconds: 45,
    intermissionSeconds: 20,
    rounds: 3,
    inviteTtlMinutes: 60,
    idleTimeoutSeconds: 180,
    maxPlayers: 12,
    minPlayers: 3,
    allowLateJoin: true,
  }),
  wheel: Object.freeze({
    lobbySeconds: 60,
    // Per-turn clock. The puzzle itself is capped by roundSeconds.
    turnSeconds: 30,
    roundSeconds: 300,
    intermissionSeconds: 20,
    rounds: 3,
    inviteTtlMinutes: 60,
    idleTimeoutSeconds: 180,
    maxPlayers: 8,
    minPlayers: 2,
    allowLateJoin: true,
  }),
});

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanAlias(value, fallback = DEFAULT_ALIAS) {
  const alias = String(value != null ? value : fallback || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return alias.length >= 5 ? alias : (fallback || DEFAULT_ALIAS);
}

function sanitiseScramble(incoming, base) {
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
    allowLateJoin: incoming.allowLateJoin != null
      ? incoming.allowLateJoin !== false
      : base.allowLateJoin !== false,
    preferredAlias: cleanAlias(incoming.preferredAlias, base.preferredAlias || DEFAULT_ALIAS),
  };
}

function sanitisePrompts(incoming, base) {
  return {
    lobbySeconds: clampInt(incoming.lobbySeconds, 20, 300, base.lobbySeconds),
    roundSeconds: clampInt(incoming.roundSeconds, 20, 300, base.roundSeconds),
    votingSeconds: clampInt(incoming.votingSeconds, 15, 240, base.votingSeconds),
    intermissionSeconds: clampInt(incoming.intermissionSeconds, 5, 120, base.intermissionSeconds),
    rounds: clampInt(incoming.rounds, 1, 8, base.rounds),
    inviteTtlMinutes: clampInt(incoming.inviteTtlMinutes, 5, 240, base.inviteTtlMinutes),
    idleTimeoutSeconds: clampInt(incoming.idleTimeoutSeconds, 30, 600, base.idleTimeoutSeconds),
    maxPlayers: clampInt(incoming.maxPlayers, 3, 24, base.maxPlayers),
    // Two players cannot hold a vote — each may only pick the other, so every
    // round ties. Three is the floor the game is allowed to run at.
    minPlayers: clampInt(incoming.minPlayers, 3, 12, base.minPlayers),
    allowLateJoin: incoming.allowLateJoin != null
      ? incoming.allowLateJoin !== false
      : base.allowLateJoin !== false,
  };
}

function sanitiseWheel(incoming, base) {
  return {
    lobbySeconds: clampInt(incoming.lobbySeconds, 20, 300, base.lobbySeconds),
    turnSeconds: clampInt(incoming.turnSeconds, 10, 120, base.turnSeconds),
    roundSeconds: clampInt(incoming.roundSeconds, 60, 900, base.roundSeconds),
    intermissionSeconds: clampInt(incoming.intermissionSeconds, 5, 120, base.intermissionSeconds),
    rounds: clampInt(incoming.rounds, 1, 8, base.rounds),
    inviteTtlMinutes: clampInt(incoming.inviteTtlMinutes, 5, 240, base.inviteTtlMinutes),
    idleTimeoutSeconds: clampInt(incoming.idleTimeoutSeconds, 30, 600, base.idleTimeoutSeconds),
    maxPlayers: clampInt(incoming.maxPlayers, 2, 24, base.maxPlayers),
    minPlayers: clampInt(incoming.minPlayers, 2, 12, base.minPlayers),
    allowLateJoin: incoming.allowLateJoin != null
      ? incoming.allowLateJoin !== false
      : base.allowLateJoin !== false,
  };
}

function sanitiseGame(id, raw = {}, base = DEFAULTS[id] || {}) {
  const incoming = raw && typeof raw === 'object' ? raw : {};
  const fallback = base || {};
  if (id === 'scramble') return sanitiseScramble(incoming, fallback);
  if (id === 'prompts') return sanitisePrompts(incoming, fallback);
  if (id === 'wheel') return sanitiseWheel(incoming, fallback);
  return { ...fallback, ...incoming };
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

  /** The one `/games/` short-link alias every game advertises. */
  function alias() {
    return get('scramble').preferredAlias || DEFAULT_ALIAS;
  }

  function setAlias(value) {
    return update('scramble', { preferredAlias: cleanAlias(value, alias()) }).preferredAlias;
  }

  return {
    get,
    update,
    alias,
    setAlias,
    path: settingsPath,
    DEFAULTS,
  };
}

module.exports = {
  DEFAULTS,
  DEFAULT_ALIAS,
  cleanAlias,
  sanitiseGame,
  createGameSettings,
};
