/* Guest photo booth — public / */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ALL_DISPLAYS = '*';
  const STORAGE_TARGET_KEY = 'signalBooth.targetId';

  let selectedPhotoDataUrl = null;
  let displayEvents = null;

  function setStatus(message, kind) {
    const el = $('booth-status');
    el.textContent = message || '';
    el.classList.toggle('is-good', kind === 'good');
    el.classList.toggle('is-bad', kind === 'bad');
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
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data || {};
  }

  async function apiGet(route) {
    const response = await fetch(route, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    return response.json();
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
      opt.value = display.id; // unique id — label is name only
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
    }
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
      setStatus('');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setStatus('Could not read that photo', 'bad');
    };
    img.src = objectUrl;
  }

  $('display-select').addEventListener('change', () => {
    persistTarget(selectedTargetId());
    $('display-hint').textContent = selectedTargetId() === ALL_DISPLAYS
      ? 'Sending to every Signal display on the network.'
      : 'Sending to the selected display only.';
  });

  $('btn-pick-photo').addEventListener('click', () => {
    $('photo-file').value = '';
    $('photo-file').click();
  });

  $('photo-file').addEventListener('change', () => {
    const file = $('photo-file').files && $('photo-file').files[0];
    loadPhotoFile(file);
  });

  $('btn-photo-clear').addEventListener('click', () => {
    resetPhotoPicker();
    setStatus('');
  });

  $('btn-send').addEventListener('click', async () => {
    if (!selectedPhotoDataUrl) {
      setStatus('Choose a photo first', 'bad');
      return;
    }
    const button = $('btn-send');
    button.disabled = true;
    setStatus('Sending…');
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
      setStatus('Photo sent — thanks!', 'good');
      resetPhotoPicker();
    } catch (error) {
      setStatus(error.message || 'Could not send the photo', 'bad');
      button.disabled = !selectedPhotoDataUrl;
    }
  });

  refreshDisplays();
  startDisplayEvents();
  setInterval(refreshDisplays, 60000);
})();
