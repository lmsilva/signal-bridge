# Signal Bridge — Guest Book (rev 3)

Feature requirements for a coding agent. Name confirmed: **Guest Book**. All §13 decisions are settled — build as written.

Companion file: `guest-book-mockups.html` (board frames, phone screens, admin screens). Where this document and the mockups disagree, this document wins.

---

## 1. Purpose

Let visitors send their own message to the house Vestaboard from their phone, the same way the official Vestaboard "Guest Send" channel works, but self-hosted inside Signal Bridge.

The board invites people: it shows a welcome frame with a short web address. A guest opens that address, writes a message (or draws artwork on a board simulator), and the message appears on the real Vestaboard.

Everything runs inside the existing Signal Bridge server. No Vestaboard+ subscription features are used.

## 2. Words used in this document

- **Board** — the physical Vestaboard flagship: 6 rows × 22 columns = 132 split-flap tiles. It can only show uppercase letters, digits, a small set of punctuation marks, and 7 color chips. The valid character set already exists in the bridge's Vestaboard code — reuse that map; do not make a new one.
- **Frame** — one full 6×22 screen of content sent to the board.
- **Guest page** — the public web page where guests write messages.
- **Invite frame** — the frame that advertises the guest page on the board.
- **Short link** — the TinyURL address shown on the invite frame (example: `TINYURL.COM/WITTYBOARD`).
- **Public base URL** — the address where Signal Bridge is reachable from the internet (today: `https://signal.wittydigital.com`).
- **The Book** — the admin log of every guest message ever received.

## 3. What gets built (summary)

Five pieces, in dependency order:

1. A **global "Public base URL" setting** (new, shared by other features too).
2. A **short-link service** that creates and watches a TinyURL pointing at the guest page.
3. The **guest page** itself: compose, preview, send — with optional protection and always-on abuse limits.
4. **Board behavior**: how and when guest messages show, and for how long.
5. **Admin**: a settings section, the invite push/schedule controls, and The Book (message log + optional approval).

## 4. Global setting: Public base URL

Add one field to the admin Settings page: **Public base URL**.

- Default: empty. When empty, features that need it fall back to today's behavior (`https://<PROXY_OWN_IP>:47810/` style local URLs).
- When set (example: `https://signal.wittydigital.com`), every feature that advertises a URL to people must build it from this value:
  - Guest Snaps: the booth URL shown on the display overlay and inside the generated QR codes.
  - Guest Book: the guest page URL and the short link target.
  - Any future feature that prints a URL or QR code.
- Validation: must be `https://`, no trailing slash stored, must be a hostname (not a LAN IP) when used for the short link.
- Store it in `data/config.json` like other settings (`web.publicBaseUrl`). Changing it takes effect without a restart.
- Migration task: find every place that currently prints the booth URL or builds a QR code and route it through one helper, `publicUrl(path)`.

## 5. Short-link service (TinyURL)

### 5.1 Why a short link

The board cannot show `HTTPS://SIGNAL.WITTYDIGITAL.COM/GUESTBOOK/` — too long, and the board has no lowercase. The invite frame must show a short, all-caps, typeable address. `TINYURL.COM/` is 12 characters, so with a board row of 22 characters the alias may be **at most 10 characters**. TinyURL requires an alias of **at least 5 characters**.

### 5.2 The API token (yes, we need a config field)

Anonymous TinyURL creation exists, but reserving a **custom alias** reliably and managing the link needs the official API with a token from a free TinyURL account (created under Account Settings → API). Add to admin Settings, Guest Book section:

- **TinyURL API token** — secret; store in `.env` as `TINYURL_API_TOKEN` like other secrets, editable from Settings the same way other credentials are handled today.
- **Preferred alias** — text field, default `WITTYBOARD`. Validate: 5–10 characters, letters and digits only. Stored uppercase.

API call to create: `POST https://api.tinyurl.com/create` with bearer token, body `{ "url": <target>, "domain": "tinyurl.com", "alias": <alias> }`.

Free-account limits that shape the design:

- Free tokens can **create** links, **update an alias**, and **archive** links. Changing the **destination** of an existing link is a paid feature. So: if the Public base URL ever changes, do not try to repoint the old link — archive it and create a fresh one.
- We create at most a handful of links, ever. Health checks (§5.4) never call the API, so free-plan quotas are not a concern.

### 5.3 Case rule — register both spellings

The board displays the alias in uppercase only. Public reports disagree on whether TinyURL aliases are case-sensitive, so do not depend on either answer:

1. Create the link with the alias exactly as displayed: `WITTYBOARD`.
2. Then attempt a second link with the lowercase twin `wittyboard` pointing at the same target.
   - If TinyURL treats case as equal, the second create fails as "alias taken" — treat that as success and record one link.
   - If TinyURL treats case as different, we now own both spellings, so the address works whether a guest types it as shown or in lowercase (phone keyboards default to lowercase).
3. Health checks test **both** spellings.

Build-time task: verify the real behavior once with a test alias and leave a comment in the service recording what was observed.

### 5.4 Health watch and self-repair

