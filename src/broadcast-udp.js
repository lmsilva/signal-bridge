const dgram = require('dgram');

function createUdpBroadcaster(config, log) {
  const settings = {
    enabled: config.udpBroadcast?.enabled !== false,
    port: Number(config.udpBroadcast?.port || 47832),
    targets: Array.isArray(config.udpBroadcast?.targets) ? config.udpBroadcast.targets : [],
    defaultDisplaySeconds: Number(config.udpBroadcast?.defaultDisplaySeconds || 120),
  };

  let socket = null;
  let ready = false;

  function ensureSocket() {
    if (socket) {
      return Promise.resolve(socket);
    }

    return new Promise((resolve, reject) => {
      socket = dgram.createSocket('udp4');

      socket.on('error', (error) => {
        log.error('UDP broadcast socket error', error.message || error);
      });

      socket.bind(0, () => {
        socket.setBroadcast(true);
        ready = true;
        resolve(socket);
      });

      socket.once('error', reject);
    });
  }

  async function send(payload) {
    if (!settings.enabled) {
      return;
    }

    try {
      const sock = await ensureSocket();
      const body = Buffer.from(JSON.stringify(payload), 'utf8');

      const deliveries = [
        { host: '255.255.255.255', label: 'broadcast' },
        ...settings.targets.map((host) => ({ host, label: 'target' })),
      ];

      for (const target of deliveries) {
        await new Promise((resolve) => {
          sock.send(body, settings.port, target.host, (error) => {
            if (error) {
              log.warn(`UDP send failed (${target.label}: ${target.host})`, error.message || error);
            } else {
              log.debug(`UDP payload sent to ${target.host}:${settings.port}`);
            }
            resolve();
          });
        });
      }
    } catch (error) {
      log.error('UDP broadcast failed', error.message || error);
    }
  }

  function close() {
    if (socket) {
      socket.close();
      socket = null;
      ready = false;
    }
  }

  return {
    settings,
    send,
    close,
  };
}

module.exports = {
  createUdpBroadcaster,
};
