/**
 * Ring Doorbell → Vestaboard.
 *
 * Listens for ding (and optional motion) via the unofficial ring-client-api
 * refresh-token session, then fans out a vestaboard-only alert. The board
 * layout is a red-border card with a yellow bell motif plus the house title
 * and message (Settings → Ring Doorbell).
 */

const path = require('path');
const {
  COLS,
  CHIPS,
  fold,
  wrap,
  truncate,
  blankRow,
  assertValidLayout,
} = require('./vestaboard/encoder');
const { centered } = require('./vestaboard/frames');
const { createRingSettings, DEFAULT_SETTINGS } = require('./ring-settings');
const {
  defaultCredentialsPath,
  resolveRingRefreshToken,
  saveRingRefreshToken,
  clearRingRefreshToken,
  credentialsStatus,
} = require('./ring-credentials');

const TYPE = 'ring.doorbell';
const BORDER = CHIPS.red;
const BELL = CHIPS.yellow;

function credentialsPathOf(config = {}) {
  return config.ringCredentialsPath
    || defaultCredentialsPath(config.ROOT || path.resolve(__dirname, '..'));
}

function edgeRow() {
  return new Array(COLS).fill(BORDER);
}

function sideChipRow() {
  const row = blankRow(COLS);
  row[0] = BORDER;
  row[COLS - 1] = BORDER;
  return row;
}

function paintBellTop(row) {
  row[9] = BELL;
  row[10] = BELL;
  return row;
}

function paintBellBody(row) {
  row[8] = BELL;
  row[9] = BELL;
  row[10] = BELL;
  row[11] = BELL;
  return row;
}

/**
 * 6×22 doorbell alert card.
 *
 * One message line:
 *   solid red rail
 *   yellow bell + red sides
 *   yellow bell body + red sides
 *   title
 *   message
 *   solid red rail
 *
 * Two message lines drop the top bell row so the copy still fits.
 */
function ringDoorbellRows({
  title = DEFAULT_SETTINGS.title,
  message = DEFAULT_SETTINGS.message,
} = {}) {
  const titleText = truncate(
    fold(title) || fold(DEFAULT_SETTINGS.title),
    18,
  );
  const messageLines = wrap(
    fold(message) || fold(DEFAULT_SETTINGS.message),
    18,
  ).slice(0, 2);
  while (messageLines.length < 2) {
    messageLines.push('');
  }

  const titleRow = sideChipRow();
  centered(titleText, { from: 2, width: 18, row: titleRow });

  if (messageLines[1]) {
    const m1 = sideChipRow();
    centered(messageLines[0], { from: 2, width: 18, row: m1 });
    const m2 = sideChipRow();
    centered(messageLines[1], { from: 2, width: 18, row: m2 });
    return assertValidLayout([
      edgeRow(),
      paintBellBody(sideChipRow()),
      titleRow,
      m1,
      m2,
      edgeRow(),
    ], 'ring doorbell');
  }

  const messageRow = sideChipRow();
  if (messageLines[0]) {
    centered(messageLines[0], { from: 2, width: 18, row: messageRow });
  }

  return assertValidLayout([
    edgeRow(),
    paintBellTop(sideChipRow()),
    paintBellBody(sideChipRow()),
    titleRow,
    messageRow,
    edgeRow(),
  ], 'ring doorbell');
}

function buildRingDoorbellPayload({
  title,
  message,
  deviceName = '',
  kind = 'ding',
  cameraId = '',
  asOf = new Date(),
} = {}) {
  const at = asOf instanceof Date ? asOf : new Date(asOf);
  const rows = ringDoorbellRows({ title, message });
  return {
    type: TYPE,
    kind: kind === 'motion' ? 'motion' : 'ding',
    title: String(title != null ? title : DEFAULT_SETTINGS.title),
    message: String(message != null ? message : DEFAULT_SETTINGS.message),
    deviceName: String(deviceName || '').trim(),
    cameraId: String(cameraId || '').trim(),
    rows,
    asOf: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
  };
}

