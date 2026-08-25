// The two frame shapes every board screen is built from.
//
// Info frames (badgeFrame) carry state: a titled header, up to four content
// rows, and a footer for timestamps or a page counter. Alert frames
// (borderFrame) carry moments: a solid colour border around a few lines of
// text, which reads across a room.
//
// Pure functions. Every builder returns a validated 6x22 code layout.

const {
  ROWS,
  COLS,
  BLANK,
  CHIPS,
  encodeText,
  blankRow,
  placeCodes,
  placeText,
  truncate,
  assertValidLayout,
  contentLength,
} = require('./encoder');

const { dateParts } = require('./clock');

// Badge frames keep chips in both top and bottom corners, so the title and
// footer live in the middle. Content spans columns 3..18 inclusive.
const BADGE_TEXT_FROM = 3;
const BADGE_TEXT_TO = 18;
const BADGE_TEXT_WIDTH = BADGE_TEXT_TO - BADGE_TEXT_FROM + 1;

// Content rows inset one column on each side so nothing crowds the edge.
const BODY_FROM = 1;
const BODY_TO = COLS - 2;

// Border frames lose a column to the chip on each side, plus one space of
// padding, leaving 18 usable characters.
const BORDER_TEXT_FROM = 2;
const BORDER_TEXT_WIDTH = 18;

const MAX_BODY_ROWS = 4;

const DWELL_CAP_SECONDS = 30;
const ALERT_DWELL_SECONDS = 60;

function chipCode(color) {
  if (typeof color === 'number') {
    return color;
  }
  const code = CHIPS[String(color || '').toLowerCase()];
  if (code === undefined) {
    throw new Error(`unknown chip colour ${JSON.stringify(color)}`);
  }
  return code;
}

/**
 * One row with text on the left and text pushed to the right.
 *
 * Used for timer countdowns, sensor readings and anything else that reads as a
 * label and a value. Throws when the two would touch, because a silently
 * overlapping row is worse on a board than a loud failure in a test.
 */
function lr(left, right, options = {}) {
  const from = options.from ?? BODY_FROM;
  const to = options.to ?? BODY_TO;
  const row = options.row || blankRow(COLS);

  const leftCodes = encodeText(left);
  const rightCodes = encodeText(right);
  const span = to - from + 1;

  if (leftCodes.length + rightCodes.length + (rightCodes.length ? 1 : 0) > span) {
    throw new Error(
      `lr row overflows: "${left}" + "${right}" needs `
      + `${leftCodes.length + rightCodes.length + 1} of ${span} columns`,
    );
  }

  placeCodes(row, leftCodes, from);
  if (rightCodes.length) {
    placeCodes(row, rightCodes, to - rightCodes.length + 1);
  }
  return row;
}

/**
 * Centre text within a span. An odd remainder puts the extra blank on the
 * left, which is how the spec draws a short centred alert.
 */
function centered(text, options = {}) {
  const from = options.from ?? BORDER_TEXT_FROM;
  const width = options.width ?? BORDER_TEXT_WIDTH;
  const row = options.row || blankRow(COLS);
  const codes = encodeText(text).slice(0, width);
  const start = from + Math.ceil((width - codes.length) / 2);
  return placeCodes(row, codes, start);
}

/** `1/3`, for paginated content. Returns '' for a single page. */
function pageCounter(page, total) {
  if (!Number.isFinite(page) || !Number.isFinite(total) || total <= 1) {
    return '';
  }
  return `${page}/${total}`;
}

/**
 * Turn one body-row description into a row of codes.
 *
 * Accepts a plain string (indented one column), an already-built code row, or
 * an object for the label-and-value and centred cases.
 */
function bodyRow(entry) {
  if (entry === null || entry === undefined || entry === '') {
    return blankRow(COLS);
  }

  if (Array.isArray(entry)) {
    if (entry.length !== COLS) {
      throw new Error(`body row has ${entry.length} columns, expected ${COLS}`);
    }
    return [...entry];
  }

  if (typeof entry === 'string') {
    const row = blankRow(COLS);
    return placeText(row, entry, BODY_FROM);
  }

  if (typeof entry === 'object') {
    if (entry.center !== undefined) {
      return centered(entry.center, { from: 0, width: COLS });
    }
    const row = blankRow(COLS);
    const from = entry.indent ?? BODY_FROM;
    const to = entry.to ?? BODY_TO;
    if (entry.right !== undefined && entry.right !== '') {
      return lr(entry.left ?? '', entry.right, { from, to, row });
    }
    return placeText(row, entry.left ?? entry.text ?? '', from);
  }

  throw new Error(`unsupported body row ${JSON.stringify(entry)}`);
}

