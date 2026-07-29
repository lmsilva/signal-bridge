import unittest
import tkinter as tk

from src.page_header import paint_page_header


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


if __name__ == "__main__":
    unittest.main()
