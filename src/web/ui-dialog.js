/**
 * In-app confirm / prompt dialogs.
 *
 * Never use window.confirm / window.prompt / window.alert for product UI â€”
 * they look foreign on the Signal chrome and block the main thread. Call
 * SignalUiDialog.confirm / .prompt instead; both return Promises.
 */
(() => {
  const STYLE_ID = 'signal-ui-dialog-style';
  const ROOT_ID = 'signal-ui-dialog';

  const CSS = `
#${ROOT_ID}.uid-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  background: rgba(4, 8, 18, 0.72);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  overscroll-behavior: contain;
}
#${ROOT_ID}[hidden] { display: none !important; }
#${ROOT_ID} .uid-card {
  width: min(400px, 100%);
  background: var(--bg-elev, #152038);
  border: 1px solid var(--line, #2a3a5c);
  border-radius: 20px;
  padding: 22px 22px 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  text-align: center;
  animation: uid-pop 180ms ease-out;
}
@keyframes uid-pop {
  from { transform: translateY(10px) scale(0.98); opacity: 0; }
  to { transform: none; opacity: 1; }
}
#${ROOT_ID} .uid-title {
  margin: 0 0 8px;
  font-size: 1.15rem;
  font-weight: 800;
  color: var(--text, #e8eefc);
  letter-spacing: -0.01em;
}
#${ROOT_ID} .uid-body {
  margin: 0 4px 20px;
  font-size: 0.94rem;
  line-height: 1.5;
  color: var(--muted, var(--text-dim, #8fa3c4));
  white-space: pre-wrap;
}
#${ROOT_ID} .uid-body:empty { display: none; }
#${ROOT_ID} .uid-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  margin: 0 0 18px;
}
#${ROOT_ID} .uid-field[hidden] { display: none !important; }
#${ROOT_ID} .uid-field-label {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted, var(--text-dim, #8fa3c4));
}
#${ROOT_ID} .uid-input {
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line, #2a3a5c);
  border-radius: 12px;
  background: var(--bg, #0d1528);
  color: var(--text, #e8eefc);
  font: inherit;
  font-size: 1.05rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
  padding: 12px 14px;
}
#${ROOT_ID} .uid-input:focus {
  outline: 2px solid var(--accent, #5ec8f0);
  outline-offset: 1px;
}
#${ROOT_ID} .uid-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
#${ROOT_ID} .uid-btn {
  appearance: none;
  border: 1px solid var(--line, #2a3a5c);
  border-radius: 12px;
  font: inherit;
  font-weight: 700;
  font-size: 0.95rem;
  min-height: 46px;
  padding: 0 14px;
  cursor: pointer;
  background: transparent;
  color: var(--text, #e8eefc);
}
#${ROOT_ID} .uid-btn-cancel:hover {
  background: rgba(255, 255, 255, 0.04);
}
#${ROOT_ID} .uid-btn-ok {
  border-color: transparent;
  background: var(--accent, #5ec8f0);
  color: var(--accent-ink, #082f49);
}
#${ROOT_ID} .uid-btn-ok.is-danger {
  background: var(--danger, #ff6b6b);
  color: var(--danger-ink, #fff);
}
#${ROOT_ID} .uid-btn:focus-visible {
  outline: 2px solid #7dd3fc;
  outline-offset: 2px;
}
`;

  let active = null;

  function ensureDom() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'uid-backdrop';
    root.hidden = true;
    root.setAttribute('role', 'presentation');
    root.innerHTML =
      '<div class="uid-card" role="dialog" aria-modal="true" aria-labelledby="uid-title" aria-describedby="uid-body">' +
      '<h2 class="uid-title" id="uid-title"></h2>' +
      '<p class="uid-body" id="uid-body"></p>' +
      '<div class="uid-field" id="uid-field" hidden>' +
      '<label class="uid-field-label" id="uid-field-label" for="uid-input"></label>' +
      '<input class="uid-input" id="uid-input" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="uid-actions">' +
      '<button type="button" class="uid-btn uid-btn-cancel" id="uid-cancel">Cancel</button>' +
      '<button type="button" class="uid-btn uid-btn-ok" id="uid-ok">OK</button>' +
      '</div></div>';
    document.body.appendChild(root);
    return root;
  }

  function finish(result) {
    if (!active) return;
    const resolve = active.resolve;
    const root = active.root;
    const onKey = active.onKey;
    active = null;
    document.removeEventListener('keydown', onKey, true);
    root.hidden = true;
    resolve(result);
  }

  function openDialog(options) {
    const opts = options || {};
    const root = ensureDom();
    if (active) finish(opts.mode === 'prompt' ? null : false);

    const title = root.querySelector('#uid-title');
    const body = root.querySelector('#uid-body');
    const field = root.querySelector('#uid-field');
    const fieldLabel = root.querySelector('#uid-field-label');
    const input = root.querySelector('#uid-input');
    const cancelBtn = root.querySelector('#uid-cancel');
    const okBtn = root.querySelector('#uid-ok');

    title.textContent = opts.title || (opts.mode === 'prompt' ? 'Enter a value' : 'Are you sure?');
    body.textContent = opts.body || '';
    cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    okBtn.textContent = opts.confirmLabel || (opts.mode === 'prompt' ? 'Save' : 'Confirm');
    okBtn.classList.toggle('is-danger', Boolean(opts.danger));

    const isPrompt = opts.mode === 'prompt';
    field.hidden = !isPrompt;
    if (isPrompt) {
      fieldLabel.textContent = opts.inputLabel || 'Value';
      input.value = opts.value == null ? '' : String(opts.value);
      input.type = opts.inputType || 'text';
      if (opts.min != null) input.min = String(opts.min);
      else input.removeAttribute('min');
      if (opts.max != null) input.max = String(opts.max);
      else input.removeAttribute('max');
      if (opts.step != null) input.step = String(opts.step);
      else input.removeAttribute('step');
    }

    return new Promise((resolve) => {
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(isPrompt ? null : false);
          return;
        }
        if (event.key === 'Enter' && isPrompt) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }

      function submit() {
        if (!isPrompt) {
          finish(true);
          return;
        }
        let value = input.value;
        if (typeof opts.validate === 'function') {
          const next = opts.validate(value);
          if (next === false) {
            input.focus();
            input.select();
            return;
          }
          if (next != null && next !== true) value = String(next);
        }
        finish(value);
      }

      active = { resolve: resolve, root: root, onKey: onKey };
      cancelBtn.onclick = () => finish(isPrompt ? null : false);
      okBtn.onclick = () => submit();
      root.onclick = (event) => {
        if (event.target === root) finish(isPrompt ? null : false);
      };
      document.addEventListener('keydown', onKey, true);
      root.hidden = false;
      requestAnimationFrame(() => {
        if (isPrompt) {
          input.focus();
          input.select();
        } else {
          (opts.danger ? cancelBtn : okBtn).focus();
        }
      });
    });
  }

  const api = {
    confirm(options) {
      return openDialog(Object.assign({}, options || {}, { mode: 'confirm' }));
    },
    prompt(options) {
      return openDialog(Object.assign({}, options || {}, { mode: 'prompt' }));
    },
  };

  const rootObj = typeof globalThis !== 'undefined' ? globalThis : window;
  rootObj.SignalUiDialog = api;
})();