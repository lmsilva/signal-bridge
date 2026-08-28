# Movie Theater "Now Playing" on the Vestaboard — Signal Bridge requirements (rev 2)

Status: **implemented 2026-08-28** as **Feature Presentation** (D1). D2–D4
landed as recommended: live play/stop and explicit Push honour
`plex.quietHoursExempt` (default true); scheduler-driven frames always
respect 22:00–07:00; `pushOnStop: true`; no pin while playing. Command ids
are `plex.*`. Companion mockups sit beside this file.

Read first: `src/PROJECT.md`, then `dev assets/vestaboard-requirements/`
(especially `01-architecture.md` and `02-encoding-and-design.md`). This feature
builds on that stack and does not change it.

---

## 1. What we are building

The bridge learns to watch the house Plex server (Plex is the local media
server that holds the movie library) and to notice when the movie theater
Apple TV starts or stops a movie. When a movie starts, every enabled
Vestaboard flips to a cinema "NOW PLAYING" frame: a red theater curtain
framing the movie title, its rating, and when it started and when it
should end. The frame stays on the board until something else replaces it.
When the movie stops, the curtain goes dark — only the side rails stay red
— around a "LAST PLAYED" frame. Both can also be brought
back by hand from the Signal push tab or on a schedule, like Steam and PSN
now-playing.

Hard boundary: **this feature never touches the full displays.** The movie
poster app already owns "what is playing" on the poster screen and keeps
working exactly as it does today. Nothing here sends UDP, registers a
full-display formatter, or marks a display busy. Vestaboards only.

Which device counts as "the theater" is configuration: the watcher only
reacts to Plex sessions whose player IP address (the device's address on the
LAN) is in a configured list — the same lock-to-one-device approach the
poster app uses.

## 2. Decisions to confirm

Defaults are chosen so the feature works as described in §1; these four are
the calls Luis should sign off on (or flip) before implementation starts.

**D1 — Feature name.** Recommended: **Curtain Call** — it names the chosen
design and fits the two-word house style (Roll Credits, Flight Plan).
Alternates: Now Showing, Feature Presentation, Matinee. Command ids stay
`plex.*` either way, so the name only affects UI labels and doc titles.

**D2 — Quiet hours.** The locked board rule is 22:00–07:00 with only alarm
and timer fires exempt. Movies mostly happen at night, so that rule as-is
would silence the main use case. Recommended: when `plex.quietHoursExempt`
is `true` (the default), live play/stop events and explicit admin pushes
carry the queue's per-item exemption; scheduler-driven plex frames always
respect quiet hours. Set it `false` to keep the original rule untouched.
This widens a locked decision, so it needs an explicit yes.

**D3 — Push on stop.** When the movie stops, push the LAST PLAYED frame
(default `pushOnStop: true`). The alternative — leave NOW PLAYING up until
other content arrives — reads as stale. Recommended: push it.

**D4 — Pin while playing.** Should an active movie block scheduler rotation
on the boards so the frame holds for the whole film? Recommended: **no**.
Luis said "until something else gets pushed," the scheduler already owns the
board's rhythm, and a scheduler rule on `plex.now-playing` can bring the
frame back on whatever cadence he likes. No pinning mechanism is built.

## 3. What this builds on

The whole Vestaboard stack exists and is tested: `src/vestaboard/`
(encoder, frames, notation, queue, router, transport, settings, simulator,
replay) plus formatters. This feature adds, and only adds:

- one frame builder (`cinemaFrame` in `src/vestaboard/frames.js`),
- one formatter module (`src/vestaboard/formatters/cinema.js`),
- one watcher service (`src/plex-api.js`, `src/plex-now-playing.js`,
  `src/plex-credentials.js`),
- commands, routes, one admin settings section, config, tests, docs.

The closest sibling is the Steam/PSN pattern (`src/steam-*.js`,
`formatters/gaming.js`): a poller keeps session state and emits a typed
payload; a formatter turns that payload into frames. Copy the shape, not
the priority: Steam's game-start frame is an **alert** (it preempts, holds
60 seconds, then the queue restores the last snapshot). The movie frame is
the opposite — it must *stay*. So every cinema frame is a **snapshot**.
Queue mechanics then do the rest for free: the frame becomes
`lastSnapshot`, later alerts (a timer firing, a broadcast) interrupt and
restore it, and it lives until the next snapshot replaces it. That is
exactly "stays until something else gets pushed," with zero new queue code.

