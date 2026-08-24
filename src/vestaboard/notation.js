// The layout notation used by the requirements and the golden fixtures.
//
// A frame is written as six lines of up to 22 characters. Lowercase letters
// are colour chips, everything else is the literal character on that flap, and
// short lines pad with blanks. It exists so a fixture reads like the layout
// drawing in the spec instead of a wall of integers:
//
//   gg SHOPPING LIST    gg
//    COMPANY Q. TEN
//    EGGS
//
//
//   gg 2 ITEMS          gg
//
// Specs and fixtures only. At runtime everything is code arrays.

const {
  ROWS,
  COLS,
  BLANK,
  CHIPS,
  CODE_BY_CHAR,
  CHAR_BY_CODE,
} = require('./encoder');

const CHIP_BY_LETTER = new Map([
  ['r', CHIPS.red],
  ['o', CHIPS.orange],
  ['y', CHIPS.yellow],
  ['g', CHIPS.green],
  ['b', CHIPS.blue],
  ['v', CHIPS.violet],
  ['w', CHIPS.white],
  ['k', CHIPS.black],
  ['f', CHIPS.filled],
]);

const LETTER_BY_CHIP = new Map(
  [...CHIP_BY_LETTER].map(([letter, code]) => [code, letter]),
);

/**
 * Parse notation text into a 6x22 code layout.
 *
 * Throws on anything ambiguous — a row that runs past 22 columns, the wrong
 * number of rows, or a character with no flap — because a fixture that quietly
 * parses into the wrong thing would make its test meaningless.
 */
function parseLayout(text, { label = 'layout' } = {}) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  // Allow the leading and trailing newline you get from a template literal.
  while (lines.length && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // A frame's blank rows are meaningful, so only pad a layout that is short.
  while (lines.length < ROWS) {
    lines.push('');
  }
  if (lines.length !== ROWS) {
    throw new Error(`${label}: expected ${ROWS} rows, got ${lines.length}`);
  }

  return lines.map((line, index) => {
    if (line.length > COLS) {
      throw new Error(
        `${label}: row ${index} is ${line.length} columns, max ${COLS} (${JSON.stringify(line)})`,
      );
    }

    const row = new Array(COLS).fill(BLANK);
    for (let column = 0; column < line.length; column += 1) {
      const char = line[column];
      if (CHIP_BY_LETTER.has(char)) {
        row[column] = CHIP_BY_LETTER.get(char);
        continue;
      }
      const code = CODE_BY_CHAR.get(char.toUpperCase());
      if (code === undefined) {
        throw new Error(
          `${label}: row ${index} column ${column} has no flap for ${JSON.stringify(char)}`,
        );
      }
      row[column] = code;
    }
    return row;
  });
}

/** Render a code layout back into notation, for test failure messages. */
function formatLayout(rows) {
  return (rows || [])
    .map((row) => (row || [])
      .map((code) => {
        if (LETTER_BY_CHIP.has(code)) {
          return LETTER_BY_CHIP.get(code);
        }
        return CHAR_BY_CODE.get(code) ?? '?';
      })
      .join('')
      .replace(/\s+$/, ''))
    .join('\n');
}

module.exports = {
  CHIP_BY_LETTER,
  LETTER_BY_CHIP,
  parseLayout,
  formatLayout,
};
