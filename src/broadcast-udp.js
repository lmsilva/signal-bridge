const dgram = require('dgram');

const DEFAULT_PORT = 47832;
const DEFAULT_DISCOVERY_PORT = 47833;

function createUdpBroadcaster(config, log, { onMessage } = {}) {
  const settings = {
    enabled: config.udpBroadcast?.enabled !== false,
    port: Number(config.udpBroadcast?.port || DEFAULT_PORT),
    // Separate port for display.announce so discovery does not fight the
    // Windows clients that already bind :47832 for overlays.
    discoveryPort: Number(
      config.udpBroadcast?.discoveryPort == null
        ? DEFAULT_DISCOVERY_PORT
        : config.udpBroadcast.discoveryPort,
    ),
    targets: Array.isArray(config.udpBroadcast?.targets) ? config.udpBroadcast.targets : [],
    defaultDisplaySeconds: Number(config.udpBroadcast?.defaultDisplaySeconds || 120),
  };

  let sendSocket = null;
  let discoverySocket = null;
  let sendReady = false;
  let startPromise = null;
  let listeningForAnnounces = false;

  function handleInbound(msg, rinfo) {
    if (typeof onMessage !== 'function') {
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') {
      return;
    }
    try {
      onMessage(payload, rinfo);
    } catch (error) {
      log.warn('UDP inbound handler failed', error?.message || error);
    }
  }

  function ensureSendSocket() {
    if (sendSocket && sendReady) {
      return Promise.resolve(sendSocket);
    }

    return new Promise((resolve, reject) => {
      if (sendSocket && sendReady) {
        resolve(sendSocket);
        return;
      }

      sendSocket = dgram.createSocket('udp4');
      sendSocket.on('error', (error) => {
        log.error('UDP send socket error', error.message || error);
        if (!sendReady) {
          reject(error);
        }
      });

      // Ephemeral bind for outbound — avoids EADDRINUSE with display clients
      // on the same machine and keeps QNAP host-network sends reliable.
      sendSocket.bind(0, () => {
        try {
          sendSocket.setBroadcast(true);
        } catch (error) {
          log.warn('UDP setBroadcast failed', error?.message || error);
        }
        sendReady = true;
        resolve(sendSocket);
      });
    });
  }

  function startDiscoverySocket() {
    if (!settings.discoveryPort || settings.discoveryPort <= 0) {
      log.warn('UDP discovery port disabled — display announces will not be received');
      return Promise.resolve(null);
    }
    if (discoverySocket && listeningForAnnounces) {
      return Promise.resolve(discoverySocket);
    }

    return new Promise((resolve, reject) => {
      discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      discoverySocket.on('message', handleInbound);

      discoverySocket.on('error', (error) => {
        log.error('UDP discovery socket error', error.message || error);
        listeningForAnnounces = false;
        if (error?.code === 'EADDRINUSE') {
          log.error(
            `Discovery port ${settings.discoveryPort} is in use — display registration will fail until it is free`,
          );
        }
        reject(error);
      });

      discoverySocket.bind(settings.discoveryPort, '0.0.0.0', () => {
        try {
          discoverySocket.setBroadcast(true);
        } catch {
          // ignore
        }
        listeningForAnnounces = true;
        log.info(
          `UDP display discovery listening on 0.0.0.0:${settings.discoveryPort} `
          + `(announces); overlay traffic uses :${settings.port}`,
        );
        resolve(discoverySocket);
      });
    });
  }

  /**
   * @param {object} payload
   * @param {{ host?: string }} [options] - when host is set, unicast only to that IP
   */
  async function send(payload, options = {}) {
    if (!settings.enabled) {
      return;
    }

    try {
      const sock = await ensureSendSocket();
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const unicastHost = options.host ? String(options.host).trim() : '';

      const deliveries = unicastHost
        ? [{ host: unicastHost, label: 'unicast' }]
        : [
          { host: '255.255.255.255', label: 'broadcast' },
          ...settings.targets.map((host) => ({ host, label: 'target' })),
        ];

      for (const target of deliveries) {
        await new Promise((resolveSend) => {
          sock.send(body, settings.port, target.host, (error) => {
            if (error) {
              log.warn(`UDP send failed (${target.label}: ${target.host})`, error.message || error);
            } else {
              log.debug(`UDP payload sent to ${target.host}:${settings.port}`);
            }
            resolveSend();
          });
        });
      }
    } catch (error) {
      log.error('UDP broadcast failed', error.message || error);
    }
  }

  async function start() {
    if (!settings.enabled) {
      return null;
    }
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      await ensureSendSocket();
      try {
        await startDiscoverySocket();
      } catch (error) {
        log.warn('Display discovery socket failed to start', error?.message || error);
      }
      return sendSocket;
    })();

    return startPromise;
  }

  function close() {
    for (const sock of [sendSocket, discoverySocket]) {
      if (!sock) {
        continue;
      }
      try {
        sock.close();
      } catch {
        // already closed
      }
    }
    sendSocket = null;
    discoverySocket = null;
    sendReady = false;
    startPromise = null;
    listeningForAnnounces = false;
  }

  return {
    settings,
    send,
    start,
    close,
    get listeningForAnnounces() {
      return listeningForAnnounces;
    },
  };
}

module.exports = {
  createUdpBroadcaster,
  DEFAULT_PORT,
  DEFAULT_DISCOVERY_PORT,
};
