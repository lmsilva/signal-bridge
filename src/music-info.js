// Detect "play <song/artist/...>" voice commands and "what song is playing"
// queries, then fetch now-playing info for either.

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

function normalizePlayerInfo(playerInfo, device) {
  if (!playerInfo) {
    return null;
  }
  const info = playerInfo.infoText || {};
  const song = String(info.title || '').trim() || null;
  if (!song) {
    return null;
  }
  return {
    song,
    artist: String(info.subText1 || '').trim() || null,
    album: String(info.subText2 || '').trim() || null,
    artUrl: playerInfo.mainArt?.url || null,
    provider: playerInfo.provider?.providerDisplayName || playerInfo.provider?.providerName || null,
    state: playerInfo.state || null,
    device: device || null,
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

module.exports = {
  matchesMusicQuery,
  matchesNowPlayingQuery,
  fetchNowPlaying,
  normalizePlayerInfo,
  emptyNowPlaying,
  normalizeQueryText,
  PLAY_MUSIC_RE,
  NOW_PLAYING_QUERY_RE,
};
