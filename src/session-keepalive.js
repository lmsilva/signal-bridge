const { getSessionMeta } = require('./session-meta');
const {
  isRefreshDeferralMessage,
  isCookieRenewFailure,
  tokenDateAdvanced,
  tokenDateMs,
} = require('./session-token-health');

const DEFAULTS = {
  enabled: true,
  pingIntervalMs: 15 * 60 * 1000,
  refreshIntervalMs: 2 * 60 * 60 * 1000,
  startupRefreshDelayMs: 3 * 60 * 1000,
  proactiveRefreshAfterMs: 8 * 60 * 60 * 1000,
  minTokenAgeForRefreshMs: 2 * 60 * 60 * 1000,
  staleTokenWatchdogHours: 18,
  staleNoopRetryMs: 30 * 60 * 1000,
  recommendReauthAfterHours: 16,
  forceReauthAfterHours: 22,
  externalRefreshCooldownMs: 60 * 1000,
  reconnectPush: true,
  failureThreshold: 5,
  livenessProbe: true,
};

function needsStaleTokenWatchdog(meta, staleTokenWatchdogHours = DEFAULTS.staleTokenWatchdogHours) {
  return meta?.tokenAgeHours != null && meta.tokenAgeHours >= staleTokenWatchdogHours;
}

function pickRefreshReason(meta, settings, { shouldProactive, shouldScheduled } = {}) {
  if (needsStaleTokenWatchdog(meta, settings.staleTokenWatchdogHours)) {
    return 'stale-token-watchdog';
  }
  if (shouldProactive) {
    return 'proactive-age';
  }
  if (shouldScheduled) {
    return 'scheduled';
  }
  return null;
}

function isAuthRelatedMessage(message) {
  const text = String(message || '').toLowerCase();
  if (/no tokens in register response/i.test(text)) {
    return false;
  }
  if (isCookieRenewFailure(message)) {
    return true;
  }
  return /401|403|unauth|authentication|csrf|cookie|session|login|expired|invalid token|forbidden/.test(text);
}

