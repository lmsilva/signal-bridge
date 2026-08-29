# Flight Plan — requirements (rev 3)

Feature name: **Flight Plan**
Project: Signal Bridge
Date: 26 Aug 2026 (rev 3 — named Flight Plan; rev 2 corrected quiet hours
and split out the display design)
Status: ready for an implementing agent. Two items need checking against
live API docs before the poll ladder is written — see §14.
Screen and board layout live in the companion document
`flight-plan-display-design.md`.

---

## 1. What this feature does

Luis keeps a list of trips. A trip is a named period of travel with one or
more flights in it — his own travel, or someone flying in to visit.

The bridge then:

- shows the next trip and the next flight when he pushes it from Signal,
- shows it on a schedule, like any other page,
- watches the tracked flights and pushes an update by itself when
  something important changes,
- draws a live flight tracker on the full display while a flight is in
  the air,
- shows a Vestaboard Flight Tracker card (one flight per frame: route,
  both clocks, status, gate) on Next Flight and Trip Board.

This is not the same thing as the existing Overhead panel. Overhead shows
aircraft near the house. Flight Plan shows flights he cares about,
anywhere in the world.

### A note on the name

The feature is **Flight Plan**. The namespace, file prefix and command ids
are all `flightplan`, one word.

AeroDataBox uses the same phrase for something else — a filed ATC flight
plan, which is a real field in their status response and the thing that
doubles the cost of a status call on the free plan (§4). Keep the two
apart in code: the feature is `flightplan`, their concept is
`filedFlightPlan`. Put a one-line comment where they meet in
`flightplan-api.js`.

A **trip** remains a trip everywhere — it is the object the user creates.
Flight Plan is the feature that holds trips.

---

## 2. Decisions already made

These are settled. Do not re-open them.

| Question | Decision |
|---|---|
| Whose flights | Both. A trip is either his own travel or a visitor arriving ("Mom visiting"). |
| What shows on screen | The next trip and the next flight, not the whole list. |
| How long it stays | The normal dwell setting for that display. |
| Quiet hours | Vestaboards always obey the quiet window. Full displays have none. See §3. |
| What triggers an automatic push | Claude's call — the rules are in §9. |
| Trip images | Several per trip, rotated. |
| Past trips | Kept as history. The admin list must filter and sort. |
| Marketplace | RapidAPI. See §4. |
| Home airport | A setting, plus a one-click "Home" button on the From and To fields. |
| Flight search | By flight number only. Route search is dropped — see §6. |

---

## 3. Quiet hours

Vestaboards **always** obey `quietHours`. A flight update is not exempt,
unlike an alarm or a timer fire. A board flipping at 3am is noise.

Full displays have **no quiet window at all**. The bridge pushes whenever
a material change lands, at any hour. The monitors switch on and off on
their own timer, so a push that arrives while a display is off is simply
never answered, and a display that is on makes no sound. There is no
setting for this and none should be added.

## 4. Which marketplace, and why not the cheap one

Use **RapidAPI**.

AeroDataBox sells the same API through three routes, and the free plans
are not the same thing:

| Route | Free plan |
|---|---|
| RapidAPI | Free, unrestricted duration, 600 API units a month |
| API.Market | Free is a **7-day trial** only |
| Direct with AeroDataBox | Listed as coming soon |

API.Market is cheaper on the paid rungs ($5 versus $5.35 for 6,000
units), but its free tier expires after a week. The requirement here is to
stay free permanently, so RapidAPI wins.

RapidAPI free plan limits:

- 600 API units a month
- 1 request per second
- an extra cap of 1,000 requests per hour, which only RapidAPI applies

**Units are not requests.** Each endpoint has a Tier that sets its cost:
Tier 1 costs 1 unit, Tier 2 costs 2, Tier 3 costs 6, and some endpoints
are free at 0. One more catch: on the free plan, if a flight status
request finds a filed flight plan (US mainland flights), that request is
**charged twice**.

### The budget

Assume the worst case for a status call: Tier 2, doubled by a flight
plan, so 4 units per call.

- One flight, whole poll ladder (§7): about 25 calls, so up to 100 units.
- A four-flight trip in one month: about 400 units of the 600.
- Twenty flights a year: about 2,000 units of the 7,200 available.

That fits, but not with room to waste. Every rule in §7 and §8 exists to
protect that margin.

### Future note

Direct subscription lets you earn non-expiring credits by feeding ADS-B
data to AeroDataBox. Those credits **do not** apply to marketplace
subscriptions. If Luis ever runs a receiver, moving from RapidAPI to
direct becomes worthwhile. Not now.

