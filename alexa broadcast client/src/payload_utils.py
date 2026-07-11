from datetime import datetime, timedelta, timezone


import re


DISPLAY_TYPES = (
    "broadcast",
    "time.query",
    "weather.query",
    "indoor-temperature.query",
    "air-quality.query",
    "timer.snapshot",
    "alarm.snapshot",
    "shopping-list.snapshot",
    "music.playing",
    "smart-home.command",
    "tesla-battery.query",
    "tesla-dashboard.query",
    "vivint-alarm.query",
    "alexa-notifications.query",
    "request.processing",
)


def resolve_display_type(payload: dict) -> str:
    explicit = payload.get("type")
    if explicit in DISPLAY_TYPES:
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
        "alarm.snapshot": ("Alexa", "Alarms"),
        "shopping-list.snapshot": ("Alexa", "Shopping List"),
        "music.playing": ("Alexa", "Now Playing"),
        "smart-home.command": ("Alexa", "Smart Home"),
        "tesla-battery.query": ("Alexa", "Tesla Battery"),
        "tesla-dashboard.query": ("Tesla", "mission control"),
        "vivint-alarm.query": ("Alexa", "Security"),
        "alexa-notifications.query": ("Alexa", "Notifications"),
        "request.processing": ("Alexa", "Working on it"),
    }
    return titles.get(display_type, ("Alexa", "Display"))


def processing_stage_message(stages: list | None, elapsed_sec: float) -> str:
    """Latest stage message whose afterSec threshold has been reached."""
    message = ""
    for stage in stages or []:
        if not isinstance(stage, dict):
            continue
        try:
            after = float(stage.get("afterSec", 0))
        except (TypeError, ValueError):
            continue
        if elapsed_sec >= after and stage.get("message"):
            message = str(stage["message"])
    return message


def parse_iso_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def resolve_time_display_datetime(payload: dict | None) -> datetime:
    """Resolve the clock to show for a time.query payload.

    Prefer parsed hour/minute (user-local wall clock) over ISO timestamps, which
    can be wrong when the bridge runs in UTC. Never use the activity timestamp
    as the clock — that causes a visible flicker (e.g. 4:15 PM before 10:15 PM).
    """
    payload = payload or {}
    parsed = payload.get("parsedTime") or {}
    hour = parsed.get("hour")
    minute = parsed.get("minute")
    if hour is not None and minute is not None:
        now = datetime.now().astimezone()
        second = parsed.get("second") or 0
        try:
            return now.replace(
                hour=int(hour),
                minute=int(minute),
                second=int(second),
                microsecond=0,
            )
        except ValueError:
            pass

    if parsed.get("iso"):
        dt = parse_iso_timestamp(parsed["iso"])
        if dt:
            return dt.astimezone()

    spoken = payload.get("spokenResponse") or ""
    for fmt in ("%I:%M %p", "%I:%M:%S %p", "%H:%M"):
        try:
            clock = datetime.strptime(spoken.strip().split("It's")[-1].strip(), fmt)
            now = datetime.now().astimezone()
            return now.replace(
                hour=clock.hour,
                minute=clock.minute,
                second=clock.second,
                microsecond=0,
            )
        except ValueError:
            continue

    return datetime.now().astimezone()


def format_chip_timestamp(value: str) -> str:
    parsed = parse_iso_timestamp(value)
    if parsed:
        return parsed.astimezone().strftime("%b %d · %I:%M %p")
    return value or datetime.now().astimezone().strftime("%b %d · %I:%M %p")


def format_charge_time_to_full(minutes: int | float | None) -> str:
    if minutes is None:
        return ""
    total = max(0, int(round(float(minutes))))
    if total <= 0:
        return "full"
    hours, mins = divmod(total, 60)
    if hours and mins:
        return f"{hours}h {mins}m to full"
    if hours:
        return f"{hours}h to full"
    return f"{mins} min to full"