/**
 * The info frame: chips in all four corners, a title, up to four content rows,
 * and a footer.
 *
 * Title and footer text is cut to fit rather than allowed to run into the
 * chips — these are labels, and a label that pushes a chip off the board would
 * change what the frame means.
 */
function badgeFrame({
  color,
  title = '',
  titleRight = '',
  rows = [],
  footerLeft = '',
  footerRight = '',
} = {}) {
  const chip = chipCode(color);

  if (rows.length > MAX_BODY_ROWS) {
    throw new Error(`badge frame takes at most ${MAX_BODY_ROWS} rows, got ${rows.length}`);
  }

  const cornerRow = (left, right) => {
    const row = blankRow(COLS);
    row[0] = chip;
    row[1] = chip;
    row[COLS - 2] = chip;
    row[COLS - 1] = chip;

    const rightText = truncate(right, BADGE_TEXT_WIDTH);
    const rightCodes = encodeText(rightText);
    // The left label yields whatever the right-hand text needs, plus a gap.
    const leftRoom = rightCodes.length
      ? BADGE_TEXT_WIDTH - rightCodes.length - 1
      : BADGE_TEXT_WIDTH;
    placeText(row, truncate(left, Math.max(0, leftRoom)), BADGE_TEXT_FROM);
    if (rightCodes.length) {
      placeCodes(row, rightCodes, BADGE_TEXT_TO - rightCodes.length + 1);
    }
    return row;
  };

  const layout = [cornerRow(title, titleRight)];
  for (let i = 0; i < MAX_BODY_ROWS; i += 1) {
    layout.push(bodyRow(rows[i]));
  }
  layout.push(cornerRow(footerLeft, footerRight));

  return assertValidLayout(layout, 'badge frame');
}

/**
 * The alert frame: a solid border of one colour around up to four lines.
 *
 * `more` marks a frame that continues into the next one by turning the
 * bottom-right border chip yellow — the only hint a board can give that a
 * message is not finished.
 */
function borderFrame({
  color,
  lines = [],
  more = false,
  align = 'left',
  indent = 0,
} = {}) {
  const chip = chipCode(color);
  const content = lines.filter((line) => line !== null && line !== undefined);

  if (content.length > MAX_BODY_ROWS) {
    throw new Error(`border frame takes at most ${MAX_BODY_ROWS} lines, got ${content.length}`);
  }

  const edge = new Array(COLS).fill(chip);
  const layout = [edge];

  for (let i = 0; i < MAX_BODY_ROWS; i += 1) {
    const row = blankRow(COLS);
    row[0] = chip;
    row[COLS - 1] = chip;

    const text = content[i];
    if (text) {
      const from = BORDER_TEXT_FROM + indent;
      const width = BORDER_TEXT_WIDTH - indent;
      if (align === 'center') {
        centered(text, { from, width, row });
      } else {
        placeCodes(row, encodeText(text).slice(0, width), from);
      }
    }
    layout.push(row);
  }

  const bottom = new Array(COLS).fill(chip);
  if (more) {
    bottom[COLS - 1] = CHIPS.yellow;
  }
  layout.push(bottom);

  return assertValidLayout(layout, 'border frame');
}

/**
 * A battery-style bar: parens around 18 slots, filled left to right.
 *
 * Returns codes rather than a whole row so a caller can place it where the
 * layout needs it.
 */
function gauge(filled, total = 18, color = 'green') {
  const slots = Math.max(1, Math.floor(total));
  const lit = Math.max(0, Math.min(slots, Math.round(filled)));
  const chip = chipCode(color);

  const codes = [...encodeText('(')];
  for (let i = 0; i < slots; i += 1) {
    codes.push(i < lit ? chip : BLANK);
  }
  codes.push(...encodeText(')'));
  return codes;
}

