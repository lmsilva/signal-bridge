#!/usr/bin/env node
/**
 * Build the shipped Vestaboard Artwork templates.
 *
 * Source: simulator screenshots of each design, decoded back into flap codes.
 *
 *   node tools/build-vestaboard-artwork.js <screenshot-dir>
 *
 * Each screenshot is a crop of the 22x6 board. Blank flaps render as bare
 * background, so they leave nothing to detect: the row lattice comes from the
 * painted rows (every design paints all six) and the column lattice is anchored
 * on the board sitting centred in the crop. Every decode is printed as an ASCII
 * grid so a human can compare it against the screenshot before committing.
 *
 * Characters cannot be read back from pixels, so a cell that holds a glyph
 * rather than a solid chip is reported and supplied by `TEXT_ROWS` below.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  ROWS, COLS, CHIPS, encodeText, decodeCodes, validate,
} = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'vestaboard-artwork-designs.json');

// Flap face colours, straight from src/web/vestaboard-bezel.css.
const PALETTE = {
  [CHIPS.red]: [0xe0, 0x3c, 0x31],
  [CHIPS.orange]: [0xf5, 0x82, 0x20],
  [CHIPS.yellow]: [0xff, 0xd2, 0x00],
  [CHIPS.green]: [0x22, 0xa2, 0x4b],
  [CHIPS.blue]: [0x0f, 0x62, 0xc8],
  [CHIPS.violet]: [0x7b, 0x3f, 0x98],
  [CHIPS.white]: [0xf2, 0xf2, 0xf2],
  [CHIPS.filled]: [0x6e, 0x6e, 0x6e],
};

const LEGEND = {
  0: '.',
  [CHIPS.red]: 'R',
  [CHIPS.orange]: 'O',
  [CHIPS.yellow]: 'Y',
  [CHIPS.green]: 'G',
  [CHIPS.blue]: 'B',
  [CHIPS.violet]: 'V',
  [CHIPS.white]: 'W',
  [CHIPS.black]: 'K',
  [CHIPS.filled]: 'F',
};

// A flap cell is much taller than it is wide. Measured off every screenshot,
// the column pitch is a fixed fraction of the row pitch.
const PITCH_RATIO = 0.694;

// How close a pixel must sit to a flap colour to count as that chip.
const COLOUR_TOLERANCE = 62;
// A solid chip fills its flap face; a glyph only inks a little of it.
const CHIP_COVERAGE = 0.55;
const GLYPH_COVERAGE = 0.06;
// How far below the rails beside it a dark cell must sit to be a black chip.
// Measured margins are 9 or more; a blank flap matches its rails exactly.
const BLACK_MARGIN = 5;

const DESIGNS = [
  { id: 'art-mountains', name: 'Mountains', hash: '37b8d38d' },
  { id: 'art-american-flag', name: 'American Flag', hash: '1830ad19' },
  { id: 'art-japanese-heart', name: 'Japanese Heart', hash: '2d0ce9d7' },
  { id: 'art-key-to-heart', name: 'Key to Heart', hash: '23950a07' },
  { id: 'art-turkey', name: 'Turkey', hash: 'dee59445' },
  { id: 'art-psychedelic-heart', name: 'Psychedelic Heart', hash: '1490689c' },
  { id: 'art-school-bus', name: 'School Bus', hash: '00522dfd' },
  { id: 'art-winter', name: 'Winter', hash: '4874f850' },
  { id: 'art-cute-bird', name: 'Cute Bird', hash: '43097cd8' },
  { id: 'art-christmas-house', name: 'Christmas House', hash: 'a0dfdecb' },
  { id: 'art-cute-beaver', name: 'Cute Beaver', hash: 'ab7232a8' },
];

// Text the decoder cannot read back. `col` is where the word starts.
const TEXT_ROWS = {
  'art-japanese-heart': [
    { row: 1, col: 1, text: 'MOTTO' },
    { row: 2, col: 1, text: 'AISHITERU' },
    { row: 3, col: 1, text: 'YO!' },
  ],
};

// Column shifts applied after the centred fit, for designs whose painted area
// leaves whole columns empty on both sides (the fit cannot tell 2+2 from 1+3).
const COLUMN_NUDGE = {};

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Nearest solid flap colour, or null when the pixel is background. */
function classify(r, g, b) {
  let best = null;
  let bestD = Infinity;
  for (const code of Object.keys(PALETTE)) {
    const d = dist2([r, g, b], PALETTE[code]);
    if (d < bestD) { bestD = d; best = Number(code); }
  }
  return Math.sqrt(bestD) <= COLOUR_TOLERANCE ? best : null;
}

