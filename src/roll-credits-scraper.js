const crypto = require('crypto');

const META_FIELDS = [
  'description',
  'publisher',
  'developer',
  'releaseDate',
  'genres',
  'maxPlayers',
  'coopSupported',
];

function createMediaId() {
  return `m_${crypto.randomBytes(6).toString('hex')}`;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function scrapedMeta(value) {
  const result = {};
  for (const field of META_FIELDS) {
    if (value?.[field] !== undefined) result[field] = value[field];
  }
  return result;
}

function sourceFor(candidate) {
  return `scraped:${candidate?.provider || 'unknown'}`;
}

function normalizeScopes(scopes) {
  if (scopes == null) {
    return { metadata: true, cover: true, screenshots: true, video: true };
  }
  // Admin UI posts checked checkbox values as a string array.
  if (Array.isArray(scopes)) {
    const selected = new Set(scopes.map((value) => String(value || '').trim()).filter(Boolean));
    return {
      metadata: selected.has('metadata'),
      cover: selected.has('cover'),
      screenshots: selected.has('screenshots'),
      video: selected.has('video'),
    };
  }
  return {
    metadata: scopes.metadata === true,
    cover: scopes.cover === true,
    screenshots: scopes.screenshots === true,
    video: scopes.video === true,
  };
}

function normalizeTitleKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function candidatePlatforms(row) {
  return (row?.platforms || []).map((platform) => (
    typeof platform === 'object' ? platform.id : platform
  )).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean);
}

