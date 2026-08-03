import unittest

from src.config import effective_display_seconds
from src.display_panels import GuestPhotoboothPanel, SmartHomePanel
from src.payload_utils import DISPLAY_TYPES, is_display_payload, title_for_display_type


class GuestPhotoboothLayoutTests(unittest.TestCase):
    def test_portrait_stacks_two_cards_without_connector(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(1000, 1600, True)
        self.assertTrue(geo["portrait"])
        self.assertEqual(len(geo["cards"]), 2)
        self.assertEqual(geo["cards"][0]["x"], 0)
        self.assertEqual(geo["cards"][1]["x"], 0)
        self.assertGreater(
            geo["cards"][1]["y"],
            geo["cards"][0]["y"] + geo["card_h"],
        )
        self.assertEqual(geo["gap"], 24)
        self.assertEqual(geo["connector_h"], 0)
        self.assertEqual(geo["plate"], 620)
        self.assertEqual(geo["qr_size"], 560)

    def test_landscape_places_cards_side_by_side(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(1400, 700, False)
        self.assertFalse(geo["portrait"])
        self.assertEqual(geo["cards"][0]["y"], geo["cards"][1]["y"])
        self.assertGreater(geo["cards"][1]["x"], geo["cards"][0]["x"])
        self.assertGreaterEqual(geo["qr_size"], 400)
        self.assertGreaterEqual(geo["plate"], 450)
        self.assertEqual(geo["gap"], 24)
        self.assertEqual(geo["origin_y"], 0)

    def test_guest_photobooth_is_a_recognized_display_type(self):
        self.assertIn("guest.photobooth", DISPLAY_TYPES)
        self.assertTrue(is_display_payload({"type": "guest.photobooth"}))
        self.assertEqual(
            title_for_display_type("guest.photobooth"),
            ("Signal", "Guest Snaps"),
        )

    def test_display_seconds_bypass_max_clamp(self):
        config = {"defaultDisplaySeconds": 30, "maxDisplaySeconds": 120}
        payload = {"type": "guest.photobooth", "displaySeconds": 180}
        self.assertEqual(effective_display_seconds(payload, config), 180)

    def test_pin_band_reserved_when_access_pin_present(self):
        self.assertEqual(GuestPhotoboothPanel.pin_band_height(1.0, has_pin=True), 110)
        self.assertEqual(GuestPhotoboothPanel.pin_band_height(1.0, has_pin=False), 0)
        self.assertEqual(GuestPhotoboothPanel.pin_band_height(2.0, has_pin=True), 220)

    def test_pin_band_height_uses_measured_metrics_when_given(self):
        self.assertEqual(
            GuestPhotoboothPanel.pin_band_height(
                1.0, has_pin=True, metrics={"height": 147},
            ),
            147,
        )
        self.assertEqual(
            GuestPhotoboothPanel.pin_band_height(
                1.0, has_pin=False, metrics={"height": 147},
            ),
            0,
        )


class GuestPhotoboothPinBandTests(unittest.TestCase):
    """The PIN used to be centre-anchored in a fixed 110u band while its font
    stayed at a fixed 42/48pt, so its line box swallowed the caption above it."""

    @classmethod
    def setUpClass(cls):
        import tkinter as tk
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    # (screen_w, screen_h) — portrait, landscape, and a sub-1080-vmin panel.
    SCREENS = ((1080, 1920), (1920, 1080), (1600, 900), (1280, 720))

    def _metrics_for(self, screen_w, screen_h):
        from src.design_system import design_u

        u = design_u(screen_w, screen_h)
        fonts = GuestPhotoboothPanel.pin_band_fonts(u)
        return u, fonts, GuestPhotoboothPanel.measure_pin_band(*fonts, u=u)

    def test_stack_never_overlaps(self):
        for screen_w, screen_h in self.SCREENS:
            with self.subTest(screen=(screen_w, screen_h)):
                _, _, m = self._metrics_for(screen_w, screen_h)
                caption_bottom = m["caption_y"] + m["caption_h"]
                pin_bottom = m["pin_y"] + m["pin_h"]
                self.assertLessEqual(caption_bottom, m["pin_y"])
                self.assertLessEqual(pin_bottom, m["hint_y"])

    def test_stack_stays_inside_the_band(self):
        for screen_w, screen_h in self.SCREENS:
            with self.subTest(screen=(screen_w, screen_h)):
                _, _, m = self._metrics_for(screen_w, screen_h)
                self.assertGreaterEqual(m["caption_y"], 0)
                self.assertLessEqual(m["hint_y"] + m["hint_h"], m["height"])

    def test_band_never_shrinks_below_the_historical_reserve(self):
        for screen_w, screen_h in self.SCREENS:
            with self.subTest(screen=(screen_w, screen_h)):
                u, _, m = self._metrics_for(screen_w, screen_h)
                self.assertGreaterEqual(
                    m["height"],
                    GuestPhotoboothPanel.pin_band_height(u, has_pin=True),
                )
                self.assertLessEqual(
                    m["height"],
                    GuestPhotoboothPanel.PIN_BAND_MAX_H * u + 1,
                )

    def test_pin_font_scales_with_display_unit(self):
        _, small_fonts, _ = self._metrics_for(1280, 720)
        _, large_fonts, _ = self._metrics_for(1920, 1080)
        self.assertLess(
            int(small_fonts[1].cget("size")), int(large_fonts[1].cget("size")),
        )

    def test_draw_places_three_texts_in_reading_order(self):
        from unittest.mock import MagicMock

        panel = GuestPhotoboothPanel.__new__(GuestPhotoboothPanel)
        panel.config = {}
        panel._item_ids = []
        panel.canvas = MagicMock()
        panel.canvas.create_text.return_value = 1
        panel._track = lambda item_id: panel._item_ids.append(item_id) or item_id

        u, fonts, metrics = self._metrics_for(1080, 1920)
        panel._draw_access_pin_band(
            40, 136, 1000, metrics["height"], "123456", "Enter this PIN on your phone",
            u=u, metrics=metrics, fonts=fonts,
        )
        calls = panel.canvas.create_text.call_args_list
        self.assertEqual(len(calls), 3)
        texts = [c.kwargs["text"] for c in calls]
        self.assertEqual(texts, ["BOOTH PIN", "123456", "Enter this PIN on your phone"])
        # Every item anchors "n" so nothing grows upward into its neighbour.
        self.assertEqual([c.kwargs["anchor"] for c in calls], ["n", "n", "n"])
        ys = [c.args[1] for c in calls]
        self.assertEqual(ys, sorted(ys))

    def test_pin_clears_the_page_header_on_small_panels(self):
        from src.design_system import page_chrome

        for screen_w, screen_h in self.SCREENS:
            with self.subTest(screen=(screen_w, screen_h)):
                chrome = page_chrome(screen_w, screen_h, timed=True)
                _, _, m = self._metrics_for(screen_w, screen_h)
                header_bottom = (32 if chrome.portrait else 28) * chrome.u + 84 * chrome.u
                self.assertGreaterEqual(chrome.content_top + m["caption_y"], header_bottom)


class GuestPhotoboothCaptionTests(unittest.TestCase):
    """"Network" and the SSID are set in different faces at different sizes, so
    sharing a top edge left the smaller word floating above the larger one."""

    @classmethod
    def setUpClass(cls):
        import tkinter as tk
        import tkinter.font as tkfont

        cls.root = tk.Tk()
        cls.root.withdraw()
        cls.small = tkfont.Font(family="Segoe UI", size=13)
        cls.large = tkfont.Font(family="Consolas", size=22, weight="bold")

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    def runs(self, ssid="Pandamonium"):
        return [(self.small, "Network ", "#9AA7B8"), (self.large, ssid, "#5FD0FF")]

    def test_the_two_runs_share_a_baseline(self):
        runs = self.runs()
        layout = GuestPhotoboothPanel.layout_caption_runs(runs)

        baselines = [
            place["dy"] + font.metrics("ascent")
            for (font, _text, _fill), place in zip(runs, layout["runs"])
        ]
        self.assertEqual(len(set(baselines)), 1, "both runs must sit on one baseline")

    def test_the_smaller_run_is_pushed_down_not_the_larger_one(self):
        runs = self.runs()
        layout = GuestPhotoboothPanel.layout_caption_runs(runs)

        small_place, large_place = layout["runs"]
        self.assertGreater(small_place["dy"], large_place["dy"])
        self.assertEqual(large_place["dy"], 0, "the tallest run defines the top")

    def test_the_runs_sit_side_by_side_without_overlapping(self):
        runs = self.runs()
        layout = GuestPhotoboothPanel.layout_caption_runs(runs)

        self.assertEqual(layout["runs"][0]["dx"], 0)
        self.assertEqual(layout["runs"][1]["dx"], self.small.measure("Network "))
        self.assertEqual(
            layout["width"],
            self.small.measure("Network ") + self.large.measure("Pandamonium"),
        )

    def test_the_band_is_tall_enough_for_the_larger_face(self):
        layout = GuestPhotoboothPanel.layout_caption_runs(self.runs())

        # Reserving only the small caption's line height let the SSID overhang
        # the card border.
        self.assertGreaterEqual(layout["height"], self.large.metrics("linespace"))
        self.assertGreater(layout["height"], self.small.metrics("linespace"))

    def test_a_single_run_needs_no_offset(self):
        runs = [(self.small, "Already connected? Start here", "#9AA7B8")]
        layout = GuestPhotoboothPanel.layout_caption_runs(runs)

        self.assertEqual(layout["runs"], [{"dx": 0, "dy": 0}])
        self.assertEqual(layout["width"], self.small.measure(runs[0][1]))

    def test_the_caption_is_centred_on_the_card(self):
        from unittest.mock import MagicMock

        panel = GuestPhotoboothPanel.__new__(GuestPhotoboothPanel)
        panel._item_ids = []
        panel.canvas = MagicMock()
        panel.canvas.create_text.return_value = 1
        panel._track = lambda item_id: panel._item_ids.append(item_id) or item_id

        runs = self.runs()
        panel._draw_caption_runs(runs, center_x=500, top=200)

        calls = panel.canvas.create_text.call_args_list
        self.assertEqual([c.kwargs["text"] for c in calls], ["Network ", "Pandamonium"])
        self.assertEqual([c.kwargs["anchor"] for c in calls], ["nw", "nw"])
        layout = GuestPhotoboothPanel.layout_caption_runs(runs)
        self.assertAlmostEqual(calls[0].args[0], 500 - layout["width"] / 2)


class SmartHomeLayoutTests(unittest.TestCase):
    def test_portrait_puts_breathing_room_under_icon(self):
        geo = SmartHomePanel.compute_stack_layout(
            900, True, on_h=50, name_h=36, pill_h=40,
        )
        self.assertGreaterEqual(geo["gap_icon_on"], 56)
        self.assertGreaterEqual(geo["gap_on_name"], 28)
        # Leftover height should expand gaps, not only top pad.
        self.assertGreater(geo["gap_icon_on"], geo["top_pad"] * 0.4)

    def test_tight_area_still_keeps_icon_readable(self):
        geo = SmartHomePanel.compute_stack_layout(
            300, True, on_h=50, name_h=36, pill_h=40,
        )
        self.assertGreaterEqual(geo["icon_size"], 96)


if __name__ == "__main__":
    unittest.main()
