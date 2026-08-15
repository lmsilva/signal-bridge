const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesShoppingListQuery,
  shoppingListTrigger,
  extractAddedItem,
  normalizeItems,
  parseShoppingListFromSpeech,
  resolveShoppingList,
  findShoppingList,
  mergeItems,
  itemValue,
  sanitizeItemName,
  isValidShoppingItemName,
  isItemCompleted,
} = require('../src/shopping-list');
const { buildShoppingListPayload } = require('../src/udp-payload');

test('matchesShoppingListQuery detects show and add phrases', () => {
  assert.equal(matchesShoppingListQuery('show my shopping list'), true);
  assert.equal(matchesShoppingListQuery('add milk to shopping list'), true);
  assert.equal(matchesShoppingListQuery('what is the weather'), false);
});

test('matchesShoppingListQuery detects short add when Alexa confirms shopping list', () => {
  assert.equal(
    matchesShoppingListQuery('add milk', "Okay, I've added milk to your shopping list"),
    true,
  );
});

test('shoppingListTrigger classifies add vs show', () => {
  assert.equal(shoppingListTrigger('add eggs to my shopping list'), 'shopping-list-add');
  assert.equal(shoppingListTrigger('add milk', "Added milk to your shopping list"), 'shopping-list-add');
  assert.equal(shoppingListTrigger('show my shopping list'), 'shopping-list-show');
});

test('extractAddedItem reads explicit and short add commands', () => {
  assert.equal(extractAddedItem('add bananas to shopping list'), 'bananas');
  assert.equal(extractAddedItem('add milk', "Added milk to your shopping list"), 'milk');
});

test('extractAddedItem strips Alexa wake+repeat ASR echo', () => {
  assert.equal(
    extractAddedItem('alexa add chocolate almonds, add chocolate almonds'),
    'chocolate almonds',
  );
  assert.equal(
    extractAddedItem(
      'alexa add dark chocolate, add dark chocolate',
      "Okay, I've added dark chocolate to your shopping list",
    ),
    'dark chocolate',
  );
});

test('sanitizeItemName collapses duplicated add-echo leftovers', () => {
  assert.equal(
    sanitizeItemName('chocolate almonds, add chocolate almonds'),
    'chocolate almonds',
  );
});

test('resolveShoppingList does not merge ASR echo as a second item', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', items: [{ id: '1', value: 'chocolate almonds', createdAt: null }] },
    "Okay, I've added chocolate almonds to your shopping list",
    [],
    extractAddedItem('alexa add chocolate almonds, add chocolate almonds'),
    'shopping-list-add',
    'alexa add chocolate almonds, add chocolate almonds',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['chocolate almonds']);
});

test('resolveShoppingList sanitizes a raw ASR-echo addedItem', () => {
  // Defense in depth: even if extractAddedItem is skipped, merge must not
  // keep "chocolate almonds, add chocolate almonds" as its own row.
  const list = resolveShoppingList(
    { name: 'Shopping List', items: [{ id: '1', value: 'chocolate almonds', createdAt: null }] },
    "Okay, I've added chocolate almonds to your shopping list",
    [],
    'chocolate almonds, add chocolate almonds',
    'shopping-list-add',
    'alexa add chocolate almonds, add chocolate almonds',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['chocolate almonds']);
  assert.equal(list.items.some((item) => /,\s*add\s+/i.test(item.value)), false);
});

