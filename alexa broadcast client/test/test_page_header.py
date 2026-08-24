import unittest
import tkinter as tk

from src.design_system import design_u, page_chrome
from src.page_header import paint_page_header, pill_frame

PILLS = ("ROLL CREDITS", "AUTODARTS", "AUTODARTS DASHBOARD", "SHARED PHOTOS")
SCREENS = ((1080, 1920), (1920, 1080))
# px painted per font point: 1.33 is stock 96dpi, 2.05 is the wall PC.
PX_PER_PT = (1.33, 1.6, 2.05, 2.4)


class PageHeaderSpacingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tk.Tk()
        cls.root.withdraw()

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    def test_label_and_value_do_not_overlap(self):
        canvas = tk.Canvas(self.root, width=1920, height=1080)
        ids = paint_page_header(
            canvas,
            screen_w=1920,
            screen_h=1080,
            pill="SHARED PHOTOS",
            left_label="SOURCE",
            left_value="Signal",
            right_label="PHOTO",
            right_value="02 / 08",
        )
        self.assertGreaterEqual(len(ids), 6)

        # Collect left-column texts (SOURCE + Signal) by x≈60u.
        texts = []
        for item_id in ids:
            if canvas.type(item_id) != "text":
                continue
            x, y = canvas.coords(item_id)
            text = canvas.itemcget(item_id, "text")
            if text in ("SOURCE", "Signal"):
                bbox = canvas.bbox(item_id)
                texts.append((text, bbox))
        self.assertEqual(len(texts), 2)
        by_name = {t: b for t, b in texts}
        # SOURCE bottom must sit above Signal top (no overlap).
        self.assertLessEqual(by_name["SOURCE"][3], by_name["Signal"][1] + 1)

        right = []
        for item_id in ids:
            if canvas.type(item_id) != "text":
                continue
            text = canvas.itemcget(item_id, "text")
            if text in ("PHOTO", "02 / 08"):
                right.append((text, canvas.bbox(item_id)))
        by_name = {t: b for t, b in right}
        self.assertLessEqual(by_name["PHOTO"][3], by_name["02 / 08"][1] + 1)


    def test_pill_frame_holds_its_title_at_every_display_scaling(self):
        """Font sizes are points and the frame is px, so a frame sized from the
        point size clipped the caps at the wall's Windows display scaling."""
        for ratio in PX_PER_PT:
            for screen in SCREENS:
                u = design_u(*screen)
                points = max(11, int(round(24 * u)))
                for pill in PILLS:
                    # What Tk will actually paint at this display scaling.
                    text_w = len(pill) * points * ratio * 0.55  # Consolas advance
                    text_h = points * ratio
                    box = pill_frame(
                        pill, mid_x=screen[0] / 2, cy=74 * u, u=u,
                        text_w=text_w, text_h=text_h,
                    )
                    where = f"{pill} {screen} @ {ratio}px/pt"
                    gap = 6 * u
                    self.assertGreaterEqual(
                        (box[2] - box[0]) - text_w, gap * 2, f"title bleeds sideways — {where}",
                    )
                    self.assertGreaterEqual(
                        (box[3] - box[1]) - text_h, gap * 2, f"title bleeds vertically — {where}",
                    )
                    chrome = page_chrome(*screen, timed=True)
                    self.assertLessEqual(
                        box[3], chrome.content_top, f"pill runs into the cards — {where}",
                    )

    def test_pill_frame_holds_its_title_on_this_display(self):
        """Same check against real Tk metrics rather than a modelled ratio."""
        for screen in SCREENS:
            u = design_u(*screen)
            for pill in PILLS:
                canvas = tk.Canvas(self.root, width=screen[0], height=screen[1])
                ids = paint_page_header(
                    canvas, screen_w=screen[0], screen_h=screen[1], pill=pill,
                    left_label="SOURCE", left_value="Signal",
                    right_label="GAMES", right_value="29",
                )
                frame = text = None
                for item_id in ids:
                    kind = canvas.type(item_id)
                    if kind == "polygon":
                        frame = canvas.bbox(item_id)
                    elif kind == "text" and canvas.itemcget(item_id, "text") == pill:
                        text = canvas.bbox(item_id)
                where = f"{pill} {screen}"
                self.assertIsNotNone(frame, f"no pill frame — {where}")
                self.assertIsNotNone(text, f"no pill text — {where}")
                gap = 6 * u
                self.assertLessEqual(frame[0] + gap, text[0], f"title bleeds left — {where}")
                self.assertLessEqual(text[2], frame[2] - gap, f"title bleeds right — {where}")
                self.assertLessEqual(frame[1] + gap, text[1], f"title bleeds up — {where}")
                self.assertLessEqual(text[3], frame[3] - gap, f"title bleeds down — {where}")
                canvas.destroy()


if __name__ == "__main__":
    unittest.main()