// Three-wide, five-tall digits, drawn with chips. Anything narrower stops
// reading as a number from across a room.
const BLOCK_DIGITS = {
  0: ['###', '# #', '# #', '# #', '###'],
  1: ['  #', '  #', '  #', '  #', '  #'],
  2: ['###', '  #', '###', '#  ', '###'],
  3: ['###', '  #', '###', '  #', '###'],
  4: ['# #', '# #', '###', '  #', '  #'],
  5: ['###', '#  ', '###', '  #', '###'],
  6: ['###', '#  ', '###', '# #', '###'],
  7: ['###', '  #', '  #', '  #', '  #'],
  8: ['###', '# #', '###', '# #', '###'],
  9: ['###', '# #', '###', '  #', '###'],
};

// Column where each element of the clock face starts.
const CLOCK_COLUMNS = {
  hourTens: 0,
  hourOnes: 4,
  colon: 8,
  minuteTens: 10,
  minuteOnes: 14,
  meridiem: 18,
};

function placeBlockDigit(layout, digit, column, chip) {
  const pattern = BLOCK_DIGITS[digit];
  if (!pattern) {
    return;
  }
  pattern.forEach((line, rowIndex) => {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '#') {
        layout[rowIndex][column + i] = chip;
      }
    }
  });
}

/**
 * The clock face: four block digits with a colon between them and the
 * meridiem beside the last row. The tens-of-hours slot stays blank before
 * 10 o'clock rather than showing a leading zero.
 */
function blockTime(date, { footer = '', color = 'white', footerColor = 'white', timeZone } = {}) {
  const chip = chipCode(color);
  const when = date instanceof Date ? date : new Date(date);
  const parts = dateParts(when, timeZone) || dateParts(when);

  let hours = parts.hour;
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours %= 12;
  if (hours === 0) {
    hours = 12;
  }
  const minutes = parts.minute;

  const digits = Array.from({ length: 5 }, () => blankRow(COLS));

  if (hours >= 10) {
    placeBlockDigit(digits, Math.floor(hours / 10), CLOCK_COLUMNS.hourTens, chip);
  }
  placeBlockDigit(digits, hours % 10, CLOCK_COLUMNS.hourOnes, chip);
  placeBlockDigit(digits, Math.floor(minutes / 10), CLOCK_COLUMNS.minuteTens, chip);
  placeBlockDigit(digits, minutes % 10, CLOCK_COLUMNS.minuteOnes, chip);

  digits[1][CLOCK_COLUMNS.colon] = CHIPS.yellow;
  digits[3][CLOCK_COLUMNS.colon] = CHIPS.yellow;

  placeText(digits[3], meridiem, CLOCK_COLUMNS.meridiem);

  const footerChip = chipCode(footerColor);
  const footerRow = blankRow(COLS);
  footerRow[0] = footerChip;
  footerRow[1] = footerChip;
  footerRow[COLS - 2] = footerChip;
  footerRow[COLS - 1] = footerChip;
  placeText(footerRow, truncate(footer, BADGE_TEXT_WIDTH), BADGE_TEXT_FROM);

  return assertValidLayout([...digits, footerRow], 'clock frame');
}

/**
 * How long a frame should hold.
 *
 * Long frames need longer than short ones to read, so dwell scales with the
 * number of flaps actually in use, floored at the board's configured dwell and
 * capped so nothing sits forever.
 */
function dwellFor(rows, { base = 15, cap = DWELL_CAP_SECONDS } = {}) {
  const readingSeconds = Math.ceil(contentLength(rows) / 10);
  return Math.min(cap, Math.max(base, readingSeconds));
}

module.exports = {
  ROWS,
  COLS,
  BADGE_TEXT_FROM,
  BADGE_TEXT_TO,
  BADGE_TEXT_WIDTH,
  BODY_FROM,
  BODY_TO,
  BORDER_TEXT_FROM,
  BORDER_TEXT_WIDTH,
  MAX_BODY_ROWS,
  ALERT_DWELL_SECONDS,
  DWELL_CAP_SECONDS,
  BLOCK_DIGITS,
  CLOCK_COLUMNS,
  chipCode,
  lr,
  centered,
  pageCounter,
  bodyRow,
  badgeFrame,
  borderFrame,
  gauge,
  blockTime,
  dwellFor,
};
