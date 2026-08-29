// What a Vestaboard can and cannot show.
//
// A board is 6 rows of 22 split-flap modules. Each flap can be one of a fixed
// set of characters or a solid colour chip, and nothing else — no lowercase,
// no asterisk, no accents, no emoji. Everything headed for a board passes
// through here first so the rest of the code can stop worrying about it.
//
// Pure functions only. No I/O, no clock, no config.

const ROWS = 6;
const COLS = 22;

const BLANK = 0;

/** Solid colour flaps, by name. */
const CHIPS = {
  red: 63,
  orange: 64,
  yellow: 65,
  green: 66,
  blue: 67,
  violet: 68,
  white: 69,
  black: 70,
  filled: 71,
};

// Codes the board reserves but does not render. Emitting one is a bug, so
// validate() rejects them rather than letting a blank flap appear at random.
const UNUSED_CODES = new Set([43, 45, 51, 57, 58, 61]);

const PUNCTUATION = {
  '!': 37,
  '@': 38,
  '#': 39,
  $: 40,
  '(': 41,
  ')': 42,
  '-': 44,
  '+': 46,
  '&': 47,
  '=': 48,
  ';': 49,
  ':': 50,
  "'": 52,
  '"': 53,
  '%': 54,
  ',': 55,
  '.': 56,
  '/': 59,
  '?': 60,
  '\u00b0': 62,
};

/** character -> code, built once. */
const CODE_BY_CHAR = (() => {
  const map = new Map();
  map.set(' ', BLANK);
  for (let i = 0; i < 26; i += 1) {
    map.set(String.fromCharCode(65 + i), i + 1);
  }
  // 1-9 land on 27-35 and zero trails at 36, which is not the order you would
  // guess from the digits themselves.
  for (let d = 1; d <= 9; d += 1) {
    map.set(String(d), 26 + d);
  }
  map.set('0', 36);
  for (const [char, code] of Object.entries(PUNCTUATION)) {
    map.set(char, code);
  }
  return map;
})();

/** code -> character, for turning a board layout back into readable text. */
const CHAR_BY_CODE = (() => {
  const map = new Map();
  for (const [char, code] of CODE_BY_CHAR) {
    map.set(code, char);
  }
  return map;
})();

const LEGAL_CODES = (() => {
  const set = new Set([BLANK]);
  for (const code of CODE_BY_CHAR.values()) {
    set.add(code);
  }
  for (const code of Object.values(CHIPS)) {
    set.add(code);
  }
  return set;
})();

// Letters that survive uppercasing but have no Unicode decomposition, so the
// accent stripper cannot reach them. Dropping them silently would eat a letter
// in the middle of a word; news headlines hit these often enough to matter.
const TRANSLITERATIONS = new Map([
  ['\u00c6', 'AE'],
  ['\u0152', 'OE'],
  ['\u00d8', 'O'],
  ['\u0110', 'D'],
  ['\u00d0', 'D'],
  ['\u0141', 'L'],
  ['\u00de', 'TH'],
  ['\u1e9e', 'SS'],
  ['\u00df', 'SS'],
]);

const SUBSTITUTIONS = new Map([
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201a', "'"],
  ['\u2032', "'"],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u201e', '"'],
  ['\u2033', '"'],
  ['\u2010', '-'],
  ['\u2011', '-'],
  ['\u2012', '-'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2015', '-'],
  ['\u2212', '-'],
  ['\u2026', '...'],
  ['\u00a0', ' '],
  ['\u2007', ' '],
  ['\u202f', ' '],
  ['\u2009', ' '],
  ['\u200b', ''],
]);

/**
 * Normalise text into something the board can actually spell.
 *
 * Uppercases, strips accents down to the base letter, swaps typographic
 * punctuation for the plain equivalents, and drops anything left over that has
 * no flap. Whitespace collapses to single spaces.
 */
function fold(text) {
  if (text === null || text === undefined) {
    return '';
  }

  const upper = String(text).toUpperCase();

  let out = '';
  for (const char of upper) {
    if (SUBSTITUTIONS.has(char)) {
      out += SUBSTITUTIONS.get(char);
      continue;
    }
    if (TRANSLITERATIONS.has(char)) {
      out += TRANSLITERATIONS.get(char);
      continue;
    }
    // Decompose so "Ã" becomes "A" plus a combining tilde, then drop the mark.
    const stripped = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const base of stripped) {
      if (CODE_BY_CHAR.has(base)) {
        out += base;
      } else if (/\s/.test(base)) {
        out += ' ';
      }
      // Anything else — emoji, trademark signs, box drawing — is dropped.
    }
  }

  return out.replace(/\s+/g, ' ').trim();
}

