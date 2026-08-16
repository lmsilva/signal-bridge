import unittest

from src.display_panels import ReminderPanel


class ReminderPanelHelpersTests(unittest.TestCase):
    def test_headline_uses_the_reminder_label(self):
        self.assertEqual(
            ReminderPanel.reminder_headline({"label": "check on the corn"}),
            "check on the corn",
        )

    def test_headline_falls_back_when_unlabelled(self):
        self.assertEqual(ReminderPanel.reminder_headline({}), "Reminder")

    def test_place_shows_the_echo_name(self):
        self.assertEqual(
            ReminderPanel.reminder_place({"device": "Kitchen Echo"}),
            "Kitchen Echo",
        )

    def test_opaque_device_id_is_softened(self):
        self.assertEqual(
            ReminderPanel.reminder_place({"device": "G090N0123456"}),
            "Echo device",
        )

    def test_missing_device_leaves_place_empty(self):
        self.assertEqual(ReminderPanel.reminder_place({"label": "check on the corn"}), "")


if __name__ == "__main__":
    unittest.main()
