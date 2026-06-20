import argparse
import json
import socket
from datetime import datetime, timezone

# Alexa does not publish a household-announcement character cap, but playback is
# limited to roughly 40 seconds of audio. Elsewhere in Alexa, TTS text tops out
# at 8000 characters — the same limit our overlay client accepts.
ALEXA_MAX_MESSAGE_CHARACTERS = 8000


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


def build_payload(args) -> dict:
    return {
        "version": 1,
        "message": args.message,
        "sender": args.sender,
        "destination": args.destination,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "displaySeconds": args.seconds,
        "trigger": "test",
    }


def print_payload_summary(payload: dict, host: str, port: int, body: bytes) -> None:
    message = payload["message"]
    print(f"Sent test broadcast to {host}:{port}")
    print(f"Message length: {len(message)} characters")
    print(f"UDP payload size: {len(body)} bytes")

    if len(message) <= 160:
        print(json.dumps(payload, indent=2))
        return

    preview = f"{message[:120].rstrip()}…"
    print(json.dumps({**payload, "message": preview}, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Send a test Alexa broadcast overlay message")
    parser.add_argument("--host", default="127.0.0.1", help="Target host (default: loopback)")
    parser.add_argument("--port", type=int, default=47832, help="UDP port")
    parser.add_argument("--message", default="This is a test broadcast message", help="Message body")
    parser.add_argument("--sender", default="Test Sender", help="Sender label")
    parser.add_argument("--destination", default="All devices", help="Destination label")
    parser.add_argument("--seconds", type=int, default=120, help="Requested display duration")
    parser.add_argument(
        "--long",
        action="store_true",
        help=(
            f"Send a maximum-length message ({ALEXA_MAX_MESSAGE_CHARACTERS} characters) "
            "to test scrolling"
        ),
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=ALEXA_MAX_MESSAGE_CHARACTERS,
        help="Character count used with --long (default: Alexa/client maximum)",
    )
    args = parser.parse_args()

    if args.long:
        args.message = build_max_length_message(max(1, args.max_chars))

    payload = build_payload(args)
    body = json.dumps(payload).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(body, (args.host, args.port))
    sock.close()

    print_payload_summary(payload, args.host, args.port, body)


if __name__ == "__main__":
    main()
