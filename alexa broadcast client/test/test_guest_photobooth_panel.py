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
