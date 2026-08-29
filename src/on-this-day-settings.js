/**
 * On This Day in History — house edits on top of the shipped corpus.
 *
 * Events live in `on-this-day-events.json`. This file remembers hidden shipped
 * ids, text/year overrides, custom additions, year-range filters, and recent
 * ids so a scheduled rotation does not feel stuck.
 */

const fs = require('fs');
const path = require('path');

const RECENT_CAP = 160;
const TEXT_MAX = 220;
const YEAR_MIN = -4000;
const YEAR_MAX = 2100;

const FALLBACK = {
  recentIds: [],
  hiddenIds: [],
  removedIds: [],
  overrides: {},
  custom: [],
  minYear: null,
  maxYear: null,
};

function cleanId(value) {
  return String(value || '').trim();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}

function cleanYear(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n === 0 || n < YEAR_MIN || n > YEAR_MAX) {
    return null;
  }
  return n;
}

function cleanMonth(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : null;
}

function cleanDay(value, month = 1) {
  const n = Math.round(Number(value));
  const max = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] || 31;
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
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
    const month = cleanMonth(row?.month);
    const day = cleanDay(row?.day, month || 1);
    const year = cleanYear(row?.year);
    const text = cleanText(row?.text);
    if (!month || !day || year == null || !text || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push({ id, month, day, year, text });
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
    const year = entry?.year != null ? cleanYear(entry.year) : null;
    if (!text && year == null) {
      continue;
    }
    out[key] = {};
    if (text) {
      out[key].text = text;
    }
    if (year != null) {
      out[key].year = year;
    }
  }
  return out;
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const incoming = raw || {};
  const recentSource = Array.isArray(incoming.recentIds) ? incoming.recentIds : base.recentIds;
  const minYear = incoming.minYear !== undefined
    ? cleanYear(incoming.minYear)
    : (base.minYear != null ? cleanYear(base.minYear) : null);
  const maxYear = incoming.maxYear !== undefined
    ? cleanYear(incoming.maxYear)
    : (base.maxYear != null ? cleanYear(base.maxYear) : null);
  return {
    recentIds: uniqueIds(recentSource).slice(-RECENT_CAP),
    hiddenIds: uniqueIds(incoming.hiddenIds != null ? incoming.hiddenIds : base.hiddenIds),
    removedIds: uniqueIds(incoming.removedIds != null ? incoming.removedIds : base.removedIds),
    overrides: sanitiseOverrides(incoming.overrides != null ? incoming.overrides : base.overrides),
    custom: sanitiseCustom(incoming.custom != null ? incoming.custom : base.custom),
    minYear,
    maxYear,
  };
}

function createOnThisDaySettings(config = {}, log = console) {
  const settingsPath = config.onThisDaySettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'on-this-day-settings.json');
  let current = {
    ...FALLBACK,
    overrides: {},
    custom: [],
    hiddenIds: [],
    removedIds: [],
    recentIds: [],
    minYear: null,
    maxYear: null,
  };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = sanitiseSettings({}, FALLBACK);
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), FALLBACK);
    } catch (error) {
      log?.warn?.('Could not read On This Day settings', error?.message || error);
      current = sanitiseSettings({}, FALLBACK);
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save On This Day settings', error?.message || error);
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
      minYear: current.minYear,
      maxYear: current.maxYear,
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
  YEAR_MIN,
  YEAR_MAX,
  FALLBACK,
  cleanText,
  cleanYear,
  cleanMonth,
  cleanDay,
  sanitiseSettings,
  createOnThisDaySettings,
};
