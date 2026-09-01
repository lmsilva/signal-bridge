/* Signal Bridge — control page logic (vanilla JS, no framework) */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Declared up here, not beside the poller, so `startPolling()` can run from
  // the bootstrap below without tripping over a temporal dead zone.
  const POLL_MS = 5000;
  let statusTimer = null;
  let lastStatus = null;

  // ------------------------------------------- Modal / sheet dismiss (Escape + backdrop)
  const sheetDismissRegistry = new Map();

  function registerSheetDismiss(id, handler) {
    sheetDismissRegistry.set(id, handler);
  }

  function topVisibleSheet() {
    const sheets = [...document.querySelectorAll('.sheet-backdrop')].filter((el) => !el.hidden);
    return sheets.length ? sheets[sheets.length - 1] : null;
  }

  function dismissSheet(sheetEl) {
    if (!sheetEl) return;
    const handler = sheetDismissRegistry.get(sheetEl.id);
    if (handler) {
      handler(sheetEl);
      return;
    }
    sheetEl.hidden = true;
  }

  function initSheetDismiss() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const top = topVisibleSheet();
      if (!top) return;
      event.preventDefault();
      dismissSheet(top);
    }, true);

    document.querySelectorAll('.sheet-backdrop').forEach((sheet) => {
      sheet.addEventListener('click', (event) => {
        if (event.target !== sheet) return;
        dismissSheet(sheet);
      });
    });
  }

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
      err.data = data;
      throw err;
    }
    return data || {};
  }

  async function apiGet(route, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 0;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : 0;
    try {
      const response = await fetch(appUrl(route), {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller?.signal,
      });
      if (response.status === 401) {
        redirectToAdminLogin();
        throw new Error('Admin login required');
      }
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      return response.json();
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  // ------------------------------------------------- Critical chrome boot

  // Everything past this point is panel wiring — thousands of lines of it —
  // and one throw anywhere in it used to strand the whole page: header stuck
  // on "connecting…", Push grid stuck on skeletons, Log out button dead. The
  // three things the admin is unusable without are booted here instead, each
  // guarded on its own, and the boot is queued as a macrotask so it still runs
  // after a synchronous failure further down this file.

  function guard(what, fn) {
    try {
      return fn();
    } catch (error) {
      console.error(`admin: ${what} failed`, error);
      reportBootFailure(`${what}: ${error?.message || error}`);
      return undefined;
    }
  }

  let bootFailureShown = false;
  // Closed on the last line of this file. While it is open an escaping error
  // means the page is half-built; after that, errors are ordinary runtime
  // problems that the toasts already report.
  let bootWindowOpen = true;

  /**
   * A silent white screen is the one failure mode we cannot debug from a
   * screenshot, so anything that escapes gets said out loud.
   */
  function reportBootFailure(detail) {
    if (bootFailureShown || !bootWindowOpen) return;
    bootFailureShown = true;
    try {
      const banner = document.createElement('div');
      banner.className = 'boot-error';
      banner.setAttribute('role', 'alert');
      banner.textContent = `Part of the admin failed to start — ${detail}`;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'boot-error-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => banner.remove());
      banner.appendChild(close);
      document.body.appendChild(banner);
    } catch {
      // Nothing left to do — the console message above is the record.
    }
  }

  window.addEventListener('error', (event) => {
    reportBootFailure(event?.message || 'script error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportBootFailure(event?.reason?.message || 'request failed');
  });

  /**
   * Push tiles are static data (title, icon, category), so the bridge inlines
   * the catalog into the page instead of making the grid wait on
   * `/api/commands` — that endpoint probes every provider for readiness and
   * was routinely the slowest thing on the page.
   */
  function inlinePushCommands() {
    const node = document.getElementById('push-catalog');
    if (!node) return null;
    try {
      const parsed = JSON.parse(node.textContent || 'null');
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch {
      return null;
    }
  }

  let chromeBooted = false;

  function bootAdminChrome() {
    if (chromeBooted) return;
    chromeBooted = true;
    guard('status poll', () => startPolling());
    const catalog = guard('push catalog', () => inlinePushCommands());
    if (catalog) {
      guard('push grid', () => renderPushGrid(catalog));
    } else {
      // Older shell, or the catalog never got substituted — fall back.
      guard('push grid', () => loadPushGrid());
    }
  }

  // Bound here rather than with the rest of the session code near the bottom:
  // being unable to sign out of a half-loaded page is its own trap.
  $('btn-admin-logout')?.addEventListener('click', async () => {
    guard('logout cleanup', () => {
      uiStorageRemove(SETTINGS_VIEW_KEY);
      uiStorageRemove(SETTINGS_SEARCH_KEY);
      uiStorageRemove(PUSH_VIEW_LEGACY_KEY);
      pushViewSession = PUSH_VIEW_ORDER[0];
    });
    try {
      await apiPost('/api/admin/logout', {});
    } catch {
      // still leave the UI even if the network call failed
    }
    location.href = '/admin/login.html';
  });

  // Queued, not called: this has to survive a throw in the wiring below.
  window.setTimeout(bootAdminChrome, 0);

  function selectedTargetId() {
    const value = $('display-select')?.value;
    return value || ALL_DISPLAYS;
  }

  function selectedDisplayEntry() {
    const id = selectedTargetId();
    if (!id || id === ALL_DISPLAYS) {
      return null;
    }
    return knownDisplays.find((d) => d.id === id) || null;
  }

  function selectedDisplayKind() {
    return selectedDisplayEntry()?.kind || null;
  }

  function isSingleDisplaySelected() {
    const id = selectedTargetId();
    return Boolean(id) && id !== ALL_DISPLAYS;
  }

  /** Remote control (mouse, keys, power) only exists on the Windows overlay. */
  function isFullDisplaySelected() {
    const entry = selectedDisplayEntry();
    return Boolean(entry) && entry.kind !== 'vestaboard';
  }

  function vestaboardHealthSuffix(health) {
    switch (health) {
      case 'degraded':
        return 'key refused';
      case 'unhealthy':
        return 'not answering';
      case 'offline':
        return 'off';
      default:
        return null;
    }
  }

  function displayOptionLabel(d) {
    const label = d.label || d.name;
    if (d.kind === 'vestaboard') {
      const suffix = vestaboardHealthSuffix(d.health);
      return suffix ? `${label} (${suffix})` : label;
    }
    return d.stale ? `${label} (offline?)` : label;
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
    const single = isFullDisplaySelected();
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
    const single = isFullDisplaySelected();
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
    } else if (selectedDisplayKind() === 'vestaboard') {
      hint.textContent = 'Vestaboard — board-capable pushes go to every enabled board.';
    } else if (single) {
      const entry = selectedDisplayEntry();
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
      .map((d) => `${d.id}|${d.name}|${d.host || ''}|${d.stale ? 1 : 0}|${d.lastSeen || ''}|${d.kind || ''}|${d.health || ''}`)
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

  /** All Displays first; Vestaboard Simulator next when listed; then A–Z. */
  function sortDisplayPickerEntries(entries) {
    return [...entries].sort((a, b) => {
      const aSim = a.simulator ? 0 : 1;
      const bSim = b.simulator ? 0 : 1;
      if (aSim !== bSim) return aSim - bSim;
      return String(a.label || a.name || '').localeCompare(
        String(b.label || b.name || ''),
        undefined,
        { sensitivity: 'base' },
      );
    });
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

    // Keep the in-session choice if it is still valid; otherwise land on All
    // Displays. Do not restore the last page-load target from localStorage —
    // All Displays is the intentional default.
    const previous = select.value || '';
    select.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = ALL_DISPLAYS;
    allOpt.textContent = 'All Displays';
    select.appendChild(allOpt);

    for (const d of sortDisplayPickerEntries(knownDisplays)) {
      const opt = document.createElement('option');
      opt.value = d.id; // always unique — never target by friendly name
      opt.textContent = displayOptionLabel(d);
      select.appendChild(opt);
    }

    const ids = new Set(knownDisplays.map((d) => d.id));
    const added = knownDisplays.filter((d) => !previousIds.has(d.id));
    if (previous && previous !== ALL_DISPLAYS && ids.has(previous)) {
      select.value = previous;
    } else {
      select.value = ALL_DISPLAYS;
    }
    localStorage.setItem(STORAGE_TARGET_KEY, select.value);
    updateControlTabVisibility();
    renderPushGrid();
    if (typeof renderSchedRules === 'function') {
      renderSchedRules();
    }

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
    renderPushGrid();
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

  // Push / Settings / Scheduler are long pages. Remember where the admin
  // was so a hop to another tab and back does not yank them to the top.
  const tabScrollY = Object.create(null);

  function currentPageScroll() {
    return window.scrollY || pageScrollEl().scrollTop || 0;
  }

  function currentSchedView() {
    const active = document.querySelector('#sched-view-tabs .segmented-btn.active');
    return active?.dataset?.schedView || 'schedule';
  }

  function rememberTabScroll(tab, view) {
    if (!tab) return;
    const y = currentPageScroll();
    tabScrollY[tab] = y;
    if (view) tabScrollY[`${tab}:${view}`] = y;
  }

  function restoreTabScroll(tab, view, { top = false } = {}) {
    const key = !top && view ? `${tab}:${view}` : tab;
    const y = top ? 0 : Math.max(0, Number(tabScrollY[key] ?? tabScrollY[tab] ?? 0) || 0);
    const apply = () => {
      window.scrollTo(0, y);
      pageScrollEl().scrollTop = y;
    };
    apply();
    requestAnimationFrame(apply);
  }

  function activateTab(tabId, { scroll = 'restore' } = {}) {
    // Lets a tab widen the content column — the Vestaboard needs more room
    // than a stack of settings cards.
    const previousTab = document.body.dataset.tab || '';
    const switching = previousTab !== tabId;
    if (switching && previousTab) {
      if (previousTab === 'settings' && typeof currentSettingsView === 'function') {
        rememberTabScroll('settings', currentSettingsView());
      } else if (previousTab === 'push' && typeof pushViewSession !== 'undefined') {
        rememberTabScroll('push', pushViewSession);
      } else if (previousTab === 'scheduler') {
        rememberTabScroll('scheduler', currentSchedView());
      } else {
        rememberTabScroll(previousTab);
      }
    }
    document.body.dataset.tab = tabId;
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
    updateControlLockUi();
    if (previousTab === 'board' && tabId !== 'board'
      && typeof vbOnBoardTabLeave === 'function') {
      vbOnBoardTabLeave();
    }
    if (tabId === 'credits') {
      initCreditsUi();
      startCreditsEvents();
      loadCredits();
    } else if (tabId === 'settings') {
      initCreditsUi();
      loadCreditsSettings();
      loadFlightplanSettings();
      // The boot-time filter runs while this panel is `display: none`.
      // Chrome then forgets [hidden] on the grid children, so Global
      // paints News/Media cards until a later pane click re-applies it.
      applySettingsFilter(currentSettingsView());
    } else if (tabId === 'board') {
      // Unlock audio on the gesture that opened the tab — never play a
      // sample cascade here. Hearing the flip without seeing flaps is worse
      // than a quiet first visit (Sound on still demos the sample).
      if (typeof vbUnlockAudio === 'function') vbUnlockAudio();
      if (typeof vbOnBoardTabEnter === 'function') vbOnBoardTabEnter();
      loadVestaboardSim().then(() => startVestaboardSimEvents());
    } else if (tabId === 'flightplan') {
      loadFlightplanTrips({ force: false });
    }
    if (typeof updateStickyOffsets === 'function') updateStickyOffsets();
    if (switching) {
      if (tabId === 'settings' && typeof currentSettingsView === 'function') {
        restoreTabScroll('settings', currentSettingsView(), { top: scroll === 'top' });
      } else if (tabId === 'push') {
        restoreTabScroll('push', pushViewSession, { top: scroll === 'top' });
      } else if (tabId === 'scheduler') {
        restoreTabScroll('scheduler', currentSchedView(), { top: scroll === 'top' });
      } else {
        restoreTabScroll(tabId, null, { top: scroll === 'top' });
      }
    }
    if (typeof updatePageJump === 'function') updatePageJump();
    if (typeof updateSchedSetupCompact === 'function') updateSchedSetupCompact();
  }

  // Sticky tab heads sit under the measured sticky chrome (header + display).
  function updateStickyOffsets() {
    const chrome = document.querySelector('.sticky-chrome');
    const schedHead = $('sched-head');
    document.documentElement.style.setProperty(
      '--sticky-chrome-h',
      `${chrome?.offsetHeight || 0}px`,
    );
    document.documentElement.style.setProperty(
      '--sched-head-h',
      `${schedHead && !schedHead.closest('.tab-panel')?.hidden ? schedHead.offsetHeight : 0}px`,
    );
  }

  function pageScrollEl() {
    return document.scrollingElement || document.documentElement;
  }

  function updatePageJump() {
    const wrap = $('page-jump');
    const topBtn = $('btn-jump-top');
    const bottomBtn = $('btn-jump-bottom');
    if (!wrap || !topBtn || !bottomBtn) return;
    const tab = document.body.dataset.tab || '';
    const longTabs = new Set(['push', 'settings', 'scheduler']);
    const scroller = pageScrollEl();
    const maxScroll = Math.max(0, scroller.scrollHeight - window.innerHeight);
    const y = window.scrollY || scroller.scrollTop || 0;
    const show = longTabs.has(tab) && maxScroll > 160;
    wrap.hidden = !show;
    if (!show) return;
    topBtn.disabled = y < 48;
    bottomBtn.disabled = y > maxScroll - 48;
  }

  function updateSchedSetupCompact() {
    const card = $('sched-setup-card');
    const scheduleView = $('sched-view-schedule');
    if (!card) return;
    const onSchedule = document.body.dataset.tab === 'scheduler'
      && scheduleView
      && !scheduleView.hidden;
    if (!onSchedule) {
      card.classList.remove('is-compact');
      return;
    }
    // Hiding the Add row shrinks the sticky card. Without hysteresis that
    // height change pulls scrollY back under the enter threshold, which
    // expands the card again — and the page jumps to the top in a loop.
    const y = window.scrollY || pageScrollEl().scrollTop || 0;
    const compact = card.classList.contains('is-compact');
    const enterAt = 72;
    const leaveAt = 16;
    card.classList.toggle('is-compact', compact ? y > leaveAt : y > enterAt);
  }

  window.addEventListener('resize', () => {
    updateStickyOffsets();
    updatePageJump();
  }, { passive: true });
  window.addEventListener('scroll', () => {
    updatePageJump();
    updateSchedSetupCompact();
  }, { passive: true });

  $('btn-jump-top')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('btn-jump-bottom')?.addEventListener('click', () => {
    const scroller = pageScrollEl();
    window.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  });
  updatePageJump();

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab);
    });
  });

  // Logo / title → Push landing pane from any tab.
  $('btn-app-home')?.addEventListener('click', () => {
    activateTab('push', { scroll: 'top' });
    showPushView('home');
  });

  // Initial state: only the default active panel should be un-hidden.
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = !panel.classList.contains('active');
  });
  document.body.dataset.tab = document.querySelector('.tab-btn.active')?.dataset?.tab || 'push';
  updateStickyOffsets();
  updatePageJump();
  updateSchedSetupCompact();

  // ------------------------------------------------ Pane search (shared)

  // Settings and Push are both long pages behind a sub-nav, and both filter
  // their panes from one search box, so the plumbing lives here once.

  function uiStorageGet(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function uiStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode / quota — in-memory behaviour still works for this visit.
    }
  }

  function uiStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  function normalizeSearchQuery(value) {
    return (globalThis.SignalSettingsFilter || {
      normalizeSearchQuery: (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' '),
    }).normalizeSearchQuery(value);
  }

  /**
   * Titles, labels, button copy, placeholders — anything a user might type.
   * `data-search-terms` carries words the element never actually prints, so a
   * push tile can answer to its command id and service name too.
   */
  function searchHaystack(el) {
    const bits = [(el.textContent || ''), (el.dataset?.searchTerms || '')];
    el.querySelectorAll('input[placeholder], textarea[placeholder]').forEach((node) => {
      bits.push(node.getAttribute('placeholder') || '');
    });
    el.querySelectorAll('option').forEach((node) => {
      bits.push(node.textContent || '');
    });
    return bits.join(' ').toLowerCase().replace(/\s+/g, ' ');
  }

  function matchesSearch(el, query, extra = '') {
    if (!query) return true;
    const haystack = `${searchHaystack(el)} ${String(extra).toLowerCase()}`;
    const filter = globalThis.SignalSettingsFilter;
    if (filter?.matchesSearchQuery) return filter.matchesSearchQuery(haystack, query);
    return query.split(' ').every((term) => term && haystack.includes(term));
  }

  // Catalog filter shared by Push + Settings: which display *type* the listed
  // operations apply to. Independent of the header target picker (which still
  // decides where a push is sent).
  const KIND_FILTER_KEY = 'signal.displayKindFilter';
  const KIND_FILTER_ORDER = ['all', 'vestaboard', 'full'];
  const KIND_FILTERS = new Set(KIND_FILTER_ORDER);

  /** Settings cards → which surfaces they configure. Default is both. */
  const SETTINGS_CARD_KINDS = Object.freeze({
    'locale-settings-card': ['full', 'vestaboard'],
    'public-url-settings-card': ['full', 'vestaboard'],
    'tinyurl-settings-card': ['full', 'vestaboard'],
    'guest-snaps-settings-card': ['full', 'vestaboard'],
    'guest-book-settings-card': ['vestaboard'],
    'ring-doorbell-settings-card': ['vestaboard'],
    'weather-alerts-settings-card': ['vestaboard'],
    'world-population-settings-card': ['vestaboard'],
    'calendar-clock-settings-card': ['vestaboard'],
    'word-clock-settings-card': ['vestaboard'],
    'red-letter-settings-card': ['vestaboard'],
    'youtube-settings-card': ['full'],
    'upside-news-settings-card': ['full', 'vestaboard'],
    'learn-japanese-settings-card': ['vestaboard'],
    'learn-portuguese-settings-card': ['vestaboard'],
    'learn-spanish-settings-card': ['vestaboard'],
    'learn-french-settings-card': ['vestaboard'],
    'learn-german-settings-card': ['vestaboard'],
    'learn-italian-settings-card': ['vestaboard'],
    'chuck-norris-settings-card': ['vestaboard'],
    'roast-me-settings-card': ['vestaboard'],
    'family-quotes-settings-card': ['vestaboard'],
    'warm-fuzzies-settings-card': ['vestaboard'],
    'daily-bucket-fillers-settings-card': ['vestaboard'],
    'misheard-lyrics-settings-card': ['vestaboard'],
    'periodic-table-settings-card': ['vestaboard'],
    'us-state-facts-settings-card': ['vestaboard'],
    'word-of-the-day-settings-card': ['vestaboard'],
    'dad-jokes-settings-card': ['vestaboard'],
    'us-weather-map-settings-card': ['vestaboard'],
    'amazing-facts-settings-card': ['vestaboard'],
    'world-geography-facts-settings-card': ['vestaboard'],
    'conversation-starters-settings-card': ['vestaboard'],
    'stoic-quotes-settings-card': ['vestaboard'],
    'on-this-day-settings-card': ['vestaboard'],
    'baking-inspiration-settings-card': ['vestaboard'],
    'stock-market-settings-card': ['vestaboard'],
    'currency-rates-settings-card': ['vestaboard'],
    'plex-top10-settings-card': ['vestaboard'],
    'wiki-ck-settings-card': ['full', 'vestaboard'],
    'starlink-tracker-settings-card': ['vestaboard'],
    'space-launch-alerts-settings-card': ['vestaboard'],
    'iss-tracker-settings-card': ['vestaboard'],
    'overhead-settings-card': ['full', 'vestaboard'],
    'flightplan-settings-card': ['full', 'vestaboard'],
    'autodarts-settings-card': ['full', 'vestaboard'],
    'huupe-settings-card': ['full', 'vestaboard'],
    'trivia-settings-card': ['full', 'vestaboard'],
    'word-scramble-settings-card': ['vestaboard'],
    'word-riddles-settings-card': ['vestaboard'],
    'plex-settings-card': ['vestaboard'],
    'credits-settings-card': ['full', 'vestaboard'],
    'vb-settings-card': ['vestaboard'],
  });

  function parseKindList(value) {
    return String(value || '')
      .split(/[\s,|]+/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part === 'full' || part === 'vestaboard');
  }

  function currentKindFilter() {
    const saved = uiStorageGet(KIND_FILTER_KEY, 'all');
    return KIND_FILTERS.has(saved) ? saved : 'all';
  }

  function syncKindFilterButtons(filter) {
    document.querySelectorAll('.display-kind-filter').forEach((group) => {
      group.querySelectorAll('[data-kind-filter]').forEach((btn) => {
        const on = btn.dataset.kindFilter === filter;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    });
  }

  function setKindFilter(next, { persist = true } = {}) {
    const filter = KIND_FILTERS.has(next) ? next : 'all';
    if (persist) uiStorageSet(KIND_FILTER_KEY, filter);
    syncKindFilterButtons(filter);
    if (typeof applySettingsFilter === 'function') applySettingsFilter();
    if (typeof renderPushGrid === 'function') renderPushGrid();
    else if (typeof applyPushFilter === 'function') applyPushFilter();
    return filter;
  }

  function kindsMatchFilter(kinds, filter = currentKindFilter()) {
    if (!filter || filter === 'all') return true;
    const list = Array.isArray(kinds) && kinds.length ? kinds : ['full', 'vestaboard'];
    return list.includes(filter);
  }

  function settingsCardKinds(card) {
    if (!(card instanceof HTMLElement)) return ['full', 'vestaboard'];
    const fromAttr = parseKindList(card.dataset.displayKinds);
    if (fromAttr.length) return fromAttr;
    if (card.id && SETTINGS_CARD_KINDS[card.id]) {
      return [...SETTINGS_CARD_KINDS[card.id]];
    }
    if (card.classList.contains('slideshow-settings-card')) return ['full'];
    if (card.classList.contains('vb-settings-card')) return ['vestaboard'];
    if (card.dataset.settingsGroup === 'accounts') return ['full', 'vestaboard'];
    return ['full', 'vestaboard'];
  }

  function elementMatchesKindFilter(el, filter = currentKindFilter()) {
    if (!el) return true;
    if (el.classList?.contains('card') && el.dataset?.settingsGroup != null) {
      return kindsMatchFilter(settingsCardKinds(el), filter);
    }
    const fromAttr = parseKindList(el.dataset?.displayKinds);
    if (fromAttr.length) return kindsMatchFilter(fromAttr, filter);
    return true;
  }

  // ---------------------------------------------------------- Settings panes

  const SETTINGS_VIEW_KEY = 'signal.settingsView';
  const SETTINGS_SEARCH_KEY = 'signal.settingsSearch';
  const SETTINGS_VIEW_ORDER = ['global', 'accounts', 'youtube', 'games', 'news', 'language', 'travel', 'media'];
  const SETTINGS_VIEWS = new Set(SETTINGS_VIEW_ORDER);

  function currentSettingsView() {
    const active = document.querySelector('#settings-view-tabs .segmented-btn.active');
    const view = active?.dataset?.settingsView;
    return SETTINGS_VIEWS.has(view) ? view : 'global';
  }

  /**
   * A card's heading lives in a sibling `.section-label`, not inside the card,
   * so searching its own text alone missed the words a user actually reaches
   * for: "starter" never found Conversation Starters (the card says "Let's
   * talk"), and "world" never found World Currency Rates.
   */
  function settingsSectionLabel(card) {
    const nested = [...(card.children || [])].find((el) => el.classList.contains('section-label'));
    if (nested) return nested;
    let node = card.previousElementSibling;
    while (node) {
      if (node.classList.contains('section-label')) return node;
      // Ran into the card above without passing a heading — this one has none.
      if (node.classList.contains('card')) return null;
      node = node.previousElementSibling;
    }
    return null;
  }

  function applySettingsFilter(preferredView = null) {
    const searchInput = $('settings-search');
    const clearBtn = $('settings-search-clear');
    const empty = $('settings-search-empty');
    const raw = searchInput?.value || '';
    const query = normalizeSearchQuery(raw);
    const kindFilter = currentKindFilter();
    syncKindFilterButtons(kindFilter);
    if (clearBtn) clearBtn.hidden = !String(raw).trim();

    const counts = Object.fromEntries(SETTINGS_VIEW_ORDER.map((view) => [view, 0]));
    const cards = [...document.querySelectorAll('#settings-card-grid .card[data-settings-group]')];
    const headings = new Map();
    for (const card of cards) {
      const group = card.dataset.settingsGroup;
      const heading = settingsSectionLabel(card);
      if (heading) headings.set(card, heading);
      const match = matchesSearch(card, query, heading?.textContent || '')
        && elementMatchesKindFilter(card, kindFilter);
      card.dataset.settingsMatch = match ? '1' : '0';
      if (match && SETTINGS_VIEWS.has(group)) counts[group] += 1;
    }

    const decided = (globalThis.SignalSettingsFilter?.decideSettingsFilter || ((opts) => {
      let view = SETTINGS_VIEWS.has(opts.preferredView) ? opts.preferredView : currentSettingsView();
      if ((opts.query || opts.kindFilter !== 'all') && (opts.counts[view] || 0) === 0) {
        view = SETTINGS_VIEW_ORDER.find((name) => (opts.counts[name] || 0) > 0) || view;
      }
      return { view, total: SETTINGS_VIEW_ORDER.reduce((sum, name) => sum + (opts.counts[name] || 0), 0) };
    }))({
      counts,
      query,
      kindFilter,
      activeView: currentSettingsView(),
      preferredView,
    });
    const view = decided.view;

    document.querySelectorAll('#settings-view-tabs .segmented-btn').forEach((btn) => {
      const name = btn.dataset.settingsView;
      const count = counts[name] || 0;
      const on = name === view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      // Same as Push: hide tabs with no hits for the typed search. Keep the
      // active tab so a click onto an empty pane does not vanish the bar.
      btn.hidden = Boolean(query) && count === 0 && !on;
      const badge = btn.querySelector('.settings-hit-count');
      if (badge) {
        badge.textContent = String(count);
        badge.hidden = !query && kindFilter === 'all';
      }
    });

    // A heading follows the one card it introduces. Keying it off the pane
    // instead left a wall of headings above a single result.
    const shownHeadings = new Set();
    for (const [card, heading] of headings) {
      if (card.dataset.settingsGroup === view && card.dataset.settingsMatch === '1') {
        shownHeadings.add(heading);
      }
    }
    document.querySelectorAll('#settings-card-grid [data-settings-group]').forEach((el) => {
      const group = el.dataset.settingsGroup;
      if (el.classList.contains('card')) {
        el.hidden = group !== view || el.dataset.settingsMatch !== '1';
        return;
      }
      el.hidden = el.classList.contains('section-label')
        ? !shownHeadings.has(el)
        : group !== view || counts[group] === 0;
    });

    const total = SETTINGS_VIEW_ORDER.reduce((sum, name) => sum + counts[name], 0);
    if (empty) {
      // A pane click during a search can land on zero hits without the
      // catalog itself being empty — still tell the user why the grid is blank.
      const nothing = (counts[view] || 0) === 0;
      empty.hidden = !nothing;
      if (nothing) {
        empty.textContent = query
          ? 'No settings match that search.'
          : kindFilter === 'vestaboard'
            ? 'No Vestaboard settings in this section.'
            : kindFilter === 'full'
              ? 'No software-display settings in this section.'
              : 'No settings match that filter.';
      }
    }

    uiStorageSet(SETTINGS_VIEW_KEY, view);
    return { view, counts, query, total, kindFilter };
  }

  function showSettingsView(view) {
    applySettingsFilter(view);
  }

  function setSettingsSearch(value, { persist = true } = {}) {
    const input = $('settings-search');
    if (input) input.value = value;
    if (persist) uiStorageSet(SETTINGS_SEARCH_KEY, String(value || ''));
    applySettingsFilter();
  }

  $('settings-view-tabs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-settings-view]');
    if (!(btn instanceof HTMLElement)) return;
    if (!btn.closest('#settings-view-tabs')) return;
    const next = btn.dataset.settingsView;
    const previous = currentSettingsView();
    if (next === previous) return;
    rememberTabScroll('settings', previous);
    showSettingsView(next);
    restoreTabScroll('settings', next);
  });

  $('settings-search')?.addEventListener('input', (event) => {
    const value = event.target?.value || '';
    uiStorageSet(SETTINGS_SEARCH_KEY, value);
    applySettingsFilter();
  });

  $('settings-search-clear')?.addEventListener('click', () => {
    setSettingsSearch('');
    $('settings-search')?.focus();
  });

  // Restore the last pane + search before the Settings tab is opened, so
  // non-matching cards are never flashed as a long scrolling page.
  (() => {
    const savedView = uiStorageGet(SETTINGS_VIEW_KEY, 'global');
    const savedSearch = uiStorageGet(SETTINGS_SEARCH_KEY, '');
    const input = $('settings-search');
    if (input) input.value = savedSearch;
    applySettingsFilter(savedView);
  })();

  // ------------------------------------------------------------- Push panes

  // The Push grid grew past thirty tiles, so it is filed the way Settings is:
  // one pane per category, a search that counts hits on every tab, and tabs
  // that step aside when nothing in them matches. Categories come from the
  // command registry (`pushCategory`), so a new tile lands in a pane on its own.
  const PUSH_VIEW_LEGACY_KEY = 'signal.pushView';
  const PUSH_VIEW_ORDER = ['home', 'games', 'media', 'news', 'language', 'travel', 'share'];
  const PUSH_VIEWS = new Set(PUSH_VIEW_ORDER);
  // In-memory only: bottom tabs never reload the page, so this survives Push ↔
  // Settings hops. A fresh admin load (including after login) always opens Home.
  let pushViewSession = PUSH_VIEW_ORDER[0];
  uiStorageRemove(PUSH_VIEW_LEGACY_KEY);

  function applyPushFilter(preferredView = null) {
    const grid = $('push-card-grid');
    if (!grid) return null;
    const searchInput = $('push-search');
    const clearBtn = $('push-search-clear');
    const empty = $('push-search-empty');
    const raw = searchInput?.value || '';
    const query = normalizeSearchQuery(raw);
    const kindFilter = currentKindFilter();
    syncKindFilterButtons(kindFilter);
    if (clearBtn) clearBtn.hidden = !String(raw).trim();

    // Until /api/commands answers, the rows hold skeletons and every count is
    // zero — hiding tabs on that would blank the page for a beat on load.
    const loading = Boolean(grid.querySelector('[data-push-category][aria-busy]'));

    const counts = Object.fromEntries(PUSH_VIEW_ORDER.map((view) => [view, 0]));

    grid.querySelectorAll('[data-push-category]').forEach((row) => {
      const group = row.dataset.pushCategory;
      let hits = 0;
      row.querySelectorAll('.push-card[data-command-id]').forEach((tile) => {
        const match = matchesSearch(tile, query) && elementMatchesKindFilter(tile, kindFilter);
        tile.hidden = !match;
        if (match) hits += 1;
      });
      row.dataset.pushHits = String(hits);
      if (PUSH_VIEWS.has(group)) counts[group] += hits;
    });

    grid.querySelectorAll('[data-push-item]').forEach((item) => {
      const group = item.closest('[data-push-group]')?.dataset?.pushGroup;
      const match = matchesSearch(item, query) && elementMatchesKindFilter(item, kindFilter);
      item.dataset.pushMatch = match ? '1' : '0';
      if (match && PUSH_VIEWS.has(group)) counts[group] += 1;
    });

    let view = PUSH_VIEWS.has(preferredView) ? preferredView : pushViewSession;
    // Only step aside for an active search/filter — an empty Home pane (e.g. a
    // board that hides Alexa tiles) must not jump to Share on load. Never auto
    // jump while skeletons are still up, or onto Share as a fallback.
    if ((query || kindFilter !== 'all') && !loading && counts[view] === 0) {
      const next = PUSH_VIEW_ORDER.find((name) => name !== 'share' && counts[name] > 0)
        || (counts.share > 0 ? 'share' : null);
      if (next) {
        view = next;
      }
    }

    document.querySelectorAll('#push-view-tabs .segmented-btn').forEach((btn) => {
      const name = btn.dataset.pushView;
      const count = counts[name] || 0;
      const on = name === view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      // Keep the active tab visible even at 0 hits so Home does not vanish
      // while commands are still loading / filtered empty.
      btn.hidden = !loading && count === 0 && !on;
      const badge = btn.querySelector('.push-hit-count');
      if (badge) {
        badge.textContent = String(count);
        badge.hidden = !query && kindFilter === 'all';
      }
    });

    grid.querySelectorAll('[data-push-group]').forEach((block) => {
      const group = block.dataset.pushGroup;
      if (group !== view) {
        block.hidden = true;
        return;
      }
      if (block.classList.contains('push-share-pane')) {
        block.hidden = false;
        const tileSection = block.querySelector('.push-share-tiles');
        const row = block.querySelector('[data-push-category]');
        if (tileSection) {
          tileSection.hidden = Boolean(row) && !loading && Number(row.dataset.pushHits || 0) === 0;
        }
        // Hide the whole Share pane when every hand-built column and tile is out.
        const items = [...block.querySelectorAll('[data-push-item]')];
        const itemVisible = items.some((item) => item.dataset.pushMatch === '1');
        const tilesVisible = Number(row?.dataset?.pushHits || 0) > 0;
        if (!loading && !itemVisible && !tilesVisible) {
          block.hidden = true;
        }
        return;
      }
      const row = block.querySelector('[data-push-category]');
      // A tile block earns its heading only while a tile below it still shows.
      block.hidden = Boolean(row) && !loading && Number(row.dataset.pushHits || 0) === 0;
    });

    grid.querySelectorAll('[data-push-item]').forEach((item) => {
      const group = item.closest('[data-push-group]')?.dataset?.pushGroup;
      item.hidden = group !== view || item.dataset.pushMatch !== '1';
    });

    const total = PUSH_VIEW_ORDER.reduce((sum, name) => sum + counts[name], 0);
    if (empty) {
      // With every tab hidden the page is otherwise blank, so say which of the
      // reasons emptied it — the search, the kind filter, or the display target.
      const nothing = !loading && total === 0;
      empty.hidden = !nothing;
      if (nothing) {
        if (query) {
          empty.textContent = 'Nothing to push matches that search.';
        } else if (kindFilter === 'vestaboard') {
          empty.textContent = 'Nothing here applies to Vestaboard.';
        } else if (kindFilter === 'full') {
          empty.textContent = 'Nothing here applies to software displays.';
        } else {
          empty.textContent = 'Nothing here can be sent to the display you picked.';
        }
      }
    }

    pushViewSession = view;
    return { view, counts, query, total, kindFilter };
  }

  function showPushView(view) {
    applyPushFilter(view);
  }

  $('push-view-tabs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-push-view]');
    if (!(btn instanceof HTMLElement)) return;
    if (!btn.closest('#push-view-tabs')) return;
    if (btn.hidden) return;
    const next = btn.dataset.pushView;
    const previous = pushViewSession;
    if (next === previous) return;
    rememberTabScroll('push', previous);
    showPushView(next);
    restoreTabScroll('push', next);
  });

  $('push-search')?.addEventListener('input', () => {
    applyPushFilter();
  });

  $('push-search-clear')?.addEventListener('click', () => {
    const input = $('push-search');
    if (input) input.value = '';
    applyPushFilter();
    input?.focus();
  });

  document.querySelectorAll('.display-kind-filter').forEach((group) => {
    group.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-kind-filter]');
      if (!(btn instanceof HTMLElement) || !group.contains(btn)) return;
      setKindFilter(btn.dataset.kindFilter);
    });
  });

  // Restore the shared Applies-to filter (default All Displays).
  syncKindFilterButtons(currentKindFilter());

  // Push is the landing tab and always opens on Home. The sub-tab survives
  // bottom-nav hops within one page load; search is never restored.
  applyPushFilter(PUSH_VIEW_ORDER[0]);

  // ---------------------------------------------------------- Status poller

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
      renderStatus(await apiGet('/api/status', { timeoutMs: 8000 }));
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
    'weather-alert': '<path d="M7.5 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 12.1 3.5 3.5 0 0 0 7.5 18Z"/><path d="M12 8v4M12 14.5v.5"/>',
    'shopping-list': '<path d="M6 6h14l-1.5 9h-11z"/><path d="M6 6 5 3H3"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    'guest-snaps': '<rect x="3" y="3" width="8" height="8" rx="1.5"/><path d="M5.5 7h3M7 5.5v3"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M15 17h4M17 15v4"/><path d="M13 7h4M17 3v4M3 17h4M7 13v4"/>',
    'air-quality': '<path d="M4 14c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 9c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 19c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0"/>',
    'now-playing': '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="currentColor" stroke="none"/>',
    alarm: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5 2 6H4c.5-1 2-2.5 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M12 3v1"/>',
    notification: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5 2 6H4c.5-1 2-2.5 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M12 3v1"/>',
    trivia: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.2 2.5c-.5.2-.7.6-.7 1.1v.5"/><path d="M12 16.6v.4"/>',
    riddle: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.2 9.6a2.6 2.6 0 1 1 3.4 2.4c-.6.4-1 .9-1 1.7"/><circle cx="12" cy="16.2" r=".7" fill="currentColor" stroke="none"/>',
    scramble: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h2v2H8zM11 8h2v2h-2zM14 8h2v2h-2zM8 11h2v2H8zM11 11h2v2h-2zM14 11h2v2h-2zM8 14h2v2H8zM11 14h2v2h-2zM14 14h2v2h-2z"/>',
    news: '<path d="M4 5.5h12.5A2.5 2.5 0 0 1 19 8v11H6.5A2.5 2.5 0 0 1 4 16.5v-11Z"/><path d="M8 9h6M8 12h6M8 15h3.5"/><path d="M19 10.5h1.5A1.5 1.5 0 0 1 22 12v5.5A1.5 1.5 0 0 1 20.5 19H19"/>',
    wiki: '<path d="M5 4.5h8a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z"/><path d="M9 4.5V3h6v1.5"/><path d="M8 10h6M8 13.5h4"/>',
    japanese: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
    portuguese: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18"/><circle cx="9" cy="12" r="3"/>',
    spanish: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18"/>',
    french: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
    german: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.7h18M3 14.3h18"/>',
    italian: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
    chuck: '<circle cx="12" cy="8.5" r="3.2"/><path d="M7 20c.6-3.2 2.6-5 5-5s4.4 1.8 5 5"/><path d="M5 10.5c2-.8 4-.8 7-.8s5 0 7 .8"/><path d="M8.2 13.2 6.5 15M15.8 13.2 17.5 15"/>',
    amazing: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="m8.5 4.5 1 1.5M15.5 4.5l-1 1.5M5.5 9l1.5.8M18.5 9l-1.5.8"/>',
    talk: '<path d="M5 6.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H10l-3.5 3v-3H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z"/><path d="M14 9.5h5a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-1v2l-2.5-2"/>',
    stoic: '<path d="M8 4h8v3.5c0 2.2-1.8 4-4 4s-4-1.8-4-4V4Z"/><path d="M7 20c.8-3.5 2.8-5.5 5-5.5s4.2 2 5 5.5"/><path d="M9.5 9.5h5"/>',
    history: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/><path d="M16.5 15.5 18 18"/>',
    bake: '<path d="M7 14h10v5H7z"/><path d="M8 14c0-3 1.5-6 4-6s4 3 4 6"/><path d="M9 9.5c.5-1.5 1.5-2.5 3-2.5s2.5 1 3 2.5"/><path d="M6 19h12"/>',
    stocks: '<path d="M4 18V6M4 18h16"/><path d="m7 14 3-4 3 2 4-6"/>',
    currency: '<circle cx="12" cy="12" r="9"/><path d="M12 6v12M9.5 9.5c.6-1 1.6-1.5 2.5-1.5 1.4 0 2.5.9 2.5 2s-1.1 2-2.5 2h-1c-1.4 0-2.5.9-2.5 2s1.1 2 2.5 2c.9 0 1.9-.5 2.5-1.5"/>',
    world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 3.2 2.8 14.8 0 18M12 3c-2.8 3.2-2.8 14.8 0 18"/><path d="M5.5 7.5c2 .8 4 .8 6.5.8s4.5 0 6.5-.8M5.5 16.5c2-.8 4-.8 6.5-.8s4.5 0 6.5.8"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
    'word-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>',
    roast: '<path d="M12 3c2.8 3 4.2 5.3 4.2 7a4.2 4.2 0 0 1-8.4 0c0-1.7 1.4-4 4.2-7z"/><path d="M6.5 14.5c-.9 1.2-1.4 2.4-1.4 3.4C5.1 20.2 8 22 12 22s6.9-1.8 6.9-4.1c0-1-.5-2.2-1.4-3.4"/>',
    'family-quotes': '<path d="M12 20.5S4 15.8 4 10.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 8 2.2c0 5.6-8 10.3-8 10.3z"/>',
    'warm-fuzzies': '<path d="M12 20.5S4 15.8 4 10.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 8 2.2c0 5.6-8 10.3-8 10.3z"/><path d="M8.5 10.5c1.2-1.5 3-2.2 3.5-.5.5-1.7 2.3-1 3.5.5"/>',
    'daily-bucket-fillers': '<path d="M7 8h10l-1.2 11H8.2L7 8z"/><path d="M6 8h12"/><path d="M9 8V6.5A3 3 0 0 1 15 6.5V8"/><path d="M10 12h4"/>',
    'misheard-lyrics': '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/><path d="M9 10l10-2"/>',
    'periodic-table': '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><rect x="14" y="13" width="7" height="7" rx="1"/>',
    'state-facts': '<path d="M4 7h11l2 2h3v6l-3 3H8l-2-2H4z"/><path d="M8 9.5h.01M12 8.5h.01M15 11h.01M10 13h.01"/>',
    'word-of-the-day': '<path d="M4 5h16v3H4z"/><path d="M6 11h3v8H6z"/><path d="M11 11h3v8h-3z"/><path d="M16 11h3v8h-3z"/>',
    'dad-jokes': '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    'us-weather-map': '<path d="M3 7h11l2 2h5v6l-3 3H9l-3-2H3z"/><path d="M9 7v9M14 9v9"/>',
    'quiet-hours': '<path d="M14.5 4.5A7.5 7.5 0 1 0 19.5 16 6.2 6.2 0 0 1 14.5 4.5Z"/><path d="M16.2 6.2 17 4.4M18.4 8.8l1.6-.6M19.2 12l1.8.2"/>',
    sky: '<circle cx="12" cy="12" r="9"/><path d="M8 14h8"/><path d="m12 8 2 2-2 2-2-2 2-2Z" fill="currentColor" stroke="none"/><path d="M6 10h2M16 10h2"/>',
    iss: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M3 12h4M17 12h4M12 3v4M12 17v4"/><path d="M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2"/>',
    starlink: '<circle cx="12" cy="12" r="9"/><path d="M5 12h14M12 5v14"/><circle cx="7" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="0.9" fill="currentColor" stroke="none"/>',
    'launch-alert': '<path d="M12 3l8 14H4L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.2 9.6v4.8l4.3-2.4-4.3-2.4Z" fill="currentColor" stroke="none"/>',
    steam: '<circle cx="12" cy="12" r="9"/><circle cx="15" cy="9.5" r="2.4"/><path d="M3.3 15.2 8 17.1"/><circle cx="9" cy="15.6" r="2.1"/>',
    psn: '<path d="M10 4.5 15 6v12.5l-2.6-.9V8.2L10 7.5Z" fill="currentColor" stroke="none"/><path d="M4 15.2c2-1.1 4.4-1.5 4.4-1.5v2s-2.1.4-3 .9c-.4.2-.3.5.2.5"/><path d="M20 14.4c-1.6-.9-4-.7-4-.7v1.9s1.9-.3 2.8 0"/>',
    credits: '<path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4M12 13v4M8 20h8M9 17h6"/>',
    autodarts: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    huupe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    plex: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M8 8v8l7-4-7-4Z" fill="currentColor" stroke="none"/>',
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

  let allPushCommands = [];
  let pushCommands = [];

  function commandSupportsSelectedKind(command) {
    const kind = selectedDisplayKind();
    if (!kind) {
      return true;
    }
    const kinds = Array.isArray(command.kinds) && command.kinds.length
      ? command.kinds
      : ['full'];
    return kinds.includes(kind);
  }

  function commandMatchesKindFilter(command) {
    const kinds = Array.isArray(command.kinds) && command.kinds.length
      ? command.kinds
      : ['full'];
    return kindsMatchFilter(kinds);
  }

  function renderPushGrid(commands) {
    // Displays refresh can call this before /api/commands answers. Keep the
    // skeleton placeholders — wiping them blanks Home and flashes Share.
    if (commands) {
      allPushCommands = commands;
    } else if (!allPushCommands.length) {
      return;
    }
    pushCommands = allPushCommands.filter(
      (command) => command.pushable
        && commandSupportsSelectedKind(command)
        && commandMatchesKindFilter(command),
    );
    document.querySelectorAll('[data-push-category]').forEach((row) => {
      const category = String(row.dataset.pushCategory || '').trim();
      const mine = pushCommands.filter((command) => command.pushCategory === category);
      row.innerHTML = mine.map((command) => {
        const sub = PUSH_SUBTITLE_HTML[command.id] || escapeHtml(command.subtitle);
        const extraClass = command.id === 'signal.slideshow' ? ' push-card-photo' : '';
        const iconClass = command.id === 'signal.slideshow' ? ' push-icon-photo' : '';
        // The service name and the command id are searchable even though the
        // tile never prints them, so "flightplan" finds Trip Board.
        const terms = [command.title, command.subtitle, command.group, command.id].join(' ');
        const kinds = Array.isArray(command.kinds) && command.kinds.length
          ? command.kinds
          : ['full'];
        return `<button type="button" class="push-card${extraClass}"`
          + ` id="${pushCardElementId(command.id)}" data-command-id="${escapeHtml(command.id)}"`
          + ` data-display-kinds="${escapeHtml(kinds.join(' '))}"`
          + ` data-search-terms="${escapeHtml(terms)}">`
          + `<span class="push-icon${iconClass}">${pushIconSvg(command.icon)}</span>`
          + `<span class="push-card-title">${escapeHtml(command.title)}</span>`
          + `<span class="push-card-sub">${sub}</span>`
          + '</button>';
      }).join('');
      row.removeAttribute('aria-busy');
    });
    // Visibility of rows, headings and tabs belongs to the filter alone.
    // Always re-assert Home on the first successful command paint so an empty
    // pre-load pass cannot leave Share looking selected.
    applyPushFilter(pushViewSession || PUSH_VIEW_ORDER[0]);
  }

  async function loadPushGrid() {
    try {
      const { commands } = await apiGet('/api/commands', { timeoutMs: 20000 });
      renderPushGrid(commands);
    } catch (error) {
      // A failed load leaves the skeletons rather than showing a blank Share flash.
      console.warn('Could not load push commands', error);
    }
  }

  // Fast path: every binding the boot needs exists by now, so run it inline
  // rather than waiting for the queued attempt above. bootAdminChrome() is
  // idempotent, so whichever call lands first wins.
  bootAdminChrome();

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
    // Root-absolute (guest upload page) — ignores <base href="/admin/…">.
    window.open('/guestsnaps/', '_blank', 'noopener,noreferrer');
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

  registerSheetDismiss('qr-sheet', () => {
    $('qr-sheet').hidden = true;
  });

  registerSheetDismiss('qr-scanner-sheet', () => {
    stopQrScanner();
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
  registerSheetDismiss('photo-lightbox', () => closeLightbox());
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
  registerSheetDismiss('photo-delete-sheet', () => closeDeleteConfirm());
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

  const SCHED_RULE_SEARCH_KEY = 'signal.schedRuleSearch';
  let schedFocusRuleId = null;

  function normalizeSchedQuery(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function schedRuleSearchQuery() {
    return normalizeSchedQuery($('sched-rule-search')?.value || '');
  }

  function schedRuleMatches(rule, query) {
    if (!query) return true;
    const haystack = [
      rule.label,
      rule.commandTitle,
      rule.commandGroup,
      rule.commandId,
      rule.target,
    ].join(' ').toLowerCase().replace(/\s+/g, ' ');
    return query.split(' ').every((term) => term && haystack.includes(term));
  }

  function schedRuleGroupLabel(rule) {
    return String(rule.commandGroup || '').trim() || (rule.broken ? 'Broken' : 'Other');
  }

  function compareSchedRules(a, b) {
    return Number(b.enabled) - Number(a.enabled)
      || String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' })
      || String(a.id || '').localeCompare(String(b.id || ''));
  }

  function focusSchedRule(ruleId) {
    if (!ruleId) return;
    const card = document.querySelector(`#sched-rule-list [data-rule-id="${CSS.escape(ruleId)}"]`);
    if (!(card instanceof HTMLElement)) return;
    card.classList.add('is-new');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.classList.remove('is-new'), 2200);
  }

  function renderSchedRules() {
    const host = $('sched-rule-list');
    const meta = $('sched-rule-meta');
    const empty = $('sched-rule-empty');
    const clearBtn = $('sched-rule-search-clear');
    const searchInput = $('sched-rule-search');
    if (!host) return;

    // Display refreshes and saves rebuild this list; keep the window where
    // the admin left it so a filter + scroll is not yanked back to the top.
    const scroller = pageScrollEl();
    const savedY = window.scrollY || scroller.scrollTop || 0;

    const rawSearch = searchInput?.value || '';
    const query = normalizeSchedQuery(rawSearch);
    if (clearBtn) clearBtn.hidden = !String(rawSearch).trim();

    if (!schedRules.length) {
      host.innerHTML = '';
      if (meta) meta.textContent = 'No rules yet';
      if (empty) {
        empty.hidden = false;
        empty.textContent = 'Pick a command above and click Add rule. New rules land in their group, sorted by name.';
      }
      return;
    }

    const matched = schedRules.filter((rule) => schedRuleMatches(rule, query));
    if (meta) {
      meta.textContent = query
        ? `${matched.length} of ${schedRules.length} rules`
        : `${schedRules.length} rule${schedRules.length === 1 ? '' : 's'} · grouped by type`;
    }

    if (!matched.length) {
      host.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = `No rules match “${rawSearch.trim()}”.`;
      }
      restoreSchedScroll(savedY);
      return;
    }
    if (empty) empty.hidden = true;

    const groups = new Map();
    for (const rule of matched) {
      const group = schedRuleGroupLabel(rule);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(rule);
    }

    const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    host.innerHTML = groupNames.map((group) => {
      const rules = groups.get(group).sort(compareSchedRules);
      return `<section class="sched-rule-group" data-sched-group="${escapeHtml(group)}">`
        + `<h3 class="sched-rule-group-title">${escapeHtml(group)}`
        + `<span class="sched-rule-group-count">${rules.length}</span></h3>`
        + rules.map(schedRuleCardHtml).join('')
        + `</section>`;
    }).join('');

    if (schedFocusRuleId) {
      const id = schedFocusRuleId;
      schedFocusRuleId = null;
      requestAnimationFrame(() => focusSchedRule(id));
    } else {
      restoreSchedScroll(savedY);
    }
  }

  function restoreSchedScroll(y) {
    const top = Math.max(0, Number(y) || 0);
    if (!top) return;
    const apply = () => {
      window.scrollTo(0, top);
      pageScrollEl().scrollTop = top;
    };
    apply();
    requestAnimationFrame(apply);
  }

  function schedCommandById(commandId) {
    return schedCommands.find((entry) => entry.id === commandId) || null;
  }

  function schedTargetOptions(rule) {
    const command = schedCommandById(rule.commandId);
    const kinds = Array.isArray(command?.kinds) && command.kinds.length
      ? command.kinds
      : ['full'];
    const boardCapable = kinds.includes('vestaboard');
    const boardOnly = kinds.length === 1 && kinds[0] === 'vestaboard';
    const current = rule.target || (boardOnly ? 'vestaboard' : 'full');
    const options = [];
    if (!boardOnly) {
      options.push(['full', 'Full displays'], ['all', 'All displays']);
    }
    if (boardCapable) {
      options.push(['vestaboard', 'Vestaboards']);
      for (const display of knownDisplays.filter((entry) => entry.kind === 'vestaboard')) {
        options.push([display.id, display.label || display.name]);
      }
    }
    for (const display of knownDisplays.filter((entry) => entry.kind !== 'vestaboard')) {
      if (boardOnly) {
        continue;
      }
      options.push([display.id, display.label || display.name]);
    }
    if (current && !options.some(([value]) => value === current)) {
      options.push([current, current]);
    }
    return options.map(([value, label]) => (
      `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`
    )).join('');
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
        <label class="field-label" for="tgt-${escapeHtml(rule.id)}">Show on</label>
        <select class="field-input" id="tgt-${escapeHtml(rule.id)}" data-sched-field="target">${schedTargetOptions(rule)}</select>
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
      target: value('target')?.value || 'full',
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

  let schedCommandCatalog = [];
  let schedCommandActiveIndex = -1;

  function setSchedAddCommand(command) {
    const hidden = $('sched-add-command');
    const search = $('sched-add-command-search');
    if (hidden) hidden.value = command?.id || '';
    if (search) {
      search.value = command ? command.title : '';
      search.dataset.selectedId = command?.id || '';
    }
    hideSchedCommandList();
  }

  function hideSchedCommandList() {
    const list = $('sched-add-command-list');
    const search = $('sched-add-command-search');
    if (list) list.hidden = true;
    if (search) search.setAttribute('aria-expanded', 'false');
    schedCommandActiveIndex = -1;
  }

  function filterSchedCommandCatalog(query) {
    const q = normalizeSchedQuery(query);
    if (!q) return schedCommandCatalog.slice();
    const terms = q.split(' ').filter(Boolean);
    return schedCommandCatalog.filter((entry) => (
      terms.every((term) => entry.haystack.includes(term))
    ));
  }

  function renderSchedCommandList(items) {
    const list = $('sched-add-command-list');
    const search = $('sched-add-command-search');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="typeahead-empty">No matching events</div>';
      list.hidden = false;
      if (search) search.setAttribute('aria-expanded', 'true');
      schedCommandActiveIndex = -1;
      return;
    }
    const shown = items.slice(0, 50);
    list.innerHTML = shown.map((entry, index) => (
      `<button type="button" class="typeahead-item${index === 0 ? ' is-active' : ''}"`
      + ` role="option" data-command-id="${escapeHtml(entry.id)}" data-index="${index}">`
      + `<span class="typeahead-item-title">${escapeHtml(entry.title)}</span>`
      + `<span class="typeahead-item-group">${escapeHtml(entry.group)}</span>`
      + '</button>'
    )).join('');
    list.hidden = false;
    if (search) search.setAttribute('aria-expanded', 'true');
    schedCommandActiveIndex = 0;
    list.querySelectorAll('[data-command-id]').forEach((btn) => {
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const id = btn.dataset.commandId;
        const command = schedCommandCatalog.find((entry) => entry.id === id);
        if (command) setSchedAddCommand(command);
      });
    });
  }

  function highlightSchedCommandItem(index) {
    const list = $('sched-add-command-list');
    if (!list || list.hidden) return;
    const items = [...list.querySelectorAll('[data-command-id]')];
    if (!items.length) return;
    schedCommandActiveIndex = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, i) => {
      item.classList.toggle('is-active', i === schedCommandActiveIndex);
    });
    items[schedCommandActiveIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function renderSchedCommandPicker() {
    schedCommandCatalog = schedCommands
      .filter((entry) => entry.schedulable)
      .map((command) => ({
        id: command.id,
        title: command.title,
        group: command.group || 'Other',
        haystack: [command.title, command.subtitle, command.group, command.id]
          .join(' ')
          .toLowerCase()
          .replace(/\s+/g, ' '),
      }));
    const hidden = $('sched-add-command');
    const search = $('sched-add-command-search');
    // Keep a previous pick if it is still schedulable; otherwise leave the
    // field blank so "Add a rule" is a search box, not Tesla Dashboard.
    const previousId = hidden?.value || search?.dataset.selectedId || '';
    const current = previousId
      ? schedCommandCatalog.find((entry) => entry.id === previousId)
      : null;
    setSchedAddCommand(current || null);
  }

  function bindSchedCommandPicker() {
    const search = $('sched-add-command-search');
    const list = $('sched-add-command-list');
    if (!search || search.dataset.bound === '1') return;
    search.dataset.bound = '1';

    search.addEventListener('focus', () => {
      renderSchedCommandList(filterSchedCommandCatalog(search.value));
    });
    search.addEventListener('input', () => {
      // Typing means the previous pick may no longer match — keep hidden id
      // only while the text still equals that title.
      const selected = schedCommandCatalog.find((entry) => entry.id === search.dataset.selectedId);
      if (!selected || search.value.trim() !== selected.title) {
        const hidden = $('sched-add-command');
        if (hidden) hidden.value = '';
        search.dataset.selectedId = '';
      }
      renderSchedCommandList(filterSchedCommandCatalog(search.value));
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (list?.hidden) renderSchedCommandList(filterSchedCommandCatalog(search.value));
        highlightSchedCommandItem(schedCommandActiveIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlightSchedCommandItem(schedCommandActiveIndex - 1);
      } else if (event.key === 'Enter') {
        const active = list?.querySelector('.typeahead-item.is-active[data-command-id]');
        if (active && !list.hidden) {
          event.preventDefault();
          const command = schedCommandCatalog.find((entry) => entry.id === active.dataset.commandId);
          if (command) setSchedAddCommand(command);
        }
      } else if (event.key === 'Escape') {
        hideSchedCommandList();
        search.blur();
      }
    });
    search.addEventListener('blur', () => {
      setTimeout(() => hideSchedCommandList(), 150);
    });
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
        empty.textContent = 'No rules yet — add one on the Schedule tab and activity will appear here.';
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
        : 'No activity in this window yet. Tap a rule on the Schedule tab to see when it is next due.';
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
    if (event.target) {
      const targetLabels = {
        full: 'Full displays',
        all: 'All displays',
        vestaboard: 'Vestaboards',
      };
      const named = knownDisplays.find((entry) => entry.id === event.target);
      rows.push(['Target', targetLabels[event.target]
        || named?.label || named?.name || event.target]);
    }
    if (event.boardOutcomes?.length) {
      rows.push(['Boards', event.boardOutcomes.map((row) => (
        `${row.boardId}: ${row.reason || (row.skipped ? 'skipped' : 'posted')}`
      )).join(', ')]);
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
        ${schedBoardStatsHtml(entry.boards)}
      </div>`;
    }).join('');
  }

  function schedBoardStatsHtml(boards) {
    if (!boards || typeof boards !== 'object') {
      return '';
    }
    const ids = Object.keys(boards);
    if (!ids.length) {
      return '';
    }
    const lines = ids.map((id) => {
      const named = knownDisplays.find((entry) => entry.id === id);
      const counts = Object.entries(boards[id])
        .map(([reason, count]) => `${count} ${reason}`)
        .join(', ');
      return `${named?.label || named?.name || id}: ${counts}`;
    });
    return `<div class="sched-readout">${escapeHtml(lines.join(' · '))}</div>`;
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
      if (target.closest('#sched-view-settings') || target.id === 'sched-active') {
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
        const previous = currentSchedView();
        if (view !== previous) rememberTabScroll('scheduler', previous);
        document.querySelectorAll('#sched-view-tabs .segmented-btn').forEach((btn) => {
          btn.classList.toggle('active', btn === viewBtn);
        });
        $('sched-view-schedule').hidden = view !== 'schedule';
        $('sched-view-activity').hidden = view !== 'activity';
        $('sched-view-simulation').hidden = view !== 'simulation';
        $('sched-view-settings').hidden = view !== 'settings';
        updateStickyOffsets();
        if (view !== previous) restoreTabScroll('scheduler', view);
        updateSchedSetupCompact();
        updatePageJump();
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
      if (!commandId) {
        toast('Pick an event type to schedule', 'bad');
        $('sched-add-command-search')?.focus();
        return;
      }
      try {
        const result = await apiFetch(`${SCHED_ROUTE}/rules`, {
          method: 'POST',
          body: { commandId, intervalSeconds: 2700, probability: 90 },
        });
        const newId = result?.rule?.id || null;
        // Clear search so the new card is always visible in its group.
        const search = $('sched-rule-search');
        if (search && search.value) {
          search.value = '';
          try { localStorage.removeItem(SCHED_RULE_SEARCH_KEY); } catch { /* ignore */ }
        }
        schedFocusRuleId = newId;
        await loadSchedRules();
        await refreshSchedStatus();
        if (result?.rule?.label) {
          toast(`Added ${result.rule.label}`, 'good');
        }
      } catch (error) {
        toast(error.message || 'Could not add rule', 'bad');
      }
    });

    const searchInput = $('sched-rule-search');
    if (searchInput) {
      try {
        const saved = localStorage.getItem(SCHED_RULE_SEARCH_KEY);
        if (saved) searchInput.value = saved;
      } catch { /* ignore */ }
      searchInput.addEventListener('input', () => {
        try {
          const value = searchInput.value;
          if (String(value).trim()) localStorage.setItem(SCHED_RULE_SEARCH_KEY, value);
          else localStorage.removeItem(SCHED_RULE_SEARCH_KEY);
        } catch { /* ignore */ }
        renderSchedRules();
      });
    }
    $('sched-rule-search-clear')?.addEventListener('click', () => {
      const input = $('sched-rule-search');
      if (input) input.value = '';
      try { localStorage.removeItem(SCHED_RULE_SEARCH_KEY); } catch { /* ignore */ }
      renderSchedRules();
      input?.focus();
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
        bindSchedCommandPicker();
        await loadSchedRules();
        await refreshSchedStatus();
        updateStickyOffsets();
        updatePageJump();
        updateSchedSetupCompact();
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

  // ------------------------------------------- Settings → Feature Presentation

  function plexStatusTone(status) {
    if (!status?.enabled) return { tone: 'off', label: 'Off', text: 'Feature Presentation is off.' };
    if (status.health === 'auth') {
      return { tone: 'bad', label: 'Auth', text: status.healthReason || 'Plex rejected the token.' };
    }
    if (status.health === 'unhealthy') {
      return { tone: 'bad', label: 'Unreachable', text: status.healthReason || 'Plex is unreachable.' };
    }
    if (status.playing) {
      return { tone: 'ok', label: 'Playing', text: status.session?.title ? `Playing ${status.session.title}.` : 'A movie is playing.' };
    }
    if (status.lastPlayed?.title) {
      return { tone: 'ok', label: 'Idle', text: `Last played ${status.lastPlayed.title}.` };
    }
    if (status.health === 'idle') {
      return { tone: '', label: 'Idle', text: status.healthReason || 'Waiting for a theater session.' };
    }
    return { tone: 'ok', label: 'Watching', text: 'Watching the theater player.' };
  }

  function renderPlexPlayerList(ids) {
    const list = $('plex-player-list');
    if (!list) return;
    const players = Array.isArray(ids) ? ids : [];
    if (!players.length) {
      list.innerHTML = '<li class="hint">None yet — add the Apple TV IP below.</li>';
      return;
    }
    list.innerHTML = players.map((ip) => (
      `<li data-ip="${escapeHtml(ip)}"><span>${escapeHtml(ip)}</span>`
      + `<button type="button" class="btn btn-outline plex-remove-player" data-ip="${escapeHtml(ip)}">Remove</button></li>`
    )).join('');
  }

  function renderPlexLivePlayers(players) {
    const list = $('plex-live-players');
    if (!list) return;
    const rows = Array.isArray(players) ? players : [];
    if (!rows.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = rows.map((row) => {
      const label = [row.name, row.product, row.address].filter(Boolean).join(' · ');
      const ip = row.address || '';
      return `<li data-ip="${escapeHtml(ip)}"><span>${escapeHtml(label || ip)}</span>`
        + (ip ? `<button type="button" class="btn btn-outline plex-add-live" data-ip="${escapeHtml(ip)}">Add</button>` : '')
        + '</li>';
    }).join('');
  }

  function renderPlexSettings(status) {
    const settings = status.settings || {};
    const enabled = $('plex-enabled');
    if (enabled) {
      enabled.checked = settings.enabled === true;
      enabled.closest('.trivia-check')?.classList.toggle('is-off', !enabled.checked);
    }
    const url = $('plex-server-url');
    if (url && document.activeElement !== url) url.value = settings.serverUrl || '';
    const poll = $('plex-poll-ms');
    if (poll) poll.value = String(Math.round((settings.pollIntervalMs || 15000) / 1000));
    const grace = $('plex-stop-grace');
    if (grace) grace.value = String(Math.round((settings.stopGraceMs || 30000) / 1000));
    const drift = $('plex-end-drift');
    if (drift) drift.value = String(settings.repushEndDriftMinutes || 5);
    const pushOnStop = $('plex-push-on-stop');
    if (pushOnStop) {
      pushOnStop.checked = settings.pushOnStop !== false;
      pushOnStop.closest('.trivia-check')?.classList.toggle('is-off', !pushOnStop.checked);
    }
    const quiet = $('plex-quiet-hours');
    if (quiet) {
      quiet.checked = settings.quietHoursExempt !== false;
      quiet.closest('.trivia-check')?.classList.toggle('is-off', !quiet.checked);
    }
    const score = $('plex-critic-score');
    if (score) {
      score.checked = settings.showCriticScore !== false;
      score.closest('.trivia-check')?.classList.toggle('is-off', !score.checked);
    }
    renderPlexPlayerList(settings.monitoredPlayers);
    renderPlexCredentials(status);
    renderPlexStatus(status);
  }

  function renderPlexCredentials(status) {
    const creds = status?.credentials || {};
    const hint = $('plex-token-hint');
    if (!hint) return;
    if (creds.envBlocksOverwrite) {
      hint.textContent = 'PLEX_TOKEN is set in .env and cannot be replaced here.';
    } else if (creds.hasToken) {
      hint.textContent = creds.tokenHint
        ? `Token saved (…${creds.tokenHint}). Paste a new one to replace it.`
        : 'Token saved. Paste a new one to replace it.';
    } else {
      hint.textContent = 'Write-only. Stored encrypted. PLEX_TOKEN in .env wins if set.';
    }
  }

  function renderPlexStatus(status) {
    const pill = $('plex-status-pill');
    const detail = $('plex-status-detail');
    const tone = plexStatusTone(status);
    if (pill) {
      pill.textContent = tone.label;
      pill.className = `status-pill ${tone.tone ? `is-${tone.tone}` : ''}`;
    }
    if (detail) detail.textContent = tone.text;
  }

  function readPlexForm() {
    const players = [...document.querySelectorAll('#plex-player-list li[data-ip]')]
      .map((row) => row.dataset.ip)
      .filter(Boolean);
    return {
      enabled: Boolean($('plex-enabled')?.checked),
      serverUrl: $('plex-server-url')?.value || '',
      monitoredPlayers: players,
      pollIntervalMs: Math.round(Number($('plex-poll-ms')?.value || 15) * 1000),
      stopGraceMs: Math.round(Number($('plex-stop-grace')?.value || 30) * 1000),
      repushEndDriftMinutes: Number($('plex-end-drift')?.value || 5),
      pushOnStop: Boolean($('plex-push-on-stop')?.checked),
      quietHoursExempt: Boolean($('plex-quiet-hours')?.checked),
      showCriticScore: Boolean($('plex-critic-score')?.checked),
    };
  }

  async function savePlexSettings() {
    try {
      const result = await apiFetch('/api/plex/settings', {
        method: 'POST',
        body: readPlexForm(),
      });
      renderPlexSettings(result);
      toast(
        result.settings?.enabled ? 'Plex settings saved — watching the theater player.' : 'Plex settings saved.',
        'ok',
      );
    } catch (error) {
      toast(error.message || 'Could not save Plex settings', 'bad');
    }
  }

  async function loadPlexSettings() {
    const card = $('plex-settings-card');
    if (!card) return;
    try {
      const status = await apiGet('/api/plex/status');
      renderPlexSettings(status);
      card.hidden = false;
    } catch {
      card.hidden = true;
      const label = card.previousElementSibling;
      if (label?.classList.contains('section-label')) label.hidden = true;
    }
  }

  const plexCard = $('plex-settings-card');
  if (plexCard) {
    plexCard.addEventListener('change', (event) => {
      if (event.target?.closest('.trivia-check')) {
        event.target.closest('.trivia-check')?.classList.toggle('is-off', !event.target.checked);
      }
    });
    $('btn-plex-add-player')?.addEventListener('click', () => {
      const input = $('plex-player-ip');
      const ip = String(input?.value || '').trim();
      if (!ip) return;
      const current = readPlexForm().monitoredPlayers;
      if (!current.includes(ip)) current.push(ip);
      renderPlexPlayerList(current);
      if (input) input.value = '';
    });
    plexCard.addEventListener('click', (event) => {
      const remove = event.target.closest('.plex-remove-player');
      if (remove) {
        const ip = remove.dataset.ip;
        renderPlexPlayerList(readPlexForm().monitoredPlayers.filter((value) => value !== ip));
        return;
      }
      const add = event.target.closest('.plex-add-live');
      if (add) {
        const ip = add.dataset.ip;
        const current = readPlexForm().monitoredPlayers;
        if (ip && !current.includes(ip)) current.push(ip);
        renderPlexPlayerList(current);
      }
    });
    $('btn-plex-token-help')?.addEventListener('click', () => {
      const panel = $('plex-token-help');
      const button = $('btn-plex-token-help');
      if (!panel || !button) return;
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('btn-plex-settings-save')?.addEventListener('click', () => {
      savePlexSettings();
    });
    $('btn-plex-save-token')?.addEventListener('click', async () => {
      const token = String($('plex-token')?.value || '').trim();
      if (!token) {
        toast('Paste a Plex token first', 'bad');
        return;
      }
      const serverUrl = String($('plex-server-url')?.value || '').trim();
      try {
        const result = await apiFetch('/api/plex/token', {
          method: 'POST',
          body: { token, serverUrl },
        });
        const field = $('plex-token');
        if (field) field.value = '';
        if (serverUrl && $('plex-server-url')) {
          $('plex-server-url').value = serverUrl;
        }
        renderPlexCredentials(result);
        toast('Plex token saved', 'ok');
      } catch (error) {
        toast(error.message || 'Could not save token', 'bad');
      }
    });
    $('btn-plex-test')?.addEventListener('click', async () => {
      const serverUrl = String($('plex-server-url')?.value || '').trim();
      if (!serverUrl) {
        toast('Set the Plex server URL first', 'bad');
        return;
      }
      try {
        const result = await apiFetch('/api/plex/test', {
          method: 'POST',
          body: { serverUrl },
        });
        renderPlexLivePlayers(result.players);
        const hint = $('plex-live-players-hint');
        if (hint) {
          hint.textContent = result.players?.length
            ? 'Players in a session right now — tap Add to monitor one.'
            : 'No sessions right now. Start a movie on the Apple TV and test again.';
        }
        toast(result.ok ? 'Plex is reachable' : (result.error || 'Test failed'), result.ok ? 'ok' : 'bad');
      } catch (error) {
        toast(error.message || 'Plex test failed', 'bad');
      }
    });
    $('btn-plex-preview')?.addEventListener('click', async () => {
      try {
        await apiPost('/api/plex/preview', withTarget({ mode: 'auto' }));
        toast('Feature Presentation queued', 'ok');
      } catch (error) {
        toast(error.message || 'Preview failed', 'bad');
      }
    });
    loadPlexSettings();
  }

  // ------------------------------------------- Settings → Global / Location

  function localeUnit() {
    const active = document.querySelector('#locale-unit .segmented-btn.active');
    return active?.dataset?.localeUnit === 'C' ? 'C' : 'F';
  }

  function setLocaleUnit(unit) {
    const want = unit === 'C' ? 'C' : 'F';
    document.querySelectorAll('#locale-unit .segmented-btn').forEach((btn) => {
      const on = btn.dataset.localeUnit === want;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderLocaleSettings(settings = {}) {
    const city = $('locale-city');
    const zip = $('locale-zip');
    const currency = $('locale-currency');
    if (city && document.activeElement !== city) city.value = settings.city || '';
    if (zip && document.activeElement !== zip) zip.value = settings.postalCode || '';
    if (currency && document.activeElement !== currency) {
      const code = String(settings.currencyCode || 'USD').toUpperCase();
      if (![...currency.options].some((opt) => opt.value === code)) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${code} — Custom`;
        currency.appendChild(opt);
      }
      currency.value = code;
    }
    setLocaleUnit(settings.temperatureUnit);
    const pill = $('locale-status-pill');
    const detail = $('locale-status-detail');
    const resolved = $('locale-resolved');
    const hasCoords = Number.isFinite(Number(settings.latitude))
      && Number.isFinite(Number(settings.longitude));
    if (pill) {
      pill.textContent = hasCoords ? 'Set' : 'Not set';
      pill.className = `status-pill ${hasCoords ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = hasCoords
        ? `${settings.label || settings.city || 'Home'} · ${settings.timeZone || ''}`
        : 'One pin for Weekly Weather, outdoor forecast, Overhead, routes, and board clocks.';
    }
    if (resolved) {
      if (!hasCoords) {
        resolved.textContent = 'Save a city or ZIP to pin the house here.';
      } else {
        const lat = Number(settings.latitude).toFixed(4);
        const lon = Number(settings.longitude).toFixed(4);
        const fx = settings.currencyCode || 'USD';
        resolved.textContent = `${settings.label || 'Home'}\n${lat}, ${lon}\n${settings.timeZone || ''} · °${settings.temperatureUnit || 'F'} · ${fx}`;
        resolved.style.whiteSpace = 'pre-line';
      }
    }
  }

  async function loadLocaleSettings() {
    try {
      const data = await apiGet('/api/locale/settings');
      renderLocaleSettings(data.settings || data.locale || {});
    } catch {
      renderLocaleSettings({});
    }
  }

  $('locale-unit')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-locale-unit]');
    if (!btn) return;
    setLocaleUnit(btn.dataset.localeUnit);
  });

  $('btn-locale-save')?.addEventListener('click', async () => {
    const button = $('btn-locale-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/locale/settings', {
        city: $('locale-city')?.value || '',
        postalCode: $('locale-zip')?.value || '',
        temperatureUnit: localeUnit(),
        currencyCode: $('locale-currency')?.value || 'USD',
      });
      renderLocaleSettings(result.settings || {});
      toast('House location saved', 'ok');
      loadOverheadSettings();
      loadIssTrackerSettings();
      loadStarlinkTrackerSettings();
    } catch (error) {
      toast(error.message || 'Could not save location', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadLocaleSettings();

  // ------------------------------------------- Settings → Global / Public URL

  function renderPublicUrlSettings(data = {}) {
    const settings = data.settings || {};
    const input = $('public-base-url');
    if (input && document.activeElement !== input) {
      input.value = settings.publicBaseUrl || '';
    }
    const pill = $('public-url-status-pill');
    const detail = $('public-url-status-detail');
    const resolved = $('public-url-resolved');
    const envNote = $('public-url-env-note');
    const hasUrl = Boolean(settings.publicBaseUrl);
    if (pill) {
      pill.textContent = hasUrl ? 'Set' : 'Not set';
      pill.className = `status-pill ${hasUrl ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = hasUrl
        ? 'HTTPS origin for Guest Snaps, the Guest Book short link, and every other human-facing URL.'
        : 'Save an https:// hostname guests can reach from outside the house.';
    }
    if (resolved) {
      resolved.textContent = data.origin
        ? data.origin
        : 'Falls back to GUEST_PHOTOBOOTH_URL, then the LAN address.';
    }
    if (envNote) {
      if (data.envGuestPhotoboothUrlSet) {
        envNote.hidden = false;
        envNote.textContent = data.envNote
          || 'GUEST_PHOTOBOOTH_URL is also set in .env — the Public base URL above wins while it is set.';
      } else {
        envNote.hidden = true;
        envNote.textContent = '';
      }
    }
  }

  async function loadPublicUrlSettings() {
    try {
      const data = await apiGet('/api/public-url/settings');
      renderPublicUrlSettings(data);
    } catch {
      renderPublicUrlSettings({});
    }
  }

  $('btn-public-url-save')?.addEventListener('click', async () => {
    const button = $('btn-public-url-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/public-url/settings', {
        publicBaseUrl: $('public-base-url')?.value || '',
      });
      renderPublicUrlSettings(result);
      toast('Public base URL saved', 'ok');
      loadGuestBookSettings();
      loadGuestSnapsSettings();
    } catch (error) {
      toast(error.message || 'Could not save public URL', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadPublicUrlSettings();

  // ------------------------------------------- Settings → TinyURL

  function renderTinyurlSettings(data = {}) {
    const creds = data.credentials || {};
    const token = $('tinyurl-token');
    if (token && document.activeElement !== token) {
      token.value = '';
      token.placeholder = creds.hasToken
        ? (creds.tokenHint ? `Saved (…${creds.tokenHint})` : 'Token saved')
        : 'Paste token, or set TINYURL_API_TOKEN in .env';
    }
    const hint = $('tinyurl-token-hint');
    if (hint) {
      if (creds.envBlocksOverwrite) {
        hint.textContent = 'TINYURL_API_TOKEN is set in .env and cannot be replaced here.';
      } else if (creds.hasToken) {
        hint.textContent = creds.tokenHint
          ? `Global token saved (…${creds.tokenHint}). Paste a new one to replace it.`
          : 'Global token saved. Paste a new one to replace it.';
      } else {
        hint.textContent = 'Write-only. Stored encrypted. TINYURL_API_TOKEN in .env wins if set.';
      }
    }
    const clear = $('tinyurl-clear-token');
    if (clear) clear.checked = false;
    const pill = $('tinyurl-status-pill');
    if (pill) {
      pill.textContent = creds.hasToken ? 'Saved' : 'Not set';
      pill.className = `status-pill ${creds.hasToken ? 'is-ok' : 'is-warn'}`;
    }
  }

  async function loadTinyurlSettings() {
    try {
      renderTinyurlSettings(await apiGet('/api/tinyurl/settings'));
    } catch {
      renderTinyurlSettings({});
    }
  }

  $('btn-tinyurl-save')?.addEventListener('click', async () => {
    const button = $('btn-tinyurl-save');
    if (button) button.disabled = true;
    try {
      const body = {};
      const token = String($('tinyurl-token')?.value || '').trim();
      if (token) body.apiToken = token;
      if ($('tinyurl-clear-token')?.checked) body.clearToken = true;
      renderTinyurlSettings(await apiPost('/api/tinyurl/settings', body));
      if ($('tinyurl-token')) $('tinyurl-token').value = '';
      toast('TinyURL token saved', 'ok');
    } catch (error) {
      toast(error.message || 'Could not save TinyURL token', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadTinyurlSettings();

  // ------------------------------------------- Settings → Guest Snaps

  function renderGuestSnapsSettings(data = {}) {
    const settings = data.settings || {};
    const creds = data.credentials || {};
    const link = data.shortlink || {};
    const alias = $('guest-snaps-alias');
    if (alias && document.activeElement !== alias) {
      alias.value = settings.preferredAlias || '';
    }
    const token = $('guest-snaps-token');
    if (token && document.activeElement !== token) {
      token.value = '';
      token.placeholder = creds.hasToken
        ? (creds.tokenHint ? `Saved (…${creds.tokenHint})` : 'Token saved')
        : 'Paste token, or set TINYURL_API_TOKEN in .env';
    }
    const hint = $('guest-snaps-token-hint');
    if (hint) {
      if (creds.envBlocksOverwrite) {
        hint.textContent = 'TINYURL_API_TOKEN is set in .env and cannot be replaced here.';
      } else if (creds.hasOverride) {
        hint.textContent = creds.tokenHint
          ? `Override saved (…${creds.tokenHint}). Paste a new one to replace it.`
          : 'Override saved. Paste a new one to replace it.';
      } else if (creds.usingGlobal && creds.hasToken) {
        hint.textContent = 'Using the global token. Paste one here only if this feature needs its own.';
      } else if (creds.hasToken) {
        hint.textContent = creds.tokenHint
          ? `Token saved (…${creds.tokenHint}).`
          : 'Token saved.';
      } else {
        hint.textContent = 'Optional. Uses the global TinyURL token unless you paste one here.';
      }
    }
    const clearOverride = $('guest-snaps-clear-override');
    if (clearOverride) clearOverride.checked = false;

    const health = link.health || (link.alias ? 'unknown' : 'missing');
    const pill = $('guest-snaps-status-pill');
    const detail = $('guest-snaps-status-detail');
    const dot = $('guest-snaps-dot');
    const label = $('guest-snaps-shortlink-label');
    const check = $('guest-snaps-shortlink-check');
    const targetHint = $('guest-snaps-target-hint');
    const tone = health === 'healthy'
      ? 'ok'
      : (health === 'unhealthy' || link.alert ? 'bad' : 'warn');
    if (pill) {
      const text = link.alert
        ? 'Needs repair'
        : health === 'healthy'
          ? 'Active'
          : health === 'missing'
            ? 'Not set'
            : 'Unknown';
      pill.textContent = text;
      pill.className = `status-pill ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = link.alert?.message
        || (link.display
          ? `Short link ${link.display}`
          : 'Short link to the photo booth. Printed on the Vestaboard as TINYURL.COM/ALIAS.');
    }
    if (dot) {
      dot.className = `gb-dot ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    }
    if (label) {
      label.textContent = link.display || 'No short link yet.';
    }
    if (check) {
      check.textContent = formatShortlinkCheck(link);
    }
    if (targetHint) {
      const target = data.targetUrl || '';
      targetHint.textContent = target
        ? `Target ${target}`
        : 'Set a Public base URL (HTTPS) first — LAN IPs cannot be shortened.';
    }
  }

  async function loadGuestSnapsSettings() {
    try {
      const data = await apiGet('/api/guest-snaps/settings');
      renderGuestSnapsSettings(data);
    } catch {
      renderGuestSnapsSettings({});
    }
  }

  $('btn-guest-snaps-save')?.addEventListener('click', async () => {
    const button = $('btn-guest-snaps-save');
    if (button) button.disabled = true;
    try {
      const body = {
        preferredAlias: $('guest-snaps-alias')?.value || '',
      };
      const token = String($('guest-snaps-token')?.value || '').trim();
      if (token) body.apiToken = token;
      if ($('guest-snaps-clear-override')?.checked) body.clearOverride = true;
      const result = await apiPost('/api/guest-snaps/settings', body);
      renderGuestSnapsSettings(result);
      if ($('guest-snaps-token')) $('guest-snaps-token').value = '';
      if (result.shortlink?.error || result.shortlink?.ok === false) {
        toast(result.shortlink.error || result.shortlink.lastCheckDetail || 'Short link was not created', 'bad');
      } else {
        toast('Guest Snaps settings saved', 'ok');
      }
    } catch (error) {
      toast(error.message || 'Could not save Guest Snaps settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-guest-snaps-check')?.addEventListener('click', async () => {
    const button = $('btn-guest-snaps-check');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/guest-snaps/check', {
        preferredAlias: $('guest-snaps-alias')?.value || '',
      });
      renderGuestSnapsSettings(result);
      if (result.shortlink?.error || result.shortlink?.ok === false) {
        toast(result.shortlink.error || result.shortlink.lastCheckDetail || 'Check failed', 'bad');
      } else {
        toast(result.shortlink?.health === 'healthy' ? 'Short link is healthy' : 'Short link checked', 'ok');
      }
    } catch (error) {
      toast(error.message || 'Check failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadGuestSnapsSettings();

  // ------------------------------------------- Settings → Guest Book

  function formatShortlinkCheck(link = {}) {
    if (!link.lastCheckAt) return 'Last check —';
    const at = new Date(link.lastCheckAt);
    if (Number.isNaN(at.getTime())) return 'Last check —';
    const detail = link.lastCheckDetail ? ` · ${link.lastCheckDetail}` : '';
    return `Checked ${at.toLocaleString()} ${detail}`.replace(/\s+/g, ' ').trim();
  }

  function syncGuestBookRateFields() {
    const on = Boolean($('guest-book-rate-on')?.checked);
    ['guest-book-rate', 'guest-book-window', 'guest-book-daily'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !on;
    });
  }

  function renderGuestBookSettings(data = {}) {
    const settings = data.settings || {};
    const creds = data.credentials || {};
    const link = data.shortlink || {};
    const alias = $('guest-book-alias');
    if (alias && document.activeElement !== alias) {
      alias.value = settings.preferredAlias || '';
    }
    const setCheck = (id, on) => {
      const el = $(id);
      if (el) el.checked = Boolean(on);
    };
    setCheck('guest-book-enabled', settings.enabled !== false);
    setCheck('guest-book-paused', settings.paused);
    setCheck('guest-book-wake', settings.guestsMayWake);
    setCheck('guest-book-approval', settings.approval);
    setCheck('guest-book-blocked-on', settings.blockedWordsEnabled);
    setCheck('guest-book-rate-on', settings.rateLimitEnabled !== false);
    syncGuestBookRateFields();
    const inviteFooter = $('guest-book-invite-footer');
    if (inviteFooter && document.activeElement !== inviteFooter) {
      inviteFooter.value = settings.inviteFooter === 'always' ? 'always' : 'whenRoom';
    }
    const who = $('guest-book-who');
    if (who && document.activeElement !== who) {
      who.value = settings.whoCanSend || 'anyone';
    }
    const rate = $('guest-book-rate');
    if (rate && document.activeElement !== rate) rate.value = String(settings.ratePerGuest || 3);
    const windowEl = $('guest-book-window');
    if (windowEl && document.activeElement !== windowEl) {
      windowEl.value = String(settings.rateWindowMinutes || 10);
    }
    const daily = $('guest-book-daily');
    if (daily && document.activeElement !== daily) daily.value = String(settings.dailyCap || 100);
    const blocked = $('guest-book-blocked-words');
    if (blocked && document.activeElement !== blocked) {
      blocked.value = (settings.blockedWords || []).join('\n');
    }
    const codeHint = $('guest-book-code-hint');
    if (codeHint) {
      const pin = data.boardCode || '';
      codeHint.hidden = !pin;
      codeHint.textContent = pin ? `Today's board code is ${pin}` : '';
    }
    const token = $('guest-book-token');
    if (token && document.activeElement !== token) {
      token.value = '';
      token.placeholder = creds.hasToken
        ? (creds.tokenHint ? `Saved (…${creds.tokenHint})` : 'Token saved')
        : 'Paste token, or set TINYURL_API_TOKEN in .env';
    }
    const hint = $('guest-book-token-hint');
    if (hint) {
      if (creds.envBlocksOverwrite) {
        hint.textContent = 'TINYURL_API_TOKEN is set in .env and cannot be replaced here.';
      } else if (creds.hasOverride) {
        hint.textContent = creds.tokenHint
          ? `Override saved (…${creds.tokenHint}). Paste a new one to replace it.`
          : 'Override saved. Paste a new one to replace it.';
      } else if (creds.usingGlobal && creds.hasToken) {
        hint.textContent = 'Using the global token. Paste one here only if this feature needs its own.';
      } else if (creds.hasToken) {
        hint.textContent = creds.tokenHint
          ? `Token saved (…${creds.tokenHint}). Paste a new one to replace it.`
          : 'Token saved. Paste a new one to replace it.';
      } else {
        hint.textContent = 'Optional. Uses the global TinyURL token unless you paste one here.';
      }
    }
    const clearOverride = $('guest-book-clear-override');
    if (clearOverride) clearOverride.checked = false;

    const health = link.health || (link.alias ? 'unknown' : 'missing');
    const pill = $('guest-book-status-pill');
    const detail = $('guest-book-status-detail');
    const dot = $('guest-book-dot');
    const label = $('guest-book-shortlink-label');
    const check = $('guest-book-shortlink-check');
    const tone = health === 'healthy'
      ? 'ok'
      : (health === 'unhealthy' || link.alert ? 'bad' : 'warn');
    if (pill) {
      const text = link.alert
        ? 'Needs repair'
        : health === 'healthy'
          ? 'Active'
          : health === 'missing'
            ? 'Not set'
            : 'Unknown';
      pill.textContent = text;
      pill.className = `status-pill ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = link.alert?.message
        || (link.display
          ? `Short link ${link.display}`
          : 'Short link to /guestbook/. Guests write a message on their phone.');
    }
    if (dot) {
      dot.className = `gb-dot ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    }
    if (label) {
      label.textContent = link.display || 'No short link yet.';
    }
    if (check) {
      check.textContent = formatShortlinkCheck(link);
    }
  }

  async function loadGuestBookSettings() {
    try {
      const data = await apiGet('/api/guest-book/settings');
      renderGuestBookSettings(data);
    } catch {
      renderGuestBookSettings({});
    }
  }

  $('btn-guest-book-save')?.addEventListener('click', async () => {
    const button = $('btn-guest-book-save');
    if (button) button.disabled = true;
    try {
      const body = {
        preferredAlias: $('guest-book-alias')?.value || '',
        enabled: Boolean($('guest-book-enabled')?.checked),
        paused: Boolean($('guest-book-paused')?.checked),
        whoCanSend: $('guest-book-who')?.value || 'anyone',
        inviteFooter: $('guest-book-invite-footer')?.value === 'always' ? 'always' : 'whenRoom',
        guestsMayWake: Boolean($('guest-book-wake')?.checked),
        approval: Boolean($('guest-book-approval')?.checked),
        rateLimitEnabled: Boolean($('guest-book-rate-on')?.checked),
        ratePerGuest: Number($('guest-book-rate')?.value || 3),
        rateWindowMinutes: Number($('guest-book-window')?.value || 10),
        dailyCap: Number($('guest-book-daily')?.value || 100),
        blockedWordsEnabled: Boolean($('guest-book-blocked-on')?.checked),
        blockedWords: String($('guest-book-blocked-words')?.value || '')
          .split(/[\n,]+/)
          .map((word) => word.trim())
          .filter(Boolean),
      };
      const password = String($('guest-book-password')?.value || '').trim();
      if (password) body.password = password;
      const token = String($('guest-book-token')?.value || '').trim();
      if (token) body.apiToken = token;
      if ($('guest-book-clear-override')?.checked) body.clearOverride = true;
      const result = await apiPost('/api/guest-book/settings', body);
      renderGuestBookSettings(result);
      if ($('guest-book-token')) $('guest-book-token').value = '';
      if ($('guest-book-password')) $('guest-book-password').value = '';
      if (result.shortlink?.error || result.shortlink?.ok === false) {
        toast(result.shortlink.error || result.shortlink.lastCheckDetail || 'Short link was not created', 'bad');
      } else {
        toast('Guest Book settings saved', 'ok');
      }
    } catch (error) {
      toast(error.message || 'Could not save Guest Book settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('guest-book-rate-on')?.addEventListener('change', syncGuestBookRateFields);

  $('btn-guest-book-check')?.addEventListener('click', async () => {
    const button = $('btn-guest-book-check');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/guest-book/check', {
        preferredAlias: $('guest-book-alias')?.value || '',
      });
      renderGuestBookSettings(result);
      if (result.shortlink?.error || result.shortlink?.ok === false) {
        toast(result.shortlink.error || result.shortlink.lastCheckDetail || 'Check failed', 'bad');
      } else {
        toast(result.shortlink?.health === 'healthy' ? 'Short link is healthy' : 'Short link checked', 'ok');
      }
    } catch (error) {
      toast(error.message || 'Check failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadGuestBookSettings();

  // ---------- Ring Doorbell ----------
  let ringPreviewTimer = null;

  function ringConnectionClass(state) {
    switch (String(state || '')) {
      case 'listening': return 'ok';
      case 'connecting': return 'warn';
      case 'error': return 'bad';
      case 'needs_auth': return 'warn';
      case 'disabled': return 'warn';
      default: return '';
    }
  }

  function showRing2fa(prompt) {
    const login = $('ring-login-block');
    const twofa = $('ring-2fa-block');
    if (login) login.hidden = true;
    if (twofa) twofa.hidden = false;
    const hint = $('ring-2fa-prompt');
    if (hint) hint.textContent = prompt || 'Enter the code Ring sent you.';
    $('ring-2fa-code')?.focus();
  }

  function showRingLogin() {
    const login = $('ring-login-block');
    const twofa = $('ring-2fa-block');
    if (login) login.hidden = false;
    if (twofa) twofa.hidden = true;
    const code = $('ring-2fa-code');
    if (code) code.value = '';
  }

  function renderRingSettings(data = {}) {
    setChecked('ring-enabled', data.enabled !== false);
    setChecked('ring-push-ding', data.pushOnDing !== false);
    setChecked('ring-push-motion', Boolean(data.pushOnMotion));
    setChecked('ring-show-time', data.showTime !== false);
    setChecked('ring-quiet-exempt', data.quietHoursExempt !== false);
    const title = $('ring-title');
    if (title && document.activeElement !== title) {
      title.value = data.title || 'Ring Door Bell';
    }
    const message = $('ring-message');
    if (message && document.activeElement !== message) {
      message.value = data.message || 'Someone is at your front door';
    }
    const pill = $('ring-status-pill');
    const detail = $('ring-status-detail');
    const conn = data.connection || {};
    const state = conn.state || (data.configured ? 'idle' : 'needs_auth');
    if (pill) {
      pill.textContent = data.pending2fa
        ? 'Needs 2FA'
        : state === 'listening'
          ? 'Listening'
          : state === 'connecting'
            ? 'Connecting'
            : state === 'needs_auth'
              ? 'Needs auth'
              : state === 'disabled'
                ? 'Off'
                : state === 'error'
                  ? 'Error'
                  : data.configured ? 'Ready' : 'Not linked';
      pill.className = `status-pill ${ringConnectionClass(data.pending2fa ? 'needs_auth' : state)}`;
    }
    if (detail) {
      const bits = [
        data.pending2fa
          ? (data.twoFactorPrompt || 'Enter the verification code from Ring.')
          : (conn.detail || 'Sign in with your Ring email and password.'),
      ];
      if (data.tokenSource === 'env') {
        bits.push('Token comes from RING_REFRESH_TOKEN in .env.');
      } else if (data.hasToken && data.tokenHint) {
        bits.push(`Saved token …${data.tokenHint}`);
      }
      if (conn.lastError) {
        bits.push(conn.lastError);
      }
      detail.textContent = bits.join(' ');
    }
    if (data.pending2fa) {
      showRing2fa(data.twoFactorPrompt);
    } else if (!document.activeElement || !['ring-email', 'ring-password', 'ring-2fa-code'].includes(document.activeElement.id)) {
      showRingLogin();
    }
    const cameras = $('ring-cameras');
    if (cameras) {
      const list = Array.isArray(data.cameras) ? data.cameras : [];
      if (!list.length) {
        cameras.textContent = data.listening
          ? 'Connected — no cameras found on this account.'
          : 'Cameras appear after a successful connect.';
      } else {
        cameras.textContent = `Cameras: ${list.map((cam) => cam.name || cam.id).join(', ')}`;
      }
    }
    scheduleRingPreview();
  }

  async function refreshRingPreview() {
    const host = $('ring-preview');
    if (!host) return;
    try {
      const data = await apiPost('/api/ring/preview', {
        title: $('ring-title')?.value || '',
        message: $('ring-message')?.value || '',
        showTime: Boolean($('ring-show-time')?.checked),
      });
      if (Array.isArray(data.rows)) {
        renderVbGrid(host, data.rows);
      }
    } catch {
      // Keep the last good preview if the bridge is mid-restart.
    }
  }

  function scheduleRingPreview() {
    clearTimeout(ringPreviewTimer);
    ringPreviewTimer = setTimeout(() => {
      refreshRingPreview();
    }, 180);
  }

  async function loadRingSettings() {
    try {
      const data = await apiGet('/api/ring/settings');
      renderRingSettings(data);
    } catch (error) {
      const pill = $('ring-status-pill');
      if (pill) {
        pill.textContent = 'Unavailable';
        pill.className = 'status-pill bad';
      }
      const detail = $('ring-status-detail');
      if (detail) detail.textContent = error.message || 'Could not load Ring settings';
    }
  }

  function ringSettingsBody() {
    return {
      enabled: Boolean($('ring-enabled')?.checked),
      title: $('ring-title')?.value || '',
      message: $('ring-message')?.value || '',
      pushOnDing: Boolean($('ring-push-ding')?.checked),
      pushOnMotion: Boolean($('ring-push-motion')?.checked),
      showTime: Boolean($('ring-show-time')?.checked),
      quietHoursExempt: Boolean($('ring-quiet-exempt')?.checked),
    };
  }

  ['ring-title', 'ring-message'].forEach((id) => {
    $(id)?.addEventListener('input', scheduleRingPreview);
  });
  $('ring-show-time')?.addEventListener('change', scheduleRingPreview);

  $('btn-ring-save')?.addEventListener('click', async () => {
    const button = $('btn-ring-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/settings', ringSettingsBody());
      renderRingSettings(result);
      toast('Ring settings saved', 'ok');
    } catch (error) {
      toast(error.message || 'Save failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-reset')?.addEventListener('click', async () => {
    const button = $('btn-ring-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/settings', { reset: true });
      renderRingSettings(result);
      toast('Ring defaults restored', 'ok');
    } catch (error) {
      toast(error.message || 'Reset failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button) button.disabled = true;
    try {
      await apiPost('/api/push/ring-doorbell', withTarget({
        title: $('ring-title')?.value || '',
        message: $('ring-message')?.value || '',
        showTime: Boolean($('ring-show-time')?.checked),
      }));
      toast('Ring preview pushed', 'ok');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-auth')?.addEventListener('click', async () => {
    const button = $('btn-ring-auth');
    const input = $('ring-token-input');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/auth/link', {
        refreshToken: input?.value || '',
      });
      if (input) input.value = '';
      renderRingSettings(result);
      toast(result.listening ? 'Ring is listening' : 'Ring token saved', 'ok');
    } catch (error) {
      toast(error.message || 'Connect failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-login')?.addEventListener('click', async () => {
    const button = $('btn-ring-login');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/auth/login', {
        email: $('ring-email')?.value || '',
        password: $('ring-password')?.value || '',
      });
      const password = $('ring-password');
      if (password) password.value = '';
      if (result.needs2fa) {
        showRing2fa(result.prompt);
        toast('Enter your Ring verification code', 'ok');
        return;
      }
      showRingLogin();
      renderRingSettings(result);
      toast(result.listening ? 'Ring is listening' : 'Signed in to Ring', 'ok');
    } catch (error) {
      toast(error.message || 'Sign-in failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-verify')?.addEventListener('click', async () => {
    const button = $('btn-ring-verify');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/auth/verify', {
        code: $('ring-2fa-code')?.value || '',
      });
      showRingLogin();
      renderRingSettings(result);
      toast(result.listening ? 'Ring is listening' : 'Signed in to Ring', 'ok');
    } catch (error) {
      if (error?.data?.needs2fa || error?.data?.prompt) {
        showRing2fa(error.data.prompt || error.message);
      }
      toast(error.message || 'Verification failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-cancel-2fa')?.addEventListener('click', () => {
    showRingLogin();
  });

  $('btn-ring-clear')?.addEventListener('click', async () => {
    const button = $('btn-ring-clear');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/auth/clear', {});
      renderRingSettings(result);
      toast('Ring session cleared', 'ok');
    } catch (error) {
      toast(error.message || 'Clear failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-ring-reconnect')?.addEventListener('click', async () => {
    const button = $('btn-ring-reconnect');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/ring/reconnect', {});
      renderRingSettings(result);
      toast(result.listening ? 'Listening again' : (result.connection?.detail || 'Reconnect finished'), 'ok');
    } catch (error) {
      toast(error.message || 'Reconnect failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  loadRingSettings();

  const GB_BOOK_PAGE_SIZE = 10;
  let guestBookPage = 1;
  let guestBookPages = 1;
  let guestBookTotal = 0;
  let guestBookFilter = 'all';
  let guestBookWaitingCount = 0;
  let guestBookSelected = new Set();
  let guestBookPageIds = [];
  /** id → { status, at } for the current page (bulk action gating). */
  let guestBookPageMeta = new Map();

  function guestBookStatusLabel(status) {
    switch (String(status || '')) {
      case 'waiting': return 'Waiting for approval';
      case 'released': return 'Released';
      case 'held': return 'Held for quiet hours';
      case 'queued': return 'Queued';
      case 'shown': return 'Shown';
      default: return status || '';
    }
  }

  function selectedGuestBookEntries() {
    return [...guestBookSelected]
      .map((id) => {
        const meta = guestBookPageMeta.get(id);
        return meta ? { id, ...meta } : null;
      })
      .filter(Boolean);
  }

  function syncGuestBookSelectionUi() {
    const bulk = $('guest-book-bulk');
    const deleteBtn = $('btn-guest-book-delete-selected');
    const releaseBtn = $('btn-guest-book-release-selected');
    const pushBtn = $('btn-guest-book-push-selected');
    const bulkLabel = $('guest-book-bulk-label');
    const count = guestBookSelected.size;
    const selected = selectedGuestBookEntries();
    const allWaiting = count > 0 && selected.length === count
      && selected.every((entry) => entry.status === 'waiting');
    const pushable = selected.filter((entry) => entry.status !== 'waiting');
    if (bulk) bulk.hidden = count === 0;
    if (bulkLabel) {
      bulkLabel.textContent = count === 1 ? '1 selected' : `${count} selected`;
    }
    if (deleteBtn) {
      deleteBtn.textContent = count === 1 ? 'Delete' : `Delete ${count}`;
    }
    if (releaseBtn) {
      releaseBtn.hidden = !allWaiting;
      releaseBtn.textContent = count === 1 ? 'Release' : `Release ${count}`;
    }
    if (pushBtn) {
      pushBtn.hidden = pushable.length === 0;
      pushBtn.textContent = pushable.length === 1
        ? 'Push to board'
        : `Push ${pushable.length} to board`;
    }
    document.querySelectorAll('#guest-book-list .gb-book-entry').forEach((card) => {
      const id = card.getAttribute('data-book-id');
      const on = guestBookSelected.has(id);
      card.classList.toggle('is-selected', on);
      const box = card.querySelector('[data-book-select]');
      if (box) box.checked = on;
    });
  }

  let guestBookPendingDeleteIds = [];

  function openGuestBookDeleteConfirm(ids) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return;
    guestBookPendingDeleteIds = list;
    const title = $('guest-book-delete-title');
    if (title) {
      title.textContent = list.length === 1
        ? 'Delete this message?'
        : `Delete ${list.length} messages?`;
    }
    const sheet = $('guest-book-delete-sheet');
    if (sheet) sheet.hidden = false;
  }

  function closeGuestBookDeleteConfirm() {
    const sheet = $('guest-book-delete-sheet');
    if (sheet) sheet.hidden = true;
    guestBookPendingDeleteIds = [];
  }

  async function confirmGuestBookDelete() {
    const list = [...guestBookPendingDeleteIds];
    if (!list.length) {
      closeGuestBookDeleteConfirm();
      return;
    }
    const confirmBtn = $('guest-book-delete-confirm');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      const result = list.length === 1
        ? await apiPost('/api/guest-book/delete', { id: list[0] })
        : await apiPost('/api/guest-book/delete', { ids: list });
      list.forEach((id) => guestBookSelected.delete(id));
      const deleted = Number(result?.deleted || list.length);
      toast(
        deleted === 1 ? 'Deleted from The Book' : `Deleted ${deleted} from The Book`,
        'ok',
      );
      closeGuestBookDeleteConfirm();
      const remainingOnPage = guestBookPageIds.filter((id) => !list.includes(id)).length;
      if (!remainingOnPage && guestBookPage > 1) guestBookPage -= 1;
      await renderGuestBookList();
    } catch (error) {
      toast(error.message || 'Delete failed', 'bad');
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  function deleteGuestBookEntries(ids) {
    openGuestBookDeleteConfirm(ids);
  }

  function updateGuestBookPager() {
    const label = $('guest-book-page-label');
    const prev = $('btn-guest-book-prev');
    const next = $('btn-guest-book-next');
    if (label) {
      label.textContent = guestBookTotal
        ? `Page ${guestBookPage} of ${guestBookPages}`
        : 'No pages';
    }
    if (prev) prev.disabled = guestBookPage <= 1;
    if (next) next.disabled = guestBookPage >= guestBookPages || !guestBookTotal;
  }

  async function renderGuestBookList({ resetSelection = false } = {}) {
    const host = $('guest-book-list');
    const summary = $('guest-book-sheet-summary');
    if (!host) return;
    if (resetSelection) guestBookSelected = new Set();
    try {
      const filterQs = guestBookFilter !== 'all' ? `&status=${encodeURIComponent(guestBookFilter)}` : '';
      const data = await apiGet(
        `/api/guest-book/book?page=${guestBookPage}&pageSize=${GB_BOOK_PAGE_SIZE}${filterQs}`,
      );
      const entries = data.entries || [];
      guestBookTotal = Number(data.total || 0);
      guestBookPages = Math.max(1, Number(data.pages || 1));
      guestBookPage = Math.min(guestBookPages, Math.max(1, Number(data.page || 1)));
      guestBookWaitingCount = Number(data.waiting || 0);
      guestBookPageIds = entries.map((entry) => entry.id).filter(Boolean);
      guestBookPageMeta = new Map(
        entries
          .filter((entry) => entry.id)
          .map((entry) => [entry.id, { status: entry.status || '', at: entry.at || '' }]),
      );
      if (summary) {
        const waitingNote = guestBookWaitingCount
          ? ` · ${guestBookWaitingCount} waiting for approval`
          : '';
        if (!guestBookTotal) {
          summary.textContent = guestBookFilter === 'waiting'
            ? 'Nothing waiting for approval.'
            : guestBookFilter === 'released'
              ? 'No released messages yet.'
              : 'No guest messages yet.';
        } else if (guestBookFilter === 'all') {
          summary.textContent = `${guestBookTotal} message${guestBookTotal === 1 ? '' : 's'} in The Book${waitingNote}.`;
        } else if (guestBookFilter === 'waiting') {
          summary.textContent = `${guestBookTotal} waiting for approval.`;
        } else {
          summary.textContent = `${guestBookTotal} released message${guestBookTotal === 1 ? '' : 's'}.`;
        }
      }
      host.innerHTML = entries.map((entry) => {
        const when = entry.at
          ? new Date(entry.at).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
          : '';
        const from = entry.name || 'Anonymous';
        const ip = entry.ip ? ` · ${entry.ip}` : '';
        const checked = guestBookSelected.has(entry.id) ? ' checked' : '';
        const selected = guestBookSelected.has(entry.id) ? ' is-selected' : '';
        const waiting = entry.status === 'waiting';
        const badge = waiting
          ? '<span class="gb-book-badge is-waiting">Needs approval</span>'
          : entry.status === 'released'
            ? '<span class="gb-book-badge is-released">Released</span>'
            : '';
        const releaseBtn = waiting
          ? '<button type="button" class="btn btn-accent btn-sm" data-book-release>Release</button>'
          : '';
        const replayBtn = waiting
          ? ''
          : '<button type="button" class="btn btn-outline btn-sm" data-book-replay>Replay</button>';
        return `
        <article class="gb-book-entry${selected}${waiting ? ' is-waiting' : ''}" data-book-id="${escapeHtml(entry.id)}" data-book-status="${escapeHtml(entry.status || '')}">
          <label class="gb-book-check">
            <input type="checkbox" data-book-select aria-label="Select message"${checked}>
          </label>
          <div class="gb-book-meta">
            <div class="gb-book-row-head">
              <strong>From: ${escapeHtml(from)}</strong>
              ${badge}
            </div>
            <span class="hint">${escapeHtml(when)}${escapeHtml(ip)} · ${escapeHtml(guestBookStatusLabel(entry.status))}</span>
            <div class="gb-book-actions">
              ${releaseBtn}
              ${replayBtn}
              <button type="button" class="btn btn-danger btn-sm" data-book-delete>Delete</button>
            </div>
          </div>
          <div class="vb-bezel preview-bezel gb-book-bezel" aria-hidden="true">
            <div class="vb-grid" data-book-preview></div>
            <div class="vb-wordmark">VESTABOARD</div>
          </div>
        </article>`;
      }).join('');
      host.querySelectorAll('.gb-book-entry').forEach((card, index) => {
        const entry = entries[index];
        renderFlapGrid(
          card.querySelector('[data-book-preview]'),
          entry?.previewRows || entry?.rows,
        );
      });
      updateGuestBookPager();
      syncGuestBookSelectionUi();
    } catch (error) {
      if (summary) summary.textContent = error.message || 'Could not load The Book.';
      host.innerHTML = '';
      guestBookPageIds = [];
      guestBookPageMeta = new Map();
      updateGuestBookPager();
      syncGuestBookSelectionUi();
    }
  }

  function openGuestBookSheet() {
    const sheet = $('guest-book-sheet');
    if (sheet) sheet.hidden = false;
    document.documentElement.classList.add('gb-book-open');
    guestBookPage = 1;
    guestBookFilter = 'all';
    document.querySelectorAll('#guest-book-filter [data-book-filter]').forEach((button) => {
      const on = button.getAttribute('data-book-filter') === 'all';
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderGuestBookList({ resetSelection: true });
  }

  function closeGuestBookSheet() {
    const sheet = $('guest-book-sheet');
    if (sheet) sheet.hidden = true;
    document.documentElement.classList.remove('gb-book-open');
    guestBookSelected = new Set();
    closeGuestBookDeleteConfirm();
  }

  $('btn-guest-book-invite')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/guest-book-invite', withTarget());
      toast(result.shortLabel ? `Invite on the board · ${result.shortLabel}` : 'Invite on the board', 'good');
    } catch (error) {
      toast(error?.message || 'Guest Book invite push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-guest-book-open')?.addEventListener('click', () => openGuestBookSheet());
  $('btn-guest-book-sheet-close')?.addEventListener('click', () => closeGuestBookSheet());
  registerSheetDismiss('guest-book-sheet', () => closeGuestBookSheet());
  registerSheetDismiss('guest-book-delete-sheet', () => closeGuestBookDeleteConfirm());
  $('guest-book-delete-cancel')?.addEventListener('click', () => closeGuestBookDeleteConfirm());
  $('guest-book-delete-confirm')?.addEventListener('click', () => confirmGuestBookDelete());

  $('btn-guest-book-prev')?.addEventListener('click', () => {
    if (guestBookPage <= 1) return;
    guestBookPage -= 1;
    renderGuestBookList();
  });
  $('btn-guest-book-next')?.addEventListener('click', () => {
    if (guestBookPage >= guestBookPages) return;
    guestBookPage += 1;
    renderGuestBookList();
  });

  $('guest-book-filter')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-book-filter]');
    if (!button) return;
    const next = button.getAttribute('data-book-filter') || 'all';
    if (next === guestBookFilter) return;
    guestBookFilter = next;
    guestBookPage = 1;
    document.querySelectorAll('#guest-book-filter [data-book-filter]').forEach((entry) => {
      const on = entry === button;
      entry.classList.toggle('active', on);
      entry.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderGuestBookList({ resetSelection: true });
  });

  $('btn-guest-book-delete-selected')?.addEventListener('click', () => {
    deleteGuestBookEntries([...guestBookSelected]);
  });

  $('btn-guest-book-release-selected')?.addEventListener('click', async () => {
    const ids = selectedGuestBookEntries()
      .filter((entry) => entry.status === 'waiting')
      .map((entry) => entry.id);
    if (!ids.length) return;
    const button = $('btn-guest-book-release-selected');
    if (button) button.disabled = true;
    try {
      const result = ids.length === 1
        ? await apiPost('/api/guest-book/release', { id: ids[0] })
        : await apiPost('/api/guest-book/release', { ids });
      const count = Number(result?.released || ids.length);
      ids.forEach((id) => guestBookSelected.delete(id));
      toast(count === 1 ? 'Released to the board' : `Released ${count} to the board`, 'ok');
      await renderGuestBookList();
    } catch (error) {
      toast(error.message || 'Release failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-guest-book-push-selected')?.addEventListener('click', async () => {
    const ids = selectedGuestBookEntries()
      .filter((entry) => entry.status !== 'waiting')
      .map((entry) => entry.id);
    if (!ids.length) return;
    const button = $('btn-guest-book-push-selected');
    if (button) button.disabled = true;
    try {
      const result = ids.length === 1
        ? await apiPost('/api/guest-book/replay', { id: ids[0] })
        : await apiPost('/api/guest-book/replay', { ids });
      const count = Number(result?.pushed || ids.length);
      toast(count === 1 ? 'Pushed to the board' : `Pushed ${count} to the board`, 'ok');
      await renderGuestBookList();
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  // Wheel on the dimmed backdrop (outside the sheet) must not move Settings.
  $('guest-book-sheet')?.addEventListener('wheel', (event) => {
    const sheet = event.currentTarget.querySelector('.sheet');
    if (sheet?.contains(event.target)) return;
    event.preventDefault();
  }, { passive: false });

  $('guest-book-list')?.addEventListener('change', (event) => {
    const box = event.target.closest('[data-book-select]');
    const card = event.target.closest('.gb-book-entry');
    if (!box || !card) return;
    const id = card.getAttribute('data-book-id');
    if (!id) return;
    if (box.checked) guestBookSelected.add(id);
    else guestBookSelected.delete(id);
    syncGuestBookSelectionUi();
  });

  $('guest-book-list')?.addEventListener('click', async (event) => {
    const card = event.target.closest('.gb-book-entry');
    if (!card) return;
    const id = card.getAttribute('data-book-id');
    if (event.target.closest('[data-book-select]') || event.target.closest('.gb-book-check')) {
      return;
    }
    if (event.target.closest('[data-book-release]')) {
      const button = event.target.closest('[data-book-release]');
      button.disabled = true;
      try {
        await apiPost('/api/guest-book/release', { id });
        toast('Released to the board', 'ok');
        guestBookSelected.delete(id);
        await renderGuestBookList();
      } catch (error) {
        toast(error.message || 'Release failed', 'bad');
        button.disabled = false;
      }
      return;
    }
    if (event.target.closest('[data-book-replay]')) {
      try {
        await apiPost('/api/guest-book/replay', { id });
        toast('Replayed to the board', 'ok');
        renderGuestBookList();
      } catch (error) {
        toast(error.message || 'Replay failed', 'bad');
      }
      return;
    }
    if (event.target.closest('[data-book-delete]')) {
      await deleteGuestBookEntries([id]);
    }
  });

  // ------------------------------------------ Settings → Weather Alerts

  function renderWeatherAlertsSettings(data = {}) {
    const settings = data.settings || {};
    const severity = $('weather-alerts-min-severity');
    const maxAlerts = $('weather-alerts-max');
    const watches = $('weather-alerts-watches');
    const advisories = $('weather-alerts-advisories');
    if (severity && document.activeElement !== severity) {
      severity.value = settings.minSeverity || 'Minor';
    }
    if (maxAlerts && document.activeElement !== maxAlerts) {
      maxAlerts.value = String(settings.maxAlerts || 3);
    }
    if (watches) watches.checked = settings.includeWatches !== false;
    if (advisories) advisories.checked = settings.includeAdvisories !== false;

    const pill = $('weather-alerts-status-pill');
    const detail = $('weather-alerts-status-detail');
    const location = $('weather-alerts-location');
    const hasPin = Boolean(data.hasLocation);
    if (pill) {
      pill.textContent = hasPin ? 'Ready' : 'Needs pin';
      pill.className = `status-pill ${hasPin ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = hasPin
        ? 'Active U.S. National Weather Service alerts for the house pin. Free — no API key.'
        : 'Set the house location under Location, then push Weather Alerts.';
    }
    if (location) {
      const loc = data.location || {};
      if (!hasPin) {
        location.textContent = 'Set a city or ZIP under Location.';
      } else {
        location.textContent = `${loc.label || loc.city || 'Home'}`
          + (loc.timeZone ? ` · ${loc.timeZone}` : '')
          + ' · NWS';
      }
    }
  }

  async function loadWeatherAlertsSettings() {
    try {
      const data = await apiGet('/api/weather-alerts/settings');
      renderWeatherAlertsSettings(data);
    } catch (_error) {
      renderWeatherAlertsSettings({});
    }
  }

  $('btn-weather-alerts-save')?.addEventListener('click', async () => {
    const button = $('btn-weather-alerts-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/weather-alerts/settings', {
        minSeverity: $('weather-alerts-min-severity')?.value,
        maxAlerts: Number($('weather-alerts-max')?.value || 3),
        includeWatches: Boolean($('weather-alerts-watches')?.checked),
        includeAdvisories: Boolean($('weather-alerts-advisories')?.checked),
      });
      renderWeatherAlertsSettings(result);
      toast('Weather alert filters saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save weather alert filters', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-weather-alerts-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/weather-alerts', withTarget());
      if (result.mode === 'alerts') {
        const count = result.alerts?.length || 0;
        const first = result.alerts?.[0]?.event || 'Alert';
        toast(`${first}${count > 1 ? ` (+${count - 1})` : ''}`, 'good');
      } else if (result.mode === 'outside-us') {
        toast('NWS alerts need a U.S. house pin', 'bad');
      } else {
        toast('All clear — no active alerts', 'good');
      }
    } catch (error) {
      toast(error?.message || 'Weather Alerts push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadWeatherAlertsSettings();

  // ----------------------------------------- Settings → World Population

  function formatWorldPopNumber(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
      return '';
    }
    return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatWorldPopRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return '';
    }
    const fixed = Math.abs(number) >= 10 ? number.toFixed(0) : number.toFixed(1);
    return fixed.replace(/\.0$/, '');
  }

  function renderWorldPopulationPreview(data = {}) {
    const host = $('world-population-preview');
    if (!host) {
      return;
    }
    const estimate = data.estimate || {};
    const formatted = data.formatted || formatWorldPopNumber(estimate.population);
    const births = formatWorldPopRate(estimate.birthsPerSec);
    const deaths = formatWorldPopRate(estimate.deathsPerSec);
    const net = formatWorldPopRate(estimate.netPerSec);
    const detail = (births && deaths) ? `B ${births}/S  D ${deaths}/S` : '';
    const rate = net ? `NET +${net} / SECOND` : '';
    const source = String(data.settings?.sourceLabel || estimate.sourceLabel || 'ESTIMATE').slice(0, 18);
    const lines = [
      'WORLD POPULATION',
      '',
      formatted,
      detail || rate,
      detail ? rate : '',
      source,
    ];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines.slice(0, 6));
  }

  function renderWorldPopulationSettings(data = {}) {
    const settings = data.settings || {};
    const estimate = data.estimate || {};
    const fields = {
      'world-pop-base': settings.basePopulation,
      'world-pop-base-at': settings.baseAt,
      'world-pop-births': settings.birthsPerYear,
      'world-pop-deaths': settings.deathsPerYear,
      'world-pop-source': settings.sourceLabel,
    };
    Object.entries(fields).forEach(([id, value]) => {
      const input = $(id);
      if (input && document.activeElement !== input) {
        input.value = value == null ? '' : String(value);
      }
    });
    const pill = $('world-population-status-pill');
    const detail = $('world-population-status-detail');
    const live = $('world-population-live');
    const rates = $('world-population-rates');
    const formatted = data.formatted || formatWorldPopNumber(estimate.population);
    if (pill) {
      pill.textContent = formatted ? 'Live' : '…';
      pill.className = `status-pill ${formatted ? 'is-ok' : ''}`;
    }
    if (detail) {
      detail.textContent = formatted
        ? `${formatted} people · estimated from your baseline`
        : 'Estimated live headcount from a UN-style baseline — no network call.';
    }
    if (live) {
      live.textContent = formatted || '…';
    }
    if (rates) {
      const births = formatWorldPopRate(estimate.birthsPerSec);
      const deaths = formatWorldPopRate(estimate.deathsPerSec);
      const net = formatWorldPopRate(estimate.netPerSec);
      rates.textContent = (births && deaths && net)
        ? `+${net}/s net · ${births} births/s · ${deaths} deaths/s`
        : '…';
    }
    renderWorldPopulationPreview(data);
  }

  async function loadWorldPopulationSettings() {
    try {
      const data = await apiGet('/api/world-population/settings');
      renderWorldPopulationSettings(data);
    } catch (_error) {
      renderWorldPopulationSettings({});
    }
  }

  function readWorldPopulationForm() {
    return {
      basePopulation: $('world-pop-base')?.value,
      baseAt: $('world-pop-base-at')?.value,
      birthsPerYear: $('world-pop-births')?.value,
      deathsPerYear: $('world-pop-deaths')?.value,
      sourceLabel: $('world-pop-source')?.value,
    };
  }

  $('btn-world-population-save')?.addEventListener('click', async () => {
    const button = $('btn-world-population-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/world-population/settings', readWorldPopulationForm());
      renderWorldPopulationSettings(result);
      toast('World population model saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save population model', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-world-population-reset')?.addEventListener('click', async () => {
    const button = $('btn-world-population-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/world-population/settings', { reset: true });
      renderWorldPopulationSettings(result);
      toast('Reset to UN defaults', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset population model', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-world-population-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/world-population', withTarget());
      const count = result.population?.formatted || 'World population';
      toast(count, 'good');
    } catch (error) {
      toast(error?.message || 'World Population push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadWorldPopulationSettings();
  window.setInterval(() => {
    if (document.hidden) return;
    if (!$('world-population-settings-card')) return;
    const view = typeof currentSettingsView === 'function' ? currentSettingsView() : 'global';
    if (view !== 'global' && view !== 'all') return;
    loadWorldPopulationSettings();
  }, 5000);

  // ------------------------------------------- Settings → Calendar Clock

  const CALENDAR_CLOCK_CHIP_COLORS = new Set([
    'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white',
  ]);

  function calendarClockWeekStart() {
    const active = document.querySelector('#calendar-clock-week-start .segmented-btn.active');
    return active?.dataset?.weekStart === 'monday' ? 'monday' : 'sunday';
  }

  function setCalendarClockWeekStart(value) {
    const want = value === 'monday' ? 'monday' : 'sunday';
    document.querySelectorAll('#calendar-clock-week-start .segmented-btn').forEach((btn) => {
      const on = btn.dataset.weekStart === want;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function placeCalendarClockText(grid, text, row, startCol) {
    const body = String(text || '').toUpperCase();
    for (let i = 0; i < body.length; i += 1) {
      const col = startCol + i;
      if (col < 0 || col >= 22 || !grid[row]) {
        continue;
      }
      grid[row][col].text = body[i] === ' ' ? '' : body[i];
    }
  }

  function renderCalendarClockPreview(payload = {}) {
    const host = $('calendar-clock-preview');
    if (!host) {
      return;
    }
    const grid = [0, 1, 2, 3, 4, 5].map(() => (
      Array.from({ length: 22 }, () => ({ text: '', chip: '' }))
    ));
    const dayRow0 = payload.showHeader ? 1 : 0;
    // Keep these in lockstep with CAL_COL0 / TEXT_COL in calendar-clock.js.
    const calCol0 = 1;
    const textCol = 10;
    if (payload.showHeader && payload.header) {
      placeCalendarClockText(grid, payload.header, 0, calCol0);
    }
    const monthChip = String(payload.theme?.month || '').toLowerCase();
    const todayChip = String(payload.theme?.today || '').toLowerCase();
    for (const cell of payload.cells || []) {
      const row = dayRow0 + Number(cell.row);
      const col = calCol0 + Number(cell.col);
      if (!grid[row] || Number(cell.col) < 0 || Number(cell.col) >= 7 || col >= 22) {
        continue;
      }
      const color = cell.today ? todayChip : monthChip;
      grid[row][col].chip = CALENDAR_CLOCK_CHIP_COLORS.has(color) ? color : '';
    }
    const month = String(payload.monthName || '');
    const day = String(payload.day ?? '');
    const dateGap = textCol + month.length + 2 + day.length <= 22 ? 2 : 1;
    placeCalendarClockText(grid, payload.weekdayName, 1, textCol);
    placeCalendarClockText(grid, month, 2, textCol);
    placeCalendarClockText(grid, day, 2, textCol + month.length + dateGap);
    placeCalendarClockText(grid, payload.timeLabel, 4, textCol);
    const codeRows = grid.map((row) => row.map((cell) => (
      cell.chip ? flapChipCode(cell.chip) : flapCharCode(cell.text)
    )));
    renderVbGrid(host, codeRows);
  }

  function renderCalendarClockSettings(data = {}) {
    const settings = data.settings || {};
    const payload = data.payload || {};
    setCalendarClockWeekStart(settings.weekStartsOn);
    const pill = $('calendar-clock-status-pill');
    const detail = $('calendar-clock-status-detail');
    if (pill) {
      const ready = Boolean(payload.monthName && payload.timeLabel);
      pill.textContent = ready ? 'Ready' : '…';
      pill.className = `status-pill ${ready ? 'is-ok' : ''}`;
    }
    if (detail) {
      if (payload.weekdayName && payload.monthName) {
        const header = payload.showHeader ? 'Weekday letters on row 1' : 'Six-week month — no header';
        detail.textContent = `${payload.weekdayName} ${payload.monthName} ${payload.day} · ${payload.timeLabel} · ${header}`;
      } else {
        detail.textContent = 'Monthly calendar chips plus the house clock. Weekday letters appear only when the month fits in five rows.';
      }
    }
    renderCalendarClockPreview(payload);
  }

  async function loadCalendarClockSettings() {
    try {
      const data = await apiGet('/api/calendar-clock/settings');
      renderCalendarClockSettings(data);
    } catch {
      renderCalendarClockSettings({});
    }
  }

  async function saveCalendarClockWeekStart(weekStartsOn) {
    setCalendarClockWeekStart(weekStartsOn);
    try {
      const result = await apiPost('/api/calendar-clock/settings', { weekStartsOn });
      renderCalendarClockSettings(result);
    } catch (error) {
      toast(error?.message || 'Could not save Calendar Clock settings', 'bad');
      loadCalendarClockSettings();
    }
  }

  $('calendar-clock-week-start')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-week-start]');
    if (!btn) return;
    saveCalendarClockWeekStart(btn.dataset.weekStart);
  });

  $('btn-calendar-clock-reset')?.addEventListener('click', async () => {
    const button = $('btn-calendar-clock-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/calendar-clock/settings', { reset: true });
      renderCalendarClockSettings(result);
      toast('Calendar Clock defaults restored', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset Calendar Clock', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-calendar-clock-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/calendar-clock', withTarget());
      const label = [result.weekdayName, result.monthName, result.day].filter(Boolean).join(' ');
      toast(label || result.timeLabel || 'Calendar Clock on the board', 'good');
    } catch (error) {
      toast(error?.message || 'Calendar Clock push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadCalendarClockSettings();
  window.setInterval(() => {
    if (document.hidden) return;
    if (!$('calendar-clock-settings-card')) return;
    const view = typeof currentSettingsView === 'function' ? currentSettingsView() : 'global';
    if (view !== 'global' && view !== 'all') return;
    loadCalendarClockSettings();
  }, 15000);

  // ----------------------------------------------- Settings → Word Clock

  function renderWordClockSettings(data = {}) {
    const settings = data.settings || {};
    const payload = data.payload || {};
    setSegmented('word-clock-rounding', 'data-rounding', settings.rounding === 'exact' ? 'exact' : 'five');
    const dayPart = $('word-clock-day-part');
    if (dayPart) dayPart.checked = settings.dayPart !== false;
    const pill = $('word-clock-status-pill');
    if (pill) {
      const ready = Boolean(payload.text);
      pill.textContent = ready ? 'Ready' : '…';
      pill.className = `status-pill ${ready ? 'is-ok' : ''}`;
    }
    const detail = $('word-clock-status-detail');
    if (detail) {
      detail.textContent = payload.text
        ? `Right now the board would read “${payload.text}”`
        : 'The time spelled out as a sentence, centred on the board.';
    }
    const host = $('word-clock-preview');
    if (host) renderVbGrid(host, data.boardRows || blankDesignerCells());
  }

  async function loadWordClockSettings() {
    try {
      renderWordClockSettings(await apiGet('/api/word-clock/settings'));
    } catch {
      renderWordClockSettings({});
    }
  }

  async function saveWordClockSettings(patch) {
    try {
      renderWordClockSettings(await apiPost('/api/word-clock/settings', patch));
    } catch (error) {
      toast(error?.message || 'Could not save Word Clock settings', 'bad');
      loadWordClockSettings();
    }
  }

  $('word-clock-rounding')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rounding]');
    if (!button) return;
    saveWordClockSettings({ rounding: button.dataset.rounding });
  });

  $('word-clock-day-part')?.addEventListener('change', (event) => {
    saveWordClockSettings({ dayPart: event.target.checked });
  });

  $('btn-word-clock-reset')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      renderWordClockSettings(await apiPost('/api/word-clock/settings', { reset: true }));
      toast('Word Clock defaults restored', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset Word Clock', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-word-clock-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/word-clock', withTarget());
      toast(result.text || 'Word Clock on the board', 'good');
    } catch (error) {
      toast(error?.message || 'Word Clock push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadWordClockSettings();
  // A clock preview that lags the wall is worse than none, so it re-reads on
  // the same cadence as the Calendar Clock card.
  window.setInterval(() => {
    if (document.hidden) return;
    if (!$('word-clock-settings-card')) return;
    const view = typeof currentSettingsView === 'function' ? currentSettingsView() : 'global';
    if (view !== 'global' && view !== 'all') return;
    loadWordClockSettings();
  }, 15000);

  // -------------------------------- Settings → Red Letter and the Date Book

  // Flap codes, in board order: blank, A-Z, 1-9, 0, then punctuation. The gaps
  // are codes the board reserves and never renders, so they read as blanks.
  const FLAP_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$() - +&=;: \'"%,.  /? \u00b0';
  const FLAP_CODE_BY_CHAR = (() => {
    const map = new Map();
    for (let code = 0; code < FLAP_CHARS.length; code += 1) {
      const char = FLAP_CHARS[code];
      if (char !== ' ' && !map.has(char)) {
        map.set(char, code);
      }
    }
    map.set(' ', 0);
    return map;
  })();
  const FLAP_CHIPS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'white', 'black', 'filled'];
  const FLAP_CHIP_BY_CODE = new Map(FLAP_CHIPS.map((name, index) => [63 + index, name]));
  const RL_MESSAGE_CELL = -1;
  const RL_ROWS = 6;
  const RL_COLS = 22;

  function blankDesignerCells() {
    return Array.from({ length: RL_ROWS }, () => new Array(RL_COLS).fill(0));
  }

  function flapChipCode(name) {
    const index = FLAP_CHIPS.indexOf(String(name || '').toLowerCase());
    return index >= 0 ? 63 + index : 0;
  }

  function flapCharCode(ch) {
    const raw = String(ch == null ? '' : ch);
    if (!raw || raw === ' ' || raw === '■') return 0;
    return FLAP_CODE_BY_CHAR.get(raw.toUpperCase()) || 0;
  }

  /**
   * Paint a 6×22 code grid as Vestaboard Simulator tiles (shared flap-grid.js).
   * Hosts are `.vb-grid` inside a `.vb-bezel` — same look as Red Letter / the sim.
   */
  function renderVbGrid(host, rows, { slots = false, caret = null, interactive = false } = {}) {
    if (typeof window.renderFlapGrid === 'function') {
      window.renderFlapGrid(host, rows, {
        slots,
        caret,
        interactive,
        rowAttr: 'data-rl-row',
        colAttr: 'data-rl-col',
        messageCell: RL_MESSAGE_CELL,
        lockFrom: RL_ROWS,
      });
      return;
    }
    if (!host) return;
    host.textContent = '';
  }

  function renderFlapGrid(host, rows, opts = {}) {
    renderVbGrid(host, rows, opts);
  }

  /** Text lines → simulator tiles. `decorate(row, col, ch)` may return a code. */
  function paintPreviewLines(host, lines, decorate) {
    if (typeof window.paintPreviewLines === 'function') {
      window.paintPreviewLines(host, lines, decorate);
      return;
    }
    if (!host) return;
    const rows = [];
    for (let row = 0; row < RL_ROWS; row += 1) {
      const line = String(lines?.[row] || '').padEnd(RL_COLS, ' ').slice(0, RL_COLS);
      const codes = [];
      for (let col = 0; col < RL_COLS; col += 1) {
        const ch = line[col];
        const over = typeof decorate === 'function' ? decorate(row, col, ch) : null;
        codes.push(over != null ? over : flapCharCode(ch));
      }
      rows.push(codes);
    }
    renderVbGrid(host, rows);
  }

  let redLetterState = { settings: {}, events: [], nextUp: null, boardPreview: null };
  let dateBookPreviewCard = 'countdown';
  let dateBookSelectedId = '';
  let dateBookSearch = '';

  function setSegmented(hostId, attr, value) {
    document.querySelectorAll(`#${hostId} [${attr}]`).forEach((button) => {
      const on = button.getAttribute(attr) === value;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function dateBookDayLabel(next = {}) {
    const days = Number(next.daysAway);
    if (!Number.isFinite(days)) return '';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 0) return 'passed';
    return `in ${days} days`;
  }

  const DATE_BOOK_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DATE_BOOK_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const DATE_BOOK_ORDINALS = [
    { value: '1', label: 'First' },
    { value: '2', label: 'Second' },
    { value: '3', label: 'Third' },
    { value: '4', label: 'Fourth' },
    { value: 'last', label: 'Last' },
  ];

  function dateBookSelectOptions(items, selected) {
    return items.map((item) => {
      const value = typeof item === 'object' ? item.value : item;
      const label = typeof item === 'object' ? item.label : item;
      return `<option value="${escapeHtml(String(value))}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function dateBookScheduleLabel(event = {}) {
    const time = event.time && event.time !== '00:00' ? ` at ${event.time}` : '';
    if (event.schedule === 'weekday' && event.ordinal != null && event.weekday != null && event.month) {
      const which = DATE_BOOK_ORDINALS.find((row) => String(row.value) === String(event.ordinal))?.label || event.ordinal;
      return `${which} ${DATE_BOOK_WEEKDAYS[event.weekday] || ''} of ${DATE_BOOK_MONTHS[event.month - 1] || ''}${time}`.replace(/\s+/g, ' ').trim();
    }
    return `${event.date || ''}${time}`.trim();
  }

  function syncDateBookWhenMode(scope) {
    if (!scope) return;
    const select = scope.querySelector('#date-book-schedule, [data-date-book-schedule]');
    const mode = select?.value === 'weekday' ? 'weekday' : 'date';
    scope.querySelectorAll('[data-date-book-mode]').forEach((field) => {
      field.hidden = field.dataset.dateBookMode !== mode;
    });
  }

  function dateBookDraftReady(draft = {}) {
    if (!String(draft.name || '').trim()) return false;
    if (draft.schedule === 'weekday') {
      return draft.ordinal && draft.weekday != null && draft.month;
    }
    return Boolean(String(draft.date || '').trim());
  }

  /**
   * Compose-sheet preview: if the date (or name) is still being filled in,
   * invent enough of an event that the board can flip a live sample. Missing
   * calendar dates aim at the next local midnight so Countdown is never blank
   * while someone types the day-of message.
   */
  function dateBookPreviewEvent(draft = {}) {
    const event = { ...draft };
    const name = String(event.name || '').trim();
    const message = String(event.message || '').trim();
    if (!name) {
      event.name = message ? message.slice(0, 40) : 'EVENT';
    }
    if (event.schedule === 'weekday') {
      return event;
    }
    if (!String(event.date || '').trim()) {
      const nextMidnight = new Date();
      nextMidnight.setHours(24, 0, 0, 0);
      const y = nextMidnight.getFullYear();
      const m = String(nextMidnight.getMonth() + 1).padStart(2, '0');
      const d = String(nextMidnight.getDate()).padStart(2, '0');
      event.date = `${y}-${m}-${d}`;
    }
    return event;
  }

  function dateBookComposeHint(draft = {}) {
    const named = Boolean(String(draft.name || '').trim());
    const messaged = Boolean(String(draft.message || '').trim());
    if (!named && !messaged) return '';
    if (!named) return 'Needs an event name';
    if (draft.schedule === 'weekday') {
      return dateBookDraftReady(draft) ? '' : 'Needs a weekday of the month';
    }
    return String(draft.date || '').trim() ? '' : 'Needs a date';
  }

  function renderRedLetterCard(data = {}) {
    const settings = data.settings || {};
    setSegmented('red-letter-push-selection', 'data-red-letter-push', settings.pushSelection || 'next');
    setSegmented('red-letter-schedule-selection', 'data-red-letter-schedule', settings.scheduleSelection || 'next');
    const showTime = $('red-letter-show-time');
    if (showTime) showTime.checked = settings.showTime !== false;

    const pill = $('red-letter-status-pill');
    const detail = $('red-letter-status-detail');
    const total = Number(data.total || 0);
    const upcoming = Number(data.upcoming || 0);
    if (pill) {
      pill.textContent = total ? `${upcoming} upcoming` : 'Empty';
      pill.className = `status-pill ${upcoming ? 'is-ok' : ''}`;
    }
    const label = $('red-letter-preview-label');
    if (label) {
      label.textContent = settings.pushSelection === 'random' ? 'A random pick' : 'The next one';
    }
    if (detail) {
      const today = Number(data.today || 0);
      const pushRandom = settings.pushSelection === 'random';
      if (!total) {
        detail.textContent = 'Nothing in the Date Book yet. Add a birthday, an anniversary or a visit and the board will count down to it.';
      } else if (!data.nextUp) {
        detail.textContent = `${total} event${total === 1 ? '' : 's'} on file, none of them still ahead.`;
      } else if (pushRandom) {
        detail.textContent = today
          ? `${today} event${today === 1 ? '' : 's'} today. Push Now picks at random from ${upcoming} upcoming.`
          : `${upcoming} upcoming. Push Now picks one at random.`;
      } else if (today) {
        detail.textContent = `${today} event${today === 1 ? '' : 's'} today — the board shows the message, not a countdown.`;
      } else {
        detail.textContent = `Next up: ${data.nextUp.name} ${dateBookDayLabel(data.nextUp)} (${data.nextUp.date}).`;
      }
    }
  }

  function paintRedLetterPreview(preview) {
    const host = $('red-letter-preview');
    if (!host) return;
    if (!preview?.rows) {
      renderVbGrid(host, blankDesignerCells());
      return;
    }
    renderVbGrid(host, preview.rows);
  }

  function applyRedLetterState(data = {}) {
    redLetterState = {
      settings: data.settings || {},
      events: Array.isArray(data.events) ? data.events : redLetterState.events,
      nextUp: data.nextUp || null,
      boardPreview: data.boardPreview !== undefined ? data.boardPreview : redLetterState.boardPreview,
    };
    renderRedLetterCard(data);
    renderDateBookList();
    paintRedLetterPreview(redLetterState.boardPreview);
  }

  async function loadRedLetter() {
    try {
      applyRedLetterState(await apiGet('/api/red-letter/settings'));
    } catch {
      renderRedLetterCard({});
    }
  }

  async function saveRedLetterSettings(patch) {
    try {
      applyRedLetterState(await apiPost('/api/red-letter/settings', patch));
    } catch (error) {
      toast(error?.message || 'Could not save Red Letter settings', 'bad');
      loadRedLetter();
    }
  }

  $('red-letter-push-selection')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-red-letter-push]');
    if (button) saveRedLetterSettings({ pushSelection: button.dataset.redLetterPush });
  });

  $('red-letter-schedule-selection')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-red-letter-schedule]');
    if (button) saveRedLetterSettings({ scheduleSelection: button.dataset.redLetterSchedule });
  });

  $('red-letter-show-time')?.addEventListener('change', (event) => {
    saveRedLetterSettings({ showTime: event.currentTarget.checked });
  });

  $('btn-red-letter-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/red-letter', withTarget());
      toast(result.card === 'day-of'
        ? `${result.event?.name}: today's message is on the board`
        : `Counting down to ${result.event?.name}`, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Red Letter', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  // ---------------------------------------------------- Date Book manager

  function dateBookVisibleEvents() {
    const needle = dateBookSearch.trim().toLowerCase();
    if (!needle) return redLetterState.events;
    return redLetterState.events.filter((event) => (
      `${event.name} ${event.message || ''} ${event.date} ${dateBookScheduleLabel(event)}`.toLowerCase().includes(needle)
    ));
  }

  function renderDateBookList() {
    const list = $('date-book-list');
    const summary = $('date-book-summary');
    if (summary) {
      const total = redLetterState.events.length;
      summary.textContent = total
        ? `${total} event${total === 1 ? '' : 's'}. One-off dates drop off the board once they pass; yearly ones — and weekdays of the month, like the last Thursday of November — roll forward on their own.`
        : 'Nothing here yet. Add the dates you want counted down to.';
    }
    if (!list) return;

    const events = dateBookVisibleEvents();
    if (!events.length) {
      list.innerHTML = `<p class="hint">${redLetterState.events.length ? 'No events match that search.' : 'No events yet.'}</p>`;
      return;
    }
    list.innerHTML = events.map((event) => {
      const next = event.next || {};
      const badges = [
        next.isToday ? '<span class="date-book-badge is-today">Today</span>' : '',
        event.recurring ? '<span class="date-book-badge is-yearly">Yearly</span>' : '',
        event.schedule === 'weekday' ? '<span class="date-book-badge is-yearly">Weekday</span>' : '',
        event.layout ? '<span class="date-book-badge is-art">Artwork</span>' : '',
        next.expired ? '<span class="date-book-badge">Passed</span>' : '',
      ].filter(Boolean).join('');
      const schedule = event.schedule === 'weekday' ? 'weekday' : 'date';
      const time = event.time || '';
      const whenLine = [
        next.date || event.date,
        dateBookScheduleLabel(event),
        next.expired ? '' : dateBookDayLabel(next),
      ].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ');
      return `
        <article class="cn-fact${event.enabled === false ? ' is-hidden' : ''}" data-date-book-id="${escapeHtml(event.id)}">
          <div class="date-book-row-head">
            <span class="date-book-row-name">${escapeHtml(event.name)}</span>
            ${badges}
            <span class="date-book-row-when">${escapeHtml(whenLine)}</span>
          </div>
          <textarea class="field-input cn-fact-text" rows="2" maxlength="240" data-date-book-message
            placeholder="Message for the day itself">${escapeHtml(event.message || '')}</textarea>
          <div class="date-book-when">
            <div class="date-book-when-field">
              <label class="field-label">When</label>
              <select class="field-input" data-date-book-schedule>
                <option value="date"${schedule === 'date' ? ' selected' : ''}>On a date</option>
                <option value="weekday"${schedule === 'weekday' ? ' selected' : ''}>Weekday of the month</option>
              </select>
            </div>
            <div class="date-book-when-field" data-date-book-mode="date"${schedule === 'date' ? '' : ' hidden'}>
              <label class="field-label">Date</label>
              <input type="date" class="field-input" data-date-book-date value="${escapeHtml(event.date || '')}">
            </div>
            <div class="date-book-when-field" data-date-book-mode="weekday"${schedule === 'weekday' ? '' : ' hidden'}>
              <label class="field-label">Which</label>
              <select class="field-input" data-date-book-ordinal>${dateBookSelectOptions(DATE_BOOK_ORDINALS, event.ordinal || '1')}</select>
            </div>
            <div class="date-book-when-field" data-date-book-mode="weekday"${schedule === 'weekday' ? '' : ' hidden'}>
              <label class="field-label">Weekday</label>
              <select class="field-input" data-date-book-weekday>${dateBookSelectOptions(DATE_BOOK_WEEKDAYS.map((label, value) => ({ value, label })), event.weekday ?? 1)}</select>
            </div>
            <div class="date-book-when-field" data-date-book-mode="weekday"${schedule === 'weekday' ? '' : ' hidden'}>
              <label class="field-label">Of</label>
              <select class="field-input" data-date-book-month>${dateBookSelectOptions(DATE_BOOK_MONTHS.map((label, index) => ({ value: index + 1, label })), event.month || 9)}</select>
            </div>
            <div class="date-book-when-field">
              <label class="field-label">Time</label>
              <input type="time" class="field-input" data-date-book-time value="${escapeHtml(time)}" title="Leave blank for midnight">
            </div>
            <div class="date-book-when-field">
              <span class="field-label">Repeat</span>
              <label class="trivia-check date-book-repeat-box">
                <input type="checkbox" data-date-book-recurring ${event.recurring ? 'checked' : ''}>
                <span>Every year</span>
              </label>
            </div>
          </div>
          <div class="cn-fact-meta">
            <div class="cn-fact-actions">
              <button type="button" class="btn btn-outline btn-sm" data-date-book-action="preview">Preview</button>
              <button type="button" class="btn btn-outline btn-sm" data-date-book-action="design">Design</button>
              <button type="button" class="btn btn-outline btn-sm" data-date-book-action="save">Save</button>
              <button type="button" class="btn btn-outline btn-sm" data-date-book-action="toggle">${event.enabled === false ? 'Enable' : 'Pause'}</button>
              <button type="button" class="btn btn-danger btn-sm" data-date-book-action="remove">Delete</button>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  function dateBookDraft() {
    const schedule = $('date-book-schedule')?.value || 'date';
    return {
      name: $('date-book-name')?.value || '',
      message: $('date-book-message')?.value || '',
      schedule,
      // A leftover calendar date must not pin a weekday rule.
      date: schedule === 'date' ? ($('date-book-date')?.value || '') : '',
      time: $('date-book-time')?.value || '',
      ordinal: $('date-book-ordinal')?.value || '1',
      weekday: Number($('date-book-weekday')?.value ?? 1),
      month: Number($('date-book-month')?.value || 9),
      recurring: Boolean($('date-book-recurring')?.checked),
    };
  }

  function dateBookRowDraft(row) {
    if (!row) return {};
    return {
      message: row.querySelector('[data-date-book-message]')?.value || '',
      schedule: row.querySelector('[data-date-book-schedule]')?.value || 'date',
      date: row.querySelector('[data-date-book-date]')?.value || '',
      time: row.querySelector('[data-date-book-time]')?.value || '',
      ordinal: row.querySelector('[data-date-book-ordinal]')?.value || '1',
      weekday: Number(row.querySelector('[data-date-book-weekday]')?.value ?? 1),
      month: Number(row.querySelector('[data-date-book-month]')?.value || 9),
      recurring: Boolean(row.querySelector('[data-date-book-recurring]')?.checked),
    };
  }

  let dateBookPreviewTimer = 0;

  /**
   * Previews come from the bridge rather than a second copy of the layout
   * code in the browser, so what the sheet shows is what the board will flip.
   * The compose form keeps painting while the date/name are incomplete by
   * borrowing next midnight (and a stand-in name) for the request only.
   */
  async function refreshDateBookPreview() {
    const host = $('date-book-preview');
    const hint = $('date-book-fit-hint');
    if (!host) return;
    if (dateBookSelectedId) {
      try {
        const data = await apiPost('/api/date-book/preview', { eventId: dateBookSelectedId });
        const card = dateBookPreviewCard === 'dayOf' ? data.dayOf : data.countdown;
        renderVbGrid(host, card?.rows);
        if (hint) {
          hint.textContent = card?.overflow
            ? 'The message is longer than the artwork has room for'
            : '';
        }
      } catch (error) {
        renderVbGrid(host, blankDesignerCells());
        if (hint) hint.textContent = error?.message || '';
      }
      return;
    }

    const draft = dateBookDraft();
    const composeHint = dateBookComposeHint(draft);
    if (!String(draft.name || '').trim() && !String(draft.message || '').trim()) {
      renderVbGrid(host, blankDesignerCells());
      if (hint) hint.textContent = '';
      return;
    }
    try {
      const data = await apiPost('/api/date-book/preview', { event: dateBookPreviewEvent(draft) });
      const card = dateBookPreviewCard === 'dayOf' ? data.dayOf : data.countdown;
      renderVbGrid(host, card?.rows);
      if (hint) {
        hint.textContent = composeHint
          || (card?.overflow ? 'The message is longer than the artwork has room for' : '');
      }
    } catch (error) {
      renderVbGrid(host, blankDesignerCells());
      if (hint) hint.textContent = composeHint || error?.message || '';
    }
  }

  function queueDateBookPreview() {
    window.clearTimeout(dateBookPreviewTimer);
    dateBookPreviewTimer = window.setTimeout(refreshDateBookPreview, 200);
  }

  function openDateBookSheet() {
    const sheet = $('date-book-manage-sheet');
    if (!sheet) return;
    sheet.hidden = false;
    dateBookSelectedId = '';
    syncDateBookWhenMode($('date-book-when'));
    loadRedLetter().then(refreshDateBookPreview);
  }

  function closeDateBookSheet() {
    const sheet = $('date-book-manage-sheet');
    if (sheet) sheet.hidden = true;
    loadRedLetter();
  }

  $('btn-date-book-manage')?.addEventListener('click', openDateBookSheet);
  $('btn-date-book-close')?.addEventListener('click', closeDateBookSheet);
  registerSheetDismiss('date-book-manage-sheet', () => closeDateBookSheet());

  ['date-book-name', 'date-book-message', 'date-book-date', 'date-book-time'].forEach((id) => {
    $(id)?.addEventListener('input', () => {
      dateBookSelectedId = '';
      queueDateBookPreview();
    });
  });
  ['date-book-schedule', 'date-book-ordinal', 'date-book-weekday', 'date-book-month', 'date-book-recurring'].forEach((id) => {
    $(id)?.addEventListener('change', () => {
      dateBookSelectedId = '';
      if (id === 'date-book-schedule') {
        const weekday = $('date-book-schedule')?.value === 'weekday';
        const recurring = $('date-book-recurring');
        if (weekday && recurring && !recurring.checked) recurring.checked = true;
        syncDateBookWhenMode($('date-book-when'));
      }
      queueDateBookPreview();
    });
  });

  $('date-book-preview-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-date-book-preview]');
    if (!button) return;
    dateBookPreviewCard = button.dataset.dateBookPreview;
    setSegmented('date-book-preview-tabs', 'data-date-book-preview', dateBookPreviewCard);
    refreshDateBookPreview();
  });

  $('date-book-search')?.addEventListener('input', (event) => {
    dateBookSearch = event.currentTarget.value || '';
    renderDateBookList();
  });

  $('btn-date-book-add')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const created = await apiPost('/api/date-book/events', dateBookDraft());
      ['date-book-name', 'date-book-message', 'date-book-time'].forEach((id) => {
        const field = $(id);
        if (field) field.value = '';
      });
      const recurring = $('date-book-recurring');
      if (recurring) recurring.checked = $('date-book-schedule')?.value === 'weekday';
      applyRedLetterState(created);
      dateBookSelectedId = created.event?.id || '';
      refreshDateBookPreview();
      toast(`${created.event?.name} added to the Date Book`, 'good');
    } catch (error) {
      toast(error?.message || 'Could not add that event', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('date-book-list')?.addEventListener('change', (event) => {
    if (!event.target.closest('[data-date-book-schedule]')) return;
    syncDateBookWhenMode(event.target.closest('[data-date-book-id]'));
  });

  $('date-book-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-date-book-action]');
    const row = event.target.closest('[data-date-book-id]');
    if (!button || !row) return;
    const id = row.dataset.dateBookId;
    const stored = redLetterState.events.find((entry) => entry.id === id);
    const action = button.dataset.dateBookAction;

    if (action === 'preview') {
      dateBookSelectedId = id;
      refreshDateBookPreview();
      return;
    }
    if (action === 'design') {
      openRedLetterDesigner(id);
      return;
    }

    button.disabled = true;
    try {
      if (action === 'remove') {
        applyRedLetterState(await apiFetch(appUrl(`/api/date-book/events/${encodeURIComponent(id)}`), { method: 'DELETE' }));
        toast('Event deleted', 'good');
      } else {
        const patch = action === 'toggle'
          ? { enabled: stored?.enabled === false }
          : dateBookRowDraft(row);
        applyRedLetterState(await apiFetch(appUrl(`/api/date-book/events/${encodeURIComponent(id)}`), {
          method: 'PUT', body: patch,
        }));
        if (action === 'save') toast('Event saved', 'good');
      }
    } catch (error) {
      toast(error?.message || 'Could not update that event', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  // ------------------------------------------------ Red Letter designer

  // `.` blank, `#` a message flap, anything else a chip letter.
  // `confetti` is the house Day Of look (rails + message slots).
  const RL_PRESETS = {
    blank: [
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
      '......................',
    ],
    heart: [
      '..rrr..rrr............',
      'rrwrrrrrrr.###########',
      'rrrrrrrrrr.###########',
      '.rrrrrrrr..###########',
      '..rrrrrr...###########',
      '....rr................',
    ],
    confetti: [
      'rvwrvwrvwrvwrvwrvwrvwr',
      '######################',
      '######################',
      '######################',
      '######################',
      'wrvwrvwrvwrvwrvwrvwrvw',
    ],
    halloween: [
      '..ooooo...............',
      '.ooooooo.#############',
      '.oykkkyo.#############',
      '.oykykyo.#############',
      '.okyyyko.#############',
      '..ooooo...............',
    ],
    summer: [
      'y.y...y.y.............',
      '.y..yyy..y.###########',
      '..yyyyyyy..###########',
      '.y.yyyyy.y.###########',
      'y..yyy..y..###########',
      'ggyoyoyoyggg..........',
    ],
    beach: [
      'g.....ww..............',
      'gg...wwww.............',
      'fgg.bwbwbw.###########',
      'f..wbwbwbw.###########',
      '..yyyyyyyy.###########',
      '.yyyyyyyyyy...........',
    ],
    christmas: [
      '.....w................',
      '....grg.##############',
      '...grgrg.#############',
      '..grgrgrg.############',
      '.grgrgrgrg.###########',
      '....fff...............',
    ],
    autumn: [
      'r.y.o.................',
      '.oyo.r.y.#############',
      'royyoyr..#############',
      '.rorror.y#############',
      'y.ror.o...............',
      '..fff.y.o.............',
    ],
    border: [
      'rrrrrrrrrrrrrrrrrrrrrr',
      'r####################r',
      'r####################r',
      'r####################r',
      'r####################r',
      'rrrrrrrrrrrrrrrrrrrrrr',
    ],
  };

  const RL_CHIP_LETTERS = {
    r: 'red', o: 'orange', y: 'yellow', g: 'green', b: 'blue', v: 'violet', w: 'white', k: 'black', f: 'filled',
  };

  // Characters someone can stamp onto a flap from the palette. Space is
  // listed first so a blank can be picked without switching to Erase.
  const RL_PALETTE_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890!@#$()-_+&=;:\'"%,./?°';

  function presetCells(name) {
    const lines = RL_PRESETS[name] || RL_PRESETS.blank;
    return Array.from({ length: RL_ROWS }, (_, row) => (
      Array.from({ length: RL_COLS }, (_, col) => {
        const letter = lines[row]?.[col] || '.';
        if (letter === '#') return RL_MESSAGE_CELL;
        const chip = RL_CHIP_LETTERS[letter];
        return chip ? 63 + FLAP_CHIPS.indexOf(chip) : 0;
      })
    ));
  }

  let designerEventId = '';
  let designerCells = blankDesignerCells();
  let designerBaseline = blankDesignerCells();
  let designerUndo = [];
  let designerTool = { kind: 'chip', chip: 'red' };
  let designerCaret = null;
  let designerPainting = false;
  let designerPreviewTimer = 0;

  function cloneDesignerCells(cells) {
    return Array.from({ length: RL_ROWS }, (_, row) => (
      Array.from({ length: RL_COLS }, (_, col) => Number(cells?.[row]?.[col] ?? 0))
    ));
  }

  function designerCellsEqual(a, b) {
    for (let row = 0; row < RL_ROWS; row += 1) {
      for (let col = 0; col < RL_COLS; col += 1) {
        if (Number(a?.[row]?.[col] ?? 0) !== Number(b?.[row]?.[col] ?? 0)) {
          return false;
        }
      }
    }
    return true;
  }

  function designerIsDirty() {
    return Boolean(designerEventId) && !designerCellsEqual(designerCells, designerBaseline);
  }

  function syncDesignerActionUi() {
    const undoBtn = $('btn-red-letter-designer-undo');
    const resetBtn = $('btn-red-letter-designer-reset');
    if (undoBtn) undoBtn.disabled = designerUndo.length === 0;
    if (resetBtn) resetBtn.disabled = !designerIsDirty();
  }

  function pushDesignerUndo() {
    designerUndo.push(cloneDesignerCells(designerCells));
    if (designerUndo.length > 40) designerUndo.shift();
    syncDesignerActionUi();
  }

  function undoDesigner() {
    if (!designerUndo.length) return;
    designerCells = designerUndo.pop();
    designerCaret = null;
    renderDesignerGrid();
    refreshDesignerPreview();
    syncDesignerActionUi();
  }

  function resetDesigner() {
    if (!designerIsDirty()) return;
    pushDesignerUndo();
    designerCells = cloneDesignerCells(designerBaseline);
    designerCaret = null;
    renderDesignerGrid();
    refreshDesignerPreview();
    syncDesignerActionUi();
  }

  function designerCodeForTool() {
    if (designerTool.kind === 'message') return RL_MESSAGE_CELL;
    if (designerTool.kind === 'erase') return 0;
    if (designerTool.kind === 'char') {
      return FLAP_CODE_BY_CHAR.get(designerTool.char) ?? 0;
    }
    return 63 + Math.max(0, FLAP_CHIPS.indexOf(designerTool.chip));
  }

  function syncDesignerToolUi() {
    document.querySelectorAll('#red-letter-tools [data-rl-tool]').forEach((entry) => {
      const kind = entry.dataset.rlTool;
      const on = designerTool.kind === kind
        && (kind !== 'chip' || entry.dataset.rlChip === designerTool.chip);
      entry.classList.toggle('is-active', on);
    });
    document.querySelectorAll('#red-letter-chars [data-rl-char]').forEach((entry) => {
      const raw = entry.dataset.rlChar ?? '';
      const char = raw === 'blank' ? ' ' : raw;
      const on = designerTool.kind === 'char' && char === designerTool.char;
      entry.classList.toggle('is-active', on);
    });
  }

  function buildCharPalette() {
    const host = $('red-letter-chars');
    if (!host || host.dataset.ready === '1') return;
    host.innerHTML = [...RL_PALETTE_CHARS].map((char) => {
      const isBlank = char === ' ';
      const attr = isBlank ? 'blank' : char;
      const label = isBlank ? 'Blank' : char;
      const blankClass = isBlank ? ' is-blank' : '';
      return `<button type="button" class="rl-char${blankClass}" data-rl-char="${escapeHtml(attr)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    }).join('');
    host.dataset.ready = '1';
  }

  function renderDesignerGrid() {
    renderVbGrid($('red-letter-grid'), designerCells, {
      slots: true,
      caret: designerCaret,
      interactive: true,
    });
  }

  async function refreshDesignerPreview() {
    const host = $('red-letter-designer-preview');
    const warning = $('red-letter-designer-warning');
    const event = redLetterState.events.find((entry) => entry.id === designerEventId);
    if (!host || !event) return;
    try {
      const data = await apiPost('/api/date-book/preview', {
        event: { ...event, layout: { cells: designerCells } },
      });
      renderVbGrid(host, data.dayOf?.rows);
      if (warning) {
        if (data.dayOf?.overflow) {
          warning.textContent = 'The message runs past the flaps you marked — mark more, or shorten it.';
        } else if (!data.dayOf?.custom) {
          warning.textContent = 'Nothing painted yet, so the board falls back to the house confetti card.';
        } else {
          warning.textContent = '';
        }
      }
    } catch (error) {
      if (warning) warning.textContent = error?.message || '';
    }
  }

  function queueDesignerPreview() {
    window.clearTimeout(designerPreviewTimer);
    designerPreviewTimer = window.setTimeout(refreshDesignerPreview, 160);
  }

  function advanceDesignerCaret(row, col) {
    let nextRow = row;
    let nextCol = col + 1;
    if (nextCol >= RL_COLS) {
      nextCol = 0;
      nextRow = Math.min(RL_ROWS - 1, row + 1);
    }
    designerCaret = { row: nextRow, col: nextCol };
  }

  function paintDesignerCell(row, col, { moveCaret = true, advance = false } = {}) {
    if (!designerCells[row] || col < 0 || col >= RL_COLS) return;
    designerCells[row][col] = designerCodeForTool();
    if (advance) advanceDesignerCaret(row, col);
    else if (moveCaret) designerCaret = { row, col };
    renderDesignerGrid();
    queueDesignerPreview();
    syncDesignerActionUi();
  }

  function writeCharsFromCaret(text) {
    if (!designerCaret) {
      designerCaret = { row: 0, col: 0 };
    }
    pushDesignerUndo();
    let { row, col } = designerCaret;
    for (const raw of String(text || '')) {
      const upper = raw.toUpperCase();
      const code = FLAP_CODE_BY_CHAR.get(upper);
      if (code === undefined) continue;
      designerCells[row][col] = code;
      col += 1;
      if (col >= RL_COLS) {
        col = 0;
        row = Math.min(RL_ROWS - 1, row + 1);
      }
    }
    designerCaret = { row, col };
    renderDesignerGrid();
    queueDesignerPreview();
    syncDesignerActionUi();
  }

  function designerBoardIsClear() {
    return designerCells.every((row) => row.every((code) => code === 0));
  }

  function designerCellFromPoint(x, y) {
    const target = document.elementFromPoint(x, y);
    const cell = target?.closest?.('[data-rl-row]');
    if (!cell) return null;
    return { row: Number(cell.dataset.rlRow), col: Number(cell.dataset.rlCol) };
  }

  function openRedLetterDesigner(eventId) {
    const sheet = $('red-letter-designer-sheet');
    const event = redLetterState.events.find((entry) => entry.id === eventId);
    if (!sheet || !event) return;
    buildCharPalette();
    designerEventId = eventId;
    designerCaret = null;
    designerUndo = [];
    designerTool = { kind: 'chip', chip: 'red' };
    syncDesignerToolUi();
    // Fresh events start from the house Day Of confetti card (message slots
    // in the middle rails), not the heart preset.
    designerCells = event.layout?.cells?.length
      ? presetFromSaved(event.layout.cells)
      : presetCells('confetti');
    designerBaseline = cloneDesignerCells(designerCells);
    const subtitle = $('red-letter-designer-subtitle');
    if (subtitle) {
      subtitle.textContent = `${event.name} — ${event.message || 'no message yet'}`;
    }
    const quick = $('red-letter-quick-type');
    if (quick) quick.value = '';
    sheet.hidden = false;
    renderDesignerGrid();
    refreshDesignerPreview();
    syncDesignerActionUi();
  }

  function presetFromSaved(cells) {
    return Array.from({ length: RL_ROWS }, (_, row) => (
      Array.from({ length: RL_COLS }, (_, col) => {
        const code = Number(cells?.[row]?.[col]);
        if (code === RL_MESSAGE_CELL) return RL_MESSAGE_CELL;
        return Number.isFinite(code) && code >= 0 && code <= 71 ? code : 0;
      })
    ));
  }

  function closeRedLetterDesigner() {
    const sheet = $('red-letter-designer-sheet');
    if (sheet) sheet.hidden = true;
    const unsaved = $('red-letter-unsaved-sheet');
    if (unsaved) unsaved.hidden = true;
    designerEventId = '';
    designerUndo = [];
    syncDesignerActionUi();
  }

  function hideRedLetterUnsavedSheet() {
    const sheet = $('red-letter-unsaved-sheet');
    if (sheet) sheet.hidden = true;
  }

  function requestCloseRedLetterDesigner() {
    if (!designerEventId) {
      closeRedLetterDesigner();
      return;
    }
    if (!designerIsDirty()) {
      closeRedLetterDesigner();
      return;
    }
    const sheet = $('red-letter-unsaved-sheet');
    if (sheet) sheet.hidden = false;
  }

  async function saveRedLetterDesigner({ closeAfter = true } = {}) {
    if (!designerEventId) return false;
    const button = $('btn-red-letter-designer-save');
    if (button) button.disabled = true;
    try {
      applyRedLetterState(await apiFetch(appUrl(`/api/date-book/events/${encodeURIComponent(designerEventId)}`), {
        method: 'PUT', body: { layout: { cells: designerCells } },
      }));
      designerBaseline = cloneDesignerCells(designerCells);
      designerUndo = [];
      syncDesignerActionUi();
      toast('Design saved', 'good');
      if (closeAfter) closeRedLetterDesigner();
      return true;
    } catch (error) {
      toast(error?.message || 'Could not save the design', 'bad');
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  $('btn-red-letter-designer-close')?.addEventListener('click', requestCloseRedLetterDesigner);
  registerSheetDismiss('red-letter-designer-sheet', () => requestCloseRedLetterDesigner());
  registerSheetDismiss('red-letter-unsaved-sheet', () => hideRedLetterUnsavedSheet());
  $('btn-red-letter-unsaved-cancel')?.addEventListener('click', hideRedLetterUnsavedSheet);
  $('btn-red-letter-unsaved-discard')?.addEventListener('click', () => {
    hideRedLetterUnsavedSheet();
    closeRedLetterDesigner();
  });
  $('btn-red-letter-unsaved-save')?.addEventListener('click', async () => {
    hideRedLetterUnsavedSheet();
    await saveRedLetterDesigner({ closeAfter: true });
  });
  $('btn-red-letter-designer-undo')?.addEventListener('click', () => undoDesigner());
  $('btn-red-letter-designer-reset')?.addEventListener('click', () => resetDesigner());

  $('red-letter-tools')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rl-tool]');
    if (!button) return;
    designerTool = { kind: button.dataset.rlTool, chip: button.dataset.rlChip || 'red' };
    syncDesignerToolUi();
  });

  $('red-letter-chars')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rl-char]');
    if (!button) return;
    const raw = button.dataset.rlChar ?? '';
    const char = raw === 'blank' ? ' ' : raw;
    designerTool = { kind: 'char', char };
    syncDesignerToolUi();
    if (designerCaret) {
      pushDesignerUndo();
      paintDesignerCell(designerCaret.row, designerCaret.col, { advance: true });
    }
  });

  const designerQuickType = $('red-letter-quick-type');
  designerQuickType?.addEventListener('focus', () => {
    if (!designerCaret) designerCaret = { row: 0, col: 0 };
    renderDesignerGrid();
  });
  designerQuickType?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    writeCharsFromCaret(designerQuickType.value);
    designerQuickType.value = '';
  });
  // Paste a whole phrase without needing Enter — still one go from the caret.
  designerQuickType?.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    event.preventDefault();
    writeCharsFromCaret(text);
    designerQuickType.value = '';
  });

  const designerGrid = $('red-letter-grid');
  designerGrid?.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('[data-rl-row]');
    if (!cell) return;
    event.preventDefault();
    designerGrid.focus();
    const row = Number(cell.dataset.rlRow);
    const col = Number(cell.dataset.rlCol);
    // Character tool with a glyph picked: click paints and advances. Without a
    // glyph (shouldn't happen), click only moves the caret for quick-type.
    if (designerTool.kind === 'char') {
      if (designerTool.char != null) {
        designerPainting = false;
        pushDesignerUndo();
        paintDesignerCell(row, col, { advance: true });
      } else {
        designerCaret = { row, col };
        renderDesignerGrid();
      }
      return;
    }
    designerPainting = true;
    pushDesignerUndo();
    designerGrid.setPointerCapture?.(event.pointerId);
    paintDesignerCell(row, col, {
      advance: designerTool.kind === 'char',
    });
  });

  // Pointer capture means enter/leave stop firing mid-drag, so the cell under
  // the finger is looked up by coordinate instead. Touch needs it either way.
  designerGrid?.addEventListener('pointermove', (event) => {
    if (!designerPainting) return;
    const at = designerCellFromPoint(event.clientX, event.clientY);
    if (at) paintDesignerCell(at.row, at.col, { moveCaret: false });
  });

  ['pointerup', 'pointercancel'].forEach((name) => {
    designerGrid?.addEventListener(name, () => {
      designerPainting = false;
    });
  });

  designerGrid?.addEventListener('keydown', (event) => {
    if (!designerCaret) return;
    const { row, col } = designerCaret;
    const move = (nextRow, nextCol) => {
      designerCaret = {
        row: Math.min(RL_ROWS - 1, Math.max(0, nextRow)),
        col: Math.min(RL_COLS - 1, Math.max(0, nextCol)),
      };
      renderDesignerGrid();
    };

    if (event.key === 'ArrowLeft') { event.preventDefault(); move(row, col - 1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(row, col + 1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(row - 1, col); return; }
    if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); move(row + 1, 0); return; }
    if (event.key === 'Backspace') {
      event.preventDefault();
      pushDesignerUndo();
      const back = Math.max(0, col - 1);
      designerCells[row][back] = 0;
      designerCaret = { row, col: back };
      renderDesignerGrid();
      queueDesignerPreview();
      syncDesignerActionUi();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'z') {
      event.preventDefault();
      undoDesigner();
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const code = FLAP_CODE_BY_CHAR.get(event.key.toUpperCase());
    if (code === undefined) return;
    event.preventDefault();
    pushDesignerUndo();
    designerCells[row][col] = code;
    advanceDesignerCaret(row, col);
    renderDesignerGrid();
    queueDesignerPreview();
    syncDesignerActionUi();
  });

  document.querySelectorAll('[data-rl-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      pushDesignerUndo();
      designerCells = presetCells(button.dataset.rlPreset);
      designerCaret = null;
      renderDesignerGrid();
      refreshDesignerPreview();
      syncDesignerActionUi();
    });
  });

  $('btn-red-letter-designer-blank')?.addEventListener('click', () => {
    if (!designerBoardIsClear()) {
      const ok = window.confirm('Clear the whole board? This only wipes the editor — Save to keep it, or cancel to leave the flaps as they are.');
      if (!ok) return;
    }
    pushDesignerUndo();
    designerCells = blankDesignerCells();
    designerCaret = null;
    renderDesignerGrid();
    refreshDesignerPreview();
    syncDesignerActionUi();
  });

  $('btn-red-letter-designer-clear')?.addEventListener('click', async () => {
    if (!designerEventId) return;
    try {
      applyRedLetterState(await apiFetch(appUrl(`/api/date-book/events/${encodeURIComponent(designerEventId)}`), {
        method: 'PUT', body: { layout: null },
      }));
      closeRedLetterDesigner();
      toast('Artwork removed — back to the house card', 'good');
    } catch (error) {
      toast(error?.message || 'Could not remove the artwork', 'bad');
    }
  });

  $('btn-red-letter-designer-save')?.addEventListener('click', async () => {
    await saveRedLetterDesigner({ closeAfter: true });
  });

  buildCharPalette();
  loadRedLetter();

  // ------------------------------------------- Settings → Learn Japanese

  function collectLearnJapaneseList(attr) {
    return [...document.querySelectorAll(`[${attr}]:checked`)].map((input) => input.getAttribute(attr));
  }

  function setLearnJapaneseList(attr, values) {
    const want = new Set(values || []);
    document.querySelectorAll(`[${attr}]`).forEach((input) => {
      input.checked = want.has(input.getAttribute(attr));
    });
  }

  function renderLearnJapaneseSettings(status = {}) {
    const settings = status.settings || {};
    setLearnJapaneseList('data-learn-japanese-level', settings.levels || ['N5', 'N4']);
    setLearnJapaneseList('data-learn-japanese-pos', settings.partsOfSpeech || []);
    const pill = $('learn-japanese-status-pill');
    const detail = $('learn-japanese-status-detail');
    const hint = $('learn-japanese-pool-hint');
    const available = Number(status.available || 0);
    const total = Number(status.total || 0);
    if (pill) {
      pill.textContent = available > 0 ? `${available} words` : 'Empty';
      pill.className = `status-pill ${available > 0 ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = available > 0
        ? `${available} of ${total} shipped words match these filters.`
        : 'Turn a level or part of speech back on — the pool is empty.';
    }
    if (hint) {
      hint.textContent = total
        ? `Shipped lexicon: ${total} JLPT N5/N4 words (OpenJLPT / JMDict).`
        : 'Lexicon missing.';
    }
  }

  async function loadLearnJapaneseSettings() {
    try {
      const data = await apiGet('/api/learn-japanese/settings');
      renderLearnJapaneseSettings(data);
    } catch {
      renderLearnJapaneseSettings({});
    }
  }

  async function saveLearnJapaneseSettings() {
    try {
      const result = await apiPost('/api/learn-japanese/settings', {
        levels: collectLearnJapaneseList('data-learn-japanese-level'),
        partsOfSpeech: collectLearnJapaneseList('data-learn-japanese-pos'),
      });
      renderLearnJapaneseSettings(result);
    } catch (error) {
      toast(error.message || 'Could not save Learn Japanese settings', 'bad');
      await loadLearnJapaneseSettings();
    }
  }

  $('learn-japanese-settings-card')?.addEventListener('change', (event) => {
    if (!event.target.closest('[data-learn-japanese-level], [data-learn-japanese-pos]')) {
      return;
    }
    saveLearnJapaneseSettings();
  });

  $('btn-learn-japanese-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/learn-japanese', withTarget());
      const romaji = result.word?.romaji || 'word';
      toast(`Learn Japanese: ${romaji}`, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Learn Japanese', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadLearnJapaneseSettings();

  // ------------------------------------------- Settings → Learn {Language}

  function bindLearnLanguageCard(language, title) {
    const card = $(`learn-${language}-settings-card`);
    if (!card) return;

    function collect(attr) {
      return [...card.querySelectorAll(`[${attr}]:checked`)].map((input) => input.getAttribute(attr));
    }

    function setList(attr, values) {
      const want = new Set(values || []);
      card.querySelectorAll(`[${attr}]`).forEach((input) => {
        input.checked = want.has(input.getAttribute(attr));
      });
    }

    function render(status = {}) {
      const settings = status.settings || {};
      setList('data-learn-language-level', settings.levels || ['A1', 'A2']);
      setList('data-learn-language-pos', settings.partsOfSpeech || []);
      const pill = $(`learn-${language}-status-pill`);
      const detail = $(`learn-${language}-status-detail`);
      const hint = $(`learn-${language}-pool-hint`);
      const available = Number(status.available || 0);
      const total = Number(status.total || 0);
      if (pill) {
        pill.textContent = available ? `${available} words` : 'Empty';
        pill.className = `status-pill ${available ? 'is-ok' : 'is-warn'}`;
      }
      if (detail && available) {
        detail.textContent = `${available} of ${total} shipped words match the filters.`;
      }
      if (hint) {
        hint.textContent = total
          ? `Shipped A1/A2 list: ${total} words.`
          : 'No lexicon loaded.';
      }
    }

    async function load() {
      try {
        render(await apiGet(`/api/learn-${language}/settings`));
      } catch {
        render({});
      }
    }

    async function save() {
      try {
        const result = await apiPost(`/api/learn-${language}/settings`, {
          levels: collect('data-learn-language-level'),
          partsOfSpeech: collect('data-learn-language-pos'),
        });
        render(result);
      } catch (error) {
        toast(error.message || `Could not save ${title} settings`, 'bad');
      }
    }

    card.addEventListener('change', (event) => {
      if (!event.target.closest('[data-learn-language-level], [data-learn-language-pos]')) {
        return;
      }
      save();
    });

    $(`btn-learn-${language}-push`)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await apiPost(`/api/push/learn-${language}`, withTarget());
        toast(`${title}: ${result.word?.word || 'word'}`, 'good');
      } catch (error) {
        toast(error?.message || `Could not push ${title}`, 'bad');
      } finally {
        button.disabled = false;
      }
    });

    load();
  }

  bindLearnLanguageCard('portuguese', 'Learn Portuguese');
  bindLearnLanguageCard('spanish', 'Learn Spanish');
  bindLearnLanguageCard('french', 'Learn French');
  bindLearnLanguageCard('german', 'Learn German');
  bindLearnLanguageCard('italian', 'Learn Italian');

  // ------------------------------------------- Settings → Plex Top 10 Movies

  (function bindPlexTop10Card() {
    const card = $('plex-top10-settings-card');
    if (!card) return;

    const genreBox = $('plex-top10-genres');
    let source = 'library';

    function renderGenres(all = [], picked = []) {
      if (!genreBox) return;
      const want = new Set((picked || []).map((name) => String(name).toLowerCase()));
      genreBox.innerHTML = '';
      for (const name of all) {
        const label = document.createElement('label');
        label.className = 'trivia-check';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('data-plex-top10-genre', name);
        input.checked = want.has(String(name).toLowerCase());
        const span = document.createElement('span');
        span.textContent = name;
        label.append(input, span);
        genreBox.append(label);
      }
    }

    function pickedGenres() {
      return [...card.querySelectorAll('[data-plex-top10-genre]:checked')]
        .map((input) => input.getAttribute('data-plex-top10-genre'));
    }

    function render(status = {}) {
      const settings = status.settings || {};
      source = settings.source === 'global' ? 'global' : 'library';
      card.querySelectorAll('[data-plex-top10-source]').forEach((button) => {
        button.classList.toggle('active', button.getAttribute('data-plex-top10-source') === source);
      });
      const cache = $('plex-top10-cache');
      if (cache) cache.value = settings.cacheMinutes ?? 180;
      renderGenres(status.genres || [], settings.genres || []);

      const pill = $('plex-top10-status-pill');
      const detail = $('plex-top10-status-detail');
      const hint = $('plex-top10-genre-hint');
      if (pill) {
        pill.textContent = status.linked ? 'Linked' : 'No token';
        pill.className = `status-pill ${status.linked ? 'is-ok' : 'is-warn'}`;
      }
      if (detail) {
        detail.textContent = status.linked
          ? (source === 'global'
            ? 'Ranking what is popular across Plex.'
            : 'Ranking your own library by play count.')
          : 'Save a Plex token under Feature Presentation first.';
      }
      if (hint) {
        const count = (status.genres || []).length;
        hint.textContent = count
          ? `${count} genres in your movie library.`
          : 'Genres load once Plex is reachable.';
      }
    }

    async function load() {
      try {
        render(await apiGet('/api/plex-top10/settings'));
      } catch {
        render({});
      }
    }

    async function save() {
      try {
        render(await apiPost('/api/plex-top10/settings', {
          source,
          genres: pickedGenres(),
          cacheMinutes: Number($('plex-top10-cache')?.value ?? 180),
        }));
        toast('Plex Top 10 settings saved', 'good');
      } catch (error) {
        toast(error?.message || 'Could not save Plex Top 10 settings', 'bad');
      }
    }

    card.addEventListener('click', (event) => {
      const button = event.target.closest('[data-plex-top10-source]');
      if (!button) return;
      source = button.getAttribute('data-plex-top10-source');
      card.querySelectorAll('[data-plex-top10-source]').forEach((entry) => {
        entry.classList.toggle('active', entry === button);
      });
    });

    $('btn-plex-top10-save')?.addEventListener('click', save);

    $('btn-plex-top10-push')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await apiPost('/api/push/plex-top10', withTarget({ refresh: true }));
        toast(`Plex Top 10: ${result.movies?.length || 0} movies`, 'good');
      } catch (error) {
        toast(error?.message || 'Could not push Plex Top 10', 'bad');
      } finally {
        button.disabled = false;
      }
    });

    load();
  }());

  // ------------------------------------------- Settings → Chuck Norris

  const CN_PAGE_SIZE = 12;
  let chuckNorrisPage = 1;
  let chuckNorrisTimer = 0;

  function foldPreview(text) {
    return String(text || '')
      .toUpperCase()
      .replace(/[^A-Z0-9 !@#$()+\-=;:'"%,./?°]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function wrapPreview(text, width, { orphans = true } = {}) {
    const words = foldPreview(text).split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    const isOrphanCandidate = (word) => orphans
      && word
      && word.length <= 2
      && /[A-Z0-9]/.test(word);
    for (const word of words) {
      let token = word;
      if (token.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        while (token.length > width) {
          lines.push(token.slice(0, width));
          token = token.slice(width);
        }
        if (!token) {
          continue;
        }
      }
      const next = line ? `${line} ${token}` : token;
      if (next.length <= width) {
        line = next;
        continue;
      }
      if (line) {
        const parts = line.split(' ');
        const last = parts[parts.length - 1];
        if (
          parts.length > 1
          && isOrphanCandidate(last)
          && last.length + 1 + token.length <= width
        ) {
          parts.pop();
          lines.push(parts.join(' '));
          line = `${last} ${token}`;
          continue;
        }
        lines.push(line);
      }
      line = token;
    }
    if (line) {
      lines.push(line);
    }
    return lines;
  }

  function confirmCorpusRemove(kind, preview) {
    const snippet = String(preview || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const label = kind || 'item';
    return window.confirm(
      snippet
        ? `Remove this ${label}?\n\n${snippet}\n\nThis cannot be undone.`
        : `Remove this ${label}? This cannot be undone.`,
    );
  }

  function corpusManageActions({ hidden, custom, saveAttr, hideAttr, removeAttr }) {
    const hide = custom
      ? ''
      : `<button type="button" class="btn btn-outline btn-sm" ${hideAttr}>${hidden ? 'Restore' : 'Hide'}</button>`;
    return `<button type="button" class="btn btn-outline btn-sm" ${saveAttr}>Save</button>`
      + hide
      + `<button type="button" class="btn btn-danger btn-sm" ${removeAttr}>Remove</button>`;
  }

  function chuckNorrisCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} facts ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderChuckNorrisCard(data = {}) {
    const pill = $('chuck-norris-status-pill');
    const detail = $('chuck-norris-status-detail');
    const summary = $('chuck-norris-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${chuckNorrisCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit Chuck Norris facts. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? chuckNorrisCountsLine(data) : 'Loading…';
    }
  }

  function renderChuckNorrisPreview(text) {
    const host = $('chuck-norris-preview');
    if (!host) {
      return;
    }
    const lines = ['CHUCK NORRIS', ...wrapPreview(text, 22).slice(0, 5)];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines);
    const hint = $('chuck-norris-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 5 ? `Fits in ${rows} row${rows === 1 ? '' : 's'}` : 'Too long for one frame')
        : '';
    }
  }

  function renderChuckNorrisSettings(data = {}) {
    renderChuckNorrisCard(data);
    const list = $('chuck-norris-fact-list');
    if (list) {
      const facts = data.facts || [];
      if (!facts.length) {
        list.innerHTML = '<p class="hint">No facts match that search.</p>';
      } else {
        list.innerHTML = facts.map((fact) => `
          <article class="cn-fact${fact.hidden ? ' is-hidden' : ''}${fact.custom ? ' is-custom' : ''}" data-cn-id="${escapeHtml(fact.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(fact.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${fact.custom ? 'Yours' : 'Shipped'} · ${fact.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: fact.hidden,
                  custom: fact.custom,
                  saveAttr: 'data-cn-save',
                  hideAttr: 'data-cn-hide',
                  removeAttr: 'data-cn-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('chuck-norris-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    chuckNorrisPage = data.page || 1;
    const prev = $('btn-chuck-norris-prev');
    const next = $('btn-chuck-norris-next');
    if (prev) prev.disabled = chuckNorrisPage <= 1;
    if (next) next.disabled = chuckNorrisPage >= (data.pages || 1);
  }

  async function loadChuckNorrisStatus() {
    try {
      const data = await apiGet('/api/chuck-norris/facts?page=1&pageSize=1');
      renderChuckNorrisCard(data);
    } catch {
      renderChuckNorrisCard({});
    }
  }

  async function loadChuckNorrisFacts(page = chuckNorrisPage) {
    const query = $('chuck-norris-search')?.value || '';
    const hidden = Boolean($('chuck-norris-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(CN_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      const data = await apiGet(`/api/chuck-norris/facts?${params}`);
      renderChuckNorrisSettings(data);
    } catch {
      renderChuckNorrisSettings({});
    }
  }

  function openChuckNorrisManageSheet() {
    const sheet = $('chuck-norris-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    renderChuckNorrisPreview($('chuck-norris-new')?.value || '');
    loadChuckNorrisFacts(1);
  }

  function closeChuckNorrisManageSheet() {
    const sheet = $('chuck-norris-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadChuckNorrisStatus();
  }

  $('btn-chuck-norris-manage')?.addEventListener('click', () => openChuckNorrisManageSheet());
  $('btn-chuck-norris-manage-close')?.addEventListener('click', () => closeChuckNorrisManageSheet());
  registerSheetDismiss('chuck-norris-manage-sheet', () => closeChuckNorrisManageSheet());

  $('btn-chuck-norris-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/chuck-norris', withTarget());
      const preview = String(result.fact?.text || 'Chuck Norris fact').slice(0, 60);
      toast(preview, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Chuck Norris Fun Facts', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-chuck-norris-add')?.addEventListener('click', async () => {
    const input = $('chuck-norris-new');
    const text = input?.value || '';
    try {
      await apiPost('/api/chuck-norris/facts', { text });
      if (input) input.value = '';
      renderChuckNorrisPreview('');
      toast('Fact added', 'good');
      await loadChuckNorrisFacts(1);
    } catch (error) {
      toast(error.message || 'Could not add that fact', 'bad');
    }
  });

  $('chuck-norris-new')?.addEventListener('input', (event) => {
    renderChuckNorrisPreview(event.target.value);
  });

  $('chuck-norris-search')?.addEventListener('input', () => {
    window.clearTimeout(chuckNorrisTimer);
    chuckNorrisTimer = window.setTimeout(() => {
      loadChuckNorrisFacts(1);
    }, 250);
  });

  $('chuck-norris-show-hidden')?.addEventListener('change', () => loadChuckNorrisFacts(1));
  $('btn-chuck-norris-prev')?.addEventListener('click', () => loadChuckNorrisFacts(chuckNorrisPage - 1));
  $('btn-chuck-norris-next')?.addEventListener('click', () => loadChuckNorrisFacts(chuckNorrisPage + 1));

  $('chuck-norris-fact-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-cn-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-cn-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-cn-save]')) {
        await apiPost('/api/chuck-norris/facts', { id, text });
        toast('Fact saved', 'good');
      } else if (event.target.closest('[data-cn-remove]')) {
        if (!confirmCorpusRemove('fact', text)) {
          return;
        }
        await apiPost('/api/chuck-norris/facts', { id, remove: true });
        toast('Fact removed', 'good');
      } else if (event.target.closest('[data-cn-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/chuck-norris/facts', { id, hidden: !restore });
        toast(restore ? 'Fact restored' : 'Fact hidden', 'good');
      } else {
        return;
      }
      await loadChuckNorrisFacts(chuckNorrisPage);
    } catch (error) {
      toast(error.message || 'Could not update that fact', 'bad');
    }
  });

  loadChuckNorrisStatus();

  // ------------------------------------------------ Settings → Roast Me!

  const ROAST_PAGE_SIZE = 12;
  let roastMePage = 1;
  let roastMeTimer = 0;

  function roastMeCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} roasts ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderRoastMeCard(data = {}) {
    const pill = $('roast-me-status-pill');
    const detail = $('roast-me-status-detail');
    const summary = $('roast-me-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${roastMeCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit roasts. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? roastMeCountsLine(data) : 'Loading…';
    }
  }

  function renderRoastMePreview(text) {
    const host = $('roast-me-preview');
    if (!host) {
      return;
    }
    // No title row and a greedy wrap, same as the board: the block is centred
    // down the six rows rather than starting at the top.
    const wrapped = wrapPreview(text, 22, { orphans: false });
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('roast-me-fit-hint');
    if (hint) {
      hint.textContent = text
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function renderRoastMeSettings(data = {}) {
    renderRoastMeCard(data);
    const list = $('roast-me-roast-list');
    if (list) {
      const roasts = data.roasts || [];
      if (!roasts.length) {
        list.innerHTML = '<p class="hint">No roasts match that search.</p>';
      } else {
        list.innerHTML = roasts.map((roast) => `
          <article class="cn-fact${roast.hidden ? ' is-hidden' : ''}${roast.custom ? ' is-custom' : ''}" data-roast-id="${escapeHtml(roast.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(roast.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${roast.custom ? 'Yours' : 'Shipped'} · ${roast.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: roast.hidden,
                  custom: roast.custom,
                  saveAttr: 'data-roast-save',
                  hideAttr: 'data-roast-hide',
                  removeAttr: 'data-roast-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('roast-me-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    roastMePage = data.page || 1;
    const prev = $('btn-roast-me-prev');
    const next = $('btn-roast-me-next');
    if (prev) prev.disabled = roastMePage <= 1;
    if (next) next.disabled = roastMePage >= (data.pages || 1);
  }

  async function loadRoastMeStatus() {
    try {
      renderRoastMeCard(await apiGet('/api/roast-me/roasts?page=1&pageSize=1'));
    } catch {
      renderRoastMeCard({});
    }
  }

  async function loadRoastMeRoasts(page = roastMePage) {
    const query = $('roast-me-search')?.value || '';
    const hidden = Boolean($('roast-me-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(ROAST_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      renderRoastMeSettings(await apiGet(`/api/roast-me/roasts?${params}`));
    } catch {
      renderRoastMeSettings({});
    }
  }

  function openRoastMeManageSheet() {
    const sheet = $('roast-me-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    renderRoastMePreview($('roast-me-new')?.value || '');
    loadRoastMeRoasts(1);
  }

  function closeRoastMeManageSheet() {
    const sheet = $('roast-me-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadRoastMeStatus();
  }

  $('btn-roast-me-manage')?.addEventListener('click', () => openRoastMeManageSheet());
  $('btn-roast-me-manage-close')?.addEventListener('click', () => closeRoastMeManageSheet());
  registerSheetDismiss('roast-me-manage-sheet', () => closeRoastMeManageSheet());

  $('btn-roast-me-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/roast-me', withTarget());
      toast(String(result.roast?.text || 'Roast on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Roast Me!', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-roast-me-add')?.addEventListener('click', async () => {
    const input = $('roast-me-new');
    const text = input?.value || '';
    try {
      await apiPost('/api/roast-me/roasts', { text });
      if (input) input.value = '';
      renderRoastMePreview('');
      toast('Roast added', 'good');
      await loadRoastMeRoasts(1);
    } catch (error) {
      toast(error.message || 'Could not add that roast', 'bad');
    }
  });

  $('roast-me-new')?.addEventListener('input', (event) => {
    renderRoastMePreview(event.target.value);
  });

  $('roast-me-search')?.addEventListener('input', () => {
    window.clearTimeout(roastMeTimer);
    roastMeTimer = window.setTimeout(() => {
      loadRoastMeRoasts(1);
    }, 250);
  });

  $('roast-me-show-hidden')?.addEventListener('change', () => loadRoastMeRoasts(1));
  $('btn-roast-me-prev')?.addEventListener('click', () => loadRoastMeRoasts(roastMePage - 1));
  $('btn-roast-me-next')?.addEventListener('click', () => loadRoastMeRoasts(roastMePage + 1));

  $('roast-me-roast-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-roast-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-roast-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-roast-save]')) {
        await apiPost('/api/roast-me/roasts', { id, text });
        toast('Roast saved', 'good');
      } else if (event.target.closest('[data-roast-remove]')) {
        if (!confirmCorpusRemove('roast', text)) {
          return;
        }
        await apiPost('/api/roast-me/roasts', { id, remove: true });
        toast('Roast removed', 'good');
      } else if (event.target.closest('[data-roast-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/roast-me/roasts', { id, hidden: !restore });
        toast(restore ? 'Roast restored' : 'Roast hidden', 'good');
      } else {
        return;
      }
      await loadRoastMeRoasts(roastMePage);
    } catch (error) {
      toast(error.message || 'Could not update that roast', 'bad');
    }
  });

  loadRoastMeStatus();

  // -------------------------------------------- Settings → Family Quotes

  const FQ_PAGE_SIZE = 12;
  const FQ_WIDTH = 21;
  let familyQuotesPage = 1;
  let familyQuotesTimer = 0;

  // Mirrors quoteLines() in src/family-quotes.js: a row per sentence, wrapped
  // one column shy of the right edge, attribution glued to the last sentence.
  function familyQuoteLines(text, author) {
    const parts = [];
    let buffer = '';
    for (const piece of String(text || '').split(/(?<=[.!?])\s+/)) {
      buffer = buffer ? `${buffer} ${piece}` : piece;
      if (!/(?:\b(?:mr|mrs|ms|dr|st|jr|sr|prof|rev|gen|capt|lt|col|vs|etc)|\b[A-Za-z])\.$/i.test(buffer)) {
        parts.push(buffer);
        buffer = '';
      }
    }
    if (buffer) parts.push(buffer);
    const kept = parts.filter(Boolean);
    if (!kept.length) {
      return [];
    }
    const credit = String(author || '').trim();
    if (credit) {
      kept[kept.length - 1] = `${kept[kept.length - 1]} -${credit}`;
    }
    return kept.flatMap((part) => wrapPreview(part, FQ_WIDTH, { orphans: false }));
  }

  function familyQuotesCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} quotes ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderFamilyQuotesCard(data = {}) {
    const pill = $('family-quotes-status-pill');
    const detail = $('family-quotes-status-detail');
    const summary = $('family-quotes-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${familyQuotesCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit family quotes. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? familyQuotesCountsLine(data) : 'Loading…';
    }
  }

  function renderFamilyQuotesPreview(text, author) {
    const host = $('family-quotes-preview');
    if (!host) {
      return;
    }
    const wrapped = familyQuoteLines(text, author);
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('family-quotes-fit-hint');
    if (hint) {
      hint.textContent = text
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function refreshFamilyQuotesPreview() {
    renderFamilyQuotesPreview(
      $('family-quotes-new')?.value || '',
      $('family-quotes-new-author')?.value || '',
    );
  }

  function renderFamilyQuotesSettings(data = {}) {
    renderFamilyQuotesCard(data);
    const list = $('family-quotes-quote-list');
    if (list) {
      const quotes = data.quotes || [];
      if (!quotes.length) {
        list.innerHTML = '<p class="hint">No quotes match that search.</p>';
      } else {
        list.innerHTML = quotes.map((quote) => `
          <article class="cn-fact${quote.hidden ? ' is-hidden' : ''}${quote.custom ? ' is-custom' : ''}" data-fq-id="${escapeHtml(quote.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(quote.text)}</textarea>
            <input type="text" class="field-input fq-author" maxlength="48" placeholder="Who said it" value="${escapeHtml(quote.author || '')}">
            <div class="cn-fact-meta">
              <span class="hint">${quote.custom ? 'Yours' : 'Shipped'} · ${quote.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: quote.hidden,
                  custom: quote.custom,
                  saveAttr: 'data-fq-save',
                  hideAttr: 'data-fq-hide',
                  removeAttr: 'data-fq-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('family-quotes-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    familyQuotesPage = data.page || 1;
    const prev = $('btn-family-quotes-prev');
    const next = $('btn-family-quotes-next');
    if (prev) prev.disabled = familyQuotesPage <= 1;
    if (next) next.disabled = familyQuotesPage >= (data.pages || 1);
  }

  async function loadFamilyQuotesStatus() {
    try {
      renderFamilyQuotesCard(await apiGet('/api/family-quotes/quotes?page=1&pageSize=1'));
    } catch {
      renderFamilyQuotesCard({});
    }
  }

  async function loadFamilyQuotes(page = familyQuotesPage) {
    const query = $('family-quotes-search')?.value || '';
    const hidden = Boolean($('family-quotes-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(FQ_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      renderFamilyQuotesSettings(await apiGet(`/api/family-quotes/quotes?${params}`));
    } catch {
      renderFamilyQuotesSettings({});
    }
  }

  function openFamilyQuotesManageSheet() {
    const sheet = $('family-quotes-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    refreshFamilyQuotesPreview();
    loadFamilyQuotes(1);
  }

  function closeFamilyQuotesManageSheet() {
    const sheet = $('family-quotes-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadFamilyQuotesStatus();
  }

  $('btn-family-quotes-manage')?.addEventListener('click', () => openFamilyQuotesManageSheet());
  $('btn-family-quotes-manage-close')?.addEventListener('click', () => closeFamilyQuotesManageSheet());
  registerSheetDismiss('family-quotes-manage-sheet', () => closeFamilyQuotesManageSheet());

  $('btn-family-quotes-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/family-quotes', withTarget());
      toast(String(result.quote?.text || 'Family quote on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Family Quotes', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-family-quotes-add')?.addEventListener('click', async () => {
    const input = $('family-quotes-new');
    const authorInput = $('family-quotes-new-author');
    try {
      await apiPost('/api/family-quotes/quotes', {
        text: input?.value || '',
        author: authorInput?.value || '',
      });
      if (input) input.value = '';
      if (authorInput) authorInput.value = '';
      refreshFamilyQuotesPreview();
      toast('Quote added', 'good');
      await loadFamilyQuotes(1);
    } catch (error) {
      toast(error.message || 'Could not add that quote', 'bad');
    }
  });

  $('family-quotes-new')?.addEventListener('input', () => refreshFamilyQuotesPreview());
  $('family-quotes-new-author')?.addEventListener('input', () => refreshFamilyQuotesPreview());

  $('family-quotes-search')?.addEventListener('input', () => {
    window.clearTimeout(familyQuotesTimer);
    familyQuotesTimer = window.setTimeout(() => {
      loadFamilyQuotes(1);
    }, 250);
  });

  $('family-quotes-show-hidden')?.addEventListener('change', () => loadFamilyQuotes(1));
  $('btn-family-quotes-prev')?.addEventListener('click', () => loadFamilyQuotes(familyQuotesPage - 1));
  $('btn-family-quotes-next')?.addEventListener('click', () => loadFamilyQuotes(familyQuotesPage + 1));

  $('family-quotes-quote-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-fq-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-fq-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    const author = article.querySelector('.fq-author')?.value;
    try {
      if (event.target.closest('[data-fq-save]')) {
        await apiPost('/api/family-quotes/quotes', { id, text, author });
        toast('Quote saved', 'good');
      } else if (event.target.closest('[data-fq-remove]')) {
        if (!confirmCorpusRemove('quote', text)) {
          return;
        }
        await apiPost('/api/family-quotes/quotes', { id, remove: true });
        toast('Quote removed', 'good');
      } else if (event.target.closest('[data-fq-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/family-quotes/quotes', { id, hidden: !restore });
        toast(restore ? 'Quote restored' : 'Quote hidden', 'good');
      } else {
        return;
      }
      await loadFamilyQuotes(familyQuotesPage);
    } catch (error) {
      toast(error.message || 'Could not update that quote', 'bad');
    }
  });

  loadFamilyQuotesStatus();

  // -------------------------------------------- Settings → Warm Fuzzies

  const WF_PAGE_SIZE = 12;
  const WF_COLS = 22;
  const WF_INDENT = 2;
  const WF_BODY_WIDTH = WF_COLS - WF_INDENT;
  let warmFuzziesPage = 1;
  let warmFuzziesTimer = 0;

  function centerPreviewLine(line, width = WF_COLS) {
    const trimmed = String(line || '');
    if (!trimmed) {
      return '';
    }
    const pad = Math.max(0, Math.floor((width - trimmed.length) / 2));
    return `${' '.repeat(pad)}${trimmed}`;
  }

  // Mirrors fuzzyLines() in src/warm-fuzzies-layout.js.
  function warmFuzzyPreviewLines(text) {
    const folded = foldPreview(text);
    if (!folded) {
      return [];
    }
    const full = wrapPreview(folded, WF_COLS, { orphans: false });
    if (!full.length || full.length > 6) {
      return [];
    }
    if (full.length <= 2 && full.every((line) => line.length <= 20)) {
      return full.map((line) => centerPreviewLine(line));
    }
    let lines = full;
    let mode = 'flush';
    if (!full.some((line) => line.length >= WF_COLS)) {
      const sentences = String(folded).split(/(?<=[.!?])\s+/).filter(Boolean);
      const indented = [];
      for (const sentence of sentences) {
        indented.push(...wrapPreview(sentence, WF_BODY_WIDTH, { orphans: false }));
      }
      if (indented.length && indented.length <= 6
        && indented.every((line) => line.length <= WF_BODY_WIDTH)) {
        lines = indented;
        mode = 'indent';
      }
    }
    return lines.map((line) => {
      if (mode === 'indent') {
        return `${' '.repeat(WF_INDENT)}${line}`;
      }
      return line;
    });
  }

  function warmFuzziesCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} fuzzies ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderWarmFuzziesCard(data = {}) {
    const pill = $('warm-fuzzies-status-pill');
    const detail = $('warm-fuzzies-status-detail');
    const summary = $('warm-fuzzies-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${warmFuzziesCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit compliments like the marketplace channel. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? warmFuzziesCountsLine(data) : 'Loading…';
    }
  }

  function renderWarmFuzziesPreview(text) {
    const host = $('warm-fuzzies-preview');
    if (!host) {
      return;
    }
    const wrapped = warmFuzzyPreviewLines(text);
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('warm-fuzzies-fit-hint');
    if (hint) {
      hint.textContent = text
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function renderWarmFuzziesSettings(data = {}) {
    renderWarmFuzziesCard(data);
    const list = $('warm-fuzzies-fuzzy-list');
    if (list) {
      const fuzzies = data.fuzzies || [];
      if (!fuzzies.length) {
        list.innerHTML = '<p class="hint">No fuzzies match that search.</p>';
      } else {
        list.innerHTML = fuzzies.map((fuzzy) => `
          <article class="cn-fact${fuzzy.hidden ? ' is-hidden' : ''}${fuzzy.custom ? ' is-custom' : ''}" data-wf-id="${escapeHtml(fuzzy.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(fuzzy.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${fuzzy.custom ? 'Yours' : 'Shipped'} · ${fuzzy.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: fuzzy.hidden,
                  custom: fuzzy.custom,
                  saveAttr: 'data-wf-save',
                  hideAttr: 'data-wf-hide',
                  removeAttr: 'data-wf-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('warm-fuzzies-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page || 1} of ${data.pages}` : '';
    }
    warmFuzziesPage = data.page || 1;
    const prev = $('btn-warm-fuzzies-prev');
    const next = $('btn-warm-fuzzies-next');
    if (prev) prev.disabled = warmFuzziesPage <= 1;
    if (next) next.disabled = warmFuzziesPage >= (data.pages || 1);
  }

  async function loadWarmFuzziesStatus() {
    try {
      renderWarmFuzziesCard(await apiGet('/api/warm-fuzzies/fuzzies?page=1&pageSize=1'));
    } catch {
      renderWarmFuzziesCard({});
    }
  }

  async function loadWarmFuzzies(page = warmFuzziesPage) {
    const query = $('warm-fuzzies-search')?.value || '';
    const hidden = Boolean($('warm-fuzzies-show-hidden')?.checked);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(WF_PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    try {
      renderWarmFuzziesSettings(await apiGet(`/api/warm-fuzzies/fuzzies?${params}`));
    } catch {
      renderWarmFuzziesSettings({});
    }
  }

  function openWarmFuzziesManageSheet() {
    const sheet = $('warm-fuzzies-manage-sheet');
    if (sheet) {
      sheet.hidden = false;
    }
    renderWarmFuzziesPreview($('warm-fuzzies-new')?.value || '');
    loadWarmFuzzies(1);
  }

  function closeWarmFuzziesManageSheet() {
    const sheet = $('warm-fuzzies-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadWarmFuzziesStatus();
  }

  $('btn-warm-fuzzies-manage')?.addEventListener('click', () => openWarmFuzziesManageSheet());
  $('btn-warm-fuzzies-manage-close')?.addEventListener('click', () => closeWarmFuzziesManageSheet());
  registerSheetDismiss('warm-fuzzies-manage-sheet', () => closeWarmFuzziesManageSheet());

  $('btn-warm-fuzzies-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/warm-fuzzies', withTarget());
      toast(String(result.fuzzy?.text || 'Warm fuzzy on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Warm Fuzzies', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-warm-fuzzies-add')?.addEventListener('click', async () => {
    const input = $('warm-fuzzies-new');
    try {
      await apiPost('/api/warm-fuzzies/fuzzies', { text: input?.value || '' });
      if (input) input.value = '';
      renderWarmFuzziesPreview('');
      toast('Fuzzy added', 'good');
      await loadWarmFuzzies(1);
    } catch (error) {
      toast(error.message || 'Could not add that fuzzy', 'bad');
    }
  });

  $('warm-fuzzies-new')?.addEventListener('input', (event) => {
    renderWarmFuzziesPreview(event.currentTarget.value || '');
  });

  $('warm-fuzzies-search')?.addEventListener('input', () => {
    window.clearTimeout(warmFuzziesTimer);
    warmFuzziesTimer = window.setTimeout(() => {
      loadWarmFuzzies(1);
    }, 250);
  });

  $('warm-fuzzies-show-hidden')?.addEventListener('change', () => loadWarmFuzzies(1));
  $('btn-warm-fuzzies-prev')?.addEventListener('click', () => loadWarmFuzzies(warmFuzziesPage - 1));
  $('btn-warm-fuzzies-next')?.addEventListener('click', () => loadWarmFuzzies(warmFuzziesPage + 1));

  $('warm-fuzzies-fuzzy-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-wf-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-wf-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-wf-save]')) {
        await apiPost('/api/warm-fuzzies/fuzzies', { id, text });
        toast('Fuzzy saved', 'good');
      } else if (event.target.closest('[data-wf-remove]')) {
        if (!confirmCorpusRemove('fuzzy', text)) {
          return;
        }
        await apiPost('/api/warm-fuzzies/fuzzies', { id, remove: true });
        toast('Fuzzy removed', 'good');
      } else if (event.target.closest('[data-wf-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/warm-fuzzies/fuzzies', { id, hidden: !restore });
        toast(restore ? 'Fuzzy restored' : 'Fuzzy hidden', 'good');
      } else {
        return;
      }
      await loadWarmFuzzies(warmFuzziesPage);
    } catch (error) {
      toast(error.message || 'Could not update that fuzzy', 'bad');
    }
  });

  loadWarmFuzziesStatus();

  // ------------------------------------------- Settings → Daily Bucket Fillers

  const BF_PAGE_SIZE = 12;
  const BF_COLS = 22;
  const BF_INDENT = 2;
  const BF_TIGHT = 18;
  let dailyBucketFillersPage = 1;
  let dailyBucketFillersTimer = 0;

  // Mirrors fillerLines() in src/daily-bucket-fillers-layout.js.
  function dailyBucketFillerPreviewLines(text) {
    const folded = foldPreview(text);
    if (!folded) {
      return [];
    }
    const full = wrapPreview(folded, BF_COLS, { orphans: true });
    if (!full.length || full.length > 6) {
      return [];
    }
    if (full.length <= 2 && full.every((line) => line.length <= 20)) {
      return full.map((line) => centerPreviewLine(line));
    }
    const tight = wrapPreview(folded, BF_TIGHT, { orphans: true });
    if (tight.length && tight.length <= 6 && tight.every((line) => line.length <= BF_TIGHT)) {
      return tight.map((line) => `${' '.repeat(BF_INDENT)}${line}`);
    }
    const indented = wrapPreview(folded, BF_COLS - BF_INDENT, { orphans: true });
    if (indented.length && indented.length <= 6
      && indented.every((line) => line.length <= BF_COLS - BF_INDENT)) {
      return indented.map((line) => `${' '.repeat(BF_INDENT)}${line}`);
    }
    return full;
  }

  function dailyBucketFillersCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} fillers ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderDailyBucketFillersCard(data = {}) {
    const pill = $('daily-bucket-fillers-status-pill');
    const detail = $('daily-bucket-fillers-status-detail');
    const summary = $('daily-bucket-fillers-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${dailyBucketFillersCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit kindness challenges like the marketplace channel. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? dailyBucketFillersCountsLine(data) : 'Loading…';
    }
  }

  function renderDailyBucketFillersPreview(text) {
    const host = $('daily-bucket-fillers-preview');
    if (!host) {
      return;
    }
    const wrapped = dailyBucketFillerPreviewLines(text);
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('daily-bucket-fillers-fit-hint');
    if (hint) {
      hint.textContent = text
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function renderDailyBucketFillersSettings(data = {}) {
    renderDailyBucketFillersCard(data);
    const list = $('daily-bucket-fillers-filler-list');
    if (list) {
      const fillers = data.fillers || [];
      if (!fillers.length) {
        list.innerHTML = '<p class="hint">No fillers match that search.</p>';
      } else {
        list.innerHTML = fillers.map((filler) => `
          <article class="cn-fact${filler.hidden ? ' is-hidden' : ''}${filler.custom ? ' is-custom' : ''}" data-bf-id="${escapeHtml(filler.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(filler.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${filler.custom ? 'Yours' : 'Shipped'} · ${filler.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: filler.hidden,
                  custom: filler.custom,
                  saveAttr: 'data-bf-save',
                  hideAttr: 'data-bf-hide',
                  removeAttr: 'data-bf-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('daily-bucket-fillers-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page || 1} of ${data.pages}` : '';
    }
    dailyBucketFillersPage = data.page || 1;
    const prev = $('btn-daily-bucket-fillers-prev');
    const next = $('btn-daily-bucket-fillers-next');
    if (prev) prev.disabled = dailyBucketFillersPage <= 1;
    if (next) next.disabled = dailyBucketFillersPage >= (data.pages || 1);
  }

  async function loadDailyBucketFillersStatus() {
    try {
      renderDailyBucketFillersCard(await apiGet('/api/daily-bucket-fillers/fillers?page=1&pageSize=1'));
    } catch {
      renderDailyBucketFillersCard({});
    }
  }

  async function loadDailyBucketFillers(page = dailyBucketFillersPage) {
    const query = $('daily-bucket-fillers-search')?.value || '';
    const hidden = Boolean($('daily-bucket-fillers-show-hidden')?.checked);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(BF_PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    try {
      renderDailyBucketFillersSettings(await apiGet(`/api/daily-bucket-fillers/fillers?${params}`));
    } catch {
      renderDailyBucketFillersSettings({});
    }
  }

  function openDailyBucketFillersManageSheet() {
    const sheet = $('daily-bucket-fillers-manage-sheet');
    if (sheet) {
      sheet.hidden = false;
    }
    renderDailyBucketFillersPreview($('daily-bucket-fillers-new')?.value || '');
    loadDailyBucketFillers(1);
  }

  function closeDailyBucketFillersManageSheet() {
    const sheet = $('daily-bucket-fillers-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadDailyBucketFillersStatus();
  }

  $('btn-daily-bucket-fillers-manage')?.addEventListener('click', () => openDailyBucketFillersManageSheet());
  $('btn-daily-bucket-fillers-manage-close')?.addEventListener('click', () => closeDailyBucketFillersManageSheet());
  registerSheetDismiss('daily-bucket-fillers-manage-sheet', () => closeDailyBucketFillersManageSheet());

  $('btn-daily-bucket-fillers-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/daily-bucket-fillers', withTarget());
      toast(String(result.filler?.text || 'Bucket filler on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Daily Bucket Fillers', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-daily-bucket-fillers-add')?.addEventListener('click', async () => {
    const input = $('daily-bucket-fillers-new');
    try {
      await apiPost('/api/daily-bucket-fillers/fillers', { text: input?.value || '' });
      if (input) input.value = '';
      renderDailyBucketFillersPreview('');
      toast('Filler added', 'good');
      await loadDailyBucketFillers(1);
    } catch (error) {
      toast(error.message || 'Could not add that filler', 'bad');
    }
  });

  $('daily-bucket-fillers-new')?.addEventListener('input', (event) => {
    renderDailyBucketFillersPreview(event.currentTarget.value || '');
  });

  $('daily-bucket-fillers-search')?.addEventListener('input', () => {
    window.clearTimeout(dailyBucketFillersTimer);
    dailyBucketFillersTimer = window.setTimeout(() => {
      loadDailyBucketFillers(1);
    }, 250);
  });

  $('daily-bucket-fillers-show-hidden')?.addEventListener('change', () => loadDailyBucketFillers(1));
  $('btn-daily-bucket-fillers-prev')?.addEventListener('click', () => loadDailyBucketFillers(dailyBucketFillersPage - 1));
  $('btn-daily-bucket-fillers-next')?.addEventListener('click', () => loadDailyBucketFillers(dailyBucketFillersPage + 1));

  $('daily-bucket-fillers-filler-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-bf-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-bf-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-bf-save]')) {
        await apiPost('/api/daily-bucket-fillers/fillers', { id, text });
        toast('Filler saved', 'good');
      } else if (event.target.closest('[data-bf-remove]')) {
        if (!confirmCorpusRemove('filler', text)) {
          return;
        }
        await apiPost('/api/daily-bucket-fillers/fillers', { id, remove: true });
        toast('Filler removed', 'good');
      } else if (event.target.closest('[data-bf-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/daily-bucket-fillers/fillers', { id, hidden: !restore });
        toast(restore ? 'Filler restored' : 'Filler hidden', 'good');
      } else {
        return;
      }
      await loadDailyBucketFillers(dailyBucketFillersPage);
    } catch (error) {
      toast(error.message || 'Could not update that filler', 'bad');
    }
  });

  loadDailyBucketFillersStatus();

  // ------------------------------------------- Settings → Misheard Lyrics

  const ML_PAGE_SIZE = 12;
  const ML_WIDTH = 20;
  let misheardLyricsPage = 1;
  let misheardLyricsTimer = 0;

  // Mirrors lyricLines() in src/misheard-lyrics-layout.js: wrap at 20
  // (house orphan pull so "A SOAPLESS PLACE" stays together), period on
  // the lyric, then `- ARTIST` on its own line(s). Two columns of air.
  function misheardLyricLines(text, artist) {
    const lyric = String(text || '').replace(/\s+/g, ' ').trim();
    if (!lyric) {
      return [];
    }
    const stopped = /[.!?]$/.test(lyric) ? lyric : `${lyric}.`;
    const body = wrapPreview(stopped, ML_WIDTH);
    const credit = String(artist || '').replace(/\s+/g, ' ').trim();
    if (credit) {
      body.push(...wrapPreview(`- ${credit}`, ML_WIDTH));
    }
    return body.map((line) => `  ${line}`);
  }

  function misheardLyricsCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} lyrics ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderMisheardLyricsCard(data = {}) {
    const pill = $('misheard-lyrics-status-pill');
    const detail = $('misheard-lyrics-status-detail');
    const summary = $('misheard-lyrics-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${misheardLyricsCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit misheard lyrics. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? misheardLyricsCountsLine(data) : 'Loading…';
    }
  }

  function renderMisheardLyricsPreview(text, artist) {
    const host = $('misheard-lyrics-preview');
    if (!host) {
      return;
    }
    const wrapped = misheardLyricLines(text, artist);
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('misheard-lyrics-fit-hint');
    if (hint) {
      hint.textContent = text
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function refreshMisheardLyricsPreview() {
    renderMisheardLyricsPreview(
      $('misheard-lyrics-new')?.value || '',
      $('misheard-lyrics-new-artist')?.value || '',
    );
  }

  function renderMisheardLyricsSettings(data = {}) {
    renderMisheardLyricsCard(data);
    const list = $('misheard-lyrics-lyric-list');
    if (list) {
      const lyrics = data.lyrics || [];
      if (!lyrics.length) {
        list.innerHTML = '<p class="hint">No lyrics match that search.</p>';
      } else {
        list.innerHTML = lyrics.map((lyric) => `
          <article class="cn-fact${lyric.hidden ? ' is-hidden' : ''}${lyric.custom ? ' is-custom' : ''}" data-ml-id="${escapeHtml(lyric.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="160">${escapeHtml(lyric.text)}</textarea>
            <input type="text" class="field-input ml-artist" maxlength="48" placeholder="Artist" value="${escapeHtml(lyric.artist || '')}">
            <div class="cn-fact-meta">
              <span class="hint">${lyric.custom ? 'Yours' : 'Shipped'} · ${lyric.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: lyric.hidden,
                  custom: lyric.custom,
                  saveAttr: 'data-ml-save',
                  hideAttr: 'data-ml-hide',
                  removeAttr: 'data-ml-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('misheard-lyrics-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    misheardLyricsPage = data.page || 1;
    const prev = $('btn-misheard-lyrics-prev');
    const next = $('btn-misheard-lyrics-next');
    if (prev) prev.disabled = misheardLyricsPage <= 1;
    if (next) next.disabled = misheardLyricsPage >= (data.pages || 1);
  }

  async function loadMisheardLyricsStatus() {
    try {
      renderMisheardLyricsCard(await apiGet('/api/misheard-lyrics/lyrics?page=1&pageSize=1'));
    } catch {
      renderMisheardLyricsCard({});
    }
  }

  async function loadMisheardLyrics(page = misheardLyricsPage) {
    const query = $('misheard-lyrics-search')?.value || '';
    const hidden = Boolean($('misheard-lyrics-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(ML_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      renderMisheardLyricsSettings(await apiGet(`/api/misheard-lyrics/lyrics?${params}`));
    } catch {
      renderMisheardLyricsSettings({});
    }
  }

  function openMisheardLyricsManageSheet() {
    const sheet = $('misheard-lyrics-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    refreshMisheardLyricsPreview();
    loadMisheardLyrics(1);
  }

  function closeMisheardLyricsManageSheet() {
    const sheet = $('misheard-lyrics-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadMisheardLyricsStatus();
  }

  $('btn-misheard-lyrics-manage')?.addEventListener('click', () => openMisheardLyricsManageSheet());
  $('btn-misheard-lyrics-manage-close')?.addEventListener('click', () => closeMisheardLyricsManageSheet());
  registerSheetDismiss('misheard-lyrics-manage-sheet', () => closeMisheardLyricsManageSheet());

  $('btn-misheard-lyrics-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/misheard-lyrics', withTarget());
      toast(String(result.lyric?.text || 'Misheard lyric on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Misheard Lyrics', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-misheard-lyrics-add')?.addEventListener('click', async () => {
    const input = $('misheard-lyrics-new');
    const artistInput = $('misheard-lyrics-new-artist');
    try {
      await apiPost('/api/misheard-lyrics/lyrics', {
        text: input?.value || '',
        artist: artistInput?.value || '',
      });
      if (input) input.value = '';
      if (artistInput) artistInput.value = '';
      refreshMisheardLyricsPreview();
      toast('Lyric added', 'good');
      await loadMisheardLyrics(1);
    } catch (error) {
      toast(error.message || 'Could not add that lyric', 'bad');
    }
  });

  $('misheard-lyrics-new')?.addEventListener('input', () => refreshMisheardLyricsPreview());
  $('misheard-lyrics-new-artist')?.addEventListener('input', () => refreshMisheardLyricsPreview());

  $('misheard-lyrics-search')?.addEventListener('input', () => {
    window.clearTimeout(misheardLyricsTimer);
    misheardLyricsTimer = window.setTimeout(() => {
      loadMisheardLyrics(1);
    }, 250);
  });

  $('misheard-lyrics-show-hidden')?.addEventListener('change', () => loadMisheardLyrics(1));
  $('btn-misheard-lyrics-prev')?.addEventListener('click', () => loadMisheardLyrics(misheardLyricsPage - 1));
  $('btn-misheard-lyrics-next')?.addEventListener('click', () => loadMisheardLyrics(misheardLyricsPage + 1));

  $('misheard-lyrics-lyric-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-ml-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-ml-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    const artist = article.querySelector('.ml-artist')?.value;
    try {
      if (event.target.closest('[data-ml-save]')) {
        await apiPost('/api/misheard-lyrics/lyrics', { id, text, artist });
        toast('Lyric saved', 'good');
      } else if (event.target.closest('[data-ml-remove]')) {
        if (!confirmCorpusRemove('lyric', text)) {
          return;
        }
        await apiPost('/api/misheard-lyrics/lyrics', { id, remove: true });
        toast('Lyric removed', 'good');
      } else if (event.target.closest('[data-ml-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/misheard-lyrics/lyrics', { id, hidden: !restore });
        toast(restore ? 'Lyric restored' : 'Lyric hidden', 'good');
      } else {
        return;
      }
      await loadMisheardLyrics(misheardLyricsPage);
    } catch (error) {
      toast(error.message || 'Could not update that lyric', 'bad');
    }
  });

  loadMisheardLyricsStatus();

  // ----------------------------------------------- Settings → Periodic Table

  let periodicTableState = { elements: [], categories: [], settings: { categories: [] } };

  function periodicTableCountsLine(data = {}) {
    const total = Number(data.total || 0);
    const available = Number(data.available || 0);
    const filtered = available < total;
    return filtered
      ? `${available} of ${total} elements in rotation`
      : `${total} elements in rotation`;
  }

  function readPeriodicTableCategories() {
    const grid = $('periodic-table-category-grid');
    if (!grid) {
      return [];
    }
    return [...grid.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter(Boolean);
  }

  function renderPeriodicTableCategories(data = {}) {
    const grid = $('periodic-table-category-grid');
    if (!grid) {
      return;
    }
    const selected = new Set((data.settings?.categories || []).map((value) => String(value)));
    const categories = Array.isArray(data.categories) ? data.categories : [];
    grid.innerHTML = categories.map((row) => {
      const id = String(row.id || '');
      const checked = selected.has(id) ? ' checked' : '';
      const count = Number(row.count) || 0;
      const label = String(row.label || id);
      return `<label class="periodic-table-category-item"><input type="checkbox" value="${escapeHtml(id)}"${checked}> ${escapeHtml(label)} <span class="hint">(${count})</span></label>`;
    }).join('');
  }

  function renderPeriodicTableElementSelect(data = {}, { filterCategories = null } = {}) {
    const select = $('periodic-table-element');
    if (!select) {
      return;
    }
    const selectedCategories = filterCategories
      ?? (data.settings?.categories || []);
    const allowed = selectedCategories.length
      ? new Set(selectedCategories)
      : null;
    const elements = (Array.isArray(data.elements) ? data.elements : [])
      .filter((element) => !allowed || allowed.has(element.category));
    const current = select.value;
    select.innerHTML = elements.map((element) => {
      const label = `${element.number} · ${element.name} (${element.symbol})`;
      return `<option value="${escapeHtml(String(element.number))}">${escapeHtml(label)}</option>`;
    }).join('');
    if (current && [...select.options].some((option) => option.value === current)) {
      select.value = current;
    } else if (select.options.length) {
      select.selectedIndex = 0;
    }
    return elements;
  }

  function renderPeriodicTablePreview(data = {}) {
    const host = $('periodic-table-preview');
    if (!host) {
      return;
    }
    const select = $('periodic-table-element');
    const number = Number(select?.value);
    const element = (Array.isArray(data.elements) ? data.elements : periodicTableState.elements || [])
      .find((row) => row.number === number)
      || periodicTableState.elements?.[0];
    const lines = Array.isArray(element?.lines) ? element.lines : [];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines.slice(0, 6));
  }

  function renderPeriodicTableSettings(data = {}) {
    periodicTableState = {
      elements: data.elements || [],
      categories: data.categories || [],
      settings: data.settings || { categories: [] },
      available: data.available,
      total: data.total,
    };
    const pill = $('periodic-table-status-pill');
    const detail = $('periodic-table-status-detail');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
      pill.className = `status-pill ${data.available ? 'is-ok' : ''}`;
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${periodicTableCountsLine(data)}. Filter by category or push a specific element to test.`
        : 'All 118 elements with atomic number, name, symbol, category, and weight — centred like the marketplace channel.';
    }
    renderPeriodicTableCategories(data);
    const visible = renderPeriodicTableElementSelect(data);
    renderPeriodicTablePreview({ ...data, elements: visible });
  }

  async function loadPeriodicTableSettings() {
    try {
      renderPeriodicTableSettings(await apiGet('/api/periodic-table/settings'));
    } catch (_error) {
      renderPeriodicTableSettings({});
    }
  }

  $('periodic-table-element')?.addEventListener('change', () => renderPeriodicTablePreview(periodicTableState));
  $('periodic-table-category-grid')?.addEventListener('change', () => {
    const visible = renderPeriodicTableElementSelect(periodicTableState, {
      filterCategories: readPeriodicTableCategories(),
    });
    renderPeriodicTablePreview({ ...periodicTableState, elements: visible });
  });

  $('btn-periodic-table-save')?.addEventListener('click', async () => {
    const button = $('btn-periodic-table-save');
    try {
      button.disabled = true;
      const result = await apiPost('/api/periodic-table/settings', {
        categories: readPeriodicTableCategories(),
      });
      renderPeriodicTableSettings(result);
      toast('Periodic table filters saved', 'good');
    } catch (error) {
      toast(error.message || 'Could not save filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-periodic-table-reset')?.addEventListener('click', async () => {
    const button = $('btn-periodic-table-reset');
    try {
      button.disabled = true;
      const result = await apiPost('/api/periodic-table/settings', { reset: true });
      renderPeriodicTableSettings(result);
      toast('Periodic table filters reset', 'good');
    } catch (error) {
      toast(error.message || 'Could not reset filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-periodic-table-push-selected')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const number = Number($('periodic-table-element')?.value);
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/periodic-table', withTarget({ number }));
      toast(`Pushed ${result.element?.name || 'element'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-periodic-table-push-random')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/periodic-table', withTarget());
      toast(`Pushed ${result.element?.name || 'element'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadPeriodicTableSettings();

  // ----------------------------------------------- Settings → US State Facts

  let usStateFactsState = { states: [], regions: [], settings: { regions: [] } };

  function usStateFactsCountsLine(data = {}) {
    const total = Number(data.total || 0);
    const available = Number(data.available || 0);
    const filtered = available < total;
    return filtered
      ? `${available} of ${total} states in rotation`
      : `${total} states in rotation`;
  }

  function readUsStateFactsRegions() {
    const grid = $('us-state-facts-region-grid');
    if (!grid) {
      return [];
    }
    return [...grid.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter(Boolean);
  }

  function renderUsStateFactsRegions(data = {}) {
    const grid = $('us-state-facts-region-grid');
    if (!grid) {
      return;
    }
    const selected = new Set((data.settings?.regions || []).map((value) => String(value)));
    const regions = Array.isArray(data.regions) ? data.regions : [];
    grid.innerHTML = regions.map((row) => {
      const id = String(row.id || '');
      const checked = selected.has(id) ? ' checked' : '';
      const count = Number(row.count) || 0;
      const label = String(row.label || id);
      return `<label class="us-state-facts-region-item"><input type="checkbox" value="${escapeHtml(id)}"${checked}> ${escapeHtml(label)} <span class="hint">(${count})</span></label>`;
    }).join('');
  }

  function renderUsStateFactsStateSelect(data = {}, { filterRegions = null } = {}) {
    const select = $('us-state-facts-state');
    if (!select) {
      return;
    }
    const selectedRegions = filterRegions
      ?? (data.settings?.regions || []);
    const allowed = selectedRegions.length
      ? new Set(selectedRegions)
      : null;
    const states = (Array.isArray(data.states) ? data.states : [])
      .filter((state) => !allowed || allowed.has(state.region));
    const current = select.value;
    select.innerHTML = states.map((state) => {
      const label = state.name;
      return `<option value="${escapeHtml(String(state.id))}">${escapeHtml(label)}</option>`;
    }).join('');
    if (current && [...select.options].some((option) => option.value === current)) {
      select.value = current;
    } else if (select.options.length) {
      select.selectedIndex = 0;
    }
    return states;
  }

  function renderUsStateFactsPreview(data = {}) {
    const host = $('us-state-facts-preview');
    if (!host) {
      return;
    }
    const select = $('us-state-facts-state');
    const id = String(select?.value || '');
    const state = (Array.isArray(data.states) ? data.states : usStateFactsState.states || [])
      .find((row) => row.id === id)
      || usStateFactsState.states?.[0];
    const rows = Array.isArray(state?.rows) ? state.rows : [];
    if (rows.length) {
      renderVbGrid(host, rows);
      return;
    }
    paintPreviewLines(host, ['', '', '', '', '', '']);
  }

  function renderUsStateFactsSettings(data = {}) {
    usStateFactsState = {
      states: data.states || [],
      regions: data.regions || [],
      settings: data.settings || { regions: [] },
      available: data.available,
      total: data.total,
    };
    const pill = $('us-state-facts-status-pill');
    const detail = $('us-state-facts-status-detail');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
      pill.className = `status-pill ${data.available ? 'is-ok' : ''}`;
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${usStateFactsCountsLine(data)}. Filter by region or push a specific state to test.`
        : 'All 50 states with capital, bird, and flower — chip-flanked name like the marketplace channel.';
    }
    renderUsStateFactsRegions(data);
    const visible = renderUsStateFactsStateSelect(data);
    renderUsStateFactsPreview({ ...data, states: visible });
  }

  async function loadUsStateFactsSettings() {
    try {
      renderUsStateFactsSettings(await apiGet('/api/us-state-facts/settings'));
    } catch (_error) {
      renderUsStateFactsSettings({});
    }
  }

  $('us-state-facts-state')?.addEventListener('change', () => renderUsStateFactsPreview(usStateFactsState));
  $('us-state-facts-region-grid')?.addEventListener('change', () => {
    const visible = renderUsStateFactsStateSelect(usStateFactsState, {
      filterRegions: readUsStateFactsRegions(),
    });
    renderUsStateFactsPreview({ ...usStateFactsState, states: visible });
  });

  $('btn-us-state-facts-save')?.addEventListener('click', async () => {
    const button = $('btn-us-state-facts-save');
    try {
      button.disabled = true;
      const result = await apiPost('/api/us-state-facts/settings', {
        regions: readUsStateFactsRegions(),
      });
      renderUsStateFactsSettings(result);
      toast('US State Facts filters saved', 'good');
    } catch (error) {
      toast(error.message || 'Could not save filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-us-state-facts-reset')?.addEventListener('click', async () => {
    const button = $('btn-us-state-facts-reset');
    try {
      button.disabled = true;
      const result = await apiPost('/api/us-state-facts/settings', { reset: true });
      renderUsStateFactsSettings(result);
      toast('US State Facts filters reset', 'good');
    } catch (error) {
      toast(error.message || 'Could not reset filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-us-state-facts-push-selected')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const id = $('us-state-facts-state')?.value;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/us-state-facts', withTarget({ id }));
      toast(`Pushed ${result.state?.name || 'state'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-us-state-facts-push-random')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/us-state-facts', withTarget());
      toast(`Pushed ${result.state?.name || 'state'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadUsStateFactsSettings();

  // ----------------------------------------------- Settings → Word of the Day

  let wordOfTheDayState = { words: [], partsOfSpeech: [], settings: { partsOfSpeech: [] } };
  let wordOfTheDayTimer = 0;

  function wordOfTheDayCountsLine(data = {}) {
    const total = Number(data.total || 0);
    const available = Number(data.available || 0);
    const filtered = available < total;
    return filtered
      ? `${available} of ${total} words in rotation`
      : `${total.toLocaleString()} words in rotation`;
  }

  function readWordOfTheDayPos() {
    const grid = $('word-of-the-day-pos-grid');
    if (!grid) {
      return [];
    }
    return [...grid.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.value)
      .filter(Boolean);
  }

  function renderWordOfTheDayPos(data = {}) {
    const grid = $('word-of-the-day-pos-grid');
    if (!grid) {
      return;
    }
    const selected = new Set((data.settings?.partsOfSpeech || []).map((value) => String(value)));
    const parts = Array.isArray(data.partsOfSpeech) ? data.partsOfSpeech : [];
    grid.innerHTML = parts.map((row) => {
      const id = String(row.id || '');
      const checked = selected.has(id) ? ' checked' : '';
      const count = Number(row.count) || 0;
      const label = String(row.label || id);
      return `<label class="word-of-the-day-pos-item"><input type="checkbox" value="${escapeHtml(id)}"${checked}> ${escapeHtml(label)} <span class="hint">(${count.toLocaleString()})</span></label>`;
    }).join('');
  }

  function renderWordOfTheDaySelect(data = {}) {
    const select = $('word-of-the-day-word');
    if (!select) {
      return;
    }
    const words = Array.isArray(data.words) ? data.words : [];
    const current = select.value;
    select.innerHTML = words.map((entry) => {
      const label = `${entry.word} · ${entry.posLabel || entry.pos}`;
      return `<option value="${escapeHtml(entry.id)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (current && [...select.options].some((option) => option.value === current)) {
      select.value = current;
    } else if (select.options.length) {
      select.selectedIndex = 0;
    }
    return words;
  }

  function renderWordOfTheDayPreview() {
    const host = $('word-of-the-day-preview');
    if (!host) {
      return;
    }
    const select = $('word-of-the-day-word');
    const id = select?.value;
    const entry = (wordOfTheDayState.words || []).find((row) => row.id === id)
      || wordOfTheDayState.words?.[0];
    const lines = Array.isArray(entry?.lines) ? [...entry.lines] : [];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines.slice(0, 6));
  }

  function renderWordOfTheDaySettings(data = {}) {
    wordOfTheDayState = {
      words: data.words || [],
      partsOfSpeech: data.partsOfSpeech || [],
      settings: data.settings || { partsOfSpeech: [] },
      available: data.available,
      total: data.total,
    };
    const pill = $('word-of-the-day-status-pill');
    const detail = $('word-of-the-day-status-detail');
    if (pill) {
      pill.textContent = data.available != null ? `${Number(data.available).toLocaleString()} ready` : '…';
      pill.className = `status-pill ${data.available ? 'is-ok' : ''}`;
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${wordOfTheDayCountsLine(data)}. Search for a word or push a random one to test.`
        : 'Local board-fit vocabulary entries with part of speech and a short definition — like the marketplace channel.';
    }
    renderWordOfTheDayPos(data);
    renderWordOfTheDaySelect(data);
    renderWordOfTheDayPreview();
  }

  async function loadWordOfTheDaySettings(query = '') {
    try {
      const params = new URLSearchParams();
      if (query) {
        params.set('q', query);
      }
      const suffix = params.toString() ? `?${params}` : '';
      renderWordOfTheDaySettings(await apiGet(`/api/word-of-the-day/settings${suffix}`));
    } catch (_error) {
      renderWordOfTheDaySettings({});
    }
  }

  $('word-of-the-day-search')?.addEventListener('input', () => {
    window.clearTimeout(wordOfTheDayTimer);
    wordOfTheDayTimer = window.setTimeout(() => {
      loadWordOfTheDaySettings($('word-of-the-day-search')?.value || '');
    }, 250);
  });
  $('word-of-the-day-word')?.addEventListener('change', () => renderWordOfTheDayPreview());
  $('word-of-the-day-pos-grid')?.addEventListener('change', () => {
    const visible = renderWordOfTheDaySelect({
      ...wordOfTheDayState,
      words: (wordOfTheDayState.words || []).filter((entry) => {
        const allowed = readWordOfTheDayPos();
        return !allowed.length || allowed.includes(entry.pos);
      }),
    });
    wordOfTheDayState.words = visible;
    renderWordOfTheDayPreview();
  });

  $('btn-word-of-the-day-save')?.addEventListener('click', async () => {
    const button = $('btn-word-of-the-day-save');
    try {
      button.disabled = true;
      const result = await apiPost('/api/word-of-the-day/settings', {
        partsOfSpeech: readWordOfTheDayPos(),
      });
      renderWordOfTheDaySettings(result);
      toast('Word of the Day filters saved', 'good');
    } catch (error) {
      toast(error.message || 'Could not save filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-word-of-the-day-reset')?.addEventListener('click', async () => {
    const button = $('btn-word-of-the-day-reset');
    try {
      button.disabled = true;
      const result = await apiPost('/api/word-of-the-day/settings', { reset: true });
      renderWordOfTheDaySettings(result);
      toast('Word of the Day filters reset', 'good');
    } catch (error) {
      toast(error.message || 'Could not reset filters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-word-of-the-day-push-selected')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const id = $('word-of-the-day-word')?.value;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/word-of-the-day', withTarget({ id }));
      toast(`Pushed ${result.entry?.word || 'word'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-word-of-the-day-push-random')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/word-of-the-day', withTarget());
      toast(`Pushed ${result.entry?.word || 'word'}`, 'good');
    } catch (error) {
      toast(error.message || 'Push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadWordOfTheDaySettings();

  // ----------------------------------------------- Settings → Dad Jokes

  const DJ_PAGE_SIZE = 12;
  const DJ_WIDTH = 21;
  let dadJokesPage = 1;
  let dadJokesTimer = 0;

  // Mirrors jokeLines() in src/dad-jokes-layout.js: setup, a blank row, then
  // the punchline, each greedily wrapped one column shy of the right edge.
  function dadJokeLines(setup, punchline) {
    const top = wrapPreview(String(setup || '').trim(), DJ_WIDTH, { orphans: false });
    const bottom = wrapPreview(String(punchline || '').trim(), DJ_WIDTH, { orphans: false });
    if (!top.length) return bottom;
    if (!bottom.length) return top;
    return [...top, '', ...bottom];
  }

  function dadJokesCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} jokes ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderDadJokesCard(data = {}) {
    const pill = $('dad-jokes-status-pill');
    const detail = $('dad-jokes-status-detail');
    const summary = $('dad-jokes-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${dadJokesCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local board-fit dad jokes. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? dadJokesCountsLine(data) : 'Loading…';
    }
  }

  function renderDadJokesPreview(setup, punchline) {
    const host = $('dad-jokes-preview');
    if (!host) {
      return;
    }
    const wrapped = dadJokeLines(setup, punchline);
    const chunk = wrapped.slice(0, 6);
    const top = Math.floor((6 - chunk.length) / 2);
    const lines = [];
    for (let row = 0; row < 6; row += 1) {
      lines.push(chunk[row - top] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('dad-jokes-fit-hint');
    if (hint) {
      hint.textContent = setup
        ? (wrapped.length <= 6
          ? `Fits in ${wrapped.length} row${wrapped.length === 1 ? '' : 's'}`
          : 'Too long for one frame')
        : '';
    }
  }

  function refreshDadJokesPreview() {
    renderDadJokesPreview(
      $('dad-jokes-new')?.value || '',
      $('dad-jokes-new-punchline')?.value || '',
    );
  }

  function renderDadJokesSettings(data = {}) {
    renderDadJokesCard(data);
    const list = $('dad-jokes-joke-list');
    if (list) {
      const jokes = data.jokes || [];
      if (!jokes.length) {
        list.innerHTML = '<p class="hint">No jokes match that search.</p>';
      } else {
        list.innerHTML = jokes.map((joke) => `
          <article class="cn-fact${joke.hidden ? ' is-hidden' : ''}${joke.custom ? ' is-custom' : ''}" data-dj-id="${escapeHtml(joke.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="160">${escapeHtml(joke.setup)}</textarea>
            <textarea class="field-input dj-punchline" rows="2" maxlength="160" placeholder="Punchline">${escapeHtml(joke.punchline || '')}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${joke.custom ? 'Yours' : 'Shipped'} · ${joke.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: joke.hidden,
                  custom: joke.custom,
                  saveAttr: 'data-dj-save',
                  hideAttr: 'data-dj-hide',
                  removeAttr: 'data-dj-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('dad-jokes-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    dadJokesPage = data.page || 1;
    const prev = $('btn-dad-jokes-prev');
    const next = $('btn-dad-jokes-next');
    if (prev) prev.disabled = dadJokesPage <= 1;
    if (next) next.disabled = dadJokesPage >= (data.pages || 1);
  }

  async function loadDadJokesStatus() {
    try {
      renderDadJokesCard(await apiGet('/api/dad-jokes/jokes?page=1&pageSize=1'));
    } catch {
      renderDadJokesCard({});
    }
  }

  async function loadDadJokes(page = dadJokesPage) {
    const query = $('dad-jokes-search')?.value || '';
    const hidden = Boolean($('dad-jokes-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(DJ_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      renderDadJokesSettings(await apiGet(`/api/dad-jokes/jokes?${params}`));
    } catch {
      renderDadJokesSettings({});
    }
  }

  function openDadJokesManageSheet() {
    const sheet = $('dad-jokes-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    refreshDadJokesPreview();
    loadDadJokes(1);
  }

  function closeDadJokesManageSheet() {
    const sheet = $('dad-jokes-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadDadJokesStatus();
  }

  $('btn-dad-jokes-manage')?.addEventListener('click', () => openDadJokesManageSheet());
  $('btn-dad-jokes-manage-close')?.addEventListener('click', () => closeDadJokesManageSheet());
  registerSheetDismiss('dad-jokes-manage-sheet', () => closeDadJokesManageSheet());

  $('btn-dad-jokes-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/dad-jokes', withTarget());
      toast(String(result.joke?.setup || 'Dad joke on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Dad Jokes', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-dad-jokes-add')?.addEventListener('click', async () => {
    const setupInput = $('dad-jokes-new');
    const punchlineInput = $('dad-jokes-new-punchline');
    try {
      await apiPost('/api/dad-jokes/jokes', {
        setup: setupInput?.value || '',
        punchline: punchlineInput?.value || '',
      });
      if (setupInput) setupInput.value = '';
      if (punchlineInput) punchlineInput.value = '';
      refreshDadJokesPreview();
      toast('Joke added', 'good');
      await loadDadJokes(1);
    } catch (error) {
      toast(error.message || 'Could not add that joke', 'bad');
    }
  });

  $('dad-jokes-new')?.addEventListener('input', () => refreshDadJokesPreview());
  $('dad-jokes-new-punchline')?.addEventListener('input', () => refreshDadJokesPreview());

  $('dad-jokes-search')?.addEventListener('input', () => {
    window.clearTimeout(dadJokesTimer);
    dadJokesTimer = window.setTimeout(() => {
      loadDadJokes(1);
    }, 250);
  });

  $('dad-jokes-show-hidden')?.addEventListener('change', () => loadDadJokes(1));
  $('btn-dad-jokes-prev')?.addEventListener('click', () => loadDadJokes(dadJokesPage - 1));
  $('btn-dad-jokes-next')?.addEventListener('click', () => loadDadJokes(dadJokesPage + 1));

  $('dad-jokes-joke-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-dj-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-dj-id');
    const setup = article.querySelector('.cn-fact-text')?.value;
    const punchline = article.querySelector('.dj-punchline')?.value;
    try {
      if (event.target.closest('[data-dj-save]')) {
        await apiPost('/api/dad-jokes/jokes', { id, setup, punchline });
        toast('Joke saved', 'good');
      } else if (event.target.closest('[data-dj-remove]')) {
        if (!confirmCorpusRemove('joke', setup)) {
          return;
        }
        await apiPost('/api/dad-jokes/jokes', { id, remove: true });
        toast('Joke removed', 'good');
      } else if (event.target.closest('[data-dj-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/dad-jokes/jokes', { id, hidden: !restore });
        toast(restore ? 'Joke restored' : 'Joke hidden', 'good');
      } else {
        return;
      }
      await loadDadJokes(dadJokesPage);
    } catch (error) {
      toast(error.message || 'Could not update that joke', 'bad');
    }
  });

  loadDadJokesStatus();

  // ------------------------------------------- Settings → Amazing Facts

  const AF_PAGE_SIZE = 12;
  let amazingFactsPage = 1;
  let amazingFactsTimer = 0;
  let amazingFactsPoolTimer = 0;
  let amazingFactsCategoryOptions = [];
  let amazingFactsPoolSaving = false;

  function labelAmazingCategory(id) {
    return String(id || '')
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Trivia';
  }

  /**
   * Empty categories on the server means "every topic". The UI mirrors that by
   * checking every box — "Use all" used to clear the checks, which looked like
   * "use none".
   */
  function amazingFactsPoolIsAll(selectedPool = [], options = amazingFactsCategoryOptions) {
    return !Array.isArray(selectedPool) || selectedPool.length === 0
      || (options.length > 0 && selectedPool.length >= options.length);
  }

  function amazingFactsPoolLabel(data = {}) {
    const options = data.categoryOptions || amazingFactsCategoryOptions || [];
    const pool = Array.isArray(data.categories) ? data.categories : [];
    if (amazingFactsPoolIsAll(pool, options)) return 'All topics';
    if (pool.length === 1) return labelAmazingCategory(pool[0]);
    if (pool.length <= 3) return pool.map(labelAmazingCategory).join(', ');
    return `${pool.length} of ${options.length || pool.length} topics`;
  }

  function readAmazingFactsPoolCategories() {
    const pool = $('amazing-facts-pool-categories');
    if (!pool) return [];
    const boxes = [...pool.querySelectorAll('input[type="checkbox"]')];
    if (!boxes.length) return [];
    const checked = boxes.filter((el) => el.checked).map((el) => el.value).filter(Boolean);
    // All checked (or none left) → empty list = unrestricted draw.
    if (!checked.length || checked.length === boxes.length) return [];
    return checked;
  }

  function syncAmazingFactsPoolChipStyles() {
    const pool = $('amazing-facts-pool-categories');
    if (!pool) return;
    pool.querySelectorAll('.af-pool-chip').forEach((chip) => {
      const on = Boolean(chip.querySelector('input[type="checkbox"]')?.checked);
      chip.classList.toggle('is-on', on);
    });
  }

  function updateAmazingFactsPoolSummary(data = null) {
    const summary = $('amazing-facts-pool-summary');
    if (!summary) return;
    if (data) {
      summary.textContent = amazingFactsPoolLabel(data);
      return;
    }
    const categories = readAmazingFactsPoolCategories();
    summary.textContent = amazingFactsPoolLabel({
      categories,
      categoryOptions: amazingFactsCategoryOptions,
    });
  }

  function fillAmazingCategorySelects(options = [], selectedPool = []) {
    amazingFactsCategoryOptions = options;
    const browse = $('amazing-facts-browse-category');
    const pool = $('amazing-facts-pool-categories');
    const useAll = amazingFactsPoolIsAll(selectedPool, options);
    const selected = new Set((selectedPool || []).map(String));
    if (browse) {
      const current = browse.value || '';
      browse.innerHTML = '<option value="">All categories</option>'
        + options.map((row) => (
          `<option value="${escapeHtml(row.id)}">${escapeHtml(labelAmazingCategory(row.id))} (${row.count || 0})</option>`
        )).join('');
      browse.value = current;
    }
    if (pool) {
      pool.innerHTML = options.map((row) => {
        const on = useAll || selected.has(row.id);
        return `<label class="af-pool-chip${on ? ' is-on' : ''}">`
          + `<input type="checkbox" value="${escapeHtml(row.id)}"${on ? ' checked' : ''}>`
          + `<span>${escapeHtml(labelAmazingCategory(row.id))}</span>`
          + `<span class="af-pool-chip-count">${row.count || 0}</span>`
          + `</label>`;
      }).join('');
    }
    updateAmazingFactsPoolSummary({
      categories: useAll ? [] : [...selected],
      categoryOptions: options,
    });
  }

  function renderAmazingFactsPreview(text) {
    const host = $('amazing-facts-preview');
    if (!host) {
      return;
    }
    const body = wrapPreview(text, 22).slice(0, 5);
    const padTop = Math.floor((5 - body.length) / 2);
    const lines = ['AMAZING FACT'];
    for (let i = 0; i < 5; i += 1) {
      lines.push(body[i - padTop] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('amazing-facts-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 5 ? `Fits in ${rows} row${rows === 1 ? '' : 's'}` : 'Too long for one frame')
        : '';
    }
  }

  function amazingFactsCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} facts ready`
      + ` · ${amazingFactsPoolLabel(data).toLowerCase()}`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderAmazingFactsCard(data = {}) {
    const pill = $('amazing-facts-status-pill');
    const detail = $('amazing-facts-status-detail');
    const summary = $('amazing-facts-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${amazingFactsCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local amazing facts for the Vestaboard. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? amazingFactsCountsLine(data) : 'Loading…';
    }
  }

  function renderAmazingFactsSettings(data = {}) {
    renderAmazingFactsCard(data);
    const attribution = $('amazing-facts-attribution');
    if (attribution) {
      attribution.textContent = data.attribution
        ? `${data.attribution}${data.license ? ` (${data.license})` : ''}`
        : '';
    }
    fillAmazingCategorySelects(data.categoryOptions || amazingFactsCategoryOptions, data.categories || []);
    const list = $('amazing-facts-fact-list');
    if (list) {
      const facts = data.facts || [];
      if (!facts.length) {
        list.innerHTML = '<p class="hint">No facts match that search.</p>';
      } else {
        list.innerHTML = facts.map((fact) => `
          <article class="cn-fact${fact.hidden ? ' is-hidden' : ''}${fact.custom ? ' is-custom' : ''}" data-af-id="${escapeHtml(fact.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(fact.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${fact.custom ? 'Yours' : 'Shipped'} · ${escapeHtml(labelAmazingCategory(fact.category))} · ${fact.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: fact.hidden,
                  custom: fact.custom,
                  saveAttr: 'data-af-save',
                  hideAttr: 'data-af-hide',
                  removeAttr: 'data-af-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('amazing-facts-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    amazingFactsPage = data.page || 1;
    const prev = $('btn-amazing-facts-prev');
    const next = $('btn-amazing-facts-next');
    if (prev) prev.disabled = amazingFactsPage <= 1;
    if (next) next.disabled = amazingFactsPage >= (data.pages || 1);
  }

  async function loadAmazingFactsStatus() {
    try {
      const data = await apiGet('/api/amazing-facts/facts?page=1&pageSize=1');
      renderAmazingFactsCard(data);
      const attribution = $('amazing-facts-attribution');
      if (attribution) {
        attribution.textContent = data.attribution
          ? `${data.attribution}${data.license ? ` (${data.license})` : ''}`
          : '';
      }
      fillAmazingCategorySelects(data.categoryOptions || [], data.categories || []);
    } catch {
      renderAmazingFactsCard({});
    }
  }

  async function saveAmazingFactsPool({ quiet = false } = {}) {
    if (amazingFactsPoolSaving) return;
    amazingFactsPoolSaving = true;
    const categories = readAmazingFactsPoolCategories();
    try {
      const data = await apiPost('/api/amazing-facts/facts', { categories });
      fillAmazingCategorySelects(data.categoryOptions || amazingFactsCategoryOptions, data.categories || []);
      renderAmazingFactsCard(data);
      if (!quiet) {
        toast(
          amazingFactsPoolIsAll(data.categories || [], data.categoryOptions || [])
            ? 'Random push uses every topic'
            : `Random push uses ${amazingFactsPoolLabel(data).toLowerCase()}`,
          'good',
        );
      }
    } catch (error) {
      toast(error.message || 'Could not save topics', 'bad');
      await loadAmazingFactsStatus();
    } finally {
      amazingFactsPoolSaving = false;
    }
  }

  function queueAmazingFactsPoolSave() {
    syncAmazingFactsPoolChipStyles();
    updateAmazingFactsPoolSummary();
    window.clearTimeout(amazingFactsPoolTimer);
    amazingFactsPoolTimer = window.setTimeout(() => saveAmazingFactsPool({ quiet: true }), 350);
  }

  async function loadAmazingFacts(page = amazingFactsPage) {
    const query = $('amazing-facts-search')?.value || '';
    const hidden = Boolean($('amazing-facts-show-hidden')?.checked);
    const category = $('amazing-facts-browse-category')?.value || '';
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(AF_PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    if (category) params.set('category', category);
    try {
      const data = await apiGet(`/api/amazing-facts/facts?${params}`);
      renderAmazingFactsSettings(data);
    } catch (error) {
      toast(error.message || 'Could not load Amazing Facts', 'bad');
    }
  }

  function openAmazingFactsManageSheet() {
    const sheet = $('amazing-facts-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    renderAmazingFactsPreview($('amazing-facts-new')?.value || '');
    loadAmazingFacts(1);
  }

  function closeAmazingFactsManageSheet() {
    const sheet = $('amazing-facts-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadAmazingFactsStatus();
  }

  $('btn-amazing-facts-manage')?.addEventListener('click', () => openAmazingFactsManageSheet());
  $('btn-amazing-facts-manage-close')?.addEventListener('click', () => closeAmazingFactsManageSheet());
  registerSheetDismiss('amazing-facts-manage-sheet', () => closeAmazingFactsManageSheet());

  $('btn-amazing-facts-add')?.addEventListener('click', async () => {
    const input = $('amazing-facts-new');
    try {
      await apiPost('/api/amazing-facts/facts', {
        text: input?.value || '',
        category: $('amazing-facts-browse-category')?.value || 'custom',
      });
      if (input) input.value = '';
      toast('Fact added', 'good');
      await loadAmazingFacts(1);
      renderAmazingFactsPreview('');
    } catch (error) {
      toast(error.message || 'Could not add that fact', 'bad');
    }
  });

  $('btn-amazing-facts-push')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/amazing-facts', withTarget());
      toast(result.fact?.text ? 'Pushed an amazing fact' : 'Pushed Amazing Facts', 'good');
    } catch (error) {
      toast(error.message || 'Could not push Amazing Facts', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-amazing-facts-pool-all')?.addEventListener('click', async () => {
    const pool = $('amazing-facts-pool-categories');
    pool?.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.checked = true; });
    syncAmazingFactsPoolChipStyles();
    updateAmazingFactsPoolSummary();
    window.clearTimeout(amazingFactsPoolTimer);
    await saveAmazingFactsPool();
  });

  $('amazing-facts-pool-categories')?.addEventListener('change', (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;
    queueAmazingFactsPoolSave();
  });

  $('amazing-facts-new')?.addEventListener('input', () => {
    renderAmazingFactsPreview($('amazing-facts-new')?.value || '');
  });
  $('amazing-facts-search')?.addEventListener('input', () => {
    window.clearTimeout(amazingFactsTimer);
    amazingFactsTimer = window.setTimeout(() => loadAmazingFacts(1), 250);
  });
  $('amazing-facts-browse-category')?.addEventListener('change', () => loadAmazingFacts(1));
  $('amazing-facts-show-hidden')?.addEventListener('change', () => loadAmazingFacts(1));
  $('btn-amazing-facts-prev')?.addEventListener('click', () => loadAmazingFacts(amazingFactsPage - 1));
  $('btn-amazing-facts-next')?.addEventListener('click', () => loadAmazingFacts(amazingFactsPage + 1));

  $('amazing-facts-fact-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-af-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-af-id');
    const text = article.querySelector('.cn-fact-text')?.value || '';
    try {
      if (event.target.closest('[data-af-save]')) {
        await apiPost('/api/amazing-facts/facts', { id, text });
        toast('Fact saved', 'good');
      } else if (event.target.closest('[data-af-remove]')) {
        if (!confirmCorpusRemove('fact', text)) {
          return;
        }
        await apiPost('/api/amazing-facts/facts', { id, remove: true });
        toast('Fact removed', 'good');
      } else if (event.target.closest('[data-af-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/amazing-facts/facts', { id, hidden: !restore });
        toast(restore ? 'Fact restored' : 'Fact hidden', 'good');
      } else {
        return;
      }
      await loadAmazingFacts(amazingFactsPage);
    } catch (error) {
      toast(error.message || 'Could not update that fact', 'bad');
    }
  });

  loadAmazingFactsStatus();

  // ------------------------------------------- Settings → World Geography Facts

  const WG_PAGE_SIZE = 12;
  let worldGeographyFactsPage = 1;
  let worldGeographyFactsTimer = 0;
  let worldGeographyFactsCategoryOptions = [];

  function labelWorldGeographyCategory(id) {
    return String(id || '')
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Trivia';
  }

  function fillWorldGeographyCategorySelects(options = [], selectedPool = []) {
    worldGeographyFactsCategoryOptions = options;
    const browse = $('world-geography-facts-browse-category');
    const pool = $('world-geography-facts-pool-categories');
    const selected = new Set((selectedPool || []).map(String));
    if (browse) {
      const current = browse.value || '';
      browse.innerHTML = '<option value="">All categories</option>'
        + options.map((row) => (
          `<option value="${escapeHtml(row.id)}">${escapeHtml(labelWorldGeographyCategory(row.id))} (${row.count || 0})</option>`
        )).join('');
      browse.value = current;
    }
    if (pool) {
      pool.innerHTML = options.map((row) => (
        `<option value="${escapeHtml(row.id)}"${selected.has(row.id) ? ' selected' : ''}>${escapeHtml(labelWorldGeographyCategory(row.id))} (${row.count || 0})</option>`
      )).join('');
    }
  }

  function renderWorldGeographyFactsPreview(text) {
    const host = $('world-geography-facts-preview');
    if (!host) {
      return;
    }
    const lines = ['WORLD GEOGRAPHY', ...wrapPreview(text, 22).slice(0, 5)];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines);
    const hint = $('world-geography-facts-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 5 ? `Fits in ${rows} row${rows === 1 ? '' : 's'}` : 'Too long for one frame')
        : '';
    }
  }

  function worldGeographyFactsCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    const pool = Array.isArray(data.categories) ? data.categories.length : 0;
    return `${data.available || 0} facts ready`
      + (pool ? ` · pool: ${pool} categor${pool === 1 ? 'y' : 'ies'}` : '')
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderWorldGeographyFactsCard(data = {}) {
    const pill = $('world-geography-facts-status-pill');
    const detail = $('world-geography-facts-status-detail');
    const summary = $('world-geography-facts-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${worldGeographyFactsCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local world geography facts for the Vestaboard. No API key — manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? worldGeographyFactsCountsLine(data) : 'Loading…';
    }
  }

  function renderWorldGeographyFactsSettings(data = {}) {
    renderWorldGeographyFactsCard(data);
    const attribution = $('world-geography-facts-attribution');
    if (attribution) {
      attribution.textContent = data.attribution
        ? `${data.attribution}${data.license ? ` (${data.license})` : ''}`
        : '';
    }
    fillWorldGeographyCategorySelects(
      data.categoryOptions || worldGeographyFactsCategoryOptions,
      data.categories || [],
    );
    const list = $('world-geography-facts-fact-list');
    if (list) {
      const facts = data.facts || [];
      if (!facts.length) {
        list.innerHTML = '<p class="hint">No facts match that search.</p>';
      } else {
        list.innerHTML = facts.map((fact) => `
          <article class="cn-fact${fact.hidden ? ' is-hidden' : ''}${fact.custom ? ' is-custom' : ''}" data-wg-id="${escapeHtml(fact.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(fact.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${fact.custom ? 'Yours' : 'Shipped'} · ${escapeHtml(labelWorldGeographyCategory(fact.category))} · ${fact.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: fact.hidden,
                  custom: fact.custom,
                  saveAttr: 'data-wg-save',
                  hideAttr: 'data-wg-hide',
                  removeAttr: 'data-wg-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('world-geography-facts-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    worldGeographyFactsPage = data.page || 1;
    const prev = $('btn-world-geography-facts-prev');
    const next = $('btn-world-geography-facts-next');
    if (prev) prev.disabled = worldGeographyFactsPage <= 1;
    if (next) next.disabled = worldGeographyFactsPage >= (data.pages || 1);
  }

  async function loadWorldGeographyFactsStatus() {
    try {
      const data = await apiGet('/api/world-geography-facts/facts?page=1&pageSize=1');
      renderWorldGeographyFactsCard(data);
    } catch {
      renderWorldGeographyFactsCard({});
    }
  }

  async function loadWorldGeographyFacts(page = worldGeographyFactsPage) {
    const query = $('world-geography-facts-search')?.value || '';
    const hidden = Boolean($('world-geography-facts-show-hidden')?.checked);
    const category = $('world-geography-facts-browse-category')?.value || '';
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(WG_PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    if (category) params.set('category', category);
    try {
      const data = await apiGet(`/api/world-geography-facts/facts?${params}`);
      renderWorldGeographyFactsSettings(data);
    } catch (error) {
      toast(error.message || 'Could not load World Geography Facts', 'bad');
    }
  }

  function openWorldGeographyFactsManageSheet() {
    const sheet = $('world-geography-facts-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    renderWorldGeographyFactsPreview($('world-geography-facts-new')?.value || '');
    loadWorldGeographyFacts(1);
  }

  function closeWorldGeographyFactsManageSheet() {
    const sheet = $('world-geography-facts-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadWorldGeographyFactsStatus();
  }

  $('btn-world-geography-facts-manage')?.addEventListener('click', () => openWorldGeographyFactsManageSheet());
  $('btn-world-geography-facts-manage-close')?.addEventListener('click', () => closeWorldGeographyFactsManageSheet());
  registerSheetDismiss('world-geography-facts-manage-sheet', () => closeWorldGeographyFactsManageSheet());

  $('btn-world-geography-facts-add')?.addEventListener('click', async () => {
    const input = $('world-geography-facts-new');
    try {
      await apiPost('/api/world-geography-facts/facts', {
        text: input?.value || '',
        category: $('world-geography-facts-browse-category')?.value || 'custom',
      });
      if (input) input.value = '';
      renderWorldGeographyFactsPreview('');
      toast('Fact added', 'good');
      await loadWorldGeographyFacts(1);
    } catch (error) {
      toast(error.message || 'Could not add that fact', 'bad');
    }
  });

  $('btn-world-geography-facts-push')?.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const result = await apiPost('/api/push/world-geography-facts', withTarget());
      toast(result.fact?.text ? 'Pushed a geography fact' : 'Pushed World Geography Facts', 'good');
    } catch (error) {
      toast(error.message || 'Could not push World Geography Facts', 'bad');
    }
  });

  $('btn-world-geography-facts-save-pool')?.addEventListener('click', async () => {
    const pool = $('world-geography-facts-pool-categories');
    const categories = pool
      ? [...pool.selectedOptions].map((option) => option.value).filter(Boolean)
      : [];
    try {
      await apiPost('/api/world-geography-facts/facts', { categories });
      toast(categories.length ? 'Push pool saved' : 'Using all categories', 'good');
      await loadWorldGeographyFactsStatus();
    } catch (error) {
      toast(error.message || 'Could not save pool', 'bad');
    }
  });

  $('btn-world-geography-facts-clear-pool')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/world-geography-facts/facts', { categories: [] });
      toast('Using all categories', 'good');
      await loadWorldGeographyFacts(worldGeographyFactsPage);
    } catch (error) {
      toast(error.message || 'Could not clear pool', 'bad');
    }
  });

  $('world-geography-facts-new')?.addEventListener('input', () => {
    renderWorldGeographyFactsPreview($('world-geography-facts-new')?.value || '');
  });
  $('world-geography-facts-search')?.addEventListener('input', () => {
    window.clearTimeout(worldGeographyFactsTimer);
    worldGeographyFactsTimer = window.setTimeout(() => loadWorldGeographyFacts(1), 250);
  });
  $('world-geography-facts-browse-category')?.addEventListener('change', () => loadWorldGeographyFacts(1));
  $('world-geography-facts-show-hidden')?.addEventListener('change', () => loadWorldGeographyFacts(1));
  $('btn-world-geography-facts-prev')?.addEventListener('click', () => loadWorldGeographyFacts(worldGeographyFactsPage - 1));
  $('btn-world-geography-facts-next')?.addEventListener('click', () => loadWorldGeographyFacts(worldGeographyFactsPage + 1));

  $('world-geography-facts-fact-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-wg-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-wg-id');
    const text = article.querySelector('.cn-fact-text')?.value || '';
    try {
      if (event.target.closest('[data-wg-save]')) {
        await apiPost('/api/world-geography-facts/facts', { id, text });
        toast('Fact saved', 'good');
      } else if (event.target.closest('[data-wg-remove]')) {
        if (!confirmCorpusRemove('fact', text)) {
          return;
        }
        await apiPost('/api/world-geography-facts/facts', { id, remove: true });
        toast('Fact removed', 'good');
      } else if (event.target.closest('[data-wg-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/world-geography-facts/facts', { id, hidden: !restore });
        toast(restore ? 'Fact restored' : 'Fact hidden', 'good');
      } else {
        return;
      }
      await loadWorldGeographyFacts(worldGeographyFactsPage);
    } catch (error) {
      toast(error.message || 'Could not update that fact', 'bad');
    }
  });

  loadWorldGeographyFactsStatus();

  // ------------------------------------------- Settings → Conversation Starters

  const CS_PAGE_SIZE = 12;
  let conversationStartersPage = 1;
  let conversationStartersTimer = 0;

  function renderConversationStartersPreview(text) {
    const host = $('conversation-starters-preview');
    if (!host) {
      return;
    }
    const body = wrapPreview(text, 22).slice(0, 5);
    const padTop = Math.floor((5 - body.length) / 2);
    const lines = ["LET'S TALK"];
    for (let i = 0; i < 5; i += 1) {
      lines.push(body[i - padTop] || '');
    }
    paintPreviewLines(host, lines);
    const hint = $('conversation-starters-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 5 ? `Fits in ${rows} row${rows === 1 ? '' : 's'}` : 'Too long for one frame')
        : '';
    }
  }

  function conversationStartersCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} prompts ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderConversationStartersCard(data = {}) {
    const pill = $('conversation-starters-status-pill');
    const detail = $('conversation-starters-status-detail');
    const summary = $('conversation-starters-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${conversationStartersCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local icebreaker prompts for the Vestaboard. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? conversationStartersCountsLine(data) : 'Loading…';
    }
  }

  function renderConversationStartersSettings(data = {}) {
    renderConversationStartersCard(data);
    const list = $('conversation-starters-prompt-list');
    if (list) {
      const prompts = data.prompts || [];
      if (!prompts.length) {
        list.innerHTML = '<p class="hint">No prompts match that search.</p>';
      } else {
        list.innerHTML = prompts.map((prompt) => `
          <article class="cn-fact${prompt.hidden ? ' is-hidden' : ''}${prompt.custom ? ' is-custom' : ''}" data-cs-id="${escapeHtml(prompt.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(prompt.text)}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${prompt.custom ? 'Yours' : 'Shipped'} · ${prompt.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: prompt.hidden,
                  custom: prompt.custom,
                  saveAttr: 'data-cs-save',
                  hideAttr: 'data-cs-hide',
                  removeAttr: 'data-cs-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('conversation-starters-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    conversationStartersPage = data.page || 1;
    const prev = $('btn-conversation-starters-prev');
    const next = $('btn-conversation-starters-next');
    if (prev) prev.disabled = conversationStartersPage <= 1;
    if (next) next.disabled = conversationStartersPage >= (data.pages || 1);
  }

  async function loadConversationStartersStatus() {
    try {
      const data = await apiGet('/api/conversation-starters/prompts?page=1&pageSize=1');
      renderConversationStartersCard(data);
    } catch {
      renderConversationStartersCard({});
    }
  }

  async function loadConversationStarters(page = conversationStartersPage) {
    const query = $('conversation-starters-search')?.value || '';
    const hidden = Boolean($('conversation-starters-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(CS_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      const data = await apiGet(`/api/conversation-starters/prompts?${params}`);
      renderConversationStartersSettings(data);
    } catch {
      renderConversationStartersSettings({});
    }
  }

  function openConversationStartersManageSheet() {
    const sheet = $('conversation-starters-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    renderConversationStartersPreview($('conversation-starters-new')?.value || '');
    loadConversationStarters(1);
  }

  function closeConversationStartersManageSheet() {
    const sheet = $('conversation-starters-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadConversationStartersStatus();
  }

  $('btn-conversation-starters-manage')?.addEventListener('click', () => openConversationStartersManageSheet());
  $('btn-conversation-starters-manage-close')?.addEventListener('click', () => closeConversationStartersManageSheet());
  registerSheetDismiss('conversation-starters-manage-sheet', () => closeConversationStartersManageSheet());

  $('btn-conversation-starters-add')?.addEventListener('click', async () => {
    const input = $('conversation-starters-new');
    const text = input?.value || '';
    try {
      await apiPost('/api/conversation-starters/prompts', { text });
      if (input) input.value = '';
      renderConversationStartersPreview('');
      toast('Prompt added', 'good');
      await loadConversationStarters(1);
    } catch (error) {
      toast(error.message || 'Could not add that prompt', 'bad');
    }
  });

  $('btn-conversation-starters-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/conversation-starters', withTarget());
      const preview = String(result.prompt?.text || 'Conversation starter').slice(0, 60);
      toast(preview, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Conversation Starters', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('conversation-starters-new')?.addEventListener('input', (event) => {
    renderConversationStartersPreview(event.target.value);
  });

  $('conversation-starters-search')?.addEventListener('input', () => {
    window.clearTimeout(conversationStartersTimer);
    conversationStartersTimer = window.setTimeout(() => {
      loadConversationStarters(1);
    }, 250);
  });

  $('conversation-starters-show-hidden')?.addEventListener('change', () => loadConversationStarters(1));
  $('btn-conversation-starters-prev')?.addEventListener('click', () => loadConversationStarters(conversationStartersPage - 1));
  $('btn-conversation-starters-next')?.addEventListener('click', () => loadConversationStarters(conversationStartersPage + 1));

  $('conversation-starters-prompt-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-cs-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-cs-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-cs-save]')) {
        await apiPost('/api/conversation-starters/prompts', { id, text });
        toast('Prompt saved', 'good');
      } else if (event.target.closest('[data-cs-remove]')) {
        if (!confirmCorpusRemove('prompt', text)) {
          return;
        }
        await apiPost('/api/conversation-starters/prompts', { id, remove: true });
        toast('Prompt removed', 'good');
      } else if (event.target.closest('[data-cs-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/conversation-starters/prompts', { id, hidden: !restore });
        toast(restore ? 'Prompt restored' : 'Prompt hidden', 'good');
      } else {
        return;
      }
      await loadConversationStarters(conversationStartersPage);
    } catch (error) {
      toast(error.message || 'Could not update that prompt', 'bad');
    }
  });

  loadConversationStartersStatus();

  // ------------------------------------------- Settings → Stoic Quotes

  const SQ_PAGE_SIZE = 12;
  let stoicQuotesPage = 1;
  let stoicQuotesTimer = 0;

  function renderStoicQuotesPreview(text, author) {
    const host = $('stoic-quotes-preview');
    if (!host) {
      return;
    }
    const quoteLines = wrapPreview(text, 22).slice(0, 4);
    const who = foldPreview(author || '');
    const authorLine = who ? `- ${who}`.slice(0, 22) : '';
    const lines = ['STOIC', ...quoteLines];
    while (lines.length < 5) {
      lines.push('');
    }
    lines.push(authorLine);
    if (authorLine) {
      lines[5] = String(authorLine).padStart(22, ' ').slice(-22);
    }
    paintPreviewLines(host, lines);
    const hint = $('stoic-quotes-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 4 ? `Fits in ${rows} row${rows === 1 ? '' : 's'} + author` : 'Too long for one frame')
        : '';
    }
  }

  function stoicQuotesCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} quotes ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderStoicQuotesCard(data = {}) {
    const pill = $('stoic-quotes-status-pill');
    const detail = $('stoic-quotes-status-detail');
    const summary = $('stoic-quotes-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${stoicQuotesCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local Stoic quotes for the Vestaboard. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? stoicQuotesCountsLine(data) : 'Loading…';
    }
  }

  function renderStoicQuotesSettings(data = {}) {
    renderStoicQuotesCard(data);
    const list = $('stoic-quotes-quote-list');
    if (list) {
      const quotes = data.quotes || [];
      if (!quotes.length) {
        list.innerHTML = '<p class="hint">No quotes match that search.</p>';
      } else {
        list.innerHTML = quotes.map((quote) => `
          <article class="cn-fact${quote.hidden ? ' is-hidden' : ''}${quote.custom ? ' is-custom' : ''}" data-sq-id="${escapeHtml(quote.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(quote.text)}</textarea>
            <input type="text" class="field-input cn-fact-author" maxlength="40" value="${escapeHtml(quote.author || '')}" placeholder="Author">
            <div class="cn-fact-meta">
              <span class="hint">${quote.custom ? 'Yours' : 'Shipped'} · ${quote.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: quote.hidden,
                  custom: quote.custom,
                  saveAttr: 'data-sq-save',
                  hideAttr: 'data-sq-hide',
                  removeAttr: 'data-sq-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('stoic-quotes-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    stoicQuotesPage = data.page || 1;
    const prev = $('btn-stoic-quotes-prev');
    const next = $('btn-stoic-quotes-next');
    if (prev) prev.disabled = stoicQuotesPage <= 1;
    if (next) next.disabled = stoicQuotesPage >= (data.pages || 1);
  }

  async function loadStoicQuotesStatus() {
    try {
      const data = await apiGet('/api/stoic-quotes/quotes?page=1&pageSize=1');
      renderStoicQuotesCard(data);
    } catch {
      renderStoicQuotesCard({});
    }
  }

  async function loadStoicQuotes(page = stoicQuotesPage) {
    const query = $('stoic-quotes-search')?.value || '';
    const hidden = Boolean($('stoic-quotes-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(SQ_PAGE_SIZE),
      });
      if (hidden) {
        params.set('hidden', '1');
      }
      const data = await apiGet(`/api/stoic-quotes/quotes?${params}`);
      renderStoicQuotesSettings(data);
    } catch {
      renderStoicQuotesSettings({});
    }
  }

  function refreshStoicPreview() {
    renderStoicQuotesPreview(
      $('stoic-quotes-new')?.value || '',
      $('stoic-quotes-author')?.value || '',
    );
  }

  function openStoicQuotesManageSheet() {
    const sheet = $('stoic-quotes-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    refreshStoicPreview();
    loadStoicQuotes(1);
  }

  function closeStoicQuotesManageSheet() {
    const sheet = $('stoic-quotes-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadStoicQuotesStatus();
  }

  $('btn-stoic-quotes-manage')?.addEventListener('click', () => openStoicQuotesManageSheet());
  $('btn-stoic-quotes-manage-close')?.addEventListener('click', () => closeStoicQuotesManageSheet());
  registerSheetDismiss('stoic-quotes-manage-sheet', () => closeStoicQuotesManageSheet());

  $('btn-stoic-quotes-add')?.addEventListener('click', async () => {
    const input = $('stoic-quotes-new');
    const author = $('stoic-quotes-author');
    try {
      await apiPost('/api/stoic-quotes/quotes', {
        text: input?.value || '',
        author: author?.value || '',
      });
      if (input) input.value = '';
      if (author) author.value = '';
      refreshStoicPreview();
      toast('Quote added', 'good');
      await loadStoicQuotes(1);
    } catch (error) {
      toast(error.message || 'Could not add that quote', 'bad');
    }
  });

  $('btn-stoic-quotes-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/stoic-quotes', withTarget());
      const who = result.quote?.author || 'Stoic';
      const preview = String(result.quote?.text || 'Stoic quote').slice(0, 48);
      toast(`${who}: ${preview}`, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Stoic Quotes', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('stoic-quotes-new')?.addEventListener('input', refreshStoicPreview);
  $('stoic-quotes-author')?.addEventListener('input', refreshStoicPreview);

  $('stoic-quotes-search')?.addEventListener('input', () => {
    window.clearTimeout(stoicQuotesTimer);
    stoicQuotesTimer = window.setTimeout(() => {
      loadStoicQuotes(1);
    }, 250);
  });

  $('stoic-quotes-show-hidden')?.addEventListener('change', () => loadStoicQuotes(1));
  $('btn-stoic-quotes-prev')?.addEventListener('click', () => loadStoicQuotes(stoicQuotesPage - 1));
  $('btn-stoic-quotes-next')?.addEventListener('click', () => loadStoicQuotes(stoicQuotesPage + 1));

  $('stoic-quotes-quote-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-sq-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-sq-id');
    const text = article.querySelector('.cn-fact-text')?.value;
    const author = article.querySelector('.cn-fact-author')?.value;
    try {
      if (event.target.closest('[data-sq-save]')) {
        await apiPost('/api/stoic-quotes/quotes', { id, text, author });
        toast('Quote saved', 'good');
      } else if (event.target.closest('[data-sq-remove]')) {
        if (!confirmCorpusRemove('quote', text)) {
          return;
        }
        await apiPost('/api/stoic-quotes/quotes', { id, remove: true });
        toast('Quote removed', 'good');
      } else if (event.target.closest('[data-sq-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/stoic-quotes/quotes', { id, hidden: !restore });
        toast(restore ? 'Quote restored' : 'Quote hidden', 'good');
      } else {
        return;
      }
      await loadStoicQuotes(stoicQuotesPage);
    } catch (error) {
      toast(error.message || 'Could not update that quote', 'bad');
    }
  });

  loadStoicQuotesStatus();

  // ------------------------------------ Settings → Word Riddles

  const WR_PAGE_SIZE = 12;
  const WR_GREEN = 66;
  const WR_BLUE = 67;
  let wordRiddlesPage = 1;
  let wordRiddlesTimer = 0;
  let wordRiddlesPreviewPhase = 'riddle';

  function wrExpandLine(line, width) {
    const words = String(line || '').split(' ').filter(Boolean);
    if (words.length < 2) return line;
    let extra = width - words.join(' ').length;
    if (extra <= 0) return words.join(' ');
    let out = words[0];
    for (let i = 1; i < words.length; i += 1) {
      const add = extra > 0 ? 1 : 0;
      extra -= add;
      out += ` ${' '.repeat(add)}${words[i]}`;
    }
    return out;
  }

  function wrRiddleLines(text) {
    const lines = wrapPreview(text, 22);
    if (!lines.length || lines.length > 6) return lines.slice(0, 6);
    return lines.map((line) => wrExpandLine(line, 22));
  }

  function wrAnswerLines(text) {
    const folded = foldPreview(text || '');
    if (!folded) return [];
    if (!folded.includes(' ') && folded.length >= 2 && folded.length <= 11) {
      return [folded.split('').join(' ')];
    }
    return wrapPreview(folded, 22).slice(0, 2);
  }

  function wrPadBlock(lines, slots, align) {
    const chunk = (lines || []).slice(0, slots);
    const padTop = Math.floor((slots - chunk.length) / 2);
    const max = chunk.reduce((n, line) => Math.max(n, String(line || '').length), 0);
    const inset = Math.max(0, Math.floor((22 - max) / 2));
    const out = Array.from({ length: slots }, () => '');
    chunk.forEach((line, i) => {
      const start = align === 'center'
        ? Math.floor((22 - String(line || '').length) / 2)
        : inset;
      out[padTop + i] = `${' '.repeat(Math.max(0, start))}${line}`;
    });
    return out;
  }

  function renderWordRiddlesPreview(riddle, answer) {
    const host = $('word-riddles-preview');
    if (!host) return;
    const phase = wordRiddlesPreviewPhase;
    if (phase === 'intro') {
      paintPreviewLines(host, ['', '', 'RIDDLE ME', 'THIS...', '', ''], (row, col) => {
        if (row === 0) return col < 11 ? WR_GREEN : WR_BLUE;
        if (row === 5) return col < 11 ? WR_BLUE : WR_GREEN;
        return null;
      });
    } else if (phase === 'answer') {
      paintPreviewLines(host, wrPadBlock(wrAnswerLines(answer), 6, 'center'));
    } else {
      paintPreviewLines(host, wrPadBlock(wrRiddleLines(riddle), 6, 'block'));
    }
    const hint = $('word-riddles-fit-hint');
    if (hint) {
      const qRows = wrRiddleLines(riddle).length;
      const aRows = wrAnswerLines(answer).length;
      if (!riddle && !answer) {
        hint.textContent = '';
      } else if (qRows > 0 && qRows <= 6 && aRows > 0 && aRows <= 2) {
        hint.textContent = `Fits · riddle ${qRows} row${qRows === 1 ? '' : 's'}`;
      } else {
        hint.textContent = 'Too long for the board';
      }
    }
  }

  function refreshWordRiddlesPreview() {
    renderWordRiddlesPreview(
      $('word-riddles-new')?.value || '',
      $('word-riddles-answer')?.value || '',
    );
  }

  function wordRiddlesCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} riddles ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function setWordRiddlesSlider(value) {
    const slider = $('word-riddles-reveal-delay');
    const label = $('word-riddles-reveal-delay-value');
    if (slider) {
      slider.value = String(value);
      slider.setAttribute('aria-valuenow', String(value));
    }
    if (label) label.textContent = `${value}s`;
  }

  function renderWordRiddlesCard(data = {}) {
    const pill = $('word-riddles-status-pill');
    const detail = $('word-riddles-status-detail');
    const summary = $('word-riddles-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail && data.available != null) {
      detail.textContent = `${wordRiddlesCountsLine(data)}. Pick the delay between the riddle and the reveal, then manage the list or push a random one.`;
    }
    if (summary) {
      summary.textContent = data.available != null ? wordRiddlesCountsLine(data) : 'Loading…';
    }
    if (data.revealDelaySeconds != null) {
      setWordRiddlesSlider(data.revealDelaySeconds);
    }
    if (data.showIntro != null) {
      const box = $('word-riddles-show-intro');
      if (box) box.checked = data.showIntro !== false;
    }
  }

  function renderWordRiddlesSettings(data = {}) {
    renderWordRiddlesCard(data);
    const list = $('word-riddles-riddle-list');
    if (list) {
      const riddles = data.riddles || [];
      if (!riddles.length) {
        list.innerHTML = '<p class="hint">No riddles match that search.</p>';
      } else {
        list.innerHTML = riddles.map((item) => `
          <article class="cn-fact${item.hidden ? ' is-hidden' : ''}${item.custom ? ' is-custom' : ''}" data-wr-id="${escapeHtml(item.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(item.riddle)}</textarea>
            <input type="text" class="field-input cn-fact-author" maxlength="80" value="${escapeHtml(item.answer || '')}" placeholder="Answer">
            <div class="cn-fact-meta">
              <span class="hint">${item.custom ? 'Yours' : 'Shipped'} · ${item.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: item.hidden,
                  custom: item.custom,
                  saveAttr: 'data-wr-save',
                  hideAttr: 'data-wr-hide',
                  removeAttr: 'data-wr-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('word-riddles-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    wordRiddlesPage = data.page || 1;
    const prev = $('btn-word-riddles-prev');
    const next = $('btn-word-riddles-next');
    if (prev) prev.disabled = wordRiddlesPage <= 1;
    if (next) next.disabled = wordRiddlesPage >= (data.pages || 1);
  }

  async function loadWordRiddlesStatus() {
    try {
      const data = await apiGet('/api/word-riddles/riddles?page=1&pageSize=1');
      renderWordRiddlesCard(data);
    } catch {
      renderWordRiddlesCard({});
    }
  }

  async function loadWordRiddles(page = wordRiddlesPage) {
    const query = $('word-riddles-search')?.value || '';
    const hidden = Boolean($('word-riddles-show-hidden')?.checked);
    try {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        pageSize: String(WR_PAGE_SIZE),
      });
      if (hidden) params.set('hidden', '1');
      const data = await apiGet(`/api/word-riddles/riddles?${params}`);
      renderWordRiddlesSettings(data);
    } catch {
      renderWordRiddlesSettings({});
    }
  }

  async function saveWordRiddlesPlayback() {
    const delay = Number($('word-riddles-reveal-delay')?.value || 30);
    const showIntro = Boolean($('word-riddles-show-intro')?.checked);
    setWordRiddlesSlider(delay);
    try {
      const data = await apiPost('/api/word-riddles/settings', {
        revealDelaySeconds: delay,
        showIntro,
      });
      renderWordRiddlesCard(data);
    } catch (error) {
      toast(error.message || 'Could not save Word Riddles settings', 'bad');
    }
  }

  function openWordRiddlesManageSheet() {
    const sheet = $('word-riddles-manage-sheet');
    if (!sheet) return;
    sheet.hidden = false;
    refreshWordRiddlesPreview();
    loadWordRiddles(1);
  }

  function closeWordRiddlesManageSheet() {
    const sheet = $('word-riddles-manage-sheet');
    if (sheet) sheet.hidden = true;
    loadWordRiddlesStatus();
  }

  $('btn-word-riddles-manage')?.addEventListener('click', () => openWordRiddlesManageSheet());
  $('btn-word-riddles-manage-close')?.addEventListener('click', () => closeWordRiddlesManageSheet());
  registerSheetDismiss('word-riddles-manage-sheet', () => closeWordRiddlesManageSheet());

  $('btn-word-riddles-add')?.addEventListener('click', async () => {
    const input = $('word-riddles-new');
    const answer = $('word-riddles-answer');
    try {
      await apiPost('/api/word-riddles/riddles', {
        riddle: input?.value || '',
        answer: answer?.value || '',
      });
      if (input) input.value = '';
      if (answer) answer.value = '';
      refreshWordRiddlesPreview();
      toast('Riddle added', 'good');
      await loadWordRiddles(1);
    } catch (error) {
      toast(error.message || 'Could not add that riddle', 'bad');
    }
  });

  $('btn-word-riddles-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/word-riddles', withTarget());
      const preview = String(result.riddle?.riddle || 'Word riddle').slice(0, 48);
      toast(preview, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Word Riddles', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('word-riddles-new')?.addEventListener('input', refreshWordRiddlesPreview);
  $('word-riddles-answer')?.addEventListener('input', refreshWordRiddlesPreview);
  $('word-riddles-preview-phase')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-wr-phase]');
    if (!btn) return;
    wordRiddlesPreviewPhase = btn.getAttribute('data-wr-phase') || 'riddle';
    document.querySelectorAll('#word-riddles-preview-phase [data-wr-phase]').forEach((el) => {
      el.classList.toggle('active', el === btn);
    });
    refreshWordRiddlesPreview();
  });

  $('word-riddles-reveal-delay')?.addEventListener('input', (event) => {
    setWordRiddlesSlider(Number(event.currentTarget.value || 30));
  });
  $('word-riddles-reveal-delay')?.addEventListener('change', () => saveWordRiddlesPlayback());
  $('word-riddles-show-intro')?.addEventListener('change', () => saveWordRiddlesPlayback());

  $('word-riddles-search')?.addEventListener('input', () => {
    window.clearTimeout(wordRiddlesTimer);
    wordRiddlesTimer = window.setTimeout(() => {
      loadWordRiddles(1);
    }, 250);
  });

  $('word-riddles-show-hidden')?.addEventListener('change', () => loadWordRiddles(1));
  $('btn-word-riddles-prev')?.addEventListener('click', () => loadWordRiddles(wordRiddlesPage - 1));
  $('btn-word-riddles-next')?.addEventListener('click', () => loadWordRiddles(wordRiddlesPage + 1));

  $('word-riddles-riddle-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-wr-id]');
    if (!article) return;
    const id = article.getAttribute('data-wr-id');
    const riddle = article.querySelector('.cn-fact-text')?.value;
    const answer = article.querySelector('.cn-fact-author')?.value;
    try {
      if (event.target.closest('[data-wr-save]')) {
        await apiPost('/api/word-riddles/riddles', { id, riddle, answer });
        toast('Riddle saved', 'good');
      } else if (event.target.closest('[data-wr-remove]')) {
        if (!confirmCorpusRemove('riddle', riddle)) return;
        await apiPost('/api/word-riddles/riddles', { id, remove: true });
        toast('Riddle removed', 'good');
      } else if (event.target.closest('[data-wr-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/word-riddles/riddles', { id, hidden: !restore });
        toast(restore ? 'Riddle restored' : 'Riddle hidden', 'good');
      } else {
        return;
      }
      await loadWordRiddles(wordRiddlesPage);
    } catch (error) {
      toast(error.message || 'Could not update that riddle', 'bad');
    }
  });

  loadWordRiddlesStatus();

  // ------------------------------------------- Settings → Word Scramble

  const WS_HISTORY_PAGE = 10;
  let wordScrambleHistOffset = 0;
  let wordScrambleHistTotal = 0;
  let wordScramblePoll = null;
  let wordScrambleEndId = '';

  function renderWordScrambleSettings(data = {}) {
    const settings = data.settings || {};
    const creds = data.credentials || {};
    const link = data.shortlink || {};
    const setNum = (id, value) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    setNum('word-scramble-lobby', settings.lobbySeconds ?? 45);
    setNum('word-scramble-round', settings.roundSeconds ?? 180);
    setNum('word-scramble-intermission', settings.intermissionSeconds ?? 20);
    setNum('word-scramble-rounds', settings.rounds ?? 3);
    const dup = $('word-scramble-dup');
    if (dup && document.activeElement !== dup) {
      dup.value = settings.duplicateRule === 'cancel' ? 'cancel' : 'everyone';
    }
    const lateJoin = $('word-scramble-late-join');
    if (lateJoin) lateJoin.checked = settings.allowLateJoin !== false;
    const alias = $('word-scramble-alias');
    if (alias && document.activeElement !== alias) {
      alias.value = settings.preferredAlias || 'WITTYGAME';
    }
    const token = $('word-scramble-token');
    if (token && document.activeElement !== token) {
      token.value = '';
      token.placeholder = creds.hasOverride
        ? (creds.tokenHint ? `Override (…${creds.tokenHint})` : 'Override saved')
        : 'Optional — leave blank to use the global token';
    }
    const hint = $('word-scramble-token-hint');
    if (hint) {
      if (creds.envBlocksOverwrite) {
        hint.textContent = 'TINYURL_API_TOKEN is set in .env and cannot be replaced here.';
      } else if (creds.hasOverride) {
        hint.textContent = creds.tokenHint
          ? `Override saved (…${creds.tokenHint}).`
          : 'Override saved.';
      } else if (creds.usingGlobal && creds.hasToken) {
        hint.textContent = 'Using the global token.';
      } else {
        hint.textContent = 'Optional. Uses the global TinyURL token unless you paste one here.';
      }
    }
    const clear = $('word-scramble-clear-override');
    if (clear) clear.checked = false;

    const health = link.health || (link.alias ? 'unknown' : 'missing');
    const pill = $('word-scramble-status-pill');
    const detail = $('word-scramble-status-detail');
    const tone = health === 'healthy' ? 'ok' : (health === 'unhealthy' || link.alert ? 'bad' : 'warn');
    if (pill) {
      pill.textContent = link.alert ? 'Needs repair' : health === 'healthy' ? 'Active' : health === 'missing' ? 'Not set' : 'Unknown';
      pill.className = `status-pill ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = link.alert?.message
        || (link.display
          ? `Short link ${link.display}`
          : 'Invite phones to a 4×4 Word Scramble. The board holds the grid; the timer stays on the phone.');
    }
    const dot = $('word-scramble-dot');
    if (dot) dot.className = `gb-dot ${tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-warn'}`;
    if ($('word-scramble-shortlink-label')) {
      $('word-scramble-shortlink-label').textContent = link.display || 'No short link yet.';
    }
    if ($('word-scramble-shortlink-check')) {
      $('word-scramble-shortlink-check').textContent = formatShortlinkCheck(link);
    }
    if ($('word-scramble-target-hint')) {
      $('word-scramble-target-hint').textContent = data.targetUrl
        ? `Target ${data.targetUrl}`
        : 'Set a Public base URL (HTTPS) first.';
    }
  }

  async function loadWordScrambleSettings() {
    try {
      renderWordScrambleSettings(await apiGet('/api/word-scramble/settings'));
    } catch {
      renderWordScrambleSettings({});
    }
  }

  $('btn-word-scramble-save')?.addEventListener('click', async () => {
    const button = $('btn-word-scramble-save');
    if (button) button.disabled = true;
    try {
      const body = {
        lobbySeconds: Number($('word-scramble-lobby')?.value),
        roundSeconds: Number($('word-scramble-round')?.value),
        intermissionSeconds: Number($('word-scramble-intermission')?.value),
        rounds: Number($('word-scramble-rounds')?.value),
        duplicateRule: $('word-scramble-dup')?.value,
        allowLateJoin: $('word-scramble-late-join')?.checked !== false,
        preferredAlias: $('word-scramble-alias')?.value || '',
      };
      const token = String($('word-scramble-token')?.value || '').trim();
      if (token) body.apiToken = token;
      if ($('word-scramble-clear-override')?.checked) body.clearOverride = true;
      renderWordScrambleSettings(await apiPost('/api/word-scramble/settings', body));
      if ($('word-scramble-token')) $('word-scramble-token').value = '';
      toast('Word Scramble settings saved', 'ok');
    } catch (error) {
      toast(error.message || 'Could not save Word Scramble settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-word-scramble-push')?.addEventListener('click', async () => {
    try {
      const result = await apiPost('/api/push/word-scramble', {});
      toast(result.session?.code ? `Invite posted — code ${result.session.code}` : 'Invite posted', 'ok');
    } catch (error) {
      toast(error.message || 'Could not push invite', 'bad');
    }
  });

  function setWordScrambleTab(tab) {
    const active = tab === 'active';
    $('word-scramble-tab-active')?.classList.toggle('active', active);
    $('word-scramble-tab-history')?.classList.toggle('active', !active);
    if ($('word-scramble-active-panel')) $('word-scramble-active-panel').hidden = !active;
    if ($('word-scramble-history-panel')) $('word-scramble-history-panel').hidden = active;
  }

  async function loadWordScrambleActive() {
    const list = $('word-scramble-active-list');
    if (!list) return;
    try {
      const data = await apiGet('/api/game-sessions');
      const sessions = data.sessions || [];
      list.innerHTML = '';
      if (!sessions.length) {
        list.innerHTML = '<p class="hint">No live sessions.</p>';
        return;
      }
      for (const session of sessions) {
        const row = document.createElement('article');
        row.className = 'cn-fact';
        row.innerHTML = `<div class="cn-fact-meta"><strong>${escapeHtml(session.code)}</strong>`
          + ` · ${escapeHtml(session.phase)} · ${session.playerCount || 0} players`
          + ` · ${session.elapsedSeconds || 0}s</div>`
          + `<button type="button" class="btn btn-outline btn-sm" data-ws-end="${escapeHtml(session.sessionId)}">End</button>`;
        list.appendChild(row);
      }
    } catch (error) {
      list.innerHTML = `<p class="hint">${escapeHtml(error.message || 'Could not load sessions')}</p>`;
    }
  }

  /** Archived rows ticked for deletion, kept across a page turn. */
  const wordScrambleHistPicked = new Set();

  function syncWordScrambleHistPicks() {
    const boxes = [...document.querySelectorAll('[data-ws-hist]')];
    const button = $('btn-word-scramble-hist-delete');
    if (button) {
      button.disabled = wordScrambleHistPicked.size === 0;
      button.textContent = wordScrambleHistPicked.size
        ? `Delete ${wordScrambleHistPicked.size}`
        : 'Delete';
    }
    const all = $('word-scramble-hist-all');
    if (all) {
      all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
    }
  }

  async function loadWordScrambleHistory(offset = wordScrambleHistOffset) {
    const list = $('word-scramble-history-list');
    if (!list) return;
    try {
      const data = await apiGet(`/api/game-sessions/history?offset=${offset}&limit=${WS_HISTORY_PAGE}`);
      wordScrambleHistOffset = data.offset || 0;
      wordScrambleHistTotal = data.total || 0;
      list.innerHTML = '';
      const rows = data.rows || [];
      if (!rows.length) {
        list.innerHTML = '<p class="hint">No archived games yet.</p>';
      }
      for (const row of rows) {
        const article = document.createElement('article');
        article.className = 'cn-fact';
        const when = String(row.endedAt || row.startedAt || '').slice(0, 16).replace('T', ' ');
        const players = row.players?.length || 0;
        const rounds = row.rounds || 0;
        // The bare winner and word used to read as two mystery columns.
        const outcome = row.abandoned
          ? 'Abandoned'
          : `Won by ${row.winner?.name || 'nobody'}`;
        const best = row.topWord?.word
          ? ` · best word ${String(row.topWord.word).toUpperCase()}`
          : '';
        const id = String(row.sessionId || '');
        article.innerHTML = '<label class="trivia-check">'
          + `<input type="checkbox" data-ws-hist="${escapeHtml(id)}"`
          + `${wordScrambleHistPicked.has(id) ? ' checked' : ''}>`
          + `<span><strong>${escapeHtml(when)}</strong> · ${rounds} round${rounds === 1 ? '' : 's'}`
          + ` · ${players} player${players === 1 ? '' : 's'}<br>`
          + `<span class="hint">${escapeHtml(outcome)}${escapeHtml(best)}</span></span></label>`;
        list.appendChild(article);
      }
      syncWordScrambleHistPicks();
      const label = $('word-scramble-hist-page');
      if (label) {
        const page = Math.floor(wordScrambleHistOffset / WS_HISTORY_PAGE) + 1;
        const pages = Math.max(1, Math.ceil(wordScrambleHistTotal / WS_HISTORY_PAGE));
        label.textContent = `${page} / ${pages}`;
      }
    } catch (error) {
      list.innerHTML = `<p class="hint">${escapeHtml(error.message || 'Could not load history')}</p>`;
    }
  }

  function openWordScrambleSessions() {
    const sheet = $('word-scramble-sessions-sheet');
    if (!sheet) return;
    sheet.hidden = false;
    setWordScrambleTab('active');
    loadWordScrambleActive();
    loadWordScrambleHistory(0);
    if (wordScramblePoll) clearInterval(wordScramblePoll);
    wordScramblePoll = setInterval(() => {
      if ($('word-scramble-sessions-sheet')?.hidden) return;
      if (!$('word-scramble-active-panel')?.hidden) loadWordScrambleActive();
    }, 5000);
  }

  function closeWordScrambleSessions() {
    const sheet = $('word-scramble-sessions-sheet');
    if (sheet) sheet.hidden = true;
    if (wordScramblePoll) {
      clearInterval(wordScramblePoll);
      wordScramblePoll = null;
    }
  }

  function openWordScrambleEnd(sessionId) {
    wordScrambleEndId = sessionId;
    const sheet = $('word-scramble-end-sheet');
    if (sheet) sheet.hidden = false;
  }

  function closeWordScrambleEnd() {
    wordScrambleEndId = '';
    const sheet = $('word-scramble-end-sheet');
    if (sheet) sheet.hidden = true;
  }

  $('btn-word-scramble-sessions')?.addEventListener('click', () => openWordScrambleSessions());
  $('btn-word-scramble-sessions-close')?.addEventListener('click', () => closeWordScrambleSessions());
  registerSheetDismiss('word-scramble-sessions-sheet', () => closeWordScrambleSessions());
  $('word-scramble-sessions-tabs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ws-tab]');
    if (!btn) return;
    setWordScrambleTab(btn.getAttribute('data-ws-tab'));
  });
  $('word-scramble-active-list')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ws-end]');
    if (btn) openWordScrambleEnd(btn.getAttribute('data-ws-end'));
  });
  $('word-scramble-history-list')?.addEventListener('change', (event) => {
    const box = event.target.closest('[data-ws-hist]');
    if (!box) return;
    const id = box.getAttribute('data-ws-hist');
    if (box.checked) wordScrambleHistPicked.add(id);
    else wordScrambleHistPicked.delete(id);
    syncWordScrambleHistPicks();
  });
  $('word-scramble-hist-all')?.addEventListener('change', (event) => {
    const on = event.target.checked;
    for (const box of document.querySelectorAll('[data-ws-hist]')) {
      box.checked = on;
      const id = box.getAttribute('data-ws-hist');
      if (on) wordScrambleHistPicked.add(id);
      else wordScrambleHistPicked.delete(id);
    }
    syncWordScrambleHistPicks();
  });
  $('btn-word-scramble-hist-delete')?.addEventListener('click', async () => {
    const ids = [...wordScrambleHistPicked];
    if (!ids.length) return;
    try {
      const result = await apiPost('/api/game-sessions/history/delete', { sessionIds: ids });
      wordScrambleHistPicked.clear();
      toast(`Deleted ${result.removed || 0} game${result.removed === 1 ? '' : 's'}`, 'ok');
      loadWordScrambleHistory(0);
    } catch (error) {
      toast(error.message || 'Could not delete those games', 'bad');
    }
  });
  $('btn-word-scramble-hist-prev')?.addEventListener('click', () => {
    loadWordScrambleHistory(Math.max(0, wordScrambleHistOffset - WS_HISTORY_PAGE));
  });
  $('btn-word-scramble-hist-next')?.addEventListener('click', () => {
    if (wordScrambleHistOffset + WS_HISTORY_PAGE < wordScrambleHistTotal) {
      loadWordScrambleHistory(wordScrambleHistOffset + WS_HISTORY_PAGE);
    }
  });
  $('word-scramble-end-cancel')?.addEventListener('click', () => closeWordScrambleEnd());
  $('word-scramble-end-confirm')?.addEventListener('click', async () => {
    const id = wordScrambleEndId;
    closeWordScrambleEnd();
    if (!id) return;
    try {
      await apiPost('/api/game-sessions/end', { sessionId: id });
      toast('Session ended', 'ok');
      loadWordScrambleActive();
      loadWordScrambleHistory(wordScrambleHistOffset);
    } catch (error) {
      toast(error.message || 'Could not end session', 'bad');
    }
  });
  registerSheetDismiss('word-scramble-end-sheet', () => closeWordScrambleEnd());

  loadWordScrambleSettings();

  // ------------------------------------ Settings → On This Day in History

  const OTD_PAGE_SIZE = 12;
  const OTD_MONTHS = [
    '', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  let onThisDayPage = 1;
  let onThisDayTimer = 0;
  let onThisDayToday = { month: new Date().getMonth() + 1, day: new Date().getDate() };

  function fillOnThisDayMonthSelect() {
    const select = $('on-this-day-new-month');
    if (!select || select.options.length) {
      return;
    }
    for (let month = 1; month <= 12; month += 1) {
      const option = document.createElement('option');
      option.value = String(month);
      option.textContent = OTD_MONTHS[month];
      select.appendChild(option);
    }
  }

  function formatOtdDateLine(month, day, year) {
    const mon = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(month)] || '';
    const y = Number(year);
    const yearLabel = Number.isFinite(y) && y < 0 ? `${Math.abs(y)} BC` : String(year || '');
    if (!mon || !day || !yearLabel) {
      return '';
    }
    return `${mon} ${Number(day)}, ${yearLabel}`.slice(0, 22);
  }

  function renderOnThisDayPreview(text, month, day, year) {
    const host = $('on-this-day-preview');
    if (!host) {
      return;
    }
    const dateLine = formatOtdDateLine(month, day, year);
    const body = wrapPreview(text, 22).slice(0, 4);
    const lines = ['ON THIS DAY', dateLine, ...body];
    while (lines.length < 6) {
      lines.push('');
    }
    if (dateLine) {
      const pad = Math.max(0, Math.floor((22 - dateLine.length) / 2));
      lines[1] = `${' '.repeat(pad)}${dateLine}`.padEnd(22, ' ').slice(0, 22);
    }
    paintPreviewLines(host, lines);
    const hint = $('on-this-day-fit-hint');
    if (hint) {
      const rows = wrapPreview(text, 22).length;
      hint.textContent = text
        ? (rows <= 4 ? `Fits in ${rows} row${rows === 1 ? '' : 's'} + date` : 'Too long for one frame')
        : '';
    }
  }

  function refreshOnThisDayPreview() {
    renderOnThisDayPreview(
      $('on-this-day-new-text')?.value || '',
      $('on-this-day-new-month')?.value || onThisDayToday.month,
      $('on-this-day-new-day')?.value || onThisDayToday.day,
      $('on-this-day-new-year')?.value || new Date().getFullYear(),
    );
  }

  function onThisDayCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    const label = data.today?.label || 'today';
    return `${data.available || 0} ready for ${label}`
      + (data.totalAvailable != null ? ` · ${data.totalAvailable} year-round` : '')
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderOnThisDayCard(data = {}) {
    if (data.today) {
      onThisDayToday = {
        month: Number(data.today.month) || onThisDayToday.month,
        day: Number(data.today.day) || onThisDayToday.day,
      };
    }
    const pill = $('on-this-day-status-pill');
    const detail = $('on-this-day-status-detail');
    const summary = $('on-this-day-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} today` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${onThisDayCountsLine(data)}. Manage facts in a sheet, or push today’s pick to test.`
        : 'Local Wikipedia-sourced history for the Vestaboard. Manage facts in a sheet, or push today’s pick to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? onThisDayCountsLine(data) : 'Loading…';
    }
  }

  function renderOnThisDaySettings(data = {}) {
    renderOnThisDayCard(data);
    const attribution = $('on-this-day-attribution');
    if (attribution) {
      attribution.textContent = data.attribution
        ? `${data.attribution}${data.license ? ` (${data.license})` : ''}`
        : '';
    }
    const minYear = $('on-this-day-min-year');
    const maxYear = $('on-this-day-max-year');
    if (minYear && document.activeElement !== minYear) {
      minYear.value = data.minYear != null ? String(data.minYear) : '';
    }
    if (maxYear && document.activeElement !== maxYear) {
      maxYear.value = data.maxYear != null ? String(data.maxYear) : '';
    }
    const monthSelect = $('on-this-day-new-month');
    const dayInput = $('on-this-day-new-day');
    if (monthSelect && !monthSelect.value) {
      monthSelect.value = String(onThisDayToday.month);
    }
    if (dayInput && !dayInput.value) {
      dayInput.value = String(onThisDayToday.day);
    }
    const list = $('on-this-day-event-list');
    if (list) {
      const events = data.events || [];
      if (!events.length) {
        list.innerHTML = '<p class="hint">No facts match that search.</p>';
      } else {
        list.innerHTML = events.map((event) => {
          const label = formatOtdDateLine(event.month, event.day, event.year);
          return `
          <article class="cn-fact${event.hidden ? ' is-hidden' : ''}${event.custom ? ' is-custom' : ''}" data-otd-id="${escapeHtml(event.id)}">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="220">${escapeHtml(event.text)}</textarea>
            <input type="number" class="field-input cn-fact-author" data-otd-year maxlength="6" value="${escapeHtml(String(event.year))}" placeholder="Year">
            <div class="cn-fact-meta">
              <span class="hint">${event.custom ? 'Yours' : 'Shipped'} · ${escapeHtml(label)} · ${event.rows || 0} rows</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: event.hidden,
                  custom: event.custom,
                  saveAttr: 'data-otd-save',
                  hideAttr: 'data-otd-hide',
                  removeAttr: 'data-otd-remove',
                })}
              </div>
            </div>
          </article>`;
        }).join('');
      }
    }
    const pageLabel = $('on-this-day-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    onThisDayPage = data.page || 1;
    const prev = $('btn-on-this-day-prev');
    const next = $('btn-on-this-day-next');
    if (prev) prev.disabled = onThisDayPage <= 1;
    if (next) next.disabled = onThisDayPage >= (data.pages || 1);
  }

  async function loadOnThisDayStatus() {
    try {
      const params = new URLSearchParams({
        page: '1',
        pageSize: '1',
        month: String(onThisDayToday.month),
        day: String(onThisDayToday.day),
      });
      const data = await apiGet(`/api/on-this-day/events?${params}`);
      renderOnThisDayCard(data);
    } catch {
      renderOnThisDayCard({});
    }
  }

  async function loadOnThisDay(page = onThisDayPage) {
    const query = $('on-this-day-search')?.value || '';
    const hidden = Boolean($('on-this-day-show-hidden')?.checked);
    const todayOnly = Boolean($('on-this-day-today-only')?.checked);
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(OTD_PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    if (todayOnly) {
      params.set('month', String(onThisDayToday.month));
      params.set('day', String(onThisDayToday.day));
    }
    try {
      const data = await apiGet(`/api/on-this-day/events?${params}`);
      renderOnThisDaySettings(data);
    } catch (error) {
      toast(error.message || 'Could not load On This Day facts', 'bad');
    }
  }

  function openOnThisDayManageSheet() {
    const sheet = $('on-this-day-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    fillOnThisDayMonthSelect();
    refreshOnThisDayPreview();
    loadOnThisDay(1);
  }

  function closeOnThisDayManageSheet() {
    const sheet = $('on-this-day-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadOnThisDayStatus();
  }

  fillOnThisDayMonthSelect();

  $('btn-on-this-day-manage')?.addEventListener('click', () => openOnThisDayManageSheet());
  $('btn-on-this-day-manage-close')?.addEventListener('click', () => closeOnThisDayManageSheet());
  registerSheetDismiss('on-this-day-manage-sheet', () => closeOnThisDayManageSheet());

  $('btn-on-this-day-add')?.addEventListener('click', async () => {
    const text = $('on-this-day-new-text');
    try {
      await apiPost('/api/on-this-day/events', {
        text: text?.value || '',
        month: $('on-this-day-new-month')?.value || onThisDayToday.month,
        day: $('on-this-day-new-day')?.value || onThisDayToday.day,
        year: $('on-this-day-new-year')?.value,
      });
      if (text) text.value = '';
      toast('Fact added', 'good');
      await loadOnThisDay(1);
      refreshOnThisDayPreview();
    } catch (error) {
      toast(error.message || 'Could not add that fact', 'bad');
    }
  });

  $('btn-on-this-day-save-filters')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/on-this-day/events', {
        minYear: $('on-this-day-min-year')?.value ?? '',
        maxYear: $('on-this-day-max-year')?.value ?? '',
      });
      toast('Year range saved', 'good');
      await loadOnThisDay(1);
    } catch (error) {
      toast(error.message || 'Could not save year range', 'bad');
    }
  });

  $('btn-on-this-day-push')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/on-this-day', withTarget());
      toast(result.event?.dateLine ? `Pushed ${result.event.dateLine}` : 'Pushed On This Day', 'good');
    } catch (error) {
      toast(error.message || 'Could not push On This Day', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('on-this-day-new-text')?.addEventListener('input', refreshOnThisDayPreview);
  $('on-this-day-new-month')?.addEventListener('change', refreshOnThisDayPreview);
  $('on-this-day-new-day')?.addEventListener('input', refreshOnThisDayPreview);
  $('on-this-day-new-year')?.addEventListener('input', refreshOnThisDayPreview);

  $('on-this-day-search')?.addEventListener('input', () => {
    window.clearTimeout(onThisDayTimer);
    onThisDayTimer = window.setTimeout(() => {
      loadOnThisDay(1);
    }, 250);
  });
  $('on-this-day-today-only')?.addEventListener('change', () => loadOnThisDay(1));
  $('on-this-day-show-hidden')?.addEventListener('change', () => loadOnThisDay(1));
  $('btn-on-this-day-prev')?.addEventListener('click', () => loadOnThisDay(onThisDayPage - 1));
  $('btn-on-this-day-next')?.addEventListener('click', () => loadOnThisDay(onThisDayPage + 1));

  $('on-this-day-event-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-otd-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-otd-id');
    const text = article.querySelector('.cn-fact-text')?.value || '';
    const year = article.querySelector('[data-otd-year]')?.value;
    try {
      if (event.target.closest('[data-otd-save]')) {
        await apiPost('/api/on-this-day/events', { id, text, year });
        toast('Fact saved', 'good');
      } else if (event.target.closest('[data-otd-remove]')) {
        if (!confirmCorpusRemove('fact', text)) {
          return;
        }
        await apiPost('/api/on-this-day/events', { id, remove: true });
        toast('Fact removed', 'good');
      } else if (event.target.closest('[data-otd-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/on-this-day/events', { id, hidden: !restore });
        toast(restore ? 'Fact restored' : 'Fact hidden', 'good');
      } else {
        return;
      }
      await loadOnThisDay(onThisDayPage);
    } catch (error) {
      toast(error.message || 'Could not update that fact', 'bad');
    }
  });

  loadOnThisDayStatus();

  // ---------------------------------------- Settings → Baking Inspiration

  let bakingInspirationPage = 1;
  let bakingInspirationTimer = 0;

  function parseBakingIngredients(value) {
    return String(value || '')
      .split(/[,\n+/|]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  function renderBakingInspirationPreview(title, ingredients) {
    const host = $('baking-inspiration-preview');
    if (!host) {
      return;
    }
    const name = String(title || '').trim().toUpperCase().slice(0, 22);
    const parts = parseBakingIngredients(ingredients).map((item) => item.toUpperCase().slice(0, 22));
    const ingLines = wrapPreview(parts.join(' + '), 22).slice(0, 4);
    const lines = ['BAKE THIS', name, ...ingLines];
    while (lines.length < 6) {
      lines.push('');
    }
    paintPreviewLines(host, lines.slice(0, 6));
    const hint = $('baking-inspiration-fit-hint');
    if (hint) {
      if (!name && !parts.length) {
        hint.textContent = '';
      } else if (!name || !parts.length) {
        hint.textContent = 'Need a title and ingredients';
      } else if (ingLines.length > 4 || parts.length > 5) {
        hint.textContent = 'Too long for one frame';
      } else {
        hint.textContent = `${parts.length} ingredient${parts.length === 1 ? '' : 's'} · fits`;
      }
    }
  }

  function refreshBakingPreview() {
    renderBakingInspirationPreview(
      $('baking-inspiration-new-title')?.value || '',
      $('baking-inspiration-new-ings')?.value || '',
    );
  }

  function bakingInspirationCountsLine(data = {}) {
    const hidden = Number(data.hiddenCount || 0);
    const custom = Number(data.customCount || 0);
    return `${data.available || 0} ideas ready`
      + (custom ? ` · ${custom} added here` : '')
      + (hidden ? ` · ${hidden} hidden` : '');
  }

  function renderBakingInspirationCard(data = {}) {
    const pill = $('baking-inspiration-status-pill');
    const detail = $('baking-inspiration-status-detail');
    const summary = $('baking-inspiration-manage-summary');
    if (pill) {
      pill.textContent = data.available != null ? `${data.available} ready` : '…';
    }
    if (detail) {
      detail.textContent = data.available != null
        ? `${bakingInspirationCountsLine(data)}. Manage the list in a sheet, or push a random one to test.`
        : 'Local baking ideas for the Vestaboard. Manage the list in a sheet, or push a random one to test.';
    }
    if (summary) {
      summary.textContent = data.available != null ? bakingInspirationCountsLine(data) : 'Loading…';
    }
  }

  function renderBakingInspirationSettings(data = {}) {
    renderBakingInspirationCard(data);
    const list = $('baking-inspiration-idea-list');
    if (list) {
      const ideas = data.ideas || [];
      if (!ideas.length) {
        list.innerHTML = '<p class="hint">No ideas match that search.</p>';
      } else {
        list.innerHTML = ideas.map((idea) => `
          <article class="cn-fact${idea.hidden ? ' is-hidden' : ''}${idea.custom ? ' is-custom' : ''}" data-bake-id="${escapeHtml(idea.id)}">
            <input type="text" class="field-input cn-fact-author" maxlength="40" value="${escapeHtml(idea.title)}" placeholder="Title">
            <textarea class="field-input cn-fact-text" rows="2" maxlength="160">${escapeHtml((idea.ingredients || []).join(', '))}</textarea>
            <div class="cn-fact-meta">
              <span class="hint">${idea.custom ? 'Yours' : 'Shipped'} · ${(idea.ingredients || []).length} ingredients</span>
              <div class="cn-fact-actions">
                ${corpusManageActions({
                  hidden: idea.hidden,
                  custom: idea.custom,
                  saveAttr: 'data-bake-save',
                  hideAttr: 'data-bake-hide',
                  removeAttr: 'data-bake-remove',
                })}
              </div>
            </div>
          </article>
        `).join('');
      }
    }
    const pageLabel = $('baking-inspiration-page-label');
    if (pageLabel) {
      pageLabel.textContent = data.pages ? `Page ${data.page} of ${data.pages}` : '';
    }
    bakingInspirationPage = data.page || 1;
    const prev = $('btn-baking-inspiration-prev');
    const next = $('btn-baking-inspiration-next');
    if (prev) prev.disabled = bakingInspirationPage <= 1;
    if (next) next.disabled = bakingInspirationPage >= (data.pages || 1);
  }

  async function loadBakingInspirationStatus() {
    try {
      const data = await apiGet('/api/baking-inspiration/ideas?page=1&pageSize=1');
      renderBakingInspirationCard(data);
    } catch {
      renderBakingInspirationCard({});
    }
  }

  async function loadBakingInspiration(page = bakingInspirationPage) {
    const query = $('baking-inspiration-search')?.value || '';
    const hidden = Boolean($('baking-inspiration-show-hidden')?.checked);
    const params = new URLSearchParams({
      page: String(Math.max(1, page)),
      pageSize: '12',
    });
    if (query) params.set('q', query);
    if (hidden) params.set('hidden', '1');
    try {
      const data = await apiGet(`/api/baking-inspiration/ideas?${params}`);
      renderBakingInspirationSettings(data);
    } catch (error) {
      renderBakingInspirationSettings({});
      toast(error?.message || 'Could not load baking ideas', 'bad');
    }
  }

  function openBakingInspirationManageSheet() {
    const sheet = $('baking-inspiration-manage-sheet');
    if (!sheet) {
      return;
    }
    sheet.hidden = false;
    refreshBakingPreview();
    loadBakingInspiration(1);
  }

  function closeBakingInspirationManageSheet() {
    const sheet = $('baking-inspiration-manage-sheet');
    if (sheet) {
      sheet.hidden = true;
    }
    loadBakingInspirationStatus();
  }

  $('btn-baking-inspiration-manage')?.addEventListener('click', () => openBakingInspirationManageSheet());
  $('btn-baking-inspiration-manage-close')?.addEventListener('click', () => closeBakingInspirationManageSheet());
  registerSheetDismiss('baking-inspiration-manage-sheet', () => closeBakingInspirationManageSheet());

  $('btn-baking-inspiration-add')?.addEventListener('click', async () => {
    const title = $('baking-inspiration-new-title');
    const ings = $('baking-inspiration-new-ings');
    try {
      await apiPost('/api/baking-inspiration/ideas', {
        title: title?.value,
        ingredients: ings?.value,
      });
      if (title) title.value = '';
      if (ings) ings.value = '';
      refreshBakingPreview();
      toast('Baking idea added', 'good');
      await loadBakingInspiration(1);
    } catch (error) {
      toast(error.message || 'Could not add that idea', 'bad');
    }
  });

  $('btn-baking-inspiration-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/baking-inspiration', withTarget());
      const name = result.idea?.title || 'Baking idea';
      toast(name, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Baking Inspiration', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('baking-inspiration-new-title')?.addEventListener('input', refreshBakingPreview);
  $('baking-inspiration-new-ings')?.addEventListener('input', refreshBakingPreview);

  $('baking-inspiration-search')?.addEventListener('input', () => {
    window.clearTimeout(bakingInspirationTimer);
    bakingInspirationTimer = window.setTimeout(() => {
      loadBakingInspiration(1);
    }, 250);
  });
  $('baking-inspiration-show-hidden')?.addEventListener('change', () => loadBakingInspiration(1));
  $('btn-baking-inspiration-prev')?.addEventListener('click', () => loadBakingInspiration(bakingInspirationPage - 1));
  $('btn-baking-inspiration-next')?.addEventListener('click', () => loadBakingInspiration(bakingInspirationPage + 1));

  $('baking-inspiration-idea-list')?.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-bake-id]');
    if (!article) {
      return;
    }
    const id = article.getAttribute('data-bake-id');
    const title = article.querySelector('.cn-fact-author')?.value;
    const ingredients = article.querySelector('.cn-fact-text')?.value;
    try {
      if (event.target.closest('[data-bake-save]')) {
        await apiPost('/api/baking-inspiration/ideas', { id, title, ingredients });
        toast('Idea saved', 'good');
      } else if (event.target.closest('[data-bake-remove]')) {
        if (!confirmCorpusRemove('idea', title || ingredients)) {
          return;
        }
        await apiPost('/api/baking-inspiration/ideas', { id, remove: true });
        toast('Idea removed', 'good');
      } else if (event.target.closest('[data-bake-hide]')) {
        const restore = article.classList.contains('is-hidden');
        await apiPost('/api/baking-inspiration/ideas', { id, hidden: !restore });
        toast(restore ? 'Idea restored' : 'Idea hidden', 'good');
      } else {
        return;
      }
      await loadBakingInspiration(bakingInspirationPage);
    } catch (error) {
      toast(error.message || 'Could not update that idea', 'bad');
    }
  });

  loadBakingInspirationStatus();

  // --------------------------------------------- Settings → Stock Market

  function setStockChangeMode(mode) {
    const want = mode === 'points' ? 'points' : 'percent';
    document.querySelectorAll('#stock-market-change-mode [data-stock-change]').forEach((btn) => {
      const on = btn.getAttribute('data-stock-change') === want;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function currentStockChangeMode() {
    const active = document.querySelector('#stock-market-change-mode .segmented-btn.active');
    return active?.getAttribute('data-stock-change') === 'points' ? 'points' : 'percent';
  }

  function renderStockMarketPreview(tickers = []) {
    const host = $('stock-market-preview');
    if (!host) {
      return;
    }
    // Mirror stockMarketFrames / stockQuoteRow: white title chips, price+change
    // right-aligned ahead of a green/red direction chip, five quotes per page.
    const list = (tickers || [])
      .map((ticker) => String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.^_=-]/g, '').slice(0, 5))
      .filter(Boolean)
      .slice(0, 10);
    const page = list.slice(0, 5);
    const pages = Math.max(1, Math.ceil(Math.max(list.length, 1) / 5));
    const title = list.length > 5 ? `STOCKS 1/${pages}` : 'STOCK MARKET';
    const mode = currentStockChangeMode();
    const samples = [
      { price: '319.70', percent: '+3.3%', points: '+10.35', dir: 'up' },
      { price: '513.50', percent: '+6.3%', points: '+30.29', dir: 'up' },
      { price: '346.60', percent: '+0.5%', points: '+1.72', dir: 'up' },
      { price: '185.00', percent: '-0.4%', points: '-0.74', dir: 'down' },
      { price: '120.50', percent: '+1.2%', points: '+1.43', dir: 'up' },
    ];

    const rows = blankDesignerCells();
    rows[0][0] = flapChipCode('white');
    rows[0][1] = flapChipCode('white');
    rows[0][20] = flapChipCode('white');
    rows[0][21] = flapChipCode('white');
    const titleBody = String(title).slice(0, 18);
    const titlePad = Math.max(0, 18 - titleBody.length);
    const titleLeft = Math.floor(titlePad / 2);
    const titleLine = `${' '.repeat(titleLeft)}${titleBody}${' '.repeat(titlePad - titleLeft)}`;
    for (let col = 0; col < 18; col += 1) {
      rows[0][2 + col] = flapCharCode(titleLine[col]);
    }

    page.forEach((symbol, index) => {
      const sample = samples[index % samples.length];
      const change = mode === 'points' ? sample.points : sample.percent;
      const right = `${sample.price} ${change}`.slice(0, 15);
      const start = Math.max(6, 20 - right.length);
      const row = rows[index + 1];
      for (let col = 0; col < symbol.length && col < 5; col += 1) {
        row[col] = flapCharCode(symbol[col]);
      }
      for (let col = 0; col < right.length; col += 1) {
        row[start + col] = flapCharCode(right[col]);
      }
      row[21] = flapChipCode(sample.dir === 'down' ? 'red' : sample.dir === 'up' ? 'green' : 'white');
    });

    renderVbGrid(host, rows);
  }

  function renderStockMarketSettings(data = {}) {
    const settings = data.settings || {};
    const tickers = settings.tickers || data.defaults?.tickers || [];
    const input = $('stock-market-tickers');
    if (input && document.activeElement !== input) {
      input.value = tickers.join(', ');
    }
    setStockChangeMode(settings.changeMode || 'percent');
    const provider = $('stock-market-provider');
    if (provider && document.activeElement !== provider) {
      provider.value = settings.provider || 'auto';
    }
    const keyInput = $('stock-market-finnhub-key');
    if (keyInput && document.activeElement !== keyInput) {
      keyInput.value = '';
      keyInput.placeholder = settings.hasFinnhubKey
        ? 'Key saved — leave blank to keep'
        : 'Optional Finnhub API key';
    }
    const clear = $('stock-market-clear-key');
    if (clear) clear.checked = false;

    const pill = $('stock-market-status-pill');
    const detail = $('stock-market-status-detail');
    if (pill) {
      pill.textContent = tickers.length ? `${tickers.length} tickers` : 'Empty';
      pill.className = `status-pill ${tickers.length ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = settings.hasFinnhubKey
        ? `${tickers.length} tickers · Finnhub key saved · Yahoo fallback`
        : `${tickers.length} tickers · Yahoo Finance (no API key)`;
    }
    renderStockMarketPreview(tickers);
  }

  async function loadStockMarketSettings() {
    try {
      const data = await apiGet('/api/stock-market/settings');
      renderStockMarketSettings(data);
    } catch (_error) {
      renderStockMarketSettings({});
    }
  }

  $('stock-market-change-mode')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-stock-change]');
    if (!btn) return;
    setStockChangeMode(btn.getAttribute('data-stock-change'));
    const tickers = String($('stock-market-tickers')?.value || '')
      .split(/[\s,;|]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 10);
    renderStockMarketPreview(tickers);
  });

  $('stock-market-tickers')?.addEventListener('input', () => {
    const tickers = String($('stock-market-tickers')?.value || '')
      .split(/[\s,;|]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 10);
    renderStockMarketPreview(tickers);
  });

  $('btn-stock-market-save')?.addEventListener('click', async () => {
    const button = $('btn-stock-market-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/stock-market/settings', {
        tickers: $('stock-market-tickers')?.value,
        changeMode: currentStockChangeMode(),
        provider: $('stock-market-provider')?.value,
        finnhubApiKey: $('stock-market-finnhub-key')?.value,
        clearFinnhubApiKey: Boolean($('stock-market-clear-key')?.checked),
      });
      renderStockMarketSettings(result);
      toast('Stock watchlist saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save stock watchlist', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-stock-market-reset')?.addEventListener('click', async () => {
    const button = $('btn-stock-market-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/stock-market/settings', { reset: true });
      renderStockMarketSettings(result);
      toast('Reset to default tickers', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset stock watchlist', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-stock-market-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/stock-market', withTarget());
      const count = result.quotes?.length || 0;
      toast(`${count} quote${count === 1 ? '' : 's'} on the board`, 'good');
    } catch (error) {
      toast(error?.message || 'Stock Market push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadStockMarketSettings();

  // ------------------------------------------- Settings → World Currency Rates

  const CURRENCY_RATES_DEFAULT_QUOTES = Object.freeze([
    'EUR', 'GBP', 'JPY', 'CAD', 'MXN', 'ARS', 'BSD', 'CNY',
  ]);
  let currencyRatesDefaultQuotes = [...CURRENCY_RATES_DEFAULT_QUOTES];

  function resolveCurrencyRatesQuotes(quotes = []) {
    const list = (Array.isArray(quotes) ? quotes : [])
      .map((code) => String(code || '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 12);
    return list.length ? list : [...currencyRatesDefaultQuotes];
  }

  function renderCurrencyRatesPreview(quotes = [], base = 'USD') {
    const host = $('currency-rates-preview');
    if (!host) return;
    // Empty watchlist → system defaults (same as a saved empty list on the server).
    const list = resolveCurrencyRatesQuotes(quotes).slice(0, 4);
    const baseCode = String(base || 'USD').toUpperCase().slice(0, 3);
    const samples = [
      { rate: '0.915', change: '-0.09%', dir: 'down' },
      { rate: '0.767', change: '+0.20%', dir: 'up' },
      { rate: '151.2', change: '+0.12%', dir: 'up' },
      { rate: '1.385', change: '-0.32%', dir: 'down' },
    ];
    const titleText = `${baseCode} CONVERSIONS`;
    const titlePad = Math.max(0, 22 - titleText.length);
    const titleLeft = Math.floor(titlePad / 2);
    const title = `${' '.repeat(titleLeft)}${titleText}${' '.repeat(titlePad - titleLeft)}`.slice(0, 22);
    // Mirrors fxColumnHeaderRow / fxQuoteRow: `$` at column 7 over the rates,
    // `+/-%` right-aligned to the change column so its `+` lands on the point.
    const header = `${' '.repeat(7)}$${' '.repeat(9)}+/-%`;
    const dataLines = list.map((code, index) => {
      const sample = samples[index % samples.length];
      const symbol = String(code || '').toUpperCase().slice(0, 3).padEnd(3, ' ');
      const rate = String(sample.rate).padEnd(7, ' ').slice(0, 7);
      const change = String(sample.change).padStart(7, ' ').slice(-7);
      return `${symbol}    ${rate}${change}#`.padEnd(22, ' ').slice(0, 22);
    });
    const lines = [title, header, ...dataLines];
    while (lines.length < 6) lines.push('');
    paintPreviewLines(host, lines.slice(0, 6), (rowIndex, col, ch) => {
      if (rowIndex === 0 && (col === 0 || col === 1 || col === 20 || col === 21)) {
        return flapChipCode('white');
      }
      if (rowIndex >= 2 && col === 21 && ch === '#') {
        const dir = samples[(rowIndex - 2) % samples.length]?.dir;
        if (dir === 'up') return flapChipCode('green');
        if (dir === 'down') return flapChipCode('red');
        return flapChipCode('white');
      }
      return null;
    });
  }

  function renderCurrencyRatesSettings(data = {}) {
    const settings = data.settings || {};
    if (Array.isArray(data.defaults?.quotes) && data.defaults.quotes.length) {
      currencyRatesDefaultQuotes = data.defaults.quotes
        .map((code) => String(code || '').trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 12);
    }
    const input = $('currency-rates-quotes');
    const quotes = resolveCurrencyRatesQuotes(settings.quotes || []);
    if (input && document.activeElement !== input) {
      // Keep the field showing the effective list (defaults when unset).
      input.value = quotes.join(', ');
    }
    const base = data.baseCurrency || 'USD';
    const pill = $('currency-rates-status-pill');
    const detail = $('currency-rates-status-detail');
    if (pill) {
      const count = quotes.length;
      pill.textContent = count ? `${count} vs ${base}` : 'Empty';
      pill.className = `status-pill ${count ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = `Live rates vs ${base} with day-over-day % (green up / red down). Free — no API key.`;
    }
    renderCurrencyRatesPreview(quotes, base);
  }

  async function loadCurrencyRatesSettings() {
    try {
      const data = await apiGet('/api/currency-rates/settings');
      renderCurrencyRatesSettings(data);
    } catch {
      renderCurrencyRatesSettings({});
    }
  }

  $('currency-rates-quotes')?.addEventListener('input', () => {
    const quotes = String($('currency-rates-quotes')?.value || '')
      .split(/[\s,;|/]+/)
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 12);
    const base = ($('locale-currency')?.value || 'USD').toUpperCase();
    renderCurrencyRatesPreview(quotes, base);
  });

  $('btn-currency-rates-save')?.addEventListener('click', async () => {
    const button = $('btn-currency-rates-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/currency-rates/settings', {
        quotes: $('currency-rates-quotes')?.value,
      });
      renderCurrencyRatesSettings(result);
      toast('Currency list saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save currency list', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-currency-rates-reset')?.addEventListener('click', async () => {
    const button = $('btn-currency-rates-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/currency-rates/settings', { reset: true });
      renderCurrencyRatesSettings(result);
      toast('Reset to default currencies', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset currency list', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-currency-rates-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/currency-rates', withTarget());
      const count = result.quotes?.length || 0;
      toast(`${count} rate${count === 1 ? '' : 's'} vs ${result.base || 'USD'}`, 'good');
    } catch (error) {
      toast(error?.message || 'Currency Rates push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadCurrencyRatesSettings();

  // -------------------------------------------- Settings → US Weather Map

  // The silhouette is fixed, so the preview can draw the country before any
  // reading arrives — a blank bezel would look like the card was broken.
  const USWM_MASK = [
    '###############.....##',
    '################..###.',
    '.###################..',
    '..#################...',
    '...###############....',
    '..........#......#....',
  ];
  let usWeatherMapMode = 'temperature';
  let usWeatherMapCells = null;

  function usWeatherMapRows() {
    const rows = Array.from({ length: 6 }, () => new Array(22).fill(0));
    if (Array.isArray(usWeatherMapCells) && usWeatherMapCells.length) {
      for (const cell of usWeatherMapCells) {
        const row = Number(cell?.row);
        const col = Number(cell?.col);
        if (rows[row] && col >= 0 && col < 22) {
          rows[row][col] = flapChipCode(cell?.chip);
        }
      }
      return rows;
    }
    // No map yet: show the outline in black so the shape still reads.
    USWM_MASK.forEach((line, row) => {
      [...line].forEach((mark, col) => {
        if (mark === '#') rows[row][col] = flapChipCode('black');
      });
    });
    return rows;
  }

  function renderUsWeatherMapPreview() {
    const host = $('us-weather-map-preview');
    if (host) renderVbGrid(host, usWeatherMapRows());
  }

  function renderUsWeatherMapSettings(data = {}) {
    const settings = data.settings || {};
    usWeatherMapMode = settings.mode || 'temperature';

    const pill = $('us-weather-map-status-pill');
    if (pill) {
      pill.textContent = data.hasMap
        ? (data.mapAgeMinutes ? `${data.mapAgeMinutes}m old` : 'fresh')
        : (data.lastError ? 'unavailable' : 'ready');
    }
    const detail = $('us-weather-map-status-detail');
    if (detail && data.cellCount) {
      detail.textContent = data.lastError
        ? `Last fetch failed: ${data.lastError}`
        : `A colour chip for each of ${data.cellCount} points across the continental US. No text — the whole board is the map. Free — no API key.`;
    }

    for (const button of document.querySelectorAll('#us-weather-map-mode-tabs .segmented-btn')) {
      button.classList.toggle('active', button.dataset.mapMode === usWeatherMapMode);
    }

    const legend = $('us-weather-map-legend');
    if (legend) {
      legend.innerHTML = (data.legend || []).map((band) => `
        <span class="uswm-swatch">
          <i class="uswm-chip" data-chip="${flapChipCode(band.chip)}"></i>
          ${escapeHtml(band.label)}
        </span>
      `).join('');
    }

    const refresh = $('us-weather-map-refresh');
    if (refresh && settings.refreshMinutes != null) {
      refresh.value = settings.refreshMinutes;
    }
    renderUsWeatherMapPreview();
  }

  async function loadUsWeatherMapSettings() {
    try {
      renderUsWeatherMapSettings(await apiGet('/api/us-weather-map/settings'));
    } catch {
      renderUsWeatherMapSettings({});
    }
  }

  async function saveUsWeatherMapSettings(patch) {
    try {
      renderUsWeatherMapSettings(await apiPost('/api/us-weather-map/settings', patch));
    } catch (error) {
      toast(error.message || 'Could not save the map settings', 'bad');
    }
  }

  for (const button of document.querySelectorAll('#us-weather-map-mode-tabs .segmented-btn')) {
    button.addEventListener('click', () => {
      // The chips mean something different in each mode, so a stale map would
      // be a lie until the next fetch.
      usWeatherMapCells = null;
      saveUsWeatherMapSettings({ mode: button.dataset.mapMode });
    });
  }

  $('btn-us-weather-map-save')?.addEventListener('click', () => saveUsWeatherMapSettings({
    mode: usWeatherMapMode,
    refreshMinutes: $('us-weather-map-refresh')?.value,
  }));

  $('btn-us-weather-map-reset')?.addEventListener('click', () => {
    usWeatherMapCells = null;
    saveUsWeatherMapSettings({ reset: true });
  });

  $('btn-us-weather-map-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const hint = $('us-weather-map-hint');
    if (hint) hint.textContent = 'Fetching the map…';
    try {
      const result = await apiPost('/api/push/us-weather-map', { ...withTarget(), force: true });
      usWeatherMapCells = result.cells || null;
      renderUsWeatherMapPreview();
      if (hint) {
        hint.textContent = result.range
          ? `${result.range.minF}F to ${result.range.maxF}F across the map`
          : 'Map on the board';
      }
      toast('Weather map on the board', 'good');
      loadUsWeatherMapSettings();
    } catch (error) {
      if (hint) hint.textContent = 'Push Now fetches a fresh map and shows it here.';
      toast(error?.message || 'Could not push the weather map', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadUsWeatherMapSettings();

  // ------------------------------------------- Settings → Starlink Tracker

  function renderStarlinkTrackerPreview(settings = {}) {
    const host = $('starlink-tracker-preview');
    if (!host) return;
    const lines = [
      'STARLINK TRACKER',
      '',
      'TONIGHT 9:42PM',
      'NW HIGH 52DEG',
    ];
    if (settings.showWeather !== false) lines.push('CLEAR SKY');
    if (settings.showVisibility !== false) lines.push('GOOD VISIBILITY');
    while (lines.length < 6) lines.push('');
    paintPreviewLines(host, lines.slice(0, 6));
  }

  function renderStarlinkTrackerSettings(data = {}) {
    const settings = data.settings || {};
    const hours = $('starlink-hours-ahead');
    const elev = $('starlink-min-elevation');
    if (hours && document.activeElement !== hours) hours.value = String(settings.hoursAhead || 72);
    if (elev && document.activeElement !== elev) elev.value = String(settings.minElevation || 20);
    setChecked('starlink-prefer-visible', settings.preferVisible !== false);
    setChecked('starlink-show-weather', settings.showWeather !== false);
    setChecked('starlink-show-visibility', settings.showVisibility !== false);
    const pill = $('starlink-tracker-status-pill');
    const detail = $('starlink-tracker-status-detail');
    const location = $('starlink-tracker-location');
    const hasLocation = Boolean(data.hasLocation);
    if (pill) {
      pill.textContent = hasLocation ? 'Ready' : 'No house pin';
      pill.className = `status-pill ${hasLocation ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = hasLocation
        ? 'Next Starlink pass over the house pin — time, sky position, and conditions. Free — no API key.'
        : 'Set a city or ZIP under Location to predict passes from home.';
    }
    if (location) {
      const loc = data.location || {};
      location.textContent = hasLocation
        ? `House pin: ${loc.label || loc.city || 'Home'} (${Number(loc.latitude).toFixed(2)}, ${Number(loc.longitude).toFixed(2)})`
        : 'Uses the house pin under Settings → Global → Location.';
    }
    renderStarlinkTrackerPreview(settings);
  }

  async function loadStarlinkTrackerSettings() {
    try {
      const data = await apiGet('/api/starlink-tracker/settings');
      renderStarlinkTrackerSettings(data);
    } catch {
      renderStarlinkTrackerSettings({});
    }
  }

  function starlinkSettingsFromForm() {
    return {
      hoursAhead: Number($('starlink-hours-ahead')?.value || 72),
      minElevation: Number($('starlink-min-elevation')?.value || 20),
      preferVisible: Boolean($('starlink-prefer-visible')?.checked),
      showWeather: Boolean($('starlink-show-weather')?.checked),
      showVisibility: Boolean($('starlink-show-visibility')?.checked),
    };
  }

  ['starlink-hours-ahead', 'starlink-min-elevation', 'starlink-prefer-visible',
    'starlink-show-weather', 'starlink-show-visibility'].forEach((id) => {
    $(id)?.addEventListener('change', () => renderStarlinkTrackerPreview(starlinkSettingsFromForm()));
  });

  $('btn-starlink-tracker-save')?.addEventListener('click', async () => {
    const button = $('btn-starlink-tracker-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/starlink-tracker/settings', starlinkSettingsFromForm());
      renderStarlinkTrackerSettings(result);
      toast('Starlink settings saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save Starlink settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-starlink-tracker-reset')?.addEventListener('click', async () => {
    const button = $('btn-starlink-tracker-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/starlink-tracker/settings', { reset: true });
      renderStarlinkTrackerSettings(result);
      toast('Reset to Starlink defaults', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset Starlink settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-starlink-tracker-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/starlink-tracker', withTarget());
      toast(result.whenLabel || 'Starlink on the board', 'good');
    } catch (error) {
      toast(error?.message || 'Starlink tracker push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadStarlinkTrackerSettings();

  // ------------------------------------------- Settings → Space Launch Alerts

  let spaceLaunchAlertsState = { settings: {}, launches: [] };

  function spaceLaunchChipCode(name) {
    const index = FLAP_CHIPS.indexOf(String(name || 'blue').toLowerCase());
    return index >= 0 ? 63 + index : 63 + FLAP_CHIPS.indexOf('blue');
  }

  function renderSpaceLaunchAlertsPreview(launch, chipColor = 'blue') {
    const host = $('space-launch-alerts-preview');
    if (!host) {
      return;
    }
    const rows = Array.isArray(launch?.rows) ? launch.rows.map((row) => [...row]) : [];
    if (!rows.length) {
      paintPreviewLines(host, ['', '', '', '', '', '']);
      return;
    }
    const chip = spaceLaunchChipCode(chipColor);
    if (rows[0]) {
      rows[0][0] = chip;
      rows[0][1] = chip;
      rows[0][20] = chip;
      rows[0][21] = chip;
    }
    renderVbGrid(host, rows);
  }

  function renderSpaceLaunchAlertsSettings(data = {}) {
    spaceLaunchAlertsState = {
      settings: data.settings || {},
      launches: data.launches || [],
    };
    const settings = data.settings || {};
    const hours = $('space-launch-hours-ahead');
    const refresh = $('space-launch-refresh-hours');
    const chip = $('space-launch-chip-color');
    if (hours && document.activeElement !== hours) {
      hours.value = String(settings.hoursAhead || 168);
    }
    if (refresh && document.activeElement !== refresh) {
      refresh.value = String(settings.refreshHours || 6);
    }
    if (chip && document.activeElement !== chip) {
      chip.value = settings.chipColor || 'blue';
    }
    setChecked('space-launch-include-suborbital', Boolean(settings.includeSuborbital));
    const pill = $('space-launch-alerts-status-pill');
    const detail = $('space-launch-alerts-status-detail');
    const cacheDetail = $('space-launch-alerts-cache-detail');
    const available = Number(data.available || 0);
    if (pill) {
      pill.textContent = available ? `${available} ready` : 'No launches';
      pill.className = `status-pill ${available ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = available
        ? `${available} board-fit launch${available === 1 ? '' : 'es'} in cache. Pick one to preview or push a test alert.`
        : 'No upcoming launches fit the board yet — try Refresh cache or widen the look-ahead window.';
    }
    if (cacheDetail) {
      const age = data.cacheAgeMinutes != null ? `${data.cacheAgeMinutes} min ago` : 'never';
      cacheDetail.textContent = data.fetchedAt
        ? `Cached ${data.total || 0} launches · updated ${age} · ${data.source || 'Launch Library 2'}`
        : 'Cache empty — Refresh cache to fetch upcoming launches.';
    }
    const select = $('space-launch-select');
    const launches = data.launches || [];
    const previous = select?.value || '';
    if (select) {
      select.innerHTML = launches.length
        ? launches.map((launch) => (
          `<option value="${escapeHtml(launch.id)}">${escapeHtml(launch.name)} · ${escapeHtml(launch.countdown || '')}</option>`
        )).join('')
        : '<option value="">No launches in cache</option>';
      if (previous && launches.some((launch) => launch.id === previous)) {
        select.value = previous;
      }
    }
    const selected = launches.find((launch) => launch.id === select?.value) || launches[0];
    renderSpaceLaunchAlertsPreview(selected, settings.chipColor || 'blue');
  }

  async function loadSpaceLaunchAlertsSettings() {
    try {
      renderSpaceLaunchAlertsSettings(await apiGet('/api/space-launch-alerts/settings'));
    } catch {
      renderSpaceLaunchAlertsSettings({});
    }
  }

  function spaceLaunchSettingsFromForm() {
    return {
      hoursAhead: Number($('space-launch-hours-ahead')?.value || 168),
      refreshHours: Number($('space-launch-refresh-hours')?.value || 6),
      chipColor: $('space-launch-chip-color')?.value || 'blue',
      includeSuborbital: Boolean($('space-launch-include-suborbital')?.checked),
    };
  }

  ['space-launch-hours-ahead', 'space-launch-refresh-hours', 'space-launch-chip-color', 'space-launch-include-suborbital']
    .forEach((id) => {
      $(id)?.addEventListener('change', () => {
        const launch = spaceLaunchAlertsState.launches.find(
          (row) => row.id === $('space-launch-select')?.value,
        ) || spaceLaunchAlertsState.launches[0];
        renderSpaceLaunchAlertsPreview(launch, spaceLaunchSettingsFromForm().chipColor);
      });
    });

  $('space-launch-select')?.addEventListener('change', () => {
    const launch = spaceLaunchAlertsState.launches.find(
      (row) => row.id === $('space-launch-select')?.value,
    );
    renderSpaceLaunchAlertsPreview(launch, spaceLaunchSettingsFromForm().chipColor);
  });

  $('btn-space-launch-alerts-save')?.addEventListener('click', async () => {
    const button = $('btn-space-launch-alerts-save');
    button.disabled = true;
    try {
      const result = await apiPost('/api/space-launch-alerts/settings', spaceLaunchSettingsFromForm());
      renderSpaceLaunchAlertsSettings(result);
      toast('Space Launch Alerts settings saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save settings', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-space-launch-alerts-reset')?.addEventListener('click', async () => {
    const button = $('btn-space-launch-alerts-reset');
    button.disabled = true;
    try {
      const result = await apiPost('/api/space-launch-alerts/settings', { reset: true });
      renderSpaceLaunchAlertsSettings(result);
      toast('Defaults restored', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset settings', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-space-launch-alerts-refresh')?.addEventListener('click', async () => {
    const button = $('btn-space-launch-alerts-refresh');
    button.disabled = true;
    try {
      const result = await apiPost('/api/space-launch-alerts/settings', {
        ...spaceLaunchSettingsFromForm(),
        refresh: true,
      });
      renderSpaceLaunchAlertsSettings(result);
      toast('Launch cache refreshed', 'good');
    } catch (error) {
      toast(error?.message || 'Could not refresh launch cache', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-space-launch-alerts-push-selected')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const launchId = $('space-launch-select')?.value;
      const result = await apiPost('/api/push/space-launch-alerts', withTarget({ launchId }));
      toast(String(result.launch?.rocket || 'Launch alert on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push launch alert', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('btn-space-launch-alerts-push-next')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/space-launch-alerts', withTarget());
      toast(String(result.launch?.rocket || 'Launch alert on the board').slice(0, 60), 'good');
    } catch (error) {
      toast(error?.message || 'Could not push launch alert', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadSpaceLaunchAlertsSettings();

  // ------------------------------------------- Settings → ISS Tracker

  function issUnit() {
    const active = document.querySelector('#iss-tracker-unit .segmented-btn.active');
    return active?.dataset?.issUnit === 'km' ? 'km' : 'miles';
  }

  function setIssUnit(unit) {
    const want = unit === 'km' ? 'km' : 'miles';
    document.querySelectorAll('#iss-tracker-unit .segmented-btn').forEach((btn) => {
      const on = btn.dataset.issUnit === want;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderIssTrackerPreview(settings = {}, hasLocation = false) {
    const host = $('iss-tracker-preview');
    if (!host) return;
    const unit = settings.distanceUnit === 'km' ? 'KM' : 'MI';
    const speed = settings.distanceUnit === 'km' ? 'GOING 27,600 KM/H' : 'GOING 17,130 MPH';
    const alt = settings.distanceUnit === 'km' ? '@  420 KM HIGH' : '@  262 MI HIGH';
    const away = hasLocation ? `3,917 ${unit} AWAY @` : 'SET HOUSE PIN';
    const coords = settings.showCoordinates !== false ? '1.45° S,  33.56° W' : '';
    const center = (text, width = 22) => {
      const body = String(text || '').slice(0, width);
      const pad = Math.max(0, width - body.length);
      const left = Math.floor(pad / 2);
      return `${' '.repeat(left)}${body}${' '.repeat(pad - left)}`;
    };
    // Title/time sit inside the white L ornaments (chips on corners).
    const titleInner = center('ISS SPACE ORBIT', 18);
    const timeInner = center('09:20 AM', 20);
    const lines = [
      `  ${titleInner}  `.slice(0, 22),
      ` ${timeInner} `.slice(0, 22),
      center(away),
      center(coords),
      center(settings.showAltitude !== false ? alt : ''),
      center(speed),
    ];
    paintPreviewLines(host, lines.slice(0, 6), (rowIndex, col) => {
      if (rowIndex === 0 && (col === 0 || col === 1 || col === 20 || col === 21)) {
        return flapChipCode('white');
      }
      if (rowIndex === 1 && (col === 0 || col === 21)) {
        return flapChipCode('white');
      }
      return null;
    });
  }

  function renderIssTrackerSettings(data = {}) {
    const settings = data.settings || {};
    setIssUnit(settings.distanceUnit);
    setChecked('iss-tracker-show-coords', settings.showCoordinates !== false);
    setChecked('iss-tracker-show-altitude', settings.showAltitude !== false);
    const pill = $('iss-tracker-status-pill');
    const detail = $('iss-tracker-status-detail');
    const location = $('iss-tracker-location');
    const hasLocation = Boolean(data.hasLocation);
    if (pill) {
      pill.textContent = hasLocation ? 'Ready' : 'No house pin';
      pill.className = `status-pill ${hasLocation ? 'is-ok' : 'is-warn'}`;
    }
    if (detail) {
      detail.textContent = hasLocation
        ? 'Marketplace ISS SPACE ORBIT board — away, coords, altitude, speed. Free — no API key.'
        : 'Set a city or ZIP under Location to show how far the station is from home.';
    }
    if (location) {
      const loc = data.location || {};
      location.textContent = hasLocation
        ? `House pin: ${loc.label || loc.city || 'Home'} (${Number(loc.latitude).toFixed(2)}, ${Number(loc.longitude).toFixed(2)})`
        : 'Uses the house pin under Settings → Global → Location for the AWAY distance.';
    }
    renderIssTrackerPreview(settings, hasLocation);
  }

  async function loadIssTrackerSettings() {
    try {
      const data = await apiGet('/api/iss-tracker/settings');
      renderIssTrackerSettings(data);
    } catch {
      renderIssTrackerSettings({});
    }
  }

  $('iss-tracker-unit')?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-iss-unit]');
    if (!btn) return;
    setIssUnit(btn.dataset.issUnit);
    renderIssTrackerPreview({
      distanceUnit: issUnit(),
      showCoordinates: Boolean($('iss-tracker-show-coords')?.checked),
      showAltitude: Boolean($('iss-tracker-show-altitude')?.checked),
    }, true);
  });

  ['iss-tracker-show-coords', 'iss-tracker-show-altitude']
    .forEach((id) => {
      $(id)?.addEventListener('change', () => {
        renderIssTrackerPreview({
          distanceUnit: issUnit(),
          showCoordinates: Boolean($('iss-tracker-show-coords')?.checked),
          showAltitude: Boolean($('iss-tracker-show-altitude')?.checked),
        }, true);
      });
    });

  $('btn-iss-tracker-save')?.addEventListener('click', async () => {
    const button = $('btn-iss-tracker-save');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/iss-tracker/settings', {
        distanceUnit: issUnit(),
        showCoordinates: Boolean($('iss-tracker-show-coords')?.checked),
        showAltitude: Boolean($('iss-tracker-show-altitude')?.checked),
      });
      renderIssTrackerSettings(result);
      toast('ISS tracker settings saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save ISS settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-iss-tracker-reset')?.addEventListener('click', async () => {
    const button = $('btn-iss-tracker-reset');
    if (button) button.disabled = true;
    try {
      const result = await apiPost('/api/iss-tracker/settings', { reset: true });
      renderIssTrackerSettings(result);
      toast('Reset to ISS defaults', 'good');
    } catch (error) {
      toast(error?.message || 'Could not reset ISS settings', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-iss-tracker-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/iss-tracker', withTarget());
      toast(result.relativeLabel || result.speedLabel || 'ISS on the board', 'good');
    } catch (error) {
      toast(error?.message || 'ISS tracker push failed', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  loadIssTrackerSettings();

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
        homeLoc.textContent = 'Location: not set — save a city or ZIP under Settings → Global.';
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
        ? 'Save a city or ZIP under Settings → Global — Overhead uses the same pin as weather.'
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
    const devicePending = Boolean(status.deviceLinkPending);
    const ratePaused = Boolean(status.rateLimit?.paused || status.archive?.rateLimit?.paused);
    if (pill) {
      pill.textContent = devicePending ? 'Approve on phone' : (needsRelink ? 'Re-link needed' : (ratePaused ? 'Cloud paused' : (linked ? 'Linked' : 'Not linked')));
      pill.className = `status-pill${(!devicePending && (needsRelink || ratePaused)) ? ' bad' : (linked || devicePending ? ' good' : '')}`;
    }
    if (detail) {
      if (devicePending) {
        detail.textContent = 'Open the link below, sign in, and enter the code — this page updates when Autodarts approves.';
      } else if (needsRelink) {
        detail.textContent = status.unavailableReason || 'Re-link Autodarts in Settings';
      } else if (ratePaused) {
        detail.textContent = status.rateLimit?.reason
          || status.archive?.rateLimit?.reason
          || 'Autodarts cloud is rate-limited — waiting before retrying';
      } else if (linked) {
        detail.textContent = `Linked as ${status.userName || status.userId || 'account'}`
          + (status.boardName ? ` · board ${status.boardName}` : '')
          + (status.keepAlive ? ' · session kept alive automatically' : '');
      } else {
        detail.textContent = 'Pick device link or email & password below to connect your account.';
      }
    }

    renderAutodartsOauth(status.oauth);

    const modeTabs = $('autodarts-mode-tabs');
    const linkedActions = $('autodarts-linked-actions');
    const deviceBlock = $('autodarts-device-block');
    const linkBtn = $('btn-autodarts-link');
    // A dead refresh token still has user/board metadata, but it is not a
    // working link — show the device/password flow until a fresh token lands.
    const showLinkedChrome = linked && !needsRelink && !devicePending;

    if (showLinkedChrome) {
      if (modeTabs) modeTabs.hidden = true;
      if ($('autodarts-device-mode')) $('autodarts-device-mode').hidden = true;
      if ($('autodarts-password-block')) $('autodarts-password-block').hidden = true;
      if (linkedActions) linkedActions.hidden = false;
    } else {
      if (modeTabs) modeTabs.hidden = devicePending;
      if (linkedActions) linkedActions.hidden = true;
      if (devicePending) {
        autodartsLinkMode = 'device';
        applyAutodartsLinkMode('device');
        if (deviceBlock) deviceBlock.hidden = false;
        if (linkBtn) linkBtn.hidden = true;
        if ($('autodarts-password-block')) $('autodarts-password-block').hidden = true;
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
      const ratePaused = Boolean(status.rateLimit?.paused || archive.rateLimit?.paused);
      syncBtn.disabled = !syncReady || archive.running === true || ratePaused || needsRelink || !linked;
      syncBtn.title = needsRelink || !linked
        ? 'Link Autodarts before syncing history'
        : (ratePaused
          ? 'Autodarts cloud is rate-limited — wait for the cooldown before syncing again'
          : (syncReady
            ? 'Pull Match History from Autodarts (local archive is the offline cache)'
            : 'History sync is disabled in settings'));
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
        // beginDeviceLink used to return linked:true whenever a (possibly
        // expired) refresh token was still on disk — that toasted success and
        // hid the approval code. Only celebrate after the poll actually lands.
        if (result.linked && !result.deviceLinkPending) {
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
      if ($('autodarts-device-block')) $('autodarts-device-block').hidden = true;
      if ($('btn-autodarts-link')) {
        $('btn-autodarts-link').hidden = false;
        $('btn-autodarts-link').click();
      }
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

  // ---------------------------------------- Settings → Huupe

  const HUUPE_MODES = ['family', 'justhuupe', 'dailyprize', 'fitness', 'live'];

  let huupeSaveTimer = null;
  let huupePollTimer = null;

  function setHuupeSlider(sliderId, labelId, value, suffix) {
    const slider = $(sliderId);
    const label = $(labelId);
    if (!slider) return;
    slider.value = String(value);
    if (label) label.textContent = `${value}${suffix || ''}`;
  }

  function readHuupeForm() {
    const inactivityBtn = document.querySelector('#huupe-inactivity-tabs .segmented-btn.active');
    return {
      device: {
        host: ($('huupe-host')?.value || '').trim(),
        port: Number($('huupe-port')?.value || 5555),
        autoDiscover: Boolean($('huupe-auto-discover')?.checked),
      },
      live: {
        autoPush: Boolean($('huupe-auto-push')?.checked),
        inactivityMinutes: Number(inactivityBtn?.dataset.minutes || 5),
        finalHoldSeconds: Number($('huupe-final-hold')?.value || 60),
        minShotsToOpen: Number($('huupe-min-shots')?.value || 2),
      },
      modes: HUUPE_MODES.reduce((out, mode) => {
        out[mode] = Boolean($(`huupe-mode-${mode}`)?.checked);
        return out;
      }, {}),
      dashboard: {
        leaderboardSize: Number($('huupe-leaderboard-size')?.value || 10),
        displaySeconds: Number($('huupe-dashboard-seconds')?.value || 120),
      },
      lastGame: {
        displaySeconds: Number($('huupe-last-game-seconds')?.value || 90),
      },
    };
  }

  async function saveHuupeSettings() {
    try {
      const result = await apiPost('/api/huupe/settings', readHuupeForm());
      if (result.settings) renderHuupeSettings(result.settings);
    } catch (error) {
      toast(error.message || 'Could not save Huupe settings', 'bad');
    }
  }

  function queueHuupeSave() {
    clearTimeout(huupeSaveTimer);
    huupeSaveTimer = setTimeout(saveHuupeSettings, 400);
  }

  function renderHuupeSettings(settings) {
    if (!settings) return;
    const device = settings.device || {};
    const live = settings.live || {};
    const modes = settings.modes || {};
    const dashboard = settings.dashboard || {};
    const lastGame = settings.lastGame || {};

    // Never clobber an address the user is halfway through typing.
    const host = $('huupe-host');
    if (host && document.activeElement !== host) host.value = device.host || '';
    if ($('huupe-port')) $('huupe-port').value = String(device.port || 5555);
    if ($('huupe-auto-discover')) $('huupe-auto-discover').checked = device.autoDiscover !== false;

    if ($('huupe-auto-push')) $('huupe-auto-push').checked = live.autoPush !== false;
    document.querySelectorAll('#huupe-inactivity-tabs .segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.minutes) === Number(live.inactivityMinutes || 5));
    });
    setHuupeSlider('huupe-final-hold', 'huupe-final-hold-value', live.finalHoldSeconds || 60, 's');
    setHuupeSlider('huupe-min-shots', 'huupe-min-shots-value', live.minShotsToOpen || 2, '');

    for (const mode of HUUPE_MODES) {
      const box = $(`huupe-mode-${mode}`);
      if (box) box.checked = modes[mode] !== false;
    }

    setHuupeSlider('huupe-leaderboard-size', 'huupe-leaderboard-size-value', dashboard.leaderboardSize || 10, '');
    setHuupeSlider('huupe-dashboard-seconds', 'huupe-dashboard-seconds-value', dashboard.displaySeconds || 120, 's');
    setHuupeSlider('huupe-last-game-seconds', 'huupe-last-game-seconds-value', lastGame.displaySeconds || 90, 's');
  }

  function huupeStatusWords(status) {
    const collector = status.collector || {};
    const session = status.live?.session;
    if (session) {
      return { pill: 'Playing', tone: 'good', detail: `${session.modeLabel || 'Session'} in progress — ${session.stats?.made || 0}/${session.stats?.attempts || 0} shots` };
    }
    if (collector.state === 'streaming') {
      // A hoop nobody is shooting on logs nothing, so "connected" on its own
      // used to look identical to a stream that had quietly died. Say when the
      // hoop last answered instead.
      const missed = Number(collector.missedBeats) || 0;
      const beat = Number(collector.secondsSinceBeat);
      const heard = Number.isFinite(beat)
        ? `answered ${beat < 90 ? `${beat}s` : `${Math.round(beat / 60)}m`} ago`
        : 'idle';
      return {
        pill: 'Connected',
        tone: missed ? '' : 'good',
        detail: missed
          ? `${collector.serial || 'The hoop'} missed the last check — reconnecting if it stays quiet`
          : `Listening to ${collector.serial || 'the hoop'} — ${heard}`,
      };
    }
    if (collector.state === 'unconfigured') {
      return { pill: 'Not set up', tone: '', detail: 'Turn on wireless ADB on the hoop, then tap Discover.' };
    }
    if (collector.state === 'connecting') {
      return { pill: 'Connecting', tone: '', detail: 'Dialling the hoop…' };
    }
    // A hoop that is switched off is the normal overnight state, not a fault.
    return {
      pill: 'Offline',
      tone: '',
      detail: collector.lastError
        ? `Hoop not answering — ${collector.lastError}`
        : 'Hoop is off or asleep. It will reconnect on its own.',
    };
  }

  function renderHuupeStatus(status) {
    const words = huupeStatusWords(status);
    const pill = $('huupe-status-pill');
    if (pill) {
      pill.textContent = words.pill;
      pill.className = `status-pill${words.tone ? ` ${words.tone}` : ''}`;
    }
    const detail = $('huupe-status-detail');
    if (detail) detail.textContent = words.detail;

    const deviceHint = $('huupe-device-hint');
    if (deviceHint) {
      const info = status.collector?.device;
      if (info) {
        const adbNote = info.persistentAdbPort
          ? 'wireless ADB survives reboots'
          : 'wireless ADB will not survive a reboot — set persist.adb.tcp.port';
        deviceHint.textContent = `${info.model} · Android ${info.androidRelease} · ${adbNote}`;
      } else {
        deviceHint.textContent = status.collector?.state === 'unconfigured'
          ? 'Device: not found yet'
          : 'Device: —';
      }
    }

    const archiveHint = $('huupe-archive-hint');
    if (archiveHint) {
      const count = status.archive?.count || 0;
      const last = status.live?.lastSession;
      archiveHint.textContent = count
        ? `${count} session${count === 1 ? '' : 's'} archived · ${status.players || 0} player${status.players === 1 ? '' : 's'}`
          + (last?.endedAt ? ` · last ${new Date(last.endedAt).toLocaleDateString()}` : '')
        : 'No sessions recorded yet — play a game and it will appear here';
    }

    renderHuupeSettings(status.settings);
  }

  async function loadHuupeSettings() {
    const card = $('huupe-settings-card');
    if (!card) return;
    try {
      renderHuupeStatus(await apiGet('/api/huupe/status'));
    } catch {
      card.hidden = true;
    }
  }

  async function loadHuupeLog() {
    const view = $('huupe-log');
    if (!view) return;
    try {
      const result = await apiGet('/api/huupe/log');
      const lines = result.lines || [];
      view.textContent = lines.length
        ? lines.map((line) => `${line.at || ''} ${line.tag}: ${line.message}`).join('\n')
        : 'Nothing unrecognised — the parser understood every line it saw.';
      view.scrollTop = view.scrollHeight;
    } catch (error) {
      view.textContent = error.message || 'Could not load the log';
    }
  }

  function setHuupeBusy(button, busy, busyLabel) {
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

  const huupeCard = $('huupe-settings-card');
  if (huupeCard) {
    huupeCard.addEventListener('change', (event) => {
      if (event.target.matches('input, select')) queueHuupeSave();
    });
    huupeCard.addEventListener('input', (event) => {
      if (event.target.matches('input[type="range"]')) {
        const map = {
          'huupe-final-hold': ['huupe-final-hold-value', 's'],
          'huupe-min-shots': ['huupe-min-shots-value', ''],
          'huupe-leaderboard-size': ['huupe-leaderboard-size-value', ''],
          'huupe-dashboard-seconds': ['huupe-dashboard-seconds-value', 's'],
          'huupe-last-game-seconds': ['huupe-last-game-seconds-value', 's'],
        };
        const entry = map[event.target.id];
        if (entry) setHuupeSlider(event.target.id, entry[0], event.target.value, entry[1]);
        queueHuupeSave();
      }
    });
    $('huupe-inactivity-tabs')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.segmented-btn');
      if (!btn) return;
      document.querySelectorAll('#huupe-inactivity-tabs .segmented-btn')
        .forEach((node) => node.classList.toggle('active', node === btn));
      queueHuupeSave();
    });
    $('btn-huupe-discover')?.addEventListener('click', async () => {
      const button = $('btn-huupe-discover');
      setHuupeBusy(button, true, 'Scanning…');
      toast('Scanning the network for your hoop…', '');
      try {
        const result = await apiPost('/api/huupe/discover', {});
        if (result.ok) {
          toast(`Found the hoop at ${result.host}`, 'good');
        } else {
          toast(result.error || 'No hoop found — check wireless ADB is on', 'warn');
        }
        await loadHuupeSettings();
      } catch (error) {
        toast(error.message || 'Discovery failed', 'bad');
      } finally {
        setHuupeBusy(button, false);
      }
    });
    $('btn-huupe-reconnect')?.addEventListener('click', async () => {
      try {
        await apiPost('/api/huupe/reconnect', {});
        toast('Reconnecting to the hoop…', '');
        setTimeout(loadHuupeSettings, 1500);
      } catch (error) {
        toast(error.message || 'Could not reconnect', 'bad');
      }
    });
    $('btn-huupe-test')?.addEventListener('click', async () => {
      const button = $('btn-huupe-test');
      setHuupeBusy(button, true, 'Testing…');
      try {
        const result = await apiPost('/api/huupe/test', {});
        $('huupe-test-result').textContent = result.message || (result.ok ? 'ok' : 'failed');
        toast(result.message || (result.ok ? 'Huupe ok' : 'Test failed'), result.ok ? 'good' : 'bad');
      } catch (error) {
        toast(error.message || 'Test failed', 'bad');
      } finally {
        setHuupeBusy(button, false);
      }
    });
    $('btn-huupe-rebuild')?.addEventListener('click', async () => {
      const button = $('btn-huupe-rebuild');
      setHuupeBusy(button, true, 'Rebuilding…');
      try {
        const result = await apiPost('/api/huupe/rebuild', {});
        toast(`Rebuilt from ${result.sessions || 0} session${result.sessions === 1 ? '' : 's'}`, 'good');
        await loadHuupeSettings();
      } catch (error) {
        toast(error.message || 'Rebuild failed', 'bad');
      } finally {
        setHuupeBusy(button, false);
      }
    });
    huupeCard.querySelector('.huupe-advanced')?.addEventListener('toggle', (event) => {
      if (event.target.open) loadHuupeLog();
    });

    loadHuupeSettings();
    // The hoop goes on and off all day; the card is only honest if it keeps up.
    huupePollTimer = setInterval(loadHuupeSettings, 5000);
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
  registerSheetDismiss('pin-sheet', () => {
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
  let creditsPreviewMedia = null;
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

  function creditsBustedMediaUrl(path) {
    const url = creditsMediaUrl(path);
    if (!url) return '';
    return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
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

  // Listed bottom-of-stack first: the last visible one is what Escape or a
  // backdrop click should dismiss.
  const CREDITS_SHEET_IDS = [
    'credits-add-sheet',
    'credits-edit-sheet',
    'credits-preview-sheet',
    'credits-delete-sheet',
    'credits-rescrape-sheet',
    'credits-unsaved-sheet',
  ];

  function creditsTopSheetId() {
    for (let index = CREDITS_SHEET_IDS.length - 1; index >= 0; index -= 1) {
      const node = $(CREDITS_SHEET_IDS[index]);
      if (node && !node.hidden) return CREDITS_SHEET_IDS[index];
    }
    return null;
  }

  function closeCreditsPreview() {
    const video = $('credits-preview-video');
    if (video) {
      creditsUnbindPreviewLoop(video);
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    const img = $('credits-preview-img');
    if (img) img.removeAttribute('src');
    creditsPreviewMedia = null;
    if ($('credits-preview-sheet')) $('credits-preview-sheet').hidden = true;
  }

  function requestCreditsEditClose() {
    if (creditsEditDirty) {
      $('credits-unsaved-sheet').hidden = false;
      return;
    }
    $('credits-edit-sheet').hidden = true;
  }

  function closeCreditsSheetById(id) {
    if (id === 'credits-edit-sheet') {
      requestCreditsEditClose();
      return;
    }
    if (id === 'credits-preview-sheet') {
      closeCreditsPreview();
      return;
    }
    const node = $(id);
    if (node) node.hidden = true;
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
      const label = CREDITS_PRIORITY_LABELS[row.kind] || row.kind;
      const canPreview = creditsCanPreviewMedia(row);
      const thumb = canPreview
        ? `<button type="button" class="credits-media-thumb-btn" data-media-action="preview" data-media-index="${index}" aria-label="Preview ${escapeHtml(label)}">${creditsMediaThumbHtml(row)}</button>`
        : creditsMediaThumbHtml(row);
      const trimmed = row.kind === 'video' && (row.trimStart !== null && row.trimStart !== undefined)
        ? ` · clip ${creditsClock(row.trimStart) || '00m00s'}–${creditsClock(row.trimEnd) || 'end'}`
        : '';
      return `<div class="credits-media-row" draggable="true" data-media-id="${escapeHtml(row.id)}" data-media-index="${index}">
        <span class="credits-media-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        ${thumb}
        <div class="credits-media-copy"><strong>${escapeHtml(label)}</strong>
          ${escapeHtml(row.source || 'unknown')} · ${escapeHtml(row.status || 'ready')}${row.resolution ? ` · ${row.resolution}p` : ''}${trimmed}
          ${row.statusDetail ? `<br>${escapeHtml(row.statusDetail)}` : ''}</div>
        <div class="credits-media-actions">
          <button type="button" class="credits-mini-btn" data-media-action="up" data-media-index="${index}" aria-label="Move up"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="credits-mini-btn" data-media-action="down" data-media-index="${index}" aria-label="Move down"${index >= media.length - 1 ? ' disabled' : ''}>↓</button>
          ${canPreview ? `<button type="button" class="credits-mini-btn" data-media-action="preview" data-media-index="${index}">${row.kind === 'video' ? 'Preview / trim' : 'Preview'}</button>` : ''}
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

  function creditsClock(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return '';
    const parsed = Number(seconds);
    if (!Number.isFinite(parsed) || parsed < 0) return '';
    const total = Math.round(parsed);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}m${String(secs).padStart(2, '0')}s`;
  }

  function parseCreditsClock(text) {
    const raw = String(text || '').trim();
    if (raw === '') return null;
    const mmss = /^(\d+)\s*m\s*(\d+(?:\.\d+)?)\s*s$/i.exec(raw);
    if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
    const colon = /^(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
    const justSec = Number(raw);
    if (Number.isFinite(justSec) && justSec >= 0) return justSec;
    return NaN;
  }

  function creditsTrimStatus(message, tone = '') {
    const node = $('credits-trim-status');
    if (!node) return;
    node.textContent = message || '';
    node.className = `credits-trim-status${tone ? ` is-${tone}` : ''}`;
  }

  function creditsUnbindPreviewLoop(video) {
    if (!video) return;
    if (video._creditsOnTime) {
      video.removeEventListener('timeupdate', video._creditsOnTime);
      video._creditsOnTime = null;
    }
    if (video._creditsOnMeta) {
      video.removeEventListener('loadedmetadata', video._creditsOnMeta);
      video._creditsOnMeta = null;
    }
    if (video._creditsOnPlay) {
      video.removeEventListener('play', video._creditsOnPlay);
      video._creditsOnPlay = null;
    }
    if (video._creditsOnEnded) {
      video.removeEventListener('ended', video._creditsOnEnded);
      video._creditsOnEnded = null;
    }
  }

  function creditsPreviewRangeFromFields() {
    const start = parseCreditsClock($('credits-trim-start')?.value);
    const end = parseCreditsClock($('credits-trim-end')?.value);
    return {
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) && end > 0 ? end : null,
    };
  }

  function creditsBindPreviewLoop(video) {
    if (!video) return;
    creditsUnbindPreviewLoop(video);
    const { start, end } = creditsPreviewRangeFromFields();
    const from = Math.max(0, start || 0);
    const to = end !== null && end > from ? end : null;
    const seekStart = () => {
      if (!Number.isFinite(video.duration)) return;
      const clamped = Math.min(from, Math.max(0, video.duration - 0.05));
      if (Math.abs(video.currentTime - clamped) > 0.15) {
        video.currentTime = clamped;
      }
    };
    video._creditsOnMeta = seekStart;
    video._creditsOnPlay = () => {
      if (video.currentTime < from - 0.08) video.currentTime = from;
    };
    video._creditsOnTime = () => {
      if (!Number.isFinite(video.currentTime)) return;
      if (video.currentTime < from - 0.08) {
        video.currentTime = from;
        return;
      }
      if (to === null) return;
      if (video.currentTime >= to - 0.05) {
        video.currentTime = from;
      }
    };
    video._creditsOnEnded = () => {
      video.currentTime = from;
      video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', video._creditsOnMeta);
    video.addEventListener('play', video._creditsOnPlay);
    video.addEventListener('timeupdate', video._creditsOnTime);
    video.addEventListener('ended', video._creditsOnEnded);
    if (video.readyState >= 1) seekStart();
  }

  function creditsPreviewStill(row) {
    if (row.kind !== 'video') return creditsMediaUrl(row.path || row.thumbPath);
    return creditsMediaUrl(row.thumbPath) || creditsYoutubeThumbUrl(row.youtubeUrl);
  }

  function creditsCanPreviewMedia(row) {
    return Boolean(creditsMediaUrl(row?.path) || creditsPreviewStill(row || {}));
  }

  function openCreditsPreview(index) {
    const row = (creditsEditGame?.media || [])[index];
    if (!row) return;
    creditsPreviewMedia = { ...row, index };

    const img = $('credits-preview-img');
    const video = $('credits-preview-video');
    const isVideo = row.kind === 'video';
    const fileUrl = creditsMediaUrl(row.path);

    video.pause();
    creditsUnbindPreviewLoop(video);
    video.removeAttribute('src');
    video.load();
    if (isVideo && fileUrl) {
      video.src = creditsBustedMediaUrl(row.path);
      video.hidden = false;
      img.hidden = true;
      img.removeAttribute('src');
    } else {
      const still = creditsPreviewStill(row);
      img.src = still;
      img.hidden = !still;
      video.hidden = true;
    }

    $('credits-preview-title').textContent = CREDITS_PRIORITY_LABELS[row.kind] || row.kind;
    const parts = [row.source || 'unknown', row.status || 'ready'];
    if (row.resolution) parts.push(`${row.resolution}p`);
    const clock = creditsClock(row.durationSeconds);
    if (clock) parts.push(clock);
    if (isVideo && !fileUrl) parts.push('not downloaded yet');
    $('credits-preview-caption').textContent = parts.join(' · ');

    const canTrim = isVideo && Boolean(fileUrl);
    $('credits-trim').hidden = !canTrim;
    const canRes = canTrim && Boolean(row.youtubeUrl || row.source === 'youtube');
    if ($('credits-resolution-row')) $('credits-resolution-row').hidden = !canRes;
    if (canTrim) {
      const start = Number(row.trimStart);
      const end = Number(row.trimEnd);
      $('credits-trim-start').value = Number.isFinite(start) && row.trimStart !== null
        ? creditsClock(start)
        : '00m00s';
      $('credits-trim-end').value = Number.isFinite(end) && row.trimEnd
        ? creditsClock(end)
        : '';
      if ($('credits-trim-resolution')) {
        $('credits-trim-resolution').value = String(row.resolution || $('credits-youtube-resolution')?.value || 720);
      }
      creditsTrimStatus(row.trimStart === null || row.trimStart === undefined
        ? 'No range picked yet — the display takes a few seconds from near the start.'
        : 'Using your saved range.');
      creditsBindPreviewLoop(video);
      video.play().catch(() => {});
    }
    $('credits-preview-sheet').hidden = false;
  }

  function creditsTrimTimeFromVideo(fieldId) {
    const video = $('credits-preview-video');
    if (!video || video.hidden || !Number.isFinite(video.currentTime)) return;
    $(fieldId).value = creditsClock(video.currentTime);
    creditsTrimStatus('Range changed — save it to rebuild the wall clip.');
    creditsBindPreviewLoop(video);
  }

  async function saveCreditsTrim({ clear = false } = {}) {
    if (!creditsPreviewMedia || !creditsEditGame) return;
    const startRaw = clear ? '' : $('credits-trim-start').value.trim();
    const endRaw = clear ? '' : $('credits-trim-end').value.trim();
    const trimStart = startRaw === '' ? null : parseCreditsClock(startRaw);
    const trimEnd = endRaw === '' ? null : parseCreditsClock(endRaw);
    if ((trimStart !== null && !Number.isFinite(trimStart))
      || (trimEnd !== null && !Number.isFinite(trimEnd))) {
      creditsTrimStatus('Enter the start and end as 01m03s.', 'bad');
      return;
    }
    if (trimStart !== null && trimEnd !== null && trimEnd <= trimStart) {
      creditsTrimStatus('The end has to come after the start.', 'bad');
      return;
    }

    const button = $('btn-credits-trim-save');
    button.disabled = true;
    creditsTrimStatus('Rebuilding the wall clip…');
    try {
      const { media: updated } = await apiPost(
        `${CREDITS_ROUTE}/games/${encodeURIComponent(creditsEditGame.id)}`
        + `/media/${encodeURIComponent(creditsPreviewMedia.id)}/trim`,
        { trimStart, trimEnd },
      );
      const rows = creditsEditGame.media || [];
      const at = rows.findIndex((item) => item.id === updated.id);
      if (at >= 0) rows[at] = updated;
      creditsPreviewMedia = { ...updated, index: creditsPreviewMedia.index };
      if (clear) {
        $('credits-trim-start').value = '00m00s';
        $('credits-trim-end').value = '';
      } else {
        $('credits-trim-start').value = trimStart !== null ? creditsClock(trimStart) : '00m00s';
        $('credits-trim-end').value = trimEnd !== null ? creditsClock(trimEnd) : '';
      }
      creditsBindPreviewLoop($('credits-preview-video'));
      renderCreditsMedia();
      creditsTrimStatus(
        updated.previewPath
          ? (clear ? 'Back to the automatic range.' : 'Clip range saved.')
          : (updated.statusDetail || 'Saved, but the clip could not be rebuilt.'),
        updated.previewPath ? 'good' : 'bad',
      );
    } catch (error) {
      creditsTrimStatus(error.message || 'Could not save the clip range.', 'bad');
    } finally {
      button.disabled = false;
    }
  }

  async function waitForCreditsMediaReady(gameId, mediaId) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (!creditsPreviewMedia || creditsPreviewMedia.id !== mediaId) return null;
      const [{ jobs = [] }, { game }] = await Promise.all([
        apiGet(`${CREDITS_ROUTE}/jobs`),
        apiGet(`${CREDITS_ROUTE}/games/${encodeURIComponent(gameId)}`),
      ]);
      const row = (game?.media || []).find((item) => item.id === mediaId);
      const job = [...jobs].reverse().find((item) => (
        item.gameId === gameId && item.mediaId === mediaId
      ));
      if (job?.state === 'failed' || row?.status === 'failed') {
        throw new Error(job?.error || row?.statusDetail || 'Download failed');
      }
      if (row && row.status === 'ready' && (!job || job.state === 'done')) {
        return { game, row };
      }
      creditsTrimStatus(`Re-downloading${row?.resolution ? ` at ${row.resolution}p` : ''}…`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('Timed out waiting for the new file');
  }

  function applyCreditsPreviewFile(row) {
    const video = $('credits-preview-video');
    if (!video || row?.kind !== 'video' || !row.path) return;
    creditsUnbindPreviewLoop(video);
    video.pause();
    video.src = creditsBustedMediaUrl(row.path);
    video.hidden = false;
    video.load();
    creditsBindPreviewLoop(video);
    video.play().catch(() => {});
  }

  async function saveCreditsResolution() {
    if (!creditsPreviewMedia || !creditsEditGame) return;
    const resolution = Number($('credits-trim-resolution')?.value);
    const gameId = creditsEditGame.id;
    const mediaId = creditsPreviewMedia.id;
    const button = $('btn-credits-resolution-save');
    if (button) button.disabled = true;
    creditsTrimStatus(`Re-downloading at ${resolution}p…`);
    try {
      const data = await apiPost(
        `${CREDITS_ROUTE}/games/${encodeURIComponent(gameId)}`
        + `/media/${encodeURIComponent(mediaId)}/resolution`,
        { resolution },
      );
      const queued = data.media || data;
      const rows = creditsEditGame.media || [];
      const at = rows.findIndex((item) => item.id === mediaId);
      if (at >= 0) rows[at] = { ...rows[at], ...queued };
      creditsPreviewMedia = { ...creditsPreviewMedia, ...queued };
      renderCreditsMedia();
      const ready = await waitForCreditsMediaReady(gameId, mediaId);
      if (!ready) return;
      creditsEditGame.media = ready.game.media;
      creditsPreviewMedia = { ...ready.row, index: creditsPreviewMedia.index };
      renderCreditsMedia();
      applyCreditsPreviewFile(ready.row);
      const parts = [ready.row.source || 'unknown', ready.row.status || 'ready'];
      if (ready.row.resolution) parts.push(`${ready.row.resolution}p`);
      const clock = creditsClock(ready.row.durationSeconds);
      if (clock) parts.push(clock);
      $('credits-preview-caption').textContent = parts.join(' · ');
      creditsTrimStatus(`${resolution}p is ready — preview updated.`, 'good');
    } catch (error) {
      creditsTrimStatus(error.message || 'Could not change the resolution.', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateCreditsMedia(action, index) {
    const media = creditsEditGame?.media || [];
    const row = media[index];
    if (!row) return;
    if (action === 'preview') {
      openCreditsPreview(index);
      return;
    }
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
      button.addEventListener('click', () => closeCreditsSheetById(button.dataset.closeCreditsSheet));
    });
    // Clicking the dimmed area outside a card dismisses it, matching the photo
    // lightbox. On the unsaved prompt that means cancel: the prompt closes and
    // the edit sheet stays open behind it, so nobody loses work by missing.
    registerSheetDismiss('credits-add-sheet', (el) => { el.hidden = true; });
    registerSheetDismiss('credits-edit-sheet', () => requestCreditsEditClose());
    registerSheetDismiss('credits-preview-sheet', () => closeCreditsPreview());
    registerSheetDismiss('credits-delete-sheet', (el) => { el.hidden = true; });
    registerSheetDismiss('credits-rescrape-sheet', (el) => { el.hidden = true; });
    registerSheetDismiss('credits-unsaved-sheet', (el) => { el.hidden = true; });
    $('btn-credits-unsaved-cancel')?.addEventListener('click', () => {
      $('credits-unsaved-sheet').hidden = true;
    });
    $('btn-credits-unsaved-discard')?.addEventListener('click', () => {
      creditsEditDirty = false;
      $('credits-unsaved-sheet').hidden = true;
      $('credits-edit-sheet').hidden = true;
    });
    $('btn-credits-unsaved-save')?.addEventListener('click', () => {
      $('credits-unsaved-sheet').hidden = true;
      saveCreditsEdit();
    });
    $('btn-credits-trim-start')?.addEventListener('click', () => creditsTrimTimeFromVideo('credits-trim-start'));
    $('btn-credits-trim-end')?.addEventListener('click', () => creditsTrimTimeFromVideo('credits-trim-end'));
    $('btn-credits-trim-save')?.addEventListener('click', () => saveCreditsTrim());
    $('btn-credits-trim-clear')?.addEventListener('click', () => saveCreditsTrim({ clear: true }));
    $('btn-credits-resolution-save')?.addEventListener('click', () => saveCreditsResolution());
    $('credits-trim-start')?.addEventListener('change', () => creditsBindPreviewLoop($('credits-preview-video')));
    $('credits-trim-end')?.addEventListener('change', () => creditsBindPreviewLoop($('credits-preview-video')));
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
    $('btn-credits-rebuild-previews')?.addEventListener('click', async () => {
      const btn = $('btn-credits-rebuild-previews');
      if (btn) btn.disabled = true;
      try {
        const result = await apiPost(`${CREDITS_ROUTE}/rebuild-previews`, {});
        const queued = Number(result.queued || 0);
        toast(
          queued
            ? `Rebuilding ${queued} wall preview${queued === 1 ? '' : 's'}…`
            : 'No ready videos to rebuild',
          'good',
        );
      } catch (error) {
        toast(error.message || 'Could not rebuild wall previews', 'bad');
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

  // Admin session: Log out is bound at the top of this file, beside the rest
  // of the chrome boot, so it works even if the wiring above it threw.

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

  // Vestaboards (Settings tab) -----------------------------------------------

  const VB_HEALTH_TONE = {
    ok: 'ok', degraded: 'warn', unhealthy: 'bad', offline: 'warn',
  };
  const VB_HEALTH_TEXT = {
    ok: 'OK', degraded: 'Key refused', unhealthy: 'Not answering', offline: 'Off',
  };

  let vbBoards = [];
  let vbHouse = { dwellSeconds: 15, priorities: null };
  let vbPriorityCatalog = null;
  let vbPriorityDraft = [];
  let vbPriorityDragIndex = -1;

  function vbBoardRow(board) {
    const row = document.createElement('div');
    row.className = 'vb-board-row';

    const head = document.createElement('div');
    head.className = 'vb-board-head';

    const name = document.createElement('div');
    name.className = 'auth-name';
    name.textContent = board.name;

    const pill = document.createElement('span');
    pill.className = `status-pill ${VB_HEALTH_TONE[board.health] || 'warn'}`;
    pill.textContent = board.enabled
      ? (VB_HEALTH_TEXT[board.health] || board.health)
      : 'Off';

    head.append(name, pill);

    const detail = document.createElement('div');
    detail.className = 'auth-detail';
    const bits = [board.simulator ? 'Simulator' : 'Local API'];
    if (!board.hasKey) bits.push('no key yet');
    if (board.quietHours?.enabled === false) {
      bits.push('quiet hours off');
    } else if (board.quietHours?.remindOnStart === false) {
      bits.push('no quiet reminder');
    } else {
      bits.push('quiet reminder on');
    }
    detail.textContent = bits.join(' · ');

    const remind = document.createElement('label');
    remind.className = 'trivia-check vb-board-remind';
    const remindInput = document.createElement('input');
    remindInput.type = 'checkbox';
    remindInput.checked = board.quietHours?.remindOnStart !== false;
    remindInput.addEventListener('change', () => {
      vbSetRemindOnStart(board.id, remindInput.checked);
    });
    const remindSpan = document.createElement('span');
    remindSpan.textContent = 'Quiet Hours Reminder when quiet starts';
    remind.append(remindInput, remindSpan);

    const actions = document.createElement('div');
    actions.className = 'vb-board-actions';

    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn btn-outline btn-sm';
    test.textContent = 'Test flip';
    test.disabled = !board.enabled || !board.hasKey;
    test.addEventListener('click', () => vbTestFlip(board.id, test));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-outline btn-sm';
    toggle.textContent = board.enabled ? 'Switch off' : 'Switch on';
    toggle.addEventListener('click', () => vbSetEnabled(board.id, !board.enabled));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-outline btn-sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => vbOpenForm(board));

    actions.append(test, toggle, edit);

    if (!board.simulator) {
      actions.append(vbRemoveButton(board));
    }

    row.append(head, detail, remind, actions);
    return row;
  }

  function vbRenderBoards() {
    const host = $('vb-board-list');
    if (!host) {
      return;
    }
    if (!vbBoards.length) {
      host.innerHTML = '<p class="hint">No boards yet.</p>';
      return;
    }
    host.innerHTML = '';
    for (const board of vbBoards) {
      host.appendChild(vbBoardRow(board));
    }
  }

  function vbApplyHouse(data) {
    if (data?.house) {
      vbHouse = {
        dwellSeconds: Number(data.house.dwellSeconds) || 15,
        priorities: Array.isArray(data.house.priorities) ? data.house.priorities : null,
      };
    }
    if (data?.priorityCatalog) {
      vbPriorityCatalog = data.priorityCatalog;
    }
    const dwell = $('vb-house-dwell');
    if (dwell) {
      dwell.value = String(vbHouse.dwellSeconds || 15);
    }
    const pri = $('btn-vb-house-priorities');
    if (pri) {
      const summary = vbPrioritySummary(vbHouse);
      pri.title = summary;
    }
  }

  async function loadVestaboards() {
    try {
      const data = await apiGet('/api/vestaboards');
      vbBoards = data.boards || [];
      vbApplyHouse(data);
      vbRenderBoards();
    } catch {
      const host = $('vb-board-list');
      if (host) {
        host.innerHTML = '<p class="hint">Vestaboards are switched off in config.</p>';
      }
    }
  }

  function vbCatalogEvent(source) {
    return (vbPriorityCatalog?.events || []).find((item) => item.source === source) || null;
  }

  function vbPrioritySummary(policy) {
    const list = Array.isArray(policy?.priorities) ? policy.priorities : (vbPriorityCatalog?.defaults || []);
    const jump = list.filter((rule) => rule.jump || rule.hold).length;
    const hold = list.filter((rule) => rule.hold).length;
    const now = list.filter((rule) => rule.immediate !== false && (rule.jump || rule.hold)).length;
    if (!jump) {
      return 'nothing jumps';
    }
    const parts = [`${jump} jump`];
    if (now && now !== jump) parts.push(`${now} now`);
    if (hold) parts.push(`${hold} hold`);
    return parts.join(' · ');
  }

  function vbClonePriorities(list) {
    return (Array.isArray(list) ? list : []).map((rule) => ({
      source: rule.source,
      jump: rule.jump !== false,
      immediate: rule.immediate !== false,
      hold: Boolean(rule.hold),
      holdMinutes: Number(rule.holdMinutes) || vbCatalogEvent(rule.source)?.defaultHoldMinutes || 30,
    }));
  }

  function vbOpenPriorities() {
    const sheet = $('vb-priority-sheet');
    if (!sheet) {
      return;
    }
    vbCloseForm();
    vbPriorityDraft = vbClonePriorities(
      vbHouse.priorities != null ? vbHouse.priorities : (vbPriorityCatalog?.defaults || []),
    );
    const title = $('vb-priority-title');
    if (title) {
      title.textContent = 'Priorities';
    }
    const picker = $('vb-priority-picker');
    if (picker) picker.hidden = true;
    const search = $('vb-priority-search');
    if (search) search.value = '';
    vbRenderPriorityList();
    sheet.hidden = false;
  }

  function vbClosePriorities() {
    const sheet = $('vb-priority-sheet');
    if (sheet) sheet.hidden = true;
    const picker = $('vb-priority-picker');
    if (picker) picker.hidden = true;
    vbPriorityDraft = [];
    vbPriorityDragIndex = -1;
  }

  function vbRenderPriorityList() {
    const host = $('vb-priority-list');
    const empty = $('vb-priority-empty');
    if (!host) {
      return;
    }
    host.innerHTML = '';
    if (empty) empty.hidden = vbPriorityDraft.length > 0;
    vbPriorityDraft.forEach((rule, index) => {
      host.appendChild(vbPriorityRow(rule, index));
    });
    vbRenderPriorityPicker();
  }

  function vbPriorityRow(rule, index) {
    const item = vbCatalogEvent(rule.source);
    const row = document.createElement('div');
    row.className = 'vb-priority-row';
    if (rule.hold) row.classList.add('is-holding');
    if (rule.hold && item?.holdCaution) row.classList.add('is-caution');
    row.draggable = true;
    row.dataset.priorityIndex = String(index);

    const handle = document.createElement('div');
    handle.className = 'vb-priority-handle';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'vb-priority-move';
    up.textContent = '▲';
    up.setAttribute('aria-label', 'Move up');
    up.disabled = index === 0;
    up.addEventListener('click', () => vbMovePriority(index, index - 1));
    const grip = document.createElement('div');
    grip.className = 'vb-priority-grip';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag to reorder';
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'vb-priority-move';
    down.textContent = '▼';
    down.setAttribute('aria-label', 'Move down');
    down.disabled = index === vbPriorityDraft.length - 1;
    down.addEventListener('click', () => vbMovePriority(index, index + 1));
    handle.append(up, grip, down);

    const rank = document.createElement('span');
    rank.className = 'vb-priority-rank';
    rank.textContent = String(index + 1);

    const name = document.createElement('div');
    name.className = 'vb-priority-name';
    name.textContent = item?.label || rule.source;
    if (rule.hold && item?.holdCaution) {
      name.title = 'Holding this pins the board. Alarms usually cut in now, then the queue continues.';
    } else if (rule.hold) {
      name.title = `Holds the board · gives up after ${rule.holdMinutes} min`;
    } else if (rule.immediate !== false) {
      name.title = 'Goes to the front and replaces what is showing as soon as flaps can move';
    } else {
      name.title = 'Goes to the front, then waits for the current page to finish';
    }

    const controls = document.createElement('div');
    controls.className = 'vb-priority-controls';

    const nowLabel = document.createElement('label');
    nowLabel.className = 'trivia-check';
    nowLabel.title = 'Replace what is on the board right away (after the flap rate window)';
    const nowInput = document.createElement('input');
    nowInput.type = 'checkbox';
    nowInput.checked = rule.immediate !== false;
    nowInput.addEventListener('change', () => {
      rule.immediate = nowInput.checked;
      if (rule.immediate) rule.jump = true;
      vbRenderPriorityList();
    });
    const nowSpan = document.createElement('span');
    nowSpan.textContent = 'Now';
    nowLabel.append(nowInput, nowSpan);
    controls.append(nowLabel);

    const holdLabel = document.createElement('label');
    holdLabel.className = 'trivia-check';
    const holdInput = document.createElement('input');
    holdInput.type = 'checkbox';
    holdInput.checked = Boolean(rule.hold);
    holdInput.addEventListener('change', () => {
      rule.hold = holdInput.checked;
      if (rule.hold) {
        rule.jump = true;
        rule.immediate = true;
      }
      vbRenderPriorityList();
    });
    const holdSpan = document.createElement('span');
    holdSpan.textContent = 'Hold';
    holdLabel.append(holdInput, holdSpan);
    controls.append(holdLabel);

    if (rule.hold) {
      const minutes = document.createElement('label');
      minutes.className = 'vb-priority-minutes';
      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.className = 'field-input';
      minInput.min = String(vbPriorityCatalog?.minHoldMinutes || 1);
      minInput.max = String(vbPriorityCatalog?.maxHoldMinutes || 180);
      minInput.value = String(rule.holdMinutes);
      minInput.title = 'Max hold time';
      minInput.addEventListener('change', () => {
        const raw = Number(minInput.value);
        const lo = vbPriorityCatalog?.minHoldMinutes || 1;
        const hi = vbPriorityCatalog?.maxHoldMinutes || 180;
        rule.holdMinutes = Number.isFinite(raw)
          ? Math.min(hi, Math.max(lo, Math.round(raw)))
          : (item?.defaultHoldMinutes || 30);
        minInput.value = String(rule.holdMinutes);
        vbRenderPriorityList();
      });
      const minText = document.createElement('span');
      minText.textContent = 'min';
      minutes.append(minInput, minText);
      controls.append(minutes);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'vb-priority-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${item?.label || rule.source}`);
    remove.addEventListener('click', () => {
      vbPriorityDraft.splice(index, 1);
      vbRenderPriorityList();
    });
    controls.append(remove);

    row.append(handle, rank, name, controls);

    row.addEventListener('dragstart', (event) => {
      vbPriorityDragIndex = index;
      row.classList.add('is-dragging');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      } catch {
        // Older WebViews reject setData; the drag still works locally.
      }
    });
    row.addEventListener('dragend', () => {
      vbPriorityDragIndex = -1;
      hostClearPriorityDrag();
    });
    row.addEventListener('dragover', (event) => {
      if (vbPriorityDragIndex < 0) return;
      event.preventDefault();
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', (event) => {
      if (!row.contains(event.relatedTarget)) {
        row.classList.remove('is-drop-target');
      }
    });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = vbPriorityDragIndex;
      vbPriorityDragIndex = -1;
      hostClearPriorityDrag();
      if (from >= 0 && from !== index) {
        vbMovePriority(from, index);
      }
    });

    return row;
  }

  function hostClearPriorityDrag() {
    $('vb-priority-list')?.querySelectorAll('.is-dragging, .is-drop-target').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  function vbMovePriority(from, to) {
    if (to < 0 || to >= vbPriorityDraft.length || from === to) {
      return;
    }
    const [row] = vbPriorityDraft.splice(from, 1);
    vbPriorityDraft.splice(to, 0, row);
    vbRenderPriorityList();
  }

  function vbRenderPriorityPicker() {
    const host = $('vb-priority-picker-list');
    if (!host || !vbPriorityCatalog) {
      return;
    }
    const query = String($('vb-priority-search')?.value || '').trim().toLowerCase();
    const taken = new Set(vbPriorityDraft.map((rule) => rule.source));
    host.innerHTML = '';
    let shown = 0;
    for (const group of vbPriorityCatalog.groups || []) {
      const events = (vbPriorityCatalog.events || []).filter((item) => {
        if (item.group !== group.id || taken.has(item.source)) return false;
        if (!query) return true;
        return `${item.label} ${item.source} ${item.hint}`.toLowerCase().includes(query);
      });
      if (!events.length) continue;
      const label = document.createElement('div');
      label.className = 'vb-priority-group-label';
      label.textContent = group.label;
      host.append(label);
      for (const item of events) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vb-priority-choice';
        const title = document.createElement('strong');
        title.textContent = item.label;
        const hint = document.createElement('span');
        hint.textContent = item.defaultHold ? 'Hold' : 'Jump';
        button.append(title, hint);
        button.addEventListener('click', () => {
          vbPriorityDraft.push({
            source: item.source,
            jump: true,
            immediate: true,
            hold: Boolean(item.defaultHold),
            holdMinutes: item.defaultHoldMinutes || 30,
          });
          const picker = $('vb-priority-picker');
          if (picker) picker.hidden = true;
          vbRenderPriorityList();
        });
        host.append(button);
        shown += 1;
      }
    }
    if (!shown) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = query ? 'Nothing matches.' : 'Every event in the catalog is already on the list.';
      host.append(none);
    }
  }

  function vbOpenForm(board = null) {
    const form = $('vb-board-form');
    if (!form) {
      return;
    }
    const isSim = Boolean(board?.simulator);
    $('vb-form-id').value = board?.id || '';
    $('vb-form-name').value = board?.name || '';
    $('vb-form-url').value = board?.baseUrl || '';
    $('vb-form-key').value = '';
    $('vb-form-quiet-start').value = board?.quietHours?.start || '22:00';
    $('vb-form-quiet-end').value = board?.quietHours?.end || '07:00';
    $('vb-form-quiet-enabled').checked = board?.quietHours?.enabled !== false;
    $('vb-form-quiet-remind').checked = board?.quietHours?.remindOnStart !== false;
    $('vb-form-url').disabled = isSim;
    $('vb-form-key').disabled = isSim;
    const urlHint = $('vb-form-url-hint');
    const keyHint = $('vb-form-key-hint');
    if (urlHint) {
      urlHint.textContent = isSim
        ? 'The simulator address is fixed on this host.'
        : 'Use the board\'s IP rather than its .local name — mDNS does not resolve from inside Docker.';
    }
    if (keyHint) {
      keyHint.hidden = isSim;
    }
    form.hidden = false;
    $('btn-vb-add').hidden = true;
    const quietPush = $('btn-vb-quiet-hours-push');
    if (quietPush) quietPush.hidden = true;
    $('vb-form-name').focus();
  }

  function vbCloseForm() {
    const form = $('vb-board-form');
    if (form) form.hidden = true;
    const add = $('btn-vb-add');
    if (add) add.hidden = false;
    const push = $('btn-vb-quiet-hours-push');
    if (push) push.hidden = false;
    $('vb-form-url').disabled = false;
    $('vb-form-key').disabled = false;
    const keyHint = $('vb-form-key-hint');
    if (keyHint) keyHint.hidden = false;
  }

  async function vbTestFlip(id, button) {
    button.disabled = true;
    try {
      const data = await apiPost('/api/vestaboards/test-flip', { id });
      toast(data.queued ? 'Test flip queued' : 'Test flip sent', 'good');
    } catch (error) {
      toast(error?.message || 'Test flip failed', 'bad');
    } finally {
      button.disabled = false;
    }
  }

  async function vbSetEnabled(id, enabled) {
    try {
      const data = await apiPost('/api/vestaboards/enable', { id, enabled });
      vbBoards = data.boards || [];
      vbApplyHouse(data);
      vbRenderBoards();
    } catch (error) {
      toast(error?.message || 'Could not change the board', 'bad');
    }
  }

  async function vbSetRemindOnStart(id, remindOnStart) {
    const board = vbBoards.find((entry) => entry.id === id);
    if (!board) {
      return;
    }
    try {
      const data = await apiPost('/api/vestaboards', {
        id: board.id,
        name: board.name,
        baseUrl: board.baseUrl || '',
        enabled: board.enabled,
        simulator: board.simulator,
        quietHours: {
          start: board.quietHours?.start || '22:00',
          end: board.quietHours?.end || '07:00',
          enabled: board.quietHours?.enabled !== false,
          remindOnStart: Boolean(remindOnStart),
        },
      });
      vbBoards = data.boards || [];
      vbRenderBoards();
      toast(
        remindOnStart ? 'Quiet Hours Reminder on' : 'Quiet Hours Reminder off',
        'good',
      );
    } catch (error) {
      toast(error?.message || 'Could not update Quiet Hours Reminder', 'bad');
      await loadVestaboards();
    }
  }

  /** Two-tap remove, the same guard the Remote tab uses for its hard actions. */
  function vbRemoveButton(board) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline btn-sm btn-danger';
    button.textContent = 'Remove';

    let armed = false;
    let disarm = null;

    button.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Tap to confirm';
        button.classList.add('confirming');
        disarm = window.setTimeout(() => {
          armed = false;
          button.textContent = 'Remove';
          button.classList.remove('confirming');
        }, 4000);
        return;
      }

      window.clearTimeout(disarm);
      try {
        const data = await apiPost('/api/vestaboards/remove', { id: board.id });
        vbBoards = data.boards || [];
        vbRenderBoards();
        toast('Board removed', 'good');
      } catch (error) {
        toast(error?.message || 'Could not remove the board', 'bad');
      }
    });

    return button;
  }

  $('btn-vb-add')?.addEventListener('click', () => vbOpenForm(null));
  $('btn-vb-cancel')?.addEventListener('click', () => vbCloseForm());
  $('btn-vb-priority-close')?.addEventListener('click', () => vbClosePriorities());
  registerSheetDismiss('vb-priority-sheet', () => vbClosePriorities());
  $('btn-vb-priority-add')?.addEventListener('click', () => {
    const picker = $('vb-priority-picker');
    if (!picker) return;
    picker.hidden = !picker.hidden;
    if (!picker.hidden) {
      vbRenderPriorityPicker();
      $('vb-priority-search')?.focus();
    }
  });
  $('vb-priority-search')?.addEventListener('input', () => vbRenderPriorityPicker());
  $('btn-vb-priority-reset')?.addEventListener('click', () => {
    const sheet = $('vb-priority-reset-sheet');
    if (sheet) sheet.hidden = false;
  });
  function vbClosePriorityReset() {
    const sheet = $('vb-priority-reset-sheet');
    if (sheet) sheet.hidden = true;
  }
  $('vb-priority-reset-cancel')?.addEventListener('click', () => vbClosePriorityReset());
  $('vb-priority-reset-confirm')?.addEventListener('click', () => {
    vbPriorityDraft = vbClonePriorities(vbPriorityCatalog?.defaults || []);
    vbRenderPriorityList();
    vbClosePriorityReset();
  });
  registerSheetDismiss('vb-priority-reset-sheet', () => vbClosePriorityReset());
  $('btn-vb-house-priorities')?.addEventListener('click', () => vbOpenPriorities());

  $('btn-vb-house-dwell-save')?.addEventListener('click', async () => {
    const button = $('btn-vb-house-dwell-save');
    if (button) button.disabled = true;
    try {
      const data = await apiPost('/api/vestaboards/house', {
        dwellSeconds: Number($('vb-house-dwell')?.value) || 15,
      });
      vbBoards = data.boards || vbBoards;
      vbApplyHouse(data);
      toast('Dwell saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save dwell', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-vb-priority-save')?.addEventListener('click', async () => {
    const button = $('btn-vb-priority-save');
    if (button) button.disabled = true;
    try {
      const data = await apiPost('/api/vestaboards/house', {
        priorities: vbPriorityDraft,
      });
      vbBoards = data.boards || vbBoards;
      vbApplyHouse(data);
      vbClosePriorities();
      toast('Priorities saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save priorities', 'bad');
    } finally {
      if (button) button.disabled = false;
    }
  });

  $('btn-vb-quiet-hours-push')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await apiPost('/api/push/quiet-hours-reminder', withTarget());
      toast(`Quiet Hours Reminder (${result.variant || 'night card'})`, 'good');
    } catch (error) {
      toast(error?.message || 'Could not push Quiet Hours Reminder', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('vb-board-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('vb-form-name').value.trim();
    if (!name) {
      toast('The board needs a name', 'bad');
      return;
    }
    const payload = {
      id: $('vb-form-id').value.trim() || name,
      name,
      baseUrl: $('vb-form-url').value.trim(),
      quietHours: {
        start: $('vb-form-quiet-start').value || '22:00',
        end: $('vb-form-quiet-end').value || '07:00',
        enabled: $('vb-form-quiet-enabled').checked,
        remindOnStart: $('vb-form-quiet-remind').checked,
      },
    };
    const key = $('vb-form-key').value.trim();
    if (key) {
      payload.key = key;
    }

    try {
      const data = await apiPost('/api/vestaboards', payload);
      vbBoards = data.boards || [];
      vbApplyHouse(data);
      vbRenderBoards();
      vbCloseForm();
      toast('Board saved', 'good');
    } catch (error) {
      toast(error?.message || 'Could not save the board', 'bad');
    }
  });

  // Vestaboard simulator -----------------------------------------------------
  // The page holds no opinion about what the board should show. It draws the
  // layout the simulator reports and animates whatever changed since the last
  // one, so what you see here is exactly what a real board would have flipped.

  const VB_ROWS = 6;
  const VB_COLS = 22;
  const VB_TILES = VB_ROWS * VB_COLS;
  // 63 and up are the solid colour chips; everything below is a glyph.
  const VB_CHIP_MIN = 63;
  const VB_MAX_CALLS = 20;
  // One mechanical click. Keep in sync with `.vb-tile.is-flipping .vb-flap`.
  const VB_FLAP_MS = 100;
  // Cap so a blank→chip wrap cannot take the whole cascade on one module.
  const VB_MAX_DRUM_STEPS = 24;
  // Full-board rewrite length. Fallback until <audio> reports duration;
  // keep in sync with `vb-flip.wav` (~5.6s after trim).
  const VB_CASCADE_MS = 5616;
  const VB_SOUND_KEY = 'signal.vbSound';

  let vbGlyphs = {};
  let vbDrum = [];
  let vbTiles = null;
  let vbCurrent = null;
  let vbShown = null;
  let vbGen = null;
  let vbCalls = [];
  let vbEvents = null;
  let vbQueueDragging = false;
  let vbQueueItems = [];
  let vbQueueRevision = 0;
  let vbPendingQueue = null;
  let vbQueuePollTimer = null;
  const VB_QUEUE_POLL_MS = 2000;
  let vbRateTimer = null;
  let vbRateUntil = 0;
  let vbRateGame = false;
  let vbSoundOn = (() => {
    try {
      return window.localStorage.getItem(VB_SOUND_KEY) !== '0';
    } catch {
      return true;
    }
  })();
  let vbAudioCtx = null;
  let vbAudioMaster = null;
  let vbClickBuffers = [];
  let vbFlipSample = null;
  let vbFlipSampleReady = false;
  // Flips that arrived while the board tab was hidden — replay with sound
  // the next time the admin is actually looking at the flaps.
  let vbPendingReplay = null;
  let vbSettleTimer = null;

  function vbBoardWatching() {
    return document.body.dataset.tab === 'board' && !document.hidden;
  }

  function vbLoadFlipSample() {
    if (vbFlipSample) {
      return vbFlipSample;
    }
    try {
      vbFlipSample = new Audio('vb-flip.wav?v=signal89');
      vbFlipSample.preload = 'auto';
      vbFlipSample.addEventListener('canplaythrough', () => {
        vbFlipSampleReady = true;
      }, { once: true });
      vbFlipSample.load();
    } catch {
      vbFlipSample = null;
    }
    return vbFlipSample;
  }

  function vbCascadeMs() {
    const seconds = Number(vbFlipSample?.duration);
    if (Number.isFinite(seconds) && seconds > 1 && seconds < 20) {
      return Math.round(seconds * 1000);
    }
    return VB_CASCADE_MS;
  }

  function vbStaggerBudgetMs() {
    const walk = VB_MAX_DRUM_STEPS * VB_FLAP_MS;
    return Math.max(400, vbCascadeMs() - walk);
  }

  function vbReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  }

  function vbBuildClickBuffer(ctx, variant) {
    const duration = 0.028;
    const n = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const thudF = 155 + variant * 32;
    const tickF = 2200 + variant * 380;
    for (let i = 0; i < n; i += 1) {
      const t = i / ctx.sampleRate;
      const snap = Math.exp(-t * 220);
      const body = Math.exp(-t * 85);
      const noise = (Math.random() * 2 - 1) * snap * 0.62;
      const thud = Math.sin(2 * Math.PI * thudF * t) * body * 0.48;
      const tick = Math.sin(2 * Math.PI * tickF * t) * snap * 0.42;
      data[i] = noise + thud + tick;
    }
    return buffer;
  }

  function vbEnsureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      return null;
    }
    if (!vbAudioCtx) {
      vbAudioCtx = new AC();
      const compressor = vbAudioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 10;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.09;
      vbAudioMaster = vbAudioCtx.createGain();
      vbAudioMaster.gain.value = 0.55;
      compressor.connect(vbAudioMaster);
      vbAudioMaster.connect(vbAudioCtx.destination);
      vbAudioMaster._in = compressor;
      vbClickBuffers = [0, 1, 2, 3].map((v) => vbBuildClickBuffer(vbAudioCtx, v));
    }
    return vbAudioCtx;
  }

  function vbUnlockAudio() {
    const ctx = vbEnsureAudio();
    if (!ctx) {
      return;
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    // iOS only fully unlocks after a buffer plays inside the gesture.
    try {
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
  }

  function vbPlayClick() {
    // Clicks only while the flaps are on screen — a hidden board tab still
    // has document.hidden === false, which is how a flip used to rattle
    // against Push / Settings with nothing to look at.
    if (!vbSoundOn || vbReducedMotion() || !vbBoardWatching()) {
      return;
    }
    const ctx = vbAudioCtx;
    if (!ctx || ctx.state !== 'running' || !vbClickBuffers.length) {
      return;
    }
    const buffer = vbClickBuffers[Math.floor(Math.random() * vbClickBuffers.length)];
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.9 + Math.random() * 0.24;
    const gain = ctx.createGain();
    gain.gain.value = 0.55 + Math.random() * 0.4;
    src.connect(gain);
    gain.connect(vbAudioMaster?._in || ctx.destination);
    src.start(ctx.currentTime + Math.random() * 0.004);
  }

  function vbStopCascade() {
    if (vbFlipSample) {
      try {
        vbFlipSample.pause();
        vbFlipSample.currentTime = 0;
      } catch {
        // ignore
      }
    }
  }

  function vbPlayCascade() {
    if (!vbSoundOn || vbReducedMotion() || !vbBoardWatching()) {
      return;
    }
    const sample = vbLoadFlipSample();
    if (sample && (vbFlipSampleReady || sample.readyState >= 2)) {
      try {
        sample.pause();
        sample.currentTime = 0;
        sample.volume = 0.78;
        const played = sample.play();
        if (played && typeof played.catch === 'function') {
          played.catch(() => vbPlaySampleRattle());
        }
        return;
      } catch {
        // fall through to the synthesized swarm
      }
    }
    vbPlaySampleRattle();
  }

  function vbPlaySampleRattle() {
    vbUnlockAudio();
    const ctx = vbAudioCtx;
    if (!ctx) {
      return;
    }
    const start = () => {
      for (let i = 0; i < 8; i += 1) {
        window.setTimeout(vbPlayClick, i * 70);
      }
    };
    if (ctx.state === 'running') {
      start();
    } else {
      ctx.resume().then(start).catch(() => {});
    }
  }

  function vbSyncSoundButton() {
    const button = $('btn-vb-sound');
    if (button) {
      button.textContent = vbSoundOn ? 'Sound on' : 'Sound off';
    }
  }

  function vbBuildGrid() {
    const grid = $('vb-grid');
    if (!grid) {
      return;
    }
    if (vbTiles) {
      return;
    }
    vbTiles = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < VB_TILES; i += 1) {
      const tile = document.createElement('div');
      tile.className = 'vb-tile';
      // Perspective lives on the cell; the flap is the card that actually
      // rotates so a click reads as a split-flap drop, not a 2D squash.
      const flap = document.createElement('div');
      flap.className = 'vb-flap';
      const glyph = document.createElement('span');
      glyph.className = 'vb-glyph';
      flap.appendChild(glyph);
      tile.appendChild(flap);
      frag.appendChild(tile);
      vbTiles.push(tile);
    }
    grid.appendChild(frag);
    vbCurrent = new Array(VB_TILES).fill(0);
    vbShown = new Array(VB_TILES).fill(0);
    vbGen = new Array(VB_TILES).fill(0);
  }

  function vbEnsureGrid() {
    if (!vbTiles) {
      vbBuildGrid();
    }
  }

  function vbPaintTile(tile, code) {
    const glyph = tile.querySelector('.vb-glyph');
    if (code >= VB_CHIP_MIN) {
      tile.classList.add('is-chip');
      tile.dataset.chip = String(code);
      if (glyph) {
        glyph.textContent = '';
      }
      return;
    }
    tile.classList.remove('is-chip');
    delete tile.dataset.chip;
    if (glyph) {
      // The charset maps blank to a space. Writing that space is not enough
      // if a previous letter is still in the node — always clear code 0.
      glyph.textContent = code === 0 ? '' : (vbGlyphs[code] ?? vbGlyphs[String(code)] ?? '');
    }
  }

  function vbFaceMatches(index, code) {
    return (vbCurrent[index] ?? 0) === code && (vbShown[index] ?? 0) === code;
  }

  function vbSettleBoard() {
    if (!vbTiles || !vbCurrent) {
      return;
    }
    for (let index = 0; index < VB_TILES; index += 1) {
      const tile = vbTiles[index];
      const code = vbCurrent[index] ?? 0;
      if (!tile || (vbShown[index] ?? 0) === code) {
        continue;
      }
      if (tile.classList.contains('is-flipping')) {
        continue;
      }
      vbShown[index] = code;
      vbPaintTile(tile, code);
    }
  }

  function vbScheduleSettle() {
    window.clearTimeout(vbSettleTimer);
    const wait = VB_CASCADE_MS + (VB_MAX_DRUM_STEPS * VB_FLAP_MS) + 250;
    vbSettleTimer = window.setTimeout(vbSettleBoard, wait);
  }

  function vbStopTile(index) {
    if (vbGen) {
      vbGen[index] += 1;
    }
    const tile = vbTiles?.[index];
    if (tile) {
      tile.classList.remove('is-flipping');
    }
  }

  function vbFlipDelay(index, strategy) {
    const row = Math.floor(index / VB_COLS);
    const col = index % VB_COLS;
    const budget = vbStaggerBudgetMs();
    const jitter = Math.random() * 40;
    switch (strategy) {
      case 'reverse-column':
        return ((VB_COLS - 1 - col) / (VB_COLS - 1)) * budget + jitter;
      case 'row':
        return (row / Math.max(1, VB_ROWS - 1)) * budget + jitter;
      case 'diagonal':
        return ((row + col) / (VB_ROWS + VB_COLS - 2)) * budget + jitter;
      case 'edges-to-center': {
        const dist = Math.min(col, VB_COLS - 1 - col);
        const maxDist = Math.max(1, Math.floor((VB_COLS - 1) / 2));
        return (dist / maxDist) * budget + jitter;
      }
      case 'random':
        return Math.random() * budget;
      case 'column':
      default:
        return (col / (VB_COLS - 1)) * budget + jitter;
    }
  }

  function vbDrumSteps(from, to) {
    const drum = vbDrum;
    if (!Array.isArray(drum) || drum.length < 2 || from === to) {
      return [to];
    }
    let fromIdx = drum.indexOf(from);
    let toIdx = drum.indexOf(to);
    if (fromIdx < 0) fromIdx = 0;
    if (toIdx < 0) toIdx = 0;
    const len = drum.length;
    const distance = (toIdx - fromIdx + len) % len;
    if (distance === 0) {
      return [to];
    }
    const stride = distance > VB_MAX_DRUM_STEPS
      ? Math.ceil(distance / VB_MAX_DRUM_STEPS)
      : 1;
    const steps = [];
    for (let walked = stride; walked < distance; walked += stride) {
      steps.push(drum[(fromIdx + walked) % len]);
    }
    steps.push(to);
    return steps;
  }

  function vbRunFlips(index, codes, startDelay) {
    const tile = vbTiles[index];
    if (!tile || !codes.length) {
      return;
    }
    const gen = (vbGen[index] += 1);
    const flapMs = vbReducedMotion() ? 1 : VB_FLAP_MS;
    const swapAt = Math.max(1, Math.floor(flapMs * 0.48));

    const run = (step) => {
      if (vbGen[index] !== gen) {
        return;
      }
      if (step >= codes.length) {
        tile.classList.remove('is-flipping');
        const target = vbCurrent[index] ?? 0;
        vbPaintTile(tile, target);
        vbShown[index] = target;
        return;
      }
      const code = codes[step];
      tile.classList.remove('is-flipping');
      void tile.offsetWidth;
      tile.classList.add('is-flipping');
      if (!vbFlipSampleReady) {
        vbPlayClick();
      }
      window.setTimeout(() => {
        if (vbGen[index] !== gen) {
          return;
        }
        vbPaintTile(tile, code);
        vbShown[index] = code;
      }, swapAt);
      window.setTimeout(() => run(step + 1), flapMs);
    };

    window.setTimeout(() => {
      if (vbGen[index] !== gen) {
        return;
      }
      run(0);
    }, startDelay);
  }

  function vbSnapToCurrent() {
    if (!vbTiles || !vbCurrent) {
      return;
    }
    vbStopCascade();
    for (let index = 0; index < VB_TILES; index += 1) {
      const tile = vbTiles[index];
      if (!tile) continue;
      vbStopTile(index);
      const code = vbCurrent[index] ?? 0;
      vbShown[index] = code;
      vbPaintTile(tile, code);
    }
  }

  function vbStartQueuePoll() {
    if (vbQueuePollTimer) {
      return;
    }
    vbQueuePollTimer = window.setInterval(() => {
      if (!vbBoardWatching() || vbQueueDragging) {
        return;
      }
      vbRefreshQueueFromSim();
    }, VB_QUEUE_POLL_MS);
  }

  function vbStopQueuePoll() {
    window.clearInterval(vbQueuePollTimer);
    vbQueuePollTimer = null;
  }

  function vbOnBoardTabLeave() {
    // Finish in-flight flaps so we do not resume a half-spin later.
    vbSnapToCurrent();
    vbStopQueuePoll();
  }

  function vbOnBoardTabEnter() {
    vbStartQueuePoll();
    // A flip that landed while we were elsewhere is still worth seeing —
    // roll committed targets back to what is painted, then walk forward so
    // sound and flaps stay paired.
    const pending = vbPendingReplay;
    vbPendingReplay = null;
    if (!pending?.layout) {
      vbSettleBoard();
      return;
    }
    requestAnimationFrame(() => {
      if (!vbBoardWatching()) return;
      if (vbShown && vbCurrent) {
        for (let index = 0; index < VB_TILES; index += 1) {
          vbCurrent[index] = vbShown[index] ?? 0;
        }
      }
      vbApplyLayout(pending.layout, true, pending.strategy);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      vbSnapToCurrent();
      vbStopQueuePoll();
    } else if (document.body.dataset.tab === 'board') {
      vbStartQueuePoll();
      vbRefreshQueueFromSim();
      vbSettleBoard();
    }
  });

  function vbApplyLayout(layout, animate, strategy) {
    vbEnsureGrid();
    if (!Array.isArray(layout) || !vbTiles) {
      return;
    }
    const flat = [];
    for (const row of layout) {
      for (const code of row) {
        flat.push(Number(code) || 0);
      }
    }

    // Flaps on a `display: none` panel never paint; playing the cascade then
    // is how you heard a flip with nothing moving. Keep the painted board on
    // the last frame the admin saw and replay when they come back.
    const watching = vbBoardWatching();
    if (animate && !watching) {
      let changing = 0;
      for (let index = 0; index < VB_TILES; index += 1) {
        const code = flat[index] ?? 0;
        if ((vbCurrent[index] ?? 0) !== code) changing += 1;
        vbCurrent[index] = code;
      }
      if (changing) {
        vbPendingReplay = { layout, strategy: strategy || 'column' };
      }
      return;
    }

    let starting = 0;
    for (let index = 0; index < VB_TILES; index += 1) {
      const code = flat[index] ?? 0;
      const tile = vbTiles[index];
      if (!tile) {
        continue;
      }

      if (!animate || vbReducedMotion()) {
        // A later sim.state with the same target must not snap a drum that's
        // still walking — or one still waiting on its stagger delay (before
        // `is-flipping` is set). That race is how you heard vb-flip.wav with
        // an instant paint and no flaps. A stale face on that same target
        // (letters left on the ocean after a map flip) is fixed by settle.
        if ((vbCurrent[index] ?? 0) === code) {
          continue;
        }
        vbStopTile(index);
        vbCurrent[index] = code;
        vbShown[index] = code;
        vbPaintTile(tile, code);
        continue;
      }

      if (vbFaceMatches(index, code)) {
        continue;
      }
      vbCurrent[index] = code;
      starting += 1;
      vbRunFlips(index, vbDrumSteps(vbShown[index] ?? 0, code), vbFlipDelay(index, strategy));
    }
    if (starting) {
      vbPendingReplay = null;
      vbPlayCascade();
      vbScheduleSettle();
    }
  }

  function vbStartRateCountdown(cooldownMs, { game = false } = {}) {
    window.clearInterval(vbRateTimer);
    const pill = $('vb-pill-rate');
    if (!pill) {
      return;
    }
    vbRateGame = Boolean(game);
    vbRateUntil = Date.now() + Math.max(0, cooldownMs || 0);
    const tick = () => {
      const left = Math.max(0, Math.ceil((vbRateUntil - Date.now()) / 1000));
      if (left > 0) {
        pill.textContent = vbRateGame ? `Next card in ${left}s` : `Next flip in ${left}s`;
        pill.className = 'status-pill warn';
        return;
      }
      pill.textContent = vbRateGame ? 'Holding' : 'Next flip now';
      pill.className = `status-pill ${vbRateGame ? 'warn' : 'ok'}`;
      window.clearInterval(vbRateTimer);
    };
    tick();
    vbRateTimer = window.setInterval(tick, 250);
  }

  function vbRenderState(state) {
    if (!state) {
      return;
    }
    const pill = $('vb-pill-online');
    if (pill) {
      pill.textContent = state.online ? 'Online' : 'Offline';
      pill.className = `status-pill ${state.online ? 'ok' : 'bad'}`;
    }
    $('vb-bezel')?.classList.toggle('is-offline', !state.online);
    const toggle = $('btn-vb-toggle');
    if (toggle) {
      toggle.textContent = state.online ? 'Turn off' : 'Turn on';
    }
    const quiet = $('vb-pill-quiet');
    if (quiet) {
      quiet.hidden = !state.quietHours;
    }
    vbStartRateCountdown(state.cooldownMs, { game: Boolean(state.gameLock) });
    if (Array.isArray(state.current)) {
      vbApplyLayout(state.current, false);
    }
  }

  function vbClockOf(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour12: false });
    } catch {
      return '';
    }
  }

  function vbResultTone(result) {
    if (result.startsWith('200')) return 'ok';
    if (result.startsWith('503')) return 'warn';
    return 'bad';
  }

  /** What was asked for: the endpoint, and who asked, when we know. */
  function vbCallTarget(call) {
    const target = call.endpoint || call.method || '';
    const from = call.from ? ` from ${call.from}` : '';
    return `${target}${from}`;
  }

  function vbRenderCalls() {
    const count = $('vb-calls-count');
    if (count) {
      // Refusals are named while the section is still shut, so a board that is
      // rejecting every frame does not need opening to be noticed.
      const refused = vbCalls.filter((call) => !String(call.result || '').startsWith('200')).length;
      const parts = vbCalls.length ? [String(vbCalls.length)] : [];
      if (refused) parts.push(`${refused} refused`);
      count.textContent = parts.length ? `(${parts.join(' · ')})` : '';
    }
    const host = $('vb-calls');
    if (!host) {
      return;
    }
    if (!vbCalls.length) {
      host.innerHTML = '<p class="hint">No calls yet.</p>';
      return;
    }
    host.innerHTML = '';
    for (const call of [...vbCalls].reverse()) {
      const row = document.createElement('div');
      row.className = 'vb-row vb-row-call';

      const meta = document.createElement('div');
      meta.className = 'vb-row-call-meta';

      const time = document.createElement('span');
      time.className = 'vb-row-time';
      time.textContent = vbClockOf(call.at);
      meta.appendChild(time);

      if (call.detail) {
        const detail = document.createElement('span');
        detail.className = 'vb-row-detail';
        detail.textContent = call.detail;
        meta.appendChild(detail);
      }

      const target = document.createElement('div');
      target.className = 'vb-row-call-target';

      const verb = document.createElement('span');
      verb.className = 'vb-row-verb';
      verb.textContent = call.verb || String(call.method || '').split(' ')[0];

      const main = document.createElement('span');
      main.className = 'vb-row-main';
      main.textContent = vbCallTarget(call);
      main.title = call.agent ? `${vbCallTarget(call)} · ${call.agent}` : vbCallTarget(call);

      target.append(verb, main);

      const result = document.createElement('span');
      result.className = `vb-row-result ${vbResultTone(call.result)}`;
      result.textContent = call.result;

      row.append(meta, target, result);
      host.appendChild(row);
    }
  }

  function vbQueueIdsFromDom() {
    return [...document.querySelectorAll('#vb-queue .vb-queue-row')]
      .map((row) => row.dataset.id)
      .filter(Boolean);
  }

  function vbQueueRevisionOf(payload) {
    const rev = Number(payload?.revision ?? payload?.queueRevision);
    return Number.isFinite(rev) ? rev : null;
  }

  function vbFlushPendingQueue() {
    if (!vbPendingQueue) {
      return;
    }
    const pending = vbPendingQueue;
    vbPendingQueue = null;
    vbApplyQueue(pending.items, pending.revision);
  }

  function vbApplyQueue(items, revision) {
    if (revision != null && revision < vbQueueRevision) {
      return;
    }
    if (revision != null) {
      vbQueueRevision = revision;
    }
    if (vbQueueDragging) {
      vbPendingQueue = { items, revision };
      return;
    }
    vbRenderQueue(items);
  }

  function vbRefreshQueueFromSim() {
    return apiGet('/api/vestaboard-sim').then((data) => {
      if (!data?.ok) {
        return;
      }
      vbApplyQueue(data.queue, data.queueRevision);
      if (data.state) {
        const nextUntil = Date.now() + Math.max(0, data.state.cooldownMs || 0);
        const game = Boolean(data.state.gameLock);
        if (Math.abs(nextUntil - vbRateUntil) > 1500 || game !== vbRateGame) {
          vbStartRateCountdown(data.state.cooldownMs, { game });
        } else {
          vbRateGame = game;
        }
      }
    }).catch(() => {
      // SSE or the next poll will catch up.
    });
  }

  async function vbCancelQueued(id) {
    try {
      const data = await apiPost('/api/vestaboard-sim/queue/cancel', { id });
      vbApplyQueue(data.queue, data.queueRevision);
    } catch {
      await vbRefreshQueueFromSim();
    }
  }

  async function vbClearQueue() {
    if (!vbQueueItems.length) {
      return;
    }
    try {
      vbEndQueueDrag(document.querySelector('.vb-queue-row.dragging'));
      const data = await apiPost('/api/vestaboard-sim/queue/clear', {});
      vbApplyQueue(data.queue, data.queueRevision);
    } catch (error) {
      toast(error?.message || 'Could not clear the queue', 'bad');
      await vbRefreshQueueFromSim();
    }
  }

  async function vbReleaseHolds() {
    try {
      const data = await apiPost('/api/vestaboards/release-holds', {});
      if (data?.queue) {
        vbApplyQueue(data.queue, data.queueRevision);
      }
      if (data?.state) {
        vbStartRateCountdown(data.state.cooldownMs, { game: Boolean(data.state.gameLock) });
      } else {
        await vbRefreshQueueFromSim();
      }
      const n = Number(data?.released) || 0;
      toast(
        n === 0
          ? 'No holds to release'
          : n === 1
            ? 'Released hold on 1 board'
            : `Released holds on ${n} boards`,
      );
    } catch (error) {
      toast(error?.message || 'Could not release holds', 'bad');
      await vbRefreshQueueFromSim();
    }
  }

  function vbSyncClearButton() {
    const btn = $('btn-vb-queue-clear');
    if (!btn) {
      return;
    }
    btn.hidden = vbQueueItems.length === 0;
  }

  async function vbCommitQueueOrder() {
    const ids = vbQueueIdsFromDom();
    const before = vbQueueItems.map((item) => item.id).filter(Boolean);
    if (!ids.length || ids.join('\0') === before.join('\0')) {
      vbFlushPendingQueue();
      return;
    }
    try {
      const data = await apiPost('/api/vestaboard-sim/queue/reorder', { ids });
      vbApplyQueue(data.queue, data.queueRevision);
    } catch (error) {
      toast(error?.message || 'Could not reorder the queue', 'bad');
      await vbRefreshQueueFromSim();
    }
    vbFlushPendingQueue();
  }

  function vbEndQueueDrag(row) {
    row?.classList.remove('dragging');
    document.body.classList.remove('vb-queue-dragging');
    vbQueueDragging = false;
  }

  function vbStartQueueDrag(event, row) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.target.closest?.('.vb-queue-cancel')) {
      return;
    }
    event.preventDefault();
    vbQueueDragging = true;
    row.classList.add('dragging');
    document.body.classList.add('vb-queue-dragging');

    const pointerId = event.pointerId;
    const onMove = (move) => {
      if (move.pointerId !== pointerId) {
        return;
      }
      const host = $('vb-queue');
      if (!host) {
        return;
      }
      const others = [...host.querySelectorAll('.vb-queue-row')].filter((node) => node !== row);
      const y = move.clientY;
      let before = null;
      for (const other of others) {
        const box = other.getBoundingClientRect();
        if (y < box.top + box.height / 2) {
          before = other;
          break;
        }
      }
      if (before) {
        host.insertBefore(row, before);
      } else {
        host.appendChild(row);
      }
    };
    const onUp = (up) => {
      if (up && up.pointerId !== pointerId) {
        return;
      }
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      vbEndQueueDrag(row);
      vbCommitQueueOrder();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
  }

  function vbRenderQueue(items) {
    const host = $('vb-queue');
    if (!host) {
      return;
    }
    vbQueueItems = Array.isArray(items) ? items : [];
    vbSyncClearButton();
    if (!vbQueueItems.length) {
      host.innerHTML = '<p class="hint">Nothing queued.</p>';
      return;
    }
    host.innerHTML = '';
    for (const item of vbQueueItems) {
      const row = document.createElement('div');
      row.className = 'vb-row vb-queue-row';
      row.dataset.id = item.id || '';

      const handle = document.createElement('span');
      handle.className = 'vb-queue-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.textContent = '⋮⋮';

      const source = document.createElement('span');
      source.className = 'vb-queue-source';
      source.textContent = item.source || '—';
      source.title = item.source || '';

      const main = document.createElement('span');
      main.className = 'vb-queue-title';
      main.textContent = item.label || 'Frame';
      main.title = item.label || 'Frame';

      const state = document.createElement('span');
      const cuttingIn = item.status === 'cutting-in';
      state.className = `vb-queue-status${item.status === 'held' ? ' is-held' : ''}${cuttingIn ? ' is-now' : ''}`;
      state.textContent = item.notBefore
        ? `not before ${vbClockOf(item.notBefore)}`
        : (item.status === 'held' ? 'held' : (cuttingIn ? 'cutting in' : 'waiting'));

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'vb-queue-cancel';
      cancel.setAttribute('aria-label', 'Cancel this page');
      cancel.textContent = '×';
      cancel.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (item.id) {
          vbCancelQueued(item.id);
        }
      });

      row.addEventListener('pointerdown', (event) => vbStartQueueDrag(event, row));
      row.append(handle, source, main, state, cancel);
      host.appendChild(row);
    }
  }

  async function loadVestaboardSim() {
    vbLoadFlipSample();
    let data;
    try {
      data = await apiGet('/api/vestaboard-sim');
    } catch {
      const port = $('vb-port');
      if (port) {
        port.textContent = 'Simulator is switched off in config';
      }
      return;
    }
    if (!data?.ok) {
      return;
    }

    vbGlyphs = data.glyphs || {};
    vbDrum = Array.isArray(data.drum) ? data.drum.map((code) => Number(code) || 0) : [];
    vbBuildGrid();
    vbSyncSoundButton();
    vbApplyLayout(data.state?.current, false);
    vbRenderState(data.state);
    vbCalls = data.calls || [];
    vbRenderCalls();
    vbApplyQueue(data.queue, data.queueRevision);

    const port = $('vb-port');
    if (port && data.port) {
      port.textContent = `Local API on port ${data.port}`;
    }
  }

  function startVestaboardSimEvents() {
    if (vbBoardWatching()) {
      vbStartQueuePoll();
    }
    if (vbEvents && vbEvents.readyState !== EventSource.CLOSED) {
      return;
    }
    try {
      vbEvents = new EventSource(appUrl('/api/vestaboard-sim/events'));
    } catch {
      return;
    }

    const on = (name, handler) => {
      vbEvents.addEventListener(name, (event) => {
        try {
          handler(JSON.parse(event.data));
        } catch {
          // ignore malformed events
        }
      });
    };

    on('sim.state', (state) => vbRenderState(state));
    on('sim.flip', (detail) => vbApplyLayout(detail.layout, true, detail.strategy));
    on('sim.call', (call) => {
      vbCalls.push(call);
      while (vbCalls.length > VB_MAX_CALLS) {
        vbCalls.shift();
      }
      vbRenderCalls();
    });
    on('sim.queue', (detail) => vbApplyQueue(detail.items, vbQueueRevisionOf(detail)));

    vbEvents.onerror = () => {
      vbRefreshQueueFromSim();
    };
  }

  $('btn-vb-queue-clear')?.addEventListener('click', () => {
    vbClearQueue();
  });

  $('btn-vb-release-holds')?.addEventListener('click', () => {
    vbReleaseHolds();
  });

  $('btn-vb-sound')?.addEventListener('click', () => {
    vbSoundOn = !vbSoundOn;
    try {
      window.localStorage.setItem(VB_SOUND_KEY, vbSoundOn ? '1' : '0');
    } catch {
      // private mode
    }
    vbSyncSoundButton();
    vbUnlockAudio();
    if (vbSoundOn) {
      // Explicit gesture on the board tab — sample the cascade so muted
      // browsers prove audio works. Not played on mere tab entry.
      vbPlayCascade();
    } else {
      vbStopCascade();
    }
  });
  vbSyncSoundButton();

  document.addEventListener('pointerdown', vbUnlockAudio, { capture: true, passive: true });
  document.addEventListener('keydown', vbUnlockAudio, { capture: true });
  vbLoadFlipSample();

  $('btn-vb-toggle')?.addEventListener('click', async () => {
    const button = $('btn-vb-toggle');
    const turningOn = button.textContent.trim() === 'Turn on';
    button.disabled = true;
    try {
      const data = await apiPost('/api/vestaboard-sim/online', { online: turningOn });
      vbRenderState(data.state);
    } catch (error) {
      toast(error?.message || 'Could not reach the simulator', 'bad');
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('.tab-btn[data-tab="settings"]')?.addEventListener('click', () => {
    loadVestaboards();
  });

  document.querySelector('.tab-btn[data-tab="settings"]')?.addEventListener('click', () => {
    loadOverheadSettings();
    loadIssTrackerSettings();
    loadStarlinkTrackerSettings();
    loadFlightplanSettings();
    loadLocaleSettings();
    loadPublicUrlSettings();
    loadGuestBookSettings();
    loadRingSettings();
    loadGuestSnapsSettings();
    loadWeatherAlertsSettings();
    loadWorldPopulationSettings();
  });

  // ---------------------------------------------------------- Flight Plan

  function summarizeFlightplanPush(label, result = {}) {
    const boards = result?.vestaboard?.boards || [];
    const accepted = boards.filter((row) => Number(row.accepted) > 0).length;
    const skipped = boards.filter((row) => row.skipped).length;
    if (boards.length && accepted > 0) {
      result.vestaboardAccepted = true;
      return `${label} sent — Vestaboard updated (${accepted})`;
    }
    if (boards.length && accepted === 0) {
      result.vestaboardAccepted = false;
      const reason = boards.map((row) => row.reason).filter(Boolean)[0] || 'skipped';
      return `${label} sent to displays — Vestaboard skipped (${reason})`;
    }
    result.vestaboardAccepted = null;
    if (skipped) return `${label} sent — Vestaboard skipped`;
    return `${label} sent to selected display(s)`;
  }

  let flightplanTripId = null;
  let flightplanHomeAirport = 'SLC';
  let flightplanSearchLegs = [];
  const flightplanLoadedTrips = new Set();
  const flightplanPopulateInflight = new Map();

  function formatFlightplanAirlineNumber(airline, number) {
    const code = String(airline || '').trim().toUpperCase();
    let num = String(number || '').trim().toUpperCase().replace(/\s+/g, '');
    if (code && num.startsWith(code)) num = num.slice(code.length);
    return `${code} ${num}`.trim();
  }

  function formatFlightplanTripDates(trip) {
    if (trip.startDate && trip.endDate && trip.endDate !== trip.startDate) {
      return `${trip.startDate} – ${trip.endDate}`;
    }
    return trip.startDate || trip.endDate || '';
  }

  function bindFlightplanEndDateDefault(startEl, endEl) {
    endEl?.addEventListener('focus', () => {
      if (!endEl.value && startEl?.value) endEl.value = startEl.value;
    });
  }

  function renderFlightplanLedger(status) {
    const line = $('flightplan-ledger-line');
    if (!line) return;
    const ledger = status?.ledger || {};
    const used = Number(ledger.cycleUsed) || 0;
    const cap = Number(ledger.hardCap) || 600;
    const days = ledger.daysUntilReset != null ? ledger.daysUntilReset : '—';
    line.textContent = `${used} of ${cap} units used — resets in ${days} days`;
    if (ledger.state === 'low' || ledger.state === 'out') {
      line.classList.add('hint-warn');
    } else {
      line.classList.remove('hint-warn');
    }
  }

  function renderFlightplanSettings(status) {
    const settings = status?.settings || {};
    flightplanHomeAirport = settings.homeAirport || 'SLC';
    if ($('flightplan-enabled')) $('flightplan-enabled').checked = settings.enabled === true;
    if ($('flightplan-home-airport')) $('flightplan-home-airport').value = flightplanHomeAirport;
    if ($('flightplan-auto-push')) $('flightplan-auto-push').checked = settings.autoPushEnabled !== false;
    if ($('flightplan-log-only')) $('flightplan-log-only').checked = settings.pollerLogOnly !== false;
    const pill = $('flightplan-status-pill');
    if (pill) {
      const cred = status?.credentials || {};
      let credLine = 'No API key';
      if (cred.keyUnreadable) credLine = 'Saved key unreadable — re-enter';
      else if (cred.hasApiKey) {
        credLine = `Key …${cred.apiKeyHint || '????'} (${cred.apiKeySource || 'saved'})`;
      }
      pillState(pill, settings.enabled && cred.hasApiKey ? 'good' : '', settings.enabled ? 'Enabled' : 'Disabled');
      pill.title = credLine;
    }
    const apiHint = $('flightplan-api-hint');
    if (apiHint) {
      const cred = status?.credentials || {};
      let hint = '';
      if (cred.keyUnreadable) {
        hint = 'Could not read the saved RapidAPI key (encryption key may have changed). Paste your AeroDataBox key again and save.';
      } else if (cred.envBlocksOverwrite) {
        hint = 'FLIGHTPLAN_RAPIDAPI_KEY in the environment overrides any key saved here.';
      } else if (cred.genericRapidApiKeyIgnored) {
        hint = 'RAPIDAPI_KEY is set in the environment but ignored — Flight Plan needs FLIGHTPLAN_RAPIDAPI_KEY or a key saved below from your AeroDataBox subscription.';
      } else if (!cred.hasApiKey) {
        hint = 'No AeroDataBox key is active — flight search will fail until you save one below.';
      }
      if (hint) {
        apiHint.hidden = false;
        apiHint.textContent = hint;
        apiHint.classList.add('hint-warn');
      } else {
        apiHint.hidden = true;
        apiHint.textContent = '';
        apiHint.classList.remove('hint-warn');
      }
    }
    renderFlightplanLedger(status);
  }

  async function loadFlightplanSettings() {
    try {
      const status = await apiGet('/api/flightplan/status');
      renderFlightplanSettings(status);
    } catch (error) {
      toast(error.message || 'Could not load Flight Plan settings', 'bad');
    }
  }

  function buildFlightplanTripCardShell(trip) {
    const card = document.createElement('details');
    card.className = 'flightplan-trip-card';
    card.dataset.tripId = trip.id;
    card.dataset.phase = trip.phase || '';
    const dates = formatFlightplanTripDates(trip);
    const metaParts = [`${trip.flightCount || 0} flights`, trip.phase || '', dates].filter(Boolean);
    card.innerHTML = `<summary>
        <div class="flightplan-trip-summary-main">
          <strong>${escapeHtml(trip.name)}</strong>
          <span class="flightplan-trip-summary-meta">${escapeHtml(metaParts.join(' · '))}</span>
        </div>
      </summary>
      <div class="flightplan-trip-body"><p class="hint">Loading…</p></div>`;
    card.addEventListener('toggle', () => {
      if (card.dataset.suppressToggle === '1') return;
      if (card.open) {
        populateFlightplanTripCard(card, trip.id).catch((error) => {
          toast(error.message || 'Could not load trip', 'bad');
        });
      }
    });
    return card;
  }

  async function populateFlightplanTripCard(card, tripId, { force = false } = {}) {
    const body = card.querySelector('.flightplan-trip-body');
    if (!body) return;
    if (!force && flightplanLoadedTrips.has(tripId) && body.querySelector('[data-field="name"]')) return;
    if (flightplanPopulateInflight.has(tripId)) {
      await flightplanPopulateInflight.get(tripId);
      return;
    }
    const work = (async () => {
      const data = await apiGet(`/api/flightplan/trips/${encodeURIComponent(tripId)}`);
      const trip = data.trip;
      flightplanLoadedTrips.add(tripId);
      body.innerHTML = `
      <label class="field-label">Name
        <input class="field-input" data-field="name" name="flightplan-trip-title" autocomplete="off" data-lpignore="true" data-1p-ignore="true" value="${escapeHtml(trip.name || '')}">
      </label>
      <div class="autodarts-field-grid">
        <label class="field-label">Start date
          <input class="field-input" data-field="startDate" type="date" value="${escapeHtml(trip.startDate || '')}">
        </label>
        <label class="field-label">End date
          <input class="field-input" data-field="endDate" type="date" value="${escapeHtml(trip.endDate || '')}">
        </label>
      </div>
      <label class="field-label">Notes
        <textarea class="field-input" data-field="notes" rows="3">${escapeHtml(trip.notes || '')}</textarea>
      </label>
      <div class="flightplan-flights-head">
        <span class="field-label">Flights</span>
        <button type="button" class="btn btn-outline btn-sm" data-action="add-flight">Add flight</button>
      </div>
      <div class="flightplan-flight-list" data-flight-list></div>
      <div class="autodarts-footer-actions">
        <button type="button" class="btn btn-outline" data-action="push-next" title="Show this trip next upcoming flight on the selected display(s) and Vestaboard">Push next flight</button>
        <button type="button" class="btn btn-accent" data-action="push-board" title="Show this trip departure board on the selected display(s) and Vestaboard">Push trip board</button>
        <button type="button" class="btn btn-outline" data-action="delete-trip">Delete trip</button>
      </div>`;
      const startInput = body.querySelector('[data-field="startDate"]');
      const endInput = body.querySelector('[data-field="endDate"]');
      bindFlightplanEndDateDefault(startInput, endInput);
      body.querySelectorAll('[data-field]').forEach((field) => {
        field.addEventListener('change', () => {
          saveFlightplanTripCard(card, tripId).catch(() => {});
        });
      });
      body.querySelector('[data-action="add-flight"]')?.addEventListener('click', () => {
        showFlightplanFlightSheet(tripId);
      });
      body.querySelector('[data-action="push-next"]')?.addEventListener('click', async () => {
        try {
          const result = await apiPost('/api/push/flightplan-next', withTarget({ tripId }));
          toast(summarizeFlightplanPush('Next flight', result), result?.vestaboardAccepted === false ? 'bad' : 'good');
        } catch (error) {
          toast(error.message || 'Could not push next flight', 'bad');
        }
      });
      body.querySelector('[data-action="push-board"]')?.addEventListener('click', async () => {
        try {
          const result = await apiPost('/api/push/flightplan-board', withTarget({ tripId }));
          toast(summarizeFlightplanPush('Trip board', result), result?.vestaboardAccepted === false ? 'bad' : 'good');
        } catch (error) {
          toast(error.message || 'Could not push trip board', 'bad');
        }
      });
      body.querySelector('[data-action="delete-trip"]')?.addEventListener('click', async () => {
        const count = (data.flights || []).length;
        if (!confirm(`Delete "${trip.name}" and ${count} flight(s)?`)) return;
        await fetch(`/api/flightplan/trips/${tripId}`, { method: 'DELETE', credentials: 'same-origin' });
        flightplanLoadedTrips.delete(tripId);
        if (flightplanTripId === tripId) flightplanTripId = null;
        loadFlightplanTrips({ force: true });
        toast('Trip deleted', 'good');
      });
      renderFlightplanFlights(body.querySelector('[data-flight-list]'), tripId, data.flights || []);
      refreshFlightplanTripSummary(card);
    })();
    flightplanPopulateInflight.set(tripId, work);
    try {
      await work;
    } finally {
      flightplanPopulateInflight.delete(tripId);
    }
  }

  function refreshFlightplanTripSummary(card) {
    const body = card.querySelector('.flightplan-trip-body');
    const strong = card.querySelector('.flightplan-trip-summary-main strong');
    const meta = card.querySelector('.flightplan-trip-summary-meta');
    if (!body || !strong || !meta) return;
    const name = body.querySelector('[data-field="name"]')?.value || 'Trip';
    const startDate = body.querySelector('[data-field="startDate"]')?.value || '';
    const endDate = body.querySelector('[data-field="endDate"]')?.value || '';
    const flightCount = body.querySelectorAll('.flightplan-flight-row').length;
    strong.textContent = name;
    const dates = formatFlightplanTripDates({ startDate, endDate });
    const metaParts = [`${flightCount} flights`, card.dataset.phase || '', dates].filter(Boolean);
    meta.textContent = metaParts.join(' · ');
  }

  async function saveFlightplanTripCard(card, tripId) {
    const body = card.querySelector('.flightplan-trip-body');
    if (!body) return;
    await fetch(`/api/flightplan/trips/${tripId}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: body.querySelector('[data-field="name"]')?.value,
        startDate: body.querySelector('[data-field="startDate"]')?.value,
        endDate: body.querySelector('[data-field="endDate"]')?.value,
        notes: body.querySelector('[data-field="notes"]')?.value,
      }),
    });
    refreshFlightplanTripSummary(card);
  }

  async function loadFlightplanTrips({ force = false } = {}) {
    try {
      const status = await apiGet('/api/flightplan/status');
      flightplanHomeAirport = status?.settings?.homeAirport || 'SLC';
    } catch {
      /* home-airport shortcut still works with last known value */
    }
    try {
      const filterBtn = document.querySelector('#flightplan-filter-tabs .segmented-btn.active');
      const filter = filterBtn?.dataset.filter || 'upcoming';
      const result = await apiGet(`/api/flightplan/trips?filter=${encodeURIComponent(filter)}&sort=date&dir=asc`);
      const list = $('flightplan-trip-list');
      if (!list) return;
      const trips = result.trips || [];
      const existing = new Map(
        [...list.querySelectorAll('.flightplan-trip-card')].map((el) => [el.dataset.tripId, el]),
      );
      const nextIds = new Set(trips.map((trip) => trip.id));

      // Soft update: keep open trip editors mounted so they do not flash/reload.
      if (!force && existing.size) {
        for (const [id, card] of existing) {
          if (!nextIds.has(id)) {
            flightplanLoadedTrips.delete(id);
            card.remove();
          }
        }
        for (const trip of trips) {
          let card = existing.get(trip.id);
          if (!card) {
            card = buildFlightplanTripCardShell(trip);
            list.appendChild(card);
            continue;
          }
          card.dataset.phase = trip.phase || '';
          if (!card.open || !card.querySelector('[data-field="name"]')) {
            const strong = card.querySelector('.flightplan-trip-summary-main strong');
            const meta = card.querySelector('.flightplan-trip-summary-meta');
            if (strong) strong.textContent = trip.name || 'Trip';
            if (meta) {
              const dates = formatFlightplanTripDates(trip);
              const metaParts = [`${trip.flightCount || 0} flights`, trip.phase || '', dates].filter(Boolean);
              meta.textContent = metaParts.join(' · ');
            }
          } else {
            refreshFlightplanTripSummary(card);
          }
        }
        if (!trips.length && !list.querySelector('.flightplan-trip-card')) {
          list.innerHTML = '<p class="hint">No trips in this filter.</p>';
        }
        return;
      }

      const openIds = new Set(
        [...list.querySelectorAll('.flightplan-trip-card[open]')].map((el) => el.dataset.tripId),
      );
      list.innerHTML = '';
      for (const trip of trips) {
        const card = buildFlightplanTripCardShell(trip);
        list.appendChild(card);
        if (openIds.has(trip.id)) {
          card.dataset.suppressToggle = '1';
          card.open = true;
          delete card.dataset.suppressToggle;
          flightplanLoadedTrips.delete(trip.id);
          await populateFlightplanTripCard(card, trip.id, { force: true });
        }
      }
      if (!trips.length) {
        list.innerHTML = '<p class="hint">No trips in this filter.</p>';
      }
    } catch (error) {
      toast(error.message || 'Could not load trips', 'bad');
    }
  }

  function renderFlightplanFlights(listEl, tripId, flights) {
    if (!listEl) return;
    listEl.innerHTML = '';
    for (const flight of flights) {
      const row = document.createElement('div');
      row.className = 'flightplan-flight-row';
      const route = `${flight.origin?.iata || '—'} → ${flight.destination?.iata || '—'}`;
      const label = formatFlightplanAirlineNumber(flight.airline, flight.number);
      row.innerHTML = `<div><strong>${escapeHtml(label)}</strong> · ${escapeHtml(route)} · ${escapeHtml(flight.state || '')}</div>
        <button type="button" class="btn btn-outline btn-sm" data-refresh="${flight.id}">Refresh</button>
        <button type="button" class="btn btn-outline btn-sm" data-delete="${flight.id}">Remove</button>`;
      row.querySelector('[data-refresh]')?.addEventListener('click', async () => {
        await apiPost(`/api/flightplan/flights/${flight.id}/refresh`, {});
        toast('Flight refreshed', 'good');
        const card = document.querySelector(`.flightplan-trip-card[data-trip-id="${tripId}"]`);
        flightplanLoadedTrips.delete(tripId);
        if (card) {
          await populateFlightplanTripCard(card, tripId);
          refreshFlightplanTripSummary(card);
        }
      });
      row.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!confirm(`Remove flight ${flight.airline} ${flight.number}?`)) return;
        await fetch(`/api/flightplan/flights/${flight.id}`, { method: 'DELETE', credentials: 'same-origin' });
        const card = document.querySelector(`.flightplan-trip-card[data-trip-id="${tripId}"]`);
        flightplanLoadedTrips.delete(tripId);
        if (card) {
          await populateFlightplanTripCard(card, tripId);
          refreshFlightplanTripSummary(card);
        }
      });
      listEl.appendChild(row);
    }
  }

  function bindFlightplanAirportTypeahead(input, suggestEl) {
    if (!input || !suggestEl) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) {
          suggestEl.hidden = true;
          return;
        }
        const result = await apiGet(`/api/flightplan/airports?q=${encodeURIComponent(q)}`);
        suggestEl.innerHTML = '';
        for (const row of result.airports || []) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'typeahead-item';
          const code = row.iata || row.icao || '—';
          const city = row.city ? ` · ${row.city}` : '';
          btn.textContent = `${code} — ${row.name}${city}`;
          btn.addEventListener('click', () => {
            input.value = code;
            suggestEl.hidden = true;
          });
          suggestEl.appendChild(btn);
        }
        suggestEl.hidden = !(result.airports || []).length;
      }, 200);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { suggestEl.hidden = true; }, 150);
    });
  }

  let flightplanUnsavedTarget = null;

  function flightplanTripSheetDirty() {
    return Boolean(
      $('flightplan-new-name')?.value?.trim()
      || $('flightplan-new-start')?.value
      || $('flightplan-new-end')?.value
      || $('flightplan-new-notes')?.value?.trim(),
    );
  }

  function flightplanFlightSheetDirty() {
    const list = $('flightplan-leg-list');
    const hasLegButtons = list?.querySelector('button');
    const hasMessage = list?.querySelector('.hint')?.textContent?.trim();
    return Boolean(
      hasLegButtons
      || hasMessage
      || $('flightplan-search-airline')?.value?.trim()
      || $('flightplan-search-number')?.value?.trim(),
    );
  }

  function hideFlightplanUnsavedSheet() {
    if ($('flightplan-unsaved-sheet')) $('flightplan-unsaved-sheet').hidden = true;
    flightplanUnsavedTarget = null;
  }

  function showFlightplanUnsavedSheet(target) {
    flightplanUnsavedTarget = target;
    const saveBtn = $('btn-flightplan-unsaved-save');
    if (target === 'trip') {
      $('flightplan-unsaved-title').textContent = 'Create this trip?';
      $('flightplan-unsaved-text').textContent = 'You entered trip details that have not been saved yet.';
      if (saveBtn) {
        saveBtn.hidden = false;
        saveBtn.textContent = 'Create trip';
      }
    } else {
      $('flightplan-unsaved-title').textContent = 'Discard search?';
      $('flightplan-unsaved-text').textContent = 'Your flight search will be lost.';
      if (saveBtn) saveBtn.hidden = true;
    }
    if ($('flightplan-unsaved-sheet')) $('flightplan-unsaved-sheet').hidden = false;
  }

  function requestCloseFlightplanTripSheet() {
    if (!flightplanTripSheetDirty()) {
      hideFlightplanTripSheet();
      return;
    }
    showFlightplanUnsavedSheet('trip');
  }

  function requestCloseFlightplanFlightSheet() {
    if (!flightplanFlightSheetDirty()) {
      hideFlightplanFlightSheet();
      return;
    }
    showFlightplanUnsavedSheet('flight');
  }

  function setFlightplanTestResult(message, ok = null) {
    const resultEl = $('flightplan-test-result');
    if (!resultEl) return;
    resultEl.textContent = message || '';
    resultEl.classList.toggle('hint-ok', ok === true);
    resultEl.classList.toggle('hint-warn', ok === false);
  }

  function showFlightplanTripSheet() {
    $('flightplan-new-name').value = '';
    $('flightplan-new-start').value = '';
    $('flightplan-new-end').value = '';
    $('flightplan-new-notes').value = '';
    $('flightplan-trip-sheet').hidden = false;
    $('flightplan-new-name')?.focus();
  }

  function hideFlightplanTripSheet() {
    $('flightplan-trip-sheet').hidden = true;
  }

  function showFlightplanFlightSheet(tripId) {
    flightplanTripId = tripId;
    flightplanSearchLegs = [];
    $('flightplan-leg-list').innerHTML = '';
    if ($('flightplan-search-airline')) $('flightplan-search-airline').value = '';
    if ($('flightplan-search-number')) $('flightplan-search-number').value = '';
    const card = document.querySelector(`.flightplan-trip-card[data-trip-id="${tripId}"]`);
    const startDate = card?.querySelector('[data-field="startDate"]')?.value;
    $('flightplan-search-date').value = startDate || new Date().toISOString().slice(0, 10);
    if ($('flightplan-search-airport')) $('flightplan-search-airport').value = '';
    $('flightplan-flight-sheet').hidden = false;
  }

  function hideFlightplanFlightSheet() {
    $('flightplan-flight-sheet').hidden = true;
  }

  function renderFlightplanLegs(legs, meta = {}) {
    flightplanSearchLegs = legs || [];
    const list = $('flightplan-leg-list');
    list.innerHTML = '';
    if (meta.allLegCount > 0 && !legs.length && meta.airport) {
      list.innerHTML = `<p class="hint">Found ${meta.allLegCount} leg(s) for that flight, but none use ${escapeHtml(meta.airport)}. Try another airport or clear the field.</p>`;
      return;
    }
    legs.forEach((leg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline btn-block';
      const o = leg.origin?.iata || leg.origin?.icao || '—';
      const d = leg.destination?.iata || leg.destination?.icao || '—';
      btn.textContent = `${leg.airline || ''} ${leg.number || ''} · ${o} → ${d}`;
      btn.addEventListener('click', async () => {
        const created = await apiPost(`/api/flightplan/trips/${flightplanTripId}/flights/import`, {
          leg,
          date: $('flightplan-search-date')?.value,
        });
        if (!created.ok) {
          toast(created.error || 'Could not import flight', 'bad');
          return;
        }
        hideFlightplanFlightSheet();
        toast('Flight added', 'good');
        const card = document.querySelector(`.flightplan-trip-card[data-trip-id="${flightplanTripId}"]`);
        flightplanLoadedTrips.delete(flightplanTripId);
        if (card) {
          await populateFlightplanTripCard(card, flightplanTripId);
          refreshFlightplanTripSummary(card);
        }
      });
      list.appendChild(btn);
    });
    if (!legs.length) {
      list.innerHTML = '<p class="hint">No matching legs — check the date, airport, or flight number.</p>';
    }
  }

  async function createFlightplanTrip() {
    const name = $('flightplan-new-name')?.value?.trim();
    if (!name) {
      toast('Trip name is required', 'bad');
      return false;
    }
    try {
      const created = await apiPost('/api/flightplan/trips', {
        name,
        startDate: $('flightplan-new-start')?.value || undefined,
        endDate: $('flightplan-new-end')?.value || undefined,
        notes: $('flightplan-new-notes')?.value || undefined,
      });
      if (!created.ok) {
        toast(created.error || 'Could not create trip', 'bad');
        return false;
      }
      hideFlightplanUnsavedSheet();
      hideFlightplanTripSheet();
      await loadFlightplanTrips();
      const card = document.querySelector(`.flightplan-trip-card[data-trip-id="${created.trip.id}"]`);
      if (card) {
        card.open = true;
        await populateFlightplanTripCard(card, created.trip.id);
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      toast('Trip created', 'good');
      return true;
    } catch (error) {
      toast(error.message || 'Could not create trip', 'bad');
      return false;
    }
  }

  bindFlightplanEndDateDefault($('flightplan-new-start'), $('flightplan-new-end'));

  $('btn-flightplan-settings-save')?.addEventListener('click', async () => {
    try {
      const body = {
        enabled: Boolean($('flightplan-enabled')?.checked),
        homeAirport: $('flightplan-home-airport')?.value,
        autoPushEnabled: Boolean($('flightplan-auto-push')?.checked),
        pollerLogOnly: Boolean($('flightplan-log-only')?.checked),
      };
      const key = $('flightplan-api-key')?.value?.trim();
      if (key) body.rapidApiKey = key;
      await apiPost('/api/flightplan/settings', body);
      if ($('flightplan-api-key')) $('flightplan-api-key').value = '';
      setFlightplanTestResult('');
      toast('Flight Plan settings saved', 'good');
      loadFlightplanSettings();
    } catch (error) {
      toast(error.message || 'Could not save settings', 'bad');
    }
  });

  $('btn-flightplan-test-key')?.addEventListener('click', async () => {
    setFlightplanTestResult('Testing AeroDataBox connection…');
    try {
      const key = $('flightplan-api-key')?.value?.trim();
      await apiPost('/api/flightplan/verify-key', key ? { rapidApiKey: key } : {});
      setFlightplanTestResult('Connected — AeroDataBox accepted this API key.', true);
      toast('AeroDataBox API key is valid', 'good');
      if (key) {
        await apiPost('/api/flightplan/settings', { rapidApiKey: key });
        if ($('flightplan-api-key')) $('flightplan-api-key').value = '';
      }
      loadFlightplanSettings();
    } catch (error) {
      const msg = error.message || 'API key test failed';
      setFlightplanTestResult(msg, false);
      toast(msg, 'bad');
    }
  });

  $('btn-flightplan-home-fill')?.addEventListener('click', () => {
    if ($('flightplan-home-airport')) {
      $('flightplan-home-airport').value = flightplanHomeAirport;
    }
  });

  $('btn-flightplan-trip-new')?.addEventListener('click', () => {
    showFlightplanTripSheet();
  });

  $('btn-flightplan-trip-cancel')?.addEventListener('click', requestCloseFlightplanTripSheet);

  $('btn-flightplan-trip-create')?.addEventListener('click', () => {
    createFlightplanTrip();
  });

  registerSheetDismiss('flightplan-unsaved-sheet', () => hideFlightplanUnsavedSheet());
  registerSheetDismiss('flightplan-trip-sheet', () => requestCloseFlightplanTripSheet());
  registerSheetDismiss('flightplan-flight-sheet', () => requestCloseFlightplanFlightSheet());

  $('btn-flightplan-unsaved-cancel')?.addEventListener('click', hideFlightplanUnsavedSheet);
  $('btn-flightplan-unsaved-discard')?.addEventListener('click', () => {
    hideFlightplanUnsavedSheet();
    if (flightplanUnsavedTarget === 'trip') hideFlightplanTripSheet();
    else hideFlightplanFlightSheet();
  });
  $('btn-flightplan-unsaved-save')?.addEventListener('click', () => {
    if (flightplanUnsavedTarget === 'trip') createFlightplanTrip();
  });

  $('flightplan-filter-tabs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.segmented-btn');
    if (!btn) return;
    document.querySelectorAll('#flightplan-filter-tabs .segmented-btn').forEach((el) => el.classList.remove('active'));
    btn.classList.add('active');
    loadFlightplanTrips({ force: true });
  });

  $('btn-flightplan-flight-cancel')?.addEventListener('click', requestCloseFlightplanFlightSheet);
  $('btn-flightplan-search-run')?.addEventListener('click', async () => {
    try {
      const result = await apiPost('/api/flightplan/search', {
        airline: $('flightplan-search-airline')?.value,
        number: $('flightplan-search-number')?.value,
        date: $('flightplan-search-date')?.value,
        airport: $('flightplan-search-airport')?.value,
      });
      renderFlightplanLegs(result.legs || [], result);
    } catch (error) {
      toast(error.message || 'Search failed', 'bad');
    }
  });

  $('btn-flightplan-search-airport-home')?.addEventListener('click', () => {
    if ($('flightplan-search-airport')) {
      $('flightplan-search-airport').value = flightplanHomeAirport || 'SLC';
      $('flightplan-search-airport').focus();
    }
  });

  bindFlightplanAirportTypeahead($('flightplan-home-airport'), $('flightplan-home-suggest'));
  bindFlightplanAirportTypeahead($('flightplan-search-airport'), $('flightplan-search-airport-suggest'));

  initSheetDismiss();

  // The chrome (status poll, Push tiles) is already up — it boots near the top
  // of this file so it does not depend on any of the wiring in between.
  refreshDisplays({ quiet: true });
  startDisplayEvents();
  applySteamReturnTab();
  loadVestaboardSim().then(() => startVestaboardSimEvents());
  // Fallback poll if EventSource is blocked or drops (SSE is primary).
  setInterval(() => refreshDisplays({ quiet: true }), 60000);

  // Reached only when every binding above survived, so from here on an error
  // is a runtime problem for a toast to report, not a broken page.
  bootWindowOpen = false;
})();
