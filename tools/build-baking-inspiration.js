#!/usr/bin/env node
/**
 * Build the shipped Baking Inspiration list.
 *
 * Marketplace skill: baking ideas with five ingredients or less. We ship a
 * local combinatorial corpus (no network at runtime) so scheduled pushes stay
 * fresh without depending on an external recipe API.
 *
 *   node tools/build-baking-inspiration.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fold, wrap, encodeText } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'baking-inspiration-ideas.json');
const TITLE_WIDTH = 22;
const ING_ROWS = 4;
const ING_WIDTH = 22;
const MAX_INGREDIENTS = 5;

function clean(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function foldTitle(title) {
  return fold(clean(title)).slice(0, TITLE_WIDTH);
}

function foldIngredient(value) {
  return fold(clean(value)).slice(0, ING_WIDTH);
}

function ingredientLines(ingredients) {
  const parts = ingredients.map(foldIngredient).filter(Boolean);
  if (!parts.length) {
    return [];
  }
  return wrap(parts.join(' + '), ING_WIDTH);
}

function fitsBoard(title, ingredients) {
  const name = foldTitle(title);
  if (!name || encodeText(name).length > TITLE_WIDTH) {
    return false;
  }
  if (!Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > MAX_INGREDIENTS) {
    return false;
  }
  const lines = ingredientLines(ingredients);
  return lines.length > 0 && lines.length <= ING_ROWS;
}

function idFor(title, ingredients) {
  const key = `${title}|${ingredients.join('|')}`;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

/** Hand-tuned classics — always included when they fit. */
const CLASSICS = [
  ['CHOCOLATE CHIP COOKIES', ['FLOUR', 'BUTTER', 'SUGAR', 'EGG', 'CHOC CHIPS']],
  ['BANANA BREAD', ['BANANA', 'FLOUR', 'EGG', 'SUGAR', 'BUTTER']],
  ['BROWNIES', ['CHOCOLATE', 'BUTTER', 'SUGAR', 'EGG', 'FLOUR']],
  ['SUGAR COOKIES', ['FLOUR', 'BUTTER', 'SUGAR', 'EGG']],
  ['PEANUT BUTTER COOKIES', ['PEANUT BUTTER', 'SUGAR', 'EGG']],
  ['OATMEAL RAISIN COOKIES', ['OATS', 'FLOUR', 'BUTTER', 'SUGAR', 'RAISINS']],
  ['LEMON BARS', ['LEMON', 'BUTTER', 'SUGAR', 'EGG', 'FLOUR']],
  ['SHORTBREAD', ['FLOUR', 'BUTTER', 'SUGAR']],
  ['MUFFINS', ['FLOUR', 'EGG', 'MILK', 'SUGAR', 'OIL']],
  ['PANCAKES', ['FLOUR', 'EGG', 'MILK', 'BUTTER']],
  ['WAFFLES', ['FLOUR', 'EGG', 'MILK', 'BUTTER']],
  ['CREPES', ['FLOUR', 'EGG', 'MILK', 'BUTTER']],
  ['BISCUITS', ['FLOUR', 'BUTTER', 'MILK', 'BAKING POWDER']],
  ['SCONES', ['FLOUR', 'BUTTER', 'SUGAR', 'CREAM']],
  ['CORNBREAD', ['CORNMEAL', 'FLOUR', 'EGG', 'MILK', 'BUTTER']],
  ['POUND CAKE', ['FLOUR', 'BUTTER', 'SUGAR', 'EGG']],
  ['ANGEL FOOD CAKE', ['EGG WHITE', 'SUGAR', 'FLOUR']],
  ['CARROT CAKE', ['CARROT', 'FLOUR', 'EGG', 'SUGAR', 'OIL']],
  ['APPLE CRISP', ['APPLE', 'OATS', 'BUTTER', 'SUGAR']],
  ['PEACH COBBLER', ['PEACH', 'FLOUR', 'BUTTER', 'SUGAR']],
  ['FRUIT TART', ['FRUIT', 'FLOUR', 'BUTTER', 'SUGAR', 'EGG']],
  ['MACAROONS', ['COCONUT', 'EGG WHITE', 'SUGAR']],
  ['MERINGUES', ['EGG WHITE', 'SUGAR']],
  ['FUDGE', ['CHOCOLATE', 'BUTTER', 'SUGAR', 'MILK']],
  ['RICE KRISPY TREATS', ['CEREAL', 'MARSHMALLOW', 'BUTTER']],
  ['NO BAKE COOKIES', ['OATS', 'PEANUT BUTTER', 'SUGAR', 'COCOA']],
  ['ENERGY BITES', ['OATS', 'PEANUT BUTTER', 'HONEY', 'CHOC CHIPS']],
  ['GRANOLA', ['OATS', 'HONEY', 'OIL', 'NUTS']],
  ['CINNAMON ROLLS', ['FLOUR', 'BUTTER', 'SUGAR', 'CINNAMON', 'YEAST']],
  ['DINNER ROLLS', ['FLOUR', 'YEAST', 'MILK', 'BUTTER', 'EGG']],
  ['PIZZA DOUGH', ['FLOUR', 'YEAST', 'WATER', 'OIL', 'SALT']],
  ['SOFT PRETZELS', ['FLOUR', 'YEAST', 'WATER', 'SALT', 'BUTTER']],
  ['BAGELS', ['FLOUR', 'YEAST', 'WATER', 'SALT', 'MALT']],
  ['FOCACCIA', ['FLOUR', 'YEAST', 'WATER', 'OIL', 'SALT']],
  ['NAAN', ['FLOUR', 'YEAST', 'YOGURT', 'OIL']],
  ['TORTILLAS', ['FLOUR', 'WATER', 'OIL', 'SALT']],
  ['PIE CRUST', ['FLOUR', 'BUTTER', 'WATER', 'SALT']],
  ['PUFF PASTRY', ['FLOUR', 'BUTTER', 'WATER', 'SALT']],
  ['CHOUX PASTRY', ['FLOUR', 'BUTTER', 'WATER', 'EGG']],
  ['CLAFOUTIS', ['CHERRY', 'EGG', 'MILK', 'SUGAR', 'FLOUR']],
  ['BREAD PUDDING', ['BREAD', 'MILK', 'EGG', 'SUGAR', 'BUTTER']],
  ['FRENCH TOAST', ['BREAD', 'EGG', 'MILK', 'BUTTER']],
  ['CHURROS', ['FLOUR', 'WATER', 'BUTTER', 'EGG', 'SUGAR']],
  ['DONUTS', ['FLOUR', 'YEAST', 'MILK', 'EGG', 'SUGAR']],
  ['CROISSANTS', ['FLOUR', 'BUTTER', 'YEAST', 'MILK', 'EGG']],
  ['BRIOCHE', ['FLOUR', 'BUTTER', 'EGG', 'YEAST', 'MILK']],
  ['CINNAMON TOAST', ['BREAD', 'BUTTER', 'SUGAR', 'CINNAMON']],
  ['BAKED APPLES', ['APPLE', 'BUTTER', 'SUGAR', 'CINNAMON']],
  ['BAKED PEARS', ['PEAR', 'BUTTER', 'HONEY', 'CINNAMON']],
  ['STUFFED DATES', ['DATES', 'NUTS', 'HONEY']],
];

