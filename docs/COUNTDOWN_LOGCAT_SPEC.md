# Huupe Countdown → Signal Bridge logcat contract

**For:** the `huupe-countdown` agent (`https://github.com/lmsilva/huupe-countdown`)
**Consumer:** Signal Bridge ADB collector (`com.huupe.countdown` on the Huupe Mini)
**Status:** implement in the countdown APK; do not change how `countdown-state.json` is stored
**Version:** `v: 1`

Signal Bridge already tails wireless ADB logcat. It **cannot** read `countdown-state.json` or `MatchRecord`. It **does** see HAL / `ShotTrackerWrapper` shot lines, but those have no player names, remaining scores, start (21/51/101), difficulty, busts, or winner.

This spec is the only integration. No HTTP, no file export, no ContentProvider.

---

## 1. Goal

Emit **five compact JSON events** on a dedicated log tag so the NAS can:

1. Open a live overlay when a match starts (named seats, remaining scores).
2. Update the overlay on every shot (human or bot).
3. Follow a shot that is **corrected after the fact** - typed in by hand, re-called by the hoop on a retake, or taken off the board by an undo.
4. Show that the hoop is **waiting on a retake**, because between arming and landing the board is showing a shot nobody stands behind.
5. Archive a finished match into house Huupe stats (career points, leaderboard, zones).

If these lines are missing, Countdown is invisible to Signal Bridge.

`start` / `shot` / `end` were the whole contract in the first cut. `fix` and `retake` (sections 5b and 5c) arrived with the hoop's Retake button. They are **additive on `v: 1`**: a consumer that only knows the first three keeps working, it just shows corrected shots wrong forever. Ignore an `ev` you do not recognise rather than dropping the session.

---

## 2. How to log

```kotlin
android.util.Log.i("HuupeCountdown", json)
```

| Rule | Requirement |
|------|-------------|
| Tag | Exactly `HuupeCountdown` (case-sensitive). The collector allowlists tags; any other name is dropped. |
| Level | `Log.i` (Info). Do not use Debug/Verbose - those are often filtered. |
| Payload | **One JSON object, one line.** No prefix, no pretty-print, no second object on the same line. |
| Size | Keep each line **under 800 characters**. Logcat truncates. Never dump `turns[]` or full `GameState`. |
| Process | Same app process that already calls `ShotTrackerWrapper.startProcessing()` / `onShotAttempt`. |
| Encoding | UTF-8. No trailing comma. Numbers are JSON numbers, not strings (except ids and names). |

Wrong:

```
I/HuupeCountdown: start match 51 EXACT
I/HuupeCountdown: event=start { ... }
I/Countdown: {"v":1,...}
```

Right (what `adb logcat -s HuupeCountdown:I` must show):

```
08-27 14:32:01.120  4321  4321 I HuupeCountdown: {"v":1,"ev":"start","id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","start":51,"diff":"EXACT","layup":1,"seats":[{"id":"luis","name":"Luis","bot":false},{"id":"alex","name":"Alex","bot":false}]}
```

Helper (suggested):

```kotlin
object BridgeLog {
    private const val TAG = "HuupeCountdown"
    fun emit(json: String) {
        android.util.Log.i(TAG, json)
    }
}
```

Build the JSON with a small explicit serializer (same style as `AppStore`). Do **not** serialize the whole `GameState` / `MatchRecord`.

---

## 3. Shared fields

Every event:

| Key | Type | Required | Notes |
|-----|------|----------|--------|
| `v` | number | yes | Always `1`. |
| `ev` | string | yes | `start` \| `shot` \| `fix` \| `retake` \| `end`. Unknown values must be skipped, not fatal. |
| `id` | string | yes | Stable **match** id for this game. Same value on start, every shot, and end. Use the uuid you already put on `MatchRecord.id`. Mint it in `startMatch()`, not at `recordMatch()`. |

A rematch is a **new** `id` and a new `start`.

---

## 4. Event: `start`

**When:** once, at the moment `Session.startMatch()` creates the live `GameEngine` and arms the first turn.
**Not when:** opening the seats/rules screens, restoring `pausedGame` (see section 7), or showing the result screen.

