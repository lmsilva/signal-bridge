const net = require('net');

function isPortAvailable(port, host = '::') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function ensurePortAvailable(port, log) {
  const available = await isPortAvailable(port);
  if (available) {
    return true;
  }

  log.error(`Port ${port} is already in use — the Amazon login proxy cannot start`);
  log.error('On the NAS, free the port then run auth again:');
  log.error(`  ss -tlnp | grep :${port}`);
  log.error(`  kill -9 <pid>   # or: PROXY_PORT=${port + 1} ./reauth.sh`);
  log.error('Or run ./reauth.sh again (it now kills listeners on this port automatically)');
  return false;
}

function isProxyPortError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Proxy Server could not be initialized')
    || message.includes('Proxy could not be initialized')
    || message.includes('EADDRINUSE')
  );
}

module.exports = {
  isPortAvailable,
  ensurePortAvailable,
  isProxyPortError,
};
