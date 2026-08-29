'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { onThisDayFrames } = require('../src/vestaboard/formatters/feeds');
const {
  loadShipped,
  eventRows,
  matchingEvents,
  pickEvent,
  listEvents,
  buildOnThisDayPayload,
  formatDateLine,
  formatYear,
  createOnThisDay,
} = require('../src/on-this-day');
const { sanitiseSettings } = require('../src/on-this-day-settings');

test('the shipped corpus covers every calendar day with board-fit facts', () => {
  const events = loadShipped();
  assert.ok(events.length > 4000, `expected thousands of events, got ${events.length}`);
  const days = new Set();
  for (const event of events.slice(0, 120)) {
    assert.ok(event.id);
    assert.ok(event.text);
    assert.ok(Number.isFinite(event.year) && event.year !== 0);
    assert.ok(event.month >= 1 && event.month <= 12);
    assert.ok(event.day >= 1 && event.day <= 31);
    const rows = eventRows(event.text);
    assert.ok(rows.length >= 1 && rows.length <= 4, event.text);
  }
  for (const event of events) {
    days.add(`${String(event.month).padStart(2, '0')}-${String(event.day).padStart(2, '0')}`);
  }
  assert.equal(days.size, 366);
});

test('buildOnThisDayPayload is a vestaboard history.day card', () => {
  const payload = buildOnThisDayPayload({
    id: 'demo',
    month: 8,
    day: 29,
    year: 1966,
    text: 'The Beatles give their last public concert at Candlestick Park.',
  });
  assert.equal(payload.type, 'history.day');
  assert.equal(payload.event.dateLine, 'AUG 29, 1966');
  const frames = onThisDayFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'history.day');
  const drawing = formatLayout(frames[0].rows).split('\n');
  assert.match(drawing[0], /ON THIS DAY/);
  assert.match(drawing[1], /AUG 29/);
  assert.match(drawing[1], /1966/);
  assert.equal(validate(frames[0].rows).ok, true);
});

test('on this day with no text renders nothing', () => {
  assert.deepEqual(onThisDayFrames({ type: 'history.day' }), []);
  assert.deepEqual(onThisDayFrames({}), []);
});

test('formatYear labels BC years', () => {
  assert.equal(formatYear(-44), '44 BC');
  assert.equal(formatYear(1969), '1969');
  assert.equal(formatDateLine(3, 15, -44), 'MAR 15, 44 BC');
});

test('pickEvent stays on the requested month/day and skips recent ids', () => {
  const pool = matchingEvents({}, { month: 8, day: 29 });
  assert.ok(pool.length > 2);
  const first = pickEvent({
    recentIds: pool.slice(1).map((row) => row.id),
  }, { month: 8, day: 29 });
  assert.equal(first.id, pool[0].id);
  assert.equal(first.month, 8);
  assert.equal(first.day, 29);
});

test('listEvents can filter by date and search year', () => {
  const page = listEvents({}, { month: 7, day: 4, page: 1, pageSize: 5 });
  assert.ok(page.total > 0);
  assert.ok(page.events.every((row) => row.month === 7 && row.day === 4));
  const yearHit = listEvents({}, { query: '1969', page: 1, pageSize: 5 });
  assert.ok(yearHit.total > 0);
});

test('year range filters shrink the matching pool', () => {
  const all = matchingEvents({}, { month: 1, day: 1 });
  const modern = matchingEvents({ minYear: 1900 }, { month: 1, day: 1 });
  assert.ok(modern.length < all.length);
  assert.ok(modern.every((row) => row.year >= 1900));
});

test('statusSnapshot without a query is a cheap count, not a full wrap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-this-day-'));
  const api = createOnThisDay({
    ROOT: dir,
    onThisDaySettingsPath: path.join(dir, 'settings.json'),
  }, console, {
    getLocaleSettings: () => ({ timeZone: 'UTC' }),
  });
  const cheap = api.statusSnapshot();
  assert.equal(cheap.events, undefined);
  assert.ok(Number(cheap.available) > 0);
  assert.equal(cheap.available, cheap.todayAvailable);
  const today = cheap.today;
  assert.equal(
    cheap.available,
    matchingEvents({}, { month: today.month, day: today.day }).length,
  );
});

test('createOnThisDay remembers recent picks and accepts custom facts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-this-day-'));
  const api = createOnThisDay({
    ROOT: dir,
    onThisDaySettingsPath: path.join(dir, 'settings.json'),
  }, console, {
    getLocaleSettings: () => ({ timeZone: 'UTC' }),
  });
  const payload = api.nextPayload({ month: 8, day: 29, asOf: '2026-08-29T12:00:00Z' });
  assert.ok(payload?.event?.id);
  assert.equal(api.getSettings().recentIds.includes(payload.event.id), true);

  const added = api.addEvent({
    month: 8,
    day: 29,
    year: 2099,
    text: 'Signal Bridge ships On This Day for the Vestaboard flaps.',
  });
  assert.equal(added.ok, true);
  assert.ok(added.customCount >= 1);

  const listed = api.statusSnapshot({ month: 8, day: 29, pageSize: 50 });
  assert.ok(listed.events.some((row) => row.custom && /Signal Bridge/.test(row.text)));

  const customId = listed.events.find((row) => row.custom).id;
  const removedCustom = api.updateEvent(customId, { remove: true });
  assert.equal(removedCustom.ok, true);
  assert.equal(api.getSettings().custom.some((row) => row.id === customId), false);

  const shippedId = payload.event.id;
  const removedShipped = api.updateEvent(shippedId, { remove: true });
  assert.equal(removedShipped.ok, true);
  assert.ok(api.getSettings().removedIds.includes(shippedId));
});

test('sanitiseSettings keeps year bounds and custom rows', () => {
  const cleaned = sanitiseSettings({
    minYear: '1800',
    maxYear: '1999',
    custom: [{ id: 'c1', month: 2, day: 29, year: -100, text: 'Leap day ancient note that is long enough.' }],
    hiddenIds: ['a', 'a', ''],
  });
  assert.equal(cleaned.minYear, 1800);
  assert.equal(cleaned.maxYear, 1999);
  assert.equal(cleaned.custom.length, 1);
  assert.equal(cleaned.custom[0].year, -100);
  assert.deepEqual(cleaned.hiddenIds, ['a']);
});
