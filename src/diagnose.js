const Alexa = require('alexa-remote2');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { buildAlexaInitOptions, loadSession } = require('./session');

async function diagnose() {
  const config = loadConfig();
  const log = createLogger({ ...config, debug: true });
  const session = loadSession(config.sessionPath);

  if (!session) {
    log.error('No session file', config.sessionPath);
    process.exit(1);
  }

  log.info('Session file found', {
    savedAt: session.savedAt,
    path: config.sessionPath,
  });

  const alexa = new Alexa();
  const initOptions = buildAlexaInitOptions(config, session);
  initOptions.logger = log.debug.bind(log);

  await new Promise((resolve, reject) => {
    alexa.init(initOptions, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  const devices = Object.keys(alexa.serialNumbers || {}).length;
  const pushConnected = alexa.isPushConnected();

  log.info('Authentication OK', { devices, pushConnected });

  await new Promise((resolve) => {
    alexa.getCustomerHistoryRecords(
      {
        startTime: Date.now() - 24 * 60 * 60 * 1000,
        filter: false,
        forceRequest: true,
      },
      (err, records) => {
        if (err) {
          log.error('History API failed — session may need re-auth', err.message || err);
          resolve();
          return;
        }

        log.info(`History API OK — ${records?.length || 0} records in last 24h`);
        (records || []).slice(-5).forEach((activity, index) => {
          log.info(`Recent ${index + 1}`, {
            time: activity.creationTimestamp
              ? new Date(activity.creationTimestamp).toISOString()
              : null,
            device: activity.name,
            summary: activity?.description?.summary,
          });
        });
        resolve();
      },
    );
  });

  if (!pushConnected) {
    log.warn('Push channel is NOT connected — live events will be missed until reconnect');
    log.warn('Try: npm run auth  (or restart container after re-auth)');
  }

  process.exit(0);
}

diagnose().catch((error) => {
  console.error('Diagnose failed:', error.message || error);
  console.error('Run: npm run auth');
  process.exit(1);
});
