'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCorpusRemove } = require('../src/corpus-remove');

test('applyCorpusRemove deletes a custom row', () => {
  const result = applyCorpusRemove({
    custom: [{ id: 'c1', text: 'House fact' }, { id: 'c2', text: 'Keep' }],
    hiddenIds: ['c1'],
    removedIds: [],
    recentIds: ['c1'],
    overrides: { c1: 'old' },
  }, 'c1', { isShipped: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.custom, [{ id: 'c2', text: 'Keep' }]);
  assert.equal(result.patch.overrides.c1, undefined);
  assert.equal(result.patch.removedIds.includes('c1'), false);
});

test('applyCorpusRemove records a shipped id and leaves the rest of the house edits', () => {
  const result = applyCorpusRemove({
    custom: [{ id: 'c1', text: 'House fact' }],
    hiddenIds: ['ship-1'],
    removedIds: [],
    recentIds: ['ship-1'],
    overrides: { 'ship-1': 'edited' },
  }, 'ship-1', { isShipped: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.removedIds, ['ship-1']);
  assert.deepEqual(result.patch.hiddenIds, []);
  assert.equal(result.patch.overrides['ship-1'], undefined);
  assert.equal(result.patch.custom.length, 1);
});

test('applyCorpusRemove rejects an unknown id', () => {
  const result = applyCorpusRemove({
    custom: [],
    hiddenIds: [],
    removedIds: [],
    recentIds: [],
    overrides: {},
  }, 'missing', { isShipped: false });
  assert.equal(result.ok, false);
});
