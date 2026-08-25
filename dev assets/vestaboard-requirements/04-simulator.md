# 04 — Vestaboard simulator

## 1. Purpose and the one rule

The simulator lets the whole feature be built and tested before a
physical board exists, and stays useful afterward as a mirror and a fault
injector. The one rule: the bridge's send path never knows it is talking
to the simulator. Router, formatters, queue, and transport are identical;
the simulator board entry just has a local `baseUrl` and its own token.

## 2. Mock API

Mounted on the existing Signal web server (same process, same port
47810) under `/vestaboard-sim/api/`. It speaks the Cloud API shape. The
authoritative contract is Vestaboard's own documentation
(docs.vestaboard.com, Cloud API section, formerly called the Read/Write
API) — mirror the documented request and response shapes exactly; the
notes below record the behavior our client depends on.

### 2.1 POST /vestaboard-sim/api/

- Header: `X-Vestaboard-Token: <token>`. The bridge's transport always
  sends this.
- Body: either `{"text": "..."}` (the sim centers it, like the real
  service) or a raw JSON 6x22 array of character codes. The bridge always
  sends the array form.
- Responses:
  - 200 with the documented success body including a generated message id
    (uuid). Accepted layout becomes the current message, an SSE flip
    event fires, `lastAcceptedAt` updates.
  - 200, no flip, same id as current, when the posted layout is identical
    to the current one (a real board does not re-flip identical content).
    Does not update `lastAcceptedAt`.
  - 401 `{"error":"invalid token"}` when the header is missing or wrong.
  - 400 `{"error":"invalid layout"}` when rows != 6, any row != 22, or
    any code is outside the legal set (02 §1, unused codes included).
  - 503 when the post arrives less than `rateWindowSeconds` (default 15)
    after the last accepted post, and 503 whenever the simulator is
    toggled off. Body distinguishes them: `{"error":"rate limited"}` vs
    `{"error":"board offline"}` — the transport treats both as retryable
    per 01 §7.3.

### 2.2 GET /vestaboard-sim/api/

- Same auth. Returns the documented current-message shape: an object with
  the current layout (stringified array, as the real service returns it)
  and its id.

### 2.3 Token

Generated once on first boot with a secure random source, stored in
`data/vestaboard-secrets.json` under the sim board id, shown read-only on
the settings row. Never appears in logs, SSE, or error bodies.

## 3. The pre-registered device and its toggle

The simulator board entry from 01 §3 ships in the default config,
enabled. The settings toggle controls `enabled`:

- On: the board is in the registry, the picker, and scheduler target
  fan-out; the endpoint accepts posts.
- Off: removed from picker and fan-out; the endpoint answers 503
  "board offline". Because the queue keeps retrying per 01 §7.3, flipping
  the toggle off and on mid-push is the standard way to test retry,
  backoff, and health reporting. Toggling is live, no restart, and emits
  a registry SSE update.

## 4. The simulator page

`/admin/simulator`, linked as a Simulator tab in the admin. Reuses the
Signal UI's existing style and its SSE plumbing. Must work well on a
phone.

Layout, top to bottom:

1. Header: title, an Online/Offline pill, a rate pill ("Next flip allowed
   in Ns" counting down, or "now"), a quiet-hours badge when the window
   is active, and the on/off toggle.
2. The board: dark bezel, 6x22 tiles, all-caps condensed glyphs, color
   chips as full-tile fills, a faint horizontal seam across each tile's
   middle. Flip animation on changed tiles only: each changed tile plays
   a ~450ms flap (rotateX squash), delayed by `column * 14ms` plus 0–90ms
   random jitter, so a full change sweeps left to right in roughly 2–4
   seconds. Offline dims the bezel.
3. Queue card: the pending items with their `label`, `source`, and state
   (waiting / not before hh:mm:ss).
4. Call log card: the last 20 API calls — time, method, and result
   (200 flipped / 200 duplicate / 400 / 401 auth bad / 503 rate /
   503 offline). Never the token.

### SSE stream

`GET /vestaboard-sim/stream`, same mechanism as the picker's live
updates. Events:

```
sim.state  { online, cooldownMs, quietHours }
sim.flip   { id, layout, label, source }        after each accepted post
sim.call   { at, method, result }               after every request
sim.queue  { items: [{ label, source, notBefore }] }  on queue change
```

The page renders entirely from these events plus one initial state fetch;
it holds no logic about what should be displayed.

## 5. Replay tool

`npm run board-replay -- --file data/voice-events.jsonl --last 50
--types broadcast,timer.snapshot --speed 10 --board sim`

- Reads the JSONL, optionally filters by `--types`, takes the last N
  events, and feeds them into the real router entry point as if they were
  arriving live.
- `--speed` scales the gaps between events (recorded 60s apart at
  `--speed 10` arrive 6s apart). It does not touch queue pacing; to run
  fast end-to-end tests, lower the sim board's `rateWindowSeconds` in
  config — the queue and the sim endpoint read the same value, so
  behavior stays consistent without special-casing.
- Prints one line per event: matched formatter (or skip reason), frames
  produced, and the eventual post results.
- Exit code 0 when every produced frame was eventually accepted; nonzero
  otherwise. This makes it usable in CI against the simulator.

## 6. When the real board arrives

Add the real board in settings (token from the Vestaboard app's API
section). Keep the simulator registered: with both enabled, every push
that goes to the real board also lands on the simulator page, which makes
it a live mirror for debugging exactly what was sent. Nothing else
changes — that is the point of the one rule.
