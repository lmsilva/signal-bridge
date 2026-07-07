const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesShowAlarmsQuery,
  matchesAlarmSetQuery,
  matchesAlarmCancelQuery,
} = require('../src/alexa-alarms');

test('matchesShowAlarmsQuery detects show my alarms', () => {
  assert.equal(matchesShowAlarmsQuery('show my alarms'), true);
  assert.equal(matchesShowAlarmsQuery('list all alarms'), true);
  assert.equal(matchesShowAlarmsQuery('show my timers'), false);
});

test('matchesAlarmSetQuery detects set alarm for date or time', () => {
  assert.equal(matchesAlarmSetQuery('set alarm for 7 am tomorrow'), true);
  assert.equal(matchesAlarmSetQuery('set an alarm for 6:30 pm'), true);
  assert.equal(matchesAlarmSetQuery('set a 5 minute timer'), false);
  assert.equal(matchesAlarmSetQuery('set a 5 minute alarm'), false);
});

test('matchesAlarmSetQuery ignores Vivint security commands', () => {
  assert.equal(matchesAlarmSetQuery('ask Vivint to arm'), false);
  assert.equal(matchesShowAlarmsQuery('ask Vivint to arm'), false);
});

test('matchesAlarmCancelQuery detects cancel alarm phrasing', () => {
  assert.equal(matchesAlarmCancelQuery('cancel my alarm'), true);
  assert.equal(matchesAlarmCancelQuery('cancel all timers'), false);
});