## 4. Watching Plex

### 4.1 Connecting

Poll the server's sessions endpoint on the LAN. One request per poll:

```
GET {plex.serverUrl}/status/sessions
  X-Plex-Token: <token>
  Accept: application/json
  X-Plex-Client-Identifier: signal-bridge
  X-Plex-Product: Signal Bridge
  X-Plex-Version: <bridge version>
```

The token is Plex's per-account access key (their support article "Finding
an authentication token / X-Plex-Token" shows how to grab one from the web
app). Storage follows the house credential pattern (`secret-box.js`, same
as Guardian and AeroDataBox): a `PLEX_TOKEN` environment variable wins;
otherwise the token entered in admin settings is encrypted into
`data/plex-credentials.json`. The token never appears in `config.json` or
in logs.

Why polling and not Plex webhooks (webhooks = Plex calling us on events):
webhooks require an active Plex Pass subscription, their payload does not
reliably carry the player's LAN IP (the field is a public address), and the
bridge's house pattern for every other source is a poller against cached
state. Polling `/status/sessions` gives the IP, the playback position, and
the duration in one call, needs no subscription, and costs one small LAN
request every 15 seconds. Reference for the endpoint: the official server
API docs at developer.plex.tv/pms.

### 4.2 What we read

From each entry in `MediaContainer.Metadata[]` (Appendix B shows the
shape; verify field presence against the live server — casing and extras
vary between server versions):

| Field | Used for |
|---|---|
| `type` | keep only values in `plex.mediaTypes` (default `["movie"]`) |
| `title` | the movie title on the frame |
| `contentRating` | e.g. `PG-13`, `R` — the rating row |
| `rating`, `audienceRating` | critic score 0–10; `rating` first, `audienceRating` as fallback |
| `duration`, `viewOffset` | milliseconds; end-time math |
| `sessionKey` | identity of one playback session |
| `Player.address` | the device filter (LAN IP) |
| `Player.title`, `Player.product`, `Player.state` | device label; `playing` / `paused` |

### 4.3 Device filter

A session qualifies when its `type` is allowed **and** `Player.address` is
in `plex.monitoredPlayers`. Everything else is invisible to this feature —
someone streaming on a phone changes nothing on the boards. If several
qualifying sessions exist at once (rare), take the one that started most
recently. IP is the filter because it is what the theater Apple TV pins in
the poster app already; give the Apple TV a DHCP reservation so the address
holds still.

### 4.4 Session state machine

One state per monitored player, persisted in `plex.stateFile`
(`data/plex-now-playing.json`).

| From | Poll shows | Do |
|---|---|---|
| idle | qualifying session, state `playing` | record `startedAt` = now, compute `endsAt`; emit **now-playing** |
| playing | same session, `paused` | note it; emit nothing (the frame is still true) |
| playing/paused | same session, `playing`, position moved by pause or seek | recompute `endsAt`; if it drifts ≥ `repushEndDriftMinutes` from what the board shows, emit **now-playing** again |
| playing/paused | different movie on the same player | treat as stop + play in one poll |
| playing/paused | session absent or state `stopped` on **successful** polls for ≥ `stopGraceMs` | write the last-played record; if `pushOnStop`, emit **last-played** |
| any | poll failed (network, 5xx) | keep state, count the failure, never emit — a dead Plex server is not a stopped movie |

Notes. The grace clock only advances on successful responses, so a server
reboot mid-movie cannot fake a stop. On bridge restart, if the state file's
`sessionKey` is still playing, keep the original `startedAt` and re-emit —
the queue drops identical layouts, so this is free. Small position drift
(the normal creep of `viewOffset` between polls) is not a seek; only jumps
beyond `pollIntervalMs` plus slack count.

### 4.5 Times

- `startedAt` = wall time the watcher first saw the session playing.
- `endsAt` = that moment plus (`duration` − `viewOffset`). Recomputed on
  resume and after seeks; the board only re-flips when the shown end time
  would move by `repushEndDriftMinutes` or more (default 5 — a bathroom
  pause should not flip the house).