function createRollCreditsScraper({ store, providers, settings, jobs } = {}) {
  if (!store || !providers || !settings || !jobs) {
    throw new Error('Roll Credits scraper needs store, providers, settings, and jobs');
  }

  async function search(q, options = {}) {
    const rows = await providers.search(q, options);
    return rows.map((row) => ({
      providerId: row.providerId,
      provider: row.provider,
      name: row.name,
      year: row.year || null,
      platforms: Array.isArray(row.platforms) ? row.platforms : [],
      thumbUrl: row.thumbUrl || null,
    }));
  }

  function mediaRows(result, candidate, selectedSettings, scopes = null) {
    const rows = [];
    const source = sourceFor(candidate);
    if ((!scopes || scopes.cover) && result?.coverUrl) {
      rows.push({
        id: createMediaId(),
        kind: 'cover',
        source,
        path: null,
        thumbPath: null,
        remoteUrl: result.coverUrl,
        order: 0,
        hidden: false,
        status: 'pending',
        statusDetail: null,
      });
    }
    if (!scopes || scopes.screenshots) {
      (result?.screenshotUrls || [])
        .slice(0, selectedSettings.scrape.maxScreenshots)
        .forEach((remoteUrl, index) => rows.push({
          id: createMediaId(),
          kind: 'screenshot',
          source,
          path: null,
          thumbPath: null,
          remoteUrl,
          order: index,
          hidden: false,
          status: 'pending',
          statusDetail: null,
        }));
    }
    if ((!scopes || scopes.video)
      && selectedSettings.scrape.downloadVideo
      && (result?.youtubeUrl || result?.videoUrl)) {
      rows.push({
        id: createMediaId(),
        kind: 'video',
        source,
        path: null,
        thumbPath: null,
        remoteUrl: result.videoUrl || null,
        youtubeUrl: result.youtubeUrl || null,
        resolution: result.youtubeUrl ? selectedSettings.youtube.defaultResolution : null,
        order: 0,
        hidden: false,
        status: 'pending',
        statusDetail: null,
      });
    }
    return rows;
  }

  function queueRows(game, rows) {
    for (const row of rows) {
      jobs.enqueueDownload({
        gameId: game.id,
        mediaId: row.id,
        kind: row.kind,
      });
    }
  }

  async function createFromCandidate({
    candidate,
    system,
    beatenAt,
    beatenDateUnknown,
    beatenWith = '',
    notes = '',
  } = {}) {
    if (!candidate?.providerId || !candidate?.name) {
      throw new Error('A Roll Credits search candidate is required');
    }
    const selectedSettings = settings.get();
    const result = await providers.fetchGame(candidate, { system });
    const rows = mediaRows(result, candidate, selectedSettings);
    const created = store.createGame({
      title: result?.name || candidate.name,
      system,
      beatenAt,
      beatenDateUnknown,
      beatenWith: String(beatenWith || '').trim(),
      notes: String(notes || '').trim(),
      meta: scrapedMeta(result?.meta),
      metaEdited: [],
      media: rows,
      mediaPriorityOverride: null,
      provider: {
        igdbId: candidate.provider === 'igdb' ? Number(candidate.providerId) : null,
        steamAppId: candidate.provider === 'steam' ? Number(candidate.providerId) : null,
        ...(result?.provider || {}),
      },
      scrape: {
        lastScrapedAt: new Date().toISOString(),
        status: result ? 'ok' : 'failed',
        detail: result ? null : 'No provider returned game details',
      },
    });
    queueRows(created, rows);
    return store.getGame(created.id);
  }

  function createManual({
    title,
    system,
    beatenAt,
    beatenDateUnknown,
    beatenWith = '',
    notes = '',
  } = {}) {
    return store.createGame({
      title,
      system,
      beatenAt,
      beatenDateUnknown,
      beatenWith: String(beatenWith || '').trim(),
      notes: String(notes || '').trim(),
      meta: {},
      metaEdited: [],
      media: [],
      mediaPriorityOverride: null,
      provider: { igdbId: null, steamAppId: null, screenscraperId: null },
      scrape: {
        lastScrapedAt: null,
        status: 'manual',
        detail: null,
      },
    });
  }

  function candidateFor(game, { title } = {}) {
    const name = String(title || game.title || '').trim() || game.title;
    if (game.provider?.igdbId) {
      return {
        provider: 'igdb',
        providerId: game.provider.igdbId,
        steamAppId: game.provider.steamAppId,
        name,
      };
    }
    if (game.provider?.steamAppId) {
      return {
        provider: 'steam',
        providerId: game.provider.steamAppId,
        name,
      };
    }
    return { provider: 'steam', providerId: null, name };
  }

  /**
   * Re-scrape must target the title + system currently set on the game (or
   * passed from the edit form). A stale igdbId from another platform (NES
   * Rambo vs Arcade Rambo) must not win over a system-matching search hit.
   */
  async function resolveRescrapeCandidate(game, { title, system } = {}) {
    const wantedTitle = String(title || game.title || '').trim() || game.title;
    const wantedSystem = String(system || game.system || '').trim().toLowerCase() || game.system;
    const titleKey = normalizeTitleKey(wantedTitle);
    let matches = [];
    try {
      matches = await providers.search(wantedTitle, { limit: 20 });
    } catch {
      matches = [];
    }
    const forSystem = matches.filter((row) => candidatePlatforms(row).includes(wantedSystem));
    const exact = forSystem.find((row) => normalizeTitleKey(row.name) === titleKey);
    const pick = exact || forSystem[0] || null;
    if (pick?.providerId) {
      return {
        provider: pick.provider,
        providerId: pick.providerId,
        name: pick.name || wantedTitle,
        steamAppId: pick.provider === 'steam' ? pick.providerId : game.provider?.steamAppId,
        igdbId: pick.provider === 'igdb' ? pick.providerId : game.provider?.igdbId,
      };
    }
    // Search returned hits but none for this system — do not reuse a stale
    // cross-platform provider id (NES Rambo vs Arcade Rambo).
    if (matches.length > 0) {
      return {
        provider: 'igdb',
        providerId: null,
        name: wantedTitle,
      };
    }
    // Empty search — fall back to the stored id when it still makes sense.
    const fallback = candidateFor(game, { title: wantedTitle });
    if (wantedSystem === 'pc' || wantedSystem === 'steam-deck') {
      return fallback;
    }
    if (fallback.provider === 'igdb' && fallback.providerId) {
      return fallback;
    }
    return {
      provider: 'igdb',
      providerId: null,
      name: wantedTitle,
    };
  }

  async function rescrape(gameId, {
    scopes,
    mode = 'fill-gaps',
    title,
    system,
  } = {}) {
    const game = store.getGame(gameId);
    if (!game) throw new Error('Roll Credits game not found');
    if (!['fill-gaps', 'replace-scraped', 'replace-everything'].includes(mode)) {
      throw new Error('Unknown Roll Credits re-scrape mode');
    }
    const selectedScopes = normalizeScopes(scopes);
    const wantedTitle = String(title || game.title || '').trim() || game.title;
    const wantedSystem = String(system || game.system || '').trim().toLowerCase() || game.system;
    const candidate = await resolveRescrapeCandidate(game, {
      title: wantedTitle,
      system: wantedSystem,
    });
    const result = await providers.fetchGame(candidate, {
      system: wantedSystem,
      title: wantedTitle,
    });
    if (!result) {
      return store.updateGame(gameId, {
        // Keep the system/title the admin set — never invent a platform from scrape.
        title: wantedTitle,
        system: wantedSystem,
        scrape: {
          lastScrapedAt: new Date().toISOString(),
          status: 'failed',
          detail: 'No provider returned game details',
        },
      });
    }

    const patch = {
      title: wantedTitle,
      system: wantedSystem,
    };
    if (selectedScopes.metadata) {
      const existingMeta = { ...(game.meta || {}) };
      const edited = new Set(game.metaEdited || []);
      for (const field of META_FIELDS) {
        const incoming = result.meta?.[field];
        if (incoming === undefined) continue;
        if (mode === 'fill-gaps') {
          if (isEmpty(existingMeta[field])) existingMeta[field] = incoming;
        } else if (mode === 'replace-everything' || !edited.has(field)) {
          existingMeta[field] = incoming;
        }
      }
      // Difficulty is intentionally absent from META_FIELDS and is manual-only.
      patch.meta = existingMeta;
      if (mode === 'replace-everything') {
        patch.metaEdited = (game.metaEdited || []).filter((field) => !META_FIELDS.includes(field));
      }
    }

    const selectedSettings = settings.get();
    const freshRows = mediaRows(result, candidate, selectedSettings, selectedScopes);
    const selectedKinds = new Set([
      selectedScopes.cover ? 'cover' : null,
      selectedScopes.screenshots ? 'screenshot' : null,
      selectedScopes.video ? 'video' : null,
    ].filter(Boolean));
    const currentRows = game.media || [];
    let addedRows = freshRows;
    let keptRows = [...currentRows];
    if (mode === 'fill-gaps') {
      const kindsWithReady = new Set(
        currentRows.filter((row) => row.status === 'ready' && !row.hidden).map((row) => row.kind),
      );
      addedRows = freshRows.filter((row) => !kindsWithReady.has(row.kind));
    } else {
      keptRows = currentRows.filter((row) => {
        if (!selectedKinds.has(row.kind)) return true;
        if (row.source === 'upload' || row.source === 'youtube') return true;
        return !String(row.source || '').startsWith('scraped:');
      });
    }
    patch.media = [...keptRows, ...addedRows];
    patch.provider = { ...(game.provider || {}), ...(result.provider || {}) };
    if (candidate.provider === 'igdb' && candidate.providerId) {
      patch.provider.igdbId = Number(candidate.providerId);
    }
    if (candidate.provider === 'steam' && candidate.providerId) {
      patch.provider.steamAppId = Number(candidate.providerId);
    }
    patch.scrape = {
      lastScrapedAt: new Date().toISOString(),
      status: 'ok',
      detail: null,
    };
    const updated = store.updateGame(gameId, patch);
    queueRows(updated, addedRows);
    return store.getGame(gameId);
  }

  return {
    search,
    createFromCandidate,
    createManual,
    rescrape,
  };
}

module.exports = {
  createRollCreditsScraper,
  createMediaId,
  META_FIELDS,
  scrapedMeta,
  normalizeScopes,
};
