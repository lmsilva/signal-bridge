// Gaming family of board frames (03 §C): Steam, PSN, Autodarts, Roll Credits.
//
// Steam and PSN payloads already carry the resolved title. The library caches
// are only consulted for a last-played date or an owned-count footer, never
// for the name. `mode` on the wire is `playing` / `last-played` — there is no
// `now-playing` mode, and `library-tour` is not board-capable.

const {
  COLS,
  blankRow,
  encodeText,
  placeText,
  truncate,
  wrap,
  fold,
  toNumber,
  formatWhole,
  formatAverage,
  formatCount,
} = require('../encoder');

const {
  BODY_FROM,
  BODY_TO,
  chipCode,
  lr,
  badgeFrame,
} = require('../frames');

const { toDate, clockLabel, shortDate, parseYmd } = require('../clock');
const { snapshotFrame, alertFrame, padRows, isPlaceholderTitle } = require('./common');

const BODY_WIDTH = BODY_TO - BODY_FROM + 1;
const PLAYER_NAME_WIDTH = 13;

const SYSTEM_LABELS = new Map(
  require('../../roll-credits-systems.json').map((system) => [system.id, system.label]),
);

function systemLabel(system, explicit) {
  if (explicit) {
    return fold(explicit);
  }
  const id = String(system || '').toLowerCase();
  return fold(SYSTEM_LABELS.get(id) || system || '');
}

function fitName(name, width = PLAYER_NAME_WIDTH) {
  return truncate(name, width);
}

/** Two spaces between a pair — fold() would collapse a padded string. */
function twoSpace(left, right) {
  const start = fold(left);
  const end = fold(right);
  if (!end) {
    return start;
  }
  return lr(start, end, { from: BODY_FROM, to: BODY_FROM + start.length + end.length + 1 });
}

function playingCard({
  title,
  gameName,
  mode,
  launchedAt,
  lastPlayedAt,
  footerLeft,
  source,
  alert,
  timeZone,
}) {
  const name = fold(gameName);
  if (isPlaceholderTitle(name)) {
    return [];
  }

  const playing = mode === 'playing';
  const heading = playing ? 'NOW PLAYING:' : 'LAST PLAYED:';
  const nameLines = wrap(name, BODY_WIDTH);
  const zone = { timeZone };
  const when = playing
    ? (toDate(launchedAt) ? `LAUNCHED ${clockLabel(launchedAt, zone)}` : '')
    : lastPlayedLine(lastPlayedAt, timeZone);
  const content = [heading, ...nameLines];
  if (when) {
    content.push('');
    content.push(when);
  }

  const rows = badgeFrame({
    color: 'blue',
    title,
    rows: padRows(content),
    footerLeft,
  });

  const label = playing ? `${title} playing` : `${title} last played`;
  return [
    alert
      ? alertFrame(rows, label, source)
      : snapshotFrame(rows, label, source),
  ];
}

function lastPlayedLine(value, timeZone) {
  const date = toDate(value);
  if (!date) {
    return '';
  }
  const zone = { timeZone };
  return `${shortDate(date, zone)} - ${clockLabel(date, zone)}`;
}

function steamFrames(payload = {}, ctx = {}) {
  const steam = payload.steam;
  if (!steam || steam.mode === 'library-tour') {
    return [];
  }

  const playing = steam.mode !== 'last-played';
  const owned = toNumber(ctx.ownedCount ?? ctx.librarySize);
  return playingCard({
    title: 'STEAM',
    gameName: steam.name,
    mode: playing ? 'playing' : 'last-played',
    launchedAt: steam.startedAt,
    lastPlayedAt: steam.lastPlayedAt,
    footerLeft: playing
      ? 'GAME ON!'
      : (owned === null ? '' : `${formatCount(owned)} GAMES OWNED`),
    source: 'steam.now-playing',
    alert: playing,
    timeZone: ctx.timeZone,
  });
}

function psnFrames(payload = {}, ctx = {}) {
  const psn = payload.psn;
  if (!psn || psn.mode === 'library-tour') {
    return [];
  }

  const playing = psn.mode !== 'last-played';
  const owned = toNumber(ctx.ownedCount ?? ctx.librarySize);
  const lastAt = toDate(psn.lastPlayedAt);
  return playingCard({
    title: 'PLAYSTATION',
    gameName: psn.name,
    mode: playing ? 'playing' : 'last-played',
    launchedAt: psn.startedAt,
    lastPlayedAt: psn.lastPlayedAt,
    footerLeft: playing
      ? 'GAME ON!'
      : (owned === null ? '' : `${formatCount(owned)} GAMES OWNED`),
    source: 'psn.now-playing',
    alert: playing,
    timeZone: ctx.timeZone,
  }).map((frame) => {
    // PSN last-played often has a date and nothing else worth saying.
    if (!playing && lastAt && !owned) {
      const rebuilt = badgeFrame({
        color: 'blue',
        title: 'PLAYSTATION',
        rows: padRows([
          'LAST PLAYED:',
          ...wrap(fold(psn.name), BODY_WIDTH),
          '',
          `ON ${shortDate(lastAt, { timeZone: ctx.timeZone })}`,
        ]),
      });
      return snapshotFrame(rebuilt, frame.label, frame.source);
    }
    return frame;
  });
}

