const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDomain,
  resolveTeslaFleetConfig,
  REGION_BASE_URLS,
} = require('../src/tesla-config');
const {
  sessionFromTokenResponse,
  decodeJwtExpiry,
} = require('../src/tesla-session');
const { parseRateLimitHeaders } = require('../src/tesla-http');
const {
  buildFleetReading,
  buildErrorReading,
  mapChargingLabel,
  resetFleetClientState,
  isFleetConfigured,
} = require('../src/tesla-fleet-client');

test('normalizeDomain strips scheme and path', () => {
  assert.equal(normalizeDomain('fleetapi.example.com'), 'fleetapi.example.com');
});

test('resolveTeslaFleetConfig reads env vars', () => {
  const prev = {
    id: process.env.TESLA_CLIENT_ID,
    secret: process.env.TESLA_CLIENT_SECRET,
    domain: process.env.TESLA_FLEET_DOMAIN,
    vin: process.env.TESLA_VIN,
    region: process.env.TESLA_FLEET_REGION,
  };
  process.env.TESLA_CLIENT_ID = 'test-id';
  process.env.TESLA_CLIENT_SECRET = 'test-secret';
  process.env.TESLA_FLEET_DOMAIN = 'fleetapi.example.com';
  process.env.TESLA_VIN = '5YJ3E1EA1KF000001';
  process.env.TESLA_FLEET_REGION = 'na';

  try {
    const fleet = resolveTeslaFleetConfig({ ROOT: '/app' });
    assert.equal(fleet.clientId, 'test-id');
    assert.equal(fleet.domain, 'fleetapi.example.com');
    assert.equal(fleet.vin, '5YJ3E1EA1KF000001');
    assert.equal(fleet.fleetApiBase, REGION_BASE_URLS.na);
    assert.match(fleet.sessionPath, /data[\\/]tesla-session\.json$/);
  } finally {
    for (const [key, value] of Object.entries({
      TESLA_CLIENT_ID: prev.id,
      TESLA_CLIENT_SECRET: prev.secret,
      TESLA_FLEET_DOMAIN: prev.domain,
      TESLA_VIN: prev.vin,
      TESLA_FLEET_REGION: prev.region,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('sessionFromTokenResponse sets expiresAt from expires_in', () => {
  const session = sessionFromTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
  assert.equal(session.accessToken, 'a');
  assert.equal(session.refreshToken, 'r');
  assert.ok(session.expiresAt);
});

test('decodeJwtExpiry reads exp claim', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url');
  const token = `${header}.${payload}.sig`;
  assert.equal(decodeJwtExpiry(token), new Date(1_700_000_000_000).toISOString());
});

test('parseRateLimitHeaders prefers Retry-After', () => {
  const headers = new Map([['Retry-After', '30']]);
  const fakeResponse = { headers: { get: (name) => headers.get(name) || null } };
  const parsed = parseRateLimitHeaders(fakeResponse);
  assert.equal(parsed.retryAfterSec, 30);
  assert.ok(parsed.limitResetAt);
});

test('buildFleetReading normalizes percent and charging label', () => {
  const reading = buildFleetReading({
    percent: 82.4,
    chargingState: 'Charging',
    batteryRange: 210,
    model: 'Model Y',
  });
  assert.equal(reading.percent, 82);
  assert.equal(reading.chargingLabel, 'Charging');
  assert.equal(reading.source, 'fleet-api');
  assert.equal(reading.status, 'ok');
  assert.equal(reading.batteryRange, 210);
  assert.equal(reading.rangeMiles, 210);
});

test('buildFleetReading rounds fractional range and mirrors rangeMiles', () => {
  const { normalizeBatteryRangeMiles } = require('../src/tesla-fleet-client');
  assert.equal(normalizeBatteryRangeMiles(161.56), 162);
  assert.equal(normalizeBatteryRangeMiles(0), null);
  assert.equal(normalizeBatteryRangeMiles(null), null);

  const reading = buildFleetReading({
    percent: 63,
    chargingState: 'Disconnected',
    batteryRange: 161.56,
  });
  assert.equal(reading.batteryRange, 162);
  assert.equal(reading.rangeMiles, 162);
});

test('readingFromVehiclePayload falls back to ideal_battery_range', () => {
  const { readingFromVehiclePayload } = require('../src/tesla-fleet-client');
  const reading = readingFromVehiclePayload({
    charge_state: {
      battery_level: 63,
      charging_state: 'Disconnected',
      ideal_battery_range: 188.2,
    },
    display_name: 'Model Y',
  });
  assert.equal(reading.percent, 63);
  assert.equal(reading.batteryRange, 188);
  assert.equal(reading.rangeMiles, 188);
});

test('readingFromVehiclePayload prefers rated battery_range over ideal', () => {
  const { readingFromVehiclePayload } = require('../src/tesla-fleet-client');
  const reading = readingFromVehiclePayload({
    charge_state: {
      battery_level: 59,
      battery_range: 161.56,
      est_battery_range: 155.1,
      ideal_battery_range: 188.2,
      charging_state: 'Disconnected',
    },
  });
  assert.equal(reading.batteryRange, 162);
  assert.equal(reading.rangeMiles, 162);
});

test('buildErrorReading maps rate limit and auth errors', () => {
  const limited = buildErrorReading({ status: 429, message: 'Rate limited', limitResetAt: '2026-07-08T20:00:00.000Z' });
  assert.equal(limited.status, 'rate_limited');
  assert.match(limited.error, /rate limit/i);

  const auth = buildErrorReading({ status: 401, message: 'login_required' });
  assert.equal(auth.status, 'auth_required');
});

test('mapChargingLabel handles common states', () => {
  assert.equal(mapChargingLabel('Charging'), 'Charging');
  assert.equal(mapChargingLabel('Disconnected'), 'Not plugged in');
});

test('isLocationScopeError detects missing vehicle_location scope', () => {
  const { isLocationScopeError } = require('../src/tesla-fleet-client');
  const error = new Error('Unauthorized missing scopes vehicle_location for vehicle location access');
  assert.equal(isLocationScopeError(error), true);
});

test('resolveTeslaFleetConfig includes vehicle_location scope by default', () => {
  const fleet = resolveTeslaFleetConfig({ ROOT: '/app' });
  assert.match(fleet.scopes, /vehicle_location/);
});

test('resolveTeslaFleetConfig prefers TESLA_OAUTH_REDIRECT_URI', () => {
  const prev = {
    oauth: process.env.TESLA_OAUTH_REDIRECT_URI,
    redirect: process.env.TESLA_REDIRECT_URI,
  };
  process.env.TESLA_OAUTH_REDIRECT_URI = 'http://192.168.1.50:4381/callback';
  process.env.TESLA_REDIRECT_URI = 'http://localhost:4381/callback';
  try {
    const fleet = resolveTeslaFleetConfig({ ROOT: '/app' });
    assert.equal(fleet.redirectUri, 'http://192.168.1.50:4381/callback');
  } finally {
    for (const [key, value] of Object.entries({
      TESLA_OAUTH_REDIRECT_URI: prev.oauth,
      TESLA_REDIRECT_URI: prev.redirect,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('resolveCallbackListen binds :4381 HTTP for public domain redirect', () => {
  const { resolveCallbackListen } = require('../src/tesla-auth');
  const listen = resolveCallbackListen({
    redirectUri: 'https://fleetapi.example.com/callback',
  });
  assert.equal(listen.redirectUri, 'https://fleetapi.example.com/callback');
  assert.equal(listen.port, 4381);
  assert.equal(listen.useHttps, false);
  assert.equal(listen.listenHost, '0.0.0.0');
  assert.equal(listen.pathname, '/callback');
});

test('resolveCallbackListen keeps loopback redirect as local listen', () => {
  const { resolveCallbackListen } = require('../src/tesla-auth');
  const listen = resolveCallbackListen('http://localhost:4381/callback');
  assert.equal(listen.port, 4381);
  assert.equal(listen.useHttps, false);
  assert.equal(listen.listenHost, 'localhost');
});

test('resolveCallbackListen honors TESLA_CALLBACK_LISTEN override', () => {
  const { resolveCallbackListen } = require('../src/tesla-auth');
  const listen = resolveCallbackListen({
    redirectUri: 'https://fleetapi.example.com/callback',
    callbackListenUri: 'http://127.0.0.1:9999/callback',
  });
  assert.equal(listen.port, 9999);
  assert.equal(listen.hostname, '127.0.0.1');
  assert.equal(listen.useHttps, false);
});

test('parseAuthorizationCodeArg reads --code flag', () => {
  const { parseAuthorizationCodeArg } = require('../src/tesla-auth');
  assert.equal(parseAuthorizationCodeArg(['node', 'auth', '--code', 'NA_abc']), 'NA_abc');
  assert.equal(parseAuthorizationCodeArg(['node', 'auth', '--code=NA_xyz']), 'NA_xyz');
});

test('isFleetConfigured requires client credentials', () => {
  assert.equal(isFleetConfigured({ enabled: true, clientId: 'id', clientSecret: 'secret' }), true);
  assert.equal(isFleetConfigured({ enabled: true, clientId: 'id' }), false);
  assert.equal(isFleetConfigured({ enabled: false, clientId: 'id', clientSecret: 'secret' }), false);
});
