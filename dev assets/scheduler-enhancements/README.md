# Handoff: Scheduler Enhancements + User Scheduler Permission

Target repo: `lmsilva/signal-bridge` (branch `master`). Vanilla JS admin SPA — `src/web/admin/index.html`, `app.js`, `styles.css`, `house-users.js`; engine in `src/display-scheduler.js`, `src/scheduler-rules.js`, `src/quiet-hours-reminder.js`.

## Overview
Six changes to the Display Scheduler:
1. Rules can target **All displays / Software / Vestaboards / a specific display**, and the list can be **filtered** by that target.
2. New **Fixed time** schedule type: a rule fires at exact day-of-week + hour + minute slots, picked on a 7×24 week grid.
3. Every rule has a **Hold on screen** duration (default 15 min) honoured by both display kinds; priority always wins.
4. The Schedule tab becomes a **compact, grouped, filterable list** instead of stacked cards.
5. Per-Vestaboard **quiet hours become a week grid** (default quiet 22:00–07:00).
6. New household **permission `scheduler`** that exposes a **Scheduler tab on the user site** with full parity.

## About the design files
`Scheduler Enhancements.dc.html` (+ `support.js`) is a **design reference built in HTML** — an interactive prototype showing intended look and behaviour. Do **not** copy it into the app. Recreate the screens inside the existing admin SPA using its established classes (`.card`, `.segmented`, `.segmented-btn`, `.btn`, `.btn-accent`, `.btn-outline`, `.field-input`, `.field-label`, `.hint`, `.trivia-check`) and the CSS variables in `styles.css`. Screens are labelled 1a–1e in the file (badge top-left of each artboard).

## Fidelity
**High-fidelity** for layout, hierarchy, copy and behaviour. Colours/type are the repo's existing tokens, so match the existing admin look rather than pixel-matching the mock.

## Design tokens (already in `styles.css`)
- `--bg #0f172a` page · `--bg-elev #16213b` cards/rows · `--bg-elev-2 #1c2947` idle grid cell / neutral chip · `--line #263450` borders, quiet cells, off switch
- `--text #e2e8f0` · `--text-dim #8fa3c4`
- `--accent #38bdf8` (selected segment, on switch, painted "fires" cell) · `--accent-ink #082f49` text on accent
- `--good #34d399` · `--warn #fbbf24` (Vestaboard pill uses rule palette gold `#F5C453`) · `--danger #f87171`
- Radius: cards 16–18px, rows/inputs 12px, segments 9px, grid cells 5px, pills 999px
- Font: system stack already set on `body`. Sizes used: 22px/700 editor title, 16–18px/700 section titles, 15px/700 row name, 14px/600 segments, 13px meta, 12px `--text-dim` sub-lines, 11px uppercase `.08em` column headers, 11px hour labels
- Target pills: All displays `#1c2947`/`#e2e8f0` · Software `rgba(56,189,248,.18)`/`#7dd3fc` · Vestaboards `rgba(245,196,83,.18)`/`#f5c453`
- Kind chips: Cadence `rgba(143,163,196,.2)`/`#c7d2e6` · Fixed `rgba(52,211,153,.18)`/`#6ee7b7`

---

## Screen 1a — Admin › Schedule tab (list)
**Purpose:** find, filter, toggle and open rules quickly when there are 50+.

**Layout** (inside existing `#sched-view-schedule`, replaces `#sched-setup-card` + `#sched-rule-list` cards):
- Toolbar row, `display:flex; gap:12px`:
  - Search `input.field-input` (flex 1) placeholder "Find a rule by name, group or command…"
  - **Display filter** `.segmented`: `All displays | Software | Vestaboards`
  - **Kind filter** `.segmented`: `Any | Cadence | Fixed time`
  - `button.btn.btn-accent` "+ Add rule" (opens the existing command typeahead, then the editor 1b)
