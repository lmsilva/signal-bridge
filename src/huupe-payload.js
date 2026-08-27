/**
 * Wire payloads for the Huupe integration.
 *
 * Pure: every builder takes plain state and returns a plain object, so the
 * panel contract can be asserted without a hoop, a socket or a display.
 */

const { ZONES } = require('./huupe-aggregates');

const MODE_LABELS = {
  family: 'Family Mode',
  justhuupe: 'Free Play',
  dailyprize: 'Daily Prize',
  fitness: 'Fitness',
  live: 'Huupe Live',
  launcher: 'Home',
  unknown: 'Session',
};

const ZONE_LABELS = {
  layup: 'Layup',
  one: '1 PT',
  two: '2 PT',
  three: '3 PT',
};

const ZONE_SHORT = {
  layup: 'LAY',
  one: '1PT',
  two: '2PT',
  three: '3PT',
};

function modeLabel(mode) {
  return MODE_LABELS[String(mode || '').toLowerCase()] || MODE_LABELS.unknown;
}

function zoneLabel(zone) {
  return ZONE_LABELS[zone] || '';
}

/** Scores carry a tenth only when a layup actually put one there. */
function formatPoints(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function relativeDay(iso, nowMs = Date.now()) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return '';
  const days = Math.floor((nowMs - time) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function zoneRows(byZone) {
  return ZONES.map((zone) => {
    const row = byZone?.[zone] || {};
    return {
      zone,
      label: ZONE_LABELS[zone],
      short: ZONE_SHORT[zone],
      made: Number(row.made) || 0,
      attempts: Number(row.attempts) || 0,
      pct: Number(row.pct) || 0,
    };
  });
}

/**
 * The one line that has to read from across the room.
 *
 * Family Mode has a named winner once the game calls it; a solo session has
 * only its own score, which is the number the shooter is chasing.
 */
function headlineFor(session) {
  if (session.status === 'finished' && session.winner) {
    return { primary: session.winner, secondary: 'WINS' };
  }
  if (session.players?.length > 1) {
    const leader = session.players[0];
    return { primary: leader?.name || '', secondary: `${formatPoints(leader?.score)} PTS` };
  }
  return { primary: formatPoints(session.stats?.points), secondary: 'POINTS' };
}

function buildSessionPayload(session = {}, {
  persistent = true,
  displaySeconds = 0,
  now = () => Date.now(),
} = {}) {
  const nowMs = now();
  const stats = session.stats || {};
  const players = (session.players || []).map((player, index) => ({
    ...player,
    rank: index + 1,
    scoreLabel: formatPoints(player.score),
    zones: zoneRows(player.byZone),
  }));

  return {
    version: 2,
    type: 'huupe.session',
    timestamp: new Date(nowMs).toISOString(),
    displaySeconds,
    persistent,
    session: {
      sessionId: session.sessionId || null,
      mode: session.mode || 'unknown',
      modeLabel: modeLabel(session.mode),
      status: session.status || 'live',
      revision: Number(session.revision) || 0,
      startedAt: session.startedAt || null,
      endedAt: session.endedAt || null,
      durationSec: Number(session.durationSec) || 0,
      durationLabel: formatDuration(session.durationSec),
      headline: headlineFor({ ...session, players, stats }),
      players,
      stats: {
        ...stats,
        pointsLabel: formatPoints(stats.points),
        shotLine: `${Number(stats.made) || 0}/${Number(stats.attempts) || 0}`,
      },
      zones: zoneRows(stats.byZone),
      lastShot: session.lastShot
        ? {
          ...session.lastShot,
          zoneLabel: zoneLabel(session.lastShot.zone),
          pointsLabel: formatPoints(session.lastShot.points),
        }
        : null,
      winner: session.winner || null,
      sensorErrors: Number(session.sensorErrors) || 0,
    },
  };
}

/**
 * Turn an archived row back into the shape the session builder expects.
 *
 * The archive already stores computed percentages, so this is a re-hydration
 * rather than a recalculation — a stat shown on a "last game" push is exactly
 * the one that was shown when the game ended.
 */
function viewFromArchivedSession(row = {}) {
  return {
    sessionId: row.sessionId || null,
    mode: row.mode || 'unknown',
    status: 'finished',
    revision: 0,
    startedAt: row.startedAt || null,
    endedAt: row.endedAt || null,
    durationSec: Number(row.durationSec) || 0,
    players: (row.players || []).map((player) => ({ ...player, streak: 0 })),
    stats: { streak: 0, ...(row.stats || {}) },
    lastShot: null,
    winner: row.winner || null,
    uniqueScoreId: row.uniqueScoreId || null,
    combination: row.combination || null,
    truncated: Boolean(row.truncated),
    aborted: Boolean(row.aborted),
    sensorErrors: 0,
  };
}

function buildClosePayload(sessionId, reason = 'ended', { now = () => Date.now() } = {}) {
  return {
    version: 2,
    type: 'huupe.session.close',
    timestamp: new Date(now()).toISOString(),
    sessionId: sessionId || null,
    reason,
  };
}

function buildDashboardPayload(aggregate = {}, {
  displaySeconds = 120,
  leaderboardSize = 10,
  device = null,
  lastSession = null,
  now = () => Date.now(),
} = {}) {
  const nowMs = now();
  const totals = aggregate.totals || {};
  const players = Array.isArray(aggregate.players) ? aggregate.players : [];
  const size = Math.max(1, Number(leaderboardSize) || 10);

  return {
    version: 2,
    type: 'huupe.dashboard',
    timestamp: new Date(nowMs).toISOString(),
    displaySeconds,
    persistent: false,
    totals: {
      sessions: Number(totals.sessions) || 0,
      games: Number(totals.games) || 0,
      freePlaySessions: Number(totals.freePlaySessions) || 0,
      shots: Number(totals.shots) || 0,
      makes: Number(totals.makes) || 0,
      fgPct: Number(totals.fgPct) || 0,
      points: Number(totals.points) || 0,
      pointsLabel: formatPoints(totals.points),
      playSeconds: Number(totals.playSeconds) || 0,
      playLabel: formatDuration(totals.playSeconds),
      lastPlayedAt: lastSession?.endedAt || aggregate.recent?.[0]?.endedAt || null,
      lastPlayedLabel: relativeDay(
        lastSession?.endedAt || aggregate.recent?.[0]?.endedAt || null,
        nowMs,
      ),
    },
    leaderboard: players.slice(0, size).map((player, index) => ({
      rank: index + 1,
      crown: index === 0,
      name: player.displayName,
      games: player.games,
      wins: player.wins,
      winPct: player.winPct,
      points: player.points,
      pointsLabel: formatPoints(player.points),
      bestScore: player.bestScore,
      bestScoreLabel: formatPoints(player.bestScore),
      made: player.made,
      attempts: player.attempts,
      fgPct: player.fgPct,
      threes: player.threes,
      bestStreak: player.bestStreak,
      lastPlayedLabel: relativeDay(player.lastPlayedAt, nowMs),
    })),
    moreCount: Math.max(0, players.length - size),
    zones: zoneRows(aggregate.byZone),
    byMonth: Array.isArray(aggregate.byMonth) ? aggregate.byMonth : [],
    records: {
      bestSessionScore: aggregate.records?.bestSessionScore
        ? {
          ...aggregate.records.bestSessionScore,
          valueLabel: formatPoints(aggregate.records.bestSessionScore.value),
          modeLabel: modeLabel(aggregate.records.bestSessionScore.mode),
        }
        : null,
      bestStreak: aggregate.records?.bestStreak || null,
      bestFgPct: aggregate.records?.bestFgPct
        ? {
          player: aggregate.records.bestFgPct.displayName,
          value: aggregate.records.bestFgPct.fgPct,
        }
        : null,
    },
    recent: (aggregate.recent || []).map((row) => ({
      ...row,
      modeLabel: modeLabel(row.mode),
      pointsLabel: formatPoints(row.points),
      whenLabel: relativeDay(row.endedAt, nowMs),
    })),
    device: device || null,
  };
}

module.exports = {
  buildSessionPayload,
  buildClosePayload,
  buildDashboardPayload,
  viewFromArchivedSession,
  headlineFor,
  modeLabel,
  zoneLabel,
  zoneRows,
  formatPoints,
  formatDuration,
  relativeDay,
  MODE_LABELS,
  ZONE_LABELS,
  ZONE_SHORT,
};