- Target URL: `<publicBaseUrl>/guestbook/`.
- On a schedule (default: once per day, configurable), fetch `https://tinyurl.com/<alias>` (and the lowercase twin) **without following redirects** and check that the redirect location matches the target. This is a plain public web request — it costs no API quota.
- Also run the check on demand from a **Check now** button in Settings.
- If a check fails: try to re-create the link via the API. If the alias is gone for good (taken, rejected), fall back in order: `<ALIAS>` → `<ALIAS>1` → `<ALIAS>2` → a random 8-character alias. Update the stored alias, mark the old link archived if the API allows, and raise an admin alert (same alert style the bridge already uses for re-auth needed).
- The invite frame always renders the **current** alias at push time (§10). Never bake the alias into stored frames.
- Settings shows a status widget: alias, full short link, last check time, last result (see mockups).

### 5.5 Reuse

Build this as a small internal service (`shortlinks`) with `ensure(name, targetPath)` + `status(name)` so later features (for example a short link for the Guest Snaps booth) can register their own named links the same way.

## 6. The guest page

### 6.1 Address and access

- Path: `<publicBaseUrl>/guestbook/`.
- Served by the existing Signal web server next to `/` (booth) and `/admin/`. Public: no admin session required. It must remain reachable through the Cloudflare Tunnel — the outbound connector that publishes the bridge to the internet without opening router ports — with **no Cloudflare Access login policy** on this path (admin keeps its protection).
- Mobile-first layout. Follows the Signal Bridge look (dark `#0B1730` background, existing header/footer components).
- Quicklink on the admin sign-in page: alongside the existing "Guests share photos at the photo booth." line, add "Guests sign the guest book." with "the guest book" linking to `/guestbook/`. Same style and placement as the photo booth line. Show the link only while the Guest Book is enabled.

### 6.2 Compose — Message tab

- Fields: **Message** (multi-line) and **Your name** (optional, single line).
- Live board preview above the fields: an exact 6×22 simulation using the **same renderer as the admin Vestaboard Simulator page** — extract that renderer into a shared component; do not fork it.
- Input rules: text is uppercased as typed; characters outside the board's valid set are not accepted and a short hint appears ("The board can show A–Z, 0–9 and , . ! ? ' - : ; / $ % + & = ( ) @ #"). Emoji are offered as the 7 color chips only, from a small chip picker.
- The name, when given, is placed as a final line `- NAME` and counts against space.
- Layout controls: horizontal alignment (left / center / right) and vertical position (top / middle / bottom). The preview updates live. Guests can also tap a row in the preview to nudge the text block there.
- A tile counter shows space used (out of 132) and the send button disables when the message cannot fit.

### 6.3 Compose — Design tab

- A full-board editor on the same shared simulator component: tap a tile, then pick from a palette of the 7 color chips, a character keyboard, or an eraser. Includes undo and clear.
- Switching tabs keeps work: Message tab content converts to tiles when entering the Design tab; going back to Message tab from an edited design warns that free-drawn tiles will be lost.
- This tab ships in v1 as **Phase 4** (confirmed, §13).

### 6.4 Send, confirm, errors

- Send posts the frame to the bridge. Response states in plain words what happened: shown now, queued behind other messages, waiting for approval, or held until quiet hours end (each case per §8–§9).
- Success screen shows the frame as sent and how many sends the guest has left (rate limit, §8).
- If the board is unreachable, the bridge retries in the background for up to 10 minutes; the guest sees "The board is taking a nap — your message will appear when it wakes." The entry still lands in The Book.

## 7. Protection (optional, default off)

One setting, **Who can send**, with three modes:

1. **Anyone with the link** (default) — matches the official feature.
2. **Password** — admin sets a guest password. Guests enter it once; a signed cookie keeps them in for 24 hours. Store only a bcrypt hash. Compare in constant time.
3. **Board code** — a 6-digit code that rotates every 24 hours and is printed on the invite frame itself (`CODE 314159`), so only people who can physically see the board (or were told the code) can send. Same pattern as the existing Guest Snaps booth PIN — reuse that code-rotation logic.

Brute-force guard for modes 2–3: after 5 wrong tries from one address or session, block that source for 15 minutes with a plain "Too many tries — wait 15 minutes" message. Log attempts to The Book's event trail.

## 8. Abuse limits (always on, even in open mode)

- **Per-guest rate**: default 3 messages per 10 minutes (per session + per address). Configurable.
- **Per-day cap**: default 100 guest messages per day across everyone. Configurable.
- **Pause switch** in admin: stops new sends instantly; guest page shows "The guest book is closed right now."
- **Blocked words** (optional, default off): a simple admin-edited word list; a blocked message is refused with a generic "That message can't be shown" (never echo which word matched).
- **Approval queue** (optional, ships off — confirmed, §13): when on, messages wait in The Book until approved; the guest is told "Your message is waiting for the host."
- **Quiet hours**: the board's existing quiet hours (22:00–07:00) apply. By default a guest message during quiet hours is queued and the guest is told when it will appear. Admin toggle "Guests may wake the board" (default off) lets messages through anyway.

