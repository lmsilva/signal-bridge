function hasSpokenResponse(event) {
  return Boolean(String(event?.spokenResponse || '').trim());
}

function needsSpokenResponseUpgrade(event) {
  if (!event || hasSpokenResponse(event)) {
    return false;
  }

  if (event.kind === 'tesla-battery' || event.kind === 'music') {
    return true;
  }

  if (event.kind === 'vivint-alarm' || event.kind === 'alexa-notifications') {
    return true;
  }

  if (event.kind === 'shopping-list' && event.trigger === 'shopping-list-show') {
    return true;
  }

  return false;
}

function shouldMarkActivityProcessed(event) {
  return !needsSpokenResponseUpgrade(event);
}

module.exports = {
  hasSpokenResponse,
  needsSpokenResponseUpgrade,
  shouldMarkActivityProcessed,
};
