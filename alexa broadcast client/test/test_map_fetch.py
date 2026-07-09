import ssl
import unittest
import urllib.error

from src.display_panels import TeslaDashboardPanel


class MapFetchHelperTests(unittest.TestCase):
    def test_is_ssl_failure_unwraps_urlerror(self):
        cert_error = ssl.SSLCertVerificationError(
            1, "certificate verify failed: unable to get local issuer certificate"
        )
        wrapped = urllib.error.URLError(cert_error)
        self.assertTrue(TeslaDashboardPanel._is_ssl_failure(wrapped))

    def test_is_ssl_failure_direct_ssl_error(self):
        self.assertTrue(TeslaDashboardPanel._is_ssl_failure(ssl.SSLError("handshake failure")))

    def test_is_ssl_failure_rejects_plain_network_errors(self):
        self.assertFalse(TeslaDashboardPanel._is_ssl_failure(urllib.error.URLError(TimeoutError("timed out"))))
        self.assertFalse(TeslaDashboardPanel._is_ssl_failure(ConnectionResetError("reset")))

    def test_latlon_to_global_px_center_of_map(self):
        x, y = TeslaDashboardPanel._latlon_to_global_px(0.0, 0.0, 1)
        self.assertAlmostEqual(x, 256.0)
        self.assertAlmostEqual(y, 256.0)


if __name__ == "__main__":
    unittest.main()
