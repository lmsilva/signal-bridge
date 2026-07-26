const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUnmatchedActivityLog } = require('../src/unmatched-activity-log');

test('unmatched activity log caps at maxLines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmatched-'));
  const filePath = path.join(dir, 'unmatched-activities.jsonl');
  const log = createUnmatchedActivityLog({ unmatchedActivitiesLogPath: filePath }, { maxLines: 3 });
  for (let i = 0; i < 5; i += 1) {
    log.record({ summary: `row-${i}` });
  }
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\n/);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /row-2/);
  assert.match(lines[2], /row-4/);
});
