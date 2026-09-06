const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitiseSettings,
  sanitiseDestinations,
  classifyPayload,
  shouldBypassRouting,
  inAnyWindow,
  slotsAllow,
  resolveRoute,
  windowsToSlots,
  FAMILIES,
} = require('../src/event-routing');

test('default settings open every family to all displays via one route', () => {
  const settings = sanitiseSettings(null);
  assert.equal(settings.version, 2);
  assert.equal(FAMILIES.length > 10, true);
  for (const row of FAMILIES) {
    assert.deepEqual(settings.families[row.id], {
      routes: [{ destinations: 'all', slots: [] }],
    });
  }
});

test('destinations accept class shortcuts and specific display lists', () => {
  assert.equal(sanitiseDestinations('all'), 'all');
  assert.equal(sanitiseDestinations('vestaboards'), 'vestaboard');
  assert.equal(sanitiseDestinations('software'), 'full');
  assert.deepEqual(
    sanitiseDestinations(['board-a', 'board-a', 'poster-1']),
    ['board-a', 'poster-1'],
  );
});

test('classify maps common automated payload types', () => {
  assert.equal(classifyPayload({ type: 'alarm.fired' }), 'alexa.alarms');
  assert.equal(classifyPayload({ type: 'plex.now-playing' }), 'media.plex');
  assert.equal(classifyPayload({ type: 'youtube.now-playing' }), 'media.youtube');
  assert.equal(classifyPayload({ type: 'steam.now-playing.close' }), 'media.steam');
  assert.equal(classifyPayload({ type: 'unknown.thing' }), null);
});

test('manual and scheduler sends bypass routing', () => {
  assert.equal(shouldBypassRouting({ source: 'scheduler' }), true);
  assert.equal(shouldBypassRouting({ source: 'web-api' }), true);
  assert.equal(shouldBypassRouting({ bypassEventRouting: true }), true);
  assert.equal(shouldBypassRouting({}), false);
});

test('legacy HH:mm windows migrate onto weekday hour slots', () => {
  const slots = windowsToSlots([{ start: '20:00', end: '23:00' }]);
  assert.equal(slots.length, 7 * 3);
  assert.equal(slots.every((s) => s.hour >= 20 && s.hour < 23), true);
  const windows = [{ start: '22:00', end: '07:00' }];
  const noon = new Date('2026-09-05T18:00:00Z');
  const night = new Date('2026-09-06T05:00:00Z');
  assert.equal(inAnyWindow(windows, 'America/Denver', noon), false);
  assert.equal(inAnyWindow(windows, 'America/Denver', night), true);
});

test('slotsAllow treats empty as always and matches weekday hour', () => {
  // Saturday 2026-09-05 12:00 Denver = day 5, hour 12
  const noon = new Date('2026-09-05T18:00:00Z');
  assert.equal(slotsAllow([], 'America/Denver', noon), true);
  assert.equal(slotsAllow([{ day: 5, hour: 12, minute: 0 }], 'America/Denver', noon), true);
  assert.equal(slotsAllow([{ day: 0, hour: 12, minute: 0 }], 'America/Denver', noon), false);
});

test('legacy v1 settings migrate and resolveRoute unions multi-route targets', () => {
  const settings = sanitiseSettings({
    families: {
      'media.plex': {
        destinations: 'vestaboard',
        windows: [{ start: '20:00', end: '23:00' }],
      },
      'alexa.alarms': {
        routes: [
          {
            destinations: ['board-kitchen'],
            slots: [{ day: 5, hour: 12, minute: 0 }],
          },
          {
            destinations: ['board-hall'],
            slots: [],
          },
        ],
      },
    },
  });

  assert.equal(settings.families['media.plex'].routes.length, 1);
  assert.equal(settings.families['media.plex'].routes[0].destinations, 'vestaboard');
  assert.ok(settings.families['media.plex'].routes[0].slots.length > 0);

  const inside = new Date('2026-09-06T03:30:00Z'); // Sat 21:30 Denver
  const outside = new Date('2026-09-05T18:00:00Z'); // Sat 12:00 Denver

  const plexOk = resolveRoute(
    { type: 'plex.now-playing' },
    {},
    settings,
    { timeZone: 'America/Denver', now: inside },
  );
  assert.equal(plexOk.skip, false);
  assert.deepEqual(plexOk.targets, ['vestaboard']);

  const plexSkip = resolveRoute(
    { type: 'plex.now-playing' },
    {},
    settings,
    { timeZone: 'America/Denver', now: outside },
  );
  assert.equal(plexSkip.skip, true);

  const alarmNoon = resolveRoute(
    { type: 'alarm.fired' },
    {},
    settings,
    { timeZone: 'America/Denver', now: outside },
  );
  assert.equal(alarmNoon.skip, false);
  assert.deepEqual(alarmNoon.targets.sort(), ['board-hall', 'board-kitchen']);

  const alarmNight = resolveRoute(
    { type: 'alarm.fired' },
    {},
    settings,
    { timeZone: 'America/Denver', now: inside },
  );
  assert.equal(alarmNight.skip, false);
  assert.deepEqual(alarmNight.targets, ['board-hall']);

  const open = resolveRoute(
    { type: 'youtube.now-playing' },
    {},
    settings,
    { timeZone: 'America/Denver', now: outside },
  );
  assert.equal(open.skip, false);
  assert.equal(open.targets, null);

  const bypass = resolveRoute(
    { type: 'plex.now-playing' },
    { source: 'manual' },
    settings,
    { timeZone: 'America/Denver', now: outside },
  );
  assert.equal(bypass.bypassed, true);
  assert.equal(bypass.skip, false);
});