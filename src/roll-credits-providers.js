const { lookupSteamGameForCredits } = require('./game-lookup');

const IGDB_GAMES_URL = 'https://api.igdb.com/v4/games';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_SPACING_MS = 250;

function imageUrl(value, size = 't_1080p') {
  const raw = String(value?.url || value || '').trim();
  if (!raw) return null;
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  return absolute.replace(/\/t_[^/]+\//, `/${size}/`);
}

function releaseDate(unixSeconds) {
  const value = Number(unixSeconds);
  return Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString().slice(0, 10)
    : null;
}

function companyNames(rows, role) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.[role] === true)
    .map((row) => String(row.company?.name || row.company_name || '').trim())
    .filter(Boolean);
}

function multiplayerMeta(rows) {
  const modes = Array.isArray(rows) ? rows : [];
  let maxPlayers = null;
  let coopSupported = false;
  for (const mode of modes) {
    const counts = [
      mode.offlinecoopmax,
      mode.onlinecoopmax,
      mode.offlinemax,
      mode.onlinemax,
    ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
    if (counts.length) {
      maxPlayers = Math.max(maxPlayers || 0, ...counts);
    }
    if (Number(mode.offlinecoopmax) > 1 || Number(mode.onlinecoopmax) > 1) {
      coopSupported = true;
    }
  }
  return { maxPlayers, coopSupported };
}

function createIgdbProvider({
  store,
  credentials,
  fetch: fetchImpl = global.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestSpacingMs = REQUEST_SPACING_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('IGDB provider needs fetch');
  }
  let token = null;
  let tokenExpiresAt = 0;
  let nextRequestAt = 0;
  const negativeCache = new Map();

  function getCredentials() {
    const value = typeof credentials?.resolveCredentials === 'function'
      ? credentials.resolveCredentials()
      : (typeof credentials === 'function' ? credentials() : credentials);
    return value || {};
  }

  async function getToken() {
    const current = Number(typeof now === 'function' ? now() : now);
    if (token && current < tokenExpiresAt - 30_000) {
      return token;
    }
    const resolved = getCredentials();
    if (!resolved.clientId || !resolved.clientSecret) {
      throw new Error('IGDB credentials missing — add them in Settings');
    }
    const url = new URL(TWITCH_TOKEN_URL);
    url.searchParams.set('client_id', resolved.clientId);
    url.searchParams.set('client_secret', resolved.clientSecret);
    url.searchParams.set('grant_type', 'client_credentials');
    const response = await fetchImpl(url, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`IGDB authentication failed (HTTP ${response.status})`);
    }
    const body = await response.json();
    if (!body.access_token) {
      throw new Error('IGDB authentication returned no access token');
    }
    token = body.access_token;
    tokenExpiresAt = current + Math.max(1, Number(body.expires_in) || 3600) * 1000;
    return token;
  }

  async function igdb(body) {
    const current = Number(typeof now === 'function' ? now() : now);
    const waitMs = Math.max(0, nextRequestAt - current);
    if (waitMs) await sleep(waitMs);
    const sentAt = Number(typeof now === 'function' ? now() : now);
    nextRequestAt = sentAt + requestSpacingMs;
    const auth = await getToken();
    const resolved = getCredentials();
    const response = await fetchImpl(IGDB_GAMES_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'text/plain',
        'Client-ID': resolved.clientId,
        Authorization: `Bearer ${auth}`,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`IGDB request failed (HTTP ${response.status})`);
    }
    const value = await response.json();
    return Array.isArray(value) ? value : [];
  }

  function platformsFor(row) {
    const mapped = [...new Set((row.platforms || [])
      .map((platform) => store?.mapIgdbPlatformToSystem?.(platform.id ?? platform))
      .filter(Boolean)
      .map((system) => system.id))];
    // Keep search usable when IGDB only lists platforms we have not mapped yet.
    if (!mapped.length && Array.isArray(row.platforms) && row.platforms.length) {
      return ['other'];
    }
    return mapped;
  }

  async function search(title, { limit = 8 } = {}) {
    const query = String(title || '').trim();
    if (!query) return [];
    const safeTitle = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const rows = await igdb(
      'fields name,first_release_date,platforms,cover.url,cover.image_id; '
      + `search "${safeTitle}"; limit ${Math.max(1, Math.min(50, Number(limit) || 8))};`,
    );
    return rows.map((row) => ({
      providerId: row.id,
      name: String(row.name || '').trim(),
      year: releaseDate(row.first_release_date)?.slice(0, 4) || null,
      platforms: platformsFor(row),
      thumbUrl: imageUrl(row.cover, 't_cover_big'),
    })).filter((row) => row.providerId && row.name);
  }

  async function fetchGame(providerId, { system } = {}) {
    const key = `${providerId}:${system || ''}`;
    const current = Number(typeof now === 'function' ? now() : now);
    const failedAt = negativeCache.get(key);
    if (failedAt != null && current - failedAt < NEGATIVE_TTL_MS) {
      return null;
    }
    try {
      const rows = await igdb(
        'fields name,summary,involved_companies.developer,involved_companies.publisher,'
        + 'involved_companies.company.name,first_release_date,genres.name,'
        + 'multiplayer_modes.*,cover.url,cover.image_id,screenshots.url,'
        + 'screenshots.image_id,videos.video_id,videos.name,platforms; '
        + `where id = ${Number(providerId)}; limit 1;`,
      );
      const row = rows[0];
      if (!row) {
        negativeCache.set(key, current);
        return null;
      }
      const multiplayer = multiplayerMeta(row.multiplayer_modes);
      const developers = companyNames(row.involved_companies, 'developer');
      const publishers = companyNames(row.involved_companies, 'publisher');
      const videoId = String(row.videos?.[0]?.video_id || '').trim();
      return {
        name: String(row.name || '').trim(),
        meta: {
          description: String(row.summary || '').trim(),
          publisher: publishers.join(', '),
          developer: developers.join(', '),
          releaseDate: releaseDate(row.first_release_date),
          genres: (row.genres || []).map((genre) => genre.name).filter(Boolean),
          maxPlayers: multiplayer.maxPlayers,
          coopSupported: multiplayer.coopSupported,
        },
        coverUrl: imageUrl(row.cover),
        screenshotUrls: (row.screenshots || []).map((shot) => imageUrl(shot)).filter(Boolean),
        youtubeUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
        provider: { igdbId: Number(row.id || providerId) },
      };
    } catch (error) {
      negativeCache.set(key, current);
      throw error;
    }
  }

  return {
    id: 'igdb',
    search,
    fetchGame,
    clearCache: () => negativeCache.clear(),
  };
}

