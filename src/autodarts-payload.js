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

function buildDashboardPayload({
  aggregates,
  archive,
  settings,
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

function createAutodartsPayload({ archive, aggregates, settings } = {}) {
  return {
    buildDashboard: () => buildDashboardPayload({ archive, aggregates, settings }),
    buildMatch: (match, options) => buildMatchPayload(match, options),
    buildClose: (matchId, reason) => buildMatchClosePayload(matchId, reason),
    buildLastMatch: () => {
      const [latest] = archive.latest(1);
      if (!latest) return null;
      const cfg = settings.get();
      return buildMatchPayload({
        ...latest,
        status: 'finished',
        revision: Number(latest.revision) || 1,
        settingsLine: latest.settingsLine
          || [latest.variant, latest.settings?.baseScore].filter(Boolean).join(' · '),
        players: (latest.players || []).map((row) => ({
          name: row.name,
          score: row.legsWon ?? 0,
          legs: row.legsWon ?? 0,
          sets: row.setsWon ?? 0,
          average: row.average ?? null,
          lastTurnPoints: null,
          isWinner: latest.winner === row.name,
          checkoutPct: row.checkoutPct ?? null,
        })),
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
};
