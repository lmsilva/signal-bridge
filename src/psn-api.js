/**
 * Thin wrappers around the unofficial `psn-api` package.
 * NPSSO → access code → access/refresh tokens; auto-refresh on expiry.
 */

const {
  loadPsnSession,
  savePsnSession,
  resolvePsnCredentials,
  markPsnAuthStatus,
} = require('./psn-session');

function getPsnApi() {
  // Lazy require so tests can inject fakes without loading the package.
  return require('psn-api');
}

function normalizeTokens(tokens, { now = Date.now() } = {}) {
  const expiresInSec = Math.max(60, Number(tokens?.expiresIn) || 3600);
  const refreshExpiresInSec = Math.max(0, Number(tokens?.refreshTokenExpiresIn) || 0);
  // Refresh one minute before access token expiry.
  const skewMs = 60_000;
  return {
    accessToken: String(tokens.accessToken || '').trim(),
    refreshToken: String(tokens.refreshToken || '').trim(),
    idToken: tokens.idToken || null,
    scope: tokens.scope || null,
    tokenType: tokens.tokenType || 'bearer',
    expiresAt: now + expiresInSec * 1000 - skewMs,
    refreshExpiresAt: refreshExpiresInSec
      ? now + refreshExpiresInSec * 1000
      : 0,
  };
}

async function exchangeNpssoForSession(npsso, {
  api = getPsnApi(),
  now = Date.now(),
} = {}) {
  const token = String(npsso || '').trim();
  if (!token) {
    throw new Error('NPSSO cookie is required');
  }
  const accessCode = await api.exchangeNpssoForAccessCode(token);
  const tokens = await api.exchangeAccessCodeForAuthTokens(accessCode);
  return normalizeTokens(tokens, { now });
}

async function refreshPsnSession(refreshToken, {
  api = getPsnApi(),
  now = Date.now(),
} = {}) {
  const token = String(refreshToken || '').trim();
  if (!token) {
    throw new Error('PSN refresh token is missing — re-authenticate with NPSSO');
  }
  const tokens = await api.exchangeRefreshTokenForAuthTokens(token);
  return normalizeTokens(tokens, { now });
}

/**
 * Ensure a valid access token is available, refreshing/persisting as needed.
 * @returns {{ accessToken: string, accountId: string, onlineId: string|null, authorization: { accessToken: string } }}
 */
async function ensurePsnAuth(psnConfig, {
  api = getPsnApi(),
  now = () => Date.now(),
} = {}) {
  const creds = resolvePsnCredentials(psnConfig);
  if (!creds.configured) {
    throw new Error('PSN is not linked — paste an NPSSO cookie in Admin → Settings');
  }

  let session = { ...creds.session };
  const nowMs = typeof now === 'function' ? now() : now;
  const accessFresh = Boolean(session.accessToken)
    && Number(session.expiresAt) > nowMs;

  if (!accessFresh) {
    const refreshed = await refreshPsnSession(session.refreshToken || creds.refreshToken, {
      api,
      now: nowMs,
    });
    session = {
      ...session,
      ...refreshed,
      linkedAt: session.linkedAt || new Date(nowMs).toISOString(),
    };
    savePsnSession(psnConfig.sessionPath, session);
    markPsnAuthStatus(psnConfig, { status: 'ok', message: 'PSN token refreshed' });
  }

  const authorization = { accessToken: session.accessToken };
  const accountId = String(session.accountId || psnConfig.accountId || 'me').trim() || 'me';

  // Best-effort profile enrich (onlineId / real accountId) once per cold session.
  if (!session.onlineId || accountId === 'me') {
    try {
      if (typeof api.getProfileFromAccountId === 'function') {
        const profile = await api.getProfileFromAccountId(authorization, 'me');
        const resolvedId = String(
          profile?.accountId
          || profile?.profile?.accountId
          || '',
        ).trim();
        const onlineId = String(
          profile?.onlineId
          || profile?.profile?.onlineId
          || '',
        ).trim();
        let changed = false;
        if (resolvedId && resolvedId !== 'me' && resolvedId !== session.accountId) {
          session.accountId = resolvedId;
          changed = true;
        }
        if (onlineId && onlineId !== session.onlineId) {
          session.onlineId = onlineId;
          changed = true;
        }
        if (changed) {
          savePsnSession(psnConfig.sessionPath, session);
        }
      }
    } catch {
      // Presence still works with accountId "me".
    }
  }

  return {
    accessToken: session.accessToken,
    accountId: String(session.accountId || accountId || 'me'),
    onlineId: session.onlineId || null,
    authorization,
    session,
  };
}

