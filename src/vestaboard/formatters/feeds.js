// Feeds family of board frames (03 §D): YouTube, The Upside, Wiki, Overhead,
// trivia, Flight Plan, Learn Japanese and the European Learn {Language}
// boards, Quiet Hours Reminder, Chuck Norris,
// Amazing Facts, Conversation Starters, Stoic Quotes, On This Day, Baking
// Inspiration, Word Riddles, World Population Tracker, and Calendar Clock.
//
// Trivia is the only formatter that refuses work. A question that cannot fit
// a single frame is skipped rather than paged, because a multi-frame question
// is unreadable from across a room. The measured gate is in 02 §6.

const {
  ROWS,
  COLS,
  BLANK,
  CHIPS,
  blankRow,
  encodeText,
  placeText,
  truncate,
  wrap,
  fold,
  assertValidLayout,
  toNumber,
  formatWhole,
  formatCount,
} = require('../encoder');

const {
  BADGE_TEXT_WIDTH,
  BODY_FROM,
  BODY_TO,
  MAX_BODY_ROWS,
  chipCode,
  pageCounter,
  badgeFrame,
  centered,
} = require('../frames');

const {
  introRows,
  riddleRows,
  answerRows,
  INTRO_DWELL_SECONDS,
  ANSWER_DWELL_SECONDS,
} = require('../../word-riddles');
const { clampRevealDelay } = require('../../word-riddles-settings');

const {
  formatTrackerClock,
  formatTrackerFlightNumber,
  resolveFlightStatus,
  bestDepartureStamp,
  bestArrivalStamp,
} = require('../../flightplan-status');

const { snapshotFrame, paginate, padRows } = require('./common');
const { posLabel } = require('../../learn-japanese');
const { languageOf, posLabel: europeanPosLabel } = require('../../learn-language');
const { layoutFor } = require('../../quiet-hours-reminder');
const { formatPopulation, formatRate } = require('../../world-population');
const { calendarClockRows } = require('../../calendar-clock');
const { wordClockRows } = require('../../word-clock');
const { quoteLines } = require('../../family-quotes-layout');
const { jokeLines } = require('../../dad-jokes-layout');
const { redLetterRows } = require('../../red-letter');
const { dateParts, daysBetween, houseTimeZone } = require('../clock');

const BODY_WIDTH = BODY_TO - BODY_FROM + 1;
// Spec text says 22; the drawing wraps at the 20-column body so a 22-letter
// line does not steal the last word of the next thought.
const UPSIDE_WRAP = BODY_WIDTH;
const TRIVIA_QUESTION_WIDTH = 20;
const TRIVIA_TWO_COL_ANSWER = 8;
const TRIVIA_STACKED_ANSWER = 18;
const TRIVIA_RIGHT_COL = 12;
const LETTERS = ['A', 'B', 'C', 'D'];

function youtubeStatsLine(video = {}) {
  const parts = [];
  const views = toNumber(video.viewCount);
  if (views !== null) {
    parts.push(`${formatCount(views)} VIEWS`);
  }
  const likes = toNumber(video.likeCount);
  if (likes !== null) {
    parts.push(`${formatCount(likes)}+`);
  }
  const dislikes = toNumber(video.dislikeCount);
  if (dislikes !== null) {
    parts.push(`${formatCount(dislikes)}-`);
  }
  return parts.join(' ');
}

function youtubeFrames(payload = {}, ctx = {}) {
  const video = payload.youtube;
  if (!video || video.mode === 'library-tour') {
    return [];
  }

  const title = fold(video.title);
  if (!title || title === 'YOUTUBE') {
    return [];
  }

  const titleLines = wrap(title, BODY_WIDTH);
  const channel = fold(video.channelTitle);
  const stats = youtubeStatsLine(video);
  const status = ctx.deviceStatus;
  const device = (!status || status === 'linked')
    ? truncate(video.deviceLabel || '', BADGE_TEXT_WIDTH)
    : '';

  const first = titleLines.slice(0, 2);
  const rest = titleLines.slice(2);
  const frames = [];

  frames.push(snapshotFrame(badgeFrame({
    color: 'red',
    title: 'YOUTUBE',
    rows: padRows([...first, channel, stats].filter(Boolean)),
    footerLeft: device,
  }), 'YouTube', 'youtube.now-playing'));

  if (rest.length) {
    frames.push(snapshotFrame(badgeFrame({
      color: 'red',
      title: 'YOUTUBE',
      rows: padRows(rest),
      footerLeft: device,
    }), 'YouTube', 'youtube.now-playing'));
  }

  return frames;
}

function upsideIntro(count) {
  return snapshotFrame(badgeFrame({
    color: 'yellow',
    title: 'THE UPSIDE',
    rows: padRows(['', { left: 'GOOD NEWS ONLY', indent: 2 }, { left: `${formatWhole(count)} STORIES TODAY`, indent: 2 }]),
  }), 'The Upside', 'upside-news.round');
}

function wrapFlush(text, width) {
  return wrap(text, width).map((line) => ({ left: line, indent: 0 }));
}

function upsideFrames(payload = {}) {
  const news = payload.upsideNews || payload;
  const stories = (news.stories || []).filter((story) => fold(story?.headline));
  if (!stories.length) {
    return [];
  }

  const total = stories.length;
  const frames = [upsideIntro(total)];

  stories.forEach((story, index) => {
    const lines = wrapFlush(story.headline, UPSIDE_WRAP).slice(0, 8);
    const pages = paginate(lines, MAX_BODY_ROWS);
    pages.forEach((page) => {
      frames.push(snapshotFrame(badgeFrame({
        color: 'yellow',
        title: 'THE UPSIDE',
        titleRight: pageCounter(index + 1, total),
        rows: padRows(page),
      }), 'The Upside', 'upside-news.round'));
    });
  });

  return frames;
}

function wikiIntro() {
  return snapshotFrame(badgeFrame({
    color: 'white',
    title: 'WIKIPEDIA',
    rows: padRows(['', { left: 'COMMON KNOWLEDGE', indent: 2 }, { left: 'TOP READS TODAY', indent: 2 }]),
  }), 'Wikipedia', 'wiki-common-knowledge.round');
}

function wikiFrames(payload = {}) {
  const wiki = payload.wikiCommonKnowledge || payload;
  const stories = (wiki.stories || wiki.articles || []).filter((story) => fold(story?.title));
  if (!stories.length) {
    return [];
  }

  const total = stories.length;
  const frames = [wikiIntro()];

  stories.forEach((story, index) => {
    const titleLines = wrap(story.title, BODY_WIDTH);
    const teaser = fold(story.description) || fold(story.extract);
    const teaserLines = teaser ? wrap(teaser, BODY_WIDTH) : [];
    const footerLine = teaserLines.length && teaserLines[teaserLines.length - 1].length <= BADGE_TEXT_WIDTH
      ? teaserLines.pop()
      : '';
    const body = [...titleLines];
    if (teaserLines.length && body.length + teaserLines.length < MAX_BODY_ROWS) {
      body.push('');
    }
    body.push(...teaserLines);

    frames.push(snapshotFrame(badgeFrame({
      color: 'white',
      title: 'WIKI READS',
      titleRight: pageCounter(index + 1, total),
      rows: padRows(body),
      footerLeft: footerLine,
    }), 'Wikipedia', 'wiki-common-knowledge.round'));
  });

  return frames;
}

