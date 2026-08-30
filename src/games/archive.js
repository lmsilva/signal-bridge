/**
 * Finished and abandoned game sessions, one JSONL file per UTC month.
 * Dedupe is on sessionId, copied from the Huupe archive.
 */

const fs = require('fs');
const path = require('path');

function monthFileName(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
}

function createGameArchive(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '../..');
  const archiveRoot = path.resolve(
    config.gameArchivePath || path.join(root, 'data', 'game-sessions'),
  );
  const idIndex = new Set();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      if (!fs.existsSync(archiveRoot)) return;
      for (const name of fs.readdirSync(archiveRoot)) {
        if (!name.endsWith('.jsonl')) continue;
        const text = fs.readFileSync(path.join(archiveRoot, name), 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            if (row?.sessionId) idIndex.add(String(row.sessionId));
          } catch {
            // A half-written line must not cost us the rest of the month.
          }
        }
      }
    } catch (error) {
      log?.warn?.('Could not index game archive', error?.message || error);
    }
  }

  function has(sessionId) {
    ensureLoaded();
    return idIndex.has(String(sessionId || ''));
  }

  function listAll() {
    ensureLoaded();
    const rows = [];
    if (!fs.existsSync(archiveRoot)) return rows;
    const files = fs.readdirSync(archiveRoot).filter((name) => name.endsWith('.jsonl')).sort();
    for (const name of files) {
      const text = fs.readFileSync(path.join(archiveRoot, name), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // skip
        }
      }
    }
    return rows;
  }

  function append(session) {
    ensureLoaded();
    const sessionId = String(session?.sessionId || '').trim();
    if (!sessionId) {
      return { ok: false, error: 'sessionId required' };
    }
    if (idIndex.has(sessionId)) {
      return { ok: true, deduped: true };
    }
    fs.mkdirSync(archiveRoot, { recursive: true });
    const filePath = path.join(archiveRoot, monthFileName(session.endedAt || session.startedAt));
    fs.appendFileSync(filePath, `${JSON.stringify(session)}\n`, 'utf8');
    idIndex.add(sessionId);
    return { ok: true, deduped: false };
  }

  function listPage({ offset = 0, limit = 10 } = {}) {
    const rows = listAll()
      .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(50, Math.max(1, Number(limit) || 10));
    return {
      rows: rows.slice(start, start + size),
      total: rows.length,
      offset: start,
      limit: size,
    };
  }

  return {
    archiveRoot,
    has,
    append,
    listAll,
    listPage,
    count() {
      ensureLoaded();
      return idIndex.size;
    },
    monthFileName,
  };
}

module.exports = {
  createGameArchive,
  monthFileName,
};
