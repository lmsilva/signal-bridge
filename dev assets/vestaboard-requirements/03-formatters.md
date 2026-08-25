# 03 — Formatter specifications

One entry per formatter. Input shapes are taken from the real system: the
live event log (`data/voice-events.jsonl`) and the real cache files. Field
names shown here are the actual field names observed. Layout notation is
defined in 02 §4 (lowercase letters are color chips; rows pad to 22).
Every layout is a golden fixture.

General rules that apply to all entries: folding per 02 §2, dwell per
02 §5, empty content returns `[]` (or the entry's empty-state frame when
`ctx.explicit`), nulls are omitted, priorities are `alert` or `snapshot`.

## A. Alexa family (`formatters/alexa.js`)

### A1. Broadcast / announcement — the priority feature

- Trigger: event `type: "broadcast"`. Real shape:
  `{"ts","type":"broadcast","device":"Kitchen Echo","message":"...",
  "source":"voice","trigger":"broadcast-followup"}`
- Priority: alert. Dwell 60s per frame.
- Render the folded message verbatim (transcription quirks included) in a
  violet border frame, wrapped at width 18. Three tiers by wrapped line
  count: ≤3 lines → one frame, last content row names the device (device
  names truncate to fit, "MASTER BATHROOM ECHO" → "MASTER BATH ECHO");
  exactly 4 → one frame, no device row; ≥5 → two frames, first frame
  carries the yellow continuation chip in the bottom-right border corner.
  Measured split on the real 292: 238 / 26 / 28.

```
vvvvvvvvvvvvvvvvvvvvvv
v                    v
v        KYLIE       v
v                    v
v MOVIE THEATER ECHO v
vvvvvvvvvvvvvvvvvvvvvv
```

```
vvvvvvvvvvvvvvvvvvvvvv
v 'I LOVE YOU DADDY  v
v  TAKE CARE OF MY   v
v  TEDDY BEAR'       v
v  MASTER BATH ECHO  v
vvvvvvvvvvvvvvvvvvvvvv
```

```
vvvvvvvvvvvvvvvvvvvvvv        vvvvvvvvvvvvvvvvvvvvvv
v TOMMY WHEN         v        v COME TO THE MOVIE  v
v WHENEVER YOU GUYS  v        v THEATER AND BRING  v
v ARE DONE WITH      v        v THE EXTRA GAME BY  v
v MINECRAFT COME     v        v THAT YOU HAVE      v
vvvvvvvvvvvvvvvvvvvvvy        vvvvvvvvvvvvvvvvvvvvvv
```

- Edge cases: short one-word messages center horizontally and sit on row
  3. Empty message: skip.

### A2. Time ("what time is it")

- Trigger: event `type: "time.query"` (`{"ts","type","device","query"}`).
- Priority: snapshot (ephemeral). Dwell 15s fixed, then restore previous
  content (queue handles restore).
- Block-digit clock: `blockTime(now)` — white 3x5 chip digits, yellow
  colon chips on digit rows 2 and 4, `PM`/`AM` glyphs beside the last
  digit column, footer = weekday and date.

```
    www   www www
    w w y w w w
    www   w w www
      w y w w   w PM
    www   www www
ww SUNDAY AUG 23    ww
```

- A config flag `timeStyle: "text"` renders a plain one-line time instead
  (same badge frame family, white).

### A3. Smart home (device on / off)

- Trigger: event `type: "smart-home.command"`. Real shape:
  `{"device":"Office Echo","query":"alexa turn the movie poster off,
  turn the movie poster off"}` — note the query text arrives duplicated
  ("A, B" where B repeats the tail of A); use the shorter repeated
  segment, strip a leading "alexa".
- Priority: snapshot. Dwell 15s. Coalesce per 01 §7.4. Off by default in
  a board's event allowlist suggestion? No — on by default, but this is
  the first thing to disable if a board feels chatty; say so in settings
  help text.
- White badge frame, entity and state on one or two rows, a green chip
  after `ON`, none after `OFF`; footer time.

```
ww SMART HOME       ww        ww SMART HOME       ww

 KYLIE BEDROOM                 MOVIE POSTER: OFF
 LIGHTS: ON g                  VIA OFFICE ECHO

ww 9:56PM           ww        ww 9:46AM           ww
```