```json
{
  "v": 1,
  "ev": "start",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "start": 51,
  "diff": "EXACT",
  "layup": 1,
  "seats": [
    { "id": "luis-profile-uuid", "name": "Luis", "bot": false },
    { "id": "bot-VARSITY-uuid", "name": "Bot Varsity", "bot": true }
  ]
}
```

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `start` | number | yes | `21`, `51`, or `101` only. |
| `diff` | string | yes | Exact enum name: `RACE` \| `EXACT` \| `DEEP`. Not the pretty label. |
| `layup` | number | yes | `0` or `1` (points a made layup subtracts). |
| `seats` | array | yes | 1-4 objects, **display order**, index `0` = first seat. This order is the `seat` index on every later `shot`. |

Each seat:

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `id` | string | yes | Human: `PlayerProfile.id`. Bot: the bot seat id you already mint (`bot-{LEVEL}-{uuid}`). |
| `name` | string | yes | 1-12 chars as shown on the hoop. Same string you persist. Household names should match Family Mode (e.g. `Luis`, not `LUIS `). |
| `bot` | boolean | yes | `true` for bot seats. |

Do not include color/avatar/history on this line.

---

## 5. Event: `shot`

**When:** once after `GameEngine.applyShot()` has updated state, for **every** attempt - make, miss, bust shot, winning shot, human or bot.
**Not when:** accelerometer pending miss before the engine accepts it; do not log the raw HAL event.

```json
{
  "v": 1,
  "ev": "shot",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "seat": 0,
  "name": "Luis",
  "bot": false,
  "zone": "DEEP",
  "made": true,
  "pts": 3,
  "left": 48,
  "turn": 1,
  "attempt": 1,
  "bust": false,
  "win": false,
  "madeN": 1,
  "att": 1
}
```

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `seat` | number | yes | `0`-`3`, index into the `start.seats` array for **this** `id`. |
| `name` | string | yes | That seat's display name, so the live card never has to label anyone `P1`-`P4` while waiting for `end`. |
| `bot` | boolean | yes | That seat's bot flag. |
| `zone` | string | yes | `LAYUP` \| `SHORT` \| `MID` \| `DEEP` \| `MISS`. Use `MISS` when `made` is false (even if HAL reported a zone). |
| `made` | boolean | yes | Whether the hoop counted a make. |
| `pts` | number | yes | Points this shot subtracted **before** bust revert. `0` on a miss. On a bust, still send the attempted value (e.g. `3`) and set `bust: true`. |
| `left` | number | yes | That seat's **remaining** score **after** the engine applied the shot (post-bust restore if it busted). |
| `turn` | number | yes | Which of **that seat's own** turns this attempt belongs to, 1-based (their first turn is `1`, whether or not other seats have shot). Not a global turn counter. |
| `attempt` | number | yes | `1`, `2`, or `3` within that turn. |
| `bust` | boolean | yes | `true` if this shot busted (Exact / Deep). `left` is then the restored start-of-turn remaining. |
| `win` | boolean | yes | `true` if this shot won the match. |

| `madeN` | number | yes | That seat's makes for **this match** after this shot. Absolute, not a delta. |
| `att` | number | yes | That seat's attempts for **this match** after this shot. Absolute, not a delta. |

`(id, seat, turn, attempt)` is the **address** of an attempt and is stable for the life of the match. Store shots under it: a later `fix` (section 5b) reaches back to one specific attempt using exactly these four keys, and there is no other way to tell which shot it replaced.

**Assign `madeN` / `att`, never accumulate them.** Counting lines is what breaks: a consumer tailing with `-T 1` joins partway through a game and has no earlier lines to add up, and a running counter is the one thing a correction cannot repair. These two match what `end` will report for that seat (`made` / `att` in section 6), so the live card and the archive can never disagree. Busted attempts are included in both, exactly as `end` includes them.

Zone mapping the bridge will apply (do not send HAL strings like `three_point_shot`):

| Countdown zone | Bridge zone | Typical `pts` when made |
|----------------|-------------|-------------------------|
| `LAYUP` | layup | `layup` from start (`0` or `1`) |
| `SHORT` | one | `1` |
| `MID` | two | `2` |
| `DEEP` | three | `3` |
| `MISS` | - | `0` |

Log bot shots the same way. The live card needs them.

---

## 5b. Event: `fix`

**When:** once, immediately after the engine has accepted a change to an attempt that was **already reported as a `shot`**. Three things produce one:

- **Override / Fix previous turn** - a person picks the correct class from the panel. `how: "hand"`.
- **Retake** - the shooter hands the call back to the hoop and shoots again; the hoop's verdict replaces the old attempt. `how: "retake"`.
- **Undo** - the attempt is taken off the board entirely. `how: "undo"`, and `gone` is `true`.

**Not when:** the panel is opened and cancelled, or the applied class is identical to the recorded one (nothing changed, nothing is logged).

