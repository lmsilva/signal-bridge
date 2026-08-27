# Career Shot Chart — Requirements & Design (rev 4)

For: the huupe pages on the Signal Bridge display — the career dashboard page and the live/session view page.
Replaces: the green/red court graphic on both pages.
Rev 2 added: the ambient page background (section 10) and the glass card treatment.
Rev 3 added: the live view page (section 11) and per-page background signatures.
Rev 4 makes the demos and mockups full pages: every card and stat from the current screens is included, in both orientations.
Comes with these files: `shot-zones-template.svg` (the court, uncolored), `shot-chart-demo.html` (dashboard page reference), `live-view-demo.html` (live view reference), and four full-page mockups: `dashboard-bg-portrait.png`, `dashboard-bg-landscape.png`, `live-view-bg-portrait.png`, `live-view-bg-landscape.png`.

---

## 1. Purpose

The card must answer one question at a glance, from across the room: **which shot range do my points come from?** It shows a half basketball court. Each distance band on the court is colored by how many points that range has produced, relative to the other ranges. The hottest band glows. Behind the cards, a faded, sports-editorial background gives the page depth without competing with the data.

Scope guard: both pages keep their current composition. Every card, stat, pill, status header, and "Dismisses in Xs" footer from the existing screens stays, arranged as the four mockups show per orientation. Only two things change: the shot chart card itself, and the background behind the cards (which also turns the cards to glass).

## 2. What the data gives us — and what it does not

The hoop does not report where on the court a shot was taken. There are no shot coordinates. The data is four buckets, one per shot type:

| id | Name on screen | Court position | Point value |
|---|---|---|---|
| `layup` | LAYUP | At the rim | 0.1 |
| `short` | SHORT RANGE | Low post | 1 |
| `mid` | MID RANGE | High post | 2 |
| `deep` | DEEP RANGE | Top of the key | 3 |

Each bucket has three numbers: `made`, `taken`, and `points` (made × point value).

This constraint drives the whole design. Because there are no coordinates, do **not** draw shot dots, scatter blobs, or a smooth heat cloud — that would invent precision the data does not have. Instead, the court is divided into four distance bands that match the four buckets exactly, and each whole band takes one color.

## 3. The design idea

One sentence: **the court is a dark blueprint, and heat is light.**

- The court is drawn in fine, pale lines on the dashboard's dark navy. It looks like a technical drawing of a court, not a green cartoon court.
- Each band's fill comes from a cold-to-hot color ramp. Cold bands almost disappear into the background. Hot bands look lit from within.
- The single hottest band gets a soft glow along its boundary line, like a lit strip. This is the one showpiece effect. Everything else stays quiet.
- The deep band is large, so its fill fades out with distance from the rim. When deep is hot, the three-point line burns bright and the color melts back into navy by the half-court line. The panel never becomes one solid block of color.
- The page background (section 10) extends the same mood: giant ghost type, a faded strip of real court, and one warm glow — all pushed far back behind a scrim.

## 4. Court geometry

All numbers below are in the template's coordinate units. Scale: **1 foot = 10 units**. The drawing is a real half court (50 ft wide, 47 ft deep) with the hoop at the bottom, so proportions look correct.

| Thing | Value |
|---|---|
| Canvas (viewBox) | `0 0 560 530` |
| Court rectangle | x 30–530, y 30–500, corner radius 10 |
| Baseline | y = 500 (bottom) |
| Half-court line | y = 30 (top) |
| Rim center | (280, 447.5), radius 7.5 |
| Backboard | line from (250, 460) to (310, 460) |
| Paint (key) | x 200–360, y 310–500 |
| Free-throw circle | center (280, 310), radius 60 — top half only |
| Restricted arc | radius 40 around the rim |
| Three-point line | straight lines at x = 60 and x = 500 up to y = 358.02, joined by an arc of radius 237.5 around the rim |
| Half-court circle | center (280, 30), radius 60 — lower half only |

The four heat bands are rings around the rim:

| Band | From the rim | Shape in the template |
|---|---|---|
| `layup` | 0 – 5 ft | circle, radius 50 |
| `short` | 5 – 13.75 ft | circle, radius 137.5 (ends exactly at the free-throw line) |
| `mid` | 13.75 ft – three-point line | the area inside the three-point line |
| `deep` | beyond the three-point line | the rest of the court, including the corners |

