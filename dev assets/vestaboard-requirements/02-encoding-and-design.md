# 02 — Encoding and the frame design system

## 1. Character codes

The board shows exactly these codes. The encoder may output nothing else.

| Code | Character | | Code | Character |
|---|---|---|---|---|
| 0 | blank | | 47 | & |
| 1–26 | A–Z | | 48 | = |
| 27–35 | 1–9 | | 49 | ; |
| 36 | 0 | | 50 | : |
| 37 | ! | | 52 | ' |
| 38 | @ | | 53 | " |
| 39 | # | | 54 | % |
| 40 | $ | | 55 | , |
| 41 | ( | | 56 | . |
| 42 | ) | | 59 | / |
| 44 | - | | 60 | ? |
| 46 | + | | 62 | ° (degree) |

Color chips: 63 red, 64 orange, 65 yellow, 66 green, 67 blue, 68 violet,
69 white, 70 black, 71 filled. Codes 43, 45, 51, 57, 58, 61 are unused —
emitting them is a validation error.

There is no lowercase, no asterisk, no angle brackets, no underscore, and
no way to render a QR code.

## 2. Folding (text normalization)

Applied to every piece of text before layout, in this order:

1. Uppercase.
2. Strip accents to the base letter: Ã→A, É→E, Ç→C, and so on (full
   Unicode decomposition, keep the base character).
3. Substitutions: curly single quotes ' ' → `'`; curly double quotes " " →
   `"`; en dash and em dash → `-`; ellipsis character → `...`; non-breaking
   space → space.
4. Drop entirely: ™ © ® emoji and any other character with no code.
5. Collapse runs of whitespace to single spaces; trim.

Real examples this must handle (all from the live system): "HOT WHEELS
UNLEASHED™" → "HOT WHEELS UNLEASHED"; curly quotes throughout the Upside
headlines; "SÃO" → "SAO". Voice text renders verbatim after folding — no
spell correction, no cleanup ("COMPANY Q. TEN" stays as heard).

## 3. Wrapping

`wrap(text, width) -> lines[]`, greedy at word boundaries:

- Never break inside a word. A single word longer than `width` is split
  with a trailing `-` on the first part (rare; only pathological input).
- No trailing spaces on lines.
- Content that overflows a frame's row budget continues on the next frame
  of the same sequence. Never truncate mid-thought; the only permitted
  truncation is the name-fit rule below.

Name-fit rule: values living in a fixed column (sensor names, player
names, timer labels) truncate to the column width with no ellipsis
marker. Column widths are given per layout in 03-formatters.

## 4. Frame builders (`frames.js`)

All builders return rows of character codes and must pass validation.

- `lr(left, right)` — one row: left text, gap, right-aligned text. The gap
  is at least one blank; combined length over 21 is a programming error
  (throw in dev, clamp in prod with a warning).
- `badgeFrame({ color, title, titleRight, rows[4], footerLeft,
  footerRight })` — the info frame: row 1 is two chips + title (+ optional
  right-aligned text such as a category), rows 2–5 are content, row 6 is
  two chips + footer. Page counters render as `1/3` on the footer right.
- `borderFrame({ color, lines[<=4], more })` — the alert frame: full
  one-color border, content lines inside (left-padded one space after the
  border chip), and when `more` is true the bottom-right border chip is
  yellow — the "continuation" marker for multi-frame alerts.
- `gauge(filled, total)` — `(` + green chips + blanks + `)` for the Tesla
  battery bar (18 slots).
- `blockTime(date)` — the clock face: 3x5 chip digits (white) with a
  yellow colon, `AM`/`PM` letters beside the last digit row. Digit
  patterns are fixed 3x5 grids for 0–9.
- `validate(rows)` — exactly 6 rows of 22 codes, all codes legal. Called
  on every frame before it enters a queue and by every golden test.

Spec notation used in 03: layouts are drawn as 22-character text rows
where lowercase letters mean chips (r o y g b v w for red, orange,
yellow, green, blue, violet, white) and everything else is a literal flap
character. Rows are right-padded with blanks. This notation is for specs
and fixtures only; runtime deals in code arrays.

## 5. Visual grammar

- Info frames for state (dashboards, lists, feeds). Alert frames for
  moments (broadcast, alarm fire, timer fire, reminder fire, game start).
- Color meanings, fixed: red = Tesla, firing alerts, YouTube. Orange =
  timers. Yellow = alarms list, trivia, The Upside. Green = shopping,
  darts, healthy air. Blue = Steam, PSN, wifi, weather, flights. Violet =
  music and announcements. White = Wikipedia, Roll Credits, smart home,
  reminders, the identity frame. Air-quality bands: good g, fair y,
  poor o, bad r. A green chip marks a device ON state.
- Footer conventions: timestamps for point-in-time data; an orange chip
  before the time when the data is a stale cache (the full display's
  amber "cached" pill, translated); `n/m` page counters on paginated
  content; one-line insight text when a value stands out ("DOME RUNNING
  HOT").
- Dwell: `max(dwellSeconds, ceil(chars/10))` capped at 30, where chars
  counts non-blank content. Alerts hold 60 seconds unless their sequence
  says otherwise.
- Ordering: timers and alarms soonest first; flights closest first;
  shopping list pages of 4 in stored order.
- Numbers: averages to one decimal; temperatures, wind, pressure, and
  ages as whole numbers; counts over 9,999 abbreviate (37,285 → 37K).
- Data hygiene: null fields are omitted, never printed; provider
  placeholder titles (PSN "Old Game") are skipped; unknown/absent labels
  fall back to the device or room name.

## 6. Measured limits (assert these in tests)

These numbers came from running the real data through the rules; they are
regression anchors, not estimates.

- Broadcasts (n=292 from voice-events.jsonl): 238 fit tier 1 (≤3 wrapped
  lines at width 18 → one frame with the device line), 26 fit tier 2
  (4 lines → one frame, device dropped), 28 need tier 3 (two frames with
  the continuation chip). Longest observed wraps to 10 lines.
- Upside headlines (n=163): at width 22, 84 fit one frame (≤4 lines), 79
  need two, none need more. Two frames is the hard maximum.
- Trivia pool (n=1,417): exactly 158 pass the single-frame gate — 71
  two-column (question ≤2 lines at width 20 and all four answers ≤8
  characters), 2 stacked (question ≤1 line and answers ≤18), 85 boolean
  (question ≤3 lines). Everything else is skipped.

## 7. Golden fixtures

Every layout in 03-formatters is a fixture: a JSON file with the input
payload (taken from the real examples given there), the expected 6x22 code
arrays, and the expected dwell and priority. The encoder and frame
builders are done when all fixtures pass; a formatter is done when its
fixtures pass. Fixture files live beside the tests, one per screen, named
after the layout ("broadcast-tier2.json", "tesla-dashboard.json").