function routePair(route) {
  if (!route) {
    return '';
  }
  if (typeof route === 'string') {
    return fold(route).replace(/->/g, '-');
  }
  const origin = fold(route.originIata || route.originCity);
  const dest = fold(route.destIata || route.destCity);
  if (origin && dest) {
    return `${origin}-${dest}`;
  }
  return fold(route.label).replace(/->/g, '-');
}

function flightRows(aircraft, route) {
  const code = truncate(aircraft.callsign || aircraft.label || '', 6);
  const pair = routePair(route);
  const top = blankRow(COLS);
  placeText(top, code, BODY_FROM);
  if (pair) {
    placeText(top, pair, BODY_FROM + 8);
  }

  const detail = blankRow(COLS);
  let column = BODY_FROM + 1;
  const alt = toNumber(aircraft.altFt);
  if (alt !== null && alt > 0) {
    const text = `${formatWhole(alt)}FT`;
    placeText(detail, text, column);
    column += text.length + 2;
  }
  const distance = toNumber(aircraft.dstNm);
  if (distance !== null) {
    const text = `${formatWhole(distance)}MI`;
    placeText(detail, text, column);
    column += text.length + 1;
  }
  const bearing = fold(aircraft.bearingLabel);
  if (bearing) {
    placeText(detail, bearing, column);
  }

  return [top, detail];
}

function overheadFrames(payload = {}) {
  const overhead = payload.overhead || payload;
  const aircraft = overhead.aircraft || [];
  const routes = overhead.routes || {};

  if (!aircraft.length) {
    return [snapshotFrame(badgeFrame({
      color: 'blue',
      title: 'OVERHEAD',
      rows: padRows(['', { left: 'CLEAR SKIES', indent: 2 }]),
    }), 'Overhead', 'overhead.round')];
  }

  const pages = paginate(aircraft, 2);
  return pages.map((page) => {
    const content = page.flatMap((plane) => flightRows(plane, routes[plane.hex]));
    return snapshotFrame(badgeFrame({
      color: 'blue',
      title: 'OVERHEAD',
      rows: padRows(content),
      footerLeft: `${formatWhole(aircraft.length)} OVERHEAD NOW`,
    }), 'Overhead', 'overhead.round');
  });
}

/**
 * Which trivia layout a question can use, or `null` if it cannot fit a frame.
 *
 * Two-column needs a short question and four short answers. Stacked is the
 * rare long-answer case. Boolean is its own shape. Everything else is skipped
 * — paging a question is worse than drawing the next one.
 */
function triviaGate(question = {}) {
  const text = fold(question.text);
  if (!text) {
    return null;
  }
  const lines = wrap(text, TRIVIA_QUESTION_WIDTH);
  const answers = (question.answers || []).map((answer) => fold(answer)).filter(Boolean);
  const type = String(question.type || '').toLowerCase();

  if (type === 'boolean') {
    return lines.length <= 3 ? 'boolean' : null;
  }
  if (
    lines.length <= 2
    && answers.length === 4
    && answers.every((answer) => answer.length <= TRIVIA_TWO_COL_ANSWER)
  ) {
    return 'two-column';
  }
  if (lines.length <= 1 && answers.every((answer) => answer.length <= TRIVIA_STACKED_ANSWER)) {
    return 'stacked';
  }
  return null;
}

function answerPair(left, right) {
  const row = blankRow(COLS);
  if (left) {
    placeText(row, left, BODY_FROM);
  }
  if (right) {
    placeText(row, right, TRIVIA_RIGHT_COL);
  }
  return row;
}

function twoColumnAnswers(answers, { reveal, correctIndex } = {}) {
  const cell = (index) => {
    const letter = LETTERS[index];
    const text = answers[index] || '';
    if (!reveal) {
      return text ? `${letter} ${text}` : '';
    }
    if (index === correctIndex) {
      return `${letter} ${text}`;
    }
    return letter;
  };

  const rows = [
    answerPair(cell(0), cell(1)),
    answerPair(cell(2), cell(3)),
  ];

  if (!reveal) {
    return rows;
  }

  // Green chip before the correct letter; wrong answers become red chips
  // whose length matches the word they replaced.
  const paint = (row, index, column) => {
    const text = answers[index] || '';
    if (index === correctIndex) {
      const limit = index % 2 === 0 ? TRIVIA_RIGHT_COL : COLS;
      for (let i = column; i < limit; i += 1) {
        row[i] = BLANK;
      }
      if (column > 0) {
        row[column - 1] = chipCode('green');
      }
      placeText(row, `${LETTERS[index]} ${answers[index] || ''}`, column + 1);
      return;
    }
    const start = column + 2;
    for (let i = 0; i < text.length && start + i < COLS; i += 1) {
      row[start + i] = CHIPS.red;
    }
  };

  paint(rows[0], 0, BODY_FROM);
  paint(rows[0], 1, TRIVIA_RIGHT_COL);
  paint(rows[1], 2, BODY_FROM);
  paint(rows[1], 3, TRIVIA_RIGHT_COL);
  return rows;
}

function stackedAnswers(answers) {
  return answers.slice(0, 3).map((answer, index) => `${LETTERS[index]} ${answer}`);
}

function booleanAnswers(answers, { reveal, correctIndex } = {}) {
  const labels = (answers.length ? answers : ['TRUE', 'FALSE']).map((answer) => fold(answer));
  if (!reveal) {
    return [answerPair(`A ${labels[0] || 'TRUE'}`, `B ${labels[1] || 'FALSE'}`)];
  }
  const rows = twoColumnAnswers(
    [labels[0] || 'TRUE', labels[1] || 'FALSE', '', ''],
    { reveal: true, correctIndex },
  );
  return [rows[0]];
}

function triviaCategory(question) {
  return truncate(question.categoryLabel || question.categoryId || '', 7);
}

function triviaQuestionRows(question, gate, { reveal } = {}) {
  const lines = wrap(question.text, TRIVIA_QUESTION_WIDTH);
  const answers = (question.answers || []).map((answer) => fold(answer));
  const correctIndex = Number.isInteger(question.correctIndex) ? question.correctIndex : -1;
  const options = { reveal, correctIndex };

  if (gate === 'boolean') {
    return padRows([...lines.slice(0, 3), ...booleanAnswers(answers, options)]);
  }
  if (gate === 'stacked') {
    return padRows([...lines.slice(0, 1), ...stackedAnswers(answers)]);
  }
  return padRows([...lines.slice(0, 2), ...twoColumnAnswers(answers, options)]);
}

