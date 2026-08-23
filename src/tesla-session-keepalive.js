const { loadTeslaSession, accessTokenExpiresWithin } = require('./tesla-session');
const { refreshSession, isRefreshTokenRejected } = require('./tesla-token-refresh');
const {
  clearTeslaAuthStatus,
  markTeslaReauthRequired,
  markTeslaReauthRecommended,
} = require('./tesla-auth-status');

const DEFAULTS = {
  enabled: true,
  pingIntervalMs: 15 * 60 * 1000,
  refreshWithinMs: 60 * 1000,
  proactiveRefreshAfterMs: 6 * 60 * 60 * 1000,
};

function createTeslaSessionKeepAlive({ fleet, log, settings: userSettings = {} } = {}) {
  const settings = { ...DEFAULTS, ...userSettings };
  let pingTimer = null;
  let lastRefreshAt = 0;

  async function refreshIfNeeded(reason) {
    if (!fleet?.clientId || !fleet?.clientSecret) {
      return;
    }

    const session = loadTeslaSession(fleet.sessionPath);
    if (!session?.refreshToken) {
      return;
    }

    const now = Date.now();
    const needsExpiryRefresh = accessTokenExpiresWithin(session, settings.refreshWithinMs);
    const needsProactive = (
      lastRefreshAt > 0
      && now - lastRefreshAt >= settings.proactiveRefreshAfterMs
    );

    if (!needsExpiryRefresh && !needsProactive) {
      // Healthy session — don't leave a stale reauth banner up.
      clearTeslaAuthStatus(fleet);
      return;
    }

    try {
      await refreshSession(fleet, { log, reason });
      lastRefreshAt = Date.now();
    } catch (error) {
      const status = error?.status;
      const message = error?.message || String(error);
      log?.warn?.('Tesla token refresh failed', { reason, status, message });
      if (isRefreshTokenRejected(error)) {
        markTeslaReauthRequired(fleet, { reason: 'refresh_failed', message });
      } else {
        markTeslaReauthRecommended(fleet, { reason: 'refresh_failed', message });
      }
      throw error;
    }
  }

  async function ping(reason = 'scheduled') {
    try {
      await refreshIfNeeded(reason);
    } catch {
      // logged in refreshIfNeeded
    }
  }

  function start() {
    stop();
    if (!settings.enabled) {
      log?.info?.('Tesla session keep-alive disabled');
      return;
    }
    if (!fleet?.clientId || !fleet?.clientSecret) {
      log?.info?.('Tesla keep-alive skipped — credentials not configured');
      return;
    }
    const session = loadTeslaSession(fleet.sessionPath);
    if (!session?.refreshToken) {
      log?.info?.('Tesla keep-alive skipped — run npm run tesla-auth');
      return;
    }

    log?.info?.('Tesla session keep-alive enabled', {
      pingEveryMinutes: Math.round(settings.pingIntervalMs / 60000),
    });
    // Drop a stale banner if the on-disk session looks usable.
    if (!accessTokenExpiresWithin(session, settings.refreshWithinMs)) {
      clearTeslaAuthStatus(fleet);
    }
    pingTimer = setInterval(() => ping('scheduled'), settings.pingIntervalMs);
    setTimeout(() => ping('startup'), 5000);
  }

  function stop() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  return {
    start,
    stop,
    ping,
    refreshIfNeeded,
  };
}

module.exports = {
  createTeslaSessionKeepAlive,
  DEFAULTS,
};
