# Vestaboard support + simulator — Signal Bridge requirements (rev 1)

Status: decisions locked, layouts validated against real caches and the live
event log (Aug 24, 2026). Ready to implement. Companion wireframes: the four
interactive mockup sets from the planning chat (board screens, real-data
recuts, Alexa intercepts, simulator page).

## 1. What we are building

Signal Bridge learns to drive a Vestaboard: a wall-mounted split-flap display
with 6 rows of 22 characters (132 total). Each flap cycles through 64 states:
uppercase letters, digits, a small set of punctuation, and seven solid color
chips. Boards are configured in the admin settings, join the display list next
to the Windows full displays, and can be targeted by pushes and by the
scheduler. A built-in simulator ships with the bridge so the whole feature can
be built and tested before the physical board arrives.

## 2. Locked decisions

1. Connection: Cloud API first. Local API is a follow-up mode (see 10).
2. Pacing: one flip per board per 15 seconds minimum. Page dwell is
   `max(12s, 1s per 10 characters)`, capped at 30s.
3. Quiet hours: 22:00–07:00 per board by default. During quiet hours the
   board does not flip, except alarm fires and timer fires, which always pass.
4. Trivia: strict single-frame gate. Measured against the real pool of 1,417
   questions, 158 pass (71 two-column, 2 stacked, 85 true/false). Questions
   that fail the gate are skipped. The two-frame question format is a
   possible follow-up, not in scope now.
5. Announcements (Alexa broadcasts) are the highest-priority feature. They
   get the three-tier rendering in section 6 and always preempt rotation.
6. Board-targeted scheduler rules default to sparser cadence than the full
   display (section 4.5).

## 3. Board constraints (why the design looks like this)

- Character set: blank (0), A–Z (1–26), digits 1–9 (27–35), 0 (36), then
  `! @ # $ ( ) - + & = ; : ' " % , . / ? °`, color chips red 63, orange 64,
  yellow 65, green 66, blue 67, violet 68, white 69, black 70, filled 71.
  Codes 43, 45, 51, 57, 58, 61 are unused. No lowercase. No asterisk, no
  angle brackets, no QR codes.
- The cloud rejects posts sent faster than about one per 15 seconds (503),
  and the board does not re-flip identical content. A full flip takes several
  seconds and is audible.
- No smooth scrolling exists. "Scrolling" is done by paging whole frames at
  reading speed. Never marquee.

## 4. Architecture

### 4.1 Display kinds and the registry

Every display gets a `kind`: `full` (existing Windows clients) or
`vestaboard`. Windows clients keep announcing themselves over UDP as today.
Boards cannot announce, so board entries are static config merged into
`data/displays-registry.json` at startup and on settings changes. The Signal
picker must render configured boards even when zero full displays are online
(the registry being empty is a real observed state).

### 4.2 Board config

Boards live in `data/config.json` under `vestaboards`, secrets in `.env`
like Tesla. Example:

```json
"vestaboards": [
  {
    "id": "sim",
    "name": "Vestaboard Simulator",
    "kind": "vestaboard",
    "simulator": true,
    "enabled": true,
    "mode": "cloud",
    "tokenEnv": "VESTABOARD_SIM_TOKEN",
    "baseUrl": "http://127.0.0.1:47810/vestaboard-sim/api/",
    "dwellSeconds": 15,
    "quietHours": { "start": "22:00", "end": "07:00" },
    "minRotationGapSeconds": 600,
    "events": "all"
  }
]
```

A real board is the same object with `simulator: false`, no `baseUrl`
(defaults to the Cloud API), and its own token env name. `events` is `all`
or an allowlist of event types.

### 4.3 Send path

One path for every board, real or simulated:

```
event/command -> router -> formatter (per event type, per kind)
             -> frames (6x22 code arrays + dwell + priority)
             -> per-board queue -> HTTP POST (Cloud API shape)
```

The router looks up `(event type, display kind)` in the formatter table.
Full displays keep the existing UDP overlay path untouched. No formatter
registered for a kind means skip that display and write one debug log line.
This is what makes push-to-all safe: a poster push to All Displays never
touches a board. Nothing anywhere special-cases the simulator except its
`baseUrl`.

### 4.4 Queue rules

- Per-board FIFO. Minimum 15 seconds between posts. On 503, retry after the
  window with backoff; after repeated failures mark the board unhealthy in
  the picker.
- Priority classes: `alert` (broadcast, alarm fire, timer fire, reminder
  fire, game start) preempts whatever is showing, holds 60s or its dwell,
  then the interrupted rotation resumes. `snapshot` content rotates normally.
