const fs = require('fs');
const path = require('path');

const X01_VARIANTS = new Set(['x01', 'x01+', 'x01plus', 'random checkout', 'randomcheckout']);

function isX01Family(variant) {
  return X01_VARIANTS.has(String(variant || '').trim().toLowerCase());
}

function playerKey(name) {
  // v1: case-insensitive only. Alias merging (WAR D ↔ Ward) is a v2 idea.
  return String(name || '').trim().toLowerCase();
}

function emptyPlayer(displayName) {
  return {
    displayName: displayName || 'Unknown',
    matches: 0,
    wins: 0,
    winPct: 0,
    legsWon: 0,
    legsPlayed: 0,
    x01Points: 0,
    x01Darts: 0,
    x01AverageSum: 0,
    x01AverageWeight: 0,
    x01BestMatchAverage: 0,
    checkoutHits: 0,
    checkoutAttempts: 0,
    checkoutPct: 0,
    bestCheckout: 0,
    counts: { 60: 0, 100: 0, 140: 0, 170: 0, 180: 0 },
    firstSeenAt: null,
    lastPlayedAt: null,
    isGuest: true,
  };
}

function lifetimeAverage(player) {
  if (player.x01Darts > 0 && player.x01Points > 0) {
    return Number(((player.x01Points / player.x01Darts) * 3).toFixed(2));
  }
  if (player.x01AverageWeight > 0) {
    return Number((player.x01AverageSum / player.x01AverageWeight).toFixed(2));
  }
  return 0;
}

