import json
import re
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
SSL_CONTEXT = ssl.create_default_context()

WEATHER_CODE_LABELS = {
    0: "clear",
    1: "mainly_clear",
    2: "partly_cloudy",
    3: "overcast",
    45: "fog",
    48: "fog",
    51: "drizzle",
    53: "drizzle",
    55: "drizzle",
    61: "rain",
    63: "rain",
    65: "rain",
    71: "snow",
    73: "snow",
    75: "snow",
    77: "snow",
    80: "rain_showers",
    81: "rain_showers",
    82: "rain_showers",
    85: "snow_showers",
    86: "snow_showers",
    95: "thunderstorm",
    96: "thunderstorm",
    99: "thunderstorm",
}


_NAMED_LOCATION_PATTERNS = (
    re.compile(r"\bweather(?:\s+like)?\s+(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})", re.I),
    re.compile(
        r"\btemperature(?:\s+outside|\s+today|\s+now|\s+in|\s+for|\s+at)?\s+(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})",
        re.I,
    ),
    re.compile(r"\bhow(?:'s|\s+is)\s+(?:the\s+weather\s+)?(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})", re.I),
    re.compile(r"\b(?:in|for|at)\s+([a-z][a-z\s,'-]{1,60})\s+(?:weather|temperature|forecast)\b", re.I),
)
_SPOKEN_LOCATION_PATTERNS = (
    re.compile(
        r"\b(?:currently|right\s+now)\s+in\s+([a-z][a-z\s,'-]{1,60}?)(?:,|\s+it(?:'s|\s+is|\s+will)|\s+the\s+weather|\s+there|\s*$)",
        re.I,
    ),
    re.compile(
        r"\bin\s+([a-z][a-z\s,'-]{1,60}?)(?:,|\s+it(?:'s|\s+is|\s+will)|\s+the\s+weather|\s+right\s+now|\s+there|\s*$)",
        re.I,
    ),
    re.compile(
        r"\b(?:it(?:'s|\s+is)|there(?:'s|\s+is))\s+(?:\d{1,3}\s+degrees?(?:\s+fahrenheit|\s+celsius)?(?:\s+and\s+[a-z]+)?\s+)?in\s+([a-z][a-z\s,'-]{1,60})\b",
        re.I,
    ),
)


def _clean_location_name(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "").strip())
    cleaned = re.sub(
        r"\b(?:right\s+now|today|tonight|tomorrow|this\s+week|please|alexa)\b.*$",
        "",
        cleaned,
        flags=re.I,
    )
    return cleaned.rstrip("?.!, ").strip()


def normalize_transcript(value: str | None) -> str:
    text = str(value or "")
    text = re.sub(r"[\u2018\u2019\u2032`´]", "'", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_named_location(*texts: str | None) -> str | None:
    for text in texts:
        normalized = normalize_transcript(text)
        if not normalized:
            continue
        for pattern in (*_NAMED_LOCATION_PATTERNS, *_SPOKEN_LOCATION_PATTERNS):
            match = pattern.search(normalized)
            if not match:
                continue
            name = _clean_location_name(match.group(1))
            if len(name) >= 2:
                return name
    return None


def celsius_to_fahrenheit(celsius: float) -> int:
    return round((celsius * 9 / 5) + 32)


def weather_code_to_condition(code: int | float | None) -> str:
    if code is None:
        label = "unknown"
    else:
        label = WEATHER_CODE_LABELS.get(int(code), "unknown")
    if "snow" in label:
        return "snowy"
    if "rain" in label or "drizzle" in label or "shower" in label:
        return "rainy"
    if "cloud" in label or label in ("overcast", "fog"):
        return "cloudy"
    if "clear" in label:
        return "sunny"
    if "thunder" in label:
        return "stormy"
    return "unknown"


def _fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "alexa-broadcast-client/1.0"},
    )
    with urllib.request.urlopen(request, timeout=15, context=SSL_CONTEXT) as response:
        return json.loads(response.read().decode("utf-8"))


