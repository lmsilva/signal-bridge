import base64
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from PIL import Image

from src.display_panels import PhotoSlideshowPanel, QrPanel
from src.shared_photos_page import (
    compute_layout,
    counter_label,
    fit_photo_for_box,
    sample_mat_accent,
    NEUTRAL_MAT,
    PRINT_BORDER,
)

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


class PhotoSlideshowPanelShowAdvanceTests(unittest.TestCase):
    """`show()`/`_advance()` logic with a mocked Tk root/shell/canvas —
    `_fetch_photo` is stubbed out (covered separately above) so no real
    network call or background-thread timing affects these assertions."""

    def _make_panel(self):
        shell = mock.MagicMock()
        shell.content_canvas = mock.MagicMock()
        # Mirror production: OverlayLayout has NO screen_w/screen_h — those
        # live on the overlay (reachable via OverlayShell.__getattr__).
        layout = mock.MagicMock(spec=[
            "content_x", "content_width", "message_area_top", "message_area_bottom",
            "portrait",
        ])
        layout.content_x = 40
        layout.content_width = 800
        layout.message_area_top = 100
        layout.message_area_bottom = 700
        layout.portrait = True
        shell.layout = layout
        shell.overlay.screen_w = 1080
        shell.overlay.screen_h = 1920
        shell.screen_w = 1080
        shell.screen_h = 1920
        shell.body_font = mock.MagicMock()
        shell.body_font.metrics.return_value = 24
        shell.chip_value_font = mock.MagicMock()
        shell.chip_value_font.metrics.return_value = 20
        shell.chip_value_font.actual.return_value = "Segoe UI"
        root = mock.MagicMock()
        root.winfo_screenwidth.return_value = 1080
        root.winfo_screenheight.return_value = 1920
        return PhotoSlideshowPanel(root, shell, {"mutedTextColor": "#94a3b8"})

    def test_show_normalizes_object_and_bare_string_photo_entries(self):
        panel = self._make_panel()
        with mock.patch.object(PhotoSlideshowPanel, "_fetch_photo", return_value=None), \
                mock.patch.object(QrPanel, "_build_qr_image", return_value=None):
            panel.show({
                "slideshow": {
                    "photos": [
                        {"url": "https://nas/a.jpg", "uploadedAt": "2026-01-01T00:00:00Z"},
                        "https://nas/b.jpg",
                        {"url": "   ", "uploadedAt": "2026-01-02T00:00:00Z"},
                        "",
                    ],
                    "secondsPerPhoto": 3,
                },
            })
        self.assertEqual(
            panel._photos,
            [
                {
                    "url": "https://nas/a.jpg",
                    "uploadedAt": "2026-01-01T00:00:00Z",
                    "caption": "",
                },
                {"url": "https://nas/b.jpg", "uploadedAt": None, "caption": ""},
            ],
        )
        self.assertEqual(panel._seconds_per_photo, 3)
        self.assertEqual(panel._index, 0)

    def test_show_with_no_photos_leaves_the_list_empty(self):
        panel = self._make_panel()
        panel.show({"slideshow": {"photos": []}})
        self.assertEqual(panel._photos, [])

    def test_advance_stops_after_the_last_photo_instead_of_wrapping(self):
        panel = self._make_panel()
        with mock.patch.object(PhotoSlideshowPanel, "_fetch_photo", return_value=None), \
                mock.patch.object(QrPanel, "_build_qr_image", return_value=None):
            panel.show({
                "slideshow": {
                    "photos": ["https://nas/a.jpg", "https://nas/b.jpg"],
                    "secondsPerPhoto": 1,
                },
            })
            self.assertEqual(panel._index, 0)
            panel._advance()
            self.assertEqual(panel._index, 1)
            # Already on the last photo — should hold, not wrap back to 0.
            panel._advance()
            self.assertEqual(panel._index, 1)

    def test_show_starts_fetch_even_when_corner_qr_chrome_fails(self):
        """Regression: chrome used to read layout.screen_w (missing on
        OverlayLayout) and raise before the fetch thread was started."""
        panel = self._make_panel()
        with mock.patch.object(PhotoSlideshowPanel, "_fetch_photo", return_value=None) as fetch, \
                mock.patch.object(QrPanel, "_build_qr_image", side_effect=RuntimeError("qr boom")):
            panel.show({
                "slideshow": {
                    "photos": ["https://nas/a.jpg"],
                    "secondsPerPhoto": 5,
                },
            })
        import time
        for _ in range(20):
            if fetch.called:
                break
            time.sleep(0.01)
        self.assertTrue(fetch.called)


