/**
 * Persisted Feature Presentation (Plex) settings.
 *
 * Admin save writes data/plex-settings.json and the watcher reloads on the
 * next tick. config.plex seeds defaults so a documented block still exists
 * in config.example.json. The token is never stored here.
 */

const fs = require('fs');
const path = require('path');
const { normaliseServerUrl } = require('./plex-api');

const FALLBACK = {
  enabled: false,
  serverUrl: '',
  monitoredPlayers: [],
  mediaTypes: ['movie'],
  pollIntervalMs: 15000,
  stopGraceMs: 30000,
  repushEndDriftMinutes: 5,
  pushOnStop: true,
  quietHoursExempt: true,
  showCriticScore: true,
  stateFile: 'data/plex-now-playing.json',
  localTimeZone: '',
};

function defaultSettings(config = {}) {
  const seed = config.plex || {};
  return sanitiseSettings({
    ...FALLBACK,
    ...seed,
  }, FALLBACK);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitisePlayers(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const ip = String(raw || '').trim();
    if (!ip || seen.has(ip)) {
      continue;
    }
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

function sanitiseMediaTypes(list, fallback = ['movie']) {
  const allowed = new Set(['movie', 'episode', 'show']);
  const out = [];
  for (const raw of Array.isArray(list) ? list : fallback) {
    const type = String(raw || '').trim().toLowerCase();
    if (allowed.has(type) && !out.includes(type)) {
      out.push(type);
    }
  }
  return out.length ? out : [...fallback];
}

function sanitiseSettings(raw = {}, base = FALLBACK) {
  const merged = { ...base, ...(raw || {}) };
  return {
    enabled: merged.enabled === true,
    serverUrl: normaliseServerUrl(merged.serverUrl),
    monitoredPlayers: sanitisePlayers(merged.monitoredPlayers),
    mediaTypes: sanitiseMediaTypes(merged.mediaTypes, base.mediaTypes),
    pollIntervalMs: clampInt(merged.pollIntervalMs, 5000, 120000, base.pollIntervalMs || 15000),
    stopGraceMs: clampInt(merged.stopGraceMs, 0, 300000, base.stopGraceMs || 30000),
    repushEndDriftMinutes: clampInt(
      merged.repushEndDriftMinutes, 1, 60, base.repushEndDriftMinutes || 5,
    ),
    pushOnStop: merged.pushOnStop !== false,
    quietHoursExempt: merged.quietHoursExempt !== false,
    showCriticScore: merged.showCriticScore !== false,
    stateFile: String(merged.stateFile || base.stateFile || 'data/plex-now-playing.json').trim(),
    localTimeZone: String(merged.localTimeZone || '').trim(),
  };
}

function createPlexSettings(config = {}, log = console) {
  const settingsPath = config.plexSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'plex-settings.json');
  const defaults = defaultSettings(config);
  let current = { ...defaults };

  function load() {
    try {
      if (!fs.existsSync(settingsPath)) {
        current = { ...defaults };
        return current;
      }
      current = sanitiseSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), defaults);
    } catch (error) {
      log?.warn?.('Could not read Plex settings', error?.message || error);
      current = { ...defaults };
    }
    return current;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Plex settings', error?.message || error);
    }
  }

  load();

  return {
    get: () => ({ ...current }),
    update(patch = {}) {
      current = sanitiseSettings({ ...current, ...patch }, current);
      save();
      return { ...current };
    },
    reload: load,
    path: settingsPath,
  };
}

module.exports = {
  defaultSettings,
  sanitiseSettings,
  createPlexSettings,
};
