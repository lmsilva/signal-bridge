"""Wiki Common Knowledge panel — phase plan, geometry, helpers."""

from __future__ import annotations

import unittest

from src.config import effective_display_seconds
from src.design_system import page_chrome
from src.payload_utils import is_display_payload, title_for_display_type
from src.wiki_common_knowledge_panel import (
    INFINITE_LOOP_CYCLES,
    PANEL_INK_BG,
    WikiCommonKnowledgePanel,
    build_phase_plan,
    estimate_wrapped_lines,
    format_index_dateline,
    format_views_line,
    hero_box_in_region,
    hero_image_urls,
    index_card_row_layout,
    index_list_top,
    resolve_article_phase_seconds,
    resolve_index_title,
    should_apply_fetched_image,
    wiki_ck_artwork_asset_path,
    wikimedia_display_url,
)


def make_round(count=3, *, loop_count=1, index_seconds=12, article_seconds=15):
    stories = []
    categories = [
        ("science", "Science", "#A5B4FC", "#312E81"),
        ("history", "History", "#FCD34D", "#78350F"),
        ("technology", "Technology", "#67E8F9", "#164E63"),
        ("space", "Space", "#7DD3FC", "#0C4A6E"),
        ("culture", "Culture", "#F0ABFC", "#701A75"),
    ]
    for i in range(count):
        cat_id, name, accent, bg = categories[i % len(categories)]
        rank = i + 1
        stories.append({
            "index": i,
            "rank": rank,
            "id": f"wiki-{i}",
            "title": f"Most-read article number {rank}",
            "description": f"A short Wikipedia description for article {rank}.",
            "extract": f"Longer extract text for article {rank} with more detail.",
            "categoryId": cat_id,
            "categoryName": name,
            "accent": accent,
            "background": bg,
            "contentUrl": f"https://en.wikipedia.org/wiki/Test_{rank}",
            "views": 500000 + rank * 10000,
            "viewsDeltaPct": 8.5 + rank,
            "history": [1000 + j * 50 for j in range(12)],
            "artwork": {
                "topic": f"https://bridge/wiki-common-knowledge-artwork/{cat_id}.jpg",
                "fallback": "https://bridge/wiki-common-knowledge-artwork/misc.jpg",
            },
        })
    return {
        "sessionId": "test-wiki-ck",
        "title": "Wikipedia Common Knowledge",
        "indexTitle": f"What the world looked up — {count}",
        "dateline": "Wikipedia · most-read",
        "period": "daily",
        "storyCount": count,
        "indexSeconds": index_seconds,
        "articleSeconds": article_seconds,
        "loops": "once",
        "loopCount": loop_count,
        "cycleSeconds": index_seconds + count * article_seconds,
        "totalDurationSeconds": index_seconds + count * article_seconds,
        "showQr": True,
        "showSparkline": True,
        "attribution": "Wikipedia · Wikimedia pageviews",
        "indexArtwork": {
            "topic": "https://bridge/wiki-common-knowledge-artwork/misc.jpg",
            "fallback": "https://bridge/wiki-common-knowledge-artwork/misc.jpg",
        },
        "indexAccent": "#E897FF",
        "indexBackground": "#7A2396",
        "stories": stories,
    }


class WikiCkRegistrationTests(unittest.TestCase):
    def test_the_round_is_a_display_payload_with_a_title(self):
        self.assertTrue(is_display_payload({"type": "wiki-common-knowledge.round"}))
        self.assertEqual(
            title_for_display_type("wiki-common-knowledge.round"),
            ("Signal", "Wikipedia Common Knowledge"),
        )

    def test_display_seconds_are_never_clamped_mid_round(self):
        config = {"maxDisplaySeconds": 60, "defaultDisplaySeconds": 30}
        self.assertEqual(
            effective_display_seconds(
                {"type": "wiki-common-knowledge.round", "displaySeconds": 240}, config,
            ),
            240,
        )


class PhasePlanTests(unittest.TestCase):
    def test_single_cycle_is_index_then_each_article(self):
        plan = build_phase_plan(make_round(3))
        self.assertEqual(
            [entry["phase"] for entry in plan],
            ["index", "article", "article", "article"],
        )
        self.assertEqual([entry["index"] for entry in plan[1:]], [0, 1, 2])

    def test_loop_count_repeats_the_cycle(self):
        plan = build_phase_plan(make_round(2, loop_count=2))
        self.assertEqual(
            [entry["phase"] for entry in plan],
            ["index", "article", "article", "index", "article", "article"],
        )

    def test_until_dismissed_plans_many_cycles(self):
        plan = build_phase_plan(make_round(2, loop_count=0))
        cycles = {entry["cycle"] for entry in plan}
        self.assertEqual(len(cycles), INFINITE_LOOP_CYCLES)
        self.assertEqual(plan[0]["phase"], "index")
        self.assertEqual(plan[-1]["phase"], "article")

    def test_total_plan_time_for_one_cycle(self):
        wiki = make_round(3)
        total = sum(entry["seconds"] for entry in build_phase_plan(wiki))
        self.assertEqual(total, 12 + 3 * 15)

    def test_empty_stories_yields_a_single_empty_card(self):
        plan = build_phase_plan({"indexSeconds": 10, "stories": []})
        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["phase"], "empty")
        self.assertEqual(plan[0]["seconds"], 10)


