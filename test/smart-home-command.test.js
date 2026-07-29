const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmartHomeCommand, resolveDeviceType, keywordDeviceType, isGenericTarget } = require('../src/smart-home-command');

test('parseSmartHomeCommand detects turn on/off commands', () => {
  assert.deepEqual(parseSmartHomeCommand('turn movie theater pc on'), {
    action: 'on',
    target: 'movie theater pc',
  });
  assert.deepEqual(parseSmartHomeCommand('alexa, lights on'), {
    action: 'on',
    target: 'lights',
  });
  assert.deepEqual(parseSmartHomeCommand('switch bedroom lamp off'), {
    action: 'off',
    target: 'bedroom lamp',
  });
});

test('parseSmartHomeCommand dedupes comma-joined ASR echoes', () => {
  // Wake+repeat: bare matcher used to swallow "lights off, lights" as target.
  assert.deepEqual(parseSmartHomeCommand('lights off, lights off'), {
    action: 'off',
    target: 'lights',
  });
  assert.deepEqual(parseSmartHomeCommand('alexa lights off, lights off'), {
    action: 'off',
    target: 'lights',
  });
  assert.deepEqual(parseSmartHomeCommand('lights off, lights'), {
    action: 'off',
    target: 'lights',
  });
  assert.deepEqual(parseSmartHomeCommand('office lights on, lights'), {
    action: 'on',
    target: 'office lights',
  });
  assert.deepEqual(parseSmartHomeCommand('bedroom lamp off, lamp'), {
    action: 'off',
    target: 'bedroom lamp',
  });
});

test('dedupeCommaJoinedSmartHomeAsr prefers shortest command-like clause', () => {
  const { dedupeCommaJoinedSmartHomeAsr } = require('../src/smart-home-command');
  assert.equal(dedupeCommaJoinedSmartHomeAsr('lights off, lights off'), 'lights off');
  assert.equal(dedupeCommaJoinedSmartHomeAsr('lights off, lights'), 'lights off');
  assert.equal(dedupeCommaJoinedSmartHomeAsr('turn bedroom lamp off, lamp'), 'turn bedroom lamp off');
  assert.equal(dedupeCommaJoinedSmartHomeAsr('lights off'), 'lights off');
});

test('keywordDeviceType classifies common targets', () => {
  assert.equal(keywordDeviceType('bedroom lights'), 'light');
  assert.equal(keywordDeviceType('movie theater pc'), 'pc');
  assert.equal(keywordDeviceType('kitchen plug'), 'plug');
});

test('isGenericTarget treats lights as generic', () => {
  assert.equal(isGenericTarget('lights'), true);
  assert.equal(isGenericTarget('office lights'), true);
  assert.equal(isGenericTarget('movie theater pc'), false);
});

test('resolveDeviceType avoids fuzzy match for generic lights', () => {
  const endpoints = [{
    friendlyName: 'Middle Backyard Floodlights',
    category: 'LIGHT',
  }, {
    friendlyName: 'Office Lamp',
    category: 'LIGHT',
  }];
  const resolved = resolveDeviceType(endpoints, 'lights');
  assert.equal(resolved.deviceType, 'light');
  assert.equal(resolved.matchedName, null);
});

test('resolveDeviceType matches specific device names', () => {
  const endpoints = [{
    friendlyName: 'Movie Theater PC',
    category: 'SMARTPLUG',
  }];
  const resolved = resolveDeviceType(endpoints, 'movie theater pc');
  assert.equal(resolved.deviceType, 'plug');
  assert.equal(resolved.matchedName, 'Movie Theater PC');
});
