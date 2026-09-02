(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const promptCard = $('pp-prompt-card');
  const promptText = $('pp-prompt');
  const promptKicker = $('pp-prompt-kicker');
  const answerForm = $('pp-answer-form');
  const answerInput = $('pp-answer');
  const answerCount = $('pp-answer-count');
  const lockedPanel = $('pp-locked-panel');
  const lockedText = $('pp-locked');
  const lockedNote = $('pp-locked-note');
  const ballotPanel = $('pp-ballot-panel');
  const ballotList = $('pp-ballot');
  const ballotNote = $('pp-ballot-note');
  const revealPanel = $('pp-reveal-panel');
  const revealTitle = $('pp-reveal-title');
  const revealList = $('pp-reveal');
  const lobbyPanel = $('pp-lobby-panel');
  const lobbyText = $('pp-lobby');

  /** What the box will still take, so the counter can go red before the send does. */
  const MAX_ANSWER = Number(answerInput?.getAttribute('maxlength')) || 60;

  /** The ballot the phone is currently looking at, so a repaint can be skipped. */
  let ballotKey = '';

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function syncCounter() {
    if (!answerCount || !answerInput) return;
    const used = answerInput.value.length;
    answerCount.textContent = `${used}/${MAX_ANSWER}`;
    answerCount.classList.toggle('is-full', used >= MAX_ANSWER);
  }

  function hideAll() {
    for (const node of [promptCard, answerForm, lockedPanel, ballotPanel, revealPanel, lobbyPanel]) {
      if (node) node.hidden = true;
    }
  }

  /**
   * The writing half. The prompt is the loudest thing on screen; once an
   * answer is locked in the box is replaced by what you wrote, so nobody
   * wonders whether it went through.
   */
  function renderRound(session) {
    promptCard.hidden = false;
    promptKicker.textContent = 'Your prompt';
    promptText.textContent = session.prompt || '';

    const mine = session.you?.answer || '';
    answerForm.hidden = Boolean(mine);
    lockedPanel.hidden = !mine;
    if (mine) {
      lockedText.textContent = mine;
      const waiting = Math.max(0, (session.seatedCount || 0) - (session.answerCount || 0));
      lockedNote.textContent = waiting
        ? `Waiting on ${plural(waiting, 'answer')}…`
        : 'Everyone is in — voting next.';
    } else {
      syncCounter();
    }
  }

  /**
   * The voting half. Answers stay anonymous until the reveal, which is most of
   * the fun, so the list carries throwaway ids and no names. Your own answer
   * is shown but cannot be picked.
   */
  function renderVoting(session) {
    promptCard.hidden = false;
    promptKicker.textContent = 'The prompt was';
    promptText.textContent = session.prompt || '';
    ballotPanel.hidden = false;

    const ballot = session.ballot || [];
    const picked = session.you?.vote || '';
    const key = `${ballot.map((row) => row.answerId).join('|')}::${picked}`;
    if (key !== ballotKey) {
      ballotKey = key;
      ballotList.innerHTML = '';
      for (const row of ballot) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pp-vote';
        button.dataset.answerId = row.answerId;
        button.classList.toggle('is-mine', Boolean(row.mine));
        button.classList.toggle('is-picked', row.answerId === picked);
        button.disabled = Boolean(row.mine);
        const text = document.createElement('span');
        text.className = 'pp-vote-text';
        text.textContent = row.answer;
        button.appendChild(text);
        if (row.mine) {
          const tag = document.createElement('span');
          tag.className = 'pp-vote-tag';
          tag.textContent = 'Yours';
          button.appendChild(tag);
        }
        li.appendChild(button);
        ballotList.appendChild(li);
      }
    }
    const voted = Math.max(0, session.voteCount || 0);
    ballotNote.textContent = picked
      ? 'Vote counted. You can change it until time runs out.'
      : `Tap the one that made you laugh. ${plural(voted, 'vote')} in.`;
  }

  /** Between rounds and at the end: who wrote what, and how it went down. */
  function renderReveal(session) {
    const last = session.lastRound;
    const answers = last?.answers || [];
    if (!answers.length) return;
    revealPanel.hidden = false;
    revealTitle.textContent = last.prompt
      ? `Round ${last.index}: ${last.prompt}`
      : `Round ${last.index}`;
    revealList.innerHTML = '';
    answers.forEach((row, index) => {
      const li = document.createElement('li');
      li.className = 'pp-reveal-row';
      if (index === 0 && row.votes > 0) li.classList.add('is-winner');
      const answer = document.createElement('span');
      answer.className = 'pp-reveal-answer';
      answer.textContent = row.answer;
      const meta = document.createElement('span');
      meta.className = 'pp-reveal-meta';
      meta.textContent = `${row.name} · ${plural(row.votes || 0, 'vote')}`;
      li.append(answer, meta);
      revealList.appendChild(li);
    });
  }

  function renderLobby(session) {
    lobbyPanel.hidden = false;
    const short = session.needPlayers || 0;
    lobbyText.textContent = short
      ? `${plural(short, 'more player')} needed — Party Prompts takes at least ${session.minPlayers}.`
      : 'Everyone is in. The first prompt is on its way to the board.';
  }

  answerForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answer = String(answerInput?.value || '').trim();
    if (!answer) return;
    const result = await window.GameShell.submit('answer', { answer });
    // Only clear the box once the server took it; a rejected answer should
    // stay put so it can be edited rather than retyped.
    if (result?.ok) {
      answerInput.value = '';
      answerInput.blur();
      syncCounter();
    }
  });

  answerInput?.addEventListener('input', syncCounter);

  ballotList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-answer-id]');
    if (!button || button.disabled) return;
    window.GameShell.submit('vote', { answerId: button.dataset.answerId });
  });

  window.GameShell.register('prompts', {
    render(session) {
      hideAll();
      if (session.phase === 'invited' || session.phase === 'lobby') {
        renderLobby(session);
        return;
      }
      if (session.phase === 'round') {
        renderRound(session);
        return;
      }
      if (session.phase === 'voting') {
        renderVoting(session);
        return;
      }
      renderReveal(session);
    },
    teardown() {
      hideAll();
      ballotKey = '';
      if (answerInput) answerInput.value = '';
    },
  });
})();
