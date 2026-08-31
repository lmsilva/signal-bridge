/**
 * Live game sessions — codes, the phase machine, SSE, and a 1s tick.
 *
 * Active sessions live in memory. A container restart closes them. Archived
 * on a clean finish and on abandon. Late joiners sit out the current round.
 */

const crypto = require('crypto');
const { gameOf: defaultGameOf } = require('./registry');
const { createGameSettings } = require('./settings');
const { createGameArchive } = require('./archive');
const { hardestWord, scoreWord } = require('../word-scramble');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const SUBMIT_CAP = 80;
const COOKIE = 'signal_games';

function mintCode(random, taken) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      const index = Math.min(
        CODE_ALPHABET.length - 1,
        Math.floor((typeof random === 'function' ? random() : Math.random()) * CODE_ALPHABET.length),
      );
      code += CODE_ALPHABET[index];
    }
    if (!taken.has(code)) return code;
  }
  throw new Error('Could not mint a unique game code');
}

function firstName(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z]/g, ' ').trim().split(/\s+/)[0] || '';
  // One casing for everyone, so "daddy" and "Daddy" read as the same person
  // on a scoreboard that sits next to "Luis".
  const trimmed = cleaned.slice(0, 10);
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase() : '';
}

/**
 * Two people called Daddy is a real living-room case, and a scoreboard with
 * the same name twice is unreadable. The second one becomes "Daddy (2)".
 */
