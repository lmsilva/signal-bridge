const { fold, wrap, blankRow, COLS } = require('./vestaboard/encoder');
const { centered, chipCode } = require('./vestaboard/frames');

const BODY_ROWS = 6;
const TITLE = 'VERSE OF THE DAY';
const BODY_SLOTS = 4;
// Three frames covers the marketplace-length verse (Romans 1:20). A fourth is
// only there so a long favourite like Philippians 4:8 does not have to be cut.
const MAX_PAGES = 4;
const REF_FROM = 1;
const REF_WIDTH = 20;

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanReference(value) {
  return String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function referenceLabel(reference) {
  const folded = fold(cleanReference(reference));
  if (!folded || folded.length > REF_WIDTH) {
    return '';
  }
  return folded;
}

function verseLines(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, COLS);
}

function titleChipRow(text = TITLE) {
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

function referenceChipRow(reference) {
  const row = blankRow(COLS);
  row[0] = chipCode('violet');
  row[COLS - 1] = chipCode('violet');
  const label = referenceLabel(reference);
  if (label) {
    centered(label, { from: REF_FROM, width: REF_WIDTH, row });
  }
  return row;
}

function centeredBodyRow(text) {
  const row = blankRow(COLS);
  if (text) {
    centered(text, { from: 0, width: COLS, row });
  }
  return row;
}

function composeRows(reference, bodyLines) {
  const lines = (Array.isArray(bodyLines) ? bodyLines : [])
    .map((line) => fold(cleanText(line)))
    .filter(Boolean);
  if (!lines.length || lines.length > BODY_SLOTS) {
    return [];
  }
  if (lines.some((line) => line.length > COLS)) {
    return [];
  }
  if (!referenceLabel(reference)) {
    return [];
  }

  const rows = [titleChipRow(TITLE), referenceChipRow(reference)];
  if (lines.length < BODY_SLOTS) {
    rows.push(blankRow(COLS));
    for (let slot = 0; slot < BODY_SLOTS - 1; slot += 1) {
      rows.push(centeredBodyRow(lines[slot] || ''));
    }
  } else {
    for (const line of lines) {
      rows.push(centeredBodyRow(line));
    }
  }
  return rows.length === BODY_ROWS ? rows : [];
}

function versePages(reference, text) {
  const lines = verseLines(text);
  if (!lines.length || lines.length > BODY_SLOTS * MAX_PAGES) {
    return [];
  }
  if (!referenceLabel(reference)) {
    return [];
  }
  const pages = [];
  for (let index = 0; index < lines.length; index += BODY_SLOTS) {
    const rows = composeRows(reference, lines.slice(index, index + BODY_SLOTS));
    if (rows.length) {
      pages.push(rows);
    }
  }
  return pages;
}

function verseRows(reference, text) {
  return versePages(reference, text)[0] || [];
}

function previewLines(reference, text) {
  const pages = versePages(reference, text);
  if (!pages.length) {
    return [];
  }
  const lines = verseLines(text).slice(0, BODY_SLOTS);
  const out = [TITLE, referenceLabel(reference)];
  if (lines.length < BODY_SLOTS) {
    out.push('');
    while (out.length < BODY_ROWS) {
      out.push(lines[out.length - 3] || '');
    }
  } else {
    out.push(...lines);
  }
  return out.slice(0, BODY_ROWS);
}

// The corpus ships hundreds of verses and the status snapshot re-checks every
// one of them, so remember the verdict per verse rather than re-painting rows.
const fitCache = new Map();
const lineCountCache = new Map();

function verseLineCount(text) {
  const key = String(text || '');
  let hit = lineCountCache.get(key);
  if (hit === undefined) {
    hit = verseLines(key).length;
    lineCountCache.set(key, hit);
  }
  return hit;
}

function fitsBoard(reference, text) {
  const key = `${reference}\u0000${text}`;
  let hit = fitCache.get(key);
  if (hit === undefined) {
    hit = versePages(reference, text).length > 0;
    fitCache.set(key, hit);
  }
  return hit;
}

module.exports = {
  BODY_ROWS,
  BODY_SLOTS,
  MAX_PAGES,
  COLS,
  TITLE,
  REF_FROM,
  REF_WIDTH,
  cleanText,
  cleanReference,
  referenceLabel,
  verseLines,
  verseLineCount,
  titleChipRow,
  referenceChipRow,
  composeRows,
  versePages,
  verseRows,
  previewLines,
  fitsBoard,
};
