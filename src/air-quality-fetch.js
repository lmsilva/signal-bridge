const { normalizeText } = require('./indoor-locations');
const { getAirQualityMonitors } = require('./air-quality-locations');
const { iaqBand, mergeAirQualityReadings } = require('./air-quality-parse');
const {
  collectCapabilityStates,
  normalizeStateResponse,
  parseNumericValue,
  parseTemperatureF,
  stateField,
} = require('./phoenix-state-parse');
const {
  isAirQualityEndpoint,
  listSmarthomeEndpoints,
  queryEndpointState,
} = require('./smarthome-devices');

const PROPERTY_KEYS = {
  iaqScore: ['airquality', 'air quality', 'iaq', 'airqualityindex', 'airqualityscore', 'score'],
  temperatureF: ['temperature', 'currenttemperature', 'indoortemperature'],
  humidity: ['humidity', 'relativehumidity', 'indoorhumidity'],
  pm25: ['pm2.5', 'pm25', 'particulatematter', 'particulate matter', 'pm'],
  co: ['co', 'carbonmonoxide', 'carbon monoxide'],
  voc: ['voc', 'tvoc', 'volatileorganiccompounds', 'volatile organic compounds'],
};

let cachedDevices = null;
let cachedDevicesAt = 0;
const DEVICE_CACHE_MS = 5 * 60 * 1000;

function normalizePropertyName(value) {
  return normalizeText(value).replace(/[^a-z0-9.]/g, '');
}

function propertyValue(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === 'object') {
    return raw.value ?? raw.state?.value ?? raw.value?.value ?? null;
  }
  return raw;
}

function collectProperties(device) {
  const buckets = [
    device?.properties,
    device?.propertyStates,
    device?.capabilities,
    device?.state,
  ];

  const entries = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      for (const item of bucket) {
        entries.push(item);
      }
      continue;
    }
    if (bucket && typeof bucket === 'object') {
      for (const [name, value] of Object.entries(bucket)) {
        entries.push({ name, value });
      }
    }
  }
  return entries;
}

function matchPropertyKey(name) {
  const normalized = normalizePropertyName(name);
  if (!normalized) {
    return null;
  }

  for (const [key, aliases] of Object.entries(PROPERTY_KEYS)) {
    if (aliases.some((alias) => normalized.includes(normalizePropertyName(alias)))) {
      return key;
    }
  }
  return null;
}

function capabilityLabel(capability) {
  const names = capability?.resources?.friendlyNames || [];
  for (const entry of names) {
    if (entry?.value?.assetId) {
      return entry.value.assetId;
    }
    if (entry?.value?.text) {
      return entry.value.text;
    }
  }
  return capability?.interfaceName || null;
}

function parsePhoenixState(stateResponse) {
  const reading = {
    iaqScore: null,
    iaqMax: 100,
    band: 'unknown',
    temperatureF: null,
    humidity: null,
    pm25: null,
    co: null,
    voc: null,
  };

  for (const state of collectCapabilityStates(stateResponse)) {
    const instance = String(stateField(state, 'instance') ?? '');
    const name = String(stateField(state, 'name') ?? '');
    const namespace = String(stateField(state, 'namespace') ?? '');

    if (name === 'temperature' || namespace.includes('TemperatureSensor')) {
      const temp = parseTemperatureF(stateField(state, 'value') ?? state?.temperature);
      if (temp != null) {
        reading.temperatureF = temp;
      }
      continue;
    }

    const numeric = parseNumericValue(
      stateField(state, 'value') ?? stateField(state, 'rangeValue') ?? state?.temperature,
    );

    if (name === 'rangeValue' || namespace.includes('RangeController')) {
      if (numeric == null) {
        continue;
      }
      if (instance === '9') {
        reading.iaqScore = numeric;
        continue;
      }
      if (instance === '4') {
        reading.humidity = numeric;
        continue;
      }
      if (instance === '8') {
        reading.co = numeric;
        continue;
      }
      if (instance === '6') {
        reading.pm25 = numeric;
        continue;
      }
      if (instance === '5') {
        reading.voc = numeric;
      }
      continue;
    }

    if (numeric == null) {
      continue;
    }

    if (instance === '9' || name === 'airQuality' || namespace.includes('AirQuality')) {
      reading.iaqScore = numeric;
      continue;
    }
    if (instance === '4') {
      reading.humidity = numeric;
      continue;
    }
    if (instance === '8') {
      reading.co = numeric;
      continue;
    }
    if (instance === '6') {
      reading.pm25 = numeric;
      continue;
    }
    if (instance === '5') {
      reading.voc = numeric;
    }
  }

  if (reading.iaqScore != null) {
    reading.band = iaqBand(reading.iaqScore);
  }

  return reading;
}

