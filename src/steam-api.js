/**
 * Steam Web API + Store appdetails helpers for Now Playing.
 */

const https = require('https');
const { URL } = require('url');

const API_HOST = 'https://api.steampowered.com';
const STORE_HOST = 'https://store.steampowered.com';

// Steam store category ids we surface as footer tags (skip player-count ranges).
const CATEGORY_TAG_MAP = {
  1: 'Multi-player',
  2: 'Single-player',
  9: 'Co-op',
  18: 'Partial Controller',
  22: 'Steam Achievements',
  23: 'Steam Cloud',
  27: 'Cross-Platform Multiplayer',
  28: 'Full Controller',
  29: 'Steam Trading Cards',
  36: 'Online PvP',
  37: 'Shared/Split Screen PvP',
  38: 'Online Co-op',
  39: 'Shared/Split Screen Co-op',
  49: 'PvP',
};

const PREFERRED_TAG_ORDER = [
  'Split Screen',
  'Shared/Split Screen PvP',
  'Shared/Split Screen Co-op',
  'Online PvP',
  'Online Co-op',
  'PvP',
  'Co-op',
  'Full Controller',
  'Partial Controller',
  'Multi-player',
  'Single-player',
];

function httpsGetJson(urlString, { timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Steam HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Steam request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function libraryCapsuleUrls(appId) {
  const id = String(appId);
  const bases = [
    'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps',
    'https://cdn.cloudflare.steamstatic.com/steam/apps',
    'https://steamcdn-a.akamaihd.net/steam/apps',
  ];
  const assets = [
    'library_600x900_2x.jpg',
    'library_600x900.jpg',
    'library_capsule_2x.jpg',
    'library_capsule.jpg',
    'portrait.png',
    'header.jpg',
  ];
  const urls = [];
  for (const base of bases) {
    for (const asset of assets) {
      urls.push(`${base}/${id}/${asset}`);
    }
  }
  return urls;
}

async function fetchPlayerSummary(apiKey, steamId) {
  const url = `${API_HOST}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${encodeURIComponent(steamId)}`;
  const json = await httpsGetJson(url);
  const player = json?.response?.players?.[0] || null;
  if (!player) {
    return null;
  }
  const gameId = player.gameid ? Number(player.gameid) : null;
  return {
    steamId: player.steamid,
    personaName: player.personaname || null,
    personaState: player.personastate,
    profileUrl: player.profileurl || null,
    gameId: Number.isFinite(gameId) && gameId > 0 ? gameId : null,
    gameExtraInfo: player.gameextrainfo || null,
  };
}

async function fetchAppDetails(appId) {
  const url = `${STORE_HOST}/api/appdetails?appids=${encodeURIComponent(appId)}&l=english`;
  const json = await httpsGetJson(url);
  const entry = json?.[String(appId)];
  if (!entry?.success || !entry.data) {
    return null;
  }
  const data = entry.data;
  const yearMatch = String(data.release_date?.date || '').match(/\b(19|20)\d{2}\b/);
  const screenshots = (Array.isArray(data.screenshots) ? data.screenshots : [])
    .map((shot) => shot.path_full || shot.path_thumbnail)
    .filter(Boolean)
    .slice(0, 8);

  const rawCategories = Array.isArray(data.categories) ? data.categories : [];
  const tags = [];
  for (const cat of rawCategories) {
    const id = Number(cat.id);
    const mapped = CATEGORY_TAG_MAP[id] || null;
    const description = String(cat.description || '').trim();
    // Prefer mapped labels; skip vague "Steam …" store chrome except controller.
    const label = mapped || (
      /split\s*screen|co-?op|pvp|controller|multi-?player|single-?player/i.test(description)
        ? description
        : null
    );
    if (label && !tags.includes(label)) {
      tags.push(label);
    }
  }
  tags.sort((left, right) => {
    const li = PREFERRED_TAG_ORDER.indexOf(left);
    const ri = PREFERRED_TAG_ORDER.indexOf(right);
    return (li === -1 ? 999 : li) - (ri === -1 ? 999 : ri);
  });

  return {
    appId: Number(data.steam_appid || appId),
    name: data.name || `App ${appId}`,
    shortDescription: stripHtml(data.short_description),
    developers: Array.isArray(data.developers) ? data.developers : [],
    publishers: Array.isArray(data.publishers) ? data.publishers : [],
    releaseYear: yearMatch ? yearMatch[0] : null,
    headerImage: data.header_image || null,
    capsuleImage: data.capsule_image || data.capsule_imagev5 || null,
    background: data.background_raw || data.background || null,
    screenshots,
    tags: tags.slice(0, 6),
    posterCandidates: [
      ...libraryCapsuleUrls(appId),
      data.capsule_image,
      data.capsule_imagev5,
      data.header_image,
    ].filter(Boolean),
  };
}

async function fetchRecentlyPlayedGames(apiKey, steamId, { count = 5 } = {}) {
  const url = `${API_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(apiKey)}`
    + `&steamid=${encodeURIComponent(steamId)}&count=${encodeURIComponent(count)}`;
  const json = await httpsGetJson(url);
  const games = Array.isArray(json?.response?.games) ? json.response.games : [];
  return games.map((game) => ({
    appId: Number(game.appid),
    name: game.name || `App ${game.appid}`,
    playtimeForeverMin: Number.isFinite(Number(game.playtime_forever))
      ? Number(game.playtime_forever)
      : null,
    playtime2WeeksMin: Number.isFinite(Number(game.playtime_2weeks))
      ? Number(game.playtime_2weeks)
      : null,
    lastPlayedAt: Number.isFinite(Number(game.rtime_last_played)) && Number(game.rtime_last_played) > 0
      ? Number(game.rtime_last_played) * 1000
      : null,
  })).filter((game) => Number.isFinite(game.appId) && game.appId > 0);
}

async function fetchOwnedGamePlaytime(apiKey, steamId, appId) {
  // Prefer recently-played (small payload); fall back to full owned list scan.
  try {
    const recentUrl = `${API_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(apiKey)}`
      + `&steamid=${encodeURIComponent(steamId)}&count=20`;
    const recent = await httpsGetJson(recentUrl);
    const hit = (recent?.response?.games || []).find((entry) => Number(entry.appid) === Number(appId));
    if (hit) {
      return {
        playtimeForeverMin: Number(hit.playtime_forever) || 0,
        playtime2WeeksMin: Number(hit.playtime_2weeks) || 0,
      };
    }
  } catch {
    // fall through
  }
  const url = `${API_HOST}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}`
    + `&steamid=${encodeURIComponent(steamId)}`
    + '&include_played_free_games=1&include_appinfo=0';
  const json = await httpsGetJson(url);
  const game = (json?.response?.games || []).find((entry) => Number(entry.appid) === Number(appId));
  if (!game) {
    return null;
  }
  return {
    playtimeForeverMin: Number(game.playtime_forever) || 0,
    playtime2WeeksMin: Number(game.playtime_2weeks) || 0,
  };
}

async function fetchAchievementProgress(apiKey, steamId, appId) {
  let schemaTotal = null;
  try {
    const schemaUrl = `${API_HOST}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(apiKey)}&appid=${encodeURIComponent(appId)}`;
    const schema = await httpsGetJson(schemaUrl);
    const achievements = schema?.game?.availableGameStats?.achievements;
    if (Array.isArray(achievements)) {
      schemaTotal = achievements.length;
    }
  } catch {
    schemaTotal = null;
  }

  try {
    const url = `${API_HOST}/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(apiKey)}`
      + `&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appId)}`;
    const json = await httpsGetJson(url);
    if (json?.playerstats?.success === false) {
      return { earned: null, total: schemaTotal, available: false };
    }
    const list = json?.playerstats?.achievements || [];
    const earned = list.filter((entry) => Number(entry.achieved) === 1).length;
    const total = schemaTotal != null ? schemaTotal : list.length;
    return { earned, total, available: total > 0 };
  } catch {
    return { earned: null, total: schemaTotal, available: false };
  }
}

async function fetchCurrentPlayers(appId) {
  try {
    const url = `${API_HOST}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${encodeURIComponent(appId)}`;
    const json = await httpsGetJson(url);
    const count = json?.response?.player_count;
    return Number.isFinite(Number(count)) ? Number(count) : null;
  } catch {
    return null;
  }
}

function formatPlaytimeHours(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) {
    return null;
  }
  const hrs = Number(minutes) / 60;
  if (hrs < 10) {
    return `${hrs.toFixed(1)} hrs`;
  }
  return `${Math.round(hrs)} hrs`;
}

module.exports = {
  CATEGORY_TAG_MAP,
  httpsGetJson,
  stripHtml,
  libraryCapsuleUrls,
  fetchPlayerSummary,
  fetchRecentlyPlayedGames,
  fetchAppDetails,
  fetchOwnedGamePlaytime,
  fetchAchievementProgress,
  fetchCurrentPlayers,
  formatPlaytimeHours,
};
