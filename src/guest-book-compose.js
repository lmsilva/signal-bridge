/**
 * Lay a guest message onto a 6×22 Vestaboard grid.
 *
 * Chips in the text use `{R}` `{O}` `{Y}` `{G}` `{B}` `{V}` `{W}`.
 * The optional name becomes a final `- NAME` line and counts against space.
 */

const {
  ROWS,
  COLS,
  CHIPS,
  fold,
  wrap,
  blankRow,
  encodeText,
  decodeCodes,
  contentLength,
  validate,
  isLegalCode,
} = require('./vestaboard/encoder');

const CHIP_MARK = {
  R: CHIPS.red,
  O: CHIPS.orange,
  Y: CHIPS.yellow,
  G: CHIPS.green,
  B: CHIPS.blue,
  V: CHIPS.violet,
  W: CHIPS.white,
};

const CHARSET_HINT = 'The board can show A–Z, 0–9 and , . ! ? \' - : ; / $ % + & = ( ) @ #';

function encodeLine(text, align = 'center') {
  const raw = String(text || '');
  const codes = [];
  const parts = raw.split(/(\{[ROYGBVW]\})/gi);
  for (const part of parts) {
    const chip = /^\{([ROYGBVW])\}$/i.exec(part);
    if (chip) {
      codes.push(CHIP_MARK[chip[1].toUpperCase()]);
      continue;
    }
    codes.push(...encodeText(part));
  }
  if (codes.length > COLS) {
    return { ok: false, codes: codes.slice(0, COLS), overflow: true };
  }
  const row = blankRow(COLS);
  let start = 0;
  if (align === 'right') {
    start = COLS - codes.length;
  } else if (align === 'center') {
    start = Math.floor((COLS - codes.length) / 2);
  }
  codes.forEach((code, index) => {
    row[start + index] = code;
  });
  return { ok: true, codes: row, overflow: false };
}

/**
 * wrap() folds text and would strip `{R}` markers. Chips are one tile, so
 * they must stay intact and count as width 1 while words wrap around them.
 */
function wrapPreservingChips(text, width) {
  const limit = Math.max(2, Math.floor(width) || 0);
  const parts = String(text || '').split(/(\{[ROYGBVW]\})/gi);
  const tokens = [];
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (/^\{[ROYGBVW]\}$/i.test(part)) {
      tokens.push({ type: 'chip', raw: `{${part[1].toUpperCase()}}`, width: 1 });
      continue;
    }
    const folded = fold(part);
    if (!folded) {
      continue;
    }
    for (const chunk of folded.split(/(\s+)/)) {
      if (!chunk) {
        continue;
      }
      if (/^\s+$/.test(chunk)) {
        tokens.push({ type: 'space', raw: ' ', width: 1 });
      } else {
        tokens.push({ type: 'word', raw: chunk, width: chunk.length });
      }
    }
  }

  const lines = [];
  let current = '';
  let used = 0;
  const flush = () => {
    if (current) {
      lines.push(current.replace(/\s+$/, ''));
    }
    current = '';
    used = 0;
  };

  for (const token of tokens) {
    if (token.type === 'space') {
      if (current && used + 1 <= limit) {
        current += ' ';
        used += 1;
      }
      continue;
    }
    if (token.width > limit && token.type === 'word') {
      const wrapped = wrap(token.raw, limit);
      for (const piece of wrapped) {
        if (current) {
          flush();
        }
        current = piece;
        used = piece.length;
      }
      continue;
    }
    if (used + token.width > limit && current) {
      flush();
    }
    current += token.raw;
    used += token.width;
  }
  flush();
  return lines;
}

function messageLines(text, name) {
  const lines = [];
  for (const para of String(text || '').split(/\r?\n/)) {
    if (para === '') {
      if (lines.length) {
        lines.push('');
      }
      continue;
    }
    lines.push(...wrapPreservingChips(para, COLS));
  }
  const who = fold(String(name || '').trim());
  if (who) {
    const signed = `- ${who}`.slice(0, COLS);
    lines.push(signed);
  }
  return lines;
}

function blankBoard() {
  return Array.from({ length: ROWS }, () => blankRow(COLS));
}

function cloneBoard(rows) {
  return (rows || []).map((row) => (Array.isArray(row) ? row.slice(0, COLS) : blankRow(COLS)));
}

/** A guest-painted 6×22 grid. Illegal codes are refused, never coerced. */
function layoutRows(raw, { editableRows = ROWS } = {}) {
  if (!Array.isArray(raw) || raw.length !== ROWS) {
    return {
      ok: false,
      fits: false,
      used: 0,
      rows: null,
      error: 'That layout is not a full board',
    };
  }
  const rows = blankBoard();
  for (let r = 0; r < ROWS; r += 1) {
    const src = Array.isArray(raw[r]) ? raw[r] : [];
    if (src.length !== COLS) {
      return {
        ok: false,
        fits: false,
        used: 0,
        rows: null,
        error: 'That layout is not a full board',
      };
    }
    for (let c = 0; c < COLS; c += 1) {
      const code = Number(src[c] || 0);
      if (!isLegalCode(code)) {
        return {
          ok: false,
          fits: false,
          used: 0,
          rows: null,
          error: 'That message cannot be shown',
        };
      }
      rows[r][c] = code;
    }
  }
  const used = contentLength(rows.slice(0, Math.min(ROWS, Number(editableRows) || ROWS)));
  const checked = validate(rows);
  if (!checked.ok) {
    return { ok: false, fits: false, used, rows: null, error: 'That message cannot be shown' };
  }
  if (!used) {
    return { ok: false, fits: false, used: 0, rows, error: 'Write a message first' };
  }
  return {
    ok: true,
    fits: true,
    used,
    rows,
    usedRows: rows.filter((row) => row.some((code) => code)).length,
    source: 'design',
  };
}