function uniqueName(players = [], display = '') {
  const taken = new Set(players.map((p) => String(p.name || '').toLowerCase()));
  if (!taken.has(display.toLowerCase())) return display;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${display} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return display;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function createGameSessions(config = {}, log = console, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const setTimer = deps.setTimer || setInterval;
  const clearTimer = deps.clearTimer || clearInterval;
  const settingsApi = deps.gameSettings || createGameSettings(config, log);
  const archive = deps.archive || createGameArchive(config, log);
  const pushBoard = typeof deps.pushBoard === 'function' ? deps.pushBoard : () => {};
  const dropPendingBoard = typeof deps.dropPendingBoard === 'function'
    ? deps.dropPendingBoard
    : () => 0;
  const setGameLock = typeof deps.setGameLock === 'function' ? deps.setGameLock : () => {};
  const getShortlink = typeof deps.getShortlink === 'function' ? deps.getShortlink : () => null;
  const gameOf = typeof deps.gameOf === 'function' ? deps.gameOf : defaultGameOf;

  const sessions = new Map();
  const byCode = new Map();
  const listeners = new Map();
  let timer = null;

  function settingsOf(gameType) {
    return settingsApi.get(gameType);
  }

  function remainingSeconds(session, at = now()) {
    if (!session.phaseEndsAt) return 0;
    return Math.max(0, Math.ceil((session.phaseEndsAt - at) / 1000));
  }

  function aliasOf(session) {
    const link = getShortlink?.('games');
    return link?.alias || settingsOf(session.gameType).preferredAlias || 'WITTYGAME';
  }

  function publicPlayer(player) {
    return {
      id: player.id,
      name: player.name,
      seated: player.seated !== false,
      score: player.score || 0,
    };
  }

  /**
   * What the open round has earned each player so far. Submitted words were
   * already checked against the board, so this only has to apply the
   * duplicate rule — no need to re-solve the grid on every keystroke.
   */
  function pendingScores(session) {
    const out = new Map();
    const current = session.rounds[session.rounds.length - 1];
    if (session.phase !== 'round' || !current) return out;
    const claims = new Map();
    for (const [id, words] of current.wordsByPlayer) {
      for (const word of words) {
        const list = claims.get(word) || [];
        list.push(id);
        claims.set(word, list);
      }
    }
    const { duplicateRule } = settingsOf(session.gameType);
    for (const [word, ids] of claims) {
      const points = duplicateRule === 'cancel' && ids.length > 1 ? 0 : scoreWord(word);
      for (const id of ids) out.set(id, (out.get(id) || 0) + points);
    }
    return out;
  }

  /**
   * Everyone who has joined, banked score plus the open round, best first.
   * Built fresh on every read so a phone sees its points the moment they land
   * rather than waiting for the round to close.
   */
  function standings(session) {
    const pending = pendingScores(session);
    return session.players
      .map((player) => ({
        id: player.id,
        name: player.name,
        score: (player.score || 0) + (pending.get(player.id) || 0),
        seated: player.seated !== false,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  /** What one player has found this round — never another player's list. */
  function playerWords(session, playerId) {
    const current = session.rounds[session.rounds.length - 1];
    if (!current || !playerId) return [];
    return (current.wordsByPlayer.get(playerId) || [])
      .map((word) => ({ word, points: scoreWord(word) }));
  }

  function publicSession(session, at = now(), playerId = '') {
    const game = gameOf(session.gameType);
    const settings = settingsOf(session.gameType);
    const current = session.rounds[session.rounds.length - 1] || null;
    const player = playerId ? session.players.find((p) => p.id === playerId) : null;
    const revealing = session.phase === 'intermission' || session.phase === 'final';
    return {
      sessionId: session.id,
      gameType: session.gameType,
      title: game?.title || 'Game',
      code: session.code,
      phase: session.phase,
      roundIndex: session.roundIndex,
      rounds: settings.rounds,
      allowLateJoin: settings.allowLateJoin !== false,
      remainingSeconds: remainingSeconds(session, at),
      playerCount: session.players.length,
      players: session.players.map(publicPlayer),
      scores: standings(session),
      best: session.best || null,
      grid: session.phase === 'round' ? current?.grid || null : null,
      lastRound: revealing ? session.lastRound || null : null,
      you: player
        ? { ...publicPlayer(player), words: playerWords(session, playerId) }
        : null,
      alias: aliasOf(session),
    };
  }

  function emit(session, reason = 'update') {
    const set = listeners.get(session.id);
    if (!set) return;
    const at = now();
    const lines = new Map();
    for (const [res, playerId] of set) {
      if (!lines.has(playerId)) {
        lines.set(playerId, `event: session\ndata: ${JSON.stringify({
          reason,
          session: publicSession(session, at, playerId),
        })}\n\n`);
      }
      try {
        res.write(lines.get(playerId));
      } catch {
        set.delete(res);
      }
    }
    session.sseCount = set.size;
    if (set.size) session.lastSseAt = now();
  }

  function boardOptions(holdSeconds, { takeover = false, card = '' } = {}) {
    return {
      targetId: 'vestaboard',
      explicit: true,
      // Only the first invite should wrest the board from whatever was showing.
      // Later cards stay in front of held non-game pages. `replaceCard` drops
      // only stale phases at or below this one, so an unshown score card is
      // not evicted when the next round starts.
      breakHold: Boolean(takeover),
      quietHoursExempt: true,
      replaceSource: 'word.scramble',
      gameSource: 'word.scramble',
      replaceCard: card || null,
      holdSeconds,
    };
  }

  /**
   * Drop the tail of a multi-page run another feature was airing — riddles,
   * stocks, and the like — but leave single-page scheduler items waiting.
   * They stay parked behind the game lock until the session closes.
   *
   * Vestaboard games register their `source` in `games/registry.js`. While a
   * session holds the board, manual Push / Air now / scheduler ticks must not
   * interrupt — the board lock taken in `pushPhase` enforces that.
   */
  function takeBoard() {
    try {
      dropPendingBoard((frame, item) => item?.priority !== 'alert'
        && String(frame?.source || '') !== 'word.scramble'
        && Boolean(item?.sequenceId));
    } catch (error) {
      log?.warn?.('Could not clear the board queue', error?.message || error);
    }
  }

  function pushPhase(session, card, extra = {}) {
    const game = gameOf(session.gameType);
    const settings = settingsOf(session.gameType);
    const hold = extra.holdSeconds != null ? extra.holdSeconds : remainingSeconds(session);
    const source = game?.source || 'word.scramble';
    // Take (or renew) the board lock before the card is queued, so the gap
    // between two phases never opens the line to everything parked behind us.
    try {
      setGameLock(source, true);
    } catch (error) {
      log?.warn?.('Could not lock the board for the game', error?.message || error);
    }
    takeBoard();
    const payload = {
      type: 'word.scramble',
      source: game?.source || 'word.scramble',
      phase: session.phase,
      card,
      code: session.code,
      showCode: extra.showCode != null
        ? Boolean(extra.showCode)
        : settings.allowLateJoin !== false,
      roundIndex: session.roundIndex,
      rounds: settings.rounds,
      final: extra.final != null
        ? Boolean(extra.final)
        : session.phase === 'final' || card === 'final',
      alias: aliasOf(session),
      playerCount: session.players.length,
      grid: extra.grid || session.rounds[session.rounds.length - 1]?.grid || [],
      scores: extra.scores || standings(session),
      roundWinner: extra.roundWinner || null,
      roundScores: extra.roundScores || null,
      word: session.best?.word || '',
      name: session.best?.name || '',
      points: session.best?.points || 0,
      holdSeconds: hold,
      remainingSeconds: hold,
    };
    const takeover = extra.takeover != null
      ? Boolean(extra.takeover)
      : card === 'invite' || session.phase === 'invited';
    try {
      pushBoard(payload, boardOptions(hold, { takeover, card }));
    } catch (error) {
      log?.warn?.('Game board push failed', error?.message || error);
    }
  }

  function archiveRow(session, { abandoned = false, reason = '' } = {}) {
    archive.append({
      sessionId: session.id,
      gameType: session.gameType,
      code: session.code,
      startedAt: iso(session.createdAt),
      endedAt: iso(now()),
      players: session.players.map((p) => ({ id: p.id, name: p.name, score: p.score || 0 })),
      rounds: session.rounds.length,
      winner: session.scores?.[0] || null,
      topWord: session.best || null,
      abandoned,
      reason,
    });
  }

  function closeSession(session, reason = 'closed') {
    if (session.phase === 'closed') return;
    const abandoned = reason !== 'finished';
    const alreadyFinal = session.phase === 'final';
    const scores = session.scores?.length ? session.scores : standings(session);
    session.phase = 'closed';
    session.phaseEndsAt = null;
    // Scores stay up for every ending — finished, admin stop, idle, or the
    // last player leaving. A blank clear used to wipe a game nobody can
    // join; the house still wants to see how it finished. Skip a second
    // flip when the final card is already on the board.
    if (!alreadyFinal) {
      const settings = settingsOf(session.gameType);
      pushPhase(session, 'final', {
        scores,
        holdSeconds: settings.intermissionSeconds,
        takeover: true,
        final: true,
        showCode: false,
      });
    }
    // Only now may the pages parked behind the game have the board. This is
    // the one release point, so it has to cover every way a session ends:
    // finished, stopped by an admin, invite expired, idle, or last player out.
    try {
      setGameLock(gameOf(session.gameType)?.source || 'word.scramble', false);
    } catch (error) {
      log?.warn?.('Could not release the board lock', error?.message || error);
    }
    archiveRow(session, { abandoned, reason });
    emit(session, 'closed');
    const set = listeners.get(session.id);
    if (set) {
      for (const res of set.keys()) {
        try { res.end(); } catch { /* gone */ }
      }
      listeners.delete(session.id);
    }
    sessions.delete(session.id);
    byCode.delete(session.code);
  }

  function seatWaiting(session) {
    for (const player of session.players) {
      player.seated = true;
    }
  }

  function startLobby(session) {
    const settings = settingsOf(session.gameType);
    session.phase = 'lobby';
    session.phaseEndsAt = now() + settings.lobbySeconds * 1000;
    seatWaiting(session);
    pushPhase(session, 'lobby');
    emit(session, 'lobby');
  }

  function startRound(session) {
    const game = gameOf(session.gameType);
    const settings = settingsOf(session.gameType);
    session.roundIndex += 1;
    const round = game.createRound({
      minSolutions: settings.minSolutions,
      random,
    });
    session.rounds.push({
      grid: round.grid,
      solutions: round.solutions,
      wordsByPlayer: new Map(),
    });
    session.phase = 'round';
    session.phaseEndsAt = now() + settings.roundSeconds * 1000;
    for (const player of session.players) {
      if (player.seated === false) continue;
      session.rounds[session.rounds.length - 1].wordsByPlayer.set(player.id, []);
    }
    pushPhase(session, 'round', {
      grid: round.grid,
      holdSeconds: settings.roundSeconds,
    });
    emit(session, 'round');
  }

  function finishRound(session) {
    const game = gameOf(session.gameType);
    const settings = settingsOf(session.gameType);
    const current = session.rounds[session.rounds.length - 1];
    const seated = session.players.filter((p) => current.wordsByPlayer.has(p.id));
    const scored = game.scoreRound(
      seated.map((p) => ({
        id: p.id,
        words: current.wordsByPlayer.get(p.id) || [],
      })),
      { duplicateRule: settings.duplicateRule, grid: current.grid },
    );
    const byId = new Map(scored.map((row) => [row.id, row]));
    for (const player of session.players) {
      player.score = (player.score || 0) + (byId.get(player.id)?.score || 0);
    }
    session.scores = session.players
      .map((p) => ({ id: p.id, name: p.name, score: p.score || 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const found = [];
    for (const [playerId, words] of current.wordsByPlayer) {
      const player = session.players.find((p) => p.id === playerId);
      for (const word of words) {
        found.push({ word, playerId, name: player?.name || '' });
      }
    }

    // The reveal between rounds: every word the table found, and who got it.
    const byWord = new Map();
    for (const row of found) {
      const entry = byWord.get(row.word)
        || { word: row.word, points: scoreWord(row.word), names: [] };
      if (row.name && !entry.names.includes(row.name)) entry.names.push(row.name);
      byWord.set(row.word, entry);
    }
    session.lastRound = {
      index: session.roundIndex,
      words: [...byWord.values()]
        .sort((a, b) => b.points - a.points || a.word.localeCompare(b.word)),
    };

    const hardest = hardestWord(found);
    if (hardest && (!session.best || hardest.word.length > session.best.word.length)) {
      session.best = {
        word: hardest.word,
        playerId: hardest.playerId,
        name: found.find((f) => f.word === hardest.word)?.name || '',
        points: hardest.points,
      };
    }

    const roundOnly = seated
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: byId.get(p.id)?.score || 0,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const roundWinner = roundOnly[0] || null;

    const more = session.roundIndex < settings.rounds;
    if (more) {
      session.phase = 'intermission';
      session.phaseEndsAt = now() + settings.intermissionSeconds * 1000;
      seatWaiting(session);
      pushPhase(session, 'intermission', {
        roundWinner,
        roundScores: roundOnly,
        scores: session.scores,
        holdSeconds: settings.intermissionSeconds,
      });
      emit(session, 'intermission');
      return;
    }
    session.phase = 'final';
    const cards = session.best ? 2 : 1;
    session.phaseEndsAt = now() + settings.intermissionSeconds * 1000 * cards;
    pushPhase(session, 'final', {
      scores: session.scores,
      holdSeconds: settings.intermissionSeconds,
    });
    emit(session, 'final');
  }

  function advance(session) {
    if (session.phase === 'lobby') {
      startRound(session);
      return;
    }
    if (session.phase === 'round') {
      finishRound(session);
      return;
    }
    if (session.phase === 'intermission') {
      startRound(session);
      return;
    }
    if (session.phase === 'final') {
      closeSession(session, 'finished');
    }
  }

  function create({ gameType = 'scramble' } = {}) {
    const game = gameOf(gameType);
    if (!game) {
      throw new Error(`Unknown game: ${gameType}`);
    }
    const settings = settingsOf(gameType);
    const code = mintCode(random, byCode);
    const session = {
      id: crypto.randomUUID(),
      gameType,
      code,
      phase: 'invited',
      createdAt: now(),
      inviteExpiresAt: now() + settings.inviteTtlMinutes * 60 * 1000,
      phaseEndsAt: null,
      players: [],
      rounds: [],
      roundIndex: 0,
      scores: [],
      best: null,
      lastRound: null,
      sseCount: 0,
      lastSseAt: now(),
      hadPlayer: false,
    };
    sessions.set(session.id, session);
    byCode.set(code, session.id);
    pushPhase(session, 'invite', { holdSeconds: settings.inviteTtlMinutes * 60, takeover: true });
    return publicSession(session);
  }

  function getByCode(code) {
    const id = byCode.get(String(code || '').trim().toUpperCase());
    return id ? sessions.get(id) : null;
  }

  function getById(id) {
    return sessions.get(String(id || '')) || null;
  }

  function join({ code, name, playerId = '' } = {}) {
    const session = getByCode(code);
    if (!session || session.phase === 'closed') {
      return { ok: false, error: 'No game uses that code' };
    }
    const settings = settingsOf(session.gameType);
    let player = playerId
      ? session.players.find((p) => p.id === playerId)
      : null;
    if (!player) {
      const started = session.phase !== 'invited' && session.phase !== 'lobby';
      if (started && settings.allowLateJoin === false) {
        return { ok: false, error: 'That game already started' };
      }
      if (session.players.length >= settings.maxPlayers) {
        return { ok: false, error: 'That game is full' };
      }
      const display = firstName(name);
      if (!display) {
        return { ok: false, error: 'First name is required' };
      }
      player = {
        id: crypto.randomUUID(),
        name: uniqueName(session.players, display),
        seated: session.phase !== 'round',
        score: 0,
      };
      session.players.push(player);
      session.hadPlayer = true;
    }
    if (session.phase === 'invited') {
      startLobby(session);
    } else {
      emit(session, 'join');
      if (session.phase === 'lobby') {
        pushPhase(session, 'lobby');
      }
    }
    return {
      ok: true,
      player,
      session: publicSession(session, now(), player.id),
      cookie: `${session.id}|${player.id}`,
    };
  }

  function submit({ sessionId, playerId, action = 'word', payload = {} } = {}) {
    const session = getById(sessionId);
    if (!session || session.phase !== 'round') {
      return { ok: false, error: 'No round is open' };
    }
    const current = session.rounds[session.rounds.length - 1];
    if (!current.wordsByPlayer.has(playerId)) {
      return { ok: false, error: 'You are seated for the next round' };
    }
    const words = current.wordsByPlayer.get(playerId);
    if (words.length >= SUBMIT_CAP) {
      return { ok: false, error: 'Round word limit reached' };
    }
    const game = gameOf(session.gameType);
    const result = game.validateAction(current, action, payload);
    if (!result.ok) {
      return { ok: false, error: result.reason === 'not-on-board' ? 'Not on the board' : 'Not a word' };
    }
    if (words.includes(result.word)) {
      return { ok: false, error: 'Already found', duplicate: true };
    }
    words.push(result.word);
    const player = session.players.find((p) => p.id === playerId);
    const live = (player.score || 0) + words.reduce((sum, word) => sum + scoreWord(word), 0);
    emit(session, 'word');
    return {
      ok: true,
      word: result.word,
      points: result.points,
      liveScore: live,
      words: playerWords(session, playerId),
      scores: standings(session),
    };
  }

  function leave({ sessionId, playerId } = {}) {
    const session = getById(sessionId);
    if (!session) return { ok: true };
    const remaining = session.players.filter((p) => p.id !== playerId);
    if (!remaining.length) {
      // Snapshot while the last player is still seated so FINAL SCORES
      // still has their name and the points they had when they left.
      session.scores = standings(session);
      session.players = remaining;
      closeSession(session, 'empty');
      return { ok: true };
    }
    session.players = remaining;
    emit(session, 'leave');
    return { ok: true };
  }

  function subscribe(sessionId, res, playerId = '') {
    const session = getById(sessionId);
    if (!session) return () => {};
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Map());
    const set = listeners.get(sessionId);
    set.set(res, String(playerId || ''));
    session.sseCount = set.size;
    session.lastSseAt = now();
    return () => {
      set.delete(res);
      session.sseCount = set.size;
      if (set.size) session.lastSseAt = now();
    };
  }

  function tick(at = now()) {
    for (const session of [...sessions.values()]) {
      if (session.phase === 'invited' && at >= session.inviteExpiresAt) {
        closeSession(session, 'invite-expired');
        continue;
      }
      const idle = settingsOf(session.gameType).idleTimeoutSeconds * 1000;
      if (session.hadPlayer && session.sseCount === 0 && at - session.lastSseAt >= idle) {
        closeSession(session, 'idle');
        continue;
      }
      if (session.phaseEndsAt && at >= session.phaseEndsAt) {
        advance(session);
      }
    }
  }

  function listActive() {
    return [...sessions.values()].map((session) => ({
      ...publicSession(session),
      elapsedSeconds: Math.max(0, Math.round((now() - session.createdAt) / 1000)),
    }));
  }

  function end(sessionId) {
    const session = getById(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };
    closeSession(session, 'ended');
    return { ok: true };
  }

  function start() {
    if (timer || process.env.NODE_TEST_CONTEXT) return;
    timer = setTimer(() => {
      try { tick(); } catch (error) {
        log?.warn?.('Game session tick failed', error?.message || error);
      }
    }, 1000);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  start();

  return {
    create,
    join,
    submit,
    leave,
    getByCode,
    getById,
    publicSession: (session, playerId = '') => publicSession(session, now(), playerId),
    subscribe,
    tick,
    listActive,
    end,
    history: (query) => archive.listPage(query),
    forget: (sessionIds) => archive.remove(sessionIds),
    start,
    stop,
    COOKIE,
    CODE_ALPHABET,
  };
}

function parseCookie(header) {
  const raw = String(header || '');
  const match = raw.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return { sessionId: '', playerId: '' };
  const value = decodeURIComponent(match.slice(COOKIE.length + 1));
  const [sessionId, playerId] = value.split('|');
  return { sessionId: sessionId || '', playerId: playerId || '' };
}

function cookieHeader(value) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

module.exports = {
  COOKIE,
  CODE_ALPHABET,
  createGameSessions,
  parseCookie,
  cookieHeader,
  firstName,
  uniqueName,
};
