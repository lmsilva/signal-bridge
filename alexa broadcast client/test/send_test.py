import argparse
import json
import math
import os
import socket
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow `from src.lan_crypto` when run as test/send_test.py
_CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(_CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_CLIENT_ROOT))

from src.lan_crypto import encode_outbound, is_enabled  # noqa: E402

ALEXA_MAX_MESSAGE_CHARACTERS = 8000
DEFAULT_LOCATION = {
    "name": "Home",
    "resolvedName": "Saratoga Springs, Utah, United States",
    "latitude": 40.0,
    "longitude": -111.0,
}


def build_max_length_message(length: int = ALEXA_MAX_MESSAGE_CHARACTERS) -> str:
    header = (
        "Maximum-length Alexa broadcast scroll test. "
        "This message is padded to the largest size our client accepts so you can "
        "verify vertical scrolling, read pauses, timer looping, and the finishing fade. "
    )
    sentence = (
        "Section {n}: Sentence {n} of the stress test — please confirm the overlay "
        "scrolls smoothly, stays readable, and does not disappear before the text "
        "finishes when the countdown reaches zero."
    )

    parts = [header.strip()]
    index = 1

    while True:
        fragment = sentence.format(n=index)
        candidate = " ".join(parts + [fragment])
        if len(candidate) >= length:
            break
        parts.append(fragment)
        index += 1

    message = " ".join(parts)
    remaining = length - len(message) - 1
    if remaining > 0:
        tail = sentence.format(n=index)
        message = f"{message} {tail[:remaining]}"

    return message[:length]


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_payload(args) -> dict:
    now = datetime.now(timezone.utc)
    display_seconds = args.seconds

    if args.type == "broadcast":
        return {
            "version": 2,
            "type": "broadcast",
            "message": args.message,
            "sender": args.sender,
            "destination": args.destination,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
        }

    if args.type == "time":
        local = now.astimezone()
        return {
            "version": 2,
            "type": "time.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what time is it",
            "spokenResponse": local.strftime("It's %I:%M %p").replace(" 0", " "),
            "parsedTime": {
                "iso": local.isoformat(),
                "hour": local.hour,
                "minute": local.minute,
                "second": local.second,
                "timeLabel": local.strftime("%I:%M %p").lstrip("0"),
                "dateLabel": local.strftime("%A, %B %d, %Y"),
            },
        }

    if args.type == "weather-spoken":
        return {
            "version": 2,
            "type": "weather.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what is the weather like outside",
            "spokenResponse": (
                "Currently 60 degrees and mostly cloudy, with a high of 68 and a low of 52. "
                "Fire Weather Watch active with winds up to 50 mph and humidity as low as 10 percent."
            ),
            "location": {
                "scope": "local",
                "query": "local",
                "resolvedName": None,
                "latitude": None,
                "longitude": None,
            },
            "weather": None,
        }

    if args.type == "weather":
        hourly = []
        for offset in range(8):
            slot_time = now + timedelta(hours=offset * 3)
            hourly.append({
                "time": slot_time.isoformat().replace("+00:00", "Z"),
                "temperatureF": 74 - offset,
                "temperatureC": 23 - offset,
                "precipitationProbability": 5 + offset * 4,
                "windSpeedMph": 6 + offset,
                "condition": "rainy" if offset % 3 == 2 else ("sunny" if offset % 3 == 0 else "cloudy"),
            })

        daily = []
        for offset in range(7):
            day = (now + timedelta(days=offset)).date().isoformat()
            daily.append({
                "date": day,
                "highF": 82 - offset,
                "lowF": 58 - offset,
                "highC": 28 - offset,
                "lowC": 14 - offset,
                "precipitationProbability": 10 + offset * 4,
                "windSpeedMph": 8 + offset,
                "condition": ["sunny", "cloudy", "rainy", "stormy", "snowy", "sunny", "cloudy"][offset % 7],
            })

        return {
            "version": 2,
            "type": "weather.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what is the weather like outside",
            "spokenResponse": "Currently it's 74 degrees and sunny in Saratoga Springs.",
            "location": {
                "scope": "local",
                "query": DEFAULT_LOCATION["name"],
                "resolvedName": DEFAULT_LOCATION["resolvedName"],
                "latitude": DEFAULT_LOCATION["latitude"],
                "longitude": DEFAULT_LOCATION["longitude"],
            },
            "weather": {
                "location": {"resolvedName": DEFAULT_LOCATION["resolvedName"]},
                "current": {
                    "temperatureF": 74,
                    "temperatureC": 23,
                    "windSpeedMph": 6,
                    "condition": "sunny",
                },
                "next24Hours": hourly,
                "next7Days": daily,
            },
        }

    if args.type == "indoor":
        return {
            "version": 2,
            "type": "indoor-temperature.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what's the temperature on top floor",
            "spokenResponse": "It's 76 degrees on the top floor",
            "metric": "temperature",
            "location": {
                "query": "top floor",
                "label": "Top Floor",
                "entity": "top floor",
                "scope": "indoor",
                "matched": True,
            },
            "reading": {
                "temperatureF": 76,
                "humidity": None,
                "comfort": "hot",
                "summary": "It's 76 degrees on the top floor",
            },
        }

    if args.type == "indoor-humidity":
        return {
            "version": 2,
            "type": "indoor-temperature.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what is the humidity of top floor",
            "spokenResponse": "The humidity of top floor is 16%",
            "metric": "humidity",
            "location": {
                "query": "top floor",
                "label": "Top Floor",
                "entity": "top floor",
                "scope": "indoor",
                "matched": True,
            },
            "reading": {
                "temperatureF": None,
                "humidity": 16,
                "comfort": "unknown",
                "summary": "The humidity of top floor is 16%",
            },
        }

    if args.type == "air-quality":
        return {
            "version": 2,
            "type": "air-quality.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what is the air quality",
            "spokenResponse": "Air quality is at 94 out of 100 right now",
            "location": {
                "query": "living room",
                "label": "Living Room",
                "entity": "Living Room Air Quality Monitor",
                "scope": "indoor-air-quality",
                "matched": True,
            },
            "reading": {
                "iaqScore": 94,
                "iaqMax": 100,
                "band": "good",
                "temperatureF": 70,
                "humidity": 57,
                "pm25": 1,
                "co": 1,
                "voc": 1,
                "summary": "Air quality is at 94 out of 100 right now",
            },
            "monitors": [
                {"label": "Main Floor", "iaqScore": 99, "band": "good"},
                {"label": "Machine Room", "iaqScore": 99, "band": "good"},
                {"label": "Dome", "iaqScore": 95, "band": "good"},
            ],
        }

    if args.type == "air-quality-poor":
        return {
            "version": 2,
            "type": "air-quality.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what is the air quality on main floor",
            "spokenResponse": "The main floor airquality is 40 out of 100",
            "location": {
                "query": "main floor",
                "label": "Main Floor",
                "entity": "main floor",
                "scope": "indoor-air-quality",
                "matched": True,
            },
            "reading": {
                "iaqScore": 40,
                "iaqMax": 100,
                "band": "moderate",
                "temperatureF": 74,
                "humidity": 22,
                "pm25": 18,
                "co": 2,
                "voc": 480,
                "summary": "The main floor airquality is 40 out of 100",
            },
        }

    if args.type in ("timers", "timers-nine", "timers-dense"):
        labels = [
            "Toast", "Pasta", "Rice", "Eggs", "Greens", "Sauce", "Roast",
            "Potatoes", "Bread proof", "Stock", "Brisket rest", "Dough",
            "Chill", "Marinade", "Soup", "Beans", "Corn", "Gravy",
            "Pie", "Coffee", "Tea", "Yogurt", "Kimchi", "Pickles",
            "Broth", "Noodles", "Dumplings", "Stew", "Curry", "Ribs",
            "Cake", "Cookies",
        ]
        if args.type == "timers":
            count = 2
            remainings = [75, 240]
            durations = [300, 900]
            names = ["Pizza", None]
        elif args.type == "timers-nine":
            count = 9
            remainings = [135, 280, 425, 680, 840, 1110, 1575, 2280, 2700]
            durations = [r + 60 for r in remainings]
            names = labels[:count]
        else:
            count = 32
            # Under-1h densify + 8 over-1h for Mode C collapse row.
            remainings = [52 + i * 145 for i in range(24)] + [3700 + i * 420 for i in range(8)]
            durations = [max(r + 120, 600) for r in remainings]
            names = labels[:count]
        timers = []
        for i in range(count):
            rem = remainings[i]
            label = names[i]
            timers.append({
                "amazonId": f"timer-{i + 1}",
                "device": "Kitchen Echo" if i % 2 == 0 else "Bedroom Echo",
                "label": label,
                "durationSec": durations[i],
                "remainingSec": rem,
                "status": "ON",
                "fireAt": (now + timedelta(seconds=rem)).isoformat().replace("+00:00", "Z"),
            })
        return {
            "version": 2,
            "type": "timer.snapshot",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "timers": timers,
            "event": {"kind": "list"},
        }

    if args.type == "timer-fired":
        return {
            "version": 2,
            "type": "timer.snapshot",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "timers": [
                {
                    "amazonId": "timer-1",
                    "device": "Kitchen Echo",
                    "label": "Pizza",
                    "durationSec": 300,
                    "remainingSec": 0,
                    "status": "OFF",
                },
            ],
            "event": {
                "kind": "fired",
                "timer": {
                    "amazonId": "timer-1",
                    "device": "Kitchen Echo",
                    "label": "Pizza",
                    "durationSec": 300,
                    "remainingSec": 0,
                    "status": "OFF",
                },
            },
        }

    if args.type == "reminder-fired":
        return {
            "version": 2,
            "type": "reminder.fired",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(display_seconds, 25),
            "trigger": "test",
            "reminder": {
                "amazonId": "rem-1",
                "label": "check on the corn",
                "device": args.sender,
                "triggerTime": _iso_now(),
            },
            "spokenResponse": "Here's your reminder to check on the corn.",
            "event": {
                "kind": "fired",
                "reminder": {
                    "amazonId": "rem-1",
                    "label": "check on the corn",
                    "device": args.sender,
                },
            },
        }

    if args.type == "alarms":
        now = datetime.now(timezone.utc)
        return {
            "version": 2,
            "type": "alarm.snapshot",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "show-alarms",
            "alarms": [
                {
                    "amazonId": "alarm-1",
                    "device": "Kitchen Echo",
                    "label": None,
                    "triggerTime": (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
                    "remainingSec": 7200,
                    "status": "ON",
                    "alarmType": "standard",
                    "isNew": False,
                },
                {
                    "amazonId": "alarm-2",
                    "device": "Bedroom Echo",
                    "label": "Wake up",
                    "triggerTime": (now + timedelta(hours=8)).isoformat().replace("+00:00", "Z"),
                    "remainingSec": 28800,
                    "status": "ON",
                    "alarmType": "standard",
                    "isNew": True,
                },
            ],
            "event": {"kind": "list"},
            "highlightAmazonId": "alarm-2",
        }

    if args.type == "alarm-set":
        now = datetime.now(timezone.utc)
        return {
            "version": 2,
            "type": "alarm.snapshot",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "alarm-set-voice",
            "alarms": [
                {
                    "amazonId": "alarm-1",
                    "device": "Office Echo",
                    "label": None,
                    "triggerTime": (now + timedelta(hours=10)).isoformat().replace("+00:00", "Z"),
                    "remainingSec": 36000,
                    "status": "ON",
                    "alarmType": "standard",
                    "isNew": False,
                },
                {
                    "amazonId": "alarm-3",
                    "device": "Kitchen Echo",
                    "label": None,
                    "triggerTime": (now + timedelta(hours=12)).isoformat().replace("+00:00", "Z"),
                    "remainingSec": 43200,
                    "status": "ON",
                    "alarmType": "standard",
                    "isNew": True,
                },
            ],
            "event": {"kind": "started", "amazonId": "alarm-3"},
            "highlightAmazonId": "alarm-3",
        }

    if args.type in ("shopping-list", "shopping-list-many"):
        short = [
            "eggs", "shampoo", "baby aspirin", "milkshakes", "heavy whip cream",
            "onions", "paper towels", "Brisket", "toilet cover",
        ]
        many = short + [
            "butter", "cheddar", "spinach", "lemons", "garlic",
            "olive oil", "rice", "black beans", "tortillas", "salsa",
            "coffee", "oat milk", "bananas", "blueberries", "yogurt",
            "chicken thighs", "salmon", "asparagus", "mushrooms", "sourdough",
            "dish soap", "trash bags",
        ]
        values = many if args.type == "shopping-list-many" else short
        return {
            "version": 2,
            "type": "shopping-list.snapshot",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(display_seconds, 45 if args.type == "shopping-list-many" else 20),
            "trigger": "test",
            "items": [{"value": v, "completed": False} for v in values],
            "event": {"kind": "list"},
        }

    if args.type == "processing":
        return {
            "version": 2,
            "type": "request.processing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 60,
            "trigger": "processing-ack",
            "kind": "tesla-dashboard",
            "query": "show tesla dashboard",
            "request": {
                "title": "Tesla Dashboard",
                "source": "Tesla Fleet API",
                "timeoutSeconds": 45,
                "stages": [
                    {"afterSec": 0, "message": "Request received — contacting your Tesla…"},
                    {"afterSec": 5, "message": "Fetching live vehicle data…"},
                    {"afterSec": 12, "message": "Still working — your Tesla may be waking up…"},
                    {"afterSec": 25, "message": "Hang tight — waking a sleeping vehicle can take up to 30 seconds…"},
                ],
            },
        }

    if args.type == "processing-timeout":
        return {
            "version": 2,
            "type": "request.processing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 20,
            "trigger": "processing-ack",
            "kind": "tesla-battery",
            "query": "show tesla battery",
            "request": {
                "title": "Tesla Battery",
                "source": "Tesla Fleet API",
                "timeoutSeconds": 5,
                "stages": [
                    {"afterSec": 0, "message": "Request received — contacting your Tesla…"},
                ],
            },
        }

    if args.type == "tesla-battery":
        percent = max(0, min(100, int(getattr(args, "percent", 78))))
        return {
            "version": 2,
            "type": "tesla-battery.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "show tesla battery",
            "spokenResponse": f"Your battery is at {percent} percent",
            "battery": {
                "percent": percent,
                "model": "Model Y",
                "label": "Battery",
                "source": "fleet-api",
                "status": "ok",
                # Both keys — fleet readings mirror these so older/newer clients agree.
                "batteryRange": 214,
                "rangeMiles": 214,
                "chargeLimit": 80,
                "chargeLimitSoc": 80,
                "lastChargeKwh": 32.4,
                "rangeAddedMiles": 118,
                "chargingLabel": "Not plugged in",
            },
        }

    if args.type == "tesla-battery-limited":
        return {
            "version": 2,
            "type": "tesla-battery.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "show tesla battery",
            "battery": {
                "percent": None,
                "model": "Model Y",
                "label": "Battery unavailable",
                "source": "fleet-api",
                "status": "rate_limited",
                "error": "Tesla rate limit reached",
                "limitResetAt": (datetime.now(timezone.utc) + timedelta(minutes=3)).isoformat(),
            },
        }

    if args.type == "tesla-battery-refreshing":
        percent = max(0, min(100, int(getattr(args, "percent", 71))))
        cached_at = (datetime.now(timezone.utc) - timedelta(minutes=8)).isoformat().replace("+00:00", "Z")
        return {
            "version": 2,
            "type": "tesla-battery.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "show tesla battery",
            "battery": {
                "percent": percent,
                "model": "Model Y",
                "label": "Battery",
                "source": "fleet-api",
                "status": "ok",
                "stale": True,
                "refreshing": True,
                "staleReason": "Refreshing live data",
                "cachedAt": cached_at,
                "fetchedAt": cached_at,
                "freshnessSec": 8 * 60,
            },
        }

    if args.type == "tesla-battery-stale":
        percent = max(0, min(100, int(getattr(args, "percent", 68))))
        cached_at = (datetime.now(timezone.utc) - timedelta(minutes=12)).isoformat().replace("+00:00", "Z")
        return {
            "version": 2,
            "type": "tesla-battery.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "show tesla battery",
            "battery": {
                "percent": percent,
                "model": "Model Y",
                "label": "Battery",
                "source": "fleet-api",
                "status": "ok",
                "stale": True,
                "staleReason": "Request throttled",
                "cachedAt": cached_at,
                "fetchedAt": cached_at,
                "freshnessSec": 12 * 60,
                "limitResetAt": (datetime.now(timezone.utc) + timedelta(seconds=45)).isoformat(),
            },
        }

    if args.type in ("tesla-dashboard", "tesla-dashboard-stale", "tesla-dashboard-refreshing"):
        payload = {
            "version": 2,
            "type": "tesla-dashboard.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(display_seconds, 120),
            "trigger": "test",
            "query": "show tesla dashboard",
            "dashboard": {
                "status": "ok",
                "fetchedAt": _iso_now(),
                "freshnessSec": 8,
                "vehicle": {
                    "name": "Luis's Model Y",
                    "model": "Model Y",
                    "online": True,
                    "firmware": "2026.20.4",
                },
                "map": {
                    "latitude": 39.6261,
                    "longitude": -111.4399,
                    "heading": 315,
                    "headingLabel": "NW",
                    "locationLabel": "Fairview, UT",
                    "locatedAtHome": True,
                    "drivingChip": "Heading NW · 0 mph · Park",
                    "navigation": {"active": False, "footer": "No active route"},
                },
                "security": {
                    "locked": True,
                    "sentryOn": True,
                    "doorsClosed": True,
                    "windowsUp": True,
                    "secureTheme": "green",
                },
                "battery": {
                    "percent": 72,
                    "rangeMiles": 231,
                    "ratedRangeMiles": 244,
                    "charging": False,
                    "chargingLabel": "Not plugged in",
                    "lastChargeKwh": 38,
                    "lifetimeEnergy": "4.2 MWh",
                },
                "climate": {
                    "insideTempF": 71,
                    "outsideTempF": 94,
                    "hvacOn": False,
                    "cabinOverheatProtection": "on",
                },
                "tires": {
                    "fl": 42.1,
                    "fr": 42.3,
                    "rl": 41.8,
                    "rr": 39.2,
                    "warnings": {"rr": "soft"},
                    "alert": "Rear right soft warning",
                },
                "odometer": {
                    "miles": 18442,
                    "fsdMilesPercent": 31,
                    "lastChargeAddedMiles": 118,
                    "serviceDueInMiles": 558,
                    "serviceIntervalMiles": 6250,
                },
                "software": {
                    "statusLabel": "Update ready",
                    "updateAvailable": True,
                    "updateVersion": "2026.24.1",
                    "downloadPercent": 100,
                },
                "media": {
                    "playing": False,
                    "source": "Spotify",
                    "volumePercent": 50,
                },
            },
        }
        if args.type == "tesla-dashboard-stale":
            cached_at = (datetime.now(timezone.utc) - timedelta(minutes=25)).isoformat()
            payload["dashboard"].update(
                {
                    "stale": True,
                    "staleReason": "Vehicle unavailable",
                    "cachedAt": cached_at,
                    "fetchedAt": cached_at,
                    "freshnessSec": 25 * 60,
                }
            )
        if args.type == "tesla-dashboard-refreshing":
            cached_at = (datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat()
            payload["dashboard"].update(
                {
                    "stale": True,
                    "refreshing": True,
                    "staleReason": "Refreshing live data",
                    "cachedAt": cached_at,
                    "fetchedAt": cached_at,
                    "freshnessSec": 6 * 60,
                }
            )
        return payload

    if args.type == "vivint-alarm":
        mode = getattr(args, "alarm_mode", "stay")
        spoken = f"your system has been armed {mode}"
        return {
            "version": 2,
            "type": "vivint-alarm.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "ask Vivint to arm",
            "spokenResponse": spoken,
            "alarm": {
                "status": "armed",
                "mode": mode,
                "provider": "Vivint",
                "label": f"Alarm System Armed — {mode.title()}",
                "modeLabel": f"{mode.title()} Mode",
            },
        }

    if args.type == "web-open":
        return {
            "version": 2,
            "type": "web.open",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "persistent": True,
            "trigger": "test",
            "web": {"url": args.url, "errorDisplaySeconds": 20},
        }

    if args.type == "web-open-bad":
        return {
            "version": 2,
            "type": "web.open",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "persistent": True,
            "trigger": "test",
            "web": {
                "url": "http://127.0.0.1:9/this-will-not-load",
                "errorDisplaySeconds": 20,
            },
        }

    if args.type == "web-close":
        return {
            "version": 2,
            "type": "web.close",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
        }

    if args.type == "system-reboot":
        return {
            "version": 2,
            "type": "system.command",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
            "system": {"action": "reboot"},
        }

    if args.type == "system-poweroff":
        return {
            "version": 2,
            "type": "system.command",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
            "system": {"action": "poweroff"},
        }

    if args.type == "display-auth":
        return {
            "version": 2,
            "type": "display.auth",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "displaySeconds": args.seconds,
            "auth": {"pin": getattr(args, "pin", None) or "1234"},
        }

    if args.type == "display-discover":
        return {
            "version": 2,
            "type": "display.discover",
            "timestamp": _iso_now(),
            "trigger": "test",
        }

    if args.type == "input-click":
        return {
            "version": 2,
            "type": "input.pointer",
            "device": args.sender,
            "timestamp": _iso_now(),
            "trigger": "test",
            "pointer": {"dx": 0, "dy": 0, "buttons": {"left": "click"}},
        }

    if args.type == "input-key":
        return {
            "version": 2,
            "type": "input.key",
            "device": args.sender,
            "timestamp": _iso_now(),
            "trigger": "test",
            "key": {"key": "Tab", "modifiers": [], "action": "press"},
        }

    if args.type == "qr-url":
        return {
            "version": 2,
            "type": "qr.display",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "qr": {
                "qrType": "url",
                "content": args.url,
                "label": args.url,
            },
        }

    if args.type == "qr-wifi":
        return {
            "version": 2,
            "type": "qr.display",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "qr": {
                "qrType": "wifi",
                "content": "WIFI:T:WPA;S:Home Network;P:letmein123;;",
                "label": "Wi-Fi: Home Network",
            },
        }

    if args.type == "guest-photobooth":
        pin = str(getattr(args, "pin", None) or "123456").strip()
        return {
            "version": 2,
            "type": "guest.photobooth",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(display_seconds, 180),
            "trigger": "test",
            "guestPhotobooth": {
                "title": "Guest Snaps",
                "subtitle": "Two quick scans to share a photo",
                "accessPin": pin,
                "accessPinHint": "Enter this PIN on your phone",
                "wifi": {
                    "content": "WIFI:T:WPA;S:Home Network;P:letmein123;;",
                    "ssid": "Home Network",
                    "stepLabel": "1",
                    "heading": "Join Wi‑Fi",
                    "hint": "Scan to connect",
                },
                "booth": {
                    "content": args.url if args.url != "https://example.com" else "https://192.168.1.10:47810/",
                    "stepLabel": "2",
                    "heading": "Open Guest Snaps",
                    "hint": "Already on Wi‑Fi? Scan here",
                },
            },
        }

    if args.type == "music":
        return {
            "version": 2,
            "type": "music.playing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "what's playing",
            "spokenResponse": "This is Blinding Lights by The Weeknd",
            "music": {
                "song": "Blinding Lights",
                "artist": "The Weeknd",
                "album": "After Hours",
                "artUrl": "https://picsum.photos/seed/signal-music/800/800",
                "provider": "Amazon Music",
                "state": "PLAYING",
                "device": args.sender,
                "mediaLengthSec": 200,
                "mediaProgressSec": 45,
                "progressAt": _iso_now(),
            },
        }

    if args.type == "input-text":
        return {
            "version": 2,
            "type": "input.text",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
            "text": {"value": args.text, "pressEnter": args.press_enter},
        }

    if args.type == "photo-slideshow":
        now = datetime.now(timezone.utc)
        photos = [
            {
                "url": "https://picsum.photos/seed/signal1/1200/1600",
                "uploadedAt": (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
            },
            {
                "url": "https://picsum.photos/seed/signal2/1200/1600",
                "uploadedAt": (now - timedelta(days=1)).isoformat().replace("+00:00", "Z"),
            },
            {
                "url": "https://picsum.photos/seed/signal3/1600/1200",
                "uploadedAt": (now - timedelta(days=3)).isoformat().replace("+00:00", "Z"),
            },
        ]
        seconds_per_photo = 5
        return {
            "version": 2,
            "type": "photo.slideshow",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": len(photos) * seconds_per_photo,
            "trigger": "test",
            "slideshow": {"photos": photos, "secondsPerPhoto": seconds_per_photo},
        }

    if args.type == "roll-credits":
        now = datetime.now(timezone.utc)
        months = []
        for offset, count in enumerate([1, 2, 0, 3, 2, 4, 1, 5, 2, 3, 4, 6]):
            date = now - timedelta(days=(11 - offset) * 30)
            months.append({"key": date.strftime("%Y-%m"), "label": date.strftime("%b"), "count": count})
        return {
            "version": 2,
            "type": "roll-credits.tour",
            "timestamp": _iso_now(),
            "displaySeconds": 40,
            "persistent": False,
            "tourId": "smoke-dashboard",
            "count": 132,
            "walkedCount": 0,
            "loop": False,
            "secondsPerGame": 12,
            "dashboardSeconds": 35,
            "order": "recent",
            "playlistPath": "",
            "cardBaseUrl": "",
            "stats": {
                "total": 132,
                "thisYear": 41,
                "systemsCount": 14,
                "undatedCount": 3,
                "latest": {
                    "id": "rc_smoke",
                    "title": "It Takes Two",
                    "system": "ps5",
                    "systemLabel": "PlayStation 5",
                    "beatenAt": now.strftime("%Y-%m-%d"),
                    "beatenWith": "Dan",
                    "induction": 132,
                    "media": {
                        "hero": {
                            "kind": "cover",
                            "url": "https://picsum.photos/seed/roll-credits/800/1100",
                        },
                        "screenshots": [],
                    },
                },
                "months": months,
                "bySystem": [
                    {"label": "PS5", "count": 34},
                    {"label": "SNES", "count": 22},
                    {"label": "PC", "count": 17},
                    {"label": "PS2", "count": 13},
                ],
            },
        }

    if args.type == "autodarts-dashboard":
        now = datetime.now(timezone.utc)
        months = []
        for offset, count in enumerate([2, 4, 1, 6, 3, 5, 2, 8, 4, 3, 7, 9]):
            date = now - timedelta(days=(11 - offset) * 30)
            months.append({"key": date.strftime("%Y-%m"), "label": date.strftime("%b"), "count": count})
        return {
            "version": 2,
            "type": "autodarts.dashboard",
            "timestamp": _iso_now(),
            "displaySeconds": args.seconds or 120,
            "persistent": False,
            "totals": {
                "matches": 412,
                "legs": 1204,
                "thisMonth": 18,
                "lastPlayedAt": (now - timedelta(days=2)).isoformat().replace("+00:00", "Z"),
                "lastPlayedLabel": "2d",
            },
            "leaderboard": [
                {
                    "rank": 1, "crown": True, "name": "TRASHPANDA",
                    "wins": 23, "losses": 14, "winPct": 62.2,
                    "x01Average": 25.0, "bestCheckout": 48, "oneEighties": 0, "matches": 37,
                },
                {
                    "rank": 2, "crown": False, "name": "WAR D",
                    "wins": 14, "losses": 23, "winPct": 37.8,
                    "x01Average": 20.9, "bestCheckout": 40, "oneEighties": 0, "matches": 37,
                },
                {
                    "rank": 3, "crown": False, "name": "KYLIE",
                    "wins": 3, "losses": 2, "winPct": 60.0,
                    "x01Average": 18.4, "bestCheckout": 32, "oneEighties": 0, "matches": 5,
                },
                {
                    "rank": 4, "crown": False, "name": "TOMMY",
                    "wins": 1, "losses": 4, "winPct": 20.0,
                    "x01Average": 15.1, "bestCheckout": 20, "oneEighties": 0, "matches": 5,
                },
            ],
            "moreCount": 3,
            "byMonth": months,
            "rivalry": {
                "a": "TRASHPANDA", "b": "WAR D", "aWins": 23, "bWins": 14,
                "lastWinner": "TRASHPANDA",
                "lastPlayedAt": (now - timedelta(days=5)).isoformat().replace("+00:00", "Z"),
            },
            "records": {
                "bestMatchAverage": {"value": 36.3, "player": "TRASHPANDA"},
                "highestCheckout": {"value": 48, "player": "TRASHPANDA"},
                "total180s": 0,
            },
            "recent": [],
        }

    if args.type in ("autodarts-match", "autodarts-final"):
        finished = args.type == "autodarts-final"
        # Calibrated T20 in treble-20: mid-treble radius ≈ 0.6055 at top (x≈0, y≈-0.6055)
        t20_x, t20_y = 0.0, -((0.582 + 0.629) / 2)
        payload = {
            "version": 2,
            "type": "autodarts.match",
            "timestamp": _iso_now(),
            "displaySeconds": 0 if not finished else (args.seconds or 60),
            "persistent": not finished,
            "match": {
                "matchId": "smoke-match-1",
                "revision": 41,
                "status": "finished" if finished else "live",
                "variant": "X01",
                "settingsLine": "501 · SI-DO · First to 2 legs",
                "startedAt": _iso_now(),
                "durationSec": 412 if not finished else 638,
                "currentPlayerIndex": 0,
                "turn": {
                    "points": 65,
                    "busted": False,
                    "darts": [
                        {"seg": "T20", "x": t20_x, "y": t20_y, "type": "normal"},
                        {"seg": "5", "x": -0.55, "y": 0.42, "type": "normal"},
                        None,
                    ],
                },
                "prevTurn": {
                    "playerIndex": 1,
                    "points": 41,
                    "darts": [
                        {"seg": "20", "x": 0.03, "y": -0.71, "type": "normal"},
                        {"seg": "1", "x": 0.28, "y": -0.66, "type": "normal"},
                        {"seg": "M", "x": 1.24, "y": 0.31, "type": "normal"},
                    ],
                },
                "players": [
                    {
                        "name": "TRASHPANDA", "score": 261 if not finished else 2,
                        "legs": 1 if not finished else 2, "sets": 0,
                        "average": 25.03, "lastTurnPoints": 85,
                        "isWinner": finished,
                    },
                    {
                        "name": "WAR D", "score": 356 if not finished else 0,
                        "legs": 0, "sets": 0,
                        "average": 20.89, "lastTurnPoints": 41,
                        "isWinner": False,
                    },
                ],
                "gameShot": "D8" if finished else None,
                "hitMap": {
                    "players": [
                        {
                            "name": "TRASHPANDA",
                            "darts": [
                                {"seg": "T20", "x": t20_x, "y": t20_y, "type": "normal"},
                                {"seg": "20", "x": 0.05, "y": -0.75, "type": "normal"},
                                {"seg": "D16", "x": 0.55, "y": 0.78, "type": "normal"},
                            ],
                        },
                        {
                            "name": "WAR D",
                            "darts": [
                                {"seg": "19", "x": -0.2, "y": 0.7, "type": "normal"},
                                {"seg": "5", "x": -0.6, "y": 0.4, "type": "normal"},
                            ],
                        },
                    ],
                } if finished else None,
            },
        }
        if finished:
            payload["match"]["turn"] = {"points": 0, "busted": False, "darts": [None, None, None]}
            payload["match"]["prevTurn"] = None
        return payload

    if args.type == "autodarts-match-close":
        return {
            "version": 2,
            "type": "autodarts.match.close",
            "timestamp": _iso_now(),
            "matchId": "smoke-match-1",
            "reason": "test",
        }

    if args.type in ("huupe-live", "huupe-final", "huupe-solo"):
        finished = args.type == "huupe-final"
        solo = args.type == "huupe-solo"

        def _zones(made, attempts):
            spread = [("layup", "Layup", 0.30), ("one", "Close", 0.32),
                      ("two", "Mid", 0.24), ("three", "Three", 0.14)]
            rows = []
            for zone, label, share in spread:
                zone_attempts = max(1, round(attempts * share))
                zone_made = max(0, round(made * share))
                rows.append({
                    "zone": zone, "label": label,
                    "made": zone_made, "attempts": zone_attempts,
                    "pct": round(100 * zone_made / zone_attempts),
                })
            return rows

        players = [] if solo else [
            {"rank": 1, "name": "trashpanda", "score": 17.1, "scoreLabel": "17.1",
             "made": 9, "attempts": 21, "fgPct": 43, "threes": 2, "bestStreak": 4,
             "isWinner": finished, "zones": _zones(9, 21)},
            {"rank": 2, "name": "War D", "score": 12.9, "scoreLabel": "12.9",
             "made": 7, "attempts": 19, "fgPct": 37, "threes": 1, "bestStreak": 3,
             "isWinner": False, "zones": _zones(7, 19)},
            {"rank": 3, "name": "lundisupcorp", "score": 8.2, "scoreLabel": "8.2",
             "made": 4, "attempts": 16, "fgPct": 25, "threes": 0, "bestStreak": 2,
             "isWinner": False, "zones": _zones(4, 16)},
        ]
        headline = (
            {"primary": "trashpanda", "secondary": "wins by 4.2"} if finished
            else {"primary": "17.1", "secondary": "20/56 · 36%"}
        )
        if solo:
            headline = {"primary": "17.1", "secondary": "20/56 · 36%"}
        return {
            "version": 2,
            "type": "huupe.session",
            "timestamp": _iso_now(),
            "displaySeconds": (args.seconds or 60) if finished else 0,
            "persistent": not finished,
            "session": {
                "sessionId": "smoke-huupe-1",
                "mode": "justhuupe" if solo else "family",
                "modeLabel": "Free Play" if solo else "Family Mode",
                "status": "finished" if finished else "live",
                "revision": 12,
                "durationSec": 742,
                "durationLabel": "12:22",
                "headline": headline,
                "players": players,
                "stats": {
                    "points": 17.1, "pointsLabel": "17.1", "made": 20, "attempts": 56,
                    "shotLine": "20/56", "fgPct": 36, "streak": 3, "bestStreak": 6,
                    "threes": 3,
                },
                "zones": _zones(20, 56),
                "lastShot": {
                    "player": None if solo else "trashpanda", "made": True,
                    "zone": "three", "zoneLabel": "Three", "points": 3, "pointsLabel": "3",
                },
                "winner": "trashpanda" if (finished and not solo) else None,
                "sensorErrors": 0,
            },
        }

    if args.type == "huupe-session-close":
        return {
            "version": 2,
            "type": "huupe.session.close",
            "timestamp": _iso_now(),
            "sessionId": "smoke-huupe-1",
            "reason": "test",
        }

    if args.type == "huupe-dashboard":
        names = ["trashpanda", "War D", "lundisupcorp", "kylie", "emsss",
                 "tommy", "guest", "ana", "ben", "cleo"]
        return {
            "version": 2,
            "type": "huupe.dashboard",
            "timestamp": _iso_now(),
            "displaySeconds": args.seconds or 120,
            "persistent": False,
            "totals": {
                "sessions": 48, "games": 31, "freePlaySessions": 17,
                "shots": 3371, "makes": 1482, "fgPct": 44,
                "points": 902.4, "pointsLabel": "902.4",
                "playSeconds": 50820, "playLabel": "14h 07m",
                "lastPlayedAt": _iso_now(), "lastPlayedLabel": "Today",
            },
            "leaderboard": [
                {"rank": index + 1, "crown": index == 0, "name": name,
                 "games": 15 - index, "wins": 11 - index, "winPct": 73 - index * 4,
                 "points": 210.5 - index * 12, "pointsLabel": f"{210.5 - index * 12:.1f}",
                 "bestScore": 21.1 - index, "bestScoreLabel": f"{21.1 - index:.1f}",
                 "made": 140 - index * 8, "attempts": 320 - index * 12,
                 "fgPct": 64 - index * 3, "threes": 12 - index, "bestStreak": 9 - index,
                 "lastPlayedLabel": "Today"}
                for index, name in enumerate(names)
            ],
            "moreCount": 5,
            "zones": [
                {"zone": "layup", "label": "Layup", "made": 620, "attempts": 780, "pct": 79},
                {"zone": "one", "label": "Close", "made": 410, "attempts": 940, "pct": 44},
                {"zone": "two", "label": "Mid", "made": 300, "attempts": 900, "pct": 33},
                {"zone": "three", "label": "Three", "made": 152, "attempts": 751, "pct": 20},
            ],
            "records": {
                "bestSessionScore": {"value": 34.2, "valueLabel": "34.2",
                                     "mode": "family", "modeLabel": "Family Mode"},
                "bestStreak": {"value": 11, "player": "trashpanda"},
                "bestFgPct": {"player": "lundisupcorp", "value": 64},
            },
            "device": {"name": "Huupe Mini", "online": True},
            "recent": [],
        }

    if args.type == "steam-now-playing":
        started = datetime.now(timezone.utc) - timedelta(minutes=74)
        return {
            "version": 2,
            "type": "steam.now-playing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "persistent": True,
            "trigger": "test",
            "steam": {
                "appId": 1139970,
                "name": "Boomerang Fu",
                "shortDescription": (
                    "A frantic local multiplayer battle game where everyone is a sticky note "
                    "warrior armed with a deadly boomerang."
                ),
                "developers": ["Cranky Watermelon"],
                "publishers": ["Cranky Watermelon"],
                "releaseYear": "2020",
                "tags": ["Split Screen", "PvP", "Co-op", "Full Controller"],
                "posterCandidates": [
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/library_600x900.jpg",
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/header.jpg",
                ],
                "headerImage": "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/header.jpg",
                "screenshots": [
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/ss_1.jpg",
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/ss_2.jpg",
                    "https://cdn.cloudflare.steamstatic.com/steam/apps/1139970/ss_3.jpg",
                ],
                "playtimeLabel": "8.4 hrs",
                "playtimeForeverMin": 504,
                "achievements": {"earned": 14, "total": 32, "available": True},
                "currentPlayers": 312,
                "host": "MOVIETHEATERPC",
                "startedAt": started.isoformat().replace("+00:00", "Z"),
                "elapsedSec": 74 * 60,
                "personaName": "Tester",
            },
        }

    if args.type == "steam-now-playing-close":
        return {
            "version": 2,
            "type": "steam.now-playing.close",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
        }

    if args.type == "psn-now-playing":
        started = datetime.now(timezone.utc) - timedelta(minutes=42)
        return {
            "version": 2,
            "type": "psn.now-playing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "persistent": True,
            "trigger": "test",
            "psn": {
                "titleId": "PPSA01325_00",
                "name": "Astro's Playroom",
                "mode": "playing",
                "platform": "PS5",
                "shortDescription": "",
                "statusLine": "Playing now · on PS5 · as Tester · played 4 times",
                "developers": [],
                "publishers": [],
                "releaseYear": None,
                "tags": ["PS5"],
                "posterCandidates": [
                    "https://image.api.playstation.com/vulcan/ap/rnd/202010/2617/example.jpg",
                ],
                "headerImage": None,
                "screenshots": [
                    "https://image.api.playstation.com/vulcan/ap/rnd/202010/2617/banner1.jpg",
                    "https://image.api.playstation.com/vulcan/ap/rnd/202010/2617/banner2.jpg",
                ],
                "playtimeLabel": "12.5 h",
                "playtimeForeverMin": 750,
                "playCount": 4,
                "progressLabel": "61%",
                "trophies": {"earned": 28, "total": 46, "available": True, "progress": 61},
                "achievements": {"earned": 28, "total": 46, "available": True},
                "startedAt": started.isoformat().replace("+00:00", "Z"),
                "lastPlayedAt": None,
                "elapsedSec": 42 * 60,
                "onlineId": "Tester",
            },
        }

    if args.type == "psn-now-playing-close":
        return {
            "version": 2,
            "type": "psn.now-playing.close",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
        }

    if args.type in (
        "youtube-now-playing", "youtube-last-played",
        "youtube-live", "youtube-minimal",
    ):
        base = f"http://{args.host}:8080/youtube-images"
        started = datetime.now(timezone.utc) - timedelta(minutes=12, seconds=4)
        live = args.type == "youtube-live"
        # `youtube-minimal` is the degraded case: a private or deleted video,
        # hidden subscriber count, no description and no dislike estimate.
        minimal = args.type == "youtube-minimal"
        last_played = args.type == "youtube-last-played"
        return {
            "version": 2,
            "type": "youtube.now-playing",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 60 if last_played else 0,
            "persistent": not last_played,
            "trigger": "test",
            "youtube": {
                "videoId": "dQw4w9WgXcQ",
                "mode": "last-played" if last_played else "playing",
                "title": (
                    "Untitled"
                    if minimal
                    else "How the Voyager Probes Still Phone Home After 47 Years"
                ),
                "description": (
                    ""
                    if minimal
                    else "A look at the Deep Space Network and the engineering that keeps "
                         "a 1977 spacecraft in contact across 24 billion kilometres."
                ),
                "descriptionLines": 3,
                "channelTitle": "Veritasium",
                "subscriberCount": None if minimal else 16_832_904,
                "viewCount": None if minimal else 4_218_774,
                "likeCount": None if minimal else 312_401,
                "dislikeCount": None if minimal else 1_204,
                "dislikeEstimated": not minimal,
                "publishedAt": None if minimal else "2024-03-12T14:00:00Z",
                "durationSeconds": 0 if live else 1711,
                "live": live,
                "liveBroadcastContent": "live" if live else "none",
                "concurrentViewers": 18_402 if live else None,
                "metadataMissing": minimal,
                "thumbnailUrl": f"{base}/sample-thumbnail.jpg",
                "thumbnailWidth": 1280,
                "thumbnailHeight": 720,
                "avatarUrl": None if minimal else f"{base}/sample-avatar.jpg",
                "deviceLabel": "Living Room Apple TV",
                "positionSeconds": None if last_played else 724,
                "watchedSeconds": 1450 if last_played else None,
                "completed": False if last_played else None,
                "startedAt": started.isoformat().replace("+00:00", "Z"),
                "endedAt": _iso_now() if last_played else None,
            },
        }

    if args.type == "youtube-now-playing-close":
        return {
            "version": 2,
            "type": "youtube.now-playing.close",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": 0,
            "trigger": "test",
        }

    if args.type in ("trivia", "trivia-boolean", "trivia-single"):
        base = f"http://{args.host}:8080/trivia-artwork"
        # categoryIds must match trivia-categories.json / assets/trivia-artwork/.
        specs = [
            ("science-nature", "Science & Nature", "#8BB7FF", "#003F2A", "medium",
             "Which planet in our solar system has the shortest day?",
             ["Mercury", "Jupiter", "Earth", "Neptune"], 1),
            ("history", "History", "#E8B04B", "#231A0E", "hard",
             "The Treaty of Westphalia, which ended the Thirty Years' War "
             "and reshaped the political map of Europe, was signed in which year?",
             ["1618", "1648", "1701", "1789"], 1),
            ("film", "Film", "#FF8FA3", "#8F0043", "easy",
             "Who directed Jaws?", ["Steven Spielberg", "George Lucas",
                                    "Ridley Scott", "Martin Scorsese"], 0),
        ]
        if args.type == "trivia-boolean":
            specs = [(cid, label, accent, bg, diff, text, ["True", "False"], 0)
                     for cid, label, accent, bg, diff, text, _, _ in specs]
        if args.type == "trivia-single":
            specs = specs[:1]
        questions = [
            {
                "id": f"test-{i}",
                "categoryId": category_id,
                "categoryLabel": label,
                "difficulty": difficulty,
                "type": "boolean" if len(answers) == 2 else "multiple",
                "text": text,
                "answers": answers,
                "correctIndex": correct,
                "accent": accent,
                "background": background,
                "artwork": {
                    "portrait": f"{base}/{category_id}-portrait.jpg",
                    "landscape": f"{base}/{category_id}-landscape.jpg",
                },
            }
            for i, (category_id, label, accent, background, difficulty, text, answers, correct)
            in enumerate(specs)
        ]
        show_summary = len(questions) > 1
        total = 4 + len(questions) * (15 + 7) + (6 if show_summary else 0)
        return {
            "version": 2,
            "type": "trivia.round",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": total,
            "trigger": "test",
            "trivia": {
                "roundId": "test-round",
                "questions": questions,
                "questionSeconds": 15,
                "answerSeconds": 7,
                "introSeconds": 4,
                "summarySeconds": 6,
                "showIntro": True,
                "showSummary": show_summary,
                "attribution": ["Open Trivia DB", "The Trivia API"],
            },
        }

    if args.type == "upside-news":
        base = f"http://{args.host}:8080/upside-news-artwork"
        specs = [
            ("science", "Science", "#8BB7FF", "#003F2A",
             "Solar panels now power an entire village for the first time",
             "A remote community celebrated after a crowdfunded array went live."),
            ("health", "Health", "#6EE7A8", "#123524",
             "Hospital volunteers delivered 10,000 care packages",
             "Staff and neighbors packed essentials for families in recovery."),
            ("world", "World", "#F5C453", "#3a2605",
             "Neighbors replanted a burned forest corridor in one weekend",
             "More than four hundred saplings went into the ground along the trail."),
        ]
        index_seconds, story_seconds = 12, 15
        stories = [
            {
                "index": i,
                "id": f"upside-test-{i}",
                "headline": headline,
                "standfirst": standfirst,
                "sectionId": section_id,
                "sectionName": label,
                "accent": accent,
                "background": background,
                "publishedAt": _iso_now(),
                "publishedLabel": "2h ago",
                "readingMinutes": 3,
                "byline": "Signal Bridge Test",
                "sourceLabel": "The Guardian",
                "url": f"https://example.com/upside/{i}",
                "keywords": ["hope", "community"],
                "artwork": {
                    "portrait": f"{base}/{section_id}-portrait.jpg",
                    "landscape": f"{base}/{section_id}-landscape.jpg",
                },
            }
            for i, (section_id, label, accent, background, headline, standfirst)
            in enumerate(specs)
        ]
        count = len(stories)
        total = index_seconds + count * story_seconds
        return {
            "version": 2,
            "type": "upside-news.round",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": total,
            "trigger": "test",
            "upsideNews": {
                "sessionId": "test-upside-round",
                "triggeredBy": "manual",
                "title": "The Upside News",
                "indexTitle": f"Today's {count}",
                "period": "daily",
                "storyCount": count,
                "indexSeconds": index_seconds,
                "storySeconds": story_seconds,
                "loops": "once",
                "loopCount": 1,
                "cycleSeconds": total,
                "totalDurationSeconds": total,
                "showQr": True,
                "showReadingTime": True,
                "showTopicTags": False,
                "attribution": "Guardian Open Platform · positive news RSS",
                "indexArtwork": {
                    "portrait": f"{base}/general-portrait.jpg",
                    "landscape": f"{base}/general-landscape.jpg",
                },
                "indexAccent": "#E897FF",
                "indexBackground": "#7A2396",
                "stories": stories,
            },
        }

    if args.type == "wiki-common-knowledge":
        base = f"http://{args.host}:8080/wiki-common-knowledge-artwork"
        specs = [
            ("science", "Science", "#A5B4FC", "#312E81",
             "James Webb Space Telescope",
             "Space observatory launched in 2021 to study the early universe.",
             "The James Webb Space Telescope is a space telescope which conducts infrared astronomy."),
            ("history", "History", "#FCD34D", "#78350F",
             "Roman Empire",
             "The post-Republican period of ancient Rome.",
             "The Roman Empire was the post-Republican period of ancient Rome."),
            ("technology", "Technology", "#67E8F9", "#164E63",
             "Artificial intelligence",
             "Intelligence demonstrated by machines.",
             "Artificial intelligence is the capability of computational systems to perform tasks typically associated with human intelligence."),
        ]
        index_seconds, article_seconds = 12, 15
        stories = []
        for i, (cat_id, cat_name, accent, background, title, description, extract) in enumerate(specs):
            rank = i + 1
            history = [1200 + rank * 100 + j * 40 for j in range(14)]
            stories.append({
                "index": i,
                "rank": rank,
                "id": f"wiki-test-{i}",
                "title": title,
                "description": description,
                "extract": extract,
                "categoryId": cat_id,
                "categoryName": cat_name,
                "accent": accent,
                "background": background,
                "thumbnailUrl": f"https://picsum.photos/seed/wiki{rank}/320/180",
                "imageUrl": f"https://picsum.photos/seed/wiki{rank}/960/540",
                "contentUrl": f"https://en.wikipedia.org/wiki/Test_{rank}",
                "views": 842000 + rank * 12000,
                "viewsDelta": 12000 + rank * 500,
                "viewsDeltaPct": 12.4 + rank,
                "history": history,
                "artwork": {
                    "topic": f"{base}/{cat_id}.jpg",
                    "fallback": f"{base}/misc.jpg",
                },
            })
        count = len(stories)
        total = index_seconds + count * article_seconds
        return {
            "version": 2,
            "type": "wiki-common-knowledge.round",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": total,
            "trigger": "test",
            "wikiCommonKnowledge": {
                "sessionId": "test-wiki-ck-round",
                "triggeredBy": "manual",
                "title": "Wikipedia Common Knowledge",
                "indexTitle": f"What the world looked up — {count}",
                "dateline": "Wikipedia · most-read",
                "period": "daily",
                "storyCount": count,
                "indexSeconds": index_seconds,
                "articleSeconds": article_seconds,
                "loops": "once",
                "loopCount": 1,
                "cycleSeconds": total,
                "totalDurationSeconds": total,
                "showQr": True,
                "showSparkline": True,
                "attribution": "Wikipedia · Wikimedia pageviews",
                "indexArtwork": {
                    "topic": f"{base}/misc.jpg",
                    "fallback": f"{base}/misc.jpg",
                },
                "indexAccent": "#E897FF",
                "indexBackground": "#7A2396",
                "stories": stories,
            },
        }

    if args.type in ("overhead", "overhead-update"):
        home_lat, home_lon = 40.0, -111.0
        aircraft = []
        specs = [
            ("A1B2C3", "UAL123", "jet", 0, 8, 35000, 420),
            ("B2C3D4", "N12345", "light", 45, 12, 8500, 140),
            ("C3D4E5", "LIFEM1", "heli", 120, 6, 2500, 95),
            ("D4E5F6", "", "generic", 200, 18, 18000, 310),
            ("E5F6A7", "SWA456", "jet", 270, 10, 32000, 380),
            ("F6A7B8", "N9876Z", "light", 315, 14, 6500, 120),
            ("A7B8C9", "FDX789", "jet", 90, 20, 36000, 480),
            ("B8C9D0", "MEDEV1", "heli", 160, 5, 1500, 110, True),
        ]
        routes = [
            ("Salt Lake City", "Denver", "SLC", "DEN"),
            ("Provo", "Phoenix", "PVU", "PHX"),
            ("Salt Lake City", "Las Vegas", "SLC", "LAS"),
            ("Boise", "Salt Lake City", "BOI", "SLC"),
            ("Denver", "Los Angeles", "DEN", "LAX"),
            ("Salt Lake City", "Seattle", "SLC", "SEA"),
            ("Memphis", "Oakland", "MEM", "OAK"),
            ("Salt Lake City", "Ogden", "SLC", "OGD"),
        ]
        for idx, spec in enumerate(specs):
            hex_code, callsign, icon, bearing, dist, alt, gs = spec[:7]
            emergency = spec[7] if len(spec) > 7 else False
            br = math.radians(bearing)
            lat = home_lat + dist * math.cos(br) / 60.0
            lon = home_lon + dist * math.sin(br) / (60.0 * math.cos(math.radians(home_lat)))
            origin_city, dest_city, origin_iata, dest_iata = routes[idx % len(routes)]
            row = {
                "hex": hex_code,
                "callsign": callsign,
                "registration": callsign if callsign.startswith("N") else "",
                "iconClass": icon,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "track": (bearing + 70) % 360,
                "gsKt": gs,
                "altFt": alt,
                "dstNm": dist,
                "dirDeg": bearing,
                "route": {
                    "originCity": origin_city,
                    "destCity": dest_city,
                    "originIata": origin_iata,
                    "destIata": dest_iata,
                    "label": f"{origin_city} → {dest_city}",
                },
            }
            if emergency:
                row["emergency"] = True
            aircraft.append(row)

        overhead = {
            "sessionId": "test-overhead-round",
            "title": "Overhead Traffic",
            "home": {"lat": home_lat, "lon": home_lon},
            "radiusNm": 25,
            "pageSeconds": 8,
            "rowsPerPage": 4,
            "mapStyle": "radar",
            "aircraft": aircraft,
            "airports": [
                {"iata": "SLC", "lat": 40.788, "lon": -111.978},
                {"iata": "PVU", "lat": 40.219, "lon": -111.723},
            ],
            "geo": {
                "lines": [
                    [
                        {"lat": home_lat + 0.15, "lon": home_lon - 0.2},
                        {"lat": home_lat + 0.05, "lon": home_lon},
                        {"lat": home_lat - 0.1, "lon": home_lon + 0.15},
                    ],
                ],
            },
            "loops": "once",
            "loopCount": 1,
        }

        if args.type == "overhead-update":
            moved = [dict(ac) for ac in aircraft[:4]]
            for ac in moved:
                ac["lat"] = round(float(ac["lat"]) + 0.02, 5)
                ac["lon"] = round(float(ac["lon"]) + 0.01, 5)
            return {
                "version": 2,
                "type": "overhead.update",
                "device": args.sender,
                "timestamp": _iso_now(),
                "trigger": "test",
                "overhead": {
                    "sessionId": "test-overhead-round",
                    "aircraft": moved + aircraft[4:],
                },
            }

        page_seconds = overhead["pageSeconds"]
        rows = overhead["rowsPerPage"]
        pages = max(1, (len(aircraft) + rows - 1) // rows)
        total = max(60, pages * page_seconds + 20)
        return {
            "version": 2,
            "type": "overhead.round",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": total,
            "trigger": "test",
            "overhead": overhead,
        }

    if args.type == "notifications":
        return {
            "version": 2,
            "type": "alexa-notifications.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "test",
            "query": "show my notifications",
            "spokenResponse": (
                "You have 2 notifications. First, your package was delivered. "
                "Second, your reminder for tomorrow."
            ),
            "notifications": {
                "items": [
                    "Your package was delivered.",
                    "Your reminder for tomorrow.",
                ],
                "empty": False,
                "summary": "2 notifications",
            },
            "themeAccent": "#FF9900",
        }

    if args.type == "notifications-delivery":
        return {
            "version": 2,
            "type": "alexa-notifications.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": display_seconds,
            "trigger": "amazon-delivery-passive",
            "query": "Your package was delivered today and left on the porch.",
            "spokenResponse": "Your package was delivered today and left on the porch.",
            "notifications": {
                "items": ["Your package was delivered today and left on the porch."],
                "empty": False,
                "summary": "1 delivery update",
                "category": "delivery",
                "source": "amazon-shopping",
            },
            "themeAccent": "#FF9900",
        }

    if args.type in ("flightplan", "flightplan-board", "flightplan-live"):
        board = args.type == "flightplan-board"
        live = args.type == "flightplan-live"
        slc = {"iata": "SLC", "city": "Salt Lake City", "lat": 40.788, "lon": -111.977}
        nrt = {"iata": "NRT", "city": "Tokyo", "lat": 35.764, "lon": 140.386}
        icn = {"iata": "ICN", "city": "Seoul", "lat": 37.463, "lon": 126.44}

        def leg(number, origin, destination, depart, arrive, state, code, token):
            return {
                "id": f"flt_{number}",
                "airline": "DL",
                "number": number,
                "date": depart[:10],
                "origin": origin,
                "destination": destination,
                "scheduled": {"departure": depart, "arrival": arrive},
                "state": state,
                "status": {"displayLine": "ON TIME · GATE B14", "boardCode": code,
                           "colorToken": token},
                "durationMinutes": 735,
            }

        legs = [
            leg("167", slc, nrt, "2026-09-10T10:15:00-06:00", "2026-09-11T14:30:00+09:00",
                "active" if live else "upcoming", "ON", "good"),
            leg("173", nrt, icn, "2026-09-18T17:55:00+09:00", "2026-09-18T20:35:00+09:00",
                "upcoming", "+25", "warn"),
            leg("9", icn, slc, "2026-09-24T11:20:00+09:00", "2026-09-24T06:05:00-06:00",
                "upcoming", "ON", "good"),
        ]
        return {
            "version": 2,
            "type": "flightplan.flight",
            "mode": "board" if board else "next",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(args.seconds, 120),
            "asOf": _iso_now(),
            "quotaState": "ok",
            "waitingForQuota": False,
            "trip": {
                "id": "trip_test",
                "name": "Japan 2026",
                "kind": "ours",
                "traveller": None,
                "title": "in flight" if live else "upcoming flight",
            },
            "flight": {
                **legs[0],
                "latest": {
                    "departure": {"terminal": "A", "gate": "B14"},
                    "arrival": {"baggageBelt": "7"},
                },
                "registration": "N801DZ",
            },
            "flights": legs if board else [legs[0]],
            "status": {
                "displayLine": "ON TIME · GATE B14",
                "colorToken": "good",
                "boardCode": "ON",
            },
            "progress": {
                "phase": "airborne" if live else "upcoming",
                "fraction": 0.46 if live else 0.0,
                "durationMinutes": 735,
                "departsInMinutes": -320 if live else 20160,
                "remainingMinutes": 415 if live else 0,
            },
            "stage": {
                "mode": "live" if live else "preflight",
                "note": "in the air · position live" if live else "not departed",
                "position": ({"lat": 52.4, "lon": -168.9, "heading": 292}
                             if live else None),
                "route": {"origin": slc, "destination": nrt},
                "imageUrl": None,
            },
        }

    if args.type in ("route-planner", "route-planner-flight"):
        is_flight = args.type == "route-planner-flight"
        origin = {"name": "Home, US", "latitude": 40.0, "longitude": -111.0}
        destination = {"name": "Moab, UT, US", "latitude": 38.5733, "longitude": -109.5498}
        if is_flight:
            geometry = [[origin["latitude"], origin["longitude"]], [destination["latitude"], destination["longitude"]]]
            distance_miles, duration_min = 175.6, 66
        else:
            # Rough simplified driving polyline (real payloads carry many more points from OSRM).
            geometry = [
                [40.0, -111.0], [40.05, -111.3], [39.6, -110.6], [39.2, -110.0], [38.5733, -109.5498],
            ]
            distance_miles, duration_min = 177.1, 180
        return {
            "version": 2,
            "type": "route-planner.query",
            "device": args.sender,
            "timestamp": _iso_now(),
            "displaySeconds": max(display_seconds, 240),
            "trigger": "route-query",
            "query": "what is the distance between Saratoga Springs and Moab",
            "spokenResponse": "it's roughly 177 miles from Saratoga Springs to Moab",
            "mode": "flight" if is_flight else "driving",
            "origin": origin,
            "destination": destination,
            "distanceMiles": distance_miles,
            "durationMin": duration_min,
            "route": {"geometry": geometry},
        }

    raise ValueError(f"Unknown type: {args.type}")


def print_payload_summary(payload: dict, host: str, port: int, body: bytes) -> None:
    display_type = payload.get("type", "broadcast")
    print(f"Sent test {display_type} to {host}:{port}")
    print(f"UDP payload size: {len(body)} bytes")

    if display_type == "broadcast":
        message = payload.get("message", "")
        print(f"Message length: {len(message)} characters")
        if len(message) <= 160:
            print(json.dumps(payload, indent=2))
            return
        preview = f"{message[:120].rstrip()}…"
        print(json.dumps({**payload, "message": preview}, indent=2))
        return

    print(json.dumps(payload, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Send a test Alexa overlay UDP payload")
    parser.add_argument("--host", default="127.0.0.1", help="Target host (default: loopback)")
    parser.add_argument("--port", type=int, default=47832, help="UDP port")
    parser.add_argument(
        "--type",
        choices=["broadcast", "time", "weather", "weather-spoken", "indoor", "indoor-humidity", "air-quality", "air-quality-poor", "timers", "timers-nine", "timers-dense", "timer-fired", "reminder-fired", "alarms", "alarm-set", "shopping-list", "shopping-list-many", "tesla-battery", "tesla-battery-limited", "tesla-battery-stale", "tesla-battery-refreshing", "tesla-dashboard", "tesla-dashboard-stale", "tesla-dashboard-refreshing", "vivint-alarm", "notifications", "notifications-delivery", "processing", "processing-timeout", "web-open", "web-open-bad", "web-close", "system-reboot", "system-poweroff", "display-discover", "display-auth", "input-click", "input-key", "qr-url", "qr-wifi", "guest-photobooth", "input-text", "photo-slideshow", "roll-credits", "autodarts-dashboard", "autodarts-match", "autodarts-final", "autodarts-match-close", "huupe-live", "huupe-solo", "huupe-final", "huupe-session-close", "huupe-dashboard", "steam-now-playing", "steam-now-playing-close", "psn-now-playing", "psn-now-playing-close", "youtube-now-playing", "youtube-last-played", "youtube-live", "youtube-minimal", "youtube-now-playing-close", "music", "route-planner", "route-planner-flight", "flightplan", "flightplan-board", "flightplan-live", "trivia", "trivia-boolean", "trivia-single", "upside-news", "wiki-common-knowledge", "overhead", "overhead-update"],
        default="broadcast",
        help="Payload type to send",
    )
    parser.add_argument("--percent", type=int, default=78, help="Battery percent for --type tesla-battery")
    parser.add_argument("--url", default="https://example.com", help="Page for --type web-open")
    parser.add_argument("--pin", default="123456", help="PIN for --type display-auth")
    parser.add_argument("--message", default="This is a test broadcast message", help="Broadcast message body")
    parser.add_argument("--text", default="hunter2", help="Full string for --type input-text")
    parser.add_argument(
        "--press-enter",
        action="store_true",
        help="Also press Enter after typing, for --type input-text",
    )
    parser.add_argument("--sender", default="Kitchen Echo", help="Sender/device label")
    parser.add_argument("--destination", default="All devices", help="Broadcast destination label")
    parser.add_argument("--seconds", type=int, default=30, help="Requested display duration")
    parser.add_argument(
        "--long",
        action="store_true",
        help=f"Send a maximum-length broadcast message ({ALEXA_MAX_MESSAGE_CHARACTERS} characters)",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=ALEXA_MAX_MESSAGE_CHARACTERS,
        help="Character count used with --long",
    )
    parser.add_argument(
        "--secret",
        default=os.environ.get("LAN_UDP_SECRET") or os.environ.get("UDP_SECRET") or "",
        help="LAN UDP shared secret (AES-GCM). Defaults to LAN_UDP_SECRET env. "
             "Required when the display client has udpSecret set.",
    )
    args = parser.parse_args()

    if args.long:
        if args.type != "broadcast":
            parser.error("--long is only supported for --type broadcast")
        args.message = build_max_length_message(max(1, args.max_chars))

    payload = build_payload(args)
    wire = encode_outbound(payload, args.secret)
    body = json.dumps(wire, separators=(",", ":")).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(body, (args.host, args.port))
    sock.close()

    print_payload_summary(payload, args.host, args.port, body)
    if is_enabled(args.secret):
        print("(sent as AES-GCM v3 envelope)")


if __name__ == "__main__":
    main()