test('logged Snack Room add does not produce a duplicated echo row', () => {
  // From data/voice-events.jsonl 2026-08-15T04:39:54Z
  const query = 'alexa add chocolate almonds, add chocolate almonds';
  const spoken = "Okay, I've added chocolate almonds to your shopping list";
  assert.equal(matchesShoppingListQuery(query, spoken), true);
  assert.equal(shoppingListTrigger(query, spoken), 'shopping-list-add');
  const added = extractAddedItem(query, spoken);
  assert.equal(added, 'chocolate almonds');
  const list = resolveShoppingList(
    {
      name: 'Shopping List',
      items: [
        { id: '1', value: 'chocolate almonds', createdAt: '2026-08-15T04:39:56.016Z' },
        { id: '2', value: 'Eggs', createdAt: '2026-08-14T22:34:27.160Z' },
      ],
    },
    spoken,
    [],
    added,
    'shopping-list-add',
    query,
  );
  assert.deepEqual(
    list.items.map((item) => item.value),
    ['chocolate almonds', 'Eggs'],
  );
  const payload = buildShoppingListPayload(
    {
      device: 'Snack Room Echo',
      query,
      spokenResponse: spoken,
      trigger: 'shopping-list-add',
      addedItem: added,
    },
    { udpBroadcast: { defaultDisplaySeconds: 30 } },
    { list },
  );
  assert.equal(payload.type, 'shopping-list.snapshot');
  assert.equal(payload.addedItem, 'chocolate almonds');
  assert.deepEqual(payload.items.map((item) => item.value), ['chocolate almonds', 'Eggs']);
  assert.equal(
    payload.items.some((item) => /,\s*add\s+/i.test(item.value)),
    false,
  );
});

test('normalizeItems reads alexa v2 list item fields', () => {
  const items = normalizeItems([
    { itemId: '1', itemName: 'milk', itemStatus: 'ACTIVE', updateAt: 2000 },
    { itemId: '2', itemName: 'eggs', itemStatus: 'ACTIVE', updateAt: 3000 },
    { itemId: '3', itemName: 'done', itemStatus: 'COMPLETE', updateAt: 4000 },
  ]);
  assert.deepEqual(items.map((item) => item.value), ['eggs', 'milk']);
  assert.equal(itemValue({ itemName: 'bread' }), 'bread');
  assert.equal(isItemCompleted({ itemStatus: 'COMPLETE' }), true);
  assert.equal(isItemCompleted({ completed: true }), true);
});

test('parseShoppingListFromSpeech extracts item names', () => {
  const parsed = parseShoppingListFromSpeech('You have milk, eggs and bread on your shopping list');
  assert.deepEqual(parsed.items.map((item) => item.value), ['milk', 'eggs', 'bread']);
});

test('parseShoppingListFromSpeech handles count-first Alexa responses', () => {
  const parsed = parseShoppingListFromSpeech(
    'You have two items in your shopping list, milk and toilet cover',
  );
  assert.deepEqual(parsed.items.map((item) => item.value), ['milk', 'toilet cover']);
});

test('parseShoppingListFromSpeech handles show-query count without shopping list mention', () => {
  const parsed = parseShoppingListFromSpeech(
    'You have two items, milk and toilet cover',
    { query: 'show my shopping list' },
  );
  assert.deepEqual(parsed.items.map((item) => item.value), ['milk', 'toilet cover']);
});

test('parseShoppingListFromSpeech handles items on your list phrasing', () => {
  const parsed = parseShoppingListFromSpeech(
    'You have milk, eggs and bread on your list',
    { query: 'show my shopping list' },
  );
  assert.deepEqual(parsed.items.map((item) => item.value), ['milk', 'eggs', 'bread']);
});

test('parseShoppingListFromSpeech recognizes empty list responses', () => {
  const parsed = parseShoppingListFromSpeech('Your shopping list is empty');
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.explicitlyEmpty, true);
});

test('parseShoppingListFromSpeech handles here are items phrasing', () => {
  const parsed = parseShoppingListFromSpeech(
    "Here's the items on your shopping list: milk, eggs and bread",
    { query: 'show my shopping list' },
  );
  assert.deepEqual(parsed.items.map((item) => item.value), ['milk', 'eggs', 'bread']);
});

test('resolveShoppingList prefers API items on show and ignores spoken narration', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', listId: 'abc', items: [
      { id: '1', value: 'shoes', createdAt: null },
      { id: '2', value: 'coke', createdAt: null },
      { id: '3', value: 'toilet cover', createdAt: null },
    ] },
    "First 3: shoes. All of them: shoes. toilet cover. I've shown all 3 items",
    [
      { id: null, value: 'all of them: shoes', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: null, value: 'first 3: shoes', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    null,
    'shopping-list-show',
    'what is on my shopping list',
  );
  assert.deepEqual(
    list.items.map((item) => item.value).sort(),
    ['coke', 'shoes', 'toilet cover'].sort(),
  );
});

