/**
 * US State Facts — pick a state for the board.
 *
 * All 50 states ship in local JSON. No network at runtime.
 */

const SHIPPED = require('./us-state-facts-states.json');
const { createUsStateFactsSettings } = require('./us-state-facts-settings');
const { fitsBoard, stateRows, cleanChip } = require('./us-state-facts-layout');

const TYPE = 'state.facts';

function loadShipped() {
  return Array.isArray(SHIPPED?.states) ? SHIPPED.states : [];
}

function loadRegions() {
  const labels = new Map(
    (Array.isArray(SHIPPED?.regions) ? SHIPPED.regions : [])
      .map((row) => [String(row.id || '').trim(), String(row.label || '').trim()]),
  );
  const counts = new Map();
  for (const state of loadShipped()) {
    counts.set(state.region, (counts.get(state.region) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => ({
      id,
      label: labels.get(id) || id,
      count,
    }));
}

function resolveStates(settings = {}) {
  const allowed = new Set((settings.regions || []).map((value) => String(value).trim()).filter(Boolean));
  return loadShipped().filter((state) => {
    if (allowed.size && !allowed.has(state.region)) {
      return false;
    }
    return fitsBoard(state);
  });
}

function countAvailable(settings = {}) {
  return resolveStates(settings).length;
}

function findState({ id, name } = {}) {
  const key = String(id || name || '').trim().toLowerCase();
  if (!key) {
    return null;
  }
  return loadShipped().find((state) => (
    state.id === key
    || String(state.name || '').trim().toLowerCase() === key
  )) || null;
}

function pickState(settings = {}, { random = Math.random, id, name } = {}) {
  const chosen = findState({ id, name });
  if (chosen && resolveStates(settings).some((row) => row.id === chosen.id)) {
    return chosen;
  }
  const pool = resolveStates(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((state) => !recent.has(state.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function publicState(state) {
  if (!state) {
    return null;
  }
  return {
    id: state.id,
    name: state.name,
    capital: state.capital,
    bird: state.bird,
    flower: state.flower,
    region: state.region,
    color: cleanChip(state.color),
    rows: stateRows(state),
  };
}

function buildUsStateFactsPayload(state, { asOf } = {}) {
  if (!state || !fitsBoard(state)) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    state: publicState(state),
  };
}

function createUsStateFacts(config, log) {
  const settingsApi = createUsStateFactsSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    return {
      available: countAvailable(settings),
      total: loadShipped().length,
      regions: loadRegions(),
      settings,
      states: loadShipped().map(publicState).filter(Boolean),
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(extra = {}) {
      return snapshot(extra);
    },
    updateSettings(patch = {}) {
      settingsApi.update(patch);
      return snapshot();
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const state = pickState(settings, options);
      if (!state) {
        return null;
      }
      settingsApi.remember(state.id);
      return buildUsStateFactsPayload(state, options);
    },
  };
}

module.exports = {
  TYPE,
  loadShipped,
  loadRegions,
  resolveStates,
  countAvailable,
  findState,
  pickState,
  buildUsStateFactsPayload,
  createUsStateFacts,
};
