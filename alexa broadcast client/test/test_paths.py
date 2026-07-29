import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import paths


class PathsTests(unittest.TestCase):
    def test_ensure_config_file_copies_example_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp = Path(tmp_name)
            example = tmp / "config.example.json"
            example.write_text(json.dumps({"listenPort": 47832}), encoding="utf-8")

            with mock.patch.object(paths, "app_root", return_value=tmp), \
                    mock.patch.object(paths, "bundled_resource", side_effect=lambda name: tmp / name):
                config_path = paths.ensure_config_file()

            self.assertEqual(config_path, tmp / "config.json")
            self.assertTrue(config_path.exists())
            self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["listenPort"], 47832)


if __name__ == "__main__":
    unittest.main()
