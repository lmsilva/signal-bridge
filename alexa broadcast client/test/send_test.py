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
        choices=["broadcast", "time", "weather", "weather-spoken", "indoor", "indoor-humidity", "air-quality", "air-quality-poor", "timers", "timer-fired"],
        default="broadcast",
        help="Payload type to send",
    )
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