test('resolveShoppingList falls back to clean cache when API empty on show', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', listId: 'abc', items: [] },
    'First 3: shoes',
    [
      { id: null, value: 'shoes', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: null, value: 'coke', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: null, value: 'all of them: shoes', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    null,
    'shopping-list-show',
    'show my shopping list',
  );
  assert.deepEqual(list.items.map((item) => item.value).sort(), ['coke', 'shoes'].sort());
});

test('parseShoppingListFromSpeech handles whats on it phrasing', () => {
  const parsed = parseShoppingListFromSpeech(
    "You have one item on your shopping list. What's on it: toilet cover.",
    { query: 'show my shopping list' },
  );
  assert.deepEqual(parsed.items.map((item) => item.value), ['toilet cover']);
});

test('sanitizeItemName strips spoken prefixes, pagination, and narration', () => {
  assert.equal(sanitizeItemName("what's on it: toilet cover."), 'toilet cover');
  assert.equal(sanitizeItemName('all of them: shoes'), 'shoes');
  assert.equal(sanitizeItemName('first 3: shoes'), 'shoes');
  assert.equal(sanitizeItemName("toilet cover. I've shown all 3 items"), 'toilet cover');
});

test('isValidShoppingItemName rejects Alexa narration phrases', () => {
  assert.equal(isValidShoppingItemName('all of them: shoes'), false);
  assert.equal(isValidShoppingItemName("I've shown all 3 items"), false);
  assert.equal(isValidShoppingItemName('shoes'), true);
});

test('parseShoppingListFromSpeech ignores paginated readout phrases', () => {
  const parsed = parseShoppingListFromSpeech(
    "First 3: shoes. All of them: shoes. I've shown all 3 items",
    { query: 'what is on my shopping list' },
  );
  assert.equal(parsed, null);
});

test('itemValue reads nested Amazon list item shapes', () => {
  assert.equal(itemValue({ value: { text: 'bananas' } }), 'bananas');
  assert.equal(itemValue({ itemText: 'bread' }), 'bread');
});

test('findShoppingList prefers SHOPLIST over TASKS', () => {
  const lists = [
    { listId: 'todo', listType: 'TASKS', listName: 'To-do' },
    { listId: 'shop', listType: 'SHOPLIST', listName: 'Shopping List' },
  ];
  assert.equal(findShoppingList(lists)?.listId, 'shop');
});

test('resolveShoppingList falls back to speech when API fetch is empty', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', listId: 'abc', items: [] },
    'You have two items in your shopping list, milk and toilet cover',
    [],
    null,
    'shopping-list-show',
    'show my shopping list',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['milk', 'toilet cover']);
});

test('resolveShoppingList merges cached items across add commands', () => {
  const cached = [{ id: null, value: 'coke', createdAt: '2026-01-01T00:00:00.000Z' }];
  const list = resolveShoppingList(
    { name: 'Shopping List', items: [] },
    null,
    cached,
    'shoes',
    'shopping-list-add',
    'add shoes',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['shoes', 'coke']);
});

test('resolveShoppingList uses API items and still includes fresh add', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', items: [{ id: '1', value: 'milk', createdAt: null }] },
    null,
    [{ id: null, value: 'coke', createdAt: null }],
    'shoes',
    'shopping-list-add',
    'add shoes',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['shoes', 'milk']);
});

test('resolveShoppingList merges added item onto API list', () => {
  const list = resolveShoppingList(
    { name: 'Shopping List', items: [{ id: '1', value: 'eggs', createdAt: null }] },
    null,
    [],
    'milk',
    'shopping-list-add',
    'add milk',
  );
  assert.deepEqual(list.items.map((item) => item.value), ['milk', 'eggs']);
});