Paint order matters. The bands are painted far to near (`deep`, `mid`, `short`, `layup`), so each nearer band covers the one under it. No cut-out shapes are needed for the fills.

## 5. Color

Background and line tokens (they match the display's design system, base `#0B1730`):

| Token | Value | Used for |
|---|---|---|
| Page | `#0C1936` → `#0A1428`, top to bottom | page background base |
| Card | `rgba(13, 26, 50, 0.82)` + blur, see section 10 | card background |
| Panel gap | `#0F1D36` | the thin dark gaps between bands (width 5) |
| Court lines | `#A9C6E8` at 16–55% opacity | all court markings |
| Rim | `#FF8A7A` | the one warm accent that is always on |
| Card border | `rgba(124, 169, 218, 0.35)`, 1 px, radius 16 | card frame |

The heat ramp, cold to hot — five stops:

| Position | Color | Reads as |
|---|---|---|
| 0.00 | `#152540` | cold navy, barely lifts off the background |
| 0.28 | `#155E71` | deep teal |
| 0.55 | `#21A895` | teal green |
| 0.78 | `#EFA23C` | amber |
| 1.00 | `#FF6157` | hot coral (the dashboard's accent red) |

To color a band with heat value `t` (0 to 1): find the two nearest stops and mix them channel by channel (red, green, blue). The demo file has this in ten lines of code. Do not pick from a fixed set of four colors — the smooth ramp is what makes small differences between bands visible.

## 6. Heat logic

1. The stat that drives color is **each band's share of career points**. This matches the card's question ("where do the points come from") and the subtitle says so: SHARE OF CAREER POINTS.
2. For each band: `t = points / max(points of all bands)`. The best band is always full hot; the others are relative to it.
3. The label on each band shows its **share of the total**: `round(100 × points / total points)` with a `%` sign. So labels sum to about 100 and cannot be mistaken for shooting accuracy.
4. The **hot zone** is the band with the most points. Tie-breakers: more shots taken, then the longer range.
5. Keep the stat behind one config value so it can later be switched to share of makes or share of attempts without touching the drawing code. Points share is the default.

## 7. Text rules

- Zone names: spaced capitals, letter-spacing 3.5–4, `#8FA9C9`, sizes 9–12.
- Zone values: weight 600, `#EAF2FC`, sizes scaled to the band — deep 32, mid 28, short 22, layup 16. A tiny "OF POINTS" unit line sits under the value (skip it on layup — no room).
- **Dark-text flip:** when a band's `t` is 0.6 or higher, its fill is bright (amber to coral), so its label switches to dark navy text (`#0E1B31` value, `#12233E` name). Exception: `deep` always keeps light text, because its label sits in the faded part of its gradient where the background stays dark.
- **Empty band:** a band with zero shots taken keeps its value ("0%") but the whole label dims to `#54687F`. The band itself just shows the cold end of the ramp. Nothing is hidden — an empty band is information too.
- Use the display's existing font. The mockups use Barlow Semi Condensed; any clean semi-condensed sans with strong numerals works. Numerals should be tabular if available so values do not shift width.

## 8. The glow

- Each band has a glow twin in the template: its boundary path with a thick stroke (14–16 units) run through a blur filter (Gaussian, strength 11). Default opacity 0.
- Only the hot zone's glow turns on: stroke color = the band's fill color, opacity around 0.7.
- The glow breathes: opacity eases 0.55 → 0.75 → 0.55 on a 3.2 s loop. If the viewer's system asks for reduced motion, the glow holds still at 0.6.
- When new data arrives, band fills ease to their new colors over 400 ms. No other animation.

## 9. Card layout

Top to bottom inside the card:

1. Header row: coral accent bar + "CAREER SHOT CHART" (spaced caps) on the left, "SHARE OF CAREER POINTS" small on the right.
2. The court, full card width.
3. The hot-zone strip, centered: `HOT ZONE · DEEP RANGE · 80% OF POINTS` — zone name in coral, the rest muted.
4. A small legend: a 140 px bar filled with the ramp, labeled FEWER POINTS / MOST POINTS.

The chart is nearly square (560 × 530), so it works in both portrait and landscape page layouts. Scale it to the card's width and keep the aspect ratio — never stretch it. Minimum comfortable card width is about 320 px; below that, drop the "OF POINTS" unit lines first.

## 10. Page backgrounds (new in rev 2, split per page in rev 3)

The goal: each page should feel like a sports-magazine spread, but faded so far back that the cards always win. Both huupe pages share the same background system; each gets its own signature so the two screens read as siblings, not copies. Two hard rules first:

- The background is **decoration only, never information.** Any card may fully cover any part of it.
- Content never sits directly on imagery. Text and data live on cards or above the scrim — this keeps the display's existing no-content-on-imagery convention intact.

Layers, painted back to front:

Shared layers on every page, painted back to front:

| # | Layer | Spec |
|---|---|---|
| 1 | Base | vertical gradient `#0C1936` → `#0A1428` |
| 2–4 | Signature layers | per page, see the table below |
| 5 | Scrim | a vertical wash of `#0B1730`: 55% opacity at top, 25% mid, 65% at bottom, over all layers above. This is what guarantees the fade. |
| 6 | Corner ticks | four small L-shaped marks, `#E8F1FB` at 30%, 22 px arms, 4 px thick, 40 px in from each corner. |

Signature layers per page:

| Signature | Dashboard page (career) | Live view page (session) |
|---|---|---|
| Photo (optional) | a dark court/action photo, screen-filling cover crop. Treatment: grayscale 35%, brightness 45%, contrast 105%, then opacity 0.35. The page must look finished without it. | none — this page is fully drawn, no photo layer |
| Texture | **court strip**: a full-width band about 28% of the screen height tall: fill `#464D55` at 30% opacity, with two large arcs and two slanted lines stroked `#DDE6EE` at 30% opacity (an abstract patch of asphalt court) | **echo arcs**: six thin rings (`#A9C6E8`, 2.5 px, 10% opacity) plus two very wide rings (95 px, 4% opacity), all concentric, radiating from one bottom corner — an echo of the chart's distance bands |
| Ghost word | "BASKETBALL" (configurable, one word) | the session status shown in the header: "LIVE" during play, "FINAL" after |
| Ghost word style | heaviest available weight, slightly tight letter-spacing, `#E8F1FB` at **5% opacity**, bleeding off the screen edges — cropped letters are part of the look | same style; shorter word, so it sets larger |
| Warm glow | `#FF6157` (coral) fading from 13% opacity to zero, diameter about 75% of the longer screen edge | `#EFA23C` (amber) fading from 11% opacity to zero, same size |

Placement per orientation:

| Layer | Dashboard portrait | Dashboard landscape | Live view portrait | Live view landscape |
|---|---|---|---|---|
| Ghost word | rotated, up the **left edge**, ~15% of screen height per letter | across the **top**, ~17% of screen width, bleeding both sides | rotated, down the **right edge**, ~20% of screen height per letter | across the **bottom**, ~26% of screen width |
| Texture | strip in the lower third, below the main card | strip across the vertical middle | arcs from the **bottom-left** corner | arcs from the **bottom-right** corner |
| Warm glow | top-right corner | bottom-right corner | top-left corner | top-left corner |

Cards over this background become **glass**: `rgba(13, 26, 50, 0.82)` plus a backdrop blur of 14 px. If the renderer cannot blur what is behind an element, fall back to solid `#0D1A32` — never ship an unblurred transparent card.

Photo guidance: pick or pre-process photos the same way as the existing trivia/news background artwork — dark, moody court shots, processed offline, exported as WebP around 1920 px on the long edge, and checked once against the treatment above so white card text stays clearly readable over the photo's brightest area. A small local folder of processed images, one picked per day, is enough. No network fetch at render time.

Motion: the background is static by default. An optional very slow breathing of the photo (scale 1.00 → 1.04 over 60 s, back and forth) may be added behind a config flag, off by default and disabled when reduced motion is requested.

## 11. The live view page (new in rev 3)

The live/session view (status header, FREE PLAY timer, session totals, the shot chart, the shooting-by-zone list, the FINAL footer) adopts the new chart with no changes to the chart itself:

- **Same card, same template, same contract** (section 13). Only the data source differs: this page gets the current session's four buckets instead of career totals.
- Card title: "SHOT CHART". Subtitle: "SHARE OF SESSION POINTS".
- The "Shooting by Zone" list beside it stays exactly as it is. The two are complementary, not duplicates: the list answers "how well do I hit from each range" (accuracy), the court answers "where do my points come from" (points share). Because they answer different questions, the court's hot zone may disagree with the list's best accuracy — with the sample session, the court's hot zone is DEEP RANGE (80% of points) while the list's best line is LAYUP (100% made). That is correct behavior, not a bug.
- The ghost word mirrors the status header: "LIVE" while the session runs, "FINAL" once it ends. It only echoes a value already shown in the header — the background never becomes the only place a fact appears.
- During a live session, data updates flow through the normal 400 ms ease from section 8; the background never animates on data changes.

## 12. States

| State | Behavior |
|---|---|
| No shots ever | All bands cold, all values show "—", no glow. Strip reads: `NO SHOTS YET — THE COURT LIGHTS UP AS YOU PLAY`. |
| One band has all the points | That band is full hot with glow; the rest sit at the cold end. This is normal, not an error. |
| Zero-shot band among active ones | Cold fill, dimmed label, value "0%". |
| Data update while visible | Fills ease over 400 ms; glow moves to the new hot zone if it changed. |
| Hoop offline | Show the last known data unchanged. Offline status already lives in the Records card; do not repeat it here. |
| Missing background photo | Layers 1 and 3–7 carry the page alone. Never show a broken-image state. |

## 13. Legibility rules

- Color is never the only signal: every band always carries its name and its percentage, and the legend explains the ramp.
- The dark-text flip in section 7 exists to keep values readable on amber and coral. Do not remove it.
- This is a wall display read from meters away. Zone values are the biggest text in the card after the header; do not shrink them below the sizes in section 7 at full card width.
- The scrim and glass cards are the legibility guarantee for the background. If any photo makes card text hard to read, fix the photo (darker, or lower its opacity) — never brighten the text or thin the scrim.

## 14. Contract between the drawing and the code

The code touches the template only through these ids, on both pages. Everything else in the drawing — and the entire background except the live view's ghost word — is static.

| Element | What the code sets |
|---|---|
| `#zone-layup`, `#zone-short`, `#zone-mid` | `fill` = ramp color |
| `#deep-stop-near`, `#deep-stop-mid`, `#deep-stop-far` | `stop-color` = ramp color (the deep band is a gradient; set all three, leave the opacities alone) |
| `#glow-layup` … `#glow-deep` | `stroke` = ramp color; add class `is-hot` on the hot zone only |
| `#label-<zone> .zl-value` | the share text, e.g. `80%` |
| `#label-<zone>` | class `is-bright` (dark-text flip) and/or `is-empty` (dimmed) |
| Hot-zone strip | the text described in section 9 |

`shot-chart-demo.html` (dashboard page) and `live-view-demo.html` (live view page) both implement this contract completely (`applyHeat()`), each with its own background signature from section 10, loaded with the real numbers from the screenshots: layup 3/3, short 0/0, mid 1/1, deep 3/5 — total 11.3 points. Open either in a browser and rotate the window (or a phone) to see both orientations. To try the dashboard's photo layer, put any dark court photo next to it named `court-photo.jpg`. Treat the demos as the reference for both look and behavior. The four PNG mockups show the target composition per page and orientation.

## 15. Acceptance checklist

- [ ] Every card, stat, and footer from the current screens is present; only the shot chart and the background are new.
- [ ] Court geometry matches section 4; nothing is stretched.
- [ ] With the sample data, deep glows coral, mid is teal, layup is near-cold, short is cold and dimmed — matching the demo page.
- [ ] Band colors come from the ramp by mixing, not from a fixed palette.
- [ ] Labels always visible; percentages sum to about 100; empty bands dimmed, not hidden.
- [ ] Dark-text flip works on amber/coral bands; deep always keeps light text.
- [ ] Only one glow at a time; it breathes; reduced-motion setting stops the breathing.
- [ ] Data updates ease over 400 ms.
- [ ] Empty-career state shows the blueprint court with the no-shots message.
- [ ] Backgrounds render correctly in portrait and landscape on both pages, matching the four mockups.
- [ ] The two pages are clearly siblings: shared base, scrim, ticks, and glass cards — different ghost word, texture, and glow color.
- [ ] Dashboard page looks finished with no photo present; adding a photo never breaks card legibility.
- [ ] Live view uses the same template and contract as the dashboard, with the SHARE OF SESSION POINTS subtitle and session data.
- [ ] Live view ghost word follows the status header (LIVE during play, FINAL after).
- [ ] Cards are glass with backdrop blur, with the solid fallback when blur is unavailable.
- [ ] Stat source sits behind one config value (default: share of points).
