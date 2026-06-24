const DEFAULTS = {
  enabled: true,
  pingIntervalMs: 15 * 60 * 1000,
  refreshIntervalMs: 4 * 60 * 60 * 1000,
  startupRefreshDelayMs: 5 * 60 * 1000,
  reconnectPush: true,
  failureThreshold: 5,
};

function createSessionKeepAlive({
  alexa,
  config,
  log,
  onReauthRequired,
  onSessionHealthy,
  onSessionRefreshed,
}) {
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
  let consecutiveFailures = 0;

  function getStatus() {
    return {
      enabled: settings.enabled,
      lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
      lastPingOk,
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
      lastRefreshError,
      consecutiveFailures,
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

  function markFailure(reason, message) {
    consecutiveFailures += 1;
    lastRefreshError = message;

    if (consecutiveFailures >= settings.failureThreshold && onReauthRequired) {
      onReauthRequired({ reason, message, consecutiveFailures });
      log.error('Amazon session expired — re-authentication required', {
        reason,
        message,
        consecutiveFailures,
      });
      log.error('Stop listener and run: PROXY_OWN_IP=YOUR_NAS_IP ./reauth.sh');
    }
  }

  function markHealthy() {
    consecutiveFailures = 0;
    lastRefreshError = null;
    if (onSessionHealthy) {
      onSessionHealthy();
    }
  }

  function persistRefreshedSession(res, reason) {
    if (onSessionRefreshed) {
      onSessionRefreshed(res, reason);
    }
  }

  function refreshSession(reason, { onComplete } = {}) {
    if (refreshInFlight) {
      return;
    }

    refreshInFlight = true;
    log.debug(`Session keep-alive refresh (${reason})`);

    if (alexa.cookieData) {
      alexa._options = alexa._options || {};
      alexa._options.formerRegistrationData = alexa.cookieData;
    }

    alexa.refreshCookie((err, res) => {
      refreshInFlight = false;

      if (err || !res) {
        const message = err?.message || String(err || 'empty refresh response');
        log.warn(`Session refresh failed (${reason})`, message);
        markFailure(reason, message);
        onComplete?.(false, message);
        return;
      }

      alexa.setCookie(res);
      lastRefreshAt = Date.now();
      markHealthy();
      persistRefreshedSession(res, reason);
      log.info(`Session tokens refreshed (${reason})`);
      onComplete?.(true);
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
        const message = err.message || String(err);
        log.warn(`Session keep-alive ping error (${reason})`, message);
        refreshSession('ping-error', {
          onComplete: (ok, refreshMessage) => {
            if (!ok) {
              markFailure(reason, refreshMessage || message);
            }
          },
        });
        return;
      }

      if (!authenticated) {
        log.warn(`Session keep-alive auth invalid (${reason}), refreshing tokens`);
        refreshSession('auth-invalid', {
          onComplete: (ok) => {
            if (!ok) {
              markFailure(reason, 'authentication invalid after refresh');
            }
          },
        });
        return;
      }

      markHealthy();
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
      failureThreshold: settings.failureThreshold,
    });

    pingTimer = setInterval(() => pingSession('scheduled'), settings.pingIntervalMs);
    refreshTimer = setInterval(() => refreshSession('scheduled'), settings.refreshIntervalMs);

    setTimeout(() => pingSession('startup'), 60 * 1000);
    setTimeout(() => refreshSession('startup'), settings.startupRefreshDelayMs);
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
