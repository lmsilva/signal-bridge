"""Apply remote mouse/keyboard commands from the bridge control page.

Mouse input is injected with Win32 ``SendInput`` using **absolute** virtual-
desktop coordinates. Relative injected moves are discarded under RDP; plain
``SetCursorPos`` moves the logical hit-test position (hover works) but the
drawn system arrow often stays frozen — and RDP may still deliver clicks at
the frozen visual position. We therefore:

1. Track our own cursor position
2. Inject every move/click as an absolute ``SendInput`` batch aimed there
3. Paint a click-through software cursor overlay at that same spot

pynput is only used for keyboard injection and as a non-Windows mouse
fallback.
"""

from __future__ import annotations

import sys
from typing import Any, Callable


_mouse = None
_keyboard = None
_Button = None
_Key = None
_KeyCode = None

# Our notion of where the remote cursor is (screen pixels). Seeded from
# GetCursorPos on first use, then updated by every move we inject.
_tracked_pos: tuple[int, int] | None = None
_on_cursor_moved: Callable[[int, int], None] | None = None
_on_cursor_duck: Callable[[], None] | None = None


def set_cursor_moved_callback(callback: Callable[[int, int], None] | None) -> None:
    """Register a listener invoked with screen (x, y) after each pointer move."""
    global _on_cursor_moved
    _on_cursor_moved = callback


def set_cursor_duck_callback(callback: Callable[[], None] | None) -> None:
    """Hide the software cursor briefly so clicks/scrolls hit the real UI."""
    global _on_cursor_duck
    _on_cursor_duck = callback


def _notify_cursor(x: int, y: int) -> None:
    if _on_cursor_moved is None:
        return
    try:
        _on_cursor_moved(int(x), int(y))
    except Exception as exc:
        print(f"Cursor overlay callback failed: {exc}", file=sys.stderr, flush=True)


def _duck_cursor() -> None:
    if _on_cursor_duck is None:
        return
    try:
        _on_cursor_duck()
    except Exception as exc:
        print(f"Cursor duck callback failed: {exc}", file=sys.stderr, flush=True)


def _ensure_pynput():
    global _mouse, _keyboard, _Button, _Key, _KeyCode
    if _mouse is not None:
        return
    from pynput.mouse import Button, Controller as MouseController
    from pynput.keyboard import Controller as KeyboardController, Key, KeyCode

    _mouse = MouseController()
    _keyboard = KeyboardController()
    _Button = Button
    _Key = Key
    _KeyCode = KeyCode


_NAMED_KEYS = {
    "esc": "esc",
    "escape": "esc",
    "enter": "enter",
    "return": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "home": "home",
    "end": "end",
    "pageup": "page_up",
    "pagedown": "page_down",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "arrowup": "up",
    "arrowdown": "down",
    "arrowleft": "left",
    "arrowright": "right",
    "ctrl": "ctrl",
    "alt": "alt",
    "shift": "shift",
    "meta": "cmd",
    "win": "cmd",
    "cmd": "cmd",
    "f1": "f1",
    "f2": "f2",
    "f3": "f3",
    "f4": "f4",
    "f5": "f5",
    "f6": "f6",
    "f7": "f7",
    "f8": "f8",
    "f9": "f9",
    "f10": "f10",
    "f11": "f11",
    "f12": "f12",
}


def _resolve_key(name: str):
    _ensure_pynput()
    raw = str(name or "")
    if not raw:
        return None
    if len(raw) == 1:
        return raw
    mapped = _NAMED_KEYS.get(raw.lower().replace("_", "").replace("-", ""))
    if mapped and hasattr(_Key, mapped):
        return getattr(_Key, mapped)
    if len(raw) == 1:
        return _KeyCode.from_char(raw)
    return None


def _modifier_keys(modifiers: list | None):
    _ensure_pynput()
    out = []
    for mod in modifiers or []:
        key = _resolve_key(str(mod))
        if key is not None:
            out.append(key)
    return out


# ---------------------------------------------------------------- Win32 mouse

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
WHEEL_DELTA = 120

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

ABS_MOVE_FLAGS = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK

_BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

_input_struct = None
_point_cls = None


def _win32_input_struct():
    """Build (once) the ctypes INPUT structure used by SendInput."""
    global _input_struct
    if _input_struct is not None:
        return _input_struct
    import ctypes

    extra_ptr = ctypes.POINTER(ctypes.c_ulong)

    class MouseInput(ctypes.Structure):
        _fields_ = (
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", extra_ptr),
        )

    class KeyBdInput(ctypes.Structure):
        _fields_ = (
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", extra_ptr),
        )

    class HardwareInput(ctypes.Structure):
        _fields_ = (
            ("uMsg", ctypes.c_ulong),
            ("wParamL", ctypes.c_short),
            ("wParamH", ctypes.c_ushort),
        )

    class InputUnion(ctypes.Union):
        _fields_ = (("mi", MouseInput), ("ki", KeyBdInput), ("hi", HardwareInput))

    class Input(ctypes.Structure):
        _fields_ = (("type", ctypes.c_ulong), ("ii", InputUnion))

    _input_struct = (ctypes, MouseInput, Input)
    return _input_struct


