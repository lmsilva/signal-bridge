/* Guest photo booth — PIN-gated / */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALL_DISPLAYS = '*';
  const STORAGE_TARGET_KEY = 'signalBooth.targetId';
  const PIN_DIGITS = 6;

  let selectedPhotoDataUrl = null;
  let displayEvents = null;
  let authenticated = false;
  let pinDigits = PIN_DIGITS;

  function setStatus(elId, message, kind) {
    const el = $(elId);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('is-good', kind === 'good');
    el.classList.toggle('is-bad', kind === 'bad');
  }

  function setBoothStatus(message, kind) {
    setStatus('booth-status', message, kind);
  }

  function setLoginStatus(message, kind) {
    setStatus('login-status', message, kind);
    const input = $('guest-pin-input');
    input?.classList.toggle('is-invalid', kind === 'bad');
  }

  async function apiPost(route, body = {}) {
    const response = await fetch(route, {
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
    if (!response.ok) {
      const err = new Error(data?.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.code = data?.code;
      err.retryAfterSec = data?.retryAfterSec;
      throw err;
    }
    return data || {};
  }

  async function apiGet(route) {
    const response = await fetch(route, { cache: 'no-store', credentials: 'same-origin' });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const err = new Error(data?.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.code = data?.code;
      throw err;
    }
    return data || {};
  }

  function showLogin() {
    authenticated = false;
    $('booth-login').hidden = false;
    $('booth-app').hidden = true;
    $('booth-subtitle').textContent = 'Enter the PIN from the display';
    $('guest-pin-input').value = '';
    setLoginStatus('');
    setTimeout(() => $('guest-pin-input')?.focus(), 50);
  }

  function showApp() {
    authenticated = true;
    $('booth-login').hidden = true;
    $('booth-app').hidden = false;
    $('booth-subtitle').textContent = 'Share a photo with us';
    setBoothStatus('');
    refreshDisplays();
    startDisplayEvents();
  }

  async function refreshSession() {
    try {
      const session = await apiGet('/api/guest/session');
      pinDigits = Number(session.pinDigits) || PIN_DIGITS;
      $('guest-pin-input').maxLength = pinDigits;
      $('login-hint').textContent = `Enter the ${pinDigits}-digit PIN shown on the display.`;
      if (session.authenticated) {
        showApp();
        return true;
      }
    } catch {
      // fall through to login
    }
    showLogin();
    return false;
  }

  function selectedTargetId() {
    return $('display-select')?.value || ALL_DISPLAYS;
  }

  function persistTarget(id) {
    try {
      localStorage.setItem(STORAGE_TARGET_KEY, id);
    } catch {
      // private mode
    }
  }

  function rememberedTarget() {
    try {
      return localStorage.getItem(STORAGE_TARGET_KEY) || '';
    } catch {
      return '';
    }
  }

  function renderDisplays(displays) {
    const select = $('display-select');
    if (!select) return;
    const previous = select.value || rememberedTarget();
    const list = Array.isArray(displays) ? displays : [];
    select.innerHTML = '';

    if (!list.length) {
      const opt = document.createElement('option');
      opt.value = ALL_DISPLAYS;
      opt.textContent = 'All displays (none online yet)';
      select.appendChild(opt);
      $('display-hint').textContent = 'No displays announced yet — your photo will broadcast to the LAN.';
      return;
    }

    for (const display of list) {
      const opt = document.createElement('option');
      opt.value = display.id;
      const label = display.label || display.name || display.id;
      opt.textContent = display.stale ? `${label} (offline?)` : label;
      select.appendChild(opt);
    }

    const all = document.createElement('option');
    all.value = ALL_DISPLAYS;
    all.textContent = 'All displays';
    select.appendChild(all);

    if (previous && [...select.options].some((o) => o.value === previous)) {
      select.value = previous;
    } else if (list.length === 1) {
      select.value = list[0].id;
    } else {
      select.value = ALL_DISPLAYS;
    }

    $('display-hint').textContent = select.value === ALL_DISPLAYS
      ? 'Sending to every Signal display on the network.'
      : 'Sending to the selected display only.';
  }

  async function refreshDisplays() {
    if (!authenticated) return;
    try {
      const result = await apiGet('/api/displays');
      renderDisplays(result.displays || result || []);
    } catch {
      renderDisplays([]);
    }
  }

  function startDisplayEvents() {
    if (displayEvents) {
      displayEvents.close();
      displayEvents = null;
    }
    if (!authenticated) return;
    try {
      displayEvents = new EventSource('/api/displays/events');
      displayEvents.addEventListener('displays', (event) => {
        try {
          const data = JSON.parse(event.data);
          renderDisplays(data.displays || []);
        } catch {
          // ignore malformed events
        }
      });
    } catch {
      // SSE unavailable — polling fallback below
    }
  }

  function resetPhotoPicker() {
    selectedPhotoDataUrl = null;
    $('photo-file').value = '';
    $('photo-preview').hidden = true;
    $('photo-preview-img').removeAttribute('src');
    $('btn-pick-photo').hidden = false;
    $('btn-send').disabled = true;
  }

  function loadPhotoFile(file) {
    if (!file) {
      return;
    }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const maxSide = 1600;
      const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * ratio));
      const height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      selectedPhotoDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      $('photo-preview-img').src = selectedPhotoDataUrl;
      $('photo-preview').hidden = false;
      $('btn-pick-photo').hidden = true;
      $('btn-send').disabled = false;
      setBoothStatus('');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setBoothStatus('Could not read that photo', 'bad');
    };
    img.src = objectUrl;
  }

  async function unlockWithPin() {
    const pin = String($('guest-pin-input')?.value || '').replace(/\D/g, '');
    if (!pin) {
      setLoginStatus('Enter the PIN shown on the display', 'bad');
      return;
    }
    $('btn-guest-unlock').disabled = true;
    setLoginStatus('Checking…');
    try {
      await apiPost('/api/guest/login', { pin });
      setLoginStatus('Unlocked', 'good');
      showApp();
    } catch (error) {
      if (error.status === 429 && error.retryAfterSec) {
        setLoginStatus(error.message || `Try again in ${error.retryAfterSec}s`, 'bad');
      } else {
        setLoginStatus(error.message || 'Incorrect PIN', 'bad');
      }
      $('guest-pin-input').value = '';
      $('guest-pin-input').focus();
    } finally {
      $('btn-guest-unlock').disabled = false;
    }
  }

  async function requestPinOnDisplay() {
    const btn = $('btn-request-pin');
    btn.disabled = true;
    setLoginStatus('Asking the display to show the PIN…');
    try {
      await apiPost('/api/guest/request-pin', {});
      setLoginStatus('Look at the display for the PIN', 'good');
    } catch (error) {
      setLoginStatus(error.message || 'Could not request PIN', 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  $('display-select')?.addEventListener('change', () => {
    persistTarget(selectedTargetId());
    $('display-hint').textContent = selectedTargetId() === ALL_DISPLAYS
      ? 'Sending to every Signal display on the network.'
      : 'Sending to the selected display only.';
  });

  $('btn-pick-photo')?.addEventListener('click', () => {
    $('photo-file').value = '';
    $('photo-file').click();
  });

  $('photo-file')?.addEventListener('change', () => {
    const file = $('photo-file').files && $('photo-file').files[0];
    loadPhotoFile(file);
  });

  $('btn-photo-clear')?.addEventListener('click', () => {
    resetPhotoPicker();
    setBoothStatus('');
  });

  $('btn-send')?.addEventListener('click', async () => {
    if (!selectedPhotoDataUrl) {
      setBoothStatus('Choose a photo first', 'bad');
      return;
    }
    const button = $('btn-send');
    button.disabled = true;
    setBoothStatus('Sending…');
    try {
      const upload = await apiPost('/api/qr/image-upload', {
        imageDataUrl: selectedPhotoDataUrl,
      });
      const absoluteUrl = new URL(upload.path, location.origin).href;
      await apiPost('/api/qr/push', {
        mode: 'photo',
        url: absoluteUrl,
        label: 'Scan to save this photo',
        targetId: selectedTargetId(),
      });
      setBoothStatus('Photo sent — thanks!', 'good');
      resetPhotoPicker();
    } catch (error) {
      if (error.status === 401) {
        setBoothStatus('Session expired — enter the PIN again', 'bad');
        showLogin();
        return;
      }
      setBoothStatus(error.message || 'Could not send the photo', 'bad');
      button.disabled = !selectedPhotoDataUrl;
    }
  });

  $('btn-guest-unlock')?.addEventListener('click', () => {
    unlockWithPin();
  });

  $('btn-request-pin')?.addEventListener('click', () => {
    requestPinOnDisplay();
  });

  $('btn-guest-lock')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/guest/logout', {});
    } catch {
      // still lock the UI
    }
    resetPhotoPicker();
    if (displayEvents) {
      displayEvents.close();
      displayEvents = null;
    }
    showLogin();
  });

  $('guest-pin-input')?.addEventListener('input', (e) => {
    const el = e.target;
    el.value = String(el.value || '').replace(/\D/g, '').slice(0, pinDigits);
    setLoginStatus('');
  });

  $('guest-pin-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      unlockWithPin();
    }
  });

  refreshSession().then((ok) => {
    if (ok) {
      setInterval(refreshDisplays, 60000);
    } else {
      setInterval(() => {
        if (authenticated) refreshDisplays();
      }, 60000);
    }
  });
})();