def geocode_location(name: str | None) -> dict | None:
    query = (name or "").strip()
    if not query:
        return None

    params = urllib.parse.urlencode(
        {"name": query, "count": 1, "language": "en", "format": "json"}
    )
    data = _fetch_json(f"{GEOCODE_URL}?{params}")
    hit = (data.get("results") or [None])[0]
    if not hit:
        return None

    return {
        "resolvedName": ", ".join(
            part for part in (hit.get("name"), hit.get("admin1"), hit.get("country_code")) if part
        ),
        "latitude": hit.get("latitude"),
        "longitude": hit.get("longitude"),
        "timezone": hit.get("timezone"),
    }


def resolve_location_for_fetch(
    location: dict | None,
    default_location: dict | None,
    spoken_response: str | None = None,
    query_text: str | None = None,
) -> dict | None:
    location = dict(location or {})
    default_location = default_location or {}

    named_query = None
    if location.get("scope") == "named":
        query = str(location.get("query") or "").strip()
        if query and query.lower() != "local":
            named_query = query

    if not named_query:
        named_query = extract_named_location(query_text, spoken_response, location.get("query"))

    if named_query:
        geocoded = geocode_location(named_query)
        if geocoded:
            return {
                **location,
                **geocoded,
                "scope": "named",
                "query": named_query,
            }
        return None

    if location.get("latitude") is not None and location.get("longitude") is not None:
        return location

    for candidate in (
        location.get("resolvedName"),
        location.get("query") if str(location.get("query", "")).lower() != "local" else None,
    ):
        if not candidate:
            continue
        geocoded = geocode_location(str(candidate))
        if geocoded:
            return {**location, **geocoded}

    if default_location.get("latitude") is not None and default_location.get("longitude") is not None:
        return {
            **location,
            "resolvedName": default_location.get("name") or location.get("resolvedName"),
            "latitude": default_location["latitude"],
            "longitude": default_location["longitude"],
            "timezone": default_location.get("timezone") or location.get("timezone"),
        }

    return None


def _coords_differ(left: dict | None, right: dict | None, epsilon: float = 0.5) -> bool:
    if not left or not right:
        return False
    left_lat = left.get("latitude")
    left_lon = left.get("longitude")
    right_lat = right.get("latitude")
    right_lon = right.get("longitude")
    if left_lat is None or left_lon is None or right_lat is None or right_lon is None:
        return False
    return abs(float(left_lat) - float(right_lat)) > epsilon or abs(float(left_lon) - float(right_lon)) > epsilon


def _parse_api_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _hourly_start_index(times: list[str]) -> int:
    now = datetime.now(timezone.utc)
    for index, value in enumerate(times):
        try:
            slot_time = _parse_api_time(value)
        except ValueError:
            continue
        if slot_time >= now:
            return index
    return 0


