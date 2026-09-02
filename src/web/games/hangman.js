(() => {
  'use strict';

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  /** Long enough to land, short enough that the turn does not wait on it. */
  const SHAKE_MS = 600;

  const lobbyPanel = document.getElementById('hm-lobby-panel');
  const lobbyEl = document.getElementById('hm-lobby');
  const wordCard = document.getElementById('hm-word-card');
  const categoryEl = document.getElementById('hm-category');
  const wordEl = document.getElementById('hm-word');
  const eventEl = document.getElementById('hm-event');
  const gallowsPanel = document.getElementById('hm-gallows-panel');
  const gallows = document.getElementById('hm-gallows');
  const pipsEl = document.getElementById('hm-pips');
  const livesLabel = document.getElementById('hm-lives-label');
  const missesEl = document.getElementById('hm-misses');
  const pickPanel = document.getElementById('hm-pick-panel');
  const choicesEl = document.getElementById('hm-choices');
  const ownForm = document.getElementById('hm-own-form');
  const ownInput = document.getElementById('hm-own');
  const turnPanel = document.getElementById('hm-turn-panel');
  const turnEl = document.getElementById('hm-turn');
  const pointsEl = document.getElementById('hm-points');
  const lettersEl = document.getElementById('hm-letters');
  const solveForm = document.getElementById('hm-solve-form');
  const solveInput = document.getElementById('hm-solve');
  const revealPanel = document.getElementById('hm-reveal-panel');
  const revealTitle = document.getElementById('hm-reveal-title');
  const revealWord = document.getElementById('hm-reveal-word');
  const revealMeta = document.getElementById('hm-reveal-meta');

  const parts = gallows ? [...gallows.querySelectorAll('[data-at]')] : [];

  let paintedMask = '';
  let lastBeatId = 0;
  let lastRoundIndex = 0;
  let shakeTimer = 0;

  function hideAll() {
    if (lobbyPanel) lobbyPanel.hidden = true;
    if (wordCard) wordCard.hidden = true;
    if (gallowsPanel) gallowsPanel.hidden = true;
    if (pickPanel) pickPanel.hidden = true;
    if (turnPanel) turnPanel.hidden = true;
    if (lettersEl) lettersEl.hidden = true;
    if (solveForm) solveForm.hidden = true;
    if (revealPanel) revealPanel.hidden = true;
  }

  function reducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------- the word */

  /**
   * One tile per letter. A tile stays empty until its letter is called, so
   * the shape of the word — how long it is, where the repeats fall — is the
   * information a guesser is actually working from.
   */
  function renderMask(mask) {
    if (!wordEl || mask === paintedMask) return;
    paintedMask = mask;
    wordEl.innerHTML = '';
    for (const ch of mask) {
      const slot = document.createElement('span');
      slot.className = 'hm-slot' + (ch === '_' ? '' : ' is-open');
      slot.textContent = ch === '_' ? '' : ch;
      wordEl.appendChild(slot);
    }
    wordEl.dataset.long = mask.length > 9 ? 'true' : 'false';
  }

  /* ---------------------------------------------------------- the gallows */

  function renderGallows(session) {
    const lives = Number(session.lives) || 6;
    const left = Math.max(0, Number(session.livesLeft ?? lives));
    const drawn = lives - left;
    for (const part of parts) {
      part.classList.toggle('is-drawn', Number(part.dataset.at) <= drawn);
    }
    if (pipsEl) {
      pipsEl.innerHTML = '';
      for (let i = 0; i < lives; i += 1) {
        const pip = document.createElement('li');
        pip.className = 'hm-pip' + (i < left ? ' is-alive' : '');
        pipsEl.appendChild(pip);
      }
    }
    if (livesLabel) {
      livesLabel.textContent = left === 1
        ? 'One life left'
        : left ? `${left} lives left` : 'Out of lives';
    }
    if (missesEl) {
      const misses = session.misses || [];
      missesEl.textContent = misses.length ? `Missed  ${misses.join('  ')}` : '';
    }
  }

  function shake() {
    if (!gallowsPanel || reducedMotion()) return;
    window.clearTimeout(shakeTimer);
    gallowsPanel.classList.remove('is-shake');
    // Reading offsetWidth restarts the animation on a second miss in a row.
    void gallowsPanel.offsetWidth;
    gallowsPanel.classList.add('is-shake');
    shakeTimer = window.setTimeout(() => gallowsPanel.classList.remove('is-shake'), SHAKE_MS);
  }

  /* ----------------------------------------------------------- the panels */

  function renderLobby(session) {
    hideAll();
    if (!lobbyPanel || !lobbyEl) return;
    lobbyPanel.hidden = false;
    const short = session.needPlayers || 0;
    lobbyEl.textContent = short > 0
      ? `Waiting for ${short} more player${short === 1 ? '' : 's'}.`
      : 'Everyone in. The first word is on its way.';
  }

  /** The setter's menu. Nobody else is ever handed this list. */
  function renderPick(session) {
    hideAll();
    if (!pickPanel || !choicesEl) return;
    pickPanel.hidden = false;
    choicesEl.innerHTML = '';
    (session.you?.choices || []).forEach((choice, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hm-choice';
      btn.dataset.choice = String(index);
      btn.innerHTML = `<span class="hm-choice-word"></span><span class="hm-choice-cat"></span>`;
      btn.querySelector('.hm-choice-word').textContent = choice.word;
      btn.querySelector('.hm-choice-cat').textContent = choice.category;
      choicesEl.appendChild(btn);
    });
  }

  function renderWaiting(session) {
    hideAll();
    if (!lobbyPanel || !lobbyEl) return;
    lobbyPanel.hidden = false;
    lobbyEl.textContent = session.setterName
      ? `${session.setterName} is picking a word for you.`
      : 'A word is on its way.';
  }

  function renderLetters(session) {
    if (!lettersEl) return;
    const you = session.you || {};
    const called = new Set(session.called || []);
    const missed = new Set(session.misses || []);
    lettersEl.hidden = !you.canGuess;
    lettersEl.innerHTML = '';
    for (const letter of LETTERS) {
      const used = called.has(letter);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hm-letter'
        + (used ? (missed.has(letter) ? ' is-miss' : ' is-hit') : '');
      btn.textContent = letter;
      btn.dataset.letter = letter;
      btn.disabled = used || !you.canGuess;
      lettersEl.appendChild(btn);
    }
  }

  /**
   * One word, one turn. Everybody watches the same tiles; only the player it
   * is waiting on gets a keypad, so two phones cannot guess at once.
   */
  function renderRound(session) {
    hideAll();
    const you = session.you || {};
    if (session.step === 'pick') {
      if (you.canPick) renderPick(session);
      else renderWaiting(session);
      return;
    }

    if (wordCard) {
      wordCard.hidden = false;
      if (categoryEl) categoryEl.textContent = session.category || '';
      renderMask(session.mask || '');
      if (eventEl) eventEl.textContent = session.lastEvent || '';
    }
    if (gallowsPanel) {
      gallowsPanel.hidden = false;
      renderGallows(session);
    }
    if (turnPanel && turnEl) {
      turnPanel.hidden = false;
      turnPanel.classList.toggle('is-yours', Boolean(you.yourTurn));
      turnEl.textContent = you.yourTurn
        ? 'Your turn — call a letter'
        : you.isSetter
          ? 'You set this one. Sit on your hands.'
          : session.turnName
            ? `${session.turnName} is guessing`
            : 'Waiting for the next guess';
      if (pointsEl) {
        // The setter already knows the answer, so showing it costs nothing
        // and saves them squinting at the mask to follow along.
        pointsEl.textContent = you.isSetter && session.word
          ? `Your word: ${session.word}`
          : you.points
            ? `+${you.points} this word`
            : `Each letter pays ${session.letterPoints || 10} a flap`;
      }
    }
    renderLetters(session);
    if (solveForm) solveForm.hidden = !you.canSolve;
  }

  function renderReveal(session) {
    hideAll();
    if (!revealPanel) return;
    revealPanel.hidden = false;
    const last = session.lastRound || {};
    const word = last.word || session.word || '';
    if (revealTitle) {
      revealTitle.textContent = session.phase === 'final' ? 'That was the last word' : 'The word was';
    }
    if (revealWord) revealWord.textContent = word;
    if (revealMeta) {
      const misses = Number(last.misses || 0);
      const cost = `${misses} miss${misses === 1 ? '' : 'es'}`;
      revealMeta.textContent = last.solvedBy
        ? `${last.solvedBy} got it with ${cost}.`
        : word ? `Nobody got it — ${cost}.` : '';
    }
  }

  function paint(session) {
    if (session.phase === 'invited' || session.phase === 'lobby') {
      renderLobby(session);
      return;
    }
    if (session.phase === 'round') {
      renderRound(session);
      return;
    }
    renderReveal(session);
  }

  /* ------------------------------------------------------------- the input */

  choicesEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-choice]');
    if (!btn || btn.disabled) return;
    // The pick is already decided by the tap; disabling stops a second one
    // queueing behind the round that is about to start.
    [...choicesEl.querySelectorAll('button')].forEach((node) => { node.disabled = true; });
    window.GameShell.submit('pick', { choice: Number(btn.dataset.choice) });
  });

  ownForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const word = String(ownInput?.value || '').trim();
    if (!word) return;
    const result = await window.GameShell.submit('pick', { word });
    // A refused word stays in the box so it can be edited, not retyped.
    if (result?.ok && ownInput) {
      ownInput.value = '';
      ownInput.blur();
    }
  });

  lettersEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-letter]');
    if (!btn || btn.disabled) return;
    window.GameShell.submit('letter', { letter: btn.dataset.letter });
  });

  solveForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = String(solveInput?.value || '').trim();
    if (!text) return;
    window.GameShell.submit('solve', { solve: text });
    if (solveInput) solveInput.value = '';
  });

  window.GameShell.register('hangman', {
    render(session) {
      if (session.roundIndex !== lastRoundIndex) {
        lastRoundIndex = session.roundIndex;
        lastBeatId = 0;
        paintedMask = '';
      }
      const fresh = session.beat && session.beat.id > lastBeatId;
      if (fresh) {
        lastBeatId = session.beat.id;
        // A miss is the only beat worth flinching at.
        if (session.beat.kind === 'miss') shake();
      }
      paint(session);
    },
    scoreLine(session) {
      const score = session.you?.score || 0;
      if (session.phase !== 'round' || session.step === 'pick') {
        return `Your score ${score}`;
      }
      const left = Number(session.livesLeft ?? session.lives ?? 6);
      return `Your score ${score} · ${left} ${left === 1 ? 'life' : 'lives'} left`;
    },
    phaseLabel(session) {
      if (session.phase !== 'round') return '';
      const round = session.rounds > 1
        ? `Round ${session.roundIndex} of ${session.rounds}`
        : `Round ${session.roundIndex}`;
      if (session.step === 'pick') {
        return session.setterName ? `${round} · ${session.setterName} is picking` : round;
      }
      return session.turnName ? `${round} · ${session.turnName} to guess` : round;
    },
    teardown() {
      hideAll();
      window.clearTimeout(shakeTimer);
      gallowsPanel?.classList.remove('is-shake');
      paintedMask = '';
      lastBeatId = 0;
      lastRoundIndex = 0;
      if (solveInput) solveInput.value = '';
      if (ownInput) ownInput.value = '';
      if (lettersEl) lettersEl.innerHTML = '';
      if (choicesEl) choicesEl.innerHTML = '';
    },
  });
})();