function createSteamProvider({ steamApi = require('./steam-api'), now = Date.now } = {}) {
  return {
    id: 'steam',
    async search(title, { limit = 8 } = {}) {
      const rows = await steamApi.searchStoreApps(title);
      return rows.slice(0, Math.max(1, Number(limit) || 8)).map((row) => ({
        providerId: row.appId,
        name: row.name,
        year: null,
        platforms: ['pc'],
        thumbUrl: row.tinyImage || null,
      }));
    },
    async fetchGame(providerId, { system, title, maxScreenshots = 6 } = {}) {
      let value;
      if (providerId && typeof steamApi.fetchAppDetails === 'function') {
        const details = await steamApi.fetchAppDetails(providerId);
        value = details && {
          name: details.name,
          shortDescription: details.shortDescription,
          developers: details.developers,
          publishers: details.publishers,
          releaseYear: details.releaseYear,
          appId: details.appId || Number(providerId),
          coverUrl: details.headerImage,
          screenshots: details.screenshots,
          movieMp4Urls: details.movieMp4Urls,
        };
      } else {
        value = await lookupSteamGameForCredits(title, { steamApi, now, maxScreenshots });
      }
      if (!value || (system && system !== 'pc' && system !== 'steam-deck')) return null;
      return {
        name: value.name,
        meta: {
          description: value.shortDescription || '',
          publisher: (value.publishers || []).join(', '),
          developer: (value.developers || []).join(', '),
          releaseDate: value.releaseYear || null,
          genres: value.genres || [],
          maxPlayers: value.maxPlayers ?? null,
          coopSupported: value.coopSupported ?? false,
        },
        coverUrl: value.coverUrl || value.headerImage || null,
        screenshotUrls: (value.screenshots || []).slice(0, maxScreenshots),
        movieMp4Urls: value.movieMp4Urls || [],
        videoUrl: value.movieMp4Urls?.[0] || null,
        provider: { steamAppId: Number(value.appId || providerId) },
      };
    },
  };
}

function fillGaps(target, source) {
  const result = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    const empty = result[key] == null
      || result[key] === ''
      || (Array.isArray(result[key]) && result[key].length === 0);
    if (empty && value != null && value !== '') result[key] = value;
  }
  return result;
}

function createProviders({
  store,
  credentials,
  settings,
  fetch,
  steamApi = require('./steam-api'),
} = {}) {
  const providers = [
    createIgdbProvider({ store, credentials, fetch }),
    createSteamProvider({ steamApi }),
  ];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const order = () => settings?.get?.().scrape?.providerOrder || ['igdb', 'steam'];

  async function search(title, options = {}) {
    const errors = [];
    for (const id of order()) {
      const provider = byId.get(id);
      if (!provider) continue;
      try {
        const rows = await provider.search(title, options);
        if (rows.length) {
          return rows.map((row) => ({ ...row, provider: id }));
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === providers.length) throw errors[0];
    return [];
  }

  async function fetchGame(candidateOrId, options = {}) {
    const candidate = typeof candidateOrId === 'object'
      ? candidateOrId
      : { providerId: candidateOrId, provider: options.provider };
    const primaryId = candidate.provider || options.provider || order()[0];
    const ids = [primaryId, ...order().filter((id) => id !== primaryId)];
    let merged = null;
    for (const id of ids) {
      const provider = byId.get(id);
      if (!provider) continue;
      const providerId = id === primaryId
        ? candidate.providerId
        : (id === 'steam' ? candidate.steamAppId : candidate.igdbId);
      try {
        const result = await provider.fetchGame(providerId, {
          ...options,
          title: candidate.name || options.title,
          maxScreenshots: settings?.get?.().scrape?.maxScreenshots,
        });
        if (!result) continue;
        if (!merged) {
          merged = result;
        } else {
          merged = {
            ...fillGaps(merged, result),
            meta: fillGaps(merged.meta, result.meta),
            provider: fillGaps(merged.provider, result.provider),
          };
        }
      } catch {
        // A later provider may still supply a usable record.
      }
    }
    return merged;
  }

  return {
    search,
    fetchGame,
    list: () => order().map((id) => byId.get(id)).filter(Boolean),
  };
}

module.exports = {
  createIgdbProvider,
  createSteamProvider,
  createProviders,
  imageUrl,
  multiplayerMeta,
  fillGaps,
  NEGATIVE_TTL_MS,
  REQUEST_SPACING_MS,
};
