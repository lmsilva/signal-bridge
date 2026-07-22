"""Persistent web-browser display mode.

Handles ``web.open`` / ``web.close`` UDP commands by spawning (and killing) a
separate WebView2 host process (``webview_host.py`` / ``webview-host.exe``).
The page stays on screen until an explicit close command arrives — regular
overlays keep working on top of it and time out as usual.
"""

import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

PREFLIGHT_TIMEOUT_SEC = 6
# If the host process dies this quickly it never got the page up
# (missing WebView2 runtime, bad install, crash) — surface the friendly error.
STARTUP_GRACE_SEC = 4.0

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
}


def _is_ssl_failure(error: Exception) -> bool:
    if isinstance(error, ssl.SSLError):
        return True
    if isinstance(error, urllib.error.URLError):
        return isinstance(getattr(error, "reason", None), ssl.SSLError)
    return False


def preflight_url(url: str, timeout: float = PREFLIGHT_TIMEOUT_SEC) -> bool:
    """True when the host answers at all — WebView2 can still render 4xx pages.

    Only network failures (DNS, timeout, connection refused) block opening.
    Sites like Google often return non-2xx or bot challenges to urllib while
    loading fine in a real Chromium WebView.
    """
    request = urllib.request.Request(url, headers=_BROWSER_HEADERS)
    contexts = [None]
    for context in contexts:
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=context):
                return True
        except urllib.error.HTTPError:
            # Server answered (403/404/503/…) — let the browser render it.
            return True
        except Exception as exc:  # noqa: BLE001 - any network failure = not displayable
            # Frozen builds can lack a CA bundle; retry once unverified like
            # weather/map fetches do.
            if _is_ssl_failure(exc) and context is None:
                contexts.append(ssl._create_unverified_context())  # noqa: SLF001
                continue
            return False
    return False


def build_web_error_payload(source_payload: dict) -> dict:
    """Friendly failure message shown via the normal overlay + timeout."""
    web = source_payload.get("web") or {}
    try:
        seconds = int(web.get("errorDisplaySeconds") or 20)
    except (TypeError, ValueError):
        seconds = 20
    return {
        "version": 2,
        "type": "broadcast",
        "message": "Cannot display content at this time",
        "sender": "Web Display",
        "destination": None,
        "displaySeconds": max(5, seconds),
        "trigger": "web-open-failed",
    }


def build_web_opening_payload(source_payload: dict) -> dict:
    """Brief ack so the user always sees that the push was received."""
    url = (source_payload.get("web") or {}).get("url") or ""
    host = url
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.netloc or url
    except Exception:  # noqa: BLE001
        pass
    return {
        "version": 2,
        "type": "broadcast",
        "message": f"Opening {host}…",
        "sender": "Web Display",
        "destination": None,
        "displaySeconds": 8,
        "trigger": "web-open-ack",
    }


def resolve_host_executable(frozen: bool | None = None, executable: str | None = None) -> Path | None:
    """Path to webview-host.exe (frozen) or webview_host.py (dev), or None if missing."""
    is_frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    exe = executable or sys.executable
    if is_frozen:
        host = Path(exe).resolve().parent / "webview-host.exe"
        return host if host.is_file() else None
    host_script = Path(__file__).resolve().parent / "webview_host.py"
    return host_script if host_script.is_file() else None


def build_host_command(config: dict, url: str, frozen: bool | None = None,
                       executable: str | None = None) -> list[str]:
    """Command line for the WebView2 host (exe in frozen builds, script in dev)."""
    opacity = config.get("webOverlayOpacity", 0.88)
    try:
        opacity = float(opacity)
    except (TypeError, ValueError):
        opacity = 0.88
    args = ["--url", url, "--opacity", str(opacity)]

    is_frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    exe = executable or sys.executable
    if is_frozen:
        host = Path(exe).resolve().parent / "webview-host.exe"
        return [str(host), *args]
    host_script = Path(__file__).resolve().parent / "webview_host.py"
    return [exe, str(host_script), *args]


class WebOverlayManager:
    """Owns the WebView2 host process for the persistent browser display."""

    def __init__(self, config: dict):
        self.config = config
        self._process = None
        self._lock = threading.Lock()
        self._log_path = self._resolve_log_path()

    @staticmethod
    def _resolve_log_path() -> Path:
        if getattr(sys, "frozen", False):
            return Path(sys.executable).resolve().parent / "web-overlay.log"
        return Path(__file__).resolve().parent.parent / "web-overlay.log"

    def _log(self, message: str):
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n"
        try:
            with self._log_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
        except Exception:  # noqa: BLE001
            pass

    @property
    def active(self) -> bool:
        with self._lock:
            return self._process is not None and self._process.poll() is None

    def open_url(self, url: str, on_failure=None):
        """Pre-flight and open the URL; work happens off the UI thread.

        ``on_failure`` may be invoked from a worker thread — callers should
        hand the result back to their event loop (a thread-safe queue works).
        """
        self._log(f"open_url requested: {url}")
        thread = threading.Thread(
            target=self._open_worker, args=(url, on_failure), daemon=True,
        )
        thread.start()
        return thread

    def close(self):
        with self._lock:
            process, self._process = self._process, None
        if process is not None:
            self._log("close: terminating webview host")
        self._terminate(process)

    # ------------------------------------------------------------ internals

    def _open_worker(self, url: str, on_failure):
        host = resolve_host_executable()
        if host is None:
            self._log("open failed: webview-host.exe / webview_host.py not found")
            if on_failure:
                on_failure("missing-host")
            return

        if not preflight_url(url):
            self._log(f"open failed: preflight unreachable ({url})")
            if on_failure:
                on_failure("preflight")
            return

        process = self._spawn(url)
        if process is None:
            self._log(f"open failed: spawn error ({url})")
            if on_failure:
                on_failure("spawn")
            return

        self._log(f"spawned host pid={process.pid} for {url}")

        # Early-death watch: if the host exits right away the page never
        # displayed (e.g. WebView2 runtime missing).
        time.sleep(STARTUP_GRACE_SEC)
        with self._lock:
            still_current = self._process is process
        if still_current and process.poll() is not None:
            code = process.returncode
            self._log(f"host exited early with code {code}")
            with self._lock:
                if self._process is process:
                    self._process = None
            if on_failure:
                on_failure("host-exited")

    def _spawn(self, url: str):
        command = build_host_command(self.config, url)
        # Do NOT use CREATE_NO_WINDOW — that can prevent the WebView2 GUI
        # window from appearing. The host is a windowed (runw) exe.
        with self._lock:
            previous, self._process = self._process, None
        self._terminate(previous)
        try:
            self._log(f"spawning: {command}")
            process = subprocess.Popen(command)
        except Exception as exc:  # noqa: BLE001 - missing exe, bad path, ...
            self._log(f"Popen failed: {exc}")
            return None
        with self._lock:
            self._process = process
        return process

    @staticmethod
    def _terminate(process):
        if process is None or process.poll() is not None:
            return
        try:
            process.terminate()
        except Exception:  # noqa: BLE001
            return

        def _kill_if_stubborn(proc=process):
            try:
                proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass

        threading.Thread(target=_kill_if_stubborn, daemon=True).start()
