import unittest
from unittest.mock import patch

from src.game_library_tour_panel import (
    GameLibraryTourPanel,
    clamp_seconds_per_game,
    fetch_library_card,
    fetch_library_playlist,
    normalize_tour_game,
    steam_poster_candidates,
)
from src.payload_utils import resolve_display_type, title_for_display_type


class GameLibraryTourPanelTests(unittest.TestCase):
    def test_payload_registration(self):
        payload = {
            "type": "game.library-tour",
            "gameTour": {
                "platform": "steam",
                "secondsPerGame": 60,
                "loop": True,
                "tourId": "abc",
                "count": 704,
                "playlistPath": "/api/library-tour/playlist/abc",
                "cardBaseUrl": "https://bridge.local:47810",
                "games": [{"id": "570", "name": "Dota 2"}],
            },
        }
        self.assertEqual(resolve_display_type(payload), "game.library-tour")
        self.assertEqual(title_for_display_type("game.library-tour"), ("Signal", "Library Tour"))

    def test_seconds_clamp(self):
        self.assertEqual(clamp_seconds_per_game(4), 5)
        self.assertEqual(clamp_seconds_per_game(60), 60)
        self.assertEqual(clamp_seconds_per_game(400), 300)
        self.assertEqual(clamp_seconds_per_game(None), 60)

    def test_steam_poster_candidates_include_library_capsule(self):
        urls = steam_poster_candidates("570")
        self.assertTrue(any("library_600x900" in url for url in urls))
        self.assertTrue(all("/570/" in url for url in urls))

    def test_normalize_keeps_image_url_without_poster_list(self):
        game = normalize_tour_game({
            "id": "CUSA1",
            "name": "Astro",
            "imageUrl": "https://example.com/a.png",
        })
        self.assertEqual(game["imageUrl"], "https://example.com/a.png")
        self.assertEqual(game["posterCandidates"][0], "https://example.com/a.png")

    def test_advance_loops_to_start(self):
        panel = GameLibraryTourPanel.__new__(GameLibraryTourPanel)
        panel.visible = True
        panel._games = [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}]
        panel._index = 1
        panel._seconds_per_game = 30
        panel._remaining = 1
        panel._loop = True
        panel._render_current = lambda: None
        panel._tick_job = None
        panel.root = type("R", (), {"after_cancel": lambda *a, **k: None})()
        panel._advance()
        self.assertEqual(panel._index, 0)
        self.assertEqual(panel._remaining, 30)

    def test_advance_stops_without_loop(self):
        panel = GameLibraryTourPanel.__new__(GameLibraryTourPanel)
        panel.visible = True
        panel._games = [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}]
        panel._index = 1
        panel._seconds_per_game = 30
        panel._remaining = 1
        panel._loop = False
        panel._render_current = lambda: (_ for _ in ()).throw(AssertionError("should not re-render"))
        panel._update_status_text = lambda: None
        panel._tick_job = None
        panel.root = type("R", (), {"after_cancel": lambda *a, **k: None})()
        panel._advance()
        self.assertEqual(panel._index, 1)
        self.assertEqual(panel._remaining, 0)

    def test_apply_playlist_replaces_seed_and_keeps_current(self):
        panel = GameLibraryTourPanel.__new__(GameLibraryTourPanel)
        panel.visible = True
        panel._fetch_token = 1
        panel._games = [{"id": "1", "name": "Seed"}]
        panel._index = 0
        panel._expected_count = 1
        panel._update_status_text = lambda: None
        panel._prefetch_neighbors = lambda: None
        panel._render_current = lambda: (_ for _ in ()).throw(AssertionError("seed already showing"))
        panel._apply_playlist(1, [
            {"id": "1", "name": "One"},
            {"id": "2", "name": "Two"},
            {"id": "3", "name": "Three"},
        ])
        self.assertEqual(len(panel._games), 3)
        self.assertEqual(panel._index, 0)
        self.assertEqual(panel._expected_count, 3)

    def test_fetch_library_card_parses_steam(self):
        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"ok":true,"platform":"steam","steam":{"name":"Dota 2","mode":"library-tour"}}'

        with patch("urllib.request.urlopen", return_value=FakeResp()):
            card = fetch_library_card("https://bridge.local:47810", "steam", "570")
        self.assertEqual(card["name"], "Dota 2")
        self.assertEqual(card["mode"], "library-tour")

    def test_fetch_library_playlist_parses_games(self):
        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"ok":true,"games":[{"id":"1","name":"A"},{"id":"2","name":"B"}]}'

        with patch("urllib.request.urlopen", return_value=FakeResp()):
            games = fetch_library_playlist(
                "https://bridge.local:47810",
                "/api/library-tour/playlist/abc",
            )
        self.assertEqual(len(games), 2)
        self.assertEqual(games[0]["name"], "A")


if __name__ == "__main__":
    unittest.main()
