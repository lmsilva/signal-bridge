const fs = require('fs');
const path = require('path');
const { fetchJson, parseRateLimitHeaders } = require('./tesla-http');
const { getValidAccessToken } = require('./tesla-token-refresh');
const { clampPercent } = require('./tesla-battery');
const { buildDashboardFromVehicleData, buildDashboardErrorReading } = require('./tesla-dashboard-data');
const { markTeslaReauthRequired, clearTeslaAuthStatus } = require('./tesla-auth-status');

const MODEL_LABELS = {
  modely: 'Model Y',
  model3: 'Model 3',
  models: 'Model S',
  modelx: 'Model X',
};

let lastFetchAt = 0;
let rateLimitUntil = null;
let cachedVin = null;

function unwrapTeslaBody(data) {
  if (data?.response != null) {
    return data.response;
  }
  return data;
}

function teslaApiError(response, data, fallback) {
  const error = new Error(
    data?.error_description
    || data?.error
    || fallback
    || `HTTP ${response?.status}`,
  );
  error.status = response?.status;
  error.body = data;
  return error;
}

function isFleetConfigured(fleet) {
  return Boolean(
    fleet?.enabled !== false
    && fleet?.clientId
    && fleet?.clientSecret,
  );
}

function isRateLimited() {
  if (!rateLimitUntil) {
    return false;
  }
  if (Date.parse(rateLimitUntil) <= Date.now()) {
    rateLimitUntil = null;
    return false;
  }
  return true;
}

function setRateLimit(limitResetAt) {
  if (limitResetAt) {
    rateLimitUntil = limitResetAt;
    return;
  }
  rateLimitUntil = new Date(Date.now() + 60_000).toISOString();
}

function persistRateLimitState(fleet, limitResetAt) {
  if (!fleet?.sessionPath) {
    return;
  }
  const filePath = path.join(path.dirname(fleet.sessionPath), 'tesla-rate-limit.json');
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({
      limitResetAt,
      savedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  } catch {
    // optional persistence
  }
}

function loadPersistedRateLimit(fleet) {
  if (!fleet?.sessionPath) {
    return;
  }
  const filePath = path.join(path.dirname(fleet.sessionPath), 'tesla-rate-limit.json');
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.limitResetAt && Date.parse(data.limitResetAt) > Date.now()) {
      rateLimitUntil = data.limitResetAt;
    }
  } catch {
    // ignore
  }
}

function mapVehicleModel(vehicleData) {
  const carType = String(
    vehicleData?.vehicle_state?.car_type
    || vehicleData?.car_type
    || '',
  ).toLowerCase();
  return MODEL_LABELS[carType] || vehicleData?.display_name || 'Tesla';
}

function mapChargingLabel(chargingState) {
  const state = String(chargingState || '').trim();
  if (!state) {
    return null;
  }
  if (/^charging$/i.test(state)) {
    return 'Charging';
  }
  if (/complete/i.test(state)) {
    return 'Charge complete';
  }
  if (/disconnected/i.test(state)) {
    return 'Not plugged in';
  }
  return state;
}

