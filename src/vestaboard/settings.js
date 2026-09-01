// The board list, and the keys that open them.
//
// Boards are static config, not something that announces itself the way a
// Windows display client does. They live in `data/vestaboard-settings.json`
// and their keys go through the same encrypted secret box the Autodarts and
// YouTube credentials use, so a key never sits in plain text next to the
// config a user might paste into a support thread.
//
// Everything here applies live. Saving a board updates the running queue; it
// never asks for a restart.

const fs = require('fs');
const path = require('path');

const { createSecretBox } = require('../secret-box');
const { normalisePriorities } = require('./priorities');

const SIMULATOR_ID = 'sim';

const DEFAULTS = {
  enabled: true,
  simulator: false,
  baseUrl: '',
  dwellSeconds: 15,
  rateWindowSeconds: 15,
  minRotationGapSeconds: 600,
  transitionStrategy: null,
  quietHours: { start: '22:00', end: '07:00', enabled: true, remindOnStart: true },
  events: 'all',
  tokenEnv: '',
};

function cleanId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normaliseQuietHours(value) {
  if (value === null) {
    return { ...DEFAULTS.quietHours, enabled: false };
  }
  if (!value || typeof value !== 'object') {
    return { ...DEFAULTS.quietHours };
  }
  return {
    start: String(value.start || DEFAULTS.quietHours.start),
    end: String(value.end || DEFAULTS.quietHours.end),
    enabled: value.enabled !== false,
    remindOnStart: value.remindOnStart !== false,
  };
}

function normaliseEvents(value) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter(Boolean);
    return list.length ? list : 'all';
  }
  return 'all';
}

/** Fill in everything a queue and a transport need, whatever the caller left out. */
function normaliseBoard(input = {}) {
  const id = cleanId(input.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: String(input.name || '').trim() || 'Vestaboard',
    simulator: Boolean(input.simulator),
    enabled: input.enabled !== false,
    baseUrl: String(input.baseUrl || '').trim(),
    dwellSeconds: positive(input.dwellSeconds, DEFAULTS.dwellSeconds),
    rateWindowSeconds: positive(input.rateWindowSeconds, DEFAULTS.rateWindowSeconds),
    minRotationGapSeconds: positive(input.minRotationGapSeconds, DEFAULTS.minRotationGapSeconds),
    transitionStrategy: input.transitionStrategy || null,
    quietHours: normaliseQuietHours(input.quietHours),
    events: normaliseEvents(input.events),
    tokenEnv: String(input.tokenEnv || '').trim(),
    priorities: normalisePriorities(input.priorities),
  };
}

