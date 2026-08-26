/**
 * Autodarts cloud history sync.
 *
 * Primary source of truth: GET /as/v0/matches/filter (play Match History).
 * Local archive is a cache + live-observed fallback when the cloud is down.
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGES = 40;
const SCHEDULED_MAX_PAGES = 3;
const STATS_GAP_MS = 1200;
const PAGE_GAP_MS = 600;
const INITIAL_SYNC_DELAY_MS = 10 * 60 * 1000;
const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const SKIPPED_PAGES_STOP = 2;

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
  rateLimit = null,
  log = console,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let running = false;
  let lastSyncAt = null;
  let lastError = null;
  let lastImported = 0;
  let lastSkipped = 0;
  let timer = null;
  let lastManualSyncAt = 0;

  function status() {
    const cfg = settings.get();
    const enabled = cfg.sync.historyBackfill !== false
      && cfg.sync.historyEndpointConfirmed !== false;
    const rate = rateLimit?.snapshot?.() || null;
    let note = enabled
      ? (lastError && !lastSyncAt
        ? `Cloud sync failed — using local archive (${lastError})`
        : null)
      : (cfg.sync.historyEndpointConfirmed === false
        ? 'Archive builds from live matches until cloud history is confirmed'
        : 'History sync disabled in settings');
    if (rate?.paused && rate.reason) {
      note = note
        ? `${note} — cloud paused (${rate.reason})`
        : `Cloud paused (${rate.reason})`;
    }
    return {
      enabled,
      running,
      lastSyncAt,
      lastError,
      lastImported,
      lastSkipped,
      archivedCount: archive.count(),
      note,
      rateLimit: rate,
      cloud: 'GET /as/v0/matches/filter',
    };
  }

  function listErrorMessage(result) {
    return String(
      result?.json?.message
      || result?.json?.error_description
      || (typeof result?.json?.error === 'string' ? result.json.error : result?.json?.error?.message)
      || result?.text
      || `History list failed (HTTP ${result?.status || 0})`,
    ).trim();
  }

  async function importOne(item) {
    const matchId = String(item?.id || '').trim();
    if (!matchId) return { imported: false, skipped: true };
    if (archive.has(matchId)) return { imported: false, skipped: true };

    let row = null;
    try {
      const stats = await api.getMatchStats(matchId);
      if (stats?.rateLimited || rateLimit?.isRateLimitedStatus?.(stats?.status, stats?.json, stats?.text)) {
        const err = new Error(listErrorMessage(stats));
        err.code = 'AUTODARTS_RATE_LIMITED';
        throw err;
      }
      if (stats?.ok && stats.json) {
        row = archiveFromCloudStats(stats.json, { source: 'backfill' });
      } else if (stats?.status === 404) {
        row = archiveFromHistoryItem(item);
      } else {
        log?.warn?.('Autodarts history stats failed', matchId, stats?.status);
        row = archiveFromHistoryItem(item);
      }
    } catch (error) {
      if (error?.code === 'AUTODARTS_RATE_LIMITED') throw error;
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
    mode = 'manual',
    force = false,
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
    if (rateLimit?.isPaused?.()) {
      const snap = rateLimit.snapshot();
      return {
        ok: false,
        skipped: true,
        error: snap.reason || 'Autodarts cloud is rate-limited — try again later',
        note: 'Using local archive until the cooldown expires',
      };
    }
    const manual = mode !== 'scheduled';
    if (manual && !force) {
      const sinceManual = now() - lastManualSyncAt;
      if (lastManualSyncAt > 0 && sinceManual < MANUAL_SYNC_COOLDOWN_MS) {
        const waitSec = Math.ceil((MANUAL_SYNC_COOLDOWN_MS - sinceManual) / 1000);
        return {
          ok: false,
          skipped: true,
          error: `Please wait ${waitSec}s before syncing again`,
          note: 'Manual history sync is throttled to protect the Autodarts API',
        };
      }
    }

    running = true;
    lastError = null;
    let imported = 0;
    let skipped = 0;
    let pages = 0;
    let consecutiveSkippedPages = 0;
    const effectiveMaxPages = manual ? maxPages : Math.min(maxPages, SCHEDULED_MAX_PAGES);
    try {
      let page = 0;
      let done = false;
      while (!done && pages < effectiveMaxPages) {
        const result = await api.listMatchHistory({
          size: pageSize,
          page,
          sort: '-finished_at',
        });
        if (result?.rateLimited || rateLimit?.isRateLimitedStatus?.(result?.status, result?.json, result?.text)) {
          const message = listErrorMessage(result);
          lastError = message;
          return {
            ok: false,
            error: message,
            imported,
            skipped,
            note: 'Local archive left unchanged — cloud sync paused until rate limit clears',
          };
        }
        if (!result?.ok || !result.json) {
          const message = listErrorMessage(result);
          lastError = message;
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

        let pageImported = 0;
        let pageSkipped = 0;
        for (const item of items) {
          if (limit != null && imported >= Number(limit)) {
            done = true;
            break;
          }
          const outcome = await importOne(item);
          if (outcome.imported) {
            imported += 1;
            pageImported += 1;
          }
          if (outcome.skipped) {
            skipped += 1;
            pageSkipped += 1;
          }
          await sleep(STATS_GAP_MS);
        }

        pages += 1;
        if (pageImported === 0 && pageSkipped === items.length) {
          consecutiveSkippedPages += 1;
          if (consecutiveSkippedPages >= SKIPPED_PAGES_STOP) {
            log?.info?.('Autodarts history sync caught up — stopping early', { pages });
            break;
          }
        } else {
          consecutiveSkippedPages = 0;
        }

        const totalPages = Number(body.total_pages ?? body.totalPages ?? 0);
        const isLast = body.last === true
          || (totalPages > 0 && page + 1 >= totalPages)
          || items.length < pageSize;
        if (isLast || done) break;
        page += 1;
        await sleep(PAGE_GAP_MS);
      }

      lastSyncAt = new Date(now()).toISOString();
      lastImported = imported;
      lastSkipped = skipped;
      if (manual) lastManualSyncAt = now();
      aggregates.recompute(archive.listAll());
      log?.info?.('Autodarts history sync complete', { imported, skipped, pages, mode });
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
      sync({ mode: 'scheduled' }).catch(() => {});
      timer = setTimeout(tick, periodMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    timer = setTimeout(tick, INITIAL_SYNC_DELAY_MS);
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
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  SCHEDULED_MAX_PAGES,
  STATS_GAP_MS,
  INITIAL_SYNC_DELAY_MS,
};
