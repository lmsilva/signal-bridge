const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLS,
  BLANK,
  CHIPS,
  fold,
  isLegalCode,
  encodeText,
  decodeCodes,
  wrap,
  truncate,
  encodeRow,
  centerRow,
  validate,
  assertValidLayout,
  formatAverage,
  formatWhole,
  formatCount,
  contentLength,
  UNUSED_CODES,
} = require('../src/vestaboard/encoder');

const { parseLayout, formatLayout } = require('../src/vestaboard/notation');

function blankLayout() {
  return Array.from({ length: 6 }, () => new Array(COLS).fill(BLANK));
}

test('folding uppercases and leaves plain text alone', () => {
  assert.equal(fold('Hello World'), 'HELLO WORLD');
  assert.equal(fold('ALREADY LOUD'), 'ALREADY LOUD');
});

test('folding strips accents down to the base letter', () => {
  // The Upside archive is full of these; "SAO" is what the board can spell.
  assert.equal(fold('S\u00e3o Paulo'), 'SAO PAULO');
  assert.equal(fold('caf\u00e9'), 'CAFE');
  assert.equal(fold('Fran\u00e7ois'), 'FRANCOIS');
  assert.equal(fold('\u00c9L\u00c1N'), 'ELAN');
});

test('folding transliterates letters that have no decomposition', () => {
  // These survive uppercasing intact, so dropping them would eat a letter
  // in the middle of a word.
  assert.equal(fold('\u00c6ther'), 'AETHER');
  assert.equal(fold('\u00d8resund'), 'ORESUND');
  assert.equal(fold('stra\u00dfe'), 'STRASSE');
});

test('folding swaps typographic punctuation for what the board has', () => {
  assert.equal(fold('\u2018quoted\u2019'), "'QUOTED'");
  assert.equal(fold('\u201cquoted\u201d'), '"QUOTED"');
  assert.equal(fold('a \u2013 b'), 'A - B');
  assert.equal(fold('a \u2014 b'), 'A - B');
  assert.equal(fold('wait\u2026'), 'WAIT...');
  assert.equal(fold('a\u00a0b'), 'A B');
});

test('folding drops marks and emoji that have no flap', () => {
  // Straight from the Steam library cache.
  assert.equal(fold('Hot Wheels Unleashed\u2122'), 'HOT WHEELS UNLEASHED');
  assert.equal(fold('Acme\u00ae Corp\u00a9'), 'ACME CORP');
  assert.equal(fold('nice \ud83c\udfaf darts'), 'NICE DARTS');
  assert.equal(fold('a*b_c<d>e'), 'ABCDE');
});

test('folding collapses whitespace and trims', () => {
  assert.equal(fold('  too   many \n spaces  '), 'TOO MANY SPACES');
  assert.equal(fold(''), '');
  assert.equal(fold(null), '');
  assert.equal(fold(undefined), '');
});

test('digits map to the codes the board actually uses', () => {
  // 1-9 sit at 27-35 and zero trails at 36, which no one guesses right.
  assert.deepEqual(encodeText('123456789'), [27, 28, 29, 30, 31, 32, 33, 34, 35]);
  assert.deepEqual(encodeText('0'), [36]);
  assert.deepEqual(encodeText('A Z'), [1, 0, 26]);
});

test('the degree sign encodes rather than being dropped', () => {
  assert.deepEqual(encodeText('93\u00b0'), [35, 29, 62]);
});

test('decoding turns codes back into readable text', () => {
  assert.equal(decodeCodes(encodeText('HELLO WORLD')), 'HELLO WORLD');
  assert.equal(decodeCodes([CHIPS.red, 1]), ' A');
});

test('reserved codes are rejected even though they are in range', () => {
  for (const code of UNUSED_CODES) {
    assert.equal(isLegalCode(code), false, `${code} should be illegal`);
  }
  assert.equal(isLegalCode(0), true);
  assert.equal(isLegalCode(71), true);
  assert.equal(isLegalCode(72), false);
  assert.equal(isLegalCode(-1), false);
  assert.equal(isLegalCode(1.5), false);
});