const BASES = [
  {
    name: 'COOKIES',
    cores: [
      ['FLOUR', 'BUTTER', 'SUGAR', 'EGG'],
      ['FLOUR', 'OIL', 'SUGAR', 'EGG'],
      ['FLOUR', 'BUTTER', 'BROWN SUGAR', 'EGG'],
      ['OATS', 'BUTTER', 'SUGAR', 'EGG'],
      ['PEANUT BUTTER', 'SUGAR', 'EGG'],
      ['ALMOND FLOUR', 'BUTTER', 'SUGAR', 'EGG'],
    ],
  },
  {
    name: 'BARS',
    cores: [
      ['FLOUR', 'BUTTER', 'SUGAR', 'EGG'],
      ['OATS', 'BUTTER', 'SUGAR'],
      ['GRAHAM', 'BUTTER', 'SUGAR'],
      ['FLOUR', 'BUTTER', 'BROWN SUGAR'],
    ],
  },
  {
    name: 'MUFFINS',
    cores: [
      ['FLOUR', 'EGG', 'MILK', 'OIL', 'SUGAR'],
      ['FLOUR', 'EGG', 'YOGURT', 'OIL', 'SUGAR'],
      ['OATS', 'EGG', 'MILK', 'HONEY'],
      ['FLOUR', 'EGG', 'BUTTERMILK', 'BUTTER'],
    ],
  },
  {
    name: 'CAKE',
    cores: [
      ['FLOUR', 'BUTTER', 'SUGAR', 'EGG'],
      ['FLOUR', 'OIL', 'SUGAR', 'EGG'],
      ['FLOUR', 'BUTTER', 'EGG', 'MILK'],
      ['ALMOND FLOUR', 'EGG', 'SUGAR', 'BUTTER'],
    ],
  },
  {
    name: 'BREAD',
    cores: [
      ['FLOUR', 'YEAST', 'WATER', 'SALT'],
      ['FLOUR', 'YEAST', 'MILK', 'BUTTER'],
      ['FLOUR', 'BAKING POWDER', 'MILK', 'BUTTER'],
      ['FLOUR', 'YEAST', 'WATER', 'OIL', 'SALT'],
    ],
  },
  {
    name: 'SCONES',
    cores: [
      ['FLOUR', 'BUTTER', 'SUGAR', 'CREAM'],
      ['FLOUR', 'BUTTER', 'SUGAR', 'MILK'],
      ['FLOUR', 'BUTTER', 'EGG', 'CREAM'],
    ],
  },
  {
    name: 'CRISP',
    cores: [
      ['FRUIT', 'OATS', 'BUTTER', 'SUGAR'],
      ['FRUIT', 'FLOUR', 'BUTTER', 'SUGAR'],
      ['FRUIT', 'OATS', 'NUTS', 'HONEY'],
    ],
  },
  {
    name: 'PUDDING',
    cores: [
      ['MILK', 'EGG', 'SUGAR', 'VANILLA'],
      ['MILK', 'COCOA', 'SUGAR', 'CORNSTARCH'],
      ['BREAD', 'MILK', 'EGG', 'SUGAR'],
    ],
  },
  {
    name: 'BITES',
    cores: [
      ['OATS', 'PEANUT BUTTER', 'HONEY'],
      ['DATES', 'NUTS', 'COCOA'],
      ['OATS', 'HONEY', 'NUTS', 'CHOC CHIPS'],
    ],
  },
  {
    name: 'TART',
    cores: [
      ['FLOUR', 'BUTTER', 'SUGAR', 'EGG'],
      ['FLOUR', 'BUTTER', 'CREAM', 'EGG'],
    ],
  },
];

