/**
 * Autodarts live match supervisor — WebSocket + interrupt/resume + inactivity.
 * Unofficial API; fail-soft. Injectable WebSocket + clock for tests.
 */

const {
  buildMatchPayload,
  buildMatchClosePayload,
  isEmptyMatchResult,
} = require('./autodarts-payload');
const { WS_URL: DEFAULT_WS_URL } = require('./autodarts-api');

const WS_URL = DEFAULT_WS_URL || 'wss://play.ws.autodarts.com/ms/v0/subscribe';
const STATS_RETRY_MS = Object.freeze([45_000, 90_000, 180_000, 300_000]);
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const BOARD_POLL_MS = 60_000;

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

function segmentLabel(segment) {
  if (!segment || typeof segment !== 'object') return '';
  const named = String(segment.name || segment.shortName || segment.seg || '').trim();
  if (named) return named;
  const number = Number(segment.number);
  const mult = Number(segment.multiplier);
  if (!Number.isFinite(number)) return '';
  if (number === 25) return mult === 2 ? 'DB' : 'B';
  if (mult === 3) return `T${number}`;
  if (mult === 2) return `D${number}`;
  if (mult === 0 || String(segment.bed || '').toLowerCase() === 'outside') return 'M';
  return `S${number}`;
}

function normalizeDart(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    const seg = String(raw || '').trim();
    return seg ? { seg, x: null, y: null, type: 'normal' } : null;
  }
  const segment = raw.segment && typeof raw.segment === 'object' ? raw.segment : null;
  const seg = String(
    raw.seg || raw.name || raw.shortName || segmentLabel(segment) || raw.segment || '',
  ).trim() || 'M';
  const bed = String(segment?.bed || raw.bed || '').toLowerCase();
  const type = String(raw.type || '').toLowerCase() === 'bouncer'
    || bed.includes('bounc')
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
  const base = settings.baseScore ?? settings.target;
  if (base != null && base !== '') parts.push(String(base));
  const inMode = settings.inMode || settings.in;
  const outMode = settings.outMode || settings.out;
  if (inMode || outMode) {
    parts.push([inMode, outMode].filter(Boolean).join('-'));
  }
  const legs = settings.legs || settings.bestOf || meta.legs;
  if (legs != null && typeof legs !== 'object') parts.push(`First to ${legs} legs`);
  return parts.join(' · ') || String(meta.variant || 'Match');
}

function winnerNameFrom(state = {}, players = []) {
  const raw = state.winner;
  if (raw == null || raw === '' || Number(raw) === -1) return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const index = Number(raw);
    return players[index]?.name || null;
  }
  return String(raw);
}

function mapPlayers(state = {}, meta = {}) {
  const roster = state.players || meta.players || [];
  const gameScores = state.gameScores || meta.gameScores || [];
  const scoreRows = state.scores || meta.scores || [];
  const winnerIndex = Number.isInteger(Number(state.winner)) && Number(state.winner) >= 0
    ? Number(state.winner)
    : null;
  return roster.map((row, index) => {
    const name = row.name || row.playerName || row.player?.name || `Player ${index + 1}`;
    const scoreRow = scoreRows[index] || {};
    const score = row.score ?? row.remaining ?? row.points ?? row.lives
      ?? gameScores[index]
      ?? scoreRow.score
      ?? 0;
    return {
      name,
      score: Number(score) || 0,
      legs: Number(row.legs ?? row.legsWon ?? scoreRow.legs ?? 0) || 0,
      sets: Number(row.sets ?? row.setsWon ?? scoreRow.sets ?? 0) || 0,
      average: row.average != null ? Number(row.average) : (
        scoreRow.average != null ? Number(scoreRow.average) : null
      ),
      lastTurnPoints: row.lastTurnPoints != null ? Number(row.lastTurnPoints) : null,
      isWinner: Boolean(row.isWinner || row.winner || winnerIndex === index),
      userId: row.userId || row.playerId || row.player?.id || null,
      checkoutPct: row.checkoutPct ?? null,
    };
  });
}

function mapTurn(raw = {}) {
  const throws = Array.isArray(raw.throws) ? raw.throws
    : (Array.isArray(raw.darts) ? raw.darts : []);
  const darts = throws.length ? throws.map(normalizeDart) : [null, null, null];
  while (darts.length < 3) darts.push(null);
  return {
    points: Number(raw.points ?? raw.score ?? 0) || 0,
    busted: Boolean(raw.busted || raw.bust),
    darts: darts.slice(0, 3),
  };
}

