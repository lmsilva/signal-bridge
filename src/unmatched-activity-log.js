/**
 * Cap-append sampler for activities that had text/item types but no matcher hit.
 * Helps debug app-launched routines without enabling full debug logging.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LINES = 50;

function createUnmatchedActivityLog(config = {}, { maxLines = DEFAULT_MAX_LINES } = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const filePath = config.unmatchedActivitiesLogPath
    || path.resolve(root, 'data', 'unmatched-activities.jsonl');

  function ensureParent() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function readLines() {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function record(sample) {
    if (!sample) {
      return;
    }
    ensureParent();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...sample,
    });
    const lines = readLines();
    lines.push(line);
    while (lines.length > maxLines) {
      lines.shift();
    }
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    record,
    path: filePath,
  };
}

module.exports = {
  createUnmatchedActivityLog,
  DEFAULT_MAX_LINES,
};
