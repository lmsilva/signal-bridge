# 01 — Architecture and implementation guide

## 1. System overview

Today the bridge turns Alexa activity and panel commands into typed
payloads and sends them over UDP to Windows display clients. This feature
adds a second display kind that is reached over HTTP instead of UDP:

```
                          ┌────────────────────────────────────────────┐
 Alexa / panels /         │ Signal Bridge (Node, NAS Docker)           │
 scheduler / admin push   │                                            │
 ────────────────────────►│ event ──► router ──┬─► UDP overlay path    │──► full displays
                          │                    │   (unchanged)         │
                          │                    │                       │
                          │                    └─► board formatters    │
                          │                        └─► frames          │
                          │                            └─► per-board   │
                          │                                queue       │
                          │                                └─► HTTP    │──► Cloud API (real board)
                          │                                            │──► /vestaboard-sim/api (simulator)
                          │ Signal web server :47810                   │
                          │   /admin (existing)  /admin/simulator (new)│
                          │   /vestaboard-sim/api (new mock endpoint)  │
                          └────────────────────────────────────────────┘
```

The invariant that keeps the simulator honest: everything from the router
to the HTTP client is the same code for a real board and for the
simulator. Only `baseUrl` and the token differ.

## 2. Module map

New code lives under `src/vestaboard/`. Follow the module and naming
conventions in `src/PROJECT.md`.

| Module | Responsibility |
|---|---|
| `src/vestaboard/index.js` | Wires the feature: loads board config, merges the registry, registers formatters, mounts the simulator routes, exposes `pushEvent(event)` and `pushCommand(commandId, params, target)` entry points |
| `src/vestaboard/encoder.js` | Text to character codes: folding, substitution, word wrap, hyphen split, validation. Pure functions, no I/O |
| `src/vestaboard/frames.js` | Frame builders: `lr`, `badgeFrame`, `borderFrame`, page footers, continuation chip, block digits for the clock. Pure functions |
| `src/vestaboard/formatters/` | One file per event family (alexa.js, tesla.js, gaming.js, feeds.js, signal.js). Each registers formatters into the router table |
| `src/vestaboard/router.js` | The `(event type, display kind)` capability table and the fan-out logic |
| `src/vestaboard/queue.js` | One queue instance per board: pacing, priority, coalescing, dedupe, quiet hours, retries, health |
| `src/vestaboard/transport.js` | The HTTP client speaking the Cloud API shape. Takes `{ baseUrl, token }` |
| `src/vestaboard/simulator.js` | Mock API state and route handlers, SSE broadcasting for the page |
| `src/vestaboard/replay.js` | The `npm run board-replay` command line tool |
| `src/web/simulator/` | The admin simulator page (HTML, JS, CSS in the existing Signal UI style) |

Integration points in existing code (resolve exact names via
`src/PROJECT.md`):

1. Where typed payloads are built and dispatched to displays: call
   `vestaboard.pushEvent(payload)` beside the existing UDP send. The board
   side decides for itself whether it cares.
2. The web server: mount `/vestaboard-sim/api/*`, `/vestaboard-sim/stream`
   (SSE), and the `/admin/simulator` page.
3. The display registry module: merge board entries (section 5).
4. The scheduler: the `target` field and per-class fan-out (section 8).
5. The Signal admin UI: picker, push-tab filtering, settings section,
   simulator tab (section 9).

## 3. Configuration

`data/config.json` gains one section:

```json
"vestaboards": {
  "boards": [
    {
      "id": "sim",
      "name": "Vestaboard Simulator",
      "simulator": true,
      "enabled": true,
      "mode": "cloud",
      "baseUrl": "http://127.0.0.1:47810/vestaboard-sim/api/",
      "dwellSeconds": 15,
      "quietHours": { "start": "22:00", "end": "07:00" },
      "minRotationGapSeconds": 600,
      "rateWindowSeconds": 15,
      "events": "all"
    }
  ]
}
```

Field rules:

