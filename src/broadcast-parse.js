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
  if (!rest) {
    return { kind: 'command-only', destination: null, message: null };
  }

  rest = rest.replace(/^that\s+/i, '');

  if (/^to\s+/i.test(rest)) {
    rest = rest.replace(/^to\s+/i, '');

    const allDevicesMatch = rest.match(/^(all\s+devices|everywhere)\b\s*(.*)$/i);
    if (allDevicesMatch) {
      const message = normalizeText(allDevicesMatch[2]);
      return message
        ? { kind: 'inline', destination: 'All devices', message }
        : { kind: 'command-only', destination: 'All devices', message: null };
    }

    return splitDestinationAndMessage(rest);
  }

  return { kind: 'inline', destination: null, message: rest };
}

function extractInlineBroadcastMessage(summary) {
  const parsed = parseBroadcastUtterance(summary);
  if (parsed?.kind === 'inline' && parsed.message) {
    return parsed.message;
  }
  return null;
}

function isBroadcastCommandOnly(summary) {
  const parsed = parseBroadcastUtterance(summary);
  return parsed?.kind === 'command-only';
}

module.exports = {
  parseBroadcastUtterance,
  extractInlineBroadcastMessage,
  isBroadcastCommandOnly,
  destinationLooksLikeDevice,
  messageLooksLikeContent,
  splitDestinationAndMessage,
};