"""YouTube Now Playing — layout, number formatting, and every §4.5 state."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from unittest.mock import MagicMock

from src.config import effective_display_seconds
from src.payload_utils import (
    is_command_payload,
    is_display_payload,
    title_for_display_type,
)
from src.youtube_now_playing_panel import (
    THUMBNAIL_ASPECT,
    YoutubeNowPlayingPanel,
    abbreviate_count,
    format_position,
    format_upload_date,
    last_played_watched_seconds,
    live_position_seconds,
)


def make_payload(**overrides):
    base = {
        "videoId": "dQw4w9WgXcQ",
        "mode": "playing",
        "title": "How the Voyager Probes Still Phone Home After 47 Years",
        "description": "A look at the Deep Space Network and the engineering "
                       "that keeps a 1977 spacecraft in contact.",
        "descriptionLines": 3,
        "channelTitle": "Veritasium",
        "subscriberCount": 16_832_904,
        "viewCount": 4_218_774,
        "likeCount": 312_401,
        "dislikeCount": 1_204,
        "dislikeEstimated": True,
        "publishedAt": "2024-03-12T14:00:00Z",
        "durationSeconds": 1711,
        "live": False,
        "liveBroadcastContent": "none",
        "concurrentViewers": None,
        "metadataMissing": False,
        "thumbnailUrl": "http://bridge/youtube-images/abc.jpg",
        "avatarUrl": "http://bridge/youtube-images/def.jpg",
        "deviceLabel": "Living Room Apple TV",
        "positionSeconds": 724,
        "watchedSeconds": None,
        "completed": None,
        "startedAt": "2026-08-02T20:30:00Z",
        "endedAt": None,
    }
    base.update(overrides)
    return base


class FakeFont:
    """Proportional-width stand-in so text fitting can be exercised headlessly."""

    def __init__(self, size=24, weight="normal"):
        self.size = int(size)
        self.weight = weight

    def measure(self, text):
        return int(len(str(text)) * self.size * 0.55)

    def metrics(self, _key="linespace"):
        return int(self.size * 1.25)

    def cget(self, key):
        return self.size if key == "size" else "Segoe UI"

    def configure(self, **kwargs):
        if "size" in kwargs:
            self.size = int(kwargs["size"])
        if "weight" in kwargs:
            self.weight = kwargs["weight"]

    def copy(self):
        return FakeFont(self.size, self.weight)


def make_panel(config=None):
    """A panel with every Tk touchpoint mocked, but real geometry and text maths."""
    root = MagicMock()
    shell = MagicMock()
    shell.chip_label_font = FakeFont(20)
    shell.chip_value_font = FakeFont(26)
    shell.body_font = FakeFont(24)
    shell.section_label_font = FakeFont(22)
    panel = YoutubeNowPlayingPanel(root, shell, config or {
        "textColor": "#f8fafc", "mutedTextColor": "#94a3b8",
    })
    panel.canvas = MagicMock()
    panel.canvas.create_text = MagicMock(return_value=1)
    panel.canvas.create_line = MagicMock(return_value=2)
    panel.canvas.create_image = MagicMock(return_value=3)
    panel.canvas.create_rectangle = MagicMock(return_value=4)
    panel.canvas.create_oval = MagicMock(return_value=5)
    panel._item_ids = []
    return panel


def drawn_text(panel):
    return [
        call.kwargs["text"]
        for call in panel.canvas.create_text.call_args_list
        if "text" in call.kwargs
    ]


class RegistrationTests(unittest.TestCase):
    def test_payload_types_are_registered(self):
        self.assertTrue(is_display_payload({"type": "youtube.now-playing"}))
        self.assertTrue(is_command_payload({"type": "youtube.now-playing.close"}))
        self.assertEqual(
            title_for_display_type("youtube.now-playing"),
            ("YouTube", "Now Playing"),
        )

    def test_a_live_session_is_persistent_and_a_preview_is_timed(self):
        cfg = {"maxDisplaySeconds": 120, "defaultDisplaySeconds": 30}
        self.assertEqual(
            effective_display_seconds(
                {"type": "youtube.now-playing", "persistent": True, "displaySeconds": 0}, cfg,
            ),
            0,
        )
        self.assertEqual(
            effective_display_seconds(
                {"type": "youtube.now-playing", "persistent": False, "displaySeconds": 60}, cfg,
            ),
            60,
        )


class NumberFormattingTests(unittest.TestCase):
    def test_counts_abbreviate_only_above_ten_thousand(self):
        self.assertEqual(abbreviate_count(0), "0")
        self.assertEqual(abbreviate_count(947), "947")
        self.assertEqual(abbreviate_count(9_481), "9,481")
        self.assertEqual(abbreviate_count(10_000), "10K")
        self.assertEqual(abbreviate_count(312_401), "312K")
        self.assertEqual(abbreviate_count(4_218_774), "4.2M")
        self.assertEqual(abbreviate_count(16_832_904), "16.8M")
        self.assertEqual(abbreviate_count(2_400_000_000), "2.4B")

    def test_a_missing_count_is_none_not_zero(self):
        # The difference matters: 0 subs is a real value, absent is not.
        self.assertIsNone(abbreviate_count(None))
        self.assertIsNone(abbreviate_count("many"))
        self.assertIsNone(abbreviate_count(-5))

    def test_positions_gain_an_hour_field_only_when_needed(self):
        self.assertEqual(format_position(0), "0:00")
        self.assertEqual(format_position(64), "1:04")
        self.assertEqual(format_position(724), "12:04")
        self.assertEqual(format_position(3724), "1:02:04")

    def test_upload_dates_render_without_a_leading_zero(self):
        self.assertEqual(format_upload_date("2024-03-05T14:00:00Z"), "5 Mar 2024")
        self.assertIsNone(format_upload_date(None))
        self.assertIsNone(format_upload_date("not a date"))


class GeometryTests(unittest.TestCase):
    def test_the_portrait_hero_is_exactly_sixteen_by_nine(self):
        panel = make_panel()
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        x0, y0, x1, y1 = boxes["hero"]
        self.assertAlmostEqual((x1 - x0) / (y1 - y0), THUMBNAIL_ASPECT, places=2)

    def test_the_landscape_hero_is_also_sixteen_by_nine(self):
        panel = make_panel()
        boxes = panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0, has_desc=True)
        x0, y0, x1, y1 = boxes["hero"]
        self.assertAlmostEqual((x1 - x0) / (y1 - y0), THUMBNAIL_ASPECT, places=2)

    def test_bands_stack_without_overlapping_in_portrait(self):
        panel = make_panel()
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        order = ["header", "hero", "bar", "title", "channel", "desc", "stats", "upload", "device"]
        for above, below in zip(order, order[1:]):
            self.assertLessEqual(
                boxes[above][3], boxes[below][1] + 0.5,
                f"{above} overlaps {below}",
            )
        self.assertLessEqual(boxes["device"][3], 1880.5)

    def test_an_empty_description_closes_the_gap_rather_than_leaving_a_hole(self):
        panel = make_panel()
        with_desc = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        without = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=False)
        self.assertEqual(without["desc"][3], without["desc"][1])
        # The reclaimed height goes to the picture, not to whitespace.
        hero_with = with_desc["hero"][3] - with_desc["hero"][1]
        hero_without = without["hero"][3] - without["hero"][1]
        self.assertGreaterEqual(hero_without, hero_with)

    def test_portrait_spends_its_surplus_height_instead_of_pooling_it(self):
        panel = make_panel()
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        # Regression: the hero is width-capped and every other band is a fixed
        # ramp, which used to leave a ~600px void between desc and the stats.
        self.assertGreater(
            boxes["desc"][3] - boxes["desc"][1],
            YoutubeNowPlayingPanel.DESC_MIN_PORTRAIT,
        )
        for above, below in (("header", "hero"), ("bar", "title"),
                            ("title", "channel"), ("channel", "desc"),
                            ("desc", "stats")):
            gap = boxes[below][1] - boxes[above][3]
            self.assertLessEqual(
                gap, YoutubeNowPlayingPanel.GAP_MAX_PORTRAIT + 1,
                f"{above}→{below} gap of {gap:.0f}px is dead space",
            )
        # The position bar is the hero's scrubber and stays against it.
        self.assertLessEqual(boxes["bar"][1] - boxes["hero"][3], 12)

    def test_landscape_puts_the_hero_left_and_the_text_right(self):
        panel = make_panel()
        boxes = panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0, has_desc=True)
        self.assertLessEqual(boxes["hero"][2], boxes["title"][0])
        self.assertTrue(boxes["stats_inline"])
        self.assertFalse(
            panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0)["stats_inline"],
        )

    def test_a_short_screen_shrinks_the_picture_not_the_words(self):
        panel = make_panel()
        tall = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        short = panel._compute_portrait_boxes(40, 40, 1040, 1100, u=1.0, has_desc=True)
        self.assertLess(
            short["hero"][3] - short["hero"][1],
            tall["hero"][3] - tall["hero"][1],
        )
        self.assertAlmostEqual(
            short["title"][3] - short["title"][1],
            tall["title"][3] - tall["title"][1],
        )


class StatsRowTests(unittest.TestCase):
    def test_a_full_row_has_three_columns(self):
        panel = make_panel()
        columns = panel._stat_columns(make_payload())
        self.assertEqual([label for label, _ in columns], ["VIEWS", "LIKES", "DISLIKES est."])
        self.assertEqual(dict(columns)["VIEWS"], "4.2M")

    def test_it_collapses_to_two_columns_without_a_dislike_estimate(self):
        panel = make_panel()
        columns = panel._stat_columns(make_payload(dislikeCount=None))
        self.assertEqual([label for label, _ in columns], ["VIEWS", "LIKES"])

    def test_the_dislike_estimate_is_labelled_and_marked_approximate(self):
        panel = make_panel()
        columns = dict(panel._stat_columns(make_payload()))
        self.assertEqual(columns["DISLIKES est."], "~1,204")

    def test_missing_metadata_hides_the_row_entirely(self):
        panel = make_panel()
        columns = panel._stat_columns(make_payload(
            metadataMissing=True, viewCount=None, likeCount=None, dislikeCount=None,
        ))
        self.assertEqual(columns, [])

    def test_landscape_renders_one_inline_row_instead_of_tiles(self):
        panel = make_panel()
        boxes = panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0, has_desc=True)
        boxes["portrait"] = False
        panel._draw_stats(boxes, make_payload())
        texts = drawn_text(panel)
        self.assertEqual(len(texts), 1)
        self.assertIn("4.2M views", texts[0])
        self.assertIn("312K likes", texts[0])
        self.assertIn("dislikes", texts[0])
        # No wrapping width — that was what dropped "dislikes" onto Uploaded.
        kwargs = panel.canvas.create_text.call_args_list[-1].kwargs
        self.assertNotIn("width", kwargs)

    def test_portrait_renders_a_labelled_tile_per_stat(self):
        panel = make_panel()
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        boxes["portrait"] = True
        panel._draw_stats(boxes, make_payload())
        texts = drawn_text(panel)
        self.assertIn("VIEWS", texts)
        self.assertIn("LIKES", texts)
        self.assertIn("4.2M", texts)


class PositionBandTests(unittest.TestCase):
    def _band(self, payload, portrait=True):
        panel = make_panel()
        boxes = (
            panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
            if portrait
            else panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0, has_desc=True)
        )
        panel._draw_position(boxes, payload)
        return panel

    def test_playing_shows_a_progress_bar_and_a_position_counter(self):
        panel = self._band(make_payload())
        self.assertIsNotNone(panel._position_fill_id)
        self.assertIn("12:04 / 28:31", drawn_text(panel))

    def test_the_fill_is_proportional_to_the_position(self):
        panel = make_panel()
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        panel._draw_position(boxes, make_payload(positionSeconds=1711))
        track = panel._position_track
        # At the very end the fill spans the whole track.
        full = [
            call for call in panel.canvas.create_rectangle.call_args_list
            if call.kwargs.get("fill") == panel.ACCENT
        ]
        self.assertTrue(full)
        self.assertAlmostEqual(full[-1].args[2], track[2], delta=1)

    def test_last_played_replaces_the_bar_with_a_static_watched_line(self):
        panel = self._band(make_payload(
            mode="last-played", watchedSeconds=1450, completed=False, positionSeconds=None,
        ))
        self.assertIsNone(panel._position_fill_id)
        self.assertIn("Watched 24:10 of 28:31", drawn_text(panel))

    def test_last_played_uses_position_when_watched_seconds_are_zero(self):
        panel = self._band(make_payload(
            mode="last-played",
            watchedSeconds=0,
            positionSeconds=724,
            completed=False,
        ))
        self.assertIn("Watched 12:04 of 28:31", drawn_text(panel))
        self.assertNotIn("0:00", drawn_text(panel))

    def test_last_played_falls_back_to_session_span(self):
        seconds = last_played_watched_seconds({
            "watchedSeconds": 0,
            "positionSeconds": 0,
            "durationSeconds": 1711,
            "startedAt": "2026-08-02T20:00:00Z",
            "endedAt": "2026-08-02T20:12:04Z",
        })
        self.assertEqual(seconds, 724)
        self.assertEqual(format_position(seconds), "12:04")

    def test_a_finished_video_omits_the_watched_fraction(self):
        panel = self._band(make_payload(
            mode="last-played", watchedSeconds=1711, completed=True,
        ))
        self.assertIn("Watched to the end", drawn_text(panel))

    def test_a_live_stream_shows_viewers_instead_of_a_position(self):
        panel = self._band(make_payload(
            live=True, liveBroadcastContent="live",
            concurrentViewers=18_402, durationSeconds=0,
        ))
        self.assertIsNone(panel._position_fill_id)
        self.assertIn("18.4K watching now", drawn_text(panel))

    def test_live_position_advances_from_the_payload_snapshot(self):
        anchored = datetime(2026, 8, 2, 20, 30, 0, tzinfo=timezone.utc)
        self.assertEqual(
            live_position_seconds(251, 619, anchored_at=anchored, now=anchored),
            251,
        )
        self.assertEqual(
            live_position_seconds(
                251, 619,
                anchored_at=anchored,
                now=anchored + timedelta(seconds=3),
            ),
            254,
        )

    def test_live_position_stops_at_the_video_duration(self):
        anchored = datetime(2026, 8, 2, 20, 30, 0, tzinfo=timezone.utc)
        self.assertEqual(
            live_position_seconds(
                600, 619,
                anchored_at=anchored,
                now=anchored + timedelta(seconds=60),
            ),
            619,
        )

    def test_the_position_tick_rewrites_the_caption_and_fill(self):
        panel = make_panel()
        panel.visible = True
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        panel._yt = make_payload(positionSeconds=251, durationSeconds=619)
        panel._draw_position(boxes, panel._yt)
        panel._position_anchored_at = datetime(2026, 8, 2, 20, 30, 0, tzinfo=timezone.utc)
        panel._apply_live_position(
            now=datetime(2026, 8, 2, 20, 30, 5, tzinfo=timezone.utc),
        )
        panel.canvas.itemconfigure.assert_called()
        caption = panel.canvas.itemconfigure.call_args.kwargs.get("text")
        if caption is None and len(panel.canvas.itemconfigure.call_args) > 1:
            caption = panel.canvas.itemconfigure.call_args[1].get("text")
        self.assertEqual(caption, "4:16 / 10:19")
        panel.canvas.coords.assert_called()
        coords = panel.canvas.coords.call_args.args
        track = panel._position_track
        expected_fill = track[0] + (track[2] - track[0]) * (256 / 619)
        # coords(id, x0, y0, x1, y1) — the live fill ends at args[3].
        self.assertAlmostEqual(coords[3], expected_fill, delta=1)

    def test_last_played_does_not_schedule_a_position_tick(self):
        panel = make_panel()
        panel.visible = True
        panel._yt = make_payload(mode="last-played", watchedSeconds=100)
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_desc=True)
        panel._draw_position(boxes, panel._yt)
        panel._schedule_position_tick()
        self.assertIsNone(panel._position_tick_job)
        panel.root.after.assert_not_called()


class ChromeTests(unittest.TestCase):
    def _chrome(self, payload):
        panel = make_panel()
        panel._yt = payload
        panel._steam = payload
        panel._layout_boxes = panel._compute_portrait_boxes(
            40, 40, 1040, 1880, u=1.0, has_desc=True,
        )
        panel._draw_chrome(panel._layout_boxes)
        return panel

    def test_now_playing_badge(self):
        panel = self._chrome(make_payload())
        self.assertIn("NOW PLAYING", drawn_text(panel))
        self.assertIn("ELAPSED", drawn_text(panel))

    def test_last_played_badge_and_relative_stamp(self):
        panel = self._chrome(make_payload(mode="last-played"))
        texts = drawn_text(panel)
        self.assertIn("LAST PLAYED", texts)
        self.assertNotIn("NOW PLAYING", texts)
        self.assertIn("WHEN", texts)

    def test_a_live_stream_gets_its_own_badge(self):
        panel = self._chrome(make_payload(live=True, liveBroadcastContent="live"))
        texts = drawn_text(panel)
        self.assertIn("LIVE", texts)
        self.assertNotIn("NOW PLAYING", texts)


class MetaTests(unittest.TestCase):
    def _meta(self, payload, portrait=True):
        panel = make_panel()
        panel.canvas.create_window = MagicMock(return_value=9)
        boxes = (
            panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0,
                                          has_desc=bool(payload.get("description")))
            if portrait
            else panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0,
                                                has_desc=bool(payload.get("description")))
        )
        boxes["portrait"] = portrait
        panel._layout_boxes = boxes
        with mock.patch("src.text_marquee.tk.Canvas") as title_canvas, \
             mock.patch("src.steam_now_playing_panel.tk.Canvas") as desc_canvas:
            title_canvas.return_value.bbox.return_value = (0, 0, 40, 40)
            desc_canvas.return_value.bbox.return_value = (0, 0, 400, 400)
            panel._draw_meta(boxes, payload)
        return panel

    def test_the_channel_row_shows_an_abbreviated_subscriber_count(self):
        panel = self._meta(make_payload())
        texts = drawn_text(panel)
        self.assertIn("Veritasium", texts)
        self.assertIn("16.8M subs", texts)

    def test_a_hidden_subscriber_count_is_omitted_not_shown_as_zero(self):
        panel = self._meta(make_payload(subscriberCount=None))
        texts = drawn_text(panel)
        self.assertIn("Veritasium", texts)
        self.assertFalse([t for t in texts if "subs" in str(t)])

    def test_a_very_long_title_is_placed_as_a_marquee_not_ellipsised(self):
        panel = self._meta(make_payload(title="Voyager " * 60))
        # Title lives in a nested viewport — never painted (and truncated) on
        # the main canvas the way the old two-line fit did.
        title_on_canvas = [
            call for call in panel.canvas.create_text.call_args_list
            if "Voyager" in str(call.kwargs.get("text", ""))
        ]
        self.assertEqual(title_on_canvas, [])
        self.assertTrue(panel._marquees)
        panel.canvas.create_window.assert_called()

    def test_a_long_description_uses_the_scrolling_viewport(self):
        panel = self._meta(make_payload(description="A long pitch. " * 40))
        self.assertIsNotNone(panel.scroller)
        panel.canvas.create_window.assert_called()

    def test_a_description_taller_than_its_band_is_marked_for_scrolling(self):
        panel = make_panel()
        panel.canvas.create_window = MagicMock(return_value=9)
        # The height has to be stated outright: a headless canvas reports the
        # same bbox for any string, so measuring the real portrait band would
        # only be asserting how tall that band happens to be.
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 1000, 400)
            panel._place_description_viewport(
                "A long pitch. " * 40, 40, 100, 1040, 120,
            )
        self.assertTrue(panel.needs_scroll)
        self.assertTrue(panel.scroller.needs_scroll)

    def test_an_absent_description_draws_nothing_in_its_band(self):
        panel = self._meta(make_payload(description=""))
        texts = [str(t) for t in drawn_text(panel)]
        self.assertIn("Veritasium", texts)
        self.assertIsNone(panel.scroller)

    def test_landscape_keeps_the_description_above_the_stats(self):
        panel = make_panel()
        boxes = panel._compute_landscape_boxes(60, 40, 1860, 1040, u=1.0, has_desc=True)
        self.assertLessEqual(boxes["desc"][3], boxes["stats"][1] + 0.5)
        self.assertLessEqual(boxes["stats"][3], boxes["upload"][1] + 0.5)

    def test_the_device_label_is_drawn_quietly_at_the_bottom(self):
        panel = self._meta(make_payload())
        self.assertIn("Living Room Apple TV", drawn_text(panel))

    def test_the_upload_date_is_rendered_when_known(self):
        panel = self._meta(make_payload())
        self.assertIn("Uploaded 12 Mar 2024", drawn_text(panel))

    def test_a_private_video_still_renders_with_its_lounge_title(self):
        panel = self._meta(make_payload(
            metadataMissing=True, description="", publishedAt=None,
            subscriberCount=None, channelTitle="", title="Untitled",
        ))
        # Title is a marquee viewport now, not a create_text on the main canvas.
        self.assertTrue(panel._marquees)
        panel.canvas.create_window.assert_called()

    def test_landscape_uses_the_smaller_type_ramp(self):
        portrait = make_panel()
        landscape = make_panel()
        self.assertGreater(
            portrait.TITLE_SIZE_PORTRAIT, landscape.TITLE_SIZE_LANDSCAPE,
        )
        self.assertGreater(
            portrait.STAT_VALUE_PORTRAIT, landscape.STAT_VALUE_LANDSCAPE,
        )


class ImageTests(unittest.TestCase):
    def test_the_thumbnail_and_avatar_are_fetched_from_the_bridge_not_youtube(self):
        panel = make_panel()
        payload = make_payload()
        panel._layout_boxes = panel._compute_portrait_boxes(
            40, 40, 1040, 1880, u=1.0, has_desc=True,
        )
        panel._avatar_id = 99
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=False):
                started.append(args)

            def start(self):
                pass

        import src.youtube_now_playing_panel as module

        original = module.threading.Thread
        module.threading.Thread = FakeThread
        try:
            panel._start_image_fetches(payload)
        finally:
            module.threading.Thread = original

        urls = [args[1][0] for args in started]
        self.assertEqual(urls, [payload["thumbnailUrl"], payload["avatarUrl"]])
        self.assertTrue(all("ytimg.com" not in url for url in urls))

    def test_nothing_is_fetched_when_there_is_no_thumbnail(self):
        panel = make_panel()
        panel._layout_boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0)
        panel._avatar_id = None
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=False):
                started.append(args)

            def start(self):
                pass

        import src.youtube_now_playing_panel as module

        original = module.threading.Thread
        module.threading.Thread = FakeThread
        try:
            panel._start_image_fetches(make_payload(thumbnailUrl=None, avatarUrl=None))
        finally:
            module.threading.Thread = original
        self.assertEqual(started, [])


if __name__ == "__main__":
    unittest.main()