def format_tesla_media_volume_label(media: dict | None) -> str:
    """Human-readable cabin volume (Tesla reports 0–11, not a percent)."""
    if not media:
        return ""
    volume_percent = media.get("volumePercent")
    if volume_percent is not None:
        pct = max(0, min(100, int(round(float(volume_percent)))))
        return f"{pct}% volume"
    raw = media.get("volume")
    if raw is None:
        return ""
    try:
        pct = max(0, min(100, int(round(float(raw) / 11 * 100))))
    except (TypeError, ValueError):
        return ""
    return f"{pct}% volume"


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


def format_alarm_time(value: str | None) -> str:
    parsed = parse_iso_timestamp(value or "")
    if parsed:
        return parsed.astimezone().strftime("%I:%M %p").lstrip("0")
    return "—"


def resolve_alarm_trigger_time(alarm: dict | None) -> str | None:
    """Use triggerTime when present; otherwise derive from remainingSec."""
    trigger = (alarm or {}).get("triggerTime")
    if trigger:
        return str(trigger)
    remaining = (alarm or {}).get("remainingSec")
    if remaining is not None and int(remaining) > 0:
        fire_at = datetime.now(timezone.utc) + timedelta(seconds=int(remaining))
        return fire_at.isoformat()
    return None


def format_alarm_date(value: str | None) -> str:
    parsed = parse_iso_timestamp(value or "")
    if parsed:
        return parsed.astimezone().strftime("%a %b %d")
    return ""


def alarm_label_name(alarm: dict | None) -> str | None:
    label = (alarm or {}).get("label")
    if label:
        return str(label).strip()
    return None


def alarm_title(alarm: dict | None) -> str:
    label = alarm_label_name(alarm)
    if label:
        return label
    alarm_type = str((alarm or {}).get("alarmType") or "").lower()
    if alarm_type == "music":
        return "Music alarm"
    return "Alarm"


def alarm_detail_line(alarm: dict | None, device: str) -> str:
    parts = []
    date_text = format_alarm_date(resolve_alarm_trigger_time(alarm))
    if date_text:
        parts.append(date_text)
    if device:
        parts.append(f"on {device}")
    recurrence = (alarm or {}).get("recurrence")
    if recurrence:
        parts.append("Repeats")
    return " · ".join(parts) if parts else device or "Alarm"


def alarm_until_line(alarm: dict | None) -> str | None:
    remaining = (alarm or {}).get("remainingSec")
    if remaining is None:
        return None
    remaining = max(0, int(remaining))
    if remaining >= 86400:
        days, remainder = divmod(remaining, 86400)
        hours = remainder // 3600
        return f"in {days}d {hours}h"
    if remaining >= 3600:
        hours, remainder = divmod(remaining, 3600)
        minutes = remainder // 60
        return f"in {hours}h {minutes}m"
    if remaining >= 60:
        minutes = remaining // 60
        return f"in {minutes}m"
    return f"in {remaining}s"


def sample_hourly_indices(total: int, slots: int) -> list[int]:
    """Pick indices spanning a full hourly forecast: always index 0 ("Now"),
    then evenly spaced so the last pick is the final available hour."""
    if total <= 0 or slots <= 0:
        return []
    if total <= slots:
        return list(range(total))
    if slots == 1:
        return [0]
    picks: list[int] = []
    for i in range(slots):
        index = round(i * (total - 1) / (slots - 1))
        if index not in picks:
            picks.append(index)
    return picks


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


def battery_level_color(percent: int | float | None) -> str:
    """Interpolate red (0%) -> green (100%)."""
    if percent is None:
        return "#64748b"
    try:
        value = max(0.0, min(100.0, float(percent)))
    except (TypeError, ValueError):
        return "#64748b"
    red = (0xEF, 0x44, 0x44)
    green = (0x22, 0xC5, 0x5E)
    ratio = value / 100.0
    parts = [int(red[i] + (green[i] - red[i]) * ratio) for i in range(3)]
    return f"#{parts[0]:02x}{parts[1]:02x}{parts[2]:02x}"


