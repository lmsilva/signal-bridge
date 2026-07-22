/* Display Control — control page logic (vanilla JS, no framework) */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ API helpers

  const ALL_DISPLAYS = '*';
  const STORAGE_TARGET_KEY = 'displayControl.targetId';

  async function apiPost(route, body = {}) {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data || {};
  }

  async function apiGet(route) {
    const response = await fetch(route, { cache: 'no-store' });
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

  function withTarget(body = {}) {
    return { ...body, targetId: selectedTargetId() };
  }

  // -------------------------------------------------------- Display picker

  let knownDisplays = [];

  function updateControlTabVisibility() {
    const controlBtn = $('tab-btn-control');
    const single = isSingleDisplaySelected();
    if (controlBtn) {
      controlBtn.hidden = !single;
    }
    if (!single) {
      const controlPanel = $('tab-control');
      const activeControl = document.querySelector('.tab-btn.active')?.dataset?.tab === 'control';
      if (activeControl) {
        document.querySelector('.tab-btn[data-tab="push"]')?.click();
      }
      if (controlPanel) {
        controlPanel.classList.remove('active');
      }
    }
    const hint = $('display-bar-hint');
    if (!hint) {
      return;
    }
    if (!knownDisplays.length) {
      hint.textContent = 'No displays yet — tap refresh after the client starts, or wait for the 5‑minute heartbeat.';
    } else if (single) {
      const entry = knownDisplays.find((d) => d.id === selectedTargetId());
      hint.textContent = entry?.stale
        ? `${entry.name} looks offline (no recent heartbeat). Control may still work if it is awake.`
        : `Controlling ${entry?.name || 'selected display'}.`;
    } else {
      hint.textContent = 'All Displays selected — push and power commands go everywhere. Pick one display for mouse/keyboard.';
    }
  }

  function displaysFingerprint(displays) {
    return (displays || [])
      .map((d) => `${d.id}|${d.name}|${d.host || ''}|${d.stale ? 1 : 0}|${d.lastSeen || ''}`)
      .join(';');
  }

  let lastDisplaysFingerprint = '';

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

    const previousCount = knownDisplays.length;
    knownDisplays = next;
    lastDisplaysFingerprint = fingerprint;

    const previous = select.value || localStorage.getItem(STORAGE_TARGET_KEY) || '';
    select.innerHTML = '';

    for (const d of knownDisplays) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.stale ? `${d.name} (offline?)` : d.name;
      select.appendChild(opt);
    }
    const allOpt = document.createElement('option');
    allOpt.value = ALL_DISPLAYS;
    allOpt.textContent = 'All Displays';
    select.appendChild(allOpt);

    const ids = new Set(knownDisplays.map((d) => d.id));
    if (previous && previous !== ALL_DISPLAYS && ids.has(previous)) {
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
      const newest = knownDisplays.find((d) => !d.stale) || knownDisplays[0];
      if (newest) {
        toast(`Display online: ${newest.name}`, 'good');
      }
    }
  }

  async function refreshDisplays({ discover = false, quiet = false } = {}) {
    try {
      if (discover) {
        await apiPost('/api/displays/discover');
        await new Promise((r) => setTimeout(r, 900));
      }
      const data = await apiGet('/api/displays');
      renderDisplaySelect(data.displays || [], { quiet });
    } catch (error) {
      if (discover) {
        toast(error.message || 'Discover failed', 'bad');
      }
    }
  }

  let displayEvents = null;

  function startDisplayEvents() {
    if (displayEvents) {
      return;
    }
    try {
      displayEvents = new EventSource('/api/displays/events');
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
      await refreshDisplays({ discover: true });
      toast('Asked displays to announce themselves', 'good');
    } finally {
      setTimeout(() => { btn.disabled = false; }, 800);
    }
  });

  // ------------------------------------------------------------------ Toast

  function toast(message, kind = '') {
    const wrap = $('toast-wrap');
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

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `tab-${btn.dataset.tab}`);
      });
      // Keep Control (and other tabs) starting at the top — otherwise a prior
      // Push/Settings scroll can hide the touchpad under the sticky header.
      window.scrollTo(0, 0);
      document.scrollingElement?.scrollTo?.(0, 0);
    });
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

  // -------------------------------------------------- Remote confirm logic

  const CONFIRM_WINDOW_MS = 5000;

  document.querySelectorAll('.confirm-btn').forEach((button) => {
    let revertTimer = null;

    button.addEventListener('click', async () => {
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

  // -------------------------------------------------- Touchpad + keyboard

  const stickyMods = new Set();
  let pendingDx = 0;
  let pendingDy = 0;
  let pointerFlush = null;

  function flushPointer() {
    pointerFlush = null;
    if (!isSingleDisplaySelected()) {
      pendingDx = 0;
      pendingDy = 0;
      return;
    }
    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;
    if (!dx && !dy) {
      return;
    }
    apiPost('/api/input/pointer', withTarget({ dx, dy })).catch(() => {});
  }

  function queuePointer(dx, dy) {
    pendingDx += dx;
    pendingDy += dy;
    if (!pointerFlush) {
      pointerFlush = requestAnimationFrame(flushPointer);
    }
  }

  async function sendPointerButtons(buttons) {
    if (!isSingleDisplaySelected()) {
      toast('Select a single display for mouse control', 'bad');
      return;
    }
    try {
      await apiPost('/api/input/pointer', withTarget({ dx: 0, dy: 0, buttons }));
    } catch (error) {
      toast(error.message, 'bad');
    }
  }

  async function sendKey(key, extraMods = []) {
    if (!isSingleDisplaySelected()) {
      toast('Select a single display for keyboard control', 'bad');
      return;
    }
    const modifiers = [...new Set([...stickyMods, ...extraMods])];
    try {
      await apiPost('/api/input/key', withTarget({ key, modifiers, action: 'press' }));
    } catch (error) {
      toast(error.message, 'bad');
    }
  }

  (function initTouchpad() {
    const pad = $('touchpad');
    if (!pad) {
      return;
    }
    let tracking = false;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    let downAt = 0;
    let longTimer = null;

    const SENSITIVITY = 2.1;

    pad.addEventListener('pointerdown', (e) => {
      if (!isSingleDisplaySelected()) {
        toast('Select a single display for mouse control', 'bad');
        return;
      }
      tracking = true;
      moved = false;
      downAt = Date.now();
      lastX = e.clientX;
      lastY = e.clientY;
      try {
        pad.setPointerCapture(e.pointerId);
      } catch {
        // older WebKit
      }
      pad.classList.add('active');
      longTimer = setTimeout(() => {
        if (tracking && !moved) {
          sendPointerButtons({ right: 'click' });
          tracking = false;
          pad.classList.remove('active');
        }
      }, 550);
      e.preventDefault();
    });

    pad.addEventListener('pointermove', (e) => {
      if (!tracking) {
        return;
      }
      const dx = (e.clientX - lastX) * SENSITIVITY;
      const dy = (e.clientY - lastY) * SENSITIVITY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (Math.abs(dx) > 0.35 || Math.abs(dy) > 0.35) {
        moved = true;
        if (longTimer) {
          clearTimeout(longTimer);
          longTimer = null;
        }
        queuePointer(dx, dy);
      }
      e.preventDefault();
    });

    function endPointer(e) {
      if (!tracking) {
        return;
      }
      tracking = false;
      pad.classList.remove('active');
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
      if (!moved && Date.now() - downAt < 500) {
        sendPointerButtons({ left: 'click' });
      }
      flushPointer();
      e.preventDefault();
    }

    pad.addEventListener('pointerup', endPointer);
    pad.addEventListener('pointercancel', endPointer);
    // Stop iOS Safari from scrolling the page while dragging the pad.
    pad.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  })();

  $('btn-mouse-left')?.addEventListener('click', () => sendPointerButtons({ left: 'click' }));
  $('btn-mouse-right')?.addEventListener('click', () => sendPointerButtons({ right: 'click' }));

  document.querySelectorAll('.nudge').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = String(btn.dataset.nudge || '0,0').split(',');
      const dx = Number(raw[0]) || 0;
      const dy = Number(raw[1]) || 0;
      if (!isSingleDisplaySelected()) {
        toast('Select a single display for mouse control', 'bad');
        return;
      }
      queuePointer(dx, dy);
      flushPointer();
    });
  });

  document.querySelectorAll('#mod-row .mod').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mod = btn.dataset.mod;
      if (stickyMods.has(mod)) {
        stickyMods.delete(mod);
        btn.classList.remove('active');
      } else {
        stickyMods.add(mod);
        btn.classList.add('active');
      }
    });
  });

  (function buildKeyboard() {
    const root = $('keyboard');
    if (!root) {
      return;
    }

    // Each row declares a column count so CSS grid keeps keys aligned on phones
    // (flex-wrap was wrapping mid-row and looking broken on iPhone).
    const rows = [
      {
        cols: 7,
        keys: [
          { key: 'Escape', label: 'Esc', span: 1 },
          { key: 'F1', label: 'F1' }, { key: 'F2', label: 'F2' }, { key: 'F3', label: 'F3' },
          { key: 'F4', label: 'F4' }, { key: 'F5', label: 'F5' }, { key: 'F6', label: 'F6' },
        ],
      },
      {
        cols: 6,
        keys: [
          { key: 'F7', label: 'F7' }, { key: 'F8', label: 'F8' }, { key: 'F9', label: 'F9' },
          { key: 'F10', label: 'F10' }, { key: 'F11', label: 'F11' }, { key: 'F12', label: 'F12' },
        ],
      },
      {
        cols: 12,
        keys: [
          { key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' },
          { key: '4', label: '4' }, { key: '5', label: '5' }, { key: '6', label: '6' },
          { key: '7', label: '7' }, { key: '8', label: '8' }, { key: '9', label: '9' },
          { key: '0', label: '0' }, { key: '-', label: '-' },
          { key: 'Backspace', label: '⌫', span: 1 },
        ],
      },
      {
        cols: 11,
        keys: [
          { key: 'q', label: 'Q' }, { key: 'w', label: 'W' }, { key: 'e', label: 'E' },
          { key: 'r', label: 'R' }, { key: 't', label: 'T' }, { key: 'y', label: 'Y' },
          { key: 'u', label: 'U' }, { key: 'i', label: 'I' }, { key: 'o', label: 'O' },
          { key: 'p', label: 'P' }, { key: 'Tab', label: 'Tab', span: 1 },
        ],
      },
      {
        cols: 11,
        keys: [
          { key: 'a', label: 'A' }, { key: 's', label: 'S' }, { key: 'd', label: 'D' },
          { key: 'f', label: 'F' }, { key: 'g', label: 'G' }, { key: 'h', label: 'H' },
          { key: 'j', label: 'J' }, { key: 'k', label: 'K' }, { key: 'l', label: 'L' },
          { key: "'", label: "'" },
          { key: 'Enter', label: '⏎', span: 1 },
        ],
      },
      {
        cols: 11,
        keys: [
          { key: 'z', label: 'Z' }, { key: 'x', label: 'X' }, { key: 'c', label: 'C' },
          { key: 'v', label: 'V' }, { key: 'b', label: 'B' }, { key: 'n', label: 'N' },
          { key: 'm', label: 'M' }, { key: ',', label: ',' }, { key: '.', label: '.' },
          { key: '/', label: '/' }, { key: 'Delete', label: 'Del', span: 1 },
        ],
      },
      {
        cols: 10,
        keys: [
          { key: 'ArrowLeft', label: '←' }, { key: 'ArrowUp', label: '↑' },
          { key: 'ArrowDown', label: '↓' }, { key: 'ArrowRight', label: '→' },
          { key: ' ', label: 'Space', span: 4 },
          { chord: ['alt', 'F4'], label: 'Alt+F4', span: 1 },
          { chord: ['ctrl', 'w'], label: 'Ctrl+W', span: 1 },
        ],
      },
    ];

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = `key-row cols-${row.cols}`;
      for (const def of row.keys) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'key';
        const span = Number(def.span) || 1;
        if (span === 2) {
          btn.classList.add('span-2');
        } else if (span === 3) {
          btn.classList.add('span-3');
        } else if (span === 4) {
          btn.classList.add('space');
        }
        btn.textContent = def.label;
        btn.addEventListener('click', () => {
          if (def.chord) {
            const [mod, key] = def.chord;
            sendKey(key, [mod]);
          } else {
            sendKey(def.key);
          }
        });
        rowEl.appendChild(btn);
      }
      root.appendChild(rowEl);
    }
  })();

  // -------------------------------------------------------------- Start up

  refreshDisplays({ quiet: true });
  startDisplayEvents();
  startPolling();
  // Fallback poll if EventSource is blocked or drops (SSE is primary).
  setInterval(() => refreshDisplays({ quiet: true }), 60000);
})();
