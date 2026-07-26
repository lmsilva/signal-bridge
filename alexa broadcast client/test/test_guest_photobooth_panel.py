import unittest

from src.config import effective_display_seconds
from src.display_panels import GuestPhotoboothPanel
from src.payload_utils import DISPLAY_TYPES, is_display_payload, title_for_display_type


class GuestPhotoboothLayoutTests(unittest.TestCase):
    def test_portrait_stacks_two_cards(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(720, 1100, True)
        self.assertTrue(geo["portrait"])
        self.assertEqual(len(geo["cards"]), 2)
        self.assertEqual(geo["cards"][0]["x"], 0)
        self.assertEqual(geo["cards"][1]["x"], 0)
        self.assertGreater(geo["cards"][1]["y"], geo["cards"][0]["y"])
        self.assertGreaterEqual(geo["qr_size"], 140)

    def test_landscape_places_cards_side_by_side(self):
        geo = GuestPhotoboothPanel.compute_card_geometry(1400, 700, False)
        self.assertFalse(geo["portrait"])
        self.assertEqual(geo["cards"][0]["y"], geo["cards"][1]["y"])
        self.assertGreater(geo["cards"][1]["x"], geo["cards"][0]["x"])
        self.assertGreaterEqual(geo["qr_size"], 160)

    def test_guest_photobooth_is_a_recognized_display_type(self):
        self.assertIn("guest.photobooth", DISPLAY_TYPES)
        self.assertTrue(is_display_payload({"type": "guest.photobooth"}))
        self.assertEqual(
            title_for_display_type("guest.photobooth"),
            ("Signal", "Guest Photo Booth"),
        )

    def test_display_seconds_bypass_max_clamp(self):
        config = {"defaultDisplaySeconds": 30, "maxDisplaySeconds": 120}
        payload = {"type": "guest.photobooth", "displaySeconds": 180}
        self.assertEqual(effective_display_seconds(payload, config), 180)


if __name__ == "__main__":
    unittest.main()
