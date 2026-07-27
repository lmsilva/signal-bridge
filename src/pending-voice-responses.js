const { hasAlarmStatusInSpeech } = require('./vivint-alarm');
const { hasNotificationContent } = require('./alexa-notifications');
const { extractRouteLocations, spokenHasRouteAnswer } = require('./route-query');

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

    if (event.kind === 'shopping-list' && event.trigger === 'shopping-list-show') {      pending.set(pendingKey(event.device, 'shopping-list-show'), { event, at: now });
      prune(now);
      return;
    }

    if (event.kind === 'vivint-alarm') {
      if (hasAlarmStatusInSpeech(event.spokenResponse)) {
        return;
      }
      pending.set(pendingKey(event.device, 'vivint-alarm'), { event, at: now });
      prune(now);
      return;
    }

    if (event.kind === 'alexa-notifications') {
      if (hasNotificationContent(event.spokenResponse)) {
        return;
      }
      pending.set(pendingKey(event.device, 'alexa-notifications'), { event, at: now });
      prune(now);
      return;
    }

    if (event.kind === 'route') {
      pending.set(pendingKey(event.device, 'route'), { event, at: now });
      prune(now);
      return;
    }

    // Keep a short window after an AQ ask so empty-summary temperature TTS
    // from the same Echo (sensor side-channel) does not flash outdoor weather.
    if (event.kind === 'air-quality') {
      pending.set(pendingKey(event.device, 'air-quality'), { event, at: now });
      prune(now);
    }
  }

  function forget(device, kind) {
    pending.delete(pendingKey(device, kind));
  }

  function hasPending(device, kind, now = Date.now()) {
    prune(now);
    return pending.has(pendingKey(device, kind));
  }

  function tryComplete(activity, spokenResponse, helpers, now = Date.now()) {
    const response = String(spokenResponse || '').trim();
    if (!response) {
      return null;
    }

    const device = helpers.getDeviceName(activity);
    prune(now);

    const shoppingPending = pending.get(pendingKey(device, 'shopping-list-show'));    if (shoppingPending && now - shoppingPending.at <= ttlMs) {
      if (helpers.matchesShoppingListSpeech(response, shoppingPending.event.query)) {
        pending.delete(pendingKey(device, 'shopping-list-show'));
        return {
          ...shoppingPending.event,
          activityId: helpers.getActivityId(activity),
          sourceActivityId: shoppingPending.event.activityId || null,
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'shopping-list-show',
        };
      }
    }

    const vivintPending = pending.get(pendingKey(device, 'vivint-alarm'));
    if (vivintPending && now - vivintPending.at <= ttlMs) {
      if (hasAlarmStatusInSpeech(response)) {
        pending.delete(pendingKey(device, 'vivint-alarm'));
        return {
          ...vivintPending.event,
          activityId: helpers.getActivityId(activity),
          sourceActivityId: vivintPending.event.activityId || null,
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'vivint-alarm-response',
        };
      }
    }

    const notificationsPending = pending.get(pendingKey(device, 'alexa-notifications'));
    if (notificationsPending && now - notificationsPending.at <= ttlMs) {
      if (hasNotificationContent(response)) {
        pending.delete(pendingKey(device, 'alexa-notifications'));
        return {
          ...notificationsPending.event,
          activityId: helpers.getActivityId(activity),
          sourceActivityId: notificationsPending.event.activityId || null,
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'alexa-notifications-response',
        };
      }
    }

    const routePending = pending.get(pendingKey(device, 'route'));
    if (routePending && now - routePending.at <= ttlMs) {
      const defaultLocation = helpers.defaultLocation ?? null;
      if (
        spokenHasRouteAnswer(response)
        || extractRouteLocations(routePending.event.query, defaultLocation, response)
      ) {
        pending.delete(pendingKey(device, 'route'));
        return {
          ...routePending.event,
          activityId: helpers.getActivityId(activity),
          sourceActivityId: routePending.event.activityId || null,
          spokenResponse: response,
          timestamp: activity?.creationTimestamp || now,
          trigger: 'route-response',
        };
      }
    }

    return null;
  }

  return {
    remember,
    forget,
    hasPending,
    tryComplete,
    pendingKey,
  };
}

module.exports = {
  createPendingVoiceResponses,
  DEFAULT_TTL_MS,
};
