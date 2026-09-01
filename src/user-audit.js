/**
 * Append-only household user audit log.
 * Never writes passwords, tokens, or hashes.
 */

const fs = require('fs');
const path = require('path');

function defaultAuditPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'user-audit.jsonl');
}

const COALESCE_MS = 60_000;
const COALESCE_ACTIONS = new Set([
  'user.update',
  'user.avatar',
  'profile.update',
  'dashboard.update',
]);

function coalesceEntries(newestFirst) {
  const out = [];
  for (const row of newestFirst) {
    const prev = out[out.length - 1];
    if (
      prev
      && COALESCE_ACTIONS.has(row.action)
      && prev.action === row.action
      && String(prev.actorUserId || '') === String(row.actorUserId || '')
      && String(prev.targetUserId || '') === String(row.targetUserId || '')
    ) {
      const dt = Math.abs(Date.parse(prev.at) - Date.parse(row.at));
      if (Number.isFinite(dt) && dt <= COALESCE_MS) continue;
    }
    out.push(row);
  }
  return out;
}

function createUserAudit(config = {}, log = console) {
  const auditPath = path.resolve(
    config.userAuditPath || defaultAuditPath(config.ROOT),
  );

  function append(entry = {}) {
    const row = {
      at: entry.at || new Date().toISOString(),
      ip: entry.ip || null,
      actorUserId: entry.actorUserId || null,
      action: String(entry.action || 'unknown'),
      targetUserId: entry.targetUserId || null,
      detail: entry.detail && typeof entry.detail === 'object' ? entry.detail : {},
    };
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, `${JSON.stringify(row)}\n`, { encoding: 'utf8' });
    } catch (error) {
      log?.warn?.('User audit write failed', error?.message || error);
    }
    return row;
  }

  function list({ limit = 200, action = '', userId = '' } = {}) {
    let text = '';
    try {
      text = fs.readFileSync(auditPath, 'utf8');
    } catch {
      return [];
    }
    const actionFilter = String(action || '').trim();
    const userFilter = String(userId || '').trim();
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (actionFilter && row.action !== actionFilter) continue;
        if (userFilter && row.actorUserId !== userFilter && row.targetUserId !== userFilter) {
          continue;
        }
        rows.push(row);
      } catch {
        // skip torn line
      }
    }
    const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
    return coalesceEntries(rows.reverse()).slice(0, cap);
  }

  return { auditPath, append, list };
}

module.exports = { createUserAudit };
