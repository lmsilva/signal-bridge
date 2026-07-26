import unittest

from src.config import effective_display_seconds
from src.display_panels import GuestPhotoboothPanel, SmartHomePanel
from src.payload_utils import DISPLAY_TYPES, is_display_payload, title_for_display_type


class GuestPhotoboothLayoutTests(unittest.TestCase):
    def test_portrait_stacks_two_cards_with_connector_band(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(720, 1100, True)
        self.assertTrue(geo["portrait"])
        self.assertEqual(len(geo["cards"]), 2)
        self.assertEqual(geo["cards"][0]["x"], 0)
        self.assertEqual(geo["cards"][1]["x"], 0)
        # Second card starts after first card + dedicated connector band.
        self.assertGreaterEqual(
            geo["cards"][1]["y"],
            geo["cards"][0]["y"] + geo["card_h"] + geo["connector_h"],
        )
        # Connector sits in the band between cards (not inside either card).
        connector_y = geo["connector"]["y"]
        self.assertGreater(connector_y, geo["cards"][0]["y"] + geo["card_h"])
        self.assertLess(connector_y, geo["cards"][1]["y"])
        self.assertGreaterEqual(geo["qr_size"], 140)

    def test_landscape_places_cards_side_by_side(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(1400, 700, False, header_h=96)
        self.assertFalse(geo["portrait"])
        self.assertEqual(geo["cards"][0]["y"], geo["cards"][1]["y"])
        self.assertGreater(geo["cards"][1]["x"], geo["cards"][0]["x"])
        self.assertGreaterEqual(geo["qr_size"], 140)
        self.assertTrue(geo["vcenter_content"])
        # Wide gutter so "then" never sits on clipped subtitle text.
        self.assertGreaterEqual(geo["gap"], 48)
        # Cards sized to content and vertically centered — not stretched full-height.
        block_bottom = geo["cards"][0]["y"] + geo["card_h"]
        self.assertLess(block_bottom, 700)
        self.assertGreater(geo["origin_y"], 0)

    def test_landscape_header_keeps_cards_below_subtitle(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(1600, 800, False, header_h=110)
        self.assertGreaterEqual(geo["cards"][0]["y"], geo["origin_y"] + 110)

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
