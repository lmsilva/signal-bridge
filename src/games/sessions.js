/**
 * Live game sessions — codes, the phase machine, SSE, and a 1s tick.
 *
 * This file is the shell. It knows about codes, seats, phases, the board lock
 * and the archive; it knows nothing about grids, prompts, or scoring. Each
 * game supplies that through a mode in `games/modes/` (see `games/registry.js`
 * for the contract), so a new game is a new mode rather than a new branch here.
 *
 * Phases run `invited -> lobby -> round [-> voting] -> intermission -> ... ->
 * final -> closed`. The voting half only exists for modes that ask for it.
 *
 * Active sessions live in memory. A container restart closes them. Archived
 * on a clean finish and on abandon. Late joiners sit out the current round.
 */

const crypto = require('crypto');
const { gameOf: defaultGameOf } = require('./registry');
const { createGameSettings } = require('./settings');
const { createGameArchive } = require('./archive');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
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

  function modeOf(session) {
    return gameOf(session.gameType);
  }

  function sourceOf(session) {
    return modeOf(session)?.source || 'word.scramble';
  }

  function stateOf(session) {
    return session.rounds[session.rounds.length - 1] || null;
  }

  function minPlayersOf(session) {
    const settings = settingsOf(session.gameType);
    const floor = Number(settings.minPlayers);
    if (Number.isFinite(floor) && floor > 0) return floor;
    return Math.max(1, Number(modeOf(session)?.minPlayers) || 1);
  }

  function remainingSeconds(session, at = now()) {
    if (!session.phaseEndsAt) {
      // Invite is waiting to flip. Show the lobby window phones will get
      // once it lands, not a zero that looks like the game already died.
      if (session.phase === 'invited') {
        return settingsOf(session.gameType).lobbySeconds;
      }
      return 0;
    }
    return Math.max(0, Math.ceil((session.phaseEndsAt - at) / 1000));
  }

  function aliasOf() {
    const link = getShortlink?.('games');
    return link?.alias || settingsApi.alias?.() || 'WITTYGAME';
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
   * Everyone who has joined, banked score plus whatever the open round has
   * already earned them. Built fresh on every read so a phone sees its points
   * the moment they land rather than waiting for the round to close.
   */
  function standings(session) {
    const mode = modeOf(session);
    const state = stateOf(session);
    const pending = session.phase === 'round' && state && mode?.livePoints
      ? mode.livePoints({ state, settings: settingsOf(session.gameType), session })
      : new Map();
    return session.players
      .map((player) => ({
        id: player.id,
        name: player.name,
        score: (player.score || 0) + (pending.get(player.id) || 0),
        seated: player.seated !== false,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function publicSession(session, at = now(), playerId = '') {
    const mode = modeOf(session);
    const settings = settingsOf(session.gameType);
    const state = stateOf(session);
    const player = playerId ? session.players.find((p) => p.id === playerId) : null;
    const extras = mode?.publicRound
      ? mode.publicRound({
        session,
        state,
        phase: session.phase,
        playerId,
        players: session.players,
      }) || {}
      : {};
    const { you: youExtras, ...rest } = extras;
    const floor = minPlayersOf(session);
    return {
      sessionId: session.id,
      gameType: session.gameType,
      title: mode?.title || 'Game',
      code: session.code,
      phase: session.phase,
      roundIndex: session.roundIndex,
      rounds: settings.rounds,
      allowLateJoin: settings.allowLateJoin !== false,
      remainingSeconds: remainingSeconds(session, at),
      playerCount: session.players.length,
      minPlayers: floor,
      needPlayers: Math.max(0, floor - session.players.length),
      players: session.players.map(publicPlayer),
      scores: standings(session),
      ...rest,
      you: player
        ? { ...publicPlayer(player), ...(youExtras || {}) }
        : null,
      alias: aliasOf(),
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

  function boardOptions(source, holdSeconds, { takeover = false, card = '', session = null } = {}) {
    return {
      targetId: 'vestaboard',
      explicit: true,
      // Only the first invite should wrest the board from whatever was showing.
      // Later cards stay in front of held non-game pages. `replaceCard` drops
      // only stale phases at or below this one, so an unshown score card is
      // not evicted when the next round starts.
      breakHold: Boolean(takeover),
      quietHoursExempt: true,
      replaceSource: source,
      gameSource: source,
      replaceCard: card || null,
      holdSeconds,
      sessionId: session?.id || null,
      code: session?.code || null,
    };
  }

  /**
   * Drop every waiting page for this session so a dead invite cannot flip
   * after the session has already closed.
   */
  function dropSessionBoardPages(session) {
    const source = sourceOf(session);
    const code = String(session.code || '');
    const sessionId = String(session.id || '');
    try {
      dropPendingBoard((frame, item) => {
        if (item?.sessionId && String(item.sessionId) === sessionId) return true;
        if (!code) return false;
        const sameSource = String(frame?.source || '') === source
          || String(item?.ownerSource || '') === source;
        return sameSource && String(item?.code || frame?.code || '') === code;
      });
    } catch (error) {
      log?.warn?.('Could not clear game pages from the board queue', error?.message || error);
    }
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
  function takeBoard(source) {
    try {
      dropPendingBoard((frame, item) => item?.priority !== 'alert'
        && String(frame?.source || '') !== source
        && Boolean(item?.sequenceId));
    } catch (error) {
      log?.warn?.('Could not clear the board queue', error?.message || error);
    }
  }

  function pushPhase(session, card, extra = {}) {
    const mode = modeOf(session);
    const settings = settingsOf(session.gameType);
    const state = stateOf(session);
    const hold = extra.holdSeconds != null ? extra.holdSeconds : remainingSeconds(session);
    const source = sourceOf(session);
    // Take (or renew) the board lock before the card is queued, so the gap
    // between two phases never opens the line to everything parked behind us.
    try {
      setGameLock(source, true);
    } catch (error) {
      log?.warn?.('Could not lock the board for the game', error?.message || error);
    }
    takeBoard(source);
    const payload = {
      type: source,
      source,
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
      alias: aliasOf(),
      playerCount: session.players.length,
      minPlayers: minPlayersOf(session),
      scores: extra.scores || standings(session),
      roundWinner: extra.roundWinner || null,
      roundScores: extra.roundScores || null,
      ...(mode?.boardExtras ? mode.boardExtras({
        session,
        state,
        settings,
        players: session.players,
      }) : {}),
      ...(extra.board || {}),
      holdSeconds: hold,
      remainingSeconds: hold,
    };
    const takeover = extra.takeover != null
      ? Boolean(extra.takeover)
      : card === 'invite' || session.phase === 'invited';
    try {
      pushBoard(payload, boardOptions(source, hold, { takeover, card, session }));
    } catch (error) {
      log?.warn?.('Game board push failed', error?.message || error);
    }
  }

  function archiveRow(session, { abandoned = false, reason = '' } = {}) {
    const mode = modeOf(session);
    archive.append({
      sessionId: session.id,
      gameType: session.gameType,
      code: session.code,
      startedAt: iso(session.createdAt),
      endedAt: iso(now()),
      players: session.players.map((p) => ({ id: p.id, name: p.name, score: p.score || 0 })),
      rounds: session.rounds.length,
      winner: session.scores?.[0] || null,
      ...(mode?.archiveExtras ? mode.archiveExtras(session) : {}),
      abandoned,
      reason,
    });
  }

  function closeSession(session, reason = 'closed') {
    if (session.phase === 'closed') return;
    const abandoned = reason !== 'finished';
    const alreadyFinal = session.phase === 'final';
    const scores = session.scores?.length ? session.scores : standings(session);
    const hadAGame = session.hadPlayer || scores.length > 0;
    const settings = settingsOf(session.gameType);
    const short = reason === 'not-enough-players';
    // Pull any unshown invite / phase cards before we release the lock, or a
    // dead "JOIN THE NEXT GAME" can still flip with a code nobody can use.
    dropSessionBoardPages(session);
    session.phase = 'closed';
    session.phaseEndsAt = null;
    if (short) {
      // Say why. A lobby that simply vanishes reads as a broken board, and
      // the room has no idea it only needed one more person.
      pushPhase(session, 'short', {
        holdSeconds: settings.intermissionSeconds,
        takeover: true,
        showCode: false,
      });
    } else if (!alreadyFinal && hadAGame && reason !== 'preempted') {
      // Scores stay up when someone actually sat down. An empty invite that
      // times out should just drop the lock so rotation can continue — there
      // is nothing to celebrate. Skip a second flip when the final card is
      // already on the board. A board preempt (doorbell cutting through) also
      // skips the scores card — the interrupt already owns the flaps.
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
      setGameLock(sourceOf(session), false);
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
    const mode = modeOf(session);
    const settings = settingsOf(session.gameType);
    session.roundIndex += 1;
    const at = now();
    const state = mode.createRound({ random, settings, session, now: at });
    session.rounds.push(state);
    if (mode.roundKey) {
      const key = mode.roundKey(state);
      if (key) session.usedRounds.push(key);
    }
    session.phase = 'round';
    for (const player of session.players) {
      if (player.seated === false) continue;
      mode.seat(state, player.id);
    }
    mode.beginRound?.({ state, session, settings, players: session.players, now: at });
    const hold = typeof mode.roundHoldSeconds === 'function'
      ? mode.roundHoldSeconds({ settings, state, session })
      : settings.roundSeconds;
    session.phaseEndsAt = at + hold * 1000;
    pushPhase(session, 'round', { holdSeconds: hold });
    emit(session, 'round');
  }

  /**
   * The second half of a round for modes that vote. Skipped when there is
   * nothing to choose between — one answer cannot win a ballot.
   */
  function startVoting(session) {
    const mode = modeOf(session);
    const settings = settingsOf(session.gameType);
    const state = stateOf(session);
    if (mode.canVote && !mode.canVote({ state })) {
      finishRound(session);
      return;
    }
    mode.beginVoting?.({ state, random });
    session.phase = 'voting';
    session.phaseEndsAt = now() + (settings.votingSeconds || settings.intermissionSeconds) * 1000;
    pushPhase(session, 'voting', {
      holdSeconds: settings.votingSeconds || settings.intermissionSeconds,
    });
    emit(session, 'voting');
  }

  function finishRound(session) {
    const mode = modeOf(session);
    const settings = settingsOf(session.gameType);
    const state = stateOf(session);
    const result = mode.closeRound({
      state,
      players: session.players,
      settings,
      session,
      best: session.best || null,
    }) || {};
    const roundOnly = result.perPlayer || [];
    const byId = new Map(roundOnly.map((row) => [row.id, row.score || 0]));
    for (const player of session.players) {
      player.score = (player.score || 0) + (byId.get(player.id) || 0);
    }
    session.scores = session.players
      .map((p) => ({ id: p.id, name: p.name, score: p.score || 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    session.best = result.best || session.best || null;
    session.lastRound = { index: session.roundIndex, ...(result.reveal || {}) };

    const more = session.roundIndex < settings.rounds;
    if (more) {
      session.phase = 'intermission';
      session.phaseEndsAt = now() + settings.intermissionSeconds * 1000;
      seatWaiting(session);
      pushPhase(session, 'intermission', {
        roundWinner: result.winner || null,
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
      // The game is over, so the code is dead. Dropping it also frees the row
      // the fifth score needs.
      showCode: false,
    });
    emit(session, 'final');
  }

  function advance(session) {
    if (session.phase === 'invited') {
      closeSession(session, 'invite-expired');
      return;
    }
    if (session.phase === 'lobby') {
      if (!session.players.length) {
        closeSession(session, 'invite-expired');
        return;
      }
      // A game with a floor says so rather than starting a round it cannot
      // finish. Party Prompts needs three; Word Scramble is happy with one.
      if (session.players.length < minPlayersOf(session)) {
        closeSession(session, 'not-enough-players');
        return;
      }
      startRound(session);
      return;
    }
    if (session.phase === 'round') {
      const mode = modeOf(session);
      if (mode?.onRoundTimeout) {
        const result = mode.onRoundTimeout({
          state: stateOf(session),
          session,
          settings: settingsOf(session.gameType),
          players: session.players,
          now: now(),
        }) || {};
        if (result.finishRound) {
          finishRound(session);
          return;
        }
        if (result.continue) {
          const hold = result.holdSeconds
            || settingsOf(session.gameType).turnSeconds
            || settingsOf(session.gameType).roundSeconds;
          session.phaseEndsAt = now() + hold * 1000;
          pushPhase(session, 'round', { holdSeconds: hold });
          emit(session, 'timeout');
          return;
        }
      }
      if (mode?.votes) {
        startVoting(session);
      } else {
        finishRound(session);
      }
      return;
    }
    if (session.phase === 'voting') {
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
    const mode = gameOf(gameType);
    if (!mode) {
      throw new Error(`Unknown game: ${gameType}`);
    }
    const settings = settingsOf(gameType);
    const code = mintCode(random, byCode);
    // The lobby window starts when the invite actually flips — not when it
    // was queued behind dwell. Until then only the longer invite TTL is a
    // safety net so a stuck queue cannot leave a ghost session forever.
    const pendingCapMs = Math.max(
      settings.lobbySeconds,
      (Number(settings.inviteTtlMinutes) || 60) * 60,
    ) * 1000;
    const session = {
      id: crypto.randomUUID(),
      gameType,
      code,
      phase: 'invited',
      createdAt: now(),
      inviteShownAt: null,
      inviteExpiresAt: now() + pendingCapMs,
      phaseEndsAt: null,
      players: [],
      rounds: [],
      usedRounds: [],
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
    pushPhase(session, 'invite', { holdSeconds: settings.lobbySeconds, takeover: true });
    return publicSession(session);
  }

  /**
   * The invite card just landed on the board. Start the lobby countdown that
   * phones and the Sessions list use — the one that used to start at Push
   * and kill the session while the card was still waiting in the queue.
   */
  function noteBoardShown(detail = {}) {
    const card = String(detail.card || detail.frame?.card || '');
    if (card && card !== 'invite') return false;
    const session = sessionFromBoardDetail(detail);
    if (!session || session.phase !== 'invited' || session.inviteShownAt) {
      return false;
    }
    const settings = settingsOf(session.gameType);
    const shownAt = now();
    session.inviteShownAt = shownAt;
    session.inviteExpiresAt = shownAt + settings.lobbySeconds * 1000;
    session.phaseEndsAt = session.inviteExpiresAt;
    emit(session, 'invite-shown');
    return true;
  }

  /** Someone cancelled the waiting invite from the house queue. */
  function noteBoardCancelled(detail = {}) {
    const card = String(detail.card || detail.frame?.card || '');
    if (card && card !== 'invite') return false;
    const session = sessionFromBoardDetail(detail);
    if (!session || session.phase !== 'invited') return false;
    closeSession(session, 'invite-cancelled');
    return true;
  }

  function sessionFromBoardDetail(detail = {}) {
    const sessionId = String(detail.sessionId || '').trim();
    if (sessionId) {
      const byId = getById(sessionId);
      if (byId) return byId;
    }
    const code = String(detail.code || detail.frame?.code || '').trim().toUpperCase();
    return code ? getByCode(code) : null;
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
        seated: session.phase !== 'round' && session.phase !== 'voting',
        score: 0,
      };
      session.players.push(player);
      session.hadPlayer = true;
    }
    // The idle clock used to run from invite-create time. An invite that sat
    // on the board for longer than idleTimeoutSeconds would then die on the
    // very next tick after the first join — FINAL SCORES with one player at
    // zero — because hadPlayer flipped true while sseCount was still 0 and
    // lastSseAt was already stale. Reset it so the phone has a full idle
    // window to open its EventSource.
    session.lastSseAt = now();
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
    const mode = session ? modeOf(session) : null;
    const open = session
      && (session.phase === 'round' || (session.phase === 'voting' && mode?.votes));
    if (!open) {
      return { ok: false, error: 'No round is open' };
    }
    const state = stateOf(session);
    if (!mode.isSeated(state, playerId)) {
      return { ok: false, error: 'You are seated for the next round' };
    }
    const result = mode.submit({
      state,
      session,
      playerId,
      action,
      payload,
      phase: session.phase,
      settings: settingsOf(session.gameType),
      players: session.players,
      random,
    });
    if (!result.ok) return result;
    if (result.finishRound) {
      finishRound(session);
    } else if (result.advance) {
      // The mode is done with this half of the round (every answer locked,
      // the puzzle solved, …). Same path as the phase timer expiring.
      advance(session);
    } else if (result.refreshBoard) {
      if (Number.isFinite(result.holdSeconds)) {
        session.phaseEndsAt = now() + result.holdSeconds * 1000;
      }
      pushPhase(session, result.card || session.phase, {
        holdSeconds: Number.isFinite(result.holdSeconds)
          ? result.holdSeconds
          : remainingSeconds(session),
      });
    }
    emit(session, action);
    const player = session.players.find((p) => p.id === playerId);
    const live = standings(session).find((row) => row.id === playerId);
    return {
      ...result,
      liveScore: live ? live.score : player?.score || 0,
      scores: standings(session),
      session: publicSession(session, now(), playerId),
    };
  }

  function leave({ sessionId, playerId } = {}) {
    const session = getById(sessionId);
    if (!session) return { ok: true };
    const mode = modeOf(session);
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
    if (session.phase === 'round' && mode?.onLeave) {
      const result = mode.onLeave({
        state: stateOf(session),
        playerId,
        players: remaining,
        session,
        settings: settingsOf(session.gameType),
      }) || {};
      if (result.advance) {
        advance(session);
      } else if (result.refreshBoard) {
        if (Number.isFinite(result.holdSeconds)) {
          session.phaseEndsAt = now() + result.holdSeconds * 1000;
        }
        pushPhase(session, 'round', {
          holdSeconds: Number.isFinite(result.holdSeconds)
            ? result.holdSeconds
            : remainingSeconds(session),
        });
      }
    }
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
      // Always stamp the clock: when the last phone drops, idle must start
      // from *now*, not from the last time somebody was still connected.
      session.lastSseAt = now();
    };
  }

  function tick(at = now()) {
    for (const session of [...sessions.values()]) {
      if (session.phase === 'invited' && at >= session.inviteExpiresAt) {
        closeSession(session, 'invite-expired');
        continue;
      }
      const idle = settingsOf(session.gameType).idleTimeoutSeconds * 1000;
      // Nobody listening after somebody sat down. lastSseAt is refreshed on
      // join and on every SSE connect/disconnect, so a long-waiting invite
      // can no longer expire the moment the first phone sits down.
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

  /** A higher-listed board interrupt ended this game's hold. */
  function endByBoardSource(source, reason = 'preempted') {
    const owner = String(source || '');
    if (!owner) return { ended: 0 };
    let ended = 0;
    for (const session of [...sessions.values()]) {
      if (sourceOf(session) !== owner) continue;
      closeSession(session, reason);
      ended += 1;
    }
    return { ended };
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
    endByBoardSource,
    noteBoardShown,
    noteBoardCancelled,
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
