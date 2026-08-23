/**
 * Autodarts cloud history sync.
 *
 * Primary source of truth: GET /as/v0/matches/filter (play Match History).
 * Local archive is a cache + live-observed fallback when the cloud is down.
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGES = 80;
const STATS_GAP_MS = 250;

function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.floor(Number(text)));
  let sec = 0;
  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  const seconds = text.match(/(\d+)\s*s/i);
  if (hours) sec += Number(hours[1]) * 3600;
  if (minutes) sec += Number(minutes[1]) * 60;
  if (seconds) sec += Number(seconds[1]);
  return sec;
}

function playerName(row = {}) {
  return row.name || row.user?.name || row.playerName || 'Player';
}

function archiveFromCloudStats(statsJson, { source = 'backfill' } = {}) {
  if (!statsJson?.id) return null;
  const roster = Array.isArray(statsJson.players) ? statsJson.players : [];
  const scoreRows = Array.isArray(statsJson.scores) ? statsJson.scores : [];
  const matchStats = Array.isArray(statsJson.matchStats) ? statsJson.matchStats : [];
  const players = roster.map((row, index) => {
    const byId = matchStats.find((item) => item.playerId && item.playerId === row.id);
    const ms = byId || matchStats[index] || {};
    const scoreRow = scoreRows[index] || {};
    const checkoutPct = ms.checkoutPercent != null
      ? Number((Number(ms.checkoutPercent) * 100).toFixed(1))
      : null;
    return {
      name: playerName(row),
      userId: row.userId || row.user?.id || null,
      legsWon: Number(scoreRow.legs ?? ms.legsWon ?? 0) || 0,
      setsWon: Number(scoreRow.sets ?? ms.setsWon ?? 0) || 0,
      average: ms.average != null ? Number(ms.average) : null,
      first9: ms.first9Average != null ? Number(ms.first9Average) : null,
      dartsThrown: ms.dartsThrown != null ? Number(ms.dartsThrown) : null,
      pointsScored: null,
      checkoutPct,
      checkoutHits: ms.checkoutsHit != null ? Number(ms.checkoutsHit) : null,
      checkoutAttempts: ms.checkouts != null ? Number(ms.checkouts) : null,
      bestCheckout: ms.checkoutPoints != null ? Number(ms.checkoutPoints) : null,
      counts: {
        60: Number(ms.plus60) || 0,
        100: Number(ms.plus100) || 0,
        140: Number(ms.plus140) || 0,
        170: Number(ms.plus170) || 0,
        180: Number(ms.total180) || 0,
      },
    };
  });
  const winnerIndex = Number(statsJson.winner);
  const winner = Number.isInteger(winnerIndex) && winnerIndex >= 0
    ? (players[winnerIndex]?.name || null)
    : null;
  return {
    matchId: String(statsJson.id),
    variant: statsJson.variant || 'X01',
    settings: statsJson.settings || null,
    local: String(statsJson.type || '').toLowerCase() === 'local',
    startedAt: statsJson.createdAt || null,
    finishedAt: statsJson.finishedAt || null,
    durationSec: parseDuration(statsJson.duration),
    players,
    winner,
    gameShot: null,
    hitMap: null,
    source,
  };
}

/** Thin archive row from the list endpoint when /stats is unavailable. */
function archiveFromHistoryItem(item, { source = 'backfill-list' } = {}) {
  if (!item?.id) return null;
  const roster = Array.isArray(item.players) ? item.players : [];
  const scoreRows = Array.isArray(item.scores) ? item.scores : [];
  const players = roster.map((row, index) => {
    const scoreRow = scoreRows[index] || {};
    return {
      name: playerName(row),
      userId: row.userId || row.user?.id || null,
      legsWon: Number(scoreRow.legs) || 0,
      setsWon: Number(scoreRow.sets) || 0,
      average: null,
      first9: null,
      dartsThrown: null,
      pointsScored: null,
      checkoutPct: null,
      checkoutHits: null,
      checkoutAttempts: null,
      bestCheckout: null,
      counts: {},
    };
  });
  const winnerIndex = Number(item.winner);
  return {
    matchId: String(item.id),
    variant: item.variant || 'X01',
    settings: item.settings || null,
    local: String(item.type || '').toLowerCase() === 'local',
    startedAt: item.createdAt || null,
    finishedAt: item.finishedAt || null,
    durationSec: 0,
    players,
    winner: Number.isInteger(winnerIndex) && winnerIndex >= 0
      ? (players[winnerIndex]?.name || null)
      : null,
    gameShot: null,
    hitMap: null,
    source,
  };
}

