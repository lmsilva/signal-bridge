/**
 * Normalise ADS-B Exchange v2 aircraft for Overhead payloads.
 */

const EXCLUDED_CATEGORIES = new Set(['C1', 'C2', 'C3']);

const CATEGORY_ICON = {
  A1: 'light',
  A2: 'turboprop',
  A3: 'jet',
  A4: 'jet',
  A5: 'jet',
  A6: 'jet',
  A7: 'heli',
  B1: 'glider',
  B2: 'balloon',
  B4: 'light',
  B6: 'drone',
};

const TYPE_PREFIX_ICON = [
  { prefixes: ['EC', 'AS', 'R44', 'B06'], iconClass: 'heli' },
  { prefixes: ['C1', 'PA', 'SR'], iconClass: 'light' },
];

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
const SORT_MODES = ['nearest', 'altitude', 'callsign'];

function parseAltFt(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' && raw.toLowerCase() === 'ground') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function categoryToIconClass(category, typeCode = '') {
  const cat = String(category || '').trim().toUpperCase();
  if (cat && CATEGORY_ICON[cat]) {
    return CATEGORY_ICON[cat];
  }
  const type = String(typeCode || '').trim().toUpperCase();
  for (const rule of TYPE_PREFIX_ICON) {
    if (rule.prefixes.some((prefix) => type.startsWith(prefix))) {
      return rule.iconClass;
    }
  }
  return 'generic';
}

function cardinalBearing(degrees) {
  const n = Number(degrees);
  if (!Number.isFinite(n)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((n % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}

function isEmergencyAircraft(ac) {
  const squawk = String(ac?.squawk || '').trim();
  if (EMERGENCY_SQUAWKS.has(squawk)) return true;
  const emergency = String(ac?.emergency || 'none').trim().toLowerCase();
  return emergency !== '' && emergency !== 'none';
}

function normaliseAircraft(raw = {}) {
  const hex = String(raw.hex || '').trim().toLowerCase();
  if (!hex) return null;

  const category = String(raw.category || '').trim().toUpperCase();
  if (EXCLUDED_CATEGORIES.has(category)) return null;

  const callsign = String(raw.flight || raw.callsign || '').trim().toUpperCase() || null;
  const registration = String(raw.r || raw.registration || '').trim().toUpperCase() || null;
  const typeCode = String(raw.t || raw.typeCode || '').trim().toUpperCase() || null;
  const altFt = parseAltFt(raw.alt_baro ?? raw.alt_geom ?? raw.altFt ?? raw.alt);
  const gsKt = Number.isFinite(Number(raw.gs)) ? Math.round(Number(raw.gs)) : null;
  const track = Number.isFinite(Number(raw.track)) ? Math.round(Number(raw.track)) : null;
  const baroRate = Number.isFinite(Number(raw.baro_rate ?? raw.baroRate))
    ? Math.round(Number(raw.baro_rate ?? raw.baroRate))
    : null;
  const lat = Number.isFinite(Number(raw.lat)) ? Number(raw.lat) : null;
  const lon = Number.isFinite(Number(raw.lon)) ? Number(raw.lon) : null;
  const dstNm = Number.isFinite(Number(raw.dst ?? raw.dstNm))
    ? Number(raw.dst ?? raw.dstNm)
    : null;
  const dirDeg = Number.isFinite(Number(raw.dir ?? raw.dirDeg))
    ? Math.round(Number(raw.dir ?? raw.dirDeg))
    : null;
  const squawk = String(raw.squawk || '').trim() || null;
  const emergency = String(raw.emergency || 'none').trim().toLowerCase();
  const seenPos = Number.isFinite(Number(raw.seen_pos ?? raw.seenPos))
    ? Number(raw.seen_pos ?? raw.seenPos)
    : null;
  const iconClass = categoryToIconClass(category, typeCode);
  const label = callsign || registration || hex.toUpperCase();

  const aircraft = {
    hex,
    callsign,
    registration,
    typeCode,
    category: category || null,
    iconClass,
    altFt,
    gsKt,
    track,
    baroRate,
    lat,
    lon,
    dstNm,
    dirDeg,
    squawk,
    emergency,
    seenPos,
    label,
    bearingLabel: dirDeg != null ? cardinalBearing(dirDeg) : '',
  };
  aircraft.isEmergency = isEmergencyAircraft(aircraft);
  if (category === 'A5') {
    aircraft.heavy = true;
  }
  return aircraft;
}

function filterAircraft(list = [], {
  altitudeFloorFt = 0,
  includeGround = false,
} = {}) {
  const floor = Number(altitudeFloorFt) || 0;
  return (list || []).filter((ac) => {
    if (!ac?.hex) return false;
    if (EXCLUDED_CATEGORIES.has(String(ac.category || '').toUpperCase())) return false;
    if (ac.altFt == null) {
      return includeGround;
    }
    if (!includeGround && ac.altFt <= 0) return false;
    if (ac.altFt < floor) return false;
    return true;
  });
}

function sortAircraft(list = [], sort = 'nearest') {
  const mode = SORT_MODES.includes(sort) ? sort : 'nearest';
  return [...(list || [])].sort((a, b) => {
    if (a.isEmergency !== b.isEmergency) {
      return a.isEmergency ? -1 : 1;
    }
    if (mode === 'altitude') {
      const altA = a.altFt == null ? -1 : a.altFt;
      const altB = b.altFt == null ? -1 : b.altFt;
      return altB - altA;
    }
    if (mode === 'callsign') {
      return String(a.label || '').localeCompare(String(b.label || ''));
    }
    const dstA = a.dstNm == null ? Number.POSITIVE_INFINITY : a.dstNm;
    const dstB = b.dstNm == null ? Number.POSITIVE_INFINITY : b.dstNm;
    return dstA - dstB;
  });
}

module.exports = {
  EXCLUDED_CATEGORIES,
  normaliseAircraft,
  filterAircraft,
  sortAircraft,
  categoryToIconClass,
  cardinalBearing,
  isEmergencyAircraft,
};
