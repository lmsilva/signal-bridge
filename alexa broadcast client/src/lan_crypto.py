"""Shared-secret AES-256-GCM for bridge ↔ display UDP.

Wire envelope (protocol v3)::

    {"v": 3, "alg": "aes-256-gcm", "n": "<base64 nonce>", "c": "<base64 ciphertext||tag>"}

Inner plaintext is the existing v2 JSON payload. Key = SHA-256(utf8(secret)).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ALG_NAME = "aes-256-gcm"
NONCE_LEN = 12
TAG_LEN = 16
MAX_SKEW_MS = 120 * 1000


def normalize_secret(secret: str | None) -> str:
    return str(secret or "").strip()


def is_enabled(secret: str | None) -> bool:
    return bool(normalize_secret(secret))


def derive_key(secret: str | None) -> bytes:
    return hashlib.sha256(normalize_secret(secret).encode("utf-8")).digest()


def _iso_from_ms(now_ms: int | None = None) -> str:
    if now_ms is None:
        dt = datetime.now(timezone.utc)
    else:
        dt = datetime.fromtimestamp(now_ms / 1000.0, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def ensure_timestamp(payload: dict, now_ms: int | None = None) -> dict:
    if not isinstance(payload, dict):
        return payload
    now_iso = _iso_from_ms(now_ms)
    # Always stamp sentAt at seal time. Activity timestamps from Alexa history
    # can be minutes old by the time we UDP — freshness must not use those.
    out = dict(payload)
    out["timestamp"] = payload.get("timestamp") or now_iso
    out["sentAt"] = now_iso
    return out


def parse_timestamp_ms(value: Any) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except (TypeError, ValueError, OSError):
        return None


def is_fresh(payload: dict, now_ms: int | None = None) -> bool:
    if not isinstance(payload, dict):
        return False
    # Prefer wire send time; fall back to payload timestamp for older peers.
    ms = parse_timestamp_ms(payload.get("sentAt"))
    if ms is None:
        ms = parse_timestamp_ms(payload.get("timestamp"))
    if ms is None:
        return False
    if now_ms is None:
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    return abs(now_ms - ms) <= MAX_SKEW_MS


def seal_json(
    payload: dict,
    secret: str,
    *,
    nonce: bytes | None = None,
    now_ms: int | None = None,
) -> dict:
    if not is_enabled(secret):
        raise ValueError("LAN UDP secret is not configured")
    plain = ensure_timestamp(payload, now_ms)
    plaintext = json.dumps(plain, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if nonce is None:
        nonce = os.urandom(NONCE_LEN)
    elif len(nonce) != NONCE_LEN:
        raise ValueError(f"nonce must be {NONCE_LEN} bytes")
    aesgcm = AESGCM(derive_key(secret))
    combined = aesgcm.encrypt(nonce, plaintext, None)
    return {
        "v": 3,
        "alg": ALG_NAME,
        "n": base64.b64encode(nonce).decode("ascii"),
        "c": base64.b64encode(combined).decode("ascii"),
    }


def open_envelope(envelope: dict, secret: str, *, now_ms: int | None = None) -> dict | None:
    if not is_enabled(secret) or not isinstance(envelope, dict):
        return None
    if envelope.get("v") != 3 or envelope.get("alg") != ALG_NAME:
        return None
    try:
        nonce = base64.b64decode(str(envelope.get("n") or ""), validate=False)
        combined = base64.b64decode(str(envelope.get("c") or ""), validate=False)
        if len(nonce) != NONCE_LEN or len(combined) <= TAG_LEN:
            return None
        aesgcm = AESGCM(derive_key(secret))
        plaintext = aesgcm.decrypt(nonce, combined, None)
        payload = json.loads(plaintext.decode("utf-8"))
        if not isinstance(payload, dict) or not is_fresh(payload, now_ms):
            return None
        return payload
    except Exception:
        return None


def encode_outbound(payload: dict, secret: str | None) -> dict:
    if is_enabled(secret):
        return seal_json(payload, secret)
    return payload


def decode_inbound(raw: bytes | str, secret: str | None, *, now_ms: int | None = None) -> dict | None:
    try:
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw or "")
        parsed = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None

    looks_encrypted = parsed.get("v") == 3 and parsed.get("alg") == ALG_NAME
    if is_enabled(secret):
        if not looks_encrypted:
            return None
        return open_envelope(parsed, secret, now_ms=now_ms)
    if looks_encrypted:
        return None
    return parsed
