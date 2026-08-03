const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  COMMANDS,
  assertValid,
  createCommandRegistry,
} = require('../src/command-registry');

test('the shipped command table is well formed', () => {
  assert.equal(assertValid(), true);
  assert.ok(COMMANDS.length > 0);
});

test('command ids are unique', () => {
  const ids = COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every command id is a dotted namespace', () => {
  for (const command of COMMANDS) {
    assert.match(command.id, /^[a-z0-9]+\.[a-z0-9-]+$/, `bad id: ${command.id}`);
  }
});

test('assertValid rejects a duplicate id', () => {
  assert.throws(
    () => assertValid([
      { ...COMMANDS[0] },
      { ...COMMANDS[0] },
    ]),
    /Duplicate command id/,
  );
});

test('assertValid rejects a missing required key', () => {
  const broken = { ...COMMANDS[0] };
  delete broken.route;
  assert.throws(() => assertValid([broken]), /missing "route"/);
});

test('assertValid rejects a fixed-duration command with no duration', () => {
  assert.throws(
    () => assertValid([{ ...COMMANDS[0], defaultDurationSeconds: 0 }]),
    /positive defaultDurationSeconds/,
  );
});

test('assertValid rejects a variable-duration command that also fixes a duration', () => {
  assert.throws(
    () => assertValid([{
      ...COMMANDS[0], variableDuration: true, defaultDurationSeconds: 30,
    }]),
    /variableDuration but sets defaultDurationSeconds/,
  );
});

test('every command route is actually handled by the web server', () => {
  // The whole point of the registry is that the four places a command used to
  // live cannot drift; this catches a descriptor whose route was never wired.
  const source = fs.readFileSync(
    path.join(__dirname, '../src/web-server.js'), 'utf8',
  );
  for (const command of COMMANDS) {
    assert.ok(
      source.includes(`case '${command.route}':`),
      `${command.id} points at ${command.route}, which web-server.js does not handle`,
    );
  }
});

test('every command icon has admin artwork', () => {
  const appJs = fs.readFileSync(
    path.join(__dirname, '../src/web/admin/app.js'), 'utf8',
  );
  const iconBlock = appJs.slice(
    appJs.indexOf('const PUSH_ICONS = {'),
    appJs.indexOf('function pushIconSvg('),
  );
  for (const command of COMMANDS) {
    const icon = command.icon || command.group.toLowerCase();
    assert.ok(
      iconBlock.includes(`'${icon}':`) || iconBlock.includes(`${icon}:`),
      `no PUSH_ICONS entry for "${icon}" (${command.id})`,
    );
  }
});

test('every pushable command belongs to a rendered row', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../src/web/admin/index.html'), 'utf8',
  );
  const rendered = new Set(
    [...html.matchAll(/data-push-row="([^"]+)"/g)]
      .flatMap((match) => match[1].split(',').map((group) => group.trim())),
  );
  for (const command of COMMANDS.filter((c) => c.pushable)) {
    assert.ok(
      rendered.has(command.group),
      `${command.id} is pushable but group "${command.group}" has no push row`,
    );
  }
});

test('list() is JSON-serialisable and carries scheduler metadata', () => {
  const registry = createCommandRegistry();
  const list = registry.list();
  assert.deepEqual(
    JSON.parse(JSON.stringify(list)), list,
    'descriptors must survive a JSON round trip',
  );
  for (const command of list) {
    assert.equal(typeof command.schedulable, 'boolean');
    assert.equal(typeof command.variableDuration, 'boolean');
    assert.equal(typeof command.supportsContentCheck, 'boolean');
    assert.ok(Array.isArray(command.params));
  }
});

test('list() can filter to pushable or schedulable commands', () => {
  const registry = createCommandRegistry();
  // Compared against the table rather than a fixed count, so making another
  // command pushable does not look like a broken filter.
  assert.deepEqual(
    registry.list({ pushableOnly: true }).map((c) => c.id),
    COMMANDS.filter((c) => c.pushable).map((c) => c.id),
  );
  assert.deepEqual(
    registry.list({ schedulableOnly: true }).map((c) => c.id),
    COMMANDS.filter((c) => c.schedulable).map((c) => c.id),
  );
  assert.ok(registry.list().length >= registry.list({ pushableOnly: true }).length);
});

test('commands without a content check always report content', () => {
  const registry = createCommandRegistry();
  assert.equal(registry.hasContent('alexa.weather'), true);
  assert.equal(registry.hasContent('steam.last-played'), true);
});

