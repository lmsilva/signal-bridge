// Detect "turn X on/off" style voice commands and classify the target device.

const TURN_TARGET_RE = /\b(?:turn|switch|power)\s+(?:on|off)\s+(?:the\s+|my\s+)?(.+?)(?:\?|[.!]|$)/i;
const TURN_TRAILING_RE = /\b(?:turn|switch|power)\s+(?:the\s+|my\s+)?(.+?)\s+(on|off)\b/i;
const BARE_ONOFF_RE = /^(?:the\s+|my\s+)?(.+?)\s+(on|off)$/i;

const TYPE_KEYWORDS = [
  ['light', /\b(?:light|lights|lamp|sconce|chandelier|bulb)\b/i],
  ['plug', /\b(?:plug|outlet|socket)\b/i],
  ['fan', /\b(?:fan|ceiling fan)\b/i],
  ['tv', /\b(?:tv|television|projector|screen)\b/i],
  ['pc', /\b(?:pc|computer|desktop)\b/i],
  ['switch', /\b(?:switch)\b/i],
];

const CATEGORY_TYPES = {
  LIGHT: 'light',
  SMARTLOCK: 'lock',
  SMARTPLUG: 'plug',
  SWITCH: 'switch',
  FAN: 'fan',
  TV: 'tv',
  SCENE_TRIGGER: 'scene',
  ACTIVITY_TRIGGER: 'scene',
  THERMOSTAT: 'thermostat',
};

function parseSmartHomeCommand(summary) {
  const text = String(summary || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/^alexa[,\s]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return null;
  }

  const onOff = text.match(/\b(on|off)\b/i);
  if (!onOff) {
    return null;
  }
  if (!/\b(?:turn|switch|power|lights?|lamp|plug|fan)\b/i.test(text)) {
    return null;
  }
  // Not a device command: media, timers, alarms.
  if (/\b(?:timer|alarm|music|song|playlist|volume|announce|broadcast)\b/i.test(text)) {
    return null;
  }

  let target = null;
  let action = null;

  const trailing = text.match(TURN_TRAILING_RE);
  if (trailing) {
    target = trailing[1];
    action = trailing[2].toLowerCase();
  }

  if (!target) {
    const leading = text.match(TURN_TARGET_RE);
    const leadingAction = text.match(/\b(?:turn|switch|power)\s+(on|off)\b/i);
    if (leading && leadingAction) {
      target = leading[1];
      action = leadingAction[1].toLowerCase();
    }
  }

  if (!target) {
    const bare = text.match(BARE_ONOFF_RE);
    if (bare && /\b(?:lights?|lamp|plug|fan|tv)\b/i.test(bare[1])) {
      target = bare[1];
      action = bare[2].toLowerCase();
    }
  }

  if (!target || !action) {
    return null;
  }

  target = target.replace(/\b(?:please|alexa|now)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!target) {
    return null;
  }

  return { action, target };
}

function keywordDeviceType(target) {
  for (const [type, pattern] of TYPE_KEYWORDS) {
    if (pattern.test(target || '')) {
      return type;
    }
  }
  return null;
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const GENERIC_TARGETS = new Set([
  'light', 'lights', 'lamp', 'lamps', 'the light', 'the lights',
  'plug', 'plugs', 'fan', 'fans', 'switch', 'switches',
]);

function isGenericTarget(target) {
  const normalized = normalizeName(target);
  if (!normalized) {
    return true;
  }
  if (GENERIC_TARGETS.has(normalized)) {
    return true;
  }
  return /^(?:the\s+)?(?:\w+\s+){0,2}(?:lights?|lamps?|plugs?|fans?)$/.test(normalized);
}

function scoreEndpointMatch(name, needle) {
  if (!name || !needle) {
    return 0;
  }
  if (name === needle) {
    return 100;
  }
  if (needle.length >= 4 && name.includes(needle)) {
    return 70 + Math.min(needle.length, 20);
  }
  if (name.length >= 4 && needle.includes(name)) {
    return 50 + Math.min(name.length, 20);
  }
  return 0;
}

function resolveDeviceType(endpoints, target) {
  const needle = normalizeName(target);
  if (needle && !isGenericTarget(target)) {
    let best = null;
    let bestScore = 0;
    for (const endpoint of endpoints || []) {
      const name = normalizeName(endpoint.friendlyName || endpoint.legacyName);
      const score = scoreEndpointMatch(name, needle);
      if (score > bestScore) {
        bestScore = score;
        best = endpoint;
      }
    }
    if (best && bestScore >= 50) {
      const mapped = CATEGORY_TYPES[String(best.category || '').toUpperCase()];
      if (mapped) {
        return { deviceType: mapped, matchedName: best.friendlyName || best.legacyName };
      }
      return {
        deviceType: keywordDeviceType(target) || 'device',
        matchedName: best.friendlyName || best.legacyName,
      };
    }
  }

  return { deviceType: keywordDeviceType(target) || 'device', matchedName: null };
}

module.exports = {
  parseSmartHomeCommand,
  resolveDeviceType,
  keywordDeviceType,
  isGenericTarget,
  CATEGORY_TYPES,
};
