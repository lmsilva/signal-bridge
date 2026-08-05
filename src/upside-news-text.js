/**
 * Shared text helpers for The Upside News (HTML entity decode, standfirst, relative time).
 */

function decodeHtmlEntities(value) {
  let text = String(value || '');
  if (!text) {
    return '';
  }
  // Named entities first (common Guardian ones).
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&hellip;/gi, '\u2026');
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  return text.replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '));
}

function firstSentence(value) {
  const text = stripHtml(value);
  if (!text) {
    return '';
  }
  const match = text.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1].trim() : text.slice(0, 280).trim();
}

function readingMinutes(wordcount) {
  const words = Number(wordcount);
  if (!Number.isFinite(words) || words <= 0) {
    return null;
  }
  return Math.max(1, Math.round(words / 230));
}

function relativeOrAbsoluteTime(iso, { period = 'daily', now = Date.now() } = {}) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return '';
  }
  const useAbsolute = period === 'monthly' || period === 'yearly';
  if (useAbsolute) {
    return new Date(ms).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
  }
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSec < 60) {
    return 'just now';
  }
  if (deltaSec < 3600) {
    return `${Math.floor(deltaSec / 60)}m ago`;
  }
  if (deltaSec < 86400) {
    return `${Math.floor(deltaSec / 3600)}h ago`;
  }
  const days = Math.floor(deltaSec / 86400);
  if (days < 14) {
    return `${days}d ago`;
  }
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function titleSimilarity(a, b) {
  const norm = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const leftWords = new Set(left.split(' ').filter((w) => w.length > 2));
  const rightWords = new Set(right.split(' ').filter((w) => w.length > 2));
  if (!leftWords.size || !rightWords.size) {
    return 0;
  }
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftWords.size, rightWords.size);
}

function normaliseUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    // Drop tracking params.
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid'].forEach((key) => {
      parsed.searchParams.delete(key);
    });
    let href = parsed.toString();
    if (href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href.toLowerCase();
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

module.exports = {
  decodeHtmlEntities,
  stripHtml,
  firstSentence,
  readingMinutes,
  relativeOrAbsoluteTime,
  titleSimilarity,
  normaliseUrl,
};