function recomputeFromMatches(matches = []) {
  const players = new Map();
  const pairCounts = new Map();
  const monthCounts = new Map();
  const variantCounts = new Map();
  let totalLegs = 0;
  let bestMatchAverage = null;
  let highestCheckout = null;
  let total180s = 0;

  for (const match of matches) {
    const finishedAt = match.finishedAt || match.startedAt || null;
    if (finishedAt) {
      const key = String(finishedAt).slice(0, 7);
      monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
    }
    const variant = String(match.variant || 'Other');
    variantCounts.set(variant, (variantCounts.get(variant) || 0) + 1);

    const roster = Array.isArray(match.players) ? match.players : [];
    for (const row of roster) {
      totalLegs += Number(row.legsWon) || 0;
      const key = playerKey(row.name);
      if (!key) continue;
      const current = players.get(key) || emptyPlayer(row.name);
      current.displayName = row.name || current.displayName;
      current.matches += 1;
      current.legsWon += Number(row.legsWon) || 0;
      current.legsPlayed += (Number(row.legsWon) || 0) + (Number(row.legsLost) || 0);
      if (!current.legsPlayed && roster.length === 2) {
        const other = roster.find((item) => playerKey(item.name) !== key);
        current.legsPlayed = (Number(row.legsWon) || 0) + (Number(other?.legsWon) || 0);
      }
      if (String(match.winner || '').trim().toLowerCase() === key
        || String(match.winner || '') === row.name) {
        current.wins += 1;
      }
      current.isGuest = current.isGuest && !row.userId;
      if (row.userId) current.isGuest = false;
      if (!current.firstSeenAt || (finishedAt && finishedAt < current.firstSeenAt)) {
        current.firstSeenAt = finishedAt;
      }
      if (!current.lastPlayedAt || (finishedAt && finishedAt > current.lastPlayedAt)) {
        current.lastPlayedAt = finishedAt;
      }

      if (isX01Family(match.variant)) {
        const avg = Number(row.average) || 0;
        const darts = Number(row.dartsThrown) || 0;
        const points = Number(row.pointsScored);
        if (Number.isFinite(points) && points > 0 && darts > 0) {
          current.x01Points += points;
          current.x01Darts += darts;
        } else if (avg > 0 && darts > 0) {
          current.x01AverageSum += avg * darts;
          current.x01AverageWeight += darts;
        } else if (avg > 0) {
          current.x01AverageSum += avg;
          current.x01AverageWeight += 1;
        }
        if (avg > current.x01BestMatchAverage) current.x01BestMatchAverage = avg;
        if (!bestMatchAverage || avg > bestMatchAverage.value) {
          bestMatchAverage = { value: avg, player: current.displayName };
        }
        current.checkoutHits += Number(row.checkoutHits) || 0;
        current.checkoutAttempts += Number(row.checkoutAttempts) || 0;
        const best = Number(row.bestCheckout) || 0;
        if (best > current.bestCheckout) current.bestCheckout = best;
        if (!highestCheckout || best > highestCheckout.value) {
          highestCheckout = { value: best, player: current.displayName };
        }
        const counts = row.counts || {};
        for (const bucket of ['60', '100', '140', '170', '180']) {
          current.counts[bucket] += Number(counts[bucket]) || 0;
        }
        total180s += Number(counts['180']) || 0;
      }
      players.set(key, current);
    }

    if (roster.length >= 2) {
      const names = roster.map((row) => playerKey(row.name)).filter(Boolean).sort();
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          const pairKey = `${names[i]}::${names[j]}`;
          const entry = pairCounts.get(pairKey) || {
            aKey: names[i],
            bKey: names[j],
            aWins: 0,
            bWins: 0,
            matches: 0,
            lastWinner: null,
            lastPlayedAt: null,
          };
          entry.matches += 1;
          const winnerKey = playerKey(match.winner);
          if (winnerKey === names[i]) entry.aWins += 1;
          if (winnerKey === names[j]) entry.bWins += 1;
          if (!entry.lastPlayedAt || (finishedAt && finishedAt > entry.lastPlayedAt)) {
            entry.lastPlayedAt = finishedAt;
            entry.lastWinner = match.winner || null;
          }
          pairCounts.set(pairKey, entry);
        }
      }
    }
  }

  const list = [...players.values()].map((player) => {
    const x01Average = lifetimeAverage(player);
    const winPct = player.matches ? Number(((player.wins / player.matches) * 100).toFixed(1)) : 0;
    const checkoutPct = player.checkoutAttempts
      ? Number(((player.checkoutHits / player.checkoutAttempts) * 100).toFixed(2))
      : 0;
    return {
      name: player.displayName,
      matches: player.matches,
      wins: player.wins,
      losses: Math.max(0, player.matches - player.wins),
      winPct,
      legsWon: player.legsWon,
      legsPlayed: player.legsPlayed,
      x01Average,
      x01BestMatchAverage: player.x01BestMatchAverage,
      checkoutPct,
      bestCheckout: player.bestCheckout,
      counts: { ...player.counts },
      firstSeenAt: player.firstSeenAt,
      lastPlayedAt: player.lastPlayedAt,
      isGuest: player.isGuest,
    };
  });

  list.sort((a, b) => (
    b.wins - a.wins
    || b.winPct - a.winPct
    || b.x01Average - a.x01Average
    || a.name.localeCompare(b.name)
  ));

  let rivalry = null;
  let bestPair = null;
  for (const entry of pairCounts.values()) {
    if (!bestPair || entry.matches > bestPair.matches) bestPair = entry;
  }
  if (bestPair) {
    const a = players.get(bestPair.aKey);
    const b = players.get(bestPair.bKey);
    rivalry = {
      a: a?.displayName || bestPair.aKey,
      b: b?.displayName || bestPair.bKey,
      aWins: bestPair.aWins,
      bWins: bestPair.bWins,
      lastWinner: bestPair.lastWinner,
      lastPlayedAt: bestPair.lastPlayedAt,
      matches: bestPair.matches,
    };
  }

  const now = new Date();
  const months = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase().slice(0, 3);
    months.push({ key, label, count: monthCounts.get(key) || 0 });
  }

  const byVariant = [...variantCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    players: list,
    totals: {
      matches: matches.length,
      legs: totalLegs,
      thisMonth: monthCounts.get(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`) || 0,
      lastPlayedAt: list.reduce((latest, row) => (
        !latest || (row.lastPlayedAt && row.lastPlayedAt > latest) ? row.lastPlayedAt : latest
      ), null),
    },
    months,
    byVariant,
    rivalry,
    records: {
      bestMatchAverage,
      highestCheckout,
      total180s,
    },
  };
}

function createAutodartsAggregates(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const playersPath = path.resolve(
    config.autodartsPlayersPath || path.join(root, 'data', 'autodarts-players.json'),
  );
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      if (fs.existsSync(playersPath)) {
        cache = JSON.parse(fs.readFileSync(playersPath, 'utf8'));
        return cache;
      }
    } catch (error) {
      log?.warn?.('Could not read Autodarts players file', error?.message || error);
    }
    cache = recomputeFromMatches([]);
    return cache;
  }

  function persist(value) {
    try {
      fs.mkdirSync(path.dirname(playersPath), { recursive: true });
      const temporaryPath = `${playersPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, playersPath);
    } catch (error) {
      log?.warn?.('Could not persist Autodarts players', error?.message || error);
    }
  }

  function recompute(matches) {
    cache = recomputeFromMatches(matches);
    persist(cache);
    return cache;
  }

  return {
    playersPath,
    get: load,
    recompute,
    recomputeFromMatches,
    isX01Family,
    playerKey,
  };
}

module.exports = {
  createAutodartsAggregates,
  recomputeFromMatches,
  isX01Family,
  playerKey,
  lifetimeAverage,
};
