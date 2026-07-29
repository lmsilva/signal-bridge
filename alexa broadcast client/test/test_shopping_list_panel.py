import unittest

from src.display_panels import ShoppingListPanel


class ShoppingListDensityTests(unittest.TestCase):
    def test_short_list_keeps_large_two_column_landscape(self):
        cols, font_u, row_u, cap = ShoppingListPanel.pick_density(
            9, portrait=False, zone_h=850.0, u=1.0,
        )
        self.assertEqual(cols, 2)
        self.assertGreaterEqual(font_u, 46)
        self.assertGreaterEqual(cap, 9)

    def test_twenty_items_steps_down_density_to_fit(self):
        cols, font_u, row_u, cap = ShoppingListPanel.pick_density(
            20, portrait=False, zone_h=850.0, u=1.0,
        )
        self.assertGreaterEqual(cap, 20)
        self.assertLessEqual(font_u, 46)

    def test_thirty_items_uses_three_columns_or_pages(self):
        cols, font_u, row_u, cap = ShoppingListPanel.pick_density(
            30, portrait=False, zone_h=850.0, u=1.0,
        )
        # Densest landscape rung is 3-col; may still page if zone is short.
        self.assertIn(cols, (2, 3))
        self.assertGreaterEqual(cap, 15)

    def test_portrait_long_list_can_use_two_columns(self):
        cols, font_u, row_u, cap = ShoppingListPanel.pick_density(
            24, portrait=True, zone_h=1600.0, u=1.0,
        )
        self.assertGreaterEqual(cap, 20)
        self.assertIn(cols, (1, 2))

    def test_paging_prefers_capacity_of_at_least_ten(self):
        cols, font_u, row_u, cap = ShoppingListPanel.pick_density(
            10, portrait=True, zone_h=1500.0, u=1.0, prefer_cap=10,
        )
        self.assertGreaterEqual(cap, 10)

    def test_shopping_settings_defaults(self):
        panel = ShoppingListPanel.__new__(ShoppingListPanel)
        panel.config = {}
        seconds, per_page = panel._shopping_settings()
        self.assertEqual(seconds, 10)
        self.assertEqual(per_page, 10)

    def test_shopping_settings_from_config(self):
        panel = ShoppingListPanel.__new__(ShoppingListPanel)
        panel.config = {"shoppingList": {"pageSeconds": 8, "itemsPerPage": 12}}
        seconds, per_page = panel._shopping_settings()
        self.assertEqual(seconds, 8)
        self.assertEqual(per_page, 12)

    def test_shopping_settings_clamp_extremes(self):
        panel = ShoppingListPanel.__new__(ShoppingListPanel)
        panel.config = {"shoppingList": {"pageSeconds": 1, "itemsPerPage": 99}}
        seconds, per_page = panel._shopping_settings()
        self.assertEqual(seconds, 3)
        self.assertEqual(per_page, 30)

    def test_shopping_settings_reject_non_numeric(self):
        panel = ShoppingListPanel.__new__(ShoppingListPanel)
        panel.config = {"shoppingList": {"pageSeconds": "nope", "itemsPerPage": None}}
        seconds, per_page = panel._shopping_settings()
        self.assertEqual(seconds, 10)
        self.assertEqual(per_page, 10)


if __name__ == "__main__":
    unittest.main()