- All display formatting uses the house clock helpers
  (`src/vestaboard/clock.js`) with `plex.localTimeZone`, falling back to
  `voiceEvents.localTimeZone`. Times render minute-precision, house style,
  no space before AM/PM: `9:05PM`.

### 4.6 Failure handling and health

Timeout 8 seconds per poll. Three consecutive failures mark the source
unhealthy; keep polling at the normal interval and surface "Plex
unreachable" in the settings section. A `401` means the token is bad: show
"auth" in settings, slow polling to every 5 minutes, and never spin.
Recovery on any success. The boards are never cleared or changed because
Plex is down — the last frame simply stands.

## 5. Events, commands, and targeting

### 5.1 Payload

One event type, mirroring the Steam shape:

```js
{
  type: 'plex.now-playing',
  plex: {
    mode: 'now-playing',            // or 'last-played'
    title: 'Interstellar',
    contentRating: 'PG-13',         // null when Plex has none
    criticScore: 8.7,               // null when Plex has none
    startedAt: '2026-08-28T21:05:12-06:00',
    endsAt:    '2026-08-28T23:54:00-06:00',  // now-playing only
    endedAt:   null,                          // last-played only
    player: { address: '192.168.50.71', name: 'Movie Theater' }
  }
}
```

### 5.2 Vestaboard-only delivery

The watcher hands payloads to the same fan-out every service uses
(`listener.js`), **always with target `vestaboard`**. The existing
`isVestaboardOnlyTarget` check then skips UDP and `displayBusy` entirely,
and no full-display formatter is registered — two independent guarantees
that the poster app never sees this. Per-board `events` allowlists still
apply, so a bedroom board can opt out of movies while the hallway board
shows them.

### 5.3 Commands

Two entries in `src/command-registry.js`, following the Steam descriptors:

| id | title / subtitle | behavior |
|---|---|---|
| `plex.now-playing` | Movie Theater / "Now playing, or last played" | no mode in the body → **auto**: active session → NOW PLAYING, else stored last-played → LAST PLAYED |
| `plex.last-played` | Movie Theater / "The last movie watched" | forces the last-played record |

Both are `pushable` and `schedulable`, share route
`/api/push/plex-now-playing`, and set `supportsContentCheck`: content
exists when there is an active qualifying session or a stored last-played
record. Scheduler rotation with neither skips silently; an explicit push
with neither shows the empty frame (§6.6, `ctx.explicit` only — the house
rule). Router additions: register the formatter for type
`plex.now-playing`; map both command ids to that type in
`COMMAND_TO_TYPE`. Optional parity nicety: a `display-voice-commands`
matcher ("movie now playing") with `requestedMode: 'auto'`, like Steam and
YouTube have.

### 5.4 Quiet hours wiring (per D2)

The queue already supports a per-item exemption (`quietHoursExempt` on the
submitted item; `index.js` sets it in one existing path). When
`plex.quietHoursExempt` is true, set it for frames born from live events
and explicit pushes; never for scheduler-driven ones. No change to the
global exempt list.

## 6. The cinema frame

A third frame type joins badge and border frames: `cinemaFrame`, built in
`src/vestaboard/frames.js` and reserved for this feature. It is a red
theater curtain framing the show details — a cousin of `borderFrame` on
purpose, but its own builder: the content span is wider (20 columns, not
18), every line is centered rather than left-padded, and it has a darkened
second state no alert border has.

### 6.1 Anatomy

Two states. NOW PLAYING is the full curtain — solid red top and bottom
rows, red side rails, content centered between them:

```
row 1  rrrrrrrrrrrrrrrrrrrrrr   solid red
row 2  r ................. r    header
row 3  r ................. r    ┐
row 4  r ................. r    │ content (title, rating, times)
row 5  r ................. r    ┘
row 6  rrrrrrrrrrrrrrrrrrrrrr   solid red
```

LAST PLAYED and the empty frame use the dark curtain: rows 1 and 6 drop
to side rails (`r`, 20 blanks, `r`), taking the frame from 44 red chips
to 12 — readable across a room as "the show is over."

Builder contract:

```js
cinemaFrame({ border: 'full' | 'sides', rows })   // rows: up to 4 entries
```

- `border: 'full'` — rows 1 and 6 are 22 red chips; rows 2–5 carry a red
  chip in the first and last column with 20 content columns between.
