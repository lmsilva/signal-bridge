"""Free, no-key "interesting facts about this place" lookups for the Route
Planner display — wraps the Wikipedia REST summary API with the same
User-Agent + SSL-fallback pattern already used for map tiles / album art.
"""
import json
import re
import ssl
import urllib.parse
import urllib.request

from src.map_tiles import is_ssl_failure

WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
WIKIPEDIA_SEARCH_URL = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "alexa-broadcast-client/1.0 (personal home display)"

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# Frozen builds without a bundled CA store fail the default SSL context; once
# that happens we remember it and skip straight to the unverified context for
# the rest of the process (same convention as `map_tiles._unverified_ssl`).
_unverified_ssl = False


def _fetch_json(url: str) -> dict:
    global _unverified_ssl

    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )

    def download(context):
        with urllib.request.urlopen(request, timeout=10, context=context) as response:
            return json.loads(response.read().decode("utf-8"))

    context = ssl._create_unverified_context() if _unverified_ssl else ssl.create_default_context()
    try:
        return download(context)
    except Exception as error:
        if not _unverified_ssl and is_ssl_failure(error):
            data = download(ssl._create_unverified_context())
            _unverified_ssl = True
            return data
        raise


def truncate_summary(text: str | None, max_sentences: int = 2, max_chars: int = 280) -> str:
    """Trims a Wikipedia extract down to ~1-2 sentences for a small display tile."""
    sentences = _SENTENCE_SPLIT_RE.split(str(text or "").strip())
    truncated = " ".join(s for s in sentences[:max_sentences] if s).strip()
    if len(truncated) > max_chars:
        head = truncated[:max_chars].rsplit(" ", 1)[0].rstrip(" ,;:")
        truncated = f"{head}…"
    return truncated


def _fetch_summary_for_title(title_text: str) -> dict | None:
    title = urllib.parse.quote(title_text.replace(" ", "_"))
    url = WIKIPEDIA_SUMMARY_URL.format(title=title)

    try:
        data = _fetch_json(url)
    except Exception:
        return None

    if not isinstance(data, dict) or data.get("type") == "disambiguation":
        return None

    extract = truncate_summary(data.get("extract"))
    if not extract:
        return None

    page_url = ((data.get("content_urls") or {}).get("desktop") or {}).get("page")
    return {
        "title": data.get("title") or title_text,
        "extract": extract,
        "url": page_url,
    }


def _search_best_title(query: str) -> str | None:
    """Resolves free-text (e.g. a geocoder's "City, ST, US" result) to the
    Wikipedia article title actually likely to exist (e.g. "Saratoga
    Springs, Utah") via MediaWiki's plain-text search — used as a fallback
    when the literal name isn't itself an article title.
    """
    params = urllib.parse.urlencode(
        {"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": 1}
    )
    url = f"{WIKIPEDIA_SEARCH_URL}?{params}"

    try:
        data = _fetch_json(url)
    except Exception:
        return None

    results = ((data or {}).get("query") or {}).get("search") or []
    if not results:
        return None
    return results[0].get("title") or None


def fetch_place_summary(name: str | None) -> dict | None:
    """Short Wikipedia summary for a place name.

    Returns `{title, extract, url}` or `None` when there's no article, it's a
    disambiguation page, or the request fails — callers should treat a `None`
    as "no facts available for this tile", not a hard error. Geocoded place
    names (e.g. "Home, US") rarely match a Wikipedia title
    verbatim (the real article is "Saratoga Springs, Utah"), so a failed
    direct lookup falls back to MediaWiki search to resolve the real title.
    """
    query = str(name or "").strip()
    if not query:
        return None

    summary = _fetch_summary_for_title(query)
    if summary is not None:
        return summary

    best_title = _search_best_title(query)
    if not best_title or best_title.strip().lower() == query.lower():
        return None
    return _fetch_summary_for_title(best_title)