/** Rated/est/ideal range → whole miles for the battery overlay (null if unknown). */
function normalizeBatteryRangeMiles(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

function buildFleetReading({
  percent,
  chargingState,
  batteryRange,
  model,
  status = 'ok',
  error = null,
  limitResetAt = null,
  source = 'fleet-api',
}) {
  const rangeMiles = normalizeBatteryRangeMiles(batteryRange);
  return {
    percent: percent == null ? null : clampPercent(percent),
    chargingState: chargingState || null,
    chargingLabel: mapChargingLabel(chargingState),
    // Send both keys — older display clients only read `rangeMiles`.
    batteryRange: rangeMiles,
    rangeMiles,
    model: model || 'Model Y',
    label: error ? 'Battery unavailable' : 'Battery',
    source,
    status,
    error,
    limitResetAt,
  };
}

function buildErrorReading(error, { limitResetAt } = {}) {
  const status = error?.status;
  let code = 'error';
  let message = error?.message || 'Could not reach Tesla';

  if (status === 429 || error?.code === 'rate_limited') {
    code = 'rate_limited';
    message = 'Tesla rate limit reached';
  } else if (status === 401 || /login_required|invalid_grant|tesla-auth/i.test(message)) {
    code = 'auth_required';
    message = 'Tesla login required — run npm run tesla-auth';
  } else if (status === 402 || status === 403) {
    code = 'billing';
    message = 'Tesla API paused (billing or access)';
  } else if (status === 408 || /asleep|offline|unavailable/i.test(message)) {
    code = 'vehicle_offline';
    message = 'Vehicle unavailable';
  } else if (status === 503 || status >= 500) {
    code = 'unreachable';
    message = 'Could not reach Tesla';
  }

  return buildFleetReading({
    percent: null,
    model: 'Model Y',
    status: code,
    error: message,
    limitResetAt: limitResetAt || error?.limitResetAt || null,
  });
}

async function authorizedGet(fleet, urlPath, accessToken) {
  const url = urlPath.startsWith('http') ? urlPath : `${fleet.fleetApiBase}${urlPath}`;
  const { response, data } = await fetchJson(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 429) {
    const limits = parseRateLimitHeaders(response);
    setRateLimit(limits.limitResetAt);
    persistRateLimitState(fleet, limits.limitResetAt);
    const error = teslaApiError(response, data, 'Rate limited');
    error.code = 'rate_limited';
    error.limitResetAt = limits.limitResetAt;
    throw error;
  }

  if (!response.ok) {
    throw teslaApiError(response, data);
  }

  return unwrapTeslaBody(data);
}

async function resolveVin(fleet, accessToken) {
  if (fleet.vin) {
    return fleet.vin;
  }
  if (cachedVin) {
    return cachedVin;
  }

  const vehicles = await authorizedGet(fleet, '/api/1/vehicles', accessToken);
  const list = Array.isArray(vehicles) ? vehicles : vehicles?.vehicles || [];
  if (!list.length) {
    throw new Error('No Tesla vehicles on account');
  }
  const first = list[0];
  const vin = first?.vin || first?.id_s || first?.vehicle_id;
  if (!vin) {
    throw new Error('Could not resolve Tesla VIN');
  }
  cachedVin = String(vin);
  return cachedVin;
}

async function wakeVehicle(fleet, accessToken, vin, log) {
  log?.info?.('Tesla vehicle asleep — sending wake_up');
  const url = `${fleet.fleetApiBase}/api/1/vehicles/${encodeURIComponent(vin)}/wake_up`;
  const { response, data } = await fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 429) {
    const limits = parseRateLimitHeaders(response);
    setRateLimit(limits.limitResetAt);
    const error = teslaApiError(response, data, 'Wake rate limited');
    error.limitResetAt = limits.limitResetAt;
    throw error;
  }
  if (!response.ok && response.status !== 408) {
    throw teslaApiError(response, data, 'Wake failed');
  }
  return unwrapTeslaBody(data);
}

async function fetchVehicleData(fleet, accessToken, vin, { endpoints } = {}) {
  let path = `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`;
  if (endpoints) {
    path += `?endpoints=${encodeURIComponent(endpoints)}`;
  }
  return authorizedGet(fleet, path, accessToken);
}

async function fetchVehicleSnapshot(fleet, accessToken, vin) {
  return authorizedGet(
    fleet,
    `/api/1/vehicles/${encodeURIComponent(vin)}`,
    accessToken,
  );
}

function readingFromVehiclePayload(vehicleData) {
  const charge = vehicleData?.charge_state || {};
  const percent = charge.battery_level ?? charge.usable_battery_level;
  return buildFleetReading({
    percent,
    chargingState: charge.charging_state,
    // Prefer rated, then estimated, then ideal — some partial payloads omit one.
    batteryRange: charge.battery_range
      ?? charge.est_battery_range
      ?? charge.ideal_battery_range,
    model: mapVehicleModel(vehicleData),
    status: percent == null ? 'error' : 'ok',
    error: percent == null ? 'Battery level unavailable' : null,
  });
}

