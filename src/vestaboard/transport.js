// The HTTP client that talks to a Vestaboard over its Local API.
//
// This is the same code for a real board and for the simulator — only the
// base URL and the key differ. That is the whole reason the simulator is
// worth having, so nothing board-specific may leak in here.
//
// Callers get a classified result rather than an exception, because every
// failure mode means something different to the queue: 503 is ordinary
// back-pressure, 401 is a bad key that must not be retried in a spin, and a
// dropped connection is worth backing off over.

const DEFAULT_TIMEOUT_MS = 8000;
const MESSAGE_PATH = '/local-api/message';
const ENABLEMENT_PATH = '/local-api/enablement';

const KEY_HEADER = 'X-Vestaboard-Local-Api-Key';
const ENABLEMENT_HEADER = 'X-Vestaboard-Local-Api-Enablement-Token';

/** Reasons a post can end, and what the queue should do about each. */
const REASONS = {
  ok: { ok: true, retryable: false },
  busy: { ok: false, retryable: true }, // 503 — board still flipping
  auth: { ok: false, retryable: false }, // 401 — wrong or missing key
  layout: { ok: false, retryable: false }, // 400 — the flaps cannot show it
  server: { ok: false, retryable: true }, // 5xx that is not 503
  network: { ok: false, retryable: true }, // never reached the board
};

function joinPath(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 503) return 'busy';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) return 'layout';
  if (status >= 500) return 'server';
  return 'layout';
}

function result(reason, extra = {}) {
  return { reason, ...REASONS[reason], ...extra };
}

function createTransport({
  baseUrl,
  key = '',
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  async function call(url, { method = 'POST', headers = {}, body = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { status: response.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Put a layout on the board.
     *
     * A transition strategy turns the flip into an animation; without one the
     * board picks its own.
     */
    async post(layout, { strategy = null, stepIntervalMs = null, stepSize = null } = {}) {
      const body = strategy || stepIntervalMs || stepSize
        ? {
          characters: layout,
          ...(strategy ? { strategy } : {}),
          ...(stepIntervalMs ? { step_interval_ms: stepIntervalMs } : {}),
          ...(stepSize ? { step_size: stepSize } : {}),
        }
        : layout;

      try {
        const { status, payload } = await call(joinPath(baseUrl, MESSAGE_PATH), {
          headers: { [KEY_HEADER]: key },
          body,
        });
        return result(classify(status), { status, message: payload?.message || null });
      } catch (error) {
        // Timeouts arrive as an abort, which is still "never reached the board".
        return result('network', { status: 0, message: error?.message || 'network error' });
      }
    },

    /** What the board is showing now, as a bare 6x22 grid. */
    async read() {
      try {
        const { status, payload } = await call(joinPath(baseUrl, MESSAGE_PATH), {
          method: 'GET',
          headers: { [KEY_HEADER]: key },
        });
        const reason = classify(status);
        return result(reason, {
          status,
          layout: reason === 'ok' && Array.isArray(payload) ? payload : null,
        });
      } catch (error) {
        return result('network', { status: 0, message: error?.message || 'network error' });
      }
    },

    /**
     * Trade the enablement token Vestaboard sends the owner for the key this
     * transport then uses. One-time, done from the settings page.
     */
    async enable(enablementToken) {
      try {
        const { status, payload } = await call(joinPath(baseUrl, ENABLEMENT_PATH), {
          headers: { [ENABLEMENT_HEADER]: enablementToken },
        });
        const reason = classify(status);
        return result(reason, { status, apiKey: payload?.apiKey || null });
      } catch (error) {
        return result('network', { status: 0, message: error?.message || 'network error' });
      }
    },
  };
}

module.exports = {
  createTransport,
  classify,
  joinPath,
  MESSAGE_PATH,
  ENABLEMENT_PATH,
  KEY_HEADER,
  ENABLEMENT_HEADER,
};
