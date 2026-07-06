const { parseBatteryPercentFromSpeech } = require('./tesla-battery');

const DEFAULT_TTL_MS = 90000;

function pendingKey(device, kind) {
  return `${String(device || 'unknown').toLowerCase()}|${kind}`;
}

function createPendingVoiceResponses({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const pending = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of pending) {
      if (now - entry.at > ttlMs) {
        pending.delete(key);
      }
    }
  }

  function remember(event, now = Date.now()) {
    if (!event?.device || !event?.kind) {
      return;
    }

    if (event.kind === 'tesla-battery') {
      if (parseBatteryPercentFromSpeech(event.spokenResponse) != null) {
        return;
      }
      pending.set(pendingKey(event.device, 'tesla-battery'), { event, at: now });
      prune(now);
      return;
    }

    if (event.kind === 'shopping-list' && event.trigger === 'shopping-list-show') {
      pending.set(pendingKey(event.device, 'shopping-list-show'), { event, at: now });
      prune(now);
    }
  }

  function forget(device, kind) {
    pending.delete(pendingKey(device, kind));
  }

  function tryComplete(activity, spokenResponse, helpers, now = Date.now()) {
    const response = String(spokenResponse || '').trim();
    if (!response) {
      return null;
    }

    const device = helpers.getDeviceName(activity);
    prune(now);

    const teslaPending = pending.get(pendingKey(device, 'tesla-battery'));
    if (teslaPending && now - teslaPending.at <= ttlMs) {
      const percent = parseBatteryPercentFromSpeech(response);
      if (percent != null && /\bbattery\b/i.test(response)) {
        pending.delete(pendingKey(device, 'tesla-battery'));
        return {
          ...teslaPending.event,
          activityId: helpers.getActivityId(activity),
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'tesla-battery-response',
        };
      }
    }

    const shoppingPending = pending.get(pendingKey(device, 'shopping-list-show'));
    if (shoppingPending && now - shoppingPending.at <= ttlMs) {
      if (helpers.matchesShoppingListSpeech(response, shoppingPending.event.query)) {
        pending.delete(pendingKey(device, 'shopping-list-show'));
        return {
          ...shoppingPending.event,
          activityId: helpers.getActivityId(activity),
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'shopping-list-show',
        };
      }
    }

    return null;
  }

  return {
    remember,
    forget,
    tryComplete,
    pendingKey,
  };
}

module.exports = {
  createPendingVoiceResponses,
  DEFAULT_TTL_MS,
};
