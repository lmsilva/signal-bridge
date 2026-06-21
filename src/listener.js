const Alexa = require('alexa-remote2');
const path = require('path');
const { createBroadcastLog } = require('./broadcast-log');
const { BroadcastParser } = require('./parser');
const { buildAlexaInitOptions, persistFromAlexa, loadSession } = require('./session');
const { loadBridgeState, saveBridgeState, fingerprint } = require('./bridge-state');
const { getActivityId } = require('./parser');
const { buildNetworkPayload } = require('./message-details');
const { createUdpBroadcaster } = require('./broadcast-udp');
const { createSessionKeepAlive } = require('./session-keepalive');
const { markReauthRequired, clearAuthStatus, readAuthStatus } = require('./auth-status');

const VOLUME_POLL_DELAY_MS = 2000;
const HISTORY_LOOKBACK_MS = 2 * 60 * 1000;
const PERIODIC_LOOKBACK_MS = 15 * 60 * 1000;
const PERIODIC_POLL_MS = 60 * 1000;
const HEALTH_LOG_MS = 5 * 60 * 1000;

function createListener({ config, log }) {
  const alexa = new Alexa();
  const bridgeState = loadBridgeState(config.bridgeStatePath, config.broadcastLogPath);
  const parser = new BroadcastParser({
    ...bridgeState,
    fingerprintFn: fingerprint,
  });
  const broadcastLog = createBroadcastLog(config.broadcastLogPath);
  const udpBroadcaster = createUdpBroadcaster(config, log);

  function persistBridgeState() {
    saveBridgeState(config.bridgeStatePath, parser.getState());
  }
  let volumePollTimer = null;
  let historyPollInFlight = false;
  let periodicPollTimer = null;
  let healthTimer = null;
  let sessionKeepAlive = null;
  let lastPollAt = null;
  let lastPollCount = 0;
  let lastPollError = null;
  let lastCaptureAt = bridgeState.lastRecordedTimestamp || null;

  function recordBroadcast(record) {
    if (!record?.message) {
      return;
    }

    log.broadcast(record);
    broadcastLog.append(record);
    persistBridgeState();

    const networkPayload = buildNetworkPayload(record, config);
    udpBroadcaster.send(networkPayload);
    lastCaptureAt = Date.now();
    log.info(`Recorded to ${broadcastLog.path} and sent UDP broadcast`);
  }

  function inspectActivity(activity, trigger) {
    log.debug('Activity received', {
      trigger,
      summary: activity?.description?.summary,
      response: activity?.alexaResponse,
      device: activity?.name || activity?.deviceSerialNumber,
    });

    const record = parser.parseActivity(activity);
    if (record) {
      record.trigger = record.trigger || trigger;
      parser.markRecorded(getActivityId(activity), record);
      recordBroadcast(record);
      return;
    }

    if (config.debug) {
      const summary = activity?.description?.summary;
      const response = activity?.alexaResponse;
      if (summary || response) {
        log.debug('Activity ignored (not an announcement)', { trigger, summary, response });
      }
    }
  }

  function pollRecentHistory(reason, lookbackMs = HISTORY_LOOKBACK_MS) {
    if (historyPollInFlight) {
      return;
    }

    historyPollInFlight = true;
    log.debug(`Polling voice history (${reason})`);

    const historyStart = Math.max(
      Date.now() - lookbackMs,
      parser.lastRecordedTimestamp + 1,
    );

    alexa.getCustomerHistoryRecords(
      {
        startTime: historyStart,
        filter: false,
        forceRequest: true,
      },
      (err, records) => {
        historyPollInFlight = false;
        lastPollAt = Date.now();

        if (err) {
          lastPollError = err.message || String(err);
          log.warn(`History poll failed (${reason})`, lastPollError);
          return;
        }

        lastPollError = null;
        lastPollCount = records?.length || 0;

        if (lastPollCount === 0) {
          log.debug(`History poll (${reason}): no records`);
          return;
        }

        log.debug(`History poll (${reason}): ${lastPollCount} records`);

        records
          .slice()
          .sort((a, b) => (a.creationTimestamp || 0) - (b.creationTimestamp || 0))
          .forEach((activity) => inspectActivity(activity, `history-${reason}`));
      },
    );
  }

  function logHealth() {
    const pushConnected = alexa.isPushConnected?.() ?? false;
    const authStatus = readAuthStatus(config);
    log.info('Health check', {
      pushConnected,
      lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      lastPollCount,
      lastPollError,
      lastCaptureAt: lastCaptureAt ? new Date(lastCaptureAt).toISOString() : null,
      sessionPath: config.sessionPath,
      sessionKeepAlive: sessionKeepAlive?.getStatus?.() || null,
      authStatus: authStatus?.status || 'ok',
    });

    if (authStatus?.status === 'reauth_required') {
      log.error('Amazon session requires re-authentication');
      log.error('Run on the NAS: PROXY_OWN_IP=YOUR_NAS_IP docker compose -f docker-compose.auth.yml up');
      log.error(`Details written to ${path.join(path.dirname(config.sessionPath), 'auth-status.json')}`);
    }

    if (!pushConnected) {
      log.warn('Push channel disconnected — relying on history polling only');
    }

    if (lastPollError) {
      log.warn('History API errors detected — you may need to re-authenticate (./reauth.sh)');
    }
  }

  function scheduleHistoryPoll(reason) {
    clearTimeout(volumePollTimer);
    volumePollTimer = setTimeout(() => pollRecentHistory(reason, HISTORY_LOOKBACK_MS), VOLUME_POLL_DELAY_MS);
  }

  function wireEvents() {
    alexa.on('cookie', () => {
      const existingSession = loadSession(config.sessionPath) || {};
      persistFromAlexa(config, alexa, existingSession);
      clearAuthStatus(config);
      log.info('Session refreshed and saved');
    });

    alexa.on('ws-connect', () => {
      log.info('Connected to Alexa push channel');
      scheduleHistoryPoll('connect');
    });

    alexa.on('ws-disconnect', (retries, message) => {
      log.warn('Disconnected from Alexa push channel', { retries, message });
    });

    alexa.on('ws-error', (error) => {
      log.error('Alexa push channel error', error?.message || error);
    });

    alexa.on('ws-device-activity', (activity) => {
      inspectActivity(activity, 'device-activity');
    });

    alexa.on('ws-volume-change', (payload) => {
      log.debug('Volume change detected', payload);
      scheduleHistoryPoll('volume-change');
    });

    alexa.on('ws-unknown-command', (command, payload) => {
      log.debug('Unknown push command', { command, payload });
    });
  }

  function start() {
    const session = loadSession(config.sessionPath);
    if (!session) {
      return Promise.reject(new Error(`No session found at ${config.sessionPath}. Run: npm run auth`));
    }

    const initOptions = buildAlexaInitOptions(config, session, { mode: 'listener' });
    if (!initOptions) {
      return Promise.reject(new Error('Session file is missing authentication data. Run: npm run auth'));
    }

    initOptions.logger = config.debug ? log.debug.bind(log) : undefined;
    wireEvents();

    return new Promise((resolve, reject) => {
      alexa.init(initOptions, (err) => {
        if (err) {
          reject(err);
          return;
        }

        const deviceCount = Object.keys(alexa.serialNumbers || {}).length;
        log.info('Alexa bridge ready', {
          devices: deviceCount,
          logFile: broadcastLog.path,
          amazonPage: initOptions.amazonPage,
        });
        log.info('Listening for broadcast/announcement activity. Press Ctrl+C to stop.');
        log.info('Captures voice commands like: "Alexa, announce ..." or "Alexa, broadcast ..."');
        if (bridgeState.lastRecordedTimestamp > 0 || bridgeState.recordedFingerprints?.length) {
          log.info('Loaded dedup state from disk', {
            lastRecorded: bridgeState.lastRecordedTimestamp
              ? new Date(bridgeState.lastRecordedTimestamp).toISOString()
              : null,
            knownMessages: bridgeState.recordedFingerprints?.length || 0,
          });
        }

        if (udpBroadcaster.settings.enabled) {
          log.info('UDP broadcast enabled', {
            port: udpBroadcaster.settings.port,
            targets: udpBroadcaster.settings.targets.length,
          });
        }

        periodicPollTimer = setInterval(() => {
          pollRecentHistory('periodic', PERIODIC_LOOKBACK_MS);
        }, PERIODIC_POLL_MS);

        healthTimer = setInterval(logHealth, HEALTH_LOG_MS);
        logHealth();

        sessionKeepAlive = createSessionKeepAlive({
          alexa,
          config,
          log,
          onReauthRequired: (details) => markReauthRequired(config, details),
          onSessionHealthy: () => clearAuthStatus(config),
        });
        sessionKeepAlive.start();

        resolve(alexa);
      });
    });
  }

  return {
    start,
    alexa,
    udpBroadcaster,
  };
}

module.exports = {
  createListener,
};
