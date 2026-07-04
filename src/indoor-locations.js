const DEFAULT_INDOOR_LOCATIONS = [
  {
    id: 'main-floor',
    label: 'Main Floor',
    entity: 'main floor',
    aliases: ['main floor', 'downstairs'],
  },
  {
    id: 'top-floor',
    label: 'Top Floor',
    entity: 'top floor',
    aliases: ['top floor', 'upstairs'],
  },
  {
    id: 'basement',
    label: 'Basement',
    entity: 'basement ecobee sensor',
    aliases: ['basement ecobee sensor', 'basement ecobee', 'basement sensor', 'basement'],
  },
  {
    id: 'guest-bedroom',
    label: 'Guest Bedroom',
    entity: 'guest bedroom ecobee sensor',
    aliases: ['guest bedroom ecobee sensor', 'guest bedroom ecobee', 'guest bedroom sensor', 'guest bedroom', 'guest room'],
  },
  {
    id: 'living-room',
    label: 'Living Room',
    entity: 'living room ecobee sensor',
    aliases: ['living room ecobee sensor', 'living room ecobee', 'living room sensor', 'living room'],
  },
  {
    id: 'office',
    label: 'Office',
    entity: 'office ecobee sensor',
    aliases: ['office ecobee sensor', 'office ecobee', 'office sensor', 'office'],
  },
  {
    id: 'playroom',
    label: 'Playroom',
    entity: 'playroom ecobee sensor',
    aliases: ['playroom ecobee sensor', 'playroom ecobee', 'playroom sensor', 'playroom'],
  },
  {
    id: 'Bedroom 2',
    label: 'Bedroom 3',
    entity: 'Bedroom 4',
    aliases: [
      'Bedroom 4',
      'Office',
      'Playroom',
      'Room 7',
      'bedroom echo',
      'bedroom ecobee',
      'primary bedroom',
      'main bedroom',
    ],
  },
  {
    id: 'Room 8',
    label: 'Room 9',
    entity: 'Room 10',
    aliases: ['Room 10', 'Room 12', 'Room 13', 'Room 14', 'Room 16 room'],
  },
  {
    id: 'Room 12',
    label: 'Room 9',
    entity: 'Bedroom 2',
    aliases: ['Bedroom 2', 'Guest Room', 'Office', 'Room 11', 'Room 15'],
  },
];

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanupLocationPhrase(value) {
  return normalizeText(value)
    .replace(/[?.!]+$/, '')
    .replace(/\s+(?:temperature|temp|humidity)$/i, '')
    .trim();
}

function getIndoorLocations(config = {}) {
  const configured = config.locations;
  if (Array.isArray(configured) && configured.length) {
    return configured;
  }
  return DEFAULT_INDOOR_LOCATIONS;
}

function buildAliasIndex(locations) {
  const entries = [];

  for (const location of locations) {
    const aliases = new Set([location.entity, location.label, ...(location.aliases || [])]);
    for (const alias of aliases) {
      const normalized = normalizeText(alias);
      if (normalized) {
        entries.push({ location, alias: normalized });
      }
    }
  }

  return entries.sort((left, right) => right.alias.length - left.alias.length);
}

function resolveIndoorLocation(query, config = {}) {
  const locations = getIndoorLocations(config);
  const phrase = cleanupLocationPhrase(query);
  const normalizedPhrase = normalizeText(phrase);

  if (!normalizedPhrase) {
    return {
      query: phrase || null,
      label: null,
      entity: null,
      scope: 'indoor',
      matched: false,
    };
  }

  const aliasIndex = buildAliasIndex(locations);

  for (const entry of aliasIndex) {
    if (normalizedPhrase === entry.alias) {
      return {
        query: phrase,
        label: entry.location.label,
        entity: entry.location.entity,
        id: entry.location.id,
        scope: 'indoor',
        matched: true,
        matchedAlias: entry.alias,
      };
    }
  }

  for (const entry of aliasIndex) {
    if (
      normalizedPhrase.includes(entry.alias)
      || entry.alias.includes(normalizedPhrase)
    ) {
      return {
        query: phrase,
        label: entry.location.label,
        entity: entry.location.entity,
        id: entry.location.id,
        scope: 'indoor',
        matched: true,
        matchedAlias: entry.alias,
      };
    }
  }

  return {
    query: phrase,
    label: titleCasePhrase(phrase),
    entity: phrase,
    scope: 'indoor',
    matched: false,
  };
}

function titleCasePhrase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

module.exports = {
  DEFAULT_INDOOR_LOCATIONS,
  cleanupLocationPhrase,
  getIndoorLocations,
  resolveIndoorLocation,
  normalizeText,
};