function triviaFrames(payload = {}, ctx = {}) {
  const trivia = payload.trivia || {};
  const questions = trivia.questions || [];
  const hold = toNumber(trivia.questionSeconds) ?? toNumber(ctx.questionSeconds) ?? 30;
  const revealFor = toNumber(trivia.answerSeconds) ?? toNumber(ctx.answerSeconds) ?? 7;
  const frames = [];

  for (const question of questions) {
    const gate = triviaGate(question);
    if (!gate) {
      continue;
    }

    const category = triviaCategory(question);
    frames.push({
      ...snapshotFrame(badgeFrame({
        color: 'yellow',
        title: 'TRIVIA',
        titleRight: category,
        rows: triviaQuestionRows(question, gate),
        footerLeft: `ANSWER IN ${formatWhole(hold)}S`,
      }), 'Trivia', 'trivia.round'),
      dwellSeconds: hold,
    });

    const correct = fold((question.answers || [])[question.correctIndex]);
    const letter = LETTERS[question.correctIndex] || '';
    frames.push({
      ...snapshotFrame(badgeFrame({
        color: 'yellow',
        title: 'TRIVIA',
        titleRight: category,
        rows: triviaQuestionRows(question, gate, { reveal: true }),
        footerLeft: letter && correct ? `${letter} - ${correct}!` : 'THE ANSWER',
      }), 'Trivia answer', 'trivia.round'),
      dwellSeconds: revealFor,
    });
  }

  return frames;
}

const MAX_TRACKER_FRAMES = 4;

function flightPlanIata(place) {
  const code = fold(place?.iata || place?.icao || '');
  if (code.length >= 3) return code.slice(0, 3);
  return (code || '---').slice(0, 3).padEnd(3, '-');
}

function flightPlanBadgeRight(flight = {}, payload = {}, ctx = {}, page = 1, total = 1) {
  let when = 'BOARD';
  if (payload.mode === 'auto') when = 'UPDATE';
  else if (flight.state === 'active') when = 'NOW';
  else {
    const stamp = flight.scheduled?.departure || flight.date;
    if (stamp) {
      const zone = ctx.timeZone || houseTimeZone(ctx.config);
      const days = daysBetween(ctx.now || new Date(), stamp, zone);
      if (days === 0) when = 'TODAY';
      else if (days < 0) when = 'NOW';
      else when = `D-${Math.min(999, days)}`;
    }
  }
  const count = pageCounter(page, total);
  if (!count) return when;
  const combined = `${when} ${count}`;
  return combined.length <= BODY_WIDTH ? combined : when;
}