function parseIsoDurationToMinutes(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text.startsWith('PT')) {
    return null;
  }
  const hours = Number((text.match(/(\d+)H/) || [])[1] || 0);
  const minutes = Number((text.match(/(\d+)M/) || [])[1] || 0);
  const seconds = Number((text.match(/(\d+)S/) || [])[1] || 0);
  if (!hours && !minutes && !seconds) {
    return null;
  }
  return Math.round(hours * 60 + minutes + seconds / 60);
}

function formatPlaytimeHours(minutes) {
  if (!Number.isFinite(Number(minutes)) || Number(minutes) < 0) {
    return null;
  }
  const hours = Number(minutes) / 60;
  if (hours < 10) {
    return `${hours.toFixed(1)} h`;
  }
  return `${Math.round(hours)} h`;
}

function pickPresenceGame(presenceResponse) {
  const basic = presenceResponse?.basicPresence || {};
  const list = Array.isArray(basic.gameTitleInfoList) ? basic.gameTitleInfoList : [];
  const game = list[0] || null;
  if (!game) {
    return {
      onlineStatus: basic.primaryPlatformInfo?.onlineStatus || null,
      platform: basic.primaryPlatformInfo?.platform || null,
      availability: basic.availability || null,
      game: null,
    };
  }
  const platform = game.launchPlatform || game.format
    || basic.primaryPlatformInfo?.platform
    || null;
  return {
    onlineStatus: basic.primaryPlatformInfo?.onlineStatus || null,
    platform,
    availability: basic.availability || null,
    game: {
      titleId: String(game.npTitleId || game.titleId || '').trim(),
      name: String(game.titleName || game.name || '').trim(),
      platform: platform ? String(platform).toUpperCase() : null,
      conceptIconUrl: game.conceptIconUrl || null,
      npTitleIconUrl: game.npTitleIconUrl || null,
    },
  };
}

async function fetchBasicPresence(authorization, accountId, {
  api = getPsnApi(),
} = {}) {
  const response = await api.getBasicPresence(authorization, accountId || 'me');
  return pickPresenceGame(response);
}

async function fetchPlayedTitles(authorization, accountId, {
  api = getPsnApi(),
  limit = 50,
} = {}) {
  if (typeof api.getUserPlayedGames !== 'function') {
    return [];
  }
  const response = await api.getUserPlayedGames(authorization, accountId || 'me', {
    limit,
    offset: 0,
  });
  const titles = Array.isArray(response?.titles) ? response.titles : [];
  return titles.map((title) => {
    const playMin = parseIsoDurationToMinutes(title.playDuration);
    const lastPlayedAt = title.lastPlayedDateTime
      ? Date.parse(title.lastPlayedDateTime)
      : NaN;
    const firstPlayedAt = title.firstPlayedDateTime
      ? Date.parse(title.firstPlayedDateTime)
      : NaN;
    const conceptImages = collectConceptImageUrls(title);
    const screenshotUrl = title.media?.screenshotUrl || null;
    return {
      titleId: String(title.titleId || '').trim(),
      name: String(title.localizedName || title.name || '').trim(),
      imageUrl: title.localizedImageUrl || title.imageUrl || null,
      category: title.category || null,
      service: title.service || null,
      conceptId: title.concept?.id ?? null,
      playCount: Number.isFinite(Number(title.playCount)) ? Number(title.playCount) : null,
      playtimeForeverMin: playMin,
      playtimeLabel: formatPlaytimeHours(playMin),
      lastPlayedAt: Number.isFinite(lastPlayedAt) ? lastPlayedAt : null,
      firstPlayedAt: Number.isFinite(firstPlayedAt) ? firstPlayedAt : null,
      screenshotUrl,
      conceptImages,
      // Only real stills — concept banners/key-art look like cover variants.
      galleryUrls: uniqueUrls([
        screenshotUrl,
        ...conceptImages,
      ]),
    };
  }).filter((row) => row.titleId || row.name);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls || []) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Concept media for the gallery — SCREENSHOT/STILL only.
 * Banners / MASTER / LOGO are cover variants and look terrible as "screenshots".
 */
function collectConceptImageUrls(title) {
  const images = title?.concept?.media?.images;
  if (!Array.isArray(images) || !images.length) {
    return [];
  }
  return images
    .filter((img) => {
      const type = String(img?.type || '').toUpperCase();
      return type.includes('SCREENSHOT') || type.includes('STILL');
    })
    .map((img) => String(img?.url || '').trim())
    .filter(Boolean);
}