const FLAVORS = [
  { label: 'CHOCOLATE', add: ['COCOA'] },
  { label: 'CHOC CHIP', add: ['CHOC CHIPS'] },
  { label: 'DOUBLE CHOC', add: ['COCOA', 'CHOC CHIPS'] },
  { label: 'VANILLA', add: ['VANILLA'] },
  { label: 'CINNAMON', add: ['CINNAMON'] },
  { label: 'LEMON', add: ['LEMON'] },
  { label: 'ORANGE', add: ['ORANGE'] },
  { label: 'LIME', add: ['LIME'] },
  { label: 'BANANA', add: ['BANANA'] },
  { label: 'APPLE', add: ['APPLE'] },
  { label: 'BLUEBERRY', add: ['BLUEBERRY'] },
  { label: 'RASPBERRY', add: ['RASPBERRY'] },
  { label: 'STRAWBERRY', add: ['STRAWBERRY'] },
  { label: 'CHERRY', add: ['CHERRY'] },
  { label: 'PEACH', add: ['PEACH'] },
  { label: 'PUMPKIN', add: ['PUMPKIN'] },
  { label: 'CARROT', add: ['CARROT'] },
  { label: 'ZUCCHINI', add: ['ZUCCHINI'] },
  { label: 'COCONUT', add: ['COCONUT'] },
  { label: 'ALMOND', add: ['ALMOND'] },
  { label: 'PECAN', add: ['PECANS'] },
  { label: 'WALNUT', add: ['WALNUTS'] },
  { label: 'HAZELNUT', add: ['HAZELNUTS'] },
  { label: 'PEANUT', add: ['PEANUT BUTTER'] },
  { label: 'GINGER', add: ['GINGER'] },
  { label: 'CARDAMOM', add: ['CARDAMOM'] },
  { label: 'MATCHA', add: ['MATCHA'] },
  { label: 'ESPRESSO', add: ['ESPRESSO'] },
  { label: 'MOCHA', add: ['COCOA', 'ESPRESSO'] },
  { label: 'HONEY', add: ['HONEY'] },
  { label: 'MAPLE', add: ['MAPLE'] },
  { label: 'MOLASSES', add: ['MOLASSES'] },
  { label: 'RAISIN', add: ['RAISINS'] },
  { label: 'CRANBERRY', add: ['CRANBERRY'] },
  { label: 'DATE', add: ['DATES'] },
  { label: 'FIG', add: ['FIGS'] },
  { label: 'SESAME', add: ['SESAME'] },
  { label: 'POPPY SEED', add: ['POPPY SEEDS'] },
  { label: 'CHEESE', add: ['CHEESE'] },
  { label: 'HERB', add: ['HERBS'] },
  { label: 'GARLIC', add: ['GARLIC'] },
  { label: 'OLIVE', add: ['OLIVES'] },
  { label: 'TOMATO', add: ['TOMATO'] },
  { label: 'CORN', add: ['CORN'] },
  { label: 'OAT', add: ['OATS'] },
  { label: 'SEED', add: ['SEEDS'] },
];

