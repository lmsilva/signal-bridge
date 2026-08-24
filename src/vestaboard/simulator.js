// A stand-in Vestaboard that speaks the real Local API.
//
// The point is that the bridge cannot tell this apart from hardware. It
// listens on the board's own port, answers the board's own paths, expects the
// board's own headers, and fails the same ways a board fails: 401 without a
// key, 400 on a layout the flaps could not show, 503 while it is still
// finishing the last flip.
//
// Nothing in the send path knows this exists. The only difference between this
// and a real board is which host the transport was pointed at.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { ROWS, COLS, validate } = require('./encoder');

const DEFAULT_PORT = 7000;
const ENABLEMENT_PATH = '/local-api/enablement';
const MESSAGE_PATH = '/local-api/message';

const ENABLEMENT_HEADER = 'x-vestaboard-local-api-enablement-token';
const KEY_HEADER = 'x-vestaboard-local-api-key';

// A real board rejects a second message sent too soon; the flaps are still
// moving. Configurable so integration tests can run without 15s of waiting.
const DEFAULT_RATE_WINDOW_SECONDS = 15;

const MAX_CALL_LOG = 20;
const MAX_BODY_BYTES = 64 * 1024;

// Transition styles the Local API accepts. The app's own setting only applies
// to cloud messages, so locally the sender picks per message.
const STRATEGIES = new Set([
  'column',
  'reverse-column',
  'edges-to-center',
  'row',
  'diagonal',
  'random',
]);

function blankBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

function secureToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sameLayout(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pull the character grid out of a request body.
 *
 * The Local API takes either a bare array of rows or an object with a
 * `characters` key plus animation options. Both forms are real, so both are
 * accepted here.
 */
function readPostedMessage(body) {
  if (Array.isArray(body)) {
    return { characters: body, strategy: null, stepIntervalMs: null, stepSize: null };
  }

  if (body && typeof body === 'object' && Array.isArray(body.characters)) {
    const strategy = body.strategy === undefined || body.strategy === null
      ? null
      : String(body.strategy);
    if (strategy !== null && !STRATEGIES.has(strategy)) {
      return { error: `unknown strategy ${strategy}` };
    }
    return {
      characters: body.characters,
      strategy,
      stepIntervalMs: Number.isFinite(Number(body.step_interval_ms))
        ? Number(body.step_interval_ms)
        : null,
      stepSize: Number.isFinite(Number(body.step_size)) ? Number(body.step_size) : null,
    };
  }

  // The cloud API accepts {"text": "..."} and centres it. The Local API does
  // not, so neither does this.
  return { error: 'body must be a character array or an object with characters' };
}

function createVestaboardSimulator({
  config = {},
  log = console,
  now = () => Date.now(),
} = {}) {
  const root = config.ROOT || path.resolve(__dirname, '..', '..');
  const statePath = config.vestaboardSimulatorPath
    || path.join(root, 'data', 'vestaboard-simulator.json');

  const settings = config.vestaboardSimulator || {};
  const port = Number.isFinite(Number(settings.port)) ? Number(settings.port) : DEFAULT_PORT;
  // Match wherever the Signal web server already listens rather than opening a
  // wider surface than the admin UI has.
  const host = settings.host || '0.0.0.0';

  let rateWindowSeconds = Number.isFinite(Number(settings.rateWindowSeconds))
    ? Number(settings.rateWindowSeconds)
    : DEFAULT_RATE_WINDOW_SECONDS;

  let state = {
    enablementToken: '',
    apiKey: '',
    online: true,
    current: blankBoard(),
    lastAcceptedAt: null,
    lastStrategy: null,
  };

  const calls = [];
  const listeners = new Set();
  let server = null;

  function load() {
    let stored = {};
    try {
      if (fs.existsSync(statePath)) {
        stored = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
      }
    } catch (error) {
      log?.warn?.('Could not read the Vestaboard simulator state', error?.message || error);
    }

    state = {
      // Generated once. Stands in for the token Vestaboard emails a real owner.
      enablementToken: stored.enablementToken || secureToken(),
      apiKey: stored.apiKey || '',
      online: stored.online !== false,
      current: Array.isArray(stored.current) && validate(stored.current).ok
        ? stored.current
        : blankBoard(),
      lastAcceptedAt: stored.lastAcceptedAt || null,
      lastStrategy: stored.lastStrategy || null,
    };

    if (!stored.enablementToken) {
      persist();
    }
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      log?.warn?.('Could not persist the Vestaboard simulator state', error?.message || error);
    }
  }

  function emit(event, detail) {
    for (const listener of listeners) {
      try {
        listener(event, detail);
      } catch {
        // A broken page listener must not take the board down.
      }
    }
  }

  function cooldownMs() {
    if (!state.lastAcceptedAt) {
      return 0;
    }
    const elapsed = now() - state.lastAcceptedAt;
    return Math.max(0, rateWindowSeconds * 1000 - elapsed);
  }

  /** Never includes the token or the key — those only leave via settings. */
  function snapshot() {
    return {
      online: state.online,
      enabled: Boolean(state.apiKey),
      current: state.current.map((row) => [...row]),
      lastAcceptedAt: state.lastAcceptedAt,
      lastStrategy: state.lastStrategy,
      cooldownMs: cooldownMs(),
      rateWindowSeconds,
    };
  }

  function recordCall(method, result) {
    const entry = { at: new Date(now()).toISOString(), method, result };
    calls.push(entry);
    while (calls.length > MAX_CALL_LOG) {
      calls.shift();
    }
    emit('call', entry);
    return entry;
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  function handleEnablement(req, res, body) {
    const offered = req.headers[ENABLEMENT_HEADER];
    if (!offered || offered !== state.enablementToken) {
      recordCall('POST enablement', '401 auth bad');
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    // Enabling twice returns the same key, matching a board that has already
    // been enabled rather than silently rotating the caller's credential.
    if (!state.apiKey) {
      state.apiKey = secureToken(17);
      persist();
      emit('state', snapshot());
    }

    recordCall('POST enablement', '200 enabled');
    sendJson(res, 200, { message: 'Local API enabled', apiKey: state.apiKey });
  }

  function authorised(req) {
    const offered = req.headers[KEY_HEADER];
    return Boolean(state.apiKey) && offered === state.apiKey;
  }

  function handleRead(req, res) {
    if (!authorised(req)) {
      recordCall('GET message', '401 auth bad');
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    recordCall('GET message', '200 read');
    // The Local API answers with the bare grid, unlike the cloud API which
    // wraps it in a currentMessage object with an id.
    sendJson(res, 200, state.current);
  }

  function handleWrite(req, res, body) {
    if (!authorised(req)) {
      recordCall('POST message', '401 auth bad');
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    if (!state.online) {
      recordCall('POST message', '503 offline');
      sendJson(res, 503, { message: 'board offline' });
      return;
    }

    const posted = readPostedMessage(body);
    if (posted.error) {
      recordCall('POST message', '400 bad layout');
      sendJson(res, 400, { message: posted.error });
      return;
    }

    // Flagship is 6x22. The Note is 3x15, which this simulator does not model.
    const check = validate(posted.characters);
    if (!check.ok) {
      recordCall('POST message', '400 bad layout');
      sendJson(res, 400, { message: check.errors[0] });
      return;
    }

    // A board shows what it shows; re-posting it changes nothing and must not
    // restart the rate window, or a repeating page would lock the board out.
    if (sameLayout(posted.characters, state.current)) {
      recordCall('POST message', '200 duplicate');
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    const waiting = cooldownMs();
    if (waiting > 0) {
      recordCall('POST message', '503 rate');
      sendJson(res, 503, { message: 'rate limited' });
      return;
    }

    state.current = posted.characters.map((row) => [...row]);
    state.lastAcceptedAt = now();
    state.lastStrategy = posted.strategy;
    persist();

    recordCall('POST message', '200 flipped');
    emit('flip', {
      layout: snapshot().current,
      strategy: posted.strategy,
      stepIntervalMs: posted.stepIntervalMs,
      stepSize: posted.stepSize,
    });
    emit('state', snapshot());

    sendJson(res, 200, { status: 'ok' });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(Symbol.for('unparsable'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Route one request. Returns false for anything that is not a board path. */
  async function handleRequest(req, res) {
    const pathname = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

    if (pathname !== ENABLEMENT_PATH && pathname !== MESSAGE_PATH) {
      return false;
    }

    if (pathname === MESSAGE_PATH && req.method === 'GET') {
      handleRead(req, res);
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    let body = null;
    try {
      body = await readBody(req);
    } catch {
      recordCall(`POST ${pathname}`, '400 bad layout');
      sendJson(res, 400, { message: 'body too large' });
      return true;
    }

    if (body === Symbol.for('unparsable')) {
      recordCall('POST message', '400 bad layout');
      sendJson(res, 400, { message: 'body is not valid JSON' });
      return true;
    }

    if (pathname === ENABLEMENT_PATH) {
      handleEnablement(req, res, body);
    } else {
      handleWrite(req, res, body);
    }
    return true;
  }

  function start() {
    if (server) {
      return Promise.resolve(server);
    }
    server = http.createServer((req, res) => {
      handleRequest(req, res).then((handled) => {
        if (!handled) {
          sendJson(res, 404, { message: 'Not Found' });
        }
      }).catch((error) => {
        log?.warn?.('Vestaboard simulator request failed', error?.message || error);
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        }
      });
    });

    return new Promise((resolve, reject) => {
      server.once('error', (error) => {
        if (error?.code === 'EADDRINUSE') {
          log?.warn?.(
            `Vestaboard simulator could not bind port ${port}; `
            + 'set vestaboardSimulator.port to a free port',
          );
        }
        reject(error);
      });
      server.listen(port, host, () => {
        log?.info?.(`Vestaboard simulator listening on ${host}:${server.address().port}`);
        resolve(server);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      closing.close(() => resolve());
    });
  }

  load();

  return {
    handleRequest,
    start,
    stop,
    address: () => (server ? server.address() : null),
    state: snapshot,
    calls: () => calls.map((entry) => ({ ...entry })),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOnline(online) {
      const next = Boolean(online);
      if (next === state.online) {
        return snapshot();
      }
      state.online = next;
      persist();
      emit('state', snapshot());
      return snapshot();
    },
    /** Shown once on the settings page, the way a board owner gets it by email. */
    enablementToken: () => state.enablementToken,
    apiKey: () => state.apiKey,
    setRateWindowSeconds(seconds) {
      const value = Number(seconds);
      if (Number.isFinite(value) && value >= 0) {
        rateWindowSeconds = value;
      }
      return rateWindowSeconds;
    },
    statePath,
    port,
  };
}

module.exports = {
  createVestaboardSimulator,
  DEFAULT_PORT,
  DEFAULT_RATE_WINDOW_SECONDS,
  ENABLEMENT_PATH,
  MESSAGE_PATH,
  ENABLEMENT_HEADER,
  KEY_HEADER,
  STRATEGIES,
  readPostedMessage,
  blankBoard,
};
