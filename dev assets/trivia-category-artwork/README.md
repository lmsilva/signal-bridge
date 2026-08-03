# Trivia category artwork

52 background images — 26 categories x portrait and landscape — plus the code
that produced them.

## What these are

Procedurally generated. Every file here came out of `generate_artwork.py` from
nothing but code and a seed. **There are no third-party rights in any of it**:
no stock photos, no licensed imagery, no attribution obligations, nothing to
re-clear if the display is ever shown publicly. Regenerate, recolour, or resize
freely.

## Direction

"Instrument plots." Each category is a saturated deep-colour field carrying one
geometric system drawn in fine luminous linework with additive bloom — a readout
from an instrument rather than a photograph. The pattern means something about
the subject: Geography gets topographic contours, Computers gets circuit traces,
Music a waveform, History stratigraphic bands, Celebrities a starfield.

The choice is deliberate for this device rather than generically pretty. A smart
display *is* an instrument that shows data, and emissive linework on a deep field
is what that looks like. It also solves the practical problem that photographic
backgrounds fight with overlaid type while sparse linework does not.

## The colour system

Backgrounds are **not** eyeballed. They are derived in CIELAB LCh by
`derive_palette.py`, which places each category at a chosen hue angle and
lightness and then solves for the highest in-gamut chroma at that point.

Two axes carry the differentiation:

- **Hue** — 26 angles spread around the wheel, grouped so related categories sit
  near each other. Entertainment runs violet through crimson, humanities run
  amber through gold, the sciences and outdoors run green through cyan, and the
  reference categories sit in blue. The colour tells you roughly what kind of
  question is coming before you have read it.
- **Lightness** — the `tone` column. Hue alone was not enough: with 26 categories,
  several thematic clusters land on near-identical hues. Tone scales how much of
  the luminance budget the colour field is allowed, so within a cluster some
  cards read deep and some read full.

Measured result: the **closest pair of rendered cards is 7.1 dE apart**, median
separation is 54.9 dE. Below about 2.3 dE two colours are indistinguishable, so
every category is comfortably telling itself apart from every other.

Verify at any time:

    python3 derive_palette.py

That prints the palette and the closest pairs.

## Legibility guarantee

Every image is normalised in linear light so its **brightest pixel** sits at
5.2:1 against white. Not an average, not a percentile — the maximum. White
display type is legible at any position on any card, so the layout can move
without re-checking contrast.

Lossy encoding can brighten a few pixels, so the generator re-opens each saved
file, measures the real thing, and darkens-and-resaves until the guarantee holds
**on disk**. Measured range across all 52 files: **5.05:1 to 5.32:1**. Values are
in `categories.json`.

WCAG AA wants 4.5:1 for normal text and 3:1 for large. These are backgrounds for
48-72px type, so the margin is generous.

**Do not add a runtime scrim on top.** The contrast is already in the pixels; a
second overlay only makes the artwork invisible.

## Files

    <category-id>-portrait.webp     1080 x 1920   (26 files)
    <category-id>-landscape.webp    1920 x 1080   (26 files)
    categories.json                 id, label, pattern, background, accent, tone,
                                    filenames, measured contrast
    generate_artwork.py             the generator
    derive_palette.py               the colour derivation + separation check

Portrait and landscape are **separately composed**, not one crop rotated: the
wash anchor and pattern seed differ per orientation. Load the file matching the
current orientation.

WebP at quality 92. The whole pack is under 5 MB.

## Regenerating

Deterministic — the same seed always gives the same art.

    python3 generate_artwork.py            # all 26
    python3 generate_artwork.py 0 6        # a range, by index into CATEGORIES

### Changing things

- **Resolution** — the sizes in `main()`. 4K portrait is `(2160, 3840)`.
  Generation time is roughly linear in pixel count.
- **Brightness** — `TARGET_CONTRAST` at the top. Lower is brighter.
  `CONTRAST_FLOOR` is the value enforced on the encoded file. Do not go below
  4.5 without checking type on the actual panel.
- **Colour** — edit the hue and lightness for a category in `derive_palette.py`,
  re-run it, paste the row into `CATEGORIES`. Check the closest-pair output
  before committing: keep every pair above ~6 dE.
- **A new category** — a row in `derive_palette.py`, a row in `CATEGORIES`, and a
  matching `p_<pattern>` painter. Painters draw white linework into an
  `ImageDraw`; bloom, colouring, tone weighting, vignette and contrast
  normalisation are all handled downstream.

## Palette

Accents are derived from each background's own hue at L*74 and maximum in-gamut
chroma, so the chip, the correct-answer fill and the countdown ring always
harmonise with the card behind them.

| Category | Background | Accent | Tone | Pattern | ID |
| --- | --- | --- | --- | --- | --- |
| General Knowledge | `#003F71` | `#8BB7FF` | 0.8 | compass | `general-knowledge` |
| Books | `#623000` | `#FF9F51` | 0.8 | textblocks | `books` |
| Film | `#8F0043` | `#FF97B2` | 0.9 | sprockets | `film` |
| Music | `#7A2396` | `#E897FF` | 0.97 | waveform | `music` |
| Musicals & Theatre | `#730047` | `#FF94C6` | 0.75 | stagelights | `musicals-theatre` |
| Television | `#321785` | `#C8A6FF` | 0.65 | scanlines | `television` |
| Video Games | `#005D56` | `#00CCBD` | 1.0 | isogrid | `video-games` |
| Board Games | `#8C3300` | `#FF9E6D` | 1.0 | hexfield | `board-games` |
| Science & Nature | `#00582A` | `#00D16C` | 0.95 | branching | `science-nature` |
| Computers | `#005362` | `#00C7E8` | 0.95 | circuit | `computers` |
| Mathematics | `#3F41B2` | `#B9ABFF` | 1.0 | lissajous | `mathematics` |
| Mythology | `#614700` | `#E6AD00` | 0.95 | sunburst | `mythology` |
| Sports | `#2A4A00` | `#7BCB00` | 0.85 | courtarcs | `sports` |
| Geography | `#003829` | `#00CE9F` | 0.65 | contours | `geography` |
| History | `#3F2700` | `#FBA300` | 0.6 | strata | `history` |
| Politics | `#002966` | `#A6B1FF` | 0.6 | chamber | `politics` |
| Art | `#9C0018` | `#FF9B8F` | 0.95 | ribbons | `art` |
| Celebrities | `#413A00` | `#CAB800` | 0.75 | starfield | `celebrities` |
| Animals | `#003A01` | `#39D139` | 0.65 | cells | `animals` |
| Vehicles | `#002E40` | `#28C3FF` | 0.57 | speedlines | `vehicles` |
| Comics | `#67001F` | `#FF99A1` | 0.65 | halftone | `comics` |
| Gadgets | `#004044` | `#00C9D5` | 0.75 | exploded | `gadgets` |
| Anime & Manga | `#8F0072` | `#FF91DD` | 0.95 | radialburst | `anime-manga` |
| Cartoons | `#4D5500` | `#AFC000` | 1.0 | bounce | `cartoons` |
| Food & Drink | `#6D0D00` | `#FF9C83` | 0.7 | concentricpour | `food-drink` |
| Society & Culture | `#5B005C` | `#FF8BFB` | 0.65 | network | `society-culture` |
