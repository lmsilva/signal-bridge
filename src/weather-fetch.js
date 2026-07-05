const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const WEATHER_CODE_LABELS = {
  0: 'clear',
  1: 'mainly_clear',
  2: 'partly_cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  61: 'rain',
  63: 'rain',
  65: 'rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  77: 'snow',
  80: 'rain_showers',
  81: 'rain_showers',
  82: 'rain_showers',
  85: 'snow_showers',
  86: 'snow_showers',
  95: 'thunderstorm',
  96: 'thunderstorm',
  99: 'thunderstorm',
};

function weatherCodeToCondition(code, isDay = 1) {
  const label = WEATHER_CODE_LABELS[Number(code)] || 'unknown';
  if (label.includes('snow')) {
    return 'snowy';
  }
  if (label.includes('rain') || label.includes('drizzle') || label.includes('shower')) {
    return 'rainy';
  }
  if (label.includes('cloud') || label === 'overcast' || label === 'fog') {
    return 'cloudy';
  }
  if (label.includes('clear')) {
    return Number(isDay) === 0 ? 'clear-night' : 'sunny';
  }
  if (label.includes('thunder')) {
    return 'stormy';
  }
  return 'unknown';
}

function celsiusToFahrenheit(c) {
  return Math.round((c * 9) / 5 + 32);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API HTTP ${response.status}`);
  }
  return response.json();
}

async function geocodeLocation(name) {
  const query = encodeURIComponent(String(name || '').trim());
  if (!query) {
    return null;
  }

  const data = await fetchJson(`${GEOCODE_URL}?name=${query}&count=1&language=en&format=json`);
  const hit = data?.results?.[0];
  if (!hit) {
    return null;
  }

  return {
    resolvedName: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone,
  };
}

async function resolveLocation(location) {
  if (location?.scope === 'named' && location.query && location.query !== 'local') {
    const geocoded = await geocodeLocation(location.query);
    if (geocoded) {
      return geocoded;
    }
    return null;
  }

  if (location?.latitude != null && location?.longitude != null) {
    return {
      resolvedName: location.resolvedName || location.query || 'Local',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone || 'auto',
    };
  }

  const geocodeCandidates = [
    location?.scope === 'named' ? location.query : null,
    location?.resolvedName,
    location?.query && location.query !== 'local' ? location.query : null,
  ].filter(Boolean);

  for (const candidate of geocodeCandidates) {
    const geocoded = await geocodeLocation(candidate);
    if (geocoded) {
      return geocoded;
    }
  }

  return null;
}

async function fetchWeatherForecast(location) {
  const resolved = await resolveLocation(location);
  if (!resolved) {
    return null;
  }

  const params = new URLSearchParams({
    latitude: String(resolved.latitude),
    longitude: String(resolved.longitude),
    current: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'weather_code',
      'wind_speed_10m',
      'precipitation',
      'is_day',
    ].join(','),
    hourly: [
      'temperature_2m',
      'precipitation_probability',
      'weather_code',
      'wind_speed_10m',
      'is_day',
    ].join(','),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'wind_speed_10m_max',
    ].join(','),
    forecast_days: '7',
    timezone: resolved.timezone || 'auto',
    temperature_unit: 'celsius',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
  });

  const data = await fetchJson(`${FORECAST_URL}?${params.toString()}`);
  const current = data?.current || {};
  const currentC = current.temperature_2m;
  const currentCode = current.weather_code;

  // Open-Meteo returns hourly times in the LOCATION's local time (no offset
  // suffix). Convert using utc_offset_seconds so the 24h window starts at the
  // current hour regardless of the server's timezone (Docker runs in UTC).
  const hourlyTimes = data?.hourly?.time || [];
  const utcOffsetMs = (data?.utc_offset_seconds || 0) * 1000;
  const nowMs = Date.now();
  const firstFuture = hourlyTimes.findIndex(
    (timeValue) => Date.parse(`${timeValue}Z`) - utcOffsetMs > nowMs,
  );
  const startIndex = firstFuture > 0 ? firstFuture - 1 : 0;

  const hourly = hourlyTimes.slice(startIndex, startIndex + 24).map((time, offset) => {
    const index = startIndex + offset;
    return {
      time,
      temperatureC: data.hourly.temperature_2m?.[index] ?? null,
      temperatureF: data.hourly.temperature_2m?.[index] != null
        ? celsiusToFahrenheit(data.hourly.temperature_2m[index])
        : null,
      precipitationProbability: data.hourly.precipitation_probability?.[index] ?? null,
      windSpeedMph: data.hourly.wind_speed_10m?.[index] ?? null,
      condition: weatherCodeToCondition(
        data.hourly.weather_code?.[index],
        data.hourly.is_day?.[index] ?? 1,
      ),
    };
  });

  const daily = (data?.daily?.time || []).map((date, index) => ({
    date,
    highC: data.daily.temperature_2m_max?.[index] ?? null,
    lowC: data.daily.temperature_2m_min?.[index] ?? null,
    highF: data.daily.temperature_2m_max?.[index] != null
      ? celsiusToFahrenheit(data.daily.temperature_2m_max[index])
      : null,
    lowF: data.daily.temperature_2m_min?.[index] != null
      ? celsiusToFahrenheit(data.daily.temperature_2m_min[index])
      : null,
    precipitationProbability: data.daily.precipitation_probability_max?.[index] ?? null,
    windSpeedMph: data.daily.wind_speed_10m_max?.[index] ?? null,
    condition: weatherCodeToCondition(data.daily.weather_code?.[index]),
  }));

  return {
    location: {
      ...location,
      resolvedName: resolved.resolvedName,
      latitude: resolved.latitude,
      longitude: resolved.longitude,
      timezone: data.timezone || resolved.timezone,
    },
    current: {
      temperatureC: currentC ?? null,
      temperatureF: currentC != null ? celsiusToFahrenheit(currentC) : null,
      feelsLikeC: current.apparent_temperature ?? null,
      feelsLikeF: current.apparent_temperature != null
        ? celsiusToFahrenheit(current.apparent_temperature)
        : null,
      humidity: current.relative_humidity_2m ?? null,
      windSpeedMph: current.wind_speed_10m ?? null,
      precipitationIn: current.precipitation ?? null,
      condition: weatherCodeToCondition(currentCode, current.is_day ?? 1),
      isDay: current.is_day ?? null,
      weatherCode: currentCode ?? null,
    },
    next24Hours: hourly,
    next7Days: daily,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchWeatherForecast,
  geocodeLocation,
  resolveLocation,
  weatherCodeToCondition,
  celsiusToFahrenheit,
};