function isLegalCode(code) {
  return Number.isInteger(code) && LEGAL_CODES.has(code) && !UNUSED_CODES.has(code);
}

/** Codes in the order a module walks them. Unused slots are skipped. */
function drumOrder() {
  return [...LEGAL_CODES].sort((a, b) => a - b);
}

/** Fold text and turn it into character codes. */
function encodeText(text) {
  const folded = fold(text);
  const codes = [];
  for (const char of folded) {
    const code = CODE_BY_CHAR.get(char);
    if (code !== undefined) {
      codes.push(code);
    }
  }
  return codes;
}

/** Turn codes back into readable text. Chips render as a space. */
function decodeCodes(codes) {
  return (codes || [])
    .map((code) => CHAR_BY_CODE.get(code) ?? ' ')
    .join('');
}

/**
 * Greedy word wrap with orphan-aware line breaks.
 *
 * Words are never broken except when a single token cannot fit a line at all,
 * in which case it splits with a trailing hyphen.
 *
 * When the next word does not fit, a short trailing word on the current line
 * (articles, tiny glue words) is pulled onto the next line with it so we do
 * not leave orphans like:
 *   INSTRUMENTAL A
 *   CAPELLA.
 * Prefer:
 *   INSTRUMENTAL
 *   A CAPELLA.
 */
function wrap(text, width) {
  const limit = Math.max(2, Math.floor(width) || 0);
  const folded = fold(text);
  if (!folded) {
    return [];
  }

  const lines = [];
  let current = '';

  const flush = () => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  const isOrphanCandidate = (word) => {
    const token = String(word || '');
    // Articles and tiny glue words only — pulling 3-letter tokens changes too
    // many otherwise-fine greedy wraps.
    if (!token || token.length > 2) {
      return false;
    }
    // Keep punctuation-only tokens where they landed; move letter/digit glue.
    return /[A-Z0-9]/.test(token);
  };

  for (const rawWord of folded.split(' ')) {
    if (!rawWord) {
      continue;
    }
    let word = rawWord;

    // Pathological input only: a single token longer than the whole line.
    while (word.length > limit) {
      flush();
      lines.push(`${word.slice(0, limit - 1)}-`);
      word = word.slice(limit - 1);
    }

    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      const parts = current.split(' ');
      const last = parts[parts.length - 1];
      if (
        parts.length > 1
        && isOrphanCandidate(last)
        && last.length + 1 + word.length <= limit
      ) {
        parts.pop();
        lines.push(parts.join(' '));
        current = `${last} ${word}`;
      } else {
        flush();
        current = word;
      }
    }
  }

  flush();
  return lines;
}

/**
 * Fit a value into a fixed column. Names that run long are cut with no
 * ellipsis marker — a marker costs a flap and reads worse than a clean cut.
 */
function truncate(text, width) {
  const limit = Math.max(0, Math.floor(width) || 0);
  return fold(text).slice(0, limit);
}

/** A row of `width` blanks. */
function blankRow(width = COLS) {
  return new Array(width).fill(BLANK);
}

/**
 * Encode one row of text, padded with blanks to `width`. Text longer than the
 * row is cut; callers that care about overflow should wrap() first.
 */
function encodeRow(text, width = COLS) {
  const row = blankRow(width);
  const codes = encodeText(text).slice(0, width);
  for (let i = 0; i < codes.length; i += 1) {
    row[i] = codes[i];
  }
  return row;
}

