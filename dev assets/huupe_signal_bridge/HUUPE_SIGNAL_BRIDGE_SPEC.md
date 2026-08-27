# Huupe Mini × Signal Bridge — Agent Handoff Spec

**Status:** Requirements + technical design (not yet implemented)  
**Owner intent:** Personal LAN integration for one Huupe Mini (HM2). No official Huupe API; reverse-engineered from device access.  
**Primary code repo:** [signal-bridge](https://github.com/lmsilva/signal-bridge)  
**Research / captures only:** this workspace (`Huupe Mini/research/`) — do **not** put long-term product code here.

Pass this document to an implementing agent. Prefer cloning `signal-bridge` and implementing there.

---

## 1. Goal

Make the Huupe Mini a first-class Signal Bridge source (same class as Autodarts / Steam presence / displays):

1. Live Family Mode / City Royale games → overlays on software displays + Vestaboard  
2. Archive every finished game (history + aggregates)  
3. Sync player profile / career card (OVR, makes/attempts, zone FG%, ratings, bucks, wins)  
4. **Harvest all useful hoop state** for Signal Bridge (not only live games): Just Huupe cloud stats, notifications, Daily Prize / Fitness / Huupe Live sessions, badges, attempt quotas, inventory/swag, fitness challenges, multi-profile, device health, app focus/intents  
5. Signal admin “Huupe” tab for status, live match, profile, catalogs, history, settings  

**Primary path:** on-device Android agent (sideloaded APK) that watches logcat, reads local stores, calls Huupe cloud with the device JWT, and emits encrypted LAN events.  
**Not primary:** continuous ADB from Mac/NAS (fragile after reboot; keep only for install/debug).

**Performance stance:** harvesting everything is **not** overkill if done with **tiers + change detection + HTTP for large blobs**. Flooding UDP with badge catalogs every few seconds *would* be overkill — the design below avoids that.

---

## 2. Device facts (proven)

| Item | Value |
|------|--------|
| Model | HM2 / `huupemini2` |
| OS | Android 13, Rockchip **rk356x** |
| Build | **userdebug** → `adb root` works |
| Access | Wireless ADB (USB often fails on Mac). After reboot: reconnect wireless debugging; re-run `adb root`. TLS wireless port is flaky; plain `:5555` worked. |
| Sideloading | [r/huupemini guide](https://www.reddit.com/r/huupemini/comments/1iakhpi/sideloading_mini_huupe/) — Developer Options + USB debugging; **no jailbreak** |
| Example LAN | `192.168.200.216:5555` (IP/port change over time) |

### Key packages

| Role | Package |
|------|---------|
| Launcher | `com.acdetorres.huuplauncher` |
| Just Huupe | `com.huupe.justhuupe` |
| Family Mode / City Royale | `com.game.huupecityroyale` (Unity; deep link `unitydl://cityroyale?...&gameMode=OfflineMode`) |
| Daily Prize | `com.game.huupedailyprize` |
| Fitness | `com.game.huupeminifitness` |
| Huupe Live | `com.huupe.huupelive` |
| OTA / bort | `com.huupe.mini.bort`, `com.huupe.mini.bort.ota` (ops only; optional version report) |
| Shot HAL | `huupe.hardware.shottracker.IShotTracker` / service `huupe.hardware.shottracker-tof-service` |

### Local data stores (root pull)

| Store | Path / notes |
|-------|----------------|
| Launcher profiles | Room DB `AppDB` → table `profiles`: username, email, country, gender, `profileImageId`, `huupeBucks`, **JWT `token`** (sensitive), `loggedProfile` |
| City Royale prefs | `com.game.huupecityroyale.v2.playerprefs.xml` — `mrAppData`, `scoreData` (often `[]`), `attempts`, `swagStoreData`, `badgesMetaData` |
| Fitness prefs | `HUUPEMINIFITNESS`, `BADGESDATAKEY` (full catalog), `UNLOCKEDCHALLENGES`, `TASKSDIRTYDATAKEY` |
| Huupe Live | `sessionDataStore.data`, `sessionConfigsDataStore.data` under `com.huupe.huupelive/files/datastore/` |
| Just Huupe | `settings.preferences_pb` (small; stats mostly cloud) |

Pulled copies live under:

`research/device-recon/pulled/`

Family Mode session logs:

`research/device-recon/family-mode/` (`filtered.log`, `full.log`, …)

Shot samples:

`research/device-recon/session-shots.jsonl`

---

## 3. Architecture (chosen)

Mirror **Autodarts**: on-device producer → Signal Bridge owns live state, archive, display push.

```
Huupe Mini
  Unity / apps (City Royale, Just Huupe, Daily Prize, Fitness, Live, Launcher)
       → logcat + local DBs/prefs + cloud APIs (device JWT)
       → huupe-agent APK (foreground service)
            → AES-256-GCM v3 UDP → bridge :47833   (small / live)
            → POST /api/huupe/events                 (large / catalogs / reliable)

Signal Bridge (NAS)
  listener discovery decrypt
       → huupe-service (live + archive + harvest store + aggregates)
            → UDP :47832 display overlays (huupe.live / final / profile / …)
            → Vestaboard pushEvent
            → Signal admin “Huupe” tab
            → data/huupe-games/*.jsonl
            → data/huupe-profiles/<username>.json
            → data/huupe-harvest/  (badges, inventory, attempts, challenges, …)
```

### Wire protocol (reuse existing — do not invent)

- Same `LAN_UDP_SECRET` / AES-256-GCM **v3** as `src/lan-crypto.js` and display client `lan_crypto.py`  
- Inbound discovery: **`:47833`** (same socket as `display.announce`)  
- Outbound overlays: **`:47832`** via existing `sendUdpPayload`  
- Pattern references in signal-bridge: Autodarts modules, Steam presence reporter → `/api/steam/presence`

### Why on-device agent

- Survives Mac disconnect  
- Parity with display announce model  
- ADB-from-NAS is reboot-fragile (`adb root` + wireless port)

---

## 4. Repo placement (all product code in signal-bridge)

| Piece | Path |
|-------|------|
| Android agent | `tools/huupe-agent/` (Kotlin + README + adb install notes) |
| Bridge modules | `src/huupe-*.js` |
| Discovery / listener | extend `src/listener.js` (and related UDP discovery callback) |
| Payload helpers | extend `src/udp-payload.js` as needed |
| Display panel | `alexa broadcast client/src/huupe_panel.py` (clone `autodarts_panel.py`) |
| Vestaboard | `src/vestaboard/formatters/gaming.js` (+ router aliases) |
| Admin UI | Signal admin tab “Huupe” |
| Config | `config.example.json` → `huupe.*`; document `LAN_UDP_SECRET` |
| Replay harness | e.g. `npm run huupe-replay` from captured Family Mode logs |

This Huupe Mini workspace stays research only.

---

## 5. On-device agent requirements (`tools/huupe-agent`)

### 5.1 Runtime

- Kotlin Android app, **foreground sticky service**  
- `BootReceiver` to restart after reboot  
- Sideload: `adb install` / `adb install -r`  
- Log access: `READ_LOGS` and/or root logcat (userdebug proven)  
- Config on device: `bridgeHosts[]`, `discoveryPort` (47833), `udpSecret` (= NAS `LAN_UDP_SECRET`), display name, optional HTTP ingest URL + shared secret  

### 5.2 Parse sources

#### A) Family Mode / City Royale (Unity logcat) — **phase 1 / MVP**

Proven line patterns from `research/device-recon/family-mode/filtered.log`:

| Pattern | Meaning |
|---------|---------|
| `ShotTracker: startProcessing: started` | Turn / processing active (often game or turn start) |
| `ShotTracker: startProcessing: paused` | Turn boundary |
| `{name} scored {N}` | Points awarded this shot (`N` can be `0.1` for layups) |
| `Did {name} Score From {zone} SHOT MADE = True\|False` | Make/miss + Unity zone name |
| `{name} has scored {X} points and got {N} Position` | Final standings; **Position 0 = winner** |
| Yellow/green JSON with `uniqueScoreId`, `combination`, `stats` | Authoritative end blob (at least for logged-in profile) |

**Example end standings (matched real scoreboard):**

```
Player 1 has scored 23.1 points and got 0 Position
trashpanda has scored 15.1 points and got 1 Position
Player 2 has scored 13 points and got 2 Position
```

**Example end JSON (per logged-in user stats upload):**

```json
{
  "uniqueScoreId": "8/27/2026 1:46:19 AMtrashpanda09fe489d-a6fd-4ae6-8de9-8c95267ef9a9",
  "combination": {
    "gameStateType": "Offline",
    "gameConfiguration": "1v1v1",
    "gameTimeType": "1 minute",
    "gameModeType": "Classic"
  },
  "stats": {
    "score": 15.1,
    "hasWon": false,
    "longestStreak": 2,
    "noOfStreaks": 3,
    "halfPointersMade": 1,
    "halfPointersMissed": 0,
    "onePointersMade": 4,
    "onePointersMissed": 2,
    "twoPointersMade": 1,
    "twoPointersMissed": 2,
    "threePointersMade": 3,
    "threePointersMissed": 7,
    "timeSpent": 0
  }
}
```

**Unity zones seen:** `layup`, `lowPost`, `highPost`, `topOfTheKey` (Family Mode scoring zones — not identical to HAL zone names).

**Layup scoring:** makes can award **0.1** points (`halfPointers*` in end JSON).

Pin parsers to known prefixes; keep a raw-line debug buffer for unmatched lines (Unity strings are the unofficial API).

#### B) Just Huupe / raw HAL — live free-play shots

Logcat from `ShotTracker` / TOF service:

```json
{
  "stream_ts": 622.50116,
  "events": ["make_detected"],
  "shot_zone": "three_point_shot",
  "shot_range": 3.153128
}
```

| Field | Values |
|-------|--------|
| `events` | `make_detected`, `miss_detected` (ignore noise like `signal_interference` if present) |
| `shot_zone` | `layup`, `one_point_shot`, `two_point_shot`, `three_point_shot` |
| `shot_range` | meters |

Samples: `research/device-recon/session-shots.jsonl`

Free-play uses the same `huupe.shot` stream without multi-player standings. Pair with cloud Just Huupe stats (Section 6) for career totals.

#### C) Daily Prize / Fitness / Huupe Live — session logcat (capture-driven)

Packages: `com.game.huupedailyprize`, `com.game.huupeminifitness`, `com.huupe.huupelive`.

On first enable, record one session per mode (same method as Family Mode) and pin parsers. Until strings are confirmed, agent must:

- Detect foreground package / deep link → `huupe.focus.changed`
- Stream ShotTracker makes/misses while that package is foreground → `huupe.shot` with `mode` tag
- Persist Huupe Live datastore snapshots when files change → `huupe.live.session`
- Treat Unity end JSON / score lines like City Royale when found

Do not block Family Mode MVP on perfect Daily Prize/Fitness parsers; ship focus + shots first, then tighten after one recorded session each.

#### D) App focus / intents

Poll activity / UsageStats every ~2–5s while awake:

- Foreground package among known Huupe packages
- Recent `START` / deep-link intents (`unitydl://`, `huupe://`, `gameMode=`)

Emit `huupe.focus.changed` only on change (not every poll).

#### E) Device health

On announce cadence (~30s) or change:

- Battery % / charging
- Wi-Fi connected + RSSI if cheap
- Uptime
- Agent version, installed Huupe package versions
- Optional bort/OTA version string

Condensed health on `huupe.announce`; fuller snapshot as `huupe.device.health` on change or every ~5 min.

### 5.3 Harvest tiers (performance — required)

Harvesting all categories is in scope. Do not spam the LAN.

| Tier | Cadence | Transport | Examples |
|------|---------|-----------|----------|
| A — Realtime | Event-driven (logcat) | UDP (small); HTTP if end blob large | shots, scores, game start/end, focus change |
| B — Frequent | ~15–30s or on change | UDP / announce fields | device health, active profile, focus summary |
| C — Slow / on-change | Boot, after game end, every 15–60 min, or content hash change | HTTP POST preferred | badge catalog, earned badges, inventory/swag, challenges, attempt quotas, Just Huupe cloud stats, notifications, multi-profile list, full profile card |
| D — Suspend | While Tier A live match is active | — | Pause Tier C cloud polls and large file reads; catch up after `game.ended` |

**Change detection:** last SHA-256 (or length+mtime) per harvest blob on device; emit only when changed (unless forced refresh).

**Size rule:** payloads larger than ~1.5 KB encrypted → HTTP `/api/huupe/events` (badge catalog and `UNLOCKEDCHALLENGES` are tens of KB). UDP only for small deltas and live ticks.

**Settings:** each harvest category has enable flags on agent + bridge (`huupe.harvest.*`). Defaults: all enabled for this personal install. Bridge may ignore categories for Vestaboard noise while still storing them.

### 5.4 Outbound event types

Announce every ~30s and on boot:

```json
{
  "version": 2,
  "type": "huupe.announce",
  "device": {
    "id": "<stable-id>",
    "name": "Huupe Mini",
    "model": "HM2",
    "host": "<lan-ip>",
    "apps": ["cityroyale", "justhuupe", "dailyprize", "fitness", "huupelive"],
    "health": { "batteryPct": 80, "charging": false },
    "focusPackage": "com.game.huupecityroyale",
    "activeUsername": "trashpanda"
  }
}
```

#### Gameplay / focus

| `type` | When | Payload (minimum) |
|--------|------|-------------------|
| `huupe.game.started` | processing started / first score | `mode` (`family`/`justhuupe`/`dailyprize`/`fitness`/`live`), config, players |
| `huupe.player.changed` | turn boundary | from, to, turnIndex |
| `huupe.shot` | make/miss / scored line | player (nullable), make/miss, zone, range?, pointsDelta?, runningScore?, `mode` |
| `huupe.score.updated` | after shots | per-player totals (debounce ~250ms) |
| `huupe.game.ended` | standings + end JSON | standings, stats, `uniqueScoreId`, `mode` |
| `huupe.focus.changed` | foreground package / deep link change | `package`, `deepLink?`, `label` |
| `huupe.device.health` | health change / ~5 min | battery, wifi, uptime, packageVersions |

#### Harvest / catalog (prefer HTTP)

| `type` | Source | Payload |
|--------|--------|---------|
| `huupe.profile.updated` | AppDB + cloud profile APIs | career card (**no JWT**) |
| `huupe.profiles.updated` | AppDB `profiles` rows | multi-profile list (strip tokens) |
| `huupe.stats.justhuupe` | Just Huupe cloud stats endpoints | normalized free-play / cloud stats |
| `huupe.badges.catalog` | Fitness `BADGESDATAKEY` / badge-store | catalog |
| `huupe.badges.earned` | `badge-store-service/earned-badges` | earned / selected |
| `huupe.attempts.updated` | City Royale prefs `attempts` | remaining quotas + allocation windows |
| `huupe.inventory.updated` | `mrAppData` / `swagStoreData` | owned + store catalog (HTTP if large) |
| `huupe.challenges.updated` | `UNLOCKEDCHALLENGES` / dirty tasks | fitness unlocks + progress |
| `huupe.notifications.updated` | notification-service + local | recent notifications / unread (no secrets) |
| `huupe.live.session` | Huupe Live datastore | session/config snapshot |
| `huupe.harvest.snapshot` | optional rollup | categories + hashes after Tier C catch-up |

Every event: `eventId` (UUID), `ts`, `deviceId`, `contentHash?`. Bridge dedupes by `eventId` / `uniqueScoreId` / `contentHash`.

### 5.5 Reliability

- Live ticks: UDP OK (lossy)
- Large end JSON / all Tier C harvest: **POST `/api/huupe/events`** with shared secret (mirror Steam presence reporter)
- Bridge treats HTTP + UDP as one event bus
- After `game.ended`, flush deferred Tier C harvest once

### 5.6 Security on agent

- Never put Huupe JWT / password hashes in outbound LAN payloads, archives, or git
- Strip tokens if deep-link intents appear in logcat
- Multi-profile: omit `token` column entirely from `huupe.profiles.updated`
- Email / DOB are PII — admin UI should treat carefully
- Do not scrape Stripe / payment payloads even if URLs appear in APKs

---

## 6. Full harvest catalog (required)

Ship collectors for all of the following. Bridge stores everything under `data/huupe-harvest/` even if a display surface never shows it. Vestaboard/overlays stay selective; admin UI exposes the rest.

### 6.1 Profile + multi-profile

| Field group | Source |
|-------------|--------|
| Active identity, bucks, avatar | AppDB + `mrAppData` / `HUUPEMINIFITNESS` |
| All local profiles | AppDB `profiles` (no tokens) |
| Career Makes/Attempts/FG%/OVR/ratings/wins | Cloud `profile-service/profile` (local `scoreData` often empty) |

### 6.2 Just Huupe cloud stats (priority)

Base: `https://api-mini.huupe.co/huupe/api/`

- `just-huupe/shot-data-for-stats`
- `just-huupe/shot-data-for-hbucks`
- `just-huupe-live-service/user-daily-stats` (if reachable with same JWT)
- `profile-service/profile`

Emit `huupe.stats.justhuupe` on change / after free-play / Tier C poll. Normalize after one authenticated probe confirms response shape.

### 6.3 Badges

| Piece | Source | Event |
|-------|--------|-------|
| Catalog | Fitness prefs `BADGESDATAKEY` (proven large JSON) | `huupe.badges.catalog` |
| Earned / select | `badge-store-service/earned-badges`, `/earn`, `/select` | `huupe.badges.earned` |

### 6.4 Mode attempt quotas

City Royale prefs key `attempts` (proven): Battle Royale, pea shooter, most-points, 3PT challenges, ranked 1v1/2v2/4v4 — remaining counts + last allocation + display period.

Event: `huupe.attempts.updated`.

### 6.5 Inventory / swag store

- Owned: `mrAppData.inventoryInformation` / avatar loadout
- Catalog: `swagStoreData` (large — HTTP + hash)

Event: `huupe.inventory.updated`.

### 6.6 Fitness challenges

- `UNLOCKEDCHALLENGES` (very large)
- `TASKSDIRTYDATAKEY` when non-empty

Event: `huupe.challenges.updated`. Prefer unlocked IDs + titles; full dump OK over HTTP on hash change only.

### 6.7 Notifications

- Cloud: `notification-service/notifications-badge-earned` (and sibling routes discovered in launcher)
- Local: notification listeners / logcat badge-earned lines if present

Event: `huupe.notifications.updated` (title, type, ts, read/unread — no auth material).

### 6.8 Daily Prize / Fitness / Huupe Live sessions

| Mode | Package | Harvest |
|------|---------|---------|
| Daily Prize | `com.game.huupedailyprize` | focus + shots + session end when parsed |
| Fitness | `com.game.huupeminifitness` | focus + shots + challenges prefs + session end |
| Huupe Live | `com.huupe.huupelive` | datastore files → `huupe.live.session` |

Archive finished sessions into `data/huupe-games/` with a `mode` discriminant (same archive as Family Mode).

### 6.9 Device health + app focus

- `huupe.device.health` / announce.health
- `huupe.focus.changed`

Useful for Signal idle-vs-playing, quiet-hours, and admin diagnostics.

### 6.10 Agent harvest schedule (default)

| Trigger | Actions |
|---------|---------|
| Boot / agent start | Announce; Tier C full sync (HTTP); profiles; health |
| Every ~30s | Announce + health/focus fields |
| Focus change | `huupe.focus.changed`; if entering a game package, arm Tier A parsers |
| During live game | Tier A only; defer Tier C |
| Game / session end | `huupe.game.ended`; then Tier C catch-up |
| Every 30–60 min idle | Tier C poll if hashes stale |
| Admin “Refresh harvest” | Force all categories |

**Parallel durable path:** keep building career FG%/wins from `data/huupe-games` so Signal still works if Huupe APIs change.

---

## 7. Bridge service requirements

| Module | Responsibility |
|--------|----------------|
| `huupe-settings.js` | overlays, displays, quiet hours, modes, **per-category harvest toggles**, poll intervals |
| `huupe-live.js` | session state machine (all modes) |
| `huupe-archive.js` | monthly JSONL under `data/huupe-games/` (`mode` field) |
| `huupe-profile.js` | profile + multi-profile snapshots |
| `huupe-harvest.js` | badges, attempts, inventory, challenges, notifications, Just Huupe stats, live session, health/focus |
| `huupe-aggregates.js` | career rollups (archive + merged cloud stats) |
| `huupe-payload.js` | `huupe.live` / `final` / `dashboard` / `profile` / optional harvest summaries |
| `huupe-service.js` | facade + `statusSnapshot()` for admin |

### Wire into `listener.js`

- `huupe.announce` → device registry (`kind: 'huupe'` or `data/huupe-devices.json`)
- types starting with `huupe.` → `huupe.handleInbound(payload)`
- Game transitions → `sendUdpPayload` + Vestaboard `pushEvent` (interrupt-suppress like autodarts/steam)
- Harvest events → upsert `data/huupe-harvest/<category>.json`
- `game.ended` → archive + rebuild aggregates
- Condensed audit → `data/huupe-events.jsonl`

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/huupe/events` | Shared-secret ingest (agent backup + Tier C) |
| `GET` | `/api/huupe/status` | Device online, health, focus, live match |
| `GET` | `/api/huupe/history` | Archived games/sessions |
| `GET` | `/api/huupe/profile` | Career card(s) / multi-profile |
| `GET` | `/api/huupe/harvest` | Latest harvest bundle or `?category=` |
| `GET` | `/api/huupe/dashboard` | Aggregates for UI / push |
| `POST` | `/api/huupe/harvest/refresh` | Request force sync on next agent cycle |

---

## 8. Displays & Vestaboard

### Software display panels

| Payload | Content |
|---------|---------|
| `huupe.live` | Player columns, live scores, active player, clock/turn (any mode) |
| `huupe.final` | Standings / session summary |
| `huupe.profile` | Career card for Push |
| `huupe.live.close` | Auto-close after dwell |

Harvest data is primarily admin/API-backed; optional later panels for badges or Just Huupe daily stats are allowed but not required for MVP overlays.

Template: Autodarts match panel.

### Vestaboard (`formatters/gaming.js`)

- Game start one-liner; end board winner + scores (fit 6×22)
- Skip noisy per-shot flips unless “shot ticker” enabled
- Compact career frame when explicitly pushed
- Do not auto-push badge catalogs or inventory to Vestaboard

### Command registry

Pushable/schedulable: `huupe.dashboard`, `huupe.last-game`, `huupe.profile`.

---

## 9. Signal admin “Huupe” tab

- Device online / last announce age / battery / focus package
- Profile card + multi-profile switcher list (no tokens)
- Live match card
- Harvest panels: Just Huupe stats, badges (catalog + earned), attempts, inventory summary, challenges, notifications, Huupe Live session
- History table (date, mode, winner, scores) → detail drawer
- Career aggregates — archive + cloud merge
- Settings: overlays, displays, per-category harvest toggles, “Send test final”, “Refresh harvest”
- Agent install cheat-sheet (adb connect / root / install / grant logs)

---

## 10. Event → product mapping

| Detected signal | Bridge action |
|-----------------|---------------|
| `startProcessing: started` / first score | `huupe.game.started` → open live overlay |
| Active name change + processing pause/start | `huupe.player.changed` → update live panel |
| `X scored N` / SHOT MADE / HAL make-miss | `huupe.shot` + `huupe.score.updated` |
| `has scored … Position` + end JSON | `huupe.game.ended` → final + archive + Vestaboard + Tier C catch-up |
| Foreground Huupe package change | `huupe.focus.changed` → admin + idle/playing logic |
| Tier C hash change | upsert harvest store (no Vestaboard spam) |
| Missing announce > N minutes | mark device offline in admin |

**Authoritative totals:** final Position lines + end JSON (and HTTP backup). Mid-game UDP scores are advisory.

---

## 11. Implementation order

1. Bridge ingest stub — `huupe.announce` / game events / harvest types; archive + `huupe-harvest` store + admin status; Mac send_test / replay
2. Payloads + display panel + Vestaboard — `huupe-replay` from Family Mode logs
3. Android agent MVP — logcat → encrypt → announce + Family Mode events; e2e
4. Harvest wave 1 — device health, focus/intents, multi-profile, attempts, inventory, badge catalog/earned (local + cloud)
5. Harvest wave 2 — Just Huupe cloud stats (priority), profile career card, notifications
6. Harvest wave 3 — Daily Prize / Fitness session parsers (after capture), Huupe Live datastore, challenges
7. Dashboard / aggregates polish
8. Hardening — boot persist, Tier D suspend during games, secret rotation docs, dedupe, `adb install -r`

---

## 12. Acceptance criteria

### Family Mode e2e

- [ ] Agent announces; admin shows device online
- [ ] Classic 1v1v1 opens `huupe.live`
- [ ] Live scores track `{name} scored N`
- [ ] End standings match hoop UI (Position 0 = winner)
- [ ] Archived under `data/huupe-games/` with `uniqueScoreId`
- [ ] Vestaboard end board; replay harness works

### Harvest

- [ ] Just Huupe cloud stats land in `data/huupe-harvest/` / `GET /api/huupe/harvest?category=justhuupe`
- [ ] Badge catalog + earned badges sync on hash change (HTTP, not UDP spam)
- [ ] Attempt quotas, inventory/swag, fitness challenges sync
- [ ] Multi-profile list without tokens
- [ ] Notifications sync (sanitized)
- [ ] Device health + focus visible in admin / announce
- [ ] Huupe Live session snapshot when datastore present
- [ ] Daily Prize / Fitness: at least focus + shots; full session parse after capture
- [ ] During live Family Mode, Tier C polls pause; catch-up runs after end
- [ ] Large catalogs never flood Vestaboard or UDP discovery

### Profile

- [ ] Career card from cloud when APIs respond; local bucks/identity always
- [ ] JWT never in archives, display payloads, or git
- [ ] Admin profile card + Push `huupe.profile`

### Security / ops

- [ ] Secrets via env / device config only
- [ ] Agent survives reboot (documented)
- [ ] Wireless ADB + `adb root` documented for install/debug only

---

## 13. Risks (accepted)

- Unity log strings can change on OTA — pin parsers; unmatched-line buffer
- Userdebug / root / log grants may need re-setup after OTA
- Career shooting volume is cloud-backed; fall back to archive-derived stats
- UDP loss on mid-game ticks — finals from end lines / HTTP
- Large harvest blobs if change-detection bugs → rate-limit HTTP posts (max 1 full catalog / category / 5 min)
- Daily Prize / Fitness parsers incomplete until capture sessions exist
- Personal use of device JWT against Huupe APIs is OK for this LAN project; never expose token off-device

---

## 14. Research artifacts for the implementing agent

| Artifact | Location |
|----------|----------|
| This spec | `HUUBE_SIGNAL_BRIDGE_SPEC.md` (this file) |
| Family Mode filtered log | `research/device-recon/family-mode/filtered.log` |
| Shot JSONL | `research/device-recon/session-shots.jsonl` |
| Pulled AppDB + prefs | `research/device-recon/pulled/` |
| Reddit sideload research | `research/reddit-sideload/` |
| Prior Cursor plan | `~/.cursor/plans/huupe_signal_bridge_ce902169.plan.md` |
| Signal Bridge repo | https://github.com/lmsilva/signal-bridge |

Do not commit real JWTs, emails, or password material from AppDB into signal-bridge. Sanitize fixtures derived from pulls.

---

## 15. Suggested agent kickoff prompt

> Implement Huupe Mini integration in [signal-bridge](https://github.com/lmsilva/signal-bridge) per `HUUBE_SIGNAL_BRIDGE_SPEC.md` in the Huupe Mini project. Harvest all categories in Section 6 using the Tier A–D performance model (HTTP + hash change for catalogs; suspend Tier C during live games). Start with bridge ingest + `huupe-replay` from `research/device-recon/family-mode/filtered.log`, then `tools/huupe-agent`, then harvest waves. Reuse Autodarts / lan-crypto v3 / Steam presence patterns. Do not invent a new crypto scheme. Never forward Huupe JWTs off the device.
