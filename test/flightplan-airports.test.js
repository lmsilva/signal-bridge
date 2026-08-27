const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  searchAirports,
  resolveAirportCode,
  findAirport,
  _resetAirportCacheForTest,
} = require('../src/flightplan-airports');

const config = { ROOT: path.resolve(__dirname, '..') };

test('searchAirports finds LAX for la alias without matching Salt Lake', () => {
  _resetAirportCacheForTest();
  const matches = searchAirports('la', { config, limit: 5 });
  assert.ok(matches.some((row) => row.iata === 'LAX'));
  assert.equal(matches.some((row) => row.iata === 'SLC'), false);
});

test('searchAirports finds Denver by city name', () => {
  _resetAirportCacheForTest();
  const matches = searchAirports('denver', { config, limit: 5 });
  assert.ok(matches.some((row) => row.iata === 'DEN'));
});

test('resolveAirportCode maps city names to IATA', () => {
  _resetAirportCacheForTest();
  assert.equal(resolveAirportCode('denver', config), 'DEN');
  assert.equal(resolveAirportCode('Los Angeles', config), 'LAX');
  assert.equal(findAirport('SLC', config)?.iata, 'SLC');
});
