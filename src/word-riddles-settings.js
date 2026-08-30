/**
 * Word Riddles — house edits on top of the shipped corpus.
 *
 * Riddles live in `word-riddles-riddles.json`. This file remembers hidden
 * shipped ids, riddle/answer overrides, custom additions, the recent-id
 * window, and the reveal delay between the riddle and the answer.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 80;
const RIDDLE_MAX = 220;
const ANSWER_MAX = 80;
const REVEAL_MIN = 10;
const REVEAL_MAX = 180;
const REVEAL_DEFAULT = 30;

const FALLBACK = {
  recentIds: [],
  hiddenIds: [],
  removedIds: [],
  overrides: {},
  custom: [],
  revealDelaySeconds: REVEAL_DEFAULT,
  showIntro: true,
};

function cleanId(value) {
  return String(value || '').trim();
}

function cleanText(value, max = RIDDLE_MAX) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanRiddle(value) {
  return cleanText(value, RIDDLE_MAX);
}

function cleanAnswer(value) {
  return cleanText(value, ANSWER_MAX);
}

function clampRevealDelay(value, fallback = REVEAL_DEFAULT) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(REVEAL_MAX, Math.max(REVEAL_MIN, n));
}

function uniqueIds(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitiseCustom(list) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const id = cleanId(row?.id) || `custom-${out.length + 1}`;
    const riddle = cleanRiddle(row?.riddle);
    const answer = cleanAnswer(row?.answer);
    if (!riddle || !answer || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, riddle, answer });
  }
  return out;
}

function sanitiseOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  for (const [id, entry] of Object.entries(value)) {
    const key = cleanId(id);
    if (!key) {
      continue;
    }
    if (typeof entry === 'string') {
      const riddle = cleanRiddle(entry);
      if (riddle) {
        out[key] = { riddle };
      }
      continue;
    }
    const riddle = entry?.riddle != null ? cleanRiddle(entry.riddle) : null;
    const answer = entry?.answer != null ? cleanAnswer(entry.answer) : null;
    if (!riddle && !answer) {
      continue;
    }
    out[key] = {};
    if (riddle) {
      out[key].riddle = riddle;
    }
    if (answer) {
      out[key].answer = answer;
    }
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  const showIntro = incoming.showIntro != null ? incoming.showIntro !== false : base.showIntro !== false;
  return {
    recentIds: uniqueIds(recentSource).slice(-RECENT_CAP),
    hiddenIds: uniqueIds(incoming.hiddenIds != null ? incoming.hiddenIds : base.hiddenIds),
    removedIds: uniqueIds(incoming.removedIds != null ? incoming.removedIds : base.removedIds),
    overrides: sanitiseOverrides(incoming.overrides != null ? incoming.overrides : base.overrides),
    custom: sanitiseCustom(incoming.custom != null ? incoming.custom : base.custom),
    revealDelaySeconds: clampRevealDelay(
      incoming.revealDelaySeconds != null ? incoming.revealDelaySeconds : base.revealDelaySeconds,
      REVEAL_DEFAULT,
    ),
    showIntro,
  };
}

function createWordRiddlesSettings(config = {}, log = console) {
  const settingsPath = config.wordRiddlesSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'word-riddles-settings.json');
  let current = sanitiseSettings({}, FALLBACK);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Word Riddles settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Word Riddles settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      recentIds: [...current.recentIds],
      hiddenIds: [...current.hiddenIds],
      removedIds: [...current.removedIds],
      overrides: { ...current.overrides },
      custom: current.custom.map((row) => ({ ...row })),
      revealDelaySeconds: current.revealDelaySeconds,
      showIntro: current.showIntro,
    }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return this.get();
    },
    remember(id) {
      const next = cleanId(id);
      if (!next) {
        return this.get();
      }
      const recentIds = current.recentIds.filter((item) => item !== next);
      recentIds.push(next);
      current = sanitiseSettings({ ...current, recentIds }, current);
      save();
      return this.get();
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  RECENT_CAP,
  RIDDLE_MAX,
  ANSWER_MAX,
  REVEAL_MIN,
  REVEAL_MAX,
  REVEAL_DEFAULT,
  FALLBACK,
  cleanText,
  cleanRiddle,
  cleanAnswer,
  clampRevealDelay,
  sanitiseSettings,
  createWordRiddlesSettings,
};