function createVestaboardSettings({
  config = {},
  log = console,
  secretBox = null,
  env = process.env,
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..', '..');
  const filePath = config.vestaboardSettingsPath
    || path.join(root, 'data', 'vestaboard-settings.json');

  const box = secretBox || createSecretBox({
    keyPath: path.resolve(path.dirname(filePath), 'secret.key'),
    env,
  });

  /** @type {Map<string, object>} */
  const boards = new Map();
  /** id -> encrypted key */
  const keys = new Map();
  const listeners = new Set();

  function emit(reason, board = null) {
    for (const listener of listeners) {
      try {
        listener(reason, board);
      } catch (error) {
        log?.warn?.('Vestaboard settings listener failed', error?.message || error);
      }
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {
        boards: [...boards.values()].map((board) => ({
          ...board,
          // The key never sits beside the config in the clear.
          key: keys.get(board.id) || null,
        })),
      };
      fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Vestaboard settings', error?.message || error);
    }
  }

  function load() {
    let stored = null;
    try {
      if (fs.existsSync(filePath)) {
        stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (error) {
      log?.warn?.('Could not read Vestaboard settings', error?.message || error);
    }

    for (const entry of stored?.boards || []) {
      const board = normaliseBoard(entry);
      if (!board) continue;
      boards.set(board.id, board);
      if (entry.key) {
        keys.set(board.id, entry.key);
      }
    }
  }

  /**
   * The simulator ships registered, so the feature is usable on a fresh
   * install with no hardware and nothing to configure.
   */
  function seedSimulator({ port, apiKey }) {
    const existing = boards.get(SIMULATOR_ID);
    const baseUrl = `http://127.0.0.1:${port}`;

    const board = normaliseBoard({
      ...(existing || {}),
      id: SIMULATOR_ID,
      name: existing?.name || 'Vestaboard Simulator',
      simulator: true,
      enabled: existing ? existing.enabled : true,
      // The simulator's port can move in config, so its URL is always derived.
      baseUrl,
    });

    const changed = !existing || JSON.stringify(existing) !== JSON.stringify(board);
    boards.set(SIMULATOR_ID, board);
    if (apiKey && box.decrypt(keys.get(SIMULATOR_ID) || null) !== apiKey) {
      keys.set(SIMULATOR_ID, box.encrypt(apiKey));
      persist();
      emit('key', board);
      return board;
    }
    if (changed) {
      persist();
      emit(existing ? 'update' : 'add', board);
    }
    return board;
  }

  function list() {
    return [...boards.values()].map((board) => ({ ...board }));
  }

  function get(id) {
    const board = boards.get(cleanId(id));
    return board ? { ...board } : null;
  }

  /**
   * The key for a board: an environment variable wins, so a deployment can
   * hold its credential outside the data directory entirely.
   */
  function keyFor(id) {
    const board = boards.get(cleanId(id));
    if (!board) return null;
    if (board.tokenEnv && env[board.tokenEnv]) {
      return String(env[board.tokenEnv]);
    }
    return box.decrypt(keys.get(board.id) || null);
  }

  function hasKey(id) {
    return Boolean(keyFor(id));
  }

  function setKey(id, key) {
    const board = boards.get(cleanId(id));
    if (!board) return false;
    if (key) {
      keys.set(board.id, box.encrypt(key));
    } else {
      keys.delete(board.id);
    }
    persist();
    emit('key', { ...board });
    return true;
  }

  function upsert(input) {
    const existing = boards.get(cleanId(input?.id));
    const merged = { ...(input || {}) };
    // Edit / Quiet Hours Reminder omit this field — keep the saved list.
    if (!Object.prototype.hasOwnProperty.call(input || {}, 'priorities') && existing) {
      merged.priorities = existing.priorities;
    }
    const board = normaliseBoard(merged);
    if (!board) {
      return { ok: false, error: 'A board needs an id' };
    }
    if (existing?.simulator) {
      // The simulator's identity and address are ours, not the user's; only
      // the parts that make sense to tune are taken from the form.
      board.simulator = true;
      board.baseUrl = existing.baseUrl;
    }
    boards.set(board.id, board);

    if (typeof input?.key === 'string' && input.key.trim()) {
      keys.set(board.id, box.encrypt(input.key.trim()));
    }

    persist();
    emit(existing ? 'update' : 'add', { ...board });
    return { ok: true, board: { ...board }, created: !existing };
  }

  function remove(id) {
    const board = boards.get(cleanId(id));
    if (!board) {
      return { ok: false, error: 'Unknown board' };
    }
    if (board.simulator) {
      return { ok: false, error: 'The simulator cannot be removed — switch it off instead' };
    }
    boards.delete(board.id);
    keys.delete(board.id);
    persist();
    emit('remove', { ...board });
    return { ok: true };
  }

  function setEnabled(id, enabled) {
    const board = boards.get(cleanId(id));
    if (!board) {
      return { ok: false, error: 'Unknown board' };
    }
    board.enabled = Boolean(enabled);
    persist();
    emit('update', { ...board });
    return { ok: true, board: { ...board } };
  }

  load();

  return {
    filePath,
    SIMULATOR_ID,
    list,
    get,
    upsert,
    remove,
    setEnabled,
    keyFor,
    hasKey,
    setKey,
    seedSimulator,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  createVestaboardSettings,
  normaliseBoard,
  normaliseQuietHours,
  normaliseEvents,
  cleanId,
  SIMULATOR_ID,
  DEFAULTS,
};
