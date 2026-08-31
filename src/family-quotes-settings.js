/**
 * Family Quotes — house edits on top of the shipped quotes.
 *
 * The quotes themselves live in `family-quotes-quotes.json`. This file only
 * remembers hidden shipped ids, text/author overrides, custom additions, and
 * the recent-id window so a scheduled rotation does not repeat itself.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 80;
const TEXT_MAX = 220;
const AUTHOR_MAX = 48;

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

function cleanAuthor(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, AUTHOR_MAX);
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
    if (!text || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, text, author: cleanAuthor(row?.author) });
  }
  return out;
}

/** An override may carry a new quote, a new author, or both. */
function sanitiseOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  for (const [id, raw] of Object.entries(value)) {
    const key = cleanId(id);
    if (!key || !raw || typeof raw !== 'object') {
      continue;
    }
    const patch = {};
    if (raw.text != null) {
      const text = cleanText(raw.text);
      if (text) {
        patch.text = text;
      }
    }
    if (raw.author != null) {
      patch.author = cleanAuthor(raw.author);
    }
    if (Object.keys(patch).length) {
      out[key] = patch;
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

function createFamilyQuotesSettings(config = {}, log = console) {
  const settingsPath = config.familyQuotesSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'family-quotes-settings.json');
  let current = sanitiseSettings({}, FALLBACK);

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read Family Quotes settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Family Quotes settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({
      recentIds: [...current.recentIds],
      hiddenIds: [...current.hiddenIds],
      removedIds: [...current.removedIds],
      overrides: Object.fromEntries(
        Object.entries(current.overrides).map(([id, patch]) => [id, { ...patch }]),
      ),
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
  AUTHOR_MAX,
  FALLBACK,
  cleanText,
  cleanAuthor,
  sanitiseSettings,
  createFamilyQuotesSettings,
};
