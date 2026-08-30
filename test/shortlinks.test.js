const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createShortlinks,
  CREATE_URL,
  UPDATE_URL,
  urlsMatch,
  isAliasTakenError,
  aliasCandidates,
} = require('../src/shortlinks');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => '' },
  };
}

function redirectResponse(location, status = 301) {
  return {
    ok: false,
    status,
    text: async () => '',
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'location' ? location : '';
      },
    },
  };
}

function goneResponse() {
  return {
    ok: false,
    status: 404,
    text: async () => '',
    headers: { get: () => '' },
  };
}

function makeService(calls, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlinks-'));
  const config = {
    ROOT: root,
    web: { publicBaseUrl: 'https://signal.wittydigital.com' },
    tinyurlCredentialsPath: path.join(root, 'tinyurl-credentials.json'),
    shortlinksPath: path.join(root, 'shortlinks.json'),
    ...overrides.config,
  };
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    const handler = overrides.handler || defaultHandler;
    return handler({ method, url, body: opts.body ? JSON.parse(opts.body) : null, calls });
  };
  const service = createShortlinks(config, { warn() {} }, {
    fetchImpl,
    env: { TINYURL_API_TOKEN: overrides.token !== undefined ? overrides.token : 'test-token' },
    healthIntervalMs: 0,
    randomBytes: () => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    ...overrides.options,
  });
  return { service, root, config };
}

function defaultHandler({ method, url, body }) {
  if (method === 'POST' && url === CREATE_URL) {
    return jsonResponse(200, {
      data: {
        alias: body.alias,
        tiny_url: `https://tinyurl.com/${body.alias}`,
        url: body.url,
      },
      errors: [],
    });
  }
  if (method === 'PATCH' && url === UPDATE_URL) {
    return jsonResponse(200, {
      data: {
        alias: body.new_alias || body.alias,
        tiny_url: `https://tinyurl.com/${body.new_alias || body.alias}`,
        url: 'https://signal.wittydigital.com/guestbook/',
        archived: Boolean(body.archived),
      },
    });
  }
  if (method === 'HEAD' || method === 'GET') {
    return redirectResponse('https://signal.wittydigital.com/guestbook/');
  }
  return jsonResponse(500, { errors: ['unexpected'] });
}

test('urlsMatch ignores trailing slashes and host case', () => {
  assert.equal(
    urlsMatch('https://Signal.wittydigital.com/guestbook/', 'https://signal.wittydigital.com/guestbook'),
    true,
  );
  assert.equal(
    urlsMatch('https://signal.wittydigital.com/guestbook/', 'https://example.com/guestbook/'),
    false,
  );
});

test('alias-taken errors include TinyURL "not available" copy', () => {
  assert.equal(isAliasTakenError(400, { errors: ['Alias is not available'] }), true);
  assert.equal(isAliasTakenError(422, { errors: [] }), true);
  assert.equal(isAliasTakenError(401, { errors: ['Unauthorized'] }), false);
});

test('ensure creates both spellings and treats a taken twin as success', async () => {
  const calls = [];
  const { service } = makeService(calls, {
    handler({ method, url, body }) {
      if (method === 'POST' && url === CREATE_URL) {
        if (body.alias === 'wittyboard') {
          return jsonResponse(400, { errors: ['Alias is not available'] });
        }
        return defaultHandler({ method, url, body });
      }
      return defaultHandler({ method, url, body });
    },
  });
  const result = await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'wittyboard' });
  assert.equal(result.ok, true);
  assert.equal(result.alias, 'WITTYBOARD');
  assert.equal(result.twinTaken, true);
  assert.equal(result.createdBothSpellings, true);
  assert.equal(result.targetUrl, 'https://signal.wittydigital.com/guestbook/');
  const creates = calls.filter((c) => c.method === 'POST' && c.url === CREATE_URL);
  assert.deepEqual(creates.map((c) => c.body.alias), ['WITTYBOARD', 'wittyboard']);
  assert.equal(service.status('guestbook').flapLabel, 'TINYURL.COM/WITTYBOARD');
  service.stop();
});

test('health check matches Location without following redirects', async () => {
  const calls = [];
  const { service } = makeService(calls);
  await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  const healthy = await service.check('guestbook');
  assert.equal(healthy.health, 'healthy');
  assert.match(healthy.lastCheckDetail, /both spellings OK/);
  const heads = calls.filter((c) => c.method === 'HEAD');
  assert.equal(heads.length, 2);
  assert.equal(heads[0].url, 'https://tinyurl.com/WITTYBOARD');
  assert.equal(heads[1].url, 'https://tinyurl.com/wittyboard');
  service.stop();
});

test('destination change archives the old alias and creates a fresh link', async () => {
  const calls = [];
  const { service, config } = makeService(calls);
  await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  config.web.publicBaseUrl = 'https://other.wittydigital.com';
  const rebuilt = await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.targetUrl, 'https://other.wittydigital.com/guestbook/');
  const archive = calls.find((c) => c.method === 'PATCH' && c.body?.archived === true);
  assert.ok(archive);
  assert.equal(archive.body.alias, 'WITTYBOARD');
  service.stop();
});

test('repair climbs ALIAS then ALIAS1 then ALIAS2 then random8', async () => {
  const calls = [];
  let createCount = 0;
  const { service } = makeService(calls, {
    handler({ method, url, body }) {
      if (method === 'HEAD' || method === 'GET') {
        return redirectResponse('https://evil.example/phish');
      }
      if (method === 'POST' && url === CREATE_URL) {
        createCount += 1;
        if (body.alias === 'WITTYBOARD' || body.alias === 'WITTYBOARD1' || body.alias === 'WITTYBOARD2') {
          return jsonResponse(400, { errors: ['Alias is not available'] });
        }
        return defaultHandler({ method, url, body });
      }
      return defaultHandler({ method, url, body });
    },
  });
  await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  const repaired = await service.check('guestbook');
  assert.equal(repaired.alias, 'ABCDEFGH');
  assert.ok(repaired.alert?.message);
  assert.deepEqual(aliasCandidates('WITTYBOARD'), ['WITTYBOARD', 'WITTYBOARD1', 'WITTYBOARD2']);
  const aliases = calls
    .filter((c) => c.method === 'POST' && c.url === CREATE_URL)
    .map((c) => c.body.alias);
  assert.ok(aliases.includes('WITTYBOARD1'));
  assert.ok(aliases.includes('WITTYBOARD2'));
  assert.ok(aliases.includes('ABCDEFGH'));
  assert.ok(createCount >= 4);
  service.stop();
});

test('ensure refuses a LAN short-link target', async () => {
  const calls = [];
  const { service } = makeService(calls, {
    config: { web: { publicBaseUrl: 'https://192.168.1.10:47810' } },
  });
  const result = await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  assert.equal(result.ok, false);
  assert.match(result.error, /public https host/);
  assert.equal(calls.length, 0);
  service.stop();
});

test('missing token does not call the API', async () => {
  const calls = [];
  const { service } = makeService(calls, { token: '' });
  const result = await service.ensure('guestbook', '/guestbook/', { preferredAlias: 'WITTYBOARD' });
  assert.equal(result.ok, false);
  assert.match(result.error, /token/i);
  assert.equal(calls.length, 0);
  service.stop();
});
