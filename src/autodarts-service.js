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

  async function fetchBoardInfo() {
    const stored = credentials.load();
    const boardId = stored.boardId;
    if (!boardId) {
      return normalizeBoardFallback(stored);
    }
    try {
      // Prefer the boards *list* — GET /bs/v0/boards/{id} often returns detections=0.
      let raw = null;
      const list = await api.getBoards();
      if (list?.ok) {
        const rows = Array.isArray(list.json) ? list.json
          : (Array.isArray(list.json?.boards) ? list.json.boards : []);
        raw = rows.find((row) => (row.id || row.boardId) === boardId) || null;
      }
      if (!raw && api?.getBoard) {
        const detail = await api.getBoard(boardId);
        if (detail?.ok && detail.json && !Array.isArray(detail.json)) {
          raw = detail.json;
        }
      }
      const { normalizeBoardInfo } = require('./autodarts-payload');
      return normalizeBoardInfo(raw, { fallbackName: stored.boardName || boardId });
    } catch (error) {
      log?.warn?.('Autodarts board info fetch failed', error?.message || error);
      return normalizeBoardFallback(stored);
    }
  }

  function normalizeBoardFallback(stored = {}) {
    const { normalizeBoardInfo } = require('./autodarts-payload');
    return normalizeBoardInfo(null, {
      fallbackName: stored.boardName || stored.boardId || null,
    });
  }

  async function pushDashboard({ send } = {}) {
    if (archive.count() <= 0) {
      return { ok: false, error: 'No Autodarts matches archived yet — play one and the archive starts itself' };
    }
    const board = await fetchBoardInfo();
    const body = payload.buildDashboard({ board });
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
    return { ok: true, type: body.type, displaySeconds: body.displaySeconds, mode: 'last-match' };
  }

  function pushNow({ send, mode = 'auto' } = {}) {
    const { isPlayableLiveMatch } = require('./autodarts-payload');
    const liveMatch = live.getMatch();
    if ((mode === 'auto' || mode === 'now' || mode === 'now-playing')
      && isPlayableLiveMatch(liveMatch)) {
      const body = payload.buildMatch(liveMatch, { persistent: true, status: 'live' });
      const emit = typeof send === 'function' ? send : sendUdpPayload;
      if (!emit) return { ok: false, error: 'UDP sender unavailable' };
      emit(body, { source: 'manual' });
      return { ok: true, type: body.type, mode: 'live' };
    }
    if (mode === 'now' || mode === 'now-playing') {
      // Prefer last finished match over a hard error when the live shell is empty.
      const last = pushLastMatch({ send });
      if (last.ok) return { ...last, mode: 'last-match', note: 'No live match — showing last finished game' };
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
    // Pull cloud Match History into the local archive (cache). Fail-soft if offline.
    try {
      history.schedule?.();
    } catch (error) {
      log?.warn?.('Autodarts history schedule failed', error?.message || error);
    }
  }

  function close() {
    live.stop();
    history.stop?.();
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
