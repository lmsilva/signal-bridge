from datetime import datetime, timezone


import re


def resolve_display_type(payload: dict) -> str:
    explicit = payload.get("type")
    if explicit in ("broadcast", "time.query", "weather.query", "timer.snapshot"):
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
    if value in {"sunny", "cloudy", "rainy", "snowy", "stormy", "windy", "unknown"}:
        return value
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
    temp_match = _SPOKEN_TEMP_RE.search(text) or re.search(r"(-?\d{1,3})\s+degrees?", text, re.IGNORECASE)
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
