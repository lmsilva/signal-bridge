/**
 * Space Launch Alerts — upcoming launches from Launch Library 2.
 *
 * Free open API (The Space Devs), no key required. Responses are cached on
 * disk so pushes and scheduler ticks never hit the network in real time.
 */

const fs = require('fs');
const path = require('path');
const { fold } = require('./vestaboard/encoder');
const { alertRows, fitsBoard, cleanChip } = require('./space-launch-alerts-layout');
const {
  DEFAULT_SETTINGS,
  sanitiseSettings,
  createSpaceLaunchAlertsSettings,
} = require('./space-launch-alerts-settings');

const TYPE = 'launch.alert';
const LL2_UPCOMING = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/';
const USER_AGENT = 'Mozilla/5.0 (compatible; SignalBridge/1.0; +vestaboard)';
const DEFAULT_TIMEOUT_MS = 15000;
const FETCH_LIMIT = 60;
const SUCCESS_STATUS = new Set(['success', 'partial failure', 'failure']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitLaunchName(name) {
  const parts = String(name || '').split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { rocket: parts[0], mission: parts.slice(1).join(' | ') };
  }
  return { rocket: parts[0] || '', mission: parts[0] || '' };
}

function providerLabel(lsp = {}, pad = {}) {
  const name = fold(lsp.name || '');
  const country = String(pad.location?.country_code || pad.country_code || '').toUpperCase();
  if (/SPACEX/.test(name)) {
    return 'SPACEX';
  }
  if (/ROCKET LAB/.test(name)) {
    return 'ROCKET LAB';
  }
  if (/NASA/.test(name)) {
    return 'NASA';
  }
  if (/UNITED LAUNCH|ULA/.test(name)) {
    return 'ULA';
  }
  if (/BLUE ORIGIN/.test(name)) {
    return 'BLUE ORIGIN';
  }
  if (/ARIANE|Arianespace/.test(name)) {
    return 'ARIANE';
  }
  if (/ISRO|INDIA/.test(name) || country === 'IND') {
    return 'INDIA';
  }
  if (/JAXA/.test(name) || country === 'JPN') {
    return 'JAPAN';
  }
  if (/ROSCOSMOS/.test(name) || country === 'RUS') {
    return 'RUSSIA';
  }
  if (/CHINA|CNSA|CASIC|GALACTIC ENERGY|LANDSPACE|EXPACE|iSPACE/i.test(name) || country === 'CHN') {
    return 'CHINA';
  }
  const words = name.split(' ').filter(Boolean);
  return words[0] || name || 'SPACE';
}

function missionLabel(raw = {}, launchName = '') {
  const mission = cleanText(raw.name || '');
  if (mission && !/^demo flight$/i.test(mission)) {
    return fold(mission);
  }
  const parsed = splitLaunchName(launchName);
  return fold(parsed.mission || parsed.rocket || launchName);
}

function rocketLabel(raw = {}, launchName = '') {
  const config = raw.configuration || raw;
  const full = cleanText(config.full_name || config.name || '');
  if (full) {
    return fold(full);
  }
  return fold(splitLaunchName(launchName).rocket || launchName);
}

function countdownPhrase(netIso, now = Date.now()) {
  const net = Date.parse(netIso);
  if (!Number.isFinite(net)) {
    return '';
  }
  const diffMs = net - now;
  if (diffMs <= 0) {
    return 'NOW';
  }
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 90) {
    const count = Math.max(1, minutes);
    return count === 1 ? '1 MINUTE' : `${count} MINUTES`;
  }
  const hours = Math.round(diffMs / 3600000);
  if (hours < 24) {
    return hours === 1 ? '1 HOUR' : `${hours} HOURS`;
  }
  const days = Math.round(diffMs / 86400000);
  if (days === 1) {
    return '1 DAY';
  }
  return `${days} DAYS`;
}

function buildAlertSentence({ provider, rocket, mission, countdown }) {
  const lead = fold(`A ${provider} ${rocket}`.replace(/\s+/g, ' ').trim());
  const body = fold(`ROCKET WILL LAUNCH THE ${mission} MISSION IN ${countdown}`.replace(/\s+/g, ' ').trim());
  return `${lead} ${body}`.replace(/\s+/g, ' ').trim();
}

