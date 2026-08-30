/**
 * Word Riddles — pick a shipped (or house-edited) riddle for the board.
 *
 * Corpus is local JSON. No network at runtime. A round is three frames:
 * intro ("RIDDLE ME THIS..."), the riddle, then the answer after a delay.
 */

const crypto = require('crypto');
const SHIPPED = require('./word-riddles-riddles.json');
const {
  cleanRiddle,
  cleanAnswer,
  clampRevealDelay,
  REVEAL_DEFAULT,
  createWordRiddlesSettings,
} = require('./word-riddles-settings');
const { applyCorpusRemove } = require('./corpus-remove');
const {
  COLS,
  ROWS,
  CHIPS,
  BLANK,
  CODE_BY_CHAR,
  blankRow,
  encodeText,
  placeCodes,
  fold,
  wrap,
} = require('./vestaboard/encoder');

const TYPE = 'word.riddles';
const RIDDLE_ROWS = 4;
const ANSWER_ROWS = 5;
const FOOTER = 'VESTABOARD';
const INTRO_DWELL_SECONDS = 8;
const ANSWER_DWELL_SECONDS = 20;

function loadShipped() {
  return Array.isArray(SHIPPED?.riddles) ? SHIPPED.riddles : [];
}

function expandLine(line, width) {
  const words = String(line || '').split(' ').filter(Boolean);
  if (words.length < 2) {
    return line;
  }
  let extra = width - words.join(' ').length;
  if (extra <= 0) {
    return words.join(' ');
  }
  let out = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const add = extra > 0 ? 1 : 0;
    extra -= add;
    out += ` ${' '.repeat(add)}${words[i]}`;
  }
  return out;
}

function airyLines(text, width, maxLines) {
  const folded = fold(cleanRiddle(text));
  if (!folded) {
    return [];
  }
  const lines = wrap(folded, width);
  if (!lines.length || lines.length > maxLines) {
    return lines;
  }
  return lines.map((line) => expandLine(line, width));
}

function riddleLines(text) {
  return airyLines(text, COLS, RIDDLE_ROWS);
}

/** Encode already-folded board text, keeping extra spaces for the airy wrap. */
function encodeBoardText(text) {
  const codes = [];
  for (const char of String(text || '')) {
    const code = CODE_BY_CHAR.get(char);
    if (code !== undefined) {
      codes.push(code);
    } else if (char === ' ') {
      codes.push(BLANK);
    }
  }
  return codes.slice(0, COLS);
}

function letterSpaced(word) {
  const folded = fold(word);
  if (!folded || /\s/.test(folded)) {
    return '';
  }
  if (folded.length < 2 || folded.length > 11) {
    return '';
  }
  const spaced = folded.split('').join(' ');
  return encodeText(spaced).length <= COLS ? spaced : '';
}

function answerLines(text) {
  const folded = fold(cleanAnswer(text));
  if (!folded) {
    return [];
  }
  const spaced = letterSpaced(folded);
  if (spaced) {
    return [spaced];
  }
  return wrap(folded, COLS);
}

function fitsBoard(riddle, answer) {
  const riddleWrap = riddleLines(riddle);
  const answerWrap = answerLines(answer);
  return riddleWrap.length > 0
    && riddleWrap.length <= RIDDLE_ROWS
    && answerWrap.length > 0
    && answerWrap.length <= 2;
}

function centerLine(text) {
  const row = blankRow(COLS);
  const codes = encodeBoardText(text);
  const start = Math.floor((COLS - codes.length) / 2);
  return placeCodes(row, codes, start);
}

function chipBar(leftColor, rightColor) {
  const row = blankRow(COLS);
  const half = Math.floor(COLS / 2);
  for (let i = 0; i < half; i += 1) {
    row[i] = CHIPS[leftColor];
  }
  for (let i = half; i < COLS; i += 1) {
    row[i] = CHIPS[rightColor];
  }
  return row;
}