- `id`: unique, stable, url-safe. Used in registry, scheduler targets, and
  the secrets file.
- `mode`: `cloud` only in this rev. The shape leaves room for `local`.
- `baseUrl`: optional. Defaults to the real Cloud API base. The simulator
  entry sets it to the local mock. This is also how tests point a "real"
  board at the mock.
- `dwellSeconds`: base dwell; the reading-time rule in 02 can raise it per
  frame up to 30.
- `quietHours`: local time, start may be after end (crosses midnight).
- `minRotationGapSeconds`: minimum spacing between scheduler-driven flips
  on this board. Alerts are exempt. Default 600.
- `rateWindowSeconds`: minimum spacing between any two posts to this
  board. Default 15 — matches the real service. The simulator endpoint
  reads the same value, so lowering it for fast integration tests keeps
  the sim and the queue in agreement without special-casing.
- `events`: `"all"` or an array of event type / command id strings.

Secrets: tokens are not stored in config. When a board is added in the
admin, the token is written to `data/vestaboard-secrets.json` (gitignored,
same trust level as `data/alexa-session.json`) keyed by board id. A board
may instead set `tokenEnv` naming an environment variable, which wins over
the secrets file. The simulator's token is generated on first boot with a
secure random source and stored the same way.

Settings changes apply live: saving rewrites config, updates the registry,
and starts or stops queues. No restart.

## 4. Frames and the formatter contract

A formatter turns one event into board frames:

```js
register({
  event: "broadcast",            // event type or scheduler command id
  kinds: ["vestaboard"],         // display kinds this formatter serves
  priority: "alert",             // "alert" or "snapshot"
  format(payload, ctx) -> Frame[] // pure; [] means nothing to show
});

Frame = {
  rows,          // 6 arrays of 22 integer character codes
  dwellSeconds,  // already includes the reading-time rule
  label,         // short human label, e.g. "Shopping 1/3"
  source         // event type + key fields, for the simulator page
}
```

`ctx` provides `now` (Date), the board's config, and read-only accessors
for the caches the full display already uses (`data/*.json`: shopping
list, timer mirror, weather, air quality, tesla, steam/psn/youtube
libraries, roll credits, trivia pool, upside archive). Formatters never do
network I/O; they read the same cached data the existing overlays read.

Returning `[]` is the empty-content signal: the router treats it exactly
like the scheduler's existing requires-content guard — skip silently. The
"explicit push shows an all-quiet frame" behavior is the formatter's job:
`ctx.explicit` is true for direct admin/voice pushes and false for
scheduler rotation, and the formatter returns the empty-state frame only
when `ctx.explicit` is true.

## 5. Registry

`data/displays-registry.json` currently holds only self-announced Windows
clients and can legitimately be empty. Boards are merged in as static
entries at startup and whenever settings change:

```json
{ "id": "sim", "name": "Vestaboard Simulator", "kind": "vestaboard",
  "simulator": true, "health": "ok" }
```

Existing client entries get `"kind": "full"` when read (treat a missing
kind as full for backward compatibility). Boards never come from
`display.announce` and are never expired by the announce timeout. The
picker's SSE updates fire on board add, remove, enable, disable, and
health change. The picker must render correctly when zero full displays
are online and boards exist — this is a real state, not an edge case.

## 6. Router

One table keyed by `(event type or command id, kind)`.

Fan-out for an event with target T:

1. Resolve T to a display list: a single id; `all` = every enabled
   display; class `full` or `vestaboard` = every enabled display of that
   kind.