function flightPlanTripTitle(payload = {}) {
  let name = fold(payload.trip?.name || '');
  if (!name) {
    return payload.mode === 'board' ? 'TRIP BOARD' : 'NEXT FLIGHT';
  }
  if (name.length > BADGE_TEXT_WIDTH) {
    name = name.replace(/\b(TRIP|VACATION|VISIT|HOLIDAY)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim() || name;
  }
  return truncate(name, BADGE_TEXT_WIDTH);
}

function flightPlanAsOfLabel(payload = {}, ctx = {}) {
  const zone = ctx.timeZone || houseTimeZone(ctx.config);
  const parts = dateParts(payload.asOf || new Date(), zone);
  if (!parts) return '';
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function flightPlanStatusRow(headline, gate) {
  if (headline && gate && headline.length + 1 + gate.length <= BODY_WIDTH) {
    return { left: headline, right: gate };
  }
  return headline;
}

function flightPlanTrackerRows(flight = {}, payload = {}, ctx = {}, page = 1, total = 1) {
  const status = resolveFlightStatus(flight, ctx);
  const origin = flightPlanIata(flight.origin);
  const dest = flightPlanIata(flight.destination);
  const dep = formatTrackerClock(bestDepartureStamp(flight));
  const arr = formatTrackerClock(bestArrivalStamp(flight));
  const headline = fold(status.headline || 'ON TIME').slice(0, BODY_WIDTH);
  const gate = fold(status.gateLine || '').slice(0, BODY_WIDTH);
  const number = formatTrackerFlightNumber(flight.airline, flight.number) || 'FLIGHT';
  return {
    status,
    rows: padRows([
      { left: number, right: flightPlanBadgeRight(flight, payload, ctx, page, total) },
      { left: `${origin} -`, right: dest },
      { left: dep, right: arr },
      flightPlanStatusRow(headline, gate),
    ]),
  };
}

function flightPlanTrackerCards(payload = {}) {
  const flights = Array.isArray(payload.flights) ? [...payload.flights] : [];
  if (!flights.length && payload.flight) flights.push(payload.flight);
  if (payload.mode === 'board') {
    return flights.slice(0, MAX_TRACKER_FRAMES).map((row) => (
      payload.flight && payload.flight.id && payload.flight.id === row.id
        ? { ...row, ...payload.flight }
        : row
    ));
  }
  return [payload.flight || flights[0]].filter(Boolean);
}

function flightPlanBoardFrames(payload = {}, ctx = {}) {
  const cards = flightPlanTrackerCards(payload);
  if (!cards.length) return [];

  const total = cards.length;
  return cards.map((flight, index) => {
    const { status, rows } = flightPlanTrackerRows(
      flight, payload, ctx, index + 1, total,
    );
    const layout = badgeFrame({
      color: payload.alert ? 'red' : (status.chip || 'blue'),
      title: flightPlanTripTitle(payload),
      rows,
      footerLeft: 'AS OF',
      footerRight: flightPlanAsOfLabel(payload, ctx),
    });
    return {
      ...snapshotFrame(layout, 'Flight Plan', 'flightplan.flight'),
      quietHoursExempt: false,
    };
  });
}

function languageChipRow(text, chips = {}, options = {}) {
  const row = blankRow(COLS);
  const left = chips.left || 'white';
  const right = chips.right || 'red';
  row[0] = chipCode(left);
  row[1] = chipCode(left);
  row[COLS - 2] = chipCode(right);
  row[COLS - 1] = chipCode(right);
  if (text) {
    centered(fold(text), { from: 2, width: 18, row, lean: options.lean });
  }
  return row;
}

function flagChipRow(text, options = {}) {
  return languageChipRow(text, { left: 'white', right: 'red' }, options);
}

/** Left-leaning centre — odd leftover blank goes on the right. */
function jpCenter(text, options = {}) {
  return centered(text, { from: 0, width: COLS, lean: 'left', ...options });
}

/**
 * Prefer a `WORD: ` / `MEANS: ` label when the whole line still fits;
 * otherwise fall back to the bare value so long romaji/glosses are not cut.
 */
function jpLabeled(prefix, value) {
  const labeled = `${prefix}${value}`;
  const useLabel = encodeText(labeled).length <= COLS;
  return jpCenter(useLabel ? labeled : value);
}

/**
 * Learn Japanese (marketplace Learn Spanish shape, hinomaru colours):
 * white|red title chips, labeled romaji + gloss when they fit, POS in
 * parentheses, JLPT level footer. Lines lean left on an odd remainder.
 */
function learnJapaneseFrames(payload = {}) {
  const word = payload.word || {};
  const romaji = fold(word.romaji || '');
  const english = fold(word.english || '');
  if (!romaji || !english) {
    return [];
  }

  const meaning = wrap(english, COLS).slice(0, 2);
  const kind = fold(posLabel(word.pos) || word.pos || '');
  const posText = kind ? `(${kind})` : '';
  const title = flagChipRow('LEARN JAPANESE', { lean: 'left' });
  const level = fold(word.level || '');
  const difficulty = level
    ? (fold(`LEVEL: ${level}`).length <= 18 ? `LEVEL: ${level}` : level)
    : '';
  const footer = flagChipRow(difficulty, { lean: 'left' });
  const hero = jpLabeled('WORD: ', romaji);
  const posRow = jpCenter(posText);

  const rows = meaning.length > 1
    ? [
      title,
      hero,
      posRow,
      jpCenter(meaning[0]),
      jpCenter(meaning[1]),
      footer,
    ]
    : [
      title,
      blankRow(COLS),
      hero,
      posRow,
      jpLabeled('MEANS: ', meaning[0] || ''),
      footer,
    ];

  return [snapshotFrame(
    assertValidLayout(rows, 'learn japanese'),
    'Learn Japanese',
    'japanese.learn',
  )];
}

/**
 * Learn Portuguese / Spanish / French / German / Italian — same card as
 * Japanese (WORD / MEANS / POS / LEVEL) with each language's flag chips.
 */
function learnLanguageFrames(payload = {}) {
  const spec = languageOf(payload.language || payload.type);
  const word = payload.word || {};
  const native = fold(word.word || '');
  const english = fold(word.english || '');
  if (!native || !english) {
    return [];
  }

  const meaning = wrap(english, COLS).slice(0, 2);
  const kind = fold(europeanPosLabel(word.pos) || word.pos || '');
  const posText = kind ? `(${kind})` : '';
  const titleText = fold(payload.title || spec?.title || 'LEARN');
  const title = languageChipRow(titleText, payload.chips || spec?.chips || {}, { lean: 'left' });
  const level = fold(word.level || '');
  const difficulty = level
    ? (fold(`LEVEL: ${level}`).length <= 18 ? `LEVEL: ${level}` : level)
    : '';
  const footer = languageChipRow(difficulty, payload.chips || spec?.chips || {}, { lean: 'left' });
  const hero = jpLabeled('WORD: ', native);
  const posRow = jpCenter(posText);
  const source = spec?.commandId || payload.type || 'language.learn';

  const rows = meaning.length > 1
    ? [
      title,
      hero,
      posRow,
      jpCenter(meaning[0]),
      jpCenter(meaning[1]),
      footer,
    ]
    : [
      title,
      blankRow(COLS),
      hero,
      posRow,
      jpLabeled('MEANS: ', meaning[0] || ''),
      footer,
    ];

  return [snapshotFrame(
    assertValidLayout(rows, spec?.title || 'learn language'),
    spec?.title || 'Learn',
    source,
  )];
}

/**
 * Quiet Hours Reminder (marketplace night cards): moon / SHHH / stars, plus
 * a few house extras. The variant is chosen before we get here.
 */
function quietHoursReminderFrames(payload = {}) {
  const rows = layoutFor(payload);
  if (!rows?.length) {
    return [];
  }
  return [snapshotFrame(
    assertValidLayout(rows, 'quiet hours reminder'),
    'Quiet hours',
    'quiet-hours.reminder',
  )];
}

function norrisChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('orange');
  row[1] = chipCode('orange');
  row[COLS - 2] = chipCode('orange');
  row[COLS - 1] = chipCode('orange');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Chuck Norris Fun Facts (marketplace night-card): orange title chips,
 * left-aligned joke, one frame when it fits, a second page if a custom
 * fact runs long.
 */
/**
 * Word Riddles (marketplace Entertainment): green/blue intro, airy
 * left-aligned riddle with a VESTABOARD footer, then a letter-spaced answer.
 */
function wordRiddlesFrames(payload = {}) {
  const riddle = payload.riddle?.riddle || payload.riddleText || '';
  const answer = payload.riddle?.answer || payload.answer || '';
  const riddleLayout = riddleRows(riddle);
  const answerLayout = answerRows(answer);
  if (!riddleLayout.length || !answerLayout.length) {
    return [];
  }
  const frames = [];
  if (payload.showIntro !== false) {
    const intro = snapshotFrame(
      assertValidLayout(introRows(), 'word riddles intro'),
      'Word Riddles',
      'word.riddles',
      { base: INTRO_DWELL_SECONDS },
    );
    intro.dwellSeconds = INTRO_DWELL_SECONDS;
    frames.push(intro);
  }
  const riddleFrame = snapshotFrame(
    assertValidLayout(riddleLayout, 'word riddle'),
    'Word Riddle',
    'word.riddles',
    { base: 15 },
  );
  riddleFrame.dwellSeconds = clampRevealDelay(payload.revealDelaySeconds);
  frames.push(riddleFrame);
  const answerFrame = snapshotFrame(
    assertValidLayout(answerLayout, 'word riddle answer'),
    'Word Riddle answer',
    'word.riddles',
    { base: ANSWER_DWELL_SECONDS },
  );
  answerFrame.dwellSeconds = ANSWER_DWELL_SECONDS;
  frames.push(answerFrame);
  return frames;
}

function chuckNorrisFrames(payload = {}) {
  const text = fold(payload.fact?.text || payload.text || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS);
  if (!lines.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < lines.length; index += 5) {
    const chunk = lines.slice(index, index + 5);
    const body = [0, 1, 2, 3, 4].map((rowIndex) => {
      const row = blankRow(COLS);
      if (chunk[rowIndex]) {
        placeText(row, chunk[rowIndex], 0);
      }
      return row;
    });
    frames.push(snapshotFrame(
      assertValidLayout([norrisChipRow('CHUCK NORRIS'), ...body], 'chuck norris'),
      'Chuck Norris',
      'chuck.facts',
    ));
  }
  return frames;
}

function amazingChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('yellow');
  row[1] = chipCode('yellow');
  row[COLS - 2] = chipCode('yellow');
  row[COLS - 1] = chipCode('yellow');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Amazing Facts (marketplace education / Mental Floss vibe): yellow
 * AMAZING FACT chips, left-aligned quirk. Short facts are vertically centred
 * in the five body rows (same idea as Conversation Starters). Pages if a
 * custom fact runs long.
 */
function amazingFactsFrames(payload = {}) {
  const text = fold(payload.fact?.text || payload.text || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS);
  if (!lines.length) {
    return [];
  }
  const BODY_SLOTS = 5;
  const frames = [];
  for (let index = 0; index < lines.length; index += BODY_SLOTS) {
    const chunk = lines.slice(index, index + BODY_SLOTS);
    const padTop = Math.floor((BODY_SLOTS - chunk.length) / 2);
    const body = [];
    for (let rowIndex = 0; rowIndex < BODY_SLOTS; rowIndex += 1) {
      const row = blankRow(COLS);
      const line = chunk[rowIndex - padTop];
      if (line) {
        placeText(row, line, 0);
      }
      body.push(row);
    }
    frames.push(snapshotFrame(
      assertValidLayout([amazingChipRow('AMAZING FACT'), ...body], 'amazing facts'),
      'Amazing Facts',
      'amazing.facts',
    ));
  }
  return frames;
}

function geographyChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('green');
  row[1] = chipCode('green');
  row[COLS - 2] = chipCode('green');
  row[COLS - 1] = chipCode('green');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * World Geography Facts (marketplace education): green WORLD GEOGRAPHY chips,
 * left-aligned geo quirk. Pages if a custom fact runs long.
 */
function worldGeographyFactsFrames(payload = {}) {
  const text = fold(payload.fact?.text || payload.text || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS);
  if (!lines.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < lines.length; index += 5) {
    const chunk = lines.slice(index, index + 5);
    const body = [0, 1, 2, 3, 4].map((rowIndex) => {
      const row = blankRow(COLS);
      if (chunk[rowIndex]) {
        placeText(row, chunk[rowIndex], 0);
      }
      return row;
    });
    frames.push(snapshotFrame(
      assertValidLayout([geographyChipRow('WORLD GEOGRAPHY'), ...body], 'world geography facts'),
      'World Geography Facts',
      'geo.facts',
    ));
  }
  return frames;
}

function talkChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('violet');
  row[1] = chipCode('violet');
  row[COLS - 2] = chipCode('violet');
  row[COLS - 1] = chipCode('violet');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Conversation Starters (marketplace entertainment): violet LET'S TALK chips,
 * left-aligned prompt. Body lines are vertically centred in the five rows
 * under the title when the prompt is short, so short icebreakers do not sit
 * glued to the top with a big empty belly below. Custom long prompts may page.
 */
function conversationStartersFrames(payload = {}) {
  const text = fold(payload.prompt?.text || payload.text || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS);
  if (!lines.length) {
    return [];
  }
  const BODY_SLOTS = 5;
  const frames = [];
  for (let index = 0; index < lines.length; index += BODY_SLOTS) {
    const chunk = lines.slice(index, index + BODY_SLOTS);
    const padTop = Math.floor((BODY_SLOTS - chunk.length) / 2);
    const body = [];
    for (let rowIndex = 0; rowIndex < BODY_SLOTS; rowIndex += 1) {
      const row = blankRow(COLS);
      const line = chunk[rowIndex - padTop];
      if (line) {
        placeText(row, line, 0);
      }
      body.push(row);
    }
    frames.push(snapshotFrame(
      assertValidLayout([talkChipRow("LET'S TALK"), ...body], 'conversation starters'),
      'Conversation Starters',
      'talk.starters',
    ));
  }
  return frames;
}

function stoicChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[1] = chipCode('white');
  row[COLS - 2] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Stoic Quotes (marketplace lifestyle): white STOIC chips, left-aligned quote,
 * author right-aligned on the last body row.
 */
function stoicQuotesFrames(payload = {}) {
  const text = fold(payload.quote?.text || payload.text || '');
  const author = fold(payload.quote?.author || payload.author || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS).slice(0, 4);
  if (!lines.length) {
    return [];
  }
  const body = [0, 1, 2, 3].map((rowIndex) => {
    const row = blankRow(COLS);
    if (lines[rowIndex]) {
      placeText(row, lines[rowIndex], 0);
    }
    return row;
  });
  const authorRow = blankRow(COLS);
  if (author) {
    const label = encodeText(fold(`- ${author}`)).length <= COLS
      ? fold(`- ${author}`)
      : author;
    const codes = encodeText(label).slice(0, COLS);
    placeText(authorRow, label, Math.max(0, COLS - codes.length));
  }
  return [snapshotFrame(
    assertValidLayout([stoicChipRow('STOIC'), ...body, authorRow], 'stoic quotes'),
    'Stoic Quotes',
    'stoic.quotes',
  )];
}

function historyChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('red');
  row[1] = chipCode('red');
  row[COLS - 2] = chipCode('red');
  row[COLS - 1] = chipCode('red');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * On This Day in History (marketplace education): red ON THIS DAY chips,
 * centered date/year line, left-aligned event text.
 */
function onThisDayFrames(payload = {}) {
  const event = payload.event || {};
  const text = fold(event.text || payload.text || '');
  if (!text) {
    return [];
  }
  const dateLine = fold(event.dateLine || '');
  const lines = wrap(text, COLS).slice(0, 4);
  if (!lines.length) {
    return [];
  }
  const dateRow = blankRow(COLS);
  if (dateLine) {
    centered(dateLine, { from: 0, width: COLS, row: dateRow });
  }
  const body = [0, 1, 2, 3].map((rowIndex) => {
    const row = blankRow(COLS);
    if (lines[rowIndex]) {
      placeText(row, lines[rowIndex], 0);
    }
    return row;
  });
  return [snapshotFrame(
    assertValidLayout([historyChipRow('ON THIS DAY'), dateRow, ...body], 'on this day'),
    'On This Day in History',
    'history.day',
  )];
}

function bakeChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('yellow');
  row[1] = chipCode('yellow');
  row[COLS - 2] = chipCode('yellow');
  row[COLS - 1] = chipCode('yellow');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Baking Inspiration (marketplace lifestyle): yellow BAKE THIS chips, recipe
 * title, then ≤5 ingredients joined with + across the remaining rows.
 */
function bakingInspirationFrames(payload = {}) {
  const idea = payload.idea || {};
  const title = fold(idea.title || payload.title || '');
  const ingredients = Array.isArray(idea.ingredients)
    ? idea.ingredients
    : (Array.isArray(payload.ingredients) ? payload.ingredients : []);
  const parts = ingredients.map((item) => fold(item)).filter(Boolean);
  if (!title || !parts.length) {
    return [];
  }
  const titleRow = blankRow(COLS);
  placeText(titleRow, title.slice(0, COLS), 0);
  const ingLines = wrap(parts.join(' + '), COLS).slice(0, 4);
  const body = [0, 1, 2, 3].map((rowIndex) => {
    const row = blankRow(COLS);
    if (ingLines[rowIndex]) {
      placeText(row, ingLines[rowIndex], 0);
    }
    return row;
  });
  return [snapshotFrame(
    assertValidLayout([bakeChipRow('BAKE THIS'), titleRow, ...body], 'baking inspiration'),
    'Baking Inspiration',
    'bake.inspire',
  )];
}

/**
 * Calendar Clock (marketplace productivity): 7-col month chips inset one
 * flap from the left, two blank flaps, then weekday / month+day / 12h clock.
 * `SMTWTFS` only when the month fits in five week rows.
 */
function calendarClockFrames(payload = {}) {
  const rows = calendarClockRows(payload);
  if (!rows) {
    return [];
  }
  return [snapshotFrame(
    assertValidLayout(rows, 'calendar clock'),
    'Calendar Clock',
    'calendar.clock',
  )];
}

/**
 * Family Quotes (marketplace channel): the quote gets the whole board.
 *
 * No title and no chips. `quoteLines` does the shaping — a row per sentence,
 * wrapped one column shy of the right edge, attribution on the tail of the
 * last sentence — and this centres the block down the six rows.
 */
function familyQuotesFrames(payload = {}) {
  const lines = quoteLines(
    payload.quote?.text || payload.text || '',
    payload.quote?.author || payload.author || '',
  );
  if (!lines.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < lines.length; index += ROWS) {
    const chunk = lines.slice(index, index + ROWS);
    const top = Math.floor((ROWS - chunk.length) / 2);
    const rows = [];
    for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
      const row = blankRow(COLS);
      const line = chunk[rowIndex - top];
      if (line) {
        placeText(row, line, 0);
      }
      rows.push(row);
    }
    frames.push(snapshotFrame(
      assertValidLayout(rows, 'family quotes'),
      'Family Quotes',
      'family.quotes',
    ));
  }
  return frames;
}

/**
 * US Weather Map (marketplace channel): the lower 48 in colour chips.
 *
 * No text anywhere — every flap the map claims is a chip and everything else
 * stays blank, so the silhouette is the whole design. The payload already
 * carries the chip per cell; this only has to place them and refuse to paint a
 * map with holes in it.
 */
function usWeatherMapFrames(payload = {}) {
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  if (!cells.length) {
    return [];
  }
  const rows = Array.from({ length: ROWS }, () => blankRow(COLS));
  let painted = 0;
  for (const cell of cells) {
    const row = Number(cell?.row);
    const col = Number(cell?.col);
    const code = chipCode(cell?.chip);
    if (!code || !Number.isInteger(row) || !Number.isInteger(col)) {
      continue;
    }
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) {
      continue;
    }
    rows[row][col] = code;
    painted += 1;
  }
  if (!painted) {
    return [];
  }
  return [snapshotFrame(
    assertValidLayout(rows, 'us weather map'),
    'US Weather Map',
    'us.weather-map',
  )];
}

