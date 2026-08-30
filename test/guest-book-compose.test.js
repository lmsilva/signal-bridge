const test = require('node:test');
const assert = require('node:assert/strict');

const {
  layoutMessage,
  layoutRows,
  footerRows,
  footerRowsInPlace,
  stampInviteFooter,
  inviteScreenRows,
  wrapPreservingChips,
  blankBoard,
  FOOTER_CHIP_START,
} = require('../src/guest-book-compose');
const { CHIPS, decodeCodes } = require('../src/vestaboard/encoder');

test('a short message fits and the name becomes a signed line', () => {
  const layout = layoutMessage({ text: 'Hello house', name: 'Luis', align: 'center' });
  assert.equal(layout.ok, true);
  assert.equal(layout.usedRows, 2);
  assert.ok(layout.lines.includes('- LUIS'));
});

test('chip tokens count as one tile and survive wrap', () => {
  const lines = wrapPreservingChips('HI {R} THERE', 22);
  assert.equal(lines[0].includes('{R}'), true);
  const layout = layoutMessage({ text: 'HI {R} THERE' });
  assert.equal(layout.ok, true);
  const codes = layout.rows.flat();
  assert.ok(codes.includes(CHIPS.red));
});

test('a message that needs more than six rows is refused', () => {
  const line = 'XXXXXXXXXXXXXXXXXXXXXX';
  const layout = layoutMessage({
    text: Array.from({ length: 6 }, () => line).join(' '),
    name: 'Luis',
  });
  assert.equal(layout.ok, false);
  assert.match(layout.error, /does not fit/);
});

test('the invite footer pins a short message and adds chips plus the short link', () => {
  const layout = layoutMessage({ text: 'Hi', valign: 'middle' });
  const footer = footerRows(layout.rows, 'TINYURL.COM/WITTYBOARD');
  assert.ok(footer);
  assert.equal(FOOTER_CHIP_START, 8);
  assert.equal(footer[4][8], CHIPS.red);
  assert.equal(footer[4][14], CHIPS.white);
  assert.ok(footer[5].some((code) => code !== 0));
});

test('the invite screen is SIGN THE / GUEST BOOK plus the locked footer', () => {
  const rows = inviteScreenRows('TINYURL.COM/WITTYBOARD');
  assert.ok(rows);
  assert.equal(rows[0][7], 19); // S
  assert.equal(rows[1][6], 7); // G
  assert.equal(rows[2].every((code) => code === 0), true);
  assert.equal(rows[4][8], CHIPS.red);
  assert.equal(rows[5][0] !== 0, true);
});

test('the invite screen prints CODE ###### when a board code is set', () => {
  const rows = inviteScreenRows('TINYURL.COM/WITTYBOARD', { boardCode: '314159' });
  assert.ok(rows);
  assert.match(decodeCodes(rows[2]), /CODE 314159/);
  assert.equal(rows[4][8], CHIPS.red);
});

test('a painted grid with the invite locked only counts the guest rows', () => {
  const rows = blankBoard();
  rows[5][0] = CHIPS.yellow;
  assert.equal(layoutRows(rows, { editableRows: 4 }).ok, false);
  rows[1][3] = 8;
  const layout = layoutRows(rows, { editableRows: 4 });
  assert.equal(layout.ok, true);
  const stamped = stampInviteFooter(layout.rows, 'TINYURL.COM/WITTYBOARD');
  assert.equal(stamped[1][3], 8);
  assert.equal(stamped[4][8], CHIPS.red);
  assert.equal(stamped[5][0] !== CHIPS.yellow, true);
});

test('a newline starts a new row instead of wrapping onto one line', () => {
  const layout = layoutMessage({ text: 'HELLO\nWORLD', valign: 'top', align: 'left' });
  assert.equal(layout.ok, true);
  assert.deepEqual(layout.lines, ['HELLO', 'WORLD']);
  assert.equal(layout.rows[0].some((code) => code), true);
  assert.equal(layout.rows[1].some((code) => code), true);
});

test('a painted grid keeps every cell the guest placed', () => {
  const rows = blankBoard();
  rows[0][0] = CHIPS.yellow;
  rows[5][21] = CHIPS.yellow;
  rows[2][10] = 8; // H
  const layout = layoutRows(rows);
  assert.equal(layout.ok, true);
  assert.equal(layout.rows[0][0], CHIPS.yellow);
  assert.equal(layout.rows[5][21], CHIPS.yellow);
  assert.equal(layout.rows[2][10], 8);
});

test('a painted grid does not get a footer that would move the artwork', () => {
  const rows = blankBoard();
  rows[2][0] = 8;
  const footer = footerRowsInPlace(rows, 'TINYURL.COM/WITTYBOARD');
  assert.ok(footer);
  assert.equal(footer[2][0], 8);
  assert.ok(footer[4].some((code) => code === CHIPS.red));
});

test('a painted border is refused a footer because the last rows are used', () => {
  const rows = blankBoard();
  for (let c = 0; c < 22; c += 1) {
    rows[0][c] = CHIPS.red;
    rows[5][c] = CHIPS.red;
  }
  assert.equal(footerRowsInPlace(rows, 'TINYURL.COM/WITTYBOARD'), null);
});

test('illegal flap codes are refused', () => {
  const rows = blankBoard();
  rows[0][0] = 43;
  assert.equal(layoutRows(rows).ok, false);
});

test('a five-row message does not get an invite footer', () => {
  const line = 'XXXXXXXXXXXXXXXXXXXXXX';
  const layout = layoutMessage({
    text: Array.from({ length: 5 }, () => line).join(' '),
    valign: 'top',
  });
  assert.equal(layout.ok, true);
  assert.equal(layout.usedRows, 5);
  assert.equal(footerRows(layout.rows, 'TINYURL.COM/WITTYBOARD'), null);
});