### A4. Timers — list, fire, empty

- Trigger: event `type: "timer.snapshot"` (`{"trigger","timerCount",
  "event":{"kind":"list"|"started"|"fired"...}}`); timer detail comes from
  the mirror the bridge already keeps (`data/timer-mirror.json`).
- List: snapshot, orange badge frame, up to 3 timers per page soonest
  first, label column left (truncate to fit), right-aligned countdown
  `MM:SS` or `H:MM:SS`; footer "N RUNNING" + page counter when paged.
- Fire: alert, orange border frame, 60s, always passes quiet hours.
- Empty + `ctx.explicit`: the all-quiet frame. Empty + rotation: `[]`.

```
oo TIMERS           oo        oooooooooooooooooooooo
 PIZZA          12:34         o                    o
 LAUNDRY        48:10         o  PIZZA TIMER DONE  o
 SOUS VIDE    1:22:05         o  TIME'S UP!        o
                              o                    o
oo 3 RUNNING        oo        oooooooooooooooooooooo
```

```
oo TIMERS           oo

  NO TIMERS RUNNING


oo ALL QUIET        oo
```

### A5. Alarms — list and fire

- Trigger: event `type: "alarm.snapshot"`. Real shape (nested):
  `{"alarmCount":1,"event":{"kind":"started","alarm":{"device":"Bedroom
  Echo","label":null,"status":"ON","triggerTime":"2026-08-25T13:00:00.000Z",
  "remainingSec":86227,"recurrence":null,"alarmType":"standard"}}}`
- List: snapshot, yellow badge frame, soonest first, time + device (or
  label when present), "TOMORROW"/weekday line when not today; footer
  "NEXT IN 23H 57M" from `remainingSec`.
- Fire: alert, red border frame, always passes quiet hours.

```
yy ALARMS           yy        rrrrrrrrrrrrrrrrrrrrrr
 7:00AM  BEDROOM ECHO         r                    r
 TOMORROW                     r  WAKE UP - 6:30AM  r
                              r  RISE AND SHINE!   r
                              r                    r
yy NEXT IN 23H 57M  yy        rrrrrrrrrrrrrrrrrrrrrr
```

### A6. Reminder fired

- Trigger: event `type: "reminder.fired"`. Real shape:
  `{"label":"Check on corn in smoker","event":{"kind":"fired","reminder":
  {"device":"Kitchen Echo","label":"...","triggerTime":"..."}}}`
- Priority: alert, 60s. White border frame: `REMINDER:` + wrapped label +
  device.

```
wwwwwwwwwwwwwwwwwwwwww
w  REMINDER:         w
w  CHECK ON CORN     w
w  IN SMOKER         w
w  KITCHEN ECHO      w
wwwwwwwwwwwwwwwwwwwwww
```

### A7. Shopping list

- Trigger: event `type: "shopping-list.snapshot"`; items from
  `data/shopping-list-cache.json`: `{"items":[{"id","value","createdAt"}]}`.
- Snapshot, green badge frame, 4 items per page in stored order, folded
  verbatim (voice artifacts like "COMPANY Q. TEN" render as heard);
  footer "N ITEMS" + page counter when more than one page.

```
gg SHOPPING LIST    gg
 COMPANY Q. TEN
 EGGS


gg 2 ITEMS          gg
```

### A8. Weather

- Trigger: event `type: "weather.query"` or scheduler `alexa.weather`;
  data from `data/weather-cache.json`: `current{temperatureF,condition,
  windSpeedMph,humidity}`, `next24Hours[{time,temperatureF,
  precipitationProbability,windSpeedMph,condition}]`,
  `next7Days[{date,highF,lowF,precipitationProbability,condition}]`.
- Snapshot, blue badge frame: now line, high/low line, one notable line
  from the hourlies (strongest wind or highest rain chance ahead today),
  footer = tomorrow with condition and rain percent when nonzero.

```
bb WEATHER          bb
 NOW 93° SUNNY
 HIGH 96° LOW 66°
 WINDY PM - 28 MPH

bb TUE 93° RAIN 6%  bb
```

### A9. Indoor temperature

- Trigger: event `type: "indoor-temperature.query"`; data from the same
  smart-home thermostat source the existing overlay uses.