function parseSettingsLine(line) {
  const text = String(line || '');
  const score = text.match(/\b(\d{3})\b/);
  const legs = text.match(/first to (\d+)/i);
  return {
    score: score ? score[1] : '',
    legs: legs ? legs[1] : '',
  };
}

function winnerRow(name) {
  const folded = fitName(name);
  const text = `${folded} WINS`;
  const row = blankRow(COLS);
  row[BODY_FROM] = chipCode('yellow');
  placeText(row, text, BODY_FROM + 2);
  const end = BODY_FROM + 2 + encodeText(text).length + 1;
  if (end < COLS) {
    row[end] = chipCode('yellow');
  }
  return row;
}

function autodartsMatchFrames(payload = {}) {
  const match = payload.match;
  if (!match) {
    return [];
  }

  const players = (match.players || []).filter((player) => player?.name);
  if (!players.length) {
    return [];
  }

  const finished = match.status === 'finished';
  const settings = parseSettingsLine(match.settingsLine);
  const names = players.map((player) => fitName(player.name));

  if (!finished) {
    const versus = names.length === 1
      ? names[0]
      : `${names[0]} VS ${names[1]}`;
    const rows = badgeFrame({
      color: 'green',
      title: 'AUTODARTS',
      rows: padRows([
        settings.score ? `GAME ON - ${settings.score}` : 'GAME ON',
        versus,
        settings.legs ? `FIRST TO ${settings.legs} LEGS` : fold(match.variant),
      ].filter(Boolean)),
      footerLeft: 'THROW SHARP',
    });
    return [alertFrame(rows, 'Autodarts live', 'autodarts.match')];
  }

  const winner = players.find((player) => player.isWinner) || players[0];
  const opponent = players.find((player) => player !== winner);
  const winnerLegs = toNumber(winner.legs) ?? 0;
  const opponentLegs = toNumber(opponent?.legs) ?? 0;
  const average = toNumber(winner.average);
  const checkout = toNumber(winner.bestCheckout ?? match.gameShot?.checkout);
  const high = toNumber(winner.highScore ?? match.highScore);

  const vsLine = opponent
    ? `VS ${fitName(opponent.name)} - ${formatWhole(winnerLegs)}-${formatWhole(opponentLegs)} LEGS`
    : `${formatWhole(winnerLegs)} LEGS`;

  const statParts = [];
  if (average !== null) {
    statParts.push(`AVG ${formatAverage(average)}`);
  }
  if (high !== null) {
    statParts.push(`HIGH ${formatWhole(high)}`);
  }

  const rows = badgeFrame({
    color: 'green',
    title: 'AUTODARTS',
    rows: padRows([
      winnerRow(winner.name),
      vsLine,
      statParts.length === 2
        ? twoSpace(statParts[0], statParts[1])
        : (statParts[0] || ''),
      checkout === null ? '' : `CHECKOUT ${formatWhole(checkout)}`,
    ]),
    footerLeft: 'NICE DARTS',
  });
  return [alertFrame(rows, 'Autodarts final', 'autodarts.match')];
}

function recordValue(record) {
  if (record == null) {
    return null;
  }
  if (typeof record === 'object') {
    return {
      value: toNumber(record.value),
      player: fold(record.player),
    };
  }
  return { value: toNumber(record), player: '' };
}

