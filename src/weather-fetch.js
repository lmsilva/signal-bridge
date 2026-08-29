const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Open-Meteo often returns nothing for "City State" / "City, State" phrases,
// and bare city names can resolve to the wrong state (Saratoga Springs → NY).
// Parse a trailing US state (full name or abbrev) and match against admin1.
const US_ADMIN1_BY_KEY = (() => {
  const pairs = [
    ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
    ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'], ['delaware', 'de'],
    ['district of columbia', 'dc'], ['florida', 'fl'], ['georgia', 'ga'], ['hawaii', 'hi'],
    ['idaho', 'id'], ['illinois', 'il'], ['indiana', 'in'], ['iowa', 'ia'],
    ['kansas', 'ks'], ['kentucky', 'ky'], ['louisiana', 'la'], ['maine', 'me'],
    ['maryland', 'md'], ['massachusetts', 'ma'], ['michigan', 'mi'], ['minnesota', 'mn'],
    ['mississippi', 'ms'], ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'],
    ['nevada', 'nv'], ['new hampshire', 'nh'], ['new jersey', 'nj'], ['new mexico', 'nm'],
    ['new york', 'ny'], ['north carolina', 'nc'], ['north dakota', 'nd'], ['ohio', 'oh'],
    ['oklahoma', 'ok'], ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhode island', 'ri'],
    ['south carolina', 'sc'], ['south dakota', 'sd'], ['tennessee', 'tn'], ['texas', 'tx'],
    ['utah', 'ut'], ['vermont', 'vt'], ['virginia', 'va'], ['washington', 'wa'],
    ['west virginia', 'wv'], ['wisconsin', 'wi'], ['wyoming', 'wy'],
  ];
  const map = new Map();
  for (const [full, abbr] of pairs) {
    const proper = full.replace(/\b\w/g, (ch) => ch.toUpperCase());
    map.set(full, proper);
    map.set(abbr, proper);
  }
  return map;
})();

const US_ADMIN1_MULTIWORD = [...US_ADMIN1_BY_KEY.keys()]
  .filter((key) => key.includes(' '))
  .sort((a, b) => b.length - a.length);

function parseGeocodeQuery(name) {
  const text = String(name || '')
    .trim()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');
  if (!text) {
    return { city: '', admin1: null };
  }
  const lower = text.toLowerCase();
  for (const key of US_ADMIN1_MULTIWORD) {
    if (lower === key) {
      return { city: text, admin1: US_ADMIN1_BY_KEY.get(key) };
    }
    const suffix = ` ${key}`;
    if (lower.endsWith(suffix)) {
      const city = text.slice(0, text.length - suffix.length).trim();
      return { city: city || text, admin1: US_ADMIN1_BY_KEY.get(key) };
    }
  }
  const parts = text.split(' ');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toLowerCase();
    if (US_ADMIN1_BY_KEY.has(last)) {
      return {
        city: parts.slice(0, -1).join(' '),
        admin1: US_ADMIN1_BY_KEY.get(last),
      };
    }
  }
  return { city: text, admin1: null };
}

function pickGeocodeHit(results, admin1) {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  if (admin1) {
    const want = admin1.toLowerCase();
    const match = results.find((hit) => String(hit.admin1 || '').toLowerCase() === want);
    if (match) {
      return match;
    }
  }
  const usHit = results.find((hit) => String(hit.country_code || '').toUpperCase() === 'US');
  return usHit || results[0];
}

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

const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const GEOCODE_FETCH_TIMEOUT_MS = 6000;

