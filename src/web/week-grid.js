/**
 * Shared 7x24 week grid -- fixed-time scheduler slots and quiet-hours maps.
 *
 * Days are Monday-first (0=Mon ... 6=Sun), matching fixedTimes[].day and the
 * quiet-hours week strings. Hours are 0-23 columns.
 *
 * Modes:
 *   fires -- painted cell = one fire; returns fixedTimes[]
 *   quiet -- painted cell = active (not quiet); returns string[7] of 0/1
 */
(function (root) {
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function emptyMatrix() {
    return Array.from({ length: 7 }, () => new Array(24).fill(null));
  }

  function slotsFromMatrix(matrix) {
    const slots = [];
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const minute = matrix[day][hour];
        if (minute == null) continue;
        slots.push({ day, hour, minute: clampInt(minute, 0, 59, 0) });
      }
    }
    return slots;
  }

  function matrixFromSlots(slots, globalMinute) {
    const matrix = emptyMatrix();
    const fallback = clampInt(globalMinute, 0, 59, 0);
    for (const raw of Array.isArray(slots) ? slots : []) {
      const day = clampInt(raw && raw.day, 0, 6, NaN);
      const hour = clampInt(raw && raw.hour, 0, 23, NaN);
      if (!Number.isFinite(day) || !Number.isFinite(hour)) continue;
      const minute = raw && raw.minute == null
        ? fallback
        : clampInt(raw.minute, 0, 59, fallback);
      matrix[day][hour] = minute;
    }
    return matrix;
  }

  function weekStringsFromMatrix(matrix) {
    return matrix.map((row) => row.map((cell) => (cell == null ? '0' : '1')).join(''));
  }

  function matrixFromWeekStrings(week, globalMinute) {
    const matrix = emptyMatrix();
    const fallback = clampInt(globalMinute, 0, 59, 0);
    const rows = Array.isArray(week) ? week : [];
    for (let day = 0; day < 7; day += 1) {
      const row = String(rows[day] || '').padEnd(24, '0').slice(0, 24);
      for (let hour = 0; hour < 24; hour += 1) {
        if (row[hour] === '1') matrix[day][hour] = fallback;
      }
    }
    return matrix;
  }

  function formatHm(hour, minute) {
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  function collapseDays(days) {
    const unique = [...new Set(days)].sort((a, b) => a - b);
    if (unique.length === 7) return 'Every day';
    if (unique.length === 5 && unique.every((d) => d <= 4)) return 'Mon-Fri';
    if (unique.length === 2 && unique.every((d) => d >= 5)) return 'Sat, Sun';
    const labels = [];
    let start = unique[0];
    let prev = unique[0];
    for (let i = 1; i <= unique.length; i += 1) {
      const day = unique[i];
      if (day === prev + 1) {
        prev = day;
        continue;
      }
      labels.push(start === prev
        ? DAY_LABELS[start]
        : DAY_LABELS[start] + '-' + DAY_LABELS[prev]);
      start = day;
      prev = day;
    }
    return labels.join(', ');
  }

  function summarizeSlots(slots) {
    const list = Array.isArray(slots) ? slots.slice() : [];
    if (!list.length) return 'No times selected';
    list.sort((a, b) => (a.day - b.day) || (a.hour - b.hour) || (a.minute - b.minute));
    const byKey = new Map();
    for (const slot of list) {
      const key = formatHm(slot.hour, slot.minute);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(slot.day);
    }
    const parts = [];
    for (const [hm, days] of byKey) {
      parts.push(collapseDays(days) + ' ' + hm);
    }
    return 'Fires ' + list.length + 'x/week -- ' + parts.join(' | ');
  }

  function collapseHours(hours) {
    if (!hours.length) return '';
    const labels = [];
    let start = hours[0];
    let prev = hours[0];
    for (let i = 1; i <= hours.length; i += 1) {
      const hour = hours[i];
      if (hour === prev + 1) {
        prev = hour;
        continue;
      }
      labels.push(start === prev
        ? String(start).padStart(2, '0')
        : String(start).padStart(2, '0') + '-' + String(prev).padStart(2, '0'));
      start = hour;
      prev = hour;
    }
    return labels.join(', ');
  }

  function summarizeQuiet(matrix) {
    const parts = [];
    for (let day = 0; day < 7; day += 1) {
      const quietHours = [];
      for (let hour = 0; hour < 24; hour += 1) {
        if (matrix[day][hour] == null) quietHours.push(hour);
      }
      if (!quietHours.length) parts.push(DAY_LABELS[day] + ' always on');
      else if (quietHours.length === 24) parts.push(DAY_LABELS[day] + ' all quiet');
      else parts.push(DAY_LABELS[day] + ' quiet ' + collapseHours(quietHours));
    }
    return parts.join(' | ');
  }

  function createWeekGrid(host, options) {
    options = options || {};
    if (!host) throw new Error('createWeekGrid requires a host element');
    const mode = options.mode === 'quiet' ? 'quiet' : 'fires';
    const cellHeight = clampInt(options.cellHeight, 18, 48, mode === 'quiet' ? 34 : 30);
    let globalMinute = clampInt(options.globalMinute, 0, 59, 0);
    let matrix = emptyMatrix();
    let painting = null;
    let destroyed = false;

    host.classList.add('week-grid');
    host.classList.toggle('week-grid-quiet', mode === 'quiet');
    host.style.setProperty('--wg-cell-h', cellHeight + 'px');

    function emit() {
      if (typeof options.onChange !== 'function') return;
      if (mode === 'quiet') options.onChange(weekStringsFromMatrix(matrix));
      else options.onChange(slotsFromMatrix(matrix));
    }

    function cellTitle(day, hour) {
      const minute = matrix[day][hour];
      if (minute == null) {
        return mode === 'quiet'
          ? DAY_LABELS[day] + ' ' + hour + ':00 -- quiet'
          : DAY_LABELS[day] + ' ' + hour + ':00 -- off';
      }
      if (mode === 'quiet') return DAY_LABELS[day] + ' ' + hour + ':00 -- active';
      return DAY_LABELS[day] + ' ' + formatHm(hour, minute);
    }

    function paint() {
      if (destroyed) return;
      const parts = [];
      parts.push('<div class="wg-corner" aria-hidden="true"></div>');
      parts.push('<div class="wg-ampm wg-am" style="grid-column:2 / span 12">am</div>');
      parts.push('<div class="wg-ampm wg-pm" style="grid-column:14 / span 12">pm</div>');

      for (let day = 0; day < 7; day += 1) {
        const dayCls = options.dayToggle ? 'wg-day is-toggle' : 'wg-day';
        parts.push(
          '<button type="button" class="' + dayCls + '" data-wg-day="' + day + '"'
          + ' aria-label="' + DAY_LABELS[day] + '">' + DAY_LABELS[day] + '</button>'
        );
        for (let hour = 0; hour < 24; hour += 1) {
          const on = matrix[day][hour] != null;
          const minute = on ? matrix[day][hour] : globalMinute;
          const override = on && minute !== globalMinute;
          const classes = ['wg-cell', on ? 'is-on' : '', override ? 'is-override' : '']
            .filter(Boolean).join(' ');
          parts.push(
            '<button type="button" class="' + classes + '" data-wg-day="' + day
            + '" data-wg-hour="' + hour + '" title="' + cellTitle(day, hour)
            + '" aria-pressed="' + (on ? 'true' : 'false')
            + '" aria-label="' + cellTitle(day, hour) + '"></button>'
          );
        }
      }

      parts.push('<div class="wg-corner" aria-hidden="true"></div>');
      for (let hour = 0; hour < 24; hour += 1) {
        parts.push('<div class="wg-hour" aria-hidden="true">' + hour + '</div>');
      }
      host.innerHTML = parts.join('');
    }

    function setCell(day, hour, on) {
      matrix[day][hour] = on ? globalMinute : null;
    }

    function applyPaint(day, hour) {
      if (painting == null) return;
      const currentlyOn = matrix[day][hour] != null;
      if (painting === currentlyOn) return;
      setCell(day, hour, painting);
      const btn = host.querySelector('[data-wg-day="' + day + '"][data-wg-hour="' + hour + '"]');
      if (btn) {
        btn.classList.toggle('is-on', painting);
        btn.classList.toggle('is-override', false);
        btn.setAttribute('aria-pressed', painting ? 'true' : 'false');
        btn.title = cellTitle(day, hour);
        btn.setAttribute('aria-label', cellTitle(day, hour));
      }
    }

    function onPointerDown(event) {
      const cell = event.target.closest && event.target.closest('.wg-cell');
      if (!cell || !host.contains(cell)) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      // Keep keyboard focus on the cell so Space toggles it instead of
      // activating a control behind an open sheet (e.g. Configure).
      if (typeof cell.focus === 'function') cell.focus();
      const day = Number(cell.dataset.wgDay);
      const hour = Number(cell.dataset.wgHour);
      painting = matrix[day][hour] == null;
      applyPaint(day, hour);
      emit();
    }

    function onPointerEnter(event) {
      if (painting == null) return;
      if (event.buttons === 0) {
        painting = null;
        return;
      }
      const cell = event.target.closest && event.target.closest('.wg-cell');
      if (!cell || !host.contains(cell)) return;
      applyPaint(Number(cell.dataset.wgDay), Number(cell.dataset.wgHour));
      emit();
    }

    function onPointerUp() {
      painting = null;
    }

    function onClickDay(event) {
      if (!options.dayToggle) return;
      const btn = event.target.closest && event.target.closest('.wg-day.is-toggle');
      if (!btn || !host.contains(btn)) return;
      const day = Number(btn.dataset.wgDay);
      const anyOff = matrix[day].some((cell) => cell == null);
      for (let hour = 0; hour < 24; hour += 1) setCell(day, hour, anyOff);
      paint();
      emit();
    }

    function onContextMenu(event) {
      if (mode !== 'fires') return;
      const cell = event.target.closest && event.target.closest('.wg-cell');
      if (!cell || !host.contains(cell)) return;
      const day = Number(cell.dataset.wgDay);
      const hour = Number(cell.dataset.wgHour);
      if (matrix[day][hour] == null) return;
      event.preventDefault();
      const current = matrix[day][hour];
      if (typeof options.onCellContextMenu === 'function') {
        options.onCellContextMenu(day, hour, current, function (minute) {
          matrix[day][hour] = clampInt(minute, 0, 59, current);
          paint();
          emit();
        });
        return;
      }
      const dialog = (typeof globalThis !== 'undefined' ? globalThis : window).SignalUiDialog;
      if (!dialog || typeof dialog.prompt !== 'function') return;
      dialog.prompt({
        title: 'Override minute',
        body: 'Minute for ' + DAY_LABELS[day] + ' ' + String(hour).padStart(2, '0') + ':xx',
        inputLabel: 'Minute (0-59)',
        value: String(current),
        inputType: 'number',
        min: 0,
        max: 59,
        step: 1,
        confirmLabel: 'Set minute',
        validate(value) {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0 || n > 59) return false;
          return String(Math.round(n));
        },
      }).then(function (raw) {
        if (raw == null || destroyed) return;
        matrix[day][hour] = clampInt(raw, 0, 59, current);
        paint();
        emit();
      });
    }

    function onKeyDown(event) {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      const dayBtn = event.target.closest && event.target.closest('.wg-day.is-toggle');
      if (dayBtn && host.contains(dayBtn) && options.dayToggle) {
        // Prevent the native button "click" so Space does not double-fire.
        event.preventDefault();
        const day = Number(dayBtn.dataset.wgDay);
        const anyOff = matrix[day].some((cell) => cell == null);
        for (let hour = 0; hour < 24; hour += 1) setCell(day, hour, anyOff);
        paint();
        emit();
        return;
      }
      const cell = event.target.closest && event.target.closest('.wg-cell');
      if (!cell || !host.contains(cell)) return;
      event.preventDefault();
      const day = Number(cell.dataset.wgDay);
      const hour = Number(cell.dataset.wgHour);
      setCell(day, hour, matrix[day][hour] == null);
      paint();
      emit();
    }

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointerover', onPointerEnter);
    host.addEventListener('click', onClickDay);
    host.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    paint();

    return {
      paint: paint,
      getSlots: function () { return slotsFromMatrix(matrix); },
      setSlots: function (slots) {
        matrix = matrixFromSlots(slots, globalMinute);
        paint();
      },
      getWeekStrings: function () { return weekStringsFromMatrix(matrix); },
      setWeekStrings: function (week) {
        matrix = matrixFromWeekStrings(week, globalMinute);
        paint();
      },
      setGlobalMinute: function (minute) {
        const next = clampInt(minute, 0, 59, globalMinute);
        if (next === globalMinute) return;
        for (let day = 0; day < 7; day += 1) {
          for (let hour = 0; hour < 24; hour += 1) {
            if (matrix[day][hour] == null) continue;
            if (matrix[day][hour] === globalMinute) matrix[day][hour] = next;
          }
        }
        globalMinute = next;
        paint();
        emit();
      },
      getGlobalMinute: function () { return globalMinute; },
      summarize: function () {
        return mode === 'fires'
          ? summarizeSlots(slotsFromMatrix(matrix))
          : summarizeQuiet(matrix);
      },
      destroy: function () {
        destroyed = true;
        host.removeEventListener('pointerdown', onPointerDown);
        host.removeEventListener('pointerover', onPointerEnter);
        host.removeEventListener('click', onClickDay);
        host.removeEventListener('contextmenu', onContextMenu);
        host.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        host.innerHTML = '';
      },
    };
  }

  root.createWeekGrid = createWeekGrid;
  root.WeekGrid = {
    create: createWeekGrid,
    summarizeSlots: summarizeSlots,
    DAY_LABELS: DAY_LABELS,
  };
}(typeof window !== 'undefined' ? window : globalThis));
