# Games framework

House games are served at `/games/` and share one TinyURL token, one session machine, and one archive.

## TinyURL

One store (`src/tinyurl-credentials.js`, `TINYURL_API_TOKEN`, `data/tinyurl-credentials.json`). Resolver ladder keyed by short-link scope (`guestbook`, `guestsnaps`, `games`):

1. Scope env — `TINYURL_API_TOKEN_GAMES`
2. Scope saved override — `overrides[scope]`
3. Global env — `TINYURL_API_TOKEN`
4. Global saved — `token`

Settings → Global holds the shared token next to the public base URL. Guest Book, Guest Snaps, and Games may store an optional override. Env wins: a 409 if you try to overwrite the matching env var.

Short-link name `games` → `/games/`. Default alias `WITTYGAME` (21 characters as `TINYURL.COM/WITTYGAME`).

## Sessions

Phases: `invited → lobby → round → intermission → round → … → final → closed`.

Codes are 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O). Live sessions are in-memory only. Archived to `data/game-sessions/YYYY-MM.jsonl` on finish and on abandon.

Public routes (`/api/games/*`) sit above the admin-session wall. Admin routes are hyphenated (`/api/word-scramble/*`, `/api/game-sessions/*`).

## Word Scramble

Boggle on a 4×4 grid. Letters must touch 8-way. No cell reused. Dice omit Q. Standard scoring. `duplicateRule`: `everyone` (default) or `cancel`.

The Vestaboard shows a static grid for the whole round (`holdSeconds` = remaining). Timer and live score stay on the phone. A session is lobby, then 3 rounds, with high scores between them.

Phase transitions post `priority: 'snapshot'` with `breakHold: true` and `replaceSource: 'word.scramble'`. Never `alert`.
