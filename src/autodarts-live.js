/**
 * Autodarts live match supervisor — WebSocket + interrupt/resume + inactivity.
 * Unofficial API; fail-soft. Injectable WebSocket + clock for tests.
 */

const { buildMatchPayload, buildMatchClosePayload } = require('./autodarts-payload');
const { WS_URL: DEFAULT_WS_URL } = require('./autodarts-api');

const WS_URL = DEFAULT_WS_URL || 'wss://play.ws.autodarts.com/ms/v0/subscribe';
const STATS_RETRY_MS = Object.freeze([45_000, 90_000, 180_000, 300_000]);
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const BOARD_POLL_MS = 20_000;

function resolveWebSocketImpl(explicit) {
  // Tests pass `null` to disable sockets; omit / undefined → auto-detect.
  if (explicit === null) return null;
  if (explicit) return explicit;
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try {
    // Node 20 (Docker image) has no global WebSocket — use the `ws` package.
    return require('ws');
  } catch {
    return null;
  }
}

function stableJson(value) {
  return JSON.stringify(value);
}

function normalizeDart(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    const seg = String(raw || '').trim();
    return seg ? { seg, x: null, y: null, type: 'normal' } : null;
  }
  const seg = String(
    raw.seg || raw.name || raw.segment || raw.shortName || '',
  ).trim() || 'M';
  const type = String(raw.type || '').toLowerCase() === 'bouncer'
    ? 'bouncer'
    : 'normal';
  const x = Number.isFinite(Number(raw.x)) ? Number(raw.x)
    : (Number.isFinite(Number(raw.coords?.x)) ? Number(raw.coords.x) : null);
  const y = Number.isFinite(Number(raw.y)) ? Number(raw.y)
    : (Number.isFinite(Number(raw.coords?.y)) ? Number(raw.coords.y) : null);
  return { seg, x, y, type };
}

function settingsLineFrom(meta = {}) {
  if (meta.settingsLine) return String(meta.settingsLine);
  const settings = meta.settings || {};
  const parts = [];
  if (settings.baseScore) parts.push(String(settings.baseScore));
  const inMode = settings.inMode || settings.in;
  const outMode = settings.outMode || settings.out;
  if (inMode || outMode) {
    parts.push([inMode, outMode].filter(Boolean).join('-'));
  }
  const legs = settings.legs || settings.bestOf || meta.legs;
  if (legs) parts.push(`First to ${legs} legs`);
  return parts.join(' · ') || String(meta.variant || 'Match');
}

function mapPlayers(state = {}, meta = {}) {
  const roster = state.players || meta.players || [];
  return roster.map((row, index) => {
    const name = row.name || row.playerName || row.player?.name || `Player ${index + 1}`;
    const score = row.score ?? row.remaining ?? row.points ?? row.lives ?? 0;
    return {
      name,
      score: Number(score) || 0,
      legs: Number(row.legs ?? row.legsWon ?? 0) || 0,
      sets: Number(row.sets ?? row.setsWon ?? 0) || 0,
      average: row.average != null ? Number(row.average) : null,
      lastTurnPoints: row.lastTurnPoints != null ? Number(row.lastTurnPoints) : null,
      isWinner: Boolean(row.isWinner || row.winner),
      userId: row.userId || row.playerId || row.player?.id || null,
      checkoutPct: row.checkoutPct ?? null,
    };
  });
}

function mapTurn(raw = {}) {
  const darts = Array.isArray(raw.darts) ? raw.darts.map(normalizeDart) : [null, null, null];
  while (darts.length < 3) darts.push(null);
  return {
    points: Number(raw.points ?? raw.score ?? 0) || 0,
    busted: Boolean(raw.busted || raw.bust),
    darts: darts.slice(0, 3),
  };
}