class ArticlePhaseTimingTests(unittest.TestCase):
    def test_small_timer_drift_still_airs_the_last_article(self):
        action, seconds = resolve_article_phase_seconds(15, 13.2)
        self.assertEqual(action, "article")
        self.assertEqual(seconds, 15)

    def test_shortened_article_when_meaningful_time_remains(self):
        action, seconds = resolve_article_phase_seconds(15, 8)
        self.assertEqual(action, "article")
        self.assertEqual(seconds, 8)

    def test_hold_index_only_when_almost_no_time_left(self):
        action, seconds = resolve_article_phase_seconds(15, 2)
        self.assertEqual(action, "hold")
        self.assertGreaterEqual(seconds, 1)


class IndexTitleTests(unittest.TestCase):
    def test_prefers_payload_index_title(self):
        wiki = make_round(3)
        wiki["indexTitle"] = "Today's three"
        self.assertEqual(resolve_index_title(wiki), "Today's three")

    def test_falls_back_to_period_copy_when_index_title_missing(self):
        wiki = make_round(4)
        wiki["indexTitle"] = ""
        wiki["period"] = "weekly"
        self.assertEqual(resolve_index_title(wiki), "This week's four")

    def test_dateline_prefers_payload(self):
        wiki = make_round(1)
        wiki["dateline"] = "Tuesday 5 August · Wikipedia"
        self.assertEqual(format_index_dateline(wiki), "Tuesday 5 August · Wikipedia")

    def test_default_daily_title_is_not_a_single_huge_unbroken_line(self):
        # Portrait posters were clipping "What the world looked up — five".
        wiki = make_round(5)
        wiki["indexTitle"] = ""
        title = resolve_index_title(wiki)
        self.assertIn("looked up", title)
        self.assertIn("five", title)


class ViewsLineTests(unittest.TestCase):
    def test_formats_views_and_percent_delta(self):
        line = format_views_line({"views": 842000, "viewsDeltaPct": 12.4})
        self.assertIn("views", line)
        self.assertIn("+12%", line)

    def test_formats_thousands(self):
        line = format_views_line({"views": 4500, "viewsDelta": 200})
        self.assertIn("4.5K views", line)


class ArtworkPathTests(unittest.TestCase):
    def test_bundled_asset_path_uses_category_id(self):
        path = wiki_ck_artwork_asset_path("science")
        if path is not None:
            self.assertIn("science", str(path).replace("\\", "/"))


class HeroImageUrlTests(unittest.TestCase):
    def test_wikimedia_display_url_upsizes_thumbs(self):
        url = wikimedia_display_url(
            "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Glen.jpg/220px-Glen.jpg",
            min_width=960,
        )
        self.assertTrue(url.endswith("/960px-Glen.jpg"))

    def test_hero_image_urls_prefer_thumb_over_original(self):
        urls = hero_image_urls({
            "thumbnailUrl": (
                "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Glen.jpg/220px-Glen.jpg"
            ),
            "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Glen_Huge.tif",
        })
        self.assertTrue(urls)
        self.assertIn("960px-Glen.jpg", urls[0])
        self.assertTrue(any("lossy-page1" in u or "Glen_Huge" in u for u in urls))


class ImageGenerationTests(unittest.TestCase):
    def test_concurrent_thumbs_share_one_generation(self):
        # Index cards must not bump the generation per thumbnail — otherwise
        # only the last card's image survives.
        paint_gen = 7
        for _ in range(5):
            self.assertTrue(
                should_apply_fetched_image(
                    fetch_gen=paint_gen, current_gen=paint_gen, visible=True,
                ),
            )

    def test_stale_generation_and_hidden_panel_reject_images(self):
        self.assertFalse(
            should_apply_fetched_image(fetch_gen=3, current_gen=4, visible=True),
        )
        self.assertFalse(
            should_apply_fetched_image(fetch_gen=4, current_gen=4, visible=False),
        )


