const path = require('path');

const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

const REGION_BASE_URLS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
};

const DEFAULT_SCOPES = 'openid offline_access vehicle_device_data vehicle_location';

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function resolveTeslaFleetConfig(config, fileConfig = {}) {
  const fleet = fileConfig.teslaFleet || {};
  const region = String(process.env.TESLA_FLEET_REGION || fleet.region || 'na').toLowerCase();
  const fleetApiBase = REGION_BASE_URLS[region] || REGION_BASE_URLS.na;
  const sessionRel = fleet.sessionFile || 'data/tesla-session.json';
  const authStatusRel = fleet.authStatusFile || 'data/tesla-auth-status.json';

  return {
    enabled: fleet.enabled !== false,
    clientId: process.env.TESLA_CLIENT_ID || fleet.clientId || '',
    clientSecret: process.env.TESLA_CLIENT_SECRET || fleet.clientSecret || '',
    domain: normalizeDomain(process.env.TESLA_FLEET_DOMAIN || fleet.domain || ''),
    region,
    fleetApiBase,
    vin: String(process.env.TESLA_VIN || fleet.vin || '').trim(),
    redirectUri: process.env.TESLA_OAUTH_REDIRECT_URI
      || process.env.TESLA_REDIRECT_URI
      || fleet.redirectUri
      || 'http://localhost:4381/callback',
    scopes: fleet.scopes || DEFAULT_SCOPES,
    sessionFile: sessionRel,
    sessionPath: path.resolve(config.ROOT || path.resolve(__dirname, '..'), sessionRel),
    authStatusFile: authStatusRel,
    authStatusPath: path.resolve(config.ROOT || path.resolve(__dirname, '..'), authStatusRel),
    tokenUrl: TOKEN_URL,
    authorizeUrl: AUTHORIZE_URL,
    minRequestIntervalSec: Number(fleet.minRequestIntervalSec || 10),
  };
}

function requireTeslaCredentials(fleet) {
  const missing = [];
  if (!fleet.clientId) {
    missing.push('TESLA_CLIENT_ID');
  }
  if (!fleet.clientSecret) {
    missing.push('TESLA_CLIENT_SECRET');
  }
  if (missing.length) {
    throw new Error(
      `Missing Tesla credentials: ${missing.join(', ')}. Set them in .env or config teslaFleet.`,
    );
  }
}

module.exports = {
  TOKEN_URL,
  AUTHORIZE_URL,
  REGION_BASE_URLS,
  DEFAULT_SCOPES,
  normalizeDomain,
  resolveTeslaFleetConfig,
  requireTeslaCredentials,
};