function rowsToText(rows) {
  return decodeCodes((rows || []).flat()).replace(/\s+/g, ' ').trim();
}

function layoutMessage({
  text = '',
  name = '',
  align = 'center',
  valign = 'middle',
} = {}) {
  const alignment = align === 'left' || align === 'right' ? align : 'center';
  const vertical = valign === 'top' || valign === 'bottom' ? valign : 'middle';
  const lines = messageLines(text, name);
  if (!lines.length) {
    return {
      ok: false,
      fits: false,
      used: 0,
      rows: Array.from({ length: ROWS }, () => blankRow(COLS)),
      error: 'Write a message first',
    };
  }
  if (lines.length > ROWS) {
    return {
      ok: false,
      fits: false,
      used: lines.join('').length,
      rows: null,
      error: 'That message does not fit on the board',
    };
  }

  let start = 0;
  if (vertical === 'middle') {
    start = Math.floor((ROWS - lines.length) / 2);
  } else if (vertical === 'bottom') {
    start = ROWS - lines.length;
  }

  const rows = Array.from({ length: ROWS }, () => blankRow(COLS));
  for (let i = 0; i < lines.length; i += 1) {
    const encoded = encodeLine(lines[i], alignment);
    if (encoded.overflow) {
      return {
        ok: false,
        fits: false,
        used: COLS * lines.length,
        rows: null,
        error: 'That message does not fit on the board',
      };
    }
    rows[start + i] = encoded.codes;
  }

  const used = contentLength(rows);
  try {
    validate(rows);
  } catch (error) {
    return { ok: false, fits: false, used, rows: null, error: error.message };
  }
  return {
    ok: true,
    fits: true,
    used,
    rows,
    usedRows: lines.length,
    lines,
  };
}

/** 8 chips centered on 22 cols: white before red, white at the end. */
const FOOTER_CHIP_START = 7;

function inviteFooterPair(shortLabel) {
  const label = fold(String(shortLabel || '')).slice(0, COLS);
  if (!label) {
    return null;
  }
  const chips = blankRow(COLS);
  const parade = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white'];
  parade.forEach((colour, index) => {
    chips[FOOTER_CHIP_START + index] = CHIPS[colour];
  });
  return [chips, encodeLine(label, 'center').codes];
}

function inviteScreenRows(shortLabel, { boardCode = '' } = {}) {
  const label = fold(String(shortLabel || '')).slice(0, COLS);
  if (!label) {
    return null;
  }
  const layout = layoutMessage({
    text: 'SIGN THE\nGUEST BOOK',
    align: 'center',
    valign: 'top',
  });
  if (!layout.ok) {
    return null;
  }
  const rows = stampInviteFooter(layout.rows, label);
  const pin = String(boardCode || '').replace(/\D/g, '').slice(0, 6);
  if (pin && rows) {
    rows[2] = encodeLine(`CODE ${pin}`, 'center').codes;
  }
  return rows;
}

function stampInviteFooter(messageRows, shortLabel) {
  const pair = inviteFooterPair(shortLabel);
  if (!pair || !Array.isArray(messageRows) || messageRows.length !== ROWS) {
    return null;
  }
  const combined = cloneBoard(messageRows);
  combined[ROWS - 2] = pair[0];
  combined[ROWS - 1] = pair[1];
  return combined;
}

function footerRows(messageRows, shortLabel) {
  const label = fold(String(shortLabel || '')).slice(0, COLS);
  if (!label) {
    return null;
  }
  const usedRows = (messageRows || []).filter((row) => row.some((code) => code)).length;
  if (usedRows > 4) {
    return null;
  }
  const content = (messageRows || []).filter((row) => (row || []).some((code) => code));
  if (content.length > 4) {
    return null;
  }
  const combined = Array.from({ length: ROWS }, () => blankRow(COLS));
  content.forEach((row, index) => {
    combined[index] = row.slice();
  });
  return stampInviteFooter(combined, label);
}

/**
 * For a painted grid, keep the guest's placement. Only add the invite if the
 * last two rows are still empty — never slide their artwork to the top.
 */
function footerRowsInPlace(messageRows, shortLabel) {
  const label = fold(String(shortLabel || '')).slice(0, COLS);
  if (!label || !Array.isArray(messageRows) || messageRows.length !== ROWS) {
    return null;
  }
  const last = messageRows[ROWS - 1] || [];
  const next = messageRows[ROWS - 2] || [];
  if (last.some((code) => code) || next.some((code) => code)) {
    return null;
  }
  return stampInviteFooter(messageRows, label);
}

module.exports = {
  CHARSET_HINT,
  CHIP_MARK,
  encodeLine,
  wrapPreservingChips,
  messageLines,
  layoutMessage,
  layoutRows,
  rowsToText,
  footerRows,
  footerRowsInPlace,
  stampInviteFooter,
  inviteScreenRows,
  inviteFooterPair,
  FOOTER_CHIP_START,
  blankBoard,
};
