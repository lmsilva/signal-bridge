const { getSessionMeta } = require('./session-meta');

const DEFAULTS = {
  enabled: true,
  pingIntervalMs: 15 * 60 * 1000,
  refreshIntervalMs: 3 * 60 * 60 * 1000,
  startupRefreshDelayMs: 3 * 60 * 1000,
  proactiveRefreshAfterMs: 12 * 60 * 60 * 1000,
  reconnectPush: true,
  failureThreshold: 5,
  livenessProbe: true,
};

function isAuthRelatedMessage(message) {
  const text = String(message || '').toLowerCase();
  return /401|403|unauth|authentication|csrf|cookie|session|login|expired|invalid token|refresh|forbidden/.test(text);
}

function countDevices(result, alexa) {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (Array.isArray(result?.devices)) {
    return result.devices.length;
  }
  if (alexa?.serialNumbers && typeof alexa.serialNumbers === 'object') {
    return Object.keys(alexa.serialNumbers).length;
  }
  return 0;
}

function createSessionKeepAlive({
  alexa,
  config,
  log,
  journal,
  session,
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
  let lastLivenessAt = null;
  let lastLivenessOk = null;
  let lastRefreshAt = null;
  let lastRefreshError = null;
  let consecutiveFailures = 0;
  let lastHealthyAt = null;

  function sessionMeta() {
    return getSessionMeta(config, session, alexa);
  }

  function getStatus() {
    return {
      enabled: settings.enabled,
      lastPingAt: lastPingAt ? new Date(lastPingAt).toISOString() : null,
      lastPingOk,
      lastLivenessAt: lastLivenessAt ? new Date(lastLivenessAt).toISOString() : null,
      lastLivenessOk,
      lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
      lastRefreshError,
      lastHealthyAt: lastHealthyAt ? new Date(lastHealthyAt).toISOString() : null,
      consecutiveFailures,
      sessionMeta: sessionMeta(),
      journal: journal?.getSummary?.() || null,
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

  function markFailure(reason, message, { source = 'keepalive', context = {} } = {}) {
    consecutiveFailures += 1;
    lastRefreshError = message;

    journal?.recordFailure({
      type: 'session_degraded',
      source,
      reason,
      message,
      context: { ...context, consecutiveFailures },
      sessionMeta: sessionMeta(),
      level: consecutiveFailures >= settings.failureThreshold ? 'error' : 'warn',
    });

    if (consecutiveFailures >= settings.failureThreshold && onReauthRequired) {
      const classification = journal?.classifyAuthFailure?.(message, { source, reason }) || {};
      onReauthRequired({
        reason,
        message,
        consecutiveFailures,
        category: classification.category,
        likelyCause: classification.likelyCause,
        sessionMeta: sessionMeta(),
        journalPath: journal?.path,
      });
      journal?.recordFailure({
        type: 'reauth_required',
        source: 'keepalive',
        reason,
        message,
        context: { consecutiveFailures },
        sessionMeta: sessionMeta(),
        level: 'error',
      });
      log.error('Amazon session expired — re-authentication required', {
        reason,
        message,
        consecutiveFailures,
        category: classification.category,
        likelyCause: classification.likelyCause,
      });
      log.error('Stop listener and run: PROXY_OWN_IP=YOUR_NAS_IP ./reauth.sh');
      log.error(`Auth journal: ${journal?.path || 'n/a'}`);
    }
  }

  function markHealthy(source = 'keepalive') {
    const wasDegraded = consecutiveFailures > 0;
    consecutiveFailures = 0;
    lastRefreshError = null;
    lastLivenessOk = true;
    lastHealthyAt = Date.now();
    if (onSessionHealthy) {
      onSessionHealthy();
    }
    if (wasDegraded) {
      journal?.recordSuccess({
        type: 'session_recovered',
        source,
        message: 'Session auth checks passing again after prior failures',
        sessionMeta: sessionMeta(),
      });
    }
  }

  function persistRefreshedSession(res, reason) {
    if (onSessionRefreshed) {
      onSessionRefreshed(res, reason);
    }
  }

  function shouldProactiveRefresh() {
    const meta = sessionMeta();
    if (!meta.hasRefreshToken) {
      return false;
    }
    if (meta.tokenAgeHours == null) {
      return false;
    }
    const thresholdHours = Math.round(settings.proactiveRefreshAfterMs / 3600000);
    return meta.tokenAgeHours >= thresholdHours;
  }

  function refreshSession(reason, { onComplete, source = 'keepalive' } = {}) {
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
        journal?.recordFailure({
          type: 'token_refresh_failed',
          source,
          reason,
          message,
          context: { trigger: reason },
          sessionMeta: sessionMeta(),
        });
        markFailure(reason, message, { source, context: { phase: 'refresh' } });
        onComplete?.(false, message);
        return;
      }

      alexa.setCookie(res);
      lastRefreshAt = Date.now();
      markHealthy(source);
      persistRefreshedSession(res, reason);
      journal?.recordSuccess({
        type: 'token_refresh_ok',
        source,
        message: `Tokens refreshed (${reason})`,
        context: { trigger: reason },
        sessionMeta: sessionMeta(),
      });
      log.info(`Session tokens refreshed (${reason})`, sessionMeta());
      onComplete?.(true);
    });
  }

  function runLivenessProbe(reason, onComplete) {
    if (!settings.livenessProbe) {
      onComplete?.(true);
      return;
    }

    lastLivenessAt = Date.now();
    alexa.getDevices((err, result) => {
      const deviceCount = countDevices(result, alexa);
      lastLivenessOk = !err && deviceCount > 0;

      if (err) {
        const message = err.message || String(err);
        log.warn(`Session liveness probe failed (${reason})`, message);
        journal?.recordFailure({
          type: 'liveness_probe_failed',
          source: 'keepalive',
          reason,
          message,
          context: { api: 'getDevices', cached: true },
          sessionMeta: sessionMeta(),
          level: isAuthRelatedMessage(message) ? 'warn' : 'info',
        });

        if (isAuthRelatedMessage(message)) {
          refreshSession('liveness-auth', {
            source: 'liveness_probe',
            onComplete: (ok, refreshMessage) => {
              if (!ok) {
                markFailure(reason, refreshMessage || message, {
                  source: 'liveness_probe',
                  context: { api: 'getDevices' },
                });
              }
              onComplete?.(ok);
            },
          });
          return;
        }

        // Auth ping already passed — API glitch, not session loss.
        onComplete?.(true);
        return;
      }

      if (deviceCount === 0) {
        log.debug(`Session liveness probe: no devices in response (${reason})`);
        journal?.recordSuccess({
          type: 'liveness_probe_ok',
          source: 'keepalive',
          message: `Auth OK; device list empty in probe response (${reason})`,
          context: { api: 'getDevices', deviceCount: 0 },
          sessionMeta: sessionMeta(),
        });
        onComplete?.(true);
        return;
      }

      journal?.recordSuccess({
        type: 'liveness_probe_ok',
        source: 'keepalive',
        message: `Lightweight API probe OK (${reason})`,
        context: { api: 'getDevices', deviceCount },
        sessionMeta: sessionMeta(),
      });
      log.debug(`Session liveness probe OK (${reason})`, { devices: deviceCount });
      onComplete?.(true);
    });
  }

  function pingSession(reason = 'scheduled') {
    if (pingInFlight) {
      return;
    }

    pingInFlight = true;
    lastPingAt = Date.now();
    const meta = sessionMeta();

    if (!meta.hasRefreshToken) {
      pingInFlight = false;
      const message = 'Session file has no refreshToken — automatic renewal impossible';
      journal?.recordFailure({
        type: 'session_misconfigured',
        source: 'keepalive',
        reason,
        message,
        sessionMeta: meta,
        level: 'error',
      });
      markFailure(reason, message, { source: 'keepalive', context: { missing: 'refreshToken' } });
      return;
    }

    alexa.checkAuthentication((authenticated, err) => {
      if (err && authenticated === null) {
        pingInFlight = false;
        lastPingOk = false;
        const message = err.message || String(err);
        log.warn(`Session keep-alive ping error (${reason})`, message);
        journal?.recordFailure({
          type: 'auth_ping_error',
          source: 'keepalive',
          reason,
          message,
          context: { api: 'checkAuthentication' },
          sessionMeta: meta,
        });
        refreshSession('ping-error', {
          onComplete: (ok, refreshMessage) => {
            pingInFlight = false;
            if (!ok) {
              markFailure(reason, refreshMessage || message, { source: 'keepalive', context: { phase: 'ping' } });
            } else {
              runLivenessProbe(reason);
            }
          },
        });
        return;
      }

      if (!authenticated) {
        pingInFlight = false;
        lastPingOk = false;
        log.warn(`Session keep-alive auth invalid (${reason}), refreshing tokens`);
        journal?.recordFailure({
          type: 'auth_ping_invalid',
          source: 'keepalive',
          reason,
          message: 'checkAuthentication returned false',
          context: { api: 'checkAuthentication', authenticated: false },
          sessionMeta: meta,
        });
        refreshSession('auth-invalid', {
          onComplete: (ok) => {
            pingInFlight = false;
            if (!ok) {
              markFailure(reason, 'authentication invalid after refresh', {
                source: 'keepalive',
                context: { phase: 'ping' },
              });
            } else {
              runLivenessProbe(reason);
            }
          },
        });
        return;
      }

      lastPingOk = true;
      journal?.recordSuccess({
        type: 'auth_ping_ok',
        source: 'keepalive',
        message: `Auth check OK (${reason})`,
        context: { api: 'checkAuthentication' },
        sessionMeta: meta,
      });

      if (shouldProactiveRefresh()) {
        journal?.recordSuccess({
          type: 'proactive_refresh_triggered',
          source: 'keepalive',
          message: `Token age ${meta.tokenAgeHours}h — refreshing before expiry`,
          sessionMeta: meta,
        });
        refreshSession('proactive-age', {
          onComplete: (ok) => {
            pingInFlight = false;
            if (ok) {
              runLivenessProbe(reason);
            }
          },
        });
        return;
      }

      runLivenessProbe(reason, (ok) => {
        pingInFlight = false;
        if (!ok) {
          return;
        }

        markHealthy('keepalive');
        log.debug(`Session keep-alive ping OK (${reason})`, meta);

        if (settings.reconnectPush && typeof alexa.isPushConnected === 'function' && !alexa.isPushConnected()) {
          log.warn('Push channel disconnected — reconnecting during keep-alive');
          journal?.recordFailure({
            type: 'push_disconnected',
            source: 'keepalive',
            reason,
            message: 'Push channel down during scheduled ping',
            sessionMeta: meta,
            level: 'warn',
          });
          alexa.initPushConnection();
        }
      });
    });
  }

  function handleExternalAuthFailure(source, message, context = {}) {
    journal?.recordFailure({
      type: 'external_auth_failure',
      source,
      reason: context.reason || source,
      message,
      context,
      sessionMeta: sessionMeta(),
    });

    if (!isAuthRelatedMessage(message)) {
      return;
    }

    log.warn(`Auth-related failure from ${source}`, message);
    refreshSession(`external-${source}`, {
      source,
      onComplete: (ok, refreshMessage) => {
        if (!ok) {
          markFailure(source, refreshMessage || message, { source, context });
        }
      },
    });
  }

  function start() {
    stop();

    if (!settings.enabled) {
      log.info('Session keep-alive disabled');
      return;
    }

    journal?.recordSuccess({
      type: 'keepalive_started',
      source: 'keepalive',
      message: 'Session keep-alive scheduler started',
      context: {
        pingEveryMinutes: Math.round(settings.pingIntervalMs / 60000),
        refreshEveryHours: Math.round(settings.refreshIntervalMs / 3600000),
        proactiveRefreshAfterHours: Math.round(settings.proactiveRefreshAfterMs / 3600000),
        livenessProbe: settings.livenessProbe,
      },
      sessionMeta: sessionMeta(),
    });

    log.info('Session keep-alive enabled', {
      pingEveryMinutes: Math.round(settings.pingIntervalMs / 60000),
      refreshEveryHours: Math.round(settings.refreshIntervalMs / 3600000),
      proactiveRefreshAfterHours: Math.round(settings.proactiveRefreshAfterMs / 3600000),
      livenessProbe: settings.livenessProbe,
      failureThreshold: settings.failureThreshold,
      journalPath: journal?.path,
    });

    pingTimer = setInterval(() => pingSession('scheduled'), settings.pingIntervalMs);
    refreshTimer = setInterval(() => refreshSession('scheduled'), settings.refreshIntervalMs);

    setTimeout(() => pingSession('startup'), 30 * 1000);
    setTimeout(() => refreshSession('startup'), settings.startupRefreshDelayMs);
  }

  return {
    start,
    stop,
    pingSession,
    refreshSession,
    handleExternalAuthFailure,
    getStatus,
  };
}

module.exports = {
  createSessionKeepAlive,
  DEFAULTS,
  isAuthRelatedMessage,
};
