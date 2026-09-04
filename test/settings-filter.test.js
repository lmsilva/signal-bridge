'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  SETTINGS_VIEW_ORDER,
  extractSettingsCatalog,
  filterSettingsCatalog,
  decideSettingsFilter,
  matchesSearchQuery,
} = require('../src/web/admin/settings-filter');

const html = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../src/web/admin/app.js'), 'utf8');

function catalog() {
  return extractSettingsCatalog(html);
}

test('every settings card has a sibling heading, never a heading nested inside', () => {
  const { cards, headings, errors } = catalog();
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(cards.length >= 20, `expected a full settings grid, got ${cards.length} cards`);
  assert.ok(headings.length >= 15, `expected section headings, got ${headings.length}`);

  for (const view of SETTINGS_VIEW_ORDER) {
    assert.ok(
      cards.some((card) => card.group === view),
      `pane "${view}" has no cards — section tabs would look empty`,
    );
    assert.ok(
      headings.some((heading) => heading.group === view),
      `pane "${view}" has no heading`,
    );
  }

  const vestaboard = cards.find((card) => card.id === 'vb-settings-card');
  assert.ok(vestaboard, 'Vestaboards card must have id="vb-settings-card"');
  assert.equal(vestaboard.group, 'media');
  assert.match(vestaboard.heading, /vestaboards/i);

  // A stray </div> after Guest Book once closed the grid early, leaving Ring
  // through Vestaboards as siblings the filter never saw.
  assert.ok(cards.some((card) => card.id === 'ring-doorbell-settings-card'));
  assert.ok(cards.some((card) => card.id === 'youtube-settings-card'));
});

test('searching "quiet" finds Quiet Hours on the Vestaboards card', () => {
  const { cards, errors } = catalog();
  assert.equal(errors.length, 0, errors.join('\n'));

  const result = filterSettingsCatalog(cards, {
    query: 'quiet',
    kindFilter: 'all',
    activeView: 'global',
  });

  assert.ok(result.total > 0, 'searching "quiet" must not show "No settings match that search."');
  assert.ok(
    result.matches.some((card) => card.id === 'vb-settings-card'),
    'Quiet Hours lives on the Vestaboards card',
  );
  assert.ok(result.counts.media >= 1);
  assert.equal(result.empty, false);
  if (result.counts.global === 0) {
    assert.equal(result.view, 'media', 'with no Global hits, "quiet" should open Media');
  }

  // The words a user actually types.
  const vb = result.matches.find((card) => card.id === 'vb-settings-card');
  assert.ok(matchesSearchQuery(vb.haystack, 'quiet hours'));
  assert.ok(matchesSearchQuery(vb.haystack, 'vestaboard'));
});

test('section tabs with no search hits hide, matching Push', () => {
  const { cards } = catalog();
  const result = filterSettingsCatalog(cards, {
    query: 'quiet',
    kindFilter: 'all',
    activeView: 'global',
  });

  for (const name of SETTINGS_VIEW_ORDER) {
    const tab = result.tabs[name];
    if (tab.count === 0 && !tab.active) {
      assert.equal(tab.hidden, true, `${name} has no hits and must hide`);
    } else {
      assert.equal(tab.hidden, false, `${name} is active or has hits`);
    }
  }

  // An explicit click onto an empty pane still lands there; that tab stays
  // visible so the bar does not vanish, same as Push.
  for (const pane of ['global', 'accounts', 'youtube']) {
    const clicked = filterSettingsCatalog(cards, {
      query: 'quiet',
      kindFilter: 'all',
      activeView: 'media',
      preferredView: pane,
    });
    assert.equal(clicked.view, pane, `clicking ${pane} during a "quiet" search must stay there`);
    assert.equal(clicked.tabs[pane].active, true);
    assert.equal(clicked.tabs[pane].hidden, false);
    for (const name of SETTINGS_VIEW_ORDER) {
      if (name === pane) continue;
      if ((clicked.counts[name] || 0) === 0) {
        assert.equal(clicked.tabs[name].hidden, true, `${name} has no hits`);
      } else {
        assert.equal(clicked.tabs[name].hidden, false, `${name} has hits`);
      }
    }
  }
});

test('heading-only words still match (Conversation Starters, World Currency)', () => {
  const { cards } = catalog();
  const starters = filterSettingsCatalog(cards, { query: 'starter', activeView: 'global' });
  assert.ok(starters.matches.some((card) => card.id === 'conversation-starters-settings-card'));
  assert.equal(starters.view, 'news');

  const world = filterSettingsCatalog(cards, { query: 'world currency', activeView: 'global' });
  assert.ok(world.matches.some((card) => card.id === 'currency-rates-settings-card'));
});

test('decideSettingsFilter hides zero-hit tabs only while searching', () => {
  const idle = decideSettingsFilter({
    counts: Object.fromEntries(SETTINGS_VIEW_ORDER.map((name) => [name, 0])),
    query: '',
    kindFilter: 'all',
    activeView: 'global',
  });
  for (const name of SETTINGS_VIEW_ORDER) {
    assert.equal(idle.tabs[name].hidden, false);
  }

  const empty = decideSettingsFilter({
    counts: Object.fromEntries(SETTINGS_VIEW_ORDER.map((name) => [name, 0])),
    query: 'zzzz-no-such-setting',
    kindFilter: 'all',
    activeView: 'global',
  });
  assert.equal(empty.empty, true);
  assert.equal(empty.tabs.global.hidden, false, 'the active tab stays');
  for (const name of SETTINGS_VIEW_ORDER.filter((view) => view !== 'global')) {
    assert.equal(empty.tabs[name].hidden, true, `${name} has no hits`);
  }

  const bounced = decideSettingsFilter({
    counts: { media: 1, global: 0, accounts: 0, youtube: 0, games: 0, news: 0, language: 0, travel: 0 },
    query: 'quiet',
    preferredView: 'youtube',
  });
  assert.equal(bounced.view, 'youtube');
  assert.equal(bounced.tabs.youtube.hidden, false);
  assert.equal(bounced.tabs.media.hidden, false);
  assert.equal(bounced.tabs.global.hidden, true);
});

test('the admin page loads the shared filter and hides zero-hit search tabs', () => {
  assert.match(html, /settings-filter\.js\?v=signal290/);
  assert.match(html, /id="vb-settings-card"[^>]*data-search-terms="[^"]*quiet hours/);
  assert.match(html, /<div class="section-label" data-settings-group="media">Vestaboards<\/div>\s*<div class="card vb-settings-card"/);
  assert.match(appJs, /SignalSettingsFilter/);
  assert.match(appJs, /hide tabs with no hits/);
  const clickAt = appJs.indexOf("settings-view-tabs')?.addEventListener");
  assert.ok(clickAt > 0, 'settings section tabs must have a click handler');
  const settingsClick = appJs.slice(clickAt, clickAt + 600);
  assert.match(settingsClick, /showSettingsView\(next\)/);
  assert.doesNotMatch(settingsClick, /if \(btn\.hidden\) return/);
});
