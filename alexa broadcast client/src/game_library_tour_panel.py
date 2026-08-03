"""Game library tour — session UDP start + HTTP playlist + per-card enrich."""

from __future__ import annotations

import json
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import timezone
from urllib.parse import urlsplit

from src.design_system import INK_2, INK_3, design_u, page_chrome
from src.display_panels import BasePanel
from src.payload_utils import parse_iso_timestamp
from src.psn_now_playing_panel import PsnNowPlayingPanel
from src.steam_now_playing_panel import SteamNowPlayingPanel

# Frozen builds hit the bridge's self-signed cert; once unverified works, keep it.
_unverified_ssl = False


def clamp_seconds_per_game(value) -> int:
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        seconds = 60
    return max(5, min(300, seconds))


def steam_poster_candidates(app_id: str) -> list[str]:
    """Mirror bridge steam-api libraryCapsuleUrls — built client-side so UDP stays tiny."""
    app_id = str(app_id or "").strip()
    if not app_id:
        return []
    bases = (
        "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps",
        "https://cdn.cloudflare.steamstatic.com/steam/apps",
        "https://steamcdn-a.akamaihd.net/steam/apps",
    )
    assets = (
        "library_600x900_2x.jpg",
        "library_600x900.jpg",
        "library_capsule_2x.jpg",
        "library_capsule.jpg",
        "portrait.png",
        "header.jpg",
    )
    return [f"{base}/{app_id}/{asset}" for base in bases for asset in assets]


def bridge_url_candidates(url: str, config: dict | None = None) -> list[str]:
    """Primary bridge URL plus LAN bridgeHosts rewrites (same idea as trivia artwork)."""
    text = str(url or "").strip()
    if not text:
        return []
    out = [text]
    try:
        parts = urlsplit(text)
    except Exception:
        return out
    if not parts.scheme or not parts.path:
        return out
    hosts = []
    for host in (config or {}).get("bridgeHosts") or []:
        host = str(host or "").strip()
        if host and host not in hosts:
            hosts.append(host)
    for host in hosts:
        port = parts.port
        if port:
            netloc = f"{host}:{port}"
        elif parts.scheme == "https":
            netloc = f"{host}:47810"
        else:
            netloc = host
        rewritten = f"{parts.scheme}://{netloc}{parts.path}"
        if parts.query:
            rewritten += f"?{parts.query}"
        if rewritten not in out:
            out.append(rewritten)
        if parts.scheme == "https":
            http_netloc = (
                f"{host}:47810"
                if not parts.port or parts.port == 443
                else f"{host}:{parts.port}"
            )
            http_url = f"http://{http_netloc}{parts.path}"
            if parts.query:
                http_url += f"?{parts.query}"
            if http_url not in out:
                out.append(http_url)
    return out


def iso_timestamp(value) -> str | None:
    """Normalize epoch ms / ISO strings for nested Steam/PSN panels."""
    dt = parse_iso_timestamp(value)
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _http_get_json(url: str, timeout: float = 30, config: dict | None = None) -> dict | None:
    global _unverified_ssl
    for candidate in bridge_url_candidates(url, config):
        req = urllib.request.Request(candidate, headers={"Accept": "application/json"})
        contexts: list = []
        if _unverified_ssl or str(candidate).lower().startswith("https://"):
            try:
                contexts.append(ssl._create_unverified_context())
            except Exception:
                pass
        contexts.append(None)
        for ctx in contexts:
            try:
                kwargs = {"timeout": timeout}
                if ctx is not None:
                    kwargs["context"] = ctx
                with urllib.request.urlopen(req, **kwargs) as resp:
                    if ctx is not None:
                        _unverified_ssl = True
                    return json.loads(resp.read().decode("utf-8"))
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
                continue
    return None


def fetch_library_playlist(
    card_base_url: str,
    playlist_path: str,
    config: dict | None = None,
) -> list[dict] | None:
    base = str(card_base_url or "").rstrip("/")
    path = str(playlist_path or "").strip()
    if not base or not path:
        return None
    if not path.startswith("/"):
        path = f"/{path}"
    data = _http_get_json(f"{base}{path}", timeout=45, config=config)
    if not data or not data.get("ok"):
        return None
    games = data.get("games")
    return games if isinstance(games, list) else None


def fetch_library_card(
    card_base_url: str,
    platform: str,
    game_id: str,
    name: str = "",
    config: dict | None = None,
) -> dict | None:
    """GET /api/library-tour/card — returns the steam/psn object or None."""
    base = str(card_base_url or "").rstrip("/")
    if not base or not game_id:
        return None
    query = urllib.parse.urlencode({
        "platform": platform,
        "id": game_id,
        **({"name": name} if name else {}),
    })
    data = _http_get_json(f"{base}/api/library-tour/card?{query}", timeout=20, config=config)
    if not data or not data.get("ok"):
        return None
    key = "psn" if platform == "psn" else "steam"
    card = data.get(key)
    return card if isinstance(card, dict) else None


