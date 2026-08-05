/* Signal Bridge — control page logic (vanilla JS, no framework) */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ API helpers

  const ALL_DISPLAYS = '*';
  const STORAGE_TARGET_KEY = 'displayControl.targetId';
  const STORAGE_TOKEN_PREFIX = 'displayControl.token.';
  // Keep in sync with DEFAULT_PIN_DIGITS in display-control-auth.js.
  const CONTROL_PIN_DIGITS = 6;

  // APIs live at the server root (`/api/...`). Root-absolute URLs ignore
  // <base href="/admin/"> so admin pages can sit under /admin/ safely.
  // Relative asset URLs (styles, jsqr) still resolve via <base>.
  function appUrl(route) {
    const path = String(route || '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
      return path;
    }
    if (path.startsWith('/api/') || path.startsWith('/qr-images/')) {
      return path;
    }
    return path.replace(/^\//, '');
  }

  function redirectToAdminLogin() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `/admin/login.html?next=${next}`;
  }

  async function apiPost(route, body = {}) {
    const response = await fetch(appUrl(route), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.status === 401 && data?.code !== 'bad_password') {
      redirectToAdminLogin();
      throw new Error(data?.error || 'Admin login required');
    }
    if (!response.ok) {
      const err = new Error(data?.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.code = data?.code;
      throw err;
    }
    return data || {};
  }

  async function apiGet(route) {
    const response = await fetch(appUrl(route), {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      redirectToAdminLogin();
      throw new Error('Admin login required');
    }
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    return response.json();
  }

  function selectedTargetId() {
    const value = $('display-select')?.value;
    return value || ALL_DISPLAYS;
  }

  function isSingleDisplaySelected() {
    const id = selectedTargetId();
    return Boolean(id) && id !== ALL_DISPLAYS;
  }

  // Client-side cap on how long an unlock lasts — after this the user must
  // re-enter a PIN even if the tab (and its sessionStorage) survived overnight.
  const CONTROL_TOKEN_TTL_MS = 60 * 60 * 1000;

  function controlTokenFor(displayId) {
    if (!displayId || displayId === ALL_DISPLAYS) {
      return '';
    }
    try {
      const raw = sessionStorage.getItem(STORAGE_TOKEN_PREFIX + displayId);
      if (!raw) {
        return '';
      }
      const entry = JSON.parse(raw);
      if (!entry?.token || Date.now() - (entry.at || 0) > CONTROL_TOKEN_TTL_MS) {
        sessionStorage.removeItem(STORAGE_TOKEN_PREFIX + displayId);
        return '';
      }
      return entry.token;
    } catch {
      // Legacy plain-string tokens (no timestamp) are treated as expired.
      try {
        sessionStorage.removeItem(STORAGE_TOKEN_PREFIX + displayId);
      } catch {
        // private mode
      }
      return '';
    }
  }

  function setControlToken(displayId, token) {
    try {
      if (!token) {
        sessionStorage.removeItem(STORAGE_TOKEN_PREFIX + displayId);
      } else {
        sessionStorage.setItem(
          STORAGE_TOKEN_PREFIX + displayId,
          JSON.stringify({ token, at: Date.now() }),
        );
      }
    } catch {
      // private mode
    }
  }

  function withTarget(body = {}) {
    const targetId = selectedTargetId();
    const out = { ...body, targetId };
    const token = controlTokenFor(targetId);
    if (token) {
      out.controlToken = token;
    }
    return out;
  }

  function isDisplayUnlocked() {
    return Boolean(controlTokenFor(selectedTargetId()));
  }

  // -------------------------------------------------------- Display picker

  let knownDisplays = [];

  function updateControlLockUi() {
    const single = isSingleDisplaySelected();
    const unlocked = single && isDisplayUnlocked();
    const unlockBtn = $('btn-display-unlock');
    if (unlockBtn) {
      unlockBtn.hidden = !single;
      unlockBtn.classList.toggle('unlocked', unlocked);
      unlockBtn.title = unlocked
        ? 'Unlocked — tap to lock this display again'
        : 'Unlock remote control with on-screen PIN';
    }
    const lock = $('control-lock');
    const grid = $('control-grid');
    if (lock && grid) {
      lock.hidden = !single || unlocked;
      grid.hidden = single && !unlocked;
    }
    // Remote tab (power actions) mirrors the Control tab: only for a single
    // selected display, and only after the on-screen PIN unlock.
    const remoteLock = $('remote-lock');
    const remoteGrid = $('remote-grid');
    if (remoteLock && remoteGrid) {
      remoteLock.hidden = !single || unlocked;
      remoteGrid.hidden = !(single && unlocked);
    }
  }

  // Re-check every minute so the lock UI snaps back when the 1h unlock expires.
  setInterval(updateControlLockUi, 60_000);

  function updateControlTabVisibility() {
    const single = isSingleDisplaySelected();
    const remoteBtn = $('tab-btn-remote');
    const controlBtn = $('tab-btn-control');
    if (remoteBtn) {
      remoteBtn.hidden = !single;
    }
    if (controlBtn) {
      controlBtn.hidden = !single;
    }
    if (!single) {
      const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab;
      if (activeTab === 'remote' || activeTab === 'control') {
        document.querySelector('.tab-btn[data-tab="push"]')?.click();
      } else {
        const remotePanel = $('tab-remote');
        const controlPanel = $('tab-control');
        if (remotePanel) {
          remotePanel.classList.remove('active');
          remotePanel.hidden = true;
        }
        if (controlPanel) {
          controlPanel.classList.remove('active');
          controlPanel.hidden = true;
        }
      }
    }
    updateControlLockUi();
    const hint = $('display-bar-hint');
    if (!hint) {
      return;
    }
    if (!knownDisplays.length) {
      hint.textContent = 'No displays yet — tap refresh after the client starts, or wait for the 5‑minute heartbeat.';
    } else if (single) {
      const entry = knownDisplays.find((d) => d.id === selectedTargetId());
      const label = entry?.label || entry?.name || 'selected display';
      if (entry?.stale) {
        hint.textContent = `${label} looks offline (no recent heartbeat).`;
      } else if (isDisplayUnlocked()) {
        hint.textContent = `Unlocked — controlling ${label}.`;
      } else {
        hint.textContent = `${label} — unlock with the on-screen PIN for mouse, keyboard, and power.`;
      }
    } else {
      hint.textContent = 'All Displays — push goes everywhere. Pick one display to unlock remote control.';
    }
  }

  function displaysFingerprint(displays) {
    return (displays || [])
      .map((d) => `${d.id}|${d.name}|${d.host || ''}|${d.stale ? 1 : 0}|${d.lastSeen || ''}`)
      .join(';');
  }

  let lastDisplaysFingerprint = '';

  function pickNewestDisplay(entries) {
    const list = Array.isArray(entries) ? [...entries] : [];
    if (!list.length) {
      return null;
    }
    list.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    return list.find((d) => !d.stale) || list[0];
  }

  function renderDisplaySelect(displays, { quiet = false } = {}) {
    const next = Array.isArray(displays) ? displays : [];
    const fingerprint = displaysFingerprint(next);
    const select = $('display-select');
    if (!select) {
      return;
    }

    // Avoid wiping the <select> (and losing focus) when nothing meaningful changed.
    if (fingerprint === lastDisplaysFingerprint && select.options.length > 0) {
      updateControlTabVisibility();
      return;
    }

    const previousIds = new Set(knownDisplays.map((d) => d.id));
    const previousCount = knownDisplays.length;
    knownDisplays = next;
    lastDisplaysFingerprint = fingerprint;

    const previous = select.value || localStorage.getItem(STORAGE_TARGET_KEY) || '';
    select.innerHTML = '';

    for (const d of knownDisplays) {
      const opt = document.createElement('option');
      opt.value = d.id; // always unique — never target by friendly name
      const label = d.label || d.name;
      opt.textContent = d.stale ? `${label} (offline?)` : label;
      select.appendChild(opt);
    }
    const allOpt = document.createElement('option');
    allOpt.value = ALL_DISPLAYS;
    allOpt.textContent = 'All Displays';
    select.appendChild(allOpt);

    const ids = new Set(knownDisplays.map((d) => d.id));
    const added = knownDisplays.filter((d) => !previousIds.has(d.id));
    const previousMissing = Boolean(previous)
      && previous !== ALL_DISPLAYS
      && !ids.has(previous);
    // Auto-select a newly announced display when we're on All Displays (or the
    // previously selected display was pruned). Don't yank selection away from
    // a still-valid single display if a second client appears.
    if (
      added.length
      && (previous === ALL_DISPLAYS || !previous || previousMissing)
    ) {
      const newest = pickNewestDisplay(added);
      select.value = newest?.id || ALL_DISPLAYS;
    } else if (previous && previous !== ALL_DISPLAYS && ids.has(previous)) {
      select.value = previous;
    } else if (previous === ALL_DISPLAYS) {
      select.value = ALL_DISPLAYS;
    } else if (knownDisplays.length) {
      select.value = knownDisplays[0].id;
    } else {
      select.value = ALL_DISPLAYS;
    }
    localStorage.setItem(STORAGE_TARGET_KEY, select.value);
    updateControlTabVisibility();

    if (!quiet && knownDisplays.length > previousCount) {
      const newest = pickNewestDisplay(added.length ? added : knownDisplays);
      if (newest) {
        toast(`Display online: ${newest.name || newest.label || newest.id}`, 'good');
      }
    } else if (!quiet && knownDisplays.length < previousCount) {
      toast('Removed offline display(s)', 'bad');
    }
  }

  async function refreshDisplays({ discover = false, quiet = false } = {}) {
    try {
      if (discover) {
        // Server waits for re-announces, then prunes silent displays.
        const data = await apiPost('/api/displays/discover');
        renderDisplaySelect(data.displays || [], { quiet });
        return data;
      }
      const data = await apiGet('/api/displays');
      renderDisplaySelect(data.displays || [], { quiet });
      return data;
    } catch (error) {
      if (discover) {
        toast(error.message || 'Discover failed', 'bad');
      }
      return null;
    }
  }

  let displayEvents = null;

  function startDisplayEvents() {
    if (displayEvents) {
      return;
    }
    try {
      displayEvents = new EventSource(appUrl('/api/displays/events'));
    } catch {
      // Fall back to polling only.
      return;
    }
    displayEvents.addEventListener('displays', (event) => {
      try {
        const data = JSON.parse(event.data);
        renderDisplaySelect(data.displays || []);
      } catch {
        // ignore malformed events
      }
    });
    displayEvents.onerror = () => {
      // Browser will retry EventSource automatically.
    };
  }

  function stopDisplayEvents() {
    if (displayEvents) {
      displayEvents.close();
      displayEvents = null;
    }
  }

  $('display-select')?.addEventListener('change', () => {
    localStorage.setItem(STORAGE_TARGET_KEY, selectedTargetId());
    updateControlTabVisibility();
  });

  $('btn-display-refresh')?.addEventListener('click', async () => {
    const btn = $('btn-display-refresh');
    btn.disabled = true;
    try {
      const data = await refreshDisplays({ discover: true });
      const removed = data?.removedIds?.length || 0;
      if (removed) {
        toast(
          removed === 1
            ? 'Removed 1 offline display'
            : `Removed ${removed} offline displays`,
          'bad',
        );
      } else {
        toast('Asked displays to announce themselves', 'good');
      }
    } finally {
      setTimeout(() => { btn.disabled = false; }, 400);
    }
  });

  // ------------------------------------------------------------------ Toast

  function toast(message, kind = '') {
    const wrap = $('toast-wrap');
    if (!wrap) {
      return;
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`.trim();
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  // ------------------------------------------------------------------- Tabs

  function activateTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      const on = panel.id === `tab-${tabId}`;
      panel.classList.toggle('active', on);
      // Belt-and-suspenders with [hidden] so nested grid/flex never paints
      // an inactive panel (e.g. Camera Roll over Control on desktop Chrome).
      panel.hidden = !on;
    });
    if (typeof closeLightbox === 'function') {
      closeLightbox();
    }
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo?.(0, 0);
    updateControlLockUi();
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
    });
  });

  // Logo / title → Push (home) from any tab.
  $('btn-app-home')?.addEventListener('click', () => {
    activateTab('push');
  });

  // Initial state: only the default active panel should be un-hidden.
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = !panel.classList.contains('active');
  });

  // ---------------------------------------------------------- Status poller

  const POLL_MS = 5000;
  let statusTimer = null;
  let lastStatus = null;

  function pillState(pill, cls, text) {
    pill.className = `status-pill ${cls}`.trim();
    pill.textContent = text;
  }

  function renderStatus(status) {
    lastStatus = status;

    $('bridge-pulse').className = 'pulse ok';
    $('bridge-status-text').textContent = 'bridge online';

    // Active browser card
    const activeCard = $('browser-active-card');
    if (status.web?.activeUrl) {
      $('active-url').textContent = status.web.activeUrl;
      activeCard.hidden = false;
    } else {
      activeCard.hidden = true;
    }

    // Alexa auth status
    const alexaPill = $('alexa-status-pill');
    const alexaAuth = status.alexa?.auth || {};
    if (alexaAuth.status === 'success') {
      pillState(alexaPill, 'ok', 'Re-authenticated');
      $('alexa-status-detail').textContent = 'Login complete — the bridge is restarting with the new session.';
    } else if (status.alexa?.status === 'ok') {
      pillState(alexaPill, 'ok', 'Connected');
      $('alexa-status-detail').textContent = 'Amazon session is healthy.';
    } else if (status.alexa?.status === 'reauth_recommended') {
      pillState(alexaPill, 'warn', 'Re-auth soon');
      $('alexa-status-detail').textContent = status.alexa.message || 'Session is aging — re-authenticate soon.';
    } else {
      pillState(alexaPill, 'bad', 'Login required');
      $('alexa-status-detail').textContent = status.alexa?.message || 'Amazon session expired — re-authenticate now.';
    }
    if (alexaAuth.status === 'error') {
      pillState(alexaPill, 'bad', 'Auth failed');
      $('alexa-status-detail').textContent = alexaAuth.error || 'Login attempt failed — try again.';
    }

    // Tesla auth status
    const teslaPill = $('tesla-status-pill');
    const teslaAuth = status.tesla?.auth || {};
    if (!status.tesla?.configured) {
      pillState(teslaPill, 'warn', 'Not configured');
      $('tesla-status-detail').textContent = 'Tesla Fleet API credentials are not configured on the bridge.';
    } else if (teslaAuth.status === 'success') {
      pillState(teslaPill, 'ok', 'Connected');
      $('tesla-status-detail').textContent = 'Tesla login complete — new session saved.';
    } else if (teslaAuth.status === 'error' || teslaAuth.status === 'timeout') {
      pillState(teslaPill, 'bad', 'Auth failed');
      $('tesla-status-detail').textContent = teslaAuth.error || 'Tesla login did not complete — try again.';
    } else if (status.tesla.status === 'ok') {
      pillState(teslaPill, 'ok', 'Connected');
      $('tesla-status-detail').textContent = 'Tesla session is healthy.';
    } else if (status.tesla.status === 'no_session') {
      pillState(teslaPill, 'warn', 'Login required');
      $('tesla-status-detail').textContent = 'No Tesla session yet — authenticate to enable live vehicle data.';
    } else {
      pillState(teslaPill, 'warn', 'Re-auth needed');
      $('tesla-status-detail').textContent = status.tesla.message || 'Tesla session needs re-authentication.';
    }

    const uptimeMin = Math.floor((status.uptimeSec || 0) / 60);
    $('bridge-meta').textContent = `Bridge uptime: ${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m`;

    // Tesla auth completion feedback while the followup link is shown
    if (teslaAuth.status === 'success' && !$('tesla-auth-followup').hidden) {
      $('tesla-auth-followup').hidden = true;
      toast('Tesla authentication complete', 'good');
    }

    // Steam auth status
    const steamPill = $('steam-status-pill');
    const steamDetail = $('steam-status-detail');
    const steamFollowup = $('steam-auth-followup');
    const steam = status.steam || {};
    const steamAuth = steam.auth || {};
    if (steamAuth.status === 'success') {
      pillState(steamPill, 'ok', 'Linked');
      if (steamDetail) {
        steamDetail.textContent = 'Steam account linked.';
      }
    } else if (steamAuth.status === 'error') {
      pillState(steamPill, 'bad', 'Auth failed');
      if (steamDetail) {
        steamDetail.textContent = steamAuth.error || steam.message || 'Steam login failed.';
      }
    } else if (steamAuth.status === 'waiting' || steamAuth.running) {
      pillState(steamPill, 'warn', 'Waiting');
      if (steamDetail) {
        steamDetail.textContent = 'Finish signing in with Steam — you will return here when it completes.';
      }
      if (steamAuth.authorizeUrl && $('steam-auth-link') && steamFollowup) {
        $('steam-auth-link').href = steamAuth.authorizeUrl;
        steamFollowup.hidden = false;
      }
    } else if (!steam.hasApiKey) {
      pillState(steamPill, 'warn', 'Need API key');
      if (steamDetail) {
        steamDetail.textContent = 'Set STEAM_API_KEY in the bridge .env, then recreate the container.';
      }
    } else if (!steam.hasSteamId) {
      pillState(steamPill, 'warn', 'Link account');
      const keySrc = steam.apiKeySource === 'env' ? 'from .env' : 'saved in session';
      if (steamDetail) {
        steamDetail.textContent = `API key ready (${keySrc}) — authenticate with Steam to link your SteamID.`;
      }
    } else if (
      steam.status === 'playing'
      || steam.status === 'playing_presence'
      || steam.status === 'playing_recent'
    ) {
      pillState(steamPill, 'ok', 'Now playing');
      const host = steam.session?.host || 'allowed PC';
      const lagNote = steam.status === 'playing_presence'
        ? ' (presence hint — Steam profile catching up)'
        : steam.status === 'playing_recent'
          ? ' (OwnedGames beyond idle baseline)'
          : '';
      const hostLabel = host && host !== 'any' ? host : 'any PC';
      if (steamDetail) {
        steamDetail.textContent = `Playing on ${hostLabel}${lagNote}`
          + (steam.session?.suppressed ? ' (suppressed by another overlay)' : '');
      }
    } else if (steam.status === 'playing_elsewhere') {
      pillState(steamPill, 'warn', 'Other PC');
      if (steamDetail) {
        steamDetail.textContent = steam.message
          || 'Steam shows a game, but host filtering is on and no allowlisted presence was seen.';
      }
    } else if (steam.status === 'suppressed') {
      pillState(steamPill, 'warn', 'Suppressed');
      if (steamDetail) {
        steamDetail.textContent = 'Game still running — overlay hidden until a new Steam session.';
      }
    } else if (steam.status === 'api_error') {
      pillState(steamPill, 'bad', 'API error');
      if (steamDetail) {
        steamDetail.textContent = steam.message || 'Steam API request failed.';
      }
    } else {
      pillState(steamPill, 'ok', 'Ready');
      const watch = steam.requirePresence
        ? `Watching ${(steam.allowedHosts || []).join(', ') || 'allowlisted hosts'} only.`
        : 'Watching any PC (Steam account in-game).';
      if (steamDetail) {
        steamDetail.textContent = `Linked${steam.personaName ? ` as ${steam.personaName}` : ''}. ${watch}`;
      }
    }

    // PSN auth status
    const psnPill = $('psn-status-pill');
    const psnDetail = $('psn-status-detail');
    const psn = status.psn || {};
    if (!psn.configured) {
      pillState(psnPill, 'warn', 'Link account');
      if (psnDetail) {
        psnDetail.textContent = 'Paste an NPSSO cookie below to link PlayStation Network.';
      }
    } else if (psn.status === 'playing') {
      pillState(psnPill, 'ok', 'Now playing');
      if (psnDetail) {
        psnDetail.textContent = `Playing${psn.onlineId ? ` as ${psn.onlineId}` : ''}`
          + (psn.session?.suppressed ? ' (suppressed by another overlay)' : '');
      }
    } else if (psn.status === 'suppressed') {
      pillState(psnPill, 'warn', 'Suppressed');
      if (psnDetail) {
        psnDetail.textContent = 'Game still running — overlay hidden until restore or a new session.';
      }
    } else if (psn.status === 'auth_error' || psn.status === 'api_error') {
      pillState(psnPill, 'bad', 'Auth error');
      if (psnDetail) {
        psnDetail.textContent = psn.message || 'PSN token/API failed — paste a fresh NPSSO.';
      }
    } else {
      pillState(psnPill, 'ok', 'Ready');
      if (psnDetail) {
        psnDetail.textContent = `Linked${psn.onlineId ? ` as ${psn.onlineId}` : ''}. Watching PSN presence (PS5/PS4).`;
      }
    }

    if (steamAuth.status === 'success' && steamFollowup && !steamFollowup.hidden) {
      steamFollowup.hidden = true;
      toast('Steam account linked', 'good');
    }
  }

  function renderOffline() {
    $('bridge-pulse').className = 'pulse bad';
    $('bridge-status-text').textContent = 'bridge unreachable';
  }

  async function pollStatus() {
    try {
      renderStatus(await apiGet('/api/status'));
    } catch {
      renderOffline();
    }
  }

  function startPolling() {
    stopPolling();
    pollStatus();
    statusTimer = setInterval(pollStatus, POLL_MS);
  }

  function stopPolling() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });

  // --------------------------------------------------------- Push grid

  // Tile artwork keyed by CommandDescriptor.icon. The bridge owns *what* can be
  // pushed (src/command-registry.js); this file owns what it looks like.
  const PUSH_ICONS = {
    'tesla-dashboard': '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M6.5 10.5 9 8l3 3 3.5-3.5L18 10"/>',
    'tesla-battery': '<rect x="2.5" y="7.5" width="17" height="9" rx="2"/><path d="M21.5 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3M13 10.5v3"/>',
    photo: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="currentColor" stroke="none"/><path d="m3 15 4-4 3 3 4-5 4 4"/><rect x="7" y="3" width="14" height="14" rx="2" opacity="0.45"/>',
    weather: '<path d="M7.5 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 12.1 3.5 3.5 0 0 0 7.5 18Z"/>',
    'shopping-list': '<path d="M6 6h14l-1.5 9h-11z"/><path d="M6 6 5 3H3"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    'guest-snaps': '<rect x="3" y="3" width="8" height="8" rx="1.5"/><path d="M5.5 7h3M7 5.5v3"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M15 17h4M17 15v4"/><path d="M13 7h4M17 3v4M3 17h4M7 13v4"/>',
    'air-quality': '<path d="M4 14c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 9c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 19c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0"/>',
    'now-playing': '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="currentColor" stroke="none"/>',
    alarm: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5 2 6H4c.5-1 2-2.5 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M12 3v1"/>',
    trivia: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.2 2.5c-.5.2-.7.6-.7 1.1v.5"/><path d="M12 16.6v.4"/>',
    news: '<path d="M4 5.5h12.5A2.5 2.5 0 0 1 19 8v11H6.5A2.5 2.5 0 0 1 4 16.5v-11Z"/><path d="M8 9h6M8 12h6M8 15h3.5"/><path d="M19 10.5h1.5A1.5 1.5 0 0 1 22 12v5.5A1.5 1.5 0 0 1 20.5 19H19"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.2 9.6v4.8l4.3-2.4-4.3-2.4Z" fill="currentColor" stroke="none"/>',
    steam: '<circle cx="12" cy="12" r="9"/><circle cx="15" cy="9.5" r="2.4"/><path d="M3.3 15.2 8 17.1"/><circle cx="9" cy="15.6" r="2.1"/>',
    psn: '<path d="M10 4.5 15 6v12.5l-2.6-.9V8.2L10 7.5Z" fill="currentColor" stroke="none"/><path d="M4 15.2c2-1.1 4.4-1.5 4.4-1.5v2s-2.1.4-3 .9c-.4.2-.3.5.2.5"/><path d="M20 14.4c-1.6-.9-4-.7-4-.7v1.9s1.9-.3 2.8 0"/>',
  };

  function pushIconSvg(icon) {
    const body = PUSH_ICONS[icon] || PUSH_ICONS['now-playing'];
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pushCardElementId(commandId) {
    return `btn-push-${String(commandId).replace(/\./g, '-')}`;
  }

  // The slideshow tile's subtitle carries an inline link to the guest booth.
  const PUSH_SUBTITLE_HTML = {
    'signal.slideshow': 'Play every <span class="push-booth-link" data-booth-link role="link" tabindex="0">uploaded photo</span>',
  };

  let pushCommands = [];

  function renderPushGrid(commands) {
    pushCommands = (commands || []).filter((command) => command.pushable);
    document.querySelectorAll('[data-push-row]').forEach((row) => {
      const groups = String(row.dataset.pushRow || '').split(',').map((g) => g.trim());
      const mine = pushCommands.filter((command) => groups.includes(command.group));
      row.innerHTML = mine.map((command) => {
        const sub = PUSH_SUBTITLE_HTML[command.id] || escapeHtml(command.subtitle);
        const extraClass = command.id === 'signal.slideshow' ? ' push-card-photo' : '';
        const iconClass = command.id === 'signal.slideshow' ? ' push-icon-photo' : '';
        return `<button type="button" class="push-card${extraClass}"`
          + ` id="${pushCardElementId(command.id)}" data-command-id="${escapeHtml(command.id)}">`
          + `<span class="push-icon${iconClass}">${pushIconSvg(command.icon)}</span>`
          + `<span class="push-card-title">${escapeHtml(command.title)}</span>`
          + `<span class="push-card-sub">${sub}</span>`
          + '</button>';
      }).join('');
      row.hidden = mine.length === 0;
    });
  }

  async function loadPushGrid() {
    try {
      const { commands } = await apiGet('/api/commands');
      renderPushGrid(commands);
    } catch (error) {
      // A failed load leaves the rows empty rather than showing dead tiles.
      console.warn('Could not load push commands', error);
    }
  }

  // ------------------------------------------------------------- Push actions

  async function runPush(command, button) {
    button.classList.add('busy');
    try {
      if (command.id === 'signal.slideshow') {
        const { photos } = await apiGet('/api/photos');
        if (!photos || !photos.length) {
          toast('No shared photos yet — share one via QR Code → Photo first', 'bad');
          return;
        }
        const entries = photosToSlideshowEntries(photos);
        await apiPost(command.route, withTarget({ photos: entries }));
        toast(`Slideshow sent (${entries.length} photo${entries.length === 1 ? '' : 's'})`, 'good');
        return;
      }
      await apiPost(command.route, withTarget({ ...(command.body || {}) }));
      toast(`${command.title} sent`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      setTimeout(() => button.classList.remove('busy'), 900);
    }
  }

  // Resolve cached photos to the enriched {url, uploadedAt} shape the bridge
  // uses to order the slideshow per the Settings tab's persisted preference.
  function photosToSlideshowEntries(photos) {
    return (photos || []).map((p) => ({
      url: new URL(p.path, document.baseURI).href,
      uploadedAt: p.createdAt,
    }));
  }

  function openGuestPhotoBooth() {
    // Root-absolute `/` (guest upload page) — ignores <base href="/admin/…">.
    window.open('/', '_blank', 'noopener,noreferrer');
  }

  // One delegated listener rather than one per tile — tiles are re-rendered
  // whenever the registry reloads, which would strip per-node handlers.
  document.addEventListener('click', (e) => {
    const card = e.target.closest?.('[data-command-id]');
    if (!card) {
      return;
    }
    if (e.target.closest('[data-booth-link]')) {
      e.preventDefault();
      openGuestPhotoBooth();
      return;
    }
    const command = pushCommands.find((c) => c.id === card.dataset.commandId);
    if (command) {
      runPush(command, card);
    }
  });

  // Keyboard activation for the inline booth link (role=link inside the tile).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') {
      return;
    }
    if (!e.target.closest?.('[data-booth-link]')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    openGuestPhotoBooth();
  });

  // -------------------------------------------------------------- URL push

  function normalizeUrlInput(raw) {
    let value = String(raw || '').trim();
    if (!value) {
      return null;
    }
    if (!/^https?:\/\//i.test(value)) {
      // Typing "autodarts.io/..." without scheme is natural on a phone.
      if (/^[\w.-]+\.[a-z]{2,}([/:?#]|$)/i.test(value)) {
        value = `https://${value}`;
      } else {
        return null;
      }
    }
    return value;
  }

  async function pushUrl(url) {
    const button = $('btn-push-url');
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/url', withTarget({ url }));
      if (result.reachable === false) {
        toast('Pushed — but the page did not respond. The display will show an error if it cannot load.', 'bad');
      } else {
        toast('Web page sent to display', 'good');
      }
      pollStatus();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  }

  $('btn-push-url').addEventListener('click', () => {
    const url = normalizeUrlInput($('url-input').value);
    if (!url) {
      toast('Enter a valid web address first', 'bad');
      $('url-input').focus();
      return;
    }
    $('url-input').value = url;
    pushUrl(url);
  });

  $('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btn-push-url').click();
    }
  });

  $('btn-close-browser').addEventListener('click', async () => {
    try {
      await apiPost('/api/push/close-browser', withTarget());
      toast('Browser closed on display', 'good');
      pollStatus();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  // ------------------------------------------------------------- QR decode

  const qrFile = $('qr-file');
  let qrStream = null;
  let qrScanTimer = null;
  let qrScanning = false;

  function isSecureForCamera() {
    return window.isSecureContext === true;
  }

  function showConfirmUrl(raw) {
    const url = normalizeUrlInput(raw);
    if (!url) {
      toast(`QR code is not a web link: ${String(raw).slice(0, 60)}`, 'bad');
      return;
    }
    $('qr-sheet-url').textContent = url;
    $('qr-sheet').hidden = false;
    $('qr-sheet-push').dataset.url = url;
  }

  function stopQrScanner() {
    qrScanning = false;
    if (qrScanTimer) {
      cancelAnimationFrame(qrScanTimer);
      qrScanTimer = null;
    }
    const video = $('qr-video');
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    if (qrStream) {
      qrStream.getTracks().forEach((track) => track.stop());
      qrStream = null;
    }
    $('qr-scanner-sheet').hidden = true;
  }

  async function scanVideoFrame(video, canvas, ctx) {
    if (!qrScanning || video.readyState < 2) {
      return null;
    }
    const maxSide = 720;
    const ratio = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * ratio));
    const height = Math.max(1, Math.round(video.videoHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(video, 0, 0, width, height);

    // Prefer BarcodeDetector when the browser has it (not on all iOS builds).
    if (window.BarcodeDetector) {
      try {
        if (!scanVideoFrame._detector) {
          scanVideoFrame._detector = new BarcodeDetector({ formats: ['qr_code'] });
        }
        const codes = await scanVideoFrame._detector.detect(canvas);
        if (codes?.length && codes[0].rawValue) {
          return codes[0].rawValue;
        }
      } catch {
        // fall through to jsQR
      }
    }

    if (typeof jsQR === 'function') {
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (code?.data) {
        return code.data;
      }
    }
    return null;
  }

  async function startLiveQrScanner() {
    if (typeof jsQR !== 'function' && !window.BarcodeDetector) {
      toast('QR decoding is unavailable', 'bad');
      return;
    }
    if (!isSecureForCamera()) {
      toast('Camera scanning needs HTTPS. Open https://<NAS_IP>:47810/ and accept the certificate.', 'bad');
      // Fall back to photo capture (works on plain HTTP).
      qrFile.value = '';
      qrFile.click();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Camera is not available in this browser', 'bad');
      qrFile.value = '';
      qrFile.click();
      return;
    }

    stopQrScanner();
    $('qr-scanner-sheet').hidden = false;
    $('qr-scanner-status').textContent = 'Starting camera…';

    try {
      qrStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      $('qr-scanner-sheet').hidden = true;
      toast(error?.name === 'NotAllowedError'
        ? 'Camera permission denied — allow camera access for this site'
        : 'Could not open the camera', 'bad');
      return;
    }

    const video = $('qr-video');
    video.srcObject = qrStream;
    try {
      await video.play();
    } catch {
      // iOS sometimes needs a moment; keep going.
    }

    $('qr-scanner-status').textContent = 'Point at a QR code…';
    qrScanning = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let lastScan = 0;

    const tick = async (now) => {
      if (!qrScanning) {
        return;
      }
      // ~8 fps is enough for QR and keeps iPhones cool.
      if (now - lastScan > 120) {
        lastScan = now;
        try {
          const decoded = await scanVideoFrame(video, canvas, ctx);
          if (decoded) {
            stopQrScanner();
            showConfirmUrl(decoded);
            return;
          }
        } catch {
          // keep scanning
        }
      }
      qrScanTimer = requestAnimationFrame(tick);
    };
    qrScanTimer = requestAnimationFrame(tick);
  }

  function decodeQrFromImage(img) {
    const scales = [900, 1400, 600];
    for (const maxSide of scales) {
      const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * ratio));
      const height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (code?.data) {
        return code.data;
      }
    }
    return null;
  }

  $('btn-scan-qr').addEventListener('click', () => {
    startLiveQrScanner();
  });

  $('qr-scanner-cancel').addEventListener('click', () => stopQrScanner());
  $('qr-scanner-photo').addEventListener('click', () => {
    stopQrScanner();
    qrFile.value = '';
    qrFile.click();
  });
  $('qr-scanner-sheet').addEventListener('click', (e) => {
    if (e.target === $('qr-scanner-sheet')) {
      stopQrScanner();
    }
  });

  qrFile.addEventListener('change', () => {
    const file = qrFile.files && qrFile.files[0];
    if (!file) {
      return;
    }
    if (typeof jsQR !== 'function') {
      toast('QR decoding is unavailable', 'bad');
      return;
    }
    const hint = $('qr-hint');
    const original = hint.textContent;
    hint.textContent = 'Reading QR code…';

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let decoded = null;
      try {
        decoded = decodeQrFromImage(img);
      } catch {
        decoded = null;
      }
      hint.textContent = original;

      if (!decoded) {
        toast('No QR code found — try again with the code filling more of the photo', 'bad');
        return;
      }
      showConfirmUrl(decoded);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      hint.textContent = original;
      toast('Could not read that photo', 'bad');
    };
    img.src = objectUrl;
  });

  $('qr-sheet-cancel').addEventListener('click', () => {
    $('qr-sheet').hidden = true;
  });

  $('qr-sheet').addEventListener('click', (e) => {
    if (e.target === $('qr-sheet')) {
      $('qr-sheet').hidden = true;
    }
  });

  $('qr-sheet-push').addEventListener('click', () => {
    const url = $('qr-sheet-push').dataset.url;
    $('qr-sheet').hidden = true;
    if (url) {
      $('url-input').value = url;
      pushUrl(url);
    }
  });

  // -------------------------------------------------------- QR generation

  const QR_MODES = ['image', 'url', 'wifi'];
  let qrGenerateMode = 'image';
  let qrSelectedPhotoDataUrl = null;

  function setQrGenerateMode(mode) {
    if (!QR_MODES.includes(mode)) {
      return;
    }
    qrGenerateMode = mode;
    QR_MODES.forEach((m) => {
      const panel = $(`qr-panel-${m}`);
      if (panel) {
        panel.hidden = m !== mode;
      }
    });
    document.querySelectorAll('#qr-mode-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.qrMode === mode);
    });
  }

  document.querySelectorAll('#qr-mode-tabs .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => setQrGenerateMode(btn.dataset.qrMode));
  });

  $('qr-generate-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btn-qr-generate').click();
    }
  });

  $('qr-wifi-open').addEventListener('change', () => {
    const open = $('qr-wifi-open').checked;
    $('qr-wifi-password').disabled = open;
    if (open) {
      $('qr-wifi-password').value = '';
    }
  });

  function resetPhotoPicker() {
    qrSelectedPhotoDataUrl = null;
    $('qr-photo-preview').hidden = true;
    $('btn-qr-pick-photo').hidden = false;
    $('qr-image-file').value = '';
  }

  $('btn-qr-pick-photo').addEventListener('click', () => {
    $('qr-image-file').value = '';
    $('qr-image-file').click();
  });

  $('qr-image-file').addEventListener('change', () => {
    const file = $('qr-image-file').files && $('qr-image-file').files[0];
    if (!file) {
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      // Downscale + re-encode as JPEG client-side so the upload stays small
      // and fast over LAN regardless of the phone's original photo size.
      const maxSide = 1600;
      const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * ratio));
      const height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      qrSelectedPhotoDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      $('qr-photo-preview-img').src = qrSelectedPhotoDataUrl;
      $('qr-photo-preview').hidden = false;
      $('btn-qr-pick-photo').hidden = true;
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      toast('Could not read that photo', 'bad');
    };
    img.src = objectUrl;
  });

  $('btn-qr-photo-clear').addEventListener('click', resetPhotoPicker);

  $('btn-qr-generate').addEventListener('click', async () => {
    const button = $('btn-qr-generate');
    button.disabled = true;
    try {
      if (qrGenerateMode === 'url') {
        const url = normalizeUrlInput($('qr-generate-url-input').value);
        if (!url) {
          toast('Enter a valid web address first', 'bad');
          $('qr-generate-url-input').focus();
          return;
        }
        $('qr-generate-url-input').value = url;
        await apiPost('/api/qr/push', withTarget({ mode: 'url', url }));
        toast('QR code sent to display', 'good');
        return;
      }

      if (qrGenerateMode === 'wifi') {
        const ssid = $('qr-wifi-ssid').value.trim();
        if (!ssid) {
          toast('Enter the Wi-Fi network name', 'bad');
          $('qr-wifi-ssid').focus();
          return;
        }
        const isOpen = $('qr-wifi-open').checked;
        const password = $('qr-wifi-password').value;
        if (!isOpen && !password.trim()) {
          toast('Enter the Wi-Fi password (or mark it as open)', 'bad');
          $('qr-wifi-password').focus();
          return;
        }
        await apiPost('/api/qr/push', withTarget({
          mode: 'wifi',
          ssid,
          password,
          security: isOpen ? 'nopass' : 'WPA',
          hidden: $('qr-wifi-hidden').checked,
        }));
        toast('Wi-Fi QR code sent to display', 'good');
        return;
      }

      // Photo mode: upload first (bridge hosts it + returns a relative path),
      // then push that resolved URL through the same 'url' QR path — a photo
      // QR is just a URL QR once the upload step has happened.
      if (!qrSelectedPhotoDataUrl) {
        toast('Choose a photo first', 'bad');
        return;
      }
      const upload = await apiPost('/api/qr/image-upload', { imageDataUrl: qrSelectedPhotoDataUrl });
      const absoluteUrl = new URL(upload.path, document.baseURI).href;
      await apiPost('/api/qr/push', withTarget({
        mode: 'photo', url: absoluteUrl, label: 'Scan to save this photo',
      }));
      toast('Photo sent to display', 'good');
      resetPhotoPicker();
    } catch (error) {
      toast(error.message || 'Could not generate the QR code', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  // -------------------------------------------------- Slideshow Manager

  let slideshowPhotos = [];
  let slideshowPhotosSig = '';
  let slideshowSelecting = false;
  const slideshowSelected = new Set();
  let lightboxToken = null;
  let lightboxIndex = -1;
  let pendingDeleteTokens = [];

  function formatUploadedAt(iso) {
    if (!iso) {
      return '';
    }
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  /** Stable fingerprint so GET + SSE hello don't wipe in-flight thumbnails. */
  function photosSignature(photos) {
    return (photos || [])
      .map((p) => `${p.token || ''}\0${p.path || ''}\0${p.createdAt || ''}`)
      .join('\n');
  }

  /** Root-absolute `/qr-images/…` URL (ignores <base href="/admin/">). */
  function photoImageUrl(photo, { bust = false } = {}) {
    const path = appUrl(photo?.path || '');
    if (!path) {
      return '';
    }
    if (!bust) {
      return path;
    }
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}_=${Date.now()}`;
  }

  function updateSelectionUi() {
    document.querySelectorAll('#photo-grid .photo-thumb').forEach((cell) => {
      cell.classList.toggle('selected', slideshowSelected.has(cell.dataset.token));
    });
    $('slideshow-selected-count').textContent = String(slideshowSelected.size);
    $('btn-slideshow-delete-selected').disabled = slideshowSelected.size === 0;
    const allSelected = slideshowPhotos.length > 0 && slideshowSelected.size === slideshowPhotos.length;
    $('btn-slideshow-select-all').textContent = allSelected ? 'Unselect All' : 'Select All';
  }

  function toggleSelected(token) {
    if (slideshowSelected.has(token)) {
      slideshowSelected.delete(token);
    } else {
      slideshowSelected.add(token);
    }
    updateSelectionUi();
  }

  function lightboxPhotoAt(index) {
    if (index < 0 || index >= slideshowPhotos.length) {
      return null;
    }
    return slideshowPhotos[index];
  }

  function showLightboxPhoto(index) {
    const photo = lightboxPhotoAt(index);
    if (!photo) {
      return;
    }
    lightboxIndex = index;
    lightboxToken = photo.token;
    $('lightbox-img').src = photoImageUrl(photo);
    const uploaded = formatUploadedAt(photo.createdAt);
    $('lightbox-uploaded-at').textContent = uploaded ? `Uploaded ${uploaded}` : '';
    const counter = $('lightbox-counter');
    if (counter) {
      counter.textContent = slideshowPhotos.length > 1
        ? `Photo ${index + 1} of ${slideshowPhotos.length}`
        : '';
    }
    const prev = $('btn-lightbox-prev');
    const next = $('btn-lightbox-next');
    if (prev) {
      prev.disabled = index <= 0;
      prev.hidden = slideshowPhotos.length <= 1;
    }
    if (next) {
      next.disabled = index >= slideshowPhotos.length - 1;
      next.hidden = slideshowPhotos.length <= 1;
    }
  }

  function openLightbox(photo) {
    const index = slideshowPhotos.findIndex((p) => p.token === photo.token);
    showLightboxPhoto(index >= 0 ? index : 0);
    $('photo-lightbox').hidden = false;
  }

  function closeLightbox() {
    const lightbox = $('photo-lightbox');
    if (lightbox) {
      lightbox.hidden = true;
    }
    lightboxToken = null;
    lightboxIndex = -1;
  }

  function stepLightbox(delta) {
    if ($('photo-lightbox')?.hidden || lightboxIndex < 0) {
      return;
    }
    showLightboxPhoto(lightboxIndex + delta);
  }

  function bindThumbImage(img, photo) {
    // Eager load: lazy + display:none tab panels leave some thumbs stuck broken.
    img.loading = 'eager';
    img.decoding = 'async';
    img.alt = 'Shared photo';
    img.src = photoImageUrl(photo);
    img.addEventListener('error', () => {
      if (img.dataset.retried === '1') {
        return;
      }
      img.dataset.retried = '1';
      img.src = photoImageUrl(photo, { bust: true });
    });
  }

  function renderPhotoGrid() {
    const grid = $('photo-grid');
    const empty = $('photo-grid-empty');
    grid.innerHTML = '';
    empty.hidden = slideshowPhotos.length > 0;
    slideshowPhotos.forEach((photo) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'photo-thumb';
      cell.classList.toggle('selecting', slideshowSelecting);
      cell.classList.toggle('selected', slideshowSelected.has(photo.token));
      cell.dataset.token = photo.token;
      const img = document.createElement('img');
      bindThumbImage(img, photo);
      cell.appendChild(img);
      const check = document.createElement('span');
      check.className = 'photo-thumb-check';
      cell.appendChild(check);
      cell.addEventListener('click', () => {
        if (slideshowSelecting) {
          toggleSelected(photo.token);
        } else {
          openLightbox(photo);
        }
      });
      grid.appendChild(cell);
    });
  }

  // Shared by the initial load, the manual refresh button, and every SSE
  // push — one place that reconciles the in-flight selection against
  // whatever photo list just arrived (a photo deleted from another session
  // must fall out of `slideshowSelected` too, or "Delete (n)" could try to
  // delete an already-gone token).
  function applySlideshowPhotos(photos, { force = false } = {}) {
    const next = photos || [];
    const sig = photosSignature(next);
    // Opening the tab fires GET and SSE `hello` with the same list. Rebuilding
    // the grid aborts half-finished <img> fetches and leaves broken thumbs
    // until a manual refresh — skip identical updates.
    if (!force && sig === slideshowPhotosSig && $('photo-grid')?.children?.length === next.length) {
      return;
    }
    slideshowPhotosSig = sig;
    slideshowPhotos = next;
    const tokens = new Set(slideshowPhotos.map((p) => p.token));
    [...slideshowSelected].forEach((token) => {
      if (!tokens.has(token)) {
        slideshowSelected.delete(token);
      }
    });
    renderPhotoGrid();
    updateSelectionUi();
    if (!$('photo-lightbox')?.hidden && lightboxToken) {
      const index = slideshowPhotos.findIndex((p) => p.token === lightboxToken);
      if (index < 0) {
        closeLightbox();
      } else {
        showLightboxPhoto(index);
      }
    }
  }

  async function loadSlideshowPhotos({ force = false } = {}) {
    try {
      const { photos } = await apiGet('/api/photos');
      applySlideshowPhotos(photos, { force });
    } catch (error) {
      toast(error.message || 'Could not load saved photos', 'bad');
    }
  }

  // Live updates: any upload/delete on *any* open Slideshow Manager tab (this
  // one included) pushes a fresh photo list here, so the camera roll never
  // goes stale while the page is open. Falls back to the manual refresh
  // button / next tab visit if the browser blocks or drops the connection.
  let slideshowEvents = null;

  function startSlideshowEvents() {
    if (slideshowEvents) {
      return;
    }
    try {
      slideshowEvents = new EventSource(appUrl('/api/photos/events'));
    } catch {
      return;
    }
    slideshowEvents.addEventListener('photos', (event) => {
      try {
        const data = JSON.parse(event.data);
        applySlideshowPhotos(data.photos || []);
      } catch {
        // ignore malformed events
      }
    });
    slideshowEvents.onerror = () => {
      // Browser will retry the connection automatically.
    };
  }

  function setSelectingMode(on) {
    slideshowSelecting = on;
    if (!on) {
      slideshowSelected.clear();
    }
    $('btn-slideshow-select').hidden = on;
    $('slideshow-toolbar-selecting').hidden = !on;
    renderPhotoGrid();
    updateSelectionUi();
  }

  function openDeleteConfirm(tokens) {
    pendingDeleteTokens = tokens;
    $('photo-delete-title').textContent = tokens.length > 1
      ? `Delete ${tokens.length} photos?`
      : 'Delete this photo?';
    $('photo-delete-sheet').hidden = false;
  }

  function closeDeleteConfirm() {
    $('photo-delete-sheet').hidden = true;
    pendingDeleteTokens = [];
  }

  $('btn-lightbox-close')?.addEventListener('click', closeLightbox);
  $('btn-lightbox-cancel')?.addEventListener('click', closeLightbox);
  $('btn-lightbox-prev')?.addEventListener('click', (e) => {
    e.stopPropagation();
    stepLightbox(-1);
  });
  $('btn-lightbox-next')?.addEventListener('click', (e) => {
    e.stopPropagation();
    stepLightbox(1);
  });
  $('photo-lightbox')?.addEventListener('click', (e) => {
    if (e.target === $('photo-lightbox')) {
      closeLightbox();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ($('photo-lightbox')?.hidden) {
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepLightbox(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepLightbox(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeLightbox();
    }
  });

  // Swipe left/right on the lightbox image (mobile touch screens).
  (() => {
    const frame = $('lightbox-frame');
    if (!frame) {
      return;
    }
    let startX = 0;
    let startY = 0;
    let tracking = false;
    frame.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length !== 1) {
        return;
      }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    frame.addEventListener('touchend', (e) => {
      if (!tracking) {
        return;
      }
      tracking = false;
      const touch = e.changedTouches && e.changedTouches[0];
      if (!touch) {
        return;
      }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) {
        return;
      }
      stepLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });
    frame.addEventListener('touchcancel', () => {
      tracking = false;
    }, { passive: true });
  })();

  $('btn-lightbox-delete')?.addEventListener('click', () => {
    if (lightboxToken) {
      openDeleteConfirm([lightboxToken]);
    }
  });

  async function pushSlideshowEntries(entries, emptyMessage) {
    if (!entries.length) {
      toast(emptyMessage, 'bad');
      return;
    }
    await apiPost('/api/push/photo-slideshow', withTarget({ photos: entries }));
    toast(
      entries.length === 1
        ? 'Photo sent to display'
        : `Slideshow sent (${entries.length} photos)`,
      'good',
    );
  }

  $('btn-slideshow-push')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const entries = photosToSlideshowEntries(slideshowPhotos);
      await pushSlideshowEntries(
        entries,
        'No shared photos yet — share one via QR Code → Photo first',
      );
    } catch (error) {
      toast(error.message || 'Could not push slideshow', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-lightbox-push')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const photo = lightboxPhotoAt(lightboxIndex);
    if (!photo) {
      toast('No photo open', 'bad');
      return;
    }
    button.disabled = true;
    try {
      await pushSlideshowEntries(
        photosToSlideshowEntries([photo]),
        'No photo open',
      );
    } catch (error) {
      toast(error.message || 'Could not push photo', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('photo-delete-cancel')?.addEventListener('click', closeDeleteConfirm);
  $('photo-delete-sheet')?.addEventListener('click', (e) => {
    if (e.target === $('photo-delete-sheet')) {
      closeDeleteConfirm();
    }
  });
  $('photo-delete-confirm')?.addEventListener('click', async () => {
    const tokens = pendingDeleteTokens;
    closeDeleteConfirm();
    if (!tokens.length) {
      return;
    }
    try {
      await apiPost('/api/photos/delete', { tokens });
      toast(tokens.length > 1 ? `${tokens.length} photos deleted` : 'Photo deleted', 'good');
      if (lightboxToken && tokens.includes(lightboxToken)) {
        closeLightbox();
      }
      await loadSlideshowPhotos();
      if (slideshowSelecting && !slideshowSelected.size) {
        setSelectingMode(false);
      }
    } catch (error) {
      toast(error.message || 'Could not delete photo(s)', 'bad');
    }
  });

  $('btn-slideshow-select')?.addEventListener('click', () => setSelectingMode(true));
  $('btn-slideshow-cancel-select')?.addEventListener('click', () => setSelectingMode(false));
  $('btn-slideshow-select-all')?.addEventListener('click', () => {
    const allSelected = slideshowPhotos.length > 0 && slideshowSelected.size === slideshowPhotos.length;
    if (allSelected) {
      slideshowSelected.clear();
    } else {
      slideshowPhotos.forEach((p) => slideshowSelected.add(p.token));
    }
    updateSelectionUi();
  });
  $('btn-slideshow-delete-selected')?.addEventListener('click', () => {
    if (slideshowSelected.size) {
      openDeleteConfirm([...slideshowSelected]);
    }
  });

  // Load the camera roll when the tab opens, then refresh on later visits.
  // Await GET before opening SSE so the initial `hello` snapshot doesn't race
  // the first grid render and abort thumbnail requests.
  document.querySelector('.tab-btn[data-tab="slideshow"]')?.addEventListener('click', async () => {
    await loadSlideshowPhotos();
    startSlideshowEvents();
  });

  $('btn-slideshow-refresh')?.addEventListener('click', async () => {
    const btn = $('btn-slideshow-refresh');
    btn.classList.add('is-loading');
    btn.disabled = true;
    try {
      await loadSlideshowPhotos({ force: true });
    } finally {
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  });

  // ---------------------------------------------- Slideshow settings

  let slideshowOrder = 'recent';
  let slideshowSecondsPerPhoto = 5;

  function setSlideshowOrderUi(order) {
    slideshowOrder = order;
    document.querySelectorAll('#slideshow-order-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.order === order);
    });
  }

  function setSlideshowSecondsUi(seconds) {
    const value = Math.max(5, Math.min(60, Math.round(Number(seconds) || 5)));
    slideshowSecondsPerPhoto = value;
    const slider = $('slideshow-seconds-slider');
    const label = $('slideshow-seconds-value');
    if (slider) {
      slider.value = String(value);
      slider.setAttribute('aria-valuenow', String(value));
    }
    if (label) {
      label.textContent = `${value}s`;
    }
  }

  document.querySelectorAll('#slideshow-order-tabs .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const order = btn.dataset.order;
      if (order === slideshowOrder) {
        return;
      }
      const previous = slideshowOrder;
      setSlideshowOrderUi(order);
      try {
        await apiPost('/api/slideshow/settings', { order });
      } catch (error) {
        setSlideshowOrderUi(previous);
        toast(error.message || 'Could not save slideshow order', 'bad');
      }
    });
  });

  const slideshowSecondsSlider = $('slideshow-seconds-slider');
  if (slideshowSecondsSlider) {
    slideshowSecondsSlider.addEventListener('input', () => {
      setSlideshowSecondsUi(slideshowSecondsSlider.value);
    });
    slideshowSecondsSlider.addEventListener('change', async () => {
      const previous = slideshowSecondsPerPhoto;
      const secondsPerPhoto = Math.max(5, Math.min(60, Math.round(Number(slideshowSecondsSlider.value) || 5)));
      setSlideshowSecondsUi(secondsPerPhoto);
      try {
        const result = await apiPost('/api/slideshow/settings', { secondsPerPhoto });
        setSlideshowSecondsUi(result.secondsPerPhoto ?? secondsPerPhoto);
      } catch (error) {
        setSlideshowSecondsUi(previous);
        toast(error.message || 'Could not save time per photo', 'bad');
      }
    });
  }

  (async () => {
    try {
      const result = await apiGet('/api/slideshow/settings');
      setSlideshowOrderUi(result.order || 'recent');
      setSlideshowSecondsUi(result.secondsPerPhoto ?? 5);
    } catch {
      // Keep the default UI state — a fresh bridge with no settings file yet.
    }
  })();

  // ---------------------------------------------- Library tour settings
  // Steam and PSN keep independent sort + seconds (not shared).

  const libraryTourPrefs = {
    steam: { secondsPerGame: 60, sort: 'recent' },
    psn: { secondsPerGame: 60, sort: 'recent' },
  };

  function libraryTourPlatform(el) {
    const fromSelf = el?.dataset?.platform;
    if (fromSelf === 'steam' || fromSelf === 'psn') return fromSelf;
    const fromParent = el?.closest?.('[data-platform]')?.dataset?.platform;
    if (fromParent === 'steam' || fromParent === 'psn') return fromParent;
    return 'steam';
  }

  function setLibraryTourSecondsUi(platform, seconds) {
    const key = platform === 'psn' ? 'psn' : 'steam';
    const value = Math.max(5, Math.min(300, Math.round(Number(seconds) || 60)));
    libraryTourPrefs[key].secondsPerGame = value;
    const slider = $(`${key}-library-tour-seconds-slider`);
    const label = $(`${key}-library-tour-seconds-value`);
    if (slider) {
      slider.value = String(value);
      slider.setAttribute('aria-valuenow', String(value));
    }
    if (label) label.textContent = `${value}s`;
  }

  function setLibraryTourSortUi(platform, sort) {
    const key = platform === 'psn' ? 'psn' : 'steam';
    const value = ['recent', 'oldest', 'random'].includes(sort) ? sort : 'recent';
    libraryTourPrefs[key].sort = value;
    const tabs = $(`${key}-library-tour-order-tabs`);
    tabs?.querySelectorAll('.segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.order === value);
    });
  }

  function applyLibraryTourSettings(settings) {
    if (settings?.steam) {
      setLibraryTourSecondsUi('steam', settings.steam.secondsPerGame ?? 60);
      setLibraryTourSortUi('steam', settings.steam.sort ?? 'recent');
    } else if (settings?.secondsPerGame != null || settings?.sort != null) {
      // Legacy shared API shape — seed both until the bridge is redeployed.
      setLibraryTourSecondsUi('steam', settings.secondsPerGame ?? 60);
      setLibraryTourSortUi('steam', settings.sort ?? 'recent');
      setLibraryTourSecondsUi('psn', settings.secondsPerGame ?? 60);
      setLibraryTourSortUi('psn', settings.sort ?? 'recent');
      return;
    }
    if (settings?.psn) {
      setLibraryTourSecondsUi('psn', settings.psn.secondsPerGame ?? 60);
      setLibraryTourSortUi('psn', settings.psn.sort ?? 'recent');
    }
  }

  async function refreshLibraryTourCounts() {
    const steamEl = $('steam-library-count');
    const psnEl = $('psn-library-count');
    try {
      const [steam, psn] = await Promise.all([
        apiGet('/api/library-tour/steam'),
        apiGet('/api/library-tour/psn'),
      ]);
      if (steamEl) {
        steamEl.textContent = steam.ok && steam.count != null
          ? `Library: ${steam.count} game${steam.count === 1 ? '' : 's'}`
          : (steam.error || 'Library unavailable');
      }
      if (psnEl) {
        psnEl.textContent = psn.ok && psn.count != null
          ? `Library: ${psn.count} game${psn.count === 1 ? '' : 's'}`
          : (psn.error || 'Library unavailable');
      }
    } catch {
      if (steamEl) steamEl.textContent = 'Library: unavailable';
      if (psnEl) psnEl.textContent = 'Library: unavailable';
    }
  }

  document.querySelectorAll('.library-tour-seconds-slider').forEach((slider) => {
    slider.addEventListener('input', () => {
      setLibraryTourSecondsUi(libraryTourPlatform(slider), slider.value);
    });
    slider.addEventListener('change', async () => {
      const platform = libraryTourPlatform(slider);
      const previous = libraryTourPrefs[platform].secondsPerGame;
      const secondsPerGame = Math.max(
        5,
        Math.min(300, Math.round(Number(slider.value) || 60)),
      );
      setLibraryTourSecondsUi(platform, secondsPerGame);
      try {
        const result = await apiPost('/api/library-tour/settings', {
          platform,
          secondsPerGame,
        });
        applyLibraryTourSettings(result);
        if (result.secondsPerGame != null) {
          setLibraryTourSecondsUi(platform, result.secondsPerGame);
        }
      } catch (error) {
        setLibraryTourSecondsUi(platform, previous);
        toast(error.message || 'Could not save library tour timing', 'bad');
      }
    });
  });

  document.querySelectorAll('.library-tour-order-tabs .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const platform = libraryTourPlatform(btn);
      const previous = libraryTourPrefs[platform].sort;
      const sort = btn.dataset.order || 'recent';
      setLibraryTourSortUi(platform, sort);
      try {
        const result = await apiPost('/api/library-tour/settings', { platform, sort });
        applyLibraryTourSettings(result);
        if (result.sort != null) {
          setLibraryTourSortUi(platform, result.sort);
        }
      } catch (error) {
        setLibraryTourSortUi(platform, previous);
        toast(error.message || 'Could not save library tour order', 'bad');
      }
    });
  });

  (async () => {
    try {
      const result = await apiGet('/api/library-tour/settings');
      applyLibraryTourSettings(result);
    } catch {
      // Fresh bridge — keep defaults.
    }
    refreshLibraryTourCounts();
  })();

  // -------------------------------------------------- Display Scheduler

  const SCHED_ROUTE = '/api/display-scheduler';
  const IMPORTANCE_OPTIONS = [
    [1, 'Background — yields to almost everything'],
    [2, 'Low'],
    [3, 'Normal (default)'],
    [4, 'High'],
    [5, 'Featured — wins most contests'],
  ];
  const INTERVAL_CHOICES = [
    [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'],
    [2700, '45 min'], [3600, '1 hr'], [7200, '2 hr'], [10800, '3 hr'],
    [21600, '6 hr'], [43200, '12 hr'],
  ];
  const OUTCOME_LABELS = {
    aired: 'Aired',
    'lost-dice': 'Rolled and lost',
    'lost-tiebreak': 'Lost the tie-break',
    'expired-pending': 'Pending expired',
    'blocked-guard': 'No content to show',
    'blocked-cooldown': 'In cooldown',
    'blocked-window': 'Outside its window',
    'blocked-cap': 'Hit its daily cap',
    'blocked-display': 'Display was busy',
    'blocked-quiet-hours': 'Quiet hours',
    'blocked-global-gap': 'Too soon after the last airing',
    error: 'Error',
    disabled: 'Disabled',
  };

  let schedRules = [];
  let schedSettings = null;
  let schedCommands = [];
  let schedRange = '24h';
  let schedEvents = [];
  let schedSaveTimers = new Map();

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return `${total}s`;
    const minutes = Math.round(total / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function relativeTime(iso) {
    if (!iso) return 'never';
    const delta = Math.round((Date.parse(iso) - Date.now()) / 1000);
    const abs = Math.abs(delta);
    const text = formatDuration(abs);
    return delta >= 0 ? `in ${text}` : `${text} ago`;
  }

  // ------------------------------------------------------- rules view

  function renderSchedRules() {
    const host = $('sched-rule-list');
    if (!host) return;
    if (!schedRules.length) {
      host.innerHTML = '<div class="card"><p class="hint">No rules yet. '
        + 'Add one below to let the display program itself when nothing else is on.</p></div>';
      return;
    }
    // Order carries no meaning by design (§9), so sort by something useful:
    // enabled first, then by how often each rule expects to air.
    const sorted = [...schedRules].sort((a, b) => (
      Number(b.enabled) - Number(a.enabled) || b.expectedPerDay - a.expectedPerDay
    ));
    host.innerHTML = sorted.map(schedRuleCardHtml).join('');
  }

  function schedCommandById(commandId) {
    return schedCommands.find((entry) => entry.id === commandId) || null;
  }

  function schedRuleParamsHtml(rule) {
    const command = schedCommandById(rule.commandId);
    const defs = Array.isArray(command?.params) ? command.params : [];
    if (!defs.length) return '';
    const params = rule.params || {};
    const fields = defs.map((def) => {
      const key = def.key;
      const value = params[key] ?? '';
      if (def.type === 'enum' && Array.isArray(def.values)) {
        const options = def.values.map((entry) => (
          `<option value="${escapeHtml(entry)}"${entry === value ? ' selected' : ''}>${escapeHtml(entry)}</option>`
        )).join('');
        return `<label class="field-label">${escapeHtml(def.label || key)}</label>`
          + `<select class="field-input" data-sched-param="${escapeHtml(key)}">`
          + `<option value="">default</option>${options}</select>`;
      }
      const min = def.min != null ? ` min="${def.min}"` : '';
      const max = def.max != null ? ` max="${def.max}"` : '';
      return `<label class="field-label">${escapeHtml(def.label || key)}</label>`
        + `<input class="field-input" type="number"${min}${max} data-sched-param="${escapeHtml(key)}"`
        + ` value="${escapeHtml(value === '' || value == null ? '' : String(value))}" placeholder="default">`;
    }).join('');
    return `<div class="sched-field-row" style="margin-top:8px">${fields}</div>`;
  }

  function schedRuleCardHtml(rule) {
    const gap = rule.gapProfile || {};
    const gapText = gap.typicalSeconds
      ? `typical gap ${formatDuration(gap.typicalSeconds)}`
        + (gap.occasionalSeconds > gap.typicalSeconds
          ? `, occasionally ${formatDuration(gap.occasionalSeconds)}+` : '')
      : 'never airs at 0%';
    const intervalOptions = INTERVAL_CHOICES.map(([value, label]) => (
      `<option value="${value}"${value === rule.intervalSeconds ? ' selected' : ''}>${label}</option>`
    )).join('');
    const importanceOptions = IMPORTANCE_OPTIONS.map(([value, label]) => (
      `<option value="${value}"${value === rule.importance ? ' selected' : ''}>${escapeHtml(label)}</option>`
    )).join('');

    return `<div class="card sched-rule" data-rule-id="${escapeHtml(rule.id)}">
      <div class="sched-rule-head">
        <i class="sched-dot" style="background:${escapeHtml(rule.color)}"></i>
        <span class="sched-rule-name${rule.broken ? ' is-broken' : ''}">${escapeHtml(rule.label)}${
      rule.broken ? ' — command no longer exists' : ''}</span>
        <div class="sched-rule-controls">
          <input type="checkbox" data-sched-field="enabled"${rule.enabled ? ' checked' : ''} aria-label="Enable rule">
          <button type="button" class="btn btn-outline btn-sm" data-sched-action="air">Air now</button>
          <button type="button" class="btn btn-outline btn-sm" data-sched-action="delete" aria-label="Delete rule">✕</button>
        </div>
      </div>
      <div class="sched-field-row">
        <label class="field-label" for="int-${escapeHtml(rule.id)}">Every</label>
        <select class="field-input" id="int-${escapeHtml(rule.id)}" data-sched-field="intervalSeconds">${intervalOptions}</select>
      </div>
      ${schedRuleParamsHtml(rule)}
      <div class="slider-row">
        <input type="range" min="0" max="100" step="5" value="${rule.probability}"
               data-sched-field="probability" aria-label="Probability">
        <span class="slider-value" data-sched-readout="probability">${rule.probability}%</span>
      </div>
      <div class="sched-readout">
        <strong>≈ ${rule.expectedPerDay}×/day</strong> · ${escapeHtml(gapText)}${
      rule.estimatedDurationSeconds
        ? ` · runs ${formatDuration(rule.estimatedDurationSeconds)}` : ''}
      </div>
      ${rule.durationWarning ? `<div class="sched-warning">⚠ ${escapeHtml(rule.durationWarning)}</div>` : ''}
      ${rule.guard === 'requires-content' ? '<div class="sched-readout">Only when there is something to show</div>' : ''}
      <details class="sched-advanced">
        <summary>Advanced</summary>
        <div class="sched-field-row" style="margin-top:8px">
          <label class="field-label">Importance</label>
          <select class="field-input" data-sched-field="importance">${importanceOptions}</select>
          <label class="field-label">Max per day</label>
          <input class="field-input" type="number" min="1" max="200" data-sched-field="maxPerDay"
                 value="${rule.maxPerDay ?? ''}" placeholder="no limit">
          <label class="field-label">Cooldown (min)</label>
          <input class="field-input" type="number" min="0" max="1440" data-sched-field="cooldownMinutes"
                 value="${rule.cooldownSeconds ? Math.round(rule.cooldownSeconds / 60) : ''}" placeholder="none">
          <label class="field-label">Jitter (%)</label>
          <input class="field-input" type="number" min="0" max="50" data-sched-field="jitterPercent"
                 value="${rule.jitterPercent ?? ''}" placeholder="0">
        </div>
        ${rule.commandSupportsContentCheck === false ? '' : `<label class="trivia-check" style="margin-top:8px">
          <input type="checkbox" data-sched-field="guard"${rule.guard === 'requires-content' ? ' checked' : ''}>
          <span>Only air when there is content</span></label>`}
        <p class="hint">Importance biases contests; it cannot starve another rule.
          For "always this one first", raise its probability or shorten its interval instead.</p>
      </details>
    </div>`;
  }

  function schedRulePatchFrom(card) {
    const value = (field) => card.querySelector(`[data-sched-field="${field}"]`);
    const num = (field) => {
      const input = value(field);
      const raw = input ? String(input.value).trim() : '';
      return raw === '' ? null : Number(raw);
    };
    const cooldownMinutes = num('cooldownMinutes');
    const params = {};
    card.querySelectorAll('[data-sched-param]').forEach((input) => {
      const key = input.dataset.schedParam;
      if (!key) return;
      const raw = String(input.value ?? '').trim();
      if (raw === '') return;
      if (input.tagName === 'SELECT') {
        params[key] = raw;
        return;
      }
      const asNum = Number(raw);
      params[key] = Number.isFinite(asNum) ? asNum : raw;
    });
    return {
      enabled: value('enabled')?.checked !== false,
      intervalSeconds: Number(value('intervalSeconds')?.value) || 2700,
      probability: Number(value('probability')?.value) || 0,
      importance: Number(value('importance')?.value) || 3,
      maxPerDay: num('maxPerDay'),
      cooldownSeconds: cooldownMinutes == null ? null : cooldownMinutes * 60,
      jitterPercent: num('jitterPercent'),
      guard: value('guard') ? (value('guard').checked ? 'requires-content' : null) : undefined,
      params,
    };
  }

  async function saveSchedRule(ruleId, card) {
    try {
      const result = await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}`, {
        method: 'PUT', body: schedRulePatchFrom(card),
      });
      const index = schedRules.findIndex((rule) => rule.id === ruleId);
      if (index >= 0) {
        schedRules[index] = result.rule;
      }
      renderSchedRules();
    } catch (error) {
      toast(error.message || 'Could not save rule', 'bad');
      await loadSchedRules();
    }
  }

  function queueSchedRuleSave(ruleId, card) {
    clearTimeout(schedSaveTimers.get(ruleId));
    schedSaveTimers.set(ruleId, setTimeout(() => saveSchedRule(ruleId, card), 400));
  }

  async function apiFetch(route, { method = 'GET', body = null } = {}) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body != null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(route, options);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  }

  async function loadSchedRules() {
    const result = await apiFetch(`${SCHED_ROUTE}/rules`);
    schedRules = result.rules || [];
    renderSchedRules();
  }

  function renderSchedSettings(settings) {
    schedSettings = settings;
    const toggle = $('sched-active');
    if (toggle) toggle.checked = settings.active === true;
    const label = $('sched-active-label');
    if (label) {
      // Label the ON state — "Paused" on an unchecked switch reads as the
      // control's name and makes the status banner look like boilerplate.
      label.textContent = settings.active ? 'On' : 'Off';
      label.parentElement?.classList.toggle('is-active', settings.active === true);
    }
    setTriviaSlider('sched-min-gap', 'sched-min-gap-value',
      Math.round(settings.globalMinGapSeconds / 60), 'm');
    setTriviaSlider('sched-tick', 'sched-tick-value', settings.tickSeconds, 's');
    setTriviaSlider('sched-retention', 'sched-retention-value', settings.historyRetentionDays, 'd');
    setChecked('sched-quiet-enabled', Boolean(settings.quietHours));
    if (settings.quietHours) {
      const start = $('sched-quiet-start');
      const end = $('sched-quiet-end');
      if (start) start.value = settings.quietHours.start;
      if (end) end.value = settings.quietHours.end;
    }
  }

  function readSchedSettingsForm() {
    const quietOn = $('sched-quiet-enabled')?.checked !== false;
    return {
      active: $('sched-active')?.checked === true,
      globalMinGapSeconds: Number($('sched-min-gap')?.value || 5) * 60,
      tickSeconds: Number($('sched-tick')?.value || 30),
      historyRetentionDays: Number($('sched-retention')?.value || 30),
      quietHours: quietOn
        ? { start: $('sched-quiet-start')?.value || '23:00', end: $('sched-quiet-end')?.value || '07:00' }
        : null,
    };
  }

  async function saveSchedSettings() {
    try {
      const result = await apiFetch(`${SCHED_ROUTE}/settings`, {
        method: 'PUT', body: readSchedSettingsForm(),
      });
      renderSchedSettings(result.settings);
    } catch (error) {
      toast(error.message || 'Could not save scheduler settings', 'bad');
    }
  }

  async function refreshSchedStatus() {
    try {
      const status = await apiFetch(`${SCHED_ROUTE}/status`);
      const nextUp = $('sched-nextup');
      const hint = $('sched-nextup-hint');
      const card = $('sched-nextup-card');
      if (nextUp) {
        if (!status.active) {
          nextUp.textContent = 'Paused — nothing will air automatically';
        } else if (status.inQuietHours) {
          nextUp.textContent = 'Quiet hours — nothing will air until they end';
        } else if (status.nextUp) {
          nextUp.textContent = `Next up: ${status.nextUp.label} ${relativeTime(status.nextUp.dueAt)}`;
        } else {
          nextUp.textContent = 'No enabled rules';
        }
      }
      // The paused / quiet-hours lines are the status. Hide the always-on
      // "what the scheduler is" hint so it cannot be read as a second paused.
      if (hint) {
        hint.hidden = !status.active || Boolean(status.inQuietHours);
      }
      if (card) {
        card.classList.toggle('is-paused', !status.active);
        card.classList.toggle('is-quiet', Boolean(status.active && status.inQuietHours));
      }
      return status;
    } catch {
      return null;
    }
  }

  function renderSchedCommandPicker() {
    const select = $('sched-add-command');
    if (!select) return;
    const groups = new Map();
    for (const command of schedCommands.filter((entry) => entry.schedulable)) {
      if (!groups.has(command.group)) groups.set(command.group, []);
      groups.get(command.group).push(command);
    }
    select.innerHTML = [...groups.entries()].map(([group, commands]) => (
      `<optgroup label="${escapeHtml(group)}">${commands.map((command) => (
        `<option value="${escapeHtml(command.id)}">${escapeHtml(command.title)}</option>`
      )).join('')}</optgroup>`
    )).join('');
  }

  // ---------------------------------------------------- activity view

  function renderSchedStats(status, stats) {
    const host = $('sched-stats');
    if (!host) return;
    const airings = status?.airingsToday ?? 0;
    const evals = status?.evaluationsToday ?? 0;
    const hit = status?.hitRate == null ? '—' : `${Math.round(status.hitRate * 100)}%`;
    const cells = [
      [airings, 'airings today'],
      [evals, 'evaluations'],
      [hit, 'hit rate'],
      [status?.nextUp ? formatDuration(status.nextUp.inSeconds) : '—',
        status?.nextUp ? status.nextUp.label : 'next up'],
      [status?.lastAiringAt ? relativeTime(status.lastAiringAt) : '—', 'last aired'],
    ];
    host.innerHTML = cells.map(([value, label]) => (
      `<div class="sched-stat"><div class="sched-stat-value">${escapeHtml(String(value))}</div>`
      + `<div class="sched-stat-label">${escapeHtml(label)}</div></div>`
    )).join('');
  }

  const SCHED_LANE_H = 32;
  const SCHED_LANE_GAP = 8;
  const SCHED_LABEL_W = 120;

  /**
   * Hand-rolled inline SVG. The timeline is not a standard chart type — no
   * charting library is bundled and forcing this into a scatter plot would cost
   * more than the ~60 lines below.
   */
  function renderSchedTimeline(events, rules, { fromMs, toMs, showSkips }) {
    const svg = $('sched-timeline');
    const empty = $('sched-timeline-empty');
    if (!svg) return;
    const lanes = rules.filter((rule) => rule.enabled || events.some((e) => e.ruleId === rule.id));
    const width = 900;
    const height = Math.max(60, lanes.length * (SCHED_LANE_H + SCHED_LANE_GAP) + 34);
    const plotW = width - SCHED_LABEL_W - 12;
    const x = (ms) => SCHED_LABEL_W + ((ms - fromMs) / Math.max(1, toMs - fromMs)) * plotW;

    if (!lanes.length) {
      svg.innerHTML = '';
      svg.setAttribute('viewBox', '0 0 10 10');
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'No rules yet — add one on the Rules tab and activity will appear here.';
      }
      return;
    }

    const parts = [];
    // Quiet-hours bands under everything, so "nothing fired at 3am" reads as a
    // deliberate window rather than a mystery.
    if (schedSettings?.quietHours) {
      for (const [start, end] of quietBands(fromMs, toMs, schedSettings.quietHours)) {
        parts.push(`<rect x="${x(start).toFixed(1)}" y="0" width="${Math.max(0, x(end) - x(start)).toFixed(1)}" `
          + `height="${lanes.length * (SCHED_LANE_H + SCHED_LANE_GAP)}" fill="rgba(150,200,255,0.08)"/>`);
      }
    }

    lanes.forEach((rule, index) => {
      const top = index * (SCHED_LANE_H + SCHED_LANE_GAP);
      const cy = top + SCHED_LANE_H / 2;
      parts.push(`<line x1="${SCHED_LABEL_W}" y1="${cy}" x2="${width - 12}" y2="${cy}" `
        + 'stroke="rgba(150,200,255,0.18)" stroke-width="1"/>');
      parts.push(`<text x="0" y="${cy + 4}" fill="#A4ACC0" font-size="11">`
        + `${escapeHtml(truncate(rule.label, 18))}</text>`);

      for (const event of events.filter((entry) => entry.ruleId === rule.id)) {
        const at = Date.parse(event.at);
        if (at < fromMs || at > toMs) continue;
        const blocked = event.outcome.startsWith('blocked-');
        if (!showSkips && event.outcome !== 'aired') continue;
        const px = x(at);
        const attrs = `data-event-id="${escapeHtml(event.id)}" class="sched-mark" style="cursor:pointer"`;
        if (event.outcome === 'aired' && event.durationSeconds > 60) {
          // A variable-duration round is a block of time in which nothing else
          // could air; drawing it to scale is what makes the gaps legible.
          const w = Math.max(3, x(at + event.durationSeconds * 1000) - px);
          parts.push(`<rect ${attrs} x="${px.toFixed(1)}" y="${(cy - 6).toFixed(1)}" width="${w.toFixed(1)}" `
            + `height="12" rx="2" fill="${escapeHtml(rule.color)}"`
            + `${event.interrupted ? ' stroke="#F2F7FF" stroke-dasharray="3 2"' : ''}/>`);
        } else if (event.outcome === 'aired') {
          parts.push(`<circle ${attrs} cx="${px.toFixed(1)}" cy="${cy}" r="5" fill="${escapeHtml(rule.color)}"/>`);
        } else if (event.outcome === 'lost-dice') {
          parts.push(`<circle ${attrs} cx="${px.toFixed(1)}" cy="${cy}" r="3.5" fill="none" `
            + `stroke="${escapeHtml(rule.color)}" stroke-width="1.5"/>`);
        } else if (event.outcome === 'error') {
          parts.push(`<path ${attrs} d="M${px.toFixed(1)} ${cy - 4} l4 7 l-8 0 Z" fill="#FF7A6B"/>`);
        } else if (blocked) {
          parts.push(`<path ${attrs} d="M${(px - 3).toFixed(1)} ${cy - 3} l6 6 M${(px + 3).toFixed(1)} ${cy - 3} l-6 6" `
            + 'stroke="#6B7388" stroke-width="1.4" opacity="0.5"/>');
        } else {
          // lost-tiebreak / expired-pending: half circle.
          parts.push(`<path ${attrs} d="M${px.toFixed(1)} ${cy - 3.5} a3.5 3.5 0 0 1 0 7 Z" `
            + `fill="${escapeHtml(rule.color)}"/>`);
        }
      }
    });

    const axisY = lanes.length * (SCHED_LANE_H + SCHED_LANE_GAP) + 16;
    for (let i = 0; i <= 4; i += 1) {
      const ms = fromMs + ((toMs - fromMs) * i) / 4;
      parts.push(`<text x="${x(ms).toFixed(1)}" y="${axisY}" fill="#6B7388" font-size="10" `
        + `text-anchor="middle">${new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`);
    }
    // Now marker at the right edge.
    parts.push(`<line x1="${x(toMs).toFixed(1)}" y1="0" x2="${x(toMs).toFixed(1)}" y2="${axisY - 12}" `
      + 'stroke="#5FD0FF" stroke-width="1.5"/>');

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('height', String(height));
    svg.innerHTML = parts.join('');
    if (empty) {
      empty.hidden = events.length > 0;
      empty.textContent = events.length
        ? ''
        : 'No activity in this window yet. Tap a rule on the Rules tab to see when it is next due.';
    }
  }

  function quietBands(fromMs, toMs, quietHours) {
    const bands = [];
    const toMinutes = (value) => {
      const [h, m] = String(value).split(':').map(Number);
      return h * 60 + m;
    };
    const start = toMinutes(quietHours.start);
    const end = toMinutes(quietHours.end);
    const day = new Date(fromMs);
    day.setHours(0, 0, 0, 0);
    for (let d = day.getTime() - 86400000; d <= toMs; d += 86400000) {
      const s = d + start * 60000;
      const e = d + (end > start ? end : end + 1440) * 60000;
      if (e > fromMs && s < toMs) {
        bands.push([Math.max(s, fromMs), Math.min(e, toMs)]);
      }
    }
    return bands;
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function showSchedInspector(eventId) {
    const host = $('sched-inspector');
    const event = schedEvents.find((entry) => entry.id === eventId);
    if (!host || !event) return;
    const rule = schedRules.find((entry) => entry.id === event.ruleId);
    const rows = [
      ['Rule', rule?.label || event.ruleId],
      ['When', new Date(event.at).toLocaleString()],
      ['Outcome', OUTCOME_LABELS[event.outcome] || event.outcome],
    ];
    if (event.rolledValue != null) {
      rows.push(['Dice', `rolled ${event.rolledValue} against ${rule?.probability ?? '?'}%`]);
    }
    if (event.score != null) {
      rows.push(['Score', event.score.toFixed(2)]);
    }
    if (event.competingRuleIds?.length > 1) {
      // The payoff feature: "why didn't the slideshow show at 3pm" in two clicks.
      rows.push(['Competed against', event.competingRuleIds
        .filter((id) => id !== event.ruleId)
        .map((id) => schedRules.find((entry) => entry.id === id)?.label || id)
        .join(', ')]);
    }
    if (event.durationSeconds != null) {
      rows.push(['On screen', formatDuration(event.durationSeconds)
        + (event.interrupted ? ' (interrupted)' : '')]);
    }
    if (event.detail) {
      rows.push(['Detail', event.detail]);
    }
    host.hidden = false;
    host.innerHTML = '<div class="section-label" style="margin:0 0 4px">Event</div><dl>'
      + rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')
      + '</dl>';
  }

  function renderSchedRuleStats(stats, daily) {
    const host = $('sched-rule-stats');
    if (!host) return;
    if (!stats.length) {
      host.innerHTML = '<div class="card"><p class="hint">No evaluations in this window yet.</p></div>';
      return;
    }
    const hours = { '6h': 6, '12h': 12, '24h': 24, '7d': 168 }[schedRange] || 24;
    host.innerHTML = stats.map((entry) => {
      const rule = schedRules.find((item) => item.id === entry.ruleId);
      const expected = Math.round((rule?.expectedPerDay || 0) * (hours / 24) * 10) / 10;
      const scale = Math.max(expected, entry.aired, 1);
      const skip = entry.dominantSkip;
      return `<div class="card sched-rule">
        <div class="sched-rule-head">
          <i class="sched-dot" style="background:${escapeHtml(rule?.color || '#5FD0FF')}"></i>
          <span class="sched-rule-name">${escapeHtml(rule?.label || entry.ruleId)}</span>
        </div>
        <div class="sched-readout">expected ≈${expected} · actual <strong>${entry.aired}</strong>
          · hit ${entry.hitRate == null ? '—' : `${Math.round(entry.hitRate * 100)}%`}
          ${entry.avgGapSeconds ? `· avg gap ${formatDuration(entry.avgGapSeconds)}` : ''}
          ${entry.longestGapSeconds ? `· longest ${formatDuration(entry.longestGapSeconds)}` : ''}</div>
        <div class="sched-evsa">
          <div class="sched-evsa-fill" style="width:${Math.min(100, (entry.aired / scale) * 100)}%;
               background:${escapeHtml(rule?.color || '#5FD0FF')}"></div>
          <div class="sched-evsa-marker" style="left:${Math.min(100, (expected / scale) * 100)}%"></div>
        </div>
        ${sparklineHtml(daily?.[entry.ruleId], rule?.color)}
        ${skip && skip.outcome !== 'aired' && skip.count > entry.aired
    ? `<div class="sched-warning">⚠ ${skip.count} skipped — ${escapeHtml(
      (OUTCOME_LABELS[skip.outcome] || skip.outcome).toLowerCase(),
    )}</div>` : ''}
      </div>`;
    }).join('');
  }

  function sparklineHtml(series, color) {
    if (!Array.isArray(series) || !series.length) return '';
    const max = Math.max(1, ...series);
    const step = 100 / series.length;
    const bars = series.map((value, index) => {
      const h = (value / max) * 100;
      return `<rect x="${(index * step + step * 0.15).toFixed(2)}" y="${(100 - h).toFixed(2)}" `
        + `width="${(step * 0.7).toFixed(2)}" height="${h.toFixed(2)}" fill="${escapeHtml(color || '#5FD0FF')}"/>`;
    }).join('');
    return `<svg class="sched-spark" viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg>`;
  }

  function renderSchedHeatmap(rows) {
    const host = $('sched-heatmap');
    if (!host) return;
    const max = Math.max(1, ...rows.flatMap((row) => row.hours));
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const header = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => (
      `<th>${h % 2 === 0 ? String(h).padStart(2, '0') : ''}</th>`
    )).join('')}</tr>`;
    const body = rows.map((row) => {
      const cells = row.hours.map((count) => {
        if (!count) return '<td class="sched-heat-0"></td>';
        // Five steps of a single hue; zero is an outline so "none" and "few"
        // are never confused.
        const step = Math.ceil((count / max) * 5);
        return `<td style="background:rgba(95,208,255,${(step * 0.18).toFixed(2)})" title="${count}"></td>`;
      }).join('');
      return `<tr><th>${names[row.weekday]}</th>${cells}</tr>`;
    }).join('');
    host.innerHTML = `<table>${header}${body}</table>`;
  }

  async function loadSchedActivity() {
    const status = await refreshSchedStatus();
    try {
      const [activity, stats, heatmap] = await Promise.all([
        apiFetch(`${SCHED_ROUTE}/activity?window=${schedRange}`),
        apiFetch(`${SCHED_ROUTE}/stats?window=${schedRange}`),
        apiFetch(`${SCHED_ROUTE}/heatmap?days=14`),
      ]);
      schedEvents = activity.events || [];
      schedRules = activity.rules || schedRules;
      renderSchedStats(status, stats.stats);
      renderSchedTimeline(schedEvents, schedRules, {
        fromMs: Date.parse(activity.from),
        toMs: Date.parse(activity.to),
        showSkips: $('sched-show-skips')?.checked !== false,
      });
      renderSchedRuleStats(stats.stats || [], stats.daily || {});
      renderSchedHeatmap(heatmap.rows || []);
    } catch (error) {
      toast(error.message || 'Could not load scheduler activity', 'bad');
    }
  }

  // ------------------------------------------------------------ wiring

  const schedPanel = $('tab-scheduler');
  if (schedPanel) {
    schedPanel.addEventListener('change', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const card = target.closest('[data-rule-id]');
      if (card && (target.dataset.schedField || target.dataset.schedParam)) {
        queueSchedRuleSave(card.dataset.ruleId, card);
        return;
      }
      if (target.closest('#sched-view-rules') || target.id === 'sched-active') {
        if (target.id === 'sched-show-skips') return;
        await saveSchedSettings();
        return;
      }
      if (target.id === 'sched-show-skips') {
        await loadSchedActivity();
      }
    });

    schedPanel.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'range') return;
      const readout = target.parentElement?.querySelector('[data-sched-readout], .slider-value');
      if (!readout) return;
      if (target.dataset.schedField === 'probability') {
        readout.textContent = `${target.value}%`;
      } else if (target.id === 'sched-min-gap') {
        readout.textContent = `${target.value}m`;
      } else if (target.id === 'sched-tick') {
        readout.textContent = `${target.value}s`;
      } else if (target.id === 'sched-retention') {
        readout.textContent = `${target.value}d`;
      }
    });

    schedPanel.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const mark = target.closest('[data-event-id]');
      if (mark) {
        showSchedInspector(mark.dataset.eventId);
        return;
      }

      const viewBtn = target.closest('[data-sched-view]');
      if (viewBtn) {
        const view = viewBtn.dataset.schedView;
        document.querySelectorAll('#sched-view-tabs .segmented-btn').forEach((btn) => {
          btn.classList.toggle('active', btn === viewBtn);
        });
        $('sched-view-rules').hidden = view !== 'rules';
        $('sched-view-activity').hidden = view !== 'activity';
        if (view === 'activity') await loadSchedActivity();
        return;
      }

      const rangeBtn = target.closest('[data-range]');
      if (rangeBtn) {
        schedRange = rangeBtn.dataset.range;
        document.querySelectorAll('#sched-range-tabs .segmented-btn').forEach((btn) => {
          btn.classList.toggle('active', btn === rangeBtn);
        });
        await loadSchedActivity();
        return;
      }

      const action = target.closest('[data-sched-action]')?.dataset.schedAction;
      const card = target.closest('[data-rule-id]');
      if (action && card) {
        const ruleId = card.dataset.ruleId;
        try {
          if (action === 'air') {
            const rule = schedRules.find((entry) => entry.id === ruleId);
            const button = target.closest('[data-sched-action="air"]');
            if (button instanceof HTMLButtonElement) button.disabled = true;
            try {
              await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}/air`, { method: 'POST' });
              toast(`${rule?.label || 'Rule'} aired`, 'good');
            } finally {
              if (button instanceof HTMLButtonElement) button.disabled = false;
            }
          } else if (action === 'delete') {
            await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
          }
          await loadSchedRules();
          await refreshSchedStatus();
        } catch (error) {
          toast(error.message || 'Action failed', 'bad');
        }
      }
    });

    $('btn-sched-add')?.addEventListener('click', async () => {
      const commandId = $('sched-add-command')?.value;
      if (!commandId) return;
      try {
        await apiFetch(`${SCHED_ROUTE}/rules`, {
          method: 'POST',
          body: { commandId, intervalSeconds: 2700, probability: 90 },
        });
        await loadSchedRules();
        await refreshSchedStatus();
      } catch (error) {
        toast(error.message || 'Could not add rule', 'bad');
      }
    });

    $('btn-sched-simulate')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const host = $('sched-simulation');
      button.disabled = true;
      try {
        const result = await apiFetch(`${SCHED_ROUTE}/simulate`, {
          method: 'POST', body: { hours: 24, runs: 200 },
        });
        if (host) {
          host.hidden = false;
          host.innerHTML = '<p class="hint" style="margin-top:12px">Forecast for the next 24 hours — '
            + `average of ${result.runs} runs. Scheduling is stochastic, so a real day will differ.</p>`
            + result.perRule.map((entry) => (
              `<div class="sched-readout"><i class="sched-dot" style="background:${escapeHtml(entry.color)};`
              + `display:inline-block;margin-right:6px"></i>${escapeHtml(entry.label)}: `
              + `<strong>≈${entry.simulated}</strong> airings (expected ${entry.expected})</div>`
            )).join('');
        }
      } catch (error) {
        toast(error.message || 'Could not run the simulation', 'bad');
      } finally {
        button.disabled = false;
      }
    });

    document.querySelector('.tab-btn[data-tab="scheduler"]')?.addEventListener('click', async () => {
      await refreshSchedStatus();
      if (!$('sched-view-activity')?.hidden) {
        await loadSchedActivity();
      }
    });

    (async () => {
      try {
        const [settings, commands] = await Promise.all([
          apiFetch(`${SCHED_ROUTE}/settings`),
          apiFetch('/api/commands'),
        ]);
        renderSchedSettings(settings.settings);
        schedCommands = commands.commands || [];
        renderSchedCommandPicker();
        await loadSchedRules();
        await refreshSchedStatus();
      } catch {
        // Scheduler unavailable on this bridge — leave the tab in its empty state.
      }
    })();
  }

  // ------------------------------------------ Settings → YouTube

  const YOUTUBE_ROUTE = '/api/youtube';
  const YOUTUBE_DEVICE_STATUS = {
    linked: 'Linked',
    refreshing: 'Linking…',
    'needs-relink': 'Needs re-linking',
    unreachable: 'Not reachable',
  };

  let youtubeSettings = null;
  let youtubeDevices = [];
  let youtubeSaveTimer = null;

  function renderYoutubeDevices(devices) {
    youtubeDevices = devices || [];
    const list = $('youtube-devices');
    const empty = $('youtube-devices-empty');
    if (!list) {
      return;
    }
    list.innerHTML = youtubeDevices.map((device) => {
      const state = device.enabled === false ? 'off' : (device.status || 'linked');
      const detail = device.enabled === false
        ? 'Paused'
        : (device.statusDetail || YOUTUBE_DEVICE_STATUS[device.status] || 'Linked');
      const seen = device.lastSeenAt ? ` · seen ${relativeTime(device.lastSeenAt)}` : '';
      return `<div class="yt-device" data-device-id="${escapeHtml(device.id)}">
        <span class="yt-dot is-${escapeHtml(state)}"></span>
        <div class="yt-device-main">
          <div class="yt-device-name">${escapeHtml(device.label)}</div>
          <div class="yt-device-sub">${escapeHtml(detail)}${seen}</div>
        </div>
        <div class="yt-device-actions">
          <button class="btn btn-outline" data-yt-action="toggle">${device.enabled === false ? 'Resume' : 'Pause'}</button>
          <button class="btn btn-outline" data-yt-action="relink">Re-link</button>
          <button class="btn btn-outline" data-yt-action="remove">Remove</button>
        </div>
      </div>`;
    }).join('');
    if (empty) {
      empty.hidden = youtubeDevices.length > 0;
    }
    renderYoutubePreferredDevice();
  }

  function renderYoutubePreferredDevice() {
    const select = $('youtube-preferred-device');
    if (!select) {
      return;
    }
    const preferred = youtubeSettings?.multiDevice === 'preferred';
    select.hidden = !preferred || youtubeDevices.length === 0;
    select.innerHTML = youtubeDevices.map((device) => {
      const selected = device.id === youtubeSettings?.preferredDeviceId ? ' selected' : '';
      return `<option value="${escapeHtml(device.id)}"${selected}>${escapeHtml(device.label)}</option>`;
    }).join('');
  }

  function renderYoutubeQuota(cache) {
    const box = $('youtube-quota');
    if (!box) {
      return;
    }
    if (!cache) {
      box.innerHTML = '';
      return;
    }
    const used = Number(cache.quotaUsedToday || 0);
    const limit = Number(cache.quotaLimit || 10000);
    const hitRate = cache.hitRate == null ? null : Math.round(cache.hitRate * 100);
    box.innerHTML = [
      `<span class="${used > limit * 0.8 ? 'is-high' : ''}">Quota today <strong>${used.toLocaleString()}</strong> / ${limit.toLocaleString()}</span>`,
      `<span>Cached <strong>${Number(cache.videos || 0).toLocaleString()}</strong> videos, <strong>${Number(cache.channels || 0).toLocaleString()}</strong> channels</span>`,
      hitRate == null ? '' : `<span>Cache hits <strong>${hitRate}%</strong></span>`,
    ].filter(Boolean).join('');
  }

  function renderYoutubeSettings(settings) {
    youtubeSettings = settings;
    setChecked('youtube-show-description', settings.showDescription);
    setChecked('youtube-show-subscribers', settings.showSubscribers);
    setChecked('youtube-show-dislikes', settings.showDislikes);
    setChecked('youtube-show-shorts', settings.showShorts);
    setTriviaSlider('youtube-confirm-seconds', 'youtube-confirm-seconds-value', settings.confirmSeconds, 's');
    setTriviaSlider('youtube-description-lines', 'youtube-description-lines-value', settings.descriptionLines, '');
    document.querySelectorAll('#youtube-multi-device .segmented-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === settings.multiDevice);
    });
    renderYoutubePreferredDevice();
  }

  function renderYoutubeStatus(status) {
    const pill = $('youtube-status-pill');
    const detail = $('youtube-status-detail');
    if (!pill || !detail) {
      return;
    }
    let tone = 'warn';
    let label = 'Not linked';
    let text = 'Link the TV that runs YouTube to show what is playing.';

    if (status.enabled === false) {
      tone = 'off';
      label = 'Off';
      text = 'The YouTube agent is disabled on this bridge.';
    } else if (status.lounge?.unavailableReason) {
      // Say this up front — without it, linking and scanning both fail with
      // nothing on the card to explain why.
      tone = 'bad';
      label = 'Agent down';
      text = status.lounge.unavailableReason;
    } else if (status.needsRelink?.length) {
      tone = 'bad';
      label = 'Needs re-linking';
      text = `YouTube dropped the link for ${status.needsRelink.join(', ')}.`;
    } else if (!status.configured) {
      // Keeps the default copy.
    } else if (!status.hasApiKey) {
      label = 'No API key';
      text = 'Playback is detected, but titles and stats need a Data API key.';
    } else if (status.playing) {
      tone = 'ok';
      label = 'Playing';
      text = `Playing on ${status.deviceLabel || 'a linked TV'}.`;
    } else {
      tone = 'ok';
      label = 'Watching';
      const last = status.lastPlayed?.title;
      text = last ? `Idle — last played "${last}".` : 'Idle — nothing playing right now.';
    }
    pill.textContent = label;
    pill.className = `status-pill is-${tone}`;
    detail.textContent = text;
    renderYoutubeQuota(status.cache);
  }

  function readYoutubeForm() {
    const active = document.querySelector('#youtube-multi-device .segmented-btn.active');
    return {
      showDescription: $('youtube-show-description')?.checked !== false,
      showSubscribers: $('youtube-show-subscribers')?.checked !== false,
      showDislikes: $('youtube-show-dislikes')?.checked !== false,
      showShorts: $('youtube-show-shorts')?.checked === true,
      confirmSeconds: Number($('youtube-confirm-seconds')?.value ?? 5),
      descriptionLines: Number($('youtube-description-lines')?.value ?? 3),
      multiDevice: active?.dataset.mode || 'most-recent',
      preferredDeviceId: $('youtube-preferred-device')?.value || null,
    };
  }

  async function saveYoutubeSettings() {
    if (!youtubeSettings) {
      return;
    }
    try {
      const result = await apiFetch(`${YOUTUBE_ROUTE}/settings`, {
        method: 'PUT', body: readYoutubeForm(),
      });
      renderYoutubeSettings(result.settings);
    } catch (error) {
      toast(error.message || 'Could not save YouTube settings', 'bad');
    }
  }

  function queueYoutubeSave() {
    clearTimeout(youtubeSaveTimer);
    youtubeSaveTimer = setTimeout(saveYoutubeSettings, 400);
  }

  async function refreshYoutubeDevices() {
    const result = await apiFetch(`${YOUTUBE_ROUTE}/devices`);
    renderYoutubeDevices(result.devices);
  }

  async function refreshYoutubeStatus() {
    try {
      const status = await apiGet('/api/status');
      if (status?.youtube) {
        renderYoutubeStatus(status.youtube);
      }
    } catch {
      // The status poll will try again.
    }
  }

  async function loadYoutubeSettings() {
    const card = $('youtube-settings-card');
    if (!card) {
      return;
    }
    try {
      const settings = await apiFetch(`${YOUTUBE_ROUTE}/settings`);
      renderYoutubeSettings(settings.settings);
      await refreshYoutubeDevices();
      await refreshYoutubeStatus();
    } catch {
      // YouTube not wired up on this bridge — hide the card rather than
      // leaving a permanently broken one on the page.
      card.hidden = true;
      const label = card.previousElementSibling;
      if (label?.classList.contains('section-label')) {
        label.hidden = true;
      }
    }
  }

  async function linkYoutubeDevice({ pairingCode = null, screenId = null, label = null } = {}) {
    const button = $('btn-youtube-link');
    if (button) button.disabled = true;
    try {
      await apiFetch(`${YOUTUBE_ROUTE}/devices/link`, {
        method: 'POST', body: { pairingCode, screenId, label },
      });
      const code = $('youtube-pair-code');
      const name = $('youtube-pair-label');
      if (code) code.value = '';
      if (name) name.value = '';
      const found = $('youtube-discovered');
      if (found) {
        found.hidden = true;
        found.innerHTML = '';
      }
      await refreshYoutubeDevices();
      await refreshYoutubeStatus();
      toast('TV linked', 'ok');
    } catch (error) {
      toast(error.message || 'Could not link that TV', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  }

  const youtubeCard = $('youtube-settings-card');
  if (youtubeCard) {
    youtubeCard.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.matches('input[type="checkbox"]')) {
        target.closest('.trivia-check')?.classList.toggle('is-off', !target.checked);
        queueYoutubeSave();
      } else if (target.matches('input[type="range"], select')) {
        queueYoutubeSave();
      }
    });
    youtubeCard.addEventListener('input', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const label = $(`${target.id}-value`);
        if (label) {
          label.textContent = target.id === 'youtube-description-lines'
            ? target.value
            : `${target.value}s`;
        }
      }
    });

    youtubeCard.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const mode = target.closest('#youtube-multi-device .segmented-btn');
      if (mode) {
        document.querySelectorAll('#youtube-multi-device .segmented-btn').forEach((button) => {
          button.classList.toggle('active', button === mode);
        });
        const select = $('youtube-preferred-device');
        if (select) {
          select.hidden = mode.dataset.mode !== 'preferred' || youtubeDevices.length === 0;
        }
        await saveYoutubeSettings();
        return;
      }

      const pick = target.closest('[data-yt-screen-id]');
      if (pick) {
        await linkYoutubeDevice({
          screenId: pick.dataset.ytScreenId,
          label: pick.dataset.ytName || null,
        });
        return;
      }

      const action = target.dataset.ytAction;
      const row = target.closest('[data-device-id]');
      if (!action || !row) {
        return;
      }
      const id = encodeURIComponent(row.dataset.deviceId);
      const device = youtubeDevices.find((entry) => entry.id === row.dataset.deviceId);
      target.disabled = true;
      try {
        if (action === 'toggle') {
          await apiFetch(`${YOUTUBE_ROUTE}/devices/${id}`, {
            method: 'PUT', body: { enabled: device?.enabled === false },
          });
        } else if (action === 'relink') {
          await apiFetch(`${YOUTUBE_ROUTE}/devices/${id}/relink`, { method: 'POST' });
          toast('Re-linked', 'ok');
        } else if (action === 'remove') {
          await apiFetch(`${YOUTUBE_ROUTE}/devices/${id}`, { method: 'DELETE' });
        }
        await refreshYoutubeDevices();
        await refreshYoutubeStatus();
      } catch (error) {
        toast(error.message || 'Action failed', 'bad');
      } finally {
        target.disabled = false;
      }
    });

    // YouTube shows the code as "123 456 789 012" — keep that grouping while
    // the user types so a pasted or keyed 12-digit string never looks wrong.
    function formatYoutubePairCode(raw) {
      const digits = String(raw || '').replace(/\D/g, '').slice(0, 12);
      return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
    }

    $('youtube-pair-code')?.addEventListener('input', (event) => {
      const input = event.currentTarget;
      const formatted = formatYoutubePairCode(input.value);
      if (input.value === formatted) {
        return;
      }
      // Digits-only cursor: spaces before the caret do not count, so regrouping
      // never jumps the insertion point past the digit the user just typed.
      const digitsBefore = String(input.value.slice(0, input.selectionStart || 0))
        .replace(/\D/g, '').length;
      input.value = formatted;
      let cursor = 0;
      let seen = 0;
      while (cursor < formatted.length && seen < digitsBefore) {
        if (/\d/.test(formatted[cursor])) {
          seen += 1;
        }
        cursor += 1;
      }
      input.setSelectionRange(cursor, cursor);
    });

    $('btn-youtube-link')?.addEventListener('click', () => {
      const code = String($('youtube-pair-code')?.value || '').replace(/\s+/g, '');
      if (!code) {
        toast('Paste the TV code from YouTube on the TV', 'bad');
        return;
      }
      linkYoutubeDevice({
        pairingCode: code,
        label: String($('youtube-pair-label')?.value || '').trim() || null,
      });
    });

    $('btn-youtube-discover')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const box = $('youtube-discovered');
      button.disabled = true;
      button.textContent = 'Scanning…';
      try {
        const result = await apiFetch(`${YOUTUBE_ROUTE}/devices/discover`, { method: 'POST' });
        const devices = (result.devices || []).filter((entry) => !entry.alreadyLinked);
        if (box) {
          box.hidden = devices.length === 0;
          box.innerHTML = devices.map((entry) => `<button class="btn btn-outline btn-block"
            data-yt-screen-id="${escapeHtml(entry.screenId || '')}"
            data-yt-name="${escapeHtml(entry.name || '')}"
            ${entry.screenId ? '' : 'disabled'}>
            Link ${escapeHtml(entry.name || entry.address || 'this TV')}
          </button>`).join('');
        }
        if (!devices.length) {
          toast(result.devices?.length ? 'Every TV found is already linked' : 'No YouTube TVs found', 'warn');
        }
      } catch (error) {
        toast(error.message || 'Scan failed', 'bad');
      } finally {
        button.disabled = false;
        button.textContent = 'Scan the network';
      }
    });

    $('btn-youtube-api-key')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const input = $('youtube-api-key');
      const key = String(input?.value || '').trim();
      if (!key) {
        toast('Paste a YouTube Data API key', 'bad');
        return;
      }
      button.disabled = true;
      button.textContent = 'Testing…';
      try {
        await apiFetch(`${YOUTUBE_ROUTE}/api-key`, { method: 'POST', body: { apiKey: key } });
        if (input) input.value = '';
        await refreshYoutubeStatus();
        toast('API key works', 'ok');
      } catch (error) {
        toast(error.message || 'The key was rejected', 'bad');
      } finally {
        button.disabled = false;
        button.textContent = 'Save and test key';
      }
    });

    $('btn-youtube-test-push')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await apiPost('/api/push/youtube-now-playing', withTarget());
        const label = result.mode === 'last-played' ? 'Last played' : 'Now playing';
        toast(`${label}: ${result.title || 'YouTube'} (dismisses automatically)`, 'good');
      } catch (error) {
        toast(error.message, 'bad');
      } finally {
        button.disabled = false;
      }
    });

    $('btn-youtube-cache-clear')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await apiFetch(`${YOUTUBE_ROUTE}/cache/clear`, { method: 'POST' });
        renderYoutubeQuota(result);
        toast('Cache cleared', 'ok');
      } catch (error) {
        toast(error.message || 'Could not clear the cache', 'bad');
      } finally {
        button.disabled = false;
      }
    });

    loadYoutubeSettings();
  }

  // ------------------------------------------- Settings → The Upside News

  const UPSIDE_PERIOD_HINTS = {
    daily: 'Stories published in the last 24 hours',
    weekly: 'The last 7 days, best first',
    monthly: 'The last 30 days, best first',
    yearly: 'The last year, best first',
  };

  function formatCycleLength(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins <= 0) return `${secs}s`;
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
  }

  function renderUpsideNewsSettings(status) {
    const settings = status.settings || {};
    document.querySelectorAll('#upside-news-period-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.period === settings.period);
    });
    const hint = $('upside-news-period-hint');
    if (hint) hint.textContent = UPSIDE_PERIOD_HINTS[settings.period] || UPSIDE_PERIOD_HINTS.daily;
    setTriviaSlider('upside-news-items', 'upside-news-items-value', settings.items, '');
    setTriviaSlider('upside-news-story-seconds', 'upside-news-story-seconds-value', settings.storySeconds, 's');
    const loops = $('upside-news-loops');
    if (loops) loops.value = settings.loops || 'once';
    const cycle = $('upside-news-cycle-length');
    if (cycle) cycle.textContent = formatCycleLength(status.cycleSeconds);
    const guardian = $('upside-news-guardian-enabled');
    if (guardian) {
      guardian.checked = settings.guardianEnabled !== false;
      guardian.closest('.trivia-check')?.classList.toggle('is-off', !guardian.checked);
    }
    ['show-qr', 'show-reading', 'show-tags'].forEach((key) => {
      const map = {
        'show-qr': 'showQr',
        'show-reading': 'showReadingTime',
        'show-tags': 'showTopicTags',
      };
      const el = $(`upside-news-${key}`);
      if (!el) return;
      el.checked = Boolean(settings[map[key]]);
      el.closest('.trivia-check')?.classList.toggle('is-off', !el.checked);
    });
    const rssHost = $('upside-news-rss-sources');
    if (rssHost) {
      rssHost.innerHTML = (status.rssSources || []).map((source) => (
        `<label class="trivia-check${source.enabled ? '' : ' is-off'}">`
        + `<input type="checkbox" name="upsideRss" value="${escapeHtml(source.id)}"${source.enabled ? ' checked' : ''}>`
        + `<span>${escapeHtml(source.label)}</span></label>`
      )).join('');
    }
    const keyHint = $('upside-news-key-hint');
    if (keyHint) {
      if (status.apiKeySource === 'env') {
        keyHint.textContent = 'Using GUARDIAN_API_KEY from .env (takes precedence). Test uses that key unless you type a new one.';
      } else if (status.hasApiKey) {
        keyHint.textContent = 'Saved API key is on file (encrypted under data/). Test uses that key unless you type a new one.';
      } else {
        keyHint.textContent = 'Paste a key here, or set GUARDIAN_API_KEY in .env.';
      }
    }
    const archiveHint = $('upside-news-archive-hint');
    if (archiveHint) {
      const archive = status.archive || {};
      const oldest = archive.oldest
        ? new Date(archive.oldest).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : '—';
      const last = archive.lastPollAt
        ? `${Math.max(0, Math.round((Date.now() - Date.parse(archive.lastPollAt)) / 60000))}m ago`
        : 'never';
      archiveHint.textContent = `Archive: ${archive.count || 0} stories · oldest ${oldest} · last poll ${last}`
        + (archive.quotaToday ? ` · Guardian calls today ${archive.quotaToday.used}/${archive.quotaToday.limit}` : '');
    }
    const pill = $('upside-news-status-pill');
    const detail = $('upside-news-status-detail');
    if (pill) {
      pill.textContent = status.hasContent ? 'Ready' : 'Collecting';
      pill.className = `status-pill ${status.hasContent ? 'ok' : ''}`;
    }
    if (detail) {
      detail.textContent = status.hasContent
        ? `${status.available || 0} stories ready for ${settings.period || 'daily'}`
        : 'Archive is still filling — refresh after a poll, or check the Guardian key.';
    }
  }

  function readUpsideNewsForm() {
    const periodBtn = document.querySelector('#upside-news-period-tabs .segmented-btn.active');
    const rss = [...document.querySelectorAll('input[name="upsideRss"]:checked')]
      .map((el) => el.value);
    return {
      period: periodBtn?.dataset.period || 'daily',
      items: Number($('upside-news-items')?.value || 5),
      storySeconds: Number($('upside-news-story-seconds')?.value || 15),
      loops: $('upside-news-loops')?.value || 'once',
      guardianEnabled: Boolean($('upside-news-guardian-enabled')?.checked),
      enabledRssSourceIds: rss,
      showQr: Boolean($('upside-news-show-qr')?.checked),
      showReadingTime: Boolean($('upside-news-show-reading')?.checked),
      showTopicTags: Boolean($('upside-news-show-tags')?.checked),
    };
  }

  let upsideNewsSaveTimer = null;
  async function saveUpsideNewsSettings() {
    try {
      const result = await apiPost('/api/upside-news/settings', readUpsideNewsForm());
      const cycle = $('upside-news-cycle-length');
      if (cycle) cycle.textContent = formatCycleLength(result.cycleSeconds);
      await loadUpsideNewsSettings();
    } catch (error) {
      toast(error.message || 'Could not save Upside News settings', 'bad');
    }
  }

  function queueUpsideNewsSave() {
    clearTimeout(upsideNewsSaveTimer);
    upsideNewsSaveTimer = setTimeout(saveUpsideNewsSettings, 400);
  }

  async function loadUpsideNewsSettings() {
    const card = $('upside-news-settings-card');
    if (!card) return;
    try {
      const status = await apiGet('/api/upside-news/status');
      renderUpsideNewsSettings(status);
      card.hidden = false;
    } catch {
      card.hidden = true;
      const label = card.previousElementSibling;
      if (label?.classList.contains('section-label')) label.hidden = true;
    }
  }

  let upsideNewsKeyEdited = false;
  const upsideNewsCard = $('upside-news-settings-card');
  if (upsideNewsCard) {
    document.querySelectorAll('#upside-news-period-tabs .segmented-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#upside-news-period-tabs .segmented-btn')
          .forEach((other) => other.classList.toggle('active', other === btn));
        const hint = $('upside-news-period-hint');
        if (hint) hint.textContent = UPSIDE_PERIOD_HINTS[btn.dataset.period] || '';
        queueUpsideNewsSave();
      });
    });
    upsideNewsCard.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('input[type="checkbox"]')) {
        target.closest('.trivia-check')?.classList.toggle('is-off', !target.checked);
        queueUpsideNewsSave();
      } else if (target.matches('select') || target.matches('input[type="range"]')) {
        queueUpsideNewsSave();
      }
    });
    upsideNewsCard.addEventListener('input', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const isItems = target.id === 'upside-news-items';
        const label = $(isItems ? 'upside-news-items-value' : `${target.id}-value`);
        if (label) label.textContent = `${target.value}${isItems ? '' : 's'}`;
      }
    });
    const upsideNewsKeyInput = $('upside-news-api-key');
    // Strip password-manager autofill so the dotted field isn't mistaken for a saved key.
    if (upsideNewsKeyInput) {
      upsideNewsKeyInput.value = '';
      upsideNewsKeyInput.addEventListener('input', () => {
        upsideNewsKeyEdited = true;
      });
      setTimeout(() => {
        if (!upsideNewsKeyEdited) upsideNewsKeyInput.value = '';
      }, 250);
    }
    $('btn-upside-news-key-save')?.addEventListener('click', async () => {
      const apiKey = upsideNewsKeyInput?.value || '';
      try {
        await apiPost('/api/upside-news/api-key', { apiKey });
        toast('Guardian API key saved', 'ok');
        if (upsideNewsKeyInput) upsideNewsKeyInput.value = '';
        upsideNewsKeyEdited = false;
        await loadUpsideNewsSettings();
      } catch (error) {
        toast(error.message || 'Could not save API key', 'bad');
      }
    });
    $('btn-upside-news-key-test')?.addEventListener('click', async () => {
      // Ignore password-manager autofill: only send a pasted key after the
      // user typed. Otherwise Test exercises the active .env / saved key.
      const typed = upsideNewsKeyEdited
        ? String(upsideNewsKeyInput?.value || '').trim()
        : '';
      try {
        const result = await apiPost(
          '/api/upside-news/sources/test',
          typed ? { apiKey: typed } : {},
        );
        const sourceLabel = {
          env: ' (.env key)',
          session: ' (saved key)',
          config: ' (config key)',
          provided: ' (pasted key)',
        }[result.testedSource] || '';
        toast(
          result.ok ? `Guardian key works${sourceLabel}` : (result.error || 'Test failed'),
          result.ok ? 'ok' : 'bad',
        );
      } catch (error) {
        toast(error.message || 'Test failed', 'bad');
      }
    });
    $('btn-upside-news-poll')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await apiPost('/api/upside-news/archive/poll', {});
        toast('Archive refresh started', 'ok');
        setTimeout(loadUpsideNewsSettings, 4000);
      } catch (error) {
        toast(error.message || 'Could not refresh archive', 'bad');
      } finally {
        button.disabled = false;
      }
    });
    loadUpsideNewsSettings();
  }

  // ------------------------------------------- Settings → Trivia

  const TRIVIA_PROVIDER_LABELS = {
    opentdb: 'Open Trivia DB',
    'the-trivia-api': 'The Trivia API',
  };
  const TRIVIA_DIFFICULTIES = ['easy', 'medium', 'hard'];
  const TRIVIA_TYPES = [
    ['multiple', 'Multiple choice'],
    ['boolean', 'True / false'],
  ];

  let triviaSettings = null;
  let triviaSaveTimer = null;

  function formatRoundLength(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (!minutes) {
      return `${rest}s`;
    }
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }

  function triviaCheckbox(name, value, label, checked, extraHtml = '') {
    return `<label class="trivia-check${checked ? '' : ' is-off'}">`
      + `<input type="checkbox" data-trivia-list="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}>`
      + `<span>${escapeHtml(label)}</span>${extraHtml}</label>`;
  }

  function renderTriviaSettings(settings, providers) {
    triviaSettings = settings;
    const providerBox = $('trivia-providers');
    if (providerBox) {
      providerBox.innerHTML = (providers || []).map((provider) => triviaCheckbox(
        'enabledProviders', provider.id,
        TRIVIA_PROVIDER_LABELS[provider.id] || provider.id,
        settings.enabledProviders.includes(provider.id),
      )).join('');
    }
    const attributionHint = $('trivia-attribution-hint');
    if (attributionHint) {
      // Attribution is a licence condition, so show which one is in force.
      const active = (providers || []).filter((provider) => provider.enabled);
      attributionHint.textContent = active.length
        ? `Credited on screen: ${active.map((provider) => provider.attribution?.label || provider.id).join(' · ')}`
        : 'Enable at least one source or the pool cannot restock.';
    }

    const difficultyBox = $('trivia-difficulties');
    if (difficultyBox) {
      difficultyBox.innerHTML = TRIVIA_DIFFICULTIES.map((level) => triviaCheckbox(
        'enabledDifficulties', level, level[0].toUpperCase() + level.slice(1),
        settings.enabledDifficulties.includes(level),
      )).join('');
    }
    const typeBox = $('trivia-types');
    if (typeBox) {
      typeBox.innerHTML = TRIVIA_TYPES.map(([id, label]) => triviaCheckbox(
        'enabledTypes', id, label, settings.enabledTypes.includes(id),
      )).join('');
    }

    setTriviaSlider('trivia-count-slider', 'trivia-count-value', settings.questionsPerSession, '');
    setTriviaSlider('trivia-question-seconds', 'trivia-question-seconds-value', settings.questionSeconds, 's');
    setTriviaSlider('trivia-answer-seconds', 'trivia-answer-seconds-value', settings.answerSeconds, 's');
    setChecked('trivia-show-intro', settings.showIntroCard);
    setChecked('trivia-show-summary', settings.showSummaryCard);
    setChecked('trivia-shuffle-categories', settings.shuffleCategories);
  }

  function setTriviaSlider(sliderId, labelId, value, suffix) {
    const slider = $(sliderId);
    const label = $(labelId);
    if (slider) {
      slider.value = String(value);
      slider.setAttribute('aria-valuenow', String(value));
    }
    if (label) {
      label.textContent = `${value}${suffix}`;
    }
  }

  function setChecked(id, value) {
    const input = $(id);
    if (input) {
      input.checked = value !== false;
    }
  }

  function renderTriviaCategories(categories) {
    const grid = $('trivia-categories');
    if (!grid) {
      return;
    }
    grid.innerHTML = (categories || []).map((category) => triviaCheckbox(
      'enabledCategoryIds', category.id, category.label, category.enabled,
      `<span class="trivia-category-count${category.starved ? ' is-starved' : ''}">${category.count}</span>`,
    )).join('');

    const starved = (categories || []).filter((c) => c.enabled && c.starved);
    const hint = $('trivia-starved-hint');
    if (hint) {
      hint.hidden = starved.length === 0;
      hint.textContent = starved.length
        ? `Thin on questions: ${starved.map((c) => c.label).join(', ')}. `
          + 'Rounds still air — the pool widens its search rather than running short.'
        : '';
    }
  }

  function renderTriviaStatus(status) {
    const pill = $('trivia-status-pill');
    const detail = $('trivia-status-detail');
    const size = Number(status?.size || 0);
    const available = Number(status?.available || 0);
    const target = Number(status?.settings?.poolTargetSize || 0);
    if (pill) {
      const ready = status?.hasContent;
      pill.textContent = status?.refilling ? 'Restocking…' : (ready ? `${available} ready` : 'Stocking');
      pill.className = `status-pill ${ready ? 'ok' : 'warn'}`;
    }
    if (detail) {
      // `available` excludes recently-served questions, so it is usually lower
      // than the raw cache size — showing both avoids a confusing "3 ready of 300".
      const bits = [`${available} eligible of ${size} cached (target ${target})`];
      if (status?.categoryTarget) {
        bits.push(`${status.categoryTarget} per category`);
      }
      if (status?.lastRefillAt) {
        bits.push(`last topped up ${new Date(status.lastRefillAt).toLocaleTimeString()}`);
      }
      if (status?.lastError) {
        bits.push(`last error: ${status.lastError}`);
      }
      detail.textContent = bits.join(' · ');
    }
    const length = $('trivia-round-length');
    if (length) {
      length.textContent = formatRoundLength(status?.roundDurationSeconds);
    }
  }

  function collectTriviaList(name) {
    return Array.from(
      document.querySelectorAll(`input[data-trivia-list="${name}"]:checked`),
    ).map((input) => input.value);
  }

  function readTriviaForm() {
    return {
      enabledProviders: collectTriviaList('enabledProviders'),
      enabledDifficulties: collectTriviaList('enabledDifficulties'),
      enabledTypes: collectTriviaList('enabledTypes'),
      enabledCategoryIds: collectTriviaList('enabledCategoryIds'),
      questionsPerSession: Number($('trivia-count-slider')?.value || 5),
      questionSeconds: Number($('trivia-question-seconds')?.value || 15),
      answerSeconds: Number($('trivia-answer-seconds')?.value || 7),
      showIntroCard: $('trivia-show-intro')?.checked !== false,
      showSummaryCard: $('trivia-show-summary')?.checked !== false,
      shuffleCategories: $('trivia-shuffle-categories')?.checked !== false,
    };
  }

  async function saveTriviaSettings() {
    if (!triviaSettings) {
      return;
    }
    try {
      const result = await apiPost('/api/trivia/settings', readTriviaForm());
      triviaSettings = result.settings || triviaSettings;
      const length = $('trivia-round-length');
      if (length) {
        length.textContent = formatRoundLength(result.roundDurationSeconds);
      }
      // Category counts are judged against questionsPerSession, so a slider
      // move can turn a healthy category amber.
      await refreshTriviaCategories();
    } catch (error) {
      toast(error.message || 'Could not save trivia settings', 'bad');
      await loadTriviaSettings();
    }
  }

  function queueTriviaSave() {
    // Dragging a slider fires continuously; one save at the end is enough.
    clearTimeout(triviaSaveTimer);
    triviaSaveTimer = setTimeout(saveTriviaSettings, 400);
  }

  async function refreshTriviaCategories() {
    try {
      const result = await apiGet('/api/trivia/categories');
      renderTriviaCategories(result.categories);
    } catch {
      // Leave the last-rendered list in place.
    }
  }

  let triviaWatchTimer = null;

  /** Poll the pool while a replenishment pass runs, then stop on its own. */
  function watchTriviaRefill({ tries = 40 } = {}) {
    clearTimeout(triviaWatchTimer);
    if (tries <= 0) {
      return;
    }
    triviaWatchTimer = setTimeout(async () => {
      try {
        const status = await apiGet('/api/trivia/pool/status');
        renderTriviaStatus(status);
        await refreshTriviaCategories();
        if (status.refilling) {
          watchTriviaRefill({ tries: tries - 1 });
        } else if (status.lastError) {
          toast(status.lastError, 'warn');
        }
      } catch {
        // Stop quietly — the card refreshes whenever the tab is opened.
      }
    }, 5000);
  }

  async function loadTriviaSettings() {
    const card = $('trivia-settings-card');
    if (!card) {
      return;
    }
    try {
      const status = await apiGet('/api/trivia/pool/status');
      renderTriviaSettings(status.settings, status.providers);
      renderTriviaStatus(status);
      await refreshTriviaCategories();
      if (status.refilling) {
        watchTriviaRefill();
      }
    } catch {
      // Trivia not wired up on this bridge — hide the card rather than showing
      // a permanently broken one.
      card.hidden = true;
      const label = card.previousElementSibling;
      if (label?.classList.contains('section-label')) {
        label.hidden = true;
      }
    }
  }

  const triviaCard = $('trivia-settings-card');
  if (triviaCard) {
    triviaCard.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.matches('input[type="checkbox"]')) {
        target.closest('.trivia-check')?.classList.toggle('is-off', !target.checked);
        queueTriviaSave();
      } else if (target.matches('input[type="range"]')) {
        queueTriviaSave();
      }
    });
    triviaCard.addEventListener('input', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const isCount = target.id === 'trivia-count-slider';
        const label = $(isCount ? 'trivia-count-value' : `${target.id}-value`);
        if (label) {
          label.textContent = `${target.value}${isCount ? '' : 's'}`;
        }
      }
    });
    $('btn-trivia-refill')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await apiPost('/api/trivia/pool/refill', {});
        renderTriviaStatus(result.status);
        // The sources allow one call every six seconds, so a pass over every
        // category runs for minutes. Watch it from here rather than holding the
        // request open for the whole thing.
        toast('Restocking — this takes a few minutes', 'ok');
        watchTriviaRefill();
      } catch (error) {
        toast(error.message || 'Could not fetch questions', 'bad');
      } finally {
        button.disabled = false;
      }
    });
    loadTriviaSettings();
  }

  // Banner when opened over plain HTTP (camera QR will not work on iOS).
  if (!isSecureForCamera()) {
    const pushPanel = $('tab-push');
    if (pushPanel) {
      const banner = document.createElement('div');
      banner.className = 'insecure-banner';
      banner.innerHTML = 'This page is not HTTPS — live camera QR needs a secure connection. Open <strong>https://&lt;NAS_IP&gt;:47810/</strong>, tap Advanced → Proceed, then Scan QR Code.';
      pushPanel.insertBefore(banner, pushPanel.firstChild);
    }
  }

  // ------------------------------------------- Control PIN unlock

  function clearPinSheetError() {
    const err = $('pin-sheet-error');
    const input = $('pin-sheet-input');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    input?.classList.remove('is-invalid');
  }

  function showPinSheetError(message) {
    const err = $('pin-sheet-error');
    const input = $('pin-sheet-input');
    if (err) {
      err.hidden = false;
      err.textContent = message || 'Incorrect PIN — try again';
    }
    input?.classList.add('is-invalid');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  async function startPinChallenge() {
    if (!isSingleDisplaySelected()) {
      toast('Select a single display first', 'bad');
      return false;
    }
    // Open the sheet and focus the input BEFORE any await — mobile browsers
    // only pop the keyboard when focus happens inside the user's tap gesture.
    clearPinSheetError();
    $('pin-sheet-hint').textContent = 'Requesting PIN…';
    $('pin-sheet-input').value = '';
    $('pin-sheet').hidden = false;
    syncKeyboardInset();
    const pinInput = $('pin-sheet-input');
    pinInput?.focus({ preventScroll: false });
    // Keep the field in the visible area above the keyboard.
    setTimeout(() => {
      pinInput?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 50);
    try {
      await apiPost('/api/displays/auth/start', withTarget());
    } catch (error) {
      $('pin-sheet').hidden = true;
      throw error;
    }
    $('pin-sheet-hint').textContent = `A ${CONTROL_PIN_DIGITS}-digit PIN is on the display now — enter it below.`;
    return true;
  }

  function syncKeyboardInset() {
    const vv = window.visualViewport;
    if (!vv) {
      document.documentElement.style.setProperty('--keyboard-inset', '0px');
      return;
    }
    // How much of the layout viewport is covered by the OS keyboard.
    const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncKeyboardInset);
    window.visualViewport.addEventListener('scroll', syncKeyboardInset);
  }
  window.addEventListener('focusin', (e) => {
    if (e.target && e.target.id === 'pin-sheet-input') {
      syncKeyboardInset();
      setTimeout(() => {
        e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 100);
    }
  });
  window.addEventListener('focusout', () => {
    setTimeout(syncKeyboardInset, 100);
  });

  async function ensureControlUnlocked() {
    if (!isSingleDisplaySelected()) {
      toast('Select a single display first', 'bad');
      return false;
    }
    if (isDisplayUnlocked()) {
      return true;
    }
    try {
      await startPinChallenge();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return false;
  }

  async function verifyPinFromSheet() {
    const pin = String($('pin-sheet-input')?.value || '').trim();
    if (!pin) {
      showPinSheetError('Enter the PIN shown on the display');
      return;
    }
    clearPinSheetError();
    try {
      const result = await apiPost('/api/displays/auth/verify', withTarget({ pin }));
      setControlToken(selectedTargetId(), result.token);
      $('pin-sheet').hidden = true;
      clearPinSheetError();
      updateControlLockUi();
      updateControlTabVisibility();
      toast('Display unlocked for remote control', 'good');
    } catch (error) {
      const incorrect = error.code === 'control_auth_incorrect_pin'
        || /incorrect pin/i.test(error.message || '');
      if (incorrect) {
        showPinSheetError(error.message || 'Incorrect PIN — try again');
        toast(error.message || 'Incorrect PIN', 'bad');
        return;
      }
      showPinSheetError(error.message || 'Could not verify PIN');
      toast(error.message, 'bad');
    }
  }

  $('btn-display-unlock')?.addEventListener('click', async () => {
    if (isDisplayUnlocked()) {
      // Tap while unlocked = lock now (deauthenticate this display).
      setControlToken(selectedTargetId(), '');
      updateControlLockUi();
      toast('Display locked — PIN required to control it again', 'good');
      return;
    }
    try {
      await startPinChallenge();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });
  $('btn-control-unlock')?.addEventListener('click', async () => {
    try {
      await startPinChallenge();
    } catch (error) {
      toast(error.message, 'bad');
    }
  });
  $('btn-remote-unlock')?.addEventListener('click', () => {
    ensureControlUnlocked();
  });
  $('pin-sheet-cancel')?.addEventListener('click', () => {
    $('pin-sheet').hidden = true;
    clearPinSheetError();
  });
  $('pin-sheet-verify')?.addEventListener('click', () => {
    verifyPinFromSheet();
  });
  $('pin-sheet-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      verifyPinFromSheet();
    }
  });
  $('pin-sheet-input')?.addEventListener('input', (e) => {
    const el = e.target;
    el.value = String(el.value || '').replace(/\D/g, '').slice(0, CONTROL_PIN_DIGITS);
    clearPinSheetError();
  });

  // -------------------------------------------------- Remote confirm logic

  const CONFIRM_WINDOW_MS = 5000;

  document.querySelectorAll('.confirm-btn').forEach((button) => {
    let revertTimer = null;

    button.addEventListener('click', async () => {
      if (!(await ensureControlUnlocked())) {
        return;
      }
      if (!button.classList.contains('confirming')) {
        button.classList.add('confirming');
        button.textContent = 'Tap to confirm';
        revertTimer = setTimeout(() => {
          button.classList.remove('confirming');
          button.textContent = button.dataset.label;
        }, CONFIRM_WINDOW_MS);
        return;
      }

      clearTimeout(revertTimer);
      button.classList.remove('confirming');
      button.textContent = button.dataset.label;
      button.disabled = true;
      try {
        await apiPost(`/api/system/${button.dataset.action}`, withTarget());
        toast(
          button.dataset.action === 'reboot'
            ? 'Restart sent — the display PC is rebooting'
            : 'Power off sent to the display PC',
          'good',
        );
      } catch (error) {
        if (error.code === 'control_auth_required') {
          setControlToken(selectedTargetId(), '');
          updateControlLockUi();
          await ensureControlUnlocked();
        }
        toast(error.message, 'bad');
      } finally {
        setTimeout(() => { button.disabled = false; }, 2000);
      }
    });
  });

  // ------------------------------------------------------------- Auth flows

  $('btn-alexa-auth').addEventListener('click', async () => {
    const button = $('btn-alexa-auth');
    button.disabled = true;
    try {
      const result = await apiPost('/api/auth/alexa/start');
      $('alexa-proxy-link').href = result.proxyUrl;
      $('alexa-auth-followup').hidden = false;
      toast(result.alreadyRunning ? 'Login proxy already running' : 'Login proxy started', 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-tesla-auth').addEventListener('click', async () => {
    const button = $('btn-tesla-auth');
    button.disabled = true;
    try {
      const result = await apiPost('/api/auth/tesla/start');
      $('tesla-auth-link').href = result.authorizeUrl;
      $('tesla-auth-followup').hidden = false;
      if (result.warning) {
        $('tesla-auth-hint').textContent = result.warning;
        toast(result.warning, 'bad');
      } else {
        $('tesla-auth-hint').textContent =
          "Sign in with your Tesla account. You'll be sent back here automatically when it completes.";
      }
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-steam-auth')?.addEventListener('click', async () => {
    const button = $('btn-steam-auth');
    if (!button) {
      return;
    }
    button.disabled = true;
    try {
      const result = await apiPost('/api/auth/steam/start');
      const link = $('steam-auth-link');
      const followup = $('steam-auth-followup');
      if (link && result.authorizeUrl) {
        link.href = result.authorizeUrl;
      }
      if (followup) {
        followup.hidden = false;
      }
      // Open Steam immediately — the followup link remains as a fallback.
      if (result.authorizeUrl) {
        window.open(result.authorizeUrl, '_blank', 'noopener,noreferrer');
      }
      toast('Complete Steam login in the new tab', 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-steam-test-push')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/steam-now-playing', withTarget());
      const label = result.mode === 'last-played' ? 'Last played' : 'Now playing';
      toast(`${label}: ${result.name || 'Steam'} (dismisses automatically)`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-psn-auth')?.addEventListener('click', async () => {
    const button = $('btn-psn-auth');
    const input = $('psn-npsso-input');
    if (!button || !input) {
      return;
    }
    const npsso = String(input.value || '').trim();
    if (!npsso) {
      toast('Paste your NPSSO cookie first', 'bad');
      return;
    }
    button.disabled = true;
    try {
      await apiPost('/api/auth/psn/link', { npsso });
      input.value = '';
      toast('PlayStation linked', 'good');
      pollStatus();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-psn-clear')?.addEventListener('click', async () => {
    const button = $('btn-psn-clear');
    if (!button) {
      return;
    }
    button.disabled = true;
    try {
      await apiPost('/api/auth/psn/clear', {});
      toast('PSN session cleared', 'good');
      pollStatus();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-psn-test-push')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/psn-now-playing', withTarget());
      const label = result.mode === 'last-played' ? 'Last played' : 'Now playing';
      toast(`${label}: ${result.name || 'PSN'} (dismisses automatically)`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-steam-library-tour')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/steam-library-tour', withTarget({
        secondsPerGame: libraryTourPrefs.steam.secondsPerGame,
        sort: libraryTourPrefs.steam.sort,
      }));
      toast(`Steam library tour started (${result.count || 0} games)`, 'good');
      refreshLibraryTourCounts();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-psn-library-tour')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/psn-library-tour', withTarget({
        secondsPerGame: libraryTourPrefs.psn.secondsPerGame,
        sort: libraryTourPrefs.psn.sort,
      }));
      toast(`PSN library tour started (${result.count || 0} games)`, 'good');
      refreshLibraryTourCounts();
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  // -------------------------------------------------- Touchpad + keyboard

  const stickyMods = new Set();
  let pendingDx = 0;
  let pendingDy = 0;
  let pendingWheel = 0;
  let pointerFlush = null;

  function flushPointer() {
    pointerFlush = null;
    if (!isSingleDisplaySelected() || !isDisplayUnlocked()) {
      pendingDx = 0;
      pendingDy = 0;
      pendingWheel = 0;
      return;
    }
    const dx = pendingDx;
    const dy = pendingDy;
    const wheel = pendingWheel;
    pendingDx = 0;
    pendingDy = 0;
    pendingWheel = 0;
    if (!dx && !dy && !wheel) {
      return;
    }
    const body = { dx, dy };
    if (wheel) {
      body.wheel = wheel;
    }
    apiPost('/api/input/pointer', withTarget(body)).catch((error) => {
      if (error.code === 'control_auth_required') {
        setControlToken(selectedTargetId(), '');
        updateControlLockUi();
      }
    });
  }

  function queuePointer(dx, dy) {
    pendingDx += dx;
    pendingDy += dy;
    if (!pointerFlush) {
      pointerFlush = requestAnimationFrame(flushPointer);
    }
  }

  function queueWheel(steps) {
    pendingWheel += steps;
    if (!pointerFlush) {
      pointerFlush = requestAnimationFrame(flushPointer);
    }
  }

  async function sendPointerButtons(buttons) {
    if (!(await ensureControlUnlocked())) {
      return;
    }
    try {
      await apiPost('/api/input/pointer', withTarget({ dx: 0, dy: 0, buttons }));
    } catch (error) {
      if (error.code === 'control_auth_required') {
        setControlToken(selectedTargetId(), '');
        updateControlLockUi();
      }
      toast(error.message, 'bad');
    }
  }

  async function sendKey(key, extraMods = []) {
    if (!(await ensureControlUnlocked())) {
      return false;
    }
    // stickyMods is only Ctrl/Alt/Win — never Shift/Caps (those are handled by the keyboard).
    const modifiers = [...new Set([
      ...[...stickyMods].filter((m) => m !== 'shift'),
      ...extraMods,
    ])];
    try {
      await apiPost('/api/input/key', withTarget({ key, modifiers, action: 'press' }));
      return true;
    } catch (error) {
      if (error.code === 'control_auth_required') {
        setControlToken(selectedTargetId(), '');
        updateControlLockUi();
      }
      toast(error.message, 'bad');
      return false;
    }
  }

  (function initTouchpad() {
    const pad = $('touchpad');
    if (!pad) {
      return;
    }

    const SENSITIVITY = 2.1;
    const SCROLL_PX_PER_STEP = 24; // finger pixels per wheel notch
    const TAP_MAX_MS = 350;
    const MOVE_TOLERANCE_PX = 12; // total travel allowed before a tap is off

    // pointerId → last position. Standard touchpad gestures:
    //   1 finger drag → move cursor · tap → left click · hold → right click
    //   2 finger drag → scroll     · tap → right click
    const touches = new Map();
    let movedPx = 0;
    let downAt = 0;
    let longTimer = null;
    let longPressFired = false;
    let scrollPx = 0;
    let maxTouches = 0;

    function clearLongTimer() {
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
    }

    pad.addEventListener('pointerdown', (e) => {
      if (!isDisplayUnlocked()) {
        ensureControlUnlocked();
        return;
      }
      if (touches.size === 0) {
        movedPx = 0;
        downAt = Date.now();
        longPressFired = false;
        scrollPx = 0;
        maxTouches = 0;
        longTimer = setTimeout(() => {
          longTimer = null;
          if (touches.size === 1 && movedPx <= MOVE_TOLERANCE_PX) {
            longPressFired = true;
            sendPointerButtons({ right: 'click' });
          }
        }, 550);
      } else {
        // Second finger down → scroll/tap gesture, never a long-press.
        clearLongTimer();
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      maxTouches = Math.max(maxTouches, touches.size);
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {
        // older WebKit
      }
      pad.classList.add('active');
      e.preventDefault();
    });

    pad.addEventListener('pointermove', (e) => {
      const touch = touches.get(e.pointerId);
      if (!touch) {
        return;
      }
      const rawDx = e.clientX - touch.x;
      const rawDy = e.clientY - touch.y;
      touch.x = e.clientX;
      touch.y = e.clientY;
      movedPx += Math.abs(rawDx) + Math.abs(rawDy);
      if (movedPx > MOVE_TOLERANCE_PX) {
        clearLongTimer();
      }

      if (touches.size >= 2) {
        // Two-finger vertical slide → wheel. Each finger reports its own
        // moves, so divide by the finger count to average the gesture.
        // Slide up = scroll up (positive Windows wheel).
        scrollPx += -rawDy / touches.size;
        const steps = Math.trunc(scrollPx / SCROLL_PX_PER_STEP);
        if (steps) {
          scrollPx -= steps * SCROLL_PX_PER_STEP;
          queueWheel(steps);
        }
      } else if (Math.abs(rawDx) > 0.35 || Math.abs(rawDy) > 0.35) {
        // Move the cursor right away; MOVE_TOLERANCE_PX only decides whether
        // the release still counts as a tap.
        queuePointer(rawDx * SENSITIVITY, rawDy * SENSITIVITY);
      }
      e.preventDefault();
    });

    function endPointer(e) {
      if (!touches.has(e.pointerId)) {
        return;
      }
      touches.delete(e.pointerId);
      e.preventDefault();
      if (touches.size > 0) {
        return; // wait for the last finger before deciding tap vs. gesture
      }
      pad.classList.remove('active');
      clearLongTimer();
      const isTap = !longPressFired
        && movedPx <= MOVE_TOLERANCE_PX
        && Date.now() - downAt < TAP_MAX_MS;
      if (isTap) {
        // Standard touchpad: one-finger tap = left, two-finger tap = right.
        sendPointerButtons(maxTouches >= 2 ? { right: 'click' } : { left: 'click' });
      }
      longPressFired = false;
      flushPointer();
    }

    pad.addEventListener('pointerup', endPointer);
    pad.addEventListener('pointercancel', endPointer);
    // Stop iOS Safari from scrolling the page while dragging the pad.
    pad.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  })();

  $('btn-mouse-left')?.addEventListener('click', () => sendPointerButtons({ left: 'click' }));
  $('btn-mouse-right')?.addEventListener('click', () => sendPointerButtons({ right: 'click' }));

  $('btn-text-input-send')?.addEventListener('click', async () => {
    const field = $('text-input-value');
    const value = field.value;
    if (!value) {
      toast('Type something to send first', 'bad');
      field.focus();
      return;
    }
    if (!(await ensureControlUnlocked())) {
      return;
    }
    const button = $('btn-text-input-send');
    button.disabled = true;
    try {
      await apiPost('/api/input/text', withTarget({
        value,
        pressEnter: Boolean($('text-input-enter')?.checked),
      }));
      toast('Text sent to display', 'good');
      field.value = '';
      field.focus();
    } catch (error) {
      if (error.code === 'control_auth_required') {
        setControlToken(selectedTargetId(), '');
        updateControlLockUi();
      }
      toast(error.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  (function buildKeyboard() {
    const root = $('keyboard');
    if (!root) {
      return;
    }

    // Shift = one-shot (next key only). Caps = latch for letters until pressed again.
    // Never put "shift" into stickyMods — that made Shift behave like Caps.
    let shiftArmed = false;
    let capsLock = false;

    const char = (base, shiftLabel = null) => ({
      key: base,
      label: base,
      shiftLabel: shiftLabel == null ? base : shiftLabel,
      kind: 'char',
    });

    const rows = [
      {
        cols: 7,
        keys: [
          { key: 'Escape', label: 'Esc', kind: 'action', cls: 'key-action' },
          { key: 'F1', label: 'F1', kind: 'action' }, { key: 'F2', label: 'F2', kind: 'action' },
          { key: 'F3', label: 'F3', kind: 'action' }, { key: 'F4', label: 'F4', kind: 'action' },
          { key: 'F5', label: 'F5', kind: 'action' }, { key: 'F6', label: 'F6', kind: 'action' },
        ],
      },
      {
        cols: 6,
        keys: [
          { key: 'F7', label: 'F7', kind: 'action' }, { key: 'F8', label: 'F8', kind: 'action' },
          { key: 'F9', label: 'F9', kind: 'action' }, { key: 'F10', label: 'F10', kind: 'action' },
          { key: 'F11', label: 'F11', kind: 'action' }, { key: 'F12', label: 'F12', kind: 'action' },
        ],
      },
      {
        cols: 15,
        keys: [
          char('`', '~'),
          char('1', '!'), char('2', '@'), char('3', '#'), char('4', '$'), char('5', '%'),
          char('6', '^'), char('7', '&'), char('8', '*'), char('9', '('), char('0', ')'),
          char('-', '_'), char('=', '+'),
          { key: 'Backspace', label: '⌫', kind: 'action', span: 2, cls: 'key-backspace' },
        ],
      },
      {
        cols: 15,
        keys: [
          { key: 'Tab', label: 'Tab', kind: 'action', span: 2, cls: 'key-action' },
          char('q', 'Q'), char('w', 'W'), char('e', 'E'), char('r', 'R'), char('t', 'T'),
          char('y', 'Y'), char('u', 'U'), char('i', 'I'), char('o', 'O'), char('p', 'P'),
          char('[', '{'), char(']', '}'), char('\\', '|'),
        ],
      },
      {
        cols: 15,
        keys: [
          { kind: 'caps', label: 'Caps', span: 2, cls: 'key-caps' },
          char('a', 'A'), char('s', 'S'), char('d', 'D'), char('f', 'F'), char('g', 'G'),
          char('h', 'H'), char('j', 'J'), char('k', 'K'), char('l', 'L'),
          char(';', ':'), char("'", '"'),
          { key: 'Enter', label: 'Enter', kind: 'action', span: 2, cls: 'key-enter' },
        ],
      },
      {
        cols: 15,
        keys: [
          { kind: 'shift', label: 'Shift', span: 3, cls: 'key-shift' },
          char('z', 'Z'), char('x', 'X'), char('c', 'C'), char('v', 'V'), char('b', 'B'),
          char('n', 'N'), char('m', 'M'),
          char(',', '<'), char('.', '>'), char('/', '?'),
          { kind: 'shift', label: 'Shift', span: 2, cls: 'key-shift' },
        ],
      },
      {
        cols: 15,
        keys: [
          { kind: 'mod', mod: 'ctrl', label: 'Ctrl', cls: 'key-mod' },
          { kind: 'mod', mod: 'alt', label: 'Alt', cls: 'key-mod' },
          { kind: 'mod', mod: 'meta', label: 'Win', cls: 'key-mod' },
          { key: 'Space', label: 'Space', kind: 'action', span: 7, cls: 'key-space' },
          { key: 'Delete', label: 'Del', kind: 'action', cls: 'key-action' },
          { key: 'ArrowLeft', label: '←', kind: 'action' },
          { key: 'ArrowUp', label: '↑', kind: 'action' },
          { key: 'ArrowDown', label: '↓', kind: 'action' },
          { key: 'ArrowRight', label: '→', kind: 'action' },
        ],
      },
      {
        cols: 4,
        keys: [
          { chord: ['alt', 'F4'], label: 'Alt+F4', kind: 'chord', cls: 'key-action' },
          { chord: ['ctrl', 'w'], label: 'Ctrl+W', kind: 'chord', cls: 'key-action' },
          { chord: ['ctrl', 'c'], label: 'Ctrl+C', kind: 'chord', cls: 'key-action' },
          { chord: ['ctrl', 'v'], label: 'Ctrl+V', kind: 'chord', cls: 'key-action' },
        ],
      },
    ];

    const keyButtons = [];

    function isLetterKey(def) {
      return def.kind === 'char' && /^[a-z]$/i.test(def.key);
    }

    /** Number-row / punctuation symbols — Shift only (not Caps). */
    function showSymbols() {
      return shiftArmed;
    }

    /** Letter uppercase — Shift (one-shot) or Caps (latched). */
    function showUpperLetters() {
      return shiftArmed || capsLock;
    }

    function consumeShift() {
      if (!shiftArmed) {
        return;
      }
      shiftArmed = false;
      refreshKeyboard();
    }

    function paintKey(btn, def) {
      if (def.kind === 'shift') {
        btn.classList.toggle('active', shiftArmed);
        btn.textContent = def.label;
        return;
      }
      if (def.kind === 'caps') {
        btn.classList.toggle('active', capsLock);
        btn.textContent = def.label;
        return;
      }
      if (def.kind === 'mod') {
        btn.classList.toggle('active', stickyMods.has(def.mod));
        btn.textContent = def.label;
        return;
      }
      if (def.kind === 'char') {
        const useShiftGlyph = isLetterKey(def) ? showUpperLetters() : showSymbols();
        const main = useShiftGlyph ? def.shiftLabel : def.label;
        const sub = useShiftGlyph ? def.label : def.shiftLabel;
        if (sub && sub !== main) {
          btn.innerHTML = `<span class="key-sub">${sub}</span><span class="key-main">${main}</span>`;
        } else {
          btn.textContent = main;
        }
        btn.classList.toggle('shifted', useShiftGlyph);
        return;
      }
      btn.textContent = def.label;
    }

    function refreshKeyboard() {
      for (const { btn, def } of keyButtons) {
        paintKey(btn, def);
      }
    }

    function toggleStickyMod(mod) {
      if (stickyMods.has(mod)) {
        stickyMods.delete(mod);
      } else {
        stickyMods.add(mod);
      }
      refreshKeyboard();
    }

    function modifiersForKey(def) {
      const mods = [];
      if (shiftArmed) {
        mods.push('shift');
      } else if (capsLock && isLetterKey(def)) {
        mods.push('shift');
      }
      return mods;
    }

    /** Touch/click press flash — CSS :active alone is unreliable on phones. */
    function flashPressed(btn) {
      btn.classList.add('pressed');
      window.clearTimeout(btn._pressFlashTimer);
      btn._pressFlashTimer = window.setTimeout(() => {
        btn.classList.remove('pressed');
        btn._pressFlashTimer = null;
      }, 160);
    }

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = `key-row cols-${row.cols}`;
      for (const def of row.keys) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'key';
        if (def.cls) {
          btn.classList.add(...String(def.cls).split(/\s+/));
        }
        const span = Number(def.span) || 1;
        if (span >= 2 && span <= 7) {
          btn.classList.add(`span-${span}`);
        }
        paintKey(btn, def);
        keyButtons.push({ btn, def });

        btn.addEventListener('pointerdown', (e) => {
          if (e.button != null && e.button !== 0) {
            return;
          }
          flashPressed(btn);
        });

        btn.addEventListener('click', () => {
          flashPressed(btn);
          if (def.kind === 'shift') {
            // One-shot arm (tap again to cancel). Does not touch capsLock.
            shiftArmed = !shiftArmed;
            refreshKeyboard();
            return;
          }
          if (def.kind === 'caps') {
            capsLock = !capsLock;
            // Caps does not keep Shift armed.
            shiftArmed = false;
            refreshKeyboard();
            return;
          }
          if (def.kind === 'mod') {
            // Only ctrl / alt / meta — ignore accidental "shift" sticky.
            if (def.mod === 'shift') {
              return;
            }
            toggleStickyMod(def.mod);
            return;
          }
          if (def.kind === 'chord') {
            const [mod, key] = def.chord;
            sendKey(key, [mod]);
            consumeShift();
            return;
          }
          // Snapshot before send so async lag cannot re-apply a stale one-shot.
          const oneShot = modifiersForKey(def);
          sendKey(def.key, oneShot);
          consumeShift();
        });
        rowEl.appendChild(btn);
      }
      root.appendChild(rowEl);
    }

    refreshKeyboard();
  })();

  // -------------------------------------------------------------- Admin session

  $('btn-admin-logout')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/admin/logout', {});
    } catch {
      // still leave the UI even if the network call failed
    }
    location.href = '/admin/login.html';
  });

  // -------------------------------------------------------------- Start up

  // Steam OpenID returns to /admin/?steam=ok|error — open Settings so the
  // Auth card is visible. Must run at end of init (never mid-script) so a
  // failure here cannot skip status polling / button handlers.
  function applySteamReturnTab() {
    try {
      const params = new URLSearchParams(location.search);
      const steam = params.get('steam');
      if (!steam) {
        return;
      }
      activateTab('settings');
      if (steam === 'ok') {
        toast('Steam account linked', 'good');
      } else if (steam === 'error') {
        toast('Steam link failed — try again from Auth', 'bad');
      }
      params.delete('steam');
      const qs = params.toString();
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash || ''}`);
    } catch (error) {
      console.warn('Steam return tab handling failed', error);
    }
  }

  loadPushGrid();
  refreshDisplays({ quiet: true });
  startDisplayEvents();
  startPolling();
  applySteamReturnTab();
  // Fallback poll if EventSource is blocked or drops (SSE is primary).
  setInterval(() => refreshDisplays({ quiet: true }), 60000);
})();
