const fs = require('fs');
const path = require('path');

const ZONES = Object.freeze(['layup', 'one', 'two', 'three']);

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function playerKey(name) {
  return String(name || '').trim().toLowerCase();
}

function emptyZones() {
  return ZONES.reduce((out, zone) => {
    out[zone] = { made: 0, attempts: 0 };
    return out;
  }, {});
}

function addZones(target, source) {
  for (const zone of ZONES) {
    const row = source?.[zone];
    if (!row) continue;
    target[zone].made += Number(row.made) || 0;
    target[zone].attempts += Number(row.attempts) || 0;
  }
}

function pct(made, attempts) {
  const total = Number(attempts) || 0;
  if (total <= 0) return 0;
  return Math.round((100 * (Number(made) || 0)) / total);
}

function emptyPlayer(displayName) {
  return {
    displayName: displayName || 'Unknown',
    games: 0,
    wins: 0,
    winPct: 0,
    points: 0,
    bestScore: 0,
    made: 0,
    attempts: 0,
    fgPct: 0,
    threes: 0,
    bestStreak: 0,
    byZone: emptyZones(),
    firstSeenAt: null,
    lastPlayedAt: null,
  };
}

/**
 * A session worth counting.
 *
 * A couple of stray shots is someone walking past the hoop, not a session, and
 * counting it would drag every career FG% down and move "last played" to a
 * night nobody actually played.
 */
function wasPlayed(session) {
  if (!session) return false;
  const attempts = Number(session.stats?.attempts) || 0;
  return attempts >= 2;
}

function isRankedSession(session) {
  // Only modes that name their players can feed a leaderboard.
  return Array.isArray(session?.players) && session.players.length > 0;
}

function recomputeFromSessions(sessions = []) {
  const played = sessions.filter(wasPlayed);
  const players = new Map();
  const totals = {
    sessions: played.length,
    games: 0,
    freePlaySessions: 0,
    shots: 0,
    makes: 0,
    fgPct: 0,
    points: 0,
    playSeconds: 0,
  };
  const byZone = emptyZones();
  const months = new Map();
  let bestSessionScore = null;
  let bestStreak = null;

  for (const session of played) {
    const at = session.endedAt || session.startedAt || null;
    const stats = session.stats || {};
    totals.shots += Number(stats.attempts) || 0;
    totals.makes += Number(stats.made) || 0;
    totals.points += Number(stats.points) || 0;
    totals.playSeconds += Number(session.durationSec) || 0;
    addZones(byZone, stats.byZone);

    if (isRankedSession(session)) totals.games += 1;
    else totals.freePlaySessions += 1;

    const monthKey = String(at || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(monthKey)) {
      months.set(monthKey, (months.get(monthKey) || 0) + 1);
    }

    const sessionScore = Number(stats.points) || 0;
    if (sessionScore > 0 && (!bestSessionScore || sessionScore > bestSessionScore.value)) {
      bestSessionScore = { value: sessionScore, mode: session.mode || 'unknown', at };
    }
    const sessionStreak = Number(stats.bestStreak) || 0;
    if (sessionStreak > 0 && (!bestStreak || sessionStreak > bestStreak.value)) {
      bestStreak = { value: sessionStreak, player: null, at };
    }

    for (const row of session.players || []) {
      const key = playerKey(row.name);
      if (!key) continue;
      const player = players.get(key) || emptyPlayer(row.name);
      player.displayName = row.name || player.displayName;
      player.games += 1;
      if (row.position === 0 || row.isWinner === true) player.wins += 1;
      player.points += Number(row.score) || 0;
      player.bestScore = Math.max(player.bestScore, Number(row.score) || 0);
      player.made += Number(row.made) || 0;
      player.attempts += Number(row.attempts) || 0;
      player.threes += Number(row.threes) || 0;
      player.bestStreak = Math.max(player.bestStreak, Number(row.bestStreak) || 0);
      addZones(player.byZone, row.byZone);
      if (at && (!player.firstSeenAt || at < player.firstSeenAt)) player.firstSeenAt = at;
      if (at && (!player.lastPlayedAt || at > player.lastPlayedAt)) player.lastPlayedAt = at;
      players.set(key, player);

      const streak = Number(row.bestStreak) || 0;
      if (streak > 0 && (!bestStreak || streak > bestStreak.value)) {
        bestStreak = { value: streak, player: row.name || null, at };
      }
    }
  }

  totals.fgPct = pct(totals.makes, totals.shots);
  totals.points = Math.round(totals.points * 10) / 10;

  const leaderboard = [...players.values()].map((player) => ({
    ...player,
    points: Math.round(player.points * 10) / 10,
    bestScore: Math.round(player.bestScore * 10) / 10,
    winPct: player.games ? Math.round((100 * player.wins) / player.games) : 0,
    fgPct: pct(player.made, player.attempts),
  })).sort((a, b) => (
    b.wins - a.wins
    || b.winPct - a.winPct
    || b.fgPct - a.fgPct
    || String(a.displayName).localeCompare(String(b.displayName))
  ));

  const byMonth = [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      key,
      label: MONTH_LABELS[Number(key.slice(5, 7)) - 1] || key,
      count,
    }));

  const recent = played
    .slice()
    .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')))
    .slice(0, 10)
    .map((session) => ({
      sessionId: session.sessionId,
      mode: session.mode || 'unknown',
      endedAt: session.endedAt || null,
      winner: session.winner || null,
      points: Math.round((Number(session.stats?.points) || 0) * 10) / 10,
      made: Number(session.stats?.made) || 0,
      attempts: Number(session.stats?.attempts) || 0,
    }));

  return {
    updatedAt: new Date().toISOString(),
    totals,
    byZone: ZONES.reduce((out, zone) => {
      out[zone] = { ...byZone[zone], pct: pct(byZone[zone].made, byZone[zone].attempts) };
      return out;
    }, {}),
    records: {
      bestSessionScore,
      bestStreak,
      bestFgPct: leaderboard.length
        ? leaderboard.reduce((best, row) => (row.fgPct > (best?.fgPct ?? -1) ? row : best), null)
        : null,
    },
    players: leaderboard,
    byMonth,
    recent,
  };
}

function createHuupeAggregates(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const playersPath = path.resolve(
    config.huupePlayersPath || path.join(root, 'data', 'huupe-players.json'),
  );
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      if (fs.existsSync(playersPath)) {
        cache = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
      }
    } catch (error) {
      log?.warn?.('Could not read Huupe aggregates', error?.message || error);
    }
    return cache;
  }

  function persist(value) {
    try {
      fs.mkdirSync(path.dirname(playersPath), { recursive: true });
      const temporaryPath = `${playersPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, playersPath);
      return true;
    } catch (error) {
      log?.warn?.('Could not persist Huupe aggregates', error?.message || error);
      return false;
    }
  }

  /**
   * Always a full rebuild from the archive rather than an incremental update —
   * a career table that drifts from its own source is worse than a slow one,
   * and the archive is small enough that this stays cheap.
   */
  function recompute(sessions) {
    cache = recomputeFromSessions(sessions || []);
    persist(cache);
    return cache;
  }

  return {
    playersPath,
    get: load,
    recompute,
    recomputeFromSessions,
    playerKey,
  };
}

module.exports = {
  createHuupeAggregates,
  recomputeFromSessions,
  playerKey,
  wasPlayed,
  isRankedSession,
  pct,
  ZONES,
};
