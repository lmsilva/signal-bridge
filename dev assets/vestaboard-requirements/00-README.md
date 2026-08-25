# Vestaboard handoff package — read this first

This folder is everything an implementing agent needs to build Vestaboard
support and the Vestaboard simulator into Signal Bridge
(github.com/lmsilva/signal-bridge). It was produced after the design was
validated against the real running system: the live event log
(data/voice-events.jsonl, 4,269 events), the real data caches, and the real
scheduler rules.

## Documents in this package

| File | What it holds | Read when |
|---|---|---|
| 00-README.md | This index, ground rules, repo touch points | First |
| 01-architecture.md | Modules, data flow, config, registry, router, queue, scheduler, Signal UI | Before any code |
| 02-encoding-and-design.md | Character codes, text folding, wrapping, frame builders, the visual design system, measured limits | With phase 1 |
| 03-formatters.md | Every event type: trigger, real input shape, output frames, edge cases | With phases 5–6 |
| 04-simulator.md | Mock API contract, simulator device, admin page, replay tool | With phases 2–3 and 8 |
| 05-delivery-and-testing.md | Phase plan, commit messages, acceptance criteria, test plan | Throughout |
| 06-requirements-rev1.md | The approved requirements and locked decisions | For scope questions |
| 07-local-api-addendum.md | Local API is what we shipped (not Cloud). Port 7000, addressing, Docker/mDNS | With hardware / Docker questions |

If a document here ever disagrees with 06-requirements-rev1.md, the
requirements win. Flag the conflict instead of silently picking one.

## Before writing any code

1. Read `src/PROJECT.md` in the repo. It is the architecture reference for
   the bridge. These handoff docs describe integration points by what they
   do (for example "where typed payloads are dispatched to displays");
   PROJECT.md tells you the exact modules and function names. Wire into the
   existing patterns, do not build parallel ones.
2. Read `alexa broadcast client/src/PROJECT.md` only if you need to confirm
   full-display behavior. This feature must not change the full-display
   path.
3. Read `.cursor/rules` and follow it.
4. Run the existing tests (`npm test`) before you start, so you know the
   baseline is green.

## Ground rules

Style and voice (these match how the rest of the project is written):

- Code comments are direct and simple. Say what the code does in plain
  words. Do not name-drop attack names, rule ids, or acronyms in comments.
  Long reasoning belongs in these docs, not in the code.
- Documentation and README text uses simple, direct technical English.
  Short sentences. Define a term once, then use it.
- Commit messages: a short casual subject line plus a two-to-four line
  body. Plain language a junior engineer can read without looking anything
  up. The exact messages to use are in 05-delivery-and-testing.md. A commit
  too big for that format should have been split.

Engineering rules:

- One send path. Real boards and the simulator go through the identical
  router, formatter, queue, and HTTP code. The only difference is the base
  URL and the token. Never special-case the simulator in the send path.
- Golden tests are mandatory. Every frame layout in 03-formatters.md is a
  fixture. A formatter is done when its output matches its fixtures
  code-for-code.
- Do not change: the full-display UDP path, the behavior of existing
  scheduler rules that have not been given a target, the guest booth, or
  any auth flow.
- Config lives in `data/config.json`, secrets in `.env` or under `data/`
  (gitignored), exactly like the existing Tesla and Alexa integrations.

Security rules:

- Never write a board token, the simulator token, or `LAN_UDP_SECRET` to
  any log, SSE stream, API response, or error message. The simulator call
  log reports "auth ok" or "auth bad", never the token value.
- Generate the simulator token with a cryptographically secure random
  source on first boot, store it under `data/`, and show it only on the
  settings page.
- The simulator binds only where the Signal web server already binds. It
  must not open the feature to a wider network surface than the admin UI
  already has.

## Glossary

- Board: a Vestaboard — 6 rows by 22 columns of split-flap modules.
- Flip: one physical update of the board. Audible, takes seconds.
- Chip: a solid color flap (red, orange, yellow, green, blue, violet,
  white, black).
- Frame: one full 6x22 screen of character codes, with a dwell time.
- Dwell: how long a frame stays up before the next queued frame may post.
- Alert / snapshot: the two priority classes. Alerts (broadcast, alarm
  fire, timer fire, reminder fire, game start) preempt; snapshots rotate.
- SSE: Server-Sent Events, the one-way live update stream from server to
  browser that the Signal display picker already uses.
