function timestamp() {
  return new Date().toISOString();
}

function formatLine(level, message, details) {
  const base = `[${timestamp()}] ${level.padEnd(7)} ${message}`;
  if (details === undefined) {
    return base;
  }

  if (typeof details === 'string') {
    return `${base} ${details}`;
  }

  return `${base} ${JSON.stringify(details)}`;
}

function createLogger(config) {
  return {
    info(message, details) {
      console.log(formatLine('INFO', message, details));
    },
    warn(message, details) {
      console.warn(formatLine('WARN', message, details));
    },
    error(message, details) {
      console.error(formatLine('ERROR', message, details));
    },
    debug(message, details) {
      if (!config.debug) {
        return;
      }
      console.log(formatLine('DEBUG', message, details));
    },
    broadcast(record) {
      const line = formatLine('BROADCAST', `"${record.message}"`, `device=${record.device}`);
      console.log(line);
    },
  };
}

module.exports = {
  createLogger,
};
