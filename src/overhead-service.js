/**
 * Overhead (flight radar) — settings, provider fetch, enrichment, UDP session.
 */

const path = require('path');
const {
  createOverheadSettings,
  cycleSecondsFor,
  estimateDuration,
  loopCount,
  pageCount,
} = require('./overhead-settings');
const { normaliseAircraft, filterAircraft, sortAircraft } = require('./overhead-model');
const { createProvider } = require('./overhead-providers');
const { createEnrichmentCache } = require('./overhead-enrichment');
const {
  buildOverheadRoundPayload,
  buildOverheadUpdatePayload,
  buildOverheadClosePayload,
} = require('./udp-payload');

function getHomeLatLon(config = {}) {
  const loc = config.voiceEvents?.defaultLocation;
  if (loc?.latitude != null && loc?.longitude != null) {
    return {
      lat: Number(loc.latitude),
      lon: Number(loc.longitude),
      name: loc.name || loc.resolvedName || 'Home',
    };
  }
  return null;
}

function createOverheadService({
  config = {},
  log = console,
  sendUdpPayload = null,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) {
  const settings = createOverheadSettings(config, log);
  const enrichment = createEnrichmentCache({ config, log, fetchImpl, now });

  /** @type {null | {
   *   sessionId: string,
   *   settings: object,
   *   home: object,
   *   routes: object,
   *   aircraftCount: number,
   *   startedAt: number,
   *   device: string,
   *   send: Function,
   * }} */
  let session = null;
  let pollerTimer = null;
  let pollInFlight = false;
  let lastFetchAt = 0;
  let lastAircraftCount = 0;
  let lastError = null;

  function geoBaseUrl() {
    if (config.overhead?.geoBaseUrl) {
      return String(config.overhead.geoBaseUrl).replace(/\/+$/, '');
    }
    const host = config.proxyOwnIp || config.webServer?.publicHost || null;
    if (host) {
      const scheme = config.webServer?.https === false ? 'http' : 'https';
      const port = config.webServer?.port || 47810;
      return `${scheme}://${host}:${port}`;
    }
    return '';
  }

  function providerFor(current) {
    return createProvider(current.provider || 'airplanes-live', {
      fetchImpl,
      log,
      now,
      localReceiverUrl: current.localReceiverUrl,
    });
  }

  async function fetchSortedAircraft(current, home) {
    const provider = providerFor(current);
    const raw = await provider.fetchPoint(home.lat, home.lon, current.radiusNm);
    lastFetchAt = now();
    const normalised = (raw || [])
      .map((row) => normaliseAircraft(row))
      .filter(Boolean);
    const filtered = filterAircraft(normalised, current);
    return sortAircraft(filtered, current.sort);
  }

  async function enrichList(list, current) {
    if (!current.showRoutes || !list.length) {
      return { aircraft: list, routes: {} };
    }
    const cap = pageCount(current, list.length) * (current.rowsPerPage === 6 ? 6 : 4);
    const candidates = list.slice(0, Math.max(cap, current.maxPages * 6));
    return enrichment.enrichAircraftList(candidates);
  }

  function stopPoller() {
    if (pollerTimer) {
      clearInterval(pollerTimer);
      pollerTimer = null;
    }
  }

  function closeSession(reason = 'manual') {
    stopPoller();
    if (!session) return { ok: true, closed: false };
    const emit = session.send || sendUdpPayload;
    if (typeof emit === 'function') {
      emit(buildOverheadClosePayload({
        sessionId: session.sessionId,
        device: session.device,
        timestamp: now(),
        trigger: `overhead-close-${reason}`,
      }, config));
    }
    const closedId = session.sessionId;
    session = null;
    log?.info?.('Overhead session closed', { sessionId: closedId, reason });
    return { ok: true, closed: true, sessionId: closedId };
  }

  async function sendUpdate(currentSettings) {
    if (!session || pollInFlight) return;
    pollInFlight = true;
    try {
      const sorted = await fetchSortedAircraft(currentSettings, session.home);
      lastAircraftCount = sorted.length;
      const { aircraft, routes } = await enrichList(sorted, currentSettings);
      session.routes = routes;
      session.aircraftCount = sorted.length;
      const emit = session.send || sendUdpPayload;
      if (typeof emit === 'function') {
        emit(buildOverheadUpdatePayload({
          sessionId: session.sessionId,
          aircraft: sorted,
          routes: currentSettings.showRoutes ? routes : {},
          device: session.device,
          timestamp: now(),
          trigger: 'overhead-poller',
        }, config));
      }
    } catch (error) {
      lastError = error?.message || String(error);
      log?.warn?.('Overhead poll failed', lastError);
    } finally {
      pollInFlight = false;
    }
  }

  function startPoller(currentSettings) {
    stopPoller();
    const intervalMs = Math.max(3000, Number(currentSettings.refreshSeconds || 5) * 1000);
    pollerTimer = setInterval(() => {
      sendUpdate(currentSettings).catch(() => {});
    }, intervalMs);
  }

  async function push(overrides = {}, {
    device = 'Signal',
    triggeredBy = 'manual',
    send,
  } = {}) {
    const home = getHomeLatLon(config);
    if (!home) {
      return {
        ok: false,
        error: 'No home location — set voiceEvents.defaultLocation in config (same as weather)',
      };
    }

    const current = { ...settings.get(), ...overrides };
    closeSession('replace');

    let sorted = [];
    try {
      sorted = await fetchSortedAircraft(current, home);
      lastAircraftCount = sorted.length;
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }

    if (triggeredBy === 'scheduler' && sorted.length === 0) {
      return { ok: false, error: 'No aircraft in range for the scheduler' };
    }

    const { aircraft: enrichedCandidates, routes } = await enrichList(sorted, current);
    void enrichedCandidates;

    let loops = current.loops || 'once';
    if (triggeredBy === 'scheduler' && loops === 'until-dismissed') {
      loops = 'once';
    }
    const loopsN = loopCount(loops);
    const durationSeconds = estimateDuration({ ...current, loops }, sorted.length);
    const sessionId = `overhead-${now()}`;

    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (typeof emit !== 'function') {
      return { ok: false, error: 'No UDP sender is wired up' };
    }

    const payload = buildOverheadRoundPayload({
      settings: current,
      home,
      aircraft: sorted,
      routes: current.showRoutes ? routes : {},
      sessionId,
      loops,
      loopCount: loopsN,
      cycleSeconds: cycleSecondsFor(current, sorted.length),
      durationSeconds,
      geoBaseUrl: geoBaseUrl(),
      device,
      timestamp: now(),
      trigger: `overhead-${triggeredBy}`,
      triggeredBy,
    }, config);

    if (!payload) {
      return { ok: false, error: 'Could not build an Overhead payload' };
    }

    emit(payload);
    session = {
      sessionId,
      settings: current,
      home,
      routes,
      aircraftCount: sorted.length,
      startedAt: now(),
      device,
      send: emit,
    };
    startPoller(current);

    log?.info?.('Overhead round pushed', {
      aircraft: sorted.length,
      seconds: durationSeconds,
      triggeredBy,
      sessionId,
    });

    return {
      ok: true,
      sessionId,
      aircraftCount: sorted.length,
      durationSeconds,
      cycleSeconds: cycleSecondsFor(current, sorted.length),
      clearSkies: sorted.length === 0,
    };
  }

  function hasContent(overrides = {}) {
    return lastAircraftCount > 0 || Number(statusSnapshot(overrides).aircraftInRange || 0) > 0;
  }

  function statusSnapshot(overrides = {}) {
    const current = { ...settings.get(), ...overrides };
    const home = getHomeLatLon(config);
    return {
      enabled: true,
      settings: current,
      home: home
        ? { name: home.name, latitude: home.lat, longitude: home.lon }
        : null,
      hasHome: Boolean(home),
      hasContent: lastAircraftCount > 0,
      aircraftInRange: lastAircraftCount,
      lastFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
      lastError,
      cycleSeconds: cycleSecondsFor(current, lastAircraftCount),
      estimatedDurationSeconds: estimateDuration(current, lastAircraftCount),
      geoBaseUrl: geoBaseUrl(),
      session: session
        ? {
          sessionId: session.sessionId,
          startedAt: new Date(session.startedAt).toISOString(),
          aircraftCount: session.aircraftCount,
        }
        : null,
    };
  }

  async function testProvider(overrides = {}) {
    const home = getHomeLatLon(config);
    if (!home) {
      return { ok: false, error: 'No home location — set voiceEvents.defaultLocation' };
    }
    const current = { ...settings.get(), ...overrides };
    const provider = providerFor(current);
    return provider.testConnection(home.lat, home.lon, current.radiusNm);
  }

  async function prefetchCount() {
    const home = getHomeLatLon(config);
    if (!home) return 0;
    try {
      const sorted = await fetchSortedAircraft(settings.get(), home);
      lastAircraftCount = sorted.length;
      return sorted.length;
    } catch (error) {
      lastError = error?.message || String(error);
      return 0;
    }
  }

  return {
    settings,
    enrichment,
    push,
    closeSession,
    sendUpdate,
    statusSnapshot,
    hasContent,
    estimateDuration: (overrides = {}, count = lastAircraftCount) => {
      const current = { ...settings.get(), ...overrides };
      const aircraftCount = Number.isFinite(Number(count)) ? Number(count) : lastAircraftCount;
      return estimateDuration(current, aircraftCount);
    },
    testProvider,
    prefetchCount,
    getHomeLatLon: () => getHomeLatLon(config),
    geoBaseUrl,
  };
}

module.exports = {
  getHomeLatLon,
  createOverheadService,
};