async function fetchTeslaBattery(config, log) {
  const fleet = config.teslaFleet;
  if (!isFleetConfigured(fleet)) {
    throw new Error('Tesla Fleet API not configured');
  }

  loadPersistedRateLimit(fleet);

  const minIntervalMs = Math.max(0, Number(fleet.minRequestIntervalSec || 0)) * 1000;
  const now = Date.now();
  if (minIntervalMs > 0 && lastFetchAt > 0 && now - lastFetchAt < minIntervalMs) {
    return buildErrorReading(new Error('Request throttled'), {
      limitResetAt: new Date(lastFetchAt + minIntervalMs).toISOString(),
    });
  }

  if (isRateLimited()) {
    return buildErrorReading(
      { code: 'rate_limited', message: 'Tesla rate limit reached', limitResetAt: rateLimitUntil },
      { limitResetAt: rateLimitUntil },
    );
  }

  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(fleet, { log }));
  } catch (error) {
    if (error?.status === 401 || /login_required|refresh_token is invalid|invalid_grant/i.test(error?.message || '')) {
      markTeslaReauthRequired(fleet, { message: error.message, reason: 'token_invalid' });
    }
    return buildErrorReading(error);
  }

  const vin = await resolveVin(fleet, accessToken);
  lastFetchAt = Date.now();

  let vehicleData;
  try {
    vehicleData = await fetchVehicleData(fleet, accessToken, vin);
  } catch (error) {
    if (error.status === 401) {
      try {
        ({ accessToken } = await getValidAccessToken(fleet, { log, forceRefresh: true }));
        vehicleData = await fetchVehicleData(fleet, accessToken, vin);
      } catch (retryError) {
        markTeslaReauthRequired(fleet, {
          message: retryError.message || error.message,
          reason: 'api_unauthorized',
        });
        return buildErrorReading(retryError);
      }
    } else if (error.status === 429) {
      return buildErrorReading(error, { limitResetAt: error.limitResetAt });
    } else {
      const asleep = error.status === 408 || /asleep|offline/i.test(error.message || '');
      if (!asleep) {
        try {
          vehicleData = await fetchVehicleSnapshot(fleet, accessToken, vin);
          const reading = readingFromVehiclePayload(vehicleData);
          if (reading.percent != null) {
            return reading;
          }
        } catch {
          // fall through to wake attempt
        }
      }

      try {
        await wakeVehicle(fleet, accessToken, vin, log);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        vehicleData = await fetchVehicleData(fleet, accessToken, vin);
      } catch (wakeError) {
        return buildErrorReading(wakeError, { limitResetAt: wakeError.limitResetAt });
      }
    }
  }

  clearTeslaAuthStatus(fleet);
  return readingFromVehiclePayload(vehicleData);
}

const DASHBOARD_ENDPOINTS_CORE = [
  'charge_state',
  'climate_state',
  'drive_state',
  'vehicle_state',
  'vehicle_config',
  'gui_settings',
].join(';');

const DASHBOARD_ENDPOINTS_WITH_LOCATION = `${DASHBOARD_ENDPOINTS_CORE};location_data`;

function isLocationScopeError(error) {
  const message = [
    error?.message,
    error?.body?.error,
    error?.body?.error_description,
    typeof error?.body === 'string' ? error.body : null,
  ].filter(Boolean).join(' ');
  return /vehicle_location|missing scopes.*location/i.test(message);
}

async function fetchDashboardVehicleData(fleet, accessToken, vin) {
  try {
    const vehicleData = await fetchVehicleData(
      fleet,
      accessToken,
      vin,
      { endpoints: DASHBOARD_ENDPOINTS_WITH_LOCATION },
    );
    return { vehicleData, locationRestricted: false };
  } catch (error) {
    if (!isLocationScopeError(error)) {
      throw error;
    }
    const vehicleData = await fetchVehicleData(
      fleet,
      accessToken,
      vin,
      { endpoints: DASHBOARD_ENDPOINTS_CORE },
    );
    return { vehicleData, locationRestricted: true };
  }
}

async function fetchTeslaVehicleData(config, log) {
  const fleet = config.teslaFleet;
  if (!isFleetConfigured(fleet)) {
    throw new Error('Tesla Fleet API not configured');
  }

  loadPersistedRateLimit(fleet);

  const minIntervalMs = Math.max(0, Number(fleet.minRequestIntervalSec || 0)) * 1000;
  const now = Date.now();
  if (minIntervalMs > 0 && lastFetchAt > 0 && now - lastFetchAt < minIntervalMs) {
    const throttled = new Error('Request throttled');
    throttled.limitResetAt = new Date(lastFetchAt + minIntervalMs).toISOString();
    throw throttled;
  }

  if (isRateLimited()) {
    const limited = new Error('Tesla rate limit reached');
    limited.code = 'rate_limited';
    limited.limitResetAt = rateLimitUntil;
    throw limited;
  }

  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(fleet, { log }));
  } catch (error) {
    if (error?.status === 401 || /login_required|refresh_token is invalid|invalid_grant/i.test(error?.message || '')) {
      markTeslaReauthRequired(fleet, { message: error.message, reason: 'token_invalid' });
    }
    throw error;
  }

  const vin = await resolveVin(fleet, accessToken);
  lastFetchAt = Date.now();

  try {
    const result = await fetchDashboardVehicleData(fleet, accessToken, vin);
    clearTeslaAuthStatus(fleet);
    return result;
  } catch (error) {
    if (error.status === 401) {
      try {
        ({ accessToken } = await getValidAccessToken(fleet, { log, forceRefresh: true }));
        const result = await fetchDashboardVehicleData(fleet, accessToken, vin);
        clearTeslaAuthStatus(fleet);
        return result;
      } catch (retryError) {
        markTeslaReauthRequired(fleet, {
          message: retryError.message || error.message,
          reason: 'api_unauthorized',
        });
        throw retryError;
      }
    }
    if (error.status === 429) {
      throw error;
    }

    const asleep = error.status === 408 || /asleep|offline/i.test(error.message || '');
    if (!asleep) {
      try {
        const snapshot = await fetchVehicleSnapshot(fleet, accessToken, vin);
        if (snapshot?.charge_state || snapshot?.vehicle_state) {
          return { vehicleData: snapshot, locationRestricted: true };
        }
      } catch {
        // fall through to wake attempt
      }
    }

    await wakeVehicle(fleet, accessToken, vin, log);
    // Vehicles can take 10-30s to come online after wake_up; poll a few times.
    const retryDelaysMs = [4000, 6000, 8000];
    let lastError;
    for (const delayMs of retryDelaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return await fetchDashboardVehicleData(fleet, accessToken, vin);
      } catch (retryError) {
        lastError = retryError;
        if (retryError.status === 401 || retryError.status === 429) {
          throw retryError;
        }
        log?.info?.('Tesla still waking, retrying vehicle_data', {
          status: retryError.status || null,
        });
      }
    }
    throw lastError;
  }
}