**Never as a second `shot`.** That is the bug this event exists to avoid: a replaced or removed attempt must not inflate anyone's attempt count. `Session.apply()` still logs a `shot` only when the current turn actually grows.

```json
{
  "v": 1,
  "ev": "fix",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "seat": 0,
  "name": "Luis",
  "bot": false,
  "how": "retake",
  "turn": 3,
  "attempt": 2,
  "wasZone": "MISS",
  "wasPts": 0,
  "gone": false,
  "zone": "DEEP",
  "made": true,
  "pts": 3,
  "left": 18,
  "turnPts": 3,
  "bust": false,
  "win": false,
  "madeN": 2,
  "att": 4
}
```

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `seat` / `name` / `bot` | | yes | The seat whose attempt changed. **Not necessarily the seat now shooting** - `Fix previous turn` corrects a turn that is already over, and the active seat may be someone else entirely. |
| `how` | string | yes | `hand` (typed in), `retake` (the hoop called it again), or `undo` (taken off the board). Only these three values. |
| `turn` | number | yes | Same meaning as `shot.turn`. |
| `attempt` | number | yes | Same meaning as `shot.attempt`. |
| `wasZone` | string | yes | The zone previously reported for that attempt (`MISS` if it was a miss). Provided so a correction can be shown as a correction, and so a bridge that lost the original line can still reconcile. |
| `wasPts` | number | yes | The points previously reported for that attempt. |
| `gone` | boolean | yes | `true` when there is no attempt at that address any more (an undo). **Delete the stored attempt** and ignore `zone` / `made` / `pts` on that line - they are sent as `MISS` / `false` / `0` only so the key set never varies. |
| `zone` / `made` / `pts` | | yes | The attempt **as it now stands**. Same rules and vocabulary as `shot`. Meaningless when `gone` is `true`. |
| `left` | number | yes | That seat's remaining score after the whole game was recomputed. **Authoritative** - overwrite whatever you were holding. |
| `turnPts` | number | yes | Points that turn is now worth (`0` if it is a bust). |
| `bust` | boolean | yes | Whether that **turn** is a bust now. Unlike `shot.bust`, this is a turn state, not a per-shot one: `false` here **retracts** a bust a previous `shot` line reported. |
| `win` | boolean | yes | Whether this correction ends the match with that seat as winner. When `true`, an `end` line follows on the same clock, as if the corrected shot had been the winning one. An undo never wins. |
| `madeN` | number | yes | That seat's makes for **this match** after the fix. Absolute - **replace, do not add**. |
| `att` | number | yes | That seat's attempts for **this match** after the fix. Absolute - **replace, do not add**. Drops by one on an undo. |

A `fix` is not a new attempt. **Do not increment the seat's attempt count, shot count, or shots-in-turn.** It changes the attempt at `(seat, turn, attempt)` in place, so a turn that had three shots still has three - or two, if the change was an undo.

What the bridge should do with a `fix`, in order:

1. If `gone` is `true`, delete the stored attempt at that address. Otherwise replace it with `zone` / `made` / `pts`.
2. Assign that seat's remaining score from `left`. Do not add or subtract.
3. Assign that turn's bust flag from `bust` and its points from `turnPts`.
4. Assign that seat's makes and attempts from `madeN` / `att`. These are the repair for any counter that already drifted, which is why they are absolute.
5. Re-derive anything else on the wall (shooting %, threes, leaderboard preview) from the stored attempts rather than from running counters, because a counter cannot be corrected.
6. If `win` is `true`, expect `end`.

Only one attempt changes per `fix` line. A correction cascade (fixing shot 2 of a turn that then busts) still produces exactly one `fix`, and its `bust` / `left` / `turnPts` / `madeN` / `att` already account for the cascade.

An undo that empties the turn is still a `fix`: `gone: true`, the restored `left`, `turnPts: 0`, and whatever `madeN` / `att` the seat is down to - which is `0` / `0` if it was their first attempt of the match.

---

## 5c. Event: `retake`

**When:** the hoop is armed to re-call an attempt already on the board, and again when that request is stood down.

```json
{
  "v": 1,
  "ev": "retake",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "seat": 0,
  "name": "Luis",
  "bot": false,
  "state": "armed",
  "turn": 3,
  "attempt": 2,
  "zone": "MISS",
  "pts": 0
}
```

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `state` | string | yes | `armed` when the hoop is handed the call, `cancelled` when it is taken back. Only these two values. |
| `turn` / `attempt` | number | yes | The address of the attempt that is going to be replaced. |
| `zone` / `pts` | | yes | What that attempt currently says - the thing that is in doubt. |

