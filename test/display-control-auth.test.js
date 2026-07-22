const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayControlAuth } = require('../src/display-control-auth');
const {
  buildDisplayAuthPinPayload,
  buildDisplayAuthOkPayload,
} = require('../src/udp-payload');

test('control auth challenge verify and session gate', () => {
  const auth = createDisplayControlAuth({
    udpBroadcast: { defaultDisplaySeconds: 30 },
    webServer: { controlAuth: { enabled: true, sessionMinutes: 10 } },
  }, { info() {} });

  const challenge = auth.startChallenge('disp-1');
  assert.equal(challenge.displayId, 'disp-1');
  assert.match(challenge.pin, /^\d{4}$/);
  assert.equal(auth.publicChallengeView(challenge).pin, undefined);

  const payload = buildDisplayAuthPinPayload({
    pin: challenge.pin,
    displaySeconds: challenge.displaySeconds,
  }, { udpBroadcast: { defaultDisplaySeconds: 30 } });
  assert.equal(payload.type, 'display.auth');
  assert.equal(payload.auth.pin, challenge.pin);

  const wrong = auth.verifyPin('disp-1', '0000');
  assert.match(wrong.error, /Incorrect PIN/);

  const ok = auth.verifyPin('disp-1', challenge.pin);
  assert.ok(ok.token);
  assert.equal(auth.assertAuthorized('disp-1', ok.token).ok, true);
  assert.equal(auth.assertAuthorized('disp-2', ok.token).ok, false);
  assert.equal(auth.assertAuthorized('*', ok.token).ok, false);
  assert.equal(auth.assertAuthorized('disp-1', 'bad').code, 'control_auth_required');
});

test('display auth ok payload flashes Authenticated briefly', () => {
  const payload = buildDisplayAuthOkPayload({ displaySeconds: 1 });
  assert.equal(payload.type, 'display.auth');
  assert.equal(payload.auth.status, 'ok');
  assert.equal(payload.auth.pin, undefined);
  assert.equal(payload.displaySeconds, 1);
});

test('control auth can be disabled', () => {
  const auth = createDisplayControlAuth({
    webServer: { controlAuth: { enabled: false } },
  });
  assert.equal(auth.assertAuthorized('disp-1', '').ok, true);
});
