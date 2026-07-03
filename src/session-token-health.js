function tokenDateMs(sessionMeta) {
  if (!sessionMeta?.tokenDate) {
    return null;
  }
  const parsed = Date.parse(sessionMeta.tokenDate);
  return Number.isNaN(parsed) ? null : parsed;
}

function isTokenRotationStalled(sessionMeta, thresholdHours = 20) {
  const age = sessionMeta?.tokenAgeHours;
  return age != null && age >= thresholdHours;
}

function tokenDateAdvanced(previousMeta, nextMeta) {
  const previous = tokenDateMs(previousMeta);
  const next = tokenDateMs(nextMeta);
  if (next == null) {
    return false;
  }
  if (previous == null) {
    return true;
  }
  return next > previous + 60_000;
}

function isRefreshDeferralMessage(message) {
  return String(message || '').toLowerCase() === 'refresh already in flight';
}

function isCookieRenewFailure(message) {
  return /cookie invalid.*renew unsuccessful/i.test(String(message || ''));
}

module.exports = {
  tokenDateMs,
  isTokenRotationStalled,
  tokenDateAdvanced,
  isRefreshDeferralMessage,
  isCookieRenewFailure,
};
