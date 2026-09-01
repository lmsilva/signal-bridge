const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGmailMailer, rfc2822, base64Url } = require('../src/gmail-mailer');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mailer-'));
  return {
    ROOT: root,
    gmailSessionPath: path.join(root, 'gmail-session.json'),
    env: {
      GMAIL_CLIENT_ID: 'cid',
      GMAIL_CLIENT_SECRET: 'csecret',
      GMAIL_REDIRECT_URI: 'https://signal.example/api/gmail/callback',
    },
  };
}

test('gmail authorize url asks for send-only offline access', () => {
  const mailer = createGmailMailer({ config: tempConfig(), log: silentLog });
  const result = mailer.buildAuthorizeUrl({ state: 'abc' });
  assert.equal(result.ok, true);
  const url = new URL(result.url);
  assert.equal(url.searchParams.get('scope'), mailer.SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'abc');
});

test('gmail send uses a refreshed access token', async () => {
  const calls = [];
  const mailer = createGmailMailer({
    config: tempConfig(),
    log: silentLog,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body, headers: options.headers });
      if (String(url).includes('/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
          }),
        };
      }
      if (String(url).includes('/profile')) {
        return { ok: true, json: async () => ({ emailAddress: 'house@gmail.com' }) };
      }
      if (String(url).includes('/messages/send')) {
        return { ok: true, json: async () => ({ id: 'm1' }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  await mailer.exchangeCode('code-1');
  const sent = await mailer.sendMail({
    to: 'luis@example.com',
    subject: 'Your Signal password',
    text: 'hello',
  });
  assert.equal(sent.ok, true);
  assert.ok(calls.some((row) => String(row.url).includes('/messages/send')));
});

test('rfc2822 and base64url encode a simple message', () => {
  const raw = rfc2822({
    from: 'a@b.c',
    to: 'd@e.f',
    subject: 'Hi',
    text: 'hello',
  });
  assert.match(raw, /To: d@e\.f/);
  assert.doesNotMatch(base64Url('ab+c/'), /\+|\//);
});
