const Alexa = require('alexa-remote2');
const path = require('path');
const { BroadcastParser } = require('./parser');
const { buildAlexaInitOptions, persistFromAlexa, loadSession } = require('./session');
const { loadBridgeState, saveBridgeState, fingerprint } = require('./bridge-state');
const { getActivityId, getDeviceName } = require('./parser');
const { extractSpokenResponse } = require('./activity-response');
const { createPendingVoiceResponses } = require('./pending-voice-responses');
const { createUdpBroadcaster } = require('./broadcast-udp');
const { createDisplayRegistry, attachTarget } = require('./display-registry');
const { createSessionKeepAlive, isAuthRelatedMessage } = require('./session-keepalive');
const { markReauthRequired, markReauthRecommended, clearAuthStatus, readAuthStatus } = require('./auth-status');
const { createSessionAuthJournal } = require('./session-auth-journal');
const { getSessionMeta } = require('./session-meta');
const { tokenDateAdvanced } = require('./session-token-health');
const { formatError } = require('./error-format');
const { createVoiceEventDedup } = require('./voice-event-dedup');
const { shouldMarkActivityProcessed } = require('./voice-event-gate');
const { createVoiceQueryParser } = require('./voice-query-parser');
const { extractWeatherLocation } = require('./weather-location');
const { fetchWeatherForecast, geocodeLocation } = require('./weather-fetch');
const { extractRouteLocations } = require('./route-query');
const { fetchDrivingRoute, greatCircleEstimate } = require('./route-fetch');
const { createEventsLog } = require('./events-log');
const { createTimerSync } = require('./timer-sync');
const { createAlarmSync } = require('./alarm-sync');
const {
  buildBroadcastPayload,
  buildTimeQueryPayload,
  buildWeatherQueryPayload,
  buildIndoorTemperaturePayload,
  buildAirQualityPayload,
  buildShoppingListPayload,
  buildMusicPayload,
  buildTeslaBatteryPayload,
  buildTeslaDashboardPayload,
  buildVivintAlarmPayload,
  buildNotificationsPayload,
  buildSmartHomePayload,
  buildProcessingAckPayload,
  buildRoutePlannerPayload,
  buildTimerSnapshotPayload,
  buildAlarmSnapshotPayload,
} = require('./udp-payload');
const { fetchShoppingList, extractAddedItem, resolveShoppingList, loadShoppingListCache, saveShoppingListCache, matchesShoppingListSpeech } = require('./shopping-list');
const { buildTeslaBatteryReading } = require('./tesla-battery');
const { fetchTeslaBattery, fetchTeslaDashboard, isFleetConfigured, buildErrorReading } = require('./tesla-fleet-client');
const { createTeslaSessionKeepAlive } = require('./tesla-session-keepalive');
const { createBackgroundCacheRefresh } = require('./background-cache-refresh');
const { loadWeatherCache, saveWeatherCache } = require('./weather-cache');
const { loadAirQualityCache, saveAirQualityCache } = require('./air-quality-cache');
const { buildVivintAlarmReading, hasAlarmStatusInSpeech } = require('./vivint-alarm');
const { buildNotificationsReading, hasNotificationContent } = require('./alexa-notifications');
const { fetchNowPlaying, emptyNowPlaying } = require('./music-info');
const { resolveDeviceType } = require('./smart-home-command');
const { listSmarthomeEndpoints } = require('./smarthome-devices');
const { enrichAirQualityReading, enrichAllMonitors } = require('./air-quality-fetch');
const { enrichIndoorReading } = require('./indoor-temperature-fetch');
const {
  buildAirQualityReading,
  resolveAirQualityQueryLocation,
} = require('./air-quality');
const {
  mergeAirQualityReadings,
  mergeMonitorLists,
  parseMonitorSummaries,
  parseQualitativeBand,
  summarizeMonitorReadings,
} = require('./air-quality-parse');
const {
  buildIndoorReading,
  resolveIndoorQueryLocation,
} = require('./indoor-temperature');

const VOLUME_POLL_DELAY_MS = 2000;
const HISTORY_LOOKBACK_MS = 2 * 60 * 1000;
const PERIODIC_LOOKBACK_MS = 15 * 60 * 1000;
const PERIODIC_POLL_MS = 60 * 1000;
// When the push channel is down, history polling is the only capture path, so
// poll more aggressively to keep voice commands from feeling dropped.
const PUSH_DOWN_POLL_MS = 15 * 1000;
const HEALTH_LOG_MS = 5 * 60 * 1000;
const HISTORY_POLL_FAILURE_THRESHOLD = 3;

