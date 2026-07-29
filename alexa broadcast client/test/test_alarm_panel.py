import unittest

from src.display_panels import AlarmPanel


class AlarmPanelNamePlaceTests(unittest.TestCase):
    def test_labeled_alarm_keeps_name_and_device(self):
        primary, place = AlarmPanel._alarm_name_and_place({
            "label": "Wake up",
            "device": "Bedroom Echo",
        })
        self.assertEqual(primary, "Wake up")
        self.assertEqual(place, "Bedroom Echo")

    def test_unlabeled_alarm_promotes_device(self):
        primary, place = AlarmPanel._alarm_name_and_place({
            "device": "Kitchen Echo",
        })
        self.assertEqual(primary, "Kitchen Echo")
        self.assertEqual(place, "")

    def test_music_alarm_keeps_title_and_device(self):
        primary, place = AlarmPanel._alarm_name_and_place({
            "alarmType": "music",
            "device": "Office Echo",
        })
        self.assertEqual(primary, "Music alarm")
        self.assertEqual(place, "Office Echo")

    def test_opaque_device_id_is_softened(self):
        primary, place = AlarmPanel._alarm_name_and_place({
            "label": "Gym",
            "device": "G090N0123456",
        })
        self.assertEqual(primary, "Gym")
        self.assertEqual(place, "Echo device")

    def test_missing_device_leaves_place_empty(self):
        primary, place = AlarmPanel._alarm_name_and_place({"label": "Wake up"})
        self.assertEqual(primary, "Wake up")
        self.assertEqual(place, "")


if __name__ == "__main__":
    unittest.main()