def normalize_tour_game(entry: dict) -> dict | None:
    game_id = str(entry.get("id") or entry.get("appId") or entry.get("titleId") or "").strip()
    name = str(entry.get("name") or "").strip() or "Unknown"
    if not game_id:
        return None
    posters = list(entry.get("posterCandidates") or [])
    image_url = entry.get("imageUrl")
    if image_url and image_url not in posters:
        posters.insert(0, image_url)
    return {
        "id": game_id,
        "name": name,
        "posterCandidates": posters,
        "imageUrl": image_url,
        "playtimeLabel": entry.get("playtimeLabel"),
        "playtimeForeverMin": entry.get("playtimeForeverMin"),
        "lastPlayedAt": entry.get("lastPlayedAt"),
        "tags": list(entry.get("tags") or []),
    }


class GameLibraryTourPanel(BasePanel):
    """Walks library games using full now-playing cards.

    Start packet is tiny (tourId + seed). The ordered playlist arrives over HTTP;
    each card is enriched on demand (with one-ahead prefetch).
    """

    SOURCE_CHIP = "SIGNAL"

    def __init__(self, root, shell, config: dict):
        super().__init__(root, shell, config)
        self._steam_panel = SteamNowPlayingPanel(root, shell, config)
        self._psn_panel = PsnNowPlayingPanel(root, shell, config)
        self._tick_job = None
        self._countdown_job = None
        self._games: list[dict] = []
        self._index = 0
        self._seconds_per_game = 60
        self._platform = "steam"
        self._loop = True
        self._card_base_url = ""
        self._playlist_path = ""
        self._tour_id = ""
        self._expected_count = 0
        self._remaining = 0
        self._fetch_token = 0
        self._status_ids: list[int] = []
        self._counter_id = None
        self._countdown_id = None
        self._enrich_cache: dict[str, dict] = {}
        self._prefetch_ids: set[str] = set()

    def _active_card_panel(self):
        return self._psn_panel if self._platform == "psn" else self._steam_panel

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        tour = payload.get("gameTour") or {}
        self._platform = "psn" if tour.get("platform") == "psn" else "steam"
        self._seconds_per_game = clamp_seconds_per_game(tour.get("secondsPerGame"))
        self._loop = tour.get("loop") is not False
        self._card_base_url = str(tour.get("cardBaseUrl") or "").rstrip("/")
        self._tour_id = str(tour.get("tourId") or "").strip()
        self._playlist_path = str(tour.get("playlistPath") or "").strip()
        if self._tour_id and not self._playlist_path:
            self._playlist_path = f"/api/library-tour/playlist/{self._tour_id}"
        try:
            self._expected_count = max(0, int(tour.get("count") or 0))
        except (TypeError, ValueError):
            self._expected_count = 0

        seed = [
            game
            for entry in (tour.get("games") or [])
            for game in [normalize_tour_game(entry)]
            if game
        ]
        self._games = seed
        self._index = 0
        self._remaining = self._seconds_per_game
        self._enrich_cache = {}
        self._prefetch_ids = set()

        # Paint seed (or a loading shell) immediately — do not wait on playlist HTTP.
        if self._games:
            self._render_current()
        else:
            self._paint_loading()

        if self._playlist_path and self._card_base_url:
            token = self._fetch_token
            threading.Thread(
                target=self._load_playlist_worker,
                args=(token,),
                daemon=True,
            ).start()

    def hide(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None
        if self._countdown_job is not None:
            try:
                self.root.after_cancel(self._countdown_job)
            except Exception:
                pass
            self._countdown_job = None
        self._steam_panel.hide()
        self._psn_panel.hide()
        self._clear_status()
        super().hide()
        self._games = []
        self._index = 0
        self._fetch_token += 1
        self._enrich_cache = {}
        self._prefetch_ids = set()

    def _render(self, payload: dict):  # pragma: no cover
        self.show(payload)

    def _paint_loading(self):
        self._steam_panel.hide()
        self._psn_panel.hide()
        self._clear_status()
        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or self.root.winfo_screenwidth() or 1080)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or self.root.winfo_screenheight() or 1920)
        label = "Loading library…"
        if self._expected_count:
            label = f"Loading library ({self._expected_count} games)…"
        item = self.canvas.create_text(
            screen_w // 2,
            screen_h // 2,
            anchor="center",
            text=label,
            fill=INK_2,
            font=self.shell.section_title_font,
        )
        self._status_ids = [item]

    def _load_playlist_worker(self, token: int):
        games = fetch_library_playlist(
            self._card_base_url,
            self._playlist_path,
            config=self.config,
        )
        self.root.after(0, lambda: self._apply_playlist(token, games))

    def _apply_playlist(self, token: int, games: list | None):
        if token != self._fetch_token or not self.visible:
            return
        if not games:
            if not self._games:
                self._paint_loading()
            return
        normalized = [game for entry in games for game in [normalize_tour_game(entry)] if game]
        if not normalized:
            return
        current_id = self._games[self._index]["id"] if self._games else None
        self._games = normalized
        self._expected_count = len(normalized)
        if current_id:
            for index, game in enumerate(self._games):
                if game["id"] == current_id:
                    self._index = index
                    break
        else:
            self._index = 0
            self._remaining = self._seconds_per_game
            self._render_current()
            return
        # Playlist arrived after seed paint — refresh counter/total and prefetch.
        self._update_status_text()
        self._prefetch_neighbors()

    def _clear_status(self):
        for item_id in self._status_ids:
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
        self._status_ids = []
        self._counter_id = None
        self._countdown_id = None

    def _advance(self):
        self._tick_job = None
        if not self.visible or not self._games:
            return
        next_index = self._index + 1
        if next_index >= len(self._games):
            if not self._loop:
                self._remaining = 0
                self._update_status_text()
                return
            next_index = 0
        self._index = next_index
        self._remaining = self._seconds_per_game
        self._render_current()

    def _schedule_tick(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
        self._tick_job = self.root.after(self._seconds_per_game * 1000, self._advance)

    def _schedule_countdown(self):
        if self._countdown_job is not None:
            try:
                self.root.after_cancel(self._countdown_job)
            except Exception:
                pass
        self._countdown_job = self.root.after(1000, self._tick_countdown)

    def _tick_countdown(self):
        self._countdown_job = None
        if not self.visible:
            return
        self._remaining = max(0, self._remaining - 1)
        self._update_status_text()
        if self._remaining <= 0:
            return
        self._schedule_countdown()

    def _total_for_counter(self) -> int:
        return max(len(self._games), self._expected_count)

    def _update_status_text(self):
        total = self._total_for_counter()
        index = self._index + 1 if self._games else 0
        counter = f"{index} / {total}" if total else "0 / 0"
        if self._remaining > 0:
            countdown = f"NEXT IN {self._remaining}s"
        elif not self._loop and self._games and self._index >= len(self._games) - 1:
            countdown = "TOUR COMPLETE"
        else:
            countdown = "NEXT IN 0s"
        if self._counter_id is not None:
            self.canvas.itemconfigure(self._counter_id, text=counter)
        if self._countdown_id is not None:
            self.canvas.itemconfigure(self._countdown_id, text=countdown)

    def _paint_status_overlay(self):
        self._clear_status()
        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or self.root.winfo_screenwidth() or 1080)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or self.root.winfo_screenheight() or 1920)
        u = design_u(screen_w, screen_h)
        chrome = page_chrome(screen_w, screen_h, timed=False)
        y = int(round(chrome.content_bottom - 28 * u))
        x0 = int(round(chrome.content_x + 16 * u))
        x1 = int(round(chrome.content_x + chrome.content_w - 16 * u))
        self._counter_id = self.canvas.create_text(
            x0, y, anchor="w", text="", fill=INK_2, font=self.shell.section_label_font,
        )
        self._countdown_id = self.canvas.create_text(
            x1, y, anchor="e", text="", fill=INK_3, font=self.shell.section_label_font,
        )
        self._status_ids = [self._counter_id, self._countdown_id]
        self._update_status_text()

    def _poster_candidates_for(self, game: dict) -> list[str]:
        posters = list(game.get("posterCandidates") or [])
        if self._platform == "steam":
            for url in steam_poster_candidates(game.get("id") or ""):
                if url not in posters:
                    posters.append(url)
        elif game.get("imageUrl") and game["imageUrl"] not in posters:
            posters.insert(0, game["imageUrl"])
        return posters

    def _thin_fallback_card(self, game: dict, *, enrich_pending: bool = True) -> dict:
        key = "psn" if self._platform == "psn" else "steam"
        posters = self._poster_candidates_for(game)
        # Seed/playlist rows use epoch ms — convert so nested NP panels never
        # see raw ints (parse_iso_timestamp also tolerates them as a backstop).
        last_played = iso_timestamp(game.get("lastPlayedAt"))
        card = {
            "name": game.get("name") or "Unknown",
            "mode": "library-tour",
            # Nested Steam/PSN panels reserve desc/shots/footer and spin while True.
            "enrichPending": bool(enrich_pending),
            "shortDescription": "",
            "tags": list(game.get("tags") or []),
            "posterCandidates": posters,
            "headerImage": posters[0] if posters else None,
            "screenshots": [],
            "playtimeLabel": game.get("playtimeLabel"),
            "playtimeForeverMin": game.get("playtimeForeverMin"),
            "lastPlayedAt": last_played,
            "startedAt": last_played,
            "achievements": {"earned": None, "total": None, "available": False},
            "trophies": {"earned": None, "total": None, "available": False},
        }
        if self._platform == "steam":
            try:
                card["appId"] = int(game.get("id") or 0)
            except (TypeError, ValueError):
                card["appId"] = 0
        else:
            card["titleId"] = game.get("id")
            card["statusLine"] = "In library"
        return {key: card}

    def _prefetch_neighbors(self):
        if not self._card_base_url or not self._games:
            return
        for offset in (1, 2):
            index = self._index + offset
            if index >= len(self._games):
                if self._loop and self._games:
                    index = index % len(self._games)
                else:
                    continue
            game = self._games[index]
            game_id = game.get("id") or ""
            if not game_id or game_id in self._enrich_cache or game_id in self._prefetch_ids:
                continue
            self._prefetch_ids.add(game_id)
            token = self._fetch_token

            def worker(gid=game_id, gname=game.get("name") or "", t=token):
                card = fetch_library_card(
                    self._card_base_url,
                    self._platform,
                    gid,
                    gname,
                    config=self.config,
                )
                self.root.after(0, lambda: self._store_prefetch(t, gid, card))

            threading.Thread(target=worker, daemon=True).start()

    def _store_prefetch(self, token: int, game_id: str, card: dict | None):
        self._prefetch_ids.discard(game_id)
        if token != self._fetch_token or not card:
            return
        self._enrich_cache[game_id] = {**card, "mode": "library-tour"}

    def _render_current(self):
        self._steam_panel.hide()
        self._psn_panel.hide()
        self._clear_status()
        if not self._games:
            self._paint_loading()
            return

        current = self._games[self._index]
        token = self._fetch_token
        self._schedule_tick()
        self._schedule_countdown()

        cached = self._enrich_cache.get(current.get("id") or "")
        if cached:
            self._apply_enriched(token, current, cached, from_cache=True)
        else:
            thin = self._thin_fallback_card(current)
            self._active_card_panel().show(thin)
            self._paint_status_overlay()
            if self._card_base_url:
                def worker():
                    card = fetch_library_card(
                        self._card_base_url,
                        self._platform,
                        current.get("id") or "",
                        current.get("name") or "",
                        config=self.config,
                    )
                    self.root.after(0, lambda: self._apply_enriched(token, current, card))

                threading.Thread(target=worker, daemon=True).start()

        self._prefetch_neighbors()

    def _apply_enriched(self, token: int, game: dict, card: dict | None, *, from_cache: bool = False):
        if token != self._fetch_token or not self.visible:
            return
        key = "psn" if self._platform == "psn" else "steam"
        if not card:
            # Enrich failed — keep the thin card but drop spinners.
            self._active_card_panel().show(self._thin_fallback_card(game, enrich_pending=False))
            self._paint_status_overlay()
            return
        card = {**card, "mode": "library-tour"}
        card.pop("enrichPending", None)
        game_id = game.get("id") or ""
        if game_id and not from_cache:
            self._enrich_cache[game_id] = card
        if not card.get("playtimeLabel") and game.get("playtimeLabel"):
            card["playtimeLabel"] = game.get("playtimeLabel")
        if card.get("playtimeForeverMin") is None and game.get("playtimeForeverMin") is not None:
            card["playtimeForeverMin"] = game.get("playtimeForeverMin")
        if not card.get("lastPlayedAt") and game.get("lastPlayedAt"):
            card["lastPlayedAt"] = iso_timestamp(game.get("lastPlayedAt"))
        elif card.get("lastPlayedAt"):
            card["lastPlayedAt"] = iso_timestamp(card.get("lastPlayedAt")) or card.get("lastPlayedAt")
        if card.get("startedAt"):
            card["startedAt"] = iso_timestamp(card.get("startedAt")) or card.get("startedAt")
        # Ensure posters exist even when enrich omitted them.
        posters = list(card.get("posterCandidates") or [])
        for url in self._poster_candidates_for(game):
            if url and url not in posters:
                posters.append(url)
        if game.get("imageUrl") and game["imageUrl"] not in posters:
            posters.insert(0, game["imageUrl"])
        card["posterCandidates"] = posters
        if not card.get("headerImage") and posters:
            card["headerImage"] = posters[0]
        self._active_card_panel().show({key: card})
        self._paint_status_overlay()