function normalizeLaunch(raw = {}, now = Date.now()) {
  const id = String(raw.id || '').trim();
  const name = cleanText(raw.name || '');
  const net = cleanText(raw.net || '');
  const statusAbbrev = String(raw.status?.abbrev || raw.status?.name || '').trim();
  const statusName = String(raw.status?.name || '').trim();
  if (!id || !name || !net) {
    return null;
  }
  const statusKey = fold(statusAbbrev || statusName).toLowerCase();
  if (SUCCESS_STATUS.has(statusKey)) {
    return null;
  }
  const provider = providerLabel(raw.launch_service_provider, raw.pad);
  const rocket = rocketLabel(raw.rocket, name);
  const mission = missionLabel(raw.mission, name);
  const countdown = countdownPhrase(net, now);
  if (!rocket || !mission || !countdown) {
    return null;
  }
  const sentence = buildAlertSentence({ provider, rocket, mission, countdown });
  if (!fitsBoard(sentence)) {
    return null;
  }
  return {
    id,
    name,
    net,
    status: statusAbbrev || statusName,
    provider,
    rocket,
    mission,
    countdown,
    sentence,
    pad: cleanText(raw.pad?.location?.name || raw.pad?.name || ''),
    providerFull: cleanText(raw.launch_service_provider?.name || ''),
  };
}

function withinHours(netIso, hoursAhead, now = Date.now()) {
  const net = Date.parse(netIso);
  if (!Number.isFinite(net)) {
    return false;
  }
  const horizon = now + Math.max(1, hoursAhead) * 3600000;
  return net >= now - 5 * 60000 && net <= horizon;
}

function pickLaunch(launches = [], { launchId, random = Math.random, now = Date.now() } = {}) {
  const pool = launches.filter((launch) => launch?.id && launch?.sentence);
  if (!pool.length) {
    return null;
  }
  if (launchId) {
    return pool.find((launch) => launch.id === launchId) || null;
  }
  const soonest = [...pool].sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
  const index = Math.min(soonest.length - 1, Math.floor(Number(random()) * Math.min(3, soonest.length)));
  return soonest[Math.max(0, index)] || soonest[0];
}

