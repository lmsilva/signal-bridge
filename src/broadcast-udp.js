const dgram = require('dgram');
const { encodeOutbound, decodeInbound, isEnabled } = require('./lan-crypto');

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
  const lanSecret = String(config.lanUdpSecret || '').trim();
  let lastDecryptWarnAt = 0;

  let sendSocket = null;
  let discoverySocket = null;
  let sendReady = false;
  let startPromise = null;
  let listeningForAnnounces = false;

  function warnDecryptOnce(reason) {
    const now = Date.now();
    if (now - lastDecryptWarnAt < 30_000) {
      return;
    }
    lastDecryptWarnAt = now;
    log.warn(`UDP inbound dropped (${reason}) — check LAN_UDP_SECRET matches the display client udpSecret`);
  }

  function handleInbound(msg, rinfo) {
    if (typeof onMessage !== 'function') {
      return;
    }
    const payload = decodeInbound(msg, lanSecret);
    if (!payload) {
      if (isEnabled(lanSecret)) {
        warnDecryptOnce('decrypt failed or plaintext while encryption required');
      }
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
   * @param {{ host?: string, hosts?: string[] }} [options]
   *   - `host`: unicast only to that IP
   *   - `hosts`: unicast to each IP (scheduler "all displays"), then also
   *     broadcast so any unregistered listener still has a chance
   */
  async function send(payload, options = {}) {
    if (!settings.enabled) {
      return;
    }

    try {
      const sock = await ensureSendSocket();
      const wire = encodeOutbound(payload, lanSecret);
      const body = Buffer.from(JSON.stringify(wire), 'utf8');
      const unicastHost = options.host ? String(options.host).trim() : '';
      const hostList = Array.isArray(options.hosts)
        ? [...new Set(options.hosts.map((host) => String(host || '').trim()).filter(Boolean))]
        : [];

      let deliveries;
      if (unicastHost) {
        deliveries = [{ host: unicastHost, label: 'unicast' }];
      } else if (hostList.length) {
        deliveries = [
          ...hostList.map((host) => ({ host, label: 'unicast' })),
          { host: '255.255.255.255', label: 'broadcast' },
          ...settings.targets.map((host) => ({ host, label: 'target' })),
        ];
        // De-dupe in case a configured target matches a registered display.
        const seen = new Set();
        deliveries = deliveries.filter((entry) => {
          if (seen.has(entry.host)) return false;
          seen.add(entry.host);
          return true;
        });
      } else {
        deliveries = [
          { host: '255.255.255.255', label: 'broadcast' },
          ...settings.targets.map((host) => ({ host, label: 'target' })),
        ];
      }

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
      if (isEnabled(lanSecret)) {
        log.info('UDP LAN encryption enabled (AES-256-GCM shared secret)');
      } else {
        log.warn(
          'UDP LAN encryption disabled — set LAN_UDP_SECRET in .env '
          + '(and matching udpSecret on display clients) to encrypt overlays and remote input',
        );
      }
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