function turnFromState(state = {}) {
  if (Array.isArray(state.turns) && state.turns.length) return mapTurn(state.turns[0] || {});
  if (state.turn && typeof state.turn === 'object') return mapTurn(state.turn);
  if (Array.isArray(state.throws)) return mapTurn({ throws: state.throws, points: state.points });
  return mapTurn({});
}

function matchIsFinished(state = {}) {
  if (state.finished === true || state.status === 'finished') return true;
  const winner = state.winner;
  if (winner == null || winner === '' || Number(winner) === -1) return false;
  return true;
}

function eventToken(message = {}, data = {}) {
  return String(
    data.event || message.event || data.name || message.name || message.type || '',
  ).toLowerCase().trim();
}

function isAbortEvent(event = '') {
  const e = String(event || '').toLowerCase();
  return e === 'delete'
    || e === 'abort'
    || e === 'aborted'
    || e === 'surrender'
    || e === 'cancel'
    || e === 'cancelled'
    || e === 'canceled'
    || e.includes('surrender')
    || e.includes('abort')
    || (e.includes('cancel') && !e.includes('calibration'));
}

function isMatchFinishEvent(event = '', state = {}) {
  if (isAbortEvent(event)) return false;
  const e = String(event || '').toLowerCase();
  if (e === 'finish' || e === 'match.finished' || e.includes('gameshot')) return true;
  return matchIsFinished(state);
}

