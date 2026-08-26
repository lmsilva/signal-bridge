#!/usr/bin/env python3
"""YouTube Lounge sidecar.

There is no official way to detect YouTube playback, and the only maintained
client for the undocumented Lounge API is `pyytlounge` (Python). Rather than
reimplement the protocol in Node, the bridge spawns this script and speaks
NDJSON over stdin/stdout.

The split is deliberate and narrow: this process knows the Lounge protocol and
nothing else. All credentials, caching, history and display logic stay in Node,
so a protocol break is a one-file fix here (youtube.md §2.1).

Protocol
--------
stdin  — one JSON command per line:
    {"cmd": "connect", "id": ..., "device": {...}}
    {"cmd": "disconnect", "id": ...}
    {"cmd": "pair-code", "id": ..., "code": "123456789012"}
    {"cmd": "pair-screen", "id": ..., "screenId": "..."}
    {"cmd": "discover", "id": ..., "timeout": 5}
    {"cmd": "refresh", "id": ..., "device": {...}}
    {"cmd": "poll", "id": ..., "deviceId": "..."}
    {"cmd": "poll-all", "id": ...}
    {"cmd": "shutdown"}

stdout — one JSON event per line:
    {"event": "ready", "loungeAvailable": true}
    {"event": "result", "id": ..., "ok": true, "data": {...}}
    {"event": "now-playing", "deviceId": ..., "videoId": ..., "durationSeconds": ...}
    {"event": "state", "deviceId": ..., "state": "Playing", "position": 12.4}
    {"event": "ad", "deviceId": ..., "playing": true, "contentVideoId": "..."}
    {"event": "up-next", "deviceId": ..., "videoId": ...}
    {"event": "auth", "deviceId": ..., "authState": {...}, "expiry": ...}
    {"event": "disconnected", "deviceId": ...}
    {"event": "log", "level": "warn", "message": "..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import sys
from typing import Any, Dict, Optional

try:  # pragma: no cover - exercised only where the dependency is installed
    # `State` lives on the package root, not on `.wrapper`. Importing it from
    # the wrong module silently disabled the whole agent, so keep every name in
    # this block resolvable from the documented public surface.
    from pyytlounge import EventListener, State, YtLoungeApi
    from pyytlounge.dial import get_screen_id_from_dial

    LOUNGE_AVAILABLE = True
    LOUNGE_IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - the bridge degrades instead of crashing
    YtLoungeApi = None  # type: ignore[assignment]
    EventListener = object  # type: ignore[assignment]
    State = None  # type: ignore[assignment]
    get_screen_id_from_dial = None  # type: ignore[assignment]
    LOUNGE_AVAILABLE = False
    # The reason matters: "pyytlounge is absent" and "pyytlounge is present but
    # its API moved" need different fixes, and both look identical downstream.
    LOUNGE_IMPORT_ERROR = f"{type(error).__name__}: {error}"


DEVICE_NAME = "Signal Bridge"
SSDP_TARGET = "urn:dial-multiscreen-org:service:dial:1"
# Lounge long-polls end routinely (TV sleep, network blip, server close).
# Without a loop the bridge looks "linked" forever while hearing nothing.
SUBSCRIBE_RETRY_SECONDS = 1.0
CONNECT_RETRY_SECONDS = 10.0
CONNECT_RETRY_MAX_SECONDS = 60.0


def emit(payload: Dict[str, Any]) -> None:
    """One JSON object per line, flushed — Node reads this as a stream."""
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(level: str, message: str) -> None:
    emit({"event": "log", "level": level, "message": message})


class _EmitHandler(logging.Handler):
    """Route the library's own logging into the NDJSON stream."""

    def emit(self, record: logging.LogRecord) -> None:
        level = "warn" if record.levelno >= logging.WARNING else "info"
        log(level, f"pyytlounge: {record.getMessage()}")


def library_logger() -> logging.Logger:
    """pyytlounge defaults to a DEBUG logger that dumps tracebacks on stderr.

    An expired pairing code is an expected outcome, not an incident, so the
    library gets a logger that keeps its noise inside the protocol.
    """
    logger = logging.getLogger("pyytlounge.bridge")
    if not logger.handlers:
        logger.addHandler(_EmitHandler())
        logger.propagate = False
    logger.setLevel(logging.WARNING)
    return logger


def new_api(listener: Any = None) -> Any:
    return YtLoungeApi(DEVICE_NAME, listener, library_logger())