def format_battery_percent(value: int | float | None) -> str:
    if value is None:
        return "—"
    try:
        numeric = int(round(float(value)))
    except (TypeError, ValueError):
        return "—"
    return f"{max(0, min(100, numeric))}%"


def format_limit_reset_time(value: str | None) -> str:
    parsed = parse_iso_timestamp(value or "")
    if not parsed:
        return ""
    return parsed.astimezone().strftime("Try again at %I:%M %p").replace(" 0", " ")


def format_freshness_sec(sec: int | float | None) -> str:
    if sec is None:
        return "just now"
    sec = max(0, int(sec))
    if sec < 60:
        return f"{sec}s ago"
    if sec < 3600:
        return f"{sec // 60}m ago"
    if sec < 86400:
        return f"{sec // 3600}h ago"
    return f"{sec // 86400}d ago"


def format_cached_time_label(value: str | None) -> str:
    parsed = parse_iso_timestamp(value or "")
    if not parsed:
        return ""
    label = parsed.astimezone().strftime("%I:%M %p").lstrip("0")
    if parsed.astimezone().date() != datetime.now().astimezone().date():
        label = parsed.astimezone().strftime("%b %d, ") + label
    return label


_BATTERY_PERCENT_RE = re.compile(
    r"\b(?:your|the)\s+battery\s+is\s+(?:at\s+)?(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])|"
    r"\bbattery(?:\s+level)?\s+(?:is\s+)?(?:at\s+)?(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])|"
    r"\b(\d{1,3})\s*(?:%|percent)(?:\b|$|[.!,])",
    re.IGNORECASE,
)


def parse_spoken_battery_percent(spoken: str | None) -> int | None:
    text = (spoken or "").strip()
    if not text:
        return None
    match = _BATTERY_PERCENT_RE.search(text)
    if not match:
        return None
    for group in match.groups():
        if group:
            try:
                return max(0, min(100, int(group)))
            except ValueError:
                return None
    return None


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

    if location.get("multiMonitor"):
        return "Indoor Air Quality"

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


def voc_band_label(value: int | float | None) -> str:
    """Amazon air quality monitors report VOC as a 0-100 index (lower is
    cleaner air). Translate to a human word."""
    if value is None:
        return ""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return ""
    if numeric <= 33:
        return "Low"
    if numeric <= 66:
        return "Elevated"
    return "High"


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


_QUALITATIVE_BAND_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:very|pretty|really)\s+(?:good|great)\b|\bexcellent\b", re.IGNORECASE), "good"),
    (re.compile(r"\bair\s*quality(?:'s| is)\s+(?:pretty\s+)?good\b", re.IGNORECASE), "good"),
    (re.compile(r"\b(?:is|are|looks|sounds)\s+(?:pretty\s+)?good\b|\bfine\b|\bhealthy\b", re.IGNORECASE), "good"),
    (re.compile(r"\bfair\b|\bacceptable\b", re.IGNORECASE), "fair"),
    (re.compile(r"\bmoderate\b", re.IGNORECASE), "moderate"),
    (re.compile(r"\bpoor\b|\bbad\b|\bunhealthy\b", re.IGNORECASE), "poor"),
)


def parse_qualitative_air_quality_band(text: str | None) -> str | None:
    normalized = (text or "").strip()
    if not normalized:
        return None
    for pattern, band in _QUALITATIVE_BAND_PATTERNS:
        if pattern.search(normalized):
            return band
    if re.search(r"\bgood\b", normalized, re.IGNORECASE) and not re.search(
        r"\b(?:not|isn't|aren't)\s+good\b",
        normalized,
        re.IGNORECASE,
    ):
        return "good"
    return None


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

    qualitative = parse_qualitative_air_quality_band(text)
    if qualitative and parsed.get("band") in (None, "unknown"):
        parsed["band"] = qualitative

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