function matchFromState(matchId, state = {}, meta = {}, revision = 0) {
  const mergedSettings = {
    ...(meta.settings || {}),
    ...(state.settings || {}),
  };
  const players = mapPlayers(state, meta);
  const playerRaw = state.player ?? state.currentPlayerIndex ?? state.throwingPlayer ?? 0;
  const currentPlayerIndex = Number.isFinite(Number(playerRaw)) ? Number(playerRaw) : 0;
  const startedAt = meta.startedAt || meta.createdAt || state.startedAt || state.createdAt || null;
  let durationSec = Number(state.durationSec ?? state.duration ?? meta.durationSec ?? 0) || 0;
  if (!durationSec && startedAt) {
    const startedMs = Date.parse(startedAt);
    if (Number.isFinite(startedMs)) {
      durationSec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    }
  }
  const winner = winnerNameFrom(state, players) || meta.winner || null;
  return {
    matchId: String(matchId),
    revision,
    status: matchIsFinished(state) ? 'finished' : 'live',
    variant: meta.variant || state.variant || 'X01',
    settingsLine: settingsLineFrom({
      ...meta,
      ...state,
      settings: mergedSettings,
      settingsLine: meta.settingsLine || state.settingsLine,
    }),
    settings: Object.keys(mergedSettings).length ? mergedSettings : null,
    startedAt,
    durationSec,
    currentPlayerIndex,
    turn: turnFromState(state),
    prevTurn: state.prevTurn ? {
      playerIndex: Number(state.prevTurn.playerIndex) || 0,
      points: Number(state.prevTurn.points) || 0,
      darts: (state.prevTurn.darts || state.prevTurn.throws || []).map(normalizeDart),
    } : null,
    players,
    gameShot: state.gameShot || meta.gameShot || null,
    hitMap: state.hitMap || meta.hitMap || null,
    local: meta.local !== false,
    winner,
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
  rateLimit = null,
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
  // `match` is cleared once the FINAL card stops airing, but the stats fetch can still
  // be retrying minutes later (STATS_RETRY_MS runs well past finalHoldSeconds). Hold the
  // finished match here so the archive row keeps its roster, winner and variant.
  let finishedSnapshot = null;
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

  function refreshDuration() {
    if (!match?.startedAt) return;
    const startedMs = Date.parse(match.startedAt);
    if (!Number.isFinite(startedMs)) return;
    match.durationSec = Math.max(0, Math.floor((now() - startedMs) / 1000));
  }

  function pushMatch(force = false) {
    if (!match || !sendUdpPayload) return false;
    if (!settings.get().live.autoPush && match.status === 'live' && !force) {
      return false;
    }
    if (suppressed && match.status === 'live') return false;
    refreshDuration();
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
      // Autodarts sometimes emits "finished" for deleted/aborted shells (0–0, no winner).
      // Treat those like an abort — close immediately and do not air a hollow FINAL card.
      if (isEmptyMatchResult(next)) {
        beginAbort('empty-finish');
        return;
      }
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
      refreshDuration();
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
    finishedSnapshot = match;
    scheduleArchive(match?.matchId);
  }

  /** Abort / delete / surrender — close the wall immediately; keep a light archive row. */
  function beginAbort(reason = 'aborted') {
    if (!match || phase === 'idle') return;
    clearTimer(inactivityTimer);
    clearTimer(restoreTimer);
    clearTimer(finalTimer);
    finalTimer = null;
    suppressed = false;
    const matchId = match.matchId;
    // Autodarts tears the match object down moments after a game ends, so a delete
    // arriving during the FINAL hold is cleanup rather than an abandoned game. Filing
    // it as an abort would drop a completed match out of every dashboard stat, and the
    // abort row would block the real one because the archive dedupes on match id.
    const finished = phase === 'final';
    refreshDuration();
    if (finished) {
      log?.info?.('Autodarts match closed after finishing', { matchId, reason });
    } else {
      log?.info?.('Autodarts match aborted — closing display', { matchId, reason });
      archiveAbort(matchId, reason);
    }
    pushClose(reason);
    phase = 'idle';
    match = null;
    dormantMatchId = null;
    lastPushedJson = null;
  }

  function archiveAbort(matchId, reason) {
    if (!matchId || archive.has(matchId)) return;
    archive.append({
      matchId,
      aborted: true,
      abortReason: reason,
      variant: match?.variant || 'X01',
      settings: match?.settings || null,
      local: match?.local !== false,
      startedAt: match?.startedAt || null,
      finishedAt: new Date(now()).toISOString(),
      durationSec: match?.durationSec || 0,
      players: (match?.players || []).map((row) => ({
        name: row.name,
        userId: row.userId || null,
        legsWon: row.legs,
        setsWon: row.sets,
        average: row.average,
      })),
      winner: null,
      source: 'live-abort',
      revision: match?.revision || 0,
    });
    // A race ended early still counts once a leg was decided, so rebuild rather than
    // leave the wall on a stale day. Shells with no completed leg change nothing.
    aggregates.recompute(archive.listAll());
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

  /** The live match if it is still the one we are archiving, else the finished snapshot. */
  function archiveSource(matchId) {
    const id = String(matchId);
    if (match && String(match.matchId) === id) return match;
    if (finishedSnapshot && String(finishedSnapshot.matchId) === id) return finishedSnapshot;
    return null;
  }

  function archiveKnown(matchId, statsJson) {
    if (archive.has(matchId)) return;
    const source = archiveSource(matchId);
    if (!source) {
      // With no roster left to describe it, an archive row would count as a played match
      // while contributing no players. Leave it for the cloud history sync to import.
      log?.warn?.('Autodarts archive skipped — no match snapshot', matchId);
      return;
    }
    const statsPlayers = statsJson?.players || statsJson?.stats || [];
    const players = (source.players || []).map((row, index) => {
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
    const winner = source.winner
      || players.find((row) => row.isWinner)?.name
      || (source.players || []).find((row) => row.isWinner)?.name
      || null;
    archive.append({
      matchId,
      variant: source.variant || 'X01',
      settings: source.settings || null,
      local: source.local !== false,
      startedAt: source.startedAt || null,
      finishedAt: new Date(now()).toISOString(),
      durationSec: source.durationSec || 0,
      players,
      winner,
      gameShot: source.gameShot || null,
      hitMap: source.hitMap || statsJson?.hitMap || null,
      source: 'live',
      revision: source.revision || 0,
    });
    if (finishedSnapshot && String(finishedSnapshot.matchId) === String(matchId)) {
      finishedSnapshot = null;
    }
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

  function wsConnected() {
    return Boolean(socket && socket.readyState === 1);
  }

  async function pollBoardForMatch() {
    if (!started) return;
    if (wsConnected()) return;
    if (rateLimit?.isPaused?.()) return;
    const boardId = credentials.load()?.boardId;
    if (!boardId || !api?.getBoardState) return;
    // WS is primary; polling only fills gaps when the socket is down.
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
    boardPollTimer = null;
    if (!started || wsConnected()) return;
    boardPollTimer = setInterval(() => {
      if (wsConnected()) {
        clearTimer(boardPollTimer);
        boardPollTimer = null;
        return;
      }
      pollBoardForMatch().catch(() => {});
    }, BOARD_POLL_MS);
    if (typeof boardPollTimer.unref === 'function') boardPollTimer.unref();
    pollBoardForMatch().catch(() => {});
  }

  function stopBoardPoll() {
    clearTimer(boardPollTimer);
    boardPollTimer = null;
  }

  function handleWsMessage(raw) {
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    const channel = String(message.channel || message.topic || '');
    const data = (message.data && typeof message.data === 'object')
      ? message.data
      : (message.payload && typeof message.payload === 'object' ? message.payload : message);
    const event = eventToken(message, data);
    const topic = String(message.topic || '');

    // Board channel: match start / board online; abort when board reports delete.
    if (/boards/i.test(channel) || /boards/i.test(topic)) {
      const online = data.online ?? data.connected ?? data.status === 'online';
      if (online != null) boardOnline = Boolean(online);

      if (isAbortEvent(event)) {
        const abortId = extractMatchId(data) || extractMatchId(message) || match?.matchId;
        if (abortId && match && String(match.matchId) === String(abortId)) {
          beginAbort(event || 'board-delete');
        }
        return;
      }

      if (event === 'start' || event === 'match' || event.includes('match')) {
        const matchId = extractMatchId(data) || extractMatchId(message);
        if (matchId && (!match || match.matchId !== String(matchId) || match.status !== 'live')) {
          seedMatch(String(matchId)).catch((error) => {
            log?.warn?.('Autodarts seed failed', error?.message || error);
          });
        }
        return;
      }

      const matchId = extractMatchId(data) || extractMatchId(message);
      if (matchId && (!match || match.matchId !== String(matchId))) {
        seedMatch(String(matchId)).catch((error) => {
          log?.warn?.('Autodarts seed failed', error?.message || error);
        });
      }
      return;
    }

    const matchId = extractMatchId(data) || extractMatchId(message) || match?.matchId;
    if (!matchId) return;
    if (match && match.matchId && String(match.matchId) !== String(matchId)) {
      // Stale event for a previous match.
      if (!isAbortEvent(event) && !isMatchFinishEvent(event, data)) return;
    }

    if (isAbortEvent(event)) {
      if (!match || String(match.matchId) === String(matchId)) {
        if (!match) {
          // Seed enough identity to close any lingering card.
          match = { matchId: String(matchId), status: 'live', players: [], revision: 0 };
        }
        beginAbort(event || 'aborted');
      }
      return;
    }

    if (isMatchFinishEvent(event, data)) {
      const next = matchFromState(
        matchId,
        { ...data, finished: true, gameShot: data.gameShot || data.segment },
        { ...(match || {}), variant: data.variant || match?.variant, settings: data.settings || match?.settings },
        (Number(match?.revision) || 0) + 1,
      );
      if (data.gameShot || data.segment) {
        next.gameShot = String(data.gameShot || data.segment);
      }
      applyMatch(next);
      return;
    }

    // Live state / throws — Autodarts sends the full match object on *.state.
    if (data.players || data.gameScores || data.turns || data.turn || data.throws
      || data.scores || event.includes('throw') || event.includes('state')
      || event.includes('turn') || event === '' || topic.endsWith('.state')) {
      const revision = Number(
        data.revision
        ?? data.version
        ?? ((Number(match?.revision) || 0) + 1),
      );
      const next = matchFromState(
        matchId,
        data,
        {
          ...(match || {}),
          variant: data.variant || match?.variant,
          settings: data.settings || match?.settings,
          players: data.players || match?.players,
          startedAt: data.createdAt || data.startedAt || match?.startedAt,
        },
        revision,
      );
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
    stopBoardPoll();
    const boardId = credentials.load().boardId;
    if (boardId) subscribeBoard(boardId);
    if (match?.matchId && match.status === 'live') subscribeMatch(match.matchId);
    log?.info?.('Autodarts live WebSocket connected', { url: WS_URL });
  }

  function onClose() {
    socket = null;
    if (!started) return;
    unavailableReason = unavailableReason || 'Autodarts subscription closed';
    scheduleBoardPoll();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimer(reconnectTimer);
    if (rateLimit?.isPaused?.()) {
      const waitMs = Math.max(5_000, (rateLimit.snapshot()?.pausedUntil
        ? Date.parse(rateLimit.snapshot().pausedUntil) - now()
        : RECONNECT_MAX_MS));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        scheduleReconnect();
      }, Math.min(RECONNECT_MAX_MS, waitMs));
      if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
      return;
    }
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
    finishedSnapshot = null;
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
  mapPlayers,
  mapTurn,
  settingsLineFrom,
  isAbortEvent,
  isMatchFinishEvent,
  resolveWebSocketImpl,
  STATS_RETRY_MS,
  WS_URL,
  BOARD_POLL_MS,
};