function isRefreshNoopFailure(message) {
  return /no tokens in register response/i.test(String(message || ''));
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
  onReauthRecommended,
  onSessionHealthy,
  onSessionRefreshed,
}) {
  const settings = {
    ...DEFAULTS,
    ...(config.sessionKeepAlive || {}),
  };

  let pingTimer = null;
  let pingInFlight = false;
  let refreshInFlight = false;
  let lastPingAt = null;
  let lastPingOk = null;
  let lastLivenessAt = null;
  let lastLivenessOk = null;
  let lastRefreshAt = null;
  let lastRefreshAttemptAt = null;
  let lastRefreshError = null;
  let consecutiveFailures = 0;
  let lastHealthyAt = null;
  let staleNoopRetryTimer = null;
  let noopWithoutRotationCount = 0;
  let reauthRecommendedEmitted = false;
  let lastExternalRefreshRequestAt = 0;
  let trackedTokenDateMs = null;

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
      lastRefreshAttemptAt: lastRefreshAttemptAt ? new Date(lastRefreshAttemptAt).toISOString() : null,
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
    if (staleNoopRetryTimer) {
      clearTimeout(staleNoopRetryTimer);
      staleNoopRetryTimer = null;
    }
  }

  function noteSuccessfulTokenRotation(source, reason) {
    const meta = sessionMeta();
    noopWithoutRotationCount = 0;
    reauthRecommendedEmitted = false;
    trackedTokenDateMs = tokenDateMs(meta);
    lastRefreshAt = Date.now();
    lastRefreshError = null;
    journal?.recordSuccess({
      type: 'token_rotation_ok',
      source,
      message: `Access token rotated (${reason})`,
      context: { trigger: reason },
      sessionMeta: meta,
    });
  }

  function checkTokenRotationHealth(source, reason) {
    const meta = sessionMeta();
    const tokenMs = tokenDateMs(meta);
    if (tokenMs != null) {
      if (trackedTokenDateMs == null) {
        trackedTokenDateMs = tokenMs;
      } else if (tokenMs > trackedTokenDateMs + 60_000) {
        noteSuccessfulTokenRotation(source, reason);
        return;
      }
    }

    if (meta.tokenAgeHours == null || meta.tokenAgeHours < settings.recommendReauthAfterHours) {
      return;
    }

    if (
      !reauthRecommendedEmitted
      && meta.tokenAgeHours >= settings.recommendReauthAfterHours
      && onReauthRecommended
    ) {
      reauthRecommendedEmitted = true;
      onReauthRecommended({
        reason: 'token_rotation_stalled',
        message: `Access token is ${meta.tokenAgeHours}h old without rotation`,
        sessionMeta: meta,
        noopWithoutRotationCount,
        journalPath: journal?.path,
      });
      journal?.recordFailure({
        type: 'reauth_recommended',
        source,
        reason,
        message: `Token age ${meta.tokenAgeHours}h without successful rotation`,
        context: { noopWithoutRotationCount },
        sessionMeta: meta,
        level: 'warn',
      });
      log.warn('Amazon session token is stale — re-authenticate soon to avoid outage', {
        tokenAgeHours: meta.tokenAgeHours,
        tokenDate: meta.tokenDate,
      });
    }

    if (
      meta.tokenAgeHours >= settings.forceReauthAfterHours
      && noopWithoutRotationCount >= 2
      && onReauthRequired
      && consecutiveFailures < settings.failureThreshold
    ) {
      markFailure(reason, `Token age ${meta.tokenAgeHours}h without rotation`, {
        source,
        context: { phase: 'token_rotation_stalled', noopWithoutRotationCount },
      });
    }
  }

  function noteRefreshNoop(source, reason) {
    noopWithoutRotationCount += 1;
    const meta = sessionMeta();
    journal?.recordSuccess({
      type: 'token_refresh_noop',
      source,
      message: `Register returned no new tokens (${reason})`,
      context: { trigger: reason, noopWithoutRotationCount },
      sessionMeta: meta,
    });

    if (needsStaleTokenWatchdog(meta, settings.staleTokenWatchdogHours)) {
      log.warn(
        `Token age ${meta.tokenAgeHours}h — noop refresh; scheduling retry in ${Math.round(settings.staleNoopRetryMs / 60000)} min`,
      );
      journal?.recordSuccess({
        type: 'stale_token_noop_retry_scheduled',
        source,
        message: `Noop refresh at token age ${meta.tokenAgeHours}h — aggressive retry scheduled`,
        context: { trigger: reason, retryInMinutes: Math.round(settings.staleNoopRetryMs / 60000) },
        sessionMeta: meta,
      });
      scheduleStaleNoopRetry('noop-retry-stale');
    }

    checkTokenRotationHealth(source, reason);
  }

  function scheduleStaleNoopRetry(reason) {
    if (staleNoopRetryTimer) {
      return;
    }
    staleNoopRetryTimer = setTimeout(() => {
      staleNoopRetryTimer = null;
      refreshSession(reason, { force: true, source: 'stale_noop_retry' });
    }, settings.staleNoopRetryMs);
  }

  function markFailure(reason, message, { source = 'keepalive', context = {} } = {}) {
    if (isRefreshDeferralMessage(message)) {
      return;
    }

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
    const sinceLastAttempt = lastRefreshAttemptAt ? Date.now() - lastRefreshAttemptAt : Infinity;
    if (sinceLastAttempt < settings.refreshIntervalMs) {
      return false;
    }
    const thresholdHours = Math.round(settings.proactiveRefreshAfterMs / 3600000);
    return meta.tokenAgeHours >= thresholdHours;
  }

  function shouldAttemptRefresh({ force = false } = {}) {
    if (force) {
      return true;
    }

    const meta = sessionMeta();
    if (!meta.hasRefreshToken) {
      return false;
    }

    const now = Date.now();
    const sinceLastAttempt = lastRefreshAttemptAt ? now - lastRefreshAttemptAt : Infinity;
    if (sinceLastAttempt < settings.refreshIntervalMs) {
      return false;
    }

    if (meta.tokenAgeHours == null) {
      return sinceLastAttempt >= settings.refreshIntervalMs;
    }

    const minAgeHours = Math.round(settings.minTokenAgeForRefreshMs / 3600000);
    return meta.tokenAgeHours >= minAgeHours;
  }

  function verifySessionLive(onComplete) {
    alexa.checkAuthentication((authenticated, err) => {
      if (err && authenticated === null) {
        onComplete?.(false);
        return;
      }
      if (!authenticated) {
        onComplete?.(false);
        return;
      }

      runLivenessProbe('refresh-verify', (ok) => {
        onComplete?.(ok);
      });
    });
  }

  function handleRefreshFailure(reason, message, { source = 'keepalive', onComplete } = {}) {
    lastRefreshAttemptAt = Date.now();
    lastRefreshError = message;

    if (isRefreshNoopFailure(message)) {
      log.debug(`Session refresh noop (${reason}) — Amazon returned no new tokens; existing session unchanged`);
      noteRefreshNoop(source, reason);
      onComplete?.(true);
      return;
    }

    log.warn(`Session refresh failed (${reason})`, message);

    verifySessionLive((live) => {
      if (live) {
        log.info(`Session refresh failed (${reason}) but auth checks still pass — not degrading session`);
        journal?.recordSuccess({
          type: 'token_refresh_failed_but_live',
          source,
          message: `Refresh failed but session still valid: ${message}`,
          context: { trigger: reason },
          sessionMeta: sessionMeta(),
        });
        onComplete?.(true);
        return;
      }

      journal?.recordFailure({
        type: 'token_refresh_failed',
        source,
        reason,
        message,
        context: { trigger: reason, sessionDead: true },
        sessionMeta: sessionMeta(),
      });
      markFailure(reason, message, { source, context: { phase: 'refresh' } });
      onComplete?.(false, message);
    });
  }

  function refreshSession(reason, { onComplete, source = 'keepalive', force = false } = {}) {
    if (refreshInFlight) {
      onComplete?.(false, 'refresh already in flight');
      return;
    }

    if (!force && !shouldAttemptRefresh({ force: false }) && reason === 'scheduled') {
      log.debug(`Skipping scheduled refresh (${reason}) — token too young or refresh attempted recently`);
      onComplete?.(true);
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
      lastRefreshAttemptAt = Date.now();

      if (err || !res) {
        const message = err?.message || String(err || 'empty refresh response');
        handleRefreshFailure(reason, message, { source, onComplete });
        return;
      }

      const beforeMeta = sessionMeta();
      alexa.setCookie(res);
      persistRefreshedSession(res, reason);
      markHealthy(source);
      const afterMeta = sessionMeta();
      if (tokenDateAdvanced(beforeMeta, afterMeta)) {
        noteSuccessfulTokenRotation(source, reason);
        log.info(`Session tokens refreshed (${reason})`, afterMeta);
      } else {
        log.info(`Session refresh returned cookies without rotating tokenDate (${reason})`, afterMeta);
        noteRefreshNoop(source, reason);
      }
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
            force: true,
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

  function finishPingCycle(reason, meta) {
    runLivenessProbe(reason, (ok) => {
      pingInFlight = false;
      if (!ok) {
        return;
      }

      markHealthy('keepalive');
      checkTokenRotationHealth('keepalive', reason);
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
  }

  function pingSession(reason = 'scheduled') {
    if (pingInFlight || refreshInFlight) {
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
          force: true,
          onComplete: () => finishPingCycle(reason, meta),
        });
        return;
      }

      if (!authenticated) {
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
          force: true,
          onComplete: () => finishPingCycle(reason, meta),
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

      const refreshReason = pickRefreshReason(meta, settings, {
        shouldProactive: shouldProactiveRefresh(),
        shouldScheduled: shouldAttemptRefresh(),
      });

      if (refreshReason) {
        if (refreshReason === 'proactive-age') {
          journal?.recordSuccess({
            type: 'proactive_refresh_triggered',
            source: 'keepalive',
            message: `Token age ${meta.tokenAgeHours}h — refreshing before expiry`,
            sessionMeta: meta,
          });
        }
        if (refreshReason === 'stale-token-watchdog') {
          journal?.recordSuccess({
            type: 'stale_token_watchdog',
            source: 'keepalive',
            message: `Token age ${meta.tokenAgeHours}h — forcing refresh before likely expiry`,
            sessionMeta: meta,
          });
        }
        refreshSession(refreshReason, {
          force: refreshReason === 'stale-token-watchdog',
          onComplete: () => finishPingCycle(reason, meta),
        });
        return;
      }

      finishPingCycle(reason, meta);
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

    if (isCookieRenewFailure(message)) {
      checkTokenRotationHealth(source, context.reason || source);
    }

    if (!isAuthRelatedMessage(message) && !isCookieRenewFailure(message)) {
      return;
    }

    if (refreshInFlight) {
      log.debug(`Deferring external refresh from ${source} — refresh already in flight`);
      return;
    }

    const now = Date.now();
    if (now - lastExternalRefreshRequestAt < settings.externalRefreshCooldownMs) {
      return;
    }
    lastExternalRefreshRequestAt = now;

    log.warn(`Auth-related failure from ${source}`, message);
    refreshSession(`external-${source}`, {
      source,
      force: true,
      onComplete: (ok, refreshMessage) => {
        if (!ok && !isRefreshDeferralMessage(refreshMessage)) {
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
        minTokenAgeForRefreshHours: Math.round(settings.minTokenAgeForRefreshMs / 3600000),
        proactiveRefreshAfterHours: Math.round(settings.proactiveRefreshAfterMs / 3600000),
        livenessProbe: settings.livenessProbe,
        refreshViaPing: true,
      },
      sessionMeta: sessionMeta(),
    });

    log.info('Session keep-alive enabled', {
      pingEveryMinutes: Math.round(settings.pingIntervalMs / 60000),
      refreshEveryHours: Math.round(settings.refreshIntervalMs / 3600000),
      minTokenAgeForRefreshHours: Math.round(settings.minTokenAgeForRefreshMs / 3600000),
      proactiveRefreshAfterHours: Math.round(settings.proactiveRefreshAfterMs / 3600000),
      livenessProbe: settings.livenessProbe,
      failureThreshold: settings.failureThreshold,
      refreshViaPing: true,
      journalPath: journal?.path,
    });

    pingTimer = setInterval(() => pingSession('scheduled'), settings.pingIntervalMs);
    setTimeout(() => pingSession('startup'), 30 * 1000);
    setTimeout(() => {
      const meta = sessionMeta();
      if (meta.hasRefreshToken && (meta.tokenAgeHours == null || meta.tokenAgeHours >= 1)) {
        refreshSession('startup-delayed', { force: true, source: 'startup' });
      }
    }, settings.startupRefreshDelayMs);
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
  isRefreshNoopFailure,
  needsStaleTokenWatchdog,
  pickRefreshReason,
};