---

## 5. Data sources

| Need | Source | Cost |
|---|---|---|
| Flight schedule, status, gate, terminal, belt, times | AeroDataBox flight status by number and date | API units |
| Live aircraft position | adsb.lol, adsb.fi, airplanes.live — `/v2/reg/{reg}` or `/v2/callsign/{cs}` | Free |
| Airport names and coordinates | `src/web/overhead-geo/airports.json`, already in the repo | Free |
| Place coordinates for trip images | `geocodeLocation` in `weather-fetch.js`, already in the repo | Free |
| Trip images | Wikimedia REST summary endpoint, already used by `wiki-common-knowledge-wiki.js` | Free |

**The live tracker must never spend API units.** AeroDataBox gives the
aircraft registration in the status response. That registration is the key
into the free ADS-B feeds, and `overhead-providers.js` already has the
three-provider fallback chain, so reuse it rather than writing a new one.

Design for coverage gaps. ADS-B is thin over oceans, so a Pacific leg will
stop reporting mid-flight. When no position has arrived for more than 15
minutes, the panel switches to a time-based progress mode and says so. It
must never freeze a stale aircraft on the map and pretend it is live.

---

## 6. Why route search is dropped

AeroDataBox has no direct "flights from A to B" endpoint. You would fetch
the whole departure board at the origin airport and filter it yourself.
That is a bulk endpoint, so it is one of the expensive Tiers, and a
single search could cost more units than tracking a whole flight.

For roughly twenty flights a year, and with Luis stating that searching by
flight number is the important path, the trade is not worth it. Search by
airline, flight number and date only.

Leave the door open: keep the search form's provider call behind one
function so a route mode can be added later without touching the UI.

---

## 7. The poll ladder

A flight is only polled inside its own window. Outside it, nothing.

| When | Poll interval |
|---|---|
| More than 24 hours before departure | Never — the schedule was already cached when the flight was added |
| 24 hours to 3 hours before | Once an hour |
| 3 hours before to departure | Every 15 minutes |
| In the air | **Zero API calls** — position from the free ADS-B feeds |
| Landed | One final call for the arrival gate and baggage belt, then stop forever |

Additional rules:

- Re-check the schedule once at 24 hours out even if the flight was added
  months earlier. Schedules change.
- Never poll a flight in a trip marked past.
- Never poll more than one flight at a time — the free plan allows one
  request per second.
- A manual refresh button in the admin is allowed and costs units. Show
  the cost in the tooltip.

---

## 8. Caching and the credit ledger

### The ledger

A new module tracks every call: the endpoint, its Tier, the units charged,
and the timestamp. It keeps a month-to-date total that resets on the
billing cycle day.

The admin shows one line: `142 of 600 units used — resets in 9 days`.

### Three states

| State | Trigger | Behaviour |
|---|---|---|
| OK | Below the soft cap | Normal |
| Low | Soft cap reached, default 500 units | Background polling stops. Manual searches and manual refresh still work. Admin shows a warning strip. |
| Out | Hard cap reached, 600 units, or the API returns a quota error | No calls at all. Everything serves from cache. |

### What the screens show when the data is stale

Never an error, never a blank page. Show the cached data with an "as of"
line:

```
as of 14:20 — waiting for quota
```

That is the whole point of this design: Luis must be able to look at the
wall and tell the difference between "out of credits" and "broken". The
board does the same thing, on its footer row.

### Cache rules

- A flight's schedule is cached from the moment it is added and never
  re-fetched until 24 hours before departure.
- Every status response is stored in full. The next poll compares against
  the stored copy — that comparison is what drives §9.
- A landed flight's final record is frozen. It is history, never re-polled.
- Search results are cached for 6 hours by airline, number and date, so
  re-running the same search is free.
- Airport data and trip images are cached permanently on disk.

Check AeroDataBox's terms of use, Article 5, for how long their data may
be retained, and honour it. If it forbids indefinite retention, keep the
full record only while the trip is active and reduce a past flight to the
few fields needed for history.

---

## 9. What counts as a change worth pushing

Every poll compares the new status against the last stored one. A push
fires only on a **material change**:

- Departure or arrival time moves by 15 minutes or more against the last
  shown value
- Gate change, at either end
- Terminal change, at either end
- Status becomes cancelled, diverted, departed or landed
- Baggage belt is assigned, for an arriving visitor flight
- The flight date changes

Deliberately **not** material: boarding, small time drifts under 15
minutes, aircraft swap, and any field flapping back to a value already
shown.

Guards:

- One automatic push per flight per 10 minutes, at most.
- If a value changes and then changes back within one poll cycle, push
  nothing.
- Two identical pushes in a row are suppressed.
- The Vestaboard drops the push during quiet hours. The full display
  always takes it.

Every material change is written to the events log with the old and new
values, so the admin can show a change history per flight.

---

## 10. Data model

Two stores, following the Roll Credits pattern: JSON on disk beside the
other bridge state, re-read on every read.

### Trip

| Field | Notes |
|---|---|
| `id` | Slug |
| `name` | "Japan Trip 2026" |
| `kind` | `ours` or `visitor` |
| `traveller` | Free text, used for visitor trips — "Mom" |
| `startDate`, `endDate` | The trip window |
| `notes` | Free text, editable |
| `locations` | List of place names, each with coordinates and a resolved image |
| `images` | List of image records: URL, source, caption, and whether it was picked by hand |
| `flights` | List of flight ids |
| `archived` | Set automatically once the last flight has landed |

### Flight

| Field | Notes |
|---|---|
| `id` | Slug |
| `tripId` | Owner |
| `airline`, `number`, `date` | What the user typed |
| `origin`, `destination` | IATA and ICAO codes |
| `scheduled` | Departure and arrival times, from the first lookup |
| `latest` | The full cached status response |
| `registration`, `callsign` | Keys into the free ADS-B feeds |
| `history` | Material changes, with timestamps |
| `state` | `upcoming`, `active`, `landed` |

---

## 11. The admin page

New tab: **Flight Plan**.

### Trip list

- Cards or rows, newest active trip first.
- Filter: upcoming, active, past, all. Sort: date, name, flight count.
- A past trip is dimmed but fully readable.

### Trip editor

- Name, kind, traveller, start and end dates, notes.
- Delete needs a confirmation dialog that names the trip and says how many
  flights go with it.
- Images: see §12.
- Flights: add, remove, reorder. Removing one flight does not confirm;
  removing the trip does.

### Add a flight

One mode only: by flight number.

1. Airline, flight number, departure date.
2. One API call.
3. Show every matching leg — a flight number can have more than one leg
   in a day, and codeshares appear here too. Show origin, destination and
   times so the right one is obvious.
4. He picks one. That is what gets stored.

The From and To fields, wherever they appear, get a small **Home** button.
One click fills the field with the home airport from settings. It works on
either field, because he flies out as often as people fly in.

### Per-flight view

Current status, the change history from §9, a manual refresh button with
its unit cost in the tooltip, and a "push to display now" button.

---

## 12. Trip images

Pipeline, all free, all reusing existing code:

1. **Guess from the title.** Strip trip words (trip, vacation, visit,
   holiday, weekend) and any four-digit year. What is left is the
   candidate — "Japan Trip 2026" gives "Japan".
2. **Geocode it** with `geocodeLocation`. If nothing resolves, skip to
   step 5.
3. **Fetch the article image** from the Wikimedia REST summary endpoint,
   with the contact User-Agent that `wiki-common-knowledge-wiki.js`
   already requires.
4. **Show candidates, do not auto-accept.** Present three or four options
   and let him pick. A country's top article image is often a flag or a
   map rather than a landmark, so prefer searching a city over a country
   where both are available.
5. **Location search.** A text field where he types any place and gets
   the same candidate list. Several locations per trip are allowed, and
   each contributes images.
6. **Curated pack.** A small bundled set — US big city, small town, beach,
   mountains, desert, island paradise, island town — for trips with no
   findable place, like "Mom visiting".

Auto-detection is a convenience, not the main path. "Mom visiting" will
never resolve, and that is expected.

Downloaded images are cached to disk and re-used. Never hotlink at
display time.

---

## 13. The screens

Full layout, colour rules, the status vocabulary, the tracker card and the
Next Flight / Trip Board / alert frames are specified in `flight-plan-display-design.md`.

Two things from that document are load-bearing here, so they are repeated:

- The status vocabulary is **one exported module** read by the display
  panel, the board formatter and the change detector in §9. Three copies
  is how the wall and the board end up disagreeing.
- The "as of" timestamp appears on every frame and every panel, always,
  not only when data is stale.

## 14. Settings

New file `src/flightplan-settings.js`, following `trivia-settings.js`.

| Setting | Default |
|---|---|
| `enabled` | `false` |
| `apiKey` | empty — entered in admin, stored through `secret-box.js` |
| `homeAirport` | empty, IATA code |
| `softCapUnits` | `500` |
| `hardCapUnits` | `600` |
| `billingCycleDay` | `1` |
| `autoPushEnabled` | `true` |
| `autoPushCooldownMinutes` | `10` |
| `materialDelayMinutes` | `15` |
| `livePositionStaleMinutes` | `15` |
| `searchCacheHours` | `6` |
| `imageCandidateCount` | `4` |