/** Contiguous stretches of indexes whose histogram bucket is non-zero. */
function runs(hist) {
  const out = [];
  let start = -1;
  for (let i = 0; i < hist.length; i += 1) {
    const on = hist[i] > 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, hist.length - 1]);
  return out;
}

function centres(list) {
  return list.map(([a, b]) => (a + b) / 2);
}

function mean(list) {
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

async function decode(file, design) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const mask = new Uint8Array(width * height);
  const colHist = new Uint32Array(width);
  const rowHist = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      if (classify(data[i], data[i + 1], data[i + 2]) != null) {
        mask[y * width + x] = 1;
        colHist[x] += 1;
        rowHist[y] += 1;
      }
    }
  }

  // Rows: every design paints all six, so the runs map straight onto them.
  const rowRuns = runs(rowHist);
  if (rowRuns.length !== ROWS) {
    throw new Error(`${design.id}: found ${rowRuns.length} row bands, expected ${ROWS}`);
  }
  const rowCentres = centres(rowRuns);
  const pitchY = (rowCentres[ROWS - 1] - rowCentres[0]) / (ROWS - 1);

  // Columns: take the pitch from gaps that look like one flap step, ignoring
  // the narrow runs that thin glyph strokes produce.
  const colRuns = runs(colHist);
  const colCentres = centres(colRuns);
  const guess = pitchY * PITCH_RATIO;
  const steps = colCentres.slice(1)
    .map((v, i) => v - colCentres[i])
    .filter((d) => d > guess * 0.75 && d < guess * 1.25);
  const pitchX = steps.length ? mean(steps) : guess;

  // Lock the lattice onto the flap faces themselves. A face run is about half a
  // pitch wide; anything narrower is a glyph stroke and anything wider is two
  // colours the mask could not separate, so neither is trusted for the fit.
  const faces = colRuns
    .filter(([a, b]) => {
      const w = b - a + 1;
      return w >= pitchX * 0.34 && w <= pitchX * 0.8;
    })
    .map(([a, b]) => (a + b) / 2);
  if (!faces.length) throw new Error(`${design.id}: no flap faces to fit the columns on`);

  // Circular mean of the centres modulo the pitch: the sub-pixel phase every
  // column shares. Averaging as angles keeps runs either side of the wrap.
  const angles = faces.map((c) => ((c % pitchX) / pitchX) * 2 * Math.PI);
  const phase = (() => {
    const s = mean(angles.map(Math.sin));
    const c = mean(angles.map(Math.cos));
    let a = Math.atan2(s, c);
    if (a < 0) a += 2 * Math.PI;
    return (a / (2 * Math.PI)) * pitchX;
  })();

  // The phase fixes where the columns sit; the board being centred in the crop
  // picks which of those positions is column zero.
  const centred = (width - COLS * pitchX) / 2 + pitchX / 2;
  const nudge = COLUMN_NUDGE[design.id] || 0;
  const originX = phase + (Math.round((centred - phase) / pitchX) + nudge) * pitchX;

  const indexes = faces.map((c) => Math.round((c - originX) / pitchX));
  const stray = indexes.filter((i) => i < 0 || i >= COLS);
  if (stray.length) {
    throw new Error(`${design.id}: ${stray.length} flap faces fall outside the 22 columns`
      + ` (${stray.join(', ')}) — adjust COLUMN_NUDGE`);
  }

  /** Mean luminance of a box, used to separate a black chip from a blank. */
  function luminance(cx, cy, halfW, halfH) {
    let sum = 0;
    let n = 0;
    for (let y = Math.round(cy - halfH); y <= Math.round(cy + halfH); y += 1) {
      for (let x = Math.round(cx - halfW); x <= Math.round(cx + halfW); x += 1) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * channels;
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        n += 1;
      }
    }
    return n ? sum / n : 0;
  }

  const cells = [];
  const glyphs = [];
  let blacks = 0;
  const halfH = Math.max(1, Math.round(pitchY * 0.22));
  const halfW = Math.max(1, Math.round(pitchX * 0.24));
  for (let row = 0; row < ROWS; row += 1) {
    const out = new Array(COLS).fill(0);
    const cy = rowCentres[row];
    for (let col = 0; col < COLS; col += 1) {
      const cx = originX + col * pitchX;
      const tally = new Map();
      let total = 0;
      for (let y = Math.round(cy - halfH); y <= Math.round(cy + halfH); y += 1) {
        for (let x = Math.round(cx - halfW); x <= Math.round(cx + halfW); x += 1) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = (y * width + x) * channels;
          const code = classify(data[i], data[i + 1], data[i + 2]);
          total += 1;
          if (code != null) tally.set(code, (tally.get(code) || 0) + 1);
        }
      }
      let top = 0;
      let topCode = 0;
      for (const [code, n] of tally) {
        if (n > top) { top = n; topCode = code; }
      }
      const coverage = total ? top / total : 0;
      if (coverage >= CHIP_COVERAGE) {
        out[col] = topCode;
        continue;
      }
      // A blank flap shows whatever the page is doing behind the board, so it
      // reads the same as the rails either side of it. A black chip is a painted
      // face and sits clearly darker than both.
      const cell = luminance(cx, cy, halfW, halfH);
      const rail = Math.min(
        luminance(cx - pitchX * 0.5, cy, 1, halfH),
        luminance(cx + pitchX * 0.5, cy, 1, halfH),
      );
      if (cell < rail - BLACK_MARGIN) {
        out[col] = CHIPS.black;
        blacks += 1;
      } else if (coverage >= GLYPH_COVERAGE) {
        glyphs.push({ row, col, coverage: +coverage.toFixed(2) });
      }
    }
    cells.push(out);
  }

  return {
    cells, glyphs, blacks, pitchX, pitchY, width, height,
  };
}

