from datetime import datetime, timezone


import re


def resolve_display_type(payload: dict) -> str:
    explicit = payload.get("type")
    if explicit in ("broadcast", "time.query", "weather.query", "indoor-temperature.query", "air-quality.query", "timer.snapshot"):
        return explicit

    if payload.get("message"):
        return "broadcast"

    return ""


def is_display_payload(payload: dict) -> bool:
    return bool(resolve_display_type(payload))


def title_for_display_type(display_type: str) -> tuple[str, str]:
    titles = {
        "broadcast": ("Alexa Broadcast", "Received"),
        "time.query": ("Alexa", "Time"),
        "weather.query": ("Alexa", "Weather"),
        "indoor-temperature.query": ("Alexa", "Indoor"),
        "air-quality.query": ("Alexa", "Air Quality"),
        "timer.snapshot": ("Alexa", "Timers"),
    }
    return titles.get(display_type, ("Alexa", "Display"))


def parse_iso_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def format_chip_timestamp(value: str) -> str:
    parsed = parse_iso_timestamp(value)
    if parsed:
        return parsed.astimezone().strftime("%b %d · %I:%M %p")
    return value or datetime.now().astimezone().strftime("%b %d · %I:%M %p")


def format_duration(seconds: int | float | None) -> str:
    if seconds is None:
        return "—"
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_timer_clock(seconds: int | float | None) -> str:
    if seconds is None:
        return "—"
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def format_timer_set_label(seconds: int | float | None) -> str:
    if seconds is None:
        return "Timer"
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours and minutes == 0 and secs == 0:
        return "1 hour timer" if hours == 1 else f"{hours} hour timer"
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d} timer"
    if secs == 0:
        return "1 min timer" if minutes == 1 else f"{minutes} min timer"
    return f"{minutes}:{secs:02d} timer"


def timer_label_name(timer: dict | None) -> str | None:
    if not timer:
        return None
    label = str(timer.get("label") or "").strip()
    return label or None


def timer_title(timer: dict | None) -> str:
    label = timer_label_name(timer)
    if label:
        return label
    return format_timer_set_label((timer or {}).get("durationSec"))


def timer_detail_line(timer: dict | None, device: str, *, finished: bool = False) -> str:
    parts = [device]
    duration_sec = (timer or {}).get("durationSec")
    if duration_sec is not None:
        parts.append(f"{format_timer_clock(duration_sec)} timer")
    line = " · ".join(parts)
    if finished:
        return f"{line} — finished"
    return line


def normalize_condition(condition: str | None) -> str:
    if not condition:
        return "unknown"

    value = str(condition).lower().replace(" ", "_")
    if "night" in value:
        return "clear-night"
    if "snow" in value:
        return "snowy"
    if "rain" in value or "shower" in value or "drizzle" in value:
        return "rainy"
    if "storm" in value or "thunder" in value:
        return "stormy"
    if "wind" in value:
        return "windy"
    if "cloud" in value or "overcast" in value or "fog" in value:
        return "cloudy"
    if "clear" in value or "sunny" in value:
        return "sunny"
    return "unknown"


def format_weather_location(location: dict | None) -> str:
    if not location:
        return "Weather"

    resolved = location.get("resolvedName")
    query = location.get("query")
    if resolved and str(resolved).lower() != "local":
        return str(resolved)
    if query and str(query).lower() != "local":
        return str(query)
    return "Your area"


def format_indoor_location(location: dict | None) -> str:
    if not location:
        return "Indoor"

    label = location.get("label")
    if label:
        return str(label)

    entity = location.get("entity")
    if entity:
        return str(entity)

    query = location.get("query")
    if query:
        return str(query).title()

    return "Indoor"


def indoor_comfort_band(
    temperature_f: int | float | None,
    *,
    cold_below_f: int = 68,
    hot_above_f: int = 74,
) -> str:
    if temperature_f is None:
        return "unknown"
    try:
        value = float(temperature_f)
    except (TypeError, ValueError):
        return "unknown"
    if value < cold_below_f:
        return "cold"
    if value > hot_above_f:
        return "hot"
    return "comfortable"


_SPOKEN_INDOOR_TEMP_RE = re.compile(
    r"\b(?:oh\s+)?(?:shows?|reads?|currently|it's|it is)\s+(-?\d{1,3}(?:\.\d+)?)\s+degrees?\b",
    re.IGNORECASE,
)
_SPOKEN_INDOOR_TEMP_WITH_LOCATION_RE = re.compile(
    r"\b(-?\d{1,3}(?:\.\d+)?)\s+degrees?\s+(?:on|in|at)\s+(?:the\s+)?(.+?)(?:[.!]|$)",
    re.IGNORECASE,
)
_SPOKEN_INDOOR_TEMP_FALLBACK_RE = re.compile(
    r"\b(-?\d{1,3}(?:\.\d+)?)\s+degrees?\b",
    re.IGNORECASE,
)
_SPOKEN_INDOOR_HUMIDITY_RE = re.compile(
    r"\bhumidity(?:\s+of|\s+on|\s+in|\s+at|\s+for)?\s+[\w\s']+?\s+is\s+(\d{1,3})\s*(?:%|percent)?\b",
    re.IGNORECASE,
)