async function fetchJson(url, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Weather API HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function hitMatchesAdmin1(hit, admin1) {
  if (!admin1) {
    return true;
  }
  return String(hit?.admin1 || '').toLowerCase() === String(admin1).toLowerCase();
}

function formatGeocodeHit(hit) {
  if (!hit) {
    return null;
  }
  return {
    resolvedName: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
    city: hit.name || '',
    region: hit.admin1 || '',
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone,
  };
}

const ZIPPOPOTAM_URL = 'https://api.zippopotam.us';

function normaliseUsZip(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : '';
}

/**
 * US ZIP via Zippopotam (no key). Falls back to Open-Meteo name search so a
 * typed "84043" still resolves if Zippopotam is unreachable.
 */
async function geocodePostalCode(code, { timeoutMs = GEOCODE_FETCH_TIMEOUT_MS } = {}) {
  const zip = normaliseUsZip(code);
  const raw = String(code || '').trim();
  if (zip) {
    try {
      const data = await fetchJson(`${ZIPPOPOTAM_URL}/us/${zip}`, { timeoutMs });
      const place = data?.places?.[0];
      if (place) {
        return {
          resolvedName: [place['place name'], place['state abbreviation']].filter(Boolean).join(', '),
          city: place['place name'] || '',
          region: place['state abbreviation'] || '',
          postalCode: zip,
          latitude: Number(place.latitude),
          longitude: Number(place.longitude),
          timezone: null,
        };
      }
    } catch {
      // Fall through to Open-Meteo.
    }
  }
  if (!raw) {
    return null;
  }
  const hit = await geocodeLocation(raw, { timeoutMs });
  if (!hit) {
    return null;
  }
  return { ...hit, postalCode: zip || raw };
}

/** IANA zone for a lat/lon. Open-Meteo `timezone=auto` is the house clock. */
async function lookupTimeZone(latitude, longitude, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m',
    timezone: 'auto',
  });
  try {
    const data = await fetchJson(`${FORECAST_URL}?${params.toString()}`, { timeoutMs });
    return data?.timezone || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Global Settings form: ZIP for coordinates when it is a US
 * 5-digit code, city for the display name, Open-Meteo for the IANA zone.
 */
async function resolveHouseLocale({ city = '', postalCode = '' } = {}) {
  const zip = String(postalCode || '').trim();
  const cityName = String(city || '').trim();
  if (!zip && !cityName) {
    return null;
  }

  const fromZip = zip ? await geocodePostalCode(zip) : null;
  const fromCity = cityName ? await geocodeLocation(cityName) : null;
  const hit = fromZip || fromCity;
  if (!hit || !Number.isFinite(Number(hit.latitude)) || !Number.isFinite(Number(hit.longitude))) {
    return null;
  }

  const timeZone = hit.timezone || await lookupTimeZone(hit.latitude, hit.longitude);
  const label = cityName && fromCity?.resolvedName
    ? fromCity.resolvedName
    : (hit.resolvedName || cityName || zip);

  return {
    city: fromCity?.city || fromZip?.city || cityName,
    region: fromZip?.region || fromCity?.region || '',
    postalCode: fromZip?.postalCode || normaliseUsZip(zip) || zip,
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
    timeZone: timeZone || 'America/Denver',
    label,
    country: 'US',
  };
}

async function searchGeocodeApi(name, { countryCode = null, timeoutMs = GEOCODE_FETCH_TIMEOUT_MS } = {}) {
  const query = encodeURIComponent(String(name || '').trim());
  if (!query) {
    return null;
  }
  let url = `${GEOCODE_URL}?name=${query}&count=10&language=en&format=json`;
  if (countryCode) {
    url += `&countryCode=${encodeURIComponent(countryCode)}`;
  }
  try {
    return await fetchJson(url, { timeoutMs });
  } catch {
    return null;
  }
}

/**
 * Resolve a place name via Open-Meteo. US-first for household speed; skips to
 * worldwide only on miss. When a US state was parsed, reject wrong-state hits
 * so we keep searching instead of locking onto the first same-named city.
 *
 * Options:
 * - timeoutMs: per-request abort (default 6s)
 * - maxLookups: cap sequential HTTP attempts (default 4; route uses 2)
 */
async function geocodeLocation(name, { timeoutMs = GEOCODE_FETCH_TIMEOUT_MS, maxLookups = 4 } = {}) {
  const raw = String(name || '').trim();
  if (!raw) {
    return null;
  }
  // Privacy placeholder / voice "here" — never resolve via geocode (Home → Belarus).
  if (/^(home|local|here)$/i.test(raw)) {
    return null;
  }

  const parsed = parseGeocodeQuery(raw);
  const searchName = parsed.city || raw;
  if (!searchName) {
    return null;
  }

  const lookups = [
    { name: searchName, countryCode: 'US' },
    { name: searchName, countryCode: null },
  ];
  if (searchName !== raw) {
    lookups.push(
      { name: raw, countryCode: 'US' },
      { name: raw, countryCode: null },
    );
  }

  const limit = Math.max(1, Math.min(lookups.length, Number(maxLookups) || lookups.length));
  for (let i = 0; i < limit; i += 1) {
    const attempt = lookups[i];
    const data = await searchGeocodeApi(attempt.name, {
      countryCode: attempt.countryCode,
      timeoutMs,
    });
    const hit = pickGeocodeHit(data?.results, parsed.admin1);
    if (!hit) {
      continue;
    }
    // State was explicit ("Moab Utah") — don't accept NY Saratoga Springs etc.
    if (parsed.admin1 && !hitMatchesAdmin1(hit, parsed.admin1)) {
      continue;
    }
    return formatGeocodeHit(hit);
  }

  return null;
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
  geocodePostalCode,
  lookupTimeZone,
  resolveHouseLocale,
  parseGeocodeQuery,
  pickGeocodeHit,
  resolveLocation,
  weatherCodeToCondition,
  celsiusToFahrenheit,
  GEOCODE_FETCH_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
};
