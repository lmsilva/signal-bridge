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

  // ------------------------------------------------------------ Tesla push

  async function pushTesla(kind, button) {
    button.classList.add('busy');
    try {
      await apiPost(`/api/push/tesla-${kind}`, withTarget());
      toast(`Tesla ${kind} sent`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      setTimeout(() => button.classList.remove('busy'), 900);
    }
  }

  $('btn-tesla-dashboard').addEventListener('click', (e) => pushTesla('dashboard', e.currentTarget));
  $('btn-tesla-battery').addEventListener('click', (e) => pushTesla('battery', e.currentTarget));

  // ------------------------------------------------------- Quick push tiles

  async function pushSimple(route, label, button) {
    button.classList.add('busy');
    try {
      await apiPost(route, withTarget());
      toast(`${label} sent`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      setTimeout(() => button.classList.remove('busy'), 900);
    }
  }

  $('btn-push-weather')?.addEventListener('click', (e) => pushSimple('/api/push/weather', 'Weather forecast', e.currentTarget));
  $('btn-push-shopping-list')?.addEventListener('click', (e) => pushSimple('/api/push/shopping-list', 'Shopping list', e.currentTarget));
  $('btn-push-timers')?.addEventListener('click', (e) => pushSimple('/api/push/timers', 'Active timers', e.currentTarget));
  $('btn-push-guest-snaps')?.addEventListener('click', (e) => pushSimple('/api/push/guest-photobooth', 'Guest Snaps', e.currentTarget));
  $('btn-push-air-quality')?.addEventListener('click', (e) => pushSimple('/api/push/air-quality', 'Indoor air quality', e.currentTarget));
  $('btn-push-now-playing')?.addEventListener('click', (e) => pushSimple('/api/push/now-playing', 'Now playing', e.currentTarget));
  $('btn-push-alarms')?.addEventListener('click', (e) => pushSimple('/api/push/alarms', 'Alarms', e.currentTarget));

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

  $('btn-push-photo-slideshow')?.addEventListener('click', async (e) => {
    // "uploaded photo" opens the guest booth in a new tab (same as login page).
    if (e.target.closest('[data-booth-link]')) {
      e.preventDefault();
      openGuestPhotoBooth();
      return;
    }
    const button = e.currentTarget;
    button.classList.add('busy');
    try {
      const { photos } = await apiGet('/api/photos');
      if (!photos || !photos.length) {
        toast('No shared photos yet — share one via QR Code → Photo first', 'bad');
        return;
      }
      const entries = photosToSlideshowEntries(photos);
      await apiPost('/api/push/photo-slideshow', withTarget({ photos: entries }));
      toast(`Slideshow sent (${entries.length} photo${entries.length === 1 ? '' : 's'})`, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      setTimeout(() => button.classList.remove('busy'), 900);
    }
  });

  // Keyboard activation for the inline booth link (role=link inside the tile).
  $('btn-push-photo-slideshow')?.querySelector('[data-booth-link]')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') {
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

  refreshDisplays({ quiet: true });
  startDisplayEvents();
  startPolling();
  applySteamReturnTab();
  // Fallback poll if EventSource is blocked or drops (SSE is primary).
  setInterval(() => refreshDisplays({ quiet: true }), 60000);
})();