function createAutodartsHistory({
  archive,
  aggregates,
  api,
  settings,
  log = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let running = false;
  let lastSyncAt = null;
  let lastError = null;
  let lastImported = 0;
  let lastSkipped = 0;
  let timer = null;

  function status() {
    const cfg = settings.get();
    const enabled = cfg.sync.historyBackfill !== false
      && cfg.sync.historyEndpointConfirmed !== false;
    return {
      enabled,
      running,
      lastSyncAt,
      lastError,
      lastImported,
      lastSkipped,
      archivedCount: archive.count(),
      note: enabled
        ? (lastError && !lastSyncAt
          ? `Cloud sync failed — using local archive (${lastError})`
          : null)
        : (cfg.sync.historyEndpointConfirmed === false
          ? 'Archive builds from live matches until cloud history is confirmed'
          : 'History sync disabled in settings'),
      cloud: 'GET /as/v0/matches/filter',
    };
  }

  async function importOne(item) {
    const matchId = String(item?.id || '').trim();
    if (!matchId) return { imported: false, skipped: true };
    if (archive.has(matchId)) return { imported: false, skipped: true };

    let row = null;
    try {
      const stats = await api.getMatchStats(matchId);
      if (stats?.ok && stats.json) {
        row = archiveFromCloudStats(stats.json, { source: 'backfill' });
      } else if (stats?.status === 404) {
        row = archiveFromHistoryItem(item);
      } else {
        log?.warn?.('Autodarts history stats failed', matchId, stats?.status);
        row = archiveFromHistoryItem(item);
      }
    } catch (error) {
      log?.warn?.('Autodarts history stats error', matchId, error?.message || error);
      row = archiveFromHistoryItem(item);
    }
    if (!row) return { imported: false, skipped: true };
    const result = archive.append(row);
    return { imported: !result.deduped, skipped: Boolean(result.deduped) };
  }

  async function sync({
    limit = null,
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = MAX_PAGES,
  } = {}) {
    const cfg = settings.get();
    if (cfg.sync.historyBackfill === false || cfg.sync.historyEndpointConfirmed === false) {
      return { ok: false, skipped: true, error: 'History sync is disabled in settings' };
    }
    if (running) {
      return { ok: false, error: 'History sync already running' };
    }
    if (typeof api?.listMatchHistory !== 'function') {
      return { ok: false, error: 'History list API is not available on this client' };
    }

    running = true;
    lastError = null;
    let imported = 0;
    let skipped = 0;
    let pages = 0;
    try {
      let page = 0;
      let done = false;
      while (!done && pages < maxPages) {
        const result = await api.listMatchHistory({
          size: pageSize,
          page,
          sort: '-finished_at',
        });
        if (!result?.ok || !result.json) {
          const message = `History list failed (HTTP ${result?.status || 0})`;
          lastError = message;
          // Soft-fail: keep whatever local archive we already have.
          return {
            ok: false,
            error: message,
            imported,
            skipped,
            note: 'Local archive left unchanged — retry Sync history when Autodarts is reachable',
          };
        }
        const body = result.json;
        const items = Array.isArray(body.items) ? body.items : [];
        if (!items.length) break;

        for (const item of items) {
          if (limit != null && imported >= Number(limit)) {
            done = true;
            break;
          }
          const outcome = await importOne(item);
          if (outcome.imported) imported += 1;
          if (outcome.skipped) skipped += 1;
          await sleep(STATS_GAP_MS);
        }

        pages += 1;
        const totalPages = Number(body.total_pages ?? body.totalPages ?? 0);
        const isLast = body.last === true
          || (totalPages > 0 && page + 1 >= totalPages)
          || items.length < pageSize;
        if (isLast || done) break;
        page += 1;
      }

      lastSyncAt = new Date().toISOString();
      lastImported = imported;
      lastSkipped = skipped;
      aggregates.recompute(archive.listAll());
      log?.info?.('Autodarts history sync complete', { imported, skipped, pages });
      return {
        ok: true,
        imported,
        skipped,
        pages,
        archivedCount: archive.count(),
        lastSyncAt,
      };
    } catch (error) {
      lastError = error?.message || String(error);
      log?.warn?.('Autodarts history sync failed', lastError);
      return {
        ok: false,
        error: lastError,
        imported,
        skipped,
        note: 'Using local archive until cloud sync succeeds',
      };
    } finally {
      running = false;
    }
  }

  function schedule(periodMs = 6 * 60 * 60 * 1000) {
    clearTimeout(timer);
    const tick = () => {
      sync().catch(() => {});
      timer = setTimeout(tick, periodMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    // First pass shortly after start so Settings isn't empty on day one.
    timer = setTimeout(tick, 5_000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  return {
    status,
    sync,
    schedule,
    stop,
    archiveFromCloudStats,
    archiveFromHistoryItem,
    parseDuration,
  };
}

module.exports = {
  createAutodartsHistory,
  archiveFromCloudStats,
  archiveFromHistoryItem,
  parseDuration,
};
