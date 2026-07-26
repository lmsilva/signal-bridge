import base64
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from src.display_panels import PhotoSlideshowPanel

# 1x1 transparent PNG — same fixture used by the bridge's qr-image-cache tests.
TINY_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class PhotoSlideshowPanelFetchTests(unittest.TestCase):
    """`_fetch_photo`/`_is_ssl_failure` are pure @staticmethod/@classmethod —
    testable without a Tk root, mocking the network call."""

    def setUp(self):
        PhotoSlideshowPanel._UNVERIFIED_SSL = False

    def tearDown(self):
        PhotoSlideshowPanel._UNVERIFIED_SSL = False

    def test_fetch_photo_downloads_and_thumbnails_to_fit(self):
        with mock.patch("src.display_panels.urllib.request.urlopen") as urlopen:
            response = mock.MagicMock()
            response.read.return_value = TINY_PNG_BYTES
            response.__enter__.return_value = response
            urlopen.return_value = response
            image = PhotoSlideshowPanel._fetch_photo("https://nas/qr-images/a.png", 200, 150)
        self.assertIsNotNone(image)
        self.assertLessEqual(image.width, 200)
        self.assertLessEqual(image.height, 150)

    def test_fetch_photo_returns_none_on_persistent_failure(self):
        with mock.patch(
            "src.display_panels.urllib.request.urlopen",
            side_effect=URLError("connection refused"),
        ):
            image = PhotoSlideshowPanel._fetch_photo("https://nas/qr-images/a.png", 200, 150)
        self.assertIsNone(image)

    def test_fetch_photo_returns_none_for_empty_url(self):
        self.assertIsNone(PhotoSlideshowPanel._fetch_photo("", 200, 150))
        self.assertIsNone(PhotoSlideshowPanel._fetch_photo(None, 200, 150))

    def test_fetch_photo_falls_back_to_unverified_ssl_context_and_remembers_it(self):
        calls = []
        first_call_failed = False

        def fake_urlopen(request, timeout=None, context=None):
            nonlocal first_call_failed
            calls.append(context)
            if not first_call_failed:
                first_call_failed = True
                raise URLError(ssl.SSLError("CERTIFICATE_VERIFY_FAILED"))
            response = mock.MagicMock()
            response.read.return_value = TINY_PNG_BYTES
            response.__enter__.return_value = response
            return response

        with mock.patch("src.display_panels.urllib.request.urlopen", side_effect=fake_urlopen):
            image = PhotoSlideshowPanel._fetch_photo("https://nas/qr-images/a.png", 200, 150)
        self.assertIsNotNone(image)
        self.assertEqual(len(calls), 2)
        self.assertTrue(PhotoSlideshowPanel._UNVERIFIED_SSL)

        # Once remembered, later fetches should skip straight to the unverified
        # context — a single successful call, no verify-then-retry dance.
        with mock.patch(
            "src.display_panels.urllib.request.urlopen", side_effect=fake_urlopen,
        ) as urlopen:
            second = PhotoSlideshowPanel._fetch_photo("https://nas/qr-images/b.png", 200, 150)
        self.assertIsNotNone(second)
        self.assertEqual(urlopen.call_count, 1)

    def test_is_ssl_failure_detects_ssl_error_and_wrapped_reason(self):
        self.assertTrue(PhotoSlideshowPanel._is_ssl_failure(ssl.SSLError("bad cert")))
        wrapped = URLError(ssl.SSLError("CERTIFICATE_VERIFY_FAILED"))
        self.assertTrue(PhotoSlideshowPanel._is_ssl_failure(wrapped))
        self.assertFalse(PhotoSlideshowPanel._is_ssl_failure(URLError("connection refused")))


if __name__ == "__main__":
    unittest.main()
