const { normalizeHostname, isAllowedHost } = require('./steam-config');

function createSteamPresenceStore(steamConfig, { now = () => Date.now() } = {}) {
  /** @type {Map<string, { hostname: string, appId: number, updatedAt: number }>} */
  const byHost = new Map();

  function upsert({ hostname, appId }) {
    const host = normalizeHostname(hostname);
    const id = Number(appId);
    if (!host || !Number.isFinite(id) || id <= 0) {
      return { ok: false, error: 'hostname and appId are required' };
    }
    if (!isAllowedHost(steamConfig, host)) {
      return { ok: false, error: `Host ${host} is not in steam.allowedHosts` };
    }
    const entry = {
      hostname: host,
      appId: id,
      updatedAt: now(),
    };
    byHost.set(host, entry);
    return { ok: true, entry };
  }

  function pruneStale() {
    const staleMs = (steamConfig.presenceStaleSeconds || 90) * 1000;
    const cutoff = now() - staleMs;
    for (const [host, entry] of byHost.entries()) {
      if (entry.updatedAt < cutoff) {
        byHost.delete(host);
      }
    }
  }

  function clearHost(hostname) {
    byHost.delete(normalizeHostname(hostname));
  }

  function listFresh() {
    pruneStale();
    return [...byHost.values()];
  }

  /**
   * Prefer a fresh allowed-host presence that matches accountAppId.
   * If accountAppId is null, return any fresh presence (reporter-only mode).
   */
  function matchForApp(accountAppId) {
    pruneStale();
    const wanted = accountAppId == null ? null : Number(accountAppId);
    const entries = [...byHost.values()];
    if (wanted != null && Number.isFinite(wanted)) {
      return entries.find((entry) => entry.appId === wanted) || null;
    }
    return entries[0] || null;
  }

  function snapshot() {
    pruneStale();
    return {
      hosts: [...byHost.values()].map((entry) => ({
        hostname: entry.hostname,
        appId: entry.appId,
        ageSec: Math.round((now() - entry.updatedAt) / 1000),
      })),
      staleSeconds: steamConfig.presenceStaleSeconds,
      allowedHosts: steamConfig.allowedHosts,
    };
  }

  return {
    upsert,
    pruneStale,
    clearHost,
    listFresh,
    matchForApp,
    snapshot,
  };
}

module.exports = {
  createSteamPresenceStore,
};