function placeBlock(lines, slots, { align = 'block' } = {}) {
  const chunk = (lines || []).slice(0, slots);
  const padTop = Math.floor((slots - chunk.length) / 2);
  const maxWidth = chunk.reduce((max, line) => Math.max(max, encodeBoardText(line).length), 0);
  const inset = Math.max(0, Math.floor((COLS - maxWidth) / 2));
  const rows = [];
  for (let i = 0; i < slots; i += 1) {
    const row = blankRow(COLS);
    const line = chunk[i - padTop];
    if (line) {
      const codes = encodeBoardText(line);
      const start = align === 'center'
        ? Math.floor((COLS - codes.length) / 2)
        : inset;
      placeCodes(row, codes, Math.max(0, start));
    }
    rows.push(row);
  }
  return rows;
}

function introRows() {
  return [
    chipBar('green', 'blue'),
    blankRow(COLS),
    centerLine('RIDDLE ME'),
    centerLine('THIS...'),
    blankRow(COLS),
    chipBar('blue', 'green'),
  ];
}

function riddleRows(text) {
  const lines = riddleLines(text);
  if (!lines.length) {
    return [];
  }
  return [
    ...placeBlock(lines, RIDDLE_ROWS, { align: 'block' }),
    blankRow(COLS),
    centerLine(FOOTER),
  ];
}