function buildSpaceLaunchAlertPayload(launch, { chipColor, asOf } = {}) {
  if (!launch?.sentence || !fitsBoard(launch.sentence)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    chipColor: cleanChip(chipColor),
    launch: {
      id: launch.id,
      name: launch.name,
      net: launch.net,
      status: launch.status,
      provider: launch.provider,
      rocket: launch.rocket,
      mission: launch.mission,
      countdown: launch.countdown,
      sentence: launch.sentence,
      pad: launch.pad || '',
    },
  };
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function createSpaceLaunchAlerts(config = {}, log = console) {
  const settingsApi = createSpaceLaunchAlertsSettings(config, log);
  const cachePath = config.spaceLaunchAlertsCachePath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'space-launch-alerts-cache.json');
  const defaultFetch = typeof config.spaceLaunchAlertsFetchImpl === 'function'
    ? config.spaceLaunchAlertsFetchImpl
    : fetch;

  let cache = null;
  let lastError = null;
  let refreshTimer = null;
  let refreshInFlight = null;

  function loadDiskCache() {
    try {
      if (!fs.existsSync(cachePath)) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.launches)) {
        return null;
      }
      return parsed;
    } catch (error) {
      log?.warn?.('Could not read Space Launch Alerts cache', error?.message || error);
      return null;
    }
  }

  function saveDiskCache(next) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save Space Launch Alerts cache', error?.message || error);
    }
  }

  function applyCache(parsed, now = Date.now()) {
    if (!parsed) {
      return;
    }
    cache = {
      fetchedAt: parsed.fetchedAt || parsed.at || new Date(now).toISOString(),
      launches: Array.isArray(parsed.launches) ? parsed.launches : [],
      source: parsed.source || 'launch-library-2',
    };
  }

  applyCache(loadDiskCache());

  function cacheAgeMs(now = Date.now()) {
    if (!cache?.fetchedAt) {
      return Infinity;
    }
    return now - Date.parse(cache.fetchedAt);
  }

  function filteredLaunches(settings = settingsApi.get(), now = Date.now()) {
    const cfg = sanitiseSettings(settings, DEFAULT_SETTINGS);
    return (cache?.launches || [])
      .filter((launch) => withinHours(launch.net, cfg.hoursAhead, now))
      .sort((a, b) => Date.parse(a.net) - Date.parse(b.net));
  }

  async function refreshCache({ fetchImpl, timeoutMs, force = false, now = Date.now() } = {}) {
    if (refreshInFlight) {
      return refreshInFlight;
    }
    const settings = settingsApi.get();
    const ttl = settings.refreshHours * 3600000;
    if (!force && cache && cacheAgeMs(now) < ttl) {
      return { ok: true, cached: true, count: cache.launches.length };
    }

    refreshInFlight = (async () => {
      const params = new URLSearchParams({
        limit: String(FETCH_LIMIT),
        ordering: 'net',
      });
      if (!settings.includeSuborbital) {
        params.set('include_suborbital', 'false');
      }
      const url = `${LL2_UPCOMING}?${params}`;
      try {
        const payload = await fetchJson(url, {
          fetchImpl: fetchImpl || defaultFetch,
          timeoutMs,
        });
        const launches = (payload?.results || [])
          .map((row) => normalizeLaunch(row, now))
          .filter(Boolean);
        const next = {
          fetchedAt: new Date(now).toISOString(),
          source: 'launch-library-2',
          launches,
        };
        applyCache(next, now);
        saveDiskCache(next);
        lastError = null;
        return { ok: true, cached: false, count: launches.length };
      } catch (error) {
        lastError = error?.message || String(error);
        if (cache) {
          log?.warn?.('Space Launch Alerts refresh failed — using cached launches', lastError);
          return { ok: true, cached: true, stale: true, count: cache.launches.length, error: lastError };
        }
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  function scheduleRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    const settings = settingsApi.get();
    const intervalMs = Math.max(3600000, settings.refreshHours * 3600000);
    refreshTimer = setInterval(() => {
      refreshCache({ force: true }).catch((error) => {
        log?.warn?.('Space Launch Alerts scheduled refresh failed', error?.message || error);
      });
    }, intervalMs);
    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function ensureWarm({ fetchImpl, timeoutMs } = {}) {
    scheduleRefresh();
    const settings = settingsApi.get();
    const ttl = settings.refreshHours * 3600000;
    if (!cache || cacheAgeMs() >= ttl) {
      refreshCache({ fetchImpl, timeoutMs, force: !cache }).catch((error) => {
        log?.warn?.('Space Launch Alerts warm refresh failed', error?.message || error);
      });
    }
  }

  return {
    getSettings: () => settingsApi.get(),
    updateSettings(patch) {
      const next = settingsApi.update(patch);
      scheduleRefresh();
      return next;
    },
    resetSettings: () => {
      const next = settingsApi.reset();
      scheduleRefresh();
      return next;
    },
    refreshCache,
    ensureWarm,
    stop() {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    },
    statusSnapshot(now = Date.now()) {
      const settings = settingsApi.get();
      const launches = filteredLaunches(settings, now);
      return {
        settings,
        defaults: { ...DEFAULT_SETTINGS },
        source: 'Launch Library 2 (The Space Devs)',
        fetchedAt: cache?.fetchedAt || null,
        cacheAgeMinutes: Number.isFinite(cacheAgeMs(now))
          ? Math.round(cacheAgeMs(now) / 60000)
          : null,
        total: cache?.launches?.length || 0,
        available: launches.length,
        launches: launches.slice(0, 40).map((launch) => ({
          id: launch.id,
          name: launch.name,
          net: launch.net,
          status: launch.status,
          provider: launch.provider,
          rocket: launch.rocket,
          mission: launch.mission,
          countdown: launch.countdown,
          sentence: launch.sentence,
          pad: launch.pad || '',
          rows: alertRows(launch.sentence, { chip: settings.chipColor }),
        })),
        lastError,
      };
    },
    async nextPayload({ launchId, fetchImpl, timeoutMs, random, asOf, forceRefresh } = {}) {
      await refreshCache({ fetchImpl, timeoutMs, force: Boolean(forceRefresh) });
      const settings = settingsApi.get();
      const launch = pickLaunch(filteredLaunches(settings), { launchId, random });
      if (!launch) {
        return null;
      }
      return buildSpaceLaunchAlertPayload(launch, {
        chipColor: settings.chipColor,
        asOf,
      });
    },
  };
}

module.exports = {
  TYPE,
  LL2_UPCOMING,
  DEFAULT_SETTINGS,
  cleanText,
  splitLaunchName,
  providerLabel,
  missionLabel,
  rocketLabel,
  countdownPhrase,
  buildAlertSentence,
  normalizeLaunch,
  withinHours,
  pickLaunch,
  buildSpaceLaunchAlertPayload,
  createSpaceLaunchAlerts,
};