def _send_mouse_events(events: list[tuple[int, int, int, int]]) -> bool:
    """Inject one or more mouse events in a single SendInput call.

    Each event is ``(dx, dy, flags, mouse_data)``.
    """
    if sys.platform != "win32" or not events:
        return False
    try:
        ctypes, MouseInput, Input = _win32_input_struct()
        n = len(events)
        arr = (Input * n)()
        extras = (ctypes.c_ulong * n)()
        for i, (dx, dy, flags, mouse_data) in enumerate(events):
            extras[i] = 0
            arr[i].type = 0  # INPUT_MOUSE
            arr[i].ii.mi = MouseInput(
                int(dx),
                int(dy),
                int(mouse_data) & 0xFFFFFFFF,
                int(flags),
                0,
                ctypes.pointer(extras[i]),
            )
        sent = ctypes.windll.user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(Input))
        if sent != n:
            err = ctypes.windll.kernel32.GetLastError()
            print(
                f"SendInput rejected mouse batch (sent={sent}/{n}, winerror={err}). "
                "If the foreground app runs as administrator, the display client "
                "must also run as administrator to control it.",
                file=sys.stderr,
                flush=True,
            )
            return False
        return True
    except Exception as exc:
        print(f"SendInput mouse event failed: {exc}", file=sys.stderr, flush=True)
        return False


def _send_mouse_input(dx: int = 0, dy: int = 0, flags: int = 0, mouse_data: int = 0) -> bool:
    return _send_mouse_events([(dx, dy, flags, mouse_data)])


def _cursor_pos():
    """Current OS cursor position as (x, y), or None when unavailable."""
    global _point_cls
    if sys.platform != "win32":
        return None
    try:
        import ctypes

        if _point_cls is None:
            class Point(ctypes.Structure):
                _fields_ = (("x", ctypes.c_long), ("y", ctypes.c_long))

            _point_cls = Point
        pt = _point_cls()
        if not ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)):
            return None
        return (pt.x, pt.y)
    except Exception:
        return None


def _set_cursor_pos(x: int, y: int) -> bool:
    try:
        import ctypes

        return bool(ctypes.windll.user32.SetCursorPos(int(x), int(y)))
    except Exception:
        return False


