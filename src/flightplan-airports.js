/**
 * Airport lookup for Flight Plan — uses overhead-geo airports.json.
 */

const fs = require('fs');
const path = require('path');

let cache = null;

function loadAirports(config = {}) {
  if (cache) return cache;
  const root = config.ROOT || path.resolve(__dirname, '..');
  const airportsPath = path.resolve(
    config.flightplanAirportsPath || path.join(root, 'src', 'web', 'overhead-geo', 'airports.json'),
  );
  try {
    const raw = JSON.parse(fs.readFileSync(airportsPath, 'utf8'));
    const features = Array.isArray(raw?.features) ? raw.features : [];
    cache = features.map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates || [];
      return {
        iata: String(props.iata || '').trim().toUpperCase(),
        icao: String(props.icao || '').trim().toUpperCase(),
        name: String(props.name || '').trim(),
        lon: Number(coords[0]),
        lat: Number(coords[1]),
      };
    }).filter((row) => row.iata || row.icao);
  } catch {
    cache = [];
  }
  return cache;
}

function searchAirports(query, { limit = 8, config = {} } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const rows = loadAirports(config);
  const matches = [];
  for (const row of rows) {
    const iata = row.iata.toLowerCase();
    const icao = row.icao.toLowerCase();
    const name = row.name.toLowerCase();
    if (iata.startsWith(q) || icao.startsWith(q) || name.includes(q)) {
      matches.push(row);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function findAirport(code, config = {}) {
  const text = String(code || '').trim().toUpperCase();
  if (!text) return null;
  return loadAirports(config).find((row) => row.iata === text || row.icao === text) || null;
}

function _resetAirportCacheForTest() {
  cache = null;
}

module.exports = {
  loadAirports,
  searchAirports,
  findAirport,
  _resetAirportCacheForTest,
};
