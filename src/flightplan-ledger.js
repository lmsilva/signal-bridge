/**
 * Flight Plan API unit ledger — tracks RapidAPI AeroDataBox consumption.
 */

const fs = require('fs');
const path = require('path');

const STATES = Object.freeze(['ok', 'low', 'out']);

function emptyLedger() {
  return {
    version: 1,
    entries: [],
    cycleKey: '',
    cycleUsed: 0,
    forcedOut: false,
    lastQuotaErrorAt: null,
  };
}

function cycleKeyFor(date, billingCycleDay = 1) {
  const d = date instanceof Date ? date : new Date(date);
  const day = Math.max(1, Math.min(28, Number(billingCycleDay) || 1));
  let year = d.getFullYear();
  let month = d.getMonth();
  if (d.getDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function nextResetDate(now, billingCycleDay = 1) {
  const day = Math.max(1, Math.min(28, Number(billingCycleDay) || 1));
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  let year = d.getFullYear();
  let month = d.getMonth();
  if (d.getDate() >= day) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return new Date(year, month, day, 0, 0, 0, 0);
}

function createFlightplanLedger({
  config = {},
  settings,
  log = console,
  now = () => Date.now(),
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const ledgerPath = path.resolve(
    config.flightplanLedgerPath || path.join(root, 'data', 'flightplan-ledger.json'),
  );
  let data = emptyLedger();

  function load() {
    try {
      if (!fs.existsSync(ledgerPath)) {
        data = emptyLedger();
        return data;
      }
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      data = { ...emptyLedger(), ...parsed, entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
    } catch (error) {
      log?.warn?.('Flight Plan ledger load failed', error?.message || error);
      data = emptyLedger();
    }
    return data;
  }

  function persist() {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const tmp = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, ledgerPath);
  }

  function rollCycleIfNeeded() {
    const cfg = settings?.get?.() || {};
    const key = cycleKeyFor(now(), cfg.billingCycleDay);
    if (data.cycleKey !== key) {
      data.cycleKey = key;
      data.cycleUsed = 0;
      data.forcedOut = false;
      data.lastQuotaErrorAt = null;
    }
  }

  load();
  rollCycleIfNeeded();

  function state() {
    load();
    rollCycleIfNeeded();
    const cfg = settings?.get?.() || {};
    const softCap = Number(cfg.softCapUnits) || 500;
    const hardCap = Number(cfg.hardCapUnits) || 600;
    if (data.forcedOut || data.cycleUsed >= hardCap) return 'out';
    if (data.cycleUsed >= softCap) return 'low';
    return 'ok';
  }

  function canSpend(units, { manual = false } = {}) {
    const current = state();
    if (current === 'out') return false;
    if (current === 'low' && !manual) return false;
    const cfg = settings?.get?.() || {};
    const hardCap = Number(cfg.hardCapUnits) || 600;
    return (data.cycleUsed + units) <= hardCap;
  }

  function recordCall({
    endpoint,
    tier = 1,
    units = null,
    filedFlightPlan = false,
    manual = false,
  } = {}) {
    load();
    rollCycleIfNeeded();
    const charged = units != null
      ? Number(units)
      : Math.max(0, Number(tier) || 0) * (filedFlightPlan ? 2 : 1);
    const entry = {
      at: new Date(now()).toISOString(),
      endpoint: String(endpoint || 'unknown'),
      tier: Number(tier) || 0,
      units: charged,
      manual: manual === true,
    };
    if (!canSpend(charged, { manual })) {
      return { ok: false, error: 'API unit budget exhausted', state: state(), units: charged };
    }
    data.entries.push(entry);
    if (data.entries.length > 5000) {
      data.entries = data.entries.slice(-5000);
    }
    data.cycleUsed += charged;
    persist();
    return { ok: true, state: state(), units: charged, cycleUsed: data.cycleUsed };
  }

  function markQuotaError() {
    load();
    data.forcedOut = true;
    data.lastQuotaErrorAt = new Date(now()).toISOString();
    persist();
  }

  function statusSummary() {
    load();
    rollCycleIfNeeded();
    const cfg = settings?.get?.() || {};
    const hardCap = Number(cfg.hardCapUnits) || 600;
    const resetAt = nextResetDate(now(), cfg.billingCycleDay);
    const days = Math.max(0, Math.ceil((resetAt.getTime() - now()) / 86_400_000));
    return {
      state: state(),
      cycleUsed: data.cycleUsed,
      hardCapUnits: hardCap,
      softCapUnits: Number(cfg.softCapUnits) || 500,
      cycleKey: data.cycleKey,
      resetsInDays: days,
      summaryLine: `${data.cycleUsed} of ${hardCap} units used — resets in ${days} day${days === 1 ? '' : 's'}`,
      forcedOut: data.forcedOut,
      lastQuotaErrorAt: data.lastQuotaErrorAt,
    };
  }

  return {
    ledgerPath,
    load,
    state,
    canSpend,
    recordCall,
    markQuotaError,
    statusSummary,
    cycleKeyFor,
    nextResetDate,
    STATES,
  };
}

module.exports = {
  createFlightplanLedger,
  cycleKeyFor,
  nextResetDate,
  STATES,
};
