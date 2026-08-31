const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  COMMANDS,
  BOARD_COMMAND_IDS,
  PUSH_CATEGORIES,
  kindsOf,
  supportsKind,
  pushCategoryOf,
  assertValid,
  createCommandRegistry,
} = require('../src/command-registry');
const { COMMAND_TO_TYPE, formatterFor } = require('../src/vestaboard/router');

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
    [...html.matchAll(/data-push-category="([^"]+)"/g)].map((match) => match[1].trim()),
  );
  for (const command of COMMANDS.filter((c) => c.pushable)) {
    const category = pushCategoryOf(command);
    assert.ok(
      rendered.has(category),
      `${command.id} is pushable but category "${category}" has no push row`,
    );
  }
  // A category rendered twice would double every tile in it.
  const rows = [...html.matchAll(/data-push-category="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(rows).size, rows.length, 'each category gets exactly one row');
});

test('a pushable command cannot ship without a pane to land in', () => {
  const orphan = {
    id: 'ghost.show', title: 'Ghost', group: 'Nowhere',
    route: '/api/push/ghost', pushable: true, schedulable: false,
    supportsContentCheck: false, variableDuration: false, defaultDurationSeconds: 30,
  };
  assert.throws(() => assertValid([orphan]), /no push category/);

  const misfiled = { ...orphan, pushCategory: 'basement' };
  assert.throws(() => assertValid([misfiled]), /unknown pushCategory/);
});

test('push categories are declared once and every tile claims a real one', () => {
  const ids = PUSH_CATEGORIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of PUSH_CATEGORIES) {
    assert.match(entry.id, /^[a-z-]+$/);
    assert.ok(entry.label, `${entry.id} needs a tab label`);
  }
  // Scheduler-only siblings inherit their group's pane, so the scheduler and
  // the Push page keep telling the same story about where a command lives.
  assert.equal(pushCategoryOf('steam.last-played'), pushCategoryOf('steam.now-playing'));
  assert.equal(pushCategoryOf('alexa.now-playing'), 'media');
  assert.equal(pushCategoryOf('alexa.weather'), 'home');
  assert.equal(pushCategoryOf('signal.guest-snaps'), 'share');
  assert.equal(pushCategoryOf('flightplan.board'), 'travel');
  assert.equal(pushCategoryOf('nope.missing'), null);
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
    assert.ok(Array.isArray(command.kinds) && command.kinds.length);
    assert.ok(
      command.kinds.includes('full') || command.kinds.includes('vestaboard'),
      `${command.id} needs a display kind`,
    );
    // The Push page files tiles by this, so it has to survive the wire.
    if (command.pushable) {
      assert.ok(
        PUSH_CATEGORIES.some((entry) => entry.id === command.pushCategory),
        `${command.id} sent an unusable pushCategory: ${command.pushCategory}`,
      );
    }
  }
});

