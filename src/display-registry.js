/**
 * Tracks display clients that announce themselves over UDP.
 * Persists to data/displays-registry.json so the control page remembers
 * names across bridge restarts (host/IP refresh on next announce).
 */

const fs = require('fs');
const path = require('path');

const STALE_AFTER_MS = 12 * 60 * 1000; // missed ~2 heartbeats (5 min interval)
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
        byId.set(String(entry.id), {
          id: String(entry.id),
          name: String(entry.name),
          host: entry.host || null,
          port: Number(entry.port) || null,
          lastSeen: entry.lastSeen || null,
        });
      }
    } catch (error) {
      log.warn?.('Could not load displays registry', error?.message || error);
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const displays = list().map(({ stale, ...rest }) => rest);
      fs.writeFileSync(filePath, `${JSON.stringify({ displays }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log.warn?.('Could not save displays registry', error?.message || error);
    }
  }

  function notify(entry) {
    const snapshot = list();
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
    const entry = {
      id,
      name,
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

  function list() {
    const now = Date.now();
    return [...byId.values()]
      .map((entry) => {
        const lastMs = entry.lastSeen ? Date.parse(entry.lastSeen) : 0;
        const stale = !lastMs || (now - lastMs) > STALE_AFTER_MS;
        return { ...entry, stale };
      })
      .sort((a, b) => {
        // Fresh first, then name.
        if (a.stale !== b.stale) {
          return a.stale ? 1 : -1;
        }
        return String(a.name).localeCompare(String(b.name));
      });
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

  load();

  return {
    STALE_AFTER_MS,
    ALL_TARGET_ID,
    filePath,
    upsertFromAnnounce,
    get,
    list,
    resolveDelivery,
    persist,
    onChange,
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
