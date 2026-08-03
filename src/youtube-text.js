/**
 * Text normalisation for YouTube cards.
 *
 * Raw descriptions are link walls: sponsor blocks, chapter indexes, social
 * handles, hashtag rows and merch links. Three lines of that is worse than no
 * description at all, so cleaning is mandatory before display (youtube.md §4.4).
 */

const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

// A chapter index line: "12:34 Chapter name", "0:00 - Intro", "(1:02:03) Outro".
const TIMESTAMP_LINE = /^\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*[-–—:|)]?\s*/;

// Lines that introduce a block of links rather than say anything about the
// video. Once one appears, everything after it is boilerplate.
const BOILERPLATE_MARKERS = [
  /^\s*(?:thanks to|thank you to|sponsored by|this video is sponsored)/i,
  /\b(?:use code|promo code|discount code|coupon code)\b/i,
  /^\s*(?:follow|find|support)\s+(?:me|us|the channel)\b/i,
  /^\s*(?:patreon|instagram|twitter|tiktok|discord|facebook|threads|bluesky|mastodon)\b\s*[:\-—]/i,
  /^\s*(?:my|our)\s+(?:gear|equipment|setup|merch|links)\b/i,
  /^\s*(?:chapters?|timestamps?|time\s*stamps?)\s*[:\-—]?\s*$/i,
  /^\s*(?:music|sound|footage|credits?|sources?|references?)\s*(?:by|from|:)/i,
  /^\s*(?:subscribe|join this channel)\b/i,
  /^\s*(?:🔔|👉|▶|📸|🎥|💰)/u,
];

const SOCIAL_HANDLE_LINE = /^\s*[@#][\w.]+(?:\s+[@#][\w.]+)*\s*$/;

function isBoilerplate(line) {
  return BOILERPLATE_MARKERS.some((pattern) => pattern.test(line));
}

/**
 * @param {string} raw
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
function cleanDescription(raw, { maxChars = 420 } = {}) {
  if (!raw) {
    return '';
  }
  const kept = [];
  for (const original of String(raw).split(/\r?\n/)) {
    // Skip leading subscribe / chapter / social banners — many channels put
    // those *above* the pitch, and breaking on the first one left the card
    // with no description at all. Once we have real copy, a later marker is
    // the end of the useful text (everything below is links).
    if (isBoilerplate(original)) {
      if (kept.length) {
        break;
      }
      continue;
    }
    const line = original
      .replace(URL_PATTERN, '')
      .replace(TIMESTAMP_LINE, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!line) {
      continue;
    }
    if (SOCIAL_HANDLE_LINE.test(line)) {
      continue;
    }
    // A line that was nothing but a URL leaves punctuation debris behind.
    if (/^[\s\-–—•|:,.]+$/.test(line)) {
      continue;
    }
    kept.push(line);
    if (kept.join(' ').length >= maxChars) {
      break;
    }
  }
  const text = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  if (text.length <= maxChars) {
    return text;
  }
  // Cut on a word boundary — a mid-word truncation looks like a bug.
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Abbreviate above 10,000. Seven raw digits on a wall display are noise
 * (youtube.md §4.4).
 */
function abbreviateCount(value) {
  // An absent count and a count of zero are different facts: a hidden
  // subscriber count must vanish from the card, not read "0 subs".
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  if (n < 10000) {
    // Grouped, so the client panel and the bridge agree digit for digit.
    return Math.round(n).toLocaleString('en-US');
  }
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      const scaled = n / scale;
      // 4.2M, but 16.8M → never "16.80M"; and 999K rather than 1.0M.
      const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '');
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** `PT1H2M3S` → seconds. Returns 0 for the live-stream `P0D`. */
function parseIso8601Duration(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(value || ''));
  if (!match) {
    return 0;
  }
  const [, days, hours, minutes, seconds] = match;
  return (Number(days || 0) * 86400)
    + (Number(hours || 0) * 3600)
    + (Number(minutes || 0) * 60)
    + Math.round(Number(seconds || 0));
}

/** `12:04`, or `1:02:04` past an hour. Tabular figures happen client-side. */
function formatClock(totalSeconds) {
  const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

module.exports = {
  cleanDescription,
  abbreviateCount,
  parseIso8601Duration,
  formatClock,
  isBoilerplate,
};