def state_name(state: Any) -> str:
    if state is None:
        return "Unknown"
    return getattr(state, "name", str(state))


def ad_is_playing(state: Any) -> bool:
    """True only while Lounge reports an active ad player state.

    Older logic treated anything except Stopped/Unknown as an ad, so a sticky
    or missing ad-end event wedged detection forever (no auto-push, manual
    preview fell back to stale history).
    """
    return state_name(state) in {"Playing", "Buffering", "Starting", "Advertisement"}


def parse_auth_state(value: Any) -> Optional[dict]:
    """Node stores the auth blob as a JSON string; accept either form."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def screen_name_of(api: Any) -> Optional[str]:
    """`screen_name` raises until the screen is linked — never let that escape."""
    try:
        return api.screen_name
    except Exception:
        return None


def screen_device_name_of(api: Any) -> Optional[str]:
    """`screen_device_name` raises until the session is connected."""
    try:
        return api.screen_device_name
    except Exception:
        return None


class BridgeListener(EventListener):  # type: ignore[misc]
    """Forwards the five events the bridge cares about (youtube.md §3.1).

    pyytlounge hands every callback a typed event object; the bridge speaks in
    flat JSON, so this is the only place that knows either shape.
    """

    def __init__(self, device_id: str):
        self.device_id = device_id

    async def now_playing_changed(self, event: Any) -> None:
        video_id = getattr(event, "video_id", None)
        state = state_name(getattr(event, "state", None))
        if not video_id:
            # Silence here is indistinguishable from a TV that never spoke, and
            # that ambiguity has cost two debugging sessions.
            log("info", f"now-playing for {self.device_id} had no video id (state={state})")
            return
        log("info", f"now-playing {video_id} on {self.device_id} state={state}")
        emit(
            {
                "event": "now-playing",
                "deviceId": self.device_id,
                "videoId": video_id,
                "durationSeconds": float(getattr(event, "duration", 0) or 0),
                "position": float(getattr(event, "current_time", 0) or 0),
                "state": state,
            }
        )

    async def playback_state_changed(self, event: Any) -> None:
        state = state_name(getattr(event, "state", None))
        position = float(getattr(event, "current_time", 0) or 0)
        log("info", f"state {state} on {self.device_id} at {position:.0f}s")
        emit(
            {
                "event": "state",
                "deviceId": self.device_id,
                "state": state,
                "position": position,
                "durationSeconds": float(getattr(event, "duration", 0) or 0),
            }
        )

    def _emit_ad(self, event: Any) -> None:
        payload: Dict[str, Any] = {
            "event": "ad",
            "deviceId": self.device_id,
            "playing": ad_is_playing(getattr(event, "ad_state", None)),
        }
        content_id = getattr(event, "content_video_id", None)
        if content_id:
            payload["contentVideoId"] = str(content_id)
        emit(payload)

    async def ad_playing_changed(self, event: Any) -> None:
        self._emit_ad(event)

    async def ad_state_changed(self, event: Any) -> None:
        self._emit_ad(event)

    async def autoplay_up_next_changed(self, event: Any) -> None:
        video_id = getattr(event, "video_id", None)
        if video_id:
            emit({"event": "up-next", "deviceId": self.device_id, "videoId": str(video_id)})

    async def disconnected(self, event: Any) -> None:
        emit(
            {
                "event": "disconnected",
                "deviceId": self.device_id,
                "reason": getattr(event, "reason", None),
            }
        )


async def ssdp_discover(timeout: float = 5.0) -> list:
    """SSDP sweep for DIAL endpoints.

    pyytlounge can turn a DIAL endpoint into a screen ID, but finding the
    endpoint is out of scope for the library, so we do the multicast search
    here (youtube.md §8.1).
    """
    message = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1900\r\n"
        'MAN: "ssdp:discover"\r\n'
        f"MX: {int(timeout)}\r\n"
        f"ST: {SSDP_TARGET}\r\n"
        "\r\n"
    ).encode("utf-8")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(0.5)

    found: Dict[str, Dict[str, Any]] = {}
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    try:
        sock.sendto(message, ("239.255.255.250", 1900))
        while loop.time() < deadline:
            try:
                data, addr = await loop.run_in_executor(None, sock.recvfrom, 2048)
            except (socket.timeout, OSError):
                await asyncio.sleep(0.05)
                continue
            headers = {}
            for line in data.decode("utf-8", "ignore").split("\r\n")[1:]:
                if ":" in line:
                    key, _, value = line.partition(":")
                    headers[key.strip().upper()] = value.strip()
            location = headers.get("LOCATION")
            if not location:
                continue
            found[location] = {
                "location": location,
                "address": addr[0],
                "server": headers.get("SERVER", ""),
                "usn": headers.get("USN", ""),
                "wakeup": headers.get("WAKEUP", ""),
            }
    finally:
        sock.close()
    return list(found.values())


async def screen_from_dial(location: str) -> Dict[str, Any]:
    """DIAL endpoint → YouTube screen id, or empty when YouTube is not there."""
    if not LOUNGE_AVAILABLE:
        return {}
    try:
        result = await get_screen_id_from_dial(location)
    except Exception as error:  # pragma: no cover - network dependent
        log("warn", f"DIAL screen id lookup failed for {location}: {error}")
        return {}
    if result is None:
        return {}
    return {
        "screenId": getattr(result, "screen_id", None),
        "screenName": getattr(result, "screen_name", None) or None,
    }


def _settle(future: "asyncio.Future", result: Dict[str, Any]) -> None:
    if not future.done():
        future.set_result(result)


class Agent:
    def __init__(self) -> None:
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.stopping = False

    # ------------------------------------------------------------- helpers

    def _emit_auth(self, device_id: str, api: Any) -> None:
        """Hand the serialised auth state back to Node, which owns storage.

        `auth.serialize()` — not `store_auth_state()` — because only the former
        round-trips through `load_auth_state`.
        """
        try:
            state = api.auth.serialize()
        except Exception as error:
            log("warn", f"Could not serialise lounge auth state: {error}")
            return
        emit(
            {
                "event": "auth",
                "deviceId": device_id,
                "authState": state,
                "expiry": getattr(api.auth, "expiry", None),
                "screenId": getattr(api.auth, "screen_id", None),
                "screenName": screen_name_of(api),
                "screenDeviceName": screen_device_name_of(api),
            }
        )

    def _restore_auth(self, api: Any, device: Dict[str, Any]) -> None:
        auth_state = parse_auth_state(device.get("authState"))
        if not auth_state:
            return
        try:
            api.load_auth_state(auth_state)
        except Exception as error:
            log("warn", f"Could not restore lounge auth state: {error}")

    # ------------------------------------------------------------ commands

    async def connect(self, device: Dict[str, Any]) -> Dict[str, Any]:
        """Start a long-lived subscription and report how the handshake went.

        The API owns an aiohttp session that only exists inside its context
        manager, so the whole device lifetime runs in one task rather than
        being assembled from separate calls.
        """
        device_id = str(device.get("id"))
        await self.disconnect(device_id)
        handshake: "asyncio.Future" = asyncio.get_running_loop().create_future()
        task = asyncio.create_task(self._run_device(device_id, device, handshake))
        self.sessions[device_id] = {"task": task, "api": None}
        result = await handshake
        if not result.get("ok"):
            await self.disconnect(device_id)
        return result

    async def _reestablish(self, device_id: str, api: Any) -> Optional[str]:
        """Open a new bind session, refreshing tokens only if that fails.

        Returns None on success, or an error code (`needs-relink` / `unreachable`).

        A subscribe ending is normal and says nothing about the token, but this
        used to rotate auth on every cycle — trading a token the screen honours
        for one it may not, roughly every five minutes. The result is persisted
        by `_emit_auth`, so a bad rotation outlives a container restart and the
        TV stays bound-but-silent. Reconnect first; only refresh if it fails.
        """
        try:
            if await api.connect():
                return None
        except Exception as error:
            log("warn", f"Lounge reconnect for {device_id} failed: {error}")

        try:
            if not await api.refresh_auth():
                return "needs-relink"
        except Exception as error:
            log("warn", f"Lounge auth refresh for {device_id} failed: {error}")
            return "needs-relink"
        self._emit_auth(device_id, api)
        try:
            if not await api.connect():
                return "unreachable"
        except Exception as error:
            log("warn", f"Lounge reconnect for {device_id} failed: {error}")
            return "unreachable"
        log("info", f"Lounge re-bound {device_id} after an auth refresh")
        return None

    async def _subscribe_forever(self, device_id: str, api: Any) -> Optional[str]:
        """Keep the Lounge long-poll alive across normal subscribe endings.

        `subscribe()` returns when YouTube closes the bind stream — that is
        expected, not fatal. Exiting here used to leave the TV marked linked
        with no events, so auto-push and Now Playing both went silent.
        """
        delay = CONNECT_RETRY_SECONDS
        while not self.stopping:
            try:
                await api.get_now_playing()
            except Exception as error:
                log("warn", f"Now-playing poll for {device_id} failed: {error}")
            try:
                await api.subscribe()
                # Normal completion — Lounge closed the long-poll.
                log("info", f"Lounge subscribe ended for {device_id}; reconnecting")
                delay = CONNECT_RETRY_SECONDS
            except asyncio.CancelledError:
                raise
            except Exception as error:
                log("warn", f"Lounge subscribe for {device_id} failed: {error}")

            if self.stopping:
                return None

            failure = await self._reestablish(device_id, api)
            if failure == "needs-relink":
                return failure
            if failure == "unreachable":
                # TV asleep / off — keep trying; do not tear the device down.
                await asyncio.sleep(delay)
                delay = min(delay * 2, CONNECT_RETRY_MAX_SECONDS)
                continue

            await asyncio.sleep(SUBSCRIBE_RETRY_SECONDS)
        return None

    async def _run_device(
        self, device_id: str, device: Dict[str, Any], handshake: "asyncio.Future",
    ) -> None:
        fatal_error: Optional[str] = None
        try:
            async with new_api(BridgeListener(device_id)) as api:
                session = self.sessions.get(device_id)
                if session is not None:
                    session["api"] = api
                failure = await self._authorise(device_id, device, api)
                if failure is not None:
                    _settle(handshake, failure)
                    return
                _settle(handshake, {
                    "ok": True,
                    "screenName": screen_name_of(api),
                    "screenDeviceName": screen_device_name_of(api),
                })
                # Apple TV often stays silent until asked — seed current video
                # before the long-lived subscribe loop blocks this task.
                fatal_error = await self._subscribe_forever(device_id, api)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            _settle(handshake, {"ok": False, "error": str(error)})
            log("warn", f"Lounge subscription for {device_id} ended: {error}")
            fatal_error = str(error)
        finally:
            _settle(handshake, {"ok": False, "error": fatal_error or "unreachable"})
            # Drop a dead session so poll/connect do not talk to a closed API.
            current = self.sessions.get(device_id)
            if current and current.get("task") is asyncio.current_task():
                self.sessions.pop(device_id, None)
            # One dead device link must not affect the others (§12.13), so the
            # failure is reported and contained here.
            payload: Dict[str, Any] = {"event": "disconnected", "deviceId": device_id}
            if fatal_error:
                payload["reason"] = fatal_error
            emit(payload)

    async def _authorise(
        self, device_id: str, device: Dict[str, Any], api: Any,
    ) -> Optional[Dict[str, Any]]:
        """Returns None on success, or the failure result to report."""
        self._restore_auth(api, device)

        if api.linked():
            if not await api.refresh_auth():
                return {"ok": False, "error": "needs-relink"}
        else:
            # §8.3 layer 2: a wiped token store costs nothing as long as the
            # screen ID survived, because re-pairing needs no code.
            screen_id = device.get("screenId")
            if not screen_id:
                return {"ok": False, "error": "needs-relink"}
            if not await api.pair_with_screen_id(screen_id):
                return {"ok": False, "error": "needs-relink"}
        self._emit_auth(device_id, api)

        if not await api.connect():
            return {"ok": False, "error": "unreachable"}
        # "Bound" and "receiving playback events" are different things, and only
        # the first was ever observable. Say so, so a silent screen is legible.
        log("info", f"Lounge bound {device_id} (screen={screen_name_of(api)})")
        return None

    async def disconnect(self, device_id: str) -> Dict[str, Any]:
        session = self.sessions.pop(str(device_id), None)
        if not session:
            return {"ok": True}
        api = session.get("api")
        if api is not None:
            try:
                await api.disconnect()
            except Exception:
                # Raises when it was never connected, which is not an error here.
                pass
        task = session.get("task")
        if task is not None:
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        return {"ok": True}

    async def pair_code(self, device_id: str, code: str) -> Dict[str, Any]:
        cleaned = "".join(ch for ch in str(code) if ch.isdigit())
        if len(cleaned) < 12:
            return {"ok": False, "error": "A TV code is 12 digits"}
        async with new_api() as api:
            try:
                paired = await api.pair(cleaned)
            except Exception:
                paired = False
            if not paired:
                # This is the common failure and deserves its own message: codes
                # expire quickly and a generic error wastes the user's time (§8.2).
                return {"ok": False, "error": "code-expired"}
            self._emit_auth(device_id, api)
            return {
                "ok": True,
                "screenId": api.auth.screen_id,
                "screenName": screen_name_of(api),
                "screenDeviceName": screen_device_name_of(api),
                "authState": api.auth.serialize(),
            }

    async def pair_screen(self, device_id: str, screen_id: str) -> Dict[str, Any]:
        async with new_api() as api:
            try:
                paired = await api.pair_with_screen_id(screen_id)
            except Exception:
                paired = False
            if not paired:
                return {"ok": False, "error": "needs-relink"}
            self._emit_auth(device_id, api)
            return {
                "ok": True,
                "screenId": api.auth.screen_id or screen_id,
                "screenName": screen_name_of(api),
                "screenDeviceName": screen_device_name_of(api),
                "authState": api.auth.serialize(),
            }

    async def discover(self, timeout: float) -> Dict[str, Any]:
        endpoints = await ssdp_discover(timeout)
        results = []
        for endpoint in endpoints:
            results.append({**endpoint, **await screen_from_dial(endpoint["location"])})
        return {"ok": True, "devices": results}

    async def refresh(self, device: Dict[str, Any]) -> Dict[str, Any]:
        device_id = str(device.get("id"))
        async with new_api() as api:
            self._restore_auth(api, device)
            if not api.paired() and device.get("screenId"):
                api.auth.screen_id = device["screenId"]
            if not api.paired():
                return {"ok": False, "error": "needs-relink"}
            try:
                refreshed = await api.refresh_auth()
            except Exception:
                refreshed = False
            if not refreshed:
                return {"ok": False, "error": "needs-relink"}
            self._emit_auth(device_id, api)
            return {"ok": True}

    async def poll(self, device_id: str) -> Dict[str, Any]:
        """Ask a connected screen to re-emit now-playing / state."""
        session = self.sessions.get(str(device_id))
        api = session.get("api") if session else None
        if api is None:
            return {"ok": False, "error": "not-connected"}
        try:
            await api.get_now_playing()
            return {"ok": True}
        except Exception as error:
            return {"ok": False, "error": str(error)}

    async def poll_all(self) -> Dict[str, Any]:
        results = []
        for device_id in list(self.sessions):
            results.append({"deviceId": device_id, **(await self.poll(device_id))})
        return {"ok": True, "devices": results}

    # -------------------------------------------------------------- driver

    async def handle(self, message: Dict[str, Any]) -> None:
        command = message.get("cmd")
        request_id = message.get("id")

        if command == "shutdown":
            self.stopping = True
            for device_id in list(self.sessions):
                await self.disconnect(device_id)
            return

        if not LOUNGE_AVAILABLE:
            emit({
                "event": "result",
                "id": request_id,
                "ok": False,
                "error": "pyytlounge-missing",
                "detail": LOUNGE_IMPORT_ERROR,
            })
            return

        try:
            if command == "connect":
                result = await self.connect(message.get("device") or {})
            elif command == "disconnect":
                result = await self.disconnect(str(message.get("deviceId")))
            elif command == "pair-code":
                result = await self.pair_code(str(message.get("deviceId")), message.get("code"))
            elif command == "pair-screen":
                result = await self.pair_screen(
                    str(message.get("deviceId")), str(message.get("screenId"))
                )
            elif command == "discover":
                result = await self.discover(float(message.get("timeout") or 5))
            elif command == "refresh":
                result = await self.refresh(message.get("device") or {})
            elif command == "poll":
                result = await self.poll(str(message.get("deviceId") or ""))
            elif command == "poll-all":
                result = await self.poll_all()
            else:
                result = {"ok": False, "error": f"unknown command: {command}"}
        except Exception as error:
            result = {"ok": False, "error": str(error)}

        emit({"event": "result", "id": request_id, **result})


async def main() -> None:
    agent = Agent()
    emit({
        "event": "ready",
        "loungeAvailable": LOUNGE_AVAILABLE,
        "error": LOUNGE_IMPORT_ERROR,
    })

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while not agent.stopping:
        line = await reader.readline()
        if not line:
            break
        text = line.decode("utf-8", "ignore").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            log("warn", "Ignoring malformed command line")
            continue
        # Each command runs concurrently so a slow SSDP sweep does not block
        # playback events from an already-connected screen.
        asyncio.create_task(agent.handle(message))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
