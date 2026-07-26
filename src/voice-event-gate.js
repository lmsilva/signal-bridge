const { resolveIndoorQueryLocation } = require('./indoor-temperature');

function hasSpokenResponse(event) {
  return Boolean(String(event?.spokenResponse || '').trim());
}

function needsSpokenResponseUpgrade(event, config = {}) {
  if (!event || hasSpokenResponse(event)) {
    return false;
  }

  if (event.kind === 'tesla-battery') {
    return false;
  }

  if (event.kind === 'tesla-dashboard') {
    return false;
  }

  // "play …" waits for Alexa's "Playing…" confirmation; a now-playing
  // query ("what's playing" / "what's this song") and a skip/next already
  // have everything they need from the query text + the player-info API
  // (Alexa often only beeps on skip), so don't stall waiting on speech.
  if (event.kind === 'music') {
    return event.trigger === 'music-play';
  }

  if (event.kind === 'vivint-alarm' || event.kind === 'alexa-notifications') {
    return true;
  }

  if (event.kind === 'shopping-list' && event.trigger === 'shopping-list-show') {
    return true;
  }

  // An indoor query naming a room we can't map to a sensor is usually a
  // misheard transcript; wait for Alexa's answer instead of flashing a wrong
  // location on screen (the answer may name the real room, or never come).
  if (event.kind === 'indoor-temperature') {
    const location = resolveIndoorQueryLocation(event.query, null, config?.indoorTemperature || {});
    return !location?.matched;
  }

  return false;
}

function shouldMarkActivityProcessed(event, config = {}) {
  return !needsSpokenResponseUpgrade(event, config);
}

module.exports = {
  hasSpokenResponse,
  needsSpokenResponseUpgrade,
  shouldMarkActivityProcessed,
};