- Meta line 13px dim: left "`{n} of {total} rules · grouped by type`", right "Sort: Group · Next fire · Priority" (sort selector).
- Column header row (11px uppercase dim, `grid-template-columns: 18px 1fr 118px 250px 80px 90px 44px 32px; gap:12px; padding:14px 16px 6px`): blank · Rule · Show on · Schedule · Hold · Priority · On · blank.
- Groups: header `display:flex; gap:10px; padding:10px 16px; 12px/700 uppercase .1em dim` = chevron ▾ · group name · count chip (`#1c2947`, radius 6px). Click collapses; persist collapsed set in localStorage.
- Row: same grid as header; `background --bg-elev; border 1px --line; radius 12px; padding 12px 16px; margin-bottom 6px`; hover `border-color --accent`.
  - 12px colour dot (`rule.color`)
  - name 15px/700 ellipsis + commandId 12px dim
  - target pill (see tokens)
  - kind chip + schedule summary 13px ellipsis. Cadence: "Every 30 min · 90%" (+ " · 09:00–22:00" if activeWindow). Fixed: compressed summary "Mon–Fri 06:45, 17:30 · Sat–Sun 09:00".
  - hold "15m"
  - priority: 5 pips 8×14px radius 2px, filled `--accent` up to importance, rest `--line`; title "Importance n"
  - switch 38×22 (`--accent` on / `--line` off), knob 16px white
  - chevron › opens editor (1b) as a right drawer ≥1024px, bottom sheet below.

**Filter semantics:** Software shows `target ∈ {full, all, <software display id>}`; Vestaboards shows `{vestaboard, all, <board id>}`; All shows everything. Filters + search combine; empty state uses existing `#sched-rule-empty`.

## Screen 1b — Rule editor (drawer)
**Layout:** card padding 28px.
- Header flex gap 14px: colour dot 14px · label input (transparent, 1px bottom border `--line`, 22px/700) · `btn-outline` "Air now" · `btn-outline` red text "Delete" · `btn-accent` "Save". Below: 13px dim "`{commandId} · {group} group`".
- Form grid `grid-template-columns: 200px 1fr; gap: 14px 20px`, labels 600 dim:
  - **Show on** segmented: `All displays | Software | Vestaboards | Specific display…` (last opens a display select).
  - **Schedule type** segmented: `Cadence — roughly every N minutes | Fixed time — exactly at these times`.
- **Cadence** pane (existing controls): Every, Chance slider, rate line "≈ 43.2×/day · typical gap 33m, occasionally 1h+".
- **Fixed time** pane — nested card (`--bg-elev`, radius 16px, padding 20px):
  - Title "Week schedule" 16px/700; sub 13px dim "Click or drag across cells to pick the hours this rule fires. Each selected cell fires once, at the minute chosen below." Legend right: ■ Fires (`--accent`) · ■ Idle (`#1c2947`).
  - **Grid**: `display:grid; grid-template-columns: 52px repeat(24, 1fr); gap:3px; user-select:none`. Row 0: blank + "am" bar spanning cols 2–13 (12px/700 `#FF7A6B`, 2px bottom border) + "pm" bar cols 14–25 (`--accent`). Rows Mon…Sun: day label 13px dim + 24 cells `height:30px; radius 5px`. Last row: hour labels 0–23, 11px dim centred.
  - Cell interaction: mousedown toggles cell and sets paint mode = new state; mouseenter while mouse held applies paint mode; mouseup (window) ends. Touch: pointer events equivalent. Hover outline `2px #7dd3fc`. Keyboard: cells focusable, Space toggles.
  - **Fire at minute** row: label · segmented `:00 :15 :30 :45` · "or" · inline field "HH: [mm] past the hour" (0–59, applies to all cells) · right hint "Right-click a cell to override its minute" (context menu → small popover with minute input; overridden cell shows a tiny 2px dot bottom-right).
  - Summary bar (`--bg`, radius 10px, 14px): "Fires **7×/week** — Mon–Fri 07:00 · Sat, Sun 08:00". Group consecutive days with identical times; "Nothing selected — click cells in the grid" when empty.
- Remaining fields (same 200px/1fr grid):
  - **Hold on screen**: number input + "min", default **15**. Helper: "Default 15 min. Vestaboards keep it until this expires **and** another event is queued; a higher-priority event always interrupts."
  - **Priority** segmented `1 Background | 2 Low | 3 Normal | 4 High | 5 Featured` (existing IMPORTANCE_LABELS).
  - **Quiet hours** checkbox "Exempt — may fire during a board's quiet hours".
  - Collapsed "▸ Advanced — cooldown, max per day, jitter, requires-content guard".

