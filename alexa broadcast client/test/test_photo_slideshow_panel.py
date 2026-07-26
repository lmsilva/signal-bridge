import base64
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from src.display_panels import PhotoSlideshowPanel, QrPanel

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
        # live on the overlay (reachable via OverlayShell.__getattr__). The
        # old chrome path read layout.screen_w and crashed before the fetch
        # thread started, leaving the panel stuck on "Loading photo…".
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
        shell.screen_w = 1080
        shell.screen_h = 1920
        shell.body_font = mock.MagicMock()
        shell.body_font.metrics.return_value = 24
        shell.chip_value_font = mock.MagicMock()
        shell.chip_value_font.metrics.return_value = 20
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
                {"url": "https://nas/a.jpg", "uploadedAt": "2026-01-01T00:00:00Z"},
                {"url": "https://nas/b.jpg", "uploadedAt": None},
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
        # Worker was still scheduled (root.after from the thread callback
        # path isn't what we assert — _fetch_photo itself must have run).
        # Give the daemon thread a moment to call into the stub.
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


class PhotoStageGeometryTests(unittest.TestCase):
    """Hero photo uses the full content width; the scan QR sits inside the
    photo's lower-right corner with a caption sized to the QR width."""

    def _panel(self, *, portrait: bool, content_x=80, content_width=1200,
               top=120, bottom=900):
        shell = mock.MagicMock()
        shell.content_canvas = mock.MagicMock()
        layout = mock.MagicMock()
        layout.content_x = content_x
        layout.content_width = content_width
        layout.message_area_top = top
        layout.message_area_bottom = bottom
        layout.portrait = portrait
        shell.layout = layout
        shell.chip_value_font = mock.MagicMock()
        shell.chip_value_font.metrics.return_value = 18
        shell.chip_label_font = mock.MagicMock()
        shell.chip_label_font.actual.return_value = "Segoe UI"
        shell.chip_label_font.metrics.return_value = 16
        shell.chip_label_font.measure.return_value = 100
        return PhotoSlideshowPanel(
            mock.MagicMock(),
            shell,
            {"mutedTextColor": "#94a3b8", "textColor": "#f8fafc"},
        )

    def test_landscape_uses_full_content_width(self):
        panel = self._panel(portrait=False, content_x=100, content_width=1400)
        photo_cx, _cy, max_w, _max_h, layout = panel._photo_stage_geometry()
        self.assertEqual(max_w, 1400 - 40)
        self.assertEqual(photo_cx, 100 + 1400 // 2)
        self.assertEqual(photo_cx, layout.content_x + layout.content_width // 2)

    def test_portrait_uses_full_content_width(self):
        panel = self._panel(portrait=True, content_x=40, content_width=800)
        photo_cx, _cy, max_w, _max_h, _layout = panel._photo_stage_geometry()
        self.assertEqual(max_w, 800 - 40)
        self.assertEqual(photo_cx, 40 + 800 // 2)

    def test_scan_qr_badge_sits_inside_photo_lower_right(self):
        panel = self._panel(portrait=False, content_x=100, content_width=1400,
                            top=100, bottom=800)

        class FakeQr:
            width = 180
            height = 180

        fitted = mock.MagicMock()
        fitted.metrics.return_value = 18
        fitted.measure.return_value = 180

        photo_cx, photo_cy = 700.0, 450.0
        photo_w, photo_h = 900, 600

        with mock.patch.object(QrPanel, "_build_qr_image", return_value=FakeQr()), \
                mock.patch.object(panel, "_fit_scan_qr_caption_font", return_value=fitted), \
                mock.patch("src.display_panels.ImageTk") as image_tk:
            image_tk.PhotoImage.return_value = mock.MagicMock()
            photo = panel._draw_scan_qr_badge(
                "https://nas/qr-images/a.jpg",
                photo_cx=photo_cx,
                photo_cy=photo_cy,
                photo_w=photo_w,
                photo_h=photo_h,
            )
        self.assertIsNotNone(photo)

        image_calls = list(panel.canvas.create_image.call_args_list)
        self.assertEqual(len(image_calls), 1)
        qx, qy = image_calls[0].args[:2]
        margin = panel._SCAN_QR_MARGIN
        right = photo_cx + photo_w / 2 - margin
        bottom = photo_cy + photo_h / 2 - margin
        self.assertAlmostEqual(qx + FakeQr.width / 2, right)
        self.assertAlmostEqual(qy + FakeQr.height / 2, bottom)

        # Caption is centered above the QR (anchor s), labeled "Scan for photo".
        text_calls = panel.canvas.create_text.call_args_list
        self.assertTrue(text_calls)
        args, kwargs = text_calls[-1]
        self.assertEqual(args[0], qx)
        self.assertEqual(kwargs.get("anchor"), "s")
        self.assertEqual(kwargs.get("text"), "Scan for photo")
        self.assertEqual(kwargs.get("fill"), "#f8fafc")

    def test_scan_qr_caption_constant(self):
        self.assertEqual(PhotoSlideshowPanel._SCAN_QR_CAPTION, "Scan for photo")


if __name__ == "__main__":
    unittest.main()
