# Autodarts — requirements and architecture

**Project:** Signal Bridge (`github.com/lmsilva/signal-bridge`) + Alexa Broadcast Client (display)
**Status:** Ready for implementation — revision 3 (board rendered realistically; portrait live page fills its height)
**Audience:** The implementing agent. Read `src/PROJECT.md` (bridge) and `alexa broadcast client/src/PROJECT.md` (display client) first, as those files instruct. This feature follows the same conventions as the Roll Credits plan (`roll-credits-requirements.md`); where a pattern is shared, this document names the file to copy it from instead of restating it.

---

## 0. Read this first — rules for the implementing agent

1. **Read both PROJECT.md files before writing code**, and update them when you change architecture, modules, config, or UDP behavior (bump "Last updated", add a "Recent changes" entry with deploy notes).
2. **This integration uses an unofficial API.** Autodarts has no public, documented cloud API — everything below comes from community observation of `api.autodarts.io`. Treat it exactly like the PSN integration: fail-soft everywhere, self-naming failures, and a note in the admin card that the service can break if Autodarts changes endpoints. The bridge must degrade to "cached data + friendly error", never crash.
3. **Verification protocol (mandatory):** before coding each integration point, confirm the request/response shape against the live account — open `play.autodarts.io` with browser developer tools, perform the action, and record what you see. The community discovery ledger below is the map, not the territory. Record confirmed shapes in `src/PROJECT.md` when you're done, the way the PSN and YouTube work did.
4. **The bridge is read-only.** It observes boards, matches, and stats. It must NEVER call the write endpoints (lobby create/start/delete, player add/remove, next-player, next-leg, undo, corrections, throw patch, match delete). Enforce this in code: the Autodarts HTTP helper only exposes GET plus the token-refresh POST, so a future edit cannot casually add a write.
5. **Do not break existing behavior.** Full suites green before commit: `npm test` and `run_all_tests.bat`. New tests per §14. No changes to existing UDP types, routes, or command registry entries.
6. **Writing style for everything you ship:** plain, simple language in code comments, README additions, and admin UI copy; no unnecessary jargon; acronyms get a one-line explanation. Commit messages: short and casual — subject plus a 2–4 line body; split commits that need more.
7. **Deploy notes:** bridge-only changes ship with `./recreate.sh`. This feature adds a new display panel, so note "portable client rebuild" where it applies, and bump the admin cache-bust `?v=signalNN`. No new bridge dependencies are expected (WebSocket client: Node 18's built-in `WebSocket` is fine for this, or vendor a tiny client if it proves insufficient — say so in PROJECT.md if you do).
8. **Ask before deviating.** If a requirement conflicts with what you find in the code or the live API, stop and say so.

Acronyms and terms used here, defined once:

- **WS / WebSocket** — a long-lived, two-way network connection the browser and the bridge can hold open so the server can push events the moment they happen (no polling).
- **Keycloak** — the open-source login server Autodarts runs at `login.autodarts.io`. The bridge signs in against it and receives tokens.
- **Device-link login** — a login style where the app shows a short code, you open a link on your phone, sign in once, and the app receives its tokens. Autodarts' own community tools moved to this (their manager notes e-mail and password are no longer needed). Same user experience as the YouTube TV-code linking already in the admin.
- **Variant** — an Autodarts game type: X01, X01+, Cricket, Count Up, Random Checkout, Killer, Bob's 27.
- **PPR** — points per round (three darts). Autodarts' overview stats use PPR; a per-match "Average" is the same idea.

---

## 1. What this feature is

**Autodarts on the wall display.** Luis runs an Autodarts board (camera-based automatic scoring, on a Raspberry Pi) in his game room; the board reports to the Autodarts cloud, where matches, throws, and statistics live. This feature signs the bridge into that cloud and gives the display three things:

1. **A stats dashboard** — pushable and schedulable like every other page: how many matches the board has seen, a leaderboard of everyone who has ever played on it (crown on the house champion), per-player numbers, per-month and per-variant charts, and house records.
2. **A live match page** — when a game starts on his board, the display automatically shows the scoreboard in real time, updating on every throw. If another page interrupts it and the game is still going, it comes back on its own. If the game goes quiet for a configurable time (default 15 minutes), it closes and stops coming back.
3. **A last-match card** — the final scoreboard of the most recent game, for the scheduler and for a manual push when nothing is live.

Local guest players (names typed at the board, no Autodarts account) are first-class citizens: the leaderboard is built from the bridge's own match archive, so WAR D, TOMMY, and KYLIE rank right alongside the account holder.

---

## 2. Feature name and canonical identifiers

**The feature is named "Autodarts"** — it is a platform integration, and platform integrations in this project keep the platform's name (Steam, PSN, YouTube). Display header pill: lowercase `autodarts`, per the page-title convention.

| Surface | Value |
|---|---|
| Command group | `Autodarts` (new group, new Push row) |
| Command registry ids | `autodarts.now`, `autodarts.last-match`, `autodarts.dashboard` (§10) |
| UDP payload types | `autodarts.match` (live or final card), `autodarts.match.close`, `autodarts.dashboard` |
| Module prefix | `src/autodarts-*.js` |
| Data files | `data/autodarts-settings.json`, `data/autodarts-credentials.json` (encrypted), archive under `data/autodarts-matches/`, aggregates `data/autodarts-players.json` |
| Client panel | `alexa broadcast client/src/autodarts_panel.py` |
| Settings card heading | `Autodarts` |
| Display page titles | `autodarts` (all three pages; the card itself carries a LIVE or FINAL chip) |
| Icon key | `autodarts` — a dart/target line glyph in the admin icon-map style |

No admin tab: unlike Roll Credits there is no library to manage. The whole admin footprint is one Settings card (§9) plus the Push tiles and scheduler entries the command registry provides.

---

## 3. Scope

### In scope

- Sign-in to Autodarts from the admin Settings card: device-link flow preferred, e-mail + password fallback, tokens encrypted at rest, Test button, linked-account and board status readouts, board picker.
- A bridge-maintained **match archive**: every match observed live is recorded; a history backfill fills in the past when the (to-be-verified) history-list endpoint is confirmed. Per-player lifetime aggregates computed from the archive.
- Dashboard page: totals, leaderboard with crown, charts, rivalry, records — pushable and schedulable.
- Live match service: WebSocket subscription to the board, auto-push of the live scoreboard, in-place updates per throw, interrupt-resume, inactivity close (configurable 5/10/15/30/60 minutes, default 15), final card on game shot, archive on finish.
- Last-match card (final scoreboard of the most recent archived match).
- Full X01-family live layout; a clean generic layout for the other variants (name, score, current turn) in v1.
- Tests per §14; PROJECT.md updates; README section.

### Out of scope (do not build)

- Any write action against Autodarts (rule 4 in §0): no starting, correcting, or ending matches from the bridge or display.
- Online lobby browsing, friends, tournaments. (An online match played *on his board* still displays — the live service keys off the board, not the match's local/online flag.)
- Player alias merging in the admin ("WAR D" vs "Ward" as one person) — note it as a v2 idea in code comments; v1 normalizes case only (§6).
- Cricket's full marks board and per-dart hit-maps on the live page — v2 candidates, listed in §11.5.

### Phasing

- **1a — Sign-in + plumbing:** auth, token refresh, board discovery, Settings card, status.
- **1b — Archive + dashboard:** match archive, aggregates, dashboard payload + panel, push/schedule.
- **1c — Live:** WebSocket service, auto-push, resume, inactivity, final card, archive-on-finish, last-match card.

Each phase ends with the full test run and PROJECT.md updates. 1b is useful on its own even if 1c's live events prove harder than expected.

---

## 4. Autodarts integration facts (what is known, and how sure we are)

Primary reference: the community **discovery ledger** — `github.com/thomasasen/autodarts_local_tournament/docs/autodarts-api-capabilities.md` (dated 17 Mar 2026), which catalogs observed endpoints with confidence grades and includes a browser probe script for capturing new ones. Secondary references: `lbormann/darts-caller` (the standard community integration; source shows auth + subscription in practice) and `creazy231/tools-for-autodarts` (browser extension; shows the WebSocket channels and REST calls the web app itself makes).

### 4.1 Services on `api.autodarts.io` (Bearer-token auth)

| Prefix | Service | Used here |
|---|---|---|
| `/auth/v1/*` | Auth | `POST /auth/v1/refresh` `{refreshToken}` → new access token |
| `/gs/v0/*` | Game service | `GET /gs/v0/matches/{matchId}` (metadata), `GET /gs/v0/matches/{matchId}/state` (turn, legs, throws) |
| `/as/v0/*` | Account/stats | `GET /as/v0/matches/{matchId}/stats` (per-match stats; **can 404 until stats are ready — retry with backoff**), `GET /as/v0/users/{userId}/stats/{variant}?limit={n}` |
| `/bs/v0/*` | Board service | `GET /bs/v0/boards` (the linked account's boards — powers the board picker), `GET /bs/v0/boards/{boardId}` , `GET /bs/v0/boards/{boardId}/state` |
| `/ms/v0/*` | Messages | `WS /ms/v0/subscribe` — live event stream |

Per-throw data includes the segment (`{ name: "T20", number: 20, bed: "Triple", multiplier: 3 }`) and normalized board coordinates — which is why the live card can name every dart, and why a hit-map is feasible later.

### 4.2 Login

Keycloak at `login.autodarts.io`. Two paths, both storing only tokens (never the password) encrypted with `secret-box.js`:

1. **Device-link (preferred).** The Settings card requests a device code, shows the short code + a "Open autodarts.io to approve" button, and polls until approved. Community precedent: darts-caller switched to exactly this. **Verify** the device-authorization endpoint and client id against darts-caller's current source before building.
2. **E-mail + password (fallback).** Direct token grant with the account credentials, shown only if device-link is unavailable. Credentials are exchanged immediately for tokens and not persisted; `.env` override (`AUTODARTS_EMAIL`/`AUTODARTS_PASSWORD`) with the 409 refuse-overwrite pattern from `youtube-credentials.js`.

### 4.3 Live events

`WS /ms/v0/subscribe`, authenticated with the Bearer token. The web app's own traffic (per tools-for-autodarts) rides channels including `autodarts.boards` (board status — this is how a match starting *on the board* is detected, and it carries the match id) and `autodarts.matches` (per-match state: throws, turn completions, leg results / "GameShot", match finish). **Verify** the exact subscribe message shape and event payloads from darts-caller's source plus a live capture; the ledger's probe script exists for exactly this. While there, confirm that live throw events carry the same coordinates the corrections/throw shapes show, and calibrate the coordinate space by checking that reported segments land inside their beds after mapping — the live board (§11.2) depends on it.

### 4.4 The one known gap

The **match-history list** endpoint (what the play.autodarts.io "Match history" page calls) is not in the ledger. The design therefore never depends on it: the live service archives every match it watches, so data accrues forward regardless. Backfill of older matches is a bonus the agent wires up after capturing that endpoint from the history page (it exists — the page is right there — it just needs one DevTools session to name). If it cannot be confirmed, ship without backfill and say so in the Settings card ("Archive builds from live matches").

---

## 5. Data model and storage

JSON files under `data/`, atomic writes (temp + rename), getters that reload from disk — same rules as every other feature. No database.

### 5.1 `data/autodarts-credentials.json` (encrypted fields via `secret-box.js`)

```jsonc
{
  "refreshToken": "<encrypted>",
  "userId": "…",                 // the linked account
  "userName": "TRASHPANDA",
  "boardId": "…",                // the chosen board (from GET /bs/v0/boards)
  "boardName": "Game Room",
  "linkedAt": "2026-08-23T…"
}
```

Access tokens live only in memory. A failed refresh writes an auth-status flag the Settings card reads ("Re-link needed"), mirroring the Tesla/Alexa pattern.

### 5.2 `data/autodarts-settings.json`

```jsonc
{
  "live": {
    "autoPush": true,                 // push the live card when a match starts on the board
    "inactivityMinutes": 15,          // 5 | 10 | 15 | 30 | 60 — quiet time before the card closes for good
    "finalHoldSeconds": 60            // how long the FINAL card stays after game shot
  },
  "dashboard": {
    "leaderboardSize": 8,             // 3–16; "all players ever" capped so the screen never overloads
    "displaySeconds": 120
  },
  "lastMatch": { "displaySeconds": 90 },
  "sync": { "historyBackfill": true } // only takes effect once the history endpoint is confirmed
}
```

### 5.3 Match archive — `data/autodarts-matches/YYYY-MM.jsonl`

One JSON line per finished match, month-partitioned like `scheduler-activity` (retention is a file delete; the archive is small — a few KB per match):

```jsonc
{
  "matchId": "…",                       // dedupe key — a match is archived once
  "variant": "X01",
  "settings": { "baseScore": 501, "inMode": "SI", "outMode": "DO", "legs": 2, "maxRounds": 50 },
  "local": true,
  "startedAt": "…", "finishedAt": "…", "durationSec": 638,
  "players": [
    {
      "name": "TRASHPANDA", "userId": "…",        // userId null for board guests
      "legsWon": 2, "setsWon": 0,
      "average": 25.03, "first9": 28.83, "dartsThrown": 29,
      "pointsScored": 242,                          // when derivable — powers the true lifetime average
      "checkoutPct": 14.29, "checkoutHits": 2, "checkoutAttempts": 14,
      "bestCheckout": 16, "counts": { "60": 0, "100": 0, "140": 0, "170": 0, "180": 0 }
    }
  ],
  "winner": "TRASHPANDA",
  "source": "live" | "backfill"
}
```

Populated from `GET /as/v0/matches/{id}/stats` (retried past its not-ready 404) merged with what the live session already knows (variant, settings, duration, winner). Fields the stats call doesn't provide for a variant are simply null — the aggregator skips nulls.

### 5.4 Player aggregates — `data/autodarts-players.json`

Recomputed from the archive on every new match (idempotent full pass; hundreds of matches recompute in milliseconds). Keyed by lowercased trimmed name; `displayName` keeps the most recent casing. Per player:

`matches, wins, winPct, legsWon, legsPlayed, x01Average, x01BestMatchAverage, checkoutPct, bestCheckout, counts{60,100,140,180}, firstSeenAt, lastPlayedAt, isGuest`

**X01 average, defined precisely:** lifetime average = `sum(pointsScored) / sum(dartsThrown) × 3` over X01-family matches when `pointsScored` is available; otherwise the darts-thrown-weighted mean of per-match averages. Never a plain mean of match averages — a 9-dart leg and a 90-dart slog don't weigh the same.

---

## 6. Ranking and the crown

- **Leaderboard order:** wins (match wins, all variants) descending → win% descending → X01 lifetime average descending. The crown marks row 1. Every row shows `matches` so a 3-0 newcomer sitting above a 14-20 regular is legible at a glance.
- **Wins count across all variants** (a win is a win); the skill columns (`average`, `checkout%`, `best checkout`, `180s`) come from **X01-family matches only** and are labeled that way — mixing Cricket marks into a points average would be nonsense.
- **Leaderboard size** comes from settings (default 8). The dashboard shows `+N more players` under the table when the archive holds more than fit.
- Name normalization is case-insensitive only in v1. Alias merging ("Ward" = "WAR D") is v2; leave a comment where the key is built.

---

## 7. Live match service — `src/autodarts-live.js`

A supervisor in the style of `youtube-lounge.js`: owns the WebSocket, reconnects with backoff across normal endings, refreshes tokens before expiry, and tracks *why* it is down (`unavailableReason`) so the Settings card and logs name the actual problem.

### 7.1 State machine

```
        board event: match started                      every throw/turn event
 idle ────────────────────────────▶ live ◀──────────────────────────────┐
  ▲                                  │  │                               │
  │        autodarts.match.close     │  │ another page pushed           │
  │◀──────────── inactivity ─────────┘  ▼                               │
  │        (no event for N min)     interrupted ── hold elapses AND     │
  │                                     │          match still active ──┘  (re-push, resume)
  │        game shot / match finish     │
  └◀── final card (finalHoldSeconds) ◀──┘ ──▶ fetch stats (retry 404) ──▶ archive ──▶ aggregates
```

Rules, spelled out:

1. **Start:** board channel reports an active match → seed with `GET /gs/v0/matches/{id}/state` → subscribe the match channel → if `live.autoPush`, send `autodarts.match` (persistent, like `steam.now-playing`).
2. **Update:** every event rebuilds the payload; resend **only when displayed content changed** — an identical re-push must not restart the panel's animations (the PSN lesson, already a house rule).
3. **Interrupt + resume:** `display-busy` tracks what's on screen. When an interrupting page's hold elapses, and the match is still active, and the last match event is younger than `inactivityMinutes` → re-push the live card. This is exactly the Steam "interrupt restore re-push" behavior — copy `steam-now-playing.js`'s handling and its test.
4. **Inactivity:** a timer resets on every match event. On expiry: send `autodarts.match.close`, stop resuming, go dormant. If the same unfinished match produces a new event later (someone came back to the board), treat it as a fresh start — push again, timer restarts. The threshold is the 5/10/15/30/60-minute setting, default 15.
5. **Finish:** on game shot / match finished, switch the card to its FINAL state (winner crowned, "GAME SHOT — D16" line when the winning throw is known), hold `finalHoldSeconds`, then close. In parallel fetch `/as/v0/matches/{id}/stats` with backoff (45s → 90s → 3m → 5m, the PSN-style ladder) until it stops 404ing, then archive and recompute aggregates.
6. **Multiple boards:** v1 watches the one configured board. The board picker exists so a second board later is a settings change, not a redesign.

### 7.2 Payload — `autodarts.match` (one type for live and final)

Small (~1–2 KB), full state each send. Throws are objects, not strings, because the display draws them on a board:

```jsonc
{
  "version": 2, "type": "autodarts.match", "persistent": true,
  "match": {
    "matchId": "…", "revision": 41,          // client ignores stale revisions
    "status": "live" | "finished",
    "variant": "X01",
    "settingsLine": "501 · SI-DO · First to 2 legs",
    "startedAt": "…", "durationSec": 412,
    "currentPlayerIndex": 0,
    "turn": {
      "points": 65, "busted": false,
      "darts": [
        { "seg": "T20", "x": 0.12,  "y": -0.34, "type": "normal" },
        { "seg": "5",   "x": -0.61, "y": 0.42,  "type": "normal" },
        null                                   // not thrown yet
      ]
    },
    "prevTurn": {                              // the last completed turn — the board's ghost dots
      "playerIndex": 1, "points": 41,
      "darts": [
        { "seg": "20", "x": 0.03, "y": -0.71, "type": "normal" },
        { "seg": "1",  "x": 0.28, "y": -0.66, "type": "normal" },
        { "seg": "M",  "x": 1.24, "y": 0.31,  "type": "normal" }   // a miss keeps its coords
      ]
    },
    "players": [
      { "name": "TRASHPANDA", "score": 261, "legs": 1, "sets": 0,
        "average": 25.03, "lastTurnPoints": 85, "isWinner": false },
      { "name": "WAR D", "score": 356, "legs": 0, "sets": 0,
        "average": 20.89, "lastTurnPoints": 41, "isWinner": false }
    ],
    "gameShot": null                          // "D16" on the final card when known
  }
}
```

Coordinates pass through exactly as Autodarts reports them — the bridge never invents or adjusts a position; `x`/`y` are null when the event carried none. Misses arrive as their own throw objects (segment "M"/outside coordinates); bounce-outs carry `type: "bouncer"`. Because the client redraws the whole board from each payload, an upstream throw correction fixes the display for free on the next event. For non-X01 variants v1 fills `score` with the variant's headline number (Count Up total, Cricket points, Killer lives) and leaves X01-only fields null; the board and turn strip work identically in every variant, because throws are throws. `autodarts.match.close` carries only the matchId. The last-match card is this same payload with `status: "finished"`, `persistent: false`, and `displaySeconds` from settings — one payload type, one client code path.

### 7.3 Dashboard payload — `autodarts.dashboard`

All pre-aggregated on the bridge (the client only draws), ~2–4 KB with the leaderboard capped by settings; add a byte-bound test like Roll Credits' start payload:

`totals { matches, legs, thisMonth, lastPlayedAt }` · `leaderboard[] (per §6)` · `moreCount` · `byMonth[12]` · `byVariant[]` · `rivalry { a, b, aWins, bWins, lastWinner, lastPlayedAt }` (the most-played pairing) · `records { bestMatchAverage {value, player}, highestCheckout {value, player}, total180s }` · `recent[3] { variant, players, result, winner, when }`

---

## 8. History backfill — `src/autodarts-history.js`

Runs after link and every 6 hours (plus a manual "Sync history" button using the 202 + poll pattern from trivia refill): walk the confirmed history-list endpoint newest-first, stop at the first already-archived matchId, fetch each new match's stats, archive, recompute. Politeness: sequential, spaced calls (the trivia-providers spacing helper), bounded pages per run. Until the endpoint is confirmed (§4.4), the module exists with the sync disabled and the card reads "Archive builds from live matches".

---

## 9. Admin — the Settings card

One full-width card, `.settings-columns` layout like Trivia/YouTube:

1. **Account** — unlinked: a "Link Autodarts" button → shows the short device code + an "Open autodarts.io to approve" link, polling until linked (fallback: e-mail + password fields when device-link is unavailable). Linked: "Linked as TRASHPANDA · Re-link · Unlink". Auth trouble shows the self-named reason.
2. **Board** — picker fed by `GET /bs/v0/boards` (name + id), plus a live status dot from board state ("Game Room · online"). One board selectable in v1.
3. **Live match** — auto-push toggle (default on); inactivity segmented control `5 · 10 · 15 · 30 · 60 min` (default 15); final-card hold seconds (30–180, default 60).
4. **Dashboard** — leaderboard size (3–16, default 8); seconds-on-screen sliders for dashboard (120) and last match (90).
5. **Archive** — "412 matches archived · last sync 2h ago", **Sync history** button (or the builds-from-live note), and a **Test** button that runs one authenticated read and reports plainly ("Autodarts ok — board Game Room online" / the exact failure).

---

## 10. Push and Scheduler — command registry entries

Three descriptors in group `Autodarts` (one new Push row). Mirroring Steam/PSN semantics exactly:

| id | title | pushable | schedulable | content check | duration |
|---|---|---|---|---|---|
| `autodarts.now` | `Autodarts` — "Live match, or the last one" | yes | yes | yes (live match OR archive non-empty) | 90s fixed (live pushes are persistent anyway) |
| `autodarts.last-match` | `Autodarts — last match` | no | yes | yes (archive non-empty) | `lastMatch.displaySeconds` |
| `autodarts.dashboard` | `Autodarts Dashboard` — "Leaderboard, records & charts" | yes | yes | yes (archive non-empty) | `dashboard.displaySeconds` |

`autodarts.now` is the auto tile: live card if a match is running on the board, else the last-match card — the same auto pattern as the single Steam/PSN/YouTube tiles. A scheduled `autodarts.last-match` rule can never accidentally air a live takeover (`airCommand` forces the mode from the command id, the existing rule). The live auto-push path itself never goes through the scheduler — it is event-driven, and `display-busy` keeps the two from fighting.

Optional, build last: a routine matcher in `display-voice-commands.js` ("Alexa, show darts" → `autodarts.now`; "show darts dashboard" → dashboard), toggle `voiceEvents.autodartsQueries` default on.

---

## 11. Display experience — what to show and why

### 11.1 Dashboard (the page Luis pushes or schedules)

The leaderboard is the hero — the question the page answers is *"who plays here, and who's the best?"* Content, in priority order:

**Must-have:**
- **Totals strip:** matches recorded · legs played · this month · last played ("2 days ago").
- **Board leaderboard** ("hall of fame"): rank, 👑 crown on row 1 (gold), name, W–L, win%, X01 avg, best checkout, 180s, matches. Guests and account holders identical. Capped by `leaderboardSize` with a `+N more players` footer line.
- **Matches per month:** 12-bar chart, current month in gold (the same chart language as the Roll Credits dashboard — the two features should feel like siblings on the wall).
- **Rivalry:** the most-played pairing as a head-to-head — `TRASHPANDA 23 — 14 WAR D`, last result and date. On a household board this is the panel people actually argue about.

**Nice-to-have (in order):** house records row (best match average, highest checkout, lifetime 180 count — the 180 counter rendered big and gold even at zero, because the day it ticks to 1 is a household event); variant split bars (X01 / Cricket / Killer / …); recent results strip (last 3 matches, one line each).

### 11.2 Live match page — the board is the centerpiece

The page is built around a **drawn dartboard** showing where every dart of the current turn landed — three throws per player per round, misses included — so the wall gets livelier with each throw instead of only counting numbers down.

- Header pill `autodarts` + a **LIVE** chip (alert coral); settings line `501 · SI-DO · First to 2 legs` + running duration.
- **The board** is the largest element on the page, drawn by the client to look like the real thing (§12). On it:
  - the current thrower's darts as numbered accent dots (① ② ③) at their reported coordinates, appearing one by one as events arrive;
  - the previous completed turn as small dim ghost dots, cleared the moment the next turn's first dart lands — the per-round rhythm Luis described;
  - a **miss** as a dim ✕ at its reported coordinates outside the double ring (when only the segment says miss, pin the ✕ just outside the rim — never invent a position);
  - a **bounce-out** (`type: "bouncer"`) as a hollow ring marker;
  - nothing else — no text or chips over the board face (house rule).
- **Coordinate truth:** map Autodarts' normalized coordinates onto standard board geometry (§12 ratios) and calibrate during implementation — a reported `T20` must land inside the treble-20 bed after mapping, checked across several known segments, before dots ship. If live events turn out to carry segments but no coordinates, place each dot at its segment bed's centroid: deterministic, honest, and noted in PROJECT.md.
- **Scores** flank or top the board, compact: name with the ▶ thrower marker and accent edge, remaining score as the biggest number after the board, legs (crown on the leg leader), match average, last-turn points.
- **Turn strip** under the board: three dart slots filling in as thrown (`T20 · 5 · —`), running total, `BUST` washing the strip in alert when it happens.
- Landscape: player column — board — player column, slots under the board. Portrait: compact score row on top, board center-stage, slots beneath — and the page **must use its full height**: the score row, board, and turn strip spread vertically with the board absorbing the slack, never a squished top half over dead space. Three or four players: the score blocks compress into rows; the board stays put.
- Other variants (v1): the board and turn strip work unchanged; the score blocks show the variant's headline number.
- No dismiss footer while live (persistent page, like Steam Now Playing).

### 11.3 Final card

The live layout frozen, plus the whole match's picture: **FINAL** chip replaces LIVE, winner crowned gold, `GAME SHOT — D8` when the winning dart is known, the legs result — and a **match hit-map**: two mini boards side by side, one per player, every recorded dart of the match plotted from the archived stats coordinates (the same data the Autodarts match page plots). Skipped cleanly for a match with no coordinates. Held `finalHoldSeconds`, then closes. The last-match card is exactly this, aired on demand with a dismiss footer.

### 11.4 Portrait and landscape

Both first-class, geometry through `design_u` / `page_chrome()`. Portrait dashboard stacks totals → leaderboard → chart → rivalry; landscape puts the leaderboard left (~55%) and stacks totals/chart/rivalry/records right. Live: player columns side-by-side in both; landscape widens the turn strip into a center column between them. §13 wireframes are normative for placement.

### 11.5 v2 parking lot (comment these where relevant, build nothing)

Cricket marks grid; player alias merge; multi-board support; a "form" sparkline per leaderboard row (last 5 results).

---

## 12. Design guidelines

- Tokens: display frames use `design_system.py` exactly (`BG #0B1730`, `FILL #141F35`, `LINE #264060`, ink ramp, `ACCENT #5FD0FF`); sharp corners; nothing composited over imagery (there is no imagery here — the page is typographic, which is its look: a scoreboard, not a poster).
- **Gold (`WARN #F5C453`) is achievement-only**, consistent with Roll Credits' induction gold: the crown, the leader's row highlight, the 180 counter, house records. Nowhere else.
- **LIVE chip** uses `ALERT #FF7A6B`; it is the only alert-colored element and appears only while a match is genuinely live. FINAL uses ink on `FILL`.
- Charts match the Roll Credits chart language: accent bars, gold highlight bar, every bar labeled with its number, no legends.
- **The board is drawn to look real** — the same look as Autodarts' own board view, so the wall reads instantly as a dartboard: near-black surround carrying the white numbers ring (numbers rotated tangentially), cream and matte-black beds alternating, red and green double/treble bands alternating per segment (black beds carry red bands, cream beds carry green), green outer bull, red inner bull, thin dark wires. Reference tones, tuned to sit on the navy wall: surround `#111111`, black beds `#161616`, cream `#F2ECD8`, red `#D64541`, green `#3E9B5F`, numbers `#F2F7FF`, wires `#0A0A0A`. Standard geometry ratios normalized to double-outer = 1.0: double band 0.953–1.00, treble band 0.582–0.629, outer bull 0.094, inner bull 0.037 — so mapped coordinates land truthfully. The board is this page's imagery: nothing sits over its face except the dart markers. Dart dots are `ACCENT` with a white core, a soft dark shadow, and a small 1/2/3 index (ice blue reads on both cream and black beds); ghost dots are `INK2` with a thin dark outline; the miss ✕ is `INK2` on the surround — alert stays reserved for LIVE and BUST.
- **Signature element: the crown.** One glyph, drawn (not emoji) in the client at three sizes — leaderboard row 1, live-page leg leader, final-card winner. It encodes something true (current standing) rather than decorating.
- Numbers are the typography: remaining scores and the leaderboard use the largest type on the wall — readable from a dartboard's throwing distance (2.37 m), which is the actual viewing distance in that room.
- Admin card uses the admin tokens verbatim; copy rules as before (plain verbs, errors name the fix, empty state invites: "No matches yet — play one and the archive starts itself").

---

## 13. Wireframes (normative for placement, not pixel art)

### 13.1 Admin — Settings card

```
┌─ Autodarts ──────────────────────────┐
│ ACCOUNT   Linked as TRASHPANDA       │
│           [Re-link] [Unlink]         │
│   (unlinked: [Link Autodarts] →      │
│    code  ▐ 4 F 7 - K 2 ▌             │
│    [Open autodarts.io to approve])   │
│ BOARD     [Game Room ▾]  ● online    │
│ LIVE      auto-push [on ●]           │
│   inactivity (5|10|15|30|60) min     │
│   final card hold ──●── 60s          │
│ DASHBOARD leaderboard size [ 8 ]     │
│   dashboard ──●── 120s  last ──●──90s│
│ ARCHIVE   412 matches · sync 2h ago  │
│           [Sync history]  [Test]     │
│           ✓ ok — board online        │
└──────────────────────────────────────┘
```

### 13.2 Display — dashboard, PORTRAIT (1080×1920)

```
┌────────────────────────────────┐
│  ◷ 8:41          autodarts     │
├────────────────────────────────┤
│   412      1,204     18    2d  │
│ MATCHES    LEGS    THIS MO LAST│
├────────────────────────────────┤
│  BOARD LEADERBOARD             │
│  👑 1 TRASHPANDA  23-14  62%   │
│       avg 25.0 · hi 48 · 180:0 │
│   2 WAR D         14-23  38%   │
│       avg 20.9 · hi 40 · 180:0 │
│   3 KYLIE          3-2   60%   │
│   4 TOMMY          1-4   20%   │
│   + 3 more players             │
├────────────────────────────────┤
│  MATCHES PER MONTH             │
│  ▂▄▃▆▄▅▂▇▃▄▆█   ← current=gold │
│  S O N D J F M A M J J A       │
├────────────────────────────────┤
│  RIVALRY                       │
│  TRASHPANDA  23 ── 14  WAR D   │
│  last: TRASHPANDA won · Aug 1  │
├────────────────────────────────┤
│  RECORDS  avg 36.3 · hi ✓ 48   │
│  180s: 0 (someday)             │
├────────────────────────────────┤
│      Dismisses in 92s ▂▂▂      │
└────────────────────────────────┘
```

### 13.3 Display — dashboard, LANDSCAPE (1920×1080)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◷ 8:41                     autodarts                                │
├──────────────────────────────────────┬───────────────────────────────┤
│  BOARD LEADERBOARD                   │  412   1,204    18    2 days  │
│  👑 1 TRASHPANDA 23-14 62% avg 25.0  │ MATCHES LEGS  THIS MO  LAST   │
│       hi 48 · 180:0 · 37 matches     ├───────────────────────────────┤
│   2 WAR D        14-23 38% avg 20.9  │ MATCHES PER MONTH             │
│   3 KYLIE         3-2  60% avg 18.4  │ ▂▄▃▆▄▅▂▇▃▄▆█                  │
│   4 TOMMY         1-4  20% avg 15.1  │ S O N D J F M A M J J A       │
│   + 3 more players                   ├───────────────────────────────┤
│                                      │ RIVALRY                       │
│                                      │ TRASHPANDA 23 ── 14 WAR D     │
│                                      │ last: TRASHPANDA · Aug 1      │
│                                      ├───────────────────────────────┤
│                                      │ RECORDS avg 36.3 · hi 48      │
│                                      │ 180s: 0                       │
├──────────────────────────────────────┴───────────────────────────────┤
│                       Dismisses in 92s ▂▂▂                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 13.4 Display — live match, PORTRAIT

```
┌────────────────────────────────┐
│  ◷ 8:41    autodarts    LIVE   │
├────────────────────────────────┤
│ 501 · SI-DO · First to 2L 6m52 │
├───────────────┬────────────────┤
│ ▶ TRASHPANDA  │    WAR D       │
│  261   👑 1   │   356    0     │
│  avg 25.03    │   avg 20.89    │
├───────────────┴────────────────┤
│            20                  │
│        ╭───①───╮               │
│    5 ╱     ②    ╲ 1            │
│     │           │              │
│  11 │   (bull)  │ 6            │
│     │      ∘∘   │        ✕     │
│    8 ╲         ╱ 10            │
│        ╰───────╯               │
│            3                   │
│ ① ② this turn · ∘ last · ✕ miss│
├────────────────────────────────┤
│ ▐ T20 ▌ ▐  5 ▌ ▐ — ▌     = 65  │
└────────────────────────────────┘
```

*(Portrait spreads across the full content height — the board absorbs the slack between the score row and the turn strip; no dead space below.)*

### 13.5 Display — live match, LANDSCAPE

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◷ 8:41                     autodarts                          LIVE  │
├──────────────────────────────────────────────────────────────────────┤
│              501 · SI-DO · First to 2 legs   ·   6m52                │
├───────────────────┬──────────────────────────────┬───────────────────┤
│  ▶ TRASHPANDA     │              20              │       WAR D       │
│                   │          ╭───①───╮           │                   │
│       261         │      5 ╱     ②    ╲ 1        │        356        │
│                   │       │           │     ✕    │                   │
│   legs 👑 1       │    11 │   (bull)  │ 6        │      legs 0       │
│   avg 25.03       │       │      ∘∘   │          │      avg 20.89    │
│   last 85         │      8 ╲         ╱ 10        │      last 41      │
│                   │          ╰───────╯           │                   │
│                   │              3               │                   │
│                   │   ▐T20▌ ▐ 5 ▌ ▐ — ▌  = 65    │                   │
└───────────────────┴──────────────────────────────┴───────────────────┘
```

### 13.6 Display — final card (portrait; landscape mirrors 13.5)

```
├────────────────────────────────┤
│  ◷ 8:52    autodarts   FINAL   │
│  501 · SI-DO · 10m38s          │
│ 👑 TRASHPANDA   2 — 0   WAR D  │
│      GAME SHOT — D8            │
│  avg 25.03      avg 20.89      │
│  MATCH HIT-MAP                 │
│   ╭┄∘∘┄╮         ╭┄∘┄╮         │
│   │∘∘ ∘│         │ ∘∘│         │
│   ╰┄∘┄─╯         ╰┄∘∘╯         │
│  TRASHPANDA       WAR D        │
│      Dismisses in 60s ▂▂▂      │
```

---

## 14. Testing requirements

New tests required; the entire existing suite stays green. **Before every commit: `run_all_tests.bat`.**

### 14.1 New bridge tests (`test/autodarts*.test.js`)

- **Auth:** device-link poll flow (mocked Keycloak): pending → approved → tokens stored encrypted; password fallback exchanges and never persists the password; refresh via `/auth/v1/refresh`; failed refresh sets the re-link flag; `.env` override 409.
- **Read-only guard:** the HTTP helper exposes no write verbs to game endpoints — a unit test asserts the forbidden paths/methods are unreachable.
- **Live state machine (mocked WS fixtures, injectable clock):** start → seed → push; per-throw update resends only on content change; interrupt then hold-elapse + active match → resume re-push; inactivity expiry → close + dormant; dormant + new event → fresh push; finish → FINAL payload → hold → close; stats fetch retries through the 404-until-ready window then archives exactly once (matchId dedupe); reconnect/backoff across socket closes; `unavailableReason` set on auth loss and on missing subscription.
- **Aggregates:** weighted lifetime average math (pointsScored path and fallback path); wins-across-variants vs X01-only skill columns; crown tie-breaks (wins → win% → avg); case-insensitive name keying with most-recent display casing; guest vs account rows; leaderboard cap + `moreCount`; month buckets across a year boundary; rivalry pairing selection.
- **Payloads:** `autodarts.match` shape live vs finished; revision monotonicity; non-X01 generic fill; last-match = finished + non-persistent + displaySeconds; dashboard payload byte bound at leaderboardSize 16.
- **Board data:** `turn.darts` objects carry segment, passthrough coordinates, and type for every throw including misses and bounce-outs; coordinates are null when the event had none — never synthesized; `prevTurn` holds the last completed turn and switches on player change; an upstream throw correction changes the next payload (the redraw-from-payload board is correction-proof by construction); the payload byte bound holds with full dart objects.
- **Commands/routes:** three descriptors pass `assertValid()` and appear once in `GET /api/commands`; content checks (empty archive, live match); `autodarts.now` auto split (live vs last); scheduled last-match can't air live; settings/credentials routes admin-gated; Test and Sync endpoints report plainly; SSE-free — no public routes exist for this feature (assert none were added).
- **History backfill:** stops at first known matchId; sequential spacing; disabled-until-confirmed flag path.

### 14.2 New client tests (`test_autodarts_panel.py`)

Payload type detection; dashboard layout portrait + landscape (leaderboard rows, crown on row 1, gold current-month bar, `+N more` line); live layout both orientations with the board as centerpiece — coordinate-to-pixel mapping verified against known segments (a `T20` dot must land inside the treble-20 wedge in both orientations), segment-centroid fallback when coordinates are absent, miss ✕ and bounce-out markers, ghost dots clearing on the next turn's first dart, thrower marker, dart slots, bust state, 3–4 player rows; redrawing from an identical payload changes nothing on screen and restarts no animation; revision-stale payloads ignored; final card (FINAL chip, crown, game-shot line, per-player mini hit-maps rendering — and skipping cleanly for a match without coordinates); close handling.

### 14.3 Regression assertions

Full `npm test` + client suite unchanged and green; no existing UDP type, route, or command id touched; registry valid; scheduler still enumerates and airs all pre-existing commands; startup clean with no autodarts files present (feature only adds new files).

---

## 15. Non-functional requirements

- **Fail-soft:** every Autodarts failure degrades to cached data + a self-named reason; the display never shows a stack trace and the bridge never crashes on a malformed event (log + skip).
- **Read-only guarantee:** §0 rule 4, enforced in code and tested.
- **Politeness:** one WebSocket, no polling loops while it's healthy; REST calls bounded and spaced; backfill sequential.
- **Secrets:** tokens encrypted at rest via `secret-box.js`; never in logs; no public HTTP routes added by this feature.
- **Footprint:** archive is a few KB per match — decades of household darts fit in megabytes. No media storage at all.

---

## 16. Delivery plan

| Phase | Contents | Done means |
|---|---|---|
| **1a — Sign-in** | Auth (device-link + fallback), refresh, board discovery, Settings card, Test | Linked account + board shown; failures self-name; tests green |
| **1b — Archive + dashboard** | Archive, aggregates, dashboard payload + panel (both orientations), push/schedule, backfill scaffold | Dashboard airs from real archived matches; byte-bound test in place |
| **1c — Live** | WS supervisor, auto-push, live board render (coords calibrated), resume, inactivity, final card + hit-map, archive-on-finish, last-match card | A real match on the board appears, survives an interruption, closes on quiet; suite green |

Each phase ends with the full test run, PROJECT.md (both) Recent-changes entries with deploy notes, and a README section update.

---

## 17. Decisions

**Decided (from Luis's brief):** inactivity default **15 minutes**, options 5/10/15/30/60; leaderboard capped and configurable; dashboard is the manual/scheduled page and live is event-driven.

**Still open for Luis — everything else has a chosen default:**

1. **Leaderboard default size** — 8 rows (portrait shows ~6 comfortably with stats, landscape all 8). Good default?
2. **Live auto-push default ON** — a match starting in the game room takes the wall display (and politely returns after interruptions). Confirm on-by-default?
3. **Final card hold** — 60 seconds of the winner's glory before the display moves on. Longer?

---

## Revision history

- **r3 — 2026-08-23:** Board rendering respecified as a faithful classic board (Autodarts-style: cream/black beds, per-segment red/green bands, white numbers ring) replacing the earlier palette-toned board; dart/ghost/miss marker contrast rules updated for the new surfaces; portrait live layout now required to fill its full height (board absorbs the slack). Companion `autodarts-wireframes.html` re-rendered with a true SVG mini board and the spread portrait frame.
- **r2 — 2026-08-23:** Live page redesigned around a drawn dartboard: per-turn dart dots at reported coordinates (misses and bounce-outs marked, previous turn ghosted), payload upgraded to dart objects + `prevTurn`, coordinate-calibration verification added, board palette rules added to §12, final card gains the per-player match hit-map (moved out of the v2 parking lot), wireframes and tests updated. Companion `autodarts-wireframes.html` updated to match.
- **r1 — 2026-08-23:** Initial plan. API facts sourced from the community discovery ledger (`thomasasen/autodarts_local_tournament`, 17 Mar 2026), `lbormann/darts-caller`, and `creazy231/tools-for-autodarts`; match-history list endpoint flagged as the one to capture during implementation. Companion file: `autodarts-wireframes.html` (visual versions of §13; §13 stays normative).
