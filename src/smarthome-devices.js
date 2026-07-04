const {
  collectCapabilityStates,
  normalizeStateResponse,
  stateResponseQuality,
} = require('./phoenix-state-parse');

function getSmarthomeListFn(alexa) {
  if (typeof alexa?.getSmarthomeDevicesV2 === 'function') {
    return alexa.getSmarthomeDevicesV2.bind(alexa);
  }
  if (typeof alexa?.getSmarthomeDevices === 'function') {
    return alexa.getSmarthomeDevices.bind(alexa);
  }
  return null;
}

function normalizeEndpoint(device) {
  const legacy = device?.legacyAppliance || {};
  const category = device?.displayCategories?.primary?.value
    || legacy.applianceTypes?.[0]
    || null;

  return {
    endpointId: device?.endpointId || device?.id || null,
    entityId: legacy.entityId || device?.entityId || null,
    applianceId: legacy.applianceId || device?.applianceId || null,
    friendlyName: device?.friendlyName || legacy.friendlyName || device?.name || null,
    legacyName: legacy.friendlyName || null,
    category,
    capabilities: legacy.capabilities || device?.capabilities || [],
    legacyAppliance: legacy,
    raw: device,
  };
}

async function listSmarthomeEndpoints(alexa) {
  const listFn = getSmarthomeListFn(alexa);
  if (!listFn) {
    return [];
  }

  const result = await new Promise((resolve, reject) => {
    listFn((err, devices) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(devices || []);
    });
  });

  if (Array.isArray(result)) {
    return result.map(normalizeEndpoint);
  }

  return [];
}

function summarizeCapability(capability) {
  const names = [];
  for (const entry of capability?.resources?.friendlyNames || []) {
    if (entry?.value?.assetId) {
      names.push(entry.value.assetId);
    }
    if (entry?.value?.text) {
      names.push(entry.value.text);
    }
  }
  return {
    interfaceName: capability?.interfaceName || null,
    instance: capability?.instance || null,
    names,
    unit: capability?.configuration?.unitOfMeasure || null,
    range: capability?.configuration?.supportedRange || null,
  };
}

function summarizeEndpoint(endpoint) {
  return {
    friendlyName: endpoint.friendlyName,
    legacyName: endpoint.legacyName,
    entityId: endpoint.entityId,
    applianceId: endpoint.applianceId,
    category: endpoint.category,
    capabilities: (endpoint.capabilities || []).map(summarizeCapability),
  };
}

function isAirQualityEndpoint(endpoint) {
  return endpoint.category === 'AIR_QUALITY_MONITOR';
}

function isClimateEndpoint(endpoint) {
  const haystack = JSON.stringify(endpoint).toLowerCase();
  return haystack.includes('thermostat')
    || haystack.includes('ecobee')
    || (haystack.includes('temperature') && !isAirQualityEndpoint(endpoint));
}

function buildStateQueries(endpoint) {
  const queries = [];
  const seen = new Set();

  const add = (entityId, entityType) => {
    if (!entityId) {
      return;
    }
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push({ entityId, entityType });
  };

  add(endpoint.applianceId, 'APPLIANCE');
  add(endpoint.entityId, 'ENTITY');
  add(endpoint.entityId, 'APPLIANCE');
  add(endpoint.endpointId, 'ENTITY');

  return queries;
}

async function queryEndpointState(alexa, endpoint) {
  if (typeof alexa?.querySmarthomeDevices !== 'function') {
    return null;
  }

  const queries = buildStateQueries(endpoint);
  if (!queries.length) {
    return null;
  }

  let bestResponse = null;
  let bestScore = 0;

  for (const query of queries) {
    try {
      const response = await new Promise((resolve, reject) => {
        alexa.querySmarthomeDevices(query, (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(result || null);
        });
      });

      const score = stateResponseQuality(response);
      if (score > bestScore) {
        bestScore = score;
        bestResponse = response;
      }
    } catch {
      // Try the next identifier.
    }
  }

  return bestScore > 0 ? normalizeStateResponse(bestResponse) : null;
}

module.exports = {
  buildStateQueries,
  getSmarthomeListFn,
  isAirQualityEndpoint,
  isClimateEndpoint,
  listSmarthomeEndpoints,
  normalizeEndpoint,
  queryEndpointState,
  summarizeCapability,
  summarizeEndpoint,
};
