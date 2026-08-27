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

/**
 * Finished Huupe sessions, one JSONL file per UTC month.
 *
 * Dedupe is on `sessionId`, which the live state machine mints. Family Mode
 * also reports a `uniqueScoreId`, but only for the signed-in profile and only
 * when the (frequently truncated) stats upload parses — so it is recorded as a
 * cross-reference rather than trusted as the key.
 */
function createHuupeArchive(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const archiveRoot = path.resolve(
    config.huupeArchivePath || path.join(root, 'data', 'huupe-games'),
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
      log?.warn?.('Could not index Huupe archive', error?.message || error);
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

  function latest(limit = 1) {
    const rows = listAll()
      .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
    return rows.slice(0, Math.max(0, limit));
  }

  function count() {
    ensureLoaded();
    return idIndex.size;
  }

  return {
    archiveRoot,
    has,
    append,
    listAll,
    latest,
    count,
    monthFileName,
  };
}

module.exports = {
  createHuupeArchive,
  monthFileName,
};
