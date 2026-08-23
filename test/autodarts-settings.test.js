const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createAutodartsSettings,
  DEFAULTS,
  INACTIVITY_OPTIONS,
} = require('../src/autodarts-settings');

function tempPath(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autodarts-settings-')), name);
}

test('Autodarts settings expose required defaults', () => {
  const settings = createAutodartsSettings({ autodartsSettingsPath: tempPath('s.json') });
  assert.deepEqual(settings.get(), JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(INACTIVITY_OPTIONS, [5, 10, 15, 30, 60]);
});

test('Autodarts settings clamp ranges and inactivity options', () => {
  const settings = createAutodartsSettings({ autodartsSettingsPath: tempPath('s.json') });
  const result = settings.update({
    live: { autoPush: false, inactivityMinutes: 12, finalHoldSeconds: 10 },
    dashboard: { leaderboardSize: 99, displaySeconds: 5 },
    lastMatch: { displaySeconds: 900 },
  });
  assert.equal(result.live.autoPush, false);
  assert.equal(result.live.inactivityMinutes, 15);
  assert.equal(result.live.finalHoldSeconds, 30);
  assert.equal(result.dashboard.leaderboardSize, 16);
  assert.equal(result.dashboard.displaySeconds, 30);
  assert.equal(result.lastMatch.displaySeconds, 600);

  const next = settings.update({ live: { inactivityMinutes: 30, finalHoldSeconds: 180 } });
  assert.equal(next.live.inactivityMinutes, 30);
  assert.equal(next.live.finalHoldSeconds, 180);
});