- `border: 'sides'` — every row carries only the two side chips; rows 1
  and 6 are empty rails.
- Content rows follow the same row-entry conventions as `badgeFrame`
  (plain strings, or placed entries when a chip sits inside the text, as
  the rating row needs). Every row is centered across the 20 content
  columns; odd padding puts the extra blank on the right. More than four
  rows, or a row wider than 20, throws.
- Validate every frame with `assertValidLayout`, like the other builders.

### 6.2 Colors

| Element | Chips | Why |
|---|---|---|
| Curtain (both states) | red | The theater curtain — and red already means video in the fixed color grammar (YouTube), so cinema joins that family. |
| Rating separator | white | One white chip between content rating and score; white stays quiet inside all that red. |
| Dark state | side rails only | Rows 1 and 6 lose their red — house lights down, show over. |

One grammar note for reviewers: a full one-color border is also the alert
frame's silhouette. The cinema frame claims red-border-with-centered-
content as its own look and posts as a persistent snapshot, so the two do
not blur in practice — alerts flash and restore; the curtain stays.

The mockup images approximate the physical flap colors as red `#E23F33`
and white `#EDEBE6` on the near-black board. Those hex values exist only
for mockups; the board renders real painted flaps.

### 6.3 Text rules

- Everything passes the encoder's `fold` first (uppercase, accents
  stripped, symbols with no flap dropped) — `WALL·E` → `WALL E` territory.
- **Title fit.** The content span inside the curtain is 20. After
  folding: fits 20 → one line (layout A). Longer → two lines (layout B):
  break at the space that minimizes the longer line; ties keep more text
  on top. Before giving up on a fit, drop one trailing parenthetical —
  *Birds of Prey (And the Fantabulous Emancipation of One Harley Quinn)*
  becomes `BIRDS OF PREY`. Still over two lines: keep the first two, cut
  the second at a word boundary, no ellipsis (the name-fit rule). A
  single word over 20 splits with a trailing `-` (encoder rule).
- **Rating row.** `<contentRating> w <criticScore>` — the white chip is
  the separator, one space each side. Critic score to one decimal (house
  numbers rule), from `rating` then `audienceRating`, shown while
  `showCriticScore` is true. Null fields are omitted, never printed: no
  content rating → just the score; neither → the row stays blank. Layout
  B drops the critic score (no room) and keeps the content rating.
- **Times.** Layout A row 5: `9:05PM TO 11:54PM`. Layout B folds rating
  and time into row 5: `R w 7:15-8:55PM`; the start's AM/PM appears only
  when it differs from the end's (`9:05PM-12:10AM`). When that row runs
  past 20, drop the spaces around the chip first — `PG-13w9:05PM-12:10AM`
  is exactly 20 with the widest ratings, so the rating is never cut.
  Last played: `ENDED 11:54PM` same-day, `ENDED AUG 22 10:45PM` (exactly
  20) for an earlier day.

### 6.4 The four layouts

House notation: six lines, lowercase letters are chips (`r` red, `w`
white), everything else is the literal flap, short lines pad with blanks.
These are the golden fixtures; Appendix A has the same four frames as
exact 6×22 code arrays.

`cinema-now-playing` — layout A (title fits one line):

```
rrrrrrrrrrrrrrrrrrrrrr
r    NOW PLAYING     r
r    INTERSTELLAR    r
r    PG-13 w 8.7     r
r 9:05PM TO 11:54PM  r
rrrrrrrrrrrrrrrrrrrrrr
```

`cinema-now-playing-two-line` — layout B (two-line title; rating and time
share row 5):

```
rrrrrrrrrrrrrrrrrrrrrr
r    NOW PLAYING     r
r     THE GRAND      r
r   BUDAPEST HOTEL   r
r  R w 7:15-8:55PM   r
rrrrrrrrrrrrrrrrrrrrrr
```

`cinema-last-played` — dark curtain, ended time:

```
r                    r
r    LAST PLAYED     r
r    INTERSTELLAR    r
r    PG-13 w 8.7     r
r   ENDED 11:54PM    r
r                    r
```

`cinema-empty` — explicit push with nothing playing and nothing stored:

```
r                    r
r   MOVIE THEATER    r
r                    r
r  NOTHING SHOWING   r
r                    r
r                    r
```