test('every command declares the display kinds it can air on', () => {
  for (const command of COMMANDS) {
    const kinds = kindsOf(command);
    assert.ok(kinds.length, `${command.id} needs at least one display kind`);
    if (BOARD_COMMAND_IDS.has(command.id)) {
      assert.ok(kinds.includes('vestaboard'), `${command.id} is board-capable`);
    } else {
      assert.equal(
        kinds.includes('vestaboard'),
        false,
        `${command.id} is full-display only (photos, tours, remote)`,
      );
      assert.ok(kinds.includes('full'), `${command.id} must work on a full display`);
    }
  }
  assert.equal(supportsKind('signal.slideshow', 'vestaboard'), false);
  assert.equal(supportsKind('signal.slideshow', 'full'), true);
  assert.equal(supportsKind('alexa.weather', 'vestaboard'), true);
  assert.equal(supportsKind('alexa.weather', 'all'), true);
  assert.equal(supportsKind('plex.now-playing', 'vestaboard'), true);
  assert.equal(supportsKind('plex.now-playing', 'full'), false);
  assert.equal(supportsKind('weather.weekly', 'vestaboard'), true);
  assert.equal(supportsKind('weather.weekly', 'full'), false);
  assert.equal(supportsKind('japanese.learn', 'vestaboard'), true);
  assert.equal(supportsKind('japanese.learn', 'full'), false);
  assert.equal(supportsKind('portuguese.learn', 'vestaboard'), true);
  assert.equal(supportsKind('spanish.learn', 'vestaboard'), true);
  assert.equal(supportsKind('french.learn', 'vestaboard'), true);
  assert.equal(supportsKind('german.learn', 'vestaboard'), true);
  assert.equal(supportsKind('italian.learn', 'vestaboard'), true);
  assert.equal(supportsKind('italian.learn', 'full'), false);
  assert.equal(supportsKind('signal.quiet-hours', 'vestaboard'), true);
  assert.equal(supportsKind('signal.quiet-hours', 'full'), false);
  assert.equal(supportsKind('scramble.invite', 'vestaboard'), true);
  assert.equal(supportsKind('scramble.invite', 'full'), false);
  assert.equal(supportsKind('word.riddles', 'vestaboard'), true);
  assert.equal(supportsKind('word.riddles', 'full'), false);
  assert.equal(supportsKind('chuck.facts', 'vestaboard'), true);
  assert.equal(supportsKind('chuck.facts', 'full'), false);
  assert.equal(supportsKind('amazing.facts', 'vestaboard'), true);
  assert.equal(supportsKind('amazing.facts', 'full'), false);
  assert.equal(supportsKind('geo.facts', 'vestaboard'), true);
  assert.equal(supportsKind('geo.facts', 'full'), false);
  assert.equal(supportsKind('talk.starters', 'vestaboard'), true);
  assert.equal(supportsKind('talk.starters', 'full'), false);
  assert.equal(supportsKind('stoic.quotes', 'vestaboard'), true);
  assert.equal(supportsKind('stoic.quotes', 'full'), false);
  assert.equal(supportsKind('history.day', 'vestaboard'), true);
  assert.equal(supportsKind('history.day', 'full'), false);
  assert.equal(supportsKind('world.population', 'vestaboard'), true);
  assert.equal(supportsKind('world.population', 'full'), false);
  assert.equal(supportsKind('calendar.clock', 'vestaboard'), true);
  assert.equal(supportsKind('calendar.clock', 'full'), false);
  assert.equal(supportsKind('guestbook.invite', 'vestaboard'), true);
  assert.equal(supportsKind('guestbook.invite', 'full'), false);
  assert.equal(supportsKind('bake.inspire', 'vestaboard'), true);
  assert.equal(supportsKind('bake.inspire', 'full'), false);
  assert.equal(supportsKind('weather.alerts', 'vestaboard'), true);
  assert.equal(supportsKind('weather.alerts', 'full'), false);
  assert.equal(supportsKind('stocks.market', 'vestaboard'), true);
  assert.equal(supportsKind('stocks.market', 'full'), false);
  assert.equal(supportsKind('fx.rates', 'vestaboard'), true);
  assert.equal(supportsKind('fx.rates', 'full'), false);
  assert.equal(supportsKind('iss.track', 'vestaboard'), true);
  assert.equal(supportsKind('iss.track', 'full'), false);
  assert.equal(supportsKind('starlink.track', 'vestaboard'), true);
  assert.equal(supportsKind('starlink.track', 'full'), false);
});

