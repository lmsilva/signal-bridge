// Feature Presentation (Plex cinema frames).
//
// A red theater curtain around the movie title, rating, and times. NOW PLAYING
// is the full curtain; LAST PLAYED and the empty frame drop the top and bottom
// bars so the board reads as house lights down. Every frame is a snapshot.

const { fold, wrap, formatAverage, CHIPS } = require('../encoder');
const { clockLabel, shortDate, daysBetween, toDate } = require('../clock');
const {
  CINEMA_TEXT_WIDTH,
  cinemaFrame,
  cinemaContentCodes,
} = require('../frames');
const { snapshotFrame } = require('./common');

const EMPTY_HEADER = 'FEATURE PRESENTATION';

function tz(ctx) {
  return ctx?.timeZone ? { timeZone: ctx.timeZone } : {};
}

function dropTrailingParenthetical(folded) {
  const trimmed = String(folded || '').trim();
  const match = /^(.*)\s+\([^)]+\)\s*$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function truncateAtWord(text, width) {
  const folded = fold(text);
  if (folded.length <= width) {
    return folded;
  }
  const words = folded.split(' ').filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length <= width) {
      out = next;
      continue;
    }
    if (!out) {
      return wrap(word, width)[0] || '';
    }
    break;
  }
  return out;
}

function splitTwoLines(folded, width) {
  const words = folded.split(' ').filter(Boolean);
  if (words.length <= 1) {
    return wrap(folded, width).slice(0, 2);
  }

  let best = null;
  for (let i = 1; i < words.length; i += 1) {
    const top = words.slice(0, i).join(' ');
    const bottom = words.slice(i).join(' ');
    const longer = Math.max(top.length, bottom.length);
    if (
      !best
      || longer < best.longer
      || (longer === best.longer && top.length > best.top.length)
    ) {
      best = { top, bottom, longer };
    }
  }

  let { top, bottom } = best;
  if (top.length > width) {
    return wrap(folded, width).slice(0, 2);
  }
  if (bottom.length > width) {
    bottom = truncateAtWord(bottom, width);
  }
  return [top, bottom];
}

function fitCinemaTitle(title, width = CINEMA_TEXT_WIDTH) {
  const original = fold(title);
  if (!original) {
    return { lines: [], layout: 'A' };
  }
  if (original.length <= width) {
    return { lines: [original], layout: 'A' };
  }

  const dropped = dropTrailingParenthetical(original);
  if (dropped.length <= width) {
    return { lines: [dropped], layout: 'A' };
  }

  const lines = splitTwoLines(dropped, width);
  return { lines, layout: 'B' };
}

function showScore(ctx) {
  return ctx?.showCriticScore !== false;
}

function ratingEntry(contentRating, criticScore, ctx, { includeScore = true } = {}) {
  const rating = fold(contentRating);
  const score = includeScore && showScore(ctx) ? formatAverage(criticScore) : '';
  if (!rating && !score) {
    return '';
  }
  if (!score) {
    return rating;
  }
  if (!rating) {
    return score;
  }
  return { parts: [rating, ' ', { chip: 'white' }, ' ', score] };
}

function meridiemOf(value, ctx) {
  const label = clockLabel(value, tz(ctx));
  if (label.endsWith('AM') || label.endsWith('PM')) {
    return label.slice(-2);
  }
  return '';
}

function timeWithoutMeridiem(value, ctx) {
  const label = clockLabel(value, tz(ctx));
  if (label.endsWith('AM') || label.endsWith('PM')) {
    return label.slice(0, -2);
  }
  return label;
}

function rangeTimeLine(start, end, ctx) {
  const from = clockLabel(start, tz(ctx));
  const to = clockLabel(end, tz(ctx));
  if (!from || !to) {
    return '';
  }
  return `${from} TO ${to}`;
}

