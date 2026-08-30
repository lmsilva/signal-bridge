const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TYPE,
  buildRingDoorbellPayload,
  ringDoorbellRows,
  cameraAllowed,
  createRingDoorbellService,
} = require('../src/ring-doorbell');
const { createRingSettings, DEFAULT_SETTINGS, sanitiseSettings } = require('../src/ring-settings');
const {
  saveRingRefreshToken,
  resolveRingRefreshToken,
  credentialsStatus,
  clearRingRefreshToken,
} = require('../src/ring-credentials');
const { ringDoorbellFrames } = require('../src/vestaboard/formatters/signal');
const { CHAR_BY_CODE, CHIPS } = require('../src/vestaboard/encoder');

function rowText(row) {
  return row.map((code) => {
    if (code === 0) return ' ';
    if (code === CHIPS.red) return 'r';
    if (code === CHIPS.yellow) return 'y';
    return CHAR_BY_CODE.get(code) || '#';
  }).join('');
}

test('default Ring settings keep the doorbell copy', () => {
  assert.equal(DEFAULT_SETTINGS.title, 'Ring Door Bell');
  assert.equal(DEFAULT_SETTINGS.message, 'Someone is at your front door');
  assert.equal(DEFAULT_SETTINGS.pushOnDing, true);
  assert.equal(DEFAULT_SETTINGS.pushOnMotion, false);
  assert.equal(DEFAULT_SETTINGS.showTime, true);
});

test('sanitiseSettings clamps title and message', () => {
  const next = sanitiseSettings({
    title: 'X'.repeat(40),
    message: 'Y'.repeat(200),
    cameraIds: ['a', 'a', 'b'],
  });
  assert.equal(next.title.length, 18);
  assert.equal(next.message.length, 80);
  assert.deepEqual(next.cameraIds, ['a', 'b']);
});

test('ringDoorbellRows paints a red frame with a yellow bell and title', () => {
  const rows = ringDoorbellRows({ showTime: false });
  assert.equal(rows.length, 6);
  assert.equal(rows[0].every((code) => code === CHIPS.red), true);
  assert.equal(rows[5].every((code) => code === CHIPS.red), true);
  const joined = rows.map(rowText).join('\n');
  assert.match(joined, /RING DOOR BELL/);
  assert.match(joined, /SOMEONE IS AT YOUR/);
  assert.match(joined, /FRONT DOOR/);
  assert.ok(joined.includes('y'), 'yellow bell chips');
});

test('a short message keeps the two-row bell motif', () => {
  const rows = ringDoorbellRows({ title: 'Ring Door Bell', message: 'Ding', showTime: false });
  assert.match(rowText(rows[3]), /RING DOOR BELL/);
  assert.match(rowText(rows[4]), /DING/);
  assert.ok(rows[1].includes(CHIPS.yellow));
  assert.ok(rows[2].includes(CHIPS.yellow));
});

test('showTime adds a clock row and keeps a compact bell', () => {
  const when = new Date('2026-08-30T16:42:00-06:00');
  const rows = ringDoorbellRows({
    title: 'Ring Door Bell',
    message: 'Ding',
    showTime: true,
    asOf: when,
    timeZone: 'America/Denver',
  });
  const joined = rows.map(rowText).join('\n');
  assert.match(joined, /RING DOOR BELL/);
  assert.match(joined, /DING/);
  assert.match(joined, /4:42PM/);
  assert.ok(rows[1].includes(CHIPS.yellow));
});

test('showTime with a long message drops the bell so the clock still fits', () => {
  const when = new Date('2026-08-30T09:05:00-06:00');
  const rows = ringDoorbellRows({
    showTime: true,
    asOf: when,
    timeZone: 'America/Denver',
  });
  const joined = rows.map(rowText).join('\n');
  assert.match(joined, /RING DOOR BELL/);
  assert.match(joined, /SOMEONE IS AT YOUR/);
  assert.match(joined, /FRONT DOOR/);
  assert.match(joined, /9:05AM/);
  assert.equal(joined.includes('y'), false);
});

test('buildRingDoorbellPayload feeds the alert formatter', () => {
  const payload = buildRingDoorbellPayload({
    title: 'Front Gate',
    message: 'Visitor waiting',
    showTime: false,
  });
  assert.equal(payload.type, TYPE);
  assert.equal(payload.showTime, false);
  const frames = ringDoorbellFrames(payload);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].priority, 'alert');
  assert.equal(frames[0].source, 'ring.doorbell');
  assert.match(rowText(frames[0].rows[3]), /FRONT GATE/);
});

