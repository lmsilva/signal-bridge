# Roll Credits — requirements and architecture

**Project:** Signal Bridge (`github.com/lmsilva/signal-bridge`) + Alexa Broadcast Client (display)
**Status:** Ready for implementation — revision 2 (name and scraper decided; see §2 and §17)
**Audience:** The implementing agent. Written to be self-contained, but it assumes you read both `src/PROJECT.md` (bridge) and `alexa broadcast client/src/PROJECT.md` (display client) first, as those files instruct.

---

## 0. Read this first — rules for the implementing agent

1. **Read `src/PROJECT.md` and the client `src/PROJECT.md` before writing code.** They are the source of truth for conventions. When you change architecture, modules, config, or UDP behavior, update those files: bump "Last updated" and add a "Recent changes" entry, as they require.
2. **Follow the existing patterns, do not invent new ones.** This feature is deliberately shaped like features that already exist: the Slideshow Manager tab (grid + select + bulk delete + confirm sheet), the Steam/PSN library tours (tiny UDP start payload + playlist fetch + per-card fetch), the Trivia/YouTube settings cards (credentials + Test button), and the command registry (one descriptor gives you the Push tile and the Scheduler entry). Each section below names the file to copy the pattern from.
3. **Do not break existing behavior.** The full test suites must pass before commit: `npm test` (bridge) and `run_all_tests.bat` (bridge + Windows client). Add new tests for everything in section 14. New code must not change existing UDP payload types, existing routes, or existing command registry entries.
4. **Writing style for everything you ship:** plain, simple language in code comments, README additions, and admin UI copy. No unnecessary jargon, no acronyms without a one-line explanation, no vague descriptions. State the mechanism plainly. Long design reasoning belongs in this document and PROJECT.md prose, not repeated in code comments. Commit messages: short and casual — a subject line plus a 2–4 line body; if a commit needs more than that, split the commit.
5. **Deploy notes to include in your Recent changes entry:** bridge-only changes ship with `./recreate.sh`. This feature also adds a new display panel and a new Python dependency (yt-dlp, Phase 2 also python-vlc), so note `./recreate.sh --build` and "portable client rebuild" where they apply. Bump the admin cache-bust `?v=signalNN`.
6. **Ask before deviating.** If a requirement conflicts with something you find in the code, stop and say so rather than silently picking one.

Acronyms used in this document, defined once here:

- **CRUD** — create, read, update, delete: the four basic operations on stored records.
- **API** — application programming interface: the HTTP routes the admin page and display client call on the bridge.
- **UDP** — the lightweight network protocol the bridge already uses to push pages to displays (port 47832).
- **SSE** — server-sent events: a one-way live update stream from server to browser. The Slideshow tab already uses it (`/api/photos/events`).
- **IGDB** — the Internet Game Database, a large community game database owned by Twitch. It has a free API that returns a game's platforms, cover, screenshots, videos, summary, companies, release date, and player counts. Access uses free Twitch developer credentials (a client id + secret) because Twitch owns IGDB — the Twitch account is only the key-issuing front door; no streaming features are involved.
- **yt-dlp** — a command-line tool that downloads a video file from a YouTube link at a chosen resolution. It is the standard tool for this job.

---

## 1. What this feature is

**Roll Credits**: a permanent record of every game Luis (often together with a co-op buddy) has beaten — the credits rolled, so the game goes on the list. Managed from the Signal admin page and shown on the wall display like a trophy wall.

Three parts:

1. **An admin library manager** — a new bottom-menu tab where games are added, edited, deleted, and bulk-managed. Adding a game is mostly automatic: type a title, pick the right match and system from search results, and a scraper fills in the description, publisher, release date, player count, cover, screenshots, and a video. Every scraped value can be replaced, deleted, or extended with uploads. Expected to grow to **hundreds of entries**, so the architecture below is built for that from day one.
2. **A display experience** — pushable from the Push tab and schedulable from the Scheduler tab like every other page. It opens on a **statistics dashboard** (latest game beaten, totals, per-month and per-system charts), then walks through the beaten games one by one, Steam/PSN-library style. Portrait and landscape both first-class.
3. **A configuration card** in the Settings tab — scraper providers and credentials, global media priority (video → screenshots → cover, reorderable), YouTube download resolution, storage caps, and display defaults.

The feature is generic on purpose: nothing in the data model assumes co-op. An optional free-text "Beaten with" field covers the buddy case and stays empty for solo runs.

---

## 2. Feature name — decided: Roll Credits

