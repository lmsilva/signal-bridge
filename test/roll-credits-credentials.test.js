const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadCredentials,
  saveCredentials,
  resolveCredentials,
} = require('../src/roll-credits-credentials');

test('Roll Credits credentials save encrypted and resolve session values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roll-credits-creds-'));
  const credentialsPath = path.join(directory, 'roll-credits-credentials.json');
  assert.equal(saveCredentials(credentialsPath, {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }, { env: {} }).ok, true);

  const disk = fs.readFileSync(credentialsPath, 'utf8');
  assert.doesNotMatch(disk, /client-secret/);
  assert.deepEqual(loadCredentials(credentialsPath, { env: {} }), {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  assert.equal(resolveCredentials({ env: {}, credentialsPath }).source, 'session');
});

test('environment credentials win and refuse a session save', () => {
  const credentialsPath = path.join(os.tmpdir(), 'unused-roll-credits-credentials.json');
  const env = { IGDB_CLIENT_ID: 'env-id', IGDB_CLIENT_SECRET: 'env-secret' };
  assert.deepEqual(resolveCredentials({ env, credentialsPath }), {
    clientId: 'env-id',
    clientSecret: 'env-secret',
    source: 'env',
    complete: true,
  });
  assert.equal(saveCredentials(credentialsPath, {
    clientId: 'new',
    clientSecret: 'new',
  }, { env }).status, 409);
});