function createListener({ config, log }) {
  const alexa = new Alexa();
  const legacyBroadcastLogPaths = [
    path.join(config.ROOT, 'broadcast.txt'),
    path.join(config.ROOT, 'data', 'broadcast.txt'),
  ];
  const bridgeState = loadBridgeState(config.bridgeStatePath, config.voiceEventsLogPath, {
    legacyBroadcastLogPaths,
  });
  const parser = new BroadcastParser({
    ...bridgeState,
    fingerprintFn: fingerprint,
  });
  const displayRegistry = createDisplayRegistry(config, log);
  const udpBroadcaster = createUdpBroadcaster(config, log, {
    onMessage: (payload, rinfo) => {
      if (payload?.type !== 'display.announce') {
        return;
      }
      const entry = displayRegistry.upsertFromAnnounce(payload, rinfo);
      if (entry) {
        log.info(`Display announced: ${entry.name} (${entry.id}) @ ${entry.host || '?'}`);
      }
    },
  });
  const voiceQueryParser = createVoiceQueryParser();
  const voiceEventDedup = createVoiceEventDedup();
  const pendingVoiceResponses = createPendingVoiceResponses();
  const voiceEventsLog = createEventsLog(config.voiceEventsLogPath);
  const voiceSettings = {
    enabled: config.voiceEvents?.enabled !== false,
    timeQueries: config.voiceEvents?.timeQueries !== false,
    weatherQueries: config.voiceEvents?.weatherQueries !== false,
    indoorTemperatureQueries: config.voiceEvents?.indoorTemperatureQueries !== false,
    airQualityQueries: config.voiceEvents?.airQualityQueries !== false,
    fetchWeather: config.voiceEvents?.fetchWeather !== false,
    fetchAirQuality: config.voiceEvents?.fetchAirQuality !== false,
    fetchIndoorSensor: config.voiceEvents?.fetchIndoorSensor !== false,
    shoppingListQueries: config.voiceEvents?.shoppingListQueries !== false,
    musicEvents: config.voiceEvents?.musicEvents !== false,
    smartHomeEvents: config.voiceEvents?.smartHomeEvents !== false,
    teslaBatteryQueries: config.voiceEvents?.teslaBatteryQueries !== false,
    teslaDashboardQueries: config.voiceEvents?.teslaDashboardQueries !== false,
    vivintAlarmQueries: config.voiceEvents?.vivintAlarmQueries !== false,
    notificationQueries: config.voiceEvents?.notificationQueries !== false,
    routeQueries: config.voiceEvents?.routeQueries !== false,
  };

  function persistBridgeState() {
    saveBridgeState(config.bridgeStatePath, parser.getState());
  }
  let volumePollTimer = null;
  let historyPollInFlight = false;
  let periodicPollTimer = null;
  let healthTimer = null;
  let sessionKeepAlive = null;
  let authJournal = null;
  let timerSync = null;
  let alarmSync = null;
  let teslaKeepAlive = null;
  let backgroundCacheRefresh = null;
  let activeSession = null;
  let lastPollAt = null;
  let lastPollCount = 0;
  let lastPollError = null;
  let consecutiveHistoryPollFailures = 0;
  let lastCaptureAt = bridgeState.lastRecordedTimestamp || null;

  function getDeviceNameMap() {
    const map = {};
    for (const device of Object.values(alexa.serialNumbers || {})) {
      if (!device?.serialNumber) {
        continue;
      }
      map[device.serialNumber] = device.accountName || device._name || device.serialNumber;
    }
    return map;
  }

  function sendUdpPayload(payload, options = {}) {
    return udpBroadcaster.send(payload, options);
  }

  function deliverTargetedPayload(payload, targetId) {
    const delivery = displayRegistry.resolveDelivery(targetId);
    if (delivery.error && !delivery.isAll) {
      return delivery;
    }
    const out = attachTarget(payload, delivery.target);
    sendUdpPayload(out, delivery.sendOptions);
    return delivery;
  }

  function recordBroadcast(record) {
    if (!record?.message) {
      return;
    }

    log.broadcast(record);
    voiceEventsLog.append({
      type: 'broadcast',
      device: record.device,
      message: record.message,
      destination: record.destination || null,
      source: record.source,
      trigger: record.trigger,
    });
    persistBridgeState();

    sendUdpPayload(buildBroadcastPayload(record, config));
    lastCaptureAt = Date.now();
    log.info(`Recorded broadcast to ${voiceEventsLog.path} and sent UDP`);
  }

  function scheduleResponseFollowup(reason) {
    setTimeout(() => pollRecentHistory(`${reason}-followup-2s`), 2000);
    setTimeout(() => pollRecentHistory(`${reason}-followup-5s`), 5000);
  }

  function scheduleMusicQueryRetry(event, attempt = 1) {
    const delayMs = attempt === 1 ? 2500 : 4000;
    setTimeout(async () => {
      let nowPlaying = null;
      try {
        nowPlaying = await fetchNowPlaying(alexa, event.deviceSerial || event.device, event.device, {
          attempts: 2,
          delayMs: 900,
        });
      } catch (error) {
        log.warn('Player info retry fetch failed', error.message || error);
      }
      if (nowPlaying) {
        const payload = buildMusicPayload(event, config, { nowPlaying });
        if (payload) {
          const voiceDelivery = displayRegistry.resolveDelivery(event?.targetId);
          sendUdpPayload(attachTarget(payload, voiceDelivery.target), voiceDelivery.sendOptions);
          voiceEventsLog.append({ type: payload.type, device: payload.device, query: event.query });
          log.info(`Now-playing query resolved on retry for ${event.device}`);
        }
        return;
      }
      if (attempt < 2) {
        scheduleMusicQueryRetry(event, attempt + 1);
      } else {
        // Don't leave the display blank — previous behavior silently
        // returned after retries, so "what's playing" with a slow/empty
        // player-info API looked completely broken. Emit an explicit
        // empty now-playing card instead.
        const payload = buildMusicPayload(event, config, {
          nowPlaying: emptyNowPlaying(event.device),
        });
        if (payload) {
          const voiceDelivery = displayRegistry.resolveDelivery(event?.targetId);
          sendUdpPayload(attachTarget(payload, voiceDelivery.target), voiceDelivery.sendOptions);
          voiceEventsLog.append({ type: payload.type, device: payload.device, query: event.query });
        }
        log.info(`Now-playing query gave up after retries for ${event.device}`, { query: event.query });
      }
    }, delayMs);
  }

  function handleVoiceEvent(voiceEvent, activityId, trigger) {
    if (voiceEvent?.kind === 'timer-hint' || voiceEvent?.kind === 'timer-list') {
      voiceQueryParser.markProcessed(activityId);
      log.info('Timer voice command detected', {
        trigger: voiceEvent.trigger,
        query: voiceEvent.query,
        device: voiceEvent.device,
      });
      timerSync?.requestImmediatePoll(voiceEvent.trigger, voiceEvent.device);
      return;
    }

    if (voiceEvent?.kind === 'alarm-hint' || voiceEvent?.kind === 'alarm-list') {
      voiceQueryParser.markProcessed(activityId);
      log.info('Alarm voice command detected', {
        trigger: voiceEvent.trigger,
        query: voiceEvent.query,
        device: voiceEvent.device,
      });
      alarmSync?.requestImmediatePoll(voiceEvent.trigger, voiceEvent.device);
      return;
    }

    if (!voiceSettings.enabled) {
      voiceQueryParser.markProcessed(activityId);
      if (config.debug && voiceEvent) {
        log.debug('Activity ignored (voice events disabled)', {
          trigger,
          summary: voiceEvent.query,
        });
      }
      return;
    }

    if (!voiceEvent) {
      voiceQueryParser.markProcessed(activityId);
      return;
    }

    if (!voiceEventDedup.shouldEmit(voiceEvent)) {
      if (shouldMarkActivityProcessed(voiceEvent, config)) {
        voiceQueryParser.markProcessed(activityId);
      }
      if (config.debug) {
        log.debug('Voice event deduped (recent duplicate)', {
          trigger,
          kind: voiceEvent.kind,
          query: voiceEvent.query,
          activityId,
        });
      }
      return;
    }

    if (shouldMarkActivityProcessed(voiceEvent, config)) {
      voiceQueryParser.markProcessed(activityId);
    } else {
      log.info('Voice event captured (awaiting Alexa response upgrade)', {
        trigger,
        kind: voiceEvent.kind,
        query: voiceEvent.query,
      });
    }

    recordVoiceEvent(voiceEvent).catch((error) => {
      log.error('Failed to record voice event', error.message || error);
    });
  }

  async function recordVoiceEvent(event) {
    if (!voiceSettings.enabled) {
      return;
    }

    const voiceDelivery = displayRegistry.resolveDelivery(event?.targetId);
    const emitVoicePayload = (payload) => {
      if (!payload) {
        return;
      }
      sendUdpPayload(attachTarget(payload, voiceDelivery.target), voiceDelivery.sendOptions);
    };

    if (event.kind === 'time' && !voiceSettings.timeQueries) {
      return;
    }

    if (event.kind === 'weather' && !voiceSettings.weatherQueries) {
      return;
    }

    if (event.kind === 'indoor-temperature' && !voiceSettings.indoorTemperatureQueries) {
      return;
    }

    if (event.kind === 'air-quality' && !voiceSettings.airQualityQueries) {
      return;
    }

    if (event.kind === 'shopping-list' && !voiceSettings.shoppingListQueries) {
      return;
    }

    if (event.kind === 'music' && !voiceSettings.musicEvents) {
      return;
    }

    if (event.kind === 'smart-home' && !voiceSettings.smartHomeEvents) {
      return;
    }

    if (event.kind === 'tesla-battery' && !voiceSettings.teslaBatteryQueries) {
      return;
    }

    if (event.kind === 'tesla-dashboard' && !voiceSettings.teslaDashboardQueries) {
      return;
    }

    if (event.kind === 'vivint-alarm' && !voiceSettings.vivintAlarmQueries) {
      return;
    }

    if (event.kind === 'alexa-notifications' && !voiceSettings.notificationQueries) {
      return;
    }

    if (event.kind === 'route' && !voiceSettings.routeQueries) {
      return;
    }

    // Slow external-API commands (Tesla Fleet can take 10-30s if the car has
    // to wake) get instant on-screen feedback: the cached snapshot marked
    // "refreshing" when one exists (real data replaces it once the live fetch
    // lands), otherwise a processing acknowledgment placeholder.
    if ((event.kind === 'tesla-battery' || event.kind === 'tesla-dashboard')
      && isFleetConfigured(config.teslaFleet)) {
      let preview = null;
      if (event.kind === 'tesla-battery') {
        const { loadBatteryCache, buildRefreshingReading } = require('./tesla-battery-cache');
        const cachedReading = buildRefreshingReading(loadBatteryCache(config));
        if (cachedReading) {
          preview = buildTeslaBatteryPayload(event, config, { battery: cachedReading });
        }
      } else {
        const { loadDashboardCache, buildRefreshingDashboard } = require('./tesla-dashboard-cache');
        const cachedDashboard = buildRefreshingDashboard(loadDashboardCache(config));
        if (cachedDashboard) {
          preview = buildTeslaDashboardPayload(event, config, { dashboard: cachedDashboard });
        }
      }
      if (preview) {
        emitVoicePayload(preview);
        log.info(`Cached preview sent while refreshing (${event.kind}) for ${event.device}`);
      } else {
        const ack = buildProcessingAckPayload(event, config);
        if (ack) {
          emitVoicePayload(ack);
          log.info(`Processing ack sent (${event.kind}) for ${event.device}`);
        }
      }
    }

    let payload;
    if (event.kind === 'time') {
      payload = buildTimeQueryPayload(event, config);
    } else if (event.kind === 'shopping-list') {
      const addedItem = extractAddedItem(event.query, event.spokenResponse);
      const cachedItems = loadShoppingListCache(config.shoppingListCachePath);
      let fetched = null;
      try {
        fetched = await fetchShoppingList(alexa);
      } catch (error) {
        log.warn('Shopping list fetch failed', error.message || error);
      }
      const list = resolveShoppingList(
        fetched,
        event.spokenResponse,
        cachedItems,
        addedItem,
        event.trigger,
        event.query,
      );
      saveShoppingListCache(config.shoppingListCachePath, list.items);
      if (event.trigger === 'shopping-list-show') {
        if (list.items.length === 0) {
          pendingVoiceResponses.remember(event);
          scheduleResponseFollowup('shopping-list-show');
          if (String(event.spokenResponse || '').trim()) {
            log.warn('Shopping list empty after fetch, cache, and speech parse', {
              query: event.query,
              spoken: String(event.spokenResponse).slice(0, 160),
            });
          }
        } else {
          pendingVoiceResponses.forget(event.device, 'shopping-list-show');
        }
      }
      payload = buildShoppingListPayload(
        { ...event, addedItem },
        config,
        { list },
      );
    } else if (event.kind === 'music') {
      let nowPlaying = null;
      try {
        // "music-play" waits longer for playback to actually start; a
        // "what song is playing" query is asking about something already
        // playing (or not), so a shorter budget is usually enough. But right
        // after "Alexa, next"/"skip" the player-info API can still be mid
        // transition (old track fading out, new one not yet reporting
        // PLAYING+title) for a couple of seconds, so give it a bit more room
        // than a single quick check before falling back to the retry below.
        const fetchOptions = event.trigger === 'music-query'
          ? { attempts: 3, delayMs: 900 }
          : undefined;
        nowPlaying = await fetchNowPlaying(alexa, event.deviceSerial || event.device, event.device, fetchOptions);
      } catch (error) {
        log.warn('Player info fetch failed', error.message || error);
      }
      if (!nowPlaying) {
        // Unlike other kinds, there's no later history re-poll that helps
        // here — the activity/spoken-response is already complete, the only
        // thing not ready yet is Amazon's separate player-info API. Retry
        // that directly a couple more times so a query asked right after
        // "next"/"skip" doesn't silently go nowhere (previously the user had
        // to ask again to get a fresh attempt at a moment the track had
        // settled).
        if (event.trigger === 'music-query') {
          scheduleMusicQueryRetry(event);
        }
        return;
      }
      payload = buildMusicPayload(event, config, { nowPlaying });
    } else if (event.kind === 'smart-home') {
      let typeInfo = {};
      try {
        const endpoints = await listSmarthomeEndpoints(alexa);
        typeInfo = resolveDeviceType(endpoints, event.command?.target);
      } catch (error) {
        log.warn('Smart home device lookup failed', error.message || error);
        typeInfo = resolveDeviceType([], event.command?.target);
      }
      payload = buildSmartHomePayload(event, config, typeInfo);
    } else if (event.kind === 'tesla-battery') {
      const {
        loadBatteryCache,
        saveBatteryCache,
        applyBatteryFallback,
      } = require('./tesla-battery-cache');
      let battery;
      if (isFleetConfigured(config.teslaFleet)) {
        try {
          battery = await fetchTeslaBattery(config, log);
          pendingVoiceResponses.forget(event.device, 'tesla-battery');
        } catch (error) {
          log.warn('Tesla Fleet API fetch failed', error.message || error);
          battery = buildErrorReading(error);
        }
      } else {
        battery = buildTeslaBatteryReading(event.spokenResponse);
        if (battery.percent == null) {
          log.info('Tesla battery event without parsed percent', {
            query: event.query,
            spoken: String(event.spokenResponse || '').slice(0, 160) || null,
          });
          pendingVoiceResponses.remember(event);
          scheduleResponseFollowup('tesla-battery');
        } else {
          pendingVoiceResponses.forget(event.device, 'tesla-battery');
        }
      }
      if (battery?.status === 'ok' && battery.percent != null) {
        battery = { ...battery, fetchedAt: new Date().toISOString() };
        saveBatteryCache(config, battery, log);
      } else {
        const cached = loadBatteryCache(config);
        if (cached) {
          log.warn('Tesla battery unavailable, serving cached reading', {
            reason: battery?.error || battery?.status || null,
            cachedAt: cached.fetchedAt || null,
          });
          battery = applyBatteryFallback(battery, cached);
        }
      }
      payload = buildTeslaBatteryPayload(event, config, { battery });
    } else if (event.kind === 'tesla-dashboard') {
      const {
        loadDashboardCache,
        saveDashboardCache,
        applyDashboardFallback,
      } = require('./tesla-dashboard-cache');
      let dashboard;
      if (isFleetConfigured(config.teslaFleet)) {
        try {
          dashboard = await fetchTeslaDashboard(config, log);
          pendingVoiceResponses.forget(event.device, 'tesla-dashboard');
        } catch (error) {
          log.warn('Tesla dashboard fetch failed', error.message || error);
          const { buildDashboardErrorReading } = require('./tesla-dashboard-data');
          dashboard = buildDashboardErrorReading(error);
        }
      } else {
        dashboard = {
          status: 'auth_required',
          error: 'Tesla Fleet API not configured',
          fetchedAt: new Date().toISOString(),
          freshnessSec: 0,
        };
      }
      if (dashboard?.status === 'ok') {
        saveDashboardCache(config, dashboard, log);
      } else {
        const cached = loadDashboardCache(config);
        if (cached) {
          log.warn('Tesla dashboard unavailable, serving cached snapshot', {
            reason: dashboard?.error || dashboard?.status || null,
            cachedAt: cached.fetchedAt || null,
          });
          dashboard = applyDashboardFallback(dashboard, cached);
        }
      }
      payload = buildTeslaDashboardPayload(event, config, { dashboard });
    } else if (event.kind === 'vivint-alarm') {
      const alarm = buildVivintAlarmReading(event.spokenResponse, event.query);
      if (!hasAlarmStatusInSpeech(event.spokenResponse)) {
        log.info('Vivint alarm event without parsed status', {
          query: event.query,
          spoken: String(event.spokenResponse || '').slice(0, 160) || null,
        });
        pendingVoiceResponses.remember(event);
        scheduleResponseFollowup('vivint-alarm');
      } else {
        pendingVoiceResponses.forget(event.device, 'vivint-alarm');
      }
      payload = buildVivintAlarmPayload(event, config, { alarm });
    } else if (event.kind === 'alexa-notifications') {
      const notifications = buildNotificationsReading(event.spokenResponse);
      if (!hasNotificationContent(event.spokenResponse)) {
        log.info('Notifications query without readable content yet', {
          query: event.query,
          spoken: String(event.spokenResponse || '').slice(0, 160) || null,
        });
        pendingVoiceResponses.remember(event);
        scheduleResponseFollowup('alexa-notifications');
      } else {
        pendingVoiceResponses.forget(event.device, 'alexa-notifications');
      }
      payload = buildNotificationsPayload(event, config, { notifications });
    } else if (event.kind === 'indoor-temperature') {
      const indoorConfig = config.indoorTemperature || {};
      const location = resolveIndoorQueryLocation(event.query, event.spokenResponse, indoorConfig);
      let reading = buildIndoorReading(event, indoorConfig);
      if (voiceSettings.fetchIndoorSensor) {
        try {
          reading = await enrichIndoorReading(alexa, location, event.spokenResponse, indoorConfig);
        } catch (error) {
          log.warn('Indoor sensor fetch failed', error.message || error);
        }
      }
      // A location that matches no configured sensor with nothing to show is
      // almost always a misheard transcript from a second Echo (e.g. "palmyra"
      // for a known room) — displaying it just flashes a wrong room name.
      if (!location?.matched && reading?.temperatureF == null && reading?.humidity == null) {
        log.info('Indoor query skipped (unknown location, no reading yet)', {
          query: event.query,
          location: location?.query || null,
        });
        return;
      }
      payload = buildIndoorTemperaturePayload(event, config, { location, reading });
    } else if (event.kind === 'air-quality') {
      const airQualityConfig = config.airQuality || {};
      const location = resolveAirQualityQueryLocation(event, airQualityConfig);
      let reading = buildAirQualityReading(event, airQualityConfig);
      let monitors = reading.monitors || parseMonitorSummaries(event.spokenResponse, airQualityConfig);

      if (voiceSettings.fetchAirQuality) {
        try {
          if (location?.multiMonitor || monitors.length > 1) {
            const fetchedMonitors = await enrichAllMonitors(alexa, airQualityConfig);
            monitors = mergeMonitorLists(fetchedMonitors, monitors);
            reading = mergeAirQualityReadings(reading, summarizeMonitorReadings(monitors, airQualityConfig));
          } else {
            reading = await enrichAirQualityReading(alexa, location, reading, airQualityConfig);
          }
          if (Array.isArray(monitors) && monitors.length) {
            saveAirQualityCache(config, { location, reading, monitors }, log);
          }
        } catch (error) {
          log.warn('Air quality fetch failed', error.message || error);
        }
      }

      if ((!reading.band || reading.band === 'unknown') && reading.iaqScore == null) {
        const qualitative = parseQualitativeBand(event.spokenResponse, airQualityConfig);
        if (qualitative) {
          reading.band = qualitative;
        }
      }

      if ((!reading.band || reading.band === 'unknown') && reading.iaqScore == null && !monitors.length) {
        const cached = loadAirQualityCache(config);
        if (cached?.monitors?.length) {
          log.info('Air quality unavailable, serving cached reading', {
            cachedAt: cached.savedAt || null,
          });
          monitors = cached.monitors;
          reading = mergeAirQualityReadings(reading, cached.reading || summarizeMonitorReadings(monitors, airQualityConfig));
        }
      }

      payload = buildAirQualityPayload(event, config, { location, reading, monitors });
    } else if (event.kind === 'weather') {
      const location = extractWeatherLocation(
        event.query,
        config.voiceEvents?.defaultLocation,
        event.spokenResponse,
      );
      let weather = null;
      if (voiceSettings.fetchWeather) {
        try {
          weather = await fetchWeatherForecast(location);
          if (!weather) {
            log.warn('Weather fetch returned no data', {
              query: event.query,
              location: location?.query || location?.resolvedName,
            });
          } else if (location?.scope === 'local') {
            saveWeatherCache(config, {
              location: weather.location || location,
              weather,
            }, log);
          }
        } catch (error) {
          log.warn('Weather fetch failed', error.message || error);
        }
      }
      if (!weather && location?.scope === 'local') {
        const cached = loadWeatherCache(config);
        if (cached?.weather) {
          log.info('Weather unavailable, serving cached forecast', {
            cachedAt: cached.savedAt || null,
          });
          weather = cached.weather;
        }
      }
      payload = buildWeatherQueryPayload(event, config, {
        location: weather?.location || location,
        weather,
      });
    } else if (event.kind === 'route') {
      const locations = extractRouteLocations(
        event.query,
        config.voiceEvents?.defaultLocation,
        event.spokenResponse,
      );
      if (!locations) {
        return;
      }
      let { origin, destination } = locations;
      try {
        if (origin.scope === 'named' && (origin.latitude == null || origin.longitude == null)) {
          const geocoded = await geocodeLocation(origin.query);
          if (!geocoded) {
            log.warn('Route planner could not geocode origin', { query: origin.query });
            return;
          }
          origin = { ...origin, ...geocoded };
        }
        if (destination.scope === 'named' && (destination.latitude == null || destination.longitude == null)) {
          const geocoded = await geocodeLocation(destination.query);
          if (!geocoded) {
            log.warn('Route planner could not geocode destination', { query: destination.query });
            return;
          }
          destination = { ...destination, ...geocoded };
        }
      } catch (error) {
        log.warn('Route planner geocoding failed', error.message || error);
        return;
      }

      let mode = 'driving';
      let route;
      try {
        route = await fetchDrivingRoute(origin, destination);
      } catch (error) {
        route = { ok: false };
      }
      if (!route.ok) {
        mode = 'flight';
        route = greatCircleEstimate(origin, destination);
        if (!route) {
          log.warn('Route planner could not compute a flight fallback', { origin, destination });
          return;
        }
      }

      payload = buildRoutePlannerPayload(event, config, {
        origin, destination, route, mode,
      });
      if (!payload) {
        return;
      }
    } else {
      return;
    }

    voiceEventsLog.append({ type: payload.type, device: payload.device, query: event.query });
    emitVoicePayload(payload);
    lastCaptureAt = Date.now();
    const logMeta = { query: event.query };
    if (event.kind === 'tesla-battery') {
      logMeta.percent = payload?.battery?.percent ?? null;
      logMeta.source = payload?.battery?.source ?? null;
      logMeta.status = payload?.battery?.status ?? null;
    }
    if (event.kind === 'tesla-dashboard') {
      logMeta.status = payload?.dashboard?.status ?? null;
      logMeta.vehicle = payload?.dashboard?.vehicle?.name ?? null;
    }
    if (event.kind === 'vivint-alarm') {
      logMeta.status = payload?.alarm?.status ?? null;
      logMeta.mode = payload?.alarm?.mode ?? null;
    }
    if (event.kind === 'alexa-notifications') {
      logMeta.count = payload?.notifications?.items?.length ?? 0;
    }
    if (event.kind === 'route') {
      logMeta.mode = payload?.mode ?? null;
      logMeta.distanceMiles = payload?.distanceMiles ?? null;
      logMeta.origin = payload?.origin?.name ?? null;
      logMeta.destination = payload?.destination?.name ?? null;
    }
    log.info(`Voice event captured (${payload.type}) from ${event.device}`, logMeta);
  }

  function handleAlarmSnapshot(snapshot) {
    const payload = buildAlarmSnapshotPayload(snapshot, config);
    voiceEventsLog.append({
      type: payload.type,
      trigger: payload.trigger,
      alarmCount: payload.alarms.length,
      event: payload.event,
    });
    sendUdpPayload(payload);
    lastCaptureAt = Date.now();
    log.info(`Alarm snapshot sent (${payload.trigger})`, {
      activeAlarms: payload.alarms.length,
      event: payload.event?.kind,
      highlighted: payload.highlightAmazonId || null,
    });
  }

  function handleTimerSnapshot(snapshot) {
    const payload = buildTimerSnapshotPayload(snapshot, config);
    voiceEventsLog.append({
      type: payload.type,
      trigger: payload.trigger,
      timerCount: payload.timers.length,
      event: payload.event,
    });
    sendUdpPayload(payload);
    lastCaptureAt = Date.now();
    log.info(`Timer snapshot sent (${payload.trigger})`, {
      activeTimers: payload.timers.length,
      event: payload.event?.kind,
    });
  }

  function inspectActivity(activity, trigger) {
    const spoken = extractSpokenResponse(activity);
    log.debug('Activity received', {
      trigger,
      summary: activity?.description?.summary,
      response: spoken,
      device: activity?.name || activity?.deviceSerialNumber,
    });

    const record = parser.parseActivity(activity);
    if (record) {
      record.trigger = record.trigger || trigger;
      parser.markRecorded(getActivityId(activity), record);
      recordBroadcast(record);
      return;
    }

    const activityId = getActivityId(activity);
    const completed = pendingVoiceResponses.tryComplete(activity, spoken, {
      getDeviceName,
      getActivityId,
      matchesShoppingListSpeech,
    });
    if (completed) {
      // Retire the original query activity too so later history polls don't
      // re-parse it and emit the same display a third time.
      if (completed.sourceActivityId && completed.sourceActivityId !== activityId) {
        voiceQueryParser.markProcessed(completed.sourceActivityId);
      }
      handleVoiceEvent(completed, activityId, trigger);
      return;
    }

    if (!voiceQueryParser.shouldProcess(activityId)) {
      if (config.debug) {
        const summary = activity?.description?.summary;
        if (summary || spoken) {
          log.debug('Activity ignored (duplicate activity id)', { trigger, summary, response: spoken });
        }
      }
      return;
    }

    const voiceEvent = voiceQueryParser.parse(activity);
    if (!voiceEvent) {
      voiceQueryParser.markProcessed(activityId);
      if (config.debug) {
        log.debug('Activity ignored (not a tracked voice query)', {
          trigger,
          summary: activity?.description?.summary,
        });
      }
      return;
    }

    handleVoiceEvent(voiceEvent, activityId, trigger);
  }

  function pollRecentHistory(reason, lookbackMs = HISTORY_LOOKBACK_MS) {
    if (historyPollInFlight) {
      return;
    }

    historyPollInFlight = true;
    log.debug(`Polling voice history (${reason})`);

    const historyStart = Math.max(
      Date.now() - lookbackMs,
      parser.lastRecordedTimestamp + 1,
    );

    alexa.getCustomerHistoryRecords(
      {
        startTime: historyStart,
        filter: false,
        forceRequest: true,
      },
      (err, records) => {
        historyPollInFlight = false;
        lastPollAt = Date.now();

        if (err) {
          const formatted = formatError(err);
          lastPollError = formatted;
          consecutiveHistoryPollFailures += 1;
          log.warn(`History poll failed (${reason})`, formatted);
          if (isAuthRelatedMessage(formatted)) {
            sessionKeepAlive?.handleExternalAuthFailure('history_poll', formatted, { reason });
          }
          return;
        }

        lastPollError = null;
        consecutiveHistoryPollFailures = 0;
        lastPollCount = records?.length || 0;

        if (lastPollCount === 0) {
          log.debug(`History poll (${reason}): no records`);
          return;
        }

        log.debug(`History poll (${reason}): ${lastPollCount} records`);

        records
          .slice()
          .sort((a, b) => (a.creationTimestamp || 0) - (b.creationTimestamp || 0))
          .forEach((activity) => inspectActivity(activity, `history-${reason}`));
      },
    );
  }

  function logHealth() {
    const pushConnected = alexa.isPushConnected?.() ?? false;
    const authStatus = readAuthStatus(config);
    const journalSummary = authJournal?.getSummary?.() || null;
    log.info('Health check', {
      pushConnected,
      lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      lastPollCount,
      lastPollError,
      consecutiveHistoryPollFailures,
      lastCaptureAt: lastCaptureAt ? new Date(lastCaptureAt).toISOString() : null,
      sessionPath: config.sessionPath,
      sessionMeta: getSessionMeta(config, activeSession, alexa),
      sessionKeepAlive: sessionKeepAlive?.getStatus?.() || null,
      authJournal: journalSummary,
      authStatus: authStatus?.status || 'ok',
      voiceEventsEnabled: voiceSettings.enabled,
      activeTimers: timerSync?.listActiveTimers?.().length ?? 0,
      activeAlarms: alarmSync?.listActiveAlarms?.().length ?? 0,
      backgroundCache: backgroundCacheRefresh?.getStatus?.() || null,
    });

    if (authStatus?.status === 'reauth_required') {
      log.error('Amazon session requires re-authentication');
      log.error('Run on the NAS: PROXY_OWN_IP=YOUR_NAS_IP ./reauth.sh');
      log.error(`Details written to ${path.join(path.dirname(config.sessionPath), 'auth-status.json')}`);
      if (authStatus.likelyCause) {
        log.error(`Likely cause: ${authStatus.likelyCause}`);
      }
      if (journalSummary?.path) {
        log.error(`Auth journal: ${journalSummary.path}`);
      }
    } else if (authStatus?.status === 'reauth_recommended') {
      log.warn('Amazon session token is aging without rotation — re-authenticate soon', {
        message: authStatus.message,
        tokenAgeHours: authStatus.sessionMeta?.tokenAgeHours,
        tokenDate: authStatus.sessionMeta?.tokenDate,
      });
    }

    if (!pushConnected) {
      log.warn('Push channel disconnected — relying on history polling only');
    }

    if (lastPollError) {
      const authRelated = isAuthRelatedMessage(lastPollError);
      const persistent = consecutiveHistoryPollFailures >= HISTORY_POLL_FAILURE_THRESHOLD;

      if (authRelated) {
        log.warn('History API auth errors — you may need to re-authenticate (./reauth.sh)', {
          lastPollError,
          consecutiveHistoryPollFailures,
        });
      } else if (persistent) {
        log.warn('History API failing repeatedly — check network or session health', {
          lastPollError,
          consecutiveHistoryPollFailures,
        });
      } else {
        log.debug('History poll error (transient)', {
          lastPollError,
          consecutiveHistoryPollFailures,
        });
      }
    }
  }

  function scheduleHistoryPoll(reason) {
    clearTimeout(volumePollTimer);
    volumePollTimer = setTimeout(() => pollRecentHistory(reason, HISTORY_LOOKBACK_MS), VOLUME_POLL_DELAY_MS);
  }

  function wireEvents() {
    alexa.on('cookie', () => {
      const existingSession = loadSession(config.sessionPath) || {};
      const beforeMeta = getSessionMeta(config, existingSession, alexa);
      activeSession = persistFromAlexa(config, alexa, existingSession);
      const afterMeta = getSessionMeta(config, activeSession, alexa);

      if (tokenDateAdvanced(beforeMeta, afterMeta)) {
        clearAuthStatus(config);
        authJournal?.recordSuccess({
          type: 'session_persisted',
          source: 'listener',
          message: 'Session cookie saved after token rotation',
          sessionMeta: afterMeta,
        });
        log.info('Session refreshed and saved (token rotated)');
        return;
      }

      authJournal?.recordSuccess({
        type: 'session_persisted',
        source: 'listener',
        message: 'Session cookie saved without token rotation',
        sessionMeta: afterMeta,
      });

      if (afterMeta.tokenAgeHours != null && afterMeta.tokenAgeHours >= 12) {
        authJournal?.recordFailure({
          type: 'token_rotation_stalled',
          source: 'listener',
          reason: 'cookie-event',
          message: `Cookie persisted but tokenDate unchanged at ${afterMeta.tokenAgeHours}h`,
          sessionMeta: afterMeta,
          level: 'warn',
        });
        log.warn('Session file updated but access token did not rotate', {
          tokenAgeHours: afterMeta.tokenAgeHours,
          tokenDate: afterMeta.tokenDate,
        });
        if (afterMeta.tokenAgeHours >= 16) {
          markReauthRecommended(config, {
            reason: 'token_rotation_stalled',
            message: `Access token is ${afterMeta.tokenAgeHours}h old without rotation`,
            sessionMeta: afterMeta,
            journalPath: authJournal?.path,
          });
        }
      } else {
        clearAuthStatus(config);
        log.info('Session refreshed and saved');
      }
    });

    alexa.on('ws-connect', () => {
      log.info('Connected to Alexa push channel');
      scheduleHistoryPoll('connect');
    });

    alexa.on('ws-disconnect', (retries, message) => {
      log.warn('Disconnected from Alexa push channel', { retries, message });
      // Cover the gap immediately — anything spoken around the disconnect
      // would otherwise wait for the next periodic poll.
      scheduleHistoryPoll('push-disconnect');
      authJournal?.recordFailure({
        type: 'push_disconnected',
        source: 'listener',
        reason: 'ws-disconnect',
        message: String(message || 'push disconnected'),
        context: { retries },
        sessionMeta: getSessionMeta(config, activeSession, alexa),
        level: 'warn',
      });
    });

    alexa.on('ws-error', (error) => {
      log.error('Alexa push channel error', error?.message || error);
    });

    alexa.on('ws-device-activity', (activity) => {
      inspectActivity(activity, 'device-activity');
    });

    alexa.on('ws-volume-change', (payload) => {
      log.debug('Volume change detected', payload);
      scheduleHistoryPoll('volume-change');
    });

    // Any push traffic implies someone just talked to an Echo. Not every
    // interaction emits a PUSH_ACTIVITY (e.g. "show my shopping list" often
    // arrives only as a todo/content-focus push), so use these as capture
    // hints and poll history shortly after. scheduleHistoryPoll debounces.
    alexa.on('ws-todo-change', (change) => {
      log.debug('Shopping/todo list change detected', change);
      scheduleHistoryPoll('todo-change');
    });

    alexa.on('ws-content-focus-change', () => {
      scheduleHistoryPoll('content-focus');
    });

    alexa.on('ws-media-change', () => {
      scheduleHistoryPoll('media-change');
    });

    alexa.on('ws-unknown-command', (command, payload) => {
      log.debug('Unknown push command', { command, payload });
      scheduleHistoryPoll('push-command');
    });
  }

  async function start() {
    // Bind UDP early so display.announce heartbeats work even while Alexa init runs.
    if (udpBroadcaster.settings.enabled) {
      try {
        await udpBroadcaster.start();
      } catch (error) {
        log.warn('UDP socket failed to bind — display discovery unavailable', error?.message || error);
      }
    }

    const session = loadSession(config.sessionPath);
    activeSession = session;
    if (!session) {
      throw new Error(`No session found at ${config.sessionPath}. Run: npm run auth`);
    }

    const initOptions = buildAlexaInitOptions(config, session, { mode: 'listener' });
    if (!initOptions) {
      throw new Error('Session file is missing authentication data. Run: npm run auth');
    }

    initOptions.logger = config.debug ? log.debug.bind(log) : undefined;
    authJournal = createSessionAuthJournal({ config, log });
    wireEvents();

    return new Promise((resolve, reject) => {
      alexa.init(initOptions, (err) => {
        if (err) {
          reject(err);
          return;
        }

        const deviceCount = Object.keys(alexa.serialNumbers || {}).length;
        log.info('Alexa bridge ready', {
          devices: deviceCount,
          eventsLog: voiceEventsLog.path,
          amazonPage: initOptions.amazonPage,
        });
        log.info('Listening for broadcast/announcement activity. Press Ctrl+C to stop.');
        log.info('Captures voice commands like: "Alexa, announce ..." or "Alexa, broadcast ..."');
        if (voiceSettings.enabled) {
          log.info('Voice event capture enabled', {
            timeQueries: voiceSettings.timeQueries,
            weatherQueries: voiceSettings.weatherQueries,
            fetchWeather: voiceSettings.fetchWeather,
            eventsLog: voiceEventsLog.path,
          });
        }
        if (bridgeState.lastRecordedTimestamp > 0 || bridgeState.recordedFingerprints?.length) {
          log.info('Loaded dedup state from disk', {
            lastRecorded: bridgeState.lastRecordedTimestamp
              ? new Date(bridgeState.lastRecordedTimestamp).toISOString()
              : null,
            knownMessages: bridgeState.recordedFingerprints?.length || 0,
          });
        }

        if (udpBroadcaster.settings.enabled) {
          log.info('UDP broadcast enabled', {
            port: udpBroadcaster.settings.port,
            targets: udpBroadcaster.settings.targets.length,
          });
        }

        let lastPeriodicPollAt = 0;
        periodicPollTimer = setInterval(() => {
          const pushConnected = alexa.isPushConnected?.() ?? false;
          const interval = pushConnected ? PERIODIC_POLL_MS : PUSH_DOWN_POLL_MS;
          const now = Date.now();
          if (now - lastPeriodicPollAt < interval - 250) {
            return;
          }
          lastPeriodicPollAt = now;
          pollRecentHistory(pushConnected ? 'periodic' : 'periodic-push-down', PERIODIC_LOOKBACK_MS);
        }, PUSH_DOWN_POLL_MS);

        healthTimer = setInterval(logHealth, HEALTH_LOG_MS);
        logHealth();

        sessionKeepAlive = createSessionKeepAlive({
          alexa,
          config,
          log,
          journal: authJournal,
          session: activeSession,
          onReauthRequired: (details) => markReauthRequired(config, {
            ...details,
            recentJournal: authJournal.readRecent(5),
          }),
          onReauthRecommended: (details) => markReauthRecommended(config, {
            ...details,
            recentJournal: authJournal.readRecent(5),
          }),
          onSessionHealthy: () => clearAuthStatus(config),
          onSessionRefreshed: () => {
            const existingSession = loadSession(config.sessionPath) || {};
            activeSession = persistFromAlexa(config, alexa, existingSession);
            log.debug('Session tokens persisted to disk after keep-alive refresh');
          },
        });
        sessionKeepAlive.start();

        timerSync = createTimerSync({
          alexa,
          config,
          log,
          onSnapshot: handleTimerSnapshot,
          getDeviceNameMap,
        });
        timerSync.start();

        alarmSync = createAlarmSync({
          alexa,
          config,
          log,
          onSnapshot: handleAlarmSnapshot,
          getDeviceNameMap,
        });
        alarmSync.start();

        teslaKeepAlive = createTeslaSessionKeepAlive({
          fleet: config.teslaFleet,
          log,
          settings: config.teslaFleet?.keepAlive,
        });
        teslaKeepAlive.start();

        backgroundCacheRefresh = createBackgroundCacheRefresh({
          alexa,
          config,
          log,
        });
        backgroundCacheRefresh.start();

        resolve(alexa);
      });
    });
  }

  return {
    start,
    alexa,
    udpBroadcaster,
    displayRegistry,
    deliverTargetedPayload,
    // Exposed for the control web server: synthetic events (e.g. web pushes
    // of the Tesla dashboard) flow through the same pipeline as voice events,
    // including cached previews, processing acks, and cache fallbacks.
    recordVoiceEvent,
    sendUdpPayload,
    // Timers bypass recordVoiceEvent entirely (handleVoiceEvent intercepts
    // timer-hint/timer-list before it ever builds a payload) — the "Active
    // Timers" push tile needs its own hook straight into timerSync so a web
    // push re-polls Amazon and always emits a snapshot, same as "show timers".
    requestTimerPoll: (device) => timerSync?.requestImmediatePoll('show-timers', device),
  };
}

module.exports = {
  createListener,
};
