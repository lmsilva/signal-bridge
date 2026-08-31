'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate, CHIPS } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { spaceLaunchAlertFrames } = require('../src/vestaboard/formatters/feeds');
const { TITLE, alertLines, alertRows } = require('../src/space-launch-alerts-layout');
const {
  TYPE,
  providerLabel,
  countdownPhrase,
  buildAlertSentence,
  normalizeLaunch,
  buildSpaceLaunchAlertPayload,
  createSpaceLaunchAlerts,
} = require('../src/space-launch-alerts');

function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

const framesFor = (sentence, chipColor = 'blue') => spaceLaunchAlertFrames(
  buildSpaceLaunchAlertPayload({
    id: 'demo',
    name: 'Demo',
    net: new Date(Date.now() + 45 * 60000).toISOString(),
    status: 'Go',
    provider: 'SPACEX',
    rocket: 'FALCON 9',
    mission: 'STARLINK 6-56',
    countdown: '45 MINUTES',
    sentence,
  }, { chipColor }),
);

test('the title row is SPACE LAUNCH between chip pairs', () => {
  assert.equal(TITLE, 'SPACE LAUNCH');
});

test('the three channel cards render flap for flap', () => {
  const starlink = framesFor(
    'A SPACEX FALCON 9 ROCKET WILL LAUNCH THE STARLINK 6-56 MISSION IN 45 MINUTES',
    'white',
  );
  assert.equal(starlink.length, 1);
  assert.equal(starlink[0].source, 'launch.alert');
  assertBoard(starlink[0].rows, [
    'ww   SPACE LAUNCH   ww',
    'A SPACEX FALCON 9',
    'ROCKET WILL LAUNCH THE',
    'STARLINK 6-56 MISSION',
    'IN 45 MINUTES',
    '',
  ], 'Starlink card');

  const chang = framesFor(
    "A CHINA LONG MARCH 5 ROCKET WILL LAUNCH THE CHANG'E 6 MISSION IN 10 MINUTES",
    'green',
  );
  assertBoard(chang[0].rows, [
    'gg   SPACE LAUNCH   gg',
    'A CHINA LONG MARCH 5',
    'ROCKET WILL LAUNCH THE',
    "CHANG'E 6 MISSION IN",
    '10 MINUTES',
    '',
  ], 'Chang\'e card');

  const worldview = framesFor(
    'A SPACEX FALCON 9 ROCKET WILL LAUNCH THE WORLDVIEW LEGION 1 & 2 MISSION IN 1 HOUR',
    'blue',
  );
  assertBoard(worldview[0].rows, [
    'bb   SPACE LAUNCH   bb',
    'A SPACEX FALCON 9',
    'ROCKET WILL LAUNCH THE',
    'WORLDVIEW LEGION 1 & 2',
    'MISSION IN 1 HOUR',
    '',
  ], 'Worldview card');
});

test('body lines start under the title instead of sitting on the bottom', () => {
  const rows = alertRows('A SHORT ALERT IN 1 HOUR', { chip: 'blue' });
  assertBoard(rows, [
    'bb   SPACE LAUNCH   bb',
    'A SHORT ALERT IN 1',
    'HOUR',
    '',
    '',
    '',
  ], 'short alert uses the top');
  assert.equal(rows[5].every((code) => code === 0), true);
});

test('provider and countdown helpers match marketplace wording', () => {
  assert.equal(providerLabel({ name: 'SpaceX' }), 'SPACEX');
  assert.equal(providerLabel({ name: 'China Aerospace Science and Technology Corporation' }, {
    location: { country_code: 'CHN' },
  }), 'CHINA');
  const net = new Date(Date.now() + 45 * 60000).toISOString();
  assert.equal(countdownPhrase(net), '45 MINUTES');
  assert.match(
    buildAlertSentence({
      provider: 'SPACEX',
      rocket: 'FALCON 9',
      mission: 'STARLINK 6-56',
      countdown: '45 MINUTES',
    }),
    /ROCKET WILL LAUNCH THE STARLINK 6-56 MISSION IN 45 MINUTES/,
  );
});

test('normalizeLaunch drops successful launches and refuses over-long alerts', () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const ok = normalizeLaunch({
    id: 'abc',
    name: 'Falcon 9 | Starlink 6-56',
    net: future,
    status: { abbrev: 'Go' },
    launch_service_provider: { name: 'SpaceX' },
    rocket: { configuration: { full_name: 'Falcon 9' } },
    mission: { name: 'Starlink 6-56' },
  });
  assert.ok(ok?.sentence);
  assert.ok(alertLines(ok.sentence).length <= 5);
  assert.ok(alertLines(ok.sentence).length >= 1);

  const done = normalizeLaunch({
    id: 'done',
    name: 'Falcon 9 | Old',
    net: future,
    status: { abbrev: 'Success' },
    launch_service_provider: { name: 'SpaceX' },
    rocket: { configuration: { full_name: 'Falcon 9' } },
    mission: { name: 'Old' },
  });
  assert.equal(done, null);
});

test('an empty alert never flips the board', () => {
  assert.equal(buildSpaceLaunchAlertPayload({ sentence: '' }), null);
  assert.deepEqual(spaceLaunchAlertFrames({ type: 'launch.alert' }), []);
  assert.deepEqual(alertRows(''), []);
});

test('createSpaceLaunchAlerts caches launches and serves payloads without refetching', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-launch-alerts-'));
  let fetchCount = 0;
  const future = new Date(Date.now() + 2 * 3600000).toISOString();
  const api = createSpaceLaunchAlerts({
    spaceLaunchAlertsSettingsPath: path.join(dir, 'settings.json'),
    spaceLaunchAlertsCachePath: path.join(dir, 'cache.json'),
    spaceLaunchAlertsFetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        async json() {
          return {
            results: [{
              id: 'launch-1',
              name: 'Falcon 9 | Starlink 6-56',
              net: future,
              status: { abbrev: 'Go' },
              launch_service_provider: { name: 'SpaceX' },
              rocket: { configuration: { full_name: 'Falcon 9' } },
              mission: { name: 'Starlink 6-56' },
            }],
          };
        },
      };
    },
  }, console);

  await api.refreshCache({ force: true });
  assert.equal(fetchCount, 1);
  assert.equal(api.statusSnapshot().available, 1);

  const payload = await api.nextPayload();
  assert.equal(payload.type, TYPE);
  assert.equal(payload.launch.id, 'launch-1');
  assert.equal(framesFor(payload.launch.sentence).length, 1);
  assert.deepEqual(
    api.statusSnapshot().launches[0].rows,
    spaceLaunchAlertFrames(payload)[0].rows,
  );

  await api.nextPayload();
  assert.equal(fetchCount, 1);
  api.stop();
});