/**
 * Dad Jokes (marketplace channel): setup on top, a blank row, then the
 * punchline.
 *
 * No title and no chips. The blank row is the pause before the groan, so it
 * is load-bearing — `jokeLines` puts it there and this centres the block down
 * the six rows.
 */
function dadJokesFrames(payload = {}) {
  const lines = jokeLines(
    payload.joke?.setup || payload.setup || '',
    payload.joke?.punchline || payload.punchline || '',
  );
  if (!lines.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < lines.length; index += ROWS) {
    // A chunk that starts on the pause would open with a wasted row.
    const chunk = lines.slice(index, index + ROWS);
    while (chunk.length && !chunk[0]) {
      chunk.shift();
    }
    if (!chunk.length) {
      continue;
    }
    const top = Math.floor((ROWS - chunk.length) / 2);
    const rows = [];
    for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
      const row = blankRow(COLS);
      const line = chunk[rowIndex - top];
      if (line) {
        placeText(row, line, 0);
      }
      rows.push(row);
    }
    frames.push(snapshotFrame(
      assertValidLayout(rows, 'dad jokes'),
      'Dad Jokes',
      'dad.jokes',
    ));
  }
  return frames;
}

/**
 * Roast Me! (marketplace "Boom Roasted"): the punchline gets the whole board.
 *
 * No title and no chips, so all six rows are text. Lines are left-aligned on
 * column 0 and the block is centred vertically. The wrap fills greedily
 * (`orphans: false`) because pushing a two-letter word down a line can cost a
 * whole row, and a roast reads best packed.
 */
