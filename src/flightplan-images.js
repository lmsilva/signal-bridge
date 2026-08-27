/**
 * Trip image pipeline — geocode, Wikimedia candidates, curated pack, disk cache.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { geocodeLocation } = require('./weather-fetch');
const { createWikiClient } = require('./wiki-common-knowledge-wiki');

const TRIP_WORDS = /\b(trip|vacation|visit|visiting|holiday|weekend)\b/gi;
const CURATED_PACK = Object.freeze([
  { id: 'us-big-city', label: 'US big city', query: 'Chicago' },
  { id: 'us-small-town', label: 'US small town', query: 'Park City Utah' },
  { id: 'beach', label: 'Beach', query: 'Miami Beach' },
  { id: 'mountains', label: 'Mountains', query: 'Rocky Mountains' },
  { id: 'desert', label: 'Desert', query: 'Moab Utah' },
  { id: 'island-paradise', label: 'Island paradise', query: 'Maui' },
  { id: 'island-town', label: 'Island town', query: 'Honolulu' },
]);

function guessPlaceFromTitle(title = '') {
  return String(title || '')
    .replace(TRIP_WORDS, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createFlightplanImages({
  config = {},
  settings,
  log = console,
  fetchImpl = global.fetch,
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const cacheDir = path.resolve(
    config.flightplanImagesPath || path.join(root, 'data', 'flightplan-images'),
  );
  const artworkDir = path.resolve(root, 'src', 'web', 'flightplan-artwork');

  function publicUrl(relativePath) {
    const rel = String(relativePath || '').replace(/^\/+/, '');
    return `/flightplan-artwork/${rel}`;
  }

  async function wikiCandidates(query, { limit = 4, contactEmail = '' } = {}) {
    const text = String(query || '').trim();
    if (!text) return [];
    try {
      const wiki = createWikiClient({ contactEmail, fetchImpl });
      const summary = await wiki.fetchSummary(text);
      const thumb = summary?.thumbnail?.source || summary?.originalimage?.source;
      if (!thumb) return [];
      return [{
        url: thumb,
        source: 'wikimedia',
        caption: summary.title || text,
        query: text,
      }].slice(0, limit);
    } catch (error) {
      log?.debug?.('Flight Plan wiki candidate failed', text, error?.message || error);
      return [];
    }
  }

  async function geocodeCandidates(query, { limit = 4, contactEmail = '' } = {}) {
    const geo = await geocodeLocation(query);
    if (!geo?.name) return [];
    const rows = await wikiCandidates(geo.name, { limit, contactEmail });
    return rows.map((row) => ({ ...row, lat: geo.lat, lon: geo.lon, geocodedName: geo.name }));
  }

  async function titleCandidates(title, options = {}) {
    const place = guessPlaceFromTitle(title);
    if (!place) return [];
    return geocodeCandidates(place, options);
  }

  async function locationCandidates(query, options = {}) {
    return geocodeCandidates(query, options);
  }

  function curatedCandidates() {
    return CURATED_PACK.map((row) => ({
      id: row.id,
      label: row.label,
      query: row.query,
      source: 'curated',
    }));
  }

  async function cacheRemoteImage(url, { caption = '', source = 'remote' } = {}) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
    const ext = path.extname(new URL(raw).pathname) || '.jpg';
    const filename = `${hash}${ext}`.replace(/[^a-zA-Z0-9._-]+/g, '');
    const target = path.join(cacheDir, filename);
    fs.mkdirSync(cacheDir, { recursive: true });
    if (!fs.existsSync(target)) {
      const response = await fetchImpl(raw, { headers: { Accept: 'image/*' } });
      if (!response.ok) throw new Error(`Image download failed (${response.status})`);
      const buf = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(target, buf);
    }
    return {
      id: hash,
      path: target,
      url: publicUrl(filename),
      source,
      caption,
      cached: true,
    };
  }

  function deleteTripImages(imageIds = []) {
    for (const id of imageIds) {
      const file = path.join(cacheDir, String(id));
      if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      }
    }
  }

  return {
    guessPlaceFromTitle,
    titleCandidates,
    locationCandidates,
    curatedCandidates,
    cacheRemoteImage,
    deleteTripImages,
    publicUrl,
    cacheDir,
    artworkDir,
    CURATED_PACK,
  };
}

module.exports = {
  createFlightplanImages,
  guessPlaceFromTitle,
  CURATED_PACK,
};