**Validation:** Fixed time requires ≥1 cell. Hold 1–240 min. Save disabled until valid; unsaved-changes prompt on close.

## Screen 1c — Settings › Quiet hours (per Vestaboard)
Replaces `#sched-quiet-start/end` time inputs.
- Header flex: title "Quiet hours" 18px/700 (flex 1) · board segmented (one button per configured board) · `btn-outline` sm "Copy to other boards" · "Reset to 22:00–07:00".
- 13px dim: "While quiet, **{board}** shows nothing new; queued events wait until the board wakes. Exempt rules and the Quiet Hours Reminder still post."
- Legend: ■ Active `#f5c453` · ■ Quiet `--line`; right hint "Drag to paint · click a day label to toggle the whole day".
- Same grid component as 1b, cell height 34px; painted = Active.
- Summary strip (`--bg-elev`, 13px dim): "Mon 9h quiet · Tue 9h quiet · … · Sat always on".
- Checkbox "Post a Quiet Hours Reminder card when quiet begins" (`remindOnStart`).
- Default for new boards: quiet 22–23 and 0–6 every day (= 22:00–07:00).

## Screen 1d — Admin › Household user editor
Add a 4th permission card under Flight plan / Slideshow / Red letter dates:
- **Scheduler** + "NEW" pill; helper 13px dim: "Shows the Scheduler tab on the user site with the same rule editor as admin — filters, fixed-time week grid, hold and priority." Chip "Scheduler" appears on the user card when granted.

## Screen 1e — User site › Scheduler tab
Visible only when `permissions.scheduler === true` (server-enforced on the API too). Same list (1a) and editor (1b) components at narrow width: search + "+ Add" row, display-filter segmented, rows collapse to dot · name · one meta line ("Fixed · Daily 07:00 · hold 15m · All displays") · switch. Editor opens as a full-height sheet with the 200px/1fr grid collapsing to single column below 720px; week grid keeps 24 columns (cells shrink; horizontal scroll under 560px).

---

## Interactions summary
- Segmented buttons: instant, no animation. Switch knob 120ms ease.
- Drawer: slide-in 200ms ease-out from right; sheet from bottom.
- Group collapse: instant; persisted.
- Grid paint: no transition on cell background (must feel immediate).

## State
- List: `search`, `displayFilter: all|full|vestaboard`, `kindFilter: any|cadence|fixed`, `sort`, `collapsedGroups: Set`.
- Editor: draft rule (below) + `dirty`, `paintMode: 'on'|'off'|null`, `minute` (global) and per-cell overrides.
- Quiet hours: `selectedBoardId`, per-board 7×24 boolean matrix, `paintMode`.

## Data model (scheduler-rules.js)
```js
rule.target        // 'all' | 'full' | 'vestaboard' | <displayId>   (exists)
rule.scheduleType  // 'cadence' (default) | 'fixed'                  (new)
rule.fixedTimes    // [{ day: 0-6 (Mon=0), hour: 0-23, minute: 0-59 }] (new)
rule.holdSeconds   // default 900; alias/migrate displayDurationSeconds (new)
rule.importance    // 1-5 (exists) — always honoured; fixed-time rules skip scoring
rule.quietHoursExempt // boolean (new)
```
Engine: fixed rules fire at `HH:mm` local (`timeZone` setting) when nothing of ≥ importance is showing; otherwise queue and fire when the display frees, dropping if >`holdSeconds` late. Vestaboard hold: keep frame until `holdSeconds` elapsed AND next queued event exists; interrupt immediately for higher importance.

Board quiet hours:
```js
board.quietHours = { enabled, remindOnStart, week: string[7] } // 24-char '1'(quiet)/'0' per day, Mon first
```
Migrate legacy `{start,end}` into `week` on load.

Users: `permissions.scheduler: boolean` in `house-users.js` (formPayload, fillForm, chips, setLocked) and the user-site nav/route guard.

## Files in this bundle
- `Scheduler Enhancements.dc.html` + `support.js` — interactive reference (open in a browser; grids are paintable, filters work).
- `SPEC-scheduler-enhancements.md` — short version of this brief.