The feature is named **Roll Credits** (Luis's call, Aug 2026, revision 2). It is the gamer idiom for the exact moment a game is beaten — the credits roll — so the name states the achievement itself, works for co-op and solo alike, and stays short on every surface: the tab, the Push tile, a scheduler rule, and the display header.

Naming rules, so every surface stays consistent:

- Exactly two words, always. Never "Roll Game Credits" — inserting "Game" breaks the idiom and misreads as managing the scrolling list of developer names.
- No "Manage" prefix anywhere. Admin tabs in this project name the thing, not the action (Slideshow, Scheduler, Settings), so the tab is simply **Roll Credits**; under ~380 px it may shorten to **Credits**.
- Names considered and set aside: **Hall of Fame** (revision 1's working name — clear, but less thematic), **Trophy Room** (collides with the PSN trophies already on the display), **Roll Game Credits** (rejected — see above).

Canonical identifiers (use these everywhere; do not improvise variants):

| Surface | Value |
|---|---|
| Admin tab label | `Roll Credits` (short form `Credits` under ~380 px) |
| Display page title (header pill) | `roll credits` |
| Module prefix | `src/roll-credits-*.js` |
| Command registry id | `credits.show` (see §9) |
| Command group | `Games` (new group, new Push row) |
| UDP payload type | `roll-credits.tour` (start payload only; no per-game UDP) |
| API route prefix | `/api/roll-credits/*` |
| Data files | `data/roll-credits.json`, `data/roll-credits-settings.json`, `data/roll-credits-credentials.json`, media under `data/roll-credits-media/` |
| Shipped systems file | `src/roll-credits-systems.json` |
| Record id prefix | `rc_` |
| Client panel | `alexa broadcast client/src/roll_credits_panel.py` |
| Settings card heading | `Roll Credits` |
| Icon key | `credits` — a trophy glyph (a trophy reads "achievement" at tile size; a credits-scroll glyph would read "document") |

---

## 3. Scope

### In scope

- Admin tab: grid view (box tiles, adjustable boxes per row) and list view (pagination, sorting, filtering), single CRUD, bulk select / select all / bulk delete, bulk re-scrape — all behind the existing themed confirm sheet for destructive actions.
- Add/edit flow: title search against the scraper, candidate picker with per-candidate system chips, full metadata editing, media manager (reorder, hide, delete, upload images and video, add a YouTube link at a chosen resolution), per-game media priority override, per-game re-scrape with overwrite-scope confirmation.
- "Beaten on" date: defaults to today; editable by typing, by a native date picker, or by choosing **NA** (date unknown).
- Scraper service with a provider adapter interface. Phase 1 providers: **IGDB** (primary) and the existing keyless **Steam store lookup** (`src/game-lookup.js`, enrichment for PC titles). The interface must make adding ScreenScraper (deep retro assets) later a bounded task.
- Background job queue for media downloads (images, videos) with visible per-game status.
- Push tile, Scheduler command with params, content check, and duration estimate.
- Display: stats dashboard page + per-game showcase pages, portrait and landscape, following the library-tour session/playlist/card architecture.
- Configuration card in Settings.
- Tests per §14; PROJECT.md updates; README section.

### Out of scope (do not build)

- Any social/online sync, accounts, or multi-user features.
- Automatic detection of "beaten" from Steam/PSN achievements (interesting later; not now).
- Editing games from the display; the display is read-only.
- A separate standalone web app — this lives inside the existing admin SPA.

### Phased

- **Phase 1 — everything above except playing video on the display.** Video ingestion (uploads + YouTube downloads) is fully built in Phase 1; the display's media resolver simply skips the `video` kind, falling through to screenshots/cover.
- **Phase 2 — video playback on the display panel.** The display client is Python + Tkinter; it cannot embed a YouTube player. Recommended approach: play the locally stored file with **python-vlc** (bundled LibVLC in the portable build), muted, letterboxed into the art stage, falling back to screenshots when the file is missing or playback fails. This is the only part of the feature that adds a heavyweight client dependency, which is why it is isolated. Get Luis's go-ahead before starting Phase 2.

---

## 4. Data model and storage

### 4.1 Why JSON files, and why that is enough

The bridge stores everything in JSON files under `data/` (settings, caches, registries) with no database, and this feature follows that. A record per game is ~2–4 KB of JSON; **1,000 games ≈ 2–4 MB**, loaded once into memory at startup and written atomically (write to a temp file, then rename — copy the pattern used by the existing settings modules). Sorting/filtering/paginating an in-memory array of a few thousand items takes microseconds. The real weight is **media on disk**, handled in §6. Do not add a database dependency.

### 4.2 `data/roll-credits.json`

```jsonc
{
  "version": 1,
  "games": [
    {
      "id": "rc_9f3k2m",                 // "rc_" + short random; stable forever
      "title": "It Takes Two",
      "system": "PS5",                    // one canonical system per entry (see 4.4)
      "beatenAt": "2026-08-14",           // local date only; null when unknown
      "beatenDateUnknown": false,          // true = the NA option was picked
      "beatenWith": "co-op with Dan",     // optional free text; empty for solo
      "notes": "",                        // optional free text
      "createdAt": "2026-08-14T21:03:00Z",
      "updatedAt": "2026-08-14T21:03:00Z",

      "meta": {
        "description": "…",
        "publisher": "Electronic Arts",
        "developer": "Hazelight Studios",
        "releaseDate": "2021-03-26",      // or just a year as "2021"
        "genres": ["Adventure", "Platform"],
        "maxPlayers": 2,
        "coopSupported": true,
        "difficulty": null                 // manual only — see 5.6
      },
      "metaEdited": ["description"],       // field names the user hand-edited

      "media": [
        {
          "id": "m_ab12",
          "kind": "cover" | "screenshot" | "video",
          "source": "scraped:igdb" | "scraped:steam" | "upload" | "youtube",
          "path": "rc_9f3k2m/cover.jpg",  // relative to data/roll-credits-media/
          "thumbPath": "rc_9f3k2m/thumbs/cover.360.jpg",
          "youtubeUrl": null,               // set when source is "youtube"
          "resolution": null,               // e.g. 720 for downloaded video
          "order": 0,
          "hidden": false,                  // hidden = kept but never displayed
          "status": "ready" | "pending" | "failed",
          "statusDetail": null              // human-readable failure reason
        }
      ],
      "mediaPriorityOverride": null,        // null = use global; else e.g. ["screenshot","cover","video"]

      "provider": {                         // exact ids for precise re-scrape
        "igdbId": 139090,
        "steamAppId": 1426210,
        "screenscraperId": null
      },
      "scrape": {
        "lastScrapedAt": "2026-08-14T21:03:05Z",
        "status": "ok" | "partial" | "failed" | "manual",
        "detail": null
      }
    }
  ]
}
```

Rules:

- `title` + `system` is the natural duplicate key. On add, warn (not block) when a game with the same normalized title + system already exists.
- `beatenAt: null` + `beatenDateUnknown: true` entries count in totals and per-system stats but are excluded from month/year charts.
- Deleting a game deletes its media directory. Deletion is only reachable through the confirm sheet (§7.6).

### 4.3 `data/roll-credits-settings.json`

```jsonc
{
  "mediaPriority": ["video", "screenshot", "cover"],  // global order, drag-reorderable in admin
  "youtube": { "downloadEnabled": true, "defaultResolution": 720 },   // 360|480|720|1080
  "scrape": {
    "maxScreenshots": 6,          // per game, 1–12
    "downloadVideo": true,        // fetch the provider's video during scrape
    "providerOrder": ["igdb", "steam"]
  },
  "display": {
    "secondsPerGame": 12,         // 5–300, same range as library tours
    "dashboardSeconds": 25,       // 10–120
    "order": "recent",            // recent | oldest | random | alpha
    "scheduledGameLimit": 15      // 0 = all; caps how many games a *scheduled* airing walks
  },
  "limits": { "maxImageBytes": 10485760, "maxVideoBytes": 314572800 }  // 10 MB / 300 MB
}
```

Getters reload from disk like `slideshow-settings.js`, so the admin UI and push handlers always agree.

### 4.4 Canonical systems — `src/roll-credits-systems.json`

A shipped JSON list (pattern: `trivia-categories.json`) of canonical system names with a short chip label and the provider platform ids that map to them, e.g. `{ "id": "snes", "label": "SNES", "igdbPlatformIds": [19], "sort": 240 }`. Cover the common home systems across generations (NES → Switch 2, PS1 → PS5, Xbox line, Sega line, PC, handhelds) plus `"Other"` with a free-text label for anything exotic. The scraper maps IGDB platform ids through this file so the candidate picker shows friendly chips, and stats group cleanly.

### 4.5 Credentials — `data/roll-credits-credentials.json`

IGDB Twitch client id + secret, stored encrypted with the existing `secret-box.js` (same as the YouTube API key). `.env` overrides (`IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET`) win, and the admin save refuses to overwrite an env-provided value with HTTP 409 — copy `youtube-credentials.js` exactly.

One-time setup (repeat these steps in the README section): create a free application at `dev.twitch.tv/console/apps` — Twitch requires two-factor authentication with a phone number on developer accounts — copy the Client ID, press "New Secret" for the Client Secret, paste both into the Settings card, and press Test. That is the entire Twitch involvement: the bridge only ever exchanges these two values for an access token, and all game data comes from IGDB's own servers.

---

## 5. Scraper service

### 5.1 Module layout

| File | Role |
|---|---|
| `src/roll-credits-store.js` | Load/save `data/roll-credits.json`; CRUD; list with sort/filter/page; stats aggregation (§10.3) |
| `src/roll-credits-settings.js` | Settings load/save |
| `src/roll-credits-providers.js` | Provider adapters behind one interface (5.2) |
| `src/roll-credits-scraper.js` | Search, full-record scrape, re-scrape with scopes (5.5), field mapping |
| `src/roll-credits-media.js` | Media dirs, sharp thumbnails, uploads, yt-dlp downloads, disk usage, orphan prune |
| `src/roll-credits-jobs.js` | Small sequential background job queue for downloads (5.4) |
| `src/roll-credits-payload.js` | Tour start payload + playlist + card builders (§10.4) |
| `src/roll-credits-credentials.js` | Encrypted IGDB credentials (4.5) |

### 5.2 Provider adapter interface

Every provider implements:

```js
{
  id: 'igdb',
  // Search by title. Returns candidates for the picker:
  // [{ providerId, name, year, platforms: [canonical system ids], thumbUrl }]
  search(title, { limit }),
  // Fetch the full record for one candidate on one platform:
  // { meta fields per 4.2, coverUrl, screenshotUrls: [], videoUrl | youtubeUrl }
  fetchGame(providerId, { system }),
}
```

- **IGDB (primary).** One search call answers the core UX requirement directly: *the user types a title and gets back the systems it applies to* (IGDB returns `platforms` per game). `fetchGame` maps: `summary` → description, `involved_companies` → developer/publisher, `first_release_date`, `genres`, `multiplayer_modes` → `maxPlayers`/`coopSupported`, `cover`/`screenshots` → image URLs, `videos` → a YouTube id (IGDB videos are YouTube-hosted, so the video path goes through the same yt-dlp pipeline as a hand-pasted link). Respect the documented rate limit (4 requests/second) with the same call-spacing approach `trivia-providers.js` uses; cache token until expiry; negative-cache failed lookups 6 h.
- **Steam (secondary, keyless).** Reuse and extend the existing `src/game-lookup.js` (it already searches the Steam store, rejects soundtracks/demos/DLC, requires a real name match, and caches hits 7 d / misses 6 h). Add extraction of `movies` (Steam serves direct mp4 URLs — downloaded directly, no yt-dlp) and `screenshots`. Used to enrich PC titles and as fallback when IGDB has no credentials yet: the feature must degrade gracefully, not die, when only Steam is available.
- **ScreenScraper (future, do not build now).** The adapter interface above must be sufficient for it; note it in a comment.

Provider order comes from settings (`scrape.providerOrder`). First provider that returns a candidate set wins the search; `fetchGame` merges: primary provider fills everything, later providers only fill gaps.

### 5.3 Add-game flow (what the API does)

1. `POST /api/roll-credits/search { q }` → provider search → candidates with system chips. Fast; no downloads.
2. User picks a candidate + one system in the UI (or "Add manually" — title + system only, `scrape.status: "manual"`).
3. `POST /api/roll-credits/games { candidate, system, beatenAt, beatenDateUnknown, beatenWith }` →
   - synchronously: create the record with scraped **text metadata** (one `fetchGame` call — fast) and `media[]` rows in `status: "pending"`;
   - asynchronously: enqueue downloads (cover, screenshots up to `maxScreenshots`, video if enabled) via the job queue.
4. The admin tile shows a small progress state until media lands (SSE event or poll — §7.8).

This keeps "add a game" feeling instant while a 50 MB video downloads in the background.

### 5.4 Job queue

`roll-credits-jobs.js`: an in-process, strictly sequential queue (one download at a time — be polite to providers and the NAS disk). Each job: `{ id, gameId, mediaId, kind, state: queued|running|done|failed, error }`. `GET /api/roll-credits/jobs` returns the queue for the admin status line. Failed media rows keep `status: "failed"` + `statusDetail` and get a per-item Retry button in the media manager. Restart-safe: on startup, any `pending` media row whose file is missing is re-queued.

### 5.5 Re-scrape and overwrite scopes

Both entry points — the Edit screen's "Re-scrape" button and the bulk-select "Re-scrape" action — must open the same **scope confirmation sheet** before anything runs. Options (multi-select checkboxes + one radio):

- Checkboxes — what to refresh: **Metadata**, **Cover**, **Screenshots**, **Video**. Default: all checked.
- Radio — how to treat existing data:
  - **Fill gaps only** (default): only write fields that are empty and media kinds with no `ready` item.
  - **Replace scraped data**: overwrite scraped fields and scraped media in the chosen scopes, but never touch hand-edited fields (`metaEdited`) or media with `source: "upload"` / `"youtube"`.
  - **Replace everything**: overwrite even hand-edited fields in scope. Uploads are still never deleted by a scrape — deleting an upload is only ever an explicit user action.
- The sheet states plainly what will happen, e.g. "Refresh screenshots for 12 games. Your uploads and edited text stay untouched."

Bulk re-scrape enqueues per-game jobs; the sheet's confirm button shows the count.

### 5.6 Difficulty is manual — say so honestly

No reliable public source provides a difficulty rating (IGDB, Steam, and RAWG all lack it). `meta.difficulty` is therefore a manual, optional field with preset chips in the edit form: `Easy · Normal · Hard · Brutal · —`. The scraper never writes it. Do not fake it from review scores.

---

## 6. Media pipeline

### 6.1 On-disk layout

```
data/roll-credits-media/
  rc_9f3k2m/
    cover.jpg
    shot-01.jpg … shot-06.jpg
    video-720.mp4
    thumbs/
      cover.360.jpg  shot-01.360.jpg …
```

Served at `GET /roll-credits-media/<gameId>/<file>` with long-lived cache headers (pattern: `/qr-images/*`). Public route — the display client has no admin session; this matches `/api/library-tour/card`, and the payloads contain nothing sensitive.

### 6.2 Thumbnails

Every image gets a 360 px JPEG thumb via `sharp` on write, with startup backfill and graceful fallback to the original when `sharp` is unavailable — copy `qr-image-cache.js` behavior exactly, including "never invent a thumb URL when sharp is missing." The admin grid and list **only** load thumbs; full images load only in the lightbox and on the display. Videos get a poster frame via `ffmpeg -ss 3 -frames:v 1` when ffmpeg exists in the image, else the cover doubles as the video poster.

### 6.3 Uploads

- Images: base64 JSON upload like `/api/qr/image-upload`, cap `limits.maxImageBytes` (default 10 MB), accept jpg/png/webp.
- Video: base64 would triple memory on a 200 MB file, so this is the one new mechanism — a **streaming raw-body upload** (`PUT /api/roll-credits/games/:id/media/video-upload`, `Content-Type: video/mp4|video/webm`), streamed straight to a temp file, then moved into place. Cap `limits.maxVideoBytes` (default 300 MB), reject early via `Content-Length` when present.

### 6.4 YouTube links

Adding a video by YouTube URL stores `source: "youtube"` + the URL, then enqueues a yt-dlp download at the chosen resolution (per-item picker defaulting to `youtube.defaultResolution`; format selector `bestvideo[height<=H]+bestaudio/best`, merged to mp4). yt-dlp lives in the image's existing Python venv — add a pinned `yt-dlp` line to a new `requirements-roll-credits.txt`, install it in the `Dockerfile` next to `requirements-youtube.txt`, and note `./recreate.sh --build` in Recent changes. When yt-dlp is missing from the image, the media row goes `failed` with a `statusDetail` that names the fix ("rebuild the image: ./recreate.sh --build") — same self-naming-failure philosophy as the YouTube Lounge card. If `youtube.downloadEnabled` is off, the row stays a link-only reference: admin shows the YouTube thumbnail, display skips it.

### 6.5 Disk usage and cleanup

`roll-credits-media.js` exposes `diskUsage()` (total bytes + per-kind split) for the Settings card, and `pruneOrphans()` (delete directories whose game id no longer exists) behind an admin button + confirm sheet. Rough budget to state in the admin UI copy: with defaults (6 shots, 720p video ~40 MB), a fully-loaded game ≈ 45 MB; 300 games ≈ 13 GB. The `downloadVideo` toggle and `maxScreenshots` are the levers.

---

## 7. Admin UI — the Roll Credits tab

A new bottom-menu tab between **Slideshow** and **Settings** (`data-tab="credits"`, icon: a small trophy). That makes five visible tabs (Push, Scheduler, Slideshow, Roll Credits, Settings) plus the two unlock-gated ones — verify the tab bar still fits a 360 px-wide phone without label wrapping; shorten it to "Credits" under 380 px if needed. The whole tab is mobile-first like the rest of the SPA: one-hand reach, bottom sheets for confirmations, touch targets ≥ 44 px, no hover-only affordances.

### 7.1 Header row

Sticky under the app header: **Add game** (primary button), search field (filters as you type, title + publisher + system), view toggle (grid ⇄ list), and in grid mode a boxes-per-row control. Boxes-per-row: segmented `2 · 3 · 4` on phones, `3 · 4 · 6` on wider screens; persisted in `localStorage` (it is a per-device view preference, not shared state).

### 7.2 Grid mode (default)

Box tiles, one per game — visually appealing is the point:

- Tile = cover image (thumb), title (one line, ellipsis), system chip, and the beaten date in small dim text ("Aug 14, 2026" or "date unknown"). A tiny gold `#N` induction number sits in the tile corner (see §12.4).
- Cover missing → first screenshot thumb → a flat placeholder with the title's initials. A small spinner badge while media `pending`; a small warning badge on `failed` (tap opens the game with the failed row visible).
- Lazy-load thumbs below the first dozen cells (copy the Slideshow grid).
- Tap a tile → Edit screen. Long-press (or the header **Select** button) → select mode: check dots on tiles, **Select all / Unselect all** toggle, bottom action bar with **Delete** and **Re-scrape** (both open sheets, §5.5 / §7.6).

### 7.3 List mode

For when the library gets long. A compact table backed by the server-side list API (§11): columns **Title · System · Beaten · Added** (players and publisher appear at wider breakpoints), tap a column header to sort (asc/desc), filter bar with a system multi-select chip row, a year-beaten select, and a "no date" toggle. **Pagination** (50 per page, Prev/Next + "Page x of y") rather than infinite scroll, so hundreds of rows never sit in the DOM. Row tap → Edit. Selection checkboxes + the same bulk action bar as grid mode.

### 7.4 Add flow (bottom sheet on mobile, modal on desktop)

1. Title field + **Search** → candidate list: cover thumb, name, year, and one chip per system it shipped on.
2. Tapping a candidate expands its system chips → pick exactly one → date row appears.
3. Date row: prefilled with today; tap to type or open the native date picker (`<input type="date">` — it is the elegant picker on both iOS and Android); an **NA — don't remember** chip sets unknown. Optional **Beaten with** text field.
4. **Add to Roll Credits** → record appears in the grid immediately (media pending in background).
5. A quiet **Add manually instead** link for titles the search cannot find (offline, obscure Japan-exclusives): title + system + date only.

### 7.5 Edit screen

Full-screen page (mobile) / wide modal (desktop), three stacked sections:

1. **Details** — title, system (select from canonical list, "Other" reveals free text), beaten date (same three-way control as Add), beaten with, difficulty chips, description (textarea), publisher, developer, release date, genres (chip input), max players. Any edit to a scraped field records it in `metaEdited`.
2. **Media** — the manager. Rows grouped by kind (Cover / Screenshots / Video). Each item: thumb, source badge (`IGDB`, `Steam`, `Upload`, `YouTube`), status, and actions: **hide/show**, **delete** (confirm sheet), **retry** (failed only). Reorder within a kind by drag handle (pointer-events, so it works with touch) **plus** ↑/↓ buttons — HTML5 drag-and-drop does not work on touch screens, so the buttons are the guaranteed path. Add buttons per kind: upload image(s), upload video, **Add YouTube link** (URL + resolution select, default from settings).
3. **Media priority for this game** — off by default ("Using global order: video → screenshots → cover"); toggling on reveals the same drag-reorder list as the global one, saved as `mediaPriorityOverride`.

Footer: **Save** (primary), **Re-scrape** (opens the scope sheet), **Delete** (danger, confirm sheet). Save is disabled until something changed; unsaved-changes guard on back navigation.

### 7.6 Confirmations

Every destructive action goes through the existing themed confirm sheet: single delete ("Delete *Chrono Trigger*? Its photos and video are removed too."), bulk delete ("Delete 7 games?"), media delete, orphan prune. Re-scrape uses the scope sheet from §5.5. No `window.confirm` anywhere.

### 7.7 Drag-and-drop summary

Where it exists: media reorder (7.5), global and per-game priority order lists. Everywhere it exists, an equivalent button path exists too. Grid tiles themselves are **not** reorderable — the library's order is always a sort, never manual.

### 7.8 Live updates

Reuse the SSE pattern (`/api/photos/events`): `GET /api/roll-credits/events` pushes `{reason, gameId}` on create/update/delete/media-status-change so a second open tab (or the phone while the NAS downloads a video) stays current. Manual refresh button as the fallback, same as Slideshow.

---

## 8. Configuration — Settings-tab card

One full-width card titled **Roll Credits** (layout pattern: the Trivia and YouTube cards, internal `.settings-columns`):

1. **Scraper** — IGDB client id + secret (password inputs, saved encrypted; 409 message when `.env` owns them), **Test** button that runs a tiny live search and reports "IGDB ok — 4 candidates for 'Zelda'" or the exact failure; provider order display; "Screenshots per game" number (1–12); "Download provider video" toggle.
2. **Media priority** — the global drag-reorder list (Video / Screenshots / Cover) with button fallback; one line of help copy: "When a game is shown, the first kind that exists is featured."
3. **YouTube video downloads** — enable toggle + default resolution segmented control (360/480/720/1080).
4. **Display defaults** — seconds per game (slider 5–300), dashboard seconds (slider 10–120), order segmented control (Newest first / Oldest first / Shuffle / A–Z), scheduled-airing game limit (number; 0 = all) with help copy: "A scheduled airing walks this many of the most recent games so it doesn't hold the display for half an hour. Manual pushes always loop the whole library."
5. **Storage** — live disk usage readout ("2.1 GB — 180 photos, 24 videos"), **Clean up orphaned files** button (confirm sheet).

---

## 9. Push and Scheduler integration

One new command-registry descriptor (this alone gives the Push tile and the Scheduler entry — that is the whole point of `command-registry.js`):

```js
{
  id: 'credits.show',
  title: 'Roll Credits',
  subtitle: 'Dashboard + every game beaten',
  group: 'Games',                          // new group → new Push row
  route: '/api/push/roll-credits',
  icon: 'credits',                             // add to the admin icon map
  pushable: true,
  schedulable: true,
  supportsContentCheck: true,              // content = at least one game
  variableDuration: true,
  defaultDurationSeconds: null,
  params: [
    { key: 'secondsPerGame', label: 'Seconds per game', type: 'number', min: 5, max: 300 },
    { key: 'gameLimit', label: 'Games to show (0 = all)', type: 'number', min: 0, max: 500 },
  ],
}
```

- `estimateDuration(id, params)` = `dashboardSeconds + walkedCount × secondsPerGame + slack` (a few seconds of slack so client timer drift cannot clip the last game — same reason Upside News added it). `walkedCount` honors `gameLimit`, else `display.scheduledGameLimit`, else all.
- Behavior split, copied from library tours: a **manual push loops** (`persistent: true`, dashboard reappears each full lap); a **scheduled airing walks once** (`loop: false`, computed `displaySeconds`) and returns the display to the scheduler.
- Register `assertValid()`-clean: no duplicate id, no duration contradiction — the existing registry test will catch it, and a new test must cover the descriptor (§14).
- Optional (build last, tiny): a voice/routine matcher in `display-voice-commands.js` so an Alexa routine named "Roll Credits" airs it, gated by a `voiceEvents.hofQueries` toggle defaulting on — identical shape to the library-tour matchers.

---

## 10. Display experience

### 10.1 Flow

```
push → [ DASHBOARD (dashboardSeconds) ] → game 1 → game 2 → … → game N ─┐
             ▲                                (secondsPerGame each)      │
             └── manual push loops ──────────────────────────────────────┘
                 scheduled airing ends after game N
```

Order per settings/params. Header pill: **roll credits** on every page (display-wide title convention). Scheduled airings show the standard dismiss footer with the draining rail; manual pushes are persistent (no footer), dismissed like other persistent pages.

### 10.2 Payload architecture — copy the library tour, exactly

Hundreds of games must never ride in one datagram (the library tour learned this: 700 games in one UDP packet silently delivered nothing). Flow:

1. `POST /api/push/roll-credits` builds a session in `library-tour-sessions`-style storage (reuse that module if its shape fits; else `roll-credits-sessions.js` with the same TTL behavior).
2. UDP start payload `roll-credits.tour` — **small**: `{ tourId, count, walkedCount, loop, secondsPerGame, dashboardSeconds, order, playlistPath, cardBaseUrl, stats }`. `stats` is the pre-aggregated dashboard object (§10.3, ~1–2 KB) so the dashboard paints instantly with zero fetches.
3. Client `GET /api/roll-credits/playlist/:tourId` → ordered id list + titles.
4. Per game, `GET /api/roll-credits/card?id=` → full card (meta + absolute media URLs chosen by the **priority resolver**: per-game override or global order; first `ready`, non-hidden kind wins the hero slot; screenshots band filled from what remains). One-ahead prefetch, same as the game library tour. Both routes public, like `/api/library-tour/*`.

The bridge computes everything (stats, priority resolution, URL building); the client only draws. That keeps the client dumb and testable, matching every existing panel.

### 10.3 Dashboard page — the stats, chosen and prioritized

The bridge's `stats` object and what the client renders. **Must-have (Phase 1):**

- **Latest inducted** hero: cover, title, system chip, beaten date, gold induction number ("GAME #132"), and "beaten with" line when present.
- **Big counters:** total games beaten · beaten this year · systems represented.
- **Per month** — bar chart, last 12 months (unknown-date games excluded, footnoted "+N undated" when any exist).
- **Per system** — horizontal bars with counts, top 8 + "others", so "how many per system" reads at a glance.

**Nice-to-have (build if time allows, in this order):** best month ever ("Mar 2026 — 7 games"); average per month over the last year; release-decade spread (a small histogram — satisfying for a retro-heavy library); longest streak of consecutive months with ≥ 1 beat; milestone flag when count crosses 25/50/100/… ("🏆 100th game!" as a gold chip on the hero).

Charts are drawn with plain Tkinter canvas primitives (the client already hand-draws aircraft, gauges, and rings — no chart library). Bars use the accent ramp in §12; every bar carries its number (no legend-hunting from the couch).

### 10.4 Game showcase page

Per game, `secondsPerGame` on screen, layout siblings of the Steam Now Playing panel (reuse its art-stage helpers where possible):

- **Art stage** (hero): the priority-resolved media. Images: ambient blur fill + contained crisp image, corner ticks, nothing composited on top (house rule). Video (Phase 2): muted playback letterboxed in the same stage; on failure fall back to screenshots instantly.
- **Title row:** title (marquee when long via `text_marquee`), system chip, gold induction number, beaten date ("BEATEN AUG 14 2026" / "DATE UNKNOWN"), beaten-with line.
- **Facts band:** description (clipped scroll viewport, never over images), then small stat chips: players, difficulty (when set), publisher · developer · release year, genres.
- **Screenshot strip:** up to 3 thumbs (skipped when the hero already is the only screenshot).
- **Progress:** "12 / 132" + a thin progress rail; countdown handled by the shared dismiss footer on scheduled airings.

### 10.5 Portrait and landscape

Both orientations are first-class (portrait is the household default). Use `design_u`/`page_chrome` so geometry holds on 1080×1920 and 1920×1080. Portrait: vertical stack (stage → title → facts → strip). Landscape: stage left (~55% width), text column right, strip along the bottom of the text column. Dashboard portrait: hero on top, counters row, charts stacked. Dashboard landscape: hero left column, counters + two charts in a right-hand 2×2-ish grid. Wireframes in §13 are normative for placement.

### 10.6 Client module

`roll_credits_panel.py`: handles `roll-credits.tour`, owns dashboard + showcase rendering, playlist/card fetching with one-ahead prefetch, media caching in the client's cache dir, in-place `close` handling. Register the payload type in `payload_utils.py`. Portable client rebuild required — say so in Recent changes; agents build only when explicitly asked.

---

## 11. API routes (all admin-gated except where marked public)

| Route | What it does |
|---|---|
| `GET /api/roll-credits/games?sort&dir&page&pageSize&system&yearBeaten&q&noDate` | Server-side list: sorted, filtered, paginated `{ games, total, page, pageSize }` |
| `POST /api/roll-credits/games` | Create (from candidate or manual) |
| `GET /api/roll-credits/games/:id` | One full record |
| `PUT /api/roll-credits/games/:id` | Update fields / media order / priority override |
| `DELETE /api/roll-credits/games/:id` | Delete + media dir (confirm lives in the UI) |
| `POST /api/roll-credits/games/bulk-delete { ids }` | Bulk delete → `{ deleted, failed }` |
| `POST /api/roll-credits/search { q }` | Provider search → candidates |
| `POST /api/roll-credits/games/:id/rescrape { scopes, mode }` | Single re-scrape |
| `POST /api/roll-credits/rescrape-bulk { ids, scopes, mode }` | Bulk re-scrape (enqueues jobs) |
| `POST /api/roll-credits/games/:id/media` | Add media: base64 image, or `{ youtubeUrl, resolution }` |
| `PUT /api/roll-credits/games/:id/media/video-upload` | Streaming video upload (§6.3) |
| `DELETE /api/roll-credits/games/:id/media/:mediaId` | Delete one media item |
| `POST /api/roll-credits/games/:id/media/:mediaId/retry` | Re-queue a failed download |
| `GET /api/roll-credits/jobs` | Job queue status |
| `GET /api/roll-credits/stats` | The dashboard stats object (admin preview + tests) |
| `GET`/`POST /api/roll-credits/settings` | Settings card backing |
| `POST /api/roll-credits/credentials` / `/credentials/test` | IGDB creds save (encrypted) + live test |
| `GET /api/roll-credits/events` | SSE live updates (§7.8) |
| `POST /api/push/roll-credits` | Build session + send `roll-credits.tour` (push handler; scheduler airs through it) |
| `GET /api/roll-credits/playlist/:tourId` | **Public** — ordered playlist for the display |
| `GET /api/roll-credits/card?id=` | **Public** — one resolved display card |
| `GET /roll-credits-media/*` | **Public** — media files + thumbs, long cache headers |

---

## 12. Design guidelines

Two surfaces, two existing token sets. **Do not invent new base colors** — the feature must look native to both.

### 12.1 Admin (phone-first SPA — tokens from `src/web/admin/styles.css`)

- Background `--bg #0f172a`, cards `--bg-elev #16213b` / `--bg-elev-2 #1c2947`, hairlines `--line #263450`, text `--text #e2e8f0` / `--text-dim #8fa3c4`, radius `16px`.
- Actions: `--accent #38bdf8` for primary (Add game, Save, Search), `--danger #f87171` only for delete, `--good #34d399` for success toasts, `--warn #fbbf24` reserved for the Roll Credits gold (below).
- Tiles: cover images fill the tile with `object-fit: cover`, 16px radius, 1px `--line` border; title on a solid strip below the image, never text over the artwork (house rule carried into admin).
- Sheets and toasts reuse the existing components verbatim.

### 12.2 Display (tokens from client `design_system.py`)

- Surface `BG #0B1730`, cards `FILL #141F35` with `LINE #264060` edges, radius 0 (sharp), ink `#F2F7FF` / `#A4ACC0` / `#6B7388`, accent `#5FD0FF`.
- All geometry in `u` units via `design_u`/`page_chrome` so portrait and landscape stay proportionate; shared header pill + dismiss footer.
- **Nothing composited over imagery.** Chips, numbers, and text live on the surface next to the art stage, never on it (corner ticks only, like Steam).
- Type: reuse the client's existing type ramp (the sizes the Steam/PSN panels use for title / chip / body / stat) — no new font families.

### 12.3 Charts (display dashboard)

Bars in `ACCENT #5FD0FF`; the current month's bar in gold; axis labels in `INK_3`; every bar labeled with its number directly (readable from the couch, no legend). Per-system bars use a single hue — differentiation comes from length + label, not a rainbow.

### 12.4 The signature element: the gold induction number

The feature's one memorable device. Every game carries its permanent induction number — the order it entered the list (`#001`, `#087`) — set in the gold token (`WARN`/`--warn`), the only place gold appears besides milestone chips. On admin tiles it is a small corner tag; on the display showcase it sits beside the system chip; on the dashboard hero it is large ("GAME #132"). It encodes something true (this list is a sequence of victories) instead of decorating. Milestone chips (25/50/100…) share the gold. Everything else stays quiet navy/ice so the gold reads as an award.

### 12.5 Iconography

One trophy glyph, drawn as inline SVG in the admin icon map style (1.5px stroke line icon): used for the tab button, the Push tile, and the scheduler rule icon. Media source badges are text chips (`IGDB` / `Steam` / `Upload` / `YouTube`), not logos — no third-party brand marks on the display.

### 12.6 Motion and loading

- Admin: skeleton tiles while the first page loads (the Push-tab lesson: paint placeholders so nothing jumps); no other entrance animation.
- Display: media crossfade between games ≈ 250 ms; charts draw once (no bar-growing animation on a wall display); a re-sent identical card must not restart animations (the PSN lesson — redraw only when content changed).
- Video (Phase 2) always muted, no controls chrome.

### 12.7 Copy rules

Sentence case, plain verbs, buttons say what happens ("Delete 7 games", not "Confirm"). Errors name the fix ("IGDB credentials missing — add them in Settings"). Empty states invite: "No games yet. Add the first one you've beaten."

---

## 13. Wireframes (normative for placement, not pixel art)

### 13.1 Admin — Roll Credits tab, grid mode (phone)

```
┌──────────────────────────────────────┐
│ Signal ▾            [display picker] │  sticky app chrome (existing)
├──────────────────────────────────────┤
│ [＋ Add game]   [🔍 search…       ]  │  sticky feature header
│ view: [▦ Grid|☰ List]  per row: 2·3·4│
├──────────────────────────────────────┤
│ ┌─────────────┐  ┌─────────────┐    │
│ │  cover art  │  │  cover art  │    │
│ │        #132 │  │        #131 │    │  ← gold induction tag, corner
│ ├─────────────┤  ├─────────────┤    │
│ │ It Takes Two│  │ Chrono Trig…│    │  title strip (solid, not on art)
│ │ PS5 · Aug 14│  │ SNES · n/a  │    │  system chip · beaten date
│ └─────────────┘  └─────────────┘    │
│ ┌─────────────┐  ┌─────────────┐    │
│ │  cover  ⟳   │  │  cover  ⚠   │    │  ⟳ media pending · ⚠ failed
│ │ …           │  │ …           │    │
│ └─────────────┘  └─────────────┘    │
│              (lazy loads…)          │
├──────────────────────────────────────┤
│ Push │ Sched │ Slides │ Credits │ ⚙  │  bottom tab bar
└──────────────────────────────────────┘

Select mode (long-press or "Select"):
│ ◉ tile  ◯ tile  ◉ tile   [Select all]│
├──────────────────────────────────────┤
│  3 selected   [Re-scrape] [Delete]   │  bottom action bar
```

### 13.2 Admin — list mode (phone)

```
├──────────────────────────────────────┤
│ systems: [SNES][PS5][PC][+]  yr: All │  filter chips
│ [ ] only games with no date          │
├────┬────────────────┬──────┬────────┤
│    │ Title ▲        │ Sys  │ Beaten │  tap header = sort
├────┼────────────────┼──────┼────────┤
│ ☐  │ Chrono Trigger │ SNES │  n/a   │
│ ☐  │ It Takes Two   │ PS5  │ Aug 14 │
│ ☐  │ Ōkami          │ PS2  │ Jul 02 │
│ …  │  (50 rows)     │      │        │
├────┴────────────────┴──────┴────────┤
│      ◀ Prev   Page 2 of 6   Next ▶   │
```

### 13.3 Admin — Add game sheet

```
┌──────────────────────────────────────┐
│ Add game                          ✕  │
│ [ It takes two            ] [Search] │
│ ────────────────────────────────────│
│ ▸ 🖼 It Takes Two (2021)             │
│     systems: (PS5)(PS4)(PC)(XSX)     │  ← tap a chip to choose
│ ▸ 🖼 It Takes Two: Friend's Pass …   │
│ ────────────────────────────────────│
│ Beaten on: [ 2026-08-23 📅 ] [ NA ]  │  type · native picker · unknown
│ Beaten with (optional): [ Dan     ]  │
│              [ Add to Roll Credits ] │
│         Can't find it? Add manually  │
└──────────────────────────────────────┘
```

### 13.4 Admin — Edit screen (phone, scrolls)

```
│ ← It Takes Two                #132   │
│ DETAILS                              │
│  Title [It Takes Two          ]      │
│  System [PS5 ▾]  Beaten [Aug 14|NA]  │
│  Beaten with [Dan            ]       │
│  Difficulty (Easy)(Normal)(Hard)(—)  │
│  Description [………………………………]  ✎edited │
│  Publisher/Developer/Release/Genres… │
│ MEDIA                                │
│  Cover                               │
│   ┌──┐ IGDB · ready   [hide][del]    │
│  Screenshots            [＋ upload]  │
│   ≡ ┌──┐ IGDB   ready  ↑ ↓ [del]     │  ≡ drag handle + arrow fallback
│   ≡ ┌──┐ Upload ready  ↑ ↓ [del]     │
│  Video      [＋ upload][＋ YouTube…] │
│   ≡ ▶ 720p · YouTube · pending ⟳     │
│ MEDIA PRIORITY (this game) [off ◯]   │
│  using global: video→shots→cover     │
│ ────────────────────────────────────│
│ [Re-scrape]      [Delete]   [ Save ] │
```

### 13.5 Re-scrape scope sheet (single + bulk share it)

```
┌──────────────────────────────────────┐
│ Re-scrape 12 games                   │
│ Refresh: [x]Metadata [x]Cover        │
│          [x]Screenshots [x]Video     │
│ ( ) Fill gaps only        (default)  │
│ (•) Replace scraped data             │
│ ( ) Replace everything               │
│ Your uploads and hand-edited text    │
│ stay untouched.                      │
│        [Cancel]  [Re-scrape 12]      │
└──────────────────────────────────────┘
```

### 13.6 Settings card (condensed)

```
┌─ Roll Credits ───────────────────────┐
│ SCRAPER  IGDB id [……] secret [……]    │
│          [Test]  ✓ ok — 4 candidates │
│          Screenshots per game [ 6 ]  │
│          Provider video  [on ●]      │
│ MEDIA PRIORITY  ≡ Video              │
│                 ≡ Screenshots        │
│                 ≡ Cover              │
│ YOUTUBE  downloads [on ●]            │
│          default res (360|480|720…)  │
│ DISPLAY  sec/game ──●── 12           │
│          dashboard ──●── 25s         │
│          order (New|Old|Shuf|A–Z)    │
│          scheduled limit [ 15 ]      │
│ STORAGE  2.1 GB · 180 img · 24 vid   │
│          [Clean up orphaned files]   │
└──────────────────────────────────────┘
```

### 13.7 Push row + Scheduler rule

```
Push tab:                    Scheduler rule card:
┌─ Games ─────────────┐      ┌ Roll Credits ── [On ●] ┐
│ ┌─────────────────┐ │      │ every [6h ▾]  imp [3▾] │
│ │ 🏆 Roll Credits │ │      │ sec/game [12]          │
│ │ Dashboard + all │ │      │ games (0=all) [15]     │
│ └─────────────────┘ │      │ ≈2.3 airings/day · ~3m │
└─────────────────────┘      └────────────────────────┘
```

### 13.8 Display — dashboard, PORTRAIT (1080×1920)

```
┌────────────────────────────────┐
│  ◷ 8:41         roll credits   │  shared header pill
├────────────────────────────────┤
│  LATEST INDUCTED               │
│  ┌──────────┐  It Takes Two    │
│  │  cover   │  PS5 · co-op     │
│  │   art    │  BEATEN AUG 14   │
│  │          │  GAME #132       │  ← large, gold
│  └──────────┘  🏆 132nd game   │
├────────────────────────────────┤
│   132        41         14     │  big counters
│  TOTAL    THIS YEAR  SYSTEMS   │
├────────────────────────────────┤
│  BEATEN PER MONTH (12 mo)      │
│  ▂▄▃▆▄▅▂▇▃▄▆█  ← current=gold  │
│  S O N D J F M A M J J A       │
├────────────────────────────────┤
│  BY SYSTEM                     │
│  PS5  ████████████ 34          │
│  SNES ████████ 22              │
│  PC   ██████ 17                │
│  PS2  █████ 13   (+ top 8)     │
├────────────────────────────────┤
│      Dismisses in 18s ▂▂▂      │  scheduled only
└────────────────────────────────┘
```

### 13.9 Display — dashboard, LANDSCAPE (1920×1080)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◷ 8:41                    roll credits                              │
├──────────────────────┬───────────────────────────────────────────────┤
│  LATEST INDUCTED     │   132        41          14        🏆 #132    │
│  ┌────────────┐      │  TOTAL    THIS YEAR   SYSTEMS   (milestones)  │
│  │            │      ├───────────────────────┬───────────────────────┤
│  │   cover    │      │ BEATEN PER MONTH      │ BY SYSTEM             │
│  │    art     │      │ ▂▄▃▆▄▅▂▇▃▄▆█          │ PS5  ██████████ 34    │
│  │            │      │ S O N D J F M A M J J │ SNES ███████ 22       │
│  └────────────┘      │                       │ PC   █████ 17         │
│  It Takes Two        │                       │ PS2  ████ 13          │
│  PS5 · BEATEN AUG 14 │                       │ …    ███ (top 8)      │
│  GAME #132 · w/ Dan  │                       │                       │
├──────────────────────┴───────────────────────┴───────────────────────┤
│                       Dismisses in 18s ▂▂▂                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 13.10 Display — game showcase, PORTRAIT

```
┌────────────────────────────────┐
│  ◷ 8:41         roll credits   │
├────────────────────────────────┤
│ ┌────────────────────────────┐ │
│ │                            │ │
│ │      ART STAGE             │ │  hero media by priority:
│ │  (video │ shot │ cover)    │ │  blur-fill + contained crisp,
│ │                            │ │  corner ticks, nothing on top
│ └────────────────────────────┘ │
│  It Takes Two        (PS5)     │
│  GAME #132 · BEATEN AUG 14     │  ← gold number
│  beaten with Dan               │
│ ┌────────────────────────────┐ │
│ │ description … (clipped     │ │
│ │ scroll viewport)           │ │
│ └────────────────────────────┘ │
│  👥 2 players · Hard · 2021    │
│  Hazelight · EA · Adventure    │
│ ┌───────┐ ┌───────┐ ┌───────┐  │
│ │ shot  │ │ shot  │ │ shot  │  │  strip (skipped if hero is
│ └───────┘ └───────┘ └───────┘  │   the only screenshot)
│  12 / 132  ▂▂▂▂▂▂▂▂            │  progress rail
│      Dismisses in 8s           │
└────────────────────────────────┘
```

### 13.11 Display — game showcase, LANDSCAPE

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◷ 8:41                    roll credits                              │
├──────────────────────────────────┬───────────────────────────────────┤
│ ┌──────────────────────────────┐ │  It Takes Two          (PS5)      │
│ │                              │ │  GAME #132 · BEATEN AUG 14 2026   │
│ │                              │ │  beaten with Dan                  │
│ │         ART STAGE            │ │ ┌───────────────────────────────┐ │
│ │   (~55% width, full height   │ │ │ description — clipped scroll  │ │
│ │    of the content zone)      │ │ │ viewport, never over images   │ │
│ │                              │ │ └───────────────────────────────┘ │
│ │                              │ │  👥 2 players · Hard · 2021       │
│ │                              │ │  Hazelight · EA · Adventure       │
│ └──────────────────────────────┘ │  ┌───────┐ ┌───────┐ ┌───────┐    │
│                                  │  │ shot  │ │ shot  │ │ shot  │    │
│  12 / 132 ▂▂▂▂▂▂▂▂▂▂             │  └───────┘ └───────┘ └───────┘    │
├──────────────────────────────────┴───────────────────────────────────┤
│                       Dismisses in 8s ▂▂▂                            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 14. Testing requirements

New tests are required, and the entire existing suite must stay green. **Before every commit: `run_all_tests.bat`** (bridge + client), per the repo rule.

### 14.1 New bridge tests (`test/roll-credits*.test.js`)

- **Store:** CRUD round-trips; atomic save survives a simulated crash mid-write (temp file present, main file intact); bulk delete returns `{deleted, failed}`; duplicate title+system warning flag; list API sorting (each column, both directions), filtering (system, year, text, no-date), pagination math at 0, 1, 50, 51, and 500 games.
- **Dates:** default-today on create; typed date; `NA` → `beatenAt: null` + flag; unknown dates counted in totals but absent from month buckets.
- **Stats:** month buckets across a year boundary; per-system top-8 + "others" rollup; latest-game selection; streak and best-month math; milestone detection at 25/50/100; empty-library stats shape.
- **Scraper (providers fully mocked):** IGDB search → candidate mapping with platform→canonical-system translation; fetchGame field mapping incl. `multiplayer_modes` → maxPlayers/coop; provider fallback order; gap-fill merge (secondary never overwrites primary); rate-limit spacing; token refresh; negative cache; Steam `movies`/`screenshots` extraction; difficulty is never written by any provider.
- **Re-scrape scopes:** fill-gaps writes only empties; replace-scraped preserves `metaEdited` fields and upload/youtube media; replace-everything overwrites fields but still never deletes uploads.
- **Media:** priority resolution — global order, per-game override, hidden and failed items skipped, fall-through when a kind is empty (video→shots→cover); thumb generation and the no-sharp fallback (no invented thumb URLs); image upload cap enforced; video streaming upload cap via Content-Length and via stream length; yt-dlp missing → `failed` + self-naming `statusDetail`; orphan prune only removes unreferenced dirs.
- **Jobs:** strict sequencing; retry re-queues; restart re-queues pending rows with missing files.
- **Payloads:** `roll-credits.tour` start payload stays small (assert an upper byte bound well under one datagram); playlist order honors settings/params; card URL building against `cardBaseUrl`; scheduled `walkedCount` honors `gameLimit` → settings limit → all; `estimateDuration` math incl. slack; manual push `persistent`/loop vs scheduled walk-once.
- **Command registry:** new descriptor passes `assertValid()`; `credits.show` appears exactly once in `GET /api/commands`; content check false at zero games, true at one.
- **Routes:** admin-gating on every mutating route; playlist/card/media routes public; SSE emits on create/update/delete/media-status; credentials save encrypted + 409 on env override; `/credentials/test` reports success and the exact failure string.

### 14.2 New client tests (`test_roll_credits_panel.py`)

Payload parsing (tour start incl. stats); dashboard layout portrait and landscape (geometry fits `page_chrome`, counters/charts positioned, current-month gold bar); showcase layout both orientations; hero fall-through when video/screenshots missing; marquee engaged for long titles; progress "n / N"; one-ahead prefetch; identical re-send does not restart animation; `payload_utils` type detection for `roll-credits.tour`.

### 14.3 Regression assertions (explicit)

- Full `npm test` and client suite pass with zero modified expectations in existing files.
- No existing UDP type, route, or command id changed; registry `assertValid()` still passes for the whole list.
- Admin tab bar with five visible tabs renders without wrap at 360 px width.
- Scheduler still enumerates and airs all pre-existing commands (scheduler-api tests untouched and green).
- `data/` migration: none required — the feature only adds new files; assert startup is clean with no roll-credits files present.

---

## 15. Non-functional requirements

- **Performance:** admin grid first paint < 1 s on LAN with 500 games (thumbs only, lazy below the fold); list API responses < 50 ms at 1,000 games; display card fetch + media < `secondsPerGame` with one-ahead prefetch hiding latency.
- **Resilience:** every scraper/network failure degrades, never blocks — manual add always works offline; a game with zero media still renders (placeholder stage, full text); display tour survives a mid-tour bridge restart (session TTL; client shows what it has and ends cleanly).
- **Security:** IGDB secret encrypted at rest (`secret-box`), never returned by any GET; all mutations admin-gated; upload types validated by magic bytes, not extension; public routes expose only game metadata + media on the LAN (accepted, same posture as library tours).
- **Storage:** caps enforced server-side; disk usage visible in Settings; no unbounded growth paths (screenshots capped, one video per game recommended default).

---

## 16. Delivery plan

| Phase | Contents | Done means |
|---|---|---|
| **1a — Foundation** | Store, settings, systems file, list API, stats, tests | `npm test` green; stats verified against a 300-game fixture |
| **1b — Scraper + media** | Providers, jobs, media pipeline, uploads, YouTube ingestion, credentials card | Add-by-search works end to end; failure states self-name |
| **1c — Admin tab** | Grid/list, add/edit, bulk ops, sheets, SSE, settings card | Usable on a phone; cache-bust bumped |
| **1d — Push/scheduler + display** | Command, session/playlist/card, `roll_credits_panel.py` dashboard + showcase | Manual push loops; scheduled walk ends on time; both orientations verified on the wall |
| **2 — Video on display** | python-vlc playback, portable-build bundling | Awaits Luis's go-ahead (§17) |

Each phase ends with: full test run, PROJECT.md (both) Recent-changes entries with deploy notes, README section update.

---

## 17. Decisions

**Decided (revision 2, Aug 2026):**

1. **Name: Roll Credits** — see §2 for the rules and the full identifier table.
2. **Scraper: IGDB confirmed as primary.** To settle the Twitch question for good: Twitch owns IGDB, and the Twitch developer site is only where IGDB's free API keys are issued. The bridge never touches Twitch beyond exchanging the client id + secret for an access token; all game data comes from IGDB's servers. Setup steps are in §4.5. Keyless Steam stays the built-in fallback, so the feature works (thinner) before credentials exist.

**Still open for Luis — everything else in this document has a chosen default:**

1. **Phase 2 video** — approve the python-vlc dependency for the display client when that phase starts, or keep the display images-only permanently?
2. **Scheduled-airing default** — 15 most recent games per scheduled airing (≈ 3 minutes at defaults; manual pushes always loop the whole library). Comfortable, or prefer a different number?

---

## Revision history

- **r2 — 2026-08-23:** Name decided: **Roll Credits** (revision 1's working name was Hall of Fame). IGDB confirmed as primary scraper. Every identifier, path, route, payload type, test name, and wireframe renamed to match; §4.5 gains the one-time Twitch-credential setup steps. Companion file added: `roll-credits-wireframes.html` — visual versions of the §13 wireframes for the hand-off (§13 stays normative).
- **r1 — 2026-08-23:** Initial draft under the working name Hall of Fame.
