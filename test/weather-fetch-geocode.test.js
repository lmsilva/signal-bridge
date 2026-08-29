const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGeocodeQuery,
  pickGeocodeHit,
  geocodeLocation,
} = require('../src/weather-fetch');

test('parseGeocodeQuery strips trailing US state names and abbreviations', () => {
  assert.deepEqual(parseGeocodeQuery('Las Vegas Nevada'), {
    city: 'Las Vegas',
    admin1: 'Nevada',
  });
  assert.deepEqual(parseGeocodeQuery('Las Vegas, NV'), {
    city: 'Las Vegas',
    admin1: 'Nevada',
  });
  assert.deepEqual(parseGeocodeQuery('Saratoga Springs Utah'), {
    city: 'Saratoga Springs',
    admin1: 'Utah',
  });
  assert.deepEqual(parseGeocodeQuery('Moab, Utah'), {
    city: 'Moab',
    admin1: 'Utah',
  });
  assert.deepEqual(parseGeocodeQuery('Buffalo New York'), {
    city: 'Buffalo',
    admin1: 'New York',
  });
});

test('parseGeocodeQuery treats bare state-named cities as city+admin1', () => {
  assert.deepEqual(parseGeocodeQuery('New York'), {
    city: 'New York',
    admin1: 'New York',
  });
});

test('parseGeocodeQuery leaves plain city names alone', () => {
  assert.deepEqual(parseGeocodeQuery('Moab'), {
    city: 'Moab',
    admin1: null,
  });
});

test('pickGeocodeHit prefers matching admin1 over the first result', () => {
  const results = [
    { name: 'Saratoga Springs', admin1: 'New York', country_code: 'US', latitude: 1, longitude: 2 },
    { name: 'Saratoga Springs', admin1: 'Utah', country_code: 'US', latitude: 40.35, longitude: -111.9 },
  ];
  const hit = pickGeocodeHit(results, 'Utah');
  assert.equal(hit.admin1, 'Utah');
  assert.equal(hit.latitude, 40.35);
});

test('pickGeocodeHit falls back to first US hit then first hit', () => {
  const mixed = [
    { name: 'Paris', admin1: 'Île-de-France', country_code: 'FR', latitude: 1, longitude: 2 },
    { name: 'Paris', admin1: 'Texas', country_code: 'US', latitude: 3, longitude: 4 },
  ];
  assert.equal(pickGeocodeHit(mixed, null).country_code, 'US');
  assert.equal(pickGeocodeHit(mixed.slice(0, 1), null).country_code, 'FR');
});

test('geocodeLocation refuses privacy placeholder names', async () => {
  assert.equal(await geocodeLocation('Home'), null);
  assert.equal(await geocodeLocation('here'), null);
  assert.equal(await geocodeLocation('local'), null);
});

