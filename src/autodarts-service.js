/**
 * Autodarts facade — auth, boards, settings, archive, live, push helpers.
 */

const { createAutodartsSettings } = require('./autodarts-settings');
const { createAutodartsCredentials } = require('./autodarts-credentials');
const { createAutodartsApi } = require('./autodarts-api');
const { createAutodartsAuth } = require('./autodarts-auth');
const { createAutodartsArchive } = require('./autodarts-archive');
const { createAutodartsAggregates } = require('./autodarts-aggregates');
const { createAutodartsHistory } = require('./autodarts-history');
const { createAutodartsPayload } = require('./autodarts-payload');
const { createAutodartsLive } = require('./autodarts-live');

function createAutodartsService({
  config = {},
  log = console,
  sendUdpPayload = null,
  displayBusy = null,
  dependencies = {},
} = {}) {
  const settings = dependencies.settings || createAutodartsSettings(config, log);
  const credentials = dependencies.credentials || createAutodartsCredentials(config);
  const authRef = { current: null };
  const api = dependencies.api || createAutodartsApi({
    fetchImpl: dependencies.fetchImpl || global.fetch,
    accessTokenProvider: async () => authRef.current.getAccessToken(),
    clientId: process.env.AUTODARTS_CLIENT_ID,
    clientSecret: process.env.AUTODARTS_CLIENT_SECRET || '',
    log,
  });
  const auth = dependencies.auth || createAutodartsAuth({
    credentials,
    api,
    env: config.env || process.env,
    log,
  });
  authRef.current = auth;

  const archive = dependencies.archive || createAutodartsArchive(config, log);
  const aggregates = dependencies.aggregates || createAutodartsAggregates(config, log);
  if (!dependencies.aggregates && archive.count() > 0) {
    try {
      aggregates.recompute(archive.listAll());
    } catch (error) {
      log?.warn?.('Autodarts initial aggregate rebuild failed', error?.message || error);
    }
  }
  const history = dependencies.history || createAutodartsHistory({
    archive,
    aggregates,
    api,
    settings,
    log,
  });
  const payload = dependencies.payload || createAutodartsPayload({
    archive,
    aggregates,
    settings,
  });
  const live = dependencies.live || createAutodartsLive({
    auth,
    api,
    credentials,
    settings,
    archive,
    aggregates,
    payload,
    sendUdpPayload,
    displayBusy,
    log,
    WebSocketImpl: dependencies.WebSocketImpl,
  });

  function statusSnapshot() {
    const authStatus = auth.statusSnapshot();
    const liveStatus = live.statusSnapshot();
    const historyStatus = history.status();
    return {
      ...authStatus,
      oauth: credentials.oauthStatus(),
      live: liveStatus,
      settings: settings.get(),
      archive: {
        count: archive.count(),
        ...historyStatus,
      },
      players: aggregates.get()?.players?.length || 0,
      hasArchive: archive.count() > 0,
      hasLiveMatch: Boolean(liveStatus.matchId && liveStatus.phase === 'live'),
    };
  }

  function saveOauthClient(body = {}) {
    const result = credentials.saveOauthClient(body);
    if (!result.ok) return result;
    return { ok: true, oauth: credentials.oauthStatus() };
  }

  async function fetchCommunityOauth({
    fetchImpl = dependencies.fetchImpl || global.fetch,
  } = {}) {
    const url = credentials.COMMUNITY_CREDENTIALS_URL;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 10_000) : null;
      const response = await fetchImpl(url, { signal: controller?.signal });
      if (timer) clearTimeout(timer);
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!response.ok) {
        return {
          ok: false,
          error: `Credential helper returned HTTP ${response.status}`,
          credentialsUrl: url,
        };
      }
      const clientId = String(json?.client_id || json?.clientId || '').trim();
      const clientSecret = String(json?.client_secret || json?.clientSecret || '').trim();
      if (!clientId || !clientSecret) {
        return {
          ok: false,
          error: 'Credential helper response was missing client_id or client_secret',
          credentialsUrl: url,
        };
      }
      return {
        ok: true,
        clientId,
        clientSecret,
        credentialsUrl: url,
        note: 'Paste is ready — click Save client to store them encrypted on this bridge',
      };
    } catch (error) {
      return {
        ok: false,
        error: error?.name === 'AbortError'
          ? 'Credential helper timed out'
          : (error?.message || 'Could not reach the credential helper'),
        credentialsUrl: url,
      };
    }
  }

  async function listBoards() {
    const result = await api.getBoards();
    if (!result.ok) {
      return {
        ok: false,
        error: result.json?.message || result.json?.error || `Boards request failed (${result.status})`,
        boards: [],
      };
    }
    const raw = result.json;
    const boards = Array.isArray(raw) ? raw
      : (Array.isArray(raw?.boards) ? raw.boards : []);
    return {
      ok: true,
      boards: boards.map((row) => ({
        id: row.id || row.boardId,
        name: row.name || row.boardName || row.id || 'Board',
        online: row.online ?? row.connected ?? null,
      })).filter((row) => row.id),
    };
  }

  async function selectBoard({ boardId, boardName } = {}) {
    const id = String(boardId || '').trim();
    if (!id) return { ok: false, error: 'boardId is required' };
    const saved = credentials.updateBoard({ boardId: id, boardName: boardName || id });
    if (!saved.ok) return saved;
    // Restart live watcher against the new board.
    live.stop();
    live.start();
    return { ok: true, ...statusSnapshot() };
  }

  async function testConnection() {
    try {
      const boards = await listBoards();
      if (!boards.ok) {
        return { ok: false, message: boards.error || 'Autodarts test failed' };
      }
      const stored = credentials.load();
      let boardLine = 'no board selected';
      if (stored.boardId) {
        try {
          const state = await api.getBoardState(stored.boardId);
          const online = state.json?.online ?? state.json?.connected
            ?? boards.boards.find((b) => b.id === stored.boardId)?.online;
          boardLine = `board ${stored.boardName || stored.boardId} ${online ? 'online' : 'offline'}`;
        } catch {
          boardLine = `board ${stored.boardName || stored.boardId}`;
        }
      }
      const name = stored.userName || 'linked account';
      return {
        ok: true,
        message: `Autodarts ok — ${name} · ${boardLine}`,
        boards: boards.boards,
      };
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  }

  function updateSettings(patch) {
    const next = settings.update(patch || {});
    return { ok: true, settings: next };
  }

  function pushDashboard({ send } = {}) {
    if (archive.count() <= 0) {
      return { ok: false, error: 'No Autodarts matches archived yet — play one and the archive starts itself' };
    }
    const body = payload.buildDashboard();
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    emit(body, { source: 'manual' });
    return { ok: true, type: body.type, displaySeconds: body.displaySeconds };
  }

  function pushLastMatch({ send } = {}) {
    const body = payload.buildLastMatch();
    if (!body) {
      return { ok: false, error: 'No Autodarts matches archived yet' };
    }
    const emit = typeof send === 'function' ? send : sendUdpPayload;
    if (!emit) return { ok: false, error: 'UDP sender unavailable' };
    emit(body, { source: 'manual' });
    return { ok: true, type: body.type, displaySeconds: body.displaySeconds };
  }

  function pushNow({ send, mode = 'auto' } = {}) {
    const liveMatch = live.getMatch();
    if ((mode === 'auto' || mode === 'now' || mode === 'now-playing')
      && liveMatch?.status === 'live') {
      const body = payload.buildMatch(liveMatch, { persistent: true, status: 'live' });
      const emit = typeof send === 'function' ? send : sendUdpPayload;
      if (!emit) return { ok: false, error: 'UDP sender unavailable' };
      emit(body, { source: 'manual' });
      return { ok: true, type: body.type, mode: 'live' };
    }
    if (mode === 'now' || mode === 'now-playing') {
      return { ok: false, error: 'No live Autodarts match right now' };
    }
    // Scheduled last-match must never air a live takeover.
    if (mode === 'last-match') {
      return pushLastMatch({ send });
    }
    return pushLastMatch({ send });
  }

  function start() {
    live.start();
  }

  function close() {
    live.stop();
    auth.stopDevicePoll?.();
  }

  return {
    settings,
    credentials,
    auth,
    api,
    archive,
    aggregates,
    history,
    payload,
    live,
    statusSnapshot,
    listBoards,
    selectBoard,
    testConnection,
    updateSettings,
    pushDashboard,
    pushLastMatch,
    pushNow,
    start,
    close,
    suppressActiveSession: (...args) => live.suppressActiveSession(...args),
    beginDeviceLink: (...args) => auth.beginDeviceLink(...args),
    loginWithPassword: (...args) => auth.loginWithPassword(...args),
    unlink: (...args) => auth.unlink(...args),
    stopDevicePoll: () => {
      auth.stopDevicePoll?.();
      return { ok: true, ...statusSnapshot() };
    },
    syncHistory: (...args) => history.sync(...args),
    saveOauthClient,
    fetchCommunityOauth,
  };
}

module.exports = {
  createAutodartsService,
};
