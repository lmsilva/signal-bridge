const SHOW_NOTIFICATIONS_RE =
  /\b(?:show|read|list|hear|what(?:'s|\s+are))\s+(?:me\s+)?(?:my\s+)?notifications?\b|\bnotifications?\s+please\b/i;
const NO_NOTIFICATIONS_RE =
  /\b(?:no|zero)\s+(?:new\s+)?notifications?\b|\b(?:don't|do not)\s+have\s+any\s+(?:new\s+)?notifications?\b|\bnotifications?\s+(?:are\s+)?(?:clear|empty)\b|\byou have no\b(?:\s+\w+){0,6}\s+notifications?\b|\bthere(?:'s| is| are)\s+no\b(?:\s+\w+){0,6}\s+notifications?\b|\ball caught up\b/i;
const NOTIFICATION_INTRO_RE =
  /\b(?:you have|there(?:'s| is| are))\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+notifications?\b/i;

const ORDINAL_SPLIT_RE =
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|next|finally)\s*,?\s*/i;

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

function splitNotificationItems(spoken) {
  if (isEmptyNotificationPhrase(spoken)) {
    return [];
  }

  let body = spoken
    .replace(/^(?:you have|there(?:'s| is| are))\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+notifications?[.:\s-]*/i, '')
    .replace(/^(?:here(?:'s| is| are)|okay|sure)[^.]*notifications?[.:\s-]*/i, '')
    .trim();

  if (!body) {
    return [];
  }

  const ordinalParts = body.split(ORDINAL_SPLIT_RE).map(cleanNotificationText).filter(Boolean);
  if (ordinalParts.length > 1) {
    return ordinalParts;
  }

  const numberedParts = body.split(/\b\d+\.\s+/).map(cleanNotificationText).filter(Boolean);
  if (numberedParts.length > 1) {
    return numberedParts;
  }

  const sentences = body.split(/(?<=[.!?])\s+/).map(cleanNotificationText).filter(Boolean);
  if (sentences.length > 1) {
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

module.exports = {
  SHOW_NOTIFICATIONS_RE,
  matchesNotificationsQuery,
  parseNotificationsFromSpeech,
  buildNotificationsReading,
  hasNotificationContent,
};