class GeometryTests(unittest.TestCase):
    def test_landscape_regions_do_not_overlap(self):
        chrome = page_chrome(1920, 1080, timed=True)
        boxes = WikiCommonKnowledgePanel.compute_landscape_boxes(chrome)
        hero = boxes["article_hero"]
        body = boxes["article_body"]
        footer = boxes["article_footer"]
        qr = boxes["story_qr"]
        self.assertGreater(body[0], hero[2])
        self.assertLessEqual(hero[3], footer[1])
        self.assertLessEqual(body[3], footer[1])
        self.assertLessEqual(body[2], qr[0])
        self.assertLessEqual(footer[2], qr[0])
        self.assertEqual(boxes["columns"], 2)
        left = boxes["body"]
        right = boxes["body_right"]
        self.assertGreater(right[0], left[2])
        # Article stack uses the full content top — no empty title void.
        self.assertAlmostEqual(hero[1], chrome.content_top, delta=2)
        self.assertAlmostEqual(body[1], chrome.content_top, delta=2)
        self.assertGreaterEqual(boxes["body"][1], boxes["title"][3])

    def test_portrait_qr_is_bottom_right_with_footer_band(self):
        chrome = page_chrome(1080, 1920, timed=True)
        boxes = WikiCommonKnowledgePanel.compute_portrait_boxes(chrome)
        main = boxes["article_main"]
        footer = boxes["article_footer"]
        qr = boxes["story_qr"]
        progress = boxes["progress"]
        self.assertLessEqual(main[3], footer[1])
        self.assertLessEqual(footer[3], qr[3])
        self.assertLessEqual(qr[3], progress[1])
        self.assertGreater(qr[0], (main[0] + main[2]) / 2)
        self.assertEqual(boxes["columns"], 1)
        # Article uses full height from content top.
        self.assertAlmostEqual(main[1], chrome.content_top, delta=2)
        self.assertGreaterEqual(boxes["body"][1], boxes["title"][3])

    def test_hero_box_is_sixteen_by_nine_in_portrait(self):
        region = (0.0, 0.0, 1600.0, 1200.0)
        hero = hero_box_in_region(region, portrait=True)
        width = hero[2] - hero[0]
        height = hero[3] - hero[1]
        ratio = width / height
        self.assertAlmostEqual(ratio, 16 / 9, places=1)
        # Portrait hero is capped so copy still has room below.
        self.assertLessEqual(height, 1200.0 * 0.42 + 1)

    def test_estimate_wrapped_lines_keeps_short_titles_to_one_line(self):
        import tkinter.font as tkfont
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        try:
            font = tkfont.Font(family="Segoe UI", size=24, weight="bold")
            self.assertEqual(estimate_wrapped_lines("Glen Hansard", font, 800, max_lines=3), 1)
            self.assertGreaterEqual(
                estimate_wrapped_lines("A" * 120, font, 200, max_lines=3), 2,
            )
        finally:
            root.destroy()

    def test_panel_ink_bg_is_shell_navy_not_category_purple(self):
        self.assertEqual(PANEL_INK_BG.lower(), "#0b1730")


class IndexListTopTests(unittest.TestCase):
    def test_list_top_clears_dateline_and_title_band(self):
        u = 1.0
        top = index_list_top(200, u=u, portrait=False, title_bottom=240)
        self.assertGreaterEqual(top, 240 + 20)
        self.assertGreaterEqual(top, 200 + 44)


class IndexCardRowLayoutTests(unittest.TestCase):
    def test_number_thumb_and_text_share_a_midline(self):
        layout = index_card_row_layout(
            100, 120,
            pad=16,
            thumb_size=64,
            num_h=50,
            title_h=24,
            desc_h=18,
            meta_h=16,
            gap_title_desc=6,
            gap_desc_meta=6,
        )
        self.assertAlmostEqual(layout["num_cy"], layout["thumb_y"] + 32, places=3)
        self.assertAlmostEqual(
            layout["title_y"] + layout["text_stack_h"] / 2,
            layout["mid_y"],
            places=3,
        )
        above = layout["band_top"] - 100
        below = (100 + 120) - (layout["band_top"] + layout["band_h"])
        self.assertAlmostEqual(above, below, delta=1.0)
        self.assertLess(layout["title_y"], layout["desc_y"])
        self.assertLess(layout["desc_y"], layout["meta_y"])

    def test_meta_follows_title_when_description_missing(self):
        layout = index_card_row_layout(
            0, 100,
            pad=10,
            thumb_size=48,
            num_h=40,
            title_h=20,
            desc_h=0,
            meta_h=14,
            gap_title_desc=6,
            gap_desc_meta=6,
        )
        self.assertAlmostEqual(layout["meta_y"], layout["title_y"] + 20 + 6, places=3)


class WikiCkMotionHelpersTests(unittest.TestCase):
    def test_panel_exposes_marquee_and_scroll_helpers(self):
        self.assertTrue(callable(getattr(WikiCommonKnowledgePanel, "_place_marquee", None)))
        self.assertTrue(callable(getattr(WikiCommonKnowledgePanel, "_place_vertical_scroll", None)))
        self.assertTrue(callable(getattr(WikiCommonKnowledgePanel, "_stop_text_motion", None)))


if __name__ == "__main__":
    unittest.main()
