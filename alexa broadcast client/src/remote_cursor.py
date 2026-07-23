"""Always-on-top, click-through software cursor for remote control.

RDP sessions and some kiosk apps leave the *logical* cursor free to move
(hover/hit-testing works) while the *drawn* system arrow stays frozen. This
overlay paints our own pointer at the tracked remote position so the operator
always sees where clicks will land.

While the remote pointer is active we also replace the system cursors with a
blank cursor (so the frozen OS arrow disappears). A low-level mouse hook
restores the real cursors the moment a *physical* (non-injected) mouse move
arrives — i.e. when someone touches the local mouse again.
"""

from __future__ import annotations

import sys
import threading
import tkinter as tk


# Chroma-key color for layered-window transparency (must match window/canvas bg).
_KEY_COLOR = "#ff00ff"
_KEY_COLOR_RGB = 0x00FF00FF  # COLORREF 0x00bbggrr → magenta

# System cursor IDs we blank while remote control is driving the pointer.
_OCR_IDS = (
    32512,  # OCR_NORMAL
    32513,  # OCR_IBEAM
    32514,  # OCR_WAIT
    32515,  # OCR_CROSS
    32516,  # OCR_UP
    32642,  # OCR_SIZENWSE
    32643,  # OCR_SIZENESW
    32644,  # OCR_SIZEWE
    32645,  # OCR_SIZENS
    32646,  # OCR_SIZEALL
    32648,  # OCR_NO
    32649,  # OCR_HAND
    32650,  # OCR_APPSTARTING
)

_SPI_SETCURSORS = 0x0057
_WH_MOUSE_LL = 14
_WM_MOUSEMOVE = 0x0200
_LLMHF_INJECTED = 0x00000001
_LLMHF_LOWER_INJECTED = 0x00000002