function render(cells) {
  return cells
    .map((row) => row.map((code) => LEGEND[code] ?? decodeCodes([code])).join(''))
    .join('\n  ');
}

/** Draw a decoded grid so it can be held up against the screenshot. */
async function writePreview(cells, file) {
  const cell = 24;
  const gap = 3;
  const w = COLS * cell;
  const h = ROWS * cell;
  const buf = Buffer.alloc(w * h * 3, 0x14);
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const code = cells[row][col];
      if (code === 0) continue;
      // Characters get a dim face so the preview shows where the text sits.
      const rgb = PALETTE[code]
        || (code === CHIPS.black ? [0x10, 0x10, 0x13] : [0x55, 0x55, 0x58]);
      for (let y = row * cell + gap; y < (row + 1) * cell - gap; y += 1) {
        for (let x = col * cell + gap; x < (col + 1) * cell - gap; x += 1) {
          const i = (y * w + x) * 3;
          [buf[i], buf[i + 1], buf[i + 2]] = rgb;
        }
      }
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(file);
}

(async () => {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node tools/build-vestaboard-artwork.js <screenshot-dir>');
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  const previewDir = process.argv[3] || '';
  if (previewDir) fs.mkdirSync(previewDir, { recursive: true });
  const designs = [];

  for (const design of DESIGNS) {
    const match = files.find((name) => name.includes(`_images_image-${design.hash}`));
    if (!match) throw new Error(`${design.id}: no screenshot matching ${design.hash}`);
    // eslint-disable-next-line no-await-in-loop
    const decoded = await decode(path.join(dir, match), design);
    const { cells, glyphs } = decoded;

    for (const line of TEXT_ROWS[design.id] || []) {
      const codes = encodeText(line.text);
      codes.forEach((code, i) => {
        const col = line.col + i;
        if (col < COLS) cells[line.row][col] = code;
      });
    }

    const check = validate(cells);
    if (!check.ok) throw new Error(`${design.id}: ${check.errors.join('; ')}`);

    if (previewDir) {
      // eslint-disable-next-line no-await-in-loop
      await writePreview(cells, path.join(previewDir, `${design.id}.png`));
    }

    const painted = cells.flat().filter((code) => code !== 0).length;
    console.log(`\n${design.name}  (${design.id})`);
    console.log(`  pitch ${decoded.pitchX.toFixed(2)}x${decoded.pitchY.toFixed(2)}`
      + ` crop ${decoded.width}x${decoded.height} painted ${painted}/${ROWS * COLS}`
      + ` black ${decoded.blacks}`);
    console.log(`  ${render(cells)}`);
    const unresolved = glyphs.filter((g) => cells[g.row][g.col] === 0);
    if (unresolved.length) {
      console.log(`  GLYPH CELLS (need text): ${unresolved
        .map((g) => `r${g.row}c${g.col}@${g.coverage}`).join(' ')}`);
    }

    designs.push({ id: design.id, name: design.name, cells });
  }

  const payload = {
    source: 'simulator screenshots, decoded to flap codes',
    note: 'Shipped Vestaboard Artwork templates. Edit in the portal, not here.',
    builtAt: new Date().toISOString(),
    rows: ROWS,
    cols: COLS,
    count: designs.length,
    designs,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${designs.length} designs -> ${path.relative(process.cwd(), OUT)}`);
})();