- Snapshot, blue badge frame, one row per named location (name column
  left, right-aligned temperature), footer = humidity when available.

```
bb INDOOR TEMP      bb
 TOP FLOOR        75°
 MAIN FLOOR       76°
 MACHINE ROOM     71°

bb HUMIDITY 34%     bb
```

### A10. Air quality

- Trigger: event `type: "air-quality.query"`; data from
  `data/air-quality-cache.json`: `monitors[{"label","iaqScore","band",
  "reading":{"temperatureF","humidity","pm25","co","voc"}}]`.
- Snapshot, green badge frame, one row per monitor: label column, then
  right block `<score><band chip> <temp>°`. Band chip: good g, fair y,
  poor o, bad r. Footer: "ALL CLEAR" when all good, otherwise one insight
  line about the worst monitor. More than 4 monitors: page.

```
gg AIR QUALITY      gg
 MAIN FLOOR   99g 76°
 MACHINE ROOM 99g 71°
 DOME        66y 114°

gg DOME RUNNING HOT gg
```

### A11. Music now playing

- Trigger: event `type: "music.playing"`. The logged event carries only
  the device and voice query; the track payload is whatever the
  full-display now-playing overlay receives — the board formatter takes
  that same payload (artist, album, track, output device/room).
- Snapshot, violet badge frame: artist / album / quoted track / footer
  room. Long values wrap into the free rows; overflow makes a
  continuation frame.

```
vv NOW PLAYING      vv
 KHRUANGBIN
 A LA SALA
 'MAY NINTH'

vv SONOS KITCHEN    vv
```

### A12. Notifications

- Trigger: event `type: "alexa-notifications.query"`; content from the
  overlay's notification payload.
- Snapshot, yellow badge frame: count line, then the newest notification
  wrapped; more than one page only when explicitly pushed.

```
yy NOTIFICATIONS    yy
 2 NEW
 AMAZON: PACKAGE
 DELIVERED TODAY

yy                  yy
```

### A13. Vivint

- Trigger: event `type: "vivint-alarm.query"`; render the confirmed state
  the bridge resolves for the overlay (armed stay / armed away /
  disarmed).
- Snapshot, white badge frame; green chip when armed. Footer time.

```
ww VIVINT           ww

 SYSTEM: ARMED STAY g


ww 10:37PM          ww
```

## B. Tesla family (`formatters/tesla.js`)

### B1. Dashboard

- Trigger: event `type: "tesla-dashboard.query"` or scheduler
  `tesla.dashboard`; data from `data/tesla-dashboard-cache.json`. Fields
  used: `vehicle.model`, `battery{percent,rangeMiles,charging,
  chargingLabel,chargerPowerKw}`, `map.drivingChip` ("0 mph · Park"),
  `climate{insideTempF,outsideTempF}`, `security{locked,sentryOn}`,
  `fetchedAt`, `freshnessSec`.