function answerRows(text) {
  const lines = answerLines(text);
  if (!lines.length) {
    return [];
  }
  return [
    ...placeBlock(lines, ANSWER_ROWS, { align: 'center' }),
    centerLine(FOOTER),
  ];
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolveRiddles(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const removed = new Set(settings.removedIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const item of loadShipped()) {
    const id = String(item.id || '').trim();
    if (!id || removed.has(id)) {
      continue;
    }
    const patch = overrides[id] || {};
    const riddle = cleanRiddle(patch.riddle != null ? patch.riddle : item.riddle);
    const answer = cleanAnswer(patch.answer != null ? patch.answer : item.answer);
    rows.push({
      id,
      riddle,
      answer,
      custom: false,
      hidden: hidden.has(id),
      rows: riddleLines(riddle).length,
    });
  }

  for (const item of settings.custom || []) {
    const id = String(item.id || '').trim();
    const riddle = cleanRiddle(item.riddle);
    const answer = cleanAnswer(item.answer);
    if (!id || !riddle || !answer) {
      continue;
    }
    rows.push({
      id,
      riddle,
      answer,
      custom: true,
      hidden: false,
      rows: riddleLines(riddle).length,
    });
  }

  return rows;
}

function matchingRiddles(settings = {}) {
  return resolveRiddles(settings).filter((item) => (
    !item.hidden && fitsBoard(item.riddle, item.answer)
  ));
}

function pickRiddle(settings = {}, { random = Math.random } = {}) {
  const pool = matchingRiddles(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((item) => !recent.has(item.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function playbackOptions(settings = {}, options = {}) {
  const showIntro = options.showIntro != null
    ? options.showIntro !== false
    : settings.showIntro !== false;
  const revealDelaySeconds = clampRevealDelay(
    options.revealDelaySeconds != null ? options.revealDelaySeconds : settings.revealDelaySeconds,
    REVEAL_DEFAULT,
  );
  return { showIntro, revealDelaySeconds };
}

function estimateRoundSeconds(settings = {}, options = {}) {
  const { showIntro, revealDelaySeconds } = playbackOptions(settings, options);
  return (showIntro ? INTRO_DWELL_SECONDS : 0) + revealDelaySeconds + ANSWER_DWELL_SECONDS;
}

function buildWordRiddlesPayload(item, options = {}) {
  const riddle = cleanRiddle(item?.riddle);
  const answer = cleanAnswer(item?.answer);
  if (!riddle || !answer || !fitsBoard(riddle, answer)) {
    return null;
  }
  const playback = playbackOptions(options, options);
  return {
    type: TYPE,
    asOf: options.asOf || new Date().toISOString(),
    showIntro: playback.showIntro,
    revealDelaySeconds: playback.revealDelaySeconds,
    riddle: {
      id: item.id || '',
      riddle,
      answer,
    },
  };
}

function listRiddles(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolveRiddles(settings);
  if (!hidden) {
    rows = rows.filter((item) => !item.hidden);
  }
  if (needle) {
    rows = rows.filter((item) => item.riddle.toLowerCase().includes(needle)
      || item.answer.toLowerCase().includes(needle)
      || item.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    riddles: rows.slice(start, start + size),
  };
}

function createWordRiddles(config, log) {
  const settingsApi = createWordRiddlesSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    return {
      available: matchingRiddles(settings).length,
      total: loadShipped().length + settings.custom.length,
      customCount: settings.custom.length,
      hiddenCount: settings.hiddenIds.length,
      revealDelaySeconds: settings.revealDelaySeconds,
      showIntro: settings.showIntro,
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    updateSettings(patch = {}) {
      const next = {};
      if (patch.revealDelaySeconds != null) {
        next.revealDelaySeconds = patch.revealDelaySeconds;
      }
      if (patch.showIntro != null) {
        next.showIntro = patch.showIntro;
      }
      settingsApi.update(next);
      return { ok: true, ...this.statusSnapshot() };
    },
    statusSnapshot(query) {
      const settings = settingsApi.get();
      if (query && (query.page != null || query.pageSize != null || query.query
        || query.q || query.hidden)) {
        return snapshot(listRiddles(settings, query));
      }
      return snapshot();
    },
    addRiddle(riddle, answer) {
      const nextRiddle = cleanRiddle(riddle);
      const nextAnswer = cleanAnswer(answer);
      if (!nextRiddle) {
        return { ok: false, error: 'Type a riddle' };
      }
      if (!nextAnswer) {
        return { ok: false, error: 'Type the answer' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, {
        id: newCustomId(),
        riddle: nextRiddle,
        answer: nextAnswer,
      }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updateRiddle(id, { riddle, answer, hidden, remove } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing riddle id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);
      if (remove) {
        const result = applyCorpusRemove(settings, key, { isShipped: shipped });
        if (!result.ok) {
          return { ok: false, error: 'Unknown riddle' };
        }
        settingsApi.update(result.patch);
        return { ok: true, ...this.statusSnapshot() };
      }

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else {
          const nextRiddle = riddle != null ? cleanRiddle(riddle) : custom[customIndex].riddle;
          const nextAnswer = answer != null ? cleanAnswer(answer) : custom[customIndex].answer;
          if (!nextRiddle) {
            return { ok: false, error: 'Type a riddle' };
          }
          if (!nextAnswer) {
            return { ok: false, error: 'Type the answer' };
          }
          custom[customIndex] = {
            ...custom[customIndex],
            riddle: nextRiddle,
            answer: nextAnswer,
          };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown riddle' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (riddle != null || answer != null) {
        const original = loadShipped().find((row) => row.id === key);
        const nextRiddle = riddle != null ? cleanRiddle(riddle) : cleanRiddle(original?.riddle);
        const nextAnswer = answer != null ? cleanAnswer(answer) : cleanAnswer(original?.answer);
        if (!nextRiddle) {
          return { ok: false, error: 'Type a riddle' };
        }
        if (!nextAnswer) {
          return { ok: false, error: 'Type the answer' };
        }
        if (original
          && cleanRiddle(original.riddle) === nextRiddle
          && cleanAnswer(original.answer) === nextAnswer) {
          delete overrides[key];
        } else {
          overrides[key] = { riddle: nextRiddle, answer: nextAnswer };
        }
      }
      settingsApi.update({
        hiddenIds: [...hiddenIds],
        overrides,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const item = pickRiddle(settings, options);
      if (!item) {
        return null;
      }
      settingsApi.remember(item.id);
      return buildWordRiddlesPayload(item, {
        ...playbackOptions(settings, options),
        asOf: options.asOf,
      });
    },
  };
}

module.exports = {
  TYPE,
  RIDDLE_ROWS,
  ANSWER_ROWS,
  FOOTER,
  INTRO_DWELL_SECONDS,
  ANSWER_DWELL_SECONDS,
  ROWS,
  loadShipped,
  riddleLines,
  answerLines,
  letterSpaced,
  fitsBoard,
  introRows,
  riddleRows,
  answerRows,
  resolveRiddles,
  matchingRiddles,
  pickRiddle,
  listRiddles,
  playbackOptions,
  estimateRoundSeconds,
  buildWordRiddlesPayload,
  createWordRiddles,
};
