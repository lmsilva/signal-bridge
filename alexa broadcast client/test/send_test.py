import argparse
import json
import socket
from datetime import datetime, timezone, timedelta

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

    if args.type == "timers":
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
                    "durationSec": 900,
                    "remainingSec": 240,
                    "status": "ON",
                    "fireAt": (now + timedelta(minutes=4)).isoformat().replace("+00:00", "Z"),
                },
                {
                    "amazonId": "timer-2",
                    "device": "Bedroom Echo",
                    "label": None,
                    "durationSec": 300,
                    "remainingSec": 75,
                    "status": "ON",
                    "fireAt": (now + timedelta(seconds=75)).isoformat().replace("+00:00", "Z"),
                },
            ],
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

    if args.type in ("tesla-dashboard", "tesla-dashboard-stale"):
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
        choices=["broadcast", "time", "weather", "weather-spoken", "indoor", "indoor-humidity", "air-quality", "air-quality-poor", "timers", "timer-fired", "alarms", "alarm-set", "tesla-battery", "tesla-battery-limited", "tesla-battery-stale", "tesla-dashboard", "tesla-dashboard-stale", "vivint-alarm", "notifications"],
        default="broadcast",
        help="Payload type to send",
    )
    parser.add_argument("--percent", type=int, default=78, help="Battery percent for --type tesla-battery")
    parser.add_argument("--message", default="This is a test broadcast message", help="Broadcast message body")
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
    args = parser.parse_args()

    if args.long:
        if args.type != "broadcast":
            parser.error("--long is only supported for --type broadcast")
        args.message = build_max_length_message(max(1, args.max_chars))

    payload = build_payload(args)
    body = json.dumps(payload).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(body, (args.host, args.port))
    sock.close()

    print_payload_summary(payload, args.host, args.port, body)


if __name__ == "__main__":
    main()
