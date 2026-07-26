import ssl
import unittest
import urllib.error

from src import map_tiles


class MapFetchHelperTests(unittest.TestCase):
    def test_is_ssl_failure_unwraps_urlerror(self):
        cert_error = ssl.SSLCertVerificationError(
            1, "certificate verify failed: unable to get local issuer certificate"
        )
        wrapped = urllib.error.URLError(cert_error)
        self.assertTrue(map_tiles.is_ssl_failure(wrapped))

    def test_is_ssl_failure_direct_ssl_error(self):
        self.assertTrue(map_tiles.is_ssl_failure(ssl.SSLError("handshake failure")))

    def test_is_ssl_failure_rejects_plain_network_errors(self):
        self.assertFalse(map_tiles.is_ssl_failure(urllib.error.URLError(TimeoutError("timed out"))))
        self.assertFalse(map_tiles.is_ssl_failure(ConnectionResetError("reset")))

    def test_latlon_to_global_px_center_of_map(self):
        x, y = map_tiles.latlon_to_global_px(0.0, 0.0, 1)
        self.assertAlmostEqual(x, 256.0)
        self.assertAlmostEqual(y, 256.0)

    def test_global_px_to_latlon_is_the_inverse_of_latlon_to_global_px(self):
        for lat, lon, zoom in [(40.0, -111.0, 12), (38.5733, -109.5498, 8), (0.0, 0.0, 4)]:
            x, y = map_tiles.latlon_to_global_px(lat, lon, zoom)
            round_trip_lat, round_trip_lon = map_tiles.global_px_to_latlon(x, y, zoom)
            self.assertAlmostEqual(round_trip_lat, lat, places=6)
            self.assertAlmostEqual(round_trip_lon, lon, places=6)


class ZoomToFitTests(unittest.TestCase):
    SARATOGA_SPRINGS = (40.0, -111.0)
    MOAB = (38.5733, -109.5498)

    def test_zoom_to_fit_returns_a_zoom_where_both_points_fit_in_the_box(self):
        zoom, center_lat, center_lon = map_tiles.zoom_to_fit(
            *self.SARATOGA_SPRINGS, *self.MOAB, 600, 500,
        )
        px1 = map_tiles.project_to_pixels(*self.SARATOGA_SPRINGS, center_lat, center_lon, zoom, 600, 500)
        px2 = map_tiles.project_to_pixels(*self.MOAB, center_lat, center_lon, zoom, 600, 500)
        self.assertTrue(2 <= zoom <= 15)
        # Both points should land within (or very near) the box after zooming to fit.
        for px, py in (px1, px2):
            self.assertGreater(px, -20)
            self.assertLess(px, 620)
            self.assertGreater(py, -20)
            self.assertLess(py, 520)

    def test_zoom_to_fit_uses_a_tighter_zoom_for_nearby_points(self):
        near_zoom, _, _ = map_tiles.zoom_to_fit(40.0, -111.0, 40.35, -111.90, 600, 500)
        far_zoom, _, _ = map_tiles.zoom_to_fit(*self.SARATOGA_SPRINGS, *self.MOAB, 600, 500)
        self.assertGreater(near_zoom, far_zoom)

    def test_zoom_to_fit_falls_back_to_min_zoom_for_antipodal_points(self):
        zoom, _, _ = map_tiles.zoom_to_fit(0.0, 0.0, 0.0, 179.0, 600, 500, min_zoom=2, max_zoom=15)
        self.assertEqual(zoom, 2)

    def test_project_points_to_pixels_maps_a_route_line(self):
        zoom, center_lat, center_lon = map_tiles.zoom_to_fit(
            *self.SARATOGA_SPRINGS, *self.MOAB, 600, 500,
        )
        points = map_tiles.project_points_to_pixels(
            [self.SARATOGA_SPRINGS, self.MOAB], center_lat, center_lon, zoom, 600, 500,
        )
        self.assertEqual(len(points), 2)
        self.assertNotEqual(points[0], points[1])


if __name__ == "__main__":
    unittest.main()
