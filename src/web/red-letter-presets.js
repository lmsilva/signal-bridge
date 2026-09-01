/**
 * Shared Red Letter day-of themes — the painted 6x22 starting points behind
 * the admin designer and the household event editor.
 *
 * A line is one board row: `.` blank, `#` a flap the message flows into,
 * anything else a chip letter from `CHIP_LETTERS`.
 */
(function (root) {
  const ROWS = 6;
  const COLS = 22;
  const MESSAGE_CELL = -1;
  const CHIPS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white', 'black', 'filled'];

  const CHIP_LETTERS = {
    r: 'red', o: 'orange', y: 'yellow', g: 'green', b: 'blue', v: 'violet', w: 'white', k: 'black', f: 'filled',
  };

  // `confetti` is the house Day Of look (rails + message slots).
  const PRESETS = {
    blank: [
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
    ],
    heart: [
      '..rrr..rrr............',
      'rrwrrrrrrr.###########',
      'rrrrrrrrrr.###########',
      '.rrrrrrrr..###########',
      '..rrrrrr...###########',
      '....rr................',
    ],
    confetti: [
      'rvwrvwrvwrvwrvwrvwrvwr',
      '######################',
      '######################',
      '######################',
      '######################',
      'wrvwrvwrvwrvwrvwrvwrvw',
    ],
    halloween: [
      '..ooooo...............',
      '.ooooooo.#############',
      '.oykkkyo.#############',
      '.oykykyo.#############',
      '.okyyyko.#############',
      '..ooooo...............',
    ],
    summer: [
      'y.y...y.y.............',
      '.y..yyy..y.###########',
      '..yyyyyyy..###########',
      '.y.yyyyy.y.###########',
      'y..yyy..y..###########',
      'ggyoyoyoyggg..........',
    ],
    beach: [
      'g.....ww..............',
      'gg...wwww.............',
      'fgg.bwbwbw.###########',
      'f..wbwbwbw.###########',
      '..yyyyyyyy.###########',
      '.yyyyyyyyyy...........',
    ],
    christmas: [
      '.....w................',
      '....grg.##############',
      '...grgrg.#############',
      '..grgrgrg.############',
      '.grgrgrgrg.###########',
      '....fff...............',
    ],
    autumn: [
      'r.y.o.................',
      '.oyo.r.y.#############',
      'royyoyr..#############',
      '.rorror.y#############',
      'y.ror.o...............',
      '..fff.y.o.............',
    ],
    border: [
      'rrrrrrrrrrrrrrrrrrrrrr',
      'r####################r',
      'r####################r',
      'r####################r',
      'r####################r',
      'rrrrrrrrrrrrrrrrrrrrrr',
    ],
  };

  function presetCells(name) {
    const lines = PRESETS[name] || PRESETS.blank;
    return Array.from({ length: ROWS }, (_, row) => (
      Array.from({ length: COLS }, (_, col) => {
        const letter = lines[row]?.[col] || '.';
        if (letter === '#') return MESSAGE_CELL;
        const chip = CHIP_LETTERS[letter];
        return chip ? 63 + CHIPS.indexOf(chip) : 0;
      })
    ));
  }

  function cloneCells(cells) {
    return Array.from({ length: ROWS }, (_, row) => (
      Array.from({ length: COLS }, (_, col) => Number(cells?.[row]?.[col] ?? 0))
    ));
  }

  function cellsEqual(a, b) {
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if (Number(a?.[row]?.[col] ?? 0) !== Number(b?.[row]?.[col] ?? 0)) {
          return false;
        }
      }
    }
    return true;
  }

  /** Name of the theme a saved layout came from, or '' when it was hand-painted. */
  function matchPreset(cells) {
    if (!Array.isArray(cells) || !cells.length) {
      return '';
    }
    return Object.keys(PRESETS).find((name) => cellsEqual(cells, presetCells(name))) || '';
  }

  root.RED_LETTER_PRESETS = {
    ROWS,
    COLS,
    MESSAGE_CELL,
    CHIPS,
    CHIP_LETTERS,
    PRESETS,
    presetCells,
    cloneCells,
    cellsEqual,
    matchPreset,
  };
})(typeof window !== 'undefined' ? window : globalThis);
