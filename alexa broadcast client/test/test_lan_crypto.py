import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.lan_crypto import (
    MAX_SKEW_MS,
    decode_inbound,
    derive_key,
    encode_outbound,
    is_enabled,
    open_envelope,
    seal_json,
)

SECRET = "test-lan-udp-secret"
CLIENT_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_ROOT = CLIENT_ROOT.parent


def _fresh_ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class LanCryptoTests(unittest.TestCase):
    def test_is_enabled(self):
        self.assertFalse(is_enabled(""))
        self.assertFalse(is_enabled("   "))
        self.assertTrue(is_enabled(SECRET))

    def test_derive_key_sha256(self):
        import hashlib
        self.assertEqual(
            derive_key(SECRET),
            hashlib.sha256(SECRET.encode("utf-8")).digest(),
        )

    def test_seal_open_round_trip(self):
        payload = {
            "version": 2,
            "type": "time.query",
            "timestamp": _fresh_ts(),
            "query": "what time is it",
        }
        envelope = seal_json(payload, SECRET)
        self.assertEqual(envelope["v"], 3)
        self.assertEqual(envelope["alg"], "aes-256-gcm")
        self.assertEqual(open_envelope(envelope, SECRET), payload)

    def test_rejects_wrong_key_tamper_and_stale(self):
        payload = {"version": 2, "type": "broadcast", "timestamp": _fresh_ts(), "message": "hi"}
        envelope = seal_json(payload, SECRET)
        self.assertIsNone(open_envelope(envelope, "other-secret"))
        tampered = dict(envelope)
        tampered["c"] = tampered["c"][:-4] + "AAAA"
        self.assertIsNone(open_envelope(tampered, SECRET))

        stale_ts = (
            datetime.now(timezone.utc) - timedelta(milliseconds=MAX_SKEW_MS + 5000)
        ).isoformat().replace("+00:00", "Z")
        stale = seal_json(
            {"version": 2, "type": "broadcast", "timestamp": stale_ts, "message": "old"},
            SECRET,
        )
        self.assertIsNone(open_envelope(stale, SECRET))

    def test_encode_decode_modes(self):
        payload = {
            "version": 2,
            "type": "display.announce",
            "timestamp": _fresh_ts(),
            "display": {"id": "x"},
        }
        plain = encode_outbound(payload, "")
        self.assertEqual(plain["type"], "display.announce")
        self.assertEqual(decode_inbound(json.dumps(plain), ""), payload)
        self.assertIsNone(decode_inbound(json.dumps(plain), SECRET))

        enc = encode_outbound(payload, SECRET)
        self.assertEqual(enc["v"], 3)
        self.assertEqual(decode_inbound(json.dumps(enc), SECRET), payload)
        self.assertIsNone(decode_inbound(json.dumps(enc), ""))

    def test_node_opens_python_sealed_envelope(self):
        payload = {
            "version": 2,
            "type": "input.pointer",
            "timestamp": _fresh_ts(),
            "pointer": {"action": "move", "x": 10, "y": 20},
        }
        envelope = seal_json(payload, SECRET)
        script = (
            "const { openEnvelope } = require('./src/lan-crypto');"
            "const env = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            f"const out = openEnvelope(env, {json.dumps(SECRET)});"
            "process.stdout.write(JSON.stringify(out));"
        )
        result = subprocess.run(
            ["node", "-e", script],
            input=json.dumps(envelope),
            text=True,
            cwd=str(BRIDGE_ROOT),
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            self.fail(f"node open failed: {result.stderr or result.stdout}")
        self.assertEqual(json.loads(result.stdout), payload)


if __name__ == "__main__":
    unittest.main()
