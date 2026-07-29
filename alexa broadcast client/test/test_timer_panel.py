import unittest

from src.display_panels import TimerPanel
from src.payload_utils import format_timer_duration_chip, timer_display_label


class TimerLadderHelpersTests(unittest.TestCase):
    def test_ring_diameter_landscape_ladder(self):
        self.assertEqual(TimerPanel.ring_diameter_u(1, portrait=False), 760)
        self.assertEqual(TimerPanel.ring_diameter_u(2, portrait=False), 700)
        self.assertEqual(TimerPanel.ring_diameter_u(3, portrait=False), 560)
        self.assertEqual(TimerPanel.ring_diameter_u(4, portrait=False), 420)

    def test_ring_diameter_portrait_ladder(self):
        self.assertEqual(TimerPanel.ring_diameter_u(1, portrait=True), 860)
        self.assertEqual(TimerPanel.ring_diameter_u(2, portrait=True), 680)
        self.assertEqual(TimerPanel.ring_diameter_u(3, portrait=True), 440)
        self.assertEqual(TimerPanel.ring_diameter_u(4, portrait=True), 440)

    def test_layout_mode_thresholds(self):
        self.assertEqual(TimerPanel.layout_mode(1), "rings")
        self.assertEqual(TimerPanel.layout_mode(4), "rings")
        self.assertEqual(TimerPanel.layout_mode(5), "hero")
        self.assertEqual(TimerPanel.layout_mode(9), "hero")
        self.assertEqual(TimerPanel.layout_mode(10), "dense")
        self.assertEqual(TimerPanel.layout_mode(32), "dense")

    def test_sort_soonest_first(self):
        timers = [
            {"label": "Long", "remainingSec": 900},
            {"label": "Soon", "remainingSec": 45},
            {"label": "Mid", "remainingSec": 200},
        ]
        ordered = TimerPanel.sort_soonest_first(timers)
        self.assertEqual([t["label"] for t in ordered], ["Soon", "Mid", "Long"])

    def test_split_dense_collapses_only_over_one_hour(self):
        timers = [
            {"label": "Toast", "remainingSec": 52},
            {"label": "Pasta", "remainingSec": 130},
            {"label": "Hour+", "remainingSec": 3601},
            {"label": "Far", "remainingSec": 7200},
            {"label": "Eggs", "remainingSec": 400},
        ]
        hero, near, far = TimerPanel.split_dense_timers(timers)
        self.assertEqual(hero["label"], "Toast")
        self.assertEqual([t["label"] for t in near], ["Pasta", "Eggs"])
        self.assertEqual([t["label"] for t in far], ["Hour+", "Far"])

    def test_format_more_collapse(self):
        label = TimerPanel.format_more_collapse(
            8, {"remainingSec": 3600, "fireAt": None},
        )
        self.assertTrue(label.startswith("+8 MORE · NEXT AT "))
        self.assertIn("M", label)  # AM/PM

    def test_arc_color_soonest_vs_muted_and_escalation(self):
        panel = TimerPanel.__new__(TimerPanel)
        from src.design_system import ACCENT, MUTE_ARC, WARN, ALERT
        self.assertEqual(panel._arc_color(300, "soonest"), ACCENT)
        self.assertEqual(panel._arc_color(300, "muted"), MUTE_ARC)
        self.assertEqual(panel._arc_color(40, "muted"), WARN)
        self.assertEqual(panel._arc_color(5, "soonest"), ALERT)

    def test_duration_chip_and_display_label(self):
        self.assertEqual(format_timer_duration_chip(900), "15 MIN")
        self.assertEqual(format_timer_duration_chip(3600), "1 HR")
        self.assertEqual(timer_display_label({"label": "Pasta"}), "PASTA")
        self.assertEqual(timer_display_label({"durationSec": 900}), "15 MIN")

    def test_timer_name_and_place_shows_device(self):
        primary, place = TimerPanel._timer_name_and_place({
            "label": "Pasta",
            "device": "Kitchen Echo",
        })
        self.assertEqual(primary, "Pasta")
        self.assertEqual(place, "Kitchen Echo")

    def test_timer_ring_label_keeps_chip_and_device(self):
        primary, place = TimerPanel._timer_name_and_place(
            {"durationSec": 900, "device": "Bedroom Echo"},
            ring=True,
        )
        self.assertEqual(primary, "15 MIN")
        self.assertEqual(place, "Bedroom Echo")

    def test_timer_place_softens_opaque_ids(self):
        place = TimerPanel._timer_place({"device": "G090N0123456"})
        self.assertEqual(place, "Echo device")


if __name__ == "__main__":
    unittest.main()
