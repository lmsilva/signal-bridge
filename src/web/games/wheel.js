(() => {
  'use strict';

  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

  /** Long enough to feel like a throw, short enough not to stall the turn. */
  const SPIN_MS = 2600;
  const SPIN_TURNS = 4;

  const puzzleEl = document.getElementById('wf-puzzle');
  const categoryEl = document.getElementById('wf-category');
  const eventEl = document.getElementById('wf-event');
  const puzzleCard = document.getElementById('wf-puzzle-card');
  const lobbyPanel = document.getElementById('wf-lobby-panel');
  const lobbyEl = document.getElementById('wf-lobby');
  const wheelPanel = document.getElementById('wf-wheel-panel');
  const wheelFace = document.getElementById('wf-wheel-face');
  const wheelResult = document.getElementById('wf-wheel-result');
  const turnPanel = document.getElementById('wf-turn-panel');
  const turnEl = document.getElementById('wf-turn');
  const bankEl = document.getElementById('wf-bank');
  const spinBtn = document.getElementById('btn-wf-spin');
  const lettersEl = document.getElementById('wf-letters');
  const solveForm = document.getElementById('wf-solve-form');
  const solveInput = document.getElementById('wf-solve');
  const revealPanel = document.getElementById('wf-reveal-panel');
  const revealPuzzle = document.getElementById('wf-reveal-puzzle');
  const revealMeta = document.getElementById('wf-reveal-meta');
  const revealTitle = document.getElementById('wf-reveal-title');

  let paintedWheel = '';
  let rotation = 0;
  let lastSpinId = 0;
  let lastRoundIndex = 0;
  let settleTimer = 0;
  let pending = null;

  function hideAll() {
    if (lobbyPanel) lobbyPanel.hidden = true;
    if (puzzleCard) puzzleCard.hidden = true;
    if (wheelPanel) wheelPanel.hidden = true;
    if (turnPanel) turnPanel.hidden = true;
    if (lettersEl) lettersEl.hidden = true;
    if (solveForm) solveForm.hidden = true;
    if (revealPanel) revealPanel.hidden = true;
  }

  function money(value) {
    return '$' + Math.max(0, Number(value) || 0).toLocaleString('en-US');
  }

  function reducedMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ wheel */

  function pointAt(radius, degrees) {
    const rad = ((degrees - 90) * Math.PI) / 180;
    return [
      (100 + radius * Math.cos(rad)).toFixed(2),
      (100 + radius * Math.sin(rad)).toFixed(2),
    ];
  }

  function slicePath(from, to) {
    const [x1, y1] = pointAt(96, from);
    const [x2, y2] = pointAt(96, to);
    const [x3, y3] = pointAt(30, to);
    const [x4, y4] = pointAt(30, from);
    return `M${x1} ${y1}A96 96 0 0 1 ${x2} ${y2}L${x3} ${y3}A30 30 0 0 0 ${x4} ${y4}Z`;
  }

  /** Cash wedges alternate so neighbours stay apart; the penalties own a colour. */
  function sliceFill(wedge, index) {
    if (wedge.type === 'bankrupt') return '#0b1220';
    if (wedge.type === 'lose') return '#4b5563';
    if (wedge.type === 'free') return '#16a34a';
    return index % 2 ? '#1d4ed8' : '#f8fafc';
  }

  function sliceInk(wedge, index) {
    if (wedge.type === 'bankrupt') return '#f87171';
    if (wedge.type === 'lose' || wedge.type === 'free') return '#f8fafc';
    return index % 2 ? '#f8fafc' : '#0b1220';
  }

  /** Short enough to run along one wedge without spilling into its neighbour. */
  function sliceLabel(wedge) {
    if (wedge.type === 'bankrupt') return 'BANKRUPT';
    if (wedge.type === 'lose') return 'LOSE';
    if (wedge.type === 'free') return 'FREE';
    return '$' + (wedge.value || 0);
  }

  function buildWheel(wedges) {
    if (!wheelFace || !wedges.length) return;
    const key = wedges.map((wedge) => wedge.type + (wedge.value || 0)).join(',');
    if (key === paintedWheel) return;
    paintedWheel = key;
    const step = 360 / wedges.length;
    const slices = wedges.map((wedge, index) => {
      const from = index * step;
      const mid = from + step / 2;
      const label = sliceLabel(wedge);
      const size = wedge.type === 'cash' ? 10 : 7.5;
      // Labels run along the radius — the only way BANKRUPT fits in a
      // fifteen-degree wedge — and the half of the wheel past six o'clock
      // reads the other way round, or it would hang upside down.
      const outward = mid < 180;
      const anchorY = outward ? 60 : 14;
      const spin = outward ? -90 : 90;
      return `<g transform="rotate(${mid.toFixed(2)} 100 100)">`
        + `<path d="${slicePath(-step / 2, step / 2)}" fill="${sliceFill(wedge, index)}" stroke="#0b1220" stroke-width="0.8"/>`
        + `<text x="100" y="${anchorY}" transform="rotate(${spin} 100 ${anchorY})" fill="${sliceInk(wedge, index)}"`
        + ` font-size="${size}" font-weight="700" text-anchor="start" dominant-baseline="middle">${label}</text>`
        + '</g>';
    }).join('');
    // Fonts do not cross into an image, so the wheel names its own.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + `<g font-family="Helvetica, Arial, sans-serif">${slices}</g>`
      + '<circle cx="100" cy="100" r="29" fill="#0b1220" stroke="#f8fafc" stroke-width="1.5"/>'
      + '</svg>';
    // Painted once into an image so the throw is the compositor turning a
    // decoded bitmap. As live SVG a phone re-rasterises two dozen paths and
    // their rotated text every frame, which is why the spin stuttered there
    // and looked fine on a desktop.
    wheelFace.innerHTML = '<img alt="Wheel of Fortune wheel" src="data:image/svg+xml;charset=utf-8,'
      + encodeURIComponent(svg) + '">';
  }

  function spinTo(index, count, throwId) {
    if (!wheelFace || !count) return;
    const step = 360 / count;
    // Stop off-centre the way a real wheel does. The offset is derived from
    // the throw id, so every phone in the room stops on the same picture.
    const drift = (((((throwId || 1) * 37) % 61) / 60) - 0.5) * step * 0.7;
    const target = index * step + step / 2 + drift;
    // Always wind forwards, so a second spin never rewinds through the wheel.
    const base = Math.ceil((rotation + 1) / 360) * 360;
    rotation = base + SPIN_TURNS * 360 - target;
    const ms = reducedMotion() ? 0 : SPIN_MS;
    wheelFace.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.17, 0.72, 0.16, 1)` : 'none';
    wheelFace.style.transform = `rotate(${rotation}deg)`;
  }

  function clearSettle() {
    if (settleTimer) {
      window.clearTimeout(settleTimer);
      settleTimer = 0;
    }
    pending = null;
  }

  /* ----------------------------------------------------------------- panels */

  function renderLobby(session) {
    hideAll();
    if (!lobbyPanel) return;
    lobbyPanel.hidden = false;
    const need = session.needPlayers || 0;
    lobbyEl.textContent = need
      ? 'Waiting for ' + need + ' more player' + (need === 1 ? '' : 's') + ' before anyone can spin.'
      : 'The wheel is about to start.';
  }

  function renderPuzzle(session) {
    if (!puzzleCard) return;
    puzzleCard.hidden = false;
    if (categoryEl) categoryEl.textContent = session.category || 'Puzzle';
    if (puzzleEl) puzzleEl.textContent = session.mask || '';
    if (eventEl) eventEl.textContent = session.lastEvent || '';
  }

  function renderLetters(session) {
    if (!lettersEl) return;
    const you = session.you || {};
    const called = new Set(session.called || []);
    const canGuess = Boolean(you.canGuess);
    const canVowel = Boolean(you.canVowel);
    lettersEl.hidden = !(canGuess || canVowel);
    lettersEl.innerHTML = '';
    for (const letter of LETTERS) {
      const vowel = VOWELS.has(letter);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wf-letter' + (vowel ? ' is-vowel' : '') + (called.has(letter) ? ' is-called' : '');
      btn.textContent = letter;
      btn.dataset.letter = letter;
      btn.disabled = called.has(letter) ? true : !(vowel ? canVowel : canGuess);
      lettersEl.appendChild(btn);
    }
  }

  /**
   * One wheel, one turn. Everybody watches it spin; only the player it is
   * waiting on gets a button, so two phones can never throw at once.
   */
  function renderRound(session, { spinning = false } = {}) {
    hideAll();
    renderPuzzle(session);

    const you = session.you || {};
    const yourTurn = Boolean(you.yourTurn) && !spinning;

    if (wheelPanel) {
      wheelPanel.hidden = false;
      wheelPanel.classList.toggle('is-spinning', spinning);
      if (wheelResult) {
        const wedge = session.wedge;
        wheelResult.textContent = spinning
          ? 'Spinning…'
          : wedge
            ? (wedge.type === 'cash' ? money(wedge.value) + ' a letter' : wedge.label)
            : '';
      }
    }

    if (turnPanel) {
      turnPanel.hidden = false;
      turnPanel.classList.toggle('is-yours', yourTurn);
      if (spinning) {
        turnEl.textContent = 'The wheel is spinning…';
      } else if (yourTurn) {
        turnEl.textContent = session.step === 'guess'
          ? 'Your turn — call a consonant, or solve.'
          : session.step === 'play'
            ? 'Your turn — spin again, buy a vowel, or solve.'
            : 'Your turn — spin the wheel, or solve.';
      } else {
        turnEl.textContent = session.turnName
          ? session.turnName + ' is up — wait for your turn'
          : 'Waiting for the next spin';
      }
      bankEl.textContent = 'Round bank ' + money(you.bank)
        + (you.freeSpins ? ' · ' + you.freeSpins + ' free spin' + (you.freeSpins === 1 ? '' : 's') : '');
      if (spinBtn) {
        const canSpin = yourTurn && Boolean(you.canSpin);
        spinBtn.hidden = !canSpin;
        spinBtn.disabled = !canSpin;
      }
    }

    if (spinning) return;
    renderLetters(session);
    if (solveForm) solveForm.hidden = !(you.canSolve && yourTurn);
  }

  function renderReveal(session) {
    hideAll();
    if (puzzleCard) {
      puzzleCard.hidden = false;
      if (categoryEl) categoryEl.textContent = session.lastRound?.category || session.category || 'Puzzle';
      if (puzzleEl) puzzleEl.textContent = session.lastRound?.puzzle || session.puzzle || '';
      if (eventEl) eventEl.textContent = '';
    }
    if (!revealPanel) return;
    revealPanel.hidden = false;
    const recap = session.lastRound || {};
    if (revealTitle) {
      revealTitle.textContent = session.phase === 'final' ? 'Final puzzle' : 'The puzzle';
    }
    if (revealPuzzle) revealPuzzle.textContent = recap.puzzle || session.puzzle || '';
    if (revealMeta) {
      revealMeta.textContent = recap.solvedBy
        ? recap.solvedBy + ' solved it for ' + money(recap.amount)
        : 'Nobody solved this one.';
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

  /* ------------------------------------------------------------------ input */

  spinBtn?.addEventListener('click', () => {
    if (spinBtn.disabled) return;
    // The result is already decided server-side; hiding the button here just
    // stops a double tap from queueing a second throw behind the animation.
    spinBtn.disabled = true;
    window.GameShell.submit('spin', {});
  });

  lettersEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-letter]');
    if (!btn || btn.disabled) return;
    const letter = btn.dataset.letter;
    window.GameShell.submit(VOWELS.has(letter) ? 'vowel' : 'letter', { letter });
  });

  solveForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = String(solveInput?.value || '').trim();
    if (!text) return;
    window.GameShell.submit('solve', { solve: text });
    if (solveInput) solveInput.value = '';
  });

  window.GameShell.register('wheel', {
    render(session) {
      if (Array.isArray(session.wheel)) buildWheel(session.wheel);
      if (session.roundIndex !== lastRoundIndex) {
        lastRoundIndex = session.roundIndex;
        lastSpinId = 0;
        clearSettle();
      }

      const spin = session.spin;
      const fresh = session.phase === 'round' && spin && spin.id > lastSpinId;
      if (fresh) {
        lastSpinId = spin.id;
        clearSettle();
        // Lay the turn out before the wheel moves. The server has already
        // resolved the throw, so the controls are held until it stops —
        // otherwise the phone spoils its own result — and reflowing the page
        // (the letter pad leaves) mid-throw costs a phone its first frames.
        renderRound(session, { spinning: true });
        spinTo(spin.index || 0, (session.wheel || []).length, spin.id);
        pending = session;
        settleTimer = window.setTimeout(() => {
          settleTimer = 0;
          const latest = pending;
          pending = null;
          if (latest) paint(latest);
        }, reducedMotion() ? 0 : SPIN_MS);
        return;
      }

      if (settleTimer) {
        // A newer frame landed mid-throw; show it once the wheel settles.
        pending = session;
        return;
      }
      paint(session);
    },
    scoreLine(session) {
      const bank = session.you?.bank || 0;
      const score = session.you?.score || 0;
      return bank && session.phase === 'round'
        ? 'Your score ' + score + ' · bank ' + money(bank)
        : 'Your score ' + score;
    },
    phaseLabel(session) {
      if (session.phase === 'round' && session.turnName) {
        const round = session.rounds > 1
          ? 'Round ' + session.roundIndex + ' of ' + session.rounds
          : 'Round ' + session.roundIndex;
        return round + ' · ' + session.turnName + ' to play';
      }
      return '';
    },
    teardown() {
      hideAll();
      clearSettle();
      lastSpinId = 0;
      lastRoundIndex = 0;
      if (solveInput) solveInput.value = '';
      if (lettersEl) lettersEl.innerHTML = '';
    },
  });
})();
