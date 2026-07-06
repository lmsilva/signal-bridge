const { normalizeText, resolveIndoorLocation } = require('./indoor-locations');

const DEFAULT_AIR_QUALITY_MONITORS = [
  {
    id: 'main-floor',
    label: 'Main Floor',
    entity: 'main floor air quality monitor',
    entityId: '00000000-0000-0000-0000-000000000002',
    aliases: ['main floor', 'main floor air quality', 'main floor airquality'],
  },
  {
    id: 'machine-room',
    label: 'Machine Room',
    entity: 'machine room air quality monitor',
    entityId: '00000000-0000-0000-0000-000000000003',
    aliases: ['machine room', 'machine room air quality', 'machine room airquality'],
  },
  {
    id: 'dome',
    label: 'Dome',
    entity: 'dome air quality monitor',
    entityId: '00000000-0000-0000-0000-000000000004',
    aliases: ['dome', 'dome air quality', 'dome airquality'],
  },
  {
    id: 'living-room',
    label: 'Living Room',
    entity: 'living room air quality monitor',
    aliases: ['living room', 'living room air quality', 'living room airquality', 'living room air quality monitor'],
  },
];

function getAirQualityMonitors(config = {}) {
  const configured = config.monitors || config.locations;
  if (Array.isArray(configured) && configured.length) {
    return configured;
  }
  return DEFAULT_AIR_QUALITY_MONITORS;
}

function resolveAirQualityLocation(phrase, config = {}) {
  const monitorConfig = { locations: getAirQualityMonitors(config) };
  const resolved = resolveIndoorLocation(phrase, monitorConfig);
  return {
    ...resolved,
    scope: 'indoor-air-quality',
  };
}

function cleanupAirQualityPhrase(value) {
  return normalizeText(value)
    .replace(/[?.!]+$/, '')
    .replace(/\s+(?:air\s*quality|airquality)$/i, '')
    .replace(/^(?:the\s+)?air\s*quality\s+(?:on|in|at|of|for)\s+(?:the\s+)?/i, '')
    .trim();
}

const INVALID_LOCATION_RE = /^(?:well(?:,\s*the)?|okay|so|sure|alright|oh|um|hmm|yes|no|the|it(?:'s| is)|this|that|indoor|inside|pretty|good|bad|fair|moderate|poor)$/i;

function isValidLocationPhrase(phrase) {
  const cleaned = cleanupAirQualityPhrase(phrase);
  if (!cleaned || cleaned.length < 2) {
    return false;
  }
  if (INVALID_LOCATION_RE.test(cleaned)) {
    return false;
  }
  if (/^well,?\s/i.test(cleaned)) {
    return false;
  }
  return true;
}

module.exports = {
  DEFAULT_AIR_QUALITY_MONITORS,
  cleanupAirQualityPhrase,
  getAirQualityMonitors,
  isValidLocationPhrase,
  resolveAirQualityLocation,
};
