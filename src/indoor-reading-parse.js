function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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

function parseIndoorReading(spoken, config = {}) {
  const text = normalizeText(spoken);
  const reading = {
    temperatureF: null,
    humidity: null,
    comfort: 'unknown',
    summary: text || null,
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

  const tempMatch = text.match(
    /\b(?:shows?|reads?|currently|it's|it is)\s+(\d{1,3})\s+degrees?\b/i,
  )
    || text.match(/\b(?:it's|it is)\s+(\d{1,3})\s+degrees?\b/i)
    || text.match(/\b(\d{1,3})\s+degrees?\s+(?:on|in|at)\b/i)
    || text.match(/\b(\d{1,3})\s+degrees?\b/i);

  if (tempMatch) {
    reading.temperatureF = Number.parseInt(tempMatch[1], 10);
    reading.comfort = comfortBand(reading.temperatureF, config);
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence) {
    reading.summary = firstSentence;
  }

  return reading;
}

module.exports = {
  comfortBand,
  parseIndoorReading,
};
