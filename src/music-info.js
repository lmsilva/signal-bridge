// Detect "play <song/artist/...>" voice commands, "what song is playing"
// queries, and "next"/"skip" track advances — then fetch now-playing info.

const PLAY_MUSIC_RE = /^(?:alexa[,\s]+)?play\b/i;
const MUSIC_BLOCKLIST_RE = /\b(?:timer|alarm|announcement|game|jeopardy|question)\b/i;
const SPOKEN_PLAYING_RE = /\bplaying\b/i;

// "what song is playing", "which song is playing", "what is this song",
// "what's playing", "whats playing" (no apostrophe — common ASR),
// "what song is this/on", "who sings this (song)", "name this/that song",
// "identify this song" — asking about music that's *already* playing,
// as opposed to PLAY_MUSIC_RE which starts new playback.
const NOW_PLAYING_QUERY_RE = /\b(?:what(?:'s|\s+is)?\s+(?:this\s+)?song(?:\s+is\s+(?:this|playing|on))?|which\s+song\s+is\s+playing|what(?:'s|\s+is)?\s+(?:currently\s+)?playing|who\s+sings?\s+this(?:\s+song)?|name\s+(?:this|that)\s+song|identify\s+(?:this|that)\s+song|tell\s+me\s+what\s+song\s+this\s+is)\b/i;

