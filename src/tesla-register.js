const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { resolveTeslaFleetConfig, requireTeslaCredentials } = require('./tesla-config');
const { fetchPartnerToken } = require('./tesla-token-refresh');
const { fetchJson } = require('./tesla-http');

const REGISTER_TIMEOUT_MS = 120_000;

async function fetchPartnerAccessToken(fleet) {
  const partnerToken = await fetchPartnerToken(fleet);
  const accessToken = partnerToken.access_token;
  if (!accessToken) {
    throw new Error('Partner token response missing access_token');
  }
  return accessToken;
}

async function verifyPublicKey(fleet, accessToken) {
  const verifyUrl = `${fleet.fleetApiBase}/api/1/partner_accounts/public_key?domain=${encodeURIComponent(fleet.domain)}`;
  const verify = await fetchJson(verifyUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    timeoutMs: 60_000,
  });
  return {
    ok: verify.response.ok,
    status: verify.response.status,
    data: verify.data?.response ?? verify.data,
  };
}

function isRegistrationInProgressError(message) {
  return /other update in progress/i.test(String(message || ''));
}

async function registerPartnerDomain(fleet, log, { verifyOnly = false } = {}) {
  if (!fleet.domain) {
    throw new Error('Missing TESLA_FLEET_DOMAIN — set it in .env');
  }

  log.info('Requesting partner token...');
  const accessToken = await fetchPartnerAccessToken(fleet);

  if (verifyOnly) {
    log.info(`Verifying registration for ${fleet.domain}...`);
    const verified = await verifyPublicKey(fleet, accessToken);
    if (!verified.ok) {
      throw new Error(`Domain not registered yet (HTTP ${verified.status})`);
    }
    log.info('Domain registration verified', verified.data);
    log.info(`Pair virtual key: https://www.tesla.com/_ak/${fleet.domain}`);
    return verified.data;
  }

  const registerUrl = `${fleet.fleetApiBase}/api/1/partner_accounts`;
  log.info(`Registering domain ${fleet.domain} in ${fleet.region} region...`);

  const { response, data } = await fetchJson(registerUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ domain: fleet.domain }),
    timeoutMs: REGISTER_TIMEOUT_MS,
  });

  if (!response.ok) {
    const message = data?.error || data?.error_description || data?.raw || `HTTP ${response.status}`;
    if (isRegistrationInProgressError(message)) {
      log.warn('Tesla reports a registration update is already in progress — checking status...');
      const verified = await verifyPublicKey(fleet, accessToken);
      if (verified.ok) {
        log.info('Domain is already registered with Tesla', verified.data);
        log.info(`Pair virtual key: https://www.tesla.com/_ak/${fleet.domain}`);
        return verified.data;
      }
      throw new Error(
        'Partner register in progress on Tesla side — wait 5–15 minutes, then run: '
        + 'node src/tesla-register.js --verify-only',
      );
    }
    throw new Error(`Partner register failed: ${message}`);
  }

  log.info('Partner domain registered', data?.response || data);

  const verified = await verifyPublicKey(fleet, accessToken);
  if (verified.ok) {
    log.info('Public key verification', verified.data);
  } else {
    log.warn('Could not verify public key — confirm PEM is hosted at:');
    log.warn(`https://${fleet.domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
  }

  log.info(`Pair virtual key: https://www.tesla.com/_ak/${fleet.domain}`);
  return data;
}

async function runTeslaRegister({ exitOnComplete = true, verifyOnly = false } = {}) {
  const config = loadConfig();
  const log = createLogger(config);
  const fleet = resolveTeslaFleetConfig(config);
  requireTeslaCredentials(fleet);

  await registerPartnerDomain(fleet, log, { verifyOnly });

  if (exitOnComplete) {
    process.exit(0);
  }
}

if (require.main === module) {
  const verifyOnly = process.argv.includes('--verify-only');
  runTeslaRegister({ verifyOnly }).catch((error) => {
    console.error(error?.message || error);
    if (!process.exitCode) {
      process.exit(1);
    }
  });
}

module.exports = {
  runTeslaRegister,
  registerPartnerDomain,
  verifyPublicKey,
};
