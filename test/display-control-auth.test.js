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
  assert.equal(auth.pinDigits, 6);
  assert.match(challenge.pin, /^\d{6}$/);
  assert.equal(auth.publicChallengeView(challenge).pin, undefined);
  assert.equal(auth.getStatus('disp-1', '').pinDigits, 6);

  const payload = buildDisplayAuthPinPayload({
    pin: challenge.pin,
    displaySeconds: challenge.displaySeconds,
  }, { udpBroadcast: { defaultDisplaySeconds: 30 } });
  assert.equal(payload.type, 'display.auth');
  assert.equal(payload.auth.pin, challenge.pin);

  const wrong = auth.verifyPin('disp-1', '000000');
  assert.match(wrong.error, /Incorrect PIN/);

  const ok = auth.verifyPin('disp-1', challenge.pin);
  assert.ok(ok.token);
  assert.equal(auth.assertAuthorized('disp-1', ok.token).ok, true);
  assert.equal(auth.assertAuthorized('disp-2', ok.token).ok, false);
  assert.equal(auth.assertAuthorized('*', ok.token).ok, false);
  assert.equal(auth.assertAuthorized('disp-1', 'bad').code, 'control_auth_required');
});

test('control auth pinDigits config override still pads to requested length', () => {
  const auth = createDisplayControlAuth({
    webServer: { controlAuth: { enabled: true, pinDigits: 4 } },
  }, { info() {} });
  assert.equal(auth.pinDigits, 4);
  assert.match(auth.startChallenge('disp-4').pin, /^\d{4}$/);
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