/** Place codes into an existing row at a column offset, in place. */
function placeCodes(row, codes, at) {
  let column = Math.max(0, Math.floor(at) || 0);
  for (const code of codes) {
    if (column >= row.length) {
      break;
    }
    row[column] = code;
    column += 1;
  }
  return row;
}

/** Place text into an existing row at a column offset, in place. */
function placeText(row, text, at) {
  return placeCodes(row, encodeText(text), at);
}

/** Centre text within a row of `width`, biasing left on an odd remainder. */
function centerRow(text, width = COLS) {
  const codes = encodeText(text).slice(0, width);
  const row = blankRow(width);
  const start = Math.floor((width - codes.length) / 2);
  return placeCodes(row, codes, start);
}

/**
 * Check a finished layout. Exactly 6 rows of 22 legal codes; anything else
 * would be rejected by the board with a 400, so it is caught here first.
 */
function validate(rows) {
  const errors = [];

  if (!Array.isArray(rows)) {
    return { ok: false, errors: ['layout is not an array'] };
  }
  if (rows.length !== ROWS) {
    errors.push(`layout has ${rows.length} rows, expected ${ROWS}`);
  }

  rows.forEach((row, index) => {
    if (!Array.isArray(row)) {
      errors.push(`row ${index} is not an array`);
      return;
    }
    if (row.length !== COLS) {
      errors.push(`row ${index} has ${row.length} columns, expected ${COLS}`);
    }
    row.forEach((code, column) => {
      if (!isLegalCode(code)) {
        errors.push(`row ${index} column ${column} has illegal code ${code}`);
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

function assertValidLayout(rows, label = 'layout') {
  const result = validate(rows);
  if (!result.ok) {
    throw new Error(`${label} invalid: ${result.errors.join('; ')}`);
  }
  return rows;
}

/**
 * Read a number, treating absent values as absent.
 *
 * Number(null) and Number('') are both 0, which would put a confident "0" on
 * the board where a field is simply missing. Missing data is not printed.
 */
function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Averages and similar get one decimal; a trailing ".0" is kept for rhythm. */
function formatAverage(value) {
  const number = toNumber(value);
  if (number === null) {
    return '';
  }
  return number.toFixed(1);
}

/** Temperatures, wind, pressure and ages are whole numbers. */
function formatWhole(value) {
  const number = toNumber(value);
  if (number === null) {
    return '';
  }
  return String(Math.round(number));
}

/** Counts over 9,999 abbreviate so they stop eating the row: 37,285 -> 37K. */
function formatCount(value) {
  const number = toNumber(value);
  if (number === null) {
    return '';
  }
  const rounded = Math.round(number);
  const magnitude = Math.abs(rounded);
  if (magnitude < 10000) {
    return String(rounded);
  }
  if (magnitude < 1000000) {
    return `${Math.round(rounded / 1000)}K`;
  }
  const millions = rounded / 1000000;
  const digits = Math.abs(millions) < 10 ? 1 : 0;
  return `${millions.toFixed(digits).replace(/\.0$/, '')}M`;
}

/** Count the flaps a frame actually uses, which is what dwell time keys off. */
function contentLength(rows) {
  let count = 0;
  for (const row of rows || []) {
    for (const code of row || []) {
      if (code !== BLANK) {
        count += 1;
      }
    }
  }
  return count;
}

module.exports = {
  ROWS,
  COLS,
  BLANK,
  CHIPS,
  UNUSED_CODES,
  LEGAL_CODES,
  drumOrder,
  CODE_BY_CHAR,
  CHAR_BY_CODE,
  fold,
  isLegalCode,
  encodeText,
  decodeCodes,
  wrap,
  truncate,
  blankRow,
  encodeRow,
  placeCodes,
  placeText,
  centerRow,
  validate,
  assertValidLayout,
  toNumber,
  formatAverage,
  formatWhole,
  formatCount,
  contentLength,
};
