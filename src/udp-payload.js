const { parseMessageDetails } = require('./message-details');
const { parseSpokenTime } = require('./time-parse');
const { extractWeatherLocation } = require('./weather-location');
const {
  buildIndoorReading,
  indoorMetric,
  resolveIndoorQueryLocation,
} = require('./indoor-temperature');
const {
  buildAirQualityReading,
  resolveAirQualityQueryLocation,
} = require('./air-quality');

function displaySeconds(config, override) {
  const value = Number(override);
  if (!Number.isNaN(value) && value > 0) {
    return value;
  }
  return Number(config.udpBroadcast?.defaultDisplaySeconds) || 120;
}

function buildBroadcastPayload(record, config) {
  const details = parseMessageDetails(record);

  return {
    version: 2,
    type: 'broadcast',
    message: details.message,
    sender: details.sender,
    destination: details.destination,
    timestamp: new Date(record.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config, record.displaySeconds),
    trigger: record.trigger || 'unknown',
  };
}

function buildTimeQueryPayload(event, config) {
  const parsedTime = parseSpokenTime(event.spokenResponse, new Date(event.timestamp));

  return {
    version: 2,
    type: 'time.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'time-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    parsedTime,
  };
}

function buildWeatherQueryPayload(event, config, { location, weather } = {}) {
  const resolvedLocation = location || extractWeatherLocation(
    event.query,
    config.voiceEvents?.defaultLocation,
    event.spokenResponse,
  );

  return {
    version: 2,
    type: 'weather.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config),
    trigger: event.trigger || 'weather-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    location: resolvedLocation,
    weather: weather || null,
  };
}

function timerDisplaySeconds(timers, config, event = null) {
  const base = displaySeconds(config);

  if (event?.kind === 'fired') {
    return Math.max(25, base);
  }

  const active = (timers || []).filter((timer) => {
    if (timer?.status === 'OFF') {
      return false;
    }
    return timer?.remainingSec == null || timer.remainingSec > 0;
  });

  if (!active.length) {
    return base;
  }

  const shortestRemaining = Math.min(
    ...active
      .map((timer) => Number(timer.remainingSec))
      .filter((value) => !Number.isNaN(value) && value > 0),
  );

  if (Number.isNaN(shortestRemaining)) {
    return base;
  }

  if (shortestRemaining < base) {
    return Math.max(1, Math.round(shortestRemaining));
  }

  return base;
}

function buildAirQualityPayload(event, config, { location, reading } = {}) {
  const airQualityConfig = config.airQuality || {};
  const resolvedLocation = location || resolveAirQualityQueryLocation(event, airQualityConfig);
  const resolvedReading = reading || buildAirQualityReading(event, airQualityConfig);

  return {
    version: 2,
    type: 'air-quality.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config, airQualityConfig.displaySeconds),
    trigger: event.trigger || 'air-quality-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    location: resolvedLocation,
    reading: resolvedReading,
  };
}

function buildIndoorTemperaturePayload(event, config, { location, reading } = {}) {
  const indoorConfig = config.indoorTemperature || {};
  const resolvedLocation = location || resolveIndoorQueryLocation(
    event.query,
    event.spokenResponse,
    indoorConfig,
  );
  const resolvedReading = reading || buildIndoorReading(event, indoorConfig);

  return {
    version: 2,
    type: 'indoor-temperature.query',
    device: event.device,
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    displaySeconds: displaySeconds(config, indoorConfig.displaySeconds),
    trigger: event.trigger || 'indoor-temperature-query',
    query: event.query,
    spokenResponse: event.spokenResponse || null,
    metric: indoorMetric(event.query),
    location: resolvedLocation,
    reading: resolvedReading,
  };
}

function buildTimerSnapshotPayload({
  timers,
  device,
  timestamp,
  trigger,
  event,
}, config) {
  return {
    version: 2,
    type: 'timer.snapshot',
    device: device || null,
    timestamp: new Date(timestamp || Date.now()).toISOString(),
    displaySeconds: timerDisplaySeconds(timers, config, event),
    trigger: trigger || 'timer-sync',
    timers,
    event: event || { kind: 'list' },
  };
}

module.exports = {
  buildBroadcastPayload,
  buildTimeQueryPayload,
  buildWeatherQueryPayload,
  buildIndoorTemperaturePayload,
  buildAirQualityPayload,
  buildTimerSnapshotPayload,
  displaySeconds,
  timerDisplaySeconds,
};
