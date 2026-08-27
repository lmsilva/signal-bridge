"""Render smoke tests for the Autodarts + Roll Credits dashboards.

The layout helpers are unit-tested on their own, but nothing used to paint
these pages in CI — so a card could still be drawn with text hanging outside
its frame (exactly the portrait bug reported from the wall). These tests run
the real draw code against a recording canvas and assert every glyph lands
inside the card it belongs to.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.autodarts_panel import (
    AutodartsPanel,
    layout_dashboard,
    layout_match,
    should_show_turn_strip,
)
from src.design_system import PX_PER_POINT, page_chrome, text_line_h
from src.flightplan_panel import FlightPlanPanel, layout_flightplan
from src.huupe_panel import (
    HuupePanel,
    layout_huupe_dashboard,
    layout_huupe_session,
)
from src.roll_credits_panel import RollCreditsPanel, choose_showcase_shots, layout_boxes

SCREENS = ((1080, 1920), (1200, 1920), (900, 1600), (1920, 1080))


class RecordingCanvas:
    """Just enough Tk canvas to capture what a panel painted, and where."""

    def __init__(self):
        self.items = {}
        self._next = 1

    def _add(self, kind, coords, kwargs):
        item = self._next
        self._next += 1
        self.items[item] = {"kind": kind, "coords": tuple(coords), "kwargs": dict(kwargs)}
        return item

    def create_text(self, *coords, **kwargs):
        return self._add("text", coords, kwargs)

    def create_rectangle(self, *coords, **kwargs):
        return self._add("rect", coords, kwargs)

    def create_line(self, *coords, **kwargs):
        return self._add("line", coords, kwargs)

    def create_oval(self, *coords, **kwargs):
        return self._add("oval", coords, kwargs)

    def create_polygon(self, *coords, **kwargs):
        return self._add("polygon", coords, kwargs)

    def create_image(self, *coords, **kwargs):
        return self._add("image", coords, kwargs)

    def create_window(self, *coords, **kwargs):
        return self._add("window", coords, kwargs)

    def delete(self, item):
        self.items.pop(item, None)

    def type(self, item):
        return self.items.get(item, {}).get("kind")

    def itemcget(self, item, key):
        return self.items.get(item, {}).get("kwargs", {}).get(key, "")

    def itemconfigure(self, item, **kwargs):
        if item in self.items:
            self.items[item]["kwargs"].update(kwargs)

    def coords(self, item, *values):
        if values:
            self.items[item]["coords"] = tuple(values)
        return list(self.items.get(item, {}).get("coords", ()))

    def bbox(self, item):
        coords = self.items.get(item, {}).get("coords", (0, 0))
        return (coords[0], coords[1], coords[0], coords[1])

    def tag_raise(self, *_args, **_kwargs):
        return None

    def tag_lower(self, *_args, **_kwargs):
        return None

    def configure(self, **_kwargs):
        return None

    def texts(self):
        return [item for item in self.items.values() if item["kind"] == "text"]


def make_panel(cls, screen):
    root = MagicMock()
    root.winfo_screenwidth.return_value = screen[0]
    root.winfo_screenheight.return_value = screen[1]
    root.after.return_value = "job"
    shell = MagicMock()
    shell.screen_w, shell.screen_h = screen
    shell.overlay = MagicMock(screen_w=screen[0], screen_h=screen[1])
    canvas = RecordingCanvas()
    shell.content_canvas = canvas
    panel = cls(root, shell, {})
    panel.canvas = canvas
    panel.visible = True
    return panel, canvas


def anchor_of(item):
    """Tk compass anchor, with `center`/unset normalised away."""
    anchor = str(item["kwargs"].get("anchor") or "").strip().lower()
    return "" if anchor in ("", "center") else anchor


def text_span(item, px_per_pt=PX_PER_POINT):
    """(top, bottom) of a painted string, honouring its anchor."""
    y = item["coords"][1]
    font = item["kwargs"].get("font") or ("Segoe UI", 12)
    size = font[1] if len(font) > 1 else 12
    lines = str(item["kwargs"].get("text") or "").count("\n") + 1
    height = text_line_h(size, u=1.0, px_per_pt=px_per_pt) * lines
    anchor = anchor_of(item)
    if anchor.startswith("n"):
        return y, y + height
    if anchor.startswith("s"):
        return y - height, y
    return y - height / 2, y + height / 2


def text_columns(item):
    """(left, right) of a painted string — glyph width estimated conservatively."""
    x = item["coords"][0]
    font = item["kwargs"].get("font") or ("Segoe UI", 12)
    size = font[1] if len(font) > 1 else 12
    longest = max(
        (len(line) for line in str(item["kwargs"].get("text") or "").split("\n")), default=0,
    )
    width = longest * size * 0.72  # matches the panels' no-Tk width estimate
    anchor = anchor_of(item)
    if anchor.endswith("w"):
        return x, x + width
    if anchor.endswith("e"):
        return x - width, x
    return x - width / 2, x + width / 2


def sample_dashboard():
    return {
        "type": "autodarts.dashboard",
        "displaySeconds": 120,
        "totals": {"matches": 42, "legs": 57, "thisMonth": 1, "lastPlayedLabel": "Aug 02"},
        "board": {
            "name": "Movie Theater Board", "online": True, "statusLabel": "Error",
            "version": "1.0.7", "updateLabel": "Up to date", "os": "Linux",
            "dartsThrown": 3371, "corrections": 53, "accuracy": 98.43,
        },
        "leaderboard": [
            {"rank": index + 1, "crown": index == 0, "name": name, "wins": 11 - index,
             "losses": 4, "winPct": 73, "x01Average": 24.3, "bestCheckout": 47,
             "oneEighties": 0, "matches": 15}
            for index, name in enumerate(
                ["war d", "trashpanda", "tommy", "Bot Level 2", "kylie", "emsss",
                 "lundisupcorp", "guest", "ana", "ben", "cleo", "dax"]
            )
        ],
        "moreCount": 5,
        "byMonth": [{"key": f"2026-{m:02d}", "label": "Jan", "count": m} for m in range(1, 13)],
        "rivalry": {"a": "trashpanda", "b": "war d", "aWins": 4, "bWins": 11,
                    "lastWinner": "trashpanda", "lastPlayedAt": "2026-08-02T00:00:00Z"},
        "records": {
            "bestMatchAverage": {"value": 36.3, "player": "trashpanda"},
            "highestCheckout": {"value": 48, "player": "war d"},
            "total180s": 2,
        },
    }


def sample_match(*, finished=False, players=2):
    names = ["war d", "trashpanda", "kylie", "tommy"][:players]
    return {
        "type": "autodarts.match",
        "match": {
            "status": "finished" if finished else "live",
            "settingsLine": "X01 501 · Best of 5",
            "durationSec": 742,
            "currentPlayerIndex": 0,
            "gameShot": "D20" if finished else None,
            "players": [
                {"name": name, "score": 141 + index * 40, "legs": 3 - index,
                 "average": 24.8 - index, "lastTurnPoints": 60 - index * 5,
                 "isWinner": finished and index == 0}
                for index, name in enumerate(names)
            ],
            "turn": {"points": 60, "darts": [{"seg": "T20"}, {"seg": "S5"}, {"seg": "S1"}]},
        },
    }


def sample_tour():
    return {
        "type": "roll-credits.tour",
        "secondsPerGame": 15,
        "dashboardSeconds": 25,
        "loop": True,
        "count": 29,
        "stats": {
            "total": 29, "thisYear": 8, "systemsCount": 6,
            "latestMilestone": 25,
            "bestMonth": {"label": "Aug 2026", "count": 3},
            "topBeatenWith": {"name": "War D", "count": 26},
            "undatedCount": 21,
            "latest": {
                "title": "Split/Second", "systemLabel": "Xbox 360", "induction": 29,
                "beatenWith": "War D, Tommy", "beatenAt": None,
            },
            "months": [{"key": f"2026-{m:02d}", "label": "Jan", "count": m % 4}
                       for m in range(1, 13)],
            "bySystem": [{"id": s, "label": s, "count": c} for s, c in
                         (("Arcade", 18), ("PC", 4), ("Dreamcast", 3), ("Xbox 360", 2),
                          ("Saturn", 1))],
            "beatenWith": [{"name": "War D", "count": 26}, {"name": "War D, Tommy", "count": 2},
                           {"name": "Tommy", "count": 1}],
        },
    }


def sample_flightplan(*, legs=2, live=False):
    def leg(number, origin, destination, depart, arrive, state, board, token):
        return {
            "id": f"f-{number}",
            "airline": "DL",
            "number": number,
            "date": depart[:10],
            "origin": origin,
            "destination": destination,
            "scheduled": {"departure": depart, "arrival": arrive},
            "state": state,
            "status": {"displayLine": "ON TIME · GATE B14", "boardCode": board,
                       "colorToken": token},
            "durationMinutes": 620,
            "departsInMinutes": 4200,
        }

    sea = {"iata": "SEA", "city": "Seattle", "lat": 47.45, "lon": -122.31}
    hnd = {"iata": "HND", "city": "Tokyo", "lat": 35.55, "lon": 139.78}
    icn = {"iata": "ICN", "city": "Seoul", "lat": 37.46, "lon": 126.44}
    flights = [
        leg("167", sea, hnd, "2027-06-24T13:45:00-07:00", "2027-06-25T16:00:00+09:00",
            "active" if live else "upcoming", "ON", "good"),
        leg("173", hnd, icn, "2027-07-08T17:55:00+09:00", "2027-07-08T20:35:00+09:00",
            "upcoming", "+25", "warn"),
        leg("9", icn, sea, "2027-07-10T11:20:00+09:00", "2027-07-10T06:05:00-07:00",
            "upcoming", "ON", "good"),
    ][:legs]
    return {
        "type": "flightplan.flight",
        "mode": "board" if legs > 1 else "next",
        "displaySeconds": 120,
        "asOf": "2026-08-26T18:00:00Z",
        "trip": {"id": "t1", "name": "Japan 2027", "kind": "ours",
                 "title": "in flight" if live else "upcoming flight"},
        "flight": {
            **flights[0],
            "latest": {
                "departure": {"gate": "B14", "terminal": "S",
                              "revisedTime": {"local": "2027-06-24T14:10:00-07:00"}},
                "arrival": {"baggageBelt": "7"},
            },
            "registration": "N801DZ",
        },
        "flights": flights,
        "status": {"displayLine": "ON TIME · GATE B14", "boardCode": "ON",
                   "colorToken": "good"},
        "progress": {
            "phase": "airborne" if live else "upcoming",
            "fraction": 0.42 if live else 0.0,
            "durationMinutes": 620,
            "departsInMinutes": -30 if live else 4200,
            "remainingMinutes": 360 if live else 0,
        },
        "stage": {
            "mode": "live" if live else "preflight",
            "note": "in the air · position live" if live else "not departed",
            "position": {"lat": 52.1, "lon": -170.4, "heading": 285} if live else None,
            "route": {"origin": sea, "destination": hnd},
        },
    }


def huupe_zones(scale=1):
    rows = [
        ("layup", "Layup", "At the rim", "0.1 PT", 6, 7, 85, 0.6),
        ("one", "Short Range", "Low post", "1 PT", 4, 11, 36, 4.0),
        ("two", "Mid Range", "High post", "2 PT", 3, 9, 33, 6.0),
        ("three", "Deep Range", "Top of the key", "3 PT", 2, 12, 17, 6.0),
    ]
    return [
        {"zone": zone, "label": label, "note": note, "pointsLabel": points,
         "made": made * scale, "attempts": attempts * scale, "pct": pct,
         "scored": scored * scale, "points": {"layup": 0.1, "one": 1, "two": 2, "three": 3}[zone]}
        for zone, label, note, points, made, attempts, pct, scored in rows
    ]


def sample_huupe_session(*, finished=False, players=0):
    names = ["trashpanda", "war d", "lundisupcorp", "Bot Level 2"][:players]
    return {
        "type": "huupe.session",
        "displaySeconds": 60 if finished else 0,
        "persistent": not finished,
        "session": {
            "sessionId": "s-1",
            "mode": "family" if players else "justhuupe",
            "modeLabel": "Family Mode" if players else "Free Play",
            "status": "finished" if finished else "live",
            "revision": 12,
            "durationSec": 742,
            "durationLabel": "12:22",
            "headline": {
                "primary": names[0] if (finished and names) else "17.1",
                "secondary": "wins by 4.2" if finished else "15/39 · 38%",
            },
            "players": [
                {
                    "rank": index + 1, "name": name, "score": 17.1 - index * 4.2,
                    "scoreLabel": f"{17.1 - index * 4.2:.1f}", "made": 9, "attempts": 21,
                    "fgPct": 43, "bestStreak": 4, "threes": 2,
                    "isWinner": finished and index == 0,
                    "zones": huupe_zones(),
                }
                for index, name in enumerate(names)
            ],
            "stats": {
                "points": 17.1, "pointsLabel": "17.1", "made": 15, "attempts": 39,
                "shotLine": "15/39", "fgPct": 38, "streak": 3, "bestStreak": 6,
            },
            "zones": huupe_zones(),
            "lastShot": {
                "player": names[0] if names else None, "made": True,
                "zone": "three", "zoneLabel": "Deep Range", "points": 3, "pointsLabel": "3",
            },
            "recentShots": [
                {"made": index % 3 != 0, "zone": zone, "short": short}
                for index, (zone, short) in enumerate(
                    [("three", "3PT"), ("layup", "LAY"), ("two", "2PT"), ("one", "1PT")] * 5
                )
            ],
            "winner": names[0] if (finished and names) else None,
            "sensorErrors": 0,
        },
    }


def sample_huupe_dashboard():
    return {
        "type": "huupe.dashboard",
        "displaySeconds": 120,
        "totals": {
            "sessions": 48, "games": 31, "freePlaySessions": 17, "shots": 3371,
            "makes": 1482, "fgPct": 44, "points": 902.4, "pointsLabel": "902.4",
            "playLabel": "14h 07m", "lastPlayedLabel": "Yesterday",
        },
        "leaderboard": [
            {
                "rank": index + 1, "crown": index == 0, "name": name,
                "games": 15 - index, "wins": 11 - index, "winPct": 73,
                "points": 210.5, "pointsLabel": "210.5", "bestScore": 21.1,
                "made": 140, "attempts": 320, "fgPct": 64 - index,
                "threes": 12, "bestStreak": 9, "lastPlayedLabel": "Yesterday",
            }
            for index, name in enumerate(
                ["trashpanda", "war d", "lundisupcorp", "Bot Level 2", "kylie",
                 "emsss", "tommy", "guest", "ana", "ben", "cleo", "dax"]
            )
        ],
        "moreCount": 5,
        "zones": huupe_zones(scale=40),
        "records": {
            "bestSessionScore": {"value": 34.2, "mode": "family",
                                 "modeLabel": "Family Mode", "valueLabel": "34.2"},
            "bestStreak": {"value": 11, "player": "trashpanda"},
            "bestFgPct": {"player": "lundisupcorp", "value": 64},
        },
        "device": {"name": "Huupe Mini", "online": True},
        "recent": [
            {"sessionId": f"s-{index}", "mode": "family" if index % 2 else "justhuupe",
             "modeLabel": "Family Mode" if index % 2 else "Free Play",
             "winner": "trashpanda" if index % 2 else None,
             "points": 26.1, "pointsLabel": "26.1", "made": 12, "attempts": 30,
             "whenLabel": "Yesterday"}
            for index in range(6)
        ],
    }


class DashboardRenderTests(unittest.TestCase):
    def assert_text_inside_cards(self, canvas, boxes, *, screen, label):
        chrome = page_chrome(*screen, timed=True)
        cards = [box for box in boxes.values() if isinstance(box, tuple) and len(box) == 4]
        painted = []
        for item in canvas.texts():
            top, bottom = text_span(item)
            left, right = text_columns(item)
            x = item["coords"][0]
            if bottom <= chrome.content_top + 2:
                continue  # page header sits above the cards
            inside = [
                box for box in cards
                if box[0] - 2 <= x <= box[2] + 2 and top >= box[1] - 2 and bottom <= box[3] + 2
            ]
            self.assertTrue(inside, (
                f"{label} {screen}: '{item['kwargs'].get('text')}' "
                f"paints at y {top:.0f}-{bottom:.0f}, outside every card"
            ))
            painted.append((inside[0], top, bottom, left, right, item))
        for index, (card, top, bottom, left, right, item) in enumerate(painted):
            for other_card, o_top, o_bottom, o_left, o_right, other in painted[index + 1:]:
                if other_card is not card:
                    continue
                if top >= o_bottom - 1 or bottom <= o_top + 1:
                    continue
                if left >= o_right - 1 or right <= o_left + 1:
                    continue
                self.fail(
                    f"{label} {screen}: '{item['kwargs'].get('text')}' overlaps "
                    f"'{other['kwargs'].get('text')}' inside the same card"
                )

    def test_autodarts_dashboard_keeps_every_string_inside_its_card(self):
        for screen in SCREENS:
            panel, canvas = make_panel(AutodartsPanel, screen)
            panel._render_dashboard(sample_dashboard())
            self.assertGreater(len(canvas.texts()), 20, f"nothing painted for {screen}")
            self.assert_text_inside_cards(
                canvas, layout_dashboard(*screen, timed=True),
                screen=screen, label="autodarts",
            )

    def test_flightplan_keeps_every_string_inside_its_card(self):
        """The wall showed the flight number painted over its own route line."""
        for live in (False, True):
            for legs in (1, 3):
                for screen in SCREENS:
                    panel, canvas = make_panel(FlightPlanPanel, screen)
                    payload = sample_flightplan(legs=legs, live=live)
                    panel._render(payload)
                    self.assertGreater(
                        len(canvas.texts()), 12, f"nothing painted for {screen}",
                    )
                    self.assert_text_inside_cards(
                        canvas,
                        layout_flightplan(*screen, timed=True, legs=legs),
                        screen=screen,
                        label=f"flightplan legs={legs} live={live}",
                    )

    def test_autodarts_match_keeps_every_string_inside_its_card(self):
        """Score cards size their headline from the card, so a wall-sized number
        must still clear the name, legs and averages around it."""
        for finished in (False, True):
            for players in (2, 4):
                for screen in SCREENS:
                    panel, canvas = make_panel(AutodartsPanel, screen)
                    payload = sample_match(finished=finished, players=players)
                    panel._render_match(payload)
                    self.assertGreater(len(canvas.texts()), 6, f"nothing painted for {screen}")
                    boxes = layout_match(
                        *screen, timed=finished, player_count=players, finished=finished,
                        show_strip=should_show_turn_strip(
                            payload["match"], finished=finished,
                        ),
                    )
                    cards = {
                        key: box for key, box in boxes.items()
                        if isinstance(box, tuple) and len(box) == 4
                    }
                    # Each player owns a slice of the score band — check those,
                    # not the band, so a spilling column cannot hide next door.
                    for key in ("scores", "scores_left", "scores_right"):
                        box = cards.pop(key, None)
                        if not box:
                            continue
                        count = players if key == "scores" else max(1, players // 2)
                        if key == "scores":
                            width = (box[2] - box[0]) / count
                            for index in range(count):
                                cards[f"{key}{index}"] = (
                                    box[0] + width * index, box[1],
                                    box[0] + width * (index + 1), box[3],
                                )
                        else:
                            height = (box[3] - box[1]) / count
                            for index in range(count):
                                cards[f"{key}{index}"] = (
                                    box[0], box[1] + height * index,
                                    box[2], box[1] + height * (index + 1),
                                )
                    self.assert_text_inside_cards(
                        canvas, cards, screen=screen,
                        label=f"autodarts match ({players}p{' final' if finished else ''})",
                    )

    def test_huupe_session_keeps_every_string_inside_its_card(self):
        """Family Mode paints a scoreboard and free play paints stat tiles, so
        both shapes have to clear the shooting card underneath them."""
        for finished in (False, True):
            for players in (0, 2, 4):
                for screen in SCREENS:
                    panel, canvas = make_panel(HuupePanel, screen)
                    payload = sample_huupe_session(finished=finished, players=players)
                    panel._render_session(payload)
                    self.assertGreater(len(canvas.texts()), 8, f"nothing painted for {screen}")
                    self.assert_text_inside_cards(
                        canvas,
                        layout_huupe_session(
                            *screen, timed=finished, finished=finished, players=players,
                        ),
                        screen=screen,
                        label=f"huupe session ({players}p{' final' if finished else ''})",
                    )

    def test_huupe_dashboard_keeps_every_string_inside_its_card(self):
        # A hoop nobody has played in Family Mode has an empty leaderboard and
        # no recent list, which reflows the page — cover both shapes.
        for recent in (True, False):
            for screen in SCREENS:
                panel, canvas = make_panel(HuupePanel, screen)
                payload = sample_huupe_dashboard()
                if not recent:
                    payload["recent"] = []
                    payload["leaderboard"] = []
                    payload["moreCount"] = 0
                panel._render_dashboard(payload)
                self.assertGreater(len(canvas.texts()), 18, f"nothing painted for {screen}")
                self.assert_text_inside_cards(
                    canvas, layout_huupe_dashboard(*screen, timed=True, recent=recent),
                    screen=screen, label=f"huupe dashboard (recent={recent})",
                )

    def test_roll_credits_dashboard_keeps_every_string_inside_its_card(self):
        for screen in SCREENS:
            panel, canvas = make_panel(RollCreditsPanel, screen)
            panel._tour = sample_tour()
            panel._games = []
            panel._draw_dashboard()
            self.assertGreater(len(canvas.texts()), 15, f"nothing painted for {screen}")
            boxes = layout_boxes(*screen, dashboard=True, timed=False)
            self.assert_text_inside_cards(
                canvas, boxes, screen=screen, label="roll credits",
            )

    def test_roll_credits_showcase_keeps_every_string_inside_its_card(self):
        card = {
            "title": "Split/Second Velocity Ultimate Edition",
            "systemLabel": "Xbox 360", "induction": 29, "beatenAt": "2026-08-23",
            "beatenWith": "War D, Tommy",
            "description": "A racing game where the track itself is the weapon. " * 6,
            "maxPlayers": 2, "difficulty": "Hard", "releaseDate": "2010-05-18",
            "developer": "Black Rock Studio", "publisher": "Disney Interactive",
            "genres": ["Racing", "Action"],
        }
        shots = dict(card, screenshots=[f"http://x/{n}.jpg" for n in range(3)])
        # Missing screenshots reflow the whole page, so cover both shapes.
        for variant in (card, shots):
            for screen in SCREENS:
                panel, canvas = make_panel(RollCreditsPanel, screen)
                panel._tour = sample_tour()
                panel._games = [{"id": "g1"}]
                panel._index = 0
                panel._draw_showcase(variant)
                self.assertGreater(len(canvas.texts()), 3, f"nothing painted for {screen}")
                boxes = layout_boxes(
                    *screen, dashboard=False, timed=False,
                    shots=bool(choose_showcase_shots(variant)),
                )
                self.assert_text_inside_cards(
                    canvas, boxes, screen=screen, label="roll credits showcase",
                )


if __name__ == "__main__":
    unittest.main()
