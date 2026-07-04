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

function normalizeCapabilityState(raw) {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        return { name: trimmed, value: trimmed };
      }
    }
    return { name: trimmed, value: trimmed };
  }

  if (typeof raw === 'object' && raw.property && typeof raw.property === 'object') {
    return {
      ...raw.property,
      namespace: raw.property.namespace ?? raw.namespace,
      instance: raw.property.instance ?? raw.instance,
      value: raw.property.value ?? raw.value,
      name: raw.property.name ?? raw.name,
    };
  }

  return raw;
}

function collectCapabilityStates(stateResponse) {
  const normalized = normalizeStateResponse(stateResponse);
  const entries = [];

  const pushBucket = (bucket) => {
    if (!Array.isArray(bucket)) {
      return;
    }
    for (const item of bucket) {
      const state = normalizeCapabilityState(item);
      if (state) {
        entries.push(state);
      }
    }
  };

  for (const deviceState of normalized?.deviceStates || []) {
    pushBucket(deviceState?.capabilityStates);
    pushBucket(deviceState?.properties);
    pushBucket(deviceState?.propertyStates);
  }

  pushBucket(normalized?.capabilityStates);
  pushBucket(normalized?.properties);

  return entries;
}

function stateField(state, key) {
  if (key === 'namespace') {
    return state?.namespace
      ?? state?.property?.namespace
      ?? state?.interface
      ?? state?.property?.interface
      ?? null;
  }

  if (key === 'instance') {
    return state?.instance
      ?? state?.instanceId
      ?? state?.property?.instance
      ?? state?.property?.instanceId
      ?? null;
  }

  return state?.[key] ?? state?.property?.[key] ?? null;
}

function stateResponseQuality(response) {
  const normalized = normalizeStateResponse(response);
  if (!normalized) {
    return 0;
  }

  const errors = normalized.errors || [];
  const states = collectCapabilityStates(normalized);
  if (!states.length && errors.length) {
    return 0;
  }

  return states.length;
}

module.exports = {
  celsiusToFahrenheit,
  collectCapabilityStates,
  normalizeCapabilityState,
  normalizeStateResponse,
  parseNumericValue,
  parseTemperatureF,
  stateField,
  stateResponseQuality,
};
