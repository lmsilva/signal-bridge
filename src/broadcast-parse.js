const DEVICE_WORD_RE = /^(?:echo|dot|show|flex|spot|pop|tv|fire|studio|auto|plus|sub|link)$/i;
const ALL_DEVICES_RE = /^(?:all\s+devices|everywhere)$/i;
const ROOM_WORD_RE = /^(?:kitchen|office|bedroom|bathroom|garage|basement|hallway|living|master|downstairs|upstairs|kids?|nursery|dining|family|media|game|theater|theatre|guest|front|back|laundry|mudroom|patio|porch|yard|shop|workshop)$/i;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function destinationLooksLikeDevice(text) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return false;
  }

  const last = words[words.length - 1];
  if (DEVICE_WORD_RE.test(last)) {
    return true;
  }

  if (words.length === 1 && ROOM_WORD_RE.test(words[0])) {
    return true;
  }

  return false;
}

function messageLooksLikeContent(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  const words = normalized.split(/\s+/);
  if (words.length >= 2) {
    return true;
  }

  return !DEVICE_WORD_RE.test(normalized) && !ROOM_WORD_RE.test(normalized);
}

function splitDestinationAndMessage(rest) {
  const words = normalizeText(rest).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { kind: 'command-only', destination: null, message: null };
  }

  if (words.length === 1) {
    return {
      kind: 'command-only',
      destination: words[0],
      message: null,
    };
  }

  for (let deviceWordCount = Math.min(4, words.length - 1); deviceWordCount >= 1; deviceWordCount -= 1) {
    const destination = words.slice(0, deviceWordCount).join(' ');
    const message = words.slice(deviceWordCount).join(' ');

    if (!message) {
      return { kind: 'command-only', destination, message: null };
    }

    if (messageLooksLikeContent(message) && destinationLooksLikeDevice(destination)) {
      return { kind: 'inline', destination, message };
    }
  }

  if (words.length === 2 && destinationLooksLikeDevice(words.join(' '))) {
    return { kind: 'command-only', destination: words.join(' '), message: null };
  }

  if (words.length >= 3 && destinationLooksLikeDevice(words.slice(0, 2).join(' '))) {
    return {
      kind: 'inline',
      destination: words.slice(0, 2).join(' '),
      message: words.slice(2).join(' '),
    };
  }

  return { kind: 'inline', destination: null, message: rest };
}

function parseBroadcastUtterance(summary) {
  const text = normalizeText(summary).replace(/^alexa[,\s]+/i, '');
  const verbMatch = text.match(
    /^(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)\b\s*(.*)$/i,
  );
  if (!verbMatch) {
    return null;
  }

  let rest = normalizeText(verbMatch[1]);
  // Amazon often joins a second ASR fragment with a comma:
  // "broadcast this is a test, broadcast this is a test" → rest still has
  // ", broadcast …". Drop the redundant verb clause before splitting.
  rest = stripTrailingBroadcastEcho(rest);
  if (!rest) {
    return { kind: 'command-only', destination: null, message: null };
  }

  rest = rest.replace(/^that\s+/i, '');
  rest = normalizeText(rest.replace(/^[,.\s]+/, ''));
  if (!rest) {
    return { kind: 'command-only', destination: null, message: null };
  }

  if (/^to\s+/i.test(rest)) {
    rest = rest.replace(/^to\s+/i, '');

    const allDevicesMatch = rest.match(/^(all\s+devices|everywhere)\b\s*(.*)$/i);
    if (allDevicesMatch) {
      const message = cleanBroadcastMessage(allDevicesMatch[2]);
      return message
        ? { kind: 'inline', destination: 'All devices', message }
        : { kind: 'command-only', destination: 'All devices', message: null };
    }

    const split = splitDestinationAndMessage(rest);
    if (split.kind === 'inline' && split.message) {
      const message = cleanBroadcastMessage(split.message);
      if (!message) {
        return { kind: 'command-only', destination: split.destination, message: null };
      }
      return { ...split, message };
    }
    return split;
  }

  const message = cleanBroadcastMessage(rest);
  if (!message) {
    return { kind: 'command-only', destination: null, message: null };
  }
  return { kind: 'inline', destination: null, message };
}

/**
 * Amazon frequently stores the same broadcast twice in one activity
 * (ASR_REPLACEMENT + description.summary, or wake+repeat). Joining those
 * with commas produced display text like
 * "this is a test, broadcast this is a test" or ", broadcast".
 */
function stripTrailingBroadcastEcho(text) {
  return normalizeText(text).replace(
    /\s*,\s*(?:alexa[,\s]+)?(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)\b.*$/i,
    '',
  );
}

function cleanBroadcastMessage(value) {
  let text = normalizeText(value);
  if (!text) {
    return null;
  }
  text = stripTrailingBroadcastEcho(text);
  text = normalizeText(text.replace(/^[,.\s]+/, '').replace(/[,.\s]+$/, ''));
  if (!text) {
    return null;
  }
  // Verb-only leftovers after cleaning ("broadcast", "announce").
  if (/^(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)$/i.test(text)) {
    return null;
  }
  return text;
}

/**
 * Prefer a single customer ASR fragment over the comma-joined summary when
 * parsing broadcasts — joined fragments are what created the duplicated
 * on-screen messages.
 */
function resolveBroadcastUtterance(summary, customerParts = []) {
  const parts = [];
  for (const part of customerParts || []) {
    const text = normalizeText(part);
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  }
  const joined = normalizeText(summary);
  if (joined && !parts.includes(joined)) {
    parts.push(joined);
  }

  // Longest-first: full "broadcast this is a test" wins over bare "broadcast".
  const ranked = [...parts].sort((a, b) => b.length - a.length);

  let bestCommandOnly = null;
  for (const part of ranked) {
    const parsed = parseBroadcastUtterance(part);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === 'inline' && parsed.message) {
      return parsed;
    }
    if (parsed.kind === 'command-only' && !bestCommandOnly) {
      bestCommandOnly = parsed;
    }
  }

  if (bestCommandOnly) {
    return bestCommandOnly;
  }

  // Follow-up style: parts with no broadcast verb (message only).
  for (const part of ranked) {
    if (BROADCAST_VERB_TOKEN_RE.test(part)) {
      continue;
    }
    const message = cleanBroadcastMessage(part);
    if (message) {
      return { kind: 'follow-up', destination: null, message };
    }
  }

  return null;
}

const BROADCAST_VERB_TOKEN_RE = /\b(?:announce(?:ment)?|broadcast(?:ing)?|make an announcement|send an announcement)\b/i;

function extractInlineBroadcastMessage(summary, customerParts = []) {
  const parsed = resolveBroadcastUtterance(summary, customerParts)
    || parseBroadcastUtterance(summary);
  if (parsed?.kind === 'inline' && parsed.message) {
    return parsed.message;
  }
  return null;
}

function isBroadcastCommandOnly(summary, customerParts = []) {
  const parsed = resolveBroadcastUtterance(summary, customerParts)
    || parseBroadcastUtterance(summary);
  return parsed?.kind === 'command-only';
}

module.exports = {
  parseBroadcastUtterance,
  resolveBroadcastUtterance,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  cleanBroadcastMessage,
  stripTrailingBroadcastEcho,
  destinationLooksLikeDevice,
  messageLooksLikeContent,
  splitDestinationAndMessage,
};