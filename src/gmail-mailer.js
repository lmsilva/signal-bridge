/**
 * Gmail API OAuth mailer for household password mail.
 *
 * Scope is gmail.send only. Access tokens last ~1 hour; refresh is automatic.
 * Google Cloud apps left in Testing lose the refresh token after 7 days —
 * publish the OAuth client to Production for a household-only app.
 */

const fs = require('fs');
const path = require('path');
const { createSecretBox } = require('./secret-box');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const ACCESS_SKEW_MS = 90 * 1000;

function defaultSessionPath(root) {
  return path.resolve(root || path.resolve(__dirname, '..'), 'data', 'gmail-session.json');
}

function resolveGmailConfig(config = {}, env = process.env) {
  return {
    clientId: String(env.GMAIL_CLIENT_ID || config.gmail?.clientId || '').trim(),
    clientSecret: String(env.GMAIL_CLIENT_SECRET || config.gmail?.clientSecret || '').trim(),
    redirectUri: String(env.GMAIL_REDIRECT_URI || config.gmail?.redirectUri || '').trim(),
  };
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function rfc2822({ from, to, subject, text, html }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  ];
  if (html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', text || '');
  }
  return lines.join('\r\n');
}

function createGmailMailer({
  config = {},
  log = console,
  fetchImpl = global.fetch,
  now = () => Date.now(),
} = {}) {
  const env = config.env || process.env;
  const sessionPath = path.resolve(config.gmailSessionPath || defaultSessionPath(config.ROOT));
  const box = createSecretBox({
    keyPath: path.resolve(path.dirname(sessionPath), 'secret.key'),
    env,
  });
  let memoryAccess = null;
  let accessExpiresAt = 0;

  function oauth() {
    return resolveGmailConfig(config, env);
  }

  function isConfigured() {
    const creds = oauth();
    return Boolean(creds.clientId && creds.clientSecret && creds.redirectUri);
  }

  function loadSession() {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      return {
        refreshToken: box.decrypt(raw.refreshToken) || '',
        accessToken: box.decrypt(raw.accessToken) || '',
        expiresAt: raw.expiresAt || null,
        email: raw.email || '',
        linkedAt: raw.linkedAt || null,
      };
    } catch {
      return { refreshToken: '', accessToken: '', expiresAt: null, email: '', linkedAt: null };
    }
  }

  function saveSession(session) {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const payload = {
      refreshToken: session.refreshToken ? box.encrypt(session.refreshToken) : null,
      accessToken: session.accessToken ? box.encrypt(session.accessToken) : null,
      expiresAt: session.expiresAt || null,
      email: session.email || '',
      linkedAt: session.linkedAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    const tmp = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, sessionPath);
  }

  function status() {
    const session = loadSession();
    return {
      configured: isConfigured(),
      linked: Boolean(session.refreshToken),
      email: session.email || null,
      linkedAt: session.linkedAt || null,
    };
  }

  function buildAuthorizeUrl({ state = '' } = {}) {
    const creds = oauth();
    if (!isConfigured()) {
      return { ok: false, error: 'Gmail OAuth is not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REDIRECT_URI' };
    }
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', creds.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    if (state) url.searchParams.set('state', state);
    return { ok: true, url: url.toString() };
  }

  async function tokenRequest(body) {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error_description || json.error || `Gmail token failed (${response.status})`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  async function applyTokenResponse(json, existing = loadSession()) {
    const expiresIn = Number(json.expires_in || 3600);
    const session = {
      refreshToken: json.refresh_token || existing.refreshToken,
      accessToken: json.access_token || existing.accessToken,
      expiresAt: new Date(now() + expiresIn * 1000).toISOString(),
      email: existing.email || '',
      linkedAt: existing.linkedAt || new Date(now()).toISOString(),
    };
    memoryAccess = session.accessToken;
    accessExpiresAt = now() + Math.max(30, expiresIn) * 1000 - ACCESS_SKEW_MS;
    if (!session.email && session.accessToken) {
      try {
        const me = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        const profile = await me.json().catch(() => ({}));
        if (profile.emailAddress) session.email = profile.emailAddress;
      } catch (error) {
        log?.warn?.('Gmail profile lookup failed', error?.message || error);
      }
    }
    saveSession(session);
    return session;
  }

  async function exchangeCode(code) {
    const creds = oauth();
    const json = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(code || ''),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: creds.redirectUri,
    });
    const session = await applyTokenResponse(json);
    return { ok: true, ...status(), session };
  }

  async function getAccessToken() {
    if (memoryAccess && now() < accessExpiresAt) return memoryAccess;
    const session = loadSession();
    if (!session.refreshToken) {
      throw new Error('Gmail is not linked');
    }
    if (session.accessToken && session.expiresAt && Date.parse(session.expiresAt) - ACCESS_SKEW_MS > now()) {
      memoryAccess = session.accessToken;
      accessExpiresAt = Date.parse(session.expiresAt) - ACCESS_SKEW_MS;
      return memoryAccess;
    }
    const creds = oauth();
    const json = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    const next = await applyTokenResponse(json, session);
    return next.accessToken;
  }

  async function sendMail({ to, subject, text, html } = {}) {
    const dest = String(to || '').trim();
    if (!dest) return { ok: false, error: 'No recipient email' };
    if (!loadSession().refreshToken) {
      return { ok: false, error: 'Gmail is not linked', code: 'gmail_unlinked' };
    }
    const session = loadSession();
    const raw = rfc2822({
      from: session.email || 'me',
      to: dest,
      subject: String(subject || 'Signal'),
      text,
      html,
    });
    const token = await getAccessToken();
    const response = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64Url(raw) }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: json.error?.message || `Gmail send failed (${response.status})`,
        status: response.status,
      };
    }
    return { ok: true, id: json.id || null };
  }

  function unlink() {
    try {
      if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    } catch {
      // ignore
    }
    memoryAccess = null;
    accessExpiresAt = 0;
    return { ok: true, ...status() };
  }

  return {
    isConfigured,
    status,
    buildAuthorizeUrl,
    exchangeCode,
    getAccessToken,
    sendMail,
    unlink,
    SCOPE,
  };
}

module.exports = {
  createGmailMailer,
  resolveGmailConfig,
  rfc2822,
  base64Url,
};