## 9. Board behavior when a guest message arrives

- Show it as soon as allowed (immediately in the default setup). Multiple messages queue first-in-first-out.
- **Guest dwell**: how long a guest message holds the board before normal content may replace it. Default 5 minutes, configurable 1–30. (This is intentionally longer than the 15-second reading-time dwell used for event frames — a guest walked over and typed; give it wall time.)
- **Invite footer** (toggle, default on): after the message dwell, if the frame has free bottom rows, re-render the guest message with the chips row + short link footer appended (see mockup "message + footer"), and hold that for the same dwell again. If the message uses too many rows to fit the footer, skip this step.
- After dwell ends, the board returns to whatever the scheduler / last pushed content dictates. Guest messages never interrupt alarm or timer frames.

## 10. The invite frame

- A new pushable + schedulable board content type, exactly like other Vestaboard features (appears in push controls and in scheduler rules with the Vestaboard target).
- Default template (each line editable in admin; alias and code substituted at render time):

  ```text
  Row 1  (blank)
  Row 2  WANT TO LEAVE A NOTE?
  Row 3  <12 color chips, centered>
  Row 4  SIGN THE GUEST BOOK AT
  Row 5  TINYURL.COM/<ALIAS>
  Row 6  (blank; shows CODE ###### in board-code mode)
  ```

- `SIGN THE GUEST BOOK AT` and `TINYURL.COM/WITTYBOARD` are both exactly 22 characters — full rows. Template validation must enforce 22 per row after substitution.
- Optional later scope (not required now): a matching **full-display panel** for the big screens with the same message plus a QR code built from `publicUrl('/guestbook/')`, following the existing Guest Snaps overlay pattern.

## 11. Admin

**Settings → Guest Book** (one card, see mockups): enable toggle, Who can send + password/code, approval toggle, blocked words, rates, guest dwell, invite footer toggle, quiet-hours override, TinyURL token, preferred alias, short-link status widget with Check now.

**The Book** (new admin tab or section):

- Every entry: time, name (or "anonymous"), frame thumbnail (mini simulator render), source (message / design), status (shown, queued, waiting, denied, held for quiet hours, failed), and the sender's address kept only for abuse control.
- Actions per entry: approve / deny (when queue is on), **replay to board**, delete.
- The list is the permanent guest book — that is the point of the name. Keep entries until deleted.

## 12. Security notes

- The guest page is a public internet endpoint. All state-changing requests go through the bridge's existing HTTPS server; no new ports.
- Cloudflare Tunnel already fronts `signal.wittydigital.com`; confirm the tunnel config needs no change (it maps the hostname, not paths) and that no Access policy covers `/guestbook/`.
- Secrets (`TINYURL_API_TOKEN`, guest password hash) live in `.env` / `data/`, never in git — same handling as Tesla and Alexa credentials.
- Frames from guests are data, never code: render only through the character map; no HTML from guest input is ever echoed anywhere (The Book thumbnails render from tile codes).
- Log enough to answer "who flooded the board last night" (address + timestamps in The Book) and nothing more.

## 13. Decisions (all confirmed by Luis, Aug 29 2026)

1. **Feature name** — **Guest Book**. Page path `/guestbook/`, admin log named "The Book", invite line 4 reads `SIGN THE GUEST BOOK AT`.
2. **Default send mode** — **instant**: a guest message goes straight to the board. The approval queue exists but ships off.
3. **Design tab** — **in v1**, built as Phase 4 on the shared simulator component.

## 14. Build order and acceptance checks

Build and commit in this order; each phase leaves the system working.

- **Phase 1 — Public base URL.** Setting exists, `publicUrl()` helper used by Guest Snaps QR + booth URL. Check: change the setting, QR on the display re-renders with the new host.
- **Phase 2 — Short-link service.** Token + alias config, create with both spellings, daily health check, Check now button, repair path, status widget. Check: break the target on purpose (edit setting), watch repair create a new link and alert.
- **Phase 3 — Guest page (Message tab) + limits + board behavior.** Compose with live preview, send, dwell, FIFO queue, footer variant, quiet-hours hold, rate limits, pause switch, protection modes, the admin sign-in quicklink, The Book recording everything. Check: two phones send back-to-back; second queues; both land in The Book; wrong password 5× blocks for 15 minutes.
- **Phase 4 — Design tab.** Shared simulator component extracted and used by admin + guest page. Check: draw chips artwork on a phone, it shows on the board tile-for-tile.
- **Phase 5 — Invite frame + scheduler + approval.** Invite pushable and schedulable, alias rendered live, board-code line in code mode, approval queue flow end-to-end.

## 15. References

- Mockups: `guest-book-mockups.html` (this handoff).
- Official feature being mirrored: Vestaboard "Guest Send" channel (channels.vestaboard.com → Guest Send).
- TinyURL API: `https://api.tinyurl.com/` (bearer token; token from account API Settings).
- Repo guides: `README.md`, `src/PROJECT.md` (bridge architecture), existing Vestaboard + Simulator feature docs under `docs/`.
