/**
 * Shared Display Scheduler list + editor (Phase 4).
 * Used by the household user site; admin app.js keeps its own wiring for
 * Activity / Simulation / Settings but the DOM contracts match.
 *
 * window.SignalSchedulerUi.mount({ toast, getDisplays, onStatus? })
 */
(function (root) {
  'use strict';

  const SCHED_ROUTE = '/api/display-scheduler';
  const IMPORTANCE_OPTIONS = [
    [1, 'Background - yields to almost everything'],
    [2, 'Low'],
    [3, 'Normal (default)'],
    [4, 'High'],
    [5, 'Featured - wins most contests'],
  ];
  const INTERVAL_CHOICES = [
    [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'],
    [2700, '45 min'], [3600, '1 hr'], [7200, '2 hr'], [10800, '3 hr'],
    [21600, '6 hr'], [43200, '12 hr'],
  ];
  const DEFAULT_HOLD_MINUTES = 15;
  const SCHED_RULE_SEARCH_KEY = 'signal.schedRuleSearch';
  const SCHED_DISPLAY_FILTER_KEY = 'signal.schedDisplayFilter';
  const SCHED_KIND_FILTER_KEY = 'signal.schedKindFilter';
  const SCHED_COLLAPSED_GROUPS_KEY = 'signal.schedCollapsedGroups';

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

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

  function normalizeSchedQuery(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function setSegmentedActive(rootId, dataAttr, value) {
    document.querySelectorAll(`#${rootId} .segmented-btn`).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset[dataAttr] === String(value));
    });
  }

  async function apiFetch(route, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body != null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) options.signal = controller.signal;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : 0;
    try {
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
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Request timed out — try again');
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function mount(options = {}) {
    const toast = typeof options.toast === 'function'
      ? options.toast
      : (message) => { if (message) console.info(message); };
    const getDisplays = typeof options.getDisplays === 'function'
      ? options.getDisplays
      : () => [];

    let schedRules = [];
    let schedCommands = [];
    let schedDisplayFilter = 'all';
    let schedKindFilter = 'any';
    let schedCollapsedGroups = new Set();
    let schedFocusRuleId = null;
    let schedEditorRuleId = null;
    let schedEditorBaseline = null;
    let schedEditorDirty = false;
    let schedWeekGrid = null;
    let schedEditorSaving = false;
    let schedCommandCatalog = [];
    let schedCommandActiveIndex = -1;
    let bound = false;

    try {
      const savedDisplay = localStorage.getItem(SCHED_DISPLAY_FILTER_KEY);
      if (savedDisplay === 'all' || savedDisplay === 'full' || savedDisplay === 'vestaboard') {
        schedDisplayFilter = savedDisplay;
      }
      const savedKind = localStorage.getItem(SCHED_KIND_FILTER_KEY);
      if (savedKind === 'any' || savedKind === 'cadence' || savedKind === 'fixed') {
        schedKindFilter = savedKind;
      }
      const collapsed = JSON.parse(localStorage.getItem(SCHED_COLLAPSED_GROUPS_KEY) || '[]');
      if (Array.isArray(collapsed)) schedCollapsedGroups = new Set(collapsed.map(String));
    } catch { /* ignore */ }

    function knownDisplays() {
      return getDisplays() || [];
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

    function schedRuleMatchesDisplay(rule, filter) {
      if (!filter || filter === 'all') return true;
      const target = rule.target || 'full';
      if (filter === 'full') {
        if (target === 'full' || target === 'all') return true;
        if (target === 'vestaboard') return false;
        const display = knownDisplays().find((entry) => entry.id === target);
        return !display || display.kind !== 'vestaboard';
      }
      if (filter === 'vestaboard') {
        if (target === 'vestaboard' || target === 'all') return true;
        if (target === 'full') return false;
        const display = knownDisplays().find((entry) => entry.id === target);
        return display?.kind === 'vestaboard';
      }
      return true;
    }

    function schedRuleMatchesKind(rule, filter) {
      if (!filter || filter === 'any') return true;
      const kind = rule.scheduleType === 'fixed' ? 'fixed' : 'cadence';
      return kind === filter;
    }

    function schedRuleGroupLabel(rule) {
      return String(rule.commandGroup || '').trim() || (rule.broken ? 'Broken' : 'Other');
    }

    function compareSchedRules(a, b) {
      return Number(b.enabled) - Number(a.enabled)
        || String(a.label || '').localeCompare(String(b.label || ''), undefined, { sensitivity: 'base' })
        || String(a.id || '').localeCompare(String(b.id || ''));
    }

    function persistSchedCollapsedGroups() {
      try {
        localStorage.setItem(SCHED_COLLAPSED_GROUPS_KEY, JSON.stringify([...schedCollapsedGroups]));
      } catch { /* ignore */ }
    }

    function schedHoldMinutes(rule) {
      const seconds = Number(rule?.holdSeconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.max(1, Math.min(240, Math.round(seconds / 60)));
      }
      return DEFAULT_HOLD_MINUTES;
    }

    function schedHoldLabel(rule) {
      return `${schedHoldMinutes(rule)}m`;
    }

    function schedTargetPill(rule) {
      const target = rule.target || 'full';
      if (target === 'all') return { label: 'All displays', cls: '' };
      if (target === 'full') return { label: 'Software', cls: 'is-full' };
      if (target === 'vestaboard') return { label: 'Vestaboards', cls: 'is-vestaboard' };
      const display = knownDisplays().find((entry) => entry.id === target);
      if (display?.kind === 'vestaboard') {
        return { label: display.label || display.name || target, cls: 'is-vestaboard' };
      }
      return { label: display?.label || display?.name || target, cls: 'is-full' };
    }

    function schedCadenceSummary(rule) {
      const interval = INTERVAL_CHOICES.find(([value]) => value === rule.intervalSeconds)?.[1]
        || formatDuration(rule.intervalSeconds);
      let text = `Every ${interval} | ${rule.probability}%`;
      if (rule.activeWindow?.start && rule.activeWindow?.end) {
        text += ` | ${rule.activeWindow.start}-${rule.activeWindow.end}`;
      }
      return text;
    }

    function schedFixedSummary(rule) {
      const slots = Array.isArray(rule.fixedTimes) ? rule.fixedTimes : [];
      if (!slots.length) return 'No times set';
      if (typeof root.WeekGrid?.summarizeSlots === 'function') {
        return root.WeekGrid.summarizeSlots(slots)
          .replace(/^Fires \d+x\/week -- /, '')
          .replace(/^Fires \d+x\/week - /, '')
          .replace(/^Fires \d+x\/week - /, '');
      }
      return `${slots.length}x/week`;
    }

    function schedScheduleSummary(rule) {
      return rule.scheduleType === 'fixed' ? schedFixedSummary(rule) : schedCadenceSummary(rule);
    }

    function schedRowMetaLine(rule) {
      const kind = rule.scheduleType === 'fixed' ? 'Fixed' : 'Cadence';
      const when = schedScheduleSummary(rule);
      const target = schedTargetPill(rule).label;
      return `${kind} | ${when} | hold ${schedHoldLabel(rule)} | ${target}`;
    }

    function focusSchedRule(ruleId) {
      if (!ruleId) return;
      const card = document.querySelector(`#sched-rule-list [data-rule-id="${CSS.escape(ruleId)}"]`);
      if (!(card instanceof HTMLElement)) return;
      card.classList.add('is-new');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => card.classList.remove('is-new'), 2200);
    }

    function syncSchedFilterButtons() {
      document.querySelectorAll('#sched-display-filter .segmented-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.schedDisplayFilter === schedDisplayFilter);
      });
      document.querySelectorAll('#sched-kind-filter .segmented-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.schedKindFilter === schedKindFilter);
      });
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
        options.push(['full', 'Software'], ['all', 'All displays']);
      }
      if (boardCapable) {
        options.push(['vestaboard', 'Vestaboards']);
        for (const display of knownDisplays().filter((entry) => entry.kind === 'vestaboard')) {
          options.push([display.id, display.label || display.name]);
        }
      }
      for (const display of knownDisplays().filter((entry) => entry.kind !== 'vestaboard')) {
        if (boardOnly) continue;
        options.push([display.id, display.label || display.name]);
      }
      if (current && !options.some(([value]) => value === current)) {
        options.push([current, current]);
      }
      return options;
    }

    function schedRuleParamsHtml(rule, prefix = 'data-sched-param') {
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
            + `<select class="field-input" ${prefix}="${escapeHtml(key)}">`
            + `<option value="">default</option>${options}</select>`;
        }
        const min = def.min != null ? ` min="${def.min}"` : '';
        const max = def.max != null ? ` max="${def.max}"` : '';
        return `<label class="field-label">${escapeHtml(def.label || key)}</label>`
          + `<input class="field-input" type="number"${min}${max} ${prefix}="${escapeHtml(key)}"`
          + ` value="${escapeHtml(value === '' || value == null ? '' : String(value))}" placeholder="default">`;
      }).join('');
      return `<div class="sched-field-row" style="margin-top:8px">${fields}</div>`;
    }

    function schedRuleRowHtml(rule) {
      const pill = schedTargetPill(rule);
      const fixed = rule.scheduleType === 'fixed';
      const importance = Math.max(1, Math.min(5, Number(rule.importance) || 3));
      const pips = Array.from({ length: 5 }, (_, i) => (
        `<span class="${i < importance ? 'is-on' : ''}"></span>`
      )).join('');
      return `<div class="sched-row" data-rule-id="${escapeHtml(rule.id)}" role="button" tabindex="0">
      <i class="sched-dot" style="background:${escapeHtml(rule.color)}" aria-hidden="true"></i>
      <div class="sched-row-name" data-meta="${escapeHtml(schedRowMetaLine(rule))}">
        <div class="sched-row-title${rule.broken ? ' is-broken' : ''}">${escapeHtml(rule.label)}${
        rule.broken ? ' - command no longer exists' : ''}</div>
        <div class="sched-row-sub">${escapeHtml(rule.commandId || '')}</div>
      </div>
      <span class="sched-target-pill ${pill.cls}">${escapeHtml(pill.label)}</span>
      <div class="sched-row-when">
        <span class="sched-kind-chip${fixed ? ' is-fixed' : ''}">${fixed ? 'Fixed' : 'Cadence'}</span>
        <span class="sched-row-summary">${escapeHtml(schedScheduleSummary(rule))}</span>
      </div>
      <span class="sched-row-hold">${escapeHtml(schedHoldLabel(rule))}</span>
      <div class="sched-row-pips" title="Importance ${importance}">${pips}</div>
      <label class="sched-switch" title="Enable rule">
        <input type="checkbox" data-sched-field="enabled"${rule.enabled ? ' checked' : ''} aria-label="Enable ${escapeHtml(rule.label)}">
      </label>
      <button type="button" class="sched-row-open" data-sched-action="edit" aria-label="Edit ${escapeHtml(rule.label)}">›</button>
    </div>`;
    }

    function renderSchedRules() {
      const host = $('sched-rule-list');
      const meta = $('sched-rule-meta');
      const empty = $('sched-rule-empty');
      const colHead = $('sched-col-head');
      const searchInput = $('sched-rule-search');
      if (!host) return;

      const rawSearch = searchInput?.value || '';
      const query = normalizeSchedQuery(rawSearch);
      syncSchedFilterButtons();

      if (!schedRules.length) {
        host.innerHTML = '';
        if (colHead) colHead.hidden = true;
        if (meta) meta.textContent = 'No rules yet';
        if (empty) {
          empty.hidden = false;
          empty.textContent = 'Click + Add rule, pick an event, then save. New rules land in their group, sorted by name.';
        }
        return;
      }

      const matched = schedRules.filter((rule) => (
        schedRuleMatches(rule, query)
        && schedRuleMatchesDisplay(rule, schedDisplayFilter)
        && schedRuleMatchesKind(rule, schedKindFilter)
      ));
      if (meta) {
        meta.textContent = `${matched.length} of ${schedRules.length} rules`
          + (query || schedDisplayFilter !== 'all' || schedKindFilter !== 'any' ? '' : ' | grouped by type');
      }

      if (!matched.length) {
        host.innerHTML = '';
        if (colHead) colHead.hidden = true;
        if (empty) {
          empty.hidden = false;
          empty.textContent = query
            ? `No rules match "${rawSearch.trim()}".`
            : 'No rules match these filters.';
        }
        return;
      }
      if (empty) empty.hidden = true;
      if (colHead) colHead.hidden = false;

      const groups = new Map();
      for (const rule of matched) {
        const group = schedRuleGroupLabel(rule);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(rule);
      }
      const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      host.innerHTML = groupNames.map((group) => {
        const rules = groups.get(group).sort(compareSchedRules);
        const collapsed = schedCollapsedGroups.has(group);
        return `<section class="sched-rule-group${collapsed ? ' is-collapsed' : ''}" data-sched-group="${escapeHtml(group)}">`
          + `<button type="button" class="sched-rule-group-head" data-sched-group-toggle="${escapeHtml(group)}" aria-expanded="${collapsed ? 'false' : 'true'}">`
          + `<span class="sched-group-chevron" aria-hidden="true">${collapsed ? '>' : 'v'}</span>`
          + `<span>${escapeHtml(group)}</span>`
          + `<span class="sched-rule-group-count">${rules.length}</span></button>`
          + `<div class="sched-row-wrap">${rules.map(schedRuleRowHtml).join('')}</div>`
          + `</section>`;
      }).join('');

      if (schedFocusRuleId) {
        const id = schedFocusRuleId;
        schedFocusRuleId = null;
        requestAnimationFrame(() => focusSchedRule(id));
      }
    }

    function schedEditorSnapshot() {
      const type = document.querySelector('#sched-sheet-type .segmented-btn.active')?.dataset.schedType || 'cadence';
      const targetBtn = document.querySelector('#sched-sheet-target .segmented-btn.active')?.dataset.schedTarget || 'full';
      let target = targetBtn;
      if (targetBtn === 'specific') {
        target = $('sched-sheet-specific')?.value || 'full';
      }
      const holdMinutes = Math.max(1, Math.min(240, Number($('sched-sheet-hold')?.value) || DEFAULT_HOLD_MINUTES));
      const cooldownMinutes = String($('sched-sheet-cooldown')?.value || '').trim();
      const maxPerDay = String($('sched-sheet-maxPerDay')?.value || '').trim();
      const jitter = String($('sched-sheet-jitter')?.value || '').trim();
      const params = {};
      $('sched-sheet-params')?.querySelectorAll('[data-sched-param]').forEach((input) => {
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
      const fixedTimes = schedWeekGrid
        ? schedWeekGrid.getSlots()
        : (schedEditorBaseline?.fixedTimes || []);
      const importance = Number(
        document.querySelector('#sched-sheet-importance .segmented-btn.active')?.dataset.schedImportance
      ) || 3;
      return {
        enabled: schedEditorBaseline?.enabled !== false,
        label: String($('sched-sheet-label')?.value || '').trim() || schedEditorBaseline?.label || '',
        intervalSeconds: Number($('sched-sheet-interval')?.value) || 2700,
        probability: Number($('sched-sheet-probability')?.value) || 0,
        importance,
        target,
        params,
        maxPerDay: maxPerDay === '' ? null : Number(maxPerDay),
        cooldownSeconds: cooldownMinutes === '' ? null : Number(cooldownMinutes) * 60,
        jitterPercent: jitter === '' ? null : Number(jitter),
        guard: $('sched-sheet-guard-wrap')?.hidden
          ? schedEditorBaseline?.guard
          : ($('sched-sheet-guard')?.checked ? 'requires-content' : null),
        scheduleType: type === 'fixed' ? 'fixed' : 'cadence',
        fixedTimes,
        holdSeconds: holdMinutes * 60,
        quietHoursExempt: $('sched-sheet-quiet-exempt')?.checked === true,
      };
    }

    function markSchedEditorDirty() {
      if (!schedEditorRuleId || schedEditorSaving) return;
      schedEditorDirty = true;
      updateSchedEditorSaveState();
    }

    function updateSchedEditorSaveState() {
      const saveBtn = $('btn-sched-sheet-save');
      if (!saveBtn) return;
      const snap = schedEditorSnapshot();
      const fixedOk = snap.scheduleType !== 'fixed' || (Array.isArray(snap.fixedTimes) && snap.fixedTimes.length > 0);
      const holdOk = Number.isFinite(snap.holdSeconds) && snap.holdSeconds >= 60 && snap.holdSeconds <= 240 * 60;
      saveBtn.disabled = !fixedOk || !holdOk;
    }

    function updateSchedCadenceReadout() {
      const el = $('sched-sheet-cadence-readout');
      if (!el) return;
      const intervalSeconds = Number($('sched-sheet-interval')?.value) || 2700;
      const probability = Number($('sched-sheet-probability')?.value) || 0;
      const expected = Math.round(((86400 / Math.max(1, intervalSeconds)) * (probability / 100)) * 10) / 10;
      const gap = (() => {
        const p = Math.max(0, Math.min(100, probability)) / 100;
        if (p <= 0) return 'never airs at 0%';
        const typical = intervalSeconds / p;
        const occasional = p >= 1
          ? intervalSeconds
          : intervalSeconds * (1 + Math.max(1, Math.ceil(Math.log(0.1) / Math.log(1 - p))));
        return `typical gap ${formatDuration(typical)}`
          + (occasional > typical ? `, occasionally ${formatDuration(occasional)}+` : '');
      })();
      el.innerHTML = `<strong>~ ${expected}x/day</strong> | ${escapeHtml(gap)}`;
    }

    function updateSchedFixedSummary() {
      const el = $('sched-sheet-fixed-summary');
      if (!el) return;
      if (!schedWeekGrid) {
        el.textContent = 'No times selected';
        return;
      }
      el.textContent = schedWeekGrid.summarize();
    }

    function updateSchedEditorPanes() {
      const type = document.querySelector('#sched-sheet-type .segmented-btn.active')?.dataset.schedType || 'cadence';
      const cadence = $('sched-sheet-cadence');
      const fixed = $('sched-sheet-fixed');
      if (cadence) cadence.hidden = type === 'fixed';
      if (fixed) fixed.hidden = type !== 'fixed';
      updateSchedCadenceReadout();
      updateSchedFixedSummary();
      updateSchedEditorSaveState();
    }

    function ensureSchedWeekGrid() {
      const host = $('sched-week-grid');
      if (!host || typeof root.createWeekGrid !== 'function') return null;
      if (schedWeekGrid) return schedWeekGrid;
      schedWeekGrid = root.createWeekGrid(host, {
        mode: 'fires',
        globalMinute: 0,
        onChange: () => {
          updateSchedFixedSummary();
          markSchedEditorDirty();
          updateSchedEditorSaveState();
        },
      });
      return schedWeekGrid;
    }

    function fillSchedSheetSpecific(rule) {
      const select = $('sched-sheet-specific');
      if (!select) return;
      const options = schedTargetOptions(rule).filter(([value]) => (
        value !== 'all' && value !== 'full' && value !== 'vestaboard'
      ));
      select.innerHTML = options.map(([value, label]) => (
        `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
      )).join('') || '<option value="">No specific displays</option>';
      const current = rule.target || '';
      if (current && current !== 'all' && current !== 'full' && current !== 'vestaboard') {
        select.value = current;
      }
    }

    function openSchedEditor(ruleId) {
      const rule = schedRules.find((entry) => entry.id === ruleId);
      const sheet = $('sched-rule-sheet');
      if (!rule || !sheet) return;

      schedEditorRuleId = ruleId;
      schedEditorBaseline = { ...rule, fixedTimes: Array.isArray(rule.fixedTimes) ? rule.fixedTimes.slice() : [] };
      schedEditorDirty = false;
      schedEditorSaving = true;

      const dot = $('sched-sheet-dot');
      if (dot) dot.style.background = rule.color || '#38bdf8';
      const label = $('sched-sheet-label');
      if (label) label.value = rule.label || '';
      const sub = $('sched-sheet-sub');
      if (sub) {
        const group = schedRuleGroupLabel(rule);
        sub.textContent = `${rule.commandId || ''} | ${group} group`;
      }

      const target = rule.target || 'full';
      const targetKey = (target === 'all' || target === 'full' || target === 'vestaboard')
        ? target
        : 'specific';
      setSegmentedActive('sched-sheet-target', 'schedTarget', targetKey);
      fillSchedSheetSpecific(rule);
      const specificWrap = $('sched-sheet-specific-wrap');
      if (specificWrap) specificWrap.hidden = targetKey !== 'specific';

      setSegmentedActive('sched-sheet-type', 'schedType', rule.scheduleType === 'fixed' ? 'fixed' : 'cadence');

      const interval = $('sched-sheet-interval');
      if (interval) {
        interval.innerHTML = INTERVAL_CHOICES.map(([value, text]) => (
          `<option value="${value}"${value === rule.intervalSeconds ? ' selected' : ''}>${text}</option>`
        )).join('');
      }
      const probability = $('sched-sheet-probability');
      if (probability) probability.value = String(rule.probability ?? 90);
      const probValue = $('sched-sheet-probability-value');
      if (probValue) probValue.textContent = `${probability?.value || 90}%`;

      const paramsHost = $('sched-sheet-params');
      if (paramsHost) paramsHost.innerHTML = schedRuleParamsHtml(rule);

      const hold = $('sched-sheet-hold');
      if (hold) hold.value = String(schedHoldMinutes(rule));

      const importanceHost = $('sched-sheet-importance');
      if (importanceHost) {
        const current = Math.max(1, Math.min(5, Number(rule.importance) || 3));
        importanceHost.innerHTML = IMPORTANCE_OPTIONS.map(([value, text]) => {
          const short = String(text).split(' - ')[0];
          return `<button type="button" class="segmented-btn${value === current ? ' active' : ''}" data-sched-importance="${value}">${escapeHtml(short)}</button>`;
        }).join('');
      }

      const quiet = $('sched-sheet-quiet-exempt');
      if (quiet) quiet.checked = rule.quietHoursExempt === true;

      const maxPerDay = $('sched-sheet-maxPerDay');
      if (maxPerDay) maxPerDay.value = rule.maxPerDay != null ? String(rule.maxPerDay) : '';
      const cooldown = $('sched-sheet-cooldown');
      if (cooldown) {
        cooldown.value = rule.cooldownSeconds ? String(Math.round(rule.cooldownSeconds / 60)) : '';
      }
      const jitter = $('sched-sheet-jitter');
      if (jitter) jitter.value = rule.jitterPercent != null ? String(rule.jitterPercent) : '';

      const guardWrap = $('sched-sheet-guard-wrap');
      const guard = $('sched-sheet-guard');
      if (rule.commandSupportsContentCheck === false) {
        if (guardWrap) guardWrap.hidden = true;
      } else {
        if (guardWrap) guardWrap.hidden = false;
        if (guard) guard.checked = rule.guard === 'requires-content';
      }

      const grid = ensureSchedWeekGrid();
      const slots = Array.isArray(rule.fixedTimes) ? rule.fixedTimes : [];
      const minute = slots.length ? Number(slots[0].minute) || 0 : 0;
      if (grid) {
        grid.setGlobalMinute(minute);
        grid.setSlots(slots);
      }
      setSegmentedActive('sched-sheet-minute-presets', 'schedMinute', String([0, 15, 30, 45].includes(minute) ? minute : ''));
      const minuteInput = $('sched-sheet-minute');
      if (minuteInput) minuteInput.value = String(minute);

      updateSchedEditorPanes();
      sheet.hidden = false;
      schedEditorSaving = false;
      updateSchedEditorSaveState();
      label?.focus();
    }

    async function closeSchedEditor({ force = false } = {}) {
      const sheet = $('sched-rule-sheet');
      if (!sheet || sheet.hidden) return true;
      if (!force && schedEditorDirty) {
        const dialog = root.SignalUiDialog;
        const ok = dialog && typeof dialog.confirm === 'function'
          ? await dialog.confirm({
            title: 'Discard unsaved changes?',
            body: 'Your edits to this rule will be lost.',
            confirmLabel: 'Discard',
            danger: true,
          })
          : false;
        if (!ok) return false;
      }
      sheet.hidden = true;
      schedEditorRuleId = null;
      schedEditorBaseline = null;
      schedEditorDirty = false;
      return true;
    }

    async function saveSchedEditor() {
      if (!schedEditorRuleId) return;
      const patch = schedEditorSnapshot();
      if (patch.scheduleType === 'fixed' && !(patch.fixedTimes && patch.fixedTimes.length)) {
        toast('Pick at least one time on the week grid', 'bad');
        return;
      }
      if (patch.scheduleType === 'cadence' && !(patch.fixedTimes && patch.fixedTimes.length)) {
        if (Array.isArray(schedEditorBaseline?.fixedTimes) && schedEditorBaseline.fixedTimes.length) {
          patch.fixedTimes = schedEditorBaseline.fixedTimes;
        } else {
          delete patch.fixedTimes;
        }
      }
      try {
        schedEditorSaving = true;
        const result = await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(schedEditorRuleId)}`, {
          method: 'PUT',
          body: patch,
        });
        const index = schedRules.findIndex((rule) => rule.id === schedEditorRuleId);
        if (index >= 0) schedRules[index] = result.rule;
        schedEditorDirty = false;
        closeSchedEditor({ force: true });
        renderSchedRules();
        toast('Rule saved', 'good');
      } catch (error) {
        toast(error.message || 'Could not save rule', 'bad');
        await loadSchedRules();
      } finally {
        schedEditorSaving = false;
      }
    }

    async function patchSchedRuleEnabled(ruleId, enabled) {
      try {
        const result = await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}`, {
          method: 'PUT',
          body: { enabled: Boolean(enabled) },
        });
        const index = schedRules.findIndex((rule) => rule.id === ruleId);
        if (index >= 0) schedRules[index] = result.rule;
        renderSchedRules();
      } catch (error) {
        toast(error.message || 'Could not update rule', 'bad');
        await loadSchedRules();
      }
    }

    function listLoadingHtml(label) {
      return '<div class="list-loading" role="status" aria-live="polite">'
        + '<span class="list-loading-spinner" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(label || 'Loading…') + '</span></div>';
    }

    function paintSchedRulesLoading() {
      const host = $('sched-rule-list');
      const empty = $('sched-rule-empty');
      const colHead = $('sched-col-head');
      const meta = $('sched-rule-meta');
      if (empty) empty.hidden = true;
      if (colHead) colHead.hidden = true;
      if (meta) meta.textContent = 'Loading…';
      if (!host) return;
      if (host.querySelector('.sched-rule-row, .sched-rule-group')) return;
      host.innerHTML = listLoadingHtml('Loading rules…');
    }

    async function loadSchedRules() {
      paintSchedRulesLoading();
      const result = await apiFetch(`${SCHED_ROUTE}/rules`);
      schedRules = result.rules || [];
      renderSchedRules();
    }

    async function refreshSchedStatus() {
      try {
        const status = await apiFetch(`${SCHED_ROUTE}/status`);
        const nextUp = $('sched-nextup');
        const hint = $('sched-nextup-hint');
        const card = $('sched-nextup-card');
        if (nextUp) {
          if (!status.active) {
            nextUp.textContent = 'Paused - nothing will air automatically';
          } else if (status.inQuietHours) {
            nextUp.textContent = 'Quiet hours - nothing will air until they end';
          } else if (status.nextUp) {
            nextUp.textContent = `Next up: ${status.nextUp.label} ${relativeTime(status.nextUp.dueAt)}`;
          } else {
            nextUp.textContent = 'No enabled rules';
          }
        }
        if (hint) {
          hint.hidden = !status.active || Boolean(status.inQuietHours);
        }
        if (card) {
          card.classList.toggle('is-paused', !status.active);
          card.classList.toggle('is-quiet', Boolean(status.active && status.inQuietHours));
        }
        if (typeof options.onStatus === 'function') options.onStatus(status);
        return status;
      } catch (error) {
        const nextUp = $('sched-nextup');
        if (nextUp) {
          nextUp.textContent = error?.message || 'Could not load status';
        }
        return null;
      }
    }

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

    function bindEvents() {
      if (bound) return;
      bound = true;
      const rootEl = $('tab-scheduler') || document;
      const sheet = $('sched-rule-sheet');

      sheet?.addEventListener('change', () => {
        markSchedEditorDirty();
        updateSchedCadenceReadout();
        updateSchedEditorSaveState();
      });
      sheet?.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.id === 'sched-sheet-probability') {
          const readout = $('sched-sheet-probability-value');
          if (readout) readout.textContent = `${target.value}%`;
          updateSchedCadenceReadout();
        }
        if (target.id === 'sched-sheet-minute') {
          const minute = Math.max(0, Math.min(59, Number(target.value) || 0));
          ensureSchedWeekGrid()?.setGlobalMinute(minute);
          setSegmentedActive(
            'sched-sheet-minute-presets',
            'schedMinute',
            String([0, 15, 30, 45].includes(minute) ? minute : ''),
          );
        }
        markSchedEditorDirty();
        updateSchedEditorSaveState();
      });
      sheet?.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest('#btn-sched-sheet-close')) {
          await closeSchedEditor();
          return;
        }
        if (target.closest('#btn-sched-sheet-save')) {
          await saveSchedEditor();
          return;
        }
        if (target.closest('#btn-sched-sheet-air') && schedEditorRuleId) {
          const ruleId = schedEditorRuleId;
          const rule = schedRules.find((entry) => entry.id === ruleId);
          const button = $('btn-sched-sheet-air');
          if (button instanceof HTMLButtonElement) button.disabled = true;
          try {
            await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}/air`, { method: 'POST' });
            toast(`${rule?.label || 'Rule'} aired`, 'good');
          } catch (error) {
            toast(error.message || 'Action failed', 'bad');
          } finally {
            if (button instanceof HTMLButtonElement) button.disabled = false;
          }
          return;
        }
        if (target.closest('#btn-sched-sheet-delete') && schedEditorRuleId) {
          const ruleId = schedEditorRuleId;
          const rule = schedRules.find((entry) => entry.id === ruleId);
          const dialog = root.SignalUiDialog;
          const ok = dialog && typeof dialog.confirm === 'function'
            ? await dialog.confirm({
              title: 'Delete this rule?',
              body: `Delete "${rule?.label || 'this rule'}"? This cannot be undone.`,
              confirmLabel: 'Delete',
              danger: true,
            })
            : false;
          if (!ok) return;
          try {
            await apiFetch(`${SCHED_ROUTE}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
            closeSchedEditor({ force: true });
            await loadSchedRules();
            await refreshSchedStatus();
            toast('Rule deleted', 'good');
          } catch (error) {
            toast(error.message || 'Could not delete rule', 'bad');
          }
          return;
        }
        const targetSeg = target.closest('#sched-sheet-target [data-sched-target]');
        if (targetSeg) {
          setSegmentedActive('sched-sheet-target', 'schedTarget', targetSeg.dataset.schedTarget);
          const wrap = $('sched-sheet-specific-wrap');
          if (wrap) wrap.hidden = targetSeg.dataset.schedTarget !== 'specific';
          markSchedEditorDirty();
          return;
        }
        const typeSeg = target.closest('#sched-sheet-type [data-sched-type]');
        if (typeSeg) {
          setSegmentedActive('sched-sheet-type', 'schedType', typeSeg.dataset.schedType);
          updateSchedEditorPanes();
          markSchedEditorDirty();
          return;
        }
        const importanceSeg = target.closest('#sched-sheet-importance [data-sched-importance]');
        if (importanceSeg) {
          setSegmentedActive('sched-sheet-importance', 'schedImportance', importanceSeg.dataset.schedImportance);
          markSchedEditorDirty();
          return;
        }
        const minuteSeg = target.closest('#sched-sheet-minute-presets [data-sched-minute]');
        if (minuteSeg) {
          const minute = Number(minuteSeg.dataset.schedMinute);
          setSegmentedActive('sched-sheet-minute-presets', 'schedMinute', String(minute));
          const minuteInput = $('sched-sheet-minute');
          if (minuteInput) minuteInput.value = String(minute);
          ensureSchedWeekGrid()?.setGlobalMinute(minute);
          markSchedEditorDirty();
        }
      });

      sheet?.addEventListener('click', (event) => {
        if (event.target === sheet) void closeSchedEditor();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && sheet && !sheet.hidden) {
          void closeSchedEditor();
        }
      });

      rootEl.addEventListener('change', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        const row = target.closest('#sched-rule-list [data-rule-id]');
        if (row && target.dataset.schedField === 'enabled') {
          patchSchedRuleEnabled(row.dataset.ruleId, target.checked);
        }
      });

      rootEl.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const displayFilterBtn = target.closest('[data-sched-display-filter]');
        if (displayFilterBtn) {
          schedDisplayFilter = displayFilterBtn.dataset.schedDisplayFilter || 'all';
          try { localStorage.setItem(SCHED_DISPLAY_FILTER_KEY, schedDisplayFilter); } catch { /* ignore */ }
          renderSchedRules();
          return;
        }
        const kindFilterBtn = target.closest('[data-sched-kind-filter]');
        if (kindFilterBtn) {
          schedKindFilter = kindFilterBtn.dataset.schedKindFilter || 'any';
          try { localStorage.setItem(SCHED_KIND_FILTER_KEY, schedKindFilter); } catch { /* ignore */ }
          renderSchedRules();
          return;
        }
        const groupToggle = target.closest('[data-sched-group-toggle]');
        if (groupToggle) {
          const group = groupToggle.dataset.schedGroupToggle;
          if (schedCollapsedGroups.has(group)) schedCollapsedGroups.delete(group);
          else schedCollapsedGroups.add(group);
          persistSchedCollapsedGroups();
          renderSchedRules();
          return;
        }
        if (target.closest('#btn-sched-add-open')) {
          const row = $('sched-add-row');
          if (row) row.hidden = false;
          $('sched-add-command-search')?.focus();
          return;
        }
        if (target.closest('#btn-sched-add-cancel')) {
          const row = $('sched-add-row');
          if (row) row.hidden = true;
          return;
        }
        const row = target.closest('#sched-rule-list [data-rule-id]');
        if (row) {
          if (target.closest('.sched-switch') || target.dataset.schedField === 'enabled') return;
          openSchedEditor(row.dataset.ruleId);
        }
      });

      $('sched-rule-list')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target?.closest?.('[data-rule-id].sched-row');
        if (!row) return;
        event.preventDefault();
        openSchedEditor(row.dataset.ruleId);
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
          const search = $('sched-rule-search');
          if (search && search.value) {
            search.value = '';
            try { localStorage.removeItem(SCHED_RULE_SEARCH_KEY); } catch { /* ignore */ }
          }
          const addRow = $('sched-add-row');
          if (addRow) addRow.hidden = true;
          const cmdSearch = $('sched-add-command-search');
          if (cmdSearch) cmdSearch.value = '';
          const cmdHidden = $('sched-add-command');
          if (cmdHidden) cmdHidden.value = '';
          schedFocusRuleId = newId;
          await loadSchedRules();
          await refreshSchedStatus();
          if (result?.rule?.label) toast(`Added ${result.rule.label}`, 'good');
          if (newId) openSchedEditor(newId);
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

      bindSchedCommandPicker();
      syncSchedFilterButtons();
    }

    async function refresh() {
      bindEvents();
      const nextUp = $('sched-nextup');
      if (nextUp) nextUp.textContent = 'Updating…';
      paintSchedRulesLoading();
      try {
        // Paint rules as soon as /rules returns — do not wait on /api/commands
        // (that endpoint probes every provider and is often the slowest hop).
        const rulesPromise = apiFetch(`${SCHED_ROUTE}/rules`);
        const commandsPromise = apiFetch('/api/commands').catch(() => ({ commands: [] }));
        const rules = await rulesPromise;
        schedRules = rules.rules || [];
        renderSchedRules();
        const statusPromise = refreshSchedStatus();
        const commands = await commandsPromise;
        schedCommands = commands.commands || [];
        renderSchedCommandPicker();
        await statusPromise;
      } catch (error) {
        if (nextUp) nextUp.textContent = error.message || 'Could not load scheduler';
        const host = $('sched-rule-list');
        if (host && host.querySelector('.list-loading')) {
          host.innerHTML = '';
        }
        const empty = $('sched-rule-empty');
        if (empty) {
          empty.hidden = false;
          empty.textContent = error.message || 'Could not load scheduler';
        }
        toast(error.message || 'Could not load scheduler', 'bad');
      }
    }

    return {
      refresh,
      renderRules: renderSchedRules,
      closeEditor: closeSchedEditor,
    };
  }

  root.SignalSchedulerUi = { mount };
})(typeof window !== 'undefined' ? window : globalThis);
