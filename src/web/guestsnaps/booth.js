/* Guest photo booth — PIN-gated / */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALL_DISPLAYS = '*';
  const STORAGE_TARGET_KEY = 'signalBooth.targetId';
  const PIN_DIGITS = 6;
  const MAX_QUEUE = 20;

  let photoQueue = [];
  let nextPhotoId = 1;
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
    $('booth-subtitle').textContent = 'Share photos with us';
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
      $('display-hint').textContent = 'No displays announced yet — your photos will broadcast to the LAN.';
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

  function encodePhotoFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No file'));
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
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Could not read that photo'));
      };
      img.src = objectUrl;
    });
  }

  function renderPhotoQueue() {
    const queueEl = $('photo-queue');
    const grid = $('photo-queue-grid');
    const countEl = $('photo-queue-count');
    const pick = $('btn-pick-photo');
    const pickLabel = $('btn-pick-photo-label');
    const send = $('btn-send');
    if (!queueEl || !grid || !send) return;

    const count = photoQueue.length;
    queueEl.hidden = count === 0;
    send.disabled = count === 0;
    pick?.classList.toggle('is-compact', count > 0);
    if (pickLabel) {
      pickLabel.textContent = count > 0 ? 'Add more photos' : 'Take or choose photos';
    }
    if (countEl) {
      countEl.textContent = count === 1 ? '1 photo' : `${count} photos`;
    }
    if (count === 0) {
      send.textContent = 'Send to display';
    } else if (count === 1) {
      send.textContent = 'Send photo';
    } else {
      send.textContent = `Send ${count} photos`;
    }

    grid.replaceChildren();
    photoQueue.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = 'booth-queue-item';
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = 'Queued photo';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'booth-queue-remove';
      remove.setAttribute('aria-label', 'Remove photo');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        photoQueue = photoQueue.filter((entry) => entry.id !== item.id);
        renderPhotoQueue();
      });
      cell.append(img, remove);
      grid.appendChild(cell);
    });
  }

  function resetPhotoPicker() {
    photoQueue = [];
    $('photo-file').value = '';
    renderPhotoQueue();
  }

  async function addPhotoFiles(fileList) {
    const files = [...(fileList || [])].filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) {
      return;
    }
    const room = MAX_QUEUE - photoQueue.length;
    if (room <= 0) {
      setBoothStatus(`You can queue up to ${MAX_QUEUE} photos`, 'bad');
      return;
    }
    const slice = files.slice(0, room);
    setBoothStatus(slice.length > 1 ? `Adding ${slice.length} photos…` : 'Adding photo…');
    let added = 0;
    for (const file of slice) {
      try {
        const dataUrl = await encodePhotoFile(file);
        photoQueue.push({ id: nextPhotoId, dataUrl });
        nextPhotoId += 1;
        added += 1;
        renderPhotoQueue();
      } catch {
        // skip unreadable files
      }
    }
    if (!added) {
      setBoothStatus('Could not read those photos', 'bad');
      return;
    }
    if (files.length > room) {
      setBoothStatus(`Added ${added}. Queue is full at ${MAX_QUEUE} photos.`, 'bad');
      return;
    }
    setBoothStatus(added === 1
      ? 'Photo added — take or choose more, or send.'
      : `${added} photos queued. Send them as a slideshow, or add more.`);
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
    addPhotoFiles($('photo-file').files);
  });

  $('btn-photo-clear')?.addEventListener('click', () => {
    resetPhotoPicker();
    setBoothStatus('');
  });

  $('btn-send')?.addEventListener('click', async () => {
    if (!photoQueue.length) {
      setBoothStatus('Choose a photo first', 'bad');
      return;
    }
    const button = $('btn-send');
    button.disabled = true;
    const queued = photoQueue.slice();
    setBoothStatus(queued.length > 1 ? `Sending ${queued.length} photos…` : 'Sending…');
    try {
      const photos = [];
      for (let i = 0; i < queued.length; i += 1) {
        setBoothStatus(queued.length > 1
          ? `Uploading ${i + 1} of ${queued.length}…`
          : 'Sending…');
        const upload = await apiPost('/api/qr/image-upload', {
          imageDataUrl: queued[i].dataUrl,
        });
        photos.push({
          url: new URL(upload.path, location.origin).href,
          uploadedAt: upload.createdAt || null,
        });
      }
      await apiPost('/api/qr/push', {
        mode: 'photo',
        photos,
        label: 'Scan to save this photo',
        targetId: selectedTargetId(),
      });
      setBoothStatus(photos.length > 1
        ? `${photos.length} photos sent as a slideshow — thanks!`
        : 'Photo sent — thanks!', 'good');
      resetPhotoPicker();
    } catch (error) {
      if (error.status === 401) {
        setBoothStatus('Session expired — enter the PIN again', 'bad');
        showLogin();
        return;
      }
      setBoothStatus(error.message || 'Could not send the photos', 'bad');
      button.disabled = !photoQueue.length;
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