class RemoteCursorOverlay:
    """Small topmost click-through window showing a remote-control pointer."""

    SIZE = 18
    HOT_X = 1
    HOT_Y = 1
    IDLE_HIDE_MS = 4000

    def __init__(self, root: tk.Misc):
        self._root = root
        self._win: tk.Toplevel | None = None
        self._canvas: tk.Canvas | None = None
        self._hide_after: str | None = None
        self._visible = False
        self._system_hidden = False
        self._blank_cursor = None
        self._hook = None
        self._hook_proc = None
        self._hook_thread: threading.Thread | None = None
        self._hook_thread_id = 0
        self._hook_stop = threading.Event()
        self._lock = threading.Lock()

    def show_at(self, x: int, y: int) -> None:
        """Place the pointer tip at screen (x, y) and keep it visible briefly."""
        try:
            self._ensure_window()
            assert self._win is not None
            left = int(x) - self.HOT_X
            top = int(y) - self.HOT_Y
            self._win.geometry(f"{self.SIZE}x{self.SIZE}+{left}+{top}")
            if not self._visible:
                self._win.deiconify()
                self._visible = True
            self._win.attributes("-topmost", True)
            # Re-apply every move — Tk/geometry changes can drop the styles,
            # and SetWindowLong clears SetLayeredWindowAttributes.
            self._apply_click_through()
            self._hide_system_cursor()
            self._ensure_physical_mouse_watch()
            self._schedule_hide()
        except Exception as exc:
            print(f"Remote cursor overlay failed: {exc}", file=sys.stderr, flush=True)

    def duck(self) -> None:
        """Temporarily hide the overlay so clicks/scrolls hit the real UI.

        Does NOT restore the system cursor — that would flash the frozen OS
        arrow back during the click.
        """
        self._withdraw_overlay()

    def hide(self) -> None:
        """Hide the software cursor and restore the real system cursors."""
        self._cancel_hide_timer()
        self._withdraw_overlay()
        self._restore_system_cursor()
        self._stop_physical_mouse_watch()

    def destroy(self) -> None:
        self.hide()
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
            self._win = None
            self._canvas = None
        self._destroy_blank_cursor()

    def _withdraw_overlay(self) -> None:
        if self._win is not None and self._visible:
            self._win.withdraw()
            self._visible = False

    def _cancel_hide_timer(self) -> None:
        if self._hide_after is not None:
            try:
                self._root.after_cancel(self._hide_after)
            except Exception:
                pass
            self._hide_after = None

    def _schedule_hide(self) -> None:
        self._cancel_hide_timer()
        self._hide_after = self._root.after(self.IDLE_HIDE_MS, self.hide)

    def _ensure_window(self) -> None:
        if self._win is not None:
            return
        win = tk.Toplevel(self._root)
        win.withdraw()
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        try:
            win.attributes("-transparentcolor", _KEY_COLOR)
        except tk.TclError:
            pass
        win.configure(bg=_KEY_COLOR, highlightthickness=0)
        canvas = tk.Canvas(
            win,
            width=self.SIZE,
            height=self.SIZE,
            bg=_KEY_COLOR,
            highlightthickness=0,
            bd=0,
        )
        canvas.pack(fill="both", expand=True)
        # Compact arrow tip at (HOT_X, HOT_Y).
        canvas.create_polygon(
            1, 1,
            1, 15,
            5, 12,
            8, 17,
            11, 16,
            7, 11,
            13, 11,
            fill="#f8fafc",
            outline="#0f172a",
            width=1,
        )
        self._win = win
        self._canvas = canvas
        win.update_idletasks()

    def _apply_click_through(self) -> None:
        """WS_EX_TRANSPARENT on the toplevel AND every child (canvas).

        Also re-set the color key after SetWindowLong — changing WS_EX_LAYERED
        clears SetLayeredWindowAttributes, which is what made the overlay look
        like an opaque black/magenta block and steal clicks.
        """
        if self._win is None or sys.platform != "win32":
            return
        try:
            import ctypes

            user32 = ctypes.windll.user32
            GWL_EXSTYLE = -20
            WS_EX_LAYERED = 0x00080000
            WS_EX_TRANSPARENT = 0x00000020
            WS_EX_TOOLWINDOW = 0x00000080
            WS_EX_NOACTIVATE = 0x08000000
            LWA_COLORKEY = 0x00000001
            GW_CHILD = 5
            GW_HWNDNEXT = 2
            GA_ROOT = 2

            def harden(hwnd: int) -> None:
                if not hwnd:
                    return
                style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                user32.SetWindowLongW(
                    hwnd,
                    GWL_EXSTYLE,
                    style
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE,
                )
                user32.SetLayeredWindowAttributes(hwnd, _KEY_COLOR_RGB, 0, LWA_COLORKEY)

            root_hwnd = user32.GetAncestor(int(self._win.winfo_id()), GA_ROOT)
            if not root_hwnd:
                root_hwnd = int(self._win.winfo_id())
            harden(root_hwnd)

            child = user32.GetWindow(root_hwnd, GW_CHILD)
            while child:
                harden(child)
                child = user32.GetWindow(child, GW_HWNDNEXT)

            if self._canvas is not None:
                try:
                    harden(int(self._canvas.winfo_id()))
                except Exception:
                    pass
        except Exception as exc:
            print(f"Remote cursor click-through failed: {exc}", file=sys.stderr, flush=True)

    # ---- System cursor hide / restore ------------------------------------

    def _hide_system_cursor(self) -> None:
        if sys.platform != "win32" or self._system_hidden:
            return
        try:
            import ctypes

            user32 = ctypes.windll.user32
            blank = self._ensure_blank_cursor()
            if not blank:
                return
            for ocr in _OCR_IDS:
                # SetSystemCursor takes ownership and destroys the handle —
                # CopyIcon so we can reuse our blank template.
                copied = user32.CopyIcon(blank)
                if copied:
                    user32.SetSystemCursor(copied, ocr)
            self._system_hidden = True
        except Exception as exc:
            print(f"Hide system cursor failed: {exc}", file=sys.stderr, flush=True)

    def _restore_system_cursor(self) -> None:
        if sys.platform != "win32" or not self._system_hidden:
            return
        try:
            import ctypes

            ctypes.windll.user32.SystemParametersInfoW(_SPI_SETCURSORS, 0, None, 0)
            self._system_hidden = False
        except Exception as exc:
            print(f"Restore system cursor failed: {exc}", file=sys.stderr, flush=True)

    def _ensure_blank_cursor(self):
        if self._blank_cursor is not None:
            return self._blank_cursor
        if sys.platform != "win32":
            return None
        try:
            import ctypes

            # 32x32 fully transparent cursor (AND=1, XOR=0).
            dim = 32
            stride = dim // 8
            and_mask = (ctypes.c_ubyte * (dim * stride))(*([0xFF] * (dim * stride)))
            xor_mask = (ctypes.c_ubyte * (dim * stride))(*([0x00] * (dim * stride)))
            handle = ctypes.windll.user32.CreateCursor(
                None, 0, 0, dim, dim, and_mask, xor_mask
            )
            self._blank_cursor = handle or None
            return self._blank_cursor
        except Exception as exc:
            print(f"Blank cursor create failed: {exc}", file=sys.stderr, flush=True)
            return None

    def _destroy_blank_cursor(self) -> None:
        if self._blank_cursor and sys.platform == "win32":
            try:
                import ctypes

                ctypes.windll.user32.DestroyCursor(self._blank_cursor)
            except Exception:
                pass
        self._blank_cursor = None

    # ---- Physical mouse → hand control back ------------------------------

    def _ensure_physical_mouse_watch(self) -> None:
        if sys.platform != "win32":
            return
        with self._lock:
            if self._hook_thread is not None and self._hook_thread.is_alive():
                return
            self._hook_stop.clear()
            self._hook_thread = threading.Thread(
                target=self._physical_mouse_watch_loop,
                name="remote-cursor-mouse-hook",
                daemon=True,
            )
            self._hook_thread.start()

    def _stop_physical_mouse_watch(self) -> None:
        if sys.platform != "win32":
            return
        self._hook_stop.set()
        if self._hook:
            try:
                import ctypes

                ctypes.windll.user32.UnhookWindowsHookEx(self._hook)
            except Exception:
                pass
            self._hook = None
        if self._hook_thread_id:
            try:
                import ctypes

                ctypes.windll.user32.PostThreadMessageW(
                    self._hook_thread_id, 0x0012, 0, 0  # WM_QUIT
                )
            except Exception:
                pass
        if self._hook_thread is not None and self._hook_thread.is_alive():
            self._hook_thread.join(timeout=1.0)
        self._hook_thread = None
        self._hook_thread_id = 0
        self._hook_proc = None

    def _physical_mouse_watch_loop(self) -> None:
        """Run a WH_MOUSE_LL hook; restore OS cursor on non-injected moves."""
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.windll.user32
            self._hook_thread_id = ctypes.windll.kernel32.GetCurrentThreadId()

            class POINT(ctypes.Structure):
                _fields_ = (("x", wintypes.LONG), ("y", wintypes.LONG))

            class MSLLHOOKSTRUCT(ctypes.Structure):
                _fields_ = (
                    ("pt", POINT),
                    ("mouseData", wintypes.DWORD),
                    ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD),
                    ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
                )

            HOOKPROC = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
            )

            def _callback(n_code, w_param, l_param):
                try:
                    if (
                        n_code >= 0
                        and int(w_param) == _WM_MOUSEMOVE
                        and not self._hook_stop.is_set()
                    ):
                        info = ctypes.cast(
                            l_param, ctypes.POINTER(MSLLHOOKSTRUCT)
                        ).contents
                        injected = bool(
                            info.flags & (_LLMHF_INJECTED | _LLMHF_LOWER_INJECTED)
                        )
                        if not injected and self._system_hidden:
                            # Bounce to the Tk thread — never touch Tk from here.
                            self._root.after(0, self._on_physical_mouse)
                except Exception:
                    pass
                return user32.CallNextHookEx(self._hook, n_code, w_param, l_param)

            # Keep the ctypes callback alive for the lifetime of the hook.
            self._hook_proc = HOOKPROC(_callback)
            self._hook = user32.SetWindowsHookExW(
                _WH_MOUSE_LL, self._hook_proc, None, 0
            )
            if not self._hook:
                return

            msg = wintypes.MSG()
            while not self._hook_stop.is_set():
                while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0x0001):
                    if msg.message == 0x0012:  # WM_QUIT
                        self._hook_stop.set()
                        break
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                self._hook_stop.wait(0.05)
        except Exception as exc:
            print(f"Physical mouse watch failed: {exc}", file=sys.stderr, flush=True)
        finally:
            if self._hook:
                try:
                    import ctypes

                    ctypes.windll.user32.UnhookWindowsHookEx(self._hook)
                except Exception:
                    pass
                self._hook = None
            self._hook_thread_id = 0
    def _on_physical_mouse(self) -> None:
        """Local mouse took over — drop the software cursor and restore OS cursors."""
        if not self._system_hidden and not self._visible:
            return
        self.hide()
