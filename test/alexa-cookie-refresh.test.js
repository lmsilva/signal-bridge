const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlexaCookieRefresh, addCookies } = require('../src/vendor/alexa-cookie-refresh');

function buildFormerRegistrationData() {
  return {
    loginCookie: 'frc=frc-value; map-md=map-md-value; session-id=old-session',
    refreshToken: 'Atnr|refresh-token-value',
    macDms: { device_private_key: 'key', adp_token: 'adp' },
    deviceSerial: 'abcdef0123456789',
    amazonPage: 'amazon.com',
    csrf: 'old-csrf',
    tokenDate: Date.now() - 30 * 60 * 60 * 1000,
    dataVersion: 2,
  };
}

function createMockAmazon({ failRegister = true } = {}) {
  const calls = [];

  function requestFn(options, callback) {
    calls.push({ host: options.host, path: options.path, method: options.method });

    if (options.path === '/auth/token') {
      callback(null, { statusCode: 200, headers: {} }, JSON.stringify({
        access_token: 'Atna|new-access-token',
        token_type: 'bearer',
        expires_in: 3600,
      }));
      return;
    }

    if (options.path === '/ap/exchangetoken/cookies') {
      const domain = /domain=([^&]+)/.exec(options.body || '');
      const amazonDomain = domain ? decodeURIComponent(domain[1]).replace(/^\./, '') : 'amazon.com';
      callback(null, { statusCode: 200, headers: {} }, JSON.stringify({
        response: {
          tokens: {
            cookies: {
              [`.${amazonDomain}`]: [
                { Name: 'at-main', Value: 'new-at-main' },
                { Name: 'sess-at-main', Value: 'new-sess-at' },
                { Name: 'ubid-main', Value: 'new-ubid' },
              ],
            },
          },
        },
      }));
      return;
    }

    if (options.path === '/v1/devices/@self/capabilities') {
      callback(null, { statusCode: 204, headers: {} }, '');
      return;
    }

    if (options.path === '/auth/register') {
      if (failRegister) {
        callback(null, { statusCode: 400, headers: {} }, JSON.stringify({
          response: { error: { code: 'InvalidToken', message: 'Auth time of the token is expired.' } },
        }));
        return;
      }
    }

    // CSRF probe endpoints
    callback(null, {
      statusCode: 200,
      headers: { 'set-cookie': ['csrf=new-csrf-token; Path=/; Domain=.amazon.com'] },
    }, '{}');
  }

  return { requestFn, calls };
}

test('patched refresh rotates tokenDate without calling /auth/register', async () => {
  const mock = createMockAmazon();
  const refresher = createAlexaCookieRefresh({ requestFn: mock.requestFn });
  const formerRegistrationData = buildFormerRegistrationData();
  const beforeTokenDate = formerRegistrationData.tokenDate;

  const result = await new Promise((resolve, reject) => {
    refresher.refreshAlexaCookie({
      formerRegistrationData,
      amazonPage: 'amazon.com',
      baseAmazonPage: 'amazon.com',
      acceptLanguage: 'en-US',
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  const registerCalls = mock.calls.filter((c) => c.path === '/auth/register');
  assert.equal(registerCalls.length, 0, 'refresh must not call /auth/register');

  assert.ok(result.tokenDate > beforeTokenDate, 'tokenDate must advance');
  assert.equal(result.refreshToken, 'Atnr|refresh-token-value', 'refreshToken preserved');
  assert.deepEqual(result.macDms, formerRegistrationData.macDms, 'macDms preserved');
  assert.equal(result.csrf, 'new-csrf-token', 'fresh csrf extracted');
  assert.match(result.localCookie, /at-main=new-at-main/, 'fresh marketplace cookies present');
  assert.equal(result.dataVersion, 2);
});

test('patched refresh registers capabilities with the new access token', async () => {
  const mock = createMockAmazon();
  const refresher = createAlexaCookieRefresh({ requestFn: mock.requestFn });

  await new Promise((resolve, reject) => {
    refresher.refreshAlexaCookie({
      formerRegistrationData: buildFormerRegistrationData(),
      amazonPage: 'amazon.com',
      baseAmazonPage: 'amazon.com',
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  const capabilityCalls = mock.calls.filter((c) => c.path === '/v1/devices/@self/capabilities');
  assert.equal(capabilityCalls.length, 1, 'capabilities registered once during refresh');

  const tokenCalls = mock.calls.filter((c) => c.path === '/auth/token');
  assert.equal(tokenCalls.length, 1, 'refresh token exchanged once');
});

test('patched refresh restores frc and map-md cookies for future refreshes', async () => {
  const mock = createMockAmazon();
  const refresher = createAlexaCookieRefresh({ requestFn: mock.requestFn });

  const result = await new Promise((resolve, reject) => {
    refresher.refreshAlexaCookie({
      formerRegistrationData: buildFormerRegistrationData(),
      amazonPage: 'amazon.com',
      baseAmazonPage: 'amazon.com',
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });

  assert.match(result.loginCookie, /frc=frc-value/, 'frc cookie preserved');
  assert.match(result.loginCookie, /map-md=map-md-value/, 'map-md cookie preserved');
});

test('patched refresh fails clearly without former registration data', async () => {
  const refresher = createAlexaCookieRefresh({ requestFn: () => {} });

  const error = await new Promise((resolve) => {
    refresher.refreshAlexaCookie({}, (err) => resolve(err));
  });

  assert.match(error.message, /No former registration data/);
});

test('patched refresh surfaces missing access token from Amazon', async () => {
  const refresher = createAlexaCookieRefresh({
    requestFn: (options, callback) => {
      callback(null, { statusCode: 400, headers: {} }, JSON.stringify({ error: 'invalid_grant' }));
    },
  });

  const error = await new Promise((resolve) => {
    refresher.refreshAlexaCookie({
      formerRegistrationData: buildFormerRegistrationData(),
      amazonPage: 'amazon.com',
      baseAmazonPage: 'amazon.com',
    }, (err) => resolve(err));
  });

  assert.match(error.message, /No new access token/);
});

test('addCookies merges set-cookie headers', () => {
  const merged = addCookies('a=1; b=2', {
    'set-cookie': ['b=3; Path=/', 'c=4; Path=/'],
  });
  assert.match(merged, /a=1/);
  assert.match(merged, /b=3/);
  assert.match(merged, /c=4/);
});

test('installRefreshPatch replaces refreshAlexaCookie on the alexa-cookie2 singleton', () => {
  const { installRefreshPatch } = require('../src/auth-refresh-patch');
  const alexaCookie = require('alexa-cookie2');
  const original = alexaCookie.refreshAlexaCookie;

  try {
    const patched = installRefreshPatch();
    assert.equal(patched.__bridgeRefreshPatched, true);
    assert.notEqual(patched.refreshAlexaCookie, original, 'refresh function replaced');

    // Second install is a noop
    const again = installRefreshPatch();
    assert.equal(again.refreshAlexaCookie, patched.refreshAlexaCookie);
  } finally {
    alexaCookie.refreshAlexaCookie = original;
    delete alexaCookie.__bridgeRefreshPatched;
  }
});