function matchFromState(matchId, state = {}, meta = {}, revision = 0) {
  const players = mapPlayers(state, meta);
  const currentPlayerIndex = Number.isInteger(state.currentPlayerIndex)
    ? state.currentPlayerIndex
    : Number(state.player || state.throwingPlayer || 0) || 0;
  return {
    matchId: String(matchId),
    revision,
    status: state.finished || state.status === 'finished' ? 'finished' : 'live',
    variant: meta.variant || state.variant || 'X01',
    settingsLine: settingsLineFrom({ ...meta, ...(state.settings ? { settings: state.settings } : {}) }),
    settings: meta.settings || state.settings || null,
    startedAt: meta.startedAt || state.startedAt || null,
    durationSec: Number(state.durationSec ?? state.duration ?? 0) || 0,
    currentPlayerIndex,
    turn: mapTurn(state.turn || state.throws || {}),
    prevTurn: state.prevTurn ? {
      playerIndex: Number(state.prevTurn.playerIndex) || 0,
      points: Number(state.prevTurn.points) || 0,
      darts: (state.prevTurn.darts || []).map(normalizeDart),
    } : null,
    players,
    gameShot: state.gameShot || meta.gameShot || null,
    hitMap: state.hitMap || meta.hitMap || null,
    local: meta.local !== false,
    winner: state.winner || meta.winner || null,
  };
}

