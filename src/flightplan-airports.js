/**
 * Airport lookup for Flight Plan.
 * Primary catalog: src/web/flightplan/airports.json (OurAirports medium+large with IATA).
 * Falls back to overhead-geo airports.json for local additions.
 */

const fs = require('fs');
const path = require('path');

let cache = null;

/** Shortcuts for common city searches (lowercase key → IATA codes). */
const COMMON_ALIASES = Object.freeze({
  la: ['LAX'],
  lax: ['LAX'],
  'los angeles': ['LAX'],
  nyc: ['JFK', 'LGA', 'EWR'],
  'new york': ['JFK', 'LGA', 'EWR'],
  dc: ['DCA', 'IAD', 'BWI'],
  'washington dc': ['DCA', 'IAD'],
  sf: ['SFO'],
  'san francisco': ['SFO'],
  chi: ['ORD', 'MDW'],
  chicago: ['ORD', 'MDW'],
  philly: ['PHL'],
  philadelphia: ['PHL'],
  vegas: ['LAS'],
  'las vegas': ['LAS'],
  miami: ['MIA'],
  boston: ['BOS'],
  seattle: ['SEA'],
  dallas: ['DFW', 'DAL'],
  houston: ['IAH', 'HOU'],
  atlanta: ['ATL'],
  denver: ['DEN'],
  phoenix: ['PHX'],
  detroit: ['DTW'],
  minneapolis: ['MSP'],
  portland: ['PDX'],
  slc: ['SLC'],
  'salt lake': ['SLC'],
  'salt lake city': ['SLC'],
  tokyo: ['HND', 'NRT'],
  london: ['LHR', 'LGW', 'STN', 'LCY'],
  paris: ['CDG', 'ORY'],
});

function defaultCatalogPath(root) {
  return path.join(root, 'src', 'web', 'flightplan', 'airports.json');
}

function overheadCatalogPath(root) {
  return path.join(root, 'src', 'web', 'overhead-geo', 'airports.json');
}

function loadGeoFeatures(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const features = Array.isArray(raw?.features) ? raw.features : [];
    return features.map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates || [];
      return {
        iata: String(props.iata || '').trim().toUpperCase(),
        icao: String(props.icao || '').trim().toUpperCase(),
        name: String(props.name || '').trim(),
        city: String(props.city || props.municipality || '').trim(),
        lon: Number(coords[0]),
        lat: Number(coords[1]),
      };
    });
  } catch {
    return [];
  }
}

function loadCatalogRows(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((row) => ({
      iata: String(row.iata || '').trim().toUpperCase(),
      icao: String(row.icao || '').trim().toUpperCase(),
      name: String(row.name || '').trim(),
      city: String(row.city || '').trim(),
      lat: Number(row.lat),
      lon: Number(row.lon),
    }));
  } catch {
    return [];
  }
}

function loadAirports(config = {}) {
  if (cache) return cache;
  const root = config.ROOT || path.resolve(__dirname, '..');
  const byCode = new Map();
  for (const row of loadCatalogRows(
    path.resolve(config.flightplanAirportsPath || defaultCatalogPath(root)),
  )) {
    if (row.iata || row.icao) byCode.set(row.iata || row.icao, row);
  }
  for (const row of loadGeoFeatures(overheadCatalogPath(root))) {
    if (row.iata || row.icao) byCode.set(row.iata || row.icao, { ...byCode.get(row.iata || row.icao), ...row });
  }
  cache = [...byCode.values()].filter((row) => row.iata || row.icao);
  return cache;
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[\s\-/,()]+/).filter(Boolean);
}

function scoreAirport(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return -1;
  const tokens = q.split(/\s+/).filter(Boolean);
  const iata = row.iata.toLowerCase();
  const icao = row.icao.toLowerCase();
  const name = row.name.toLowerCase();
  const city = (row.city || '').toLowerCase();
  const nameWords = tokenize(name);
  const cityWords = tokenize(city);

  let score = 0;
  for (const token of tokens) {
    let tokenScore = -1;
    if (iata === token) tokenScore = Math.max(tokenScore, 120);
    if (icao === token) tokenScore = Math.max(tokenScore, 110);
    if (iata.startsWith(token)) tokenScore = Math.max(tokenScore, 95);
    if (icao.startsWith(token)) tokenScore = Math.max(tokenScore, 90);
    if (city === token) tokenScore = Math.max(tokenScore, 100);
    if (city.startsWith(token)) tokenScore = Math.max(tokenScore, 85);
    if (cityWords.some((w) => w.startsWith(token))) tokenScore = Math.max(tokenScore, 75);
    if (nameWords.some((w) => w.startsWith(token))) tokenScore = Math.max(tokenScore, 55);
    if (city.includes(token)) tokenScore = Math.max(tokenScore, 45);
    if (name.includes(token)) tokenScore = Math.max(tokenScore, 25);
    if (tokenScore < 0) return -1;
    score += tokenScore;
  }
  return score;
}

function aliasCodes(query) {
  const key = String(query || '').trim().toLowerCase();
  return COMMON_ALIASES[key] || [];
}

function searchAirports(query, { limit = 8, config = {} } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = loadAirports(config);
  const aliasHits = new Set(aliasCodes(q));
  const scored = [];
  for (const row of rows) {
    let score = scoreAirport(row, q);
    if (aliasHits.has(row.iata)) score = Math.max(score, 130);
    if (score >= 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.iata.localeCompare(b.row.iata));
  return scored.slice(0, limit).map(({ row }) => row);
}

function findAirport(code, config = {}) {
  const text = String(code || '').trim().toUpperCase();
  if (!text) return null;
  return loadAirports(config).find((row) => row.iata === text || row.icao === text) || null;
}

function resolveAirportCode(query, config = {}) {
  const text = String(query || '').trim();
  if (!text) return '';
  const direct = findAirport(text, config);
  if (direct?.iata) return direct.iata;
  const aliasList = aliasCodes(text);
  if (aliasList.length === 1) return aliasList[0];
  const matches = searchAirports(text, { limit: 1, config });
  if (matches.length === 1) return matches[0].iata || matches[0].icao || '';
  if (/^[A-Za-z]{3,4}$/.test(text)) return text.toUpperCase();
  return text.toUpperCase();
}

function _resetAirportCacheForTest() {
  cache = null;
}

module.exports = {
  loadAirports,
  searchAirports,
  findAirport,
  resolveAirportCode,
  COMMON_ALIASES,
  _resetAirportCacheForTest,
};
