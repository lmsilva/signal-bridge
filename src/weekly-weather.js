/**
 * Weekly Weather Report — Vestaboard payload from an Open-Meteo 7-day forecast.
 *
 * Today is first, then the next six days. The board prints two columns of
 * `WED    59F` plus a condition chip (marketplace Weekly Weather Report).
 */

const { parseYmd, weekday } = require('./vestaboard/clock');

function weekdayShort(date) {
  return weekday(parseYmd(date), { short: true }) || '';
}

function weekdayLetter(date) {
  return weekdayShort(date).slice(0, 1);
}

function averageTemp(day, unit = 'F') {
  const high = unit === 'C' ? day.highC : day.highF;
  const low = unit === 'C' ? day.lowC : day.lowF;
  if (high != null && low != null) {
    return Math.round((Number(high) + Number(low)) / 2);
  }
  if (high != null) return Math.round(Number(high));
  if (low != null) return Math.round(Number(low));
  return null;
}

function daysFromForecast(weather = {}, { unit = 'F' } = {}) {
  const useC = String(unit || 'F').toUpperCase() === 'C';
  return (weather.next7Days || []).slice(0, 7).map((day) => ({
    date: day.date,
    weekday: weekdayShort(day.date),
    condition: day.condition || 'unknown',
    temp: averageTemp(day, useC ? 'C' : 'F'),
  })).filter((day) => day.date && day.temp != null);
}

function buildWeeklyWeatherPayload({
  weather,
  location,
  temperatureUnit = 'F',
} = {}) {
  const unit = String(temperatureUnit || 'F').toUpperCase() === 'C' ? 'C' : 'F';
  const days = daysFromForecast(weather, { unit });
  if (!days.length) {
    return null;
  }
  const loc = location || weather?.location || {};
  return {
    type: 'weather.weekly',
    asOf: weather?.fetchedAt || new Date().toISOString(),
    temperatureUnit: unit,
    location: {
      city: loc.city || '',
      label: loc.label || loc.resolvedName || loc.name || loc.query || '',
      latitude: loc.latitude,
      longitude: loc.longitude,
      timeZone: loc.timeZone || loc.timezone || '',
    },
    days,
  };
}

module.exports = {
  weekdayLetter,
  weekdayShort,
  averageTemp,
  daysFromForecast,
  buildWeeklyWeatherPayload,
};