### Two things to verify before writing the poll ladder

1. **The Tier of each endpoint used.** Read the tier table in the
   AeroDataBox docs and record the real unit cost of the flight status
   endpoint in a comment next to the ledger. The budget in §4 assumes the
   worst case; if it is cheaper, the ladder can be more generous.
2. **The caching and retention terms**, Article 5 of the terms of use, as
   noted in §8.

---

## 15. Push, schedule, and plumbing

New UDP type: `flightplan.flight`.
New command ids:

| Id | Title | Notes |
|---|---|---|
| `flightplan.next` | Next Flight | Pushable and schedulable |
| `flightplan.board` | Trip Board | The whole trip, board-friendly |

- Add both to `BOARD_COMMAND_IDS` in `command-registry.js`.
- Add both to `COMMAND_TO_TYPE` in `vestaboard/router.js`.
- Both support a content check: no upcoming flight means no content, and
  the scheduler skips the slot rather than showing an empty page.
- Automatic change pushes go out as the same type, so the panel and the
  formatter are shared.

---

## 16. File-by-file work list

**Bridge (Node)**

| File | Change |
|---|---|
| `src/flightplan-store.js` | New. Trips and flights on disk. |
| `src/flightplan-settings.js` | New. Settings. |
| `src/flightplan-api.js` | New. AeroDataBox client, with the ledger built in. |
| `src/flightplan-ledger.js` | New. Units used, caps, three states. |
| `src/flightplan-poller.js` | New. The poll ladder and change detection. |
| `src/flightplan-live.js` | New. Free ADS-B position lookup by registration. |
| `src/flightplan-images.js` | New. Geocode, Wikimedia, cache, curated pack. |
| `src/flightplan-payload.js` | New. Builds the `flightplan.flight` payload. |
| `src/overhead-providers.js` | Export the provider chain so `flightplan-live.js` reuses it. |
| `src/command-registry.js` | Two descriptors plus board ids. |
| `src/vestaboard/router.js` | Two `COMMAND_TO_TYPE` rows. |
| `src/vestaboard/formatters/feeds.js` | `flightPlanBoardFrames` plus map entry. |
| `src/web-server.js` | Trip and flight CRUD, search, push, settings, ledger status. |
| `src/web/admin/index.html`, `app.js` | The Flight Plan tab. |
| `src/listener.js` | Start the poller, route automatic pushes. |

**Display client (Python)**

| File | Change |
|---|---|
| `src/display_panels.py` | New `FlightPlanPanel`, both orientations. |
| `src/overlay.py`, `src/main.py`, `src/payload_utils.py` | Register `flightplan.flight`. |
| `src/map_tiles.py` | Reuse as is if possible. |

---

## 17. Commit plan

1. Store and settings modules, with tests. No network.
2. API client and the ledger, with the three states and a fake transport
   in tests. This commit proves the budget logic before a single real unit
   is spent.
3. Admin Flight Plan tab: create, edit, delete, notes, history filter and sort.
   Flights added by hand, no search yet.
4. Flight search by number, plus the Home airport shortcut.
5. Images: title guess, location search, candidate picker, curated pack.
6. Poller and change detection, running in log-only mode — it detects and
   records material changes but pushes nothing.
7. Payload, full display panel, both orientations.
8. Vestaboard formatter, commands, scheduler wiring.
9. Turn on automatic push.

Steps 1 to 6 are safe to run live in the house. Nothing reaches a screen
until step 7, and nothing pushes by itself until step 9.

---

## 18. Acceptance tests

- With no API key set, the admin loads, trips can be created and edited,
  and no call is attempted.
- A flight added 90 days out triggers exactly one API call, and none
  again until 24 hours before departure.
- With the ledger at 500 units, background polling stops and a manual
  search still works.
- With the ledger at 600 units, no call is attempted and the panel renders
  from cache with an "as of" line.
- A quota error from the API moves the ledger to Out without waiting for
  the count to reach the cap.
- A delay of 10 minutes triggers no push. A delay of 20 minutes triggers
  one. A second poll with the same 20-minute delay triggers none.
- A gate change at 3am reaches the full display and is dropped by the
  Vestaboard.
- A visitor trip renders the origin airport on the board, not the
  destination.
- Positions older than 15 minutes switch the panel to estimated mode.
- Deleting a trip requires confirmation and removes its flights, its
  cached images and its poll entries.
