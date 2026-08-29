# Flight Plan — display design (rev 4)

Companion to `flight-plan-requirements.md`. That document says what the feature
does. This one says what it looks like.

Everything here uses the existing design tokens in `design_system.py` and
the existing frame helpers in `src/vestaboard/frames.js`. No new colours,
no new fonts, no new frame primitives.

---

## 1. Colours used

From `design_system.py`, unchanged:

| Token | Value | Used for |
|---|---|---|
| `BG` | `#0B1730` | Page background |
| `INK` | `#F2F7FF` | Route line, times |
| `INK_2` | `#A4ACC0` | Secondary labels, airport and gate lines |
| `INK_3` | `#6B7388` | Header hints, footer, map pin labels |
| `ACCENT` | `#5FD0FF` | Flight number, live route, progress bar |
| `GOOD` | `#6EE7A8` | On time, landed, live position confirmed |
| `WARN` | `#F5C453` | Delayed, gate or terminal changed |
| `ALERT` | `#FF7A6B` | Cancelled, diverted |
| `LINE` | `#264060` | Hairlines, map border |
| `TRACK` | `#152443` | Empty part of the progress bar |

One colour rule governs the whole panel: **the status colour is the only
colour that changes.** Flight number stays accent, times stay ink, the
map frame stays line. If the flight is late, the status text, the two
affected times and nothing else turn amber. That way the wall answers
"is it fine?" from across the room without being read.

---

## 2. Full display — layout

Six horizontal bands, top to bottom. The same six in both orientations;
landscape splits them into two columns instead of stacking them.

| Band | Contents |
|---|---|
| Header | Page title on the left, trip name on the right, hairline below |
| Identity | Flight number in accent, route below it in ink |
| Status | One line, coloured by state |
| Stage | Map when live, trip image when not |
| Detail | Depart and arrive columns: time, then airport with gate or belt |
| Progress | Bar, a live note on the left, time remaining on the right |
| Footer | Hairline, dismiss countdown left, "as of" time right |

### Header wording

The page title changes with the trip kind, because a visitor's flight is
not "your" flight:

| Trip kind | Flight state | Title |
|---|---|---|
| `ours` | Before departure | `upcoming flight` |
| `ours` | In the air | `in flight` |
| `visitor` | Any state before landing | `arriving` |
| `visitor` | Landed | `arrived` |

### Identity and status

- Flight number: 26px, weight 500, `ACCENT`. Airline code and number
  separated by a space — `DL 167`, never `DL167`. The Vestaboard tracker
  card uses the same readable form; see §4.
- Route: 20px, `INK`, with a real arrow character.
- Status: 14px, one line, dot-separated. The colour comes from §3.

For a visitor trip the identity block leads with the arrival end. The
route still reads origin to destination, but the gate shown in the
detail band is the arrival gate and the belt replaces it once assigned.

### Stage

The stage is a bordered box, `#08122A` fill, `LINE` border, never a
full-bleed background. The house rule is no text over imagery, and this
is how it is honoured — text never enters the stage box.

Three stage states:

1. **Live.** Great-circle route from origin to destination. The flown
   part is a solid `ACCENT` line; the remaining part is a dashed
   `#3B5C80` line. The aircraft is a small dart at the current position,
   rotated to its heading. Origin and destination are small dots with
   three-letter labels placed outside the arc, never on it.
2. **Estimated.** No position for longer than `livePositionStaleMinutes`.
   Keep the arc, dim the aircraft, place it by elapsed time, and change
   the progress note to `position estimated`.
3. **Not flying.** Replace the map with a trip image, letterboxed inside
   the same box. No text on it.

### Detail

Two columns, `DEPART` and `ARRIVE`, 11px `INK_3` labels. Under each: the
scheduled time in `INK_3`, an arrow, and the estimated time in the status
colour. When the two match, show one time in `INK` and no arrow —
an unchanged time should not look like a change.

Under that, 12px `INK_2`: airport code, then gate, terminal or belt.

### Progress

Bar is 8px tall, full content width, `TRACK` behind and `ACCENT` in
front, `GOOD` once landed. The left note states where the position came
from: `in the air · position live`, `position estimated`, `on the
ground`, or `not departed`. The right note is time remaining, or the
delay, or blank.

### Footer

Always two items: the dismiss countdown that every page in the house
shows, and the "as of" timestamp. **The "as of" time is always visible,
not only when the data is stale.** It is the single thing that tells the
difference between out of credits and broken, and it should be a habit,
not an alarm.

When the ledger is in the Low or Out state, add one more line above the
footer in `INK_3`: `waiting for quota`.

### Landscape

Left column, about 40 percent width: header, identity, status, detail,
progress. Right column: the stage box, full height of the content area.
Footer spans both. No content is dropped between orientations.

---

## 3. Status vocabulary

One table drives the status line, the status colour and the board code.
Implement it once and read it from both renderers.

