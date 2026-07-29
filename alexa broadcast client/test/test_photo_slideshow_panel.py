import base64
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from PIL import Image

from src.display_panels import PhotoSlideshowPanel, QrPanel
from src.shared_photos_page import (
    circular_mean_hue,
    compute_layout,
    counter_label,
    fit_photo_for_box,
    next_in_seconds,
    rail_remaining_fraction,
    rgb_to_hsl,
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

    def test_meta_strings_keep_time_on_eyebrow_when_caption_present(self):
        from src.shared_photos_page import SharedPhotosRenderer
        page = SharedPhotosRenderer.__new__(SharedPhotosRenderer)
        eyebrow, primary = page._meta_strings(
            "upload", "2026-07-28T23:58:00Z", "Scan to save this photo",
        )
        self.assertIn("UPLOADED", eyebrow)
        self.assertIn("·", eyebrow)
        self.assertEqual(primary, "Scan to save this photo")

    def test_wrapped_caption_is_taller_than_one_line(self):
        import tkinter as tk
        from src.shared_photos_page import SharedPhotosRenderer, compute_layout

        root = tk.Tk()
        root.withdraw()
        canvas = tk.Canvas(root, width=400, height=400)
        page = SharedPhotosRenderer(canvas, shell=None, config={}, track=lambda i: i)
        page._layout = compute_layout(1920, 1080, mode="upload")
        font = page._u_font(mono=False, size_u=32)
        narrow = 160.0
        one = page._text_block_height(font, "Hi", narrow)
        many = page._text_block_height(font, "Scan to save this photo", narrow)
        root.destroy()
        self.assertGreater(many, one * 1.5)

    def test_sample_mat_accent_falls_back_for_near_black(self):
        dark = Image.new("RGB", (32, 32), (2, 2, 2))
        mat, accent = sample_mat_accent(dark)
        self.assertEqual(mat, NEUTRAL_MAT)

    def test_circular_mean_hue_wraps_around_red(self):
        # Numeric average of 350 and 10 is 180 (cyan) — circular mean stays red.
        mean = circular_mean_hue([350.0, 10.0])
        self.assertLess(min(mean, 360.0 - mean), 8.0)

    def test_sample_mat_uses_dominant_hue_not_rgb_mean(self):
        """Blue sky + green grass + warm skin must not collapse to muddy brown."""
        w = h = 48
        pixels = []
        n = w * h
        for i in range(n):
            if i < int(0.70 * n):
                pixels.append((30, 100, 210))  # blue
            elif i < int(0.85 * n):
                pixels.append((50, 170, 70))  # green
            else:
                pixels.append((210, 155, 120))  # warm skin
        img = Image.new("RGB", (w, h))
        img.putdata(pixels)
        mat, accent = sample_mat_accent(img)
        self.assertNotEqual(mat, NEUTRAL_MAT)
        ar = int(accent[1:3], 16) / 255.0
        ag = int(accent[3:5], 16) / 255.0
        ab = int(accent[5:7], 16) / 255.0
        hue, sat, _l = rgb_to_hsl(ar, ag, ab)
        # Dominant bin is blue (~210°); RGB-mean mud sits ~20–40° brown.
        self.assertGreaterEqual(hue, 180.0)
        self.assertLessEqual(hue, 260.0)
        self.assertGreater(sat, 0.2)
        self.assertGreater(ab, ar)
        self.assertGreater(ab, ag)

    def test_sample_mat_blue_photo_is_cool_not_brown(self):
        img = Image.new("RGB", (48, 48), (40, 110, 220))
        mat, accent = sample_mat_accent(img)
        mr = int(mat[1:3], 16)
        mg = int(mat[3:5], 16)
        mb = int(mat[5:7], 16)
        # Dark blue mat: blue channel leads; not equal warm brown.
        self.assertGreater(mb, mr)
        self.assertGreater(mb, mg)
        self.assertLess(mr + mg, mb * 2.2)

    def test_sample_mat_skin_heavy_avoids_chocolate_brown(self):
        """Skin/wood majority without cool accents → charcoal tint, not #5a3a20 brown."""
        img = Image.new("RGB", (48, 48), (210, 155, 120))
        mat, _accent = sample_mat_accent(img)
        mr = int(mat[1:3], 16)
        mg = int(mat[3:5], 16)
        mb = int(mat[5:7], 16)
        # Near-black: all channels low; no strong orange cast (R >> B).
        self.assertLess(max(mr, mg, mb), 45)
        self.assertLess(mr - mb, 18)

    def test_sample_mat_green_photo_tints_green(self):
        img = Image.new("RGB", (48, 48), (40, 170, 70))
        mat, accent = sample_mat_accent(img)
        self.assertNotEqual(mat, NEUTRAL_MAT)
        ag = int(accent[3:5], 16)
        ar = int(accent[1:3], 16)
        ab = int(accent[5:7], 16)
        self.assertGreater(ag, ar)
        self.assertGreater(ag, ab)

    def test_rail_remaining_matches_next_in_clock(self):
        started = 1_000_000.0
        dwell_ms = 5000
        # t=0 → full bar + NEXT IN 5
        self.assertAlmostEqual(
            rail_remaining_fraction(started, dwell_ms, now=started), 1.0,
        )
        self.assertEqual(next_in_seconds(started, 5, now=started), 5)
        # halfway → half bar + NEXT IN 3 (elapsed int 2)
        mid = started + 2.5
        self.assertAlmostEqual(
            rail_remaining_fraction(started, dwell_ms, now=mid), 0.5,
        )
        self.assertEqual(next_in_seconds(started, 5, now=mid), 3)
        # dwell complete → empty bar + NEXT IN 0 (advance fires)
        end = started + 5.0
        self.assertAlmostEqual(
            rail_remaining_fraction(started, dwell_ms, now=end), 0.0,
        )
        self.assertEqual(next_in_seconds(started, 5, now=end), 0)

    def test_rail_fill_grows_with_elapsed_not_remaining(self):
        """Accent bar loads left→right / top→bottom via elapsed = 1 − remaining."""
        # remaining 1.0 → just started → zero fill; remaining 0.0 → full elapsed.
        for remaining in (1.0, 0.75, 0.5, 0.25, 0.0):
            elapsed = 1.0 - remaining
            self.assertGreaterEqual(elapsed, 0.0)
            self.assertLessEqual(elapsed, 1.0)
            # As remaining shrinks, elapsed (fill fraction) grows.
            if remaining < 1.0:
                self.assertGreater(elapsed, 0.0)
        self.assertAlmostEqual(1.0 - rail_remaining_fraction(0, 1000, now=0), 0.0)
        self.assertAlmostEqual(1.0 - rail_remaining_fraction(0, 1000, now=0.5), 0.5)
        self.assertAlmostEqual(1.0 - rail_remaining_fraction(0, 1000, now=1.0), 1.0)


if __name__ == "__main__":
    unittest.main()