async function fetchTeslaDashboard(config, log) {
  const fetchedAt = new Date().toISOString();
  try {
    const { vehicleData, locationRestricted } = await fetchTeslaVehicleData(config, log);
    return buildDashboardFromVehicleData(vehicleData, { fetchedAt, status: 'ok', locationRestricted });
  } catch (error) {
    if (error?.message === 'Request throttled') {
      return buildDashboardErrorReading(error, { limitResetAt: error.limitResetAt });
    }
    if (error?.code === 'rate_limited' || error?.status === 429) {
      return buildDashboardErrorReading(error, { limitResetAt: error.limitResetAt || rateLimitUntil });
    }
    return buildDashboardErrorReading(error);
  }
}

/**
 * Background-safe Tesla fetch: only pulls live vehicle_data when the car is
 * already online. Never sends wake_up — waking hourly would burn Fleet free-tier
 * credit and drain the 12V/HV battery.
 *
 * Returns null when the vehicle is asleep/offline/unreachable so the caller can
 * keep the existing disk cache untouched.
 */
async function fetchTeslaDashboardIfOnline(config, log) {
  const fleet = config.teslaFleet;
  if (!isFleetConfigured(fleet)) {
    return null;
  }

  loadPersistedRateLimit(fleet);

  if (isRateLimited()) {
    log?.info?.('Tesla background cache skipped — rate limited', {
      until: rateLimitUntil,
    });
    return null;
  }

  const minIntervalMs = Math.max(0, Number(fleet.minRequestIntervalSec || 0)) * 1000;
  const now = Date.now();
  if (minIntervalMs > 0 && lastFetchAt > 0 && now - lastFetchAt < minIntervalMs) {
    log?.debug?.('Tesla background cache skipped — min request interval');
    return null;
  }

  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(fleet, { log }));
  } catch (error) {
    log?.warn?.('Tesla background cache skipped — auth', error.message || error);
    return null;
  }

  const vin = await resolveVin(fleet, accessToken);
  lastFetchAt = Date.now();

  let connectivity;
  try {
    connectivity = await fetchVehicleSnapshot(fleet, accessToken, vin);
  } catch (error) {
    if (error.status === 429) {
      setRateLimit(error.limitResetAt);
      persistRateLimitState(fleet, rateLimitUntil);
    }
    log?.warn?.('Tesla background cache skipped — connectivity check failed', {
      status: error.status || null,
      message: error.message || String(error),
    });
    return null;
  }

  const state = String(connectivity?.state || '').toLowerCase();
  if (state !== 'online') {
    log?.info?.('Tesla background cache skipped — vehicle not online', { state: state || null });
    return null;
  }

  try {
    const { vehicleData, locationRestricted } = await fetchDashboardVehicleData(
      fleet,
      accessToken,
      vin,
    );
    const fetchedAt = new Date().toISOString();
    return buildDashboardFromVehicleData(vehicleData, {
      fetchedAt,
      status: 'ok',
      locationRestricted,
    });
  } catch (error) {
    if (error.status === 429) {
      setRateLimit(error.limitResetAt);
      persistRateLimitState(fleet, rateLimitUntil);
    }
    log?.warn?.('Tesla background cache fetch failed', {
      status: error.status || null,
      message: error.message || String(error),
    });
    return null;
  }
}

function resetFleetClientState() {
  lastFetchAt = 0;
  rateLimitUntil = null;
  cachedVin = null;
}

module.exports = {
  isFleetConfigured,
  fetchTeslaBattery,
  fetchTeslaDashboard,
  fetchTeslaDashboardIfOnline,
  isLocationScopeError,
  buildFleetReading,
  buildErrorReading,
  mapChargingLabel,
  normalizeBatteryRangeMiles,
  readingFromVehiclePayload,
  resetFleetClientState,
  resolveVin,
};