def _virtual_screen():
    """(x, y, width, height) of the full virtual desktop, or None."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes

        user32 = ctypes.windll.user32
        vx = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        vy = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        vw = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        vh = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        if vw <= 1 or vh <= 1:
            return None
        return (vx, vy, vw, vh)
    except Exception:
        return None


def _clamp_to_screen(x: int, y: int) -> tuple[int, int]:
    screen = _virtual_screen()
    if not screen:
        return (x, y)
    vx, vy, vw, vh = screen
    return (
        max(vx, min(vx + vw - 1, x)),
        max(vy, min(vy + vh - 1, y)),
    )


def _to_absolute(x: int, y: int) -> tuple[int, int] | None:
    """Normalize screen pixels to SendInput absolute 0..65535 over the virtual desk."""
    screen = _virtual_screen()
    if not screen:
        return None
    vx, vy, vw, vh = screen
    cx, cy = _clamp_to_screen(x, y)
    nx = round((cx - vx) * 65535 / (vw - 1))
    ny = round((cy - vy) * 65535 / (vh - 1))
    return (nx, ny)


def _ensure_tracked_pos() -> tuple[int, int]:
    global _tracked_pos
    if _tracked_pos is not None:
        return _tracked_pos
    pos = _cursor_pos()
    if pos is None:
        screen = _virtual_screen()
        if screen:
            vx, vy, vw, vh = screen
            pos = (vx + vw // 2, vy + vh // 2)
        else:
            pos = (0, 0)
    _tracked_pos = pos
    return _tracked_pos


def _set_tracked_pos(x: int, y: int) -> tuple[int, int]:
    global _tracked_pos
    _tracked_pos = _clamp_to_screen(int(x), int(y))
    return _tracked_pos


def _move_to(x: int, y: int) -> bool:
    """Move the OS cursor to absolute screen (x, y) and update the overlay."""
    cx, cy = _set_tracked_pos(x, y)
    abs_xy = _to_absolute(cx, cy)
    ok = False
    if abs_xy is not None:
        ok = _send_mouse_events([(abs_xy[0], abs_xy[1], ABS_MOVE_FLAGS, 0)])
    if not ok:
        ok = _set_cursor_pos(cx, cy)
    _notify_cursor(cx, cy)
    return ok


def _move_relative(dx: int, dy: int) -> bool:
    """Apply a delta to the tracked remote cursor and inject an absolute move."""
    if not dx and not dy:
        return False
    x, y = _ensure_tracked_pos()
    return _move_to(x + dx, y + dy)


def _wheel_win32(steps: int) -> bool:
    # Duck the overlay so the wheel hits the real window under the tip, then
    # aim with an absolute move and send a plain wheel event (no ABSOLUTE flag).
    x, y = _ensure_tracked_pos()
    _duck_cursor()
    abs_xy = _to_absolute(x, y)
    events: list[tuple[int, int, int, int]] = []
    if abs_xy is not None:
        events.append((abs_xy[0], abs_xy[1], ABS_MOVE_FLAGS, 0))
    events.append((0, 0, MOUSEEVENTF_WHEEL, steps * WHEEL_DELTA))
    ok = _send_mouse_events(events)
    _notify_cursor(x, y)
    return ok


def _button_win32(name: str, action: str) -> bool:
    """Click/press/release at the tracked position.

    Sequence: duck overlay → absolute MOVE to tip → plain button flags.
    Combining LEFTDOWN with ABSOLUTE|MOVE on the same event is unreliable;
    RDP also delivers bare clicks at the frozen system arrow unless we MOVE first.
    """
    flags = _BUTTON_FLAGS.get(name)
    if not flags:
        return False
    down, up = flags
    x, y = _ensure_tracked_pos()
    _duck_cursor()
    abs_xy = _to_absolute(x, y)
    events: list[tuple[int, int, int, int]] = []
    if abs_xy is not None:
        events.append((abs_xy[0], abs_xy[1], ABS_MOVE_FLAGS, 0))
    if action == "down":
        events.append((0, 0, down, 0))
    elif action == "up":
        events.append((0, 0, up, 0))
    elif action == "click":
        events.append((0, 0, down, 0))
        events.append((0, 0, up, 0))
    else:
        return False
    ok = _send_mouse_events(events)
    if not ok:
        # Last resort: SetCursorPos then plain buttons.
        _set_cursor_pos(x, y)
        if action == "down":
            ok = _send_mouse_events([(0, 0, down, 0)])
        elif action == "up":
            ok = _send_mouse_events([(0, 0, up, 0)])
        else:
            ok = _send_mouse_events([(0, 0, down, 0), (0, 0, up, 0)])
    _notify_cursor(x, y)
    return ok


def _pynput_mouse(action, description: str) -> None:
    """Fallback mouse injection via pynput; never raises."""
    try:
        _ensure_pynput()
        action()
    except Exception as exc:
        print(f"Mouse {description} failed (pynput fallback): {exc}", file=sys.stderr, flush=True)


def handle_pointer(pointer: dict[str, Any] | None) -> None:
    if not isinstance(pointer, dict):
        return

    dx = float(pointer.get("dx") or 0)
    dy = float(pointer.get("dy") or 0)
    if dx or dy:
        rdx = int(round(dx))
        rdy = int(round(dy))
        if (rdx or rdy) and not _move_relative(rdx, rdy):
            x, y = _ensure_tracked_pos()
            _set_tracked_pos(x + rdx, y + rdy)
            _pynput_mouse(lambda: _mouse.move(rdx, rdy), "move")
            _notify_cursor(*_ensure_tracked_pos())

    wheel = float(pointer.get("wheel") or 0)
    if wheel:
        steps = int(round(wheel))
        if steps and not _wheel_win32(steps):
            _pynput_mouse(lambda: _mouse.scroll(0, steps), "scroll")

    buttons = pointer.get("buttons") or {}
    if not isinstance(buttons, dict):
        return
    for name in ("left", "right", "middle"):
        action = str(buttons.get(name) or "").lower()
        if action not in ("down", "up", "click"):
            continue
        if _button_win32(name, action):
            continue

        def fallback(name=name, action=action):
            button = getattr(_Button, name)
            if action == "down":
                _mouse.press(button)
            elif action == "up":
                _mouse.release(button)
            else:
                _mouse.click(button, 1)

        _pynput_mouse(fallback, f"{name} {action}")
        _notify_cursor(*_ensure_tracked_pos())


def handle_key(key_block: dict[str, Any] | None) -> None:
    if not isinstance(key_block, dict):
        return
    try:
        _ensure_pynput()
    except Exception as exc:
        print(f"Keyboard input unavailable (pynput failed to load): {exc}", file=sys.stderr, flush=True)
        return
    key = _resolve_key(key_block.get("key"))
    if key is None:
        return
    mods = _modifier_keys(key_block.get("modifiers"))
    action = str(key_block.get("action") or "press").lower()

    if action == "down":
        for mod in mods:
            _keyboard.press(mod)
        _keyboard.press(key)
        return
    if action == "up":
        _keyboard.release(key)
        for mod in reversed(mods):
            _keyboard.release(mod)
        return

    for mod in mods:
        _keyboard.press(mod)
    try:
        _keyboard.press(key)
        _keyboard.release(key)
    finally:
        for mod in reversed(mods):
            _keyboard.release(mod)


def handle_input_payload(payload: dict) -> bool:
    """Return True if the payload was an input command (handled or skipped)."""
    ptype = payload.get("type")
    if ptype == "input.pointer":
        handle_pointer(payload.get("pointer"))
        return True
    if ptype == "input.key":
        handle_key(payload.get("key"))
        return True
    return False