function cameraAllowed(cameraId, settings) {
  const ids = settings?.cameraIds || [];
  if (!ids.length) {
    return true;
  }
  return ids.includes(String(cameraId || ''));
}

function createRingDoorbellService({
  config = {},
  log = console,
  sendUdpPayload = null,
  RingApi: RingApiOption = null,
  RingRestClient: RingRestClientOption = null,
  settingsStore = null,
} = {}) {
  const settings = settingsStore || createRingSettings(config, log);
  const credentialsPath = credentialsPathOf(config);

  let api = null;
  let subscriptions = [];
  let cameras = [];
  let pendingLogin = null;
  let status = {
    state: 'idle',
    detail: 'Not connected',
    lastError: '',
    lastEventAt: null,
    lastEventKind: null,
    listeningSince: null,
  };
  let startGeneration = 0;

  function creds() {
    return credentialsStatus(credentialsPath);
  }

  function publicSettings() {
    return settings.get();
  }

  function statusSnapshot() {
    const token = creds();
    const cfg = publicSettings();
    return {
      ...cfg,
      ...token,
      connection: { ...status },
      cameras: cameras.map((cam) => ({
        id: cam.id,
        name: cam.name,
        isDoorbot: Boolean(cam.isDoorbot),
      })),
      cameraCount: cameras.length,
      listening: status.state === 'listening',
      configured: Boolean(token.hasToken),
      pending2fa: Boolean(pendingLogin?.restClient),
      twoFactorPrompt: pendingLogin?.prompt || '',
    };
  }

  function clearPendingLogin() {
    pendingLogin = null;
  }

  async function loadRingRestClient() {
    if (RingRestClientOption) {
      return RingRestClientOption;
    }
    const mod = await import('ring-client-api/rest-client');
    return mod.RingRestClient;
  }

  function assertCanSaveToken() {
    if (resolveRingRefreshToken({ credentialsPath }).tokenSource === 'env') {
      const err = new Error('RING_REFRESH_TOKEN is set in the environment and cannot be overwritten here');
      err.code = 'ENV_BLOCKS';
      throw err;
    }
  }

  /**
   * Email/password login (same flow as ring-auth-cli). May return needs2fa.
   */
  async function loginWithPassword({ email, password } = {}) {
    assertCanSaveToken();
    const user = String(email || '').trim();
    const pass = String(password || '');
    if (!user || !pass) {
      const err = new Error('Email and password are required');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    clearPendingLogin();
    const RingRestClient = await loadRingRestClient();
    const restClient = new RingRestClient({
      email: user,
      password: pass,
      controlCenterDisplayName: 'Signal Bridge',
    });

    try {
      const auth = await restClient.getCurrentAuth();
      const refreshToken = auth?.refresh_token || restClient.refreshToken;
      if (!refreshToken) {
        throw new Error('Ring login succeeded but no refresh token was returned');
      }
      saveRingRefreshToken(credentialsPath, refreshToken);
      clearPendingLogin();
      const connected = await connect();
      return { ok: true, needs2fa: false, ...connected };
    } catch (error) {
      if (restClient.using2fa || restClient.promptFor2fa) {
        pendingLogin = {
          restClient,
          email: user,
          prompt: restClient.promptFor2fa || 'Enter the verification code from Ring',
          createdAt: Date.now(),
        };
        return {
          ok: true,
          needs2fa: true,
          prompt: pendingLogin.prompt,
          email: user,
        };
      }
      const message = error?.message || String(error);
      log?.warn?.('Ring email login failed', message);
      throw Object.assign(new Error(message), { code: 'AUTH_FAILED' });
    }
  }

  async function verify2fa({ code } = {}) {
    assertCanSaveToken();
    const twoFactor = String(code || '').trim();
    if (!twoFactor) {
      const err = new Error('Verification code is required');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    if (!pendingLogin?.restClient) {
      const err = new Error('No Ring login is waiting for a verification code — sign in again');
      err.code = 'NO_PENDING';
      throw err;
    }
    // Codes expire; ask again after 10 minutes.
    if (Date.now() - (pendingLogin.createdAt || 0) > 10 * 60 * 1000) {
      clearPendingLogin();
      const err = new Error('That sign-in expired — enter your email and password again');
      err.code = 'EXPIRED';
      throw err;
    }

    try {
      const auth = await pendingLogin.restClient.getAuth(twoFactor);
      const refreshToken = auth?.refresh_token || pendingLogin.restClient.refreshToken;
      if (!refreshToken) {
        throw new Error('Ring 2FA succeeded but no refresh token was returned');
      }
      saveRingRefreshToken(credentialsPath, refreshToken);
      clearPendingLogin();
      const connected = await connect();
      return { ok: true, needs2fa: false, ...connected };
    } catch (error) {
      if (pendingLogin?.restClient?.promptFor2fa) {
        pendingLogin.prompt = pendingLogin.restClient.promptFor2fa;
      }
      const message = error?.message || String(error);
      const err = new Error(pendingLogin?.prompt || message);
      err.code = 'BAD_2FA';
      err.prompt = pendingLogin?.prompt || '';
      throw err;
    }
  }

  function clearSubscriptions() {
    for (const sub of subscriptions) {
      try {
        sub?.unsubscribe?.();
      } catch {
        // ignore
      }
    }
    subscriptions = [];
  }

  async function disconnect() {
    clearSubscriptions();
    cameras = [];
    try {
      api?.disconnect?.();
    } catch {
      // ignore
    }
    api = null;
  }

  function emitEvent({ kind, camera }) {
    const cfg = publicSettings();
    if (!cfg.enabled) {
      return;
    }
    if (kind === 'ding' && !cfg.pushOnDing) {
      return;
    }
    if (kind === 'motion' && !cfg.pushOnMotion) {
      return;
    }
    const cameraId = String(camera?.id || camera?.deviceId || '');
    if (!cameraAllowed(cameraId, cfg)) {
      return;
    }

    const payload = buildRingDoorbellPayload({
      title: cfg.title,
      message: cfg.message,
      deviceName: camera?.name || '',
      kind,
      cameraId,
    });
    status.lastEventAt = payload.asOf;
    status.lastEventKind = kind;

    if (typeof sendUdpPayload !== 'function') {
      return;
    }
    sendUdpPayload(payload, {
      targetId: 'vestaboard',
      explicit: false,
      quietHoursExempt: cfg.quietHoursExempt,
      replaceSource: TYPE,
    });
    log?.info?.(`Ring ${kind} → Vestaboard${camera?.name ? ` (${camera.name})` : ''}`);
  }

  function subscribeCamera(camera) {
    if (!camera) {
      return;
    }
    if (typeof camera.onDoorbellPressed?.subscribe === 'function') {
      subscriptions.push(camera.onDoorbellPressed.subscribe(() => {
        emitEvent({ kind: 'ding', camera });
      }));
    }
    if (typeof camera.onMotionDetected?.subscribe === 'function') {
      subscriptions.push(camera.onMotionDetected.subscribe((active) => {
        if (active) {
          emitEvent({ kind: 'motion', camera });
        }
      }));
    }
  }

  async function connect() {
    const generation = ++startGeneration;
    const cfg = publicSettings();
    const resolved = resolveRingRefreshToken({ credentialsPath });

    await disconnect();

    if (!cfg.enabled) {
      status = {
        ...status,
        state: 'disabled',
        detail: 'Ring Doorbell is turned off in Settings',
        lastError: '',
        listeningSince: null,
      };
      return statusSnapshot();
    }

    if (!resolved.refreshToken) {
      status = {
        ...status,
        state: 'needs_auth',
        detail: 'Sign in with your Ring email and password',
        lastError: '',
        listeningSince: null,
      };
      return statusSnapshot();
    }

    status = {
      ...status,
      state: 'connecting',
      detail: 'Connecting to Ring…',
      lastError: '',
      listeningSince: null,
    };

    let RingApi = RingApiOption;
    if (!RingApi) {
      ({ RingApi } = require('ring-client-api'));
    }

    try {
      api = new RingApi({
        refreshToken: resolved.refreshToken,
        cameraStatusPollingSeconds: 20,
        controlCenterDisplayName: 'Signal Bridge',
      });

      if (api.onRefreshTokenUpdated?.subscribe) {
        subscriptions.push(api.onRefreshTokenUpdated.subscribe(async (update) => {
          const next = update?.newRefreshToken || update?.refreshToken;
          if (!next || resolveRingRefreshToken({ credentialsPath }).tokenSource === 'env') {
            return;
          }
          try {
            saveRingRefreshToken(credentialsPath, next);
          } catch (error) {
            log?.warn?.('Could not persist rotated Ring refresh token', error?.message || error);
          }
        }));
      }

      const list = await api.getCameras();
      if (generation !== startGeneration) {
        return statusSnapshot();
      }
      cameras = (list || []).map((camera) => ({
        id: String(camera.id || camera.deviceId || ''),
        name: String(camera.name || 'Ring camera'),
        isDoorbot: Boolean(camera.isDoorbot),
        _raw: camera,
      }));

      for (const camera of cameras) {
        subscribeCamera(camera._raw);
      }

      status = {
        ...status,
        state: 'listening',
        detail: cameras.length
          ? `Listening on ${cameras.length} camera${cameras.length === 1 ? '' : 's'}`
          : 'Connected — no cameras found on this account',
        lastError: '',
        listeningSince: new Date().toISOString(),
      };
      log?.info?.(status.detail);
    } catch (error) {
      const message = error?.message || String(error);
      status = {
        ...status,
        state: 'error',
        detail: 'Ring connection failed',
        lastError: message,
        listeningSince: null,
      };
      cameras = [];
      log?.warn?.('Ring Doorbell connect failed', message);
      await disconnect();
    }

    return statusSnapshot();
  }

  function previewPayload(overrides = {}) {
    const cfg = publicSettings();
    return buildRingDoorbellPayload({
      title: overrides.title != null ? overrides.title : cfg.title,
      message: overrides.message != null ? overrides.message : cfg.message,
      deviceName: overrides.deviceName || 'Front Door',
      kind: overrides.kind || 'ding',
    });
  }

  function nextPayload(overrides = {}) {
    return previewPayload(overrides);
  }

  async function saveToken(token) {
    assertCanSaveToken();
    saveRingRefreshToken(credentialsPath, token);
    clearPendingLogin();
    return connect();
  }

  async function clearToken() {
    assertCanSaveToken();
    clearRingRefreshToken(credentialsPath);
    clearPendingLogin();
    await disconnect();
    status = {
      ...status,
      state: 'needs_auth',
      detail: 'Sign in with your Ring email and password',
      lastError: '',
      listeningSince: null,
    };
    return statusSnapshot();
  }

  function updateSettings(patch = {}) {
    const next = settings.update(patch);
    if (status.state === 'listening' || status.state === 'disabled' || status.state === 'error') {
      connect().catch((error) => {
        log?.warn?.('Ring reconnect after settings change failed', error?.message || error);
      });
    }
    return next;
  }

  function resetSettings() {
    const next = settings.reset();
    connect().catch(() => {});
    return next;
  }

  function start() {
    connect().catch((error) => {
      log?.warn?.('Ring Doorbell start failed', error?.message || error);
    });
  }

  function stop() {
    startGeneration += 1;
    disconnect();
    status = {
      ...status,
      state: 'idle',
      detail: 'Stopped',
      listeningSince: null,
    };
  }

  return {
    TYPE,
    start,
    stop,
    connect,
    disconnect,
    statusSnapshot,
    previewPayload,
    nextPayload,
    saveToken,
    clearToken,
    loginWithPassword,
    verify2fa,
    updateSettings,
    resetSettings,
    getSettings: () => publicSettings(),
    emitEventForTests: emitEvent,
  };
}

module.exports = {
  TYPE,
  buildRingDoorbellPayload,
  ringDoorbellRows,
  cameraAllowed,
  createRingDoorbellService,
};