test('geocodeLocation searches city-only and selects admin1 match', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    assert.match(String(url), /name=Saratoga%20Springs/);
    assert.match(String(url), /count=10/);
    return {
      ok: true,
      async json() {
        return {
          results: [
            {
              name: 'Saratoga Springs',
              admin1: 'New York',
              country_code: 'US',
              latitude: 43.08,
              longitude: -73.78,
              timezone: 'America/New_York',
            },
            {
              name: 'Saratoga Springs',
              admin1: 'Utah',
              country_code: 'US',
              latitude: 40.35,
              longitude: -111.9,
              timezone: 'America/Denver',
            },
          ],
        };
      },
    };
  };
  try {
    const result = await geocodeLocation('Saratoga Springs Utah');
    assert.equal(result.latitude, 40.35);
    assert.match(result.resolvedName, /Utah/);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('geocodeLocation resolves Las Vegas Nevada via city+state parse', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /name=Las%20Vegas/);
    return {
      ok: true,
      async json() {
        return {
          results: [
            {
              name: 'Las Vegas',
              admin1: 'Nevada',
              country_code: 'US',
              latitude: 36.17,
              longitude: -115.14,
              timezone: 'America/Los_Angeles',
            },
          ],
        };
      },
    };
  };
  try {
    const result = await geocodeLocation('Las Vegas Nevada');
    assert.equal(result.latitude, 36.17);
    assert.match(result.resolvedName, /Nevada/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('geocodeLocation rejects wrong admin1 then finds match on next lookup', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text.includes('countryCode=US')) {
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                name: 'Saratoga Springs',
                admin1: 'New York',
                country_code: 'US',
                latitude: 43.08,
                longitude: -73.78,
                timezone: 'America/New_York',
              },
            ],
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          results: [
            {
              name: 'Saratoga Springs',
              admin1: 'New York',
              country_code: 'US',
              latitude: 43.08,
              longitude: -73.78,
              timezone: 'America/New_York',
            },
            {
              name: 'Saratoga Springs',
              admin1: 'Utah',
              country_code: 'US',
              latitude: 40.35,
              longitude: -111.9,
              timezone: 'America/Denver',
            },
          ],
        };
      },
    };
  };
  try {
    const result = await geocodeLocation('Saratoga Springs Utah', { maxLookups: 2 });
    assert.equal(result.latitude, 40.35);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('geocodeLocation respects maxLookups', async () => {
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, async json() { return { results: [] }; } };
  };
  try {
    assert.equal(await geocodeLocation('Nowhereville', { maxLookups: 1 }), null);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('geocode and forecast fetch timeouts stay tight for voice overlays', () => {
  const {
    GEOCODE_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
  } = require('../src/weather-fetch');
  assert.equal(GEOCODE_FETCH_TIMEOUT_MS, 6000);
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 8000);
});

test('geocodePostalCode resolves a US ZIP via Zippopotam', async () => {
  const { geocodePostalCode } = require('../src/weather-fetch');
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /zippopotam\.us\/us\/84043/);
    return {
      ok: true,
      async json() {
        return {
          places: [{
            'place name': 'Lehi',
            'state abbreviation': 'UT',
            latitude: '40.4131',
            longitude: '-111.8553',
          }],
        };
      },
    };
  };
  try {
    const hit = await geocodePostalCode('84043-1234');
    assert.equal(hit.city, 'Lehi');
    assert.equal(hit.region, 'UT');
    assert.equal(hit.postalCode, '84043');
    assert.equal(hit.latitude, 40.4131);
    assert.equal(hit.resolvedName, 'Lehi, UT');
  } finally {
    global.fetch = originalFetch;
  }
});

test('geocodePostalCode falls back to Open-Meteo when Zippopotam fails', async () => {
  const { geocodePostalCode } = require('../src/weather-fetch');
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const text = String(url);
    if (text.includes('zippopotam')) {
      return { ok: false, status: 404, async json() { return {}; } };
    }
    return {
      ok: true,
      async json() {
        return {
          results: [{
            name: 'Lehi',
            admin1: 'Utah',
            country_code: 'US',
            latitude: 40.39,
            longitude: -111.85,
            timezone: 'America/Denver',
          }],
        };
      },
    };
  };
  try {
    const hit = await geocodePostalCode('84043');
    assert.equal(hit.latitude, 40.39);
    assert.equal(hit.postalCode, '84043');
  } finally {
    global.fetch = originalFetch;
  }
});

test('lookupTimeZone reads the IANA zone from Open-Meteo auto', async () => {
  const { lookupTimeZone } = require('../src/weather-fetch');
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /timezone=auto/);
    return {
      ok: true,
      async json() {
        return { timezone: 'America/Denver' };
      },
    };
  };
  try {
    assert.equal(await lookupTimeZone(40.41, -111.85), 'America/Denver');
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveHouseLocale prefers ZIP coordinates and a city label', async () => {
  const { resolveHouseLocale } = require('../src/weather-fetch');
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const text = String(url);
    if (text.includes('zippopotam.us/us/84043')) {
      return {
        ok: true,
        async json() {
          return {
            places: [{
              'place name': 'Lehi',
              'state abbreviation': 'UT',
              latitude: '40.4131',
              longitude: '-111.8553',
            }],
          };
        },
      };
    }
    if (text.includes('geocoding-api.open-meteo.com')) {
      return {
        ok: true,
        async json() {
          return {
            results: [{
              name: 'Lehi',
              admin1: 'Utah',
              country_code: 'US',
              latitude: 40.39,
              longitude: -111.85,
              timezone: 'America/Denver',
            }],
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { timezone: 'America/Denver' };
      },
    };
  };
  try {
    const hit = await resolveHouseLocale({ city: 'Lehi, UT', postalCode: '84043' });
    assert.equal(hit.latitude, 40.4131, 'ZIP wins the pin');
    assert.equal(hit.postalCode, '84043');
    assert.match(hit.label, /Lehi/);
    assert.equal(hit.timeZone, 'America/Denver');
  } finally {
    global.fetch = originalFetch;
  }
});

