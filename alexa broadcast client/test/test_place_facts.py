import json
import ssl
import unittest
from unittest import mock
from urllib.error import URLError

from src import place_facts


class TruncateSummaryTests(unittest.TestCase):
    def test_truncate_summary_keeps_first_two_sentences(self):
        text = "Moab is a city in Utah. It is known for red rock canyons. It also hosts Jeep Safari."
        result = place_facts.truncate_summary(text)
        self.assertEqual(result, "Moab is a city in Utah. It is known for red rock canyons.")

    def test_truncate_summary_handles_empty_text(self):
        self.assertEqual(place_facts.truncate_summary(None), "")
        self.assertEqual(place_facts.truncate_summary(""), "")

    def test_truncate_summary_hard_caps_very_long_single_sentence(self):
        long_sentence = "Moab " + ("is a very long place name description word " * 20) + "."
        result = place_facts.truncate_summary(long_sentence, max_chars=80)
        self.assertLessEqual(len(result), 81)
        self.assertTrue(result.endswith("…"))


class FetchPlaceSummaryTests(unittest.TestCase):
    def setUp(self):
        place_facts._unverified_ssl = False

    def tearDown(self):
        place_facts._unverified_ssl = False

    def _mock_response(self, payload: dict):
        response = mock.MagicMock()
        response.read.return_value = json.dumps(payload).encode("utf-8")
        response.__enter__.return_value = response
        return response

    def test_fetch_place_summary_returns_title_extract_and_url(self):
        payload = {
            "title": "Moab, Utah",
            "extract": "Moab is a city in Grand County, Utah, United States.",
            "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Moab,_Utah"}},
        }
        with mock.patch("src.place_facts.urllib.request.urlopen", return_value=self._mock_response(payload)):
            result = place_facts.fetch_place_summary("Moab, Utah")
        self.assertEqual(result["title"], "Moab, Utah")
        self.assertIn("Moab is a city", result["extract"])
        self.assertEqual(result["url"], "https://en.wikipedia.org/wiki/Moab,_Utah")

    def test_fetch_place_summary_returns_none_for_disambiguation_pages(self):
        payload = {"title": "Springfield", "type": "disambiguation", "extract": "Springfield may refer to..."}
        with mock.patch("src.place_facts.urllib.request.urlopen", return_value=self._mock_response(payload)):
            result = place_facts.fetch_place_summary("Springfield")
        self.assertIsNone(result)

    def test_fetch_place_summary_returns_none_when_extract_is_blank(self):
        payload = {"title": "X", "extract": "  "}
        with mock.patch("src.place_facts.urllib.request.urlopen", return_value=self._mock_response(payload)):
            result = place_facts.fetch_place_summary("X")
        self.assertIsNone(result)

    def test_fetch_place_summary_returns_none_for_an_empty_name(self):
        self.assertIsNone(place_facts.fetch_place_summary(""))
        self.assertIsNone(place_facts.fetch_place_summary(None))

    def test_fetch_place_summary_returns_none_on_persistent_network_failure(self):
        with mock.patch(
            "src.place_facts.urllib.request.urlopen",
            side_effect=URLError("connection refused"),
        ):
            result = place_facts.fetch_place_summary("Moab")
        self.assertIsNone(result)

    def test_fetch_place_summary_falls_back_to_search_when_direct_title_has_no_article(self):
        # Geocoded names like "Home, US" rarely match a
        # Wikipedia title verbatim (real article: "Saratoga Springs, Utah").
        search_payload = {"query": {"search": [{"title": "Saratoga Springs, Utah"}]}}
        summary_payload = {
            "title": "Saratoga Springs, Utah",
            "extract": "Saratoga Springs is a city in Utah County, Utah, United States.",
            "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Saratoga_Springs,_Utah"}},
        }

        def fake_urlopen(request, timeout=None, context=None):
            url = request.full_url
            if "rest_v1/page/summary/Saratoga_Springs%2C_UT%2C_US" in url:
                raise URLError("not found")
            if "action=query" in url:
                return self._mock_response(search_payload)
            if "rest_v1/page/summary/Saratoga_Springs%2C_Utah" in url:
                return self._mock_response(summary_payload)
            raise AssertionError(f"unexpected url: {url}")

        with mock.patch("src.place_facts.urllib.request.urlopen", side_effect=fake_urlopen):
            result = place_facts.fetch_place_summary("Home, US")

        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Saratoga Springs, Utah")
        self.assertIn("Saratoga Springs is a city", result["extract"])

    def test_fetch_place_summary_returns_none_when_search_finds_nothing_new(self):
        def fake_urlopen(request, timeout=None, context=None):
            url = request.full_url
            if "action=query" in url:
                return self._mock_response({"query": {"search": []}})
            raise URLError("not found")

        with mock.patch("src.place_facts.urllib.request.urlopen", side_effect=fake_urlopen):
            result = place_facts.fetch_place_summary("Nowhereville, ZZ, XX")
        self.assertIsNone(result)

    def test_fetch_place_summary_avoids_infinite_loop_when_search_echoes_the_same_title(self):
        def fake_urlopen(request, timeout=None, context=None):
            url = request.full_url
            if "action=query" in url:
                return self._mock_response({"query": {"search": [{"title": "Moab"}]}})
            raise URLError("not found")

        with mock.patch("src.place_facts.urllib.request.urlopen", side_effect=fake_urlopen):
            result = place_facts.fetch_place_summary("Moab")
        self.assertIsNone(result)

    def test_fetch_place_summary_falls_back_to_unverified_ssl_context(self):
        payload = {"title": "Moab", "extract": "Moab is a city in Utah."}
        calls = []
        first_call_failed = False

        def fake_urlopen(request, timeout=None, context=None):
            nonlocal first_call_failed
            calls.append(context)
            if not first_call_failed:
                first_call_failed = True
                raise URLError(ssl.SSLError("CERTIFICATE_VERIFY_FAILED"))
            return self._mock_response(payload)

        with mock.patch("src.place_facts.urllib.request.urlopen", side_effect=fake_urlopen):
            result = place_facts.fetch_place_summary("Moab")
        self.assertIsNotNone(result)
        self.assertEqual(len(calls), 2)
        self.assertTrue(place_facts._unverified_ssl)


if __name__ == "__main__":
    unittest.main()
