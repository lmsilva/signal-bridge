const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesVivintAlarmQuery,
  parseAlarmStatusFromSpeech,
  buildVivintAlarmReading,
  buildAlarmLabel,
  hasAlarmStatusInSpeech,
} = require('../src/vivint-alarm');

test('matchesVivintAlarmQuery detects ask Vivint to arm', () => {
  assert.equal(matchesVivintAlarmQuery('ask Vivint to arm'), true);
  assert.equal(matchesVivintAlarmQuery('tell Vivint to disarm'), true);
  assert.equal(matchesVivintAlarmQuery('what is the weather'), false);
});

test('parseAlarmStatusFromSpeech reads armed stay response', () => {
  const parsed = parseAlarmStatusFromSpeech('your system has been armed stay', 'ask Vivint to arm');
  assert.equal(parsed?.status, 'armed');
  assert.equal(parsed?.mode, 'stay');
});

test('parseAlarmStatusFromSpeech reads disarmed response', () => {
  const parsed = parseAlarmStatusFromSpeech('your system has been disarmed', 'tell Vivint to disarm');
  assert.equal(parsed?.status, 'disarmed');
});

test('parseAlarmStatusFromSpeech reads arm mode from query when no speech yet', () => {
  const stay = parseAlarmStatusFromSpeech(null, 'ask vivint to arm stay');
  assert.equal(stay?.status, 'armed');
  assert.equal(stay?.mode, 'stay');

  const away = parseAlarmStatusFromSpeech(null, 'ask vivint to arm away');
  assert.equal(away?.status, 'armed');
  assert.equal(away?.mode, 'away');

  const plain = parseAlarmStatusFromSpeech(null, 'ask vivint to arm');
  assert.equal(plain?.status, 'armed');
  assert.equal(plain?.mode, null);
});

test('buildVivintAlarmReading builds armed label', () => {
  const reading = buildVivintAlarmReading('your system has been armed stay', 'ask Vivint to arm');
  assert.equal(reading.status, 'armed');
  assert.equal(reading.mode, 'stay');
  assert.equal(reading.label, 'Alarm System Armed — Stay');
  assert.equal(reading.provider, 'Vivint');
});

test('buildAlarmLabel covers away and disarmed', () => {
  assert.equal(buildAlarmLabel('armed', 'away'), 'Alarm System Armed — Away');
  assert.equal(buildAlarmLabel('disarmed', null), 'Alarm System Disarmed');
});

test('hasAlarmStatusInSpeech detects confirmation text', () => {
  assert.equal(hasAlarmStatusInSpeech('your system has been armed stay'), true);
  assert.equal(hasAlarmStatusInSpeech('okay'), false);
});