def fetch_weather_forecast(location: dict) -> dict | None:
    latitude = location.get("latitude")
    longitude = location.get("longitude")
    if latitude is None or longitude is None:
        return None

    params = urllib.parse.urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": ",".join(
                [
                    "temperature_2m",
                    "apparent_temperature",
                    "relative_humidity_2m",
                    "weather_code",
                    "wind_speed_10m",
                    "precipitation",
                ]
            ),
            "hourly": ",".join(
                [
                    "temperature_2m",
                    "precipitation_probability",
                    "weather_code",
                    "wind_speed_10m",
                ]
            ),
            "daily": ",".join(
                [
                    "weather_code",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "precipitation_probability_max",
                    "wind_speed_10m_max",
                ]
            ),
            "forecast_days": 7,
            "timezone": location.get("timezone") or "auto",
            "temperature_unit": "celsius",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
        },
        doseq=True,
    )

    data = _fetch_json(f"{FORECAST_URL}?{params}")
    current = data.get("current") or {}
    current_c = current.get("temperature_2m")
    current_code = current.get("weather_code")

    hourly_times = data.get("hourly", {}).get("time") or []
    hourly_temps = data.get("hourly", {}).get("temperature_2m") or []
    hourly_rain = data.get("hourly", {}).get("precipitation_probability") or []
    hourly_wind = data.get("hourly", {}).get("wind_speed_10m") or []
    hourly_codes = data.get("hourly", {}).get("weather_code") or []
    start_index = _hourly_start_index(hourly_times)
    hourly = []
    for offset, time_value in enumerate(hourly_times[start_index : start_index + 24]):
        index = start_index + offset
        temp_c = hourly_temps[index] if index < len(hourly_temps) else None
        hourly.append(
            {
                "time": time_value,
                "temperatureC": temp_c,
                "temperatureF": celsius_to_fahrenheit(temp_c) if temp_c is not None else None,
                "precipitationProbability": hourly_rain[index] if index < len(hourly_rain) else None,
                "windSpeedMph": hourly_wind[index] if index < len(hourly_wind) else None,
                "condition": weather_code_to_condition(hourly_codes[index] if index < len(hourly_codes) else None),
            }
        )

    daily_times = data.get("daily", {}).get("time") or []
    daily_highs = data.get("daily", {}).get("temperature_2m_max") or []
    daily_lows = data.get("daily", {}).get("temperature_2m_min") or []
    daily_rain = data.get("daily", {}).get("precipitation_probability_max") or []
    daily_wind = data.get("daily", {}).get("wind_speed_10m_max") or []
    daily_codes = data.get("daily", {}).get("weather_code") or []
    daily = []
    for index, date_value in enumerate(daily_times):
        high_c = daily_highs[index] if index < len(daily_highs) else None
        low_c = daily_lows[index] if index < len(daily_lows) else None
        daily.append(
            {
                "date": date_value,
                "highC": high_c,
                "lowC": low_c,
                "highF": celsius_to_fahrenheit(high_c) if high_c is not None else None,
                "lowF": celsius_to_fahrenheit(low_c) if low_c is not None else None,
                "precipitationProbability": daily_rain[index] if index < len(daily_rain) else None,
                "windSpeedMph": daily_wind[index] if index < len(daily_wind) else None,
                "condition": weather_code_to_condition(daily_codes[index] if index < len(daily_codes) else None),
            }
        )

    return {
        "location": {
            **location,
            "resolvedName": location.get("resolvedName") or location.get("query"),
            "latitude": latitude,
            "longitude": longitude,
            "timezone": data.get("timezone") or location.get("timezone"),
        },
        "current": {
            "temperatureC": current_c,
            "temperatureF": celsius_to_fahrenheit(current_c) if current_c is not None else None,
            "feelsLikeC": current.get("apparent_temperature"),
            "feelsLikeF": (
                celsius_to_fahrenheit(current["apparent_temperature"])
                if current.get("apparent_temperature") is not None
                else None
            ),
            "humidity": current.get("relative_humidity_2m"),
            "windSpeedMph": current.get("wind_speed_10m"),
            "precipitationIn": current.get("precipitation"),
            "condition": weather_code_to_condition(current_code),
            "weatherCode": current_code,
        },
        "next24Hours": hourly,
        "next7Days": daily,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def has_forecast_data(weather: dict | None) -> bool:
    if not weather:
        return False
    return bool(weather.get("next24Hours")) and bool(weather.get("next7Days"))


def enrich_weather_payload(payload: dict, config: dict) -> dict:
    if payload.get("type") != "weather.query":
        return payload

    default_location = config.get("defaultLocation") or {}
    resolved = resolve_location_for_fetch(
        payload.get("location"),
        default_location,
        payload.get("spokenResponse"),
        payload.get("query"),
    )
    if not resolved:
        return payload

    weather = payload.get("weather")
    if has_forecast_data(weather):
        forecast_location = (weather or {}).get("location") or {}
        if not _coords_differ(resolved, forecast_location):
            if resolved.get("resolvedName") and resolved.get("resolvedName") != forecast_location.get("resolvedName"):
                enriched = dict(payload)
                enriched["location"] = {**forecast_location, **resolved}
                return enriched
            return payload

    try:
        fetched = fetch_weather_forecast(resolved)
    except (OSError, TimeoutError, json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as error:
        print(f"Weather forecast fetch failed: {error}", file=sys.stderr)
        return payload

    if not fetched:
        return payload

    enriched = dict(payload)
    enriched["location"] = fetched.get("location") or resolved
    enriched["weather"] = fetched
    return enriched