function roastMeFrames(payload = {}) {
  const text = fold(payload.roast?.text || payload.text || '');
  if (!text) {
    return [];
  }
  const lines = wrap(text, COLS, { orphans: false });
  if (!lines.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < lines.length; index += ROWS) {
    const chunk = lines.slice(index, index + ROWS);
    const top = Math.floor((ROWS - chunk.length) / 2);
    const rows = [];
    for (let rowIndex = 0; rowIndex < ROWS; rowIndex += 1) {
      const row = blankRow(COLS);
      const line = chunk[rowIndex - top];
      if (line) {
        placeText(row, line, 0);
      }
      rows.push(row);
    }
    frames.push(snapshotFrame(
      assertValidLayout(rows, 'roast me'),
      'Roast Me!',
      'roast.me',
    ));
  }
  return frames;
}

/**
 * Word Clock (marketplace productivity): the time spelled out as a sentence,
 * left-aligned as a block and centred on all six rows. Rows are built in
 * `word-clock.js` so the admin bezel paints exactly what the flaps will show.
 */
function wordClockFrames(payload = {}) {
  const rows = wordClockRows(payload);
  if (!rows) {
    return [];
  }
  return [snapshotFrame(
    assertValidLayout(rows, 'word clock'),
    'Word Clock',
    'word.clock',
  )];
}

/**
 * Red Letter: a Date Book countdown, or the event's own day-of card.
 *
 * The rows are built in `red-letter.js` because the same six rows feed the
 * admin preview and the designer; this only checks them and wraps a frame.
 */
function redLetterFrames(payload = {}) {
  const rows = redLetterRows(payload);
  if (!rows) {
    return [];
  }
  return [snapshotFrame(
    assertValidLayout(rows, 'red letter'),
    payload.card === 'day-of' ? 'Red Letter Day' : 'Red Letter Countdown',
    'red-letter.card',
  )];
}

function worldPopChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('green');
  row[1] = chipCode('green');
  row[COLS - 2] = chipCode('green');
  row[COLS - 1] = chipCode('green');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * World Population Tracker (marketplace education): green title chips, the
 * estimated headcount with commas, net growth per second, estimate footer.
 */
function worldPopulationFrames(payload = {}) {
  const pop = payload.population || {};
  const total = pop.total != null ? pop.total : payload.total;
  const formatted = fold(pop.formatted || formatPopulation(total) || '');
  if (!formatted) {
    return [];
  }
  const net = formatRate(pop.netPerSec);
  const births = formatRate(pop.birthsPerSec);
  const deaths = formatRate(pop.deathsPerSec);
  const rateLine = net
    ? fold(`NET +${net} / SECOND`)
    : '';
  const detail = (births && deaths)
    ? fold(`B ${births}/S  D ${deaths}/S`)
    : '';
  const source = fold(pop.sourceLabel || 'ESTIMATE');
  const footer = source.length <= 18 ? source : 'ESTIMATE';

  const numberRow = blankRow(COLS);
  centered(formatted, { row: numberRow });

  const mid = blankRow(COLS);
  if (detail && detail.length <= COLS) {
    centered(detail, { row: mid });
  } else if (rateLine) {
    centered(rateLine, { row: mid });
  }

  const netRow = blankRow(COLS);
  if (detail && rateLine) {
    centered(rateLine, { row: netRow });
  }

  const rows = [
    worldPopChipRow('WORLD POPULATION'),
    blankRow(COLS),
    numberRow,
    mid,
    netRow,
    worldPopChipRow(footer),
  ];

  return [snapshotFrame(
    assertValidLayout(rows, 'world population'),
    'World Population',
    'world.population',
  )];
}

function stocksChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[1] = chipCode('white');
  row[COLS - 2] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

function stockDirectionChip(direction) {
  if (direction === 'up') {
    return 'green';
  }
  if (direction === 'down') {
    return 'red';
  }
  return 'white';
}

function stockQuoteRow(quote = {}) {
  const row = blankRow(COLS);
  const symbol = fold(quote.boardSymbol || quote.symbol || '').slice(0, 5);
  const price = fold(quote.priceLabel || '');
  const change = fold(quote.changeLabel || '');
  if (!symbol || !price) {
    return row;
  }
  placeText(row, symbol, 0);
  // SYMBOL____PRICE__CHANGE_#
  const right = change ? `${price} ${change}` : price;
  const codes = encodeText(right).slice(0, 15);
  placeText(row, right, Math.max(6, COLS - 1 - codes.length - 1));
  row[COLS - 1] = chipCode(stockDirectionChip(quote.direction));
  return row;
}

