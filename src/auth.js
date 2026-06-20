const Alexa = require('alexa-remote2');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { loadSession, persistFromAlexa, buildAlexaInitOptions } = require('./session');

function isProxyLoginPrompt(error) {
  const message = String(error?.message || error || '');
  return message.includes('Please open http://');
}

function extractProxyUrl(error, config) {
  const message = String(error?.message || error || '');
  const match = message.match(/http:\/\/[^\s]+/);
  return match?.[0] || `http://${config.proxyOwnIp}:${config.proxyPort}/`;
}

function runAuth({ exitOnComplete = true } = {}) {
  const config = loadConfig();
  const log = createLogger(config);
  const existingSession = loadSession(config.sessionPath) || {};
  const alexa = new Alexa();
  let finished = false;

  log.info('Starting Alexa authentication');
  log.info('Locale settings', {
    amazonPage: existingSession.amazonPage || config.amazonPage,
    acceptLanguage: existingSession.acceptLanguage || config.acceptLanguage,
    amazonPageProxyLanguage: config.amazonPageProxyLanguage,
  });

  const initOptions = buildAlexaInitOptions(config, existingSession, { mode: 'auth' });
  initOptions.logger = config.debug ? log.debug.bind(log) : undefined;

  function finishSuccess() {
    if (finished) {
      return;
    }
    finished = true;

    persistFromAlexa(config, alexa, existingSession);
    log.info('Authentication complete');
    log.info(`Session saved to ${config.sessionPath}`);
    log.info('You can now run: npm start');

    if (exitOnComplete) {
      process.exit(0);
    }
  }

  return new Promise((resolve, reject) => {
    alexa.on('cookie', () => {
      if (!alexa.cookieData?.localCookie && !alexa.cookie) {
        return;
      }

      persistFromAlexa(config, alexa, existingSession);
      log.info(`Session saved to ${config.sessionPath}`);

      if (!finished) {
        finishSuccess();
        resolve(alexa);
      }
    });

    alexa.init(initOptions, (err) => {
      if (err) {
        if (isProxyLoginPrompt(err)) {
          const proxyUrl = extractProxyUrl(err, config);
          log.info(`Open this URL in your browser: ${proxyUrl}`);
          log.info('Log in with your Amazon account, complete 2FA if prompted');
          log.info('Waiting for login to complete...');
          return;
        }

        log.error('Authentication failed', err.message || err);
        if (exitOnComplete) {
          process.exitCode = 1;
        }
        reject(err);
        return;
      }

      finishSuccess();
      resolve(alexa);
    });
  });
}

if (require.main === module) {
  runAuth().catch(() => {
    if (!process.exitCode) {
      process.exit(1);
    }
  });
}

module.exports = {
  runAuth,
};