test('cameraAllowed honours an empty allow-list as all cameras', () => {
  assert.equal(cameraAllowed('1', { cameraIds: [] }), true);
  assert.equal(cameraAllowed('1', { cameraIds: ['2'] }), false);
  assert.equal(cameraAllowed('2', { cameraIds: ['2'] }), true);
});

test('credentials prefer RING_REFRESH_TOKEN from the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-creds-'));
  const credentialsPath = path.join(dir, 'ring-credentials.json');
  saveRingRefreshToken(credentialsPath, 'session-token-abcdef');
  const resolved = resolveRingRefreshToken({
    credentialsPath,
    env: { RING_REFRESH_TOKEN: 'env-token-zzzz' },
  });
  assert.equal(resolved.tokenSource, 'env');
  assert.equal(resolved.refreshToken, 'env-token-zzzz');
  const status = credentialsStatus(credentialsPath, { env: { RING_REFRESH_TOKEN: 'env-token-zzzz' } });
  assert.equal(status.envBlocksOverwrite, true);
  clearRingRefreshToken(credentialsPath);
});

test('email login can complete with a 2FA code from the web flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-login-'));
  let authCalls = 0;
  class FakeRestClient {
    constructor() {
      this.using2fa = false;
      this.promptFor2fa = '';
      this.refreshToken = '';
    }
    async getCurrentAuth() {
      this.using2fa = true;
      this.promptFor2fa = 'Please enter the code sent to your text/email';
      throw new Error('Your Ring account is configured to use 2-factor authentication (2fa).');
    }
    async getAuth(code) {
      authCalls += 1;
      assert.equal(code, '123456');
      this.refreshToken = 'wrapped-refresh-token-abcdef';
      return { refresh_token: this.refreshToken };
    }
  }
  class FakeRingApi {
    constructor() {
      this.onRefreshTokenUpdated = { subscribe() { return { unsubscribe() {} }; } };
    }
    async getCameras() { return []; }
    disconnect() {}
  }

  const service = createRingDoorbellService({
    config: {
      ROOT: dir,
      ringCredentialsPath: path.join(dir, 'ring-credentials.json'),
      ringSettingsPath: path.join(dir, 'ring-settings.json'),
    },
    RingApi: FakeRingApi,
    RingRestClient: FakeRestClient,
    sendUdpPayload() {},
  });

  const first = await service.loginWithPassword({ email: 'a@b.com', password: 'secret' });
  assert.equal(first.needs2fa, true);
  assert.match(first.prompt, /code/i);
  assert.equal(service.statusSnapshot().pending2fa, true);

  const done = await service.verify2fa({ code: '123456' });
  assert.equal(done.needs2fa, false);
  assert.equal(done.listening, true);
  assert.equal(authCalls, 1);
  assert.equal(service.statusSnapshot().configured, true);
  service.stop();
});

test('service emits a ding to Vestaboard when listening settings allow it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-svc-'));
  const sent = [];
  const dingHandlers = [];
  const fakeCamera = {
    id: 'cam-1',
    name: 'Front Door',
    isDoorbot: true,
    onDoorbellPressed: {
      subscribe(fn) {
        dingHandlers.push(fn);
        return { unsubscribe() {} };
      },
    },
    onMotionDetected: {
      subscribe() {
        return { unsubscribe() {} };
      },
    },
  };
  class FakeRingApi {
    constructor() {
      this.onRefreshTokenUpdated = { subscribe() { return { unsubscribe() {} }; } };
    }
    async getCameras() {
      return [fakeCamera];
    }
    disconnect() {}
  }

  const credentialsPath = path.join(dir, 'ring-credentials.json');
  saveRingRefreshToken(credentialsPath, 'test-refresh-token');
  const settingsStore = createRingSettings({
    ringSettingsPath: path.join(dir, 'ring-settings.json'),
  });
  const service = createRingDoorbellService({
    config: {
      ROOT: dir,
      ringCredentialsPath: credentialsPath,
      ringSettingsPath: path.join(dir, 'ring-settings.json'),
    },
    settingsStore,
    RingApi: FakeRingApi,
    sendUdpPayload(payload, options) {
      sent.push({ payload, options });
    },
  });

  const status = await service.connect();
  assert.equal(status.listening, true);
  assert.equal(status.cameraCount, 1);
  assert.equal(dingHandlers.length, 1);
  dingHandlers[0]();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.type, 'ring.doorbell');
  assert.equal(sent[0].options.targetId, 'vestaboard');
  assert.equal(sent[0].options.quietHoursExempt, true);
  service.stop();
});
