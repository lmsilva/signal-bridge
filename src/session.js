const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadSession(sessionPath) {
  if (!fs.existsSync(sessionPath)) {
    return null;
  }

  const raw = fs.readFileSync(sessionPath, 'utf8');
  return JSON.parse(raw);
}

function saveSession(sessionPath, session) {
  ensureParentDir(sessionPath);
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function buildAlexaInitOptions(config, session = {}, { mode = 'listener' } = {}) {
  const isAuth = mode === 'auth';
  const options = {
    amazonPage: session.amazonPage || config.amazonPage,
    acceptLanguage: session.acceptLanguage || config.acceptLanguage,
    amazonPageProxyLanguage: config.amazonPageProxyLanguage,
    useWsMqtt: !isAuth,
    autoQueryActivityOnTrigger: !isAuth,
    proxyOwnIp: config.proxyOwnIp,
    proxyPort: config.proxyPort,
    proxyLogLevel: isAuth ? 'info' : 'warn',
    setupProxy: isAuth,
    proxyOnly: isAuth,
  };

  if (isAuth) {
    options.baseAmazonPage = session.amazonPage || config.amazonPage;
    options.formerDataStorePath = config.formerDataStorePath;
    const registrationData = session.cookieData || session.formerRegistrationData;
    if (registrationData) {
      options.formerRegistrationData = registrationData;
    }
    return options;
  }

  const refreshMs = config.sessionKeepAlive?.cookieRefreshIntervalMs
    ?? config.cookieRefreshIntervalMs
    ?? 6 * 60 * 60 * 1000;
  options.cookieRefreshInterval = refreshMs;

  if (session.cookieData) {
    options.cookie = session.cookieData;
    options.formerRegistrationData = session.cookieData;
    if (session.cookieData.macDms) {
      options.macDms = session.cookieData.macDms;
    }
    return options;
  }

  if (session.formerRegistrationData) {
    options.formerRegistrationData = session.formerRegistrationData;
    options.cookie = session.formerRegistrationData.localCookie || session.formerRegistrationData.cookie;
    if (session.formerRegistrationData.macDms) {
      options.macDms = session.formerRegistrationData.macDms;
    }
    return options;
  }

  return null;
}

function persistFromAlexa(config, alexa, existingSession = {}) {
  const cookieData = alexa.cookieData || existingSession.cookieData || existingSession.formerRegistrationData;

  const session = {
    amazonPage: existingSession.amazonPage || config.amazonPage,
    acceptLanguage: existingSession.acceptLanguage || config.acceptLanguage,
    savedAt: new Date().toISOString(),
    cookieData,
    formerRegistrationData: cookieData,
  };

  saveSession(config.sessionPath, session);
  return session;
}

module.exports = {
  loadSession,
  saveSession,
  buildAlexaInitOptions,
  persistFromAlexa,
};