/**
 * Stock Market (marketplace business): white STOCK MARKET chips, up to five
 * ticker rows per page with a green/red direction chip.
 */
function stockMarketFrames(payload = {}) {
  const quotes = (payload.quotes || []).filter((quote) => quote?.priceLabel);
  if (!quotes.length) {
    return [];
  }
  const frames = [];
  for (let index = 0; index < quotes.length; index += 5) {
    const chunk = quotes.slice(index, index + 5);
    const body = [0, 1, 2, 3, 4].map((rowIndex) => (
      chunk[rowIndex] ? stockQuoteRow(chunk[rowIndex]) : blankRow(COLS)
    ));
    const title = quotes.length > 5
      ? `STOCKS ${Math.floor(index / 5) + 1}/${Math.ceil(quotes.length / 5)}`
      : 'STOCK MARKET';
    frames.push(snapshotFrame(
      assertValidLayout([stocksChipRow(title), ...body], 'stock market'),
      'Stock Market',
      'stocks.market',
    ));
  }
  return frames;
}

function fxChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[1] = chipCode('white');
  row[COLS - 2] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

// Rate column: the `$` header sits directly over the first digit of every rate.
const FX_RATE_COL = 7;
// Widest rate that still clears the change column beside it.
const FX_RATE_WIDTH = 7;
// Change labels right-align to the chip, so a two-decimal percent always puts
// its point on FX_POINT_COL — which is where the `+` of the header lands.
const FX_CHANGE_WIDTH = 7;
const FX_CHANGE_HEADER = '+/-%';

/**
 * Column labels under the title: `$` over the rates, `+/-%` over the change.
 *
 * The header block is four contiguous cells right-aligned to the change column,
 * so its `%` sits over the `%` below it and its `+` over the decimal point.
 * Spelling it `+ / - %` spread the block five cells left of the numbers it
 * labelled, which read as a separate, unaligned row.
 */
function fxColumnHeaderRow() {
  const row = blankRow(COLS);
  placeText(row, '$', FX_RATE_COL);
  placeText(row, FX_CHANGE_HEADER, COLS - 1 - FX_CHANGE_HEADER.length);
  return row;
}

/**
 * CODE  RATE    ±change% ■ — green chip on gain, red on loss (marketplace FX).
 */
function fxQuoteRow(quote = {}) {
  const row = blankRow(COLS);
  const code = fold(quote.code || '').slice(0, 3);
  const rate = fold(quote.rateLabel || '').slice(0, FX_RATE_WIDTH);
  const change = fold(quote.changeLabel || '').slice(0, FX_CHANGE_WIDTH);
  if (!code || !rate) {
    return row;
  }
  placeText(row, code, 0);
  placeText(row, rate, FX_RATE_COL);
  if (change) {
    const codes = encodeText(change);
    placeText(row, change, COLS - 1 - codes.length);
  }
  row[COLS - 1] = chipCode(stockDirectionChip(quote.direction));
  return row;
}

/**
 * World Currency Rates (marketplace business): white `{BASE} CONVERSIONS` chips,
 * $ / +/−% column headers, up to four quote rows with day-over-day change and
 * a green/red direction chip.
 */
function currencyRatesFrames(payload = {}) {
  const quotes = (payload.quotes || []).filter((quote) => quote?.rateLabel && quote?.code);
  if (!quotes.length) {
    return [];
  }
  const base = fold(payload.base || 'USD').slice(0, 3) || 'USD';
  const perPage = 4;
  const frames = [];
  for (let index = 0; index < quotes.length; index += perPage) {
    const chunk = quotes.slice(index, index + perPage);
    const body = [0, 1, 2, 3].map((rowIndex) => (
      chunk[rowIndex] ? fxQuoteRow(chunk[rowIndex]) : blankRow(COLS)
    ));
    const pages = Math.ceil(quotes.length / perPage);
    const title = pages > 1
      ? `${base} CONV ${Math.floor(index / perPage) + 1}/${pages}`
      : `${base} CONVERSIONS`;
    frames.push(snapshotFrame(
      assertValidLayout([
        fxChipRow(title),
        fxColumnHeaderRow(),
        ...body,
      ], 'currency rates'),
      'World Currency Rates',
      'fx.rates',
    ));
  }
  return frames;
}

// Ranks own the first two columns and the title runs to the right edge, the
// way the marketplace Top 10 card does — `10 MISSION: IMPOSSIBLE` is exactly
// the 22 flaps of a row.
const PLEX_TOP10_TITLE_COL = 3;
const PLEX_TOP10_TITLE_WIDTH = COLS - PLEX_TOP10_TITLE_COL;
const PLEX_TOP10_PER_FRAME = 5;

function plexTop10ChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('yellow');
  row[1] = chipCode('yellow');
  row[COLS - 2] = chipCode('yellow');
  row[COLS - 1] = chipCode('yellow');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/** Keep whole words: `The Super Mario Galaxy Movie` reads as `THE SUPER MARIO`. */