There is deliberately **no `landed` state**: a retake that lands is reported as the `fix` it produced (`how: "retake"`, same `turn` / `attempt`), so the outcome never has to be correlated across two lines.

Between `armed` and its resolution the score has not moved and the board still shows the disputed attempt. Treat it as a live, provisional state:

- Mark that attempt as in doubt rather than deleting it. It is still the record of the game until something replaces it.
- Do **not** treat `armed` as a shot, an attempt, or a score change. Nothing has happened yet.
- Exactly one of two things follows: a `fix` with `how: "retake"` at the same address, or a `retake` with `state: "cancelled"`. `cancelled` covers both backing out entirely and switching to typing the class in by hand - in the second case a `fix` with `how: "hand"` may follow, but as an ordinary correction.
- Retakes are only ever offered for **human** seats: a bot's attempt was never measured, so there is nothing for the hoop to call twice. A `retake` line for a `bot: true` seat should never appear.
- A retake can be armed while the hoop is offline (the hoop screen says so). In that case `cancelled` is the likely follow-up. Do not wait indefinitely - there is no timeout on this state, so keep it visually provisional rather than blocking on it.

---

## 6. Event: `end`

**When:** once inside `recordMatch()`, when you append a `MatchRecord` and clear `pausedGame`. That is `Phase.GAME_OVER` after the win hold - not the 1.5s hold itself.
**Not when:** app background, pause, abandon, or navigating Home without a recorded match.

```json
{
  "v": 1,
  "ev": "end",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "winnerId": "luis-profile-uuid",
  "winner": "Luis",
  "reason": "win",
  "seats": [
    { "id": "luis-profile-uuid", "name": "Luis", "left": 0, "scored": 51, "made": 9, "att": 12, "threes": 2 },
    { "id": "bot-VARSITY-uuid", "name": "Bot Varsity", "left": 18, "scored": 33, "made": 7, "att": 12, "threes": 1 }
  ]
}
```

| Key | Type | Required | Rules |
|-----|------|----------|--------|
| `winnerId` | string | yes if `reason=win` | Seat / profile id of the winner. Omit or `null` only if you ever end without a winner (do not invent one). |
| `winner` | string | yes if `reason=win` | Display name; must match that seat's `name`. |
| `reason` | string | yes | `win` for a normal finish. Use `abort` only if you later record an abandoned match (not required now). |
| `seats` | array | yes | Same order and ids as `start`. |

Each end seat:

| Key | Type | Required | Meaning |
|-----|------|----------|---------|
| `id` | string | yes | Same as start. |
| `name` | string | yes | Same as start. |
| `left` | number | yes | Remaining score at game over (`0` for the winner on Exact/Deep/Race-at-or-below). |
| `scored` | number | yes | Points actually taken off that seat's board for **this match**. See section 8. |
| `made` | number | yes | Makes this match. |
| `att` | number | yes | Attempts this match (makes + misses). Include bust-turn attempts. |
| `threes` | number | yes | Made `DEEP` shots that counted (not busted-and-reverted). |

Do **not** include `turns`, per-turn `attempts[]`, avatars, or career totals. The bridge rebuilds shooting % from `made` / `att` / shot events.

---

## 7. Lifecycle (do / do not)

| Moment | Log |
|--------|-----|
| `startMatch()` - new game or rematch | `start` (new `id`) |
| Each accepted `applyShot()` | `shot` |
| Override / Fix previous turn applied | `fix` (`how: "hand"`) |
| `Undo last shot` / Back during a turn | `fix` (`how: "undo"`, `gone: true`) - never a second `shot` |
| Retake armed (hoop handed the call) | `retake` (`state: "armed"`) |
| Retake backed out, or switched to typing it in | `retake` (`state: "cancelled"`) |
| Retake landed (hoop called the replacement) | `fix` (`how: "retake"`) - no second `shot` |
| `recordMatch()` after `GAME_OVER` | `end` |
| Restore `pausedGame` on resume | **`start` again with the same `id`**, then continue `shot`s. The bridge treats a second `start` with the same `id` as a resume, not a new game. Do not mint a new id. |
| App background / `pausedGame = game` | nothing |
| Delete a match from History | nothing (no live session) |
| Leave to Home before anyone shoots | nothing (no `start` unless the engine actually started) |
| Win hold (1.5s) before `GAME_OVER` | nothing extra; last `shot` already has `win: true` |
| `stopLocal()` / `pauseProcessing()` | nothing - HAL `startProcessing` lines already exist |