| State | Full display line | Colour | Board code |
|---|---|---|---|
| On time, not departed | `ON TIME · GATE B14` | `GOOD` | `ON` |
| Late | `DELAYED 25 MIN · GATE B14` | `WARN` | `+25` |
| Boarding | `BOARDING · GATE B14` | `GOOD` | `BRD` |
| Departed | `DEPARTED 10:40` | `ACCENT` | `DEP` |
| Landed | `LANDED · BAG BELT 7` | `GOOD` | `ARR` |
| Cancelled | `CANCELLED` | `ALERT` | `CNX` |
| Diverted | `DIVERTED TO ANC` | `ALERT` | `DIV` |
| Unknown or stale | `NO UPDATE SINCE 09:10` | `INK_3` | `--` |

A delay under `materialDelayMinutes` still reads `ON TIME`. The panel and
the change detector must agree on that threshold, or the wall will say
one thing and the push another.

The Vestaboard tracker splits that line: `headline` is the status without
the gate (`ON TIME`, `DELAYED 25 MIN`, `IN FLIGHT`), and `gateLine` is
`GATE B14` / `BAG BELT 7` on the row beneath. `boardCode` remains for the
full-display itinerary chips.

---

## 4. Vestaboard — the tracker card

Six rows, twenty-two columns. `badgeFrame` in `frames.js` gives a badge
row plus four body rows, with body columns running from `BODY_FROM` to
`BODY_TO` — twenty usable characters.

The board is not a dense FIDS table. It follows Vestaboard's Flight
Tracker channel: **one flight per frame**, the trip name on the badge,
origin and destination as the heroes, both clocks, a full-word status,
and the gate when it still fits beside the status.

```
JAPAN 2027
DL 167               TODAY
SEA -            HND
1:45P          4:40P
ON TIME         GATE B14
AS OF            12:00
```

### Badge row

Trip name (`JAPAN 2027`). Long names drop `TRIP` / `VACATION` / `VISIT`
/ `HOLIDAY` before they are cut to 16 characters. With no trip name,
Next Flight reads `NEXT FLIGHT` and Trip Board reads `TRIP BOARD`.

Corner chips take the status colour from §3 (green on time, orange
late, blue in the air, white landed, red cancelled / diverted / alert).
The chip is free — it costs no character.

### Body rows

1. **Flight** — airline+number on the left (`DL 167`). Countdown on the
   right: `D-12` twelve days out, `TODAY` on the day, `NOW` once the
   flight is active, `UPDATE` on an auto-push. When a trip board pages,
   the counter joins the countdown (`TODAY 1/2`) if it still fits in
   20 characters.
2. **Route** — origin IATA on the left, destination on the right, a
   hyphen in between (`SEA -` … `HND`). Vestaboard has no `>` flap.
3. **Clocks** — departure under origin, arrival under destination.
   12-hour with an `A`/`P` suffix (`1:45P`, `10:15A`), using the
   airport-local wall clock embedded in the stamp so a UTC Docker host
   cannot rewrite 13:45-07:00 into 20:45. Estimated / revised / actual
   beats scheduled when AeroDataBox has a newer time.
4. **Status** — the `headline` from §3, not the four-character board
   code: `ON TIME`, `DELAYED 25 MIN`, `BOARDING`, `DEPARTED`,
   `IN FLIGHT`, `LANDED`, `CANCELLED`. Gate (`GATE B14`, `TERM S`,
   `BAG BELT 7`) sits on the right of this row when both fit; otherwise
   the headline wins and the gate is omitted.

### Footer row

`AS OF` on the left and the house-timezone clock on the right.

---

## 5. Vestaboard — Next Flight, Trip Board, and alerts

### Next Flight (`flightplan.next`)

One tracker card for the upcoming (or in-the-air) flight. Same shape
whether the push is manual or a scheduler tick.

### Trip Board (`flightplan.board`)

The same tracker card, one frame per remaining leg, up to four. A
departure board that pages is what a real one does; cramming three
flights onto one 20-character grid is not. Landed legs stay in the
payload so a trip mid-journey still reads as a trip; they render as
their own `LANDED` cards when they are in the first four.

### Change alert frame

Fired by a material change from the requirements document. Badge row
names the change and the flight, then one line stating the change in
plain words, then one line with the new departure time and the delay.

Rules:

- One frame only. Never page an alert.
- Red chips on the badge row for cancellation, diversion and gate change.
  Orange for a delay.
- Dwell from `dwellFor`, as with everything else.
- **Dropped entirely during quiet hours.** A flight update is not an
  alarm and gets no exemption.

---

## 6. Rules that apply to every frame

- If the encoder cannot map a character, drop that row rather than
  substitute a lookalike.
- An empty frame array is a valid answer. A board with nothing worth
  saying should keep its last frame rather than flip to a blank face.
- Never hand-set dwell. `dwellFor` already scales with content length.
- Abbreviate long trip names with the same word-level approach
  `fitDevice` uses for room names: shorten whole words before cutting
  letters, so `JAPAN TRIP 2026` becomes `JAPAN 2026` rather than
  `JAPAN TRIP 20`.

---

## 7. What the implementing agent should build first

Build the status table in §3 as a single exported module before either
renderer. Both the panel and the formatter read from it, and the change
detector in the requirements document compares against it. Three copies
of that vocabulary is how the wall and the board end up disagreeing.
