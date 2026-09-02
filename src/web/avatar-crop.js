(() => {
  'use strict';

  const VIEW = 280;
  const OUTPUT = 512;
  const RADIUS_RATIO = 14 / 44;
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

  let ready = false;
  let sheet;
  let viewport;
  let image;
  let zoomInput;
  let preview;
  let frame;
  let resolver = null;

  let bitmap = null;
  let naturalW = 0;
  let naturalH = 0;
  let minScale = 1;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let pinchStart = null;

  function ensureUi() {
    if (ready) return;
    ready = true;

    const style = document.createElement('style');
    style.textContent = `
      #avatar-crop-sheet.su-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(4, 8, 18, 0.65);
        -webkit-backdrop-filter: blur(3px);
        backdrop-filter: blur(3px);
        display: flex;
        align-items: flex-end;
        justify-content: center;
        z-index: 120;
        padding: 0;
      }
      #avatar-crop-sheet .su-dialog {
        width: 100%;
        max-width: 560px;
        max-height: 90dvh;
        overflow: auto;
        background: #101a33;
        border: 1px solid #24304f;
        border-bottom: none;
        border-radius: 20px 20px 0 0;
        padding: 16px 16px calc(24px + env(safe-area-inset-bottom, 0px));
        color: #e8eefc;
      }
      #avatar-crop-sheet .su-sheet-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      #avatar-crop-sheet .su-sheet-head h2 { margin: 0; font-size: 1.1rem; }
      #avatar-crop-sheet .su-label {
        display: block;
        margin: 12px 0 6px;
        color: #9fb0d0;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      #avatar-crop-sheet .su-input {
        width: 100%;
        border: 1px solid #24304f;
        border-radius: 12px;
        background: #0b1224;
        color: #e8eefc;
        padding: 10px 12px;
        font: inherit;
      }
      #avatar-crop-sheet .su-btn {
        border: 0;
        border-radius: 12px;
        background: #38bdf8;
        color: #082f49;
        font: inherit;
        font-weight: 800;
        padding: 12px 16px;
        cursor: pointer;
      }
      #avatar-crop-sheet .su-text {
        border: 0;
        background: none;
        color: #38bdf8;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      #avatar-crop-sheet .hint { color: #9fb0d0; font-size: 0.85rem; line-height: 1.35; }
      .avatar-crop-dialog { max-width: 420px; }
      .avatar-crop-stage {
        position: relative;
        width: min(100%, ${VIEW}px);
        margin: 0 auto 14px;
        aspect-ratio: 1;
      }
      .avatar-crop-viewport {
        position: absolute;
        inset: 0;
        border-radius: ${(RADIUS_RATIO * 100).toFixed(2)}%;
        overflow: hidden;
        background: #0b1224;
        touch-action: none;
        cursor: grab;
      }
      .avatar-crop-viewport.is-dragging { cursor: grabbing; }
      .avatar-crop-viewport img {
        position: absolute;
        top: 0;
        left: 0;
        max-width: none;
        user-select: none;
        -webkit-user-drag: none;
        pointer-events: none;
      }
      .avatar-crop-frame {
        position: absolute;
        inset: 0;
        border-radius: ${(RADIUS_RATIO * 100).toFixed(2)}%;
        box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.55);
        border: 2px solid rgba(56, 189, 248, 0.85);
        pointer-events: none;
      }
      .avatar-crop-preview-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }
      .avatar-crop-preview {
        width: 56px;
        height: 56px;
        border-radius: 18px;
        object-fit: cover;
        flex-shrink: 0;
        background: #0b1224;
      }
      .avatar-crop-preview-row .hint { margin: 0; flex: 1; }
      .avatar-crop-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 14px;
      }
    `;
    document.head.appendChild(style);

    sheet = document.createElement('div');
    sheet.className = 'su-backdrop';
    sheet.id = 'avatar-crop-sheet';
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="su-dialog avatar-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
        <div class="su-sheet-head">
          <h2 id="avatar-crop-title">Adjust picture</h2>
          <button type="button" class="su-text" id="btn-avatar-crop-cancel-top">Cancel</button>
        </div>
        <div class="avatar-crop-stage">
          <div class="avatar-crop-viewport" id="avatar-crop-viewport">
            <img id="avatar-crop-image" alt="">
          </div>
          <div class="avatar-crop-frame" aria-hidden="true"></div>
        </div>
        <div class="avatar-crop-preview-row">
          <img class="avatar-crop-preview" id="avatar-crop-preview" alt="">
          <p class="hint">Drag to reposition. Use the slider or pinch to zoom.</p>
        </div>
        <label class="su-label" for="avatar-crop-zoom">Zoom</label>
        <input id="avatar-crop-zoom" class="su-input" type="range" min="1" max="3" step="0.01" value="1">
        <div class="avatar-crop-actions">
          <button type="button" class="su-text" id="btn-avatar-crop-cancel">Cancel</button>
          <button type="button" class="su-btn" id="btn-avatar-crop-save">Use picture</button>
        </div>
      </div>
    `;
    document.body.appendChild(sheet);

    viewport = sheet.querySelector('#avatar-crop-viewport');
    image = sheet.querySelector('#avatar-crop-image');
    zoomInput = sheet.querySelector('#avatar-crop-zoom');
    preview = sheet.querySelector('#avatar-crop-preview');
    frame = sheet.querySelector('.avatar-crop-frame');

    sheet.querySelector('#btn-avatar-crop-cancel')?.addEventListener('click', () => close(null));
    sheet.querySelector('#btn-avatar-crop-cancel-top')?.addEventListener('click', () => close(null));
    sheet.querySelector('#btn-avatar-crop-save')?.addEventListener('click', () => {
      const dataUrl = exportCrop();
      close(dataUrl);
    });
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) close(null);
    });
    zoomInput?.addEventListener('input', () => {
      setScale(minScale * Number(zoomInput.value || 1), true);
    });

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });
  }

  function close(result) {
    if (!sheet) return;
    sheet.hidden = true;
    viewport?.classList.remove('is-dragging');
    dragging = false;
    pinchStart = null;
    if (bitmap) {
      bitmap.close?.();
      bitmap = null;
    }
    if (image) image.removeAttribute('src');
    const resolve = resolver;
    resolver = null;
    if (resolve) resolve(result);
  }

  function clampOffsets() {
    const width = naturalW * scale;
    const height = naturalH * scale;
    const maxX = 0;
    const minX = VIEW - width;
    const maxY = 0;
    const minY = VIEW - height;
    offsetX = Math.min(maxX, Math.max(minX, offsetX));
    offsetY = Math.min(maxY, Math.max(minY, offsetY));
  }

  function applyTransform() {
    if (!image) return;
    image.style.width = `${naturalW * scale}px`;
    image.style.height = `${naturalH * scale}px`;
    image.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    updatePreview();
  }

  function setScale(nextScale, keepCenter = false) {
    const prevScale = scale;
    const centerX = VIEW / 2;
    const centerY = VIEW / 2;
    const imageX = (centerX - offsetX) / prevScale;
    const imageY = (centerY - offsetY) / prevScale;
    scale = Math.max(minScale, Math.min(minScale * 3, nextScale));
    if (keepCenter) {
      offsetX = centerX - imageX * scale;
      offsetY = centerY - imageY * scale;
    }
    clampOffsets();
    if (zoomInput) {
      zoomInput.value = String(Math.max(1, Math.min(3, scale / minScale)));
    }
    applyTransform();
  }

  function updatePreview() {
    if (!preview || !bitmap) return;
    const dataUrl = exportCrop();
    if (dataUrl) preview.src = dataUrl;
  }

  function exportCrop() {
    if (!bitmap) return null;
    const sx = Math.max(0, -offsetX / scale);
    const sy = Math.max(0, -offsetY / scale);
    const sw = VIEW / scale;
    const sh = VIEW / scale;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, OUTPUT, OUTPUT);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  function onPointerDown(event) {
    if (!bitmap) return;
    viewport.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch' && pinchStart) return;
    dragging = true;
    viewport.classList.add('is-dragging');
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragOriginX = offsetX;
    dragOriginY = offsetY;
  }

  function onPointerMove(event) {
    if (!bitmap) return;
    if (dragging) {
      offsetX = dragOriginX + (event.clientX - dragStartX);
      offsetY = dragOriginY + (event.clientY - dragStartY);
      clampOffsets();
      applyTransform();
    }
  }

  function onPointerUp(event) {
    if (!viewport) return;
    try { viewport.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    dragging = false;
    viewport.classList.remove('is-dragging');
  }

  function onWheel(event) {
    if (!bitmap) return;
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.94 : 1.06;
    setScale(scale * delta, true);
  }

  async function loadBitmap(file) {
    if (file.size > MAX_SOURCE_BYTES) {
      throw new Error('Choose a picture under 12 MB');
    }
    if (window.createImageBitmap) {
      const bitmapSource = await createImageBitmap(file);
      naturalW = bitmapSource.width;
      naturalH = bitmapSource.height;
      bitmap = bitmapSource;
      image.src = URL.createObjectURL(file);
      image.onload = () => URL.revokeObjectURL(image.src);
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that picture'));
      reader.readAsDataURL(file);
    });
    await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => {
        naturalW = probe.naturalWidth;
        naturalH = probe.naturalHeight;
        bitmap = probe;
        image.src = dataUrl;
        resolve();
      };
      probe.onerror = () => reject(new Error('That file is not a supported image'));
      probe.src = dataUrl;
    });
  }

  function resetCrop() {
    minScale = Math.max(VIEW / naturalW, VIEW / naturalH);
    scale = minScale;
    offsetX = (VIEW - naturalW * scale) / 2;
    offsetY = (VIEW - naturalH * scale) / 2;
    clampOffsets();
    if (zoomInput) zoomInput.value = '1';
    applyTransform();
  }

  async function open(file) {
    ensureUi();
    if (!(file instanceof Blob)) return null;
    const type = String(file.type || '').toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(type)) {
      throw new Error('Upload a PNG, JPEG, or WebP image');
    }
    await loadBitmap(file);
    resetCrop();
    return new Promise((resolve) => {
      resolver = resolve;
      sheet.hidden = false;
    });
  }

  window.avatarCropEditor = { open, exportSize: OUTPUT };
})();
