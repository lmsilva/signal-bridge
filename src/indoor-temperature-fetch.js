const { getIndoorLocations, normalizeText } = require('./indoor-locations');
const { mergeIndoorReadings, parseIndoorReading } = require('./indoor-reading-parse');
const {
  collectCapabilityStates,
  parseNumericValue,
  parseTemperatureF,
  stateField,
} = require('./phoenix-state-parse');
const {
  listSmarthomeEndpoints,
  queryEndpointState,
} = require('./smarthome-devices');

let cachedEndpoints = null;
let cachedEndpointsAt = 0;
const DEVICE_CACHE_MS = 5 * 60 * 1000;

function parsePhoenixIndoorState(stateResponse) {
  const reading = {
    temperatureF: null,
    humidity: null,
    source: 'smarthome',
  };

  for (const state of collectCapabilityStates(stateResponse)) {
    const name = String(stateField(state, 'name') ?? '');
    const namespace = String(stateField(state, 'namespace') ?? '');
    const instance = String(stateField(state, 'instance') ?? '');

    if (name === 'temperature' || namespace.includes('TemperatureSensor')) {
      const temp = parseTemperatureF(stateField(state, 'value') ?? state?.temperature);
      if (temp != null) {
        reading.temperatureF = temp;
      }
      continue;
    }

    if (name === 'rangeValue' || name === 'humidity' || namespace.includes('RelativeHumidity')) {
      const numeric = parseNumericValue(stateField(state, 'value') ?? stateField(state, 'rangeValue'));
      if (numeric == null) {
        continue;
      }
      if (instance === '4' || name === 'humidity' || namespace.includes('RelativeHumidity')) {
        reading.humidity = Math.round(numeric);
      }
    }
  }

  return reading;
}

function endpointHaystack(endpoint) {
  return normalizeText([
    endpoint?.friendlyName,
    endpoint?.legacyName,
    endpoint?.entityId,
    endpoint?.applianceId,
  ].filter(Boolean).join(' '));
}

function isIndoorSensorEndpoint(endpoint) {
  const category = endpoint?.category;
  if (category === 'TEMPERATURE_SENSOR') {
    return true;
  }
  if (category === 'THERMOSTAT') {
    const haystack = endpointHaystack(endpoint);
    return haystack.includes('ecobee sensor') || haystack.includes('sensor');
  }
  return false;
}

function findIndoorSensor(endpoints, location) {
  const locations = getIndoorLocations({});
  const configured = locations.find((entry) => entry.id === location?.id)
    || locations.find((entry) => normalizeText(entry.entity) === normalizeText(location?.entity));

  if (configured?.entityId) {
    const byEntity = endpoints.find((entry) => entry.entityId === configured.entityId);
    if (byEntity) {
      return byEntity;
    }
  }

  const needles = [
    location?.entityId,
    configured?.entityId,
    location?.entity,
    location?.label,
    location?.query,
    configured?.entity,
    configured?.label,
    ...(configured?.aliases || []),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  const sensors = endpoints.filter(isIndoorSensorEndpoint);

  for (const needle of needles) {
    const exact = sensors.find((entry) => endpointHaystack(entry) === needle);
    if (exact) {
      return exact;
    }
  }

  for (const needle of needles) {
    const match = sensors.find((entry) => {
      const haystack = endpointHaystack(entry);
      return haystack.includes(needle) || needle.includes(haystack);
    });
    if (match) {
      return match;
    }
  }

  return null;
}

async function listCachedEndpoints(alexa) {
  const now = Date.now();
  if (cachedEndpoints && now - cachedEndpointsAt < DEVICE_CACHE_MS) {
    return cachedEndpoints;
  }

  const endpoints = await listSmarthomeEndpoints(alexa);
  cachedEndpoints = endpoints;
  cachedEndpointsAt = now;
  return endpoints;
}

async function fetchIndoorSensorReading(alexa, location) {
  if (!alexa) {
    return null;
  }

  try {
    const endpoints = await listCachedEndpoints(alexa);
    const match = findIndoorSensor(endpoints, location);
    if (!match) {
      return null;
    }

    const state = await queryEndpointState(alexa, match);
    return parsePhoenixIndoorState(state || {});
  } catch (error) {
    return null;
  }
}

async function enrichIndoorReading(alexa, location, spokenResponse, config = {}) {
  const spokenReading = parseIndoorReading(spokenResponse, config);
  const sensorReading = await fetchIndoorSensorReading(alexa, location);
  if (!sensorReading) {
    return spokenReading;
  }
  return mergeIndoorReadings(spokenReading, sensorReading);
}

module.exports = {
  enrichIndoorReading,
  fetchIndoorSensorReading,
  findIndoorSensor,
  parsePhoenixIndoorState,
};
