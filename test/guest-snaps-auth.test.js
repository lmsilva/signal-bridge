const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuestSnapsAuth, DEFAULT_PIN_DIGITS } = require('../src/guest-snaps-auth');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tempConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-pin-'));
  return {
    ROOT: dataDir,
    guestSnapsPinPath: path.join(dataDir, 'guest-snaps-pin.json'),
    guestSnapsAuth: {
      pinDigits: 6,
      pinTtlMs: 24 * 60 * 60 * 1000,
      ...(overrides.guestSnapsAuth || {}),
    },
    ...overrides,
  };
}

test('ensureCurrentPin creates a persisted 6-digit PIN', () => {
  const auth = createGuestSnapsAuth(tempConfig(), silentLog);
  assert.equal(auth.pinDigits, DEFAULT_PIN_DIGITS);
  const record = auth.ensureCurrentPin();
  assert.match(record.pin, /^\d{6}$/);
  assert.ok(record.expiresAt > Date.now());
  assert.ok(fs.existsSync(auth.pinPath));
  const again = auth.ensureCurrentPin();
  assert.equal(again.pin, record.pin);
  assert.equal(again.generation, record.generation);
});

test('getPublicPinInfo never includes the PIN', () => {
  const auth = createGuestSnapsAuth(tempConfig(), silentLog);
  auth.ensureCurrentPin();
  const info = auth.getPublicPinInfo();
  assert.equal(info.pin, undefined);
  assert.equal(info.configured, true);
  assert.equal(info.pinDigits, 6);
  assert.ok(info.expiresAt);
});

test('login accepts the current PIN and rejects a wrong one', () => {
  const auth = createGuestSnapsAuth(tempConfig(), silentLog);
  const pin = auth.ensureCurrentPin().pin;
  const req = { headers: {}, socket: { remoteAddress: '10.1.1.1' } };

  const bad = auth.login('000000', req);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_pin');

  const good = auth.login(pin, req);
  assert.equal(good.ok, true);
  assert.match(good.setCookie, /signal_guest=/);
  const sessionReq = { headers: { cookie: `signal_guest=${good.token}` } };
  assert.equal(auth.assertAuthorized(sessionReq).ok, true);
});

test('progressive lockout engages after repeated bad PINs', () => {
  const auth = createGuestSnapsAuth(tempConfig(), silentLog);
  auth.ensureCurrentPin();
  const req = { headers: {}, socket: { remoteAddress: '10.2.2.2' } };

  assert.equal(auth.login('111111', req).status, 401);
  assert.equal(auth.login('222222', req).status, 401);
  const third = auth.login('333333', req);
  assert.equal(third.status, 429);
  assert.equal(third.code, 'rate_limited');
  assert.equal(third.retryAfterSec, 5);

  const whileLocked = auth.login(auth.ensureCurrentPin().pin, req);
  assert.equal(whileLocked.status, 429);
});

test('session dies when the PIN rotates', () => {
  const auth = createGuestSnapsAuth(tempConfig({
    guestSnapsAuth: { pinTtlMs: 60_000 },
  }), silentLog);
  const first = auth.ensureCurrentPin();
  const req = { headers: {}, socket: {} };
  const good = auth.login(first.pin, req);
  const sessionReq = { headers: { cookie: `signal_guest=${good.token}` } };
  assert.equal(auth.assertAuthorized(sessionReq).ok, true);

  // Persist an expired PIN so ensureCurrentPin rotates.
  auth._setCurrentForTest({
    pin: first.pin,
    issuedAt: Date.now() - 120_000,
    expiresAt: Date.now() - 1000,
    generation: first.generation,
  });
  const next = auth.ensureCurrentPin();
  assert.notEqual(next.generation, first.generation);
  assert.equal(auth.assertAuthorized(sessionReq).ok, false);
});

test('beginRequestPin returns display pin for UDP but public fields omit it', () => {
  const auth = createGuestSnapsAuth(tempConfig(), silentLog);
  const result = auth.beginRequestPin({ headers: {}, socket: { remoteAddress: '10.3.3.3' } });
  assert.equal(result.ok, true);
  assert.match(result.display.accessPin, /^\d{6}$/);
  assert.equal(result.pin, undefined);
  // Shape that web-server should return to the phone:
  const phoneJson = {
    ok: true,
    expiresAt: result.expiresAt,
    pinDigits: result.pinDigits,
  };
  assert.equal(phoneJson.pin, undefined);
  assert.equal(phoneJson.display, undefined);
});