function autodartsDashboardFrames(payload = {}) {
  const totals = payload.totals;
  if (!totals) {
    return [];
  }

  const matches = toNumber(totals.matches);
  const legs = toNumber(totals.legs);
  if (matches === null && legs === null) {
    return [];
  }

  const records = payload.records || {};
  const best = recordValue(records.bestMatchAverage);
  const checkout = recordValue(records.highestCheckout);
  const oneEighties = toNumber(records.total180s);
  const rivalry = payload.rivalry;

  const content = [];
  if (matches !== null && legs !== null) {
    content.push(twoSpace(`${formatWhole(matches)} MATCHES`, `${formatWhole(legs)} LEGS`));
  } else if (matches !== null) {
    content.push(`${formatWhole(matches)} MATCHES`);
  }

  if (best?.value !== null && best?.player) {
    content.push(`${fitName(best.player)} AVG ${formatAverage(best.value)}`);
  }

  const recordParts = [];
  if (checkout?.value !== null) {
    recordParts.push(`HIGH OUT ${formatWhole(checkout.value)}`);
  }
  if (oneEighties !== null) {
    recordParts.push(`180S ${formatWhole(oneEighties)}`);
  }
  if (recordParts.length === 2) {
    content.push(twoSpace(recordParts[0], recordParts[1]));
  } else if (recordParts[0]) {
    content.push(recordParts[0]);
  }

  if (rivalry?.a && rivalry?.b) {
    const aWins = formatWhole(rivalry.aWins);
    const bWins = formatWhole(rivalry.bWins);
    content.push(`RIVALRY ${fitName(rivalry.b)} ${aWins}-${bWins}`);
  }

  const last = parseYmd(totals.lastPlayedAt);
  const rows = badgeFrame({
    color: 'green',
    title: 'AUTODARTS',
    rows: padRows(content),
    footerLeft: last ? `LAST GAME ${shortDate(last)}` : '',
  });
  return [snapshotFrame(rows, 'Autodarts', 'autodarts.dashboard')];
}

function latestGame(games) {
  return games.reduce((winner, game) => {
    if (isPlaceholderTitle(game?.title)) {
      return winner;
    }
    if (!winner) {
      return game;
    }
    const gameInduction = toNumber(game.induction) || 0;
    const winnerInduction = toNumber(winner.induction) || 0;
    if (gameInduction !== winnerInduction) {
      return gameInduction > winnerInduction ? game : winner;
    }
    return String(game.beatenAt || '') > String(winner.beatenAt || '') ? game : winner;
  }, null);
}

function topSystem(games) {
  const counts = new Map();
  for (const game of games) {
    const id = String(game.system || 'other').toLowerCase();
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
}

function rollCreditsFrames(payload = {}, ctx = {}) {
  const games = payload.games || payload.rollCredits?.games || ctx.games || [];
  const stats = payload.stats || payload.rollCredits?.stats || {};
  // Push/UDP send `roll-credits.tour`. Compact `games` rows (title / system /
  // beatenAt) travel on the payload so the board does not depend on the
  // overlay's playlist fetch. Totals still prefer `stats` so a scheduled
  // subset cannot print "2 GAMES BEATEN" for a 29-game library.
  const latest = (stats.latest && !isPlaceholderTitle(stats.latest.title) ? stats.latest : null)
    || (games.length ? latestGame(games) : null);
  const total = toNumber(stats.total)
    || toNumber(payload.count)
    || games.length
    || 0;
  if (!latest && total <= 0) {
    return [];
  }

  let topLine = '';
  if (Array.isArray(stats.bySystem) && stats.bySystem[0]) {
    const top = stats.bySystem[0];
    topLine = `${formatCount(top.count)} ON ${systemLabel(top.id, top.label)}`;
  } else if (games.length) {
    const top = topSystem(games);
    if (top) {
      topLine = `${formatCount(top[1])} ON ${systemLabel(top[0])}`;
    }
  }

  const beaten = parseYmd(latest?.beatenAt);
  const platform = latest ? systemLabel(latest.system, latest.systemLabel) : '';
  const lastLine = beaten
    ? truncate(`LAST - ${shortDate(beaten)}${platform ? ` ON ${platform}` : ''}`, BODY_WIDTH)
    : '';

  const rows = badgeFrame({
    color: 'white',
    title: 'ROLL CREDITS',
    rows: padRows([
      `${formatCount(total)} GAMES BEATEN`,
      lastLine,
      ...(latest?.title ? wrap(latest.title, BODY_WIDTH) : []),
    ].filter(Boolean)),
    footerLeft: topLine,
  });
  return [snapshotFrame(rows, 'Roll Credits', 'credits.show')];
}

const FORMATTERS = {
  'steam.now-playing': steamFrames,
  'psn.now-playing': psnFrames,
  'autodarts.match': autodartsMatchFrames,
  'autodarts.dashboard': autodartsDashboardFrames,
  'credits.show': rollCreditsFrames,
  'roll-credits.tour': rollCreditsFrames,
};

function framesFor(payload, ctx = {}) {
  if (!payload?.type && (payload?.games || ctx.games)) {
    return rollCreditsFrames(payload, ctx);
  }
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  FORMATTERS,
  framesFor,
  steamFrames,
  psnFrames,
  autodartsMatchFrames,
  autodartsDashboardFrames,
  rollCreditsFrames,
  parseSettingsLine,
  systemLabel,
  PLAYER_NAME_WIDTH,
};
