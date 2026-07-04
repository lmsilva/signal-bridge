const { normalizeStateResponse } = require('./phoenix-state-parse');

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

async function queryEndpointState(alexa, endpoint) {
  if (typeof alexa?.querySmarthomeDevices !== 'function') {
    return null;
  }

  const queryId = endpoint.applianceId || endpoint.entityId;
  if (!queryId) {
    return null;
  }

  const response = await new Promise((resolve, reject) => {
    alexa.querySmarthomeDevices(queryId, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result || null);
    });
  });

  return response ? normalizeStateResponse(response) : null;
}

module.exports = {
  getSmarthomeListFn,
  isAirQualityEndpoint,
  isClimateEndpoint,
  listSmarthomeEndpoints,
  normalizeEndpoint,
  queryEndpointState,
  summarizeCapability,
  summarizeEndpoint,
};
