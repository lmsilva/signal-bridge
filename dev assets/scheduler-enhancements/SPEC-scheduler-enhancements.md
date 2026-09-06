# Scheduler enhancements — implementation brief

Mockups: `Scheduler Enhancements.dc.html` (screens 1a–1e). Reuse the existing admin tokens from `src/web/admin/styles.css` (`--bg #0f172a`, `--bg-elev #16213b`, `--bg-elev-2 #1c2947`, `--line #263450`, `--accent #38bdf8`, `--accent-ink #082f49`, `--good`, `--warn`, `--danger`, `--radius 16px`) and the existing `.segmented`, `.card`, `.btn`, `.field-input` classes.

## 1a — Schedule tab (admin)
- Replace stacked rule cards with **compact rows** grouped by type (collapsible group header with count).
- Row columns: colour dot · name + commandId · **Show on** pill (All displays / Software / Vestaboards / display name) · **Schedule** (kind chip `Cadence`/`Fixed` + summary) · Hold · Priority pips (1–5) · enabled switch · chevron → editor drawer.
- Toolbar: search · **display filter** segmented (All displays / Software / Vestaboards — matching `rule.target` = `all | full | vestaboard | <displayId>`; "Software" also shows `all`, "Vestaboards" also shows `all`) · **kind filter** (Any / Cadence / Fixed time) · Add rule.
- Count label reflects the filter: "7 of 49 rules".

## 1b — Rule editor (drawer / sheet)
- Header: colour dot, editable label, Air now, Delete, Save.
- **Show on** segmented: All displays / Software / Vestaboards / Specific display…
- **Schedule type** segmented: `Cadence` (today's intervalSeconds + probability + rate maths, unchanged) or **`Fixed time`** (new).
- Fixed time = **week grid** 7 rows (Mon→Sun) × 24 hour columns, am/pm header bars, hour labels below. Click toggles a cell; mouse-down + drag paints. A selected cell = one firing that day/hour.
- **Fire at minute**: segmented `:00 :15 :30 :45` + free `HH:mm` minute input (0–59) applying to all selected cells; right-click a cell for a per-cell minute override.
- Live summary line below grid: "Fires 7×/week — Mon–Fri 07:00 · Sat, Sun 08:00".
- **Hold on screen** (minutes, default **15**) — applies to both display kinds. Vestaboard semantics: stays until hold expires AND another event is queued; a higher-priority event always interrupts.
- **Priority** 1–5 (existing importance labels). Fixed-time rules bypass scoring: they fire at their time if nothing of higher priority is showing; otherwise queue behind it.
- Quiet hours exempt checkbox. Advanced (cooldown, maxPerDay, jitter, guard) stays collapsed.

Suggested data model additions to `scheduler-rules.js`:
```
scheduleType: 'cadence' | 'fixed'
fixedTimes: [{ day: 0-6, hour: 0-23, minute: 0-59 }]   // Mon=0
holdSeconds: 900                                       // replaces/aliases displayDurationSeconds
```

## 1c — Quiet hours per Vestaboard (Settings)
- One grid per board (board segmented tabs), same 7×24 grid component; painted = **Active**, unpainted = **Quiet**.
- Default: quiet 22:00–07:00 every day.
- Actions: Copy to other boards · Reset to 22:00–07:00 · click day label toggles whole day.
- Per-day summary line + "Post Quiet Hours Reminder when quiet begins" toggle (existing `remindOnStart`).
- Replaces `quietHours: {start,end}` with `quietHours: { enabled, remindOnStart, week: string[7] }` where each string is 24 chars of `1`/`0` per hour (keep `start/end` migration).

## 1d — Permission
- Add `permissions.scheduler` to household users (`house-users.js` formPayload/fillForm/chips) with card copy shown in the mock.

## 1e — User site
- New Scheduler tab, visible only with `permissions.scheduler`; full parity with admin (same list, filters and editor components; editor stacks vertically under 720px).
