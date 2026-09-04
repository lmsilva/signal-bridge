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
const { snapshotFrame, padRows, isPlaceholderTitle } = require('./common');

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
    titleAlign: 'center',
    rows: padRows(content),
    footerLeft,
  });

  const label = playing ? `${title} playing` : `${title} last played`;
  return [snapshotFrame(rows, label, source)];
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
    timeZone: ctx.timeZone,
  }).map((frame) => {
    // PSN last-played often has a date and nothing else worth saying.
    if (!playing && lastAt && !owned) {
      const rebuilt = badgeFrame({
        color: 'blue',
        title: 'PLAYSTATION',
        titleAlign: 'center',
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
    return [snapshotFrame(rows, 'Autodarts live', 'autodarts.match')];
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
  return [snapshotFrame(rows, 'Autodarts final', 'autodarts.match')];
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

function isBareYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function autodartsDashboardFrames(payload = {}, ctx = {}) {
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
  // `checkout?.value !== null` is true for a missing record too — optional
  // chaining yields undefined, which then blew up on the deref below.
  if (checkout && checkout.value !== null) {
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

  const lastAt = totals.lastPlayedAt;
  const last = parseYmd(lastAt);
  // That value is a UTC instant, so the day has to be read in the house zone
  // or a late-evening match prints tomorrow's date on the wall. A bare
  // `YYYY-MM-DD` is already a calendar day — `parseYmd` pins it to local
  // midnight, and converting that into a zone would shift it back a day.
  const zone = isBareYmd(lastAt) ? {} : { timeZone: ctx.timeZone };
  const rows = badgeFrame({
    color: 'green',
    title: 'AUTODARTS',
    rows: padRows(content),
    footerLeft: last ? `LAST GAME ${shortDate(last, zone)}` : '',
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

/** A Huupe score keeps its tenth only when a layup put one there. */
function scoreText(value) {
  const number = toNumber(value);
  if (number === null) {
    return '';
  }
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function shootingRow(stats) {
  const made = toNumber(stats?.made);
  const attempts = toNumber(stats?.attempts);
  if (made === null || attempts === null || attempts <= 0) {
    return '';
  }
  return `FG ${formatWhole(made)}/${formatWhole(attempts)} - ${formatWhole(stats.fgPct)}%`;
}

/**
 * `LAST SHOT 3PT MADE` — the running totals say how the session is going, but
 * not what just happened, and a shooter walking back to the line wants to see
 * the shot they took. `LAST SHOT LAYUP MADE` is the longest form at exactly
 * the twenty columns a body row has.
 */
function lastShotRow(session = {}) {
  const shot = session.lastShot;
  const worth = fold(shot?.worthLabel || '');
  if (!worth) {
    return '';
  }
  return `LAST SHOT ${worth} ${shot.made ? 'MADE' : 'MISS'}`;
}

/** "ON A 2 RUN" read as scoreboard code; say what the number counts. */
function streakRow(count) {
  const run = toNumber(count);
  return run > 1 ? `${formatWhole(run)} MAKES IN A ROW` : '';
}

/**
 * Board-width mode names.
 *
 * The header shares 22 columns with the colour chips and the HUUPE badge, and
 * anything too long is clipped from the left — so "Family Mode" cost us the
 * "E" in HUUPE. These are the same names, short enough to keep the brand.
 */
const HUUPE_BOARD_MODES = {
  family: 'FAMILY',
  justhuupe: 'FREE PLAY',
  dailyprize: 'DAILY',
  fitness: 'FITNESS',
  live: 'LIVE',
};

/** "HUUPE" plus a two-space gap leaves exactly this much of the header. */
const HUUPE_MODE_WIDTH = 9;

function huupeModeText(session = {}) {
  const known = HUUPE_BOARD_MODES[session.mode];
  if (known) return known;
  const label = fold(session.modeLabel || '');
  if (label.length <= HUUPE_MODE_WIDTH) return label;
  const firstWord = label.split(' ')[0];
  return truncate(firstWord, HUUPE_MODE_WIDTH);
}

function huupeSessionFrames(payload = {}) {
  const session = payload.session;
  if (!session) {
    return [];
  }

  const stats = session.stats || {};
  const attempts = toNumber(stats.attempts) || 0;
  // A board flip costs 6 seconds of flapping — two stray shots is not a game.
  if (attempts < 2) {
    return [];
  }

  const finished = session.status === 'finished';
  const players = (session.players || []).filter((player) => player?.name);
  const mode = huupeModeText(session);

  if (!finished) {
    // Four body rows either way: a scoreboard keeps one for the last shot, and
    // free play spends the fourth on the make streak when there is one.
    const rows = players.length
      ? [
        ...players.slice(0, 3).map((player) => lr(fitName(player.name), scoreText(player.score))),
        lastShotRow(session),
      ].filter(Boolean)
      : [
        `${scoreText(stats.points)} POINTS`,
        shootingRow(stats),
        lastShotRow(session),
        streakRow(stats.streak),
      ].filter(Boolean);

    return [snapshotFrame(
      badgeFrame({
        color: 'orange',
        title: 'HUUPE',
        titleRight: mode,
        rows: padRows(rows),
        footerLeft: 'SHOOTING NOW',
      }),
      'Huupe live',
      'huupe.session',
    )];
  }

  const winner = players.find((player) => player.isWinner) || players[0];
  const runnerUp = players.find((player) => player !== winner);

  const rows = [];
  if (winner) {
    rows.push(winnerRow(winner.name));
    rows.push(runnerUp
      ? `OVER ${fitName(runnerUp.name)} ${scoreText(winner.score)}-${scoreText(runnerUp.score)}`
      : `${scoreText(winner.score)} POINTS`);
    rows.push(shootingRow(winner));
  } else {
    rows.push(`${scoreText(stats.points)} POINTS`);
    rows.push(shootingRow(stats));
    rows.push(toNumber(stats.bestStreak) > 1
      ? `BEST RUN ${formatWhole(stats.bestStreak)} MAKES`
      : '');
  }
  const threes = toNumber(winner?.threes ?? stats.threes);
  rows.push(threes ? `${formatWhole(threes)} FROM DEEP` : '');

  return [snapshotFrame(
    badgeFrame({
      color: 'orange',
      title: 'HUUPE',
      titleRight: mode,
      rows: padRows(rows.filter((row) => row !== '')),
      footerLeft: 'GAME OVER',
      footerRight: fold(session.durationLabel || ''),
    }),
    'Huupe final',
    'huupe.session',
  )];
}

function huupeDashboardFrames(payload = {}, ctx = {}) {
  const totals = payload.totals;
  if (!totals) {
    return [];
  }
  const sessions = toNumber(totals.sessions);
  const shots = toNumber(totals.shots);
  if (!sessions) {
    return [];
  }

  const content = [];
  // "SESSIONS" plus a four-digit shot count runs off the end of the board, and
  // not every session is a game, so "PLAYS" is both shorter and more accurate.
  content.push(twoSpace(
    `${formatCount(sessions)} PLAYS`,
    shots ? `${formatCount(shots)} SHOTS` : '',
  ));

  const leader = (payload.leaderboard || [])[0];
  if (leader?.name) {
    content.push(lr(fitName(leader.name), `${formatWhole(leader.wins)} WINS`));
  }

  const fgPct = toNumber(totals.fgPct);
  const streak = payload.records?.bestStreak;
  const statParts = [];
  if (fgPct !== null) {
    statParts.push(`FG ${formatWhole(fgPct)}%`);
  }
  if (toNumber(streak?.value)) {
    statParts.push(`RUN ${formatWhole(streak.value)}`);
  }
  if (statParts.length === 2) {
    content.push(twoSpace(statParts[0], statParts[1]));
  } else if (statParts[0]) {
    content.push(statParts[0]);
  }

  const best = payload.records?.bestSessionScore;
  if (toNumber(best?.value)) {
    content.push(`BEST GAME ${scoreText(best.value)}`);
  }

  const lastAt = totals.lastPlayedAt;
  const last = parseYmd(lastAt);
  const zone = isBareYmd(lastAt) ? {} : { timeZone: ctx.timeZone };
  return [snapshotFrame(
    badgeFrame({
      color: 'orange',
      title: 'HUUPE',
      rows: padRows(content.filter(Boolean)),
      footerLeft: last ? `LAST GAME ${shortDate(last, zone)}` : '',
    }),
    'Huupe',
    'huupe.dashboard',
  )];
}

const FORMATTERS = {
  'steam.now-playing': steamFrames,
  'psn.now-playing': psnFrames,
  'autodarts.match': autodartsMatchFrames,
  'autodarts.dashboard': autodartsDashboardFrames,
  'huupe.session': huupeSessionFrames,
  'huupe.dashboard': huupeDashboardFrames,
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
  huupeSessionFrames,
  huupeDashboardFrames,
  rollCreditsFrames,
  scoreText,
  parseSettingsLine,
  systemLabel,
  PLAYER_NAME_WIDTH,
};
