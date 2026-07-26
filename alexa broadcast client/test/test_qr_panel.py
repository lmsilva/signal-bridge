import unittest

from src.display_panels import QrPanel

try:
    import qrcode  # noqa: F401
    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False


@unittest.skipUnless(HAS_QRCODE, "qrcode package not installed in this environment")
class QrPanelImageTests(unittest.TestCase):
    """`_build_qr_image` is a pure @staticmethod — testable without a Tk root."""

    def test_builds_image_close_to_requested_size(self):
        image = QrPanel._build_qr_image("https://example.com/party", 400)
        self.assertIsNotNone(image)
        self.assertEqual(image.width, image.height)
        # Box-size quantization means the result can't exceed the target and
        # won't be more than one module-width short of it.
        self.assertLessEqual(image.width, 400)
        self.assertGreater(image.width, 350)

    def test_denser_wifi_payload_still_fits_target_size(self):
        content = "WIFI:T:WPA;S:Home Network;P:letmein123;;"
        image = QrPanel._build_qr_image(content, 400)
        self.assertIsNotNone(image)
        self.assertLessEqual(image.width, 400)

    def test_larger_target_size_yields_larger_image(self):
        small = QrPanel._build_qr_image("https://example.com", 200)
        large = QrPanel._build_qr_image("https://example.com", 500)
        self.assertLess(small.width, large.width)

    def test_empty_content_returns_none(self):
        self.assertIsNone(QrPanel._build_qr_image("", 400))
        self.assertIsNone(QrPanel._build_qr_image(None, 400))


if __name__ == "__main__":
    unittest.main()