test('wrapping breaks at spaces and never inside a word', () => {
  const lines = wrap('the quick brown fox jumps over the lazy dog', 18);
  for (const line of lines) {
    assert.ok(line.length <= 18, `"${line}" is ${line.length} long`);
    assert.equal(line, line.trim(), 'no leading or trailing spaces');
  }
  assert.equal(lines.join(' '), 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG');
});

test('wrapping fills each line greedily', () => {
  assert.deepEqual(wrap('aaa bbb ccc', 7), ['AAA BBB', 'CCC']);
  assert.deepEqual(wrap('aaa bbb ccc', 11), ['AAA BBB CCC']);
});

test('a word too long for the line splits with a trailing hyphen', () => {
  const lines = wrap('SUPERCALIFRAGILISTIC', 10);
  assert.deepEqual(lines, ['SUPERCALI-', 'FRAGILIST-', 'IC']);
  for (const line of lines) {
    assert.ok(line.length <= 10);
  }
});

test('wrapping empty text produces no lines at all', () => {
  assert.deepEqual(wrap('', 18), []);
  assert.deepEqual(wrap('   ', 18), []);
});

test('names truncate to their column with no ellipsis marker', () => {
  // A marker costs a flap and reads worse than a clean cut.
  assert.equal(truncate('MASTER BATHROOM ECHO', 13), 'MASTER BATHRO');
  assert.equal(truncate('SHORT', 13), 'SHORT');
  assert.equal(truncate('trashpanda', 13), 'TRASHPANDA');
});

test('a row encodes padded to the full width', () => {
  const row = encodeRow('HI');
  assert.equal(row.length, COLS);
  assert.deepEqual(row.slice(0, 2), [8, 9]);
  assert.ok(row.slice(2).every((code) => code === BLANK));
});

test('centering biases left on an odd remainder', () => {
  const row = centerRow('KYLIE');
  const first = row.findIndex((code) => code !== BLANK);
  assert.equal(first, Math.floor((COLS - 5) / 2));
  assert.equal(decodeCodes(row).trim(), 'KYLIE');
});

test('validation accepts a well formed layout', () => {
  assert.equal(validate(blankLayout()).ok, true);
});

test('validation catches wrong dimensions and illegal codes', () => {
  const short = blankLayout().slice(0, 5);
  assert.equal(validate(short).ok, false);

  const narrow = blankLayout();
  narrow[2] = narrow[2].slice(0, 21);
  assert.match(validate(narrow).errors.join(' '), /21 columns/);

  const illegal = blankLayout();
  illegal[0][0] = 99;
  assert.match(validate(illegal).errors.join(' '), /illegal code 99/);

  const reserved = blankLayout();
  reserved[1][3] = 43;
  assert.match(validate(reserved).errors.join(' '), /illegal code 43/);

  assert.equal(validate('nope').ok, false);
});

test('asserting a bad layout throws with the reason attached', () => {
  const bad = blankLayout();
  bad[0][0] = 200;
  assert.throws(() => assertValidLayout(bad, 'test frame'), /test frame invalid.*200/);
});

test('numbers format to the house rules', () => {
  assert.equal(formatAverage(26.44), '26.4');
  assert.equal(formatAverage(68), '68.0');
  assert.equal(formatWhole(92.6), '93');
  assert.equal(formatWhole('75'), '75');
  assert.equal(formatAverage('nope'), '');
});

test('a missing number prints nothing rather than a confident zero', () => {
  // Number(null) and Number('') are both 0, which would put "0" on the board
  // wherever a field is simply absent.
  for (const absent of [null, undefined, '', '   ', 'nope', NaN]) {
    assert.equal(formatWhole(absent), '', `formatWhole(${JSON.stringify(absent)})`);
    assert.equal(formatAverage(absent), '', `formatAverage(${JSON.stringify(absent)})`);
    assert.equal(formatCount(absent), '', `formatCount(${JSON.stringify(absent)})`);
  }
  assert.equal(formatWhole(0), '0', 'a real zero still prints');
  assert.equal(formatCount(0), '0');
});

test('counts abbreviate once they would start eating the row', () => {
  assert.equal(formatCount(707), '707');
  assert.equal(formatCount(9999), '9999');
  assert.equal(formatCount(37285), '37K');
  assert.equal(formatCount(1482), '1482');
  assert.equal(formatCount(2400000), '2.4M');
  assert.equal(formatCount(15000000), '15M');
});

test('content length counts only the flaps that are not blank', () => {
  const layout = blankLayout();
  assert.equal(contentLength(layout), 0);
  layout[0] = encodeRow('HELLO');
  assert.equal(contentLength(layout), 5);
});

test('notation parses chips as chips and everything else literally', () => {
  const rows = parseLayout([
    'gg SHOPPING LIST    gg',
    ' COMPANY Q. TEN',
    ' EGGS',
    '',
    '',
    'gg 2 ITEMS          gg',
  ].join('\n'));

  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.length === COLS));
  assert.deepEqual(rows[0].slice(0, 2), [CHIPS.green, CHIPS.green]);
  assert.equal(decodeCodes(rows[1]).trim(), 'COMPANY Q. TEN');
  assert.ok(rows[3].every((code) => code === BLANK));
});

test('notation round trips back to the same drawing', () => {
  const drawing = [
    'ww SIGNAL BRIDGE    ww',
    '',
    '  VESTABOARD LINKED',
    '  KITCHEN BOARD - OK',
    '',
    ' roygbvw    roygbvw',
  ].join('\n');

  assert.equal(formatLayout(parseLayout(drawing)), drawing);
});

test('notation refuses a row that would run off the board', () => {
  assert.throws(
    () => parseLayout(['x'.repeat(23), '', '', '', '', ''].join('\n')),
    /23 columns/,
  );
});

test('notation refuses a character the board cannot show', () => {
  assert.throws(
    () => parseLayout(['A*B', '', '', '', '', ''].join('\n')),
    /no flap/,
  );
});

test('every layout the notation produces passes validation', () => {
  const rows = parseLayout([
    'rr TESLA MODEL Y    rr',
    'BATT 73%  RANGE 201MI',
    'PARKED - NOT PLUGGED',
    'IN 88\u00b0  OUT 91\u00b0',
    'LOCKED - SENTRY ON',
    'rr 2:38PM           rr',
  ].join('\n'));

  assert.equal(validate(rows).ok, true);
});