def parse_spoken_indoor(spoken: str | None) -> dict:
    text = (spoken or "").strip()
    if not text:
        return {}

    parsed: dict = {"summary": text}

    location_match = _SPOKEN_INDOOR_TEMP_WITH_LOCATION_RE.search(text)
    if location_match:
        try:
            parsed["temp_f"] = float(location_match.group(1))
        except ValueError:
            pass
        parsed["location_phrase"] = location_match.group(2).strip().rstrip(".!?")

    if parsed.get("temp_f") is None:
        temp_match = _SPOKEN_INDOOR_TEMP_RE.search(text) or _SPOKEN_INDOOR_TEMP_FALLBACK_RE.search(text)
        if temp_match:
            try:
                parsed["temp_f"] = float(temp_match.group(1))
            except ValueError:
                pass

    humidity_match = _SPOKEN_INDOOR_HUMIDITY_RE.search(text) or re.search(
        r"\bhumidity\s+(?:is\s+)?(\d{1,3})\s*(?:%|percent)?\b",
        text,
        re.IGNORECASE,
    )
    if humidity_match:
        try:
            parsed["humidity"] = int(humidity_match.group(1))
        except ValueError:
            pass

    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0].strip()
    if first_sentence:
        parsed["summary"] = first_sentence

    return parsed


def format_temperature_f(value: float | int | None) -> str:
    if value is None:
        return "—"
    numeric = float(value)
    if numeric.is_integer():
        return f"{int(numeric)}°F"
    return f"{numeric:.1f}°F"


def format_air_quality_location(location: dict | None) -> str:
    if not location:
        return "Air Quality"

    label = location.get("label")
    if label:
        return str(label)

    entity = location.get("entity")
    if entity:
        return str(entity).title()

    query = location.get("query")
    if query:
        return str(query).title()

    return "Air Quality"


def air_quality_band(
    score: int | float | None,
    *,
    good_min: int = 80,
    fair_min: int = 60,
    moderate_min: int = 40,
) -> str:
    if score is None:
        return "unknown"
    try:
        value = float(score)
    except (TypeError, ValueError):
        return "unknown"
    if value >= good_min:
        return "good"
    if value >= fair_min:
        return "fair"
    if value >= moderate_min:
        return "moderate"
    return "poor"


def air_quality_band_label(band: str | None) -> str:
    labels = {
        "good": "Good",
        "fair": "Fair",
        "moderate": "Moderate",
        "poor": "Poor",
        "unknown": "Unknown",
    }
    return labels.get(str(band or "unknown"), "Unknown")


_SPOKEN_AIR_QUALITY_SCORE_RE = re.compile(
    r"(\d{1,3})\s*(?:out\s+of\s+100|/\s*100)\b|"
    r"\bair\s*quality(?:\s+(?:on|in|at|for))?\s+(?:the\s+)?[\w\s']+?\s+(?:is|at)\s+(?:at\s+)?(\d{1,3})\b|"
    r"\bair\s*quality\s+(?:is\s+)?(?:at\s+)?(\d{1,3})\b",
    re.IGNORECASE,
)


def parse_spoken_air_quality(spoken: str | None) -> dict:
    text = (spoken or "").strip()
    if not text:
        return {}

    parsed: dict = {"summary": text}
    score_match = _SPOKEN_AIR_QUALITY_SCORE_RE.search(text)
    if score_match:
        for group in score_match.groups():
            if group:
                try:
                    parsed["iaq_score"] = int(group)
                    parsed["band"] = air_quality_band(parsed["iaq_score"])
                except ValueError:
                    pass
                break

    temp_match = re.search(r"(-?\d{1,3})\s+degrees?", text, re.IGNORECASE)
    if temp_match:
        try:
            parsed["temperature_f"] = int(temp_match.group(1))
        except ValueError:
            pass

    humidity_match = re.search(
        r"\b(\d{1,3})\s*(?:%|percent)\s+humidity\b|\bhumidity\s+(?:is\s+)?(\d{1,3})\s*(?:%|percent)?\b",
        text,
        re.IGNORECASE,
    )
    if humidity_match:
        for group in humidity_match.groups():
            if group:
                try:
                    parsed["humidity"] = int(group)
                except ValueError:
                    pass
                break

    pm_match = re.search(r"\bpm\s*2\.?\s*5?(?:\s+is|\s+at|\s+of)?\s+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if pm_match:
        parsed["pm25"] = pm_match.group(1)

    co_match = re.search(r"\b(?:co|carbon monoxide)\s+(?:is\s+)?(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if co_match:
        parsed["co"] = co_match.group(1)

    voc_match = re.search(r"\bvoc\s+(?:is\s+)?(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if voc_match:
        parsed["voc"] = voc_match.group(1)

    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0].strip()
    if first_sentence:
        parsed["summary"] = first_sentence

    return parsed


_SPOKEN_TEMP_RE = re.compile(
    r"(?:currently|it(?:'s|\s+is)|right\s+now)\s+(?:about\s+)?(-?\d{1,3})\s+degrees?",
    re.IGNORECASE,
)
_SPOKEN_CONDITION_RE = re.compile(
    r"\b(clear|sunny|cloudy|mostly\s+cloudy|partly\s+cloudy|overcast|rain(?:y|ing)?|"
    r"snow(?:y|ing)?|storm(?:y|s)?|fog(?:gy)?|windy|humid)\b",
    re.IGNORECASE,
)


def parse_spoken_weather(spoken: str | None) -> dict:
    text = (spoken or "").strip()
    if not text:
        return {}

    parsed: dict = {"summary": text}
    temp_match = _SPOKEN_TEMP_RE.search(text)
    if temp_match:
        # Alexa explicitly stated the current temperature ("right now it's...")
        parsed["temp_is_current"] = True
    else:
        temp_match = re.search(r"(-?\d{1,3})\s+degrees?", text, re.IGNORECASE)
    if temp_match:
        try:
            parsed["temp_f"] = int(temp_match.group(1))
        except ValueError:
            pass

    condition_match = _SPOKEN_CONDITION_RE.search(text)
    if condition_match:
        parsed["condition"] = condition_match.group(1).lower().replace(" ", "_")

    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0].strip()
    if first_sentence:
        parsed["summary"] = first_sentence

    return parsed
