function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function relativeAge(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const delta = Math.max(0, now - then);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * Normalise Autodarts board list/detail JSON into a dashboard "YOUR BOARD" card.
 * Field names vary across /bs/v0/boards responses — accept several aliases.
 */
function normalizeBoardInfo(raw, { fallbackName = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    return fallbackName ? {
      name: fallbackName,
      online: null,
      statusLabel: 'Unknown',
      version: null,
      updateLabel: null,
      os: null,
      dartsThrown: null,
      corrections: null,
      accuracy: null,
    } : null;
  }
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const onlineRaw = raw.online ?? raw.connected ?? raw.running ?? raw.status;
  let online = null;
  let statusLabel = null;
  if (typeof onlineRaw === 'boolean') {
    online = onlineRaw;
  } else if (typeof onlineRaw === 'string') {
    const lower = onlineRaw.toLowerCase();
    if (['running', 'online', 'connected', 'active', 'true'].includes(lower)) {
      online = true;
      statusLabel = onlineRaw === 'Running' ? 'Running' : 'Online';
    } else if (['offline', 'disconnected', 'stopped', 'false', 'idle'].includes(lower)) {
      online = false;
      statusLabel = 'Offline';
    } else {
      statusLabel = onlineRaw;
    }
  }
  if (statusLabel == null) {
    statusLabel = online === true ? 'Running' : (online === false ? 'Offline' : 'Unknown');
  }

  const version = raw.version || raw.clientVersion || raw.softwareVersion
    || raw.boardVersion || stats.version || null;
  const latest = raw.latestVersion || raw.availableVersion || null;
  const updateAvailable = raw.updateAvailable === true
    || raw.upToDate === false
    || (latest && version && String(latest) !== String(version));
  const updateLabel = raw.upToDate === true || raw.updateAvailable === false
    ? 'Up to date'
    : (updateAvailable ? 'Update available' : (version ? 'Up to date' : null));

  const osRaw = raw.os || raw.operatingSystem || raw.platform || raw.hostOs || null;
  let os = osRaw ? String(osRaw) : null;
  if (os) {
    const lower = os.toLowerCase();
    if (lower.includes('linux')) os = 'Linux';
    else if (lower.includes('win')) os = 'Windows';
    else if (lower.includes('darwin') || lower.includes('mac')) os = 'macOS';
  }

  const dartsThrown = firstNumber(
    raw.dartsThrown, raw.darts, raw.numDarts, raw.throws,
    stats.dartsThrown, stats.darts, stats.numDarts, stats.throws,
  );
  const corrections = firstNumber(
    raw.corrections, raw.numCorrections, raw.correctionCount,
    stats.corrections, stats.numCorrections,
  );
  let accuracy = firstNumber(
    raw.accuracy, raw.accuracyPercent, stats.accuracy, stats.accuracyPercent,
  );
  if (accuracy != null && accuracy <= 1) accuracy *= 100;
  if (accuracy != null) accuracy = Math.round(accuracy * 100) / 100;

  return {
    id: raw.id || raw.boardId || null,
    name: raw.name || raw.boardName || fallbackName || 'Board',
    online,
    statusLabel,
    version: version != null ? String(version) : null,
    updateLabel,
    os,
    dartsThrown,
    corrections,
    accuracy,
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** True when a live match shell has enough data to air (not an empty 0m00s card). */
function isPlayableLiveMatch(match) {
  if (!match || match.status !== 'live') return false;
  if (!match.matchId) return false;
  const players = Array.isArray(match.players) ? match.players : [];
  return players.length >= 1;
}

function buildDashboardPayload({
  aggregates,
  archive,
  settings,
  board = null,
  now = Date.now(),
} = {}) {
  const cfg = settings?.get?.() || settings || {};
  const leaderboardSize = clampInt(cfg.dashboard?.leaderboardSize, 3, 16, 12);
  const displaySeconds = clampInt(cfg.dashboard?.displaySeconds, 30, 600, 120);
  const data = typeof aggregates?.get === 'function' ? aggregates.get() : aggregates;
  const players = Array.isArray(data?.players) ? data.players : [];
  const leaderboard = players.slice(0, leaderboardSize).map((row, index) => ({
    rank: index + 1,
    crown: index === 0,
    name: row.name,
    wins: row.wins,
    losses: row.losses,
    winPct: row.winPct,
    x01Average: row.x01Average,
    bestCheckout: row.bestCheckout,
    oneEighties: row.counts?.['180'] || 0,
    matches: row.matches,
    isGuest: row.isGuest === true,
  }));
  const recent = (archive?.latest?.(3) || []).map((match) => ({
    variant: match.variant || 'Match',
    players: (match.players || []).map((p) => p.name).filter(Boolean),
    result: (match.players || []).map((p) => p.legsWon ?? 0).join('—'),
    winner: match.winner || null,
    when: match.finishedAt || match.startedAt || null,
  }));

  const payload = {
    version: 2,
    type: 'autodarts.dashboard',
    timestamp: new Date(now).toISOString(),
    displaySeconds,
    persistent: false,
    totals: {
      matches: data?.totals?.matches || 0,
      legs: data?.totals?.legs || 0,
      thisMonth: data?.totals?.thisMonth || 0,
      lastPlayedAt: data?.totals?.lastPlayedAt || null,
      lastPlayedLabel: relativeAge(data?.totals?.lastPlayedAt, now),
    },
    leaderboard,
    moreCount: Math.max(0, players.length - leaderboard.length),
    byMonth: data?.months || [],
    byVariant: data?.byVariant || [],
    rivalry: data?.rivalry || null,
    records: data?.records || null,
    recent,
    board: board || null,
  };
  return payload;
}

function buildMatchPayload(match, {
  persistent = true,
  displaySeconds = null,
  status = null,
} = {}) {
  const resolvedStatus = status || match?.status || 'live';
  return {
    version: 2,
    type: 'autodarts.match',
    timestamp: new Date().toISOString(),
    persistent: resolvedStatus === 'live' ? persistent : false,
    displaySeconds: resolvedStatus === 'live' ? 0 : displaySeconds,
    match: {
      matchId: match.matchId,
      revision: Number(match.revision) || 0,
      status: resolvedStatus,
      variant: match.variant || 'X01',
      settingsLine: match.settingsLine || '',
      startedAt: match.startedAt || null,
      durationSec: Number(match.durationSec) || 0,
      currentPlayerIndex: Number.isInteger(match.currentPlayerIndex) ? match.currentPlayerIndex : 0,
      turn: match.turn || { points: 0, busted: false, darts: [null, null, null] },
      prevTurn: match.prevTurn || null,
      players: Array.isArray(match.players) ? match.players : [],
      gameShot: match.gameShot || null,
      hitMap: match.hitMap || null,
    },
  };
}

function buildMatchClosePayload(matchId, reason = 'close') {
  return {
    version: 2,
    type: 'autodarts.match.close',
    timestamp: new Date().toISOString(),
    matchId: String(matchId || ''),
    reason: String(reason || 'close'),
  };
}

function settingsLineFromArchive(latest) {
  if (latest?.settingsLine) return String(latest.settingsLine);
  const settings = latest?.settings || {};
  const parts = [];
  const variant = latest?.variant || 'X01';
  parts.push(variant);
  const base = settings.baseScore ?? settings.target;
  if (base != null && base !== '') parts.push(String(base));
  const inMode = settings.inMode || settings.in;
  const outMode = settings.outMode || settings.out;
  if (inMode || outMode) {
    parts.push([inMode, outMode].filter(Boolean).join('-'));
  }
  return parts.filter(Boolean).join(' · ');
}

function createAutodartsPayload({ archive, aggregates, settings } = {}) {
  return {
    buildDashboard: (options = {}) => buildDashboardPayload({
      archive, aggregates, settings, board: options.board || null,
    }),
    buildMatch: (match, options) => buildMatchPayload(match, options),
    buildClose: (matchId, reason) => buildMatchClosePayload(matchId, reason),
    buildLastMatch: () => {
      const [latest] = archive.latest(1);
      if (!latest) return null;
      const cfg = settings.get();
      const players = (latest.players || []).map((row) => ({
        name: row.name,
        // FINAL card treats `legs` as the headline; remaining score is not useful.
        score: row.legsWon ?? 0,
        legs: row.legsWon ?? 0,
        sets: row.setsWon ?? 0,
        average: row.average ?? null,
        lastTurnPoints: null,
        isWinner: latest.winner === row.name,
        checkoutPct: row.checkoutPct ?? null,
      }));
      // If archive forgot winner, crown the highest legs.
      if (players.length && !players.some((p) => p.isWinner)) {
        const best = Math.max(...players.map((p) => Number(p.legs) || 0));
        if (best > 0) {
          for (const row of players) {
            if (Number(row.legs) === best) row.isWinner = true;
          }
        }
      }
      return buildMatchPayload({
        ...latest,
        status: 'finished',
        revision: Number(latest.revision) || 1,
        settingsLine: settingsLineFromArchive(latest),
        players,
        gameShot: latest.gameShot || null,
        hitMap: latest.hitMap || null,
        turn: { points: 0, busted: false, darts: [null, null, null] },
        prevTurn: null,
        currentPlayerIndex: 0,
        durationSec: latest.durationSec || 0,
        startedAt: latest.startedAt,
      }, {
        persistent: false,
        displaySeconds: cfg.lastMatch.displaySeconds,
        status: 'finished',
      });
    },
  };
}

module.exports = {
  createAutodartsPayload,
  buildDashboardPayload,
  buildMatchPayload,
  buildMatchClosePayload,
  relativeAge,
  normalizeBoardInfo,
  isPlayableLiveMatch,
};