function mapDeviceReading(device) {
  const reading = {
    iaqScore: null,
    iaqMax: 100,
    band: 'unknown',
    temperatureF: null,
    humidity: null,
    pm25: null,
    co: null,
    voc: null,
    source: 'smarthome',
  };

  if (device?.deviceStates || device?.capabilityStates) {
    Object.assign(reading, parsePhoenixState(normalizeStateResponse(device)));
    if (reading.iaqScore != null || reading.temperatureF != null) {
      return reading;
    }
  }

  const capabilities = device?.legacyAppliance?.capabilities || device?.capabilities || [];
  for (const capability of capabilities) {
    const label = capabilityLabel(capability);
    const instance = String(capability?.instance || '');

    if (capability?.interfaceName === 'Alexa.TemperatureSensor') {
      continue;
    }

    if (label === 'Alexa.AirQuality.IndoorAirQuality' || instance === '9') {
      reading.iaqMax = capability?.configuration?.supportedRange?.maximumValue || 100;
    }
  }

  for (const property of collectProperties(device)) {
    const name = property?.name || property?.propertyName || property?.namespace || property?.type;
    const key = matchPropertyKey(name);
    if (!key) {
      continue;
    }
    const rawValue = propertyValue(property?.value ?? property);
    if (rawValue == null) {
      continue;
    }
    const numeric = Number.parseFloat(String(rawValue).replace(/[^\d.-]/g, ''));
    if (Number.isNaN(numeric)) {
      continue;
    }
    reading[key] = numeric;
  }

  if (reading.iaqScore != null) {
    reading.band = iaqBand(reading.iaqScore);
  }

  return reading;
}

function endpointHaystack(endpoint) {
  return normalizeText([
    endpoint?.friendlyName,
    endpoint?.legacyName,
    endpoint?.entityId,
    endpoint?.applianceId,
    endpoint?.endpointId,
  ].filter(Boolean).join(' '));
}

function findMatchingDevice(endpoints, location) {
  const monitors = getAirQualityMonitors({});
  const monitor = monitors.find((entry) => entry.id === location?.id)
    || monitors.find((entry) => normalizeText(entry.entity) === normalizeText(location?.entity));

  if (monitor?.entityId) {
    const byEntity = endpoints.find((entry) => entry.entityId === monitor.entityId);
    if (byEntity) {
      return byEntity;
    }
  }

  const needles = [
    location?.entityId,
    monitor?.entityId,
    location?.entity,
    location?.label,
    location?.query,
    monitor?.entity,
    monitor?.label,
    ...(monitor?.aliases || []),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  if (!needles.length) {
    return null;
  }

  const airDevices = endpoints.filter(isAirQualityEndpoint);

  for (const needle of needles) {
    const exact = airDevices.find((device) => endpointHaystack(device) === needle);
    if (exact) {
      return exact;
    }
  }

  for (const needle of needles) {
    const match = airDevices.find((device) => {
      const haystack = endpointHaystack(device);
      return haystack.includes(needle) || needle.includes(haystack);
    });
    if (match) {
      return match;
    }
  }

  if (airDevices.length === 1) {
    return airDevices[0];
  }

  return null;
}

async function listCachedEndpoints(alexa) {
  const now = Date.now();
  if (cachedDevices && now - cachedDevicesAt < DEVICE_CACHE_MS) {
    return cachedDevices;
  }

  const endpoints = await listSmarthomeEndpoints(alexa);
  cachedDevices = endpoints;
  cachedDevicesAt = now;
  return endpoints;
}

async function fetchAirQualityReading(alexa, location, config = {}) {
  if (!alexa) {
    return null;
  }

  try {
    const endpoints = await listCachedEndpoints(alexa);
    const match = findMatchingDevice(endpoints, location);
    if (!match) {
      return null;
    }

    const state = await queryEndpointState(alexa, match);
    const normalized = normalizeStateResponse(state);
    const parsed = parsePhoenixState(normalized);
    const hasSensorData = [
      parsed.iaqScore,
      parsed.temperatureF,
      parsed.humidity,
      parsed.pm25,
      parsed.co,
      parsed.voc,
    ].some((value) => value != null);

    if (hasSensorData) {
      return { ...parsed, source: 'smarthome' };
    }

    return mapDeviceReading({ ...match.raw, ...(normalized || {}) });
  } catch (error) {
    return null;
  }
}

async function enrichAirQualityReading(alexa, location, spokenReading, config = {}) {
  const sensorReading = await fetchAirQualityReading(alexa, location, config);
  if (!sensorReading) {
    return spokenReading;
  }
  return mergeAirQualityReadings(spokenReading, sensorReading);
}

module.exports = {
  enrichAirQualityReading,
  fetchAirQualityReading,
  findMatchingDevice,
  mapDeviceReading,
  parsePhoenixState,
};
