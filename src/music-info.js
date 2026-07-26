// Detect "play <song/artist/...>" voice commands and "what song is playing"
// queries, then fetch now-playing info for either.

const PLAY_MUSIC_RE = /^(?:alexa[,\s]+)?play\b/i;
const MUSIC_BLOCKLIST_RE = /\b(?:timer|alarm|announcement|game|jeopardy|question)\b/i;
const SPOKEN_PLAYING_RE = /\bplaying\b/i;

// "what song is playing", "which song is playing", "what is this song",
// "what's playing", "what song is this/on", "who sings this (song)",
// "name this/that song" — asking about music that's *already* playing,
// as opposed to PLAY_MUSIC_RE which starts new playback.
const NOW_PLAYING_QUERY_RE = /\b(?:what(?:'s|\s+is)?\s+(?:this\s+)?song(?:\s+is\s+(?:this|playing|on))?|which\s+song\s+is\s+playing|what(?:'s|\s+is)?\s+(?:currently\s+)?playing|who\s+sings?\s+this(?:\s+song)?|name\s+(?:this|that)\s+song)\b/i;

function matchesMusicQuery(summary, response) {
  const text = String(summary || '').trim();
  if (!text || MUSIC_BLOCKLIST_RE.test(text)) {
    return false;
  }
  if (PLAY_MUSIC_RE.test(text)) {
    return true;
  }
  return /\bplay\s+(?:some\s+)?(?:music|songs?|album|playlist|station)\b/i.test(text)
    && SPOKEN_PLAYING_RE.test(String(response || ''));
}

function matchesNowPlayingQuery(summary) {
  const text = String(summary || '').trim();
  if (!text || MUSIC_BLOCKLIST_RE.test(text)) {
    return false;
  }
  return NOW_PLAYING_QUERY_RE.test(text);
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
  PLAY_MUSIC_RE,
  NOW_PLAYING_QUERY_RE,
};
