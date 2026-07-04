function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTemperatureF(value) {
  const parsed = Number.parseFloat(String(value));
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.round(parsed * 10) / 10;
}

function comfortBand(temperatureF, { coldBelowF = 68, hotAboveF = 74 } = {}) {
  if (temperatureF == null || Number.isNaN(temperatureF)) {
    return 'unknown';
  }
  if (temperatureF < coldBelowF) {
    return 'cold';
  }
  if (temperatureF > hotAboveF) {
    return 'hot';
  }
  return 'comfortable';
}

const TEMP_SPOKEN_RE = /\b(\d{1,3}(?:\.\d+)?)\s+degrees?\b/i;

function parseIndoorReading(spoken, config = {}) {
  const text = normalizeText(spoken);
  const reading = {
    temperatureF: null,
    humidity: null,
    comfort: 'unknown',
    summary: text || null,
    locationPhrase: null,
  };

  if (!text) {
    return reading;
  }

  const humidityMatch = text.match(
    /\bhumidity(?:\s+of|\s+on|\s+in|\s+at|\s+for)?\s+[\w\s']+?\s+is\s+(\d{1,3})\s*(?:%|percent)?/i,
  )
    || text.match(/\b(\d{1,3})\s*(?:%|percent)\s+humidity\b/i)
    || text.match(/\bhumidity\s+(?:is\s+)?(\d{1,3})\s*(?:%|percent)?\b/i);

  if (humidityMatch) {
    reading.humidity = Number.parseInt(humidityMatch[1], 10);
  }

  const tempWithLocation = text.match(
    /\b(\d{1,3}(?:\.\d+)?)\s+degrees?\s+(?:on|in|at)\s+(?:the\s+)?(.+?)(?:[.!]|$)/i,
  );
  if (tempWithLocation) {
    reading.temperatureF = parseTemperatureF(tempWithLocation[1]);
    reading.locationPhrase = tempWithLocation[2]
      .replace(/[?.!]+$/, '')
      .replace(/\s+(?:temperature|temp|humidity)$/i, '')
      .trim();
  }

  if (reading.temperatureF == null) {
    const tempMatch = text.match(
      /\b(?:oh\s+)?(?:it's|it is|shows?|reads?|currently)\s+(\d{1,3}(?:\.\d+)?)\s+degrees?\b/i,
    ) || text.match(TEMP_SPOKEN_RE);
    if (tempMatch) {
      reading.temperatureF = parseTemperatureF(tempMatch[1]);
    }
  }

  if (reading.temperatureF != null) {
    reading.comfort = comfortBand(reading.temperatureF, config);
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence) {
    reading.summary = firstSentence;
  }

  return reading;
}

function mergeIndoorReadings(spokenReading, sensorReading) {
  const merged = { ...(spokenReading || {}) };
  for (const [key, value] of Object.entries(sensorReading || {})) {
    if (value == null || value === '') {
      continue;
    }
    if (merged[key] == null || merged[key] === '') {
      merged[key] = value;
    }
  }
  if (merged.temperatureF != null && (!merged.comfort || merged.comfort === 'unknown')) {
    merged.comfort = comfortBand(merged.temperatureF);
  }
  return merged;
}

module.exports = {
  comfortBand,
  mergeIndoorReadings,
  parseIndoorReading,
  parseTemperatureF,
};