function plexTop10Title(title) {
  const text = fold(title || '');
  if (text.length <= PLEX_TOP10_TITLE_WIDTH) {
    return text;
  }
  const cut = text.slice(0, PLEX_TOP10_TITLE_WIDTH + 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > 0 ? cut.slice(0, space) : text.slice(0, PLEX_TOP10_TITLE_WIDTH);
  return kept.trim();
}

function plexTop10EntryRow(entry, rank) {
  const row = blankRow(COLS);
  placeText(row, String(rank).padStart(2, '0'), 0);
  const title = plexTop10Title(entry.title);
  if (title) {
    placeText(row, title, PLEX_TOP10_TITLE_COL);
  }
  return row;
}

/**
 * Plex Top 10 Movies — five ranks a frame, so a full chart is two flips.
 * Both frames keep the title row; the rank tells you where you are.
 */
function plexTop10Frames(payload = {}) {
  const movies = (payload.movies || []).filter((movie) => movie?.title);
  if (!movies.length) {
    return [];
  }
  const heading = fold(payload.boardTitle || 'PLEX TOP 10 MOVIES');
  const frames = [];
  for (let index = 0; index < movies.length; index += PLEX_TOP10_PER_FRAME) {
    const chunk = movies.slice(index, index + PLEX_TOP10_PER_FRAME);
    const body = [0, 1, 2, 3, 4].map((rowIndex) => (
      chunk[rowIndex]
        ? plexTop10EntryRow(chunk[rowIndex], chunk[rowIndex].rank || index + rowIndex + 1)
        : blankRow(COLS)
    ));
    frames.push(snapshotFrame(
      assertValidLayout([plexTop10ChipRow(heading), ...body], 'plex top 10'),
      'Plex Top 10 Movies',
      'plex.top10',
    ));
  }
  return frames;
}

function issOrbitTitleRow() {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[1] = chipCode('white');
  row[COLS - 2] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  centered(fold('ISS SPACE ORBIT'), { from: 2, width: 18, row });
  return row;
}

/** Bottom of the corner L ornaments, with the local clock centred between. */
function issOrbitTimeRow(timeLabel) {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  if (timeLabel) {
    centered(fold(timeLabel), { from: 1, width: 20, row });
  }
  return row;
}

/**
 * International Space Station (marketplace): white L-corner ornaments around
 * `ISS SPACE ORBIT` + local clock, then away / coords / altitude / speed.
 */
function issTrackFrames(payload = {}, ctx = {}) {
  if (!Number.isFinite(Number(payload.latitude)) || !Number.isFinite(Number(payload.longitude))) {
    return [];
  }
  const settings = payload.settings || {};
  const zone = ctx.timeZone || payload.timeZone || houseTimeZone(ctx.config || {});
  let timeLabel = fold(payload.timeLabel || '');
  if (!timeLabel) {
    const parts = dateParts(payload.asOf || new Date(), zone);
    if (parts) {
      let hours = parts.hour % 12;
      if (hours === 0) hours = 12;
      const meridiem = parts.hour >= 12 ? 'PM' : 'AM';
      timeLabel = `${String(hours).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} ${meridiem}`;
    }
  }

  const away = payload.awayLabel || payload.relativeLabel
    || (payload.hasHome === false ? 'SET HOUSE PIN' : '');
  const coords = settings.showCoordinates !== false ? (payload.coordLabel || '') : '';
  const altitude = settings.showAltitude !== false ? (payload.altitudeLabel || '') : '';
  const going = payload.speedLabel || '';

  const rows = [
    issOrbitTitleRow(),
    issOrbitTimeRow(timeLabel),
    away ? centered(fold(away).slice(0, 22)) : blankRow(COLS),
    coords ? centered(fold(coords).slice(0, 22)) : blankRow(COLS),
    altitude ? centered(fold(altitude).slice(0, 22)) : blankRow(COLS),
    going ? centered(fold(going).slice(0, 22)) : blankRow(COLS),
  ];
  return [snapshotFrame(
    assertValidLayout(rows, 'iss track'),
    'International Space Station',
    'iss.track',
  )];
}

function starlinkChipRow(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('white');
  row[1] = chipCode('white');
  row[COLS - 2] = chipCode('white');
  row[COLS - 1] = chipCode('white');
  if (text) {
    centered(fold(text), { from: 2, width: 18, row });
  }
  return row;
}

/**
 * Starlink Tracker: next pass/train over the house pin — when, sky position,
 * and local sky conditions.
 */
function starlinkTrackFrames(payload = {}) {
  if (payload.mode === 'none') {
    const rows = [
      starlinkChipRow('STARLINK TRACKER'),
      blankRow(COLS),
      centered(fold(payload.whenLabel || 'NO PASS SOON')),
      payload.directionLabel ? centered(fold(payload.directionLabel)) : blankRow(COLS),
      blankRow(COLS),
      starlinkChipRow(payload.home?.city || 'HOME'),
    ];
    return [snapshotFrame(
      assertValidLayout(rows, 'starlink none'),
      'Starlink Tracker',
      'starlink.track',
    )];
  }

  if (!payload.whenLabel && !payload.startUtc) {
    return [];
  }

  const settings = payload.settings || {};
  const lines = [];
  if (payload.whenLabel) {
    lines.push(fold(payload.whenLabel).slice(0, 22));
  }
  if (payload.directionLabel) {
    lines.push(fold(payload.directionLabel).slice(0, 22));
  }
  if (settings.showWeather !== false && payload.weatherLabel) {
    lines.push(fold(payload.weatherLabel).slice(0, 22));
  } else if (payload.skyCondition) {
    lines.push(fold(payload.skyCondition).slice(0, 22));
  }
  if (settings.showVisibility !== false && payload.visibilityBoard) {
    lines.push(fold(payload.visibilityBoard).slice(0, 22));
  } else if (payload.lookLabel && lines.length < 4) {
    lines.push(fold(payload.lookLabel).slice(0, 22));
  }
  while (lines.length < 4) {
    lines.push('');
  }
  const body = lines.slice(0, 4).map((line) => (
    line ? centered(line) : blankRow(COLS)
  ));
  return [snapshotFrame(
    assertValidLayout([
      starlinkChipRow('STARLINK TRACKER'),
      blankRow(COLS),
      ...body,
    ], 'starlink track'),
    'Starlink Tracker',
    'starlink.track',
  )];
}

const FORMATTERS = {
  'youtube.now-playing': youtubeFrames,
  'upside-news.round': upsideFrames,
  'wiki-common-knowledge.round': wikiFrames,
  'overhead.round': overheadFrames,
  'trivia.round': triviaFrames,
  'flightplan.flight': flightPlanBoardFrames,
  'japanese.learn': learnJapaneseFrames,
  'portuguese.learn': learnLanguageFrames,
  'spanish.learn': learnLanguageFrames,
  'french.learn': learnLanguageFrames,
  'german.learn': learnLanguageFrames,
  'italian.learn': learnLanguageFrames,
  'quiet-hours.reminder': quietHoursReminderFrames,
  'chuck.facts': chuckNorrisFrames,
  'word.riddles': wordRiddlesFrames,
  'amazing.facts': amazingFactsFrames,
  'geo.facts': worldGeographyFactsFrames,
  'talk.starters': conversationStartersFrames,
  'stoic.quotes': stoicQuotesFrames,
  'history.day': onThisDayFrames,
  'bake.inspire': bakingInspirationFrames,
  'world.population': worldPopulationFrames,
  'calendar.clock': calendarClockFrames,
  'word.clock': wordClockFrames,
  'roast.me': roastMeFrames,
  'family.quotes': familyQuotesFrames,
  'dad.jokes': dadJokesFrames,
  'us.weather-map': usWeatherMapFrames,
  'red-letter.card': redLetterFrames,
  'stocks.market': stockMarketFrames,
  'fx.rates': currencyRatesFrames,
  'plex.top10': plexTop10Frames,
  'iss.track': issTrackFrames,
  'starlink.track': starlinkTrackFrames,
};

function framesFor(payload, ctx = {}) {
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  FORMATTERS,
  framesFor,
  youtubeFrames,
  upsideFrames,
  wikiFrames,
  overheadFrames,
  triviaFrames,
  flightPlanBoardFrames,
  learnJapaneseFrames,
  learnLanguageFrames,
  quietHoursReminderFrames,
  chuckNorrisFrames,
  wordRiddlesFrames,
  amazingFactsFrames,
  worldGeographyFactsFrames,
  conversationStartersFrames,
  stoicQuotesFrames,
  onThisDayFrames,
  bakingInspirationFrames,
  worldPopulationFrames,
  calendarClockFrames,
  wordClockFrames,
  roastMeFrames,
  familyQuotesFrames,
  dadJokesFrames,
  usWeatherMapFrames,
  redLetterFrames,
  stockMarketFrames,
  currencyRatesFrames,
  plexTop10Frames,
  plexTop10Title,
  issTrackFrames,
  starlinkTrackFrames,
  triviaGate,
  youtubeStatsLine,
};
