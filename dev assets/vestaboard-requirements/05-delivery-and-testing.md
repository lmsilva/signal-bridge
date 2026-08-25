# 05 — Delivery plan and testing

Eight phases, thirteen commits. Each phase ends with `npm test` green and
its acceptance criteria met before the next begins. Commit messages below
are the messages to use — short casual subject, two-to-four line plain
body.

## Phase 1 — encoder and frame model

```
add vestaboard character encoder

Maps text to the board's 0-71 codes. Uppercases, strips
accents, drops what the board can't show. Word-wraps and
splits long content into 6x22 frames.
```

```
add frame builder helpers and golden tests

Corner-badge and border frame builders, page counters,
the color letter notation from the spec. Golden tests
lock every layout in the requirements appendix.
```

Accept when: every fixture in the package passes `validate`; the folding
table in 02 §2 has a test per row; wrap never breaks a word; the three
measured limits in 02 §6 reproduce exactly (238/26/28, 84/79/0, 158).

## Phase 2 — simulator service

```
add vestaboard simulator endpoint

Mock of the Cloud API on the Signal server. Same calls,
same headers, same errors: 401 bad token, 400 bad layout,
503 inside the 15 second window or when toggled off.
```

```
register the simulator as a board

Ships enabled with a generated token. Settings toggle
hides it from the picker and makes the endpoint answer
503 so error paths can be tested on purpose.
```

Accept when: contract tests cover every response in 04 §2 (200 flip, 200
duplicate no-flip, 400, 401, both 503s, GET current); the token never
appears in any log line during the test run; toggling emits a registry
SSE update.

## Phase 3 — simulator page

```
add the simulator page to signal admin

Renders the board with the flap animation and live
updates over the existing SSE stream. Shows the queue,
the rate limit countdown, and the last API calls.
```

Accept when: a curl POST of a valid layout flips the page within a
second; changed-tiles-only animation verified by posting two layouts
differing in one row; page is usable on a phone width; offline state dims
the board and logs 503s.

## Phase 4 — board adapter

```
add the board send queue

One queue per board. 15 seconds minimum between posts,
alerts preempt rotation, repeats coalesce, identical
layouts are not resent. Retries on 503 with backoff.
```

```
add board settings and registry merge

Boards are static config merged into the display
registry with kind vestaboard. Settings tab adds and
edits boards and has a test flip button.
```

```
add quiet hours

Boards go silent 22:00 to 07:00 by default. Alarm and
timer fires still pass. Suppressed pages are dropped,
not saved for morning.
```

Accept when: queue unit tests cover pacing, alert preemption with
lastSnapshot restore, coalescing, dedupe, the retry/backoff table, and
health transitions (ok, degraded on 401, unhealthy after three failures,
recovery); settings changes apply without restart; the picker renders
boards with zero full displays online; Test flip shows the identity frame
on the simulator page.

## Phase 5 — Alexa formatters

```
add board formatters for alexa events

Broadcasts with the three length tiers, the block digit
clock, device on and off, timers, alarms, reminders,
shopping list, weather, indoor temp, air quality, music,
notifications, and vivint.
```

Accept when: every 03 §A fixture passes; the broadcast tier split over
the real log reproduces 238/26/28; timer and alarm fires post during
quiet hours in a test and nothing else does; an empty timer list returns
`[]` in rotation and the all-quiet frame when explicit.

## Phase 6 — panel formatters

```
add board formatters for panels

Tesla dashboard and battery, steam and psn now and last
played, youtube with likes and dislikes, roll credits,
autodarts live and dashboard, upside, wiki, overhead,
guest snaps, and the gated trivia.
```

Accept when: every 03 §B–E fixture passes; the trivia gate passes exactly
158 of the real pool; PSN placeholder skipping proven with the real cache
("Old Game" never renders); the Upside two-frame maximum proven over the
real archive; YouTube omits the device when the link reports needs-relink.

## Phase 7 — routing and Signal UI

```
route pushes by display kind

Formatters register per event and kind. Push to all
skips displays with no formatter and logs one line.
The picker filters operations by the selected display.
```

Accept when: a photo push to All Displays reaches full displays and never
produces a board HTTP call (asserted via the sim call log); selecting the
simulator in the picker hides non-board operations; the debug skip line
appears exactly once per skipped display.

## Phase 8 — scheduler targets and replay

```
add scheduler targets for boards

Rules pick all, full displays, vestaboards, or one
display. Boards keep a minimum gap between scheduled
flips so short rules can't run the flaps nonstop.
```

```
add the event replay tool

Feeds a slice of voice-events.jsonl through the real
router at speed, aimed at the simulator. Used as the
main integration test.
```

Accept when: existing rules load as target full and behave exactly as
before; a 5-minute rule targeted at the sim flips at most once per
`minRotationGapSeconds`; an alert during the gap still posts; the stats
view records per-board outcomes; `npm run board-replay` over the last 50
real events exits 0 with the sim's `rateWindowSeconds` lowered.

## Test plan summary

- Golden fixtures: one JSON file per layout —
  `{ "name", "event": <input payload>, "explicit": bool,
  "frames": [{ "rows": [[codes]], "dwellSeconds", "label" }],
  "priority" }`. Inputs are the real payload examples in 03.
- Measured-limit tests: the three datasets (broadcast log slice, upside
  archive, trivia pool) ship as test data; the splits are asserted
  numbers, not tolerances.
- Contract tests: the sim endpoint against 04 §2, plus one skipped-by-
  default test that can run the same assertions against the real Cloud
  API with a real token, for the day the board arrives.
- Integration: the replay tool in CI against the simulator.
- Manual QA checklist before calling it done:
  1. Add the sim board fresh (delete secrets file, boot, token appears).
  2. Test flip → identity frame animates on the page.
  3. Push each board-capable operation from Signal to the sim.
  4. Push a photo to All Displays → full display shows it, sim call log
     stays silent.
  5. Toggle the sim off mid-sequence → 503s in the log, health degrades,
     toggle on → recovery and the queue drains.
  6. Set quiet hours to now → snapshots drop, fire a timer → it posts.
  7. Create a vestaboard-targeted rule at a short interval → observe the
     rotation gap holding.
  8. Run the replay tool over the last 50 real events and watch the page.