- Snapshot, red badge frame. Row 2: battery + range. Row 3: the state
  line — driving ("DRIVING 65 MPH"), charging ("CHARGING +11KW"), or
  parked ("PARKED - NOT PLUGGED"). Row 4: inside/outside temps. Row 5:
  security. Footer: snapshot time; when serving a stale cache (the
  overlay's amber pill state), an orange chip precedes the time.

```
rr TESLA MODEL Y    rr
BATT 73%  RANGE 201MI
PARKED - NOT PLUGGED
IN 88°  OUT 91°
LOCKED - SENTRY ON
rr 2:38PM           rr
```

### B2. Battery

- Trigger: event `type: "tesla-battery.query"`; data from
  `data/tesla-battery-cache.json` `reading{percent,rangeMiles,
  chargingLabel}`.
- Snapshot, green badge frame. Gauge: `gauge(round(percent/100*18), 18)`.
  Footer: "FULL AT <time>" when `timeToFullChargeMin` is known, otherwise
  "AS OF <time>".

```
gg TESLA BATTERY    gg

 73% - 201 MI RANGE
 (ggggggggggggg    )
 NOT PLUGGED IN
gg AS OF 2:38PM     gg
```

## C. Gaming family (`formatters/gaming.js`)

### C1. Steam — game start and last played

- Trigger: event `type: "steam.now-playing"` with `{"mode":"now-playing"|
  "last-played","appId":965680}`; resolve the name and times through
  `data/steam-library-cache.json` (`games[{appId,name,playtimeForeverMin,
  lastPlayedAt}]`, 707 entries in the real cache).
- Game start: alert (blue border feel via badge? no — badge frame, blue,
  with "GAME ON!" footer; priority alert so it preempts). Last played:
  snapshot; footer shows the library size.
- Fold drops symbols: "HOT WHEELS UNLEASHED™" → "HOT WHEELS UNLEASHED".

```
bb STEAM            bb        bb STEAM            bb
 NOW PLAYING:                  LAST PLAYED:
 HOTSHOT RACING                HOT WHEELS UNLEASHED

 LAUNCHED 7:42PM               AUG 22 - 10:45PM
bb GAME ON!         bb        bb 707 GAMES OWNED  bb
```

### C2. PSN — game start and last played

- Trigger: the PSN now/last-played events; resolve through
  `data/psn-library-cache.json`, keyed by title id, entries
  `{titleId,name,playtimeForeverMin,lastPlayedAt}` (timestamps are
  strings of milliseconds — parse). Skip provider placeholder names
  ("Old Game") and take the next real title.

```
bb PLAYSTATION      bb
 LAST PLAYED:
 SPLIT FICTION

 ON AUG 17
bb                  bb
```

### C3. Autodarts — game start, game end, dashboard

- Trigger: the Autodarts live feature's start/end events (players, game
  mode, legs target; end adds winner, leg score, match average, high
  score, checkout) and scheduler `autodarts.dashboard` with
  `data/autodarts-players.json`: `players[{name,matches,wins,x01Average,
  x01BestMatchAverage,bestCheckout,counts}]`, `totals{matches,legs,
  lastPlayedAt}`, `rivalry{a,b,aWins,bWins}`,
  `records{bestMatchAverage,highestCheckout,total180s}`.
- Start and end: alert, green badge frames; winner name flanked by yellow
  chips. Dashboard: snapshot; lead with totals, records (one decimal),
  the rivalry line, footer last-game date. Names truncate at 13.

```
gg AUTODARTS        gg        gg AUTODARTS        gg
 GAME ON - 501                 y TRASHPANDA WINS y
 LUIS VS SAM                   VS WAR D - 2-1 LEGS
 FIRST TO 3 LEGS               AVG 26.4  HIGH 60
                               CHECKOUT 51
gg THROW SHARP      gg        gg NICE DARTS       gg
```

```
gg AUTODARTS        gg
 42 MATCHES  57 LEGS
 TRASHPANDA AVG 68.3
 HIGH OUT 51  180S 1
 RIVALRY WAR D 11-4
gg LAST GAME AUG 2  gg
```

### C4. Roll Credits

- Trigger: scheduler `credits.show` or push; data from
  `data/roll-credits.json` `games{title,system,beatenAt,
  beatenDateUnknown,beatenWith}`. Derive: total count, latest by
  `beatenAt` among dated entries, system histogram for the footer.
