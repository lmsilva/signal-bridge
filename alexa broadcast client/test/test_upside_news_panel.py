"""Upside News panel — phase plan, index title, registration."""

from __future__ import annotations

import unittest

from src.config import effective_display_seconds
from src.design_system import page_chrome
from src.payload_utils import is_display_payload, title_for_display_type
from src.upside_news_panel import (
    INFINITE_LOOP_CYCLES,
    UpsideNewsPanel,
    build_phase_plan,
    credit_line,
    index_list_top,
    resolve_index_title,
    resolve_story_phase_seconds,
    upside_news_artwork_asset_path,
)


def make_round(count=3, *, loop_count=1, index_seconds=12, story_seconds=15):
    stories = []
    sections = [
        ("science", "Science", "#8BB7FF", "#003F2A"),
        ("health", "Health", "#6EE7A8", "#123524"),
        ("world", "World", "#F5C453", "#3a2605"),
    ]
    for i in range(count):
        sid, name, accent, bg = sections[i % len(sections)]
        stories.append({
            "index": i,
            "id": f"story-{i}",
            "headline": f"Good news headline number {i + 1}",
            "standfirst": f"A short standfirst for story {i + 1}.",
            "sectionId": sid,
            "sectionName": name,
            "accent": accent,
            "background": bg,
            "publishedLabel": "2h ago",
            "readingMinutes": 3,
            "byline": "Jane Reporter",
            "sourceLabel": "The Guardian",
            "url": f"https://example.com/story-{i}",
            "keywords": ["hope", "community"],
            "artwork": {
                "portrait": f"https://bridge/upside-news-artwork/{sid}-portrait.jpg",
                "landscape": f"https://bridge/upside-news-artwork/{sid}-landscape.jpg",
            },
        })
    return {
        "sessionId": "test-upside",
        "title": "The Upside News",
        "indexTitle": f"Today's {count}",
        "period": "daily",
        "storyCount": count,
        "indexSeconds": index_seconds,
        "storySeconds": story_seconds,
        "loops": "once",
        "loopCount": loop_count,
        "cycleSeconds": index_seconds + count * story_seconds,
        "totalDurationSeconds": index_seconds + count * story_seconds,
        "showQr": True,
        "showReadingTime": True,
        "showTopicTags": False,
        "attribution": "Guardian Open Platform · positive news RSS",
        "indexArtwork": {
            "portrait": "https://bridge/upside-news-artwork/general-portrait.jpg",
            "landscape": "https://bridge/upside-news-artwork/general-landscape.jpg",
        },
        "indexAccent": "#E897FF",
        "indexBackground": "#7A2396",
        "stories": stories,
    }


class UpsideNewsRegistrationTests(unittest.TestCase):
    def test_the_round_is_a_display_payload_with_a_title(self):
        self.assertTrue(is_display_payload({"type": "upside-news.round"}))
        self.assertEqual(
            title_for_display_type("upside-news.round"),
            ("Signal", "The Upside News"),
        )

    def test_display_seconds_are_never_clamped_mid_round(self):
        config = {"maxDisplaySeconds": 60, "defaultDisplaySeconds": 30}
        self.assertEqual(
            effective_display_seconds(
                {"type": "upside-news.round", "displaySeconds": 240}, config,
            ),
            240,
        )


class PhasePlanTests(unittest.TestCase):
    def test_single_cycle_is_index_then_each_story(self):
        plan = build_phase_plan(make_round(3))
        self.assertEqual(
            [entry["phase"] for entry in plan],
            ["index", "story", "story", "story"],
        )
        self.assertEqual([entry["index"] for entry in plan[1:]], [0, 1, 2])

    def test_loop_count_repeats_the_cycle(self):
        plan = build_phase_plan(make_round(2, loop_count=2))
        self.assertEqual(
            [entry["phase"] for entry in plan],
            ["index", "story", "story", "index", "story", "story"],
        )

    def test_until_dismissed_plans_many_cycles(self):
        plan = build_phase_plan(make_round(2, loop_count=0))
        cycles = {entry["cycle"] for entry in plan}
        self.assertEqual(len(cycles), INFINITE_LOOP_CYCLES)
        self.assertEqual(plan[0]["phase"], "index")
        self.assertEqual(plan[-1]["phase"], "story")

    def test_total_plan_time_for_one_cycle(self):
        upside = make_round(3)
        total = sum(entry["seconds"] for entry in build_phase_plan(upside))
        self.assertEqual(total, 12 + 3 * 15)

    def test_five_stories_plan_is_index_plus_five_story_pages(self):
        plan = build_phase_plan(make_round(5))
        self.assertEqual(plan[0]["phase"], "index")
        story_indexes = [entry["index"] for entry in plan if entry["phase"] == "story"]
        self.assertEqual(story_indexes, [0, 1, 2, 3, 4])
        self.assertEqual(len(plan), 6)  # index is NOT counted as a story

    def test_empty_stories_yields_a_single_empty_card(self):
        plan = build_phase_plan({"indexSeconds": 10, "stories": []})
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["phase"], "empty")
        self.assertEqual(plan[0]["seconds"], 10)