If the user starts a match, the app dies, and they resume the same `pausedGame`: emit `start` with the **original** `id` and current `seats` / rules, then resume `shot` lines.

---

## 8. How to compute `scored`

Career stats add `scored` to house totals. **Never send remaining as `scored`.** A winner at `left: 0` would look like they scored 0 points.

```
scored = startScore - left
```

Examples (`start` = 51):

| Seat finish | `left` | `scored` |
|-------------|--------|----------|
| Winner (reached 0) | `0` | `51` |
| Opponent still at 18 | `18` | `33` |
| Never scored (still 51) | `51` | `0` |

Busts: remaining is restored, so `scored` naturally excludes busted points. Do not add busted-then-reverted points.

Race-to-zero can finish with `left < 0` if you allow overshoot. Then `scored = startScore - left` (e.g. start 21, finish -2 → `scored` 23). Send the real `left` (can be negative).

---

## 9. Worked example (2 human, Exact 21)

```
I/HuupeCountdown: {"v":1,"ev":"start","id":"11111111-1111-1111-1111-111111111111","start":21,"diff":"EXACT","layup":1,"seats":[{"id":"p-luis","name":"Luis","bot":false},{"id":"p-alex","name":"Alex","bot":false}]}
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"DEEP","made":true,"pts":3,"left":18,"turn":1,"attempt":1,"bust":false,"win":false,"madeN":1,"att":1}
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"MID","made":true,"pts":2,"left":16,"turn":1,"attempt":2,"bust":false,"win":false,"madeN":2,"att":2}
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"MISS","made":false,"pts":0,"left":16,"turn":1,"attempt":3,"bust":false,"win":false,"madeN":2,"att":3}
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":1,"name":"Alex","bot":false,"zone":"DEEP","made":true,"pts":3,"left":18,"turn":1,"attempt":1,"bust":false,"win":false,"madeN":1,"att":1}
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"DEEP","made":true,"pts":3,"left":13,"turn":2,"attempt":1,"bust":false,"win":false,"madeN":3,"att":4}
```

The snippets below are standalone illustrations, not a continuation of the run above.

Bust (Exact, remaining 2, shoots DEEP):

```
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"DEEP","made":true,"pts":3,"left":2,"turn":3,"attempt":1,"bust":true,"win":false,"madeN":5,"att":8}
```

The hoop called that DEEP a make and Luis disagrees. He hands the call back, shoots again, and this time the hoop calls a miss - one armed line, then one `fix`, and no second `shot`:

```
I/HuupeCountdown: {"v":1,"ev":"retake","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"state":"armed","turn":3,"attempt":1,"zone":"DEEP","pts":3}
I/HuupeCountdown: {"v":1,"ev":"fix","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"how":"retake","turn":3,"attempt":1,"wasZone":"DEEP","wasPts":3,"gone":false,"zone":"MISS","made":false,"pts":0,"left":2,"turnPts":0,"bust":false,"win":false,"madeN":4,"att":8}
```

The bust is gone (`bust: false`), the turn is worth nothing (`turnPts: 0`), Luis is still on 2, and he has one make fewer off the same eight attempts. Typed in by hand instead, the same correction is one `fix` with `"how":"hand"` and no `retake` line before it.

Undo (Luis takes the attempt back off the board):

```
I/HuupeCountdown: {"v":1,"ev":"fix","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"how":"undo","turn":3,"attempt":1,"wasZone":"DEEP","wasPts":3,"gone":true,"zone":"MISS","made":false,"pts":0,"left":2,"turnPts":0,"bust":false,"win":false,"madeN":4,"att":7}
```

`gone: true` means there is no attempt 1 of turn 3 any more - drop it, and take `madeN` / `att` as the seat's totals rather than adjusting your own.

Winning shot:

```
I/HuupeCountdown: {"v":1,"ev":"shot","id":"11111111-1111-1111-1111-111111111111","seat":0,"name":"Luis","bot":false,"zone":"SHORT","made":true,"pts":1,"left":0,"turn":4,"attempt":2,"bust":false,"win":true,"madeN":4,"att":6}
I/HuupeCountdown: {"v":1,"ev":"end","id":"11111111-1111-1111-1111-111111111111","winnerId":"p-luis","winner":"Luis","reason":"win","seats":[{"id":"p-luis","name":"Luis","left":0,"scored":21,"made":4,"att":6,"threes":2},{"id":"p-alex","name":"Alex","left":18,"scored":3,"made":1,"att":1,"threes":1}]}
```