function compactTimeRange(start, end, ctx) {
  const from = clockLabel(start, tz(ctx));
  const to = clockLabel(end, tz(ctx));
  if (!from || !to) {
    return to || from || '';
  }
  if (meridiemOf(start, ctx) === meridiemOf(end, ctx)) {
    return `${timeWithoutMeridiem(start, ctx)}-${to}`;
  }
  return `${from}-${to}`;
}

function joinRatingAndText(contentRating, text, { dropSpaces = false } = {}) {
  const rating = fold(contentRating);
  const body = fold(text);
  if (!rating && !body) {
    return '';
  }
  if (!rating) {
    return body;
  }
  if (!body) {
    return rating;
  }
  if (dropSpaces) {
    return { parts: [rating, { chip: 'white' }, body] };
  }
  return { parts: [rating, ' ', { chip: 'white' }, ' ', body] };
}

function fitRatingTextRow(contentRating, text) {
  const spaced = joinRatingAndText(contentRating, text);
  if (!spaced || typeof spaced === 'string') {
    return spaced || '';
  }
  if (cinemaContentCodes(spaced).length <= CINEMA_TEXT_WIDTH) {
    return spaced;
  }
  const tight = joinRatingAndText(contentRating, text, { dropSpaces: true });
  if (cinemaContentCodes(tight).length <= CINEMA_TEXT_WIDTH) {
    return tight;
  }
  return fold(text);
}

function endedLine(endedAt, now, ctx) {
  const when = toDate(endedAt);
  if (!when) {
    return '';
  }
  const time = clockLabel(when, tz(ctx));
  if (!time) {
    return '';
  }
  const today = toDate(now) || new Date();
  if (daysBetween(when, today, ctx?.timeZone) === 0) {
    return `ENDED ${time}`;
  }
  return `ENDED ${shortDate(when, tz(ctx))} ${time}`;
}

function emptyFrame(ctx) {
  if (!ctx?.explicit) {
    return [];
  }
  const rows = cinemaFrame({
    border: 'sides',
    rows: [EMPTY_HEADER, '', 'NOTHING SHOWING'],
  });
  return [snapshotFrame(rows, 'Feature Presentation', 'plex.now-playing')];
}

function cinemaFrames(payload, ctx = {}) {
  const plex = payload?.plex || {};
  const mode = plex.mode === 'last-played' ? 'last-played' : 'now-playing';
  const titleFit = fitCinemaTitle(plex.title);

  if (!titleFit.lines.length) {
    return emptyFrame(ctx);
  }

  const playing = mode === 'now-playing';
  const header = playing ? 'NOW PLAYING' : 'LAST PLAYED';
  const rows = [header, ...titleFit.lines];
  const layoutB = titleFit.layout === 'B';

  if (playing) {
    if (layoutB) {
      rows.push(fitRatingTextRow(plex.contentRating, compactTimeRange(plex.startedAt, plex.endsAt, ctx)));
    } else {
      rows.push(ratingEntry(plex.contentRating, plex.criticScore, ctx));
      rows.push(rangeTimeLine(plex.startedAt, plex.endsAt, ctx));
    }
  } else if (layoutB) {
    rows.push(fitRatingTextRow(plex.contentRating, endedLine(plex.endedAt, ctx.now, ctx)));
  } else {
    rows.push(ratingEntry(plex.contentRating, plex.criticScore, ctx));
    rows.push(endedLine(plex.endedAt, ctx.now, ctx));
  }

  const layout = cinemaFrame({
    border: playing ? 'full' : 'sides',
    rows,
  });
  return [snapshotFrame(layout, 'Feature Presentation', 'plex.now-playing', {
    base: ctx.board?.dwellSeconds || 15,
  })];
}

const FORMATTERS = {
  'plex.now-playing': cinemaFrames,
};

function framesFor(payload, ctx = {}) {
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  FORMATTERS,
  framesFor,
  cinemaFrames,
  fitCinemaTitle,
  dropTrailingParenthetical,
  ratingEntry,
  rangeTimeLine,
  compactTimeRange,
  endedLine,
  EMPTY_HEADER,
};
