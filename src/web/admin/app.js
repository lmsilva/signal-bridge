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
    if (tabId === 'credits') {
      initCreditsUi();
      startCreditsEvents();
      loadCredits();
    } else if (tabId === 'settings') {
      initCreditsUi();
      loadCreditsSettings();
    }
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
    wiki: '<path d="M5 4.5h8a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z"/><path d="M9 4.5V3h6v1.5"/><path d="M8 10h6M8 13.5h4"/>',
    sky: '<circle cx="12" cy="12" r="9"/><path d="M8 14h8"/><path d="m12 8 2 2-2 2-2-2 2-2Z" fill="currentColor" stroke="none"/><path d="M6 10h2M16 10h2"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.2 9.6v4.8l4.3-2.4-4.3-2.4Z" fill="currentColor" stroke="none"/>',
    steam: '<circle cx="12" cy="12" r="9"/><circle cx="15" cy="9.5" r="2.4"/><path d="M3.3 15.2 8 17.1"/><circle cx="9" cy="15.6" r="2.1"/>',
    psn: '<path d="M10 4.5 15 6v12.5l-2.6-.9V8.2L10 7.5Z" fill="currentColor" stroke="none"/><path d="M4 15.2c2-1.1 4.4-1.5 4.4-1.5v2s-2.1.4-3 .9c-.4.2-.3.5.2.5"/><path d="M20 14.4c-1.6-.9-4-.7-4-.7v1.9s1.9-.3 2.8 0"/>',
    credits: '<path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4M12 13v4M8 20h8M9 17h6"/>',
    autodarts: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
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
      row.removeAttribute('aria-busy');
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
  let qrPhotoQueue = [];
  let qrNextPhotoId = 1;
  const QR_PHOTO_QUEUE_MAX = 20;

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

  function encodeQrPhotoFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No file'));
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
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not read that photo'));
      };
      img.src = objectUrl;
    });
  }

  function renderQrPhotoQueue() {
    const queueEl = $('qr-photo-queue');
    const grid = $('qr-photo-queue-grid');
    const countEl = $('qr-photo-queue-count');
    const pick = $('btn-qr-pick-photo');
    if (!queueEl || !grid) return;
    const count = qrPhotoQueue.length;
    queueEl.hidden = count === 0;
    if (countEl) {
      countEl.textContent = count === 1 ? '1 photo' : `${count} photos`;
    }
    if (pick) {
      pick.textContent = count > 0 ? 'Add more photos' : 'Choose photos';
    }
    grid.replaceChildren();
    qrPhotoQueue.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = 'qr-photo-queue-item';
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = 'Queued photo';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'qr-photo-queue-remove';
      remove.title = 'Remove photo';
      remove.setAttribute('aria-label', 'Remove photo');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        qrPhotoQueue = qrPhotoQueue.filter((entry) => entry.id !== item.id);
        renderQrPhotoQueue();
      });
      cell.append(img, remove);
      grid.appendChild(cell);
    });
  }

  function resetPhotoPicker() {
    qrPhotoQueue = [];
    $('qr-image-file').value = '';
    renderQrPhotoQueue();
    setQrPhotoProgress(null);
  }

  function setQrPhotoProgress(done, total, phase) {
    const wrap = $('qr-photo-progress');
    const label = $('qr-photo-progress-label');
    const fill = $('qr-photo-progress-fill');
    const bar = $('qr-photo-progress-bar');
    if (!wrap) {
      return;
    }
    if (done == null || !total) {
      wrap.hidden = true;
      if (fill) fill.style.width = '0%';
      if (bar) bar.setAttribute('aria-valuenow', '0');
      return;
    }
    wrap.hidden = false;
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    if (fill) fill.style.width = `${pct}%`;
    if (bar) {
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuemax', '100');
    }
    if (label) {
      if (phase === 'send') {
        label.textContent = 'Sending to display…';
      } else {
        label.textContent = `Uploading ${done} of ${total}`;
      }
    }
  }

  async function addQrPhotoFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) {
      return;
    }
    const room = QR_PHOTO_QUEUE_MAX - qrPhotoQueue.length;
    if (room <= 0) {
      toast(`You can queue up to ${QR_PHOTO_QUEUE_MAX} photos`, 'bad');
      return;
    }
    const slice = files.slice(0, room);
    let added = 0;
    for (const file of slice) {
      try {
        const dataUrl = await encodeQrPhotoFile(file);
        qrPhotoQueue.push({ id: qrNextPhotoId, dataUrl });
        qrNextPhotoId += 1;
        added += 1;
        renderQrPhotoQueue();
      } catch {
        // skip unreadable files
      }
    }
    if (!added) {
      toast('Could not read those photos', 'bad');
      return;
    }
    if (files.length > room) {
      toast(`Added ${added}. Queue is full at ${QR_PHOTO_QUEUE_MAX} photos.`, 'bad');
    }
  }

  $('btn-qr-pick-photo').addEventListener('click', () => {
    $('qr-image-file').value = '';
    $('qr-image-file').click();
  });

  $('qr-image-file').addEventListener('change', () => {
    addQrPhotoFiles($('qr-image-file').files);
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

      // Photo mode: upload each queued JPEG, then push. One photo is a
      // qr.display hero; two or more become a photo.slideshow of just
      // this queue (not the whole camera roll).
      if (!qrPhotoQueue.length) {
        toast('Choose a photo first', 'bad');
        return;
      }
      const total = qrPhotoQueue.length;
      const pick = $('btn-qr-pick-photo');
      const clear = $('btn-qr-photo-clear');
      if (pick) pick.disabled = true;
      if (clear) clear.disabled = true;
      setQrPhotoProgress(0, total);
      const photos = [];
      for (let i = 0; i < total; i += 1) {
        setQrPhotoProgress(i, total);
        const upload = await apiPost('/api/qr/image-upload', {
          imageDataUrl: qrPhotoQueue[i].dataUrl,
        });
        photos.push({
          url: new URL(upload.path, document.baseURI).href,
          uploadedAt: upload.createdAt || null,
        });
        setQrPhotoProgress(i + 1, total);
      }
      setQrPhotoProgress(total, total, 'send');
      await apiPost('/api/qr/push', withTarget({
        mode: 'photo',
        photos,
        label: 'Scan to save this photo',
      }));
      toast(photos.length > 1
        ? `Slideshow sent (${photos.length} photos)`
        : 'Photo sent to display', 'good');
      resetPhotoPicker();
    } catch (error) {
      setQrPhotoProgress(null);
      toast(error.message || 'Could not generate the QR code', 'bad');
    } finally {
      button.disabled = false;
      const pick = $('btn-qr-pick-photo');
      const clear = $('btn-qr-photo-clear');
      if (pick) pick.disabled = false;
      if (clear) clear.disabled = false;
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
      .map((p) => `${p.token || ''}\0${p.path || ''}\0${p.thumbPath || ''}\0${p.createdAt || ''}`)
      .join('\n');
  }

  /** Root-absolute `/qr-images/…` URL (ignores <base href="/admin/">). */
  function photoImageUrl(photo, { bust = false, thumb = false } = {}) {
    let raw = '';
    if (thumb) {
      // Only use a dedicated thumb URL when the API provided one. Never invent
      // `/thumbs/…` paths — that 404s when sharp isn't installed in Docker.
      raw = photo?.thumbPath || photo?.path || '';
    } else {
      raw = photo?.path || '';
    }
    const path = appUrl(raw);
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

  function bindThumbImage(img, photo, { index = 0 } = {}) {
    // Prefer the compact thumb when the API advertises one; if that 404s
    // (encode still running, or sharp missing in the image), fall back to the
    // full original so the camera roll never stays blank.
    const eagerCount = 12;
    const hasThumb = Boolean(photo?.thumbPath) && photo.thumbPath !== photo.path;
    img.loading = index < eagerCount ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.alt = 'Shared photo';
    if (index >= eagerCount) {
      img.setAttribute('fetchpriority', 'low');
    }
    img.src = photoImageUrl(photo, { thumb: hasThumb });
    img.addEventListener('error', () => {
      const stage = img.dataset.stage || 'start';
      if (stage === 'full') {
        return;
      }
      if (hasThumb && stage === 'start') {
        img.dataset.stage = 'thumb-bust';
        img.src = photoImageUrl(photo, { thumb: true, bust: true });
        return;
      }
      img.dataset.stage = 'full';
      img.src = photoImageUrl(photo, { thumb: false, bust: true });
    });
  }

  function renderPhotoGrid() {
    const grid = $('photo-grid');
    const empty = $('photo-grid-empty');
    grid.innerHTML = '';
    empty.hidden = slideshowPhotos.length > 0;
    slideshowPhotos.forEach((photo, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'photo-thumb';
      cell.classList.toggle('selecting', slideshowSelecting);
      cell.classList.toggle('selected', slideshowSelected.has(photo.token));
      cell.dataset.token = photo.token;
      const img = document.createElement('img');
      bindThumbImage(img, photo, { index });
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

  function photosTokenSignature(photos) {
    return (photos || []).map((p) => p.token || '').join('\n');
  }

  // Shared by the initial load, the manual refresh button, and every SSE
  // push — one place that reconciles the in-flight selection against
  // whatever photo list just arrived (a photo deleted from another session
  // must fall out of `slideshowSelected` too, or "Delete (n)" could try to
  // delete an already-gone token).
  function applySlideshowPhotos(photos, { force = false } = {}) {
    const next = photos || [];
    const sig = photosSignature(next);
    const tokenSig = photosTokenSignature(next);
    // Opening the tab fires GET and SSE `hello` with the same list. Rebuilding
    // the grid aborts half-finished <img> fetches and leaves broken thumbs
    // until a manual refresh — skip identical updates.
    if (!force && sig === slideshowPhotosSig && $('photo-grid')?.children?.length === next.length) {
      return;
    }
    // Same photo set, only thumb metadata flipped — keep in-flight <img>
    // loads instead of wiping the grid (was the main "still feels slow" feel).
    if (
      !force
      && tokenSig
      && tokenSig === photosTokenSignature(slideshowPhotos)
      && $('photo-grid')?.children?.length === next.length
    ) {
      slideshowPhotosSig = sig;
      slideshowPhotos = next;
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

    const SCHED_SIMULATE_STATUS = [
      {
        title: 'Building a 24-hour forecast…',
        detail: 'Walking every scheduler tick. Nothing is sent to the display.',
      },
      {
        title: 'Rolling 200 simulated days…',
        detail: 'Each run is a different roll of the dice, so we can average the spread.',
      },
      {
        title: 'Scoring which rule would win…',
        detail: 'Quiet hours, gaps, and importance all apply — same as a real day.',
      },
      {
        title: 'Averaging airings per rule…',
        detail: 'Turning the runs into a forecast you can compare to expected counts.',
      },
    ];

    function setSchedSimulationStatus(index) {
      const step = SCHED_SIMULATE_STATUS[index % SCHED_SIMULATE_STATUS.length];
      const title = $('sched-simulation-status');
      const detail = $('sched-simulation-detail');
      if (title) title.textContent = step.title;
      if (detail) detail.textContent = step.detail;
    }

    function showSchedSimulationWorking() {
      const host = $('sched-simulation');
      const working = $('sched-simulation-working');
      const results = $('sched-simulation-results');
      if (!host) return;
      host.hidden = false;
      if (working) working.hidden = false;
      if (results) results.innerHTML = '';
      setSchedSimulationStatus(0);
    }

    function renderSchedSimulation(result) {
      const host = $('sched-simulation');
      const working = $('sched-simulation-working');
      const results = $('sched-simulation-results');
      if (!host) return;
      host.hidden = false;
      if (working) working.hidden = true;
      if (!results) return;
      results.innerHTML = '<p class="hint" style="margin-top:12px">Forecast for the next 24 hours — '
        + `average of ${result.runs} runs. Scheduling is stochastic, so a real day will differ.</p>`
        + (result.perRule || []).map((entry) => (
          `<div class="sched-readout"><i class="sched-dot" style="background:${escapeHtml(entry.color)};`
          + `display:inline-block;margin-right:6px"></i>${escapeHtml(entry.label)}: `
          + `<strong>≈${entry.simulated}</strong> airings (expected ${entry.expected})</div>`
        )).join('');
    }

    $('btn-sched-simulate')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const host = $('sched-simulation');
      const label = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Simulating…';
      showSchedSimulationWorking();
      let statusIndex = 0;
      const statusTimer = setInterval(() => {
        statusIndex += 1;
        setSchedSimulationStatus(statusIndex);
      }, 2200);
      try {
        const result = await apiFetch(`${SCHED_ROUTE}/simulate`, {
          method: 'POST', body: { hours: 24, runs: 200 },
        });
        renderSchedSimulation(result);
      } catch (error) {
        if (host) {
          host.hidden = true;
          const working = $('sched-simulation-working');
          const results = $('sched-simulation-results');
          if (working) working.hidden = true;
          if (results) results.innerHTML = '';
        }
        toast(error.message || 'Could not run the simulation', 'bad');
      } finally {
        clearInterval(statusTimer);
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = label;
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

  // ------------------------------------------- Settings → Wiki Common Knowledge

  const WIKI_PERIOD_HINTS = {
    daily: 'Most-read Wikipedia articles for today',
    weekly: 'Most-read articles this ISO week (from daily caches)',
    monthly: 'Most-read articles this month (from daily caches)',
    yearly: 'Most-read articles this year (from daily caches)',
  };

  function renderWikiCkSettings(status) {
    const settings = status.settings || {};
    const periodBtn = document.querySelector(`#wiki-ck-period-tabs .segmented-btn[data-period="${settings.period || 'daily'}"]`);
    document.querySelectorAll('#wiki-ck-period-tabs .segmented-btn')
      .forEach((btn) => btn.classList.toggle('active', btn === periodBtn));
    const hint = $('wiki-ck-period-hint');
    if (hint) hint.textContent = WIKI_PERIOD_HINTS[settings.period] || WIKI_PERIOD_HINTS.daily;
    const items = $('wiki-ck-items');
    if (items) {
      items.value = settings.items || 5;
      const label = $('wiki-ck-items-value');
      if (label) label.textContent = String(items.value);
    }
    const articleSec = $('wiki-ck-article-seconds');
    if (articleSec) {
      articleSec.value = settings.articleSeconds || 15;
      const label = $('wiki-ck-article-seconds-value');
      if (label) label.textContent = `${articleSec.value}s`;
    }
    const loops = $('wiki-ck-loops');
    if (loops) loops.value = settings.loops || 'once';
    const lang = $('wiki-ck-lang');
    if (lang) lang.value = settings.lang || 'en';
    const email = $('wiki-ck-contact-email');
    if (email) email.value = settings.contactEmail || '';
    const cycle = $('wiki-ck-cycle-length');
    if (cycle) cycle.textContent = formatCycleLength(status.cycleSeconds);
    [
      ['wiki-ck-show-qr', 'showQr'],
      ['wiki-ck-show-sparkline', 'showSparkline'],
      ['wiki-ck-skip-no-image', 'skipNoImage'],
      ['wiki-ck-filter-distressing', 'filterDistressing'],
    ].forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      el.checked = Boolean(settings[key]);
      el.closest('.trivia-check')?.classList.toggle('is-off', !el.checked);
    });
    const cacheHint = $('wiki-ck-cache-hint');
    if (cacheHint) {
      const cache = status.cache || {};
      const last = cache.lastPollAt
        ? `${Math.max(0, Math.round((Date.now() - Number(cache.lastPollAt)) / 60000))}m ago`
        : 'never';
      cacheHint.textContent = `Cache: ${cache.dayLists || 0} day lists · ${cache.articles || 0} articles · last poll ${last}`
        + (cache.lastPollError ? ` · ${cache.lastPollError}` : '');
    }
    const pill = $('wiki-ck-status-pill');
    const detail = $('wiki-ck-status-detail');
    if (pill) {
      pill.textContent = status.hasContent ? 'Ready' : (status.hasContactEmail ? 'Collecting' : 'Needs email');
      pill.className = `status-pill ${status.hasContent ? 'ok' : ''}`;
    }
    if (detail) {
      detail.textContent = status.hasContent
        ? `${status.available || 0} articles ready for ${settings.period || 'daily'}`
        : (status.hasContactEmail
          ? 'Cache is still filling — refresh after a poll.'
          : 'Add a contact email so Wikimedia requests can include a valid User-Agent.');
    }
  }

  function readWikiCkForm() {
    const periodBtn = document.querySelector('#wiki-ck-period-tabs .segmented-btn.active');
    return {
      period: periodBtn?.dataset.period || 'daily',
      items: Number($('wiki-ck-items')?.value || 5),
      articleSeconds: Number($('wiki-ck-article-seconds')?.value || 15),
      loops: $('wiki-ck-loops')?.value || 'once',
      lang: $('wiki-ck-lang')?.value || 'en',
      contactEmail: $('wiki-ck-contact-email')?.value || '',
      apiToken: $('wiki-ck-api-token')?.value || undefined,
      showQr: Boolean($('wiki-ck-show-qr')?.checked),
      showSparkline: Boolean($('wiki-ck-show-sparkline')?.checked),
      skipNoImage: Boolean($('wiki-ck-skip-no-image')?.checked),
      filterDistressing: Boolean($('wiki-ck-filter-distressing')?.checked),
    };
  }

  let wikiCkSaveTimer = null;
  async function saveWikiCkSettings() {
    try {
      const body = readWikiCkForm();
      if (!body.apiToken) delete body.apiToken;
      const result = await apiPost('/api/wiki-common-knowledge/settings', body);
      const cycle = $('wiki-ck-cycle-length');
      if (cycle) cycle.textContent = formatCycleLength(result.cycleSeconds);
      await loadWikiCkSettings();
    } catch (error) {
      toast(error.message || 'Could not save Wikipedia Common Knowledge settings', 'bad');
    }
  }

  function queueWikiCkSave() {
    clearTimeout(wikiCkSaveTimer);
    wikiCkSaveTimer = setTimeout(saveWikiCkSettings, 400);
  }

  async function loadWikiCkSettings() {
    const card = $('wiki-ck-settings-card');
    if (!card) return;
    try {
      const status = await apiGet('/api/wiki-common-knowledge/status');
      renderWikiCkSettings(status);
      card.hidden = false;
    } catch {
      card.hidden = true;
      const label = card.previousElementSibling;
      if (label?.classList.contains('section-label')) label.hidden = true;
    }
  }

  const wikiCkCard = $('wiki-ck-settings-card');
  if (wikiCkCard) {
    document.querySelectorAll('#wiki-ck-period-tabs .segmented-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#wiki-ck-period-tabs .segmented-btn')
          .forEach((other) => other.classList.toggle('active', other === btn));
        const hint = $('wiki-ck-period-hint');
        if (hint) hint.textContent = WIKI_PERIOD_HINTS[btn.dataset.period] || '';
        queueWikiCkSave();
      });
    });
    wikiCkCard.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('input[type="checkbox"]')) {
        target.closest('.trivia-check')?.classList.toggle('is-off', !target.checked);
        queueWikiCkSave();
      } else if (target.matches('select') || target.matches('input[type="range"]') || target.matches('input[type="email"]') || target.matches('input[type="text"]') || target.matches('input[type="password"]')) {
        queueWikiCkSave();
      }
    });
    wikiCkCard.addEventListener('input', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const isItems = target.id === 'wiki-ck-items';
        const label = $(isItems ? 'wiki-ck-items-value' : `${target.id}-value`);
        if (label) label.textContent = `${target.value}${isItems ? '' : 's'}`;
      }
    });
    $('btn-wiki-ck-test')?.addEventListener('click', async () => {
      try {
        await saveWikiCkSettings();
        const result = await apiPost('/api/wiki-common-knowledge/test', {});
        toast(result.ok ? `Wikipedia OK (${result.articles || 0} featured)` : (result.error || 'Test failed'), result.ok ? 'ok' : 'bad');
      } catch (error) {
        toast(error.message || 'Test failed', 'bad');
      }
    });
    $('btn-wiki-ck-poll')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await apiPost('/api/wiki-common-knowledge/cache/poll', {});
        toast('Cache refresh started', 'ok');
        setTimeout(loadWikiCkSettings, 4000);
      } catch (error) {
        toast(error.message || 'Could not refresh cache', 'bad');
      } finally {
        button.disabled = false;
      }
    });
    $('btn-wiki-ck-backfill')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await apiPost('/api/wiki-common-knowledge/cache/backfill', { days: 7 });
        toast('Backfill started', 'ok');
        setTimeout(loadWikiCkSettings, 8000);
      } catch (error) {
        toast(error.message || 'Could not backfill', 'bad');
      } finally {
        button.disabled = false;
      }
    });
    loadWikiCkSettings();
  }

  // ------------------------------------------- Settings → Overhead

  function renderOverheadSettings(status) {
    const settings = status.settings || {};
    setTriviaSlider('overhead-radius-nm', 'overhead-radius-nm-value', settings.radiusNm, 'nm');
    setTriviaSlider('overhead-refresh-seconds', 'overhead-refresh-seconds-value', settings.refreshSeconds, 's');
    setTriviaSlider('overhead-page-seconds', 'overhead-page-seconds-value', settings.pageSeconds, 's');
    setTriviaSlider('overhead-max-pages', 'overhead-max-pages-value', settings.maxPages, '');
    const loops = $('overhead-loops');
    if (loops) loops.value = settings.loops || 'once';
    const sort = $('overhead-sort');
    if (sort) sort.value = settings.sort || 'nearest';
    const rows = $('overhead-rows-per-page');
    if (rows) rows.value = String(settings.rowsPerPage || 'auto');
    const provider = $('overhead-provider');
    if (provider) provider.value = settings.provider || 'airplanes-live';
    const localUrl = $('overhead-local-url');
    if (localUrl) localUrl.value = settings.localReceiverUrl || '';
    const floor = $('overhead-altitude-floor');
    if (floor) floor.value = String(settings.altitudeFloorFt ?? 0);
    const mapStyle = $('overhead-map-style');
    if (mapStyle) mapStyle.value = settings.mapStyle || 'scope';
    setChecked('overhead-show-routes', settings.showRoutes !== false);
    setChecked('overhead-include-ground', settings.includeGround === true);
    const cycle = $('overhead-cycle-length');
    if (cycle) cycle.textContent = formatCycleLength(status.estimatedDurationSeconds || status.cycleSeconds);
    const homeLoc = $('overhead-home-location');
    if (homeLoc) {
      if (status.home?.latitude != null) {
        homeLoc.textContent = `Location: ${status.home.name || 'Home'} (${Number(status.home.latitude).toFixed(4)}, ${Number(status.home.longitude).toFixed(4)})`;
      } else {
        homeLoc.textContent = 'Location: not set — configure voiceEvents.defaultLocation (same as weather).';
      }
    }
    const aircraftHint = $('overhead-aircraft-hint');
    if (aircraftHint) {
      const count = status.aircraftInRange ?? 0;
      const last = status.lastFetchAt
        ? `${Math.max(0, Math.round((Date.now() - Date.parse(status.lastFetchAt)) / 1000))}s ago`
        : 'never';
      aircraftHint.textContent = `Aircraft in range: ${count} · last fetch ${last}`;
    }
    const pill = $('overhead-status-pill');
    const detail = $('overhead-status-detail');
    if (pill) {
      pill.textContent = status.hasHome
        ? (status.hasContent ? 'Traffic' : 'Clear skies')
        : 'Needs location';
      pill.className = `status-pill ${status.hasContent ? 'ok' : ''}`;
    }
    if (detail) {
      detail.textContent = !status.hasHome
        ? 'Set voiceEvents.defaultLocation in config — Overhead uses the same coordinates as weather.'
        : (status.hasContent
          ? `${status.aircraftInRange || 0} aircraft within ${settings.radiusNm || 40} nm`
          : 'No aircraft in range right now — manual push still shows clear skies.');
    }
  }

  function readOverheadForm() {
    return {
      radiusNm: Number($('overhead-radius-nm')?.value || 40),
      refreshSeconds: Number($('overhead-refresh-seconds')?.value || 5),
      rowsPerPage: $('overhead-rows-per-page')?.value || 'auto',
      pageSeconds: Number($('overhead-page-seconds')?.value || 8),
      maxPages: Number($('overhead-max-pages')?.value || 6),
      loops: $('overhead-loops')?.value || 'once',
      sort: $('overhead-sort')?.value || 'nearest',
      altitudeFloorFt: Number($('overhead-altitude-floor')?.value || 0),
      includeGround: Boolean($('overhead-include-ground')?.checked),
      showRoutes: Boolean($('overhead-show-routes')?.checked),
      provider: $('overhead-provider')?.value || 'airplanes-live',
      localReceiverUrl: $('overhead-local-url')?.value || '',
      mapStyle: $('overhead-map-style')?.value || 'scope',
    };
  }

  let overheadSaveTimer = null;
  async function saveOverheadSettings() {
    try {
      const result = await apiPost('/api/overhead/settings', readOverheadForm());
      const cycle = $('overhead-cycle-length');
      if (cycle) {
        cycle.textContent = formatCycleLength(result.estimatedDurationSeconds || result.cycleSeconds);
      }
    } catch (error) {
      toast(error.message || 'Could not save Overhead settings', 'bad');
    }
  }
  function queueOverheadSave() {
    clearTimeout(overheadSaveTimer);
    overheadSaveTimer = setTimeout(saveOverheadSettings, 400);
  }

  async function loadOverheadSettings() {
    const card = $('overhead-settings-card');
    if (!card) return;
    try {
      const status = await apiGet('/api/overhead/status');
      renderOverheadSettings(status);
    } catch (error) {
      toast(error.message || 'Could not load Overhead settings', 'bad');
    }
  }

  const overheadCard = $('overhead-settings-card');
  if (overheadCard) {
    overheadCard.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.type === 'checkbox') {
        target.closest('.trivia-check')?.classList.toggle('is-off', !target.checked);
      }
      queueOverheadSave();
    });
    overheadCard.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type === 'range') {
        const suffix = target.id === 'overhead-radius-nm' ? 'nm' : (target.id.includes('seconds') ? 's' : '');
        const label = $(`${target.id}-value`);
        if (label) label.textContent = suffix ? `${target.value}${suffix}` : String(target.value);
      }
      queueOverheadSave();
    });
    $('btn-overhead-provider-test')?.addEventListener('click', async () => {
      try {
        await saveOverheadSettings();
        const result = await apiPost('/api/overhead/provider/test', readOverheadForm());
        const sourceLabel = result.source ? ` via ${result.source}` : '';
        toast(result.ok
          ? `Provider OK — ${result.aircraftCount ?? 0} aircraft${sourceLabel}`
          : (result.error || 'Provider test failed'), result.ok ? 'ok' : 'bad');
      } catch (error) {
        toast(error.message || 'Provider test failed', 'bad');
      }
    });
    $('btn-overhead-refresh-count')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const status = await apiGet('/api/overhead/status');
        renderOverheadSettings(status);
        toast('Count refreshed', 'ok');
      } catch (error) {
        toast(error.message || 'Could not refresh', 'bad');
      } finally {
        button.disabled = false;
      }
    });
    loadOverheadSettings();
  }

  // ---------------------------------------- Settings → Autodarts

  let autodartsSaveTimer = null;
  let autodartsPollTimer = null;
  let autodartsLinkMode = 'device';
  let autodartsBusy = false;

  function setAutodartsSlider(sliderId, labelId, value, suffix) {
    const slider = $(sliderId);
    const label = $(labelId);
    if (!slider) return;
    slider.value = String(value);
    if (label) label.textContent = `${value}${suffix || ''}`;
  }

  function readAutodartsForm() {
    const inactivityBtn = document.querySelector('#autodarts-inactivity-tabs .segmented-btn.active');
    return {
      live: {
        autoPush: Boolean($('autodarts-auto-push')?.checked),
        inactivityMinutes: Number(inactivityBtn?.dataset.minutes || 15),
        finalHoldSeconds: Number($('autodarts-final-hold')?.value || 60),
      },
      dashboard: {
        leaderboardSize: Number($('autodarts-leaderboard-size')?.value || 12),
        displaySeconds: Number($('autodarts-dashboard-seconds')?.value || 120),
      },
      lastMatch: {
        displaySeconds: Number($('autodarts-last-match-seconds')?.value || 90),
      },
    };
  }

  async function saveAutodartsSettings() {
    try {
      const result = await apiPost('/api/autodarts/settings', readAutodartsForm());
      if (result.settings) renderAutodartsSettings(result.settings);
    } catch (error) {
      toast(error.message || 'Could not save Autodarts settings', 'bad');
    }
  }

  function queueAutodartsSave() {
    clearTimeout(autodartsSaveTimer);
    autodartsSaveTimer = setTimeout(saveAutodartsSettings, 400);
  }

  function renderAutodartsSettings(settings) {
    if (!settings) return;
    const live = settings.live || {};
    const dashboard = settings.dashboard || {};
    const lastMatch = settings.lastMatch || {};
    if ($('autodarts-auto-push')) $('autodarts-auto-push').checked = live.autoPush !== false;
    document.querySelectorAll('#autodarts-inactivity-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.minutes) === Number(live.inactivityMinutes || 15));
    });
    setAutodartsSlider('autodarts-final-hold', 'autodarts-final-hold-value', live.finalHoldSeconds || 60, 's');
    setAutodartsSlider('autodarts-leaderboard-size', 'autodarts-leaderboard-size-value', dashboard.leaderboardSize || 12, '');
    setAutodartsSlider('autodarts-dashboard-seconds', 'autodarts-dashboard-seconds-value', dashboard.displaySeconds || 120, 's');
    setAutodartsSlider('autodarts-last-match-seconds', 'autodarts-last-match-seconds-value', lastMatch.displaySeconds || 90, 's');
  }

  function renderAutodartsBoards(boards, selectedId) {
    const select = $('autodarts-board');
    if (!select) return;
    const rows = Array.isArray(boards) ? boards : [];
    if (!rows.length) {
      select.innerHTML = '<option value="">No boards found</option>';
      return;
    }
    const selected = String(selectedId || '');
    const placeholder = selected
      ? ''
      : '<option value="" selected disabled>Select a board…</option>';
    select.innerHTML = placeholder + rows.map((board) => (
      `<option value="${escapeHtml(board.id)}"${board.id === selected ? ' selected' : ''}>`
      + `${escapeHtml(board.name || board.id)}`
      + `${board.online === true ? ' · online' : (board.online === false ? ' · offline' : '')}`
      + `</option>`
    )).join('');
  }

  async function ensureAutodartsBoardSelection(boards, status) {
    const rows = Array.isArray(boards) ? boards : [];
    if (!rows.length || status?.boardId) return status;
    // One board: persist it. Multiple: leave the placeholder so the UI does not
    // look selected when nothing is saved (Test was saying "no board selected").
    if (rows.length !== 1) return status;
    const only = rows[0];
    try {
      const saved = await apiPost('/api/autodarts/board', {
        boardId: only.id,
        boardName: only.name || only.id,
      });
      if (saved?.ok) {
        return { ...status, boardId: only.id, boardName: only.name || only.id, ...saved };
      }
    } catch {
      // leave placeholder
    }
    return status;
  }

  function renderAutodartsOauth(oauth) {
    if (!oauth) return;
    const idInput = $('autodarts-client-id');
    const secretInput = $('autodarts-client-secret');
    const hint = $('autodarts-oauth-hint');
    if (idInput && !idInput.dataset.dirty) {
      const rawId = oauth.clientId || oauth.defaultClientId || 'darts-caller';
      idInput.value = rawId === 'developer-darts-caller' ? 'darts-caller' : rawId;
      idInput.readOnly = Boolean(oauth.envBlocksOverwrite);
    }
    if (secretInput) {
      secretInput.readOnly = Boolean(oauth.envBlocksOverwrite);
      if (!secretInput.dataset.dirty) {
        secretInput.value = '';
        secretInput.placeholder = oauth.hasClientSecret ? '•••••••• (saved)' : 'Optional';
      }
    }
    if (hint) {
      const id = oauth.clientId || 'darts-caller';
      if (oauth.envBlocksOverwrite) {
        hint.textContent = 'Client id/secret come from .env and cannot be changed here.';
      } else if (oauth.hasClientSecret) {
        hint.textContent = `Override active (${id}, secret saved via ${oauth.source}). Leave secret blank to keep it.`;
      } else if (id === 'darts-caller') {
        hint.textContent = 'Using built-in darts-caller — no override needed to link.';
      } else {
        hint.textContent = `Using client ${id}.`;
      }
    }
  }

  function applyAutodartsLinkMode(mode) {
    autodartsLinkMode = mode === 'password' ? 'password' : 'device';
    document.querySelectorAll('#autodarts-mode-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === autodartsLinkMode);
    });
    const deviceMode = $('autodarts-device-mode');
    const passwordMode = $('autodarts-password-block');
    if (deviceMode) deviceMode.hidden = autodartsLinkMode !== 'device';
    if (passwordMode) passwordMode.hidden = autodartsLinkMode !== 'password';
  }

  function renderAutodartsStatus(status) {
    const pill = $('autodarts-status-pill');
    const detail = $('autodarts-status-detail');
    const linked = Boolean(status.linked);
    const needsRelink = Boolean(status.needsRelink);
    if (pill) {
      pill.textContent = needsRelink ? 'Re-link needed' : (linked ? 'Linked' : 'Not linked');
      pill.className = `status-pill${needsRelink ? ' bad' : (linked ? ' good' : '')}`;
    }
    if (detail) {
      if (needsRelink) {
        detail.textContent = status.unavailableReason || 'Re-link Autodarts in Settings';
      } else if (linked) {
        detail.textContent = `Linked as ${status.userName || status.userId || 'account'}`
          + (status.boardName ? ` · board ${status.boardName}` : '');
      } else {
        detail.textContent = 'Pick device link or email & password below to connect your account.';
      }
    }

    renderAutodartsOauth(status.oauth);

    const modeTabs = $('autodarts-mode-tabs');
    const linkedActions = $('autodarts-linked-actions');
    const deviceBlock = $('autodarts-device-block');
    const linkBtn = $('btn-autodarts-link');

    if (linked) {
      if (modeTabs) modeTabs.hidden = true;
      if ($('autodarts-device-mode')) $('autodarts-device-mode').hidden = true;
      if ($('autodarts-password-block')) $('autodarts-password-block').hidden = true;
      if (linkedActions) linkedActions.hidden = false;
    } else {
      if (modeTabs) modeTabs.hidden = false;
      if (linkedActions) linkedActions.hidden = true;
      if (status.deviceLinkPending) {
        autodartsLinkMode = 'device';
        applyAutodartsLinkMode('device');
        if (deviceBlock) deviceBlock.hidden = false;
        if (linkBtn) linkBtn.hidden = true;
      } else {
        applyAutodartsLinkMode(autodartsLinkMode);
        if (deviceBlock) deviceBlock.hidden = true;
        if (linkBtn) linkBtn.hidden = false;
      }
    }

    if (status.deviceUserCode && $('autodarts-device-code')) {
      $('autodarts-device-code').textContent = String(status.deviceUserCode).replace(/(.{3})/g, '$1 ').trim();
    }
    if (status.deviceVerificationUri && $('autodarts-device-open')) {
      $('autodarts-device-open').href = status.deviceVerificationUri;
    }

    const archive = status.archive || {};
    const archiveHint = $('autodarts-archive-hint');
    if (archiveHint) {
      const count = archive.count || 0;
      const syncBit = archive.lastSyncAt
        ? ` · last sync ${archive.lastSyncAt}`
        : (archive.running ? ' · syncing…' : '');
      const note = archive.note || '';
      archiveHint.textContent = count
        ? `${count} matches archived${syncBit}${note ? ` — ${note}` : ''}`
        : `No matches archived yet${syncBit}${note ? ` — ${note}` : ' — Sync history pulls from Autodarts cloud'}`;
    }
    const syncBtn = $('btn-autodarts-sync');
    if (syncBtn) {
      const syncReady = archive.enabled !== false;
      syncBtn.disabled = !syncReady || archive.running === true;
      syncBtn.title = syncReady
        ? 'Pull Match History from Autodarts (local archive is the offline cache)'
        : 'History sync is disabled in settings';
    }
    const boardStatus = $('autodarts-board-status');
    if (boardStatus) {
      const online = status.live?.boardOnline;
      boardStatus.textContent = status.boardId
        ? `Board status: ${status.boardName || status.boardId} · ${online === true ? 'online' : (online === false ? 'offline' : 'status unknown')}`
        : 'Board status: not saved — pick a board in the list';
    }
    renderAutodartsSettings(status.settings);
  }

  async function loadAutodartsSettings() {
    const card = $('autodarts-settings-card');
    if (!card) return;
    try {
      let status = await apiGet('/api/autodarts/status');
      renderAutodartsStatus(status);
      try {
        const boards = await apiGet('/api/autodarts/boards');
        if (boards.ok) {
          status = await ensureAutodartsBoardSelection(boards.boards, status);
          renderAutodartsBoards(boards.boards, status.boardId);
          renderAutodartsStatus(status);
        }
      } catch {
        // boards need a linked account
      }
      if (status.deviceLinkPending) {
        clearTimeout(autodartsPollTimer);
        autodartsPollTimer = setTimeout(loadAutodartsSettings, 3000);
      }
    } catch (error) {
      card.hidden = true;
    }
  }

  function setAutodartsBusy(button, busy, busyLabel) {
    autodartsBusy = busy;
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = busyLabel || 'Working…';
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  const autodartsCard = $('autodarts-settings-card');
  if (autodartsCard) {
    autodartsCard.addEventListener('change', (event) => {
      if (event.target.matches('#autodarts-client-id, #autodarts-client-secret, #autodarts-email, #autodarts-password')) {
        return;
      }
      if (event.target.matches('input, select')) queueAutodartsSave();
    });
    autodartsCard.addEventListener('input', (event) => {
      if (event.target.id === 'autodarts-client-id' || event.target.id === 'autodarts-client-secret') {
        event.target.dataset.dirty = '1';
        return;
      }
      if (event.target.matches('input[type="range"]')) {
        const id = event.target.id;
        const map = {
          'autodarts-final-hold': ['autodarts-final-hold-value', 's'],
          'autodarts-leaderboard-size': ['autodarts-leaderboard-size-value', ''],
          'autodarts-dashboard-seconds': ['autodarts-dashboard-seconds-value', 's'],
          'autodarts-last-match-seconds': ['autodarts-last-match-seconds-value', 's'],
        };
        const entry = map[id];
        if (entry) setAutodartsSlider(id, entry[0], event.target.value, entry[1]);
        queueAutodartsSave();
      }
    });
    $('autodarts-inactivity-tabs')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.segmented-btn');
      if (!btn) return;
      document.querySelectorAll('#autodarts-inactivity-tabs .segmented-btn')
        .forEach((node) => node.classList.toggle('active', node === btn));
      queueAutodartsSave();
    });
    $('autodarts-mode-tabs')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.segmented-btn');
      if (!btn || autodartsBusy) return;
      applyAutodartsLinkMode(btn.dataset.mode);
    });
    $('btn-autodarts-oauth-save')?.addEventListener('click', async () => {
      const button = $('btn-autodarts-oauth-save');
      setAutodartsBusy(button, true, 'Saving…');
      toast('Saving OAuth client…', '');
      try {
        const body = {
          clientId: $('autodarts-client-id')?.value,
          clientSecret: $('autodarts-client-secret')?.value,
        };
        const result = await apiPost('/api/autodarts/oauth', body);
        if (!result.ok) {
          toast(result.error || 'Could not save client', 'bad');
          return;
        }
        if ($('autodarts-client-secret')) {
          $('autodarts-client-secret').value = '';
          delete $('autodarts-client-secret').dataset.dirty;
        }
        if ($('autodarts-client-id')) delete $('autodarts-client-id').dataset.dirty;
        toast('OAuth client saved', 'good');
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Could not save client', 'bad');
      } finally {
        setAutodartsBusy(button, false);
      }
    });
    $('btn-autodarts-link')?.addEventListener('click', async () => {
      const button = $('btn-autodarts-link');
      setAutodartsBusy(button, true, 'Starting…');
      toast('Starting device link…', '');
      try {
        const result = await apiPost('/api/autodarts/link/device', {});
        if (!result.ok) {
          toast(result.error || 'Device link unavailable', 'bad');
          return;
        }
        if (result.linked) {
          toast('Autodarts linked', 'good');
        } else {
          toast('Approve the code on auth.autodarts.com', 'good');
        }
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Could not start Autodarts link', 'bad');
      } finally {
        setAutodartsBusy(button, false);
      }
    });
    $('btn-autodarts-device-cancel')?.addEventListener('click', async () => {
      try {
        await apiPost('/api/autodarts/link/cancel', {});
      } catch {
        // ignore
      }
      await loadAutodartsSettings();
      toast('Device link cancelled', 'warn');
    });
    $('btn-autodarts-password')?.addEventListener('click', async () => {
      const button = $('btn-autodarts-password');
      setAutodartsBusy(button, true, 'Signing in…');
      toast('Signing in to Autodarts…', '');
      try {
        const result = await apiPost('/api/autodarts/link/password', {
          email: $('autodarts-email')?.value,
          password: $('autodarts-password')?.value,
        });
        if (!result.ok) {
          toast(result.error || 'Login failed', 'bad');
          return;
        }
        if ($('autodarts-password')) $('autodarts-password').value = '';
        toast('Autodarts linked', 'good');
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Login failed', 'bad');
      } finally {
        setAutodartsBusy(button, false);
      }
    });
    $('btn-autodarts-relink')?.addEventListener('click', async () => {
      applyAutodartsLinkMode('device');
      if ($('autodarts-mode-tabs')) $('autodarts-mode-tabs').hidden = false;
      if ($('autodarts-linked-actions')) $('autodarts-linked-actions').hidden = true;
      if ($('autodarts-device-mode')) $('autodarts-device-mode').hidden = false;
      $('btn-autodarts-link')?.click();
    });
    $('btn-autodarts-unlink')?.addEventListener('click', async () => {
      try {
        const result = await apiPost('/api/autodarts/unlink', {});
        if (!result.ok) {
          toast(result.error || 'Could not unlink', 'bad');
          return;
        }
        toast('Autodarts unlinked', 'good');
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Could not unlink', 'bad');
      }
    });
    $('autodarts-board')?.addEventListener('change', async () => {
      const select = $('autodarts-board');
      const option = select?.selectedOptions?.[0];
      try {
        await apiPost('/api/autodarts/board', {
          boardId: select.value,
          boardName: option?.textContent?.split(' · ')[0] || select.value,
        });
        toast('Board saved', 'good');
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Could not save board', 'bad');
      }
    });
    $('btn-autodarts-test')?.addEventListener('click', async () => {
      const button = $('btn-autodarts-test');
      setAutodartsBusy(button, true, 'Testing…');
      toast('Testing Autodarts…', '');
      try {
        const result = await apiPost('/api/autodarts/test', {});
        $('autodarts-test-result').textContent = result.message || (result.ok ? 'ok' : 'failed');
        toast(result.message || (result.ok ? 'Autodarts ok' : 'Test failed'), result.ok ? 'good' : 'bad');
      } catch (error) {
        toast(error.message || 'Test failed', 'bad');
      } finally {
        setAutodartsBusy(button, false);
      }
    });
    $('btn-autodarts-sync')?.addEventListener('click', async () => {
      const button = $('btn-autodarts-sync');
      if (button?.disabled) {
        toast('History sync is already running or disabled', 'warn');
        return;
      }
      setAutodartsBusy(button, true, 'Syncing…');
      toast('Pulling Match History from Autodarts…', '');
      try {
        const result = await apiPost('/api/autodarts/sync', {});
        if (result.skipped) {
          toast(result.error || 'History sync skipped', 'warn');
        } else if (result.ok) {
          toast(
            `Imported ${result.imported || 0} match${result.imported === 1 ? '' : 'es'}`
              + (result.skipped ? ` · ${result.skipped} already known` : ''),
            'good',
          );
        } else {
          toast(result.error || result.note || 'Sync failed — local archive unchanged', 'warn');
        }
        await loadAutodartsSettings();
      } catch (error) {
        toast(error.message || 'Sync failed', 'bad');
      } finally {
        setAutodartsBusy(button, false);
      }
    });
    applyAutodartsLinkMode('device');
    loadAutodartsSettings();
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
    const perCategory = Number(status?.categoryTarget || 0);
    if (pill) {
      const ready = status?.hasContent;
      const fetching = Boolean(status?.refilling);
      const restocking = Boolean(status?.restocking);
      let label;
      let tone;
      if (fetching) {
        label = 'Restocking…';
        tone = 'warn';
      } else if (ready) {
        label = `${available} ready`;
        tone = 'ok';
      } else if (restocking) {
        label = 'Stocking';
        tone = 'warn';
      } else {
        label = available ? `${available} left` : 'Repeats soon';
        tone = 'warn';
      }
      pill.textContent = label;
      pill.className = `status-pill ${tone === 'ok' ? 'ok' : 'warn'}`;
    }
    if (detail) {
      // `available` excludes recently-served questions, so it is usually lower
      // than the raw cache size — showing both avoids a confusing "3 ready of 300".
      const bits = [`${available} unplayed of ${size} cached`];
      if (perCategory) {
        bits.push(`aim ${perCategory} per category`);
      }
      if (status?.refilling) {
        bits.push('fetching now');
      } else if (status?.lastRefillAt) {
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
        await refreshTriviaCategories();
        if (result.status?.refilling) {
          toast('Restocking — this takes a few minutes', 'ok');
          watchTriviaRefill();
        } else if (result.status?.restocking) {
          toast('Fetch queued — the pool will pick it up on the next pass', 'ok');
        } else {
          toast('Nothing new to fetch right now (per-category aim already met, or sources are empty)', 'ok');
        }
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

  // ------------------------------------------------------------- Roll Credits

  const CREDITS_ROUTE = '/api/roll-credits';
  const CREDITS_VIEW_KEY = 'rollCredits.view';
  const CREDITS_DENSITY_KEY = 'rollCredits.density';
  const CREDITS_PRIORITY_LABELS = {
    video: 'Video',
    screenshot: 'Screenshots',
    cover: 'Cover',
  };
  let creditsReady = false;
  let creditsLoading = false;
  let creditsView = localStorage.getItem(CREDITS_VIEW_KEY) === 'list' ? 'list' : 'grid';
  let creditsDensity = (() => {
    const saved = Number(localStorage.getItem(CREDITS_DENSITY_KEY));
    if (Number.isFinite(saved) && saved >= 2 && saved <= 6) return Math.round(saved);
    return creditsDefaultDensity();
  })();
  let creditsSystems = [];
  let creditsUsedSystems = [];
  let creditsSystemLabels = new Map();
  let creditsGames = [];
  let creditsTotal = 0;
  let creditsPages = 0;
  let creditsPage = 1;
  let creditsSort = 'induction';
  let creditsDir = 'desc';
  let creditsSelecting = false;
  let creditsSelected = new Set();
  let creditsSelectedSystems = new Set();
  let creditsEvents = null;
  let creditsSearchTimer = null;
  let creditsEditGame = null;
  let creditsEditDirty = false;
  let creditsDifficulty = null;
  let creditsGlobalPriority = ['video', 'screenshot', 'cover'];
  let creditsGamePriority = ['video', 'screenshot', 'cover'];
  let creditsCandidate = null;
  let creditsAddBeatenAt = '';
  let creditsPendingDelete = null;
  let creditsRescrapeIds = [];
  let creditsSettingsLoaded = false;
  let creditsResizeTimer = null;
  let creditsMediaDragIndex = null;
  let creditsFiltersOpen = false;
  let creditsKnownYears = [];
  let creditsReordering = false;
  let creditsOrderManual = false;
  let creditsDragId = null;

  const CREDITS_DIFFICULTY_RANK = {
    easy: 1, normal: 2, hard: 3, brutal: 4,
  };

  // Mirrors the store's sort keys so the multi-system merge path (which pulls
  // one request per system) orders exactly like a single server-side list.
  function creditsSortValue(game, column) {
    switch (column) {
      case 'induction': return Number(game.induction) || 0;
      case 'beatenAt': return creditsIsDateOnly(game.beatenAt) ? game.beatenAt : null;
      case 'difficulty':
        return CREDITS_DIFFICULTY_RANK[String(game.meta?.difficulty || '').toLowerCase()] || null;
      case 'releaseDate': {
        const text = String(game.meta?.releaseDate || '').trim();
        const year = /^(\d{4})/.exec(text);
        if (!year) return null;
        return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : `${year[1]}-01-01`;
      }
      case 'maxPlayers': {
        const players = Number(game.meta?.maxPlayers);
        return Number.isFinite(players) && players > 0 ? players : null;
      }
      default: return String(game[column] || '').trim() || null;
    }
  }

  function creditsCompare(a, b) {
    const left = creditsSortValue(a, creditsSort);
    const right = creditsSortValue(b, creditsSort);
    if ((left == null) !== (right == null)) return left == null ? 1 : -1;
    if (left == null) return (Number(b.induction) || 0) - (Number(a.induction) || 0);
    const compared = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
    if (compared !== 0) return creditsDir === 'asc' ? compared : -compared;
    return (Number(b.induction) || 0) - (Number(a.induction) || 0);
  }

  function creditsCanReorder() {
    return creditsSort === 'induction';
  }

  function creditsViewportWidth() {
    return Math.max(320, Number(window.innerWidth) || 390);
  }

  function creditsMaxColumns() {
    const width = creditsViewportWidth();
    if (width < 480) return 2;
    if (width < 640) return 3;
    if (width < 900) return 4;
    return 6;
  }

  function creditsDefaultDensity() {
    return creditsViewportWidth() < 640 ? 2 : 3;
  }

  function creditsGridColumns() {
    return Math.max(2, Math.min(creditsDensity, creditsMaxColumns()));
  }

  function syncCreditsZoomControls() {
    const slider = $('credits-zoom');
    if (!slider) return;
    const max = creditsMaxColumns();
    slider.max = String(max);
    slider.min = '2';
    slider.value = String(creditsGridColumns());
  }

  function creditsToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function creditsIsDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
  }

  function creditsReadBeatenFields(dateInputId, naInputId) {
    if ($(naInputId)?.checked) {
      return { beatenAt: null, beatenDateUnknown: true };
    }
    const raw = String($(dateInputId)?.value || '').trim();
    if (!creditsIsDateOnly(raw)) {
      return { error: 'Pick a beaten-on date, or choose NA — don\'t remember.' };
    }
    return { beatenAt: raw, beatenDateUnknown: false };
  }

  function revealCreditsAddFields() {
    $('credits-add-fields').hidden = false;
    // Hidden `<input type="date">` values are unreliable on iOS — re-apply after show.
    if (!$('credits-add-date-na').checked) {
      const preferred = creditsIsDateOnly(creditsAddBeatenAt)
        ? creditsAddBeatenAt
        : (creditsIsDateOnly($('credits-add-date').value) ? $('credits-add-date').value : creditsToday());
      creditsAddBeatenAt = preferred;
      $('credits-add-date').value = preferred;
      $('credits-add-date').disabled = false;
    }
  }

  function creditsSystemLabel(id) {
    const key = String(id || '').toLowerCase();
    return creditsSystemLabels.get(key)
      || creditsUsedSystems.find((system) => system.id === key)?.label
      || String(id || 'Other');
  }

  function creditsPanelFilterCount() {
    let count = creditsSelectedSystems.size;
    if ($('credits-year')?.value) count += 1;
    if ($('credits-no-date')?.checked) count += 1;
    return count;
  }

  function creditsHasActiveFilters() {
    return creditsPanelFilterCount() > 0 || Boolean($('credits-q')?.value.trim());
  }

  function syncCreditsFiltersChrome() {
    const count = creditsPanelFilterCount();
    const badge = $('credits-filters-badge');
    const clear = $('btn-credits-clear-filters');
    const toggle = $('btn-credits-filters-toggle');
    const panel = $('credits-filters-panel');
    const shell = $('credits-filters-shell');
    if (badge) {
      badge.hidden = count === 0;
      badge.textContent = count ? String(count) : '';
      badge.title = count
        ? `${count} active filter${count === 1 ? '' : 's'}`
        : '';
    }
    if (clear) clear.hidden = count === 0;
    if (toggle) {
      toggle.setAttribute('aria-expanded', creditsFiltersOpen ? 'true' : 'false');
      toggle.classList.toggle('is-open', creditsFiltersOpen);
      toggle.classList.toggle('has-active', count > 0);
    }
    if (panel) panel.hidden = !creditsFiltersOpen;
    if (shell) shell.classList.toggle('has-active', count > 0);
  }

  function clearCreditsPanelFilters() {
    creditsSelectedSystems.clear();
    if ($('credits-year')) $('credits-year').value = '';
    if ($('credits-no-date')) $('credits-no-date').checked = false;
    syncCreditsFiltersChrome();
    renderCreditsSystemFilters();
    creditsPage = 1;
    loadCredits();
  }

  function creditsDate(value, long = false) {
    if (!value) return 'date unknown';
    const [year, month, day] = String(value).split('-').map(Number);
    if (!year || !month || !day) return 'date unknown';
    return new Intl.DateTimeFormat('en-US', long
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day));
  }

  function creditsMediaUrl(path) {
    if (!path) return '';
    const value = String(path);
    if (/^https?:\/\//i.test(value) || value.startsWith('/roll-credits-media/')) return value;
    return `/roll-credits-media/${value.replace(/^\/+/, '')}`;
  }

  function creditsYoutubeId(url) {
    const text = String(url || '').trim();
    if (!text) return '';
    const match = text.match(
      /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i,
    );
    return match ? match[1] : '';
  }

  function creditsYoutubeThumbUrl(url) {
    const id = creditsYoutubeId(url);
    return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
  }

  function creditsMediaThumbHtml(row) {
    const stored = creditsMediaUrl(row.thumbPath || (row.kind !== 'video' ? row.path : ''));
    if (stored) {
      return `<img class="credits-media-thumb" src="${escapeHtml(stored)}" alt="">`;
    }
    if (row.kind === 'video') {
      const youtubeThumb = creditsYoutubeThumbUrl(row.youtubeUrl);
      if (youtubeThumb) {
        return `<span class="credits-media-thumb credits-media-thumb-video has-preview"><img src="${escapeHtml(youtubeThumb)}" alt="" loading="lazy"><span class="credits-media-play" aria-hidden="true"></span></span>`;
      }
      return `<span class="credits-media-thumb credits-media-thumb-video" title="Video" role="img" aria-label="Video"><span class="credits-media-play" aria-hidden="true"></span></span>`;
    }
    return '<span class="credits-media-thumb" aria-hidden="true"></span>';
  }

  function creditsInitials(title) {
    return String(title || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map((word) => word[0]).join('').toUpperCase();
  }

  function creditsThumb(game) {
    const ready = (game.media || []).filter((row) => row.status === 'ready' && !row.hidden);
    const row = ready.find((item) => item.kind === 'cover')
      || ready.find((item) => item.kind === 'screenshot');
    return creditsMediaUrl(row?.thumbPath || row?.path);
  }

  function creditsMediaState(game) {
    const media = game.media || [];
    if (media.some((row) => row.status === 'failed')) return 'failed';
    if (media.some((row) => row.status === 'pending')) return 'pending';
    return '';
  }

  function creditsListQuery(pageSize, page = creditsPage) {
    const params = new URLSearchParams({
      sort: creditsSort,
      dir: creditsDir,
      page: String(page),
      pageSize: String(pageSize),
    });
    const query = $('credits-q')?.value.trim();
    const year = $('credits-year')?.value;
    if (query) params.set('q', query);
    if (year) params.set('yearBeaten', year);
    if ($('credits-no-date')?.checked) params.set('noDate', 'true');
    if (creditsSelectedSystems.size === 1) {
      params.set('system', [...creditsSelectedSystems][0]);
    }
    return params;
  }

  function creditsSetError(error) {
    $('credits-error-copy').textContent = error?.message || 'Try refreshing.';
    $('credits-error').hidden = false;
    $('credits-empty').hidden = true;
  }

  async function loadCredits({ quiet = false } = {}) {
    if (!creditsReady || creditsLoading) return;
    creditsLoading = true;
    $('credits-error').hidden = true;
    $('btn-credits-refresh')?.classList.add('is-loading');
    try {
      if (creditsSelectedSystems.size > 1) {
        const selected = [...creditsSelectedSystems];
        const pageSize = creditsView === 'grid' ? 500 : 50;
        const responses = await Promise.all(selected.map((system) => {
          const params = creditsListQuery(500, 1);
          params.set('system', system);
          return apiGet(`${CREDITS_ROUTE}/games?${params}`);
        }));
        const merged = responses.flatMap((result) => result.games || []);
        const seen = new Set();
        const unique = merged.filter((game) => !seen.has(game.id) && seen.add(game.id));
        unique.sort(creditsCompare);
        creditsOrderManual = responses.some((result) => result.orderManual === true);
        creditsTotal = unique.length;
        creditsPages = Math.ceil(unique.length / pageSize) || (unique.length ? 1 : 0);
        creditsPage = Math.min(Math.max(1, creditsPage), Math.max(1, creditsPages));
        creditsGames = unique.slice((creditsPage - 1) * pageSize, creditsPage * pageSize);
      } else {
        const size = creditsView === 'grid' ? 500 : 50;
        const result = await apiGet(`${CREDITS_ROUTE}/games?${creditsListQuery(size)}`);
        creditsGames = result.games || [];
        creditsOrderManual = result.orderManual === true;
        creditsTotal = Number(result.total) || 0;
        creditsPages = Number(result.pages) || (creditsTotal ? Math.ceil(creditsTotal / size) : 0);
        creditsPage = Number(result.page) || 1;
      }
      const ids = new Set(creditsGames.map((game) => game.id));
      [...creditsSelected].forEach((id) => { if (!ids.has(id)) creditsSelected.delete(id); });
      renderCreditsYears();
      renderCredits();
      await loadCreditsJobs();
      loadCreditsSystems().catch(() => {});
    } catch (error) {
      creditsSetError(error);
      if (!quiet) toast(error.message || 'Could not load Roll Credits', 'bad');
    } finally {
      creditsLoading = false;
      $('btn-credits-refresh')?.classList.remove('is-loading');
    }
  }

  async function loadCreditsJobs() {
    try {
      const { jobs = [] } = await apiGet(`${CREDITS_ROUTE}/jobs`);
      const pending = jobs.filter((job) => job.state === 'queued' || job.state === 'running').length;
      const failed = jobs.filter((job) => job.state === 'failed').length;
      const status = $('credits-job-status');
      status.classList.toggle('has-failures', failed > 0);
      if (!pending && !failed) status.textContent = 'Media jobs are up to date.';
      else status.textContent = `${pending} pending · ${failed} failed media job${failed === 1 ? '' : 's'}`;
    } catch {
      $('credits-job-status').textContent = 'Media job status unavailable.';
    }
  }

  function setCreditsZoom(columns) {
    const max = creditsMaxColumns();
    const next = Math.max(2, Math.min(max, Math.round(Number(columns) || creditsDefaultDensity())));
    creditsDensity = next;
    localStorage.setItem(CREDITS_DENSITY_KEY, String(next));
    syncCreditsZoomControls();
    if (creditsView === 'grid') renderCreditsGrid();
  }

  function syncCreditsSortChrome() {
    const select = $('credits-sort-select');
    if (select) select.value = `${creditsSort}:${creditsDir}`;
    const toggle = $('btn-credits-reorder');
    if (toggle) {
      toggle.classList.toggle('active', creditsReordering);
      toggle.textContent = creditsReordering ? 'Done reordering' : 'Reorder';
    }
    const bar = $('credits-reorder-bar');
    if (bar) bar.hidden = !creditsReordering;
    const copy = $('credits-reorder-copy');
    if (copy) {
      copy.textContent = creditsOrderManual
        ? 'Custom order is on — drag a game, or use ↑ ↓, to change it.'
        : 'Order follows beaten dates. Drag a game, or use ↑ ↓, to take over.';
    }
    const reset = $('btn-credits-reorder-reset');
    if (reset) reset.disabled = !creditsOrderManual;
  }

  function setCreditsReordering(on) {
    creditsReordering = Boolean(on);
    if (creditsReordering) {
      creditsSelecting = false;
      creditsSelected.clear();
      // Dragging only means something against the induction order, so entering
      // reorder mode from any other sort snaps back to it first.
      if (!creditsCanReorder()) {
        creditsSort = 'induction';
        creditsDir = 'desc';
        creditsPage = 1;
        loadCredits();
        return;
      }
    }
    renderCredits();
  }

  // Rendered as spans, not buttons: grid tiles are themselves <button> elements
  // and nested buttons get hoisted out of the tile by the parser.
  function creditsMoveButtons(index) {
    if (!creditsReordering) return '';
    const step = (delta, glyph, label, disabled) => `<span
      class="credits-move-btn${disabled ? ' is-disabled' : ''}"
      data-credits-move="${delta}" data-credits-move-index="${index}"
      title="${label}">${glyph}</span>`;
    return `<span class="credits-move">
      ${step(-1, '↑', 'Move up — inducted more recently', index === 0)}
      ${step(1, '↓', 'Move down — inducted earlier', index >= creditsGames.length - 1)}
    </span>`;
  }

  function renderCredits() {
    const empty = creditsTotal === 0;
    const filtered = creditsHasActiveFilters();
    const emptyCard = $('credits-empty');
    emptyCard.querySelector('strong').textContent = filtered ? 'No games match these filters.' : 'No games yet.';
    emptyCard.querySelector('span').textContent = filtered
      ? 'Filters stay applied above — clear them or expand Filters to adjust.'
      : "Add the first one you've beaten.";
    $('btn-credits-empty-add').hidden = filtered;
    $('credits-empty').hidden = !empty;
    $('credits-grid-view').hidden = creditsView !== 'grid' || empty;
    $('credits-list-view').hidden = creditsView !== 'list' || empty;
    $('credits-density-wrap').hidden = creditsView !== 'grid';
    document.querySelectorAll('[data-credits-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.creditsView === creditsView);
    });
    syncCreditsZoomControls();
    syncCreditsFiltersChrome();
    syncCreditsSortChrome();
    renderCreditsSelection();
    if (creditsView === 'grid') renderCreditsGrid();
    else renderCreditsList();
  }

  function renderCreditsGrid() {
    const host = $('credits-grid');
    syncCreditsZoomControls();
    host.classList.toggle('is-reordering', creditsReordering);
    host.style.setProperty('--credits-columns', String(creditsGridColumns()));
    host.innerHTML = creditsGames.map((game, index) => {
      const thumb = creditsThumb(game);
      const state = creditsMediaState(game);
      const lazy = index >= 12 ? ' loading="lazy"' : '';
      const art = thumb
        ? `<img src="${escapeHtml(thumb)}" alt=""${lazy}>`
        : `<span class="credits-placeholder">${escapeHtml(creditsInitials(game.title))}</span>`;
      const badge = state === 'pending'
        ? '<span class="credits-media-badge" title="Media pending">↻</span>'
        : state === 'failed' ? '<span class="credits-media-badge failed" title="Media failed">!</span>' : '';
      return `<button type="button" class="credits-tile${creditsSelected.has(game.id) ? ' selected' : ''}"
        data-credits-id="${escapeHtml(game.id)}"${creditsReordering ? ' draggable="true"' : ''}>
        ${creditsSelecting ? '<span class="credits-tile-check"></span>' : ''}
        <span class="credits-cover">${art}${badge}
          <span class="credits-induction">#${String(game.induction || 0).padStart(3, '0')}</span>
          ${creditsMoveButtons(index)}
        </span>
        <span class="credits-tile-copy">
          <strong class="credits-tile-title">${escapeHtml(game.title || 'Untitled game')}</strong>
          <span class="credits-tile-meta"><span class="credits-system-chip">${escapeHtml(creditsSystemLabel(game.system))}</span>
          <span class="credits-date">${escapeHtml(creditsDate(game.beatenAt, true))}</span></span>
        </span>
      </button>`;
    }).join('');
  }

  function creditsSortMark(column) {
    return creditsSort === column ? (creditsDir === 'asc' ? ' ↑' : ' ↓') : '';
  }

  function renderCreditsList() {
    $('credits-table-body')?.classList.toggle('is-reordering', creditsReordering);
    const headings = {
      induction: '#', beatenAt: 'Beaten', createdAt: 'Added', title: 'Title', system: 'System',
    };
    document.querySelectorAll('[data-credits-sort]').forEach((button) => {
      const column = button.dataset.creditsSort;
      button.classList.toggle('active', column === creditsSort);
      button.textContent = `${headings[column] || column}${creditsSortMark(column)}`;
    });
    $('credits-table-body').innerHTML = creditsGames.map((game, index) => `<tr data-credits-id="${escapeHtml(game.id)}"
      class="${creditsSelected.has(game.id) ? 'selected' : ''}"${creditsReordering ? ' draggable="true"' : ''}>
      <td>${creditsSelecting ? `<input type="checkbox" aria-label="Select ${escapeHtml(game.title)}"${creditsSelected.has(game.id) ? ' checked' : ''}>` : ''}</td>
      <td class="credits-induction-col"><span class="credits-induction">#${String(game.induction || 0).padStart(3, '0')}</span>${creditsMoveButtons(index)}</td>
      <td><strong>${escapeHtml(game.title)}</strong></td>
      <td><span class="credits-system-chip">${escapeHtml(creditsSystemLabel(game.system))}</span></td>
      <td>${escapeHtml(creditsDate(game.beatenAt))}</td>
      <td>${escapeHtml(creditsDate(String(game.createdAt || '').slice(0, 10)))}</td>
      <td class="credits-wide-col">${escapeHtml(game.meta?.maxPlayers || '—')}</td>
      <td class="credits-wide-col">${escapeHtml(game.meta?.publisher || '—')}</td>
    </tr>`).join('');
    $('credits-page-label').textContent = creditsPages
      ? `Page ${creditsPage} of ${creditsPages}` : 'Page 1 of 1';
    $('btn-credits-prev').disabled = creditsPage <= 1;
    $('btn-credits-next').disabled = creditsPage >= Math.max(1, creditsPages);
  }

  // The server treats the posted ids as "these games keep the slots they already
  // hold, in this order", so a filtered or paginated view reorders safely.
  async function commitCreditsOrder() {
    const ids = creditsGames.map((game) => game.id);
    try {
      const result = await apiPost(`${CREDITS_ROUTE}/games/reorder`, { ids });
      creditsOrderManual = result.manual === true;
      await loadCredits({ quiet: true });
    } catch (error) {
      toast(error.message || 'Could not save the order', 'bad');
      await loadCredits({ quiet: true });
    }
  }

  function moveCreditsGame(index, delta) {
    const target = index + delta;
    if (index < 0 || target < 0 || target >= creditsGames.length) return;
    const [moved] = creditsGames.splice(index, 1);
    creditsGames.splice(target, 0, moved);
    renderCredits();
    commitCreditsOrder();
  }

  function dropCreditsGame(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const from = creditsGames.findIndex((game) => game.id === fromId);
    const to = creditsGames.findIndex((game) => game.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = creditsGames.splice(from, 1);
    creditsGames.splice(to, 0, moved);
    renderCredits();
    commitCreditsOrder();
  }

  async function resetCreditsOrder() {
    try {
      await apiPost(`${CREDITS_ROUTE}/games/reorder`, { reset: true });
      creditsOrderManual = false;
      toast('Induction order follows beaten dates again', 'good');
      await loadCredits({ quiet: true });
    } catch (error) {
      toast(error.message || 'Could not reset the order', 'bad');
    }
  }

  function renderCreditsSelection() {
    $('btn-credits-select').hidden = creditsSelecting;
    $('credits-selection-tools').hidden = !creditsSelecting;
    $('credits-selected-count').textContent = creditsSelected.size;
    $('btn-credits-delete-selected').disabled = creditsSelected.size === 0;
    $('btn-credits-rescrape-selected').disabled = creditsSelected.size === 0;
    $('btn-credits-select-all').textContent = creditsGames.length
      && creditsGames.every((game) => creditsSelected.has(game.id)) ? 'Unselect all' : 'Select all';
  }

  function setCreditsSelecting(on) {
    creditsSelecting = on;
    if (on) creditsReordering = false;
    if (!on) creditsSelected.clear();
    renderCredits();
  }

  function toggleCreditSelected(id) {
    if (creditsSelected.has(id)) creditsSelected.delete(id);
    else creditsSelected.add(id);
    renderCredits();
  }

  async function loadCreditsSystems() {
    const result = await apiGet(`${CREDITS_ROUTE}/systems`);
    creditsSystems = result.systems || [];
    creditsUsedSystems = Array.isArray(result.usedSystems) ? result.usedSystems : [];
    creditsSystemLabels = new Map(creditsSystems.map((system) => [system.id, system.label]));
    const options = creditsSystems.map((system) => (
      `<option value="${escapeHtml(system.id)}">${escapeHtml(system.label)}</option>`
    )).join('');
    // Rebuilding <select> options clears the selection; restore so a quiet
    // refresh (e.g. after re-scrape) cannot silently flip Arcade → NES.
    const addSystem = $('credits-add-system')?.value;
    const editSystem = $('credits-edit-system')?.value
      || creditsEditGame?.system
      || '';
    $('credits-add-system').innerHTML = options;
    $('credits-edit-system').innerHTML = options;
    if (addSystem) $('credits-add-system').value = addSystem;
    if (editSystem) $('credits-edit-system').value = editSystem;
    renderCreditsSystemFilters();
  }

  function renderCreditsSystemFilters() {
    const host = $('credits-system-filters');
    if (!host) return;
    const used = creditsUsedSystems.length ? [...creditsUsedSystems] : [];
    const usedIds = new Set(used.map((system) => system.id));
    // Keep selected systems visible even after the last matching game is edited away,
    // otherwise the list goes empty with no clue which filter is still on.
    for (const id of creditsSelectedSystems) {
      if (usedIds.has(id)) continue;
      used.push({
        id,
        label: creditsSystemLabel(id),
        count: 0,
        orphan: true,
      });
    }
    used.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id), undefined, {
      sensitivity: 'base',
    }));
    if (!used.length) {
      host.innerHTML = '<span class="credits-system-filters-empty">Filters appear after you add games.</span>';
      syncCreditsFiltersChrome();
      return;
    }
    host.innerHTML = used.map((system) => {
      const active = creditsSelectedSystems.has(system.id);
      const countLabel = Number.isFinite(Number(system.count)) ? ` · ${system.count}` : '';
      const orphanClass = system.orphan ? ' is-orphan' : '';
      return `<button type="button" class="credits-filter-chip${active ? ' active' : ''}${orphanClass}" data-credits-system="${escapeHtml(system.id)}">${escapeHtml(system.label)}${countLabel}</button>`;
    }).join('');
    syncCreditsFiltersChrome();
  }

  function renderCreditsYears() {
    const fromPage = creditsGames.map((game) => String(game.beatenAt || '').slice(0, 4))
      .filter((year) => /^\d{4}$/.test(year));
    creditsKnownYears = [...new Set([...creditsKnownYears, ...fromPage])]
      .filter((year) => /^\d{4}$/.test(year))
      .sort()
      .reverse();
    const select = $('credits-year');
    if (!select) return;
    const current = select.value;
    if (current && /^\d{4}$/.test(current) && !creditsKnownYears.includes(current)) {
      creditsKnownYears = [...creditsKnownYears, current].sort().reverse();
    }
    select.innerHTML = '<option value="">All years</option>'
      + creditsKnownYears.map((year) => `<option value="${year}">${year}</option>`).join('');
    if (current) select.value = current;
    syncCreditsFiltersChrome();
  }

  function startCreditsEvents() {
    if (creditsEvents) return;
    try {
      creditsEvents = new EventSource(appUrl(`${CREDITS_ROUTE}/events`));
    } catch {
      return;
    }
    let refreshTimer = null;
    creditsEvents.addEventListener('roll-credits', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCredits({ quiet: true }), 180);
    });
  }

  function openCreditsAdd() {
    creditsCandidate = null;
    creditsAddBeatenAt = creditsToday();
    $('credits-add-search').value = '';
    $('credits-add-title').value = '';
    $('credits-add-date').value = creditsAddBeatenAt;
    $('credits-add-date').disabled = false;
    $('credits-add-date-na').checked = false;
    $('credits-add-with').value = '';
    $('credits-candidates').innerHTML = '';
    $('credits-add-fields').hidden = true;
    $('credits-add-status').textContent = 'Search IGDB and Steam, or add a game manually.';
    $('credits-add-sheet').hidden = false;
    setTimeout(() => $('credits-add-search').focus(), 40);
  }

  async function searchCreditsCandidates() {
    const q = $('credits-add-search').value.trim();
    if (!q) {
      $('credits-add-status').textContent = 'Type a game title first.';
      return;
    }
    $('btn-credits-add-search').disabled = true;
    $('credits-add-status').textContent = 'Searching…';
    try {
      const { candidates = [] } = await apiPost(`${CREDITS_ROUTE}/search`, { q });
      $('credits-add-status').textContent = candidates.length
        ? 'Pick a game, then pick one system.' : 'No matches. Try another title or add it manually.';
      $('credits-candidates').innerHTML = candidates.map((candidate, index) => {
        const thumb = candidate.thumbUrl
          ? `<img src="${escapeHtml(candidate.thumbUrl)}" alt="">`
          : '<span class="credits-candidate-art"></span>';
        const systems = (candidate.platforms || []).map((system) => {
          const id = typeof system === 'object' ? system.id : system;
          const label = typeof system === 'object' ? (system.label || creditsSystemLabel(id)) : creditsSystemLabel(id);
          return `<button type="button" data-candidate-index="${index}" data-candidate-system="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
        }).join('');
        return `<div class="credits-candidate" data-candidate-card="${index}">${thumb}<div class="credits-candidate-main">
          <div class="credits-candidate-title">${escapeHtml(candidate.name || candidate.title)}</div>
          <div class="credits-candidate-year">${escapeHtml(candidate.year || 'Year unknown')}</div>
          <div class="credits-chip-row">${systems || '<span class="hint">No supported systems listed.</span>'}</div>
        </div></div>`;
      }).join('');
      $('credits-candidates')._creditsCandidates = candidates;
    } catch (error) {
      $('credits-add-status').textContent = error.message || 'Search failed. Add the game manually instead.';
    } finally {
      $('btn-credits-add-search').disabled = false;
    }
  }

  function chooseCreditsCandidate(index, system, button) {
    const candidate = $('credits-candidates')._creditsCandidates?.[index];
    if (!candidate) return;
    creditsCandidate = candidate;
    document.querySelectorAll('[data-candidate-card]').forEach((card) => {
      card.classList.toggle('selected', card.dataset.candidateCard === String(index));
    });
    document.querySelectorAll('[data-candidate-system]').forEach((chip) => chip.classList.remove('active'));
    button.classList.add('active');
    $('credits-add-title').value = candidate.name || candidate.title || '';
    $('credits-add-system').value = system;
    revealCreditsAddFields();
  }

  async function createCreditGame() {
    const title = $('credits-add-title').value.trim();
    const system = $('credits-add-system').value;
    if (!title || !system) {
      toast('Choose a title and one system', 'bad');
      return;
    }
    revealCreditsAddFields();
    const beaten = creditsReadBeatenFields('credits-add-date', 'credits-add-date-na');
    if (beaten.error) {
      toast(beaten.error, 'bad');
      return;
    }
    const payload = {
      title,
      system,
      beatenAt: beaten.beatenAt,
      beatenDateUnknown: beaten.beatenDateUnknown,
      beatenWith: $('credits-add-with').value.trim(),
    };
    if (creditsCandidate) payload.candidate = creditsCandidate;
    $('btn-credits-create').disabled = true;
    try {
      const result = await apiPost(`${CREDITS_ROUTE}/games`, payload);
      $('credits-add-sheet').hidden = true;
      toast(result.game?.duplicateWarning ? 'Game added — a matching game already exists' : 'Game added', 'good');
      creditsPage = 1;
      await loadCredits();
    } catch (error) {
      toast(error.message || 'Could not add game', 'bad');
    } finally {
      $('btn-credits-create').disabled = false;
    }
  }

  function creditsPriorityHtml(order, scope) {
    return order.map((kind, index) => `<div class="credits-priority-item" data-priority-kind="${kind}">
      <span>${CREDITS_PRIORITY_LABELS[kind]}</span>
      <button type="button" class="credits-mini-btn" data-priority-scope="${scope}" data-priority-move="-1" data-priority-index="${index}" aria-label="Move up">↑</button>
      <button type="button" class="credits-mini-btn" data-priority-scope="${scope}" data-priority-move="1" data-priority-index="${index}" aria-label="Move down">↓</button>
    </div>`).join('');
  }

  function markCreditsEditDirty() {
    creditsEditDirty = true;
    if ($('btn-credits-edit-save')) $('btn-credits-edit-save').disabled = false;
  }

  function renderCreditsPriorities() {
    $('credits-global-priority').innerHTML = creditsPriorityHtml(creditsGlobalPriority, 'global');
    $('credits-game-priority').innerHTML = creditsPriorityHtml(creditsGamePriority, 'game');
  }

  function moveCreditsPriority(scope, index, amount) {
    const list = scope === 'global' ? creditsGlobalPriority : creditsGamePriority;
    const next = index + amount;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    if (scope === 'game') markCreditsEditDirty();
    renderCreditsPriorities();
  }

  async function openCreditsEdit(id) {
    try {
      const { game } = await apiGet(`${CREDITS_ROUTE}/games/${encodeURIComponent(id)}`);
      creditsEditGame = game;
      creditsEditDirty = false;
      $('btn-credits-edit-save').disabled = true;
      creditsDifficulty = game.meta?.difficulty || null;
      creditsGamePriority = [...(game.mediaPriorityOverride || creditsGlobalPriority)];
      $('credits-edit-heading').textContent = game.title || 'Edit game';
      $('credits-edit-induction').textContent = `#${String(game.induction || 0).padStart(3, '0')}`;
      $('credits-edit-title').value = game.title || '';
      $('credits-edit-system').value = game.system || 'other';
      $('credits-edit-date').value = game.beatenAt || '';
      $('credits-edit-date').disabled = game.beatenDateUnknown === true;
      $('credits-edit-date-na').checked = game.beatenDateUnknown === true;
      $('credits-edit-with').value = game.beatenWith || '';
      $('credits-edit-description').value = game.meta?.description || '';
      $('credits-edit-publisher').value = game.meta?.publisher || '';
      $('credits-edit-developer').value = game.meta?.developer || '';
      $('credits-edit-release').value = game.meta?.releaseDate || '';
      $('credits-edit-players').value = game.meta?.maxPlayers || '';
      $('credits-edit-coop').checked = game.meta?.coopSupported === true;
      $('credits-edit-genres').value = (game.meta?.genres || []).join(', ');
      $('credits-edit-notes').value = game.notes || '';
      $('credits-priority-override').checked = Array.isArray(game.mediaPriorityOverride);
      $('credits-game-priority').hidden = !Array.isArray(game.mediaPriorityOverride);
      $('credits-priority-help').textContent = Array.isArray(game.mediaPriorityOverride)
        ? 'This game uses the order below.' : `Using global order: ${creditsGlobalPriority.map((kind) => CREDITS_PRIORITY_LABELS[kind].toLowerCase()).join(' → ')}.`;
      $('credits-youtube-add-resolution').value = $('credits-youtube-resolution').value || '720';
      renderCreditsDifficulty();
      renderCreditsPriorities();
      renderCreditsMedia();
      $('credits-edit-sheet').hidden = false;
    } catch (error) {
      toast(error.message || 'Could not open game', 'bad');
    }
  }

  function renderCreditsDifficulty() {
    document.querySelectorAll('[data-difficulty]').forEach((button) => {
      button.classList.toggle('active', button.dataset.difficulty === (creditsDifficulty || ''));
    });
  }

  function renderCreditsMedia() {
    const media = creditsEditGame?.media || [];
    $('credits-media-list').innerHTML = media.length ? media.map((row, index) => {
      return `<div class="credits-media-row" draggable="true" data-media-id="${escapeHtml(row.id)}" data-media-index="${index}">
        <span class="credits-media-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        ${creditsMediaThumbHtml(row)}
        <div class="credits-media-copy"><strong>${escapeHtml(CREDITS_PRIORITY_LABELS[row.kind] || row.kind)}</strong>
          ${escapeHtml(row.source || 'unknown')} · ${escapeHtml(row.status || 'ready')}${row.resolution ? ` · ${row.resolution}p` : ''}
          ${row.statusDetail ? `<br>${escapeHtml(row.statusDetail)}` : ''}</div>
        <div class="credits-media-actions">
          <button type="button" class="credits-mini-btn" data-media-action="up" data-media-index="${index}" aria-label="Move up"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="credits-mini-btn" data-media-action="down" data-media-index="${index}" aria-label="Move down"${index >= media.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="credits-mini-btn" data-media-action="hide" data-media-index="${index}">${row.hidden ? 'Show' : 'Hide'}</button>
          ${row.status === 'failed' ? `<button type="button" class="credits-mini-btn" data-media-action="retry" data-media-index="${index}">Retry</button>` : ''}
          <button type="button" class="credits-mini-btn" data-media-action="delete" data-media-index="${index}">Delete</button>
        </div>
      </div>`;
    }).join('') : '<p class="hint">No media yet. Upload an image or add a YouTube link.</p>';
  }

  function creditsKindsFromMediaOrder(media) {
    const seen = new Set();
    const kinds = [];
    for (const row of media || []) {
      const kind = String(row?.kind || '');
      if (!['video', 'screenshot', 'cover'].includes(kind) || seen.has(kind)) continue;
      seen.add(kind);
      kinds.push(kind);
    }
    for (const kind of ['video', 'screenshot', 'cover']) {
      if (!seen.has(kind)) kinds.push(kind);
    }
    return kinds;
  }

  function syncCreditsPriorityFromMediaList() {
    creditsGamePriority = creditsKindsFromMediaOrder(creditsEditGame?.media);
    const override = $('credits-priority-override');
    if (override) {
      override.checked = true;
      $('credits-game-priority').hidden = false;
      $('credits-priority-help').textContent = `Using this game's order: ${creditsGamePriority.join(' → ')}.`;
    }
    renderCreditsPriorities();
  }

  function moveCreditsMediaRow(fromIndex, toIndex) {
    const media = creditsEditGame?.media || [];
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from === to || from < 0 || to < 0 || from >= media.length || to >= media.length) return false;
    const [row] = media.splice(from, 1);
    media.splice(to, 0, row);
    media.forEach((item, itemIndex) => { item.order = itemIndex; });
    // List order drives this game's kind priority so moving video to the top
    // actually prioritizes video (arrows used to no-op across different kinds).
    syncCreditsPriorityFromMediaList();
    markCreditsEditDirty();
    renderCreditsMedia();
    return true;
  }

  function updateCreditsMedia(action, index) {
    const media = creditsEditGame?.media || [];
    const row = media[index];
    if (!row) return;
    if (action === 'hide') {
      row.hidden = !row.hidden;
      markCreditsEditDirty();
      renderCreditsMedia();
      return;
    }
    if (action === 'up' || action === 'down') {
      moveCreditsMediaRow(index, index + (action === 'up' ? -1 : 1));
      return;
    }
    if (action === 'retry') {
      apiPost(`${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}/media/${encodeURIComponent(row.id)}/retry`, {})
        .then(() => { toast('Media retry queued', 'good'); loadCredits(); })
        .catch((error) => toast(error.message || 'Could not retry media', 'bad'));
      return;
    }
    if (action === 'delete') {
      creditsPendingDelete = { type: 'media', gameId: creditsEditGame.id, mediaId: row.id };
      $('credits-delete-title').textContent = `Delete this ${row.kind}?`;
      $('credits-delete-copy').textContent = 'The stored file is removed too.';
      $('btn-credits-delete-confirm').textContent = 'Delete media';
      $('credits-delete-sheet').hidden = false;
    }
  }

  async function saveCreditsEdit() {
    if (!creditsEditGame) return;
    const originalMeta = creditsEditGame.meta || {};
    const meta = {
      ...originalMeta,
      description: $('credits-edit-description').value.trim(),
      publisher: $('credits-edit-publisher').value.trim(),
      developer: $('credits-edit-developer').value.trim(),
      releaseDate: $('credits-edit-release').value.trim(),
      genres: $('credits-edit-genres').value.split(',').map((item) => item.trim()).filter(Boolean),
      maxPlayers: Number($('credits-edit-players').value) || null,
      coopSupported: $('credits-edit-coop').checked,
      difficulty: creditsDifficulty || null,
    };
    const changedMeta = ['description', 'publisher', 'developer', 'releaseDate', 'genres', 'maxPlayers', 'coopSupported', 'difficulty']
      .filter((key) => JSON.stringify(meta[key]) !== JSON.stringify(originalMeta[key]));
    const patch = {
      title: $('credits-edit-title').value.trim(),
      system: $('credits-edit-system').value,
      beatenAt: $('credits-edit-date-na').checked ? null : $('credits-edit-date').value,
      beatenDateUnknown: $('credits-edit-date-na').checked,
      beatenWith: $('credits-edit-with').value.trim(),
      notes: $('credits-edit-notes').value.trim(),
      meta,
      metaEdited: [...new Set([...(creditsEditGame.metaEdited || []), ...changedMeta])],
      media: (creditsEditGame.media || []).map((row, index) => ({ ...row, order: index })),
      mediaPriorityOverride: $('credits-priority-override').checked ? creditsGamePriority : null,
    };
    $('btn-credits-edit-save').disabled = true;
    try {
      const { game } = await apiFetch(`${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}`, { method: 'PUT', body: patch });
      creditsEditGame = game;
      creditsEditDirty = false;
      $('credits-edit-sheet').hidden = true;
      toast('Game saved', 'good');
      await loadCredits();
    } catch (error) {
      toast(error.message || 'Could not save game', 'bad');
    } finally {
      $('btn-credits-edit-save').disabled = false;
    }
  }

  function openCreditsDelete(ids, game = null) {
    creditsPendingDelete = { type: ids.length === 1 ? 'game' : 'bulk', ids };
    $('credits-delete-title').textContent = ids.length === 1
      ? `Delete ${game?.title || 'this game'}?` : `Delete ${ids.length} games?`;
    $('credits-delete-copy').textContent = ids.length === 1
      ? 'Its photos and video are removed too.' : 'Their photos and videos are removed too.';
    $('btn-credits-delete-confirm').textContent = ids.length === 1 ? 'Delete game' : `Delete ${ids.length} games`;
    $('credits-delete-sheet').hidden = false;
  }

  async function confirmCreditsDelete() {
    const pending = creditsPendingDelete;
    if (!pending) return;
    $('btn-credits-delete-confirm').disabled = true;
    try {
      if (pending.type === 'media') {
        await apiFetch(`${CREDITS_ROUTE}/games/${encodeURIComponent(pending.gameId)}/media/${encodeURIComponent(pending.mediaId)}`, { method: 'DELETE' });
        creditsEditGame.media = (creditsEditGame.media || []).filter((row) => row.id !== pending.mediaId);
        renderCreditsMedia();
        toast('Media deleted', 'good');
      } else if (pending.type === 'game') {
        await apiFetch(`${CREDITS_ROUTE}/games/${encodeURIComponent(pending.ids[0])}`, { method: 'DELETE' });
        $('credits-edit-sheet').hidden = true;
        toast('Game deleted', 'good');
      } else {
        const result = await apiPost(`${CREDITS_ROUTE}/games/bulk-delete`, { ids: pending.ids });
        toast(`${result.deleted?.length || 0} games deleted`, 'good');
        setCreditsSelecting(false);
      }
      $('credits-delete-sheet').hidden = true;
      creditsPendingDelete = null;
      await loadCredits();
    } catch (error) {
      toast(error.message || 'Could not delete', 'bad');
    } finally {
      $('btn-credits-delete-confirm').disabled = false;
    }
  }

  function openCreditsRescrape(ids) {
    if (!ids.length) return;
    creditsRescrapeIds = ids;
    $('credits-rescrape-title').textContent = ids.length === 1 ? 'Re-scrape game' : `Re-scrape ${ids.length} games`;
    $('btn-credits-rescrape-confirm').textContent = ids.length === 1 ? 'Re-scrape game' : `Re-scrape ${ids.length} games`;
    updateCreditsRescrapeCopy();
    $('credits-rescrape-sheet').hidden = false;
  }

  function updateCreditsRescrapeCopy() {
    const mode = document.querySelector('input[name="credits-rescrape-mode"]:checked')?.value;
    const count = creditsRescrapeIds.length;
    const scopes = [...document.querySelectorAll('input[name="credits-scope"]:checked')]
      .map((input) => input.nextElementSibling?.textContent.toLowerCase()).filter(Boolean);
    const subject = scopes.length ? scopes.join(', ') : 'nothing';
    const ending = mode === 'replace-everything'
      ? 'Edited text may be replaced. Uploads are kept.'
      : mode === 'replace-scraped'
        ? 'Uploads and hand-edited text stay untouched.'
        : 'Only missing data is added.';
    $('credits-rescrape-copy').textContent = `Refresh ${subject} for ${count} game${count === 1 ? '' : 's'}. ${ending}`;
  }

  async function confirmCreditsRescrape() {
    const scopes = [...document.querySelectorAll('input[name="credits-scope"]:checked')].map((input) => input.value);
    if (!scopes.length) {
      toast('Choose at least one thing to refresh', 'bad');
      return;
    }
    const mode = document.querySelector('input[name="credits-rescrape-mode"]:checked')?.value || 'fill-gaps';
    const body = { scopes, mode };
    // When re-scraping from the open edit sheet, match against the title/system
    // currently shown — including unsaved edits — not a stale stored provider id.
    if (creditsRescrapeIds.length === 1
      && creditsEditGame
      && creditsRescrapeIds[0] === creditsEditGame.id) {
      const title = $('credits-edit-title')?.value.trim();
      const system = $('credits-edit-system')?.value;
      if (title) body.title = title;
      if (system) body.system = system;
    }
    $('btn-credits-rescrape-confirm').disabled = true;
    try {
      if (creditsRescrapeIds.length === 1) {
        const result = await apiPost(
          `${CREDITS_ROUTE}/games/${encodeURIComponent(creditsRescrapeIds[0])}/rescrape`,
          body,
        );
        if (creditsEditGame && result?.game) {
          creditsEditGame = result.game;
          await openCreditsEdit(creditsEditGame.id);
        }
      } else {
        await apiPost(`${CREDITS_ROUTE}/rescrape-bulk`, { ids: creditsRescrapeIds, ...body });
      }
      $('credits-rescrape-sheet').hidden = true;
      toast(`Re-scrape started for ${creditsRescrapeIds.length} game${creditsRescrapeIds.length === 1 ? '' : 's'}`, 'good');
      await loadCredits();
    } catch (error) {
      toast(error.message || 'Could not re-scrape games', 'bad');
    } finally {
      $('btn-credits-rescrape-confirm').disabled = false;
    }
  }

  function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the selected file'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadCreditsImages(files) {
    if (!creditsEditGame || !files.length) return;
    const kind = $('credits-image-kind').value === 'cover' ? 'cover' : 'screenshot';
    try {
      for (const file of files) {
        const dataUrl = await readFileDataUrl(file);
        const result = await apiPost(`${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}/media`, {
          dataUrl,
          kind,
        });
        creditsEditGame.media = [...(creditsEditGame.media || []), result.media];
      }
      renderCreditsMedia();
      toast(`${files.length} image${files.length === 1 ? '' : 's'} uploaded`, 'good');
      loadCredits();
    } catch (error) {
      toast(error.message || 'Could not upload image', 'bad');
    }
  }

  async function uploadCreditsVideo(file) {
    if (!creditsEditGame || !file) return;
    try {
      const response = await fetch(`${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}/media/video-upload`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'video/mp4' },
        body: file,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Upload failed (${response.status})`);
      creditsEditGame.media = [...(creditsEditGame.media || []), result.media];
      renderCreditsMedia();
      toast('Video uploaded', 'good');
      loadCredits();
    } catch (error) {
      toast(error.message || 'Could not upload video', 'bad');
    }
  }

  async function addCreditsYoutube() {
    if (!creditsEditGame) return;
    const youtubeUrl = $('credits-youtube-url').value.trim();
    if (!youtubeUrl) {
      toast('Paste a YouTube URL first', 'bad');
      return;
    }
    try {
      const result = await apiPost(`${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}/media`, {
        youtubeUrl,
        resolution: Number($('credits-youtube-add-resolution').value),
      });
      creditsEditGame.media = [...(creditsEditGame.media || []), result.media];
      $('credits-youtube-url').value = '';
      renderCreditsMedia();
      toast('YouTube download queued', 'good');
      loadCredits();
    } catch (error) {
      toast(error.message || 'Could not add YouTube video', 'bad');
    }
  }

  function formatCreditsBytes(bytes) {
    let value = Number(bytes) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  async function loadCreditsSettings() {
    if (!$('credits-settings-card')) return;
    try {
      const result = await apiGet(`${CREDITS_ROUTE}/settings`);
      const settings = result.settings || {};
      creditsGlobalPriority = [...(settings.mediaPriority || ['video', 'screenshot', 'cover'])];
      renderCreditsPriorities();
      $('credits-max-screenshots').value = settings.scrape?.maxScreenshots ?? 6;
      $('credits-download-video').checked = settings.scrape?.downloadVideo !== false;
      $('credits-youtube-enabled').checked = settings.youtube?.downloadEnabled !== false;
      $('credits-youtube-resolution').value = String(settings.youtube?.defaultResolution || 720);
      $('credits-seconds-game').value = settings.display?.secondsPerGame ?? 12;
      $('credits-dashboard-seconds').value = settings.display?.dashboardSeconds ?? 25;
      $('credits-display-order').value = settings.display?.order || 'recent';
      $('credits-scheduled-limit').value = settings.display?.scheduledGameLimit ?? 15;
      const credentials = result.credentials || {};
      const source = credentials.source || 'not set';
      pillState($('credits-credentials-pill'), credentials.hasCredentials ? 'ok' : 'warn',
        credentials.hasCredentials ? source : 'not set');
      const envOwned = source === 'env';
      $('credits-client-id').disabled = envOwned;
      $('credits-client-secret').disabled = envOwned;
      $('btn-credits-credentials-save').disabled = envOwned;
      $('credits-settings-status').textContent = envOwned
        ? 'IGDB credentials are set by environment variables. Change them in the bridge environment.'
        : credentials.hasCredentials ? 'IGDB credentials are ready.' : 'Add IGDB credentials to search the full game catalog.';
      const disk = result.diskUsage || {};
      $('credits-disk-usage').textContent = `${formatCreditsBytes(disk.totalBytes)} · ${disk.imageCount || 0} images · ${disk.videoCount || 0} videos`;
      creditsSettingsLoaded = true;
    } catch (error) {
      $('credits-settings-status').textContent = error.message || 'Could not load Roll Credits settings.';
    }
  }

  async function saveCreditsSettings() {
    const body = {
      mediaPriority: creditsGlobalPriority,
      scrape: {
        maxScreenshots: Number($('credits-max-screenshots').value),
        downloadVideo: $('credits-download-video').checked,
      },
      youtube: {
        downloadEnabled: $('credits-youtube-enabled').checked,
        defaultResolution: Number($('credits-youtube-resolution').value),
      },
      display: {
        secondsPerGame: Number($('credits-seconds-game').value),
        dashboardSeconds: Number($('credits-dashboard-seconds').value),
        order: $('credits-display-order').value,
        scheduledGameLimit: Number($('credits-scheduled-limit').value),
      },
    };
    try {
      await apiPost(`${CREDITS_ROUTE}/settings`, body);
      startCreditsEvents();
      toast('Roll Credits settings saved', 'good');
      await loadCreditsSettings();
    } catch (error) {
      toast(error.message || 'Could not save Roll Credits settings', 'bad');
    }
  }

  async function saveCreditsCredentials() {
    const response = await fetch(`${CREDITS_ROUTE}/credentials`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: $('credits-client-id').value.trim(),
        clientSecret: $('credits-client-secret').value,
      }),
    });
    const result = await response.json().catch(() => null);
    if (response.status === 409) {
      $('credits-client-id').disabled = true;
      $('credits-client-secret').disabled = true;
      $('btn-credits-credentials-save').disabled = true;
      $('credits-settings-status').textContent = result?.error
        || 'IGDB credentials are set by environment variables and cannot be changed here.';
      pillState($('credits-credentials-pill'), 'ok', 'env');
      return;
    }
    if (!response.ok) {
      toast(result?.error || 'Could not save IGDB credentials', 'bad');
      return;
    }
    $('credits-client-secret').value = '';
    toast('IGDB credentials saved', 'good');
    startCreditsEvents();
    await loadCreditsSettings();
  }

  async function testCreditsCredentials() {
    $('btn-credits-credentials-test').disabled = true;
    try {
      const result = await apiPost(`${CREDITS_ROUTE}/credentials/test`, {});
      $('credits-settings-status').textContent = result.message || 'IGDB connection works.';
      pillState($('credits-credentials-pill'), 'ok', 'working');
      toast(result.message || 'IGDB connection works', 'good');
    } catch (error) {
      $('credits-settings-status').textContent = error.message || 'IGDB test failed.';
      pillState($('credits-credentials-pill'), 'bad', 'failed');
      toast(error.message || 'IGDB test failed', 'bad');
    } finally {
      $('btn-credits-credentials-test').disabled = false;
    }
  }

  function initCreditsUi() {
    if (creditsReady) return;
    creditsReady = true;
    document.querySelectorAll('[data-credits-view]').forEach((button) => {
      button.addEventListener('click', () => {
        creditsView = button.dataset.creditsView;
        localStorage.setItem(CREDITS_VIEW_KEY, creditsView);
        creditsPage = 1;
        loadCredits();
      });
    });
    const zoomSlider = $('credits-zoom');
    if (zoomSlider) {
      syncCreditsZoomControls();
      zoomSlider.addEventListener('input', () => setCreditsZoom(zoomSlider.value));
    }
    $('btn-credits-zoom-out')?.addEventListener('click', () => setCreditsZoom(creditsGridColumns() + 1));
    $('btn-credits-zoom-in')?.addEventListener('click', () => setCreditsZoom(creditsGridColumns() - 1));
    window.addEventListener('resize', () => {
      clearTimeout(creditsResizeTimer);
      creditsResizeTimer = setTimeout(() => {
        if (!creditsReady || creditsView !== 'grid') {
          syncCreditsZoomControls();
          return;
        }
        renderCreditsGrid();
      }, 120);
    });
    $('btn-credits-add')?.addEventListener('click', openCreditsAdd);
    $('btn-credits-empty-add')?.addEventListener('click', openCreditsAdd);
    $('btn-credits-refresh')?.addEventListener('click', () => loadCredits());
    $('btn-credits-select')?.addEventListener('click', () => setCreditsSelecting(true));
    $('btn-credits-cancel-select')?.addEventListener('click', () => setCreditsSelecting(false));
    $('btn-credits-select-all')?.addEventListener('click', () => {
      const allSelected = creditsGames.length && creditsGames.every((game) => creditsSelected.has(game.id));
      creditsGames.forEach((game) => { if (allSelected) creditsSelected.delete(game.id); else creditsSelected.add(game.id); });
      renderCredits();
    });
    $('btn-credits-delete-selected')?.addEventListener('click', () => openCreditsDelete([...creditsSelected]));
    $('btn-credits-rescrape-selected')?.addEventListener('click', () => openCreditsRescrape([...creditsSelected]));
    const openOrSelectCredit = (event) => {
      const step = event.target.closest('[data-credits-move]');
      if (step) {
        if (!step.classList.contains('is-disabled')) {
          moveCreditsGame(Number(step.dataset.creditsMoveIndex), Number(step.dataset.creditsMove));
        }
        return;
      }
      const host = event.target.closest('[data-credits-id]');
      if (!host) return;
      if (creditsReordering) return;
      if (creditsSelecting) toggleCreditSelected(host.dataset.creditsId);
      else openCreditsEdit(host.dataset.creditsId);
    };
    $('credits-grid')?.addEventListener('click', openOrSelectCredit);
    $('credits-table-body')?.addEventListener('click', openOrSelectCredit);
    for (const hostId of ['credits-grid', 'credits-table-body']) {
      const host = $(hostId);
      if (!host) continue;
      host.addEventListener('dragstart', (event) => {
        const item = event.target.closest('[data-credits-id]');
        if (!item || !creditsReordering) return;
        creditsDragId = item.dataset.creditsId;
        item.classList.add('is-dragging');
        try {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', creditsDragId);
        } catch {
          // Older WebViews reject setData; the drag still works locally.
        }
      });
      host.addEventListener('dragover', (event) => {
        if (!creditsDragId) return;
        const item = event.target.closest('[data-credits-id]');
        if (!item) return;
        event.preventDefault();
        try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
        host.querySelectorAll('.is-drop-target').forEach((el) => {
          if (el !== item) el.classList.remove('is-drop-target');
        });
        item.classList.add('is-drop-target');
      });
      host.addEventListener('dragleave', (event) => {
        const item = event.target.closest('[data-credits-id]');
        if (item && !item.contains(event.relatedTarget)) item.classList.remove('is-drop-target');
      });
      host.addEventListener('dragend', () => {
        host.querySelectorAll('.is-dragging, .is-drop-target').forEach((el) => {
          el.classList.remove('is-dragging', 'is-drop-target');
        });
        creditsDragId = null;
      });
      host.addEventListener('drop', (event) => {
        const item = event.target.closest('[data-credits-id]');
        if (!item || !creditsDragId) return;
        event.preventDefault();
        const fromId = creditsDragId;
        creditsDragId = null;
        item.classList.remove('is-drop-target');
        dropCreditsGame(fromId, item.dataset.creditsId);
      });
    }
    $('credits-sort-select')?.addEventListener('change', (event) => {
      const [column, dir] = String(event.target.value || '').split(':');
      if (!column) return;
      creditsSort = column;
      creditsDir = dir === 'asc' ? 'asc' : 'desc';
      if (creditsReordering && !creditsCanReorder()) creditsReordering = false;
      creditsPage = 1;
      loadCredits();
    });
    $('btn-credits-reorder')?.addEventListener('click', () => setCreditsReordering(!creditsReordering));
    $('btn-credits-reorder-done')?.addEventListener('click', () => setCreditsReordering(false));
    $('btn-credits-reorder-reset')?.addEventListener('click', resetCreditsOrder);
    $('credits-q')?.addEventListener('input', () => {
      clearTimeout(creditsSearchTimer);
      creditsSearchTimer = setTimeout(() => { creditsPage = 1; loadCredits(); }, 250);
    });
    $('btn-credits-filters-toggle')?.addEventListener('click', () => {
      creditsFiltersOpen = !creditsFiltersOpen;
      syncCreditsFiltersChrome();
    });
    $('btn-credits-clear-filters')?.addEventListener('click', () => {
      clearCreditsPanelFilters();
    });
    $('credits-year')?.addEventListener('change', () => {
      syncCreditsFiltersChrome();
      creditsPage = 1;
      loadCredits();
    });
    $('credits-no-date')?.addEventListener('change', () => {
      syncCreditsFiltersChrome();
      creditsPage = 1;
      loadCredits();
    });
    $('credits-system-filters')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-credits-system]');
      if (!button) return;
      const id = button.dataset.creditsSystem;
      if (creditsSelectedSystems.has(id)) creditsSelectedSystems.delete(id);
      else creditsSelectedSystems.add(id);
      renderCreditsSystemFilters();
      creditsPage = 1;
      loadCredits();
    });
    document.querySelectorAll('[data-credits-sort]').forEach((button) => button.addEventListener('click', () => {
      if (creditsSort === button.dataset.creditsSort) creditsDir = creditsDir === 'asc' ? 'desc' : 'asc';
      else {
        creditsSort = button.dataset.creditsSort;
        creditsDir = 'asc';
      }
      if (creditsReordering && !creditsCanReorder()) creditsReordering = false;
      creditsPage = 1;
      loadCredits();
    }));
    $('btn-credits-prev')?.addEventListener('click', () => { creditsPage -= 1; loadCredits(); });
    $('btn-credits-next')?.addEventListener('click', () => { creditsPage += 1; loadCredits(); });
    document.querySelectorAll('[data-close-credits-sheet]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.closeCreditsSheet === 'credits-edit-sheet' && creditsEditDirty) {
          toast('Save the game before closing, or reload it to discard changes', 'bad');
          return;
        }
        $(button.dataset.closeCreditsSheet).hidden = true;
      });
    });
    $('btn-credits-add-search')?.addEventListener('click', searchCreditsCandidates);
    $('credits-add-search')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') searchCreditsCandidates();
    });
    $('credits-candidates')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-candidate-system]');
      if (button) chooseCreditsCandidate(Number(button.dataset.candidateIndex), button.dataset.candidateSystem, button);
    });
    $('btn-credits-manual')?.addEventListener('click', () => {
      creditsCandidate = null;
      $('credits-add-title').value = $('credits-add-search').value.trim();
      revealCreditsAddFields();
      $('credits-candidates').innerHTML = '';
    });
    $('credits-add-date')?.addEventListener('change', () => {
      if (creditsIsDateOnly($('credits-add-date').value)) {
        creditsAddBeatenAt = $('credits-add-date').value;
      }
    });
    $('credits-add-date')?.addEventListener('input', () => {
      if (creditsIsDateOnly($('credits-add-date').value)) {
        creditsAddBeatenAt = $('credits-add-date').value;
      }
    });
    $('credits-add-date-na')?.addEventListener('change', () => {
      $('credits-add-date').disabled = $('credits-add-date-na').checked;
    });
    $('btn-credits-create')?.addEventListener('click', createCreditGame);
    $('credits-edit-date-na')?.addEventListener('change', () => {
      $('credits-edit-date').disabled = $('credits-edit-date-na').checked;
      markCreditsEditDirty();
    });
    $('credits-edit-sheet')?.addEventListener('input', markCreditsEditDirty);
    $('credits-difficulty')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-difficulty]');
      if (!button) return;
      creditsDifficulty = button.dataset.difficulty || null;
      markCreditsEditDirty();
      renderCreditsDifficulty();
    });
    $('credits-priority-override')?.addEventListener('change', () => {
      $('credits-game-priority').hidden = !$('credits-priority-override').checked;
      markCreditsEditDirty();
    });
    document.addEventListener('click', (event) => {
      const priority = event.target.closest('[data-priority-move]');
      if (priority) moveCreditsPriority(priority.dataset.priorityScope, Number(priority.dataset.priorityIndex), Number(priority.dataset.priorityMove));
    });
    $('credits-media-list')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-media-action]');
      if (button) updateCreditsMedia(button.dataset.mediaAction, Number(button.dataset.mediaIndex));
    });
    const creditsMediaList = $('credits-media-list');
    creditsMediaList?.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.credits-media-row');
      if (!row || !creditsMediaList.contains(row)) return;
      if (event.target.closest('button, a, input, select, label')) {
        event.preventDefault();
        return;
      }
      creditsMediaDragIndex = Number(row.dataset.mediaIndex);
      row.classList.add('is-dragging');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.dataset.mediaId || String(creditsMediaDragIndex));
      } catch {
        // Older WebViews sometimes reject setData; drag can still proceed.
      }
    });
    creditsMediaList?.addEventListener('dragend', () => {
      creditsMediaList.querySelectorAll('.credits-media-row').forEach((row) => {
        row.classList.remove('is-dragging', 'is-drop-target');
      });
      creditsMediaDragIndex = null;
    });
    creditsMediaList?.addEventListener('dragover', (event) => {
      const row = event.target.closest('.credits-media-row');
      if (!row || creditsMediaDragIndex == null) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
      creditsMediaList.querySelectorAll('.credits-media-row.is-drop-target').forEach((el) => {
        if (el !== row) el.classList.remove('is-drop-target');
      });
      row.classList.add('is-drop-target');
    });
    creditsMediaList?.addEventListener('dragleave', (event) => {
      const row = event.target.closest('.credits-media-row');
      if (row && !row.contains(event.relatedTarget)) row.classList.remove('is-drop-target');
    });
    creditsMediaList?.addEventListener('drop', (event) => {
      const row = event.target.closest('.credits-media-row');
      if (!row || creditsMediaDragIndex == null) return;
      event.preventDefault();
      const toIndex = Number(row.dataset.mediaIndex);
      const fromIndex = creditsMediaDragIndex;
      creditsMediaDragIndex = null;
      row.classList.remove('is-drop-target');
      moveCreditsMediaRow(fromIndex, toIndex);
    });
    $('credits-image-upload')?.addEventListener('change', (event) => {
      uploadCreditsImages([...event.target.files]);
      event.target.value = '';
    });
    $('credits-video-upload')?.addEventListener('change', (event) => {
      uploadCreditsVideo(event.target.files[0]);
      event.target.value = '';
    });
    $('btn-credits-youtube-add')?.addEventListener('click', addCreditsYoutube);
    $('btn-credits-edit-save')?.addEventListener('click', saveCreditsEdit);
    $('btn-credits-edit-delete')?.addEventListener('click', () => {
      if (creditsEditGame) openCreditsDelete([creditsEditGame.id], creditsEditGame);
    });
    $('btn-credits-edit-rescrape')?.addEventListener('click', () => {
      if (creditsEditGame) openCreditsRescrape([creditsEditGame.id]);
    });
    $('btn-credits-delete-cancel')?.addEventListener('click', () => {
      $('credits-delete-sheet').hidden = true;
      creditsPendingDelete = null;
    });
    $('btn-credits-delete-confirm')?.addEventListener('click', confirmCreditsDelete);
    $('btn-credits-rescrape-cancel')?.addEventListener('click', () => { $('credits-rescrape-sheet').hidden = true; });
    $('btn-credits-rescrape-confirm')?.addEventListener('click', confirmCreditsRescrape);
    document.querySelectorAll('input[name="credits-scope"], input[name="credits-rescrape-mode"]')
      .forEach((input) => input.addEventListener('change', updateCreditsRescrapeCopy));
    $('btn-credits-settings-save')?.addEventListener('click', saveCreditsSettings);
    $('btn-credits-credentials-save')?.addEventListener('click', saveCreditsCredentials);
    $('btn-credits-credentials-test')?.addEventListener('click', testCreditsCredentials);
    $('btn-credits-prune')?.addEventListener('click', async () => {
      const btn = $('btn-credits-prune');
      if (btn) btn.disabled = true;
      try {
        const result = await apiPost(`${CREDITS_ROUTE}/prune-orphans`, {});
        const removed = Number(result.removed || result.pruned || result.count || 0);
        toast(removed ? `Removed ${removed} orphaned media folder${removed === 1 ? '' : 's'}` : 'No orphaned media found', 'good');
        await loadCreditsSettings();
      } catch (error) {
        toast(error.message || 'Could not prune orphaned files', 'bad');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    loadCreditsSystems().then(() => {
      renderCreditsYears();
      loadCredits();
    }).catch((error) => creditsSetError(error));
    renderCredits();
    if (!creditsSettingsLoaded) loadCreditsSettings();
  }

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
