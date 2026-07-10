const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchesTeslaDashboardQuery } = require('../src/tesla-dashboard');

test('matchesTeslaDashboardQuery detects show tesla dashboard', () => {
  assert.equal(matchesTeslaDashboardQuery('show tesla dashboard', ''), true);
  assert.equal(matchesTeslaDashboardQuery('alexa show tesla dashboard', ''), true);
  assert.equal(matchesTeslaDashboardQuery('show tesla battery', ''), false);
  assert.equal(matchesTeslaDashboardQuery('show my tesla battery', ''), false);
});
