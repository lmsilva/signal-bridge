function celsiusToFahrenheit(value) {
  return Math.round(((value * 9) / 5 + 32) * 10) / 10;
}

function parseNumericValue(raw) {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'number') {
    return raw;
  }

  if (typeof raw === 'object') {
    const nested = raw.value ?? raw.rangeValue ?? raw.amount ?? raw.reading;
    if (nested != null && nested !== raw) {
      return parseNumericValue(nested);
    }
  }

  const numeric = Number.parseFloat(String(raw).replace(/[^\d.-]/g, ''));
  return Number.isNaN(numeric) ? null : numeric;
}

function parseTemperatureF(raw) {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'object') {
    const value = raw.value ?? raw.temperature ?? raw.rangeValue;
    const scale = String(raw.scale || raw.unit || raw.value?.scale || 'FAHRENHEIT').toUpperCase();
    const numeric = parseNumericValue(value);
    if (numeric == null) {
      return null;
    }
    if (scale.includes('CELSIUS') || scale.includes('CEL')) {
      return celsiusToFahrenheit(numeric);
    }
    return Math.round(numeric * 10) / 10;
  }

  return parseNumericValue(raw);
}

function normalizeStateResponse(response) {
  if (!response) {
    return null;
  }

  if (Array.isArray(response)) {
    return { deviceStates: response };
  }

  if (response.deviceStates) {
    return response;
  }

  if (response.context?.deviceStates) {
    return { deviceStates: response.context.deviceStates };
  }

  if (response.capabilityStates || response.properties) {
    return {
      deviceStates: [{
        capabilityStates: response.capabilityStates,
        properties: response.properties,
      }],
    };
  }

  return response;
}

function collectCapabilityStates(stateResponse) {
  const normalized = normalizeStateResponse(stateResponse);
  const entries = [];

  for (const deviceState of normalized?.deviceStates || []) {
    const buckets = [
      deviceState?.capabilityStates,
      deviceState?.properties,
      deviceState?.propertyStates,
    ];
    for (const bucket of buckets) {
      if (Array.isArray(bucket)) {
        entries.push(...bucket);
      }
    }
  }

  if (Array.isArray(normalized?.capabilityStates)) {
    entries.push(...normalized.capabilityStates);
  }

  if (Array.isArray(normalized?.properties)) {
    entries.push(...normalized.properties);
  }

  return entries;
}

function stateField(state, key) {
  return state?.[key] ?? state?.property?.[key] ?? null;
}

module.exports = {
  celsiusToFahrenheit,
  collectCapabilityStates,
  normalizeStateResponse,
  parseNumericValue,
  parseTemperatureF,
  stateField,
};