class StoryPhaseTimingTests(unittest.TestCase):
    def test_small_timer_drift_still_airs_the_last_story(self):
        action, seconds = resolve_story_phase_seconds(15, 13.2)
        self.assertEqual(action, "story")
        self.assertEqual(seconds, 15)

    def test_shortened_story_when_meaningful_time_remains(self):
        action, seconds = resolve_story_phase_seconds(15, 8)
        self.assertEqual(action, "story")
        self.assertEqual(seconds, 8)

    def test_hold_index_only_when_almost_no_time_left(self):
        action, seconds = resolve_story_phase_seconds(15, 2)
        self.assertEqual(action, "hold")
        self.assertGreaterEqual(seconds, 1)


class IndexTitleTests(unittest.TestCase):
    def test_prefers_payload_index_title(self):
        upside = make_round(3)
        upside["indexTitle"] = "Today's three"
        self.assertEqual(resolve_index_title(upside), "Today's three")

    def test_falls_back_to_period_copy_when_index_title_missing(self):
        upside = make_round(4)
        upside["indexTitle"] = ""
        upside["period"] = "weekly"
        self.assertEqual(resolve_index_title(upside), "This week's four")

    def test_monthly_and_yearly_fallbacks(self):
        self.assertEqual(
            resolve_index_title({"period": "monthly", "stories": [{}]}),
            "This month's picks",
        )
        self.assertEqual(
            resolve_index_title({"period": "yearly", "stories": [{}]}),
            "This year's highlights",
        )


class CreditLineTests(unittest.TestCase):
    def test_dedupes_identical_byline_and_source(self):
        self.assertEqual(
            credit_line({"byline": "Good News Network", "sourceLabel": "Good News Network"}),
            "Good News Network",
        )
        self.assertEqual(
            credit_line({"byline": "Ada Lovelace", "sourceLabel": "The Guardian"}),
            "Ada Lovelace · The Guardian",
        )


class ArtworkPathTests(unittest.TestCase):
    def test_bundled_asset_path_uses_section_and_orientation(self):
        path = upside_news_artwork_asset_path("science", portrait=True)
        if path is not None:
            self.assertIn("science-portrait", str(path).replace("\\", "/"))


class GeometryTests(unittest.TestCase):
    def test_landscape_qr_is_bottom_right_under_story_text(self):
        chrome = page_chrome(1920, 1080, timed=True)
        boxes = UpsideNewsPanel.compute_landscape_boxes(chrome)
        text = boxes["story_text"]
        qr = boxes["story_qr"]
        credit = boxes["story_credit"]
        self.assertGreater(text[2] - text[0], chrome.content_w * 0.7)
        self.assertLessEqual(text[3], qr[1])  # copy above QR
        self.assertGreater(qr[0], chrome.content_x + chrome.content_w * 0.55)
        self.assertLessEqual(credit[2], qr[0])
        self.assertEqual(boxes["columns"], 2)
        left = boxes["body"]
        right = boxes["body_right"]
        self.assertGreater(right[0], left[2])
        self.assertGreater(boxes["title"][3] - boxes["title"][1], 160 * chrome.u)
        # Index list must start below the title band (dateline lives in title).
        self.assertGreaterEqual(boxes["body"][1], boxes["title"][3])

    def test_portrait_qr_is_bottom_right_under_story_text(self):
        chrome = page_chrome(1080, 1920, timed=True)
        boxes = UpsideNewsPanel.compute_portrait_boxes(chrome)
        text = boxes["story_text"]
        qr = boxes["story_qr"]
        credit = boxes["story_credit"]
        progress = boxes["progress"]
        attribution = boxes["attribution"]
        self.assertLessEqual(text[3], qr[1])
        self.assertLessEqual(qr[3], progress[1])
        self.assertLessEqual(progress[3], attribution[1])
        self.assertGreater(qr[0], (text[0] + text[2]) / 2)
        self.assertLessEqual(credit[2], qr[0])
        self.assertEqual(boxes["columns"], 1)
        self.assertGreater(boxes["title"][3] - boxes["title"][1], 180 * chrome.u)
        self.assertGreaterEqual(boxes["body"][1], boxes["title"][3])


class IndexListTopTests(unittest.TestCase):
    def test_list_top_clears_dateline_and_title_band(self):
        u = 1.0
        # Measured dateline bottom at 200; reserved title band ends at 240.
        top = index_list_top(200, u=u, portrait=False, title_bottom=240)
        self.assertGreaterEqual(top, 240 + 20)
        self.assertGreaterEqual(top, 200 + 44)


class UpsideNewsMotionHelpersTests(unittest.TestCase):
    def test_panel_exposes_marquee_and_scroll_helpers(self):
        self.assertTrue(callable(getattr(UpsideNewsPanel, "_place_marquee", None)))
        self.assertTrue(callable(getattr(UpsideNewsPanel, "_place_vertical_scroll", None)))
        self.assertTrue(callable(getattr(UpsideNewsPanel, "_stop_text_motion", None)))


if __name__ == "__main__":
    unittest.main()
