const SHOW_NOTIFICATIONS_RE =
  /\b(?:show|read|list|hear|what(?:'s|\s+are))\s+(?:me\s+)?(?:my\s+)?notifications?\b|\bnotifications?\s+please\b/i;
const NO_NOTIFICATIONS_RE =
  /\b(?:no|zero)\s+(?:new\s+)?notifications?\b|\b(?:don't|do not)\s+have\s+any\s+(?:new\s+)?notifications?\b|\bnotifications?\s+(?:are\s+)?(?:clear|empty)\b|\byou have no\b(?:\s+\w+){0,6}\s+notifications?\b|\bthere(?:'s| is| are)\s+no\b(?:\s+\w+){0,6}\s+notifications?\b|\ball caught up\b/i;
const NOTIFICATION_INTRO_RE =
  /\b(?:you have|there(?:'s| is| are))\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+)?notifications?\b/i;

const NOTIFICATION_INTRO_PREFIX_RE =
  /^(?:you have|there(?:'s| is| are))\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+)?notifications?(?:\s+from\s+[^.:]+)?[.:\s-]*/i;

const COUNT_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

const ORDINAL_SPLIT_RE =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|finally)\s*,?\s*/i;

const AMAZON_SHOPPING_SOURCE_RE = /\b(?:notification(?:s)? from )?amazon shopping\b/i;
const NOTIFICATION_DISMISSAL_RE =
  /\bthat(?:'s| is) all(?: your)? notifications?\b|\b(?:alright|ok(?:ay)?),?\s*no problem\b[^.]*\bnotifications?\b/i;
const DELIVERY_CONTENT_RE =
  /\b(?:package|order|delivery|delivered|deliver(?:y|ies)|shipped|shipping|out for delivery|arriving|on its way|left (?:at|on) (?:your )?(?:porch|doorstep|garage|front door))\b/i;

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesNotificationsQuery(summary, response) {
  return SHOW_NOTIFICATIONS_RE.test(normalizeText(summary));
}

function cleanNotificationText(text) {
  return String(text || '')
    .replace(/^[\s,.:-]+/, '')
    .replace(/\s*(?:that(?:'s| is) all|would you like.*)$/i, '')
    .replace(/\s*(?:do you want me to.*)$/i, '')
    .trim();
}

function isEmptyNotificationPhrase(text) {
  const spoken = normalizeText(text);
  if (!spoken) {
    return false;
  }
  return NO_NOTIFICATIONS_RE.test(spoken);
}

function emptyNotificationsResult(spoken) {
  return {
    items: [],
    empty: true,
    summary: '0 notifications',
    body: spoken,
  };
}

function parseAnnouncedCount(spoken) {
  const match = NOTIFICATION_INTRO_PREFIX_RE.exec(normalizeText(spoken));
  if (!match) {
    return null;
  }
  const raw = String(match[1] || '').toLowerCase();
  if (COUNT_WORDS[raw] != null) {
    return COUNT_WORDS[raw];
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function stripNotificationIntro(spoken) {
  return normalizeText(spoken)
    .replace(NOTIFICATION_INTRO_PREFIX_RE, '')
    .replace(/^(?:here(?:'s| is| are)|okay|sure)[^.]*notifications?[.:\s-]*/i, '')
    .trim();
}

function splitSentences(text) {
  const placeholders = [];
  const safe = String(text || '').replace(/\b(?:[A-Z]\.){1,4}(?=\s|$)/g, (match) => {
    placeholders.push(match);
    return `\u0000${placeholders.length - 1}\u0000`;
  });
  return safe
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replace(/\u0000(\d+)\u0000/g, (_, index) => placeholders[Number(index)]))
    .map(cleanNotificationText)
    .filter(Boolean);
}

function splitNotificationItems(spoken) {
  if (isEmptyNotificationPhrase(spoken)) {
    return [];
  }

  const count = parseAnnouncedCount(spoken);
  let body = stripNotificationIntro(spoken);
  if (!body) {
    body = normalizeText(spoken);
  }

  if (count === 1) {
    const cleaned = cleanNotificationText(body);
    return cleaned && !isEmptyNotificationPhrase(cleaned) ? [cleaned] : [];
  }

  const ordinalParts = body.split(ORDINAL_SPLIT_RE).map(cleanNotificationText).filter(Boolean);
  if (ordinalParts.length > 1 && (count == null || ordinalParts.length === count)) {
    return ordinalParts;
  }

  const numberedParts = body.split(/\b\d+\.\s+/).map(cleanNotificationText).filter(Boolean);
  if (numberedParts.length > 1 && (count == null || numberedParts.length === count)) {
    return numberedParts;
  }

  const sentences = splitSentences(body);
  if (count != null && sentences.length === count) {
    return sentences;
  }
  if (count == null && sentences.length > 1) {
    return sentences;
  }

  const cleaned = cleanNotificationText(body);
  if (cleaned && isEmptyNotificationPhrase(cleaned)) {
    return [];
  }
  return cleaned ? [cleaned] : [];
}

function parseNotificationsFromSpeech(response) {
  const spoken = normalizeText(response);
  if (!spoken) {
    return { items: [], empty: false, summary: null, body: null };
  }

  if (isEmptyNotificationPhrase(spoken)) {
    return emptyNotificationsResult(spoken);
  }

  const items = splitNotificationItems(spoken).filter((item) => !isEmptyNotificationPhrase(item));
  const count = items.length;
  if (count === 0 && /\bnotifications?\b/i.test(spoken) && /\b(?:no|zero|none|empty|clear|caught up)\b/i.test(spoken)) {
    return emptyNotificationsResult(spoken);
  }

  const summary = count
    ? `${count} notification${count === 1 ? '' : 's'}`
    : NOTIFICATION_INTRO_RE.test(spoken)
      ? 'Notifications'
      : null;

  return {
    items,
    empty: false,
    summary,
    body: spoken,
  };
}

function hasNotificationContent(spokenResponse) {
  const spoken = normalizeText(spokenResponse);
  if (!spoken) {
    return false;
  }
  if (isEmptyNotificationPhrase(spoken)) {
    return true;
  }
  if (NOTIFICATION_INTRO_RE.test(spoken)) {
    return true;
  }
  const parsed = parseNotificationsFromSpeech(spoken);
  if (parsed.items.length > 0) {
    return true;
  }
  return spoken.length >= 12;
}

function buildNotificationsReading(spokenResponse) {
  const parsed = parseNotificationsFromSpeech(spokenResponse);
  return {
    items: parsed.items,
    empty: parsed.empty,
    summary: parsed.summary,
    body: parsed.body,
  };
}

function isAmazonShoppingSource(text) {
  return AMAZON_SHOPPING_SOURCE_RE.test(normalizeText(text));
}

function isNotificationDismissal(text) {
  const spoken = normalizeText(text);
  if (!spoken) {
    return false;
  }
  if (NOTIFICATION_DISMISSAL_RE.test(spoken)) {
    return true;
  }
  if (isEmptyNotificationPhrase(spoken) && /\bnotifications?\b/i.test(spoken)) {
    return /\b(?:all|that(?:'s| is) all|no problem)\b/i.test(spoken);
  }
  return false;
}

function isDeliveryNotificationText(text) {
  return DELIVERY_CONTENT_RE.test(normalizeText(text));
}

function isAmazonShoppingIntroOnly(text) {
  const spoken = normalizeText(text);
  if (!spoken) {
    return false;
  }
  return isAmazonShoppingSource(spoken) && !isDeliveryNotificationText(spoken);
}

function matchesPassiveAmazonDeliveryNotification(summary, response) {
  const sum = normalizeText(summary);
  const resp = normalizeText(response);
  if (sum && matchesNotificationsQuery(sum, resp)) {
    return false;
  }
  if (!resp) {
    return false;
  }
  if (isNotificationDismissal(resp)) {
    return false;
  }
  if (sum) {
    return false;
  }
  return isAmazonShoppingSource(resp) || isDeliveryNotificationText(resp);
}

function stripAmazonShoppingIntro(spoken) {
  return normalizeText(spoken)
    .replace(/^you(?:'ve| have) got (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+) new notification(?:s)? from amazon shopping[.:\s-]*/i, '')
    .replace(/^you have (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+) new notification(?:s)? from amazon shopping[.:\s-]*/i, '')
    .replace(/let me pull that up for you[.:\s-]*/i, '')
    .trim();
}

function parseDeliveryNotificationsFromSpeech(response) {
  const spoken = normalizeText(response);
  const meta = { category: 'delivery', source: 'amazon-shopping' };
  if (!spoken || isNotificationDismissal(spoken)) {
    return { items: [], empty: true, summary: null, body: spoken || null, ...meta };
  }
  if (isAmazonShoppingIntroOnly(spoken)) {
    return { items: [], empty: false, summary: null, body: spoken, ...meta };
  }

  const parsed = parseNotificationsFromSpeech(spoken);
  let items = parsed.items.filter((item) => isDeliveryNotificationText(item));
  if (!items.length) {
    const body = stripAmazonShoppingIntro(spoken);
    if (body && isDeliveryNotificationText(body)) {
      items = [cleanNotificationText(body)];
    } else if (isDeliveryNotificationText(spoken)) {
      items = [cleanNotificationText(body || spoken)];
    }
  }

  const count = items.length;
  return {
    items,
    empty: count === 0,
    summary: count ? `${count} delivery update${count === 1 ? '' : 's'}` : null,
    body: spoken,
    ...meta,
  };
}

function hasDeliveryNotificationContent(response) {
  return parseDeliveryNotificationsFromSpeech(response).items.length > 0;
}

function buildDeliveryNotificationsReading(spokenResponse) {
  const parsed = parseDeliveryNotificationsFromSpeech(spokenResponse);
  return {
    items: parsed.items,
    empty: parsed.empty,
    summary: parsed.summary,
    body: parsed.body,
    category: parsed.category,
    source: parsed.source,
  };
}

module.exports = {
  SHOW_NOTIFICATIONS_RE,
  matchesNotificationsQuery,
  parseNotificationsFromSpeech,
  buildNotificationsReading,
  hasNotificationContent,
  isAmazonShoppingSource,
  isNotificationDismissal,
  isDeliveryNotificationText,
  isAmazonShoppingIntroOnly,
  matchesPassiveAmazonDeliveryNotification,
  parseDeliveryNotificationsFromSpeech,
  hasDeliveryNotificationContent,
  buildDeliveryNotificationsReading,
};