function createAutodartsLive({
  auth,
  api,
  credentials,
  settings,
  archive,
  aggregates,
  payload,
  sendUdpPayload,
  displayBusy = null,
  log = console,
  now = () => Date.now(),
  WebSocketImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const SocketImpl = resolveWebSocketImpl(WebSocketImpl);
  let phase = 'idle'; // idle | live | interrupted | final | dormant
  let socket = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let inactivityTimer = null;
  let restoreTimer = null;
  let finalTimer = null;
  let boardPollTimer = null;
  let started = false;
  let unavailableReason = null;
  let match = null;
  let lastPushedJson = null;
  let lastEventAt = 0;
  let suppressed = false;
  let suppressedAt = 0;
  let dormantMatchId = null;
  let statsTask = null;
  let boardOnline = null;

  function clearTimer(handle) {
    if (!handle) return;
    clearTimeout(handle);
    clearInterval(handle);
  }

  function inactivityMs() {
    const minutes = settings.get().live.inactivityMinutes || 15;
    return minutes * 60_000;
  }

  function finalHoldMs() {
    return (settings.get().live.finalHoldSeconds || 60) * 1000;
  }

  function restoreAfterMs() {
    // Same ballpark as Steam's interrupt restore — display-busy hold elapse.
    const snap = displayBusy?.snapshot?.();
    if (snap?.remainingSeconds > 0) {
      return Math.max(1_000, snap.remainingSeconds * 1000);
    }
    return 75_000;
  }

  function statusSnapshot() {
    return {
      phase,
      started,
      unavailableReason,
      boardOnline,
      matchId: match?.matchId || null,
      revision: match?.revision || 0,
      suppressed,
      lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
      dormantMatchId,
    };
  }

  function pushMatch(force = false) {
    if (!match || !sendUdpPayload) return false;
    if (!settings.get().live.autoPush && match.status === 'live' && !force) {
      return false;
    }
    if (suppressed && match.status === 'live') return false;
    const body = payload?.buildMatch
      ? payload.buildMatch(match, {
        persistent: match.status === 'live',
        displaySeconds: match.status === 'finished'
          ? settings.get().lastMatch.displaySeconds
          : null,
        status: match.status,
      })
      : buildMatchPayload(match);
    const json = stableJson(body.match);
    if (!force && json === lastPushedJson) return false;
    lastPushedJson = json;
    sendUdpPayload(body, { source: 'event' });
    return true;
  }

  function pushClose(reason = 'close') {
    if (!match?.matchId || !sendUdpPayload) return;
    sendUdpPayload(
      payload?.buildClose
        ? payload.buildClose(match.matchId, reason)
        : buildMatchClosePayload(match.matchId, reason),
      { source: 'event' },
    );
    lastPushedJson = null;
  }

  function resetInactivity() {
    clearTimer(inactivityTimer);
    inactivityTimer = null;
    if (!match || match.status !== 'live' || phase === 'dormant') return;
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      handleInactivity();
    }, inactivityMs());
    if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
  }

  function handleInactivity() {
    if (!match || match.status !== 'live') return;
    log?.info?.('Autodarts match closed for inactivity', { matchId: match.matchId });
    dormantMatchId = match.matchId;
    pushClose('inactivity');
    phase = 'dormant';
    suppressed = false;
    clearTimer(restoreTimer);
    restoreTimer = null;
  }

  function scheduleRestore() {
    clearTimer(restoreTimer);
    const delay = restoreAfterMs();
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      maybeResumeAfterInterrupt();
    }, delay);
    if (typeof restoreTimer.unref === 'function') restoreTimer.unref();
  }

  function maybeResumeAfterInterrupt() {
    if (!match || match.status !== 'live' || !suppressed) return;
    if (now() - lastEventAt > inactivityMs()) {
      handleInactivity();
      return;
    }
    if (displayBusy?.isBusy?.()) {
      const snap = displayBusy.snapshot();
      if (snap?.type && snap.type !== 'autodarts.match') {
        scheduleRestore();
        return;
      }
    }
    suppressed = false;
    suppressedAt = 0;
    phase = 'live';
    log?.info?.('Autodarts live restoring after interrupt', { matchId: match.matchId });
    pushMatch(true);
  }

  function suppressActiveSession(reason = 'interrupted') {
    if (!match || match.status !== 'live' || suppressed) return false;
    suppressed = true;
    suppressedAt = now();
    phase = 'interrupted';
    scheduleRestore();
    log?.info?.('Autodarts live suppressed', { matchId: match.matchId, reason });
    return true;
  }

  async function seedMatch(matchId) {
    let meta = {};
    let state = {};
    try {
      const metaRes = await api.getMatch(matchId);
      if (metaRes.ok) meta = metaRes.json || {};
    } catch (error) {
      log?.warn?.('Autodarts match meta failed', error?.message || error);
    }
    try {
      const stateRes = await api.getMatchState(matchId);
      if (stateRes.ok) state = stateRes.json || {};
    } catch (error) {
      log?.warn?.('Autodarts match state failed', error?.message || error);
    }
    const next = matchFromState(matchId, state, meta, 1);
    applyMatch(next, { forcePush: true });
    subscribeMatch(matchId);
  }

  function applyMatch(next, { forcePush = false } = {}) {
    const wasDormantSame = phase === 'dormant' && dormantMatchId && dormantMatchId === next.matchId;
    if (wasDormantSame && next.status === 'live') {
      // Fresh activity after inactivity — treat as a new push cycle.
      dormantMatchId = null;
      phase = 'live';
      forcePush = true;
    }
    if (match?.matchId === next.matchId && Number(next.revision) < Number(match.revision || 0)) {
      return;
    }
    // Preserve prevTurn when upstream only sends current turn darts.
    if (match?.matchId === next.matchId && match.prevTurn && !next.prevTurn) {
      const prevPlayer = match.currentPlayerIndex;
      if (next.currentPlayerIndex !== prevPlayer && match.turn?.darts?.some(Boolean)) {
        next.prevTurn = {
          playerIndex: prevPlayer,
          points: match.turn.points,
          darts: match.turn.darts,
        };
      } else {
        next.prevTurn = match.prevTurn;
      }
    }
    match = next;
    lastEventAt = now();
    if (next.status === 'finished') {
      beginFinal();
      return;
    }
    if (phase === 'dormant') {
      phase = 'live';
      dormantMatchId = null;
      forcePush = true;
    } else if (phase === 'idle' || phase === 'interrupted') {
      if (!suppressed) phase = 'live';
    } else {
      phase = suppressed ? 'interrupted' : 'live';
    }
    resetInactivity();
    pushMatch(forcePush);
  }

  function beginFinal() {
    clearTimer(inactivityTimer);
    clearTimer(restoreTimer);
    suppressed = false;
    phase = 'final';
    if (match) {
      match.status = 'finished';
      match.revision = (Number(match.revision) || 0) + 1;
    }
    pushMatch(true);
    clearTimer(finalTimer);
    finalTimer = setTimeout(() => {
      finalTimer = null;
      pushClose('final-hold');
      phase = 'idle';
      match = null;
      lastPushedJson = null;
    }, finalHoldMs());
    if (typeof finalTimer.unref === 'function') finalTimer.unref();
    scheduleArchive(match?.matchId);
  }

  function scheduleArchive(matchId) {
    if (!matchId || archive.has(matchId)) return;
    if (statsTask?.matchId === matchId) return;
    let attempt = 0;
    const run = async () => {
      try {
        const result = await api.getMatchStats(matchId);
        if (result.status === 404 && attempt < STATS_RETRY_MS.length) {
          const delay = STATS_RETRY_MS[attempt];
          attempt += 1;
          statsTask = {
            matchId,
            timer: setTimeout(() => { run().catch(() => {}); }, delay),
          };
          if (typeof statsTask.timer.unref === 'function') statsTask.timer.unref();
          return;
        }
        if (!result.ok) {
          log?.warn?.('Autodarts stats fetch failed', result.status);
          // Archive what we already know so the dashboard still grows.
          archiveKnown(matchId, null);
          statsTask = null;
          return;
        }
        archiveKnown(matchId, result.json);
        statsTask = null;
      } catch (error) {
        log?.warn?.('Autodarts archive path failed', error?.message || error);
        archiveKnown(matchId, null);
        statsTask = null;
      }
    };
    run().catch(() => {});
  }

  function archiveKnown(matchId, statsJson) {
    if (archive.has(matchId)) return;
    const statsPlayers = statsJson?.players || statsJson?.stats || [];
    const players = (match?.players || []).map((row, index) => {
      const fromStats = statsPlayers[index] || statsPlayers.find(
        (item) => String(item.name || '').toLowerCase() === String(row.name || '').toLowerCase(),
      ) || {};
      return {
        name: row.name,
        userId: row.userId || fromStats.userId || null,
        legsWon: row.legs,
        setsWon: row.sets,
        average: fromStats.average ?? row.average,
        first9: fromStats.first9 ?? null,
        dartsThrown: fromStats.dartsThrown ?? fromStats.darts ?? null,
        pointsScored: fromStats.pointsScored ?? fromStats.points ?? null,
        checkoutPct: fromStats.checkoutPct ?? null,
        checkoutHits: fromStats.checkoutHits ?? null,
        checkoutAttempts: fromStats.checkoutAttempts ?? null,
        bestCheckout: fromStats.bestCheckout ?? null,
        counts: fromStats.counts || {},
      };
    });
    const winner = match?.winner
      || players.find((row) => row.isWinner)?.name
      || (match?.players || []).find((row) => row.isWinner)?.name
      || null;
    archive.append({
      matchId,
      variant: match?.variant || 'X01',
      settings: match?.settings || null,
      local: match?.local !== false,
      startedAt: match?.startedAt || null,
      finishedAt: new Date(now()).toISOString(),
      durationSec: match?.durationSec || 0,
      players,
      winner,
      gameShot: match?.gameShot || null,
      hitMap: match?.hitMap || statsJson?.hitMap || null,
      source: 'live',
      revision: match?.revision || 0,
    });
    aggregates.recompute(archive.listAll());
  }

  function subscribeMatch(matchId) {
    const id = String(matchId || '').trim();
    if (!id) return;
    // play.autodarts.io MessageBroker topics (channel + topic, not boards:id).
    sendWs({ type: 'subscribe', channel: 'autodarts.matches', topic: `${id}.state` });
    sendWs({ type: 'subscribe', channel: 'autodarts.matches', topic: `${id}.events` });
  }

  function subscribeBoard(boardId) {
    const id = String(boardId || '').trim();
    if (!id) return;
    sendWs({ type: 'subscribe', channel: 'autodarts.boards', topic: `${id}.state` });
    sendWs({ type: 'subscribe', channel: 'autodarts.boards', topic: `${id}.matches` });
    sendWs({ type: 'subscribe', channel: 'autodarts.boards', topic: `${id}.events` });
  }

  function sendWs(message) {
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      log?.warn?.('Autodarts WS send failed', error?.message || error);
    }
  }

  function extractMatchId(message) {
    return message?.matchId
      || message?.data?.matchId
      || message?.data?.match?.id
      || message?.id
      || message?.data?.id
      || message?.match?.id
      || message?.board?.matchId
      || null;
  }

  async function pollBoardForMatch() {
    if (!started) return;
    const boardId = credentials.load()?.boardId;
    if (!boardId || !api?.getBoardState) return;
    // WS is primary; polling only fills gaps when we have no live match yet.
    if (match?.status === 'live' && phase === 'live') return;
    try {
      const result = await api.getBoardState(boardId);
      if (!result?.ok || !result.json) return;
      const data = result.json;
      const online = data.online ?? data.connected ?? data.status === 'online';
      if (online != null) boardOnline = Boolean(online);
      const matchId = extractMatchId(data)
        || data.currentMatchId
        || data.activeMatchId
        || data.match?.id
        || null;
      if (matchId && (!match || match.matchId !== String(matchId))) {
        await seedMatch(String(matchId));
      }
    } catch (error) {
      log?.debug?.('Autodarts board poll failed', error?.message || error);
    }
  }

  function scheduleBoardPoll() {
    clearTimer(boardPollTimer);
    boardPollTimer = setInterval(() => {
      pollBoardForMatch().catch(() => {});
    }, BOARD_POLL_MS);
    if (typeof boardPollTimer.unref === 'function') boardPollTimer.unref();
    // Immediate check after connect / start.
    pollBoardForMatch().catch(() => {});
  }

  function handleWsMessage(raw) {
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    const channel = String(message.channel || message.topic || message.type || '');
    const event = String(message.event || message.name || message.type || '').toLowerCase();
    const data = message.data || message.payload || message;

    if (/board/i.test(channel) || event.includes('board')) {
      const online = data.online ?? data.connected ?? data.status === 'online';
      if (online != null) boardOnline = Boolean(online);
      const matchId = extractMatchId(data) || extractMatchId(message);
      if (matchId && (!match || match.matchId !== String(matchId))) {
        if (phase === 'dormant' && dormantMatchId === String(matchId)) {
          // Will re-open on first throw/state below.
        }
        seedMatch(String(matchId)).catch((error) => {
          log?.warn?.('Autodarts seed failed', error?.message || error);
        });
      }
    }

    const matchId = extractMatchId(message) || match?.matchId;
    if (!matchId) return;

    if (event.includes('finish') || event.includes('gameshot') || event === 'match.finished'
      || data.finished === true || data.status === 'finished') {
      const next = matchFromState(
        matchId,
        { ...(data.state || data), finished: true, gameShot: data.gameShot || data.segment },
        { ...(match || {}), winner: data.winner || match?.winner },
        (Number(match?.revision) || 0) + 1,
      );
      if (data.gameShot || data.segment) {
        next.gameShot = String(data.gameShot || data.segment);
      }
      applyMatch(next);
      return;
    }

    if (data.state || data.players || data.turn || data.throws || event.includes('throw')
      || event.includes('state') || event.includes('turn')) {
      const state = data.state || data;
      const revision = Number(data.revision ?? state.revision ?? (Number(match?.revision) || 0) + 1);
      const next = matchFromState(matchId, state, match || {}, revision);
      if (Array.isArray(data.darts) || Array.isArray(state.darts)) {
        next.turn = mapTurn({
          ...(state.turn || {}),
          darts: data.darts || state.darts,
          points: data.points ?? state.points ?? state.turn?.points,
          busted: data.busted ?? state.busted,
        });
      }
      applyMatch(next);
    }
  }

  async function connect() {
    if (!SocketImpl) {
      unavailableReason = 'WebSocket unavailable in this runtime (install the ws package)';
      log?.error?.(unavailableReason);
      return;
    }
    const stored = credentials.load();
    if (!stored.boardId) {
      unavailableReason = 'Choose a board in Settings';
      return;
    }
    let token;
    try {
      token = await auth.getAccessToken();
    } catch (error) {
      unavailableReason = error?.message || 'Autodarts auth failed';
      scheduleReconnect();
      return;
    }
    unavailableReason = null;

    let wsUrl = WS_URL;
    try {
      if (typeof api?.createSubscribeTicket === 'function') {
        const ticket = await api.createSubscribeTicket(token);
        const code = ticket?.json?.code || ticket?.json?.ticket || ticket?.json?.data?.code;
        if (ticket?.ok && code) {
          wsUrl = `${WS_URL}?code=${encodeURIComponent(code)}`;
        }
      }
    } catch (error) {
      log?.warn?.('Autodarts WS ticket failed; connecting without code', error?.message || error);
    }

    try {
      // Prefer Authorization header when the runtime supports it (`ws` package).
      socket = new SocketImpl(wsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      try {
        const joined = wsUrl.includes('?')
          ? `${wsUrl}&token=${encodeURIComponent(token)}`
          : `${wsUrl}?token=${encodeURIComponent(token)}`;
        socket = new SocketImpl(joined);
      } catch (error) {
        unavailableReason = error?.message || 'Could not open Autodarts WebSocket';
        scheduleReconnect();
        return;
      }
    }

    socket.addEventListener?.('open', onOpen) || (socket.onopen = onOpen);
    socket.addEventListener?.('message', (event) => {
      handleWsMessage(event?.data ?? event);
    }) || (socket.onmessage = (event) => handleWsMessage(event?.data ?? event));
    socket.addEventListener?.('close', onClose) || (socket.onclose = onClose);
    socket.addEventListener?.('error', () => {
      unavailableReason = unavailableReason || 'Autodarts WebSocket error';
    }) || (socket.onerror = () => {
      unavailableReason = unavailableReason || 'Autodarts WebSocket error';
    });
  }

  function onOpen() {
    reconnectAttempt = 0;
    unavailableReason = null;
    const boardId = credentials.load().boardId;
    if (boardId) subscribeBoard(boardId);
    if (match?.matchId && match.status === 'live') subscribeMatch(match.matchId);
    scheduleBoardPoll();
    log?.info?.('Autodarts live WebSocket connected', { url: WS_URL });
  }

  function onClose() {
    socket = null;
    if (!started) return;
    unavailableReason = unavailableReason || 'Autodarts subscription closed';
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimer(reconnectTimer);
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt, 5)),
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => {
        unavailableReason = error?.message || String(error);
      });
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    connect().catch((error) => {
      unavailableReason = error?.message || String(error);
    });
    scheduleBoardPoll();
  }

  function stop() {
    started = false;
    clearTimer(reconnectTimer);
    clearTimer(inactivityTimer);
    clearTimer(restoreTimer);
    clearTimer(finalTimer);
    clearTimer(boardPollTimer);
    boardPollTimer = null;
    if (statsTask?.timer) clearTimer(statsTask.timer);
    statsTask = null;
    try {
      socket?.close?.();
    } catch {
      // ignore
    }
    socket = null;
  }

  /** Test / manual injection of a live state update. */
  function ingestEvent(message) {
    handleWsMessage(message);
  }

  async function forceSeed(matchId) {
    await seedMatch(matchId);
  }

  return {
    start,
    stop,
    statusSnapshot,
    suppressActiveSession,
    ingestEvent,
    forceSeed,
    pushNow: () => {
      if (match?.status === 'live') return pushMatch(true);
      return false;
    },
    getMatch: () => (match ? { ...match } : null),
    normalizeDart,
    matchFromState,
    WS_URL,
    STATS_RETRY_MS,
    // exposed for tests
    _setMatchForTest(value) { match = value; phase = value ? 'live' : 'idle'; },
    _setPhaseForTest(value) { phase = value; },
    _setLastEventAtForTest(value) { lastEventAt = value; },
    _handleInactivityForTest: handleInactivity,
    _beginFinalForTest: beginFinal,
    _archiveKnownForTest: archiveKnown,
    _maybeResumeForTest: maybeResumeAfterInterrupt,
  };
}

module.exports = {
  createAutodartsLive,
  normalizeDart,
  matchFromState,
  settingsLineFrom,
  mapTurn,
  resolveWebSocketImpl,
  STATS_RETRY_MS,
  WS_URL,
  BOARD_POLL_MS,
};