function buildPsnStatusLine({
  platform = null,
  onlineId = null,
  playCount = null,
  mode = 'playing',
  starRating = null,
} = {}) {
  const bits = [];
  bits.push(mode === 'last-played' ? 'Last played' : 'Playing now');
  if (platform) {
    bits.push(`on ${String(platform).toUpperCase()}`);
  }
  if (onlineId) {
    bits.push(`as ${onlineId}`);
  }
  const count = Number(playCount);
  if (Number.isFinite(count) && count > 0) {
    bits.push(count === 1 ? '1 session' : `${count} sessions`);
  }
  if (starRating != null && Number.isFinite(Number(starRating))) {
    bits.push(`★ ${Number(starRating).toFixed(1)}`);
  }
  return bits.join(' · ');
}

function formatTrophyProgress(trophies) {
  const progress = Number(trophies?.progress);
  if (Number.isFinite(progress) && progress >= 0) {
    return `${Math.round(progress)}%`;
  }
  const earned = Number(trophies?.earned);
  const total = Number(trophies?.total);
  if (Number.isFinite(earned) && Number.isFinite(total) && total > 0) {
    return `${Math.round((earned / total) * 100)}%`;
  }
  return null;
}

function sumTrophyCounts(counts) {
  if (!counts || typeof counts !== 'object') {
    return null;
  }
  const total = ['bronze', 'silver', 'gold', 'platinum']
    .reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

async function fetchTrophyProgress(authorization, accountId, titleId, {
  api = getPsnApi(),
  titleName = '',
} = {}) {
  if (typeof api.getUserTitles !== 'function') {
    return { earned: null, total: null, available: false, progress: null };
  }
  if (!titleId && !titleName) {
    return { earned: null, total: null, available: false, progress: null };
  }
  try {
    const response = await api.getUserTitles(authorization, accountId || 'me', {
      limit: 100,
    });
    const titles = Array.isArray(response?.trophyTitles) ? response.trophyTitles : [];
    const nameNeedle = String(titleName || '').trim().toLowerCase();
    // Trophy APIs key on npCommunicationId (not npTitleId) — match by title name.
    const match = titles.find((row) => {
      const name = String(row.trophyTitleName || '').trim().toLowerCase();
      if (!name || !nameNeedle) {
        return false;
      }
      return name === nameNeedle
        || name.includes(nameNeedle)
        || nameNeedle.includes(name);
    });
    if (!match) {
      return { earned: null, total: null, available: false, progress: null };
    }
    const earned = sumTrophyCounts(match.earnedTrophies);
    const defined = sumTrophyCounts(match.definedTrophies);
    return {
      earned,
      total: defined,
      available: true,
      progress: match.progress ?? null,
    };
  } catch {
    return { earned: null, total: null, available: false, progress: null };
  }
}

function findPlayedTitle(titles, titleId, titleName = '') {
  const needle = String(titleId || '').toLowerCase();
  const nameNeedle = String(titleName || '').trim().toLowerCase();
  const list = titles || [];
  if (needle) {
    const byId = list.find((row) => String(row.titleId || '').toLowerCase() === needle)
      || list.find((row) => {
        const id = String(row.titleId || '').toLowerCase();
        return id && (needle.startsWith(id.split('_')[0]) || id.startsWith(needle.split('_')[0]));
      });
    if (byId) {
      return byId;
    }
  }
  if (nameNeedle) {
    return list.find((row) => String(row.name || '').trim().toLowerCase() === nameNeedle)
      || list.find((row) => {
        const name = String(row.name || '').trim().toLowerCase();
        return name && (name.includes(nameNeedle) || nameNeedle.includes(name));
      })
      || null;
  }
  return null;
}

/**
 * Build a display reading from presence + library metadata + optional Store.
 */
async function enrichPsnTitle(authorization, accountId, presenceGame, {
  api = getPsnApi(),
  playedTitles = null,
  onlineId = null,
  mode = 'playing',
  storeEnrichment = null,
  skipStore = false,
} = {}) {
  if (!presenceGame?.titleId && !presenceGame?.name) {
    return null;
  }
  const titles = playedTitles || await fetchPlayedTitles(authorization, accountId, { api }).catch(() => []);
  const played = findPlayedTitle(titles, presenceGame.titleId, presenceGame.name);
  const trophies = await fetchTrophyProgress(
    authorization,
    accountId,
    presenceGame.titleId,
    { api, titleName: presenceGame.name || played?.name || '' },
  ).catch(() => ({ earned: null, total: null, available: false }));

  const posterCandidates = uniqueUrls([
    presenceGame.npTitleIconUrl,
    presenceGame.conceptIconUrl,
    played?.imageUrl,
  ]);

  // Library stills only (not key-art). Store Chihiro fills real screenshots.
  let screenshots = uniqueUrls([
    ...(played?.galleryUrls || []),
    played?.screenshotUrl,
  ]).slice(0, 3);

  const platform = presenceGame.platform
    || (played?.category
      ? String(played.category).replace(/_game$/i, '').replace(/_/g, ' ').toUpperCase()
      : null);
  const progressLabel = formatTrophyProgress(trophies);

  let shortDescription = '';
  let starRating = null;
  let starRatingCount = null;
  let contentRating = null;
  let publishers = [];
  let storeProductId = null;

  // Chihiro Plan B — cached; soft-fails. Prefer Store screenshots + blurb.
  const needsStore = !skipStore && Boolean(presenceGame.titleId || played?.titleId);
  if (needsStore) {
    try {
      const { fetchStoreEnrichmentForTitle } = require('./psn-store');
      const store = storeEnrichment || await fetchStoreEnrichmentForTitle({
        titleId: presenceGame.titleId || played?.titleId,
        name: presenceGame.name || played?.name || '',
      });
      if (store) {
        storeProductId = store.productId || null;
        if (store.shortDescription) {
          shortDescription = store.shortDescription;
        }
        if (Array.isArray(store.screenshots) && store.screenshots.length) {
          screenshots = uniqueUrls([...store.screenshots, ...screenshots]).slice(0, 3);
        }
        if (store.starRating != null) {
          starRating = store.starRating;
        }
        if (store.starRatingCount != null) {
          starRatingCount = store.starRatingCount;
        }
        if (store.contentRating) {
          contentRating = store.contentRating;
        }
        if (store.publisher) {
          publishers = [store.publisher];
        }
      }
    } catch {
      // Store is optional Plan B.
    }
  }

  const statusLine = buildPsnStatusLine({
    platform,
    onlineId,
    playCount: played?.playCount,
    mode,
    starRating,
  });

  const tags = [];
  if (platform) {
    tags.push(String(platform));
  }
  if (starRating != null) {
    tags.push(`★ ${Number(starRating).toFixed(1)}`);
  }
  if (contentRating) {
    // Keep tag short — "ESRB Everyone 10+" → "E10+"
    const shortRating = contentRating
      .replace(/^ESRB\s+/i, '')
      .replace(/Everyone\s*/i, 'E')
      .replace(/\s+/g, '');
    if (shortRating && shortRating.length <= 12) {
      tags.push(shortRating);
    }
  }

  return {
    titleId: presenceGame.titleId || played?.titleId || null,
    name: presenceGame.name || played?.name || 'PlayStation Game',
    platform,
    shortDescription,
    statusLine,
    developers: [],
    publishers,
    releaseYear: null,
    tags,
    posterCandidates,
    headerImage: posterCandidates[0] || null,
    screenshots,
    playtimeLabel: played?.playtimeLabel || null,
    playtimeForeverMin: played?.playtimeForeverMin ?? null,
    playCount: played?.playCount ?? null,
    progressLabel,
    starRating,
    starRatingCount,
    contentRating,
    storeProductId,
    lastPlayedAt: played?.lastPlayedAt || null,
    firstPlayedAt: played?.firstPlayedAt || null,
    onlineId: onlineId || null,
    trophies: {
      earned: trophies.earned,
      total: trophies.total,
      available: Boolean(trophies.available),
      progress: trophies.progress ?? null,
    },
    achievements: {
      earned: trophies.earned,
      total: trophies.total,
      available: Boolean(trophies.available),
    },
  };
}

module.exports = {
  getPsnApi,
  normalizeTokens,
  exchangeNpssoForSession,
  refreshPsnSession,
  ensurePsnAuth,
  parseIsoDurationToMinutes,
  formatPlaytimeHours,
  pickPresenceGame,
  fetchBasicPresence,
  fetchPlayedTitles,
  fetchTrophyProgress,
  findPlayedTitle,
  enrichPsnTitle,
  collectConceptImageUrls,
  buildPsnStatusLine,
  formatTrophyProgress,
  uniqueUrls,
  loadPsnSession,
  savePsnSession,
};
