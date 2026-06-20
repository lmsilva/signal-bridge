const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function formatFileLine(record) {
  const fields = [
    new Date(record.timestamp).toISOString(),
    record.message,
    record.device,
    record.source,
    record.trigger,
  ];

  return `${fields.join('\t')}\n`;
}

function createBroadcastLog(logPath) {
  ensureParentDir(logPath);

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', 'utf8');
  }

  return {
    append(record) {
      fs.appendFileSync(logPath, formatFileLine(record), 'utf8');
    },
    path: path.resolve(logPath),
  };
}

module.exports = {
  createBroadcastLog,
};
