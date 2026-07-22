"""Apply remote mouse/keyboard commands from the bridge control page."""

from __future__ import annotations

import sys
from typing import Any


_mouse = None
_keyboard = None
_Button = None
_Key = None
_KeyCode = None


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
    # F-keys etc. already normalized above; fall back to KeyCode for unknowns.
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


def _move_relative(dx: int, dy: int) -> bool:
    """Relative cursor move via Win32 SendInput when available.

    pynput's Windows ``move()`` teleports with SetCursorPos, which often does
    nothing (or fights the session) under Remote Desktop. Relative SendInput
    matches real mouse deltas and works alongside keyboard injection.
    """
    if sys.platform != "win32" or (not dx and not dy):
        return False
    try:
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

        extra = ctypes.c_ulong(0)
        inp = Input()
        inp.type = 0  # INPUT_MOUSE
        inp.ii.mi = MouseInput(
            int(dx),
            int(dy),
            0,
            0x0001,  # MOUSEEVENTF_MOVE
            0,
            ctypes.pointer(extra),
        )
        sent = ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(Input))
        return sent == 1
    except Exception:
        return False


def handle_pointer(pointer: dict[str, Any] | None) -> None:
    if not isinstance(pointer, dict):
        return
    _ensure_pynput()
    dx = float(pointer.get("dx") or 0)
    dy = float(pointer.get("dy") or 0)
    if dx or dy:
        rdx = int(round(dx))
        rdy = int(round(dy))
        if not _move_relative(rdx, rdy):
            _mouse.move(rdx, rdy)

    wheel = float(pointer.get("wheel") or 0)
    if wheel:
        _mouse.scroll(0, int(round(wheel)))

    buttons = pointer.get("buttons") or {}
    if not isinstance(buttons, dict):
        return
    mapping = {
        "left": _Button.left,
        "right": _Button.right,
        "middle": _Button.middle,
    }
    for name, button in mapping.items():
        action = str(buttons.get(name) or "").lower()
        if action == "down":
            _mouse.press(button)
        elif action == "up":
            _mouse.release(button)
        elif action == "click":
            _mouse.click(button, 1)


def handle_key(key_block: dict[str, Any] | None) -> None:
    if not isinstance(key_block, dict):
        return
    _ensure_pynput()
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

    # press = chord
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
