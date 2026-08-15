const fs = require('fs');
const path = require('path');

const SHOPPING_LIST_MENTION_RE = /\b(?:shopping|grocery)\s+list\b/i;
const SHOPPING_ADD_RE = /\b(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:shopping|grocery)\s+list\b/i;
const SHOPPING_ADD_SHORT_RE = /\b(?:add|put)\s+(.+?)(?:\?|[.!]|$)/i;
const SHOPPING_REMOVE_RE = /\b(?:remove|delete|take)\s+(.+?)\s+(?:from|off)\s+(?:my\s+|the\s+)?(?:shopping|grocery)\s+list\b/i;
const SHOPPING_SHOW_RE = /\b(?:show|read|list|what(?:'s|\s+is)\s+(?:on|in))\b.*\b(?:shopping|grocery)\s+list\b|\b(?:shopping|grocery)\s+list\b.*\b(?:show|read|list)\b/i;
const SHOPPING_SPOKEN_ADD_RE = /\b(?:added|put)\s+(.+?)\s+(?:to|on)\s+(?:your|my|the)\s+(?:shopping|grocery)\s+list\b/i;
const SHOPPING_SPOKEN_ITEMS_RE = /\b(?:you have|there(?:'s| is| are))\s+(.+?)\s+(?:on|in)\s+(?:your|my|the)\s+(?:shopping|grocery)\s+list\b/i;
const SHOPPING_SPOKEN_COUNT_FIRST_RE = /\b(?:you have|there(?:'s| is| are))\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+items?\s+(?:on|in)\s+(?:your|my|the)\s+(?:shopping|grocery)\s+list\b[,:\s]+(.+)/i;
const SHOPPING_SPOKEN_COUNT_ITEMS_RE = /\b(?:you have|there(?:'s| is| are))\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+items?\b[,:\s]+(.+)/i;
const SHOPPING_SPOKEN_ON_LIST_RE = /\b(?:you(?:\s+\w+){0,3}\s+have|there(?:'s| is| are))\s+(.+?)\s+on\s+(?:your|my|the)\s+list\b/i;
const SHOPPING_SPOKEN_HERE_ARE_RE = /\b(?:here(?:'s| is| are)|okay,? here(?:'s| is| are))\s+(?:the\s+)?(?:items?(?:\s+on\s+(?:your|my|the)\s+(?:shopping|grocery)\s+list)?(?:\s+are)?[,:]\s*)?(.+)/i;
const SHOPPING_SPOKEN_TRAILING_RE = /\b(?:shopping|grocery)\s+list\b[,:\s]+(.+)/i;
const SHOPPING_SPOKEN_WHATS_ON_IT_RE = /\bwhat(?:'s|\s+is)\s+on\s+it\s*:\s*(.+)/i;
const META_ITEM_RE = /^(?:what(?:'s|\s+is)\s+on\s+it|on your list|shopping list|grocery list)$/i;
const META_PREFIX_RE = /^(?:all of them|the rest|(?:first|next|last|item|number)\s+\d+)\s*:\s*/i;
const NARRATION_SUFFIX_RE = /\s*(?:\.?\s*(?:i(?:'ve| have) shown (?:all|the rest|you)|that(?:'s| is) (?:all|everything)|would you like to hear|do you want to hear|say (?:next|first|all)).*)$/i;
const SHOPPING_SPOKEN_PAGINATION_RE = /\b(?:first|next|last|all of them|would you like to hear|i(?:'ve| have) shown|say (?:next|all|first))\b/i;
const SHOPPING_SPOKEN_EMPTY_RE = /\b(?:your|my|the)\s+(?:shopping|grocery)\s+list\s+is\s+empty\b|\b(?:don't|do not)\s+have\s+anything\s+(?:on|in)\s+(?:your|my|the)\s+(?:shopping|grocery)\s+list\b/i;
const COUNT_ONLY_RE = /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+items?$/i;

function stripWakeWord(text) {
  return normalizeText(text).replace(/^(?:alexa[,.\s]+)+/i, '');
}

/**
 * Amazon often joins wake + repeat ASR: "alexa add milk, add milk".
 * Keep the first add fragment when the tail is the same command again.
 */
function stripRepeatedAddEcho(text) {
  const cleaned = stripWakeWord(text);
  const match = cleaned.match(
    /^(.*?\b(?:add|put)\s+.+?)\s*,\s*(?:alexa[,.\s]+)?((?:add|put)\s+.+)$/i,
  );
  if (!match) {
    return cleaned;
  }
  const first = match[1].trim();
  const second = match[2].trim();
  const firstItem = first
    .replace(/^(?:add|put)\s+/i, '')
    .replace(/\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:shopping|grocery)\s+list$/i, '')
    .trim()
    .toLowerCase();
  const secondItem = second
    .replace(/^(?:add|put)\s+/i, '')
    .replace(/\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:shopping|grocery)\s+list$/i, '')
    .trim()
    .toLowerCase();
  if (firstItem && secondItem && (
    firstItem === secondItem
    || firstItem.includes(secondItem)
    || secondItem.includes(firstItem)
  )) {
    return first;
  }
  return cleaned;
}

function sanitizeItemName(raw) {
  let name = String(raw || '').trim();
  name = name.replace(META_PREFIX_RE, '');
  name = name.replace(/^(?:what(?:'s|\s+is)\s+on\s+it\s*:\s*)/i, '');
  name = name.replace(/^(?:on\s+it\s*:\s*)/i, '');
  name = name.replace(NARRATION_SUFFIX_RE, '');
  name = name.replace(/[.!?]+$/g, '').trim();
  // "chocolate almonds, add chocolate almonds" leftover from ASR echo.
  const echo = name.match(/^(.+?)\s*,\s*(?:alexa[,.\s]+)?(?:add|put)\s+(.+)$/i);
  if (echo) {
    const left = echo[1].trim();
    const right = echo[2]
      .replace(/\s+(?:to|on)\s+(?:my\s+|the\s+)?(?:shopping|grocery)\s+list$/i, '')
      .trim();
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a && b && (a === b || a.includes(b) || b.includes(a))) {
      name = left;
    }
  }
  return name;
}

function isValidShoppingItemName(raw) {
  const original = String(raw || '').trim();
  if (!original || original.length > 60) {
    return false;
  }
  if (META_PREFIX_RE.test(original)) {
    return false;
  }
  if (SHOPPING_SPOKEN_PAGINATION_RE.test(original)) {
    return false;
  }

  const name = sanitizeItemName(original);
  if (!name) {
    return false;
  }
  if (META_ITEM_RE.test(name)) {
    return false;
  }
  if (COUNT_ONLY_RE.test(name)) {
    return false;
  }
  if (/^\d+$/.test(name)) {
    return false;
  }
  return true;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function spokenMentionsShoppingList(response) {
  return SHOPPING_LIST_MENTION_RE.test(normalizeText(response));
}

function matchesShoppingListQuery(summary, response) {
  const text = stripRepeatedAddEcho(summary);
  const spoken = normalizeText(response);

  if (SHOPPING_ADD_RE.test(text) || SHOPPING_REMOVE_RE.test(text) || SHOPPING_SHOW_RE.test(text)) {
    return true;
  }

  if (SHOPPING_SHOW_RE.test(text) || (/\bshow\b/i.test(text) && SHOPPING_LIST_MENTION_RE.test(text))) {
    return true;
  }

  // "add milk" — transcript often omits "to shopping list" but Alexa confirms in the response.
  if (SHOPPING_ADD_SHORT_RE.test(text) && (spokenMentionsShoppingList(spoken) || SHOPPING_SPOKEN_ADD_RE.test(spoken))) {
    return true;
  }

  return false;
}

function shoppingListTrigger(summary, response) {
  const text = stripRepeatedAddEcho(summary);
  if (SHOPPING_ADD_RE.test(text)) {
    return 'shopping-list-add';
  }
  if (SHOPPING_ADD_SHORT_RE.test(text) && spokenMentionsShoppingList(normalizeText(response))) {
    return 'shopping-list-add';
  }
  if (SHOPPING_REMOVE_RE.test(text)) {
    return 'shopping-list-remove';
  }
  return 'shopping-list-show';
}

function extractAddedItem(summary, response) {
  const text = stripRepeatedAddEcho(summary);
  const spoken = normalizeText(response);

  const explicit = text.match(SHOPPING_ADD_RE);
  if (explicit) {
    return sanitizeItemName(explicit[1]);
  }

  const spokenAdd = spoken.match(SHOPPING_SPOKEN_ADD_RE);
  if (spokenAdd) {
    return sanitizeItemName(spokenAdd[1]);
  }

  const short = text.match(SHOPPING_ADD_SHORT_RE);
  if (short && (spokenMentionsShoppingList(spoken) || SHOPPING_SPOKEN_ADD_RE.test(spoken) || !spoken)) {
    return sanitizeItemName(short[1].replace(/\b(?:please|alexa|now)\b/gi, ''));
  }

  return null;
}

function splitItemNames(raw) {
  return String(raw || '')
    .replace(/\band\b/gi, ',')
    .split(',')
    .map((part) => sanitizeItemName(part))
    .filter(Boolean)
    .filter(isValidShoppingItemName);
}

function buildListFromNames(names) {
  if (!names.length) {
    return null;
  }

  return {
    name: 'Shopping List',
    items: names.map((value, index) => ({
      id: null,
      value,
      createdAt: new Date(Date.now() - index).toISOString(),
    })),
  };
}

function parseShoppingListFromSpeech(response, { query } = {}) {
  const spoken = normalizeText(response);
  const isShowQuery = SHOPPING_SHOW_RE.test(normalizeText(query));
  if (!spoken || (!spokenMentionsShoppingList(spoken) && !isShowQuery)) {
    return null;
  }

  if (SHOPPING_SPOKEN_EMPTY_RE.test(spoken)) {
    return { name: 'Shopping List', items: [], explicitlyEmpty: true };
  }

  const paginatedReadout = isShowQuery && SHOPPING_SPOKEN_PAGINATION_RE.test(spoken);

  if (isShowQuery) {
    const whatsOnItMatch = spoken.match(SHOPPING_SPOKEN_WHATS_ON_IT_RE);
    if (whatsOnItMatch) {
      const parsed = buildListFromNames(splitItemNames(whatsOnItMatch[1]));
      if (parsed) {
        return parsed;
      }
    }

    if (paginatedReadout) {
      return null;
    }

    const hereAreMatch = spoken.match(SHOPPING_SPOKEN_HERE_ARE_RE);
    if (hereAreMatch) {
      const parsed = buildListFromNames(splitItemNames(hereAreMatch[1]));
      if (parsed) {
        return parsed;
      }
    }
  }

  const countFirstMatch = spoken.match(SHOPPING_SPOKEN_COUNT_FIRST_RE);
  if (countFirstMatch) {
    const parsed = buildListFromNames(splitItemNames(countFirstMatch[1]));
    if (parsed) {
      return parsed;
    }
  }

  if (isShowQuery) {
    const countItemsMatch = spoken.match(SHOPPING_SPOKEN_COUNT_ITEMS_RE);
    if (countItemsMatch) {
      const parsed = buildListFromNames(splitItemNames(countItemsMatch[1]));
      if (parsed) {
        return parsed;
      }
    }

    const onListMatch = spoken.match(SHOPPING_SPOKEN_ON_LIST_RE);
    if (onListMatch) {
      const parsed = buildListFromNames(splitItemNames(onListMatch[1]));
      if (parsed) {
        return parsed;
      }
    }
  }

  const listMatch = spoken.match(SHOPPING_SPOKEN_ITEMS_RE);
  if (listMatch) {
    const parsed = buildListFromNames(splitItemNames(listMatch[1]));
    if (parsed && !COUNT_ONLY_RE.test(listMatch[1].trim())) {
      return parsed;
    }
  }

  const trailingMatch = spoken.match(SHOPPING_SPOKEN_TRAILING_RE);
  if (trailingMatch) {
    const tail = trailingMatch[1].replace(/^(?:you have|there(?:'s| is| are))\s+/i, '');
    const parsed = buildListFromNames(splitItemNames(tail));
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function listIdFromEntry(list) {
  if (list?.listId) {
    return list.listId;
  }
  if (list?.itemId) {
    return list.itemId;
  }
  const id = list?.id;
  if (Array.isArray(id) && id.length) {
    return id[0];
  }
  if (typeof id === 'string' && id) {
    return id;
  }
  return null;
}

function resolveShoppingList(fetched, spokenResponse, cachedItems, addedItem, trigger, query) {
  const spokenList = parseShoppingListFromSpeech(spokenResponse, { query });
  const fetchedItems = fetched?.items || [];
  const spokenItems = spokenList?.items || [];
  const cached = cachedItems || [];
  const added = String(addedItem || '').trim();
  let items;

  if (
    trigger === 'shopping-list-show'
    && spokenList?.explicitlyEmpty
    && !fetchedItems.length
  ) {
    items = [];
  } else if (trigger === 'shopping-list-show') {
    const validCached = cached.filter((item) => isValidShoppingItemName(itemValue(item)));
    const validSpoken = spokenItems.filter((item) => isValidShoppingItemName(item.value));

    if (fetchedItems.length) {
      items = fetchedItems;
    } else if (validCached.length) {
      items = validCached;
    } else if (validSpoken.length) {
      items = validSpoken;
    } else {
      items = [];
    }
  } else if (fetchedItems.length) {
    items = fetchedItems;
    if (added && trigger !== 'shopping-list-remove') {
      items = mergeItems([{ value: added }], items);
    }
  } else {
    items = mergeItems(spokenItems, cached);
  }

  if (trigger === 'shopping-list-remove' && added) {
    items = items.filter((item) => itemKey(item.value) !== itemKey(added));
  } else if (added && !fetchedItems.length) {
    items = mergeItems([{ value: added }], items);
  }

  return {
    listId: fetched?.listId || null,
    name: fetched?.name || spokenList?.name || 'Shopping List',
    items,
  };
}

function callAlexa(alexa, method, ...args) {
  return new Promise((resolve, reject) => {
    alexa[method](...args, (err, body) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(body);
    });
  });
}

function itemTimestamp(item) {
  const value = item?.updatedDateTime ?? item?.createdDateTime
    ?? item?.updateAt ?? item?.createAt
    ?? item?.updatedDate ?? item?.createdDate;
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function itemValue(item) {
  if (item == null) {
    return '';
  }
  if (typeof item === 'string') {
    return item.trim();
  }

  const direct = item.value ?? item.text ?? item.itemName ?? item.name ?? item.title;
  if (typeof direct === 'string') {
    return direct.trim();
  }
  if (direct && typeof direct === 'object') {
    const nested = direct.text ?? direct.value ?? direct.itemName ?? direct.name;
    if (typeof nested === 'string') {
      return nested.trim();
    }
  }

  return String(item.itemText || item.label || '').trim();
}

function isItemCompleted(item) {
  if (item?.completed === true) {
    return true;
  }
  const status = String(item?.itemStatus || item?.status || '').toUpperCase();
  return status === 'COMPLETE' || status === 'COMPLETED';
}

function itemTimestampIso(iso) {
  const parsed = Date.parse(String(iso || ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeItems(rawItems) {
  return (rawItems || [])
    .filter((item) => item && !isItemCompleted(item))
    .map((item) => ({
      id: item.id || item.itemId || null,
      value: itemValue(item),
      createdAt: itemTimestamp(item) ? new Date(itemTimestamp(item)).toISOString() : null,
    }))
    .filter((item) => item.value)
    .sort((a, b) => itemTimestampIso(b.createdAt) - itemTimestampIso(a.createdAt));
}

function findShoppingList(lists) {
  const entries = Array.isArray(lists) ? lists : [];
  const explicit = entries.find(isShoppingListEntry);
  if (explicit) {
    return explicit;
  }

  const named = entries.find((list) => /shopping|grocery/i.test(String(list?.listName || list?.name || '')));
  if (named) {
    return named;
  }

  if (entries.length === 1) {
    return entries[0];
  }

  return null;
}

function isTodoListEntry(list) {
  const type = String(list?.listType || list?.type || '').toUpperCase();
  const name = String(list?.listName || list?.name || '').toLowerCase();
  return type === 'TASKS' || /(?:^|\s)(?:to-?do|task)s?(?:\s|$)/i.test(name);
}

function isShoppingListEntry(list) {
  const type = String(list?.listType || list?.type || '').toUpperCase();
  const name = String(list?.listName || list?.name || '').toLowerCase();
  if (type === 'SHOPLIST' || type.includes('SHOP')) {
    return true;
  }
  if (/shopping|grocery|einkauf/i.test(name)) {
    return true;
  }
  return /shop/i.test(type) && !isTodoListEntry(list);
}

function itemKey(value) {
  return sanitizeItemName(value).toLowerCase();
}

function matchesShoppingListSpeech(response, query) {
  const spoken = normalizeText(response);
  if (!spoken) {
    return false;
  }

  if (spokenMentionsShoppingList(spoken)) {
    return true;
  }

  if (!SHOPPING_SHOW_RE.test(normalizeText(query))) {
    return false;
  }

  if (
    SHOPPING_SPOKEN_EMPTY_RE.test(spoken)
    || SHOPPING_SPOKEN_WHATS_ON_IT_RE.test(spoken)
    || /\b(?:you have|there(?:'s| is| are))\b/i.test(spoken)
  ) {
    return true;
  }

  return Boolean(parseShoppingListFromSpeech(spoken, { query }));
}

function mergeItems(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const item of group || []) {
      const value = sanitizeItemName(itemValue(item));
      if (!isValidShoppingItemName(value)) {
        continue;
      }
      const key = itemKey(value);
      const existing = map.get(key);
      map.set(key, {
        id: item.id || item.itemId || existing?.id || null,
        value,
        createdAt: item.createdAt ?? existing?.createdAt ?? ((item.id || item.itemId) ? null : new Date().toISOString()),
      });
    }
  }
  return [...map.values()].sort((a, b) => itemTimestampIso(b.createdAt) - itemTimestampIso(a.createdAt));
}

function loadShoppingListCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return normalizeItems(Array.isArray(data?.items) ? data.items : []);
  } catch {
    return [];
  }
}

function saveShoppingListCache(cachePath, items) {
  if (!cachePath) {
    return;
  }

  const cleaned = (items || []).filter((item) => isValidShoppingItemName(itemValue(item)));

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    `${JSON.stringify({ items: cleaned, savedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

function extractListsFromBody(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body?.listInfoList)) {
    return body.listInfoList;
  }
  if (Array.isArray(body?.lists)) {
    return body.lists;
  }
  if (Array.isArray(body?.listsSummaries)) {
    return body.listsSummaries;
  }
  return [];
}

function extractItemsFromBody(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body?.itemInfoList)) {
    return body.itemInfoList;
  }
  if (Array.isArray(body?.listItems)) {
    return body.listItems;
  }
  if (Array.isArray(body?.items)) {
    return body.items;
  }
  return [];
}

async function fetchListItemsRaw(alexa, listId) {
  try {
    const itemsBody = await callAlexa(alexa, 'getListItemsV2', listId, { limit: 200 });
    const items = extractItemsFromBody(itemsBody);
    if (items.length) {
      return items;
    }
  } catch (_) {
    // Fall through to legacy mapped API.
  }

  try {
    const itemsBody = await callAlexa(alexa, 'getListItems', listId);
    return extractItemsFromBody(itemsBody);
  } catch (_) {
    return [];
  }
}

async function fetchShoppingList(alexa) {
  let lists = [];
  try {
    const listsBody = await callAlexa(alexa, 'getListsV2');
    lists = extractListsFromBody(listsBody);
  } catch (_) {
    try {
      const listsBody = await callAlexa(alexa, 'getLists');
      lists = extractListsFromBody(listsBody);
    } catch (_) {
      return null;
    }
  }

  const shoppingList = findShoppingList(lists);
  if (!shoppingList) {
    return null;
  }

  const listId = listIdFromEntry(shoppingList);
  if (!listId) {
    return null;
  }

  const rawItems = await fetchListItemsRaw(alexa, listId);

  return {
    listId,
    name: shoppingList.listName || shoppingList.name || 'Shopping List',
    items: normalizeItems(rawItems),
  };
}

module.exports = {
  SHOPPING_ADD_RE,
  SHOPPING_ADD_SHORT_RE,
  SHOPPING_REMOVE_RE,
  SHOPPING_SHOW_RE,
  matchesShoppingListQuery,
  matchesShoppingListSpeech,
  shoppingListTrigger,
  extractAddedItem,
  parseShoppingListFromSpeech,
  resolveShoppingList,
  fetchShoppingList,
  findShoppingList,
  isShoppingListEntry,
  listIdFromEntry,
  loadShoppingListCache,
  saveShoppingListCache,
  mergeItems,
  normalizeItems,
  itemValue,
  isItemCompleted,
  sanitizeItemName,
  isValidShoppingItemName,
  splitItemNames,
  buildListFromNames,
};