- Coalescing: repeated `smart-home.command` events inside a 5-minute window
  collapse into one frame (real log shows doubles minutes apart).
- Dedupe: never post a layout identical to what the board is showing.
- Quiet hours: suppress everything except alarm and timer fires. Suppressed
  snapshots are dropped, not queued for morning.
- Empty content: a scheduled page with nothing to show is skipped silently
  (reuse the scheduler's existing `requires-content` guard semantics). An
  explicit push of an empty page shows the small "all quiet" frame instead.

### 4.5 Scheduler

Rules gain a `target`: `all`, `full`, `vestaboard`, or one display id.
`full` fans out to announced full clients, `vestaboard` to enabled boards.
Existing rules migrate to `full` so nothing changes until asked. Boards also
enforce `minRotationGapSeconds` (default 600) between scheduler-driven
flips so a 5-minute trivia rule cannot keep the flaps running; alerts are
exempt. The scheduler stats page records which target class each run hit.
Of the 15 current rules, 12 are board-eligible; the photo slideshow and both
library tours stay full-only.

### 4.6 Signal UI

- Display picker: boards listed with the full displays; All Displays
  unchanged.
- Push tab: every operation carries capability tags. Selecting a board
  filters the list to board-capable operations. Selecting All Displays shows
  everything; the router drops mismatches per display.
- Settings: a Vestaboards section to add/edit boards (name, mode, token,
  optional base URL, dwell, quiet hours, event allowlist), a Test flip
  button per board (sends the identity frame), and the simulator toggle.

## 5. Encoder

One module owns "what the board can show":

- Fold: uppercase everything; strip accents (SÃO -> SAO); curly quotes to
  straight; en/em dashes to `-`; trademark, copyright and similar marks are
  dropped; any other unmappable character is dropped.
- Wrap: word boundaries only, never mid-word. A single word longer than the
  row splits with a hyphen. Overflow beyond a frame's row budget creates a
  continuation frame.
- Validate: exactly 6 rows of 22 codes, every code in the legal set.
- Numbers: one decimal for averages, whole numbers for temperatures, wind,
  pressure, and times; large counts abbreviate (37,285 -> 37K).
- Data hygiene: skip null fields silently; skip provider placeholders (PSN
  "Old Game"); names longer than their column truncate with no marker.

## 6. Frame design system

- Info frames: two color chips in each top corner plus a title; row 6 is a
  footer for status, timestamps, or a `1/3` page counter. Cached/stale data
  puts an orange chip before the footer time.
- Alert frames: full one-color border, content inside up to 4 rows of 18.
  Multi-frame alerts mark every non-final frame with a yellow chip in the
  bottom-right border corner.
- Color meanings: red = Tesla, firing alerts, YouTube. Orange = timers.
  Yellow = alarms list, trivia, The Upside. Green = shopping, darts, good
  air. Blue = Steam, PSN, wifi, weather, flights. Violet = music and
  announcements. White = Wikipedia, Roll Credits, smart home, reminders.
  Air-quality bands map good/fair/poor/bad to green/yellow/orange/red.
- Announcements, three measured tiers (of 292 real broadcasts: 82% tier 1,
  9% tier 2, 9% tier 3): tier 1 fits 3 rows -> one frame with the device
  named; tier 2 fits 4 rows -> one frame, device line dropped; tier 3 ->
  two frames with the continuation chip. Messages render verbatim.
- Lists order by usefulness: timers and alarms soonest first, flights
  closest first, shopping newest last.

## 7. Event coverage

Board-capable (formatter exists for kind `vestaboard`):

| Source | Types / commands |
|---|---|
| Alexa | broadcast, time.query, smart-home.command, timer.snapshot + fires, alarm.snapshot + fires, reminder.fired, shopping-list.snapshot, weather.query, indoor-temperature.query, air-quality.query, music.playing, alexa-notifications.query, vivint-alarm.query |
| Tesla | tesla-dashboard.query, tesla-battery.query |
| Gaming | steam now/last-played, psn now/last-played, autodarts start/end/dashboard, credits.show (Roll Credits) |
| Feeds | youtube now/last-played, goodnews.show (The Upside), wiki.show, overhead.show, trivia.show (gated) |
| Signal | guest snaps (text form: wifi, password, typed URL — no QR) |

Full-display only (router skips boards): photo slideshows and single photos,
movie posters, cover art and screenshots, YouTube thumbnails, Ring video,
web.open, remote input, library tours. A Ring ding can still become a text
alert later.

Known data notes: `music.playing` events carry only the voice trigger — the
formatter reads the same track payload the full display overlay uses.
`steam.now-playing` carries an appId and `youtube.now-playing` a videoId;
both resolve names/stats through the library caches. YouTube shows views,
likes, and the mirrored dislikes.

## 8. Simulator

### 8.1 Purpose and invariant

Test the whole feature with no hardware. The invariant: the send path is
identical to a real board; only the base URL differs. If it works on the
simulator, the only untested thing is Vestaboard's server.

### 8.2 Mock API

Mounted on the existing Signal web server (same service, same port 47810)
at `/vestaboard-sim/api/`, speaking the Cloud API shape:

- `POST /` with header `X-Vestaboard-Token`. Body: `{"text": "..."}` or a
  6x22 array of character codes (the bridge always sends arrays). Returns
  the documented Cloud API success shape with a generated message id.
- `GET /` returns the current message and layout in the documented shape.
- Errors, matched to the real service: 401 wrong/missing token, 400 bad
  dimensions or illegal codes, 503 when a post arrives less than 15 seconds
  after the last accepted one, 503 when the simulator is toggled off.
- Identical layout to the current one: accepted, no flip.
- The sim token is generated into `data/` on first boot and shown in
  settings.

Follow-up flag (with Local API mode): `vestaboardSim.localApiPort` opens a
second listener on the board's real local port speaking the Local API shape,
so the sim looks exactly like a physical board on the LAN.

### 8.3 Pre-registered device and toggle

Ships with the `Vestaboard Simulator` board entry from 4.2, enabled by a
settings toggle. On: it appears in the picker and in scheduler targets like
any board. Off: hidden from the picker and the endpoint answers 503 — the
toggle doubles as fault injection for retry and error-path testing.

### 8.4 Simulator page

`/admin/simulator` (a Simulator tab in the admin). Contents:

- A faithful board render: 6x22 tiles, dark bezel, split-flap animation on
  changed tiles only (per-column stagger, roughly 2–4 seconds for a full
  sweep), color chips, all-caps glyphs.
- Status strip: Online/Offline pill, rate-limit countdown ("next flip
  allowed in Ns"), quiet-hours badge when active.
- Queue card: pending frames with their source event and dwell.
- Call log: the last requests with method, auth result, and status
  (200 / 400 / 401 / 503).
- Live updates over SSE (Server-Sent Events — the one-way live update
  stream from server to browser that the display picker already uses).
- Works well on a phone; Signal is a phone UI.

### 8.5 Replay tool

`npm run board-replay -- --file data/voice-events.jsonl --last 50 --speed 10`
feeds logged events through the real router as if they were live, at an
accelerated pace, targeting the simulator. This is the main integration
test: the real family traffic, replayed.

## 9. Testing plan

- Unit: encoder golden tests — every layout in Appendix A is a fixture; the
  formatter output must match code-for-code.
- Unit: gate tests — the trivia gate against the real pool must pass exactly
  the measured 158; announcement tiering against the 292 logged broadcasts
  must match the 238/26/28 split.
- Integration: replay tool against the simulator; assert queue order, 15s
  spacing, alert preemption, coalescing, quiet hours, dedupe.
- Manual checklist: add board, test flip, push each operation from Signal,
  toggle sim off mid-push, schedule a board-targeted rule, verify All
  Displays skips board-inappropriate pushes.

## 10. Out of scope (this rev)

Local API transport (follow-up mode, config already shaped for it), VBML,
Vestaboard Note sizes, multi-board synchronized content, Ring text alerts,
the two-frame trivia format, weather severe alerts.

## 11. Commit plan

Phase 1 — encoder and frame model

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

Phase 2 — simulator service

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

Phase 3 — simulator page

```
add the simulator page to signal admin

Renders the board with the flap animation and live
updates over the existing SSE stream. Shows the queue,
the rate limit countdown, and the last API calls.
```

Phase 4 — board adapter

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

Phase 5 — Alexa formatters

```
add board formatters for alexa events

Broadcasts with the three length tiers, the block digit
clock, device on and off, timers, alarms, reminders,
shopping list, weather, indoor temp, air quality, music,
notifications, and vivint.
```

Phase 6 — panel formatters

```
add board formatters for panels

Tesla dashboard and battery, steam and psn now and last
played, youtube with likes and dislikes, roll credits,
autodarts live and dashboard, upside, wiki, overhead,
guest snaps, and the gated trivia.
```

Phase 7 — routing and Signal UI

```
route pushes by display kind

Formatters register per event and kind. Push to all
skips displays with no formatter and logs one line.
The picker filters operations by the selected display.
```

Phase 8 — scheduler targets and replay

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

## Appendix A — frame layouts

Notation: rows are 22 characters, right-padded with blanks. Lowercase
letters are color chips: r red, o orange, y yellow, g green, b blue,
v violet, w white. Everything else is a literal flap character. These are
the golden fixtures for the encoder tests; data values are examples from
the real caches and log.

Connection test (settings Test flip)

```
ww SIGNAL BRIDGE    ww

  VESTABOARD LINKED
  KITCHEN BOARD - OK

 roygbvw    roygbvw
```

Announcement — tier 1, short (centered, device named)

```
vvvvvvvvvvvvvvvvvvvvvv
v                    v
v        KYLIE       v
v                    v
v MOVIE THEATER ECHO v
vvvvvvvvvvvvvvvvvvvvvv
```

Announcement — tier 2, standard (wrapped, device named)

```
vvvvvvvvvvvvvvvvvvvvvv
v 'I LOVE YOU DADDY  v
v  TAKE CARE OF MY   v
v  TEDDY BEAR'       v
v  MASTER BATH ECHO  v
vvvvvvvvvvvvvvvvvvvvvv
```

Announcement — tier 3, long (two frames; yellow corner chip = more)

```
vvvvvvvvvvvvvvvvvvvvvv
v TOMMY WHEN         v
v WHENEVER YOU GUYS  v
v ARE DONE WITH      v
v MINECRAFT COME     v
vvvvvvvvvvvvvvvvvvvvvy
```

```
vvvvvvvvvvvvvvvvvvvvvv
v COME TO THE MOVIE  v
v THEATER AND BRING  v
v THE EXTRA GAME BY  v
v THAT YOU HAVE      v
vvvvvvvvvvvvvvvvvvvvvv
```

Time (block digits, yellow colon, ephemeral ~15s)

```
    www   www www
    w w y w w w
    www   w w www
      w y w w   w PM
    www   www www
ww SUNDAY AUG 23    ww
```

Smart home — on / off (green chip marks on)

```
ww SMART HOME       ww

 KYLIE BEDROOM
 LIGHTS: ON g

ww 9:56PM           ww
```

```
ww SMART HOME       ww

 MOVIE POSTER: OFF
 VIA OFFICE ECHO

ww 9:46AM           ww
```

Timers — list and fire

```
oo TIMERS           oo
 PIZZA          12:34
 LAUNDRY        48:10
 SOUS VIDE    1:22:05

oo 3 RUNNING        oo
```

```
oooooooooooooooooooooo
o                    o
o  PIZZA TIMER DONE  o
o  TIME'S UP!        o
o                    o
oooooooooooooooooooooo
```

Timers — explicit push, empty

```
oo TIMERS           oo

  NO TIMERS RUNNING


oo ALL QUIET        oo
```

Alarms — list and fire

```
yy ALARMS           yy
 7:00AM  BEDROOM ECHO
 TOMORROW


yy NEXT IN 23H 57M  yy
```

```
rrrrrrrrrrrrrrrrrrrrrr
r                    r
r  WAKE UP - 6:30AM  r
r  RISE AND SHINE!   r
r                    r
rrrrrrrrrrrrrrrrrrrrrr
```

Reminder fired

```
wwwwwwwwwwwwwwwwwwwwww
w  REMINDER:         w
w  CHECK ON CORN     w
w  IN SMOKER         w
w  KITCHEN ECHO      w
wwwwwwwwwwwwwwwwwwwwww
```

Shopping list (4 items per page when longer)

```
gg SHOPPING LIST    gg
 COMPANY Q. TEN
 EGGS


gg 2 ITEMS          gg
```

Weather

```
bb WEATHER          bb
 NOW 93° SUNNY
 HIGH 96° LOW 66°
 WINDY PM - 28 MPH

bb TUE 93° RAIN 6%  bb
```

Indoor temperature

```
bb INDOOR TEMP      bb
 TOP FLOOR        75°
 MAIN FLOOR       76°
 MACHINE ROOM     71°

bb HUMIDITY 34%     bb
```

Air quality (band chips per sensor, footer as insight line)

```
gg AIR QUALITY      gg
 MAIN FLOOR   99g 76°
 MACHINE ROOM 99g 71°
 DOME        66y 114°

gg DOME RUNNING HOT gg
```

Now playing (music)

```
vv NOW PLAYING      vv
 KHRUANGBIN
 A LA SALA
 'MAY NINTH'

vv SONOS KITCHEN    vv
```

Notifications

```
yy NOTIFICATIONS    yy
 2 NEW
 AMAZON: PACKAGE
 DELIVERED TODAY

yy                  yy
```

Vivint

```
ww VIVINT           ww

 SYSTEM: ARMED STAY g


ww 10:37PM          ww
```

Tesla dashboard (row 3 = drive/park/charge state; orange chip on footer
time when serving cache)

```
rr TESLA MODEL Y    rr
BATT 73%  RANGE 201MI
PARKED - NOT PLUGGED
IN 88°  OUT 91°
LOCKED - SENTRY ON
rr 2:38PM           rr
```

Tesla battery (18-slot gauge, filled to charge)

```
gg TESLA BATTERY    gg

 73% - 201 MI RANGE
 (ggggggggggggg    )
 NOT PLUGGED IN
gg AS OF 2:38PM     gg
```

Guest snaps (values from config; no QR on a board)

```
bb GUEST SNAPS      bb
 WIFI CASA-GUEST
 PASS SUNNY-TRAILS24

 SHARE PHOTOS AT:
b 192.168.1.10:47810 b
```

Steam — game start and last played

```
bb STEAM            bb
 NOW PLAYING:
 HOTSHOT RACING

 LAUNCHED 7:42PM
bb GAME ON!         bb
```

```
bb STEAM            bb
 LAST PLAYED:
 HOT WHEELS UNLEASHED

 AUG 22 - 10:45PM
bb 707 GAMES OWNED  bb
```

PSN — last played (placeholder titles skipped)

```
bb PLAYSTATION      bb
 LAST PLAYED:
 SPLIT FICTION

 ON AUG 17
bb                  bb
```

YouTube (+ likes, - dislikes, footer = client device)

```
rr YOUTUBE          rr
 SHOULD YOU BUILD A
 GAMING SERVER?
 JAKE SIMMONS
 37K VIEWS 1482+ 12-
rr MOVIE THEATER TV rr
```

Roll Credits

```
ww ROLL CREDITS     ww
 29 GAMES BEATEN
 LAST - AUG 22 ON PC
 CONTRA: OPERATION
 GALUGA
ww 18 ON ARCADE     ww
```

Autodarts — start, end, dashboard

```
gg AUTODARTS        gg
 GAME ON - 501
 LUIS VS SAM
 FIRST TO 3 LEGS

gg THROW SHARP      gg
```

```
gg AUTODARTS        gg
 y TRASHPANDA WINS y
 VS WAR D - 2-1 LEGS
 AVG 26.4  HIGH 60
 CHECKOUT 51
gg NICE DARTS       gg
```

```
gg AUTODARTS        gg
 42 MATCHES  57 LEGS
 TRASHPANDA AVG 68.3
 HIGH OUT 51  180S 1
 RIVALRY WAR D 11-4
gg LAST GAME AUG 2  gg
```

Trivia — question and reveal (single-frame gate)

```
yy TRIVIA    GENERAL yy
 WHAT IS THE ZODIAC
 SYMBOL FOR GEMINI?
 A TWINS    B FISH
 C SCALES   D MAIDEN
yy ANSWER IN 30S    yy
```

```
yy TRIVIA    GENERAL yy
 WHAT IS THE ZODIAC
 SYMBOL FOR GEMINI?
 g A TWINS  B rrrr
 C rrrrrr   D rrrrrr
yy A - TWINS!       yy
```

The Upside — intro and story (1 frame for 52% of real headlines,
2 for the rest, never more)

```
yy THE UPSIDE       yy

  GOOD NEWS ONLY
  5 STORIES TODAY

yy                  yy
```

```
yy THE UPSIDE   1/5 yy
FIRST RIVER OTTER
SPOTTED IN THE BRONX
IN 100 YEARS ALONG
THE BRONX RIVER
yy                  yy
```

Wiki Common Knowledge — intro and article

```
ww WIKIPEDIA        ww

  COMMON KNOWLEDGE
  TOP READS TODAY

ww                  ww
```

```
ww WIKI READS   2/5 ww
 THE ANTIKYTHERA
 MECHANISM

 A 2000 YEAR OLD
ww ANALOG COMPUTER  ww
```

Overhead (closest first, route as ORIGIN-DEST)

```
bb OVERHEAD         bb
 UA1642  SFO-DEN
  34000FT  2MI NE
 DL889   LAX-JFK
  38000FT  9MI SW
bb 2 OVERHEAD NOW   bb
```
