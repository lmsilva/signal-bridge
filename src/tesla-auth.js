const http = require('http');
const { exec } = require('child_process');
const { URL } = require('url');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { ensurePortAvailable } = require('./port-utils');
const { resolveTeslaFleetConfig, requireTeslaCredentials } = require('./tesla-config');
const { loadTeslaSession, saveTeslaSession, sessionFromTokenResponse } = require('./tesla-session');
const { exchangeAuthorizationCode } = require('./tesla-token-refresh');

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start "" "${url}"`);
    return;
  }
  if (platform === 'darwin') {
    exec(`open "${url}"`);
    return;
  }
  exec(`xdg-open "${url}"`);
}

function resolveListenHost(hostname) {
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    return hostname || 'localhost';
  }
  return '0.0.0.0';
}

function parseRedirect(redirectUri) {
  const parsed = new URL(redirectUri);
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  const hostname = parsed.hostname || 'localhost';
  const pathname = parsed.pathname || '/callback';
  return { hostname, port, pathname };
}

function buildAuthorizeUrl(fleet, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: fleet.clientId,
    redirect_uri: fleet.redirectUri,
    scope: fleet.scopes,
    state,
    prompt_missing_scopes: 'true',
  });
  return `${fleet.authorizeUrl}?${params.toString()}`;
}

function successHtml() {
  return `<!DOCTYPE html><html><head><title>Tesla auth complete</title></head>
<body style="font-family:sans-serif;padding:2rem">
<h1>Tesla login complete</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;
}

function errorHtml(message) {
  return `<!DOCTYPE html><html><head><title>Tesla auth failed</title></head>
<body style="font-family:sans-serif;padding:2rem">
<h1>Tesla login failed</h1><p>${message}</p>
</body></html>`;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function waitForCallback(fleet, state, log) {
  const { hostname, port, pathname } = parseRedirect(fleet.redirectUri);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const finishWithError = async (error) => {
        try {
          await closeServer(server);
        } catch {
          // ignore close errors while rejecting auth failure
        }
        reject(error);
      };

      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || hostname}`);
      if (reqUrl.pathname !== pathname) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = reqUrl.searchParams.get('error');
      const errorDescription = reqUrl.searchParams.get('error_description');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(`${error}: ${errorDescription || ''}`), () => {
          finishWithError(new Error(`Tesla auth error: ${error} ${errorDescription || ''}`.trim()));
        });
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('Missing authorization code'));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('State mismatch'), () => {
          finishWithError(new Error('Tesla auth state mismatch'));
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml(), () => {
        closeServer(server).then(() => resolve(code)).catch(reject);
      });
    });

    server.on('error', reject);
    const listenHost = resolveListenHost(hostname);
    server.listen(port, listenHost, () => {
      log.info(`Listening for Tesla callback on ${fleet.redirectUri} (bind ${listenHost}:${port})`);
    });
  });
}

async function saveTokensFromCode(fleet, code, log) {
  log.info('Exchanging authorization code for tokens...');
  const tokenData = await exchangeAuthorizationCode(fleet, code);
  const existing = loadTeslaSession(fleet.sessionPath) || {};
  const session = sessionFromTokenResponse(tokenData, existing);
  saveTeslaSession(fleet.sessionPath, session);

  log.info(`Tesla session saved to ${fleet.sessionPath}`);
  if (!session.refreshToken) {
    log.warn('No refresh token returned — ensure offline_access scope is enabled on your Tesla app');
  }
  if (fleet.domain) {
    log.info(`Pair virtual key on your phone: https://www.tesla.com/_ak/${fleet.domain}`);
  }
  log.info('Tesla authentication complete');
  return session;
}

function parseAuthorizationCodeArg(argv = process.argv) {
  const codeFlag = argv.find((arg) => arg.startsWith('--code='));
  if (codeFlag) {
    return codeFlag.slice('--code='.length).trim() || null;
  }
  const codeIndex = argv.indexOf('--code');
  if (codeIndex >= 0 && argv[codeIndex + 1]) {
    return String(argv[codeIndex + 1]).trim() || null;
  }
  return null;
}

async function runTeslaAuth({ exitOnComplete = true, authorizationCode = null } = {}) {
  const config = loadConfig();
  const log = createLogger(config);
  const fleet = resolveTeslaFleetConfig(config);
  requireTeslaCredentials(fleet);

  log.info('Starting Tesla OAuth');
  log.info(`Redirect URI: ${fleet.redirectUri}`);
  log.info(`Scopes: ${fleet.scopes}`);
  log.info(`Region: ${fleet.region} (${fleet.fleetApiBase})`);
  if (fleet.domain) {
    log.info(`Fleet domain: ${fleet.domain}`);
  }

  if (authorizationCode) {
    const session = await saveTokensFromCode(fleet, authorizationCode, log);
    if (exitOnComplete) {
      process.exit(0);
    }
    return session;
  }

  const { port } = parseRedirect(fleet.redirectUri);
  const portReady = await ensurePortAvailable(port, log);
  if (!portReady) {
    if (exitOnComplete) {
      process.exitCode = 1;
    }
    throw new Error(`Port ${port} is in use`);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const authorizeUrl = buildAuthorizeUrl(fleet, state);

  const callbackPromise = waitForCallback(fleet, state, log);
  log.info(`Open this URL in your browser:\n${authorizeUrl}`);
  openBrowser(authorizeUrl);
  log.info('Waiting for Tesla login to complete...');

  const code = await callbackPromise;
  log.info('Authorization code received');
  const session = await saveTokensFromCode(fleet, code, log);

  if (exitOnComplete) {
    setImmediate(() => process.exit(0));
    return session;
  }
  return session;
}

if (require.main === module) {
  const authorizationCode = parseAuthorizationCodeArg();
  runTeslaAuth({ authorizationCode }).catch((error) => {
    console.error(error?.message || error);
    if (!process.exitCode) {
      process.exit(1);
    }
  });
}

module.exports = {
  runTeslaAuth,
  buildAuthorizeUrl,
  parseRedirect,
  resolveListenHost,
  parseAuthorizationCodeArg,
  saveTokensFromCode,
};