test('steam.now-playing has content only while a session is live', () => {
  let status = null;
  const registry = createCommandRegistry({ getSteamStatus: () => status });
  assert.equal(registry.hasContent('steam.now-playing'), false);

  status = { session: { appId: 400, suppressed: false } };
  assert.equal(registry.hasContent('steam.now-playing'), true);

  // A suppressed session means the display is deliberately showing something
  // else, so the card would be wrong to air.
  status = { session: { appId: 400, suppressed: true } };
  assert.equal(registry.hasContent('steam.now-playing'), false);
});

test('psn.now-playing has content only while a session is live', () => {
  let status = null;
  const registry = createCommandRegistry({ getPsnStatus: () => status });
  assert.equal(registry.hasContent('psn.now-playing'), false);
  status = { session: { titleId: 'PPSA01668', suppressed: false } };
  assert.equal(registry.hasContent('psn.now-playing'), true);
});

test('an unwired feature reports no content rather than throwing', () => {
  const registry = createCommandRegistry();
  assert.equal(registry.hasContent('steam.now-playing'), false);
  assert.equal(registry.hasContent('psn.now-playing'), false);
});

test('a status probe that throws is treated as no content', () => {
  const warnings = [];
  const registry = createCommandRegistry({
    getSteamStatus: () => { throw new Error('poller exploded'); },
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal(registry.hasContent('steam.now-playing'), false);
  assert.equal(warnings.length, 1);
});

test('slideshow has content only when photos exist', () => {
  let count = 0;
  const registry = createCommandRegistry({ getPhotoCount: () => count });
  assert.equal(registry.hasContent('signal.slideshow'), false);
  count = 3;
  assert.equal(registry.hasContent('signal.slideshow'), true);
});

test('estimateDuration falls back to the descriptor default', () => {
  const registry = createCommandRegistry();
  assert.equal(registry.estimateDuration('alexa.weather'), 60);
  assert.equal(registry.estimateDuration('tesla.dashboard'), 120);
  assert.equal(registry.estimateDuration('nope.missing'), null);
});

test('estimateDuration honours an explicit per-airing override', () => {
  const registry = createCommandRegistry();
  assert.equal(
    registry.estimateDuration('alexa.weather', { displayDurationSeconds: 25 }),
    25,
  );
});

test('every fixed-duration command reports a positive estimate', () => {
  const registry = createCommandRegistry();
  for (const command of COMMANDS.filter((c) => !c.variableDuration)) {
    const seconds = registry.estimateDuration(command.id);
    assert.ok(seconds > 0, `${command.id} has no usable duration`);
  }
});

test('get() returns the descriptor or null', () => {
  const registry = createCommandRegistry();
  assert.equal(registry.get('alexa.weather').title, 'Weather Forecast');
  assert.equal(registry.get('does.not-exist'), null);
});

test('Steam and PSN library tours are schedulable with secondsPerGame', () => {
  for (const id of ['steam.library-tour', 'psn.library-tour']) {
    const command = COMMANDS.find((entry) => entry.id === id);
    assert.ok(command, `${id} missing from registry`);
    assert.equal(command.schedulable, true);
    assert.equal(command.pushable, true);
    assert.equal(command.variableDuration, true);
    assert.equal(command.supportsContentCheck, true);
    const secondsParam = (command.params || []).find((param) => param.key === 'secondsPerGame');
    assert.ok(secondsParam, `${id} must expose secondsPerGame`);
    assert.equal(secondsParam.type, 'number');
    assert.equal(secondsParam.min, 5);
    assert.equal(secondsParam.max, 300);
  }
});

test('library tour duration is count × secondsPerGame', () => {
  const registry = createCommandRegistry({
    getSteamLibraryCount: () => 704,
    getPsnLibraryCount: () => 40,
    getLibraryTourSettings: () => ({ secondsPerGame: 60, sort: 'name' }),
  });
  assert.equal(registry.estimateDuration('steam.library-tour'), 704 * 60);
  assert.equal(
    registry.estimateDuration('steam.library-tour', { secondsPerGame: 30 }),
    704 * 30,
  );
  assert.equal(registry.estimateDuration('psn.library-tour'), 40 * 60);
  assert.equal(registry.hasContent('steam.library-tour'), true);
  assert.equal(registry.hasContent('psn.library-tour'), true);
});