// When the activity transcript is empty but Alexa already answered with a
// now-playing line ("Currently playing …", "This is X by Y"), still treat
// it as a now-playing query so we don't silently drop the display.
const NOW_PLAYING_ANSWER_RE = /\b(?:currently\s+playing|now\s+playing|you'?re\s+listening\s+to|this\s+is\s+.+\s+by\s+)\b/i;

// Whole-utterance skip/next. Bare "next"/"skip" is shared with news/briefings;
// explicit "... song/track" phrases are music-intent regardless of provider.
const MUSIC_SKIP_RE = /^(?:alexa[,\s]+)?(?:next(?:\s+(?:song|track|one))?|skip(?:\s+(?:(?:this|the)\s+)?(?:song|track))?)(?:\s+please)?[.!?]*$/i;
const MUSIC_SKIP_EXPLICIT_SONG_RE = /\b(?:song|track)\b/i;

// Providers that mean "advance the next thing" but are not a song card.
const NON_MUSIC_PROVIDER_RE = /\b(?:flash\s*briefing|news|audible|kindle|podcast|npr|bbc\s*news|iheart\s*news|siriusxm\s*news)\b/i;
const MUSIC_PROVIDER_RE = /\b(?:amazon\s*music|spotify|apple\s*music|pandora|youtube\s*music|deezer|tidal|iheartradio|iheart\s*radio|sirius(?:xm)?|tunein|amazon\s*unlimited)\b/i;

function normalizeQueryText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    // Amazon ASR often drops the apostrophe ("whats playing" / "whats this song").
    .replace(/\bwhats\b/gi, "what's")
    .replace(/\bwhos\b/gi, "who's")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesMusicQuery(summary, response) {
  const text = normalizeQueryText(summary);
  if (!text || MUSIC_BLOCKLIST_RE.test(text)) {
    return false;
  }
  if (PLAY_MUSIC_RE.test(text)) {
    return true;
  }
  return /\bplay\s+(?:some\s+)?(?:music|songs?|album|playlist|station)\b/i.test(text)
    && SPOKEN_PLAYING_RE.test(String(response || ''));
}

function matchesNowPlayingQuery(summary, response) {
  const text = normalizeQueryText(summary);
  if (text && !MUSIC_BLOCKLIST_RE.test(text) && NOW_PLAYING_QUERY_RE.test(text)) {
    return true;
  }
  // Empty transcript + Alexa already answering with a now-playing line
  // (history sometimes omits description.summary on the first poll).
  const spoken = normalizeQueryText(response);
  if (!text && spoken && !MUSIC_BLOCKLIST_RE.test(spoken) && NOW_PLAYING_ANSWER_RE.test(spoken)) {
    return true;
  }
  return false;
}

/**
 * History often joins wake-word + echo of the same command:
 * "alexa next, next" / "next | next". Each segment must still look like a
 * skip on its own so "what's next, next" does not sneak through.
 */
function skipQueryCandidates(summary) {
  const text = normalizeQueryText(summary);
  if (!text) {
    return [];
  }
  const parts = text
    .split(/\s*[,|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => MUSIC_SKIP_RE.test(part))) {
    return parts;
  }
  return [text];
}

function matchesMusicSkipQuery(summary) {
  const candidates = skipQueryCandidates(summary);
  if (!candidates.length || candidates.some((part) => MUSIC_BLOCKLIST_RE.test(part))) {
    return false;
  }
  return candidates.every((part) => MUSIC_SKIP_RE.test(part));
}

function isExplicitSongSkipQuery(summary) {
  const candidates = skipQueryCandidates(summary);
  return candidates.some(
    (part) => MUSIC_SKIP_RE.test(part) && MUSIC_SKIP_EXPLICIT_SONG_RE.test(part),
  );
}

function isMusicPlayerContent(nowPlaying, { explicitSongSkip = false } = {}) {
  if (!nowPlaying || !nowPlaying.song) {
    return false;
  }
  if (explicitSongSkip) {
    return true;
  }
  const provider = String(nowPlaying.provider || '').trim();
  if (provider && NON_MUSIC_PROVIDER_RE.test(provider)) {
    return false;
  }
  if (provider && MUSIC_PROVIDER_RE.test(provider)) {
    return true;
  }
  // Song-like card: title + artist, and not a known non-music provider.
  return Boolean(nowPlaying.artist);
}

function emptyNowPlaying(device) {
  return {
    song: null,
    artist: null,
    album: null,
    artUrl: null,
    provider: null,
    state: 'IDLE',
    device: device || null,
    empty: true,
  };
}

/**
 * Decide what a music-query / music-skip retry should do after a fetch attempt.
 * music-query emits an explicit empty card when exhausted; music-skip stays silent
 * so news/briefing advances never flash "Nothing playing".
 */
function musicQueryRetryOutcome({
  trigger,
  attempt = 1,
  maxAttempts = 2,
  nowPlaying = null,
} = {}) {
  if (nowPlaying) {
    return { action: 'emit', nowPlaying };
  }
  if (attempt < maxAttempts) {
    return { action: 'retry' };
  }
  if (trigger === 'music-skip') {
    return { action: 'silent' };
  }
  return { action: 'emit-empty' };
}

/**
 * Parse Alexa's spoken now-playing answer when player-info on the asked
 * device is idle (common: song is playing on another Echo).
 */
function parseSpokenNowPlaying(spoken, device = null) {
  const text = normalizeQueryText(spoken);
  if (!text || /\b(?:nothing|not)\s+(?:is\s+)?playing\b/i.test(text)) {
    return null;
  }

  const patterns = [
    /\b(?:currently\s+playing|now\s+playing|you'?re\s+listening\s+to)\s+(.+?)\s+by\s+(.+?)(?:\s+on\s+(.+))?[.!]?$/i,
    /\bthis\s+is\s+(.+?)\s+by\s+(.+?)(?:\s+on\s+(.+))?[.!]?$/i,
    /\bplaying\s+(.+?)\s+by\s+(.+?)(?:\s+on\s+(.+))?[.!]?$/i,
    /^(.+?)\s+by\s+(.+?)\s+is\s+playing(?:\s+on\s+(.+))?[.!]?$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const song = String(match[1] || '').replace(/[?.!]+$/, '').trim();
    const artist = String(match[2] || '').replace(/[?.!]+$/, '').trim();
    const playingOn = String(match[3] || '').replace(/[?.!]+$/, '').trim() || null;
    if (!song || !artist || song.length > 120 || artist.length > 80) {
      continue;
    }
    if (/^(?:the|a|an|it|this|that)$/i.test(song)) {
      continue;
    }
    return {
      song,
      artist,
      album: null,
      artUrl: null,
      provider: null,
      state: 'PLAYING',
      device: playingOn || device || null,
      source: 'spoken',
    };
  }

  return null;
}

function listAlexaMediaDevices(alexa) {
  const devices = [];
  const seen = new Set();
  for (const device of Object.values(alexa?.serialNumbers || {})) {
    const serial = String(device?.serialNumber || '').trim();
    if (!serial || seen.has(serial)) {
      continue;
    }
    seen.add(serial);
    devices.push({
      serial,
      name: device.accountName || device._name || serial,
    });
  }
  return devices;
}

/**
 * True when `id` is a real Echo / media endpoint alexa-remote2 can resolve.
 * Web Quick Push defaults device to "Signal", which is not an Alexa player —
 * preferred getPlayerInfo always fails and must not burn retry sleeps.
 */
function isKnownAlexaMediaDevice(alexa, id) {
  const key = String(id || '').trim();
  if (!key || /^signal$/i.test(key)) {
    return false;
  }
  if (typeof alexa?.find === 'function') {
    try {
      if (alexa.find(key)) {
        return true;
      }
    } catch {
      // fall through to serialNumbers scan
    }
  }
  const lower = key.toLowerCase();
  return listAlexaMediaDevices(alexa).some((entry) => (
    String(entry.serial || '').toLowerCase() === lower
    || String(entry.name || '').toLowerCase() === lower
  ));
}

function getPlayerInfoOnce(alexa, serialOrName) {
  return new Promise((resolve) => {
    try {
      alexa.getPlayerInfo(serialOrName, (err, body) => {
        resolve(err ? null : body?.playerInfo || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Alexa player-info `progress.mediaLength` / `mediaProgress` are usually
 * milliseconds. Coerce them as a *pair*: if either value (or an explicit
 * `*InMilliseconds` field) looks like ms, treat both as ms. Converting them
 * independently breaks the first ~10s of a track — e.g. length 225000 → 225s
 * while progress 3500 stays "3500s", so the client thinks the song is over
 * and auto-dismisses right after skip / what's-playing.
 */
function coerceMediaSeconds(value) {
  if (value == null || value === '') {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  if (n >= 10000) {
    return Math.round(n / 1000);
  }
  return Math.round(n);
}

function extractMediaProgress(playerInfo) {
  const progress = playerInfo?.progress || {};
  const lengthRaw = progress.mediaLengthInMilliseconds ?? progress.mediaLength;
  const progressRaw = progress.mediaProgressInMilliseconds ?? progress.mediaProgress;
  const lengthN = lengthRaw == null || lengthRaw === '' ? null : Number(lengthRaw);
  const progressN = progressRaw == null || progressRaw === '' ? null : Number(progressRaw);
  const lengthOk = Number.isFinite(lengthN) && lengthN >= 0;
  const progressOk = Number.isFinite(progressN) && progressN >= 0;
  if (!lengthOk && !progressOk) {
    return null;
  }

  const explicitMs = progress.mediaLengthInMilliseconds != null
    || progress.mediaProgressInMilliseconds != null;
  const eitherLooksMs = explicitMs
    || (lengthOk && lengthN >= 10000)
    || (progressOk && progressN >= 10000);

  let mediaLengthSec = lengthOk
    ? Math.round(eitherLooksMs ? lengthN / 1000 : lengthN)
    : null;
  let mediaProgressSec = progressOk
    ? Math.round(eitherLooksMs ? progressN / 1000 : progressN)
    : null;

  // Safety: progress cannot exceed length; if it still does, prefer ms decode
  // of the raw progress against a seconds length.
  if (
    mediaLengthSec != null
    && mediaProgressSec != null
    && mediaProgressSec > mediaLengthSec
    && progressOk
    && !eitherLooksMs
    && progressN >= 1000
  ) {
    mediaProgressSec = Math.round(progressN / 1000);
  }
  if (mediaLengthSec != null && mediaProgressSec != null) {
    mediaProgressSec = Math.min(mediaProgressSec, mediaLengthSec);
  }

  return {
    mediaLengthSec: mediaLengthSec != null && mediaLengthSec > 0 ? mediaLengthSec : null,
    mediaProgressSec: mediaProgressSec != null && mediaProgressSec >= 0
      ? mediaProgressSec
      : null,
    progressAt: new Date().toISOString(),
  };
}

function normalizePlayerInfo(playerInfo, device) {
  if (!playerInfo) {
    return null;
  }
  const info = playerInfo.infoText || {};
  const song = String(info.title || '').trim() || null;
  if (!song) {
    return null;
  }
  const timing = extractMediaProgress(playerInfo) || {};
  return {
    song,
    artist: String(info.subText1 || '').trim() || null,
    album: String(info.subText2 || '').trim() || null,
    artUrl: playerInfo.mainArt?.url || null,
    provider: playerInfo.provider?.providerDisplayName || playerInfo.provider?.providerName || null,
    state: playerInfo.state || null,
    device: device || null,
    mediaLengthSec: timing.mediaLengthSec ?? null,
    mediaProgressSec: timing.mediaProgressSec ?? null,
    progressAt: timing.progressAt ?? null,
  };
}

// Playback usually starts a few seconds after Alexa confirms; retry until we
// see a PLAYING state with a track title.
async function fetchNowPlaying(alexa, serialOrName, device, { attempts = 4, delayMs = 1500 } = {}) {
  let lastSeen = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const playerInfo = await getPlayerInfoOnce(alexa, serialOrName);
    const normalized = normalizePlayerInfo(playerInfo, device);
    if (normalized) {
      lastSeen = normalized;
      if (normalized.state === 'PLAYING') {
        return normalized;
      }
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return lastSeen;
}

/**
 * "What's playing?" often targets an idle Echo while music plays elsewhere.
 * Prefer the asked device (when it is a real Alexa media endpoint), then scan
 * other household devices. Web Quick Push uses device "Signal" — skip the
 * preferred lookup entirely and scan immediately. Prefer PLAYING; if nothing
 * is actively playing, accept paused music content (same as preferred path).
 */
async function fetchNowPlayingHousehold(
  alexa,
  preferredSerial,
  preferredDevice,
  { attempts = 3, delayMs = 900, scanAttempts = 1 } = {},
) {
  const preferredKnown = isKnownAlexaMediaDevice(alexa, preferredSerial)
    || isKnownAlexaMediaDevice(alexa, preferredDevice);

  let preferred = null;
  if (preferredKnown) {
    preferred = await fetchNowPlaying(alexa, preferredSerial, preferredDevice, {
      attempts,
      delayMs,
    });
    if (preferred && preferred.state === 'PLAYING' && isMusicPlayerContent(preferred)) {
      return preferred;
    }
    if (preferred && isMusicPlayerContent(preferred)) {
      return preferred;
    }
  }

  const preferredKey = preferredKnown
    ? String(preferredSerial || '').trim().toLowerCase()
    : '';
  const preferredName = preferredKnown
    ? String(preferredDevice || '').trim().toLowerCase()
    : '';
  // Unknown preferred (Signal / web): poll each device a bit harder once —
  // there is no spoken "X by Y" fallback on web pushes.
  const effectiveScanAttempts = preferredKnown
    ? scanAttempts
    : Math.max(scanAttempts, 2);
  let pausedFallback = null;
  for (const entry of listAlexaMediaDevices(alexa)) {
    const serialKey = String(entry.serial || '').trim().toLowerCase();
    const nameKey = String(entry.name || '').trim().toLowerCase();
    if (preferredKey && serialKey === preferredKey) {
      continue;
    }
    if (preferredName && nameKey === preferredName) {
      continue;
    }
    const info = await fetchNowPlaying(alexa, entry.serial, entry.name, {
      attempts: effectiveScanAttempts,
      delayMs: 0,
    });
    if (!info || !isMusicPlayerContent(info)) {
      continue;
    }
    if (info.state === 'PLAYING') {
      return info;
    }
    if (!pausedFallback) {
      pausedFallback = info;
    }
  }

  return pausedFallback || preferred || null;
}

/**
 * Resolve a music-query ("what's playing") to a card: local player, other
 * household Echo that is PLAYING, or Alexa's spoken song/artist answer.
 */
async function resolveMusicQueryNowPlaying(alexa, event, fetchOptions = {}) {
  const serialOrName = event?.deviceSerial || event?.device;
  let nowPlaying = await fetchNowPlayingHousehold(
    alexa,
    serialOrName,
    event?.device,
    fetchOptions,
  );
  if (nowPlaying && isMusicPlayerContent(nowPlaying)) {
    return nowPlaying;
  }

  const fromSpeech = parseSpokenNowPlaying(event?.spokenResponse, event?.device);
  if (fromSpeech && isMusicPlayerContent(fromSpeech)) {
    return fromSpeech;
  }

  return null;
}

/**
 * After "next"/"skip", player-info often still reports the old track as
 * PLAYING for a beat. Prefer a title that differs from the first poll; if
 * the skip already finished before we looked (title never changes across
 * the budget), return the settled lastSeen so the card still appears.
 * Caller should run isMusicPlayerContent before showing a card.
 */
async function fetchNowPlayingAfterSkip(
  alexa,
  serialOrName,
  device,
  { attempts = 5, delayMs = 1200, householdFallback = true } = {},
) {
  let baselineTitle = null;
  let lastSeen = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const playerInfo = await getPlayerInfoOnce(alexa, serialOrName);
    const normalized = normalizePlayerInfo(playerInfo, device);
    if (normalized) {
      lastSeen = normalized;
      if (baselineTitle == null) {
        baselineTitle = normalized.song;
      } else if (
        normalized.song
        && normalized.song !== baselineTitle
        && normalized.state === 'PLAYING'
      ) {
        return normalized;
      }
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  if (lastSeen) {
    return lastSeen;
  }
  // Skip said on an idle Echo while music plays elsewhere — same household
  // scan "what's playing" already uses.
  if (householdFallback) {
    return fetchNowPlayingHousehold(alexa, serialOrName, device, {
      attempts: 2,
      delayMs: 400,
      scanAttempts: 1,
    });
  }
  return null;
}

module.exports = {
  matchesMusicQuery,
  matchesNowPlayingQuery,
  matchesMusicSkipQuery,
  isExplicitSongSkipQuery,
  isMusicPlayerContent,
  fetchNowPlaying,
  fetchNowPlayingHousehold,
  fetchNowPlayingAfterSkip,
  resolveMusicQueryNowPlaying,
  parseSpokenNowPlaying,
  listAlexaMediaDevices,
  isKnownAlexaMediaDevice,
  normalizePlayerInfo,
  coerceMediaSeconds,
  extractMediaProgress,
  emptyNowPlaying,
  musicQueryRetryOutcome,
  normalizeQueryText,
  PLAY_MUSIC_RE,
  NOW_PLAYING_QUERY_RE,
  MUSIC_SKIP_RE,
};