test('every board-capable command has a Vestaboard formatter', () => {
  for (const id of BOARD_COMMAND_IDS) {
    const type = COMMAND_TO_TYPE[id] || id;
    assert.ok(
      formatterFor(type) || formatterFor(id),
      `${id} is board-capable but the router has no formatter for ${type}`,
    );
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

test('list({ skipContentCheck }) runs no readiness probes', () => {
  // The admin Push grid only needs titles, icons and categories, and the
  // probes fan out into every provider — that cost is why the grid used to
  // sit on skeletons. This shape is what gets inlined into the admin page.
  let probes = 0;
  const registry = createCommandRegistry({
    getChuckNorrisStatus: () => { probes += 1; return { available: 0 }; },
    getSteamStatus: () => { probes += 1; return { session: null }; },
    getPhotoCount: () => { probes += 1; return 0; },
  });

  const cheap = registry.list({ skipContentCheck: true });
  assert.equal(probes, 0, 'no provider was asked whether it has content');
  assert.deepEqual(cheap.map((c) => c.id), registry.list({ skipContentCheck: true }).map((c) => c.id));
  assert.ok(cheap.every((command) => command.hasContent === true));
  const chuck = cheap.find((command) => command.id === 'chuck.facts');
  assert.equal(chuck.title, COMMANDS.find((c) => c.id === 'chuck.facts').title);
  assert.equal(
    chuck.estimatedDurationSeconds,
    COMMANDS.find((c) => c.id === 'chuck.facts').defaultDurationSeconds,
  );

  // The default shape still asks, and still reports an empty corpus as empty.
  const full = registry.list();
  assert.ok(probes > 0);
  assert.equal(full.find((command) => command.id === 'chuck.facts').hasContent, false);
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

test('weather.weekly is Vestaboard-only and needs a house pin', () => {
  const weekly = COMMANDS.find((command) => command.id === 'weather.weekly');
  assert.ok(weekly);
  assert.ok(weekly.pushable);
  assert.ok(weekly.schedulable);
  assert.equal(weekly.supportsContentCheck, true);
  assert.deepEqual(kindsOf(weekly), ['vestaboard']);
  assert.equal(pushCategoryOf(weekly), 'home');
  assert.equal(weekly.route, '/api/push/weekly-weather');
  assert.equal(weekly.defaultDurationSeconds, 20);

  let locale = null;
  const registry = createCommandRegistry({ getLocaleSettings: () => locale });
  assert.equal(registry.hasContent('weather.weekly'), false);

  locale = { latitude: 40.41, longitude: -111.85 };
  assert.equal(registry.hasContent('weather.weekly'), true);

  locale = { latitude: null, longitude: -111.85 };
  assert.equal(registry.hasContent('weather.weekly'), false);
});

test('weather.alerts is Vestaboard-only and needs a house pin', () => {
  const command = COMMANDS.find((entry) => entry.id === 'weather.alerts');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/weather-alerts');
  assert.equal(command.defaultDurationSeconds, 45);

  let locale = null;
  const registry = createCommandRegistry({ getLocaleSettings: () => locale });
  assert.equal(registry.hasContent('weather.alerts'), false);

  locale = { latitude: 40.41, longitude: -111.85 };
  assert.equal(registry.hasContent('weather.alerts'), true);
});

test('stocks.market is Vestaboard-only and needs a watchlist', () => {
  const command = COMMANDS.find((entry) => entry.id === 'stocks.market');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/stock-market');
  assert.equal(command.defaultDurationSeconds, 30);

  const empty = createCommandRegistry({ getStockMarketStatus: () => ({ tickerCount: 0 }) });
  assert.equal(empty.hasContent('stocks.market'), false);

  const ready = createCommandRegistry({ getStockMarketStatus: () => ({ tickerCount: 8 }) });
  assert.equal(ready.hasContent('stocks.market'), true);
});

test('fx.rates is Vestaboard-only and needs a quote list', () => {
  const command = COMMANDS.find((entry) => entry.id === 'fx.rates');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/currency-rates');
  assert.equal(command.defaultDurationSeconds, 30);

  const empty = createCommandRegistry({ getCurrencyRatesStatus: () => ({ quoteCount: 0 }) });
  assert.equal(empty.hasContent('fx.rates'), false);

  const ready = createCommandRegistry({ getCurrencyRatesStatus: () => ({ quoteCount: 8 }) });
  assert.equal(ready.hasContent('fx.rates'), true);
});

test('iss.track is Vestaboard-only Sky travel push', () => {
  const command = COMMANDS.find((entry) => entry.id === 'iss.track');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, false);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'travel');
  assert.equal(command.route, '/api/push/iss-tracker');
  assert.equal(command.defaultDurationSeconds, 30);
});

test('starlink.track is Vestaboard-only and needs a house pin', () => {
  const command = COMMANDS.find((entry) => entry.id === 'starlink.track');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'travel');
  assert.equal(command.route, '/api/push/starlink-tracker');

  let locale = null;
  const registry = createCommandRegistry({ getLocaleSettings: () => locale });
  assert.equal(registry.hasContent('starlink.track'), false);
  locale = { latitude: 40.41, longitude: -111.85 };
  assert.equal(registry.hasContent('starlink.track'), true);
});

test('japanese.learn is Vestaboard-only and needs a matching word', () => {
  const command = COMMANDS.find((entry) => entry.id === 'japanese.learn');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'language');
  assert.equal(command.route, '/api/push/learn-japanese');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getLearnJapaneseStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('japanese.learn'), false);

  const ready = createCommandRegistry({ getLearnJapaneseStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('japanese.learn'), true);
});

test('european learn-language commands stay Vestaboard-only under Language', () => {
  for (const id of [
    'portuguese.learn', 'spanish.learn', 'french.learn', 'german.learn', 'italian.learn',
  ]) {
    const command = COMMANDS.find((entry) => entry.id === id);
    assert.ok(command, id);
    assert.ok(command.pushable);
    assert.ok(command.schedulable);
    assert.equal(command.supportsContentCheck, true);
    assert.deepEqual(kindsOf(command), ['vestaboard']);
    assert.equal(pushCategoryOf(command), 'language');
    assert.equal(command.group, 'Language');
    assert.equal(command.defaultDurationSeconds, 20);

    const empty = createCommandRegistry({
      getLearnLanguageStatus: () => ({ available: 0 }),
    });
    assert.equal(empty.hasContent(id), false);

    const ready = createCommandRegistry({
      getLearnLanguageStatus: () => ({ available: 80 }),
    });
    assert.equal(ready.hasContent(id), true);
  }
});

test('scramble.invite is Vestaboard-only and needs a short link', () => {
  const command = COMMANDS.find((entry) => entry.id === 'scramble.invite');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'games');
  assert.equal(command.route, '/api/push/word-scramble');

  const empty = createCommandRegistry({ getScrambleInviteStatus: () => ({ inviteReady: false }) });
  assert.equal(empty.hasContent('scramble.invite'), false);
  const ready = createCommandRegistry({ getScrambleInviteStatus: () => ({ inviteReady: true }) });
  assert.equal(ready.hasContent('scramble.invite'), true);
});

