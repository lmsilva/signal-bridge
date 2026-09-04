/**
 * Bible Verse Of The Day - house edits on top of the shipped corpus.
 *
 * Verses live in `bible-verse-verses.json`. This file only remembers hidden
 * shipped ids, text/reference overrides, custom additions, and the recent-id
 * window so a scheduled rotation does not repeat itself.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 80;
const TEXT_MAX = 220;
const REFERENCE_MAX = 40;

const FALLBACK = {
  recentIds: [],
  hiddenIds: [],
  removedIds: [],
  overrides: {},
  custom: [],
};

function cleanId(value) {
  return String(value || '').trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

function cleanReference(value) {
  return String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REFERENCE_MAX);
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
    const text = cleanText(row?.text);
    const reference = cleanReference(row?.reference);
    if (!text || !reference || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, text, reference });
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
      const text = cleanText(entry);
      if (text) {
        out[key] = { text };
      }
      continue;
    }
    const text = entry?.text != null ? cleanText(entry.text) : null;
    const reference = entry?.reference != null ? cleanReference(entry.reference) : null;
    if (!text && !reference) {
      continue;
    }
    out[key] = {};
    if (text) {
      out[key].text = text;
    }
    if (reference) {
      out[key].reference = reference;
    }
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  return {
    recentIds: uniqueIds(recentSource).slice(-RECENT_CAP),
    hiddenIds: uniqueIds(incoming.hiddenIds != null ? incoming.hiddenIds : base.hiddenIds),
    removedIds: uniqueIds(incoming.removedIds != null ? incoming.removedIds : base.removedIds),
    overrides: sanitiseOverrides(incoming.overrides != null ? incoming.overrides : base.overrides),
    custom: sanitiseCustom(incoming.custom != null ? incoming.custom : base.custom),
  };
}

function createBibleVerseSettings(config = {}, log = console) {
  const settingsPath = config.bibleVerseSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'bible-verse-settings.json');
  let current = { ...FALLBACK, overrides: {}, custom: [], hiddenIds: [], removedIds: [], recentIds: [] };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Bible Verse settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Bible Verse settings', error?.message || error);
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
  TEXT_MAX,
  REFERENCE_MAX,
  FALLBACK,
  cleanText,
  cleanReference,
  sanitiseSettings,
  createBibleVerseSettings,
};