- Snapshot, white badge frame. Long titles wrap ("Contra: Operation
  Galuga" takes two rows).

```
ww ROLL CREDITS     ww
 29 GAMES BEATEN
 LAST - AUG 22 ON PC
 CONTRA: OPERATION
 GALUGA
ww 18 ON ARCADE     ww
```

## D. Feeds family (`formatters/feeds.js`)

### D1. YouTube

- Trigger: event `type: "youtube.now-playing"` with `{"mode","videoId"}`;
  data from `data/youtube-cache.json`: `videos[{videoId,title,
  channelTitle,publishedAt,durationSeconds}]`,
  `stats{videoId:{viewCount,likeCount}}`, `dislikes{videoId:{dislikes}}`;
  device label from `data/youtube-devices.json` (`devices[{label,
  status,statusDetail}]`).
- Snapshot, red badge frame: title wrapped (continuation frame if over
  two rows), channel, then `<views> VIEWS <likes>+ <dislikes>-`. Footer
  names the client device only when its link status is healthy; the real
  file currently reports `needs-relink`, in which case omit the device.

```
rr YOUTUBE          rr
 SHOULD YOU BUILD A
 GAMING SERVER?
 JAKE SIMMONS
 37K VIEWS 1482+ 12-
rr MOVIE THEATER TV rr
```

### D2. The Upside

- Trigger: scheduler `goodnews.show` or push; data from
  `data/upside-news-archive.json` `stories[{headline,sourceLabel,
  publishedAt}]` and the panel's configured story count.
- Snapshot sequence: intro frame, then one or two frames per story
  (headline wrapped at width 22; measured: 84 of 163 fit one frame, 79
  need two, none need more), page counter in the header right.

```
yy THE UPSIDE       yy        yy THE UPSIDE   1/5 yy
                              FIRST RIVER OTTER
  GOOD NEWS ONLY              SPOTTED IN THE BRONX
  5 STORIES TODAY             IN 100 YEARS ALONG
                              THE BRONX RIVER
yy                  yy        yy                  yy
```

### D3. Wiki Common Knowledge

- Trigger: scheduler `wiki.show` or push; same pattern as D2 with the
  panel's article titles; a one-line teaser may join a short title when
  it fits.

```
ww WIKIPEDIA        ww        ww WIKI READS   2/5 ww
                               THE ANTIKYTHERA
  COMMON KNOWLEDGE             MECHANISM
  TOP READS TODAY
                               A 2000 YEAR OLD
ww                  ww        ww ANALOG COMPUTER  ww
```

### D4. Overhead

- Trigger: scheduler `overhead.show` or push; data from the panel's
  aircraft feed (flight code, origin/destination, altitude feet, distance
  miles, bearing), sorted closest first.
- Snapshot, blue badge frame, two flights per frame (code + `ORIGIN-DEST`
  row, then altitude + distance + bearing row), footer count; page
  through everything in range.

```
bb OVERHEAD         bb
 UA1642  SFO-DEN
  34000FT  2MI NE
 DL889   LAX-JFK
  38000FT  9MI SW
bb 2 OVERHEAD NOW   bb
```

### D5. Trivia (gated)

- Trigger: scheduler `trivia.show` or push; questions from
  `data/trivia-pool.json` `{categoryLabel,difficulty,type,text,
  correctAnswer,incorrectAnswers}` (HTML entities unescaped before
  folding).
- Gate per 02 §6; skip failing questions and draw the next. Sequence:
  question frame (dwell = the configured answer timer, default 30s), then
  reveal frame (wrong answers flip to red chips matching their word
  length, correct answer keeps its text with a green chip, footer states
  the answer). Category shows in the header right.

```
yy TRIVIA    GENERAL yy       yy TRIVIA    GENERAL yy
 WHAT IS THE ZODIAC            WHAT IS THE ZODIAC
 SYMBOL FOR GEMINI?            SYMBOL FOR GEMINI?
 A TWINS    B FISH             g A TWINS  B rrrr
 C SCALES   D MAIDEN           C rrrrrr   D rrrrrr
yy ANSWER IN 30S    yy        yy A - TWINS!       yy
```

## E. Signal family (`formatters/signal.js`)

### E1. Guest snaps

- Trigger: the guest snaps command; values from `.env`
  (`GUEST_WIFI_SSID`, `GUEST_WIFI_PASSWORD`) and the booth URL. No QR is
  possible on a board, so the URL is typed out.
- Snapshot, blue badge frame, longer dwell (match the full display's ~3
  minute guest window by repeating the frame's dwell within the sequence
  rather than one long dwell over 30s).

```
bb GUEST SNAPS      bb
 WIFI CASA-GUEST
 PASS SUNNY-TRAILS24

 SHARE PHOTOS AT:
b 192.168.1.10:47810 b
```

### E2. Identity / test flip

- Trigger: the settings Test flip button.
- Snapshot, white badge frame, board name on row 4, one pass of every
  chip color on row 6 (mechanical self-check).

```
ww SIGNAL BRIDGE    ww

  VESTABOARD LINKED
  KITCHEN BOARD - OK

 roygbvw    roygbvw
```

## Not board-capable (register nothing)

Photo slideshows and single photos, movie posters, Steam/PSN library
tours, cover art and screenshots, YouTube thumbnails, Ring video,
`web.open`, remote input. The router's silent-skip handles them. The
undocumented `route-planner.query` event seen in the log also registers
nothing in this rev.
