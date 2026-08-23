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

function createAutodartsArchive(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const archiveRoot = path.resolve(
    config.autodartsArchivePath || path.join(root, 'data', 'autodarts-matches'),
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
            if (row?.matchId) idIndex.add(String(row.matchId));
          } catch {
            // skip bad line
          }
        }
      }
    } catch (error) {
      log?.warn?.('Could not index Autodarts archive', error?.message || error);
    }
  }

  function has(matchId) {
    ensureLoaded();
    return idIndex.has(String(matchId || ''));
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

  function append(match) {
    ensureLoaded();
    const matchId = String(match?.matchId || '').trim();
    if (!matchId) {
      return { ok: false, error: 'matchId required' };
    }
    if (idIndex.has(matchId)) {
      return { ok: true, deduped: true };
    }
    fs.mkdirSync(archiveRoot, { recursive: true });
    const filePath = path.join(archiveRoot, monthFileName(match.finishedAt || match.startedAt));
    fs.appendFileSync(filePath, `${JSON.stringify(match)}\n`, 'utf8');
    idIndex.add(matchId);
    return { ok: true, deduped: false };
  }

  function latest(limit = 1) {
    const rows = listAll().sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
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
  createAutodartsArchive,
  monthFileName,
};
