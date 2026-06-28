const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createEventsLog(logPath) {
  const resolved = path.resolve(logPath);
  ensureParentDir(resolved);

  if (!fs.existsSync(resolved)) {
    fs.writeFileSync(resolved, '', 'utf8');
  }

  return {
    append(entry) {
      const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      })}\n`;
      fs.appendFileSync(resolved, line, 'utf8');
    },
    path: resolved,
  };
}

module.exports = {
  createEventsLog,
};
