import threading
from pathlib import Path

from PIL import Image, ImageDraw
import pystray
from pystray import MenuItem as Item


def create_tray_icon(on_exit):
    image = Image.new("RGB", (64, 64), "#0f172a")
    draw = ImageDraw.Draw(image)
    draw.ellipse((10, 10, 54, 54), fill="#38bdf8")
    draw.rectangle((28, 22, 36, 42), fill="#0f172a")

    menu = pystray.Menu(
        Item("Alexa Broadcast Client", lambda _icon, _item: None, enabled=False),
        Item("Exit", lambda _icon, _item: on_exit()),
    )

    icon = pystray.Icon("alexa_broadcast_client", image, "Alexa Broadcast Client", menu)
    return icon


def run_tray(on_exit):
    icon = create_tray_icon(on_exit)

    def _run():
        icon.run()

    thread = threading.Thread(target=_run, daemon=True, name="tray")
    thread.start()
    return icon
