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

    def test_sort_soonest_first(self):
        timers = [
            {"label": "Long", "remainingSec": 900},
            {"label": "Soon", "remainingSec": 45},
            {"label": "Mid", "remainingSec": 200},
        ]
        ordered = TimerPanel.sort_soonest_first(timers)
        self.assertEqual([t["label"] for t in ordered], ["Soon", "Mid", "Long"])

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


if __name__ == "__main__":
    unittest.main()
