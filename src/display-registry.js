/**
 * Tracks display clients that announce themselves over UDP.
 * Persists to data/displays-registry.json so the control page remembers
 * names across bridge restarts (host/IP refresh on next announce).
 * Entries that miss heartbeats are pruned (removed) after STALE_AFTER_MS.
 */

const fs = require('fs');
const path = require('path');

const STALE_AFTER_MS = 12 * 60 * 1000; // missed ~2 heartbeats (5 min interval)
const PRUNE_INTERVAL_MS = 60 * 1000;
const ALL_TARGET_ID = '*';

function defaultRegistryPath(config) {
  return path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'displays-registry.json');
}

function createDisplayRegistry(config, log = console) {
  const filePath = config.displaysRegistryPath || defaultRegistryPath(config);
  /** @type {Map<string, object>} */
  const byId = new Map();
  /** @type {Set<(entry: object, list: object[]) => void>} */
  const listeners = new Set();
  let pruneTimer = null;

  function load() {
    try {
      if (!fs.existsSync(filePath)) {
        return;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const list = Array.isArray(raw?.displays) ? raw.displays : [];
      for (const entry of list) {
        if (!entry?.id || !entry?.name) {
          continue;
        }
        const id = String(entry.id);
        byId.set(id, {
          id,
          name: String(entry.name),
          shortId: String(entry.shortId || shortIdFrom(id)),
          host: entry.host || null,
          port: Number(entry.port) || null,
          lastSeen: entry.lastSeen || null,
        });
      }
    } catch (error) {
      log.warn?.('Could not load displays registry', error?.message || error);
    }
  }

  function shortIdFrom(id) {
    const raw = String(id || '').replace(/^disp-/i, '');
    return raw.slice(-4) || raw || '????';
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const displays = [...byId.values()].map((entry) => ({
        id: entry.id,
        name: entry.name,
        shortId: entry.shortId || shortIdFrom(entry.id),
        host: entry.host || null,
        port: entry.port || null,
        lastSeen: entry.lastSeen || null,
      }));
      fs.writeFileSync(filePath, `${JSON.stringify({ displays }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log.warn?.('Could not save displays registry', error?.message || error);
    }
  }

  function notify(entry) {
    const snapshot = list({ skipPrune: true });
    for (const listener of listeners) {
      try {
        listener(entry, snapshot);
      } catch (error) {
        log.warn?.('Display registry listener failed', error?.message || error);
      }
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function isStaleEntry(entry, now = Date.now()) {
    const lastMs = entry?.lastSeen ? Date.parse(entry.lastSeen) : 0;
    return !lastMs || (now - lastMs) > STALE_AFTER_MS;
  }

  /**
   * Drop displays that have not re-announced within STALE_AFTER_MS.
   * @returns {string[]} removed display ids
   */
  function pruneStale(now = Date.now()) {
    const removed = [];
    for (const [id, entry] of byId) {
      if (isStaleEntry(entry, now)) {
        byId.delete(id);
        removed.push(id);
        log.info?.('Removed stale display (no re-announce)', {
          id,
          name: entry.name,
          lastSeen: entry.lastSeen,
        });
      }
    }
    if (removed.length) {
      persist();
      notify({ pruned: true, removedIds: removed });
    }
    return removed;
  }

  function upsertFromAnnounce(payload, rinfo = {}) {
    const display = payload?.display || {};
    const id = String(display.id || '').trim();
    const name = String(display.name || '').trim();
    if (!id || !name) {
      return null;
    }

    // Host comes from the UDP packet source (reliable). Listen port is what the
    // client advertised — never rinfo.port (that is an ephemeral source port).
    const host = String(rinfo.address || display.host || '').trim() || null;
    const port = Number(display.port) || 47832;
    const shortId = String(display.shortId || '').trim() || shortIdFrom(id);
    const entry = {
      id,
      name,
      shortId,
      host,
      port,
      lastSeen: new Date().toISOString(),
    };
    byId.set(id, entry);
    persist();
    notify(entry);
    return entry;
  }

  function get(id) {
    if (!id || id === ALL_TARGET_ID) {
      return null;
    }
    return byId.get(String(id)) || null;
  }

  function list({ skipPrune = false } = {}) {
    if (!skipPrune) {
      pruneStale();
    }
    const now = Date.now();
    const items = [...byId.values()].map((entry) => {
      const shortId = entry.shortId || shortIdFrom(entry.id);
      // After prune, remaining entries are fresh; keep stale:false for API compat.
      return { ...entry, shortId, stale: isStaleEntry(entry, now) };
    });

    // When two PCs share displayName, disambiguate the picker label with shortId.
    // Targeting always uses entry.id (never the friendly name).
    const nameCounts = new Map();
    for (const entry of items) {
      const key = String(entry.name).toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    for (const entry of items) {
      const key = String(entry.name).toLowerCase();
      entry.label = nameCounts.get(key) > 1
        ? `${entry.name} · ${entry.shortId}`
        : entry.name;
    }

    return items.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  /**
   * Resolve control-page targetId to UDP delivery options + payload target block.
   * @param {string|null|undefined} targetId - display id, "*", "all", or empty (= all)
   */
  function resolveDelivery(targetId) {
    const raw = targetId == null ? '' : String(targetId).trim();
    const isAll = !raw || raw === ALL_TARGET_ID || raw.toLowerCase() === 'all';
    if (isAll) {
      return {
        target: { all: true },
        sendOptions: {},
        entry: null,
        isAll: true,
      };
    }

    const entry = get(raw);
    if (!entry?.host) {
      return {
        target: { id: raw },
        sendOptions: {},
        entry: null,
        isAll: false,
        error: entry
          ? `Display "${entry.name}" has no known IP yet — wait for an announce or tap Refresh`
          : `Unknown display id: ${raw}`,
      };
    }

    return {
      target: { id: entry.id },
      sendOptions: { host: entry.host },
      entry,
      isAll: false,
    };
  }

  function stop() {
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }

  load();
  pruneStale();
  pruneTimer = setInterval(() => pruneStale(), PRUNE_INTERVAL_MS);
  if (typeof pruneTimer.unref === 'function') {
    pruneTimer.unref();
  }

  return {
    STALE_AFTER_MS,
    ALL_TARGET_ID,
    filePath,
    upsertFromAnnounce,
    get,
    list,
    pruneStale,
    resolveDelivery,
    persist,
    onChange,
    stop,
  };
}

function attachTarget(payload, target) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (!target) {
    return payload;
  }
  return { ...payload, target };
}

module.exports = {
  createDisplayRegistry,
  attachTarget,
  ALL_TARGET_ID,
  STALE_AFTER_MS,
};
