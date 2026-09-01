const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserAudit } = require('../src/user-audit');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

test('user audit appends and lists newest first without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-audit-'));
  const audit = createUserAudit({
    ROOT: root,
    userAuditPath: path.join(root, 'user-audit.jsonl'),
  }, silentLog);
  audit.append({
    ip: '10.0.0.8',
    actorUserId: 'a1',
    action: 'login',
    targetUserId: 'a1',
    detail: { username: 'admin' },
  });
  audit.append({
    ip: '10.0.0.8',
    actorUserId: 'a1',
    action: 'user.create',
    targetUserId: 'u2',
    detail: { username: 'luis' },
  });
  const rows = audit.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'user.create');
  assert.equal(rows[1].action, 'login');
  assert.equal(rows[0].ip, '10.0.0.8');
  const text = fs.readFileSync(audit.auditPath, 'utf8');
  assert.doesNotMatch(text, /password/i);
  assert.equal(audit.list({ action: 'login' }).length, 1);
});

test('user audit coalesces a burst of the same profile save into one row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-audit-'));
  const audit = createUserAudit({
    ROOT: root,
    userAuditPath: path.join(root, 'user-audit.jsonl'),
  }, silentLog);
  audit.append({
    at: '2026-09-01T20:01:20.000Z',
    ip: '10.0.0.8',
    actorUserId: 'admin',
    action: 'login',
    targetUserId: 'admin',
  });
  const base = Date.parse('2026-09-01T20:01:25.000Z');
  for (let i = 0; i < 7; i += 1) {
    audit.append({
      at: new Date(base + (i * 2000)).toISOString(),
      ip: '10.0.0.8',
      actorUserId: 'thomas',
      action: 'profile.update',
      targetUserId: 'thomas',
    });
  }
  const rows = audit.list();
  assert.equal(rows.filter((row) => row.action === 'profile.update').length, 1);
  assert.equal(rows.filter((row) => row.action === 'login').length, 1);
  assert.equal(rows[0].action, 'profile.update');
});

test('user audit does not merge logins or later profile saves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'user-audit-'));
  const audit = createUserAudit({
    ROOT: root,
    userAuditPath: path.join(root, 'user-audit.jsonl'),
  }, silentLog);
  audit.append({
    at: '2026-09-01T19:00:00.000Z',
    actorUserId: 'a1',
    action: 'login',
    targetUserId: 'a1',
  });
  audit.append({
    at: '2026-09-01T19:00:10.000Z',
    actorUserId: 'a1',
    action: 'login',
    targetUserId: 'a1',
  });
  audit.append({
    at: '2026-09-01T19:00:00.000Z',
    actorUserId: 't1',
    action: 'profile.update',
    targetUserId: 't1',
  });
  audit.append({
    at: '2026-09-01T19:10:00.000Z',
    actorUserId: 't1',
    action: 'profile.update',
    targetUserId: 't1',
  });
  const rows = audit.list();
  assert.equal(rows.filter((row) => row.action === 'login').length, 2);
  assert.equal(rows.filter((row) => row.action === 'profile.update').length, 2);
});