(`MOVIE THEATER` here is a placeholder header — swap it for whatever D1
lands on if the name should appear instead.)

### 6.5 Queue behavior

Every cinema frame is a **snapshot** with the standard reading-time dwell
(`dwellFor`, base = the board's `dwellSeconds`). Persistence, alert
interruption and restore, identical-layout dropping, and the 15-second
rate window all come from the existing queue untouched. The only path that
re-asserts the frame on its own is the end-drift repush in §4.4 — that is
a live state change reclaiming the board, which is wanted; the watcher has
no periodic re-push, so it never needs the suppress-on-other-content hook
the game pollers use.

### 6.6 Empty state

Only for explicit pushes (`ctx.explicit`), per the house rule: scheduler
rotation with no content skips silently; a human pressing the tile gets an
answer. The frame is the dark curtain with `NOTHING SHOWING` (above).

## 7. Configuration reference

`data/config.json` gains one section (mirror it in `config.example.json`):

```json
"plex": {
  "enabled": false,
  "serverUrl": "http://192.168.50.10:32400",
  "monitoredPlayers": ["192.168.50.71"],
  "mediaTypes": ["movie"],
  "pollIntervalMs": 15000,
  "stopGraceMs": 30000,
  "repushEndDriftMinutes": 5,
  "pushOnStop": true,
  "quietHoursExempt": true,
  "showCriticScore": true,
  "stateFile": "data/plex-now-playing.json",
  "localTimeZone": "America/Denver"
}
```

Field rules: `serverUrl` is the LAN address of the Plex server, scheme and
port included, no trailing slash. `monitoredPlayers` is a list of player
IPs; empty list means the watcher idles. `mediaTypes` leaves the door open
for episodes later without promising them now. `localTimeZone` falls back
to `voiceEvents.localTimeZone` when absent. The token is never in this
file (§4.1). Settings changes apply live, matching the board settings —
save rewrites config and the watcher restarts itself; no container
restart.

## 8. Admin UI (Signal)

One new settings section, **Movie Theater (Plex)**, in the existing
settings style:

- Server URL field; token field (write-only, stored per §4.1); enabled
  toggle.
- **Test connection**: one live sessions call; shows reachable/auth state
  and lists the players currently in a session as `name · product · IP`
  with an "add" action per row — that is how the theater Apple TV's IP
  gets picked without typing it. Manual IP entry stays available (the
  device must be mid-playback to appear in the list).
- Monitored players list (add / remove); the numeric options
  (`pollIntervalMs`, `stopGraceMs`, `repushEndDriftMinutes`) and the three
  toggles (`pushOnStop`, `quietHoursExempt`, `showCriticScore`).
- **Preview**: queues the auto frame to a chosen board — same idea as the
  board "Test flip".
- Source health (unreachable / auth) surfaces here, matching the other
  credentialed sources.

Push tab: two tiles (Movie Theater group), filtered by display kind like
every other board-capable operation. Scheduler: both commands appear in
the rule editor with the content check from §5.3.

## 9. Testing

- **Golden fixtures**: the four layouts of §6.4 as notation fixtures with
  the Appendix A arrays as expected output; wired into `npm run
  board-replay` like the existing screens.
- `test/vestaboard-cinema.test.js`: both border states (full curtain and
  side rails); centering at width 20, odd and even; every fixture
  validates; title folding and the split rule (Interstellar, The Grand
  Budapest Hotel, the Birds of Prey parenthetical drop, a 21-character
  single word hyphen split); rating-row null cases; time formats (same
  meridiem, different meridiem, the layout B space-drop at exactly 20,
  `ENDED` same-day and dated at exactly 20); dwell.
- `test/plex-now-playing.test.js`: the §4.4 table as a transition test —
  play, pause without emit, resume with and without drift, seek, stop
  grace counting only successful polls, movie switch, newest-session pick,
  restart resume with identical-layout no-op, server-down never stops,
  401 slow-poll.
- Live pass on the simulator board end-to-end, then the real board:
  start a movie in the theater, pause it, seek it, stop it; press both
  tiles; schedule one rule; one quiet-hours evening check for whichever
  way D2 lands.

## 10. Out of scope (this rev)

TV episodes on the board (the config shape allows it later; the layout
would put the show name on the title rows and `S02E05` in the rating row —
design when wanted). Plex webhooks. Different frames per board or per
room. Posters, artwork, or anything on the full displays — the poster app
owns those. Trailers, up-next, or transcode details.

## 11. Commit plan

Six commits, each green on its own:

1. `cinemaFrame` builder + the four golden fixtures + frame tests.
2. Plex client and credentials: `plex-api.js`, `plex-credentials.js`
   (secret-box), config plumbing and `config.example.json`.
3. Watcher service and state machine: `plex-now-playing.js`, state file,
   fan-out with the `vestaboard` target, service tests.
4. Formatter `formatters/cinema.js`, router registration
   (`COMMAND_TO_TYPE` entries), quiet-hours wiring per D2, router and
   queue tests.
5. Commands, route, admin settings section with test-connection device
   picker and preview, push tiles, scheduler content check, the optional
   voice matcher.
6. Docs: `src/PROJECT.md` (module rows + Recent changes), README features
   table, this package into `dev assets/plex-vestaboard/`.

## 12. Documentation and style

Plain language throughout: shipped comments, README lines, and this
package follow Simplified Technical English — say the mechanism, define an
acronym the first time it appears, no jargon name-drops. Commit messages
stay short and casual: a subject plus a two-to-four line body a junior
reads without looking anything up; a commit that needs more should have
been split. Long reasoning lives here, not in the code.

---

## Appendix A — golden layouts as code arrays

Ground truth for the fixtures. 6 rows × 22 columns per frame; codes per
the board character set (blank 0, A–Z 1–26, digits, punctuation, chips
red 63, white 69).

`cinema-now-playing`:

```json
[
 [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
 [63, 0, 0, 0, 0, 14, 15, 23, 0, 16, 12, 1, 25, 9, 14, 7, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 9, 14, 20, 5, 18, 19, 20, 5, 12, 12, 1, 18, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 16, 7, 44, 27, 29, 0, 69, 0, 34, 56, 33, 0, 0, 0, 0, 0, 63],
 [63, 0, 35, 50, 36, 31, 16, 13, 0, 20, 15, 0, 27, 27, 50, 31, 30, 16, 13, 0, 0, 63],
 [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63]
]
```

`cinema-now-playing-two-line`:

```json
[
 [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63],
 [63, 0, 0, 0, 0, 14, 15, 23, 0, 16, 12, 1, 25, 9, 14, 7, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 0, 20, 8, 5, 0, 7, 18, 1, 14, 4, 0, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 2, 21, 4, 1, 16, 5, 19, 20, 0, 8, 15, 20, 5, 12, 0, 0, 0, 63],
 [63, 0, 0, 18, 0, 69, 0, 33, 50, 27, 31, 44, 34, 50, 31, 31, 16, 13, 0, 0, 0, 63],
 [63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63, 63]
]
```

`cinema-last-played`:

```json
[
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 12, 1, 19, 20, 0, 16, 12, 1, 25, 5, 4, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 9, 14, 20, 5, 18, 19, 20, 5, 12, 12, 1, 18, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 16, 7, 44, 27, 29, 0, 69, 0, 34, 56, 33, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 5, 14, 4, 5, 4, 0, 27, 27, 50, 31, 30, 16, 13, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63]
]
```

`cinema-empty`:

```json
[
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 13, 15, 22, 9, 5, 0, 20, 8, 5, 1, 20, 5, 18, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 14, 15, 20, 8, 9, 14, 7, 0, 19, 8, 15, 23, 9, 14, 7, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63],
 [63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63]
]
```

## Appendix B — session response shape (illustrative)

Trimmed to the fields §4.2 uses; taken from a movie playing on an Apple TV.
Treat this as a sketch: confirm names and casing against the live server
before coding, and lean on the official server API docs
(developer.plex.tv/pms) for the rest.

```json
{
  "MediaContainer": {
    "size": 1,
    "Metadata": [
      {
        "sessionKey": "42",
        "type": "movie",
        "title": "Interstellar",
        "contentRating": "PG-13",
        "rating": 8.7,
        "audienceRating": 8.6,
        "duration": 10140000,
        "viewOffset": 312000,
        "Player": {
          "address": "192.168.50.71",
          "title": "Movie Theater",
          "product": "Plex for Apple TV",
          "state": "playing"
        }
      }
    ]
  }
}
```