2. For each display: `full` kind uses the existing UDP overlay path,
   untouched. `vestaboard` kind looks up the formatter; if none exists,
   skip and write one debug line ("no board formatter for <type>, skipped
   <board>"). If one exists, call it and hand the frames to that board's
   queue with the formatter's priority.

This one rule produces both required behaviors: push-to-all is safe by
default, and board-inappropriate content (posters, photos, video, web
pushes, library tours) never reaches a board because no formatter is
registered for it.

## 7. Queue

One queue object per enabled board. This is the heart of the feature; get
it right and the hardware will behave.

State per queue:

```
current          frame on the board now (or null)
lastSnapshot     last snapshot frame shown (for restore after an alert)
items[]          pending frames, each { frame, priority, notBefore }
lastPostAt       time of last accepted post
health           ok | degraded | unhealthy | offline
coalesce{}       per coalescing-key timestamps (section 7.4)
```

### 7.1 Accepting frames

- Snapshot sequence (multi-page content): appended in order; each page's
  `notBefore` = previous page's post time + its dwell.
- Alert: inserted at the head. Pending snapshot pages from an interrupted
  sequence are dropped (the sequence does not resume mid-list; the
  scheduler will bring it back). After the alert's dwell passes and the
  queue is empty, restore `lastSnapshot` so the board does not stay stuck
  on an old alert.
- Scheduler-sourced snapshots also check `minRotationGapSeconds` since the
  last scheduler-driven flip; too soon means drop, not delay.

### 7.2 Posting loop

Post the head item when all of these hold: `now >= lastPostAt +
rateWindowSeconds`, `now >= item.notBefore`, quiet hours allow it
(section 7.5), and the layout differs from `current` (identical layout is
dropped — the physical board would not flip anyway).

### 7.3 Errors and health

- HTTP 503: wait out the remainder of the rate window plus one second,
  retry the same frame. Expected during bursts; not an error to surface.
- Network error / 5xx other than 503: retry at 30s, then 60s. Three
  consecutive failures set health `unhealthy`; keep retrying the head
  every 5 minutes. Any success resets to `ok`.
- 401: set health `degraded` with reason "auth", stop posting, surface in
  the picker and settings. Do not retry-spin on a bad token.
- Health changes emit an SSE registry update so the picker shows it.

### 7.4 Coalescing

`smart-home.command` frames coalesce on key `(event type + device/entity)`
inside a 5-minute window: a newer frame for the same key replaces the
queued one instead of adding a second flip. The real log shows repeated
"lights on" commands minutes apart; the board flips once.

### 7.5 Quiet hours

Inside the window, only alarm fires and timer fires post. Everything else
is dropped at post time (not queued for morning — stale snapshots are
worse than none). The simulator page shows a quiet-hours badge when the
window is active.

## 8. Scheduler changes

- Each rule gains `target`: `"all" | "full" | "vestaboard" | "<displayId>"`.
  Migration: existing rules load with `target: "full"`, so nothing changes
  until a rule is edited. The rule editor gets a target selector.
- Fan-out uses the router (section 6), so a rule targeted at `vestaboard`
  with no board formatter for its command simply does nothing, loudly in
  debug logs only.
- Boards additionally enforce `minRotationGapSeconds` (7.1) so short
  intervals (the real config has a 5-minute trivia rule) cannot keep the
  flaps running continuously.
- The scheduler stats view records the resolved target class and per-board
  outcome (posted, skipped-gap, skipped-quiet, skipped-empty) for each
  run.

## 9. Signal UI changes

- Display picker: boards appear with the full displays; disabled boards
  are hidden; a health suffix shows degraded/unhealthy. All Displays is
  unchanged.
- Push tab: each operation declares the kinds it supports. Board selected:
  the list filters to board-capable operations. All Displays selected:
  full list; the router drops per-display mismatches.
- Settings, new "Vestaboards" section: list of boards with add/edit/remove.
  Fields: name, token (write-only field; stored per section 3), optional
  base URL (advanced), dwell, quiet hours, event allowlist, enabled. Each
  row has "Test flip" (queues the identity frame from 03-formatters) and
  the simulator row carries the on/off toggle described in 04.
- New "Simulator" tab linking to `/admin/simulator`.

## 10. Logging

Reuse the bridge's existing logging approach. Debug lines for: skip
(no formatter), skip (gap), skip (quiet), coalesce replace, dedupe drop,
503 wait, retry, health change. Never log tokens or full layouts at info
level; layouts at debug level are fine.