function uniqueIngredients(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = foldIngredient(raw);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out.slice(0, MAX_INGREDIENTS);
}

function addIdea(map, title, ingredients) {
  const ings = uniqueIngredients(ingredients);
  const name = foldTitle(title);
  if (!fitsBoard(name, ings)) {
    return false;
  }
  const id = idFor(name, ings);
  if (map.has(id)) {
    return false;
  }
  map.set(id, {
    id,
    title: name,
    ingredients: ings,
  });
  return true;
}

function build() {
  const map = new Map();

  for (const [title, ingredients] of CLASSICS) {
    addIdea(map, title, ingredients);
  }

  for (const base of BASES) {
    for (const core of base.cores) {
      addIdea(map, base.name, core);
      for (const flavor of FLAVORS) {
        const title = `${flavor.label} ${base.name}`;
        addIdea(map, title, [...core, ...flavor.add]);
      }
    }
  }

  // Extra short “mix two flavors” cookies / muffins for volume without
  // blowing past five ingredients when the core is already lean.
  const leanCookie = ['FLOUR', 'BUTTER', 'SUGAR', 'EGG'];
  const pairs = [
    ['CHOC CHIP', 'WALNUT', ['CHOC CHIPS', 'WALNUTS']],
    ['LEMON', 'BLUEBERRY', ['LEMON', 'BLUEBERRY']],
    ['APPLE', 'CINNAMON', ['APPLE', 'CINNAMON']],
    ['PEANUT', 'CHOC', ['PEANUT BUTTER', 'CHOC CHIPS']],
    ['OAT', 'RAISIN', ['OATS', 'RAISINS']],
    ['COCONUT', 'LIME', ['COCONUT', 'LIME']],
    ['GINGER', 'MOLASSES', ['GINGER', 'MOLASSES']],
    ['ORANGE', 'CRANBERRY', ['ORANGE', 'CRANBERRY']],
    ['MAPLE', 'PECAN', ['MAPLE', 'PECANS']],
    ['ESPRESSO', 'CHOC', ['ESPRESSO', 'CHOC CHIPS']],
    ['MATCHA', 'WHITE CHOC', ['MATCHA', 'WHITE CHOC']],
    ['BANANA', 'WALNUT', ['BANANA', 'WALNUTS']],
    ['PUMPKIN', 'SPICE', ['PUMPKIN', 'CINNAMON']],
    ['HONEY', 'ALMOND', ['HONEY', 'ALMOND']],
    ['STRAWBERRY', 'CREAM', ['STRAWBERRY', 'CREAM']],
  ];
  for (const [a, b, extras] of pairs) {
    addIdea(map, `${a} ${b} COOKIES`, [...leanCookie.slice(0, 3), ...extras].slice(0, 5));
    addIdea(map, `${a} ${b} MUFFINS`, ['FLOUR', 'EGG', 'MILK', ...extras].slice(0, 5));
    addIdea(map, `${a} ${b} BARS`, ['FLOUR', 'BUTTER', 'SUGAR', ...extras].slice(0, 5));
  }

  const ideas = [...map.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Signal Bridge combinatorial baking inspiration (five ingredients or less)',
    count: ideas.length,
    ideas,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${ideas.length} baking ideas → ${path.relative(process.cwd(), OUT)}`);
}

build();