---

## 10. Out of scope (do not build)

- HTTP POST / WebSocket / mDNS to the NAS
- Writing a sidecar file for `adb pull`
- Dumping `countdown-state.json` or `MatchRecord.turns`
- Changing `onShotAttempt` / `startProcessing` / HAL TCP (those already exist)
- Backfilling old History rows
- Further event types (`pause`, `heartbeat`, per-turn summaries) - not required. `fix` and `retake` exist because a corrected shot cannot be expressed as another `shot`; nothing else has earned a line.
- Re-emitting `start` or replaying `shot`s after a `fix` - the `fix` line carries everything needed to patch in place

---

## 11. Acceptance (countdown repo)

A reviewer can verify without Signal Bridge:

```bat
adb connect <hoop-ip>:5555
adb logcat -c
adb logcat -v threadtime -s HuupeCountdown:I
```

Play one 21 Exact game (2 seats) through `GAME_OVER`. Required:

1. Exactly one `start` at tip-off, `id` is a uuid, `seats.length` matches the hoop.
2. One `shot` per engine-accepted attempt, including misses and bots.
3. `shot.id` equals `start.id` on every line.
4. A busted Exact/Deep shot has `bust: true` and `left` equal to remaining **after** revert.
5. The winning shot has `win: true` and `left: 0` (or `< 0` only for Race).
6. Exactly one `end` after the result is recorded, same `id`, `scored = start - left` per seat.
7. No pretty-printed JSON, no second tag, no line over 800 characters.
8. Backgrounding mid-game produces **no** `end`. Resume of the same paused match emits `start` with the **same** `id`.
9. Every `shot` carries `turn` and `attempt`, and `turn` counts that seat's own turns (seat 0's third turn is `"turn":3` however many shots the others took).

Then, on the same game, log a shot and correct it (Pause -> Override last shot):

10. Applying a different class emits exactly one `fix` with `how: "hand"`, the old class in `wasZone` / `wasPts`, and the same `turn` / `attempt` as the `shot` it replaces. Applying the identical class emits nothing.
11. Choosing Retake emits `retake` with `state: "armed"` naming that attempt; backing out emits `state: "cancelled"` and no `fix`.
12. Letting the hoop call the replacement emits one `fix` with `how: "retake"` and **no** second `shot` line, so the attempt count does not grow.
13. A correction that busts the turn has `bust: true` and `turnPts: 0`; correcting it back has `bust: false`. A correction that finishes the match has `win: true` and is followed by `end`.
14. Making a DEEP and undoing it emits one `fix` with `how: "undo"`, `gone: true`, the restored `left`, and `madeN` / `att` each one lower than the `shot` line reported. No second `shot` appears.
15. Overriding a miss to SHORT drops `left`, raises `madeN` by one, and leaves `att` unchanged.
16. `madeN` / `att` on the last `shot` or `fix` of the game equal that seat's `made` / `att` in `end`.

Unit-test the serializer in `game-core` or `app` with fixtures for Race / Exact bust / Deep finish / 4 seats / rematch-new-id.

---

## 12. Suggested hook points

| File (countdown repo) | Change |
|-----------------------|--------|
| `Session.startMatch()` | Mint `matchId` (reuse as `MatchRecord.id`); emit `start`. |
| After `GameEngine.applyShot()` / `Session.apply()` | Emit `shot`. |
| `Session.applyOverrideConfirm()` / `applyReviewConfirm()` | Emit `fix`; `how` is `retake` when the replacement came from the hoop. |
| `Session.openRetake()` / `cancelRetake()` / `retakeByHand()` | Emit `retake` (`armed` / `cancelled`). |
| `Session.undoShot()` (around `GameEngine.undo`) | Emit `fix` with `how: "undo"`; read the address off the state **before** the undo, since afterwards the attempt is gone. |
| `Session.recordMatch()` | Emit `end` using the finished `GameState` + same `matchId`. |
| Resume path that restores `pausedGame` | Emit `start` with existing `matchId`. |

Keep logging failures off the game path: wrap emit in try/catch; never throw from `applyShot()`.

---

## 13. Handoff

Implement this in `huupe-countdown`, ship the APK to the Mini, and paste one real `adb logcat -s HuupeCountdown:I` capture back to the Signal Bridge agent. The bridge parser will be written against this contract (`v: 1`). Bump `v` only if you break a key; do not add unused keys to stay under the size cap.
