(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PUSH_CATEGORIES = Object.freeze([
    { id: 'home', label: 'Home' },
    { id: 'games', label: 'Games' },
    { id: 'media', label: 'Media' },
    { id: 'news', label: 'News' },
    { id: 'language', label: 'Language' },
    { id: 'travel', label: 'Travel' },
    { id: 'share', label: 'Share' },
  ]);

  let me = null;
  let pendingAvatar = null;
  let commands = [];
  let displays = [];
  let pushKind = 'all';
  let libKind = 'all';
  let libCategory = 'all';
  let tripFilter = 'upcoming';
  let openTripId = '';
  let dateSelectedId = '';
  let dateDraft = {};
  let dateLayout = null;
  let datePreviewCard = 'countdown';
  let slideshowSelecting = false;
  const slideshowSelected = new Set();
  let photos = [];
  let slideshowEvents = null;
  let gamesPollTimer = null;
  const GAMES_POLL_MS = 8000;
  let lightboxIndex = -1;
  let confirmResolver = null;
  const DATE_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DATE_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const DATE_ORDINALS = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', last: 'Last' };

  async function api(path, body, method) {
    const response = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  let toastTimer = null;

  function toast(message) {
    const el = $('su-toast');
    if (!el) return;
    window.clearTimeout(toastTimer);
    el.hidden = !message;
    el.textContent = message || '';
    if (message) {
      toastTimer = window.setTimeout(() => {
        el.hidden = true;
        el.textContent = '';
      }, 3200);
    }
  }

  function showTab(name) {
    document.body.dataset.tab = name;
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${name}`);
    });
    document.querySelectorAll('#su-tabs [data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    if (name === 'board') window.userBoard?.enter?.();
    else window.userBoard?.leave?.();
    if (name === 'games') {
      loadGames();
      startGamesPoll();
    } else {
      stopGamesPoll();
    }
    if (name === 'slideshow') {
      loadPhotos();
      startSlideshowEvents();
    }
    if (name === 'flight') loadTrips();
    if (name === 'dates') loadDates();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function askConfirm({ title, text, ok = 'Delete', danger = true } = {}) {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      $('su-confirm-title').textContent = title || 'Delete?';
      $('su-confirm-text').textContent = text || 'This cannot be undone.';
      if ($('su-confirm-ok')) {
        $('su-confirm-ok').textContent = ok;
        $('su-confirm-ok').className = danger ? 'su-btn su-btn-danger' : 'su-btn';
      }
      $('su-confirm-sheet').hidden = false;
    });
  }

  function closeConfirm(ok) {
    $('su-confirm-sheet').hidden = true;
    const resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(Boolean(ok));
  }

  function formatYmd(ymd) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!match) return String(ymd || '');
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function daysLabel(next = {}) {
    const days = Number(next.daysAway);
    if (!Number.isFinite(days)) return '';
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 0) return 'Passed';
    return `in ${days} days`;
  }

  function dateScheduleLabel(event = {}) {
    if (event.schedule === 'weekday' && event.weekday != null && event.month) {
      const which = DATE_ORDINALS[event.ordinal] || event.ordinal || '';
      const day = DATE_WEEKDAYS[event.weekday] || '';
      const month = DATE_MONTHS[event.month - 1] || '';
      return `${which} ${day} of ${month}`.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function kindMatch(command, kind) {
    if (kind === 'all') return true;
    const kinds = Array.isArray(command.kinds) && command.kinds.length ? command.kinds : ['full'];
    return kinds.includes(kind);
  }

  function commandById(id) {
    return commands.find((row) => row.id === id);
  }

  function targetBody(extra = {}) {
    return { ...extra, targetId: $('push-target')?.value || '*' };
  }

  function haystack(command) {
    return `${command.title} ${command.subtitle} ${command.group} ${command.id} ${command.pushCategory || ''}`.toLowerCase();
  }

  async function saveTiles(tiles) {
    const saved = await api('/api/user/profile', { dashboardTiles: tiles });
    me = saved.user;
    renderDash();
    renderLibrary();
  }

  async function toggleLibraryTile(command) {
    const tiles = [...(me.dashboardTiles || [])];
    const idx = tiles.findIndex((tile) => tile.id === command.id);
    // Adding is one tap and trivially undone from the same card, so it just
    // happens; only taking a tile away asks first.
    if (idx < 0) {
      tiles.push({ id: command.id });
      await saveTiles(tiles);
      toast(`${command.title} added to Your tiles`);
      return;
    }
    const ok = await askConfirm({
      title: `Remove ${command.title}?`,
      text: 'This tile will leave Your tiles. You can add it again from the library.',
      ok: 'Remove',
      danger: true,
    });
    if (!ok) return;
    tiles.splice(idx, 1);
    await saveTiles(tiles);
    toast(`${command.title} removed`);
  }

  async function removeDashTile(id) {
    const command = commandById(id);
    const ok = await askConfirm({
      title: `Remove ${command?.title || 'this tile'}?`,
      text: 'This tile will leave Your tiles. You can add it again from the library.',
      ok: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await saveTiles((me.dashboardTiles || []).filter((tile) => tile.id !== id));
  }

  async function pushCommand(command) {
    toast(`Sending ${command.title}…`);
    if (command.id === 'signal.slideshow') {
      const data = await api('/api/photos');
      const entries = (data.photos || []).map((p) => ({
        url: new URL(p.path, document.baseURI).href,
        uploadedAt: p.createdAt,
      }));
      if (!entries.length) throw new Error('No saved photos yet');
      await api(command.route, targetBody({ photos: entries }));
    } else {
      await api(command.route, targetBody(command.body || {}));
    }
    toast(`${command.title} sent`);
  }

  let suppressPushClick = false;
  let dashDragWrap = null;
  let dashPlaceholder = null;

  function coarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches;
  }

  function applyPointerMode() {
    const coarse = coarsePointer();
    document.body.classList.toggle('is-coarse', coarse);
    document.body.classList.toggle('is-fine', !coarse);
    const hint = $('push-dash-hint');
    if (hint) hint.textContent = 'Drag the dots to reorder.';
  }

  function dashCardNodes(host, skip) {
    return [...(host || $('push-dash'))?.querySelectorAll('.push-card-wrap') || []]
      .filter((node) => node !== skip
        && !node.classList.contains('is-placeholder')
        && !node.classList.contains('is-dragging'));
  }

  function nearestDashSlot(host, x, y, skip) {
    const cards = dashCardNodes(host, skip);
    if (!cards.length) return null;
    let best = cards[0];
    let bestDist = Infinity;
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height / 2);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = card;
      }
    }
    const box = best.getBoundingClientRect();
    return x < box.left + box.width / 2 ? best : best.nextElementSibling;
  }

  function placeDashCard(host, wrap, x, y) {
    if (!host || !wrap) return;
    const slot = nearestDashSlot(host, x, y, wrap);
    if (slot && slot !== wrap) host.insertBefore(wrap, slot);
    else if (!slot) host.appendChild(wrap);
  }

  async function commitDashOrder() {
    const ids = dashCardNodes().map((node) => node.dataset.id);
    const current = (me?.dashboardTiles || []).map((tile) => tile.id);
    if (ids.join('\0') === current.join('\0')) return;
    await saveTiles(ids.map((id) => ({ id })));
  }

  function suppressNextPushClick() {
    suppressPushClick = true;
    window.setTimeout(() => { suppressPushClick = false; }, 450);
  }

  function makeDashPlaceholder(wrap) {
    const hole = document.createElement('div');
    hole.className = 'push-card-wrap is-placeholder';
    hole.style.minHeight = `${Math.max(88, wrap.getBoundingClientRect().height)}px`;
    return hole;
  }

  function cleanupDashDrag(wrap) {
    const host = $('push-dash');
    if (host && dashPlaceholder && wrap) {
      host.insertBefore(wrap, dashPlaceholder);
    }
    dashPlaceholder?.remove();
    dashPlaceholder = null;
    dashDragWrap = null;
    wrap?.classList.remove('is-dragging');
    document.body.classList.remove('is-dash-dragging');
    suppressNextPushClick();
  }

  function makePushCard(command, { library = false, onDash = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'push-card-wrap';
    wrap.dataset.id = command.id;
    const card = document.createElement(library ? 'button' : 'div');
    if (library) card.type = 'button';
    else {
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
    }
    card.className = `push-card${library && !onDash ? ' is-add' : ''}${library && onDash ? ' is-on' : ''}`;
    const icon = window.pushIconSvg ? window.pushIconSvg(command.icon) : '';
    const iconHtml = `<span class="push-card-icon" aria-hidden="true">${icon}</span>`;
    const titleHtml = `<strong>${escapeHtml(command.title)}</strong>`;
    const subHtml = `<span>${library && onDash ? 'On your tiles · tap to remove' : (command.subtitle || command.group)}</span>`;
    if (library) {
      card.innerHTML = iconHtml + titleHtml + subHtml;
    } else {
      card.innerHTML = `<div class="push-card-top">`
        + `<div class="push-card-lead">${iconHtml}`
        + '<button type="button" class="push-card-handle" title="Drag to reorder" aria-label="Drag to reorder">'
        + '<span class="push-card-grip" aria-hidden="true"></span></button></div>'
        + `<button type="button" class="push-card-remove" aria-label="Remove ${escapeHtml(command.title)}">×</button>`
        + '</div>'
        + titleHtml
        + subHtml;
    }
    const activate = async () => {
      if (suppressPushClick || wrap.classList.contains('is-dragging')) return;
      try {
        if (library) await toggleLibraryTile(command);
        else await pushCommand(command);
      } catch (error) {
        toast(error.message);
      }
    };
    card.addEventListener('click', (event) => {
      if (event.target.closest('.push-card-handle, .push-card-remove')) return;
      activate();
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    wrap.appendChild(card);
    if (!library) {
      const handle = card.querySelector('.push-card-handle');
      const remove = card.querySelector('.push-card-remove');
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeDashTile(command.id).catch((error) => toast(error.message));
      });
      bindDashReorder(wrap, handle);
    }
    return wrap;
  }

  function bindDashReorder(wrap, handle) {
    if (!handle) return;
    handle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    if (coarsePointer()) bindCoarseDashDrag(wrap, handle);
    else bindFineDashDrag(wrap, handle);
  }

  function bindFineDashDrag(wrap, handle) {
    handle.draggable = true;
    handle.addEventListener('dragstart', (event) => {
      event.stopPropagation();
      dashDragWrap = wrap;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', wrap.dataset.id);
      try { event.dataTransfer.setDragImage(wrap, 24, 24); } catch { /* Safari */ }
      wrap.classList.add('is-dragging');
      document.body.classList.add('is-dash-dragging');
      dashPlaceholder = makeDashPlaceholder(wrap);
      wrap.after(dashPlaceholder);
    });
    handle.addEventListener('dragend', async () => {
      cleanupDashDrag(wrap);
      try {
        await commitDashOrder();
      } catch (error) {
        toast(error.message);
      }
    });
  }

  function bindCoarseDashDrag(wrap, handle) {
    handle.addEventListener('pointerdown', (event) => startDashDrag(event, wrap, handle));
  }

  function startDashDrag(event, wrap, handle) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (wrap.classList.contains('is-dragging')) return;
    event.preventDefault();
    event.stopPropagation();
    const host = $('push-dash');
    if (!host) return;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    dashPlaceholder = makeDashPlaceholder(wrap);
    wrap.after(dashPlaceholder);
    wrap.classList.add('is-dragging');
    document.body.classList.add('is-dash-dragging');
    const ghost = wrap.cloneNode(true);
    ghost.classList.add('push-card-ghost');
    ghost.classList.remove('is-dragging');
    ghost.style.width = `${wrap.offsetWidth}px`;
    document.body.appendChild(ghost);
    const moveGhost = (x, y) => {
      ghost.style.transform = `translate(${x - wrap.offsetWidth / 2}px, ${y - 36}px)`;
    };
    moveGhost(event.clientX, event.clientY);
    const onMove = (move) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      moveGhost(move.clientX, move.clientY);
      placeDashCard(host, dashPlaceholder, move.clientX, move.clientY);
    };
    const finish = async () => {
      ghost.remove();
      handle.releasePointerCapture?.(pointerId);
      cleanupDashDrag(wrap);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      try {
        await commitDashOrder();
      } catch (error) {
        toast(error.message);
      }
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function bindDashHost() {
    const host = $('push-dash');
    if (!host || host.dataset.boundDrag) return;
    host.dataset.boundDrag = '1';
    host.addEventListener('dragenter', (event) => {
      if (!dashPlaceholder) return;
      event.preventDefault();
    });
    host.addEventListener('dragover', (event) => {
      if (!dashPlaceholder) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      placeDashCard(host, dashPlaceholder, event.clientX, event.clientY);
    });
    host.addEventListener('drop', (event) => {
      if (!dashPlaceholder) return;
      event.preventDefault();
    });
  }

  function renderDash() {
    const host = $('push-dash');
    if (!host) return;
    const q = String($('push-search')?.value || '').toLowerCase();
    const ids = (me?.dashboardTiles || []).map((tile) => tile.id);
    const list = ids
      .map(commandById)
      .filter(Boolean)
      .filter((command) => kindMatch(command, pushKind))
      .filter((command) => !q || haystack(command).includes(q));
    host.innerHTML = '';
    list.forEach((command) => host.appendChild(makePushCard(command)));
    const empty = $('push-dash-empty');
    if (empty) {
      empty.hidden = list.length > 0;
      empty.textContent = (me?.dashboardTiles || []).length
        ? 'Nothing in your tiles matches that search.'
        : 'Add tiles from the library, then tap one to push it.';
    }
  }

  function filteredLibrary() {
    const q = String($('lib-search')?.value || '').toLowerCase();
    return commands
      .filter((command) => command.pushable)
      .filter((command) => kindMatch(command, libKind))
      .filter((command) => !q || haystack(command).includes(q))
      .filter((command) => libCategory === 'all' || command.pushCategory === libCategory);
  }

  function renderLibCats(counts) {
    const host = $('lib-cats');
    if (!host) return;
    host.innerHTML = '';
    const buttons = [{ id: 'all', label: 'All' }, ...PUSH_CATEGORIES];
    buttons.forEach((entry) => {
      const count = entry.id === 'all'
        ? PUSH_CATEGORIES.reduce((sum, cat) => sum + (counts[cat.id] || 0), 0)
        : (counts[entry.id] || 0);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.cat = entry.id;
      btn.classList.toggle('active', libCategory === entry.id);
      btn.textContent = entry.id === 'all' ? 'All' : `${entry.label}`;
      if (count) {
        const badge = document.createElement('span');
        badge.className = 'su-cat-count';
        badge.textContent = ` ${count}`;
        btn.appendChild(badge);
      }
      btn.hidden = entry.id !== 'all' && count === 0 && libCategory !== entry.id;
      btn.addEventListener('click', () => {
        libCategory = entry.id;
        renderLibrary();
      });
      host.appendChild(btn);
    });
  }

  function renderLibrary() {
    const host = $('push-lib');
    if (!host) return;
    const list = filteredLibrary();
    const onDash = new Set((me?.dashboardTiles || []).map((tile) => tile.id));
    const counts = Object.fromEntries(PUSH_CATEGORIES.map((entry) => [entry.id, 0]));
    commands
      .filter((command) => command.pushable)
      .filter((command) => kindMatch(command, libKind))
      .filter((command) => {
        const q = String($('lib-search')?.value || '').toLowerCase();
        return !q || haystack(command).includes(q);
      })
      .forEach((command) => {
        if (counts[command.pushCategory] != null) counts[command.pushCategory] += 1;
      });
    renderLibCats(counts);
    host.innerHTML = '';
    const groups = libCategory === 'all'
      ? PUSH_CATEGORIES.filter((entry) => counts[entry.id] > 0)
      : PUSH_CATEGORIES.filter((entry) => entry.id === libCategory);
    groups.forEach((entry) => {
      const hits = list.filter((command) => command.pushCategory === entry.id);
      if (!hits.length) return;
      const block = document.createElement('div');
      block.className = 'push-lib-group';
      block.innerHTML = `<h3 class="su-h">${entry.label}</h3>`;
      const grid = document.createElement('div');
      grid.className = 'push-grid';
      hits.forEach((command) => {
        grid.appendChild(makePushCard(command, { library: true, onDash: onDash.has(command.id) }));
      });
      block.appendChild(grid);
      host.appendChild(block);
    });
    const empty = $('push-lib-empty');
    if (empty) empty.hidden = list.length > 0;
  }

  function fillTargets() {
    const select = $('push-target');
    if (!select) return;
    const extras = displays.map((row) => `<option value="${row.id}">${row.name || row.id}</option>`).join('');
    select.innerHTML = `<option value="*">All displays</option><option value="vestaboard">Vestaboard</option><option value="full">Software</option>${extras}`;
  }

  function bindKind(id, setter) {
    $(id)?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-kind]');
      if (!btn) return;
      $(id).querySelectorAll('button').forEach((node) => node.classList.toggle('active', node === btn));
      setter(btn.dataset.kind);
    });
  }

  function currentAvatar() {
    return pendingAvatar || me?.avatar || { kind: 'template', id: 'cat-sky' };
  }

  function avatarPreviewUrl(avatar) {
    if (avatar?.kind === 'upload' && avatar.id) return `/user-avatars/${avatar.id}`;
    return `/user/avatars/${avatar?.id || 'cat-sky'}.svg`;
  }

  function renderAvatars() {
    const host = $('avatar-grid');
    if (!host || !me) return;
    const selected = currentAvatar();
    host.innerHTML = '';
    (window.SIGNAL_AVATARS || []).forEach((row) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.toggle('active', selected.kind === 'template' && selected.id === row.id);
      btn.innerHTML = `<img src="/user/avatars/${row.id}.svg" alt="${row.label}">`;
      btn.addEventListener('click', () => {
        pendingAvatar = { kind: 'template', id: row.id };
        if ($('su-avatar')) $('su-avatar').src = avatarPreviewUrl(pendingAvatar);
        renderAvatars();
      });
      host.appendChild(btn);
    });
  }

  function applyMe() {
    if (!me) return;
    window.SIGNAL_GUESTBOOK_NAME = me.firstName || me.username;
    $('su-hello').textContent = `Hi, ${me.firstName || me.username}`;
    $('su-sub').textContent = me.isAdmin ? 'Admin' : 'Household';
    if (me.avatarUrl) $('su-avatar').src = me.avatarUrl;
    $('pf-first').value = me.firstName || (me.bootstrap ? 'Admin' : '');
    $('pf-last').value = me.lastName || '';
    $('pf-email').value = me.email || '';
    if ($('pf-email')) $('pf-email').disabled = me.bootstrap === true;
    if ($('pf-env-hint')) $('pf-env-hint').hidden = me.bootstrap !== true;
    if ($('pf-password-block')) $('pf-password-block').hidden = me.bootstrap === true;
    const canFlight = me.isAdmin || me.permissions?.flightPlan;
    const canSlides = me.isAdmin || me.permissions?.slideshow;
    const canDates = me.isAdmin || me.permissions?.redLetter;
    document.querySelector('[data-tab="flight"]').hidden = !canFlight;
    document.querySelector('[data-tab="slideshow"]').hidden = !canSlides;
    document.querySelector('[data-tab="dates"]').hidden = !canDates;
    $('tab-flight').hidden = !canFlight;
    $('tab-slideshow').hidden = !canSlides;
    $('tab-dates').hidden = !canDates;
    renderAvatars();
    renderDash();
  }

  function openGameSession(session) {
    const name = encodeURIComponent(me.firstName || me.username || '');
    window.open(`/games/?code=${encodeURIComponent(session.code)}&name=${name}`, '_blank', 'noopener');
  }

  async function loadGames() {
    const data = await api('/api/user/games');
    const host = $('games-list');
    const rows = data.sessions || [];
    $('games-empty').hidden = rows.length > 0;
    host.innerHTML = '';
    rows.forEach((session) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'game-card';
      const mins = Math.floor((session.startedAgoSeconds || 0) / 60);
      card.innerHTML = `<strong>${escapeHtml(session.game || session.gameType || 'Game')}</strong>
        <span>Code ${escapeHtml(session.code)} · ${escapeHtml(session.phase || '')}${session.lobby ? ' · lobby' : ''} · ${session.playerCount || 0} players · ${mins}m</span>
        <span class="su-btn su-btn-sm">Join now</span>`;
      card.addEventListener('click', () => openGameSession(session));
      host.appendChild(card);
    });
  }

  function startGamesPoll() {
    stopGamesPoll();
    gamesPollTimer = window.setInterval(() => {
      if (document.body.dataset.tab !== 'games') return;
      loadGames().catch(() => {});
    }, GAMES_POLL_MS);
  }

  function stopGamesPoll() {
    if (!gamesPollTimer) return;
    window.clearInterval(gamesPollTimer);
    gamesPollTimer = null;
  }

  async function loadTrips() {
    const data = await api(`/api/flightplan/trips?filter=${encodeURIComponent(tripFilter)}`);
    const host = $('trip-list');
    host.innerHTML = '';
    (data.trips || []).forEach((trip) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'manage-card';
      card.innerHTML = `<strong>${trip.name}</strong><span>${trip.startDate || ''} ${trip.endDate || ''}</span>`;
      card.addEventListener('click', () => openTrip(trip.id));
      host.appendChild(card);
    });
  }

  async function openTrip(id) {
    openTripId = id;
    const data = await api(`/api/flightplan/trips/${id}`);
    $('trip-sheet').hidden = false;
    $('trip-sheet-title').textContent = data.trip?.name || 'Trip';
    $('trip-name').value = data.trip?.name || '';
    $('trip-start').value = data.trip?.startDate || '';
    $('trip-end').value = data.trip?.endDate || '';
    $('trip-detail').hidden = false;
    const host = $('flight-list');
    host.innerHTML = (data.flights || []).map((flight) => (
      `<div class="manage-card"><strong>${flight.airline || ''} ${flight.number || ''}</strong><span>${flight.origin || ''} → ${flight.destination || ''}</span></div>`
    )).join('') || '<p class="hint">No flights yet.</p>';
  }

  function photoImageUrl(photo, { thumb = false } = {}) {
    const raw = thumb ? (photo?.thumbPath || photo?.path || '') : (photo?.path || '');
    return raw || '';
  }

  function photosToSlideshowEntries(list) {
    return (list || []).map((p) => ({
      url: new URL(p.path, document.baseURI).href,
      uploadedAt: p.createdAt,
    }));
  }

  function formatUploadedAt(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function updateSelectionUi() {
    document.querySelectorAll('#photo-grid .photo-thumb').forEach((cell) => {
      cell.classList.toggle('selected', slideshowSelected.has(cell.dataset.token));
    });
    if ($('slideshow-selected-count')) {
      $('slideshow-selected-count').textContent = String(slideshowSelected.size);
    }
    if ($('btn-slideshow-delete-selected')) {
      $('btn-slideshow-delete-selected').disabled = slideshowSelected.size === 0;
    }
    const allSelected = photos.length > 0 && slideshowSelected.size === photos.length;
    if ($('btn-slideshow-select-all')) {
      $('btn-slideshow-select-all').textContent = allSelected ? 'Unselect All' : 'Select All';
    }
  }

  function setSelectingMode(on) {
    slideshowSelecting = on;
    if (!on) slideshowSelected.clear();
    if ($('btn-slideshow-select')) $('btn-slideshow-select').hidden = on;
    if ($('slideshow-toolbar-selecting')) $('slideshow-toolbar-selecting').hidden = !on;
    renderPhotoGrid();
    updateSelectionUi();
  }

  function toggleSelected(token) {
    if (slideshowSelected.has(token)) slideshowSelected.delete(token);
    else slideshowSelected.add(token);
    updateSelectionUi();
  }

  function showLightboxPhoto(index) {
    if (index < 0 || index >= photos.length) return;
    lightboxIndex = index;
    const photo = photos[index];
    $('lightbox-img').src = photoImageUrl(photo);
    $('lightbox-uploaded-at').textContent = photo.createdAt ? `Uploaded ${formatUploadedAt(photo.createdAt)}` : '';
    $('lightbox-counter').textContent = photos.length > 1
      ? `Photo ${index + 1} of ${photos.length}`
      : '';
    const prev = $('btn-lightbox-prev');
    const next = $('btn-lightbox-next');
    if (prev) {
      prev.disabled = index <= 0;
      prev.hidden = photos.length <= 1;
    }
    if (next) {
      next.disabled = index >= photos.length - 1;
      next.hidden = photos.length <= 1;
    }
  }

  function openLightbox(photo) {
    const index = photos.findIndex((row) => row.token === photo.token);
    showLightboxPhoto(index >= 0 ? index : 0);
    $('photo-lightbox').hidden = false;
  }

  function closeLightbox() {
    $('photo-lightbox').hidden = true;
    lightboxIndex = -1;
    if ($('lightbox-img')) $('lightbox-img').src = '';
  }

  function stepLightbox(delta) {
    if ($('photo-lightbox')?.hidden || lightboxIndex < 0) return;
    showLightboxPhoto(lightboxIndex + delta);
  }

  function renderPhotoGrid() {
    const host = $('photo-grid');
    const empty = $('photo-grid-empty');
    if (!host) return;
    if (empty) empty.hidden = photos.length > 0;
    host.innerHTML = '';
    photos.forEach((photo, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-thumb';
      btn.classList.toggle('selecting', slideshowSelecting);
      btn.classList.toggle('selected', slideshowSelected.has(photo.token));
      btn.dataset.token = photo.token;
      const img = document.createElement('img');
      img.alt = 'Shared photo';
      img.loading = index < 12 ? 'eager' : 'lazy';
      img.src = photoImageUrl(photo, { thumb: true });
      img.addEventListener('error', () => {
        if (img.dataset.full) return;
        img.dataset.full = '1';
        img.src = photoImageUrl(photo);
      });
      btn.appendChild(img);
      const check = document.createElement('span');
      check.className = 'photo-thumb-check';
      btn.appendChild(check);
      btn.addEventListener('click', () => {
        if (slideshowSelecting) toggleSelected(photo.token);
        else openLightbox(photo);
      });
      host.appendChild(btn);
    });
  }

  function applyPhotos(list) {
    photos = list || [];
    const keep = new Set(photos.map((photo) => photo.token));
    [...slideshowSelected].forEach((token) => {
      if (!keep.has(token)) slideshowSelected.delete(token);
    });
    if (lightboxIndex >= photos.length) closeLightbox();
    else if (lightboxIndex >= 0) showLightboxPhoto(lightboxIndex);
    renderPhotoGrid();
    updateSelectionUi();
  }

  async function loadPhotos() {
    const data = await api('/api/photos');
    applyPhotos(data.photos || []);
  }

  function startSlideshowEvents() {
    if (slideshowEvents) return;
    try {
      slideshowEvents = new EventSource('/api/photos/events');
    } catch {
      return;
    }
    slideshowEvents.addEventListener('photos', (event) => {
      try {
        applyPhotos(JSON.parse(event.data).photos || []);
      } catch {
        // ignore a bad snapshot
      }
    });
  }

  async function deletePhotos(tokens) {
    if (!tokens.length) return;
    const ok = await askConfirm({
      title: tokens.length > 1 ? `Delete ${tokens.length} photos?` : 'Delete this photo?',
      text: 'This cannot be undone.',
    });
    if (!ok) return;
    await api('/api/photos/delete', { tokens });
    if (lightboxIndex >= 0 && tokens.includes(photos[lightboxIndex]?.token)) {
      closeLightbox();
    }
    tokens.forEach((token) => slideshowSelected.delete(token));
    await loadPhotos();
    if (slideshowSelecting && !slideshowSelected.size) setSelectingMode(false);
    toast(tokens.length > 1 ? `${tokens.length} photos deleted` : 'Photo deleted');
  }

  async function loadDates() {
    const data = await api('/api/date-book/events');
    const host = $('date-list');
    const events = data.events || [];
    if ($('date-empty')) $('date-empty').hidden = events.length > 0;
    if ($('date-summary')) {
      $('date-summary').textContent = events.length
        ? `${events.length} event${events.length === 1 ? '' : 's'}. Yearly dates roll forward; one-offs drop off once they pass.`
        : 'Birthdays, holidays, and the dates you want counted down.';
    }
    host.innerHTML = '';
    events.forEach((event) => {
      const next = event.next || {};
      const when = formatYmd(next.date || event.date);
      const away = daysLabel(next);
      const schedule = dateScheduleLabel(event);
      const badges = [
        next.isToday ? '<span class="date-badge is-today">Today</span>' : '',
        event.recurring ? '<span class="date-badge is-yearly">Yearly</span>' : '',
        event.schedule === 'weekday' ? '<span class="date-badge is-yearly">Weekday</span>' : '',
        next.expired ? '<span class="date-badge">Passed</span>' : '',
      ].filter(Boolean).join('');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'date-card';
      btn.innerHTML = `
        <div class="date-card-top">
          <strong class="date-card-name">${escapeHtml(event.name || 'Event')}</strong>
          <span class="date-card-badges">${badges}</span>
        </div>
        <span class="date-card-when">${escapeHtml(when)}${away ? ` · ${escapeHtml(away)}` : ''}</span>
        <span class="date-card-meta">${escapeHtml([schedule, event.time && event.time !== '00:00' ? event.time : '', event.message].filter(Boolean).join(' · '))}</span>`;
      btn.addEventListener('click', () => openDate(event));
      host.appendChild(btn);
    });
  }

  /**
   * The day-of card is either house confetti (no layout) or one of the shared
   * themes. Artwork someone painted flap-by-flap in the admin designer matches
   * no theme, so it stays selected as-is until a theme is picked over it.
   */
  function applyDateTheme(name, { paint = true } = {}) {
    const presets = window.RED_LETTER_PRESETS;
    if (paint) {
      dateLayout = name && name !== 'default' && presets ? presets.presetCells(name) : null;
    }
    const matched = name || (dateLayout ? '' : 'default');
    document.querySelectorAll('[data-date-theme]').forEach((button) => {
      button.classList.toggle('active', button.dataset.dateTheme === matched);
    });
    const hint = $('date-theme-hint');
    if (hint) hint.hidden = Boolean(matched);
  }

  function syncDatePreviewTabs(card) {
    datePreviewCard = card === 'dayOf' ? 'dayOf' : 'countdown';
    document.querySelectorAll('[data-date-preview]').forEach((button) => {
      button.classList.toggle('active', button.dataset.datePreview === datePreviewCard);
    });
  }

  function setDatePreviewCard(card) {
    syncDatePreviewTabs(card);
    previewDate();
  }

  function openDate(event) {
    dateDraft = event || {};
    dateSelectedId = event?.id || '';
    $('date-sheet').hidden = false;
    $('date-sheet-title').textContent = dateSelectedId ? 'Edit event' : 'New event';
    $('date-name').value = event?.name || '';
    $('date-date').value = event?.date || '';
    $('date-time').value = event?.time && event.time !== '00:00' ? event.time : '';
    $('date-message').value = event?.message || '';
    $('date-recurring').checked = event?.recurring === true;
    $('btn-date-delete').hidden = !dateSelectedId;
    const saved = event?.layout?.cells;
    dateLayout = Array.isArray(saved) && saved.length && window.RED_LETTER_PRESETS
      ? window.RED_LETTER_PRESETS.cloneCells(saved)
      : null;
    applyDateTheme(
      dateLayout ? (window.RED_LETTER_PRESETS?.matchPreset(dateLayout) || '') : 'default',
      { paint: false },
    );
    syncDatePreviewTabs('countdown');
    const schedule = dateScheduleLabel(event || {});
    if ($('date-schedule-hint')) {
      $('date-schedule-hint').hidden = !schedule;
      $('date-schedule-hint').textContent = schedule
        ? `This is a weekday rule (${schedule}). Saving keeps that schedule.`
        : '';
    }
    previewDate();
  }

  function dateFormDraft() {
    return {
      name: $('date-name').value,
      date: $('date-date').value,
      message: $('date-message').value,
      time: $('date-time').value || undefined,
      recurring: $('date-recurring').checked,
      schedule: dateDraft.schedule,
      ordinal: dateDraft.ordinal,
      weekday: dateDraft.weekday,
      month: dateDraft.month,
      layout: dateLayout ? { cells: dateLayout } : null,
    };
  }

  async function previewDate() {
    try {
      const data = await api('/api/date-book/preview', {
        eventId: dateSelectedId || undefined,
        event: dateFormDraft(),
      });
      const card = datePreviewCard === 'dayOf' ? data.dayOf : data.countdown;
      const rows = card?.rows || data.countdown?.rows || data.dayOf?.rows || data.rows;
      if (rows && window.renderFlapGrid) {
        window.renderFlapGrid($('date-preview'), rows, { interactive: false });
      }
    } catch {
      // preview is best-effort
    }
  }

  async function boot() {
    document.body.dataset.tab = 'main';
    applyPointerMode();
    window.matchMedia('(pointer: coarse)').addEventListener('change', applyPointerMode);
    bindDashHost();
    const session = await api('/api/user/me');
    me = session.user;
    window.SIGNAL_AVATARS = session.templates || [];
    applyMe();
    const [catalog, displayData] = await Promise.all([
      api('/api/user/commands'),
      api('/api/displays').catch(() => ({ displays: [] })),
    ]);
    commands = catalog.commands || [];
    displays = displayData.displays || [];
    fillTargets();
    renderDash();
    window.userBoard = window.VestaboardSimUi.createVestaboardSimUi({
      fetchJson: api,
      toast,
      watching: () => Boolean($('tab-board')?.classList.contains('active')) && !document.hidden,
    });
    window.userBoard.mount();
    renderLibrary();
  }

  document.querySelectorAll('#su-tabs [data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
  bindKind('push-kind', (kind) => { pushKind = kind; renderDash(); });
  bindKind('lib-kind', (kind) => { libKind = kind; renderLibrary(); });
  $('push-search')?.addEventListener('input', renderDash);
  $('lib-search')?.addEventListener('input', renderLibrary);
  $('btn-push-library')?.addEventListener('click', () => {
    $('push-library').hidden = false;
    renderLibrary();
  });
  $('btn-push-library-close')?.addEventListener('click', () => { $('push-library').hidden = true; });
  $('push-library')?.addEventListener('click', (event) => {
    if (event.target === $('push-library')) $('push-library').hidden = true;
  });
  $('btn-games-refresh')?.addEventListener('click', () => loadGames().catch((error) => toast(error.message)));
  $('btn-profile-save')?.addEventListener('click', async () => {
    try {
      const saved = await api('/api/user/profile', {
        firstName: $('pf-first').value,
        lastName: $('pf-last').value,
        email: me?.bootstrap ? undefined : $('pf-email').value,
        avatar: pendingAvatar || undefined,
      });
      me = saved.user;
      pendingAvatar = null;
      applyMe();
      toast('Profile saved');
    } catch (error) {
      toast(error.message);
    }
  });
  $('pf-upload')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const saved = await api('/api/user/avatar', { image: reader.result });
        me = saved.user;
        applyMe();
      } catch (error) {
        toast(error.message);
      }
    };
    reader.readAsDataURL(file);
  });
  $('btn-password')?.addEventListener('click', async () => {
    const next = String($('pf-new')?.value || '');
    const confirm = String($('pf-new-confirm')?.value || '');
    if (!next) {
      toast('Enter a new password');
      return;
    }
    if (next !== confirm) {
      toast('New passwords do not match');
      return;
    }
    try {
      await api('/api/user/password', {
        currentPassword: $('pf-current').value,
        password: next,
      });
      $('pf-current').value = '';
      $('pf-new').value = '';
      if ($('pf-new-confirm')) $('pf-new-confirm').value = '';
      toast('Password changed');
    } catch (error) {
      toast(error.message);
    }
  });
  function openProfile() {
    pendingAvatar = null;
    renderAvatars();
    $('profile-sheet').hidden = false;
  }

  function closeProfile() {
    pendingAvatar = null;
    applyMe();
    if ($('profile-sheet')) $('profile-sheet').hidden = true;
  }

  $('btn-profile')?.addEventListener('click', openProfile);
  $('btn-profile-close')?.addEventListener('click', closeProfile);
  $('profile-sheet')?.addEventListener('click', (event) => {
    if (event.target === $('profile-sheet')) closeProfile();
  });
  $('su-avatar')?.addEventListener('click', openProfile);
  $('btn-logout')?.addEventListener('click', async () => {
    await api('/api/user/logout', {});
    location.href = '/';
  });
  $('trip-filter')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-filter]');
    if (!btn) return;
    tripFilter = btn.dataset.filter;
    $('trip-filter').querySelectorAll('button').forEach((node) => node.classList.toggle('active', node === btn));
    loadTrips();
  });
  $('btn-trip-new')?.addEventListener('click', () => {
    openTripId = '';
    $('trip-sheet').hidden = false;
    $('trip-sheet-title').textContent = 'New trip';
    $('trip-name').value = '';
    $('trip-start').value = '';
    $('trip-end').value = '';
    $('trip-detail').hidden = true;
  });
  $('btn-trip-close')?.addEventListener('click', () => { $('trip-sheet').hidden = true; });
  $('btn-trip-save')?.addEventListener('click', async () => {
    try {
      const body = {
        name: $('trip-name').value,
        startDate: $('trip-start').value || undefined,
        endDate: $('trip-end').value || undefined,
      };
      if (openTripId) await api(`/api/flightplan/trips/${openTripId}`, body, 'PUT');
      else {
        const created = await api('/api/flightplan/trips', body);
        openTripId = created.trip?.id || '';
      }
      toast('Trip saved');
      await loadTrips();
      if (openTripId) await openTrip(openTripId);
    } catch (error) {
      toast(error.message);
    }
  });
  $('btn-flight-search')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/flightplan/search', {
        airline: $('flight-airline').value,
        number: $('flight-number').value,
        date: $('flight-date').value,
      });
      const host = $('flight-results');
      host.innerHTML = '';
      (data.flights || data.legs || []).forEach((leg) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'manage-card';
        btn.textContent = `${leg.airline || ''} ${leg.number || ''} ${leg.origin || ''} → ${leg.destination || ''}`;
        btn.addEventListener('click', async () => {
          await api(`/api/flightplan/trips/${openTripId}/flights/import`, { leg });
          await openTrip(openTripId);
        });
        host.appendChild(btn);
      });
    } catch (error) {
      toast(error.message);
    }
  });
  $('btn-slideshow-select')?.addEventListener('click', () => setSelectingMode(true));
  $('btn-slideshow-cancel-select')?.addEventListener('click', () => setSelectingMode(false));
  $('btn-slideshow-select-all')?.addEventListener('click', () => {
    const allSelected = photos.length > 0 && slideshowSelected.size === photos.length;
    if (allSelected) slideshowSelected.clear();
    else photos.forEach((photo) => slideshowSelected.add(photo.token));
    updateSelectionUi();
  });
  $('btn-slideshow-delete-selected')?.addEventListener('click', async () => {
    if (!slideshowSelected.size) return;
    try {
      await deletePhotos([...slideshowSelected]);
    } catch (error) {
      toast(error.message);
    }
  });
  $('btn-slideshow-refresh')?.addEventListener('click', () => {
    loadPhotos().catch((error) => toast(error.message));
  });
  $('btn-slideshow-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const chosen = slideshowSelecting
      ? photos.filter((photo) => slideshowSelected.has(photo.token))
      : photos;
    const entries = photosToSlideshowEntries(chosen);
    if (!entries.length) return toast('No photos to show');
    button.disabled = true;
    try {
      await api('/api/push/photo-slideshow', targetBody({ photos: entries }));
      toast(entries.length === 1 ? 'Photo sent to display' : `Slideshow sent (${entries.length} photos)`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $('btn-lightbox-close')?.addEventListener('click', closeLightbox);
  $('btn-lightbox-cancel')?.addEventListener('click', closeLightbox);
  $('btn-lightbox-prev')?.addEventListener('click', (event) => {
    event.stopPropagation();
    stepLightbox(-1);
  });
  $('btn-lightbox-next')?.addEventListener('click', (event) => {
    event.stopPropagation();
    stepLightbox(1);
  });
  $('photo-lightbox')?.addEventListener('click', (event) => {
    if (event.target === $('photo-lightbox')) closeLightbox();
  });
  $('btn-lightbox-delete')?.addEventListener('click', async () => {
    const token = photos[lightboxIndex]?.token;
    if (!token) return;
    try {
      await deletePhotos([token]);
    } catch (error) {
      toast(error.message);
    }
  });
  $('btn-lightbox-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const photo = photos[lightboxIndex];
    if (!photo) return toast('No photo open');
    button.disabled = true;
    try {
      await api('/api/push/photo-slideshow', targetBody({ photos: photosToSlideshowEntries([photo]) }));
      toast('Photo sent to display');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $('su-confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
  $('su-confirm-ok')?.addEventListener('click', () => closeConfirm(true));
  $('su-confirm-sheet')?.addEventListener('click', (event) => {
    if (event.target === $('su-confirm-sheet')) closeConfirm(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('su-confirm-sheet')?.hidden) closeConfirm(false);
      else if (!$('photo-lightbox')?.hidden) closeLightbox();
      else if (!$('date-sheet')?.hidden) $('date-sheet').hidden = true;
      else if (!$('profile-sheet')?.hidden) closeProfile();
      else if (!$('push-library')?.hidden) $('push-library').hidden = true;
      else if (slideshowSelecting) {
        event.preventDefault();
        setSelectingMode(false);
      }
    }
    if ($('photo-lightbox')?.hidden) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepLightbox(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(1);
    }
  });
  $('btn-date-new')?.addEventListener('click', () => openDate({}));
  $('btn-date-close')?.addEventListener('click', () => { $('date-sheet').hidden = true; });
  $('date-sheet')?.addEventListener('click', (event) => {
    if (event.target === $('date-sheet')) $('date-sheet').hidden = true;
  });
  $('btn-date-save')?.addEventListener('click', async () => {
    try {
      const body = dateFormDraft();
      if (dateSelectedId) await api(`/api/date-book/events/${dateSelectedId}`, body, 'PUT');
      else await api('/api/date-book/events', body);
      $('date-sheet').hidden = true;
      await loadDates();
      toast('Event saved');
    } catch (error) {
      toast(error.message);
    }
  });
  $('btn-date-delete')?.addEventListener('click', async () => {
    if (!dateSelectedId) return;
    const ok = await askConfirm({
      title: `Delete ${$('date-name').value || 'this event'}?`,
      text: 'This cannot be undone.',
    });
    if (!ok) return;
    try {
      await fetch(`/api/date-book/events/${dateSelectedId}`, { method: 'DELETE', credentials: 'same-origin' });
      $('date-sheet').hidden = true;
      await loadDates();
      toast('Event deleted');
    } catch (error) {
      toast(error.message);
    }
  });
  ['date-name', 'date-date', 'date-time', 'date-message'].forEach((id) => {
    $(id)?.addEventListener('input', previewDate);
  });
  $('date-recurring')?.addEventListener('change', previewDate);
  $('date-theme')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-date-theme]');
    if (!button) return;
    applyDateTheme(button.dataset.dateTheme);
    setDatePreviewCard('dayOf');
  });
  $('date-preview-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-date-preview]');
    if (button) setDatePreviewCard(button.dataset.datePreview);
  });

  boot().catch((error) => {
    toast(error.message || 'Sign in required');
    if (/sign in|unauthorized|no_session/i.test(error.message || '')) {
      location.href = '/';
    }
  });
})();
