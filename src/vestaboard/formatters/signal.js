// Frames about the bridge itself rather than about the house (03 §E).

const { COLS, blankRow, placeText, fold } = require('../encoder');
const { badgeFrame, chipCode, BODY_FROM, BODY_TO, MAX_BODY_ROWS } = require('../frames');
const { snapshotFrame, padRows } = require('./common');

const BODY_WIDTH = BODY_TO - BODY_FROM + 1;

// One pass of every colour, twice, as a mechanical self-check: if a flap is
// stuck or a colour is missing you can see it from across the room.
const CHIP_PARADE = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white'];
const PARADE_LEFT_FROM = 1;
const PARADE_RIGHT_FROM = 12;

/** A long board name would run past the row, so it is cut to what fits. */
function fitBoardName(name) {
  const room = BODY_TO - 2 + 1 - ' - OK'.length;
  return String(name || 'VESTABOARD').slice(0, room);
}

function paradeRow() {
  const row = blankRow(COLS);
  CHIP_PARADE.forEach((colour, index) => {
    row[PARADE_LEFT_FROM + index] = chipCode(colour);
    row[PARADE_RIGHT_FROM + index] = chipCode(colour);
  });
  return row;
}

/**
 * The Test flip frame: proof that a board is reachable, that its key works,
 * and that every colour of flap still turns.
 */
function identityFrame({ name = 'VESTABOARD' } = {}) {
  const layout = badgeFrame({
    color: 'white',
    title: 'SIGNAL BRIDGE',
    rows: [
      '',
      { left: 'VESTABOARD LINKED', from: 2 },
      { left: `${fitBoardName(name)} - OK`, from: 2, to: BODY_TO },
      '',
    ],
  });

  layout[layout.length - 1] = paradeRow();
  return {
    rows: layout,
    dwellSeconds: 15,
    label: 'Test flip',
    source: 'signal.identity',
  };
}

/**
 * Strip the scheme and trailing slash so a booth URL is just the host
 * guests type. Wrapping (not cutting) is what makes a long host fit.
 */
function boothHost(url) {
  return fold(String(url || '').replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
}

function chunkText(text, width) {
  const raw = String(text || '');
  if (!raw) {
    return [];
  }
  const lines = [];
  for (let i = 0; i < raw.length; i += width) {
    lines.push(raw.slice(i, i + width));
  }
  return lines;
}

/**
 * Break a host at dots rather than hyphenating. A password or SSID must
 * never gain a hyphen; a URL that picked up one would be the wrong address.
 */
function splitHost(host, width) {
  const text = String(host || '');
  if (!text) {
    return [];
  }
  if (text.length <= width) {
    return [text];
  }
  let dot = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '.' && i + 1 <= width) {
      dot = i;
    }
  }
  if (dot >= 0 && dot < text.length - 1) {
    return [text.slice(0, dot + 1), ...splitHost(text.slice(dot + 1), width)];
  }
  return chunkText(text, width);
}

function labeledOrStacked(label, value, width) {
  if (!value) {
    return [];
  }
  const labeled = `${label} ${value}`;
  if (labeled.length <= width) {
    return [labeled];
  }
  return [label, ...chunkText(value, width)];
}

function paintGuestFooter(text) {
  const row = blankRow(COLS);
  row[0] = chipCode('blue');
  row[COLS - 1] = chipCode('blue');
  if (text.length <= 18) {
    placeText(row, text, 2);
  } else {
    placeText(row, text.slice(0, 20), 1);
  }
  return row;
}

/**
 * Guest snaps cannot show a QR, so the SSID, password and booth URL are typed
 * out. Values that do not fit next to their label take the next row rather
 * than being cut. The overlay holds for about three minutes; the board
 * repeats a 30s dwell rather than asking one frame to sit past the 30s cap.
 */
function guestSnapsFrames(payload = {}, ctx = {}) {
  const guest = payload.guestPhotobooth || {};
  const wifi = guest.wifi || {};
  const ssid = fold(wifi.ssid || ctx.ssid || ctx.wifiSsid);
  const password = fold(guest.wifi?.password || ctx.password || ctx.wifiPassword);
  const url = boothHost(guest.booth?.content || ctx.boothUrl);

  if (!ssid && !url) {
    return [];
  }

  let wifiLines = labeledOrStacked('WIFI', ssid, BODY_WIDTH);
  let passLines = labeledOrStacked('PASS', password, BODY_WIDTH);
  let hostLines = splitHost(url, BODY_WIDTH);
  const slots = MAX_BODY_ROWS + (url ? 1 : 0);
  if (wifiLines.length + passLines.length + hostLines.length > slots) {
    wifiLines = ssid ? chunkText(ssid, BODY_WIDTH) : [];
    passLines = password ? chunkText(password, BODY_WIDTH) : [];
  }

  const body = [...wifiLines, ...passLines];
  let footer = '';
  if (hostLines.length === 1 && body.length <= MAX_BODY_ROWS - 1) {
    while (body.length < MAX_BODY_ROWS - 1) {
      body.push('');
    }
    body.push('SHARE PHOTOS AT:');
    footer = hostLines[0];
  } else {
    const rest = [...hostLines];
    while (body.length < MAX_BODY_ROWS && rest.length) {
      body.push(rest.shift());
    }
    footer = rest[0] || '';
  }

  const rows = badgeFrame({
    color: 'blue',
    title: 'GUEST SNAPS',
    rows: padRows(body),
  });

  if (footer) {
    rows[rows.length - 1] = paintGuestFooter(footer);
  }

  const hold = Math.max(30, Number(payload.displaySeconds) || 180);
  const copies = Math.max(1, Math.ceil(hold / 30));
  const frame = snapshotFrame(rows, 'Guest snaps', 'guest.photobooth', { base: 30 });
  frame.dwellSeconds = 30;
  return Array.from({ length: copies }, () => ({ ...frame }));
}

const FORMATTERS = {
  'guest.photobooth': guestSnapsFrames,
};

function framesFor(payload, ctx = {}) {
  if (payload?.type === 'signal.identity' || payload?.type === 'vestaboard.test-flip') {
    return [identityFrame({ name: payload.name || ctx.name })];
  }
  const formatter = FORMATTERS[payload?.type];
  return formatter ? formatter(payload, ctx) : [];
}

module.exports = {
  identityFrame,
  paradeRow,
  fitBoardName,
  CHIP_PARADE,
  guestSnapsFrames,
  boothHost,
  splitHost,
  labeledOrStacked,
  FORMATTERS,
  framesFor,
};
