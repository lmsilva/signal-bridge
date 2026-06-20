const DEFAULTS = {
  enabled: true,
  pingIntervalMs: 30 * 60 * 1000,
  refreshIntervalMs: 6 * 60 * 60 * 1000,
  reconnectPush: true,
};

function createSessionKeepAlive({ alexa, config, log }) {
  const settings = {
    ...DEFAULTS,
    ...(config.sessionKeepAlive || {}),
  };

  let pingTimer = null;
  let refreshTimer = null;
  let pingInFlight = false;
  let refreshInFlight = false;
  let lastPingAt = null;
  let lastPingOk = null;
  let lastRefreshAt = null;
  let lastRefreshError = null;

  function getStatus() {
    return {
      enabled: settings.enabled,
      lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
      lastPingOk,
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
      lastRefreshError,
    };
  }

  function stop() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function refreshSession(reason) {
    if (refreshInFlight) {
      return;
    }

    refreshInFlight = true;
    log.debug(`Session keep-alive refresh (${reason})`);

    alexa.refreshCookie((err, res) => {
      refreshInFlight = false;

      if (err || !res) {
        lastRefreshError = err?.message || String(err || 'empty refresh response');
        log.warn(`Session refresh failed (${reason})`, lastRefreshError);
        log.warn('Re-authentication may be required: npm run auth');
        return;
      }

      alexa.setCookie(res);
      lastRefreshAt = Date.now();
      lastRefreshError = null;
      log.info(`Session tokens refreshed (${reason})`);
    });
  }

  function pingSession(reason = 'scheduled') {
    if (pingInFlight) {
      return;
    }

    pingInFlight = true;
    lastPingAt = Date.now();

    alexa.checkAuthentication((authenticated, err) => {
      pingInFlight = false;
      lastPingOk = authenticated === true;

      if (err && authenticated === null) {
        log.warn(`Session keep-alive ping error (${reason})`, err.message || err);
        refreshSession('ping-error');
        return;
      }

      if (!authenticated) {
        log.warn(`Session keep-alive auth invalid (${reason}), refreshing tokens`);
        refreshSession('auth-invalid');
        return;
      }

      log.debug(`Session keep-alive ping OK (${reason})`);

      if (settings.reconnectPush && typeof alexa.isPushConnected === 'function' && !alexa.isPushConnected()) {
        log.warn('Push channel disconnected — reconnecting during keep-alive');
        alexa.initPushConnection();
      }
    });
  }

  function start() {
    stop();

    if (!settings.enabled) {
      log.info('Session keep-alive disabled');
      return;
    }

    log.info('Session keep-alive enabled', {
      pingEveryMinutes: Math.round(settings.pingIntervalMs / 60000),
      refreshEveryHours: Math.round(settings.refreshIntervalMs / 3600000),
    });

    pingTimer = setInterval(() => pingSession('scheduled'), settings.pingIntervalMs);
    refreshTimer = setInterval(() => refreshSession('scheduled'), settings.refreshIntervalMs);

    setTimeout(() => pingSession('startup'), 60 * 1000);
  }

  return {
    start,
    stop,
    pingSession,
    refreshSession,
    getStatus,
  };
}

module.exports = {
  createSessionKeepAlive,
  DEFAULTS,
};
