// Feeds family of board frames (03 §D): YouTube, The Upside, Wiki, Overhead,
// and the gated trivia pair.
//
// Trivia is the only formatter that refuses work. A question that cannot fit
// a single frame is skipped rather than paged, because a multi-frame question
// is unreadable from across a room. The measured gate is in 02 §6.

const {
  COLS,
  BLANK,
  CHIPS,
  blankRow,
  encodeText,
  placeText,
  truncate,
  wrap,
  fold,
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
} = require('../frames');

const { snapshotFrame, paginate, padRows } = require('./common');

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

const FORMATTERS = {
  'youtube.now-playing': youtubeFrames,
  'upside-news.round': upsideFrames,
  'wiki-common-knowledge.round': wikiFrames,
  'overhead.round': overheadFrames,
  'trivia.round': triviaFrames,
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
  triviaGate,
  youtubeStatsLine,
};
