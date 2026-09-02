(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const AUDIT_PAGE_SIZE = 12;
  const ACTION_LABELS = {
    login: 'Signed in',
    logout: 'Signed out',
    'user.create': 'Created user',
    'user.update': 'Updated user',
    'user.avatar': 'Updated picture',
    'profile.update': 'Updated profile',
    'dashboard.update': 'Updated tiles',
    'password.change': 'Changed password',
    'password.reset': 'Reset password',
    'password.generate': 'Generated password',
    'password.email': 'Emailed password',
    'password.email.skip': 'Password email skipped',
    'password.reset.email': 'Emailed reset link',
    'password.reset.email.skip': 'Reset email skipped',
    'password.reset.request': 'Requested reset',
    'password.reset.consume': 'Used reset link',
    'login.fail': 'Failed sign-in',
    'gmail.link': 'Linked Gmail',
    'gmail.unlink': 'Unlinked Gmail',
  };

  let users = [];
  let templates = [];
  let selectedAvatar = { kind: 'template', id: 'cat-sky' };
  let auditRows = [];
  let auditPage = 0;

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function toast(message, target = 'hu-form-status') {
    const el = $(target);
    if (el) el.textContent = message || '';
  }

  function editingId() {
    return String($('hu-edit-id')?.value || '').trim();
  }

  function selectedUser() {
    const id = editingId();
    return users.find((row) => row.id === id) || null;
  }

  function avatarSrc(user, avatar = selectedAvatar) {
    if (user?.avatarUrl && avatar?.kind === user.avatar?.kind && avatar?.id === user.avatar?.id) {
      return user.avatarUrl;
    }
    if (avatar?.kind === 'upload' && avatar.id) return `/user-avatars/${avatar.id}`;
    return `/user/avatars/${avatar?.id || 'cat-sky'}.svg`;
  }

  function displayName(user) {
    const first = String(user?.firstName || '').trim();
    if (first) return first;
    if (user?.bootstrap) return 'Admin';
    return user?.username || 'User';
  }

  function formPayload() {
    return {
      username: $('hu-username')?.value.trim(),
      email: $('hu-email')?.value.trim(),
      firstName: $('hu-first')?.value.trim(),
      lastName: $('hu-last')?.value.trim(),
      isAdmin: $('hu-admin')?.checked === true,
      permissions: {
        flightPlan: $('hu-flight')?.checked === true,
        slideshow: $('hu-slides')?.checked === true,
        redLetter: $('hu-dates')?.checked === true,
      },
      avatar: selectedAvatar,
    };
  }

  function setLocked(locked) {
    ['hu-username', 'hu-email', 'hu-admin', 'hu-flight', 'hu-slides', 'hu-dates'].forEach((id) => {
      if ($(id)) $(id).disabled = locked;
    });
    ['btn-hu-toggle', 'btn-hu-reset', 'btn-hu-email'].forEach((id) => {
      if ($(id)) $(id).hidden = locked;
    });
  }

  function fillForm(user) {
    $('hu-edit-id').value = user?.id || '';
    $('hu-username').value = user?.username || '';
    $('hu-email').value = user?.email || '';
    $('hu-first').value = user?.firstName || (user?.bootstrap ? 'Admin' : '');
    $('hu-last').value = user?.lastName || '';
    $('hu-admin').checked = user?.isAdmin === true;
    $('hu-flight').checked = user?.permissions?.flightPlan === true;
    $('hu-slides').checked = user?.permissions?.slideshow === true;
    $('hu-dates').checked = user?.permissions?.redLetter === true;
    selectedAvatar = user?.avatar
      ? { kind: user.avatar.kind, id: user.avatar.id }
      : { kind: 'template', id: 'cat-sky' };
    setLocked(user?.bootstrap === true);
    $('hu-editor-title').textContent = user
      ? (user.bootstrap ? 'Edit environment admin' : `Edit ${displayName(user)}`)
      : 'Add user';
    $('btn-hu-save').textContent = user ? 'Save changes' : 'Create user';
    $('btn-hu-toggle').textContent = user?.active === false ? 'Activate' : 'Deactivate';
    $('btn-hu-toggle').hidden = !user || user.bootstrap === true;
    $('btn-hu-reset').hidden = !user || user.bootstrap === true;
    $('btn-hu-email').hidden = !user || user.bootstrap === true;
    const username = $('hu-username');
    if (username) {
      username.readOnly = true;
      username.dataset.touched = user ? '1' : '';
    }
    renderAvatarGrid();
    renderUsers();
    toast('');
  }

  function clearForm() {
    fillForm(null);
  }

  function openEditor(user) {
    fillForm(user || null);
    if ($('hu-editor-sheet')) $('hu-editor-sheet').hidden = false;
    if (!user) {
      window.setTimeout(wipeAutofill, 50);
      window.setTimeout(wipeAutofill, 280);
    }
  }

  function closeEditor() {
    closePasswordSheet({ keepEditor: true });
    if ($('hu-editor-sheet')) $('hu-editor-sheet').hidden = true;
    if ($('hu-edit-id')) $('hu-edit-id').value = '';
    renderUsers();
  }

  function unlockUsername() {
    const username = $('hu-username');
    if (!username || username.disabled) return;
    username.readOnly = false;
  }

  function wipeAutofill() {
    const username = $('hu-username');
    if (!username || editingId() || username.dataset.touched) return;
    if (/^(admin|username)$/i.test(username.value.trim())) username.value = '';
  }

  let passwordMode = null;

  function generateHousePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const byte of bytes) out += alphabet[byte % alphabet.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
  }

  function passwordWho() {
    return $('hu-first')?.value.trim() || $('hu-username')?.value.trim() || 'this user';
  }

  function setPasswordPane(which) {
    if ($('hu-pw-form')) $('hu-pw-form').hidden = which !== 'form';
    if ($('hu-pw-done')) $('hu-pw-done').hidden = which !== 'done';
  }

  function setPasswordVisible(inputId, buttonId, visible) {
    const input = $(inputId);
    const button = $(buttonId);
    if (input) input.type = visible ? 'text' : 'password';
    if (button) {
      button.textContent = visible ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', visible ? 'true' : 'false');
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    }
  }

  function hidePasswordFields() {
    setPasswordVisible('hu-pw', 'btn-hu-pw-reveal', false);
    setPasswordVisible('hu-pw-confirm', 'btn-hu-pw-confirm-reveal', false);
  }

  function closePasswordSheet({ keepEditor = false } = {}) {
    const created = passwordMode === 'created';
    if ($('hu-password-sheet')) $('hu-password-sheet').hidden = true;
    passwordMode = null;
    if ($('hu-pw')) $('hu-pw').value = '';
    if ($('hu-pw-confirm')) $('hu-pw-confirm').value = '';
    hidePasswordFields();
    if ($('hu-pw-done-value')) $('hu-pw-done-value').textContent = '';
    if ($('hu-pw-done-secret')) $('hu-pw-done-secret').hidden = true;
    if ($('hu-pw-status')) {
      $('hu-pw-status').textContent = '';
      $('hu-pw-status').classList.remove('is-ok');
    }
    setPasswordPane('form');
    if (created && !keepEditor) closeEditor();
  }

  function showPasswordSuccess(message, password) {
    if ($('hu-pw-title')) $('hu-pw-title').textContent = 'Password set';
    if ($('hu-pw-done-msg')) $('hu-pw-done-msg').textContent = message;
    if ($('hu-pw-done-value')) $('hu-pw-done-value').textContent = password || '';
    if ($('hu-pw-done-secret')) $('hu-pw-done-secret').hidden = !password;
    setPasswordPane('done');
  }

  function openPasswordSheet(mode, { password = '', title, lead } = {}) {
    passwordMode = mode;
    const who = passwordWho();
    setPasswordPane('form');
    if ($('hu-pw-title')) {
      $('hu-pw-title').textContent = title
        || (mode === 'create' ? 'Set password' : 'Reset password');
    }
    if ($('hu-pw-lead')) {
      $('hu-pw-lead').textContent = lead
        || `Choose a password for ${who}, or generate one.`;
    }
    if ($('hu-pw')) $('hu-pw').value = password;
    if ($('hu-pw-confirm')) $('hu-pw-confirm').value = password;
    // Reveal is the "copy this now" fallback when mail did not send — show
    // that one password. Create/reset stay hidden until Show is pressed.
    setPasswordVisible('hu-pw', 'btn-hu-pw-reveal', mode === 'reveal');
    setPasswordVisible('hu-pw-confirm', 'btn-hu-pw-confirm-reveal', false);
    if ($('hu-pw-confirm-wrap')) $('hu-pw-confirm-wrap').hidden = mode === 'reveal';
    if ($('btn-hu-pw-generate')) $('btn-hu-pw-generate').hidden = mode === 'reveal';
    if ($('btn-hu-pw-save')) {
      $('btn-hu-pw-save').hidden = mode === 'reveal';
      $('btn-hu-pw-save').textContent = mode === 'create' ? 'Create user' : 'Set password';
    }
    if ($('hu-pw-status')) {
      $('hu-pw-status').textContent = '';
      $('hu-pw-status').classList.remove('is-ok');
    }
    if ($('hu-password-sheet')) $('hu-password-sheet').hidden = false;
    $('hu-pw')?.focus();
    $('hu-pw')?.select();
  }

  function readPasswordForm() {
    const password = String($('hu-pw')?.value || '');
    const confirm = String($('hu-pw-confirm')?.value || '');
    if (password.length < 8) return { error: 'Password must be at least 8 characters' };
    if (password !== confirm) return { error: 'Passwords do not match' };
    return { password };
  }

  async function copyPassword() {
    const value = String($('hu-pw')?.value || '');
    if (!value) {
      toast('Generate or type a password first.', 'hu-pw-status');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      if ($('hu-pw-status') && !$('hu-pw-form')?.hidden) {
        $('hu-pw-status').textContent = 'Copied.';
        $('hu-pw-status').classList.add('is-ok');
      }
    } catch {
      toast('Could not copy — select the password and copy it.', 'hu-pw-status');
    }
  }

  function fillGeneratedPassword() {
    const password = generateHousePassword();
    if ($('hu-pw')) $('hu-pw').value = password;
    if ($('hu-pw-confirm')) $('hu-pw-confirm').value = password;
    $('hu-pw')?.focus();
    $('hu-pw')?.select();
    copyPassword();
  }

  function renderAvatarGrid() {
    const host = $('hu-avatar-grid');
    const preview = $('hu-avatar-preview');
    if (preview) preview.src = avatarSrc(selectedUser(), selectedAvatar);
    if (!host) return;
    host.innerHTML = '';
    templates.forEach((row) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = selectedAvatar.kind === 'template' && selectedAvatar.id === row.id ? 'active' : '';
      btn.innerHTML = `<img src="/user/avatars/${esc(row.id)}.svg" alt="${esc(row.label)}">`;
      btn.addEventListener('click', () => {
        selectedAvatar = { kind: 'template', id: row.id };
        renderAvatarGrid();
      });
      host.appendChild(btn);
    });
  }

  function renderUsers() {
    const host = $('house-user-list');
    const count = $('house-users-count');
    if (count) count.textContent = `${users.length} household user${users.length === 1 ? '' : 's'}`;
    if (!host) return;
    const currentId = editingId();
    host.innerHTML = '';
    users.forEach((user) => {
      const card = document.createElement('article');
      card.className = `house-user-card${user.id === currentId ? ' is-selected' : ''}${user.bootstrap ? ' is-env' : ''}${user.active === false ? ' is-inactive' : ''}`;
      const chips = [
        user.bootstrap ? 'Environment' : (user.isAdmin ? 'Admin' : 'Member'),
        user.permissions?.flightPlan ? 'Flights' : '',
        user.permissions?.slideshow ? 'Slideshow' : '',
        user.permissions?.redLetter ? 'Dates' : '',
        user.active === false ? 'Inactive' : '',
      ].filter(Boolean);
      card.innerHTML = `
        <img class="house-user-avatar" src="${esc(user.avatarUrl || '/user/avatars/cat-sky.svg')}" alt="">
        <div class="house-user-card-body">
          <strong>${esc(displayName(user))}</strong>
          <div class="hint">${esc(user.username)}${user.email ? ` · ${esc(user.email)}` : ''}</div>
          <div class="house-user-chips">${chips.map((chip) => `<span>${esc(chip)}</span>`).join('')}</div>
        </div>
        <button type="button" class="btn btn-outline btn-sm">Edit</button>`;
      card.querySelector('button').addEventListener('click', (event) => {
        event.stopPropagation();
        openEditor(user);
      });
      card.addEventListener('click', () => openEditor(user));
      host.appendChild(card);
    });
  }

  function userLabel(id) {
    if (!id) return '';
    const user = users.find((row) => row.id === id);
    return user ? displayName(user) : id;
  }

  function filteredAudit() {
    const action = String($('audit-action')?.value || '').trim().toLowerCase();
    const userQ = String($('audit-user')?.value || '').trim().toLowerCase();
    const sort = $('audit-sort')?.value || 'newest';
    let rows = auditRows.filter((row) => {
      const label = String(ACTION_LABELS[row.action] || row.action || '').toLowerCase();
      if (action && !String(row.action || '').toLowerCase().includes(action) && !label.includes(action)) {
        return false;
      }
      if (!userQ) return true;
      const hay = [
        row.actorUserId,
        row.targetUserId,
        row.detail?.username,
        userLabel(row.actorUserId),
        userLabel(row.targetUserId),
      ].join(' ').toLowerCase();
      return hay.includes(userQ);
    });
    rows = rows.slice();
    if (sort === 'oldest') rows.reverse();
    if (sort === 'action') {
      rows.sort((a, b) => String(a.action || '').localeCompare(String(b.action || ''))
        || String(b.at || '').localeCompare(String(a.at || '')));
    }
    return rows;
  }

  function renderAudit() {
    const host = $('user-audit-list');
    const label = $('audit-page-label');
    const prev = $('btn-audit-prev');
    const next = $('btn-audit-next');
    if (!host) return;
    const rows = filteredAudit();
    const pages = Math.max(1, Math.ceil(rows.length / AUDIT_PAGE_SIZE));
    if (auditPage >= pages) auditPage = pages - 1;
    if (auditPage < 0) auditPage = 0;
    const slice = rows.slice(auditPage * AUDIT_PAGE_SIZE, (auditPage + 1) * AUDIT_PAGE_SIZE);
    const body = $('user-audit-body');
    const empty = $('user-audit-empty');
    if (body) {
      body.innerHTML = slice.map((row) => {
        const when = row.at ? new Date(row.at).toLocaleString() : '';
        const who = userLabel(row.targetUserId || row.actorUserId);
        const label = ACTION_LABELS[row.action] || row.action;
        return `<tr>
          <td><strong>${esc(label)}</strong></td>
          <td>${esc(when)}</td>
          <td>${esc(who)}</td>
          <td>${esc(row.ip || '')}</td>
        </tr>`;
      }).join('');
    }
    if (empty) empty.hidden = slice.length > 0;
    if (label) label.textContent = rows.length
      ? `Page ${auditPage + 1} of ${pages} · ${rows.length}`
      : 'No entries';
    if (prev) prev.disabled = auditPage <= 0;
    if (next) next.disabled = auditPage >= pages - 1 || !rows.length;
  }

  async function loadUsers() {
    const data = await api('/api/house-users');
    users = data.users || [];
    templates = data.templates || [];
    const editorOpen = $('hu-editor-sheet') && !$('hu-editor-sheet').hidden;
    const current = selectedUser();
    if (editorOpen && current) fillForm(users.find((row) => row.id === current.id) || current);
    else {
      renderAvatarGrid();
      renderUsers();
    }
  }

  async function loadGmail() {
    const data = await api('/api/gmail/status');
    const pill = $('gmail-status-pill');
    const detail = $('gmail-status-detail');
    const identity = $('gmail-status-identity');
    if (pill) {
      pill.textContent = data.linked ? 'Linked' : (data.configured ? 'Not linked' : 'Not configured');
      pill.className = `status-pill${data.linked ? ' ok' : ''}`;
    }
    if (identity) {
      identity.textContent = data.linked
        ? (data.email || 'Linked Gmail account')
        : (data.configured ? 'Waiting to link' : 'Not configured');
    }
    if (detail) {
      detail.textContent = data.linked
        ? 'Password-reset mail is sent from this account.'
        : (data.configured
          ? 'Link Gmail, then Signal can send password mail.'
          : 'Add GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI to .env, then restart.');
    }
    if ($('btn-gmail-link')) {
      $('btn-gmail-link').hidden = Boolean(data.linked);
      $('btn-gmail-link').disabled = !data.configured;
    }
    if ($('btn-gmail-unlink')) $('btn-gmail-unlink').hidden = !data.linked;
    if ($('gmail-setup-note')) $('gmail-setup-note').hidden = !data.configured;
  }

  async function loadAudit() {
    const data = await api('/api/house-users/audit?limit=1000');
    auditRows = data.entries || [];
    auditPage = 0;
    renderAudit();
  }

  function openSheet() {
    const sheet = $('house-users-sheet');
    if (!sheet) return;
    sheet.hidden = false;
    showTab('users');
    loadUsers().catch((error) => toast(error.message));
    loadAudit().catch(() => {});
  }

  function closeSheet() {
    closeEditor();
    const sheet = $('house-users-sheet');
    if (sheet) sheet.hidden = true;
  }

  function showTab(name) {
    document.querySelectorAll('#house-users-tabs .segmented-btn').forEach((btn) => {
      const on = btn.dataset.huTab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if ($('hu-pane-users')) $('hu-pane-users').hidden = name !== 'users';
    if ($('hu-pane-audit')) $('hu-pane-audit').hidden = name !== 'audit';
    if (name === 'audit') renderAudit();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('btn-house-users') && !$('gmail-mail-card')) return;

    $('btn-house-users')?.addEventListener('click', openSheet);
    $('btn-house-users-close')?.addEventListener('click', closeSheet);
    $('btn-hu-add')?.addEventListener('click', () => openEditor(null));
    $('btn-hu-editor-close')?.addEventListener('click', closeEditor);
    $('hu-editor-sheet')?.addEventListener('click', (event) => {
      if (event.target === $('hu-editor-sheet')) closeEditor();
    });
    $('hu-username')?.addEventListener('pointerdown', unlockUsername);
    $('hu-username')?.addEventListener('focus', unlockUsername);
    $('hu-username')?.addEventListener('input', () => {
      if ($('hu-username')) $('hu-username').dataset.touched = '1';
    });
    $('house-users-tabs')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-hu-tab]');
      if (btn) showTab(btn.dataset.huTab);
    });

    $('btn-hu-save')?.addEventListener('click', async () => {
      try {
        const id = editingId();
        const payload = formPayload();
        if (!id) {
          if (!payload.username) {
            toast('Username is required.');
            return;
          }
          openPasswordSheet('create');
          return;
        }
        const user = selectedUser();
        const body = user?.bootstrap
          ? { firstName: payload.firstName, lastName: payload.lastName, avatar: payload.avatar }
          : payload;
        await api(`/api/house-users/${id}`, { method: 'PUT', body });
        closeEditor();
        toast('Saved.', 'house-users-status');
        await loadUsers();
      } catch (error) {
        toast(error.message);
      }
    });
    $('btn-hu-clear')?.addEventListener('click', clearForm);
    $('btn-hu-toggle')?.addEventListener('click', async () => {
      const user = selectedUser();
      if (!user || user.bootstrap) return;
      try {
        await api(`/api/house-users/${user.id}`, {
          method: 'PUT',
          body: { active: user.active === false },
        });
        await loadUsers();
        toast(user.active === false ? 'Activated.' : 'Deactivated.');
      } catch (error) {
        toast(error.message);
      }
    });
    $('btn-hu-reset')?.addEventListener('click', () => {
      const user = selectedUser();
      if (!user || user.bootstrap) return;
      openPasswordSheet('reset');
    });
    $('btn-hu-pw-close')?.addEventListener('click', closePasswordSheet);
    $('hu-password-sheet')?.addEventListener('click', (event) => {
      if (event.target === $('hu-password-sheet')) closePasswordSheet();
    });
    $('btn-hu-pw-reveal')?.addEventListener('click', () => {
      setPasswordVisible('hu-pw', 'btn-hu-pw-reveal', $('hu-pw')?.type === 'password');
    });
    $('btn-hu-pw-confirm-reveal')?.addEventListener('click', () => {
      setPasswordVisible('hu-pw-confirm', 'btn-hu-pw-confirm-reveal', $('hu-pw-confirm')?.type === 'password');
    });
    $('btn-hu-pw-generate')?.addEventListener('click', fillGeneratedPassword);
    $('btn-hu-pw-copy')?.addEventListener('click', () => {
      copyPassword().catch(() => {});
    });
    $('btn-hu-pw-done-copy')?.addEventListener('click', async () => {
      const value = String($('hu-pw-done-value')?.textContent || '');
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        if ($('hu-pw-done-msg')) $('hu-pw-done-msg').textContent = 'Copied.';
      } catch {
        if ($('hu-pw-done-msg')) $('hu-pw-done-msg').textContent = 'Could not copy — select the password.';
      }
    });
    $('btn-hu-pw-done')?.addEventListener('click', () => {
      const created = passwordMode === 'created';
      closePasswordSheet();
      toast(created ? 'User created.' : 'Password set.', created ? 'house-users-status' : 'hu-form-status');
    });
    $('btn-hu-pw-save')?.addEventListener('click', async () => {
      const parsed = readPasswordForm();
      if (parsed.error) {
        if ($('hu-pw-status')) $('hu-pw-status').classList.remove('is-ok');
        toast(parsed.error, 'hu-pw-status');
        return;
      }
      try {
        const who = passwordWho();
        if (passwordMode === 'create') {
          await api('/api/house-users', {
            method: 'POST',
            body: { ...formPayload(), password: parsed.password },
          });
          passwordMode = 'created';
          showPasswordSuccess(`Created ${who} and set their password.`, parsed.password);
        } else {
          const user = selectedUser();
          if (!user) return;
          await api(`/api/house-users/${user.id}/password`, {
            method: 'POST',
            body: { password: parsed.password },
          });
          passwordMode = 'reset-done';
          showPasswordSuccess(`Password set for ${who}.`, parsed.password);
        }
        await loadUsers();
      } catch (error) {
        toast(error.message, 'hu-pw-status');
      }
    });
    $('btn-hu-email')?.addEventListener('click', async () => {
      const user = selectedUser();
      if (!user || user.bootstrap) return;
      try {
        const result = await api(`/api/house-users/${user.id}/email-password`, { method: 'POST', body: {} });
        if (result.emailed) toast('Password emailed.');
        else {
          openPasswordSheet('reveal', {
            password: result.password,
            title: 'Password',
            lead: result.mailError || 'Gmail is not linked — copy this password now.',
          });
        }
      } catch (error) {
        toast(error.message);
      }
    });
    $('hu-avatar-upload')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const id = editingId();
      if (!id) {
        toast('Save or select a user before uploading a picture.');
        return;
      }
      try {
        const cropped = await window.avatarCropEditor.open(file);
        if (!cropped) return;
        const result = await api(`/api/house-users/${id}/avatar`, { method: 'POST', body: { image: cropped } });
        selectedAvatar = result.user?.avatar || selectedAvatar;
        await loadUsers();
        toast('Picture updated.');
      } catch (error) {
        toast(error.message);
      }
    });

    $('btn-gmail-link')?.addEventListener('click', async () => {
      try {
        const data = await api('/api/gmail/start', { method: 'POST', body: {} });
        if (data.url) location.href = data.url;
        else toast(data.error || 'Could not start Gmail login', 'gmail-form-status');
      } catch (error) {
        toast(error.message, 'gmail-form-status');
      }
    });
    $('btn-gmail-unlink')?.addEventListener('click', async () => {
      try {
        await api('/api/gmail/unlink', { method: 'POST', body: {} });
        await loadGmail();
        toast('Unlinked.', 'gmail-form-status');
      } catch (error) {
        toast(error.message, 'gmail-form-status');
      }
    });

    const rerenderAudit = () => {
      auditPage = 0;
      renderAudit();
    };
    $('audit-action')?.addEventListener('input', rerenderAudit);
    $('audit-user')?.addEventListener('input', rerenderAudit);
    $('audit-sort')?.addEventListener('change', rerenderAudit);
    $('btn-audit-refresh')?.addEventListener('click', () => loadAudit().catch(() => {}));
    $('btn-audit-prev')?.addEventListener('click', () => {
      auditPage -= 1;
      renderAudit();
    });
    $('btn-audit-next')?.addEventListener('click', () => {
      auditPage += 1;
      renderAudit();
    });

    const params = new URLSearchParams(location.search);
    if (params.get('gmail') === 'ok') toast('Gmail linked.', 'gmail-form-status');
    if (params.get('gmail') === 'denied' || params.get('gmail') === 'error') {
      toast('Gmail was not linked.', 'gmail-form-status');
    }
    loadGmail().catch(() => {});
    renderAvatarGrid();
  });
})();