test('word.riddles is Vestaboard-only and needs a ready riddle', () => {
  const command = COMMANDS.find((entry) => entry.id === 'word.riddles');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.equal(command.variableDuration, true);
  assert.equal(command.defaultDurationSeconds, null);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'games');
  assert.equal(command.route, '/api/push/word-riddles');

  const empty = createCommandRegistry({ getWordRiddlesStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('word.riddles'), false);

  const ready = createCommandRegistry({
    getWordRiddlesStatus: () => ({ available: 80, revealDelaySeconds: 30, showIntro: true }),
  });
  assert.equal(ready.hasContent('word.riddles'), true);
  assert.equal(ready.estimateDuration('word.riddles'), 58);
  assert.equal(ready.estimateDuration('word.riddles', { revealDelaySeconds: 45, showIntro: false }), 65);
});

test('chuck.facts is Vestaboard-only and needs a ready fact', () => {
  const command = COMMANDS.find((entry) => entry.id === 'chuck.facts');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/chuck-norris');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getChuckNorrisStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('chuck.facts'), false);

  const ready = createCommandRegistry({ getChuckNorrisStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('chuck.facts'), true);
});

test('roast.me is Vestaboard-only and needs a ready roast', () => {
  const command = COMMANDS.find((entry) => entry.id === 'roast.me');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/roast-me');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getRoastMeStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('roast.me'), false);

  const ready = createCommandRegistry({ getRoastMeStatus: () => ({ available: 120 }) });
  assert.equal(ready.hasContent('roast.me'), true);
});

test('family.quotes is Vestaboard-only and needs a ready quote', () => {
  const command = COMMANDS.find((entry) => entry.id === 'family.quotes');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/family-quotes');
  assert.equal(command.defaultDurationSeconds, 30);

  const empty = createCommandRegistry({ getFamilyQuotesStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('family.quotes'), false);

  const ready = createCommandRegistry({ getFamilyQuotesStatus: () => ({ available: 300 }) });
  assert.equal(ready.hasContent('family.quotes'), true);
});

test('dad.jokes is Vestaboard-only and needs a ready joke', () => {
  const command = COMMANDS.find((entry) => entry.id === 'dad.jokes');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/dad-jokes');
  assert.equal(command.defaultDurationSeconds, 30);

  const empty = createCommandRegistry({ getDadJokesStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('dad.jokes'), false);

  const ready = createCommandRegistry({ getDadJokesStatus: () => ({ available: 400 }) });
  assert.equal(ready.hasContent('dad.jokes'), true);
});

test('us.weather-map is a Vestaboard weather tile that survives a cold start', () => {
  const command = COMMANDS.find((entry) => entry.id === 'us.weather-map');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  // Files with the weekly forecast, not with the headlines.
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/us-weather-map');
  assert.equal(command.defaultDurationSeconds, 30);

  // Nothing fetched yet and nothing broken: it may still be scheduled.
  const cold = createCommandRegistry({
    getUsWeatherMapStatus: () => ({ hasMap: false, lastError: null }),
  });
  assert.equal(cold.hasContent('us.weather-map'), true);

  const broken = createCommandRegistry({
    getUsWeatherMapStatus: () => ({ hasMap: false, lastError: 'network down' }),
  });
  assert.equal(broken.hasContent('us.weather-map'), false);

  // A stale map still beats a blank board.
  const stale = createCommandRegistry({
    getUsWeatherMapStatus: () => ({ hasMap: true, lastError: 'network down' }),
  });
  assert.equal(stale.hasContent('us.weather-map'), true);
});

test('amazing.facts is Vestaboard-only and needs a ready fact', () => {
  const command = COMMANDS.find((entry) => entry.id === 'amazing.facts');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/amazing-facts');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getAmazingFactsStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('amazing.facts'), false);

  const ready = createCommandRegistry({ getAmazingFactsStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('amazing.facts'), true);
});

test('geo.facts is Vestaboard-only and needs a ready fact', () => {
  const command = COMMANDS.find((entry) => entry.id === 'geo.facts');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/world-geography-facts');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getWorldGeographyFactsStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('geo.facts'), false);

  const ready = createCommandRegistry({ getWorldGeographyFactsStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('geo.facts'), true);
});

test('talk.starters is Vestaboard-only and needs a ready prompt', () => {
  const command = COMMANDS.find((entry) => entry.id === 'talk.starters');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/conversation-starters');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getConversationStartersStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('talk.starters'), false);

  const ready = createCommandRegistry({ getConversationStartersStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('talk.starters'), true);
});

test('stoic.quotes is Vestaboard-only and needs a ready quote', () => {
  const command = COMMANDS.find((entry) => entry.id === 'stoic.quotes');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/stoic-quotes');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getStoicQuotesStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('stoic.quotes'), false);

  const ready = createCommandRegistry({ getStoicQuotesStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('stoic.quotes'), true);
});

test('history.day is Vestaboard-only and needs a ready On This Day fact', () => {
  const command = COMMANDS.find((entry) => entry.id === 'history.day');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/on-this-day');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getOnThisDayStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('history.day'), false);

  const ready = createCommandRegistry({ getOnThisDayStatus: () => ({ available: 12 }) });
  assert.equal(ready.hasContent('history.day'), true);
});

test('guestbook.invite is Vestaboard-only Signal and needs a short link', () => {
  const command = COMMANDS.find((entry) => entry.id === 'guestbook.invite');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(command.route, '/api/push/guest-book-invite');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({});
  assert.equal(empty.hasContent('guestbook.invite'), false);
  const ready = createCommandRegistry({ getGuestBookStatus: () => ({ inviteReady: true }) });
  assert.equal(ready.hasContent('guestbook.invite'), true);
});

test('ring.doorbell is Vestaboard-only home and needs a saved token', () => {
  const command = COMMANDS.find((entry) => entry.id === 'ring.doorbell');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.equal(command.schedulable, false);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/ring-doorbell');

  const empty = createCommandRegistry({});
  assert.equal(empty.hasContent('ring.doorbell'), false);
  const ready = createCommandRegistry({ getRingStatus: () => ({ configured: true }) });
  assert.equal(ready.hasContent('ring.doorbell'), true);
});

test('calendar.clock is Vestaboard-only home and always has content', () => {
  const command = COMMANDS.find((entry) => entry.id === 'calendar.clock');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, false);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/calendar-clock');
  assert.equal(command.defaultDurationSeconds, 60);

  const registry = createCommandRegistry({});
  assert.equal(registry.hasContent('calendar.clock'), true);
});

test('word.clock is Vestaboard-only home and always has content', () => {
  const command = COMMANDS.find((entry) => entry.id === 'word.clock');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, false);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/word-clock');
  assert.equal(command.defaultDurationSeconds, 60);

  const registry = createCommandRegistry({});
  assert.equal(registry.hasContent('word.clock'), true);
});

test('world.population is Vestaboard-only and always has content', () => {
  const command = COMMANDS.find((entry) => entry.id === 'world.population');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, false);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/world-population');
  assert.equal(command.defaultDurationSeconds, 20);

  const registry = createCommandRegistry({});
  assert.equal(registry.hasContent('world.population'), true);
});

test('bake.inspire is Vestaboard-only and needs a ready idea', () => {
  const command = COMMANDS.find((entry) => entry.id === 'bake.inspire');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, true);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'news');
  assert.equal(command.route, '/api/push/baking-inspiration');
  assert.equal(command.defaultDurationSeconds, 20);

  const empty = createCommandRegistry({ getBakingInspirationStatus: () => ({ available: 0 }) });
  assert.equal(empty.hasContent('bake.inspire'), false);

  const ready = createCommandRegistry({ getBakingInspirationStatus: () => ({ available: 80 }) });
  assert.equal(ready.hasContent('bake.inspire'), true);
});

test('signal.quiet-hours is Vestaboard-only and always has content', () => {
  const command = COMMANDS.find((entry) => entry.id === 'signal.quiet-hours');
  assert.ok(command);
  assert.ok(command.pushable);
  assert.ok(command.schedulable);
  assert.equal(command.supportsContentCheck, false);
  assert.deepEqual(kindsOf(command), ['vestaboard']);
  assert.equal(pushCategoryOf(command), 'home');
  assert.equal(command.route, '/api/push/quiet-hours-reminder');
  assert.equal(command.defaultDurationSeconds, 20);

  const registry = createCommandRegistry();
  assert.equal(registry.hasContent('signal.quiet-hours'), true);
});

test('plex.now-playing has content when a session or last-played exists', () => {
  let status = null;
  const registry = createCommandRegistry({ getPlexStatus: () => status });
  assert.equal(registry.hasContent('plex.now-playing'), false);

  status = { hasContent: true, lastPlayed: { title: 'Interstellar' } };
  assert.equal(registry.hasContent('plex.now-playing'), true);

  status = { hasContent: true, lastPlayed: null };
  assert.equal(registry.hasContent('plex.now-playing'), true);
});

test('Feature Presentation is a single auto command, not a last-played twin', () => {
  assert.equal(COMMANDS.some((command) => command.id === 'plex.last-played'), false);
  const plex = COMMANDS.find((command) => command.id === 'plex.now-playing');
  assert.ok(plex.pushable);
  assert.ok(plex.schedulable);
  assert.equal(plex.body?.mode, undefined);
  assert.equal(plex.subtitle, 'Now playing, or last played');
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

test('notifications push has content only when a notification was captured', () => {
  let status = { hasContent: false };
  const registry = createCommandRegistry({ getNotificationsCacheStatus: () => status });
  assert.equal(registry.hasContent('alexa.notifications'), false);
  status = { hasContent: true };
  assert.equal(registry.hasContent('alexa.notifications'), true);
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
    getLibraryTourSettings: () => ({
      steam: { secondsPerGame: 60, sort: 'recent' },
      psn: { secondsPerGame: 45, sort: 'random' },
    }),
  });
  assert.equal(registry.estimateDuration('steam.library-tour'), 704 * 60);
  assert.equal(
    registry.estimateDuration('steam.library-tour', { secondsPerGame: 30 }),
    704 * 30,
  );
  assert.equal(registry.estimateDuration('psn.library-tour'), 40 * 45);
  assert.equal(registry.hasContent('steam.library-tour'), true);
  assert.equal(registry.hasContent('psn.library-tour'), true);
});

test('Roll Credits command exposes scheduler params and content check', () => {
  const command = COMMANDS.find((entry) => entry.id === 'credits.show');
  assert.ok(command);
  assert.equal(command.group, 'Games');
  assert.equal(command.route, '/api/push/roll-credits');
  assert.equal(command.variableDuration, true);
  assert.deepEqual(command.params.map((param) => param.key), ['secondsPerGame', 'gameLimit']);

  let gameCount = 0;
  const registry = createCommandRegistry({
    getRollCreditsStatus: () => ({
      gameCount,
      settings: {
        display: { secondsPerGame: 12, dashboardSeconds: 25, scheduledGameLimit: 15 },
      },
    }),
  });
  assert.equal(registry.hasContent('credits.show'), false);
  gameCount = 40;
  assert.equal(registry.hasContent('credits.show'), true);
  assert.equal(registry.estimateDuration('credits.show'), 25 + 15 * 12 + 4);
  assert.equal(
    registry.estimateDuration('credits.show', { secondsPerGame: 20, gameLimit: 3 }),
    25 + 3 * 20 + 4,
  );
});