class QrPanelSharedPhotoTests(unittest.TestCase):
    def test_is_shared_photo_url_detects_qr_images_path(self):
        self.assertTrue(QrPanel._is_shared_photo_url("https://nas:47810/qr-images/abc.jpg"))
        self.assertTrue(QrPanel._is_shared_photo_url("https://nas/qr-images/x.png?v=1"))
        self.assertFalse(QrPanel._is_shared_photo_url("https://example.com/party"))
        self.assertFalse(QrPanel._is_shared_photo_url("WIFI:T:WPA;S:Home;P:x;;"))
        self.assertFalse(QrPanel._is_shared_photo_url(""))


class SharedPhotosLayoutTests(unittest.TestCase):
    """Spec v2 1080×1920 page: large stage, bottom bar with QR plate."""

    def test_portrait_page_fills_1080x1920(self):
        layout = compute_layout(1080, 1920)
        self.assertAlmostEqual(layout.u, 1.0)
        self.assertTrue(layout.portrait)
        self.assertAlmostEqual(layout.page_w, 1080)
        self.assertAlmostEqual(layout.page_h, 1920)
        self.assertAlmostEqual(layout.photo_box[0], 1032)
        self.assertAlmostEqual(layout.photo_box[1], 1416)
        # Stage sits between header and bar.
        self.assertLess(layout.header[3], layout.stage[1])
        self.assertLessEqual(layout.stage[3], layout.bar[1])
        self.assertFalse(layout.rail_vertical)

    def test_landscape_uses_sidebar_not_letterboxed_portrait(self):
        layout = compute_layout(1920, 1080, mode="slideshow")
        self.assertFalse(layout.portrait)
        self.assertTrue(layout.rail_vertical)
        # Full-bleed landscape page — not a centred 9:16 letterbox.
        self.assertAlmostEqual(layout.page_w, 1920)
        self.assertAlmostEqual(layout.page_h, 1080)
        # Stage left of rail/sidebar (mockup: stage 1388, rail at 1420, sidebar 380).
        self.assertLess(layout.stage[2], layout.rail[0] + 1)
        self.assertAlmostEqual(layout.rail[0], layout.bar[0], delta=2)
        self.assertAlmostEqual(layout.stage[1], layout.bar[1])
        self.assertAlmostEqual(layout.stage[3], layout.bar[3])
        # Photo box uses the stage's full height (inset), not the portrait 1416 box.
        self.assertGreater(layout.photo_box[0], 1000)
        self.assertLess(layout.photo_box[1], 920)
        self.assertGreater(layout.photo_box[1], 700)

    def test_landscape_upload_zone_is_shorter_than_slideshow(self):
        slide = compute_layout(1920, 1080, mode="slideshow")
        upload = compute_layout(1920, 1080, mode="upload")
        self.assertLess(upload.stage[3] - upload.stage[1], slide.stage[3] - slide.stage[1])

    def test_counter_label_zero_pads(self):
        self.assertEqual(counter_label(0, 12), "01 / 12")
        self.assertEqual(counter_label(11, 12), "12 / 12")

    def test_fit_photo_contains_and_caps_upscale(self):
        tiny = Image.new("RGB", (100, 50), (10, 20, 30))
        fitted = fit_photo_for_box(tiny, 1032, 1416, border_px=0)
        self.assertIsNotNone(fitted)
        # ≤2× upscale from 100×50 → 200×100
        self.assertEqual(fitted.size, (200, 100))

    def test_fit_photo_adds_print_border(self):
        src = Image.new("RGB", (400, 600), (200, 100, 50))
        fitted = fit_photo_for_box(src, 500, 700, border_px=10)
        self.assertIsNotNone(fitted)
        # Border expands on all sides.
        self.assertEqual(fitted.getpixel((0, 0)), tuple(int(PRINT_BORDER[i:i + 2], 16) for i in (1, 3, 5)))

    def test_sample_mat_accent_falls_back_for_near_black(self):
        dark = Image.new("RGB", (32, 32), (2, 2, 2))
        mat, accent = sample_mat_accent(dark)
        self.assertEqual(mat, NEUTRAL_MAT)


if __name__ == "__main__":
    unittest.main()
