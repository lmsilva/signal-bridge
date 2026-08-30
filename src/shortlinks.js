/**
 * Short-link service. The rest of the bridge never mentions TinyURL —
 * call ensure(name, targetPath) and status(name).
 *
 * TinyURL is the current provider. A free token can create, update an alias,
 * and archive. It cannot change a link's destination (PATCH /change is paid),
 * so a target change archives the old alias and creates a fresh link.
 *
 * Case rule (§5.3): create UPPERCASE then try lowercase. Alias-taken on the
 * twin is success (one link). Health-check both spellings.
 *
 * Live API note (2026-08-29, free token, alias WITTYBOARD): POST /create
 * of the uppercase alias succeeded; POST /create of wittyboard returned
 * "Alias is not available". We treat that as success (one link). Public
 * HEAD of tinyurl.com/WITTYBOARD and tinyurl.com/wittyboard both 301 to
 * the same target without following redirects.
 *
 * Repair ladder when an alias is gone or points elsewhere:
 *   ALIAS → ALIAS1 → ALIAS2 → random 8.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { publicUrl, isUsableShortLinkOrigin } = require('./public-url');
const {
  defaultCredentialsPath,
  resolveTinyurlToken,
} = require('./tinyurl-credentials');

const CREATE_URL = 'https://api.tinyurl.com/create';
const UPDATE_URL = 'https://api.tinyurl.com/update';
const PUBLIC_HOST = 'https://tinyurl.com';
const DOMAIN = 'tinyurl.com';
const GUESTBOOK_NAME = 'guestbook';
const GUESTBOOK_PATH = '/guestbook/';
const DEFAULT_HEALTH_MS = 24 * 60 * 60 * 1000;

function nowIso(nowFn) {
  return new Date(nowFn()).toISOString();
}

function defaultNow() {
  return Date.now();
}

function randomAlias8(randomBytes = crypto.randomBytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function aliasCandidates(preferred) {
  const base = String(preferred || '').trim().toUpperCase();
  if (!base) {
    return [randomAlias8()];
  }
  return [base, `${base}1`, `${base}2`];
}

function publicTinyUrl(alias) {
  return `${PUBLIC_HOST}/${String(alias || '').trim()}`;
}

function flapLabel(alias) {
  const a = String(alias || '').trim().toUpperCase();
  return a ? `TINYURL.COM/${a}` : '';
}

function isAliasTakenError(status, body) {
  const errors = []
    .concat(body?.errors || [])
    .concat(body?.message || [])
    .join(' ');
  if (/alias|taken|available|exist|in use/i.test(errors)) {
    return true;
  }
  return status === 422;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

function urlsMatch(left, right) {
  try {
    const a = new URL(String(left || '').trim());
    const b = new URL(String(right || '').trim());
    const pathA = a.pathname.replace(/\/+$/, '') || '/';
    const pathB = b.pathname.replace(/\/+$/, '') || '/';
    return a.protocol === b.protocol
      && a.hostname.toLowerCase() === b.hostname.toLowerCase()
      && (a.port || defaultPort(a.protocol)) === (b.port || defaultPort(b.protocol))
      && pathA === pathB
      && a.search === b.search;
  } catch {
    return stripSlash(left) === stripSlash(right);
  }
}

function stripSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function emptyLink(name) {
  return {
    name,
    preferredAlias: '',
    alias: '',
    targetPath: '',
    targetUrl: '',
    tinyUrl: '',
    createdBothSpellings: false,
    twinTaken: false,
    health: 'unknown',
    lastCheckAt: null,
    lastCheckDetail: '',
    alert: null,
    updatedAt: null,
  };
}

function sanitiseLink(raw = {}, name = '') {
  const base = emptyLink(name || raw.name || '');
  const merged = { ...base, ...(raw || {}) };
  return {
    name: String(merged.name || name || '').trim() || name,
    preferredAlias: String(merged.preferredAlias || '').trim().toUpperCase(),
    alias: String(merged.alias || '').trim(),
    targetPath: String(merged.targetPath || ''),
    targetUrl: String(merged.targetUrl || ''),
    tinyUrl: String(merged.tinyUrl || ''),
    createdBothSpellings: Boolean(merged.createdBothSpellings),
    twinTaken: Boolean(merged.twinTaken),
    health: ['healthy', 'unhealthy', 'missing', 'unknown'].includes(merged.health)
      ? merged.health
      : 'unknown',
    lastCheckAt: merged.lastCheckAt || null,
    lastCheckDetail: String(merged.lastCheckDetail || ''),
    alert: merged.alert && typeof merged.alert === 'object'
      ? {
        message: String(merged.alert.message || ''),
        at: merged.alert.at || null,
      }
      : null,
    updatedAt: merged.updatedAt || null,
  };
}

function createShortlinks(config = {}, log = console, options = {}) {
  const statePath = config.shortlinksPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data', 'shortlinks.json');
  const credentialsPath = config.tinyurlCredentialsPath
    || defaultCredentialsPath(config.ROOT);
  const fetchImpl = options.fetch || options.fetchImpl || globalThis.fetch;
  const nowFn = options.now || defaultNow;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const publicUrlFn = options.publicUrl || publicUrl;
  const healthIntervalMs = options.healthIntervalMs == null
    ? DEFAULT_HEALTH_MS
    : Number(options.healthIntervalMs);

  let state = { links: {} };
  let timer = null;

  function load() {
    try {
      if (!fs.existsSync(statePath)) {
        state = { links: {} };
        return state;
      }
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const links = {};
      Object.entries(raw?.links || {}).forEach(([name, link]) => {
        links[name] = sanitiseLink(link, name);
      });
      state = { links };
    } catch (error) {
      log?.warn?.('Could not read short-link state', error?.message || error);
      state = { links: {} };
    }
    return state;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not save short-link state', error?.message || error);
    }
  }

  function token() {
    return resolveTinyurlToken({
      env: options.env || process.env,
      credentialsPath,
    });
  }

  function resolveTarget(targetPath, extras) {
    return publicUrlFn(targetPath, config, extras);
  }

  async function apiJson(url, { method = 'GET', body } = {}) {
    const { token: bearer } = token();
    if (!bearer) {
      throw new Error('TinyURL API token is not set');
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const parsed = parseJsonSafe(text);
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      text,
    };
  }

  /**
   * Create alias then its lowercase twin.
   * Twin alias-taken is success — TinyURL often treats aliases as
   * case-insensitive, so the second create reports "not available".
   */
  async function createBothSpellings(alias, targetUrl) {
    const upper = String(alias || '').trim();
    if (!upper) {
      throw new Error('Alias is required');
    }
    const created = await apiJson(CREATE_URL, {
      method: 'POST',
      body: { url: targetUrl, domain: DOMAIN, alias: upper },
    });
    if (!created.ok) {
      return {
        ok: false,
        taken: isAliasTakenError(created.status, created.body),
        error: (created.body?.errors || []).join('; ')
          || created.body?.message
          || created.text
          || `TinyURL create failed (${created.status})`,
        alias: upper,
        twinTaken: false,
        createdBothSpellings: false,
        tinyUrl: created.body?.data?.tiny_url || publicTinyUrl(upper),
      };
    }
    const lower = upper.toLowerCase();
    let twinTaken = false;
    let createdBothSpellings = lower === upper;
    if (lower !== upper) {
      const twin = await apiJson(CREATE_URL, {
        method: 'POST',
        body: { url: targetUrl, domain: DOMAIN, alias: lower },
      });
      if (twin.ok) {
        createdBothSpellings = true;
      } else if (isAliasTakenError(twin.status, twin.body)) {
        twinTaken = true;
        createdBothSpellings = true;
      } else {
        log?.warn?.('TinyURL lowercase twin create failed', {
          alias: lower,
          status: twin.status,
          error: (twin.body?.errors || []).join('; ') || twin.text,
        });
      }
    }
    return {
      ok: true,
      taken: false,
      alias: created.body?.data?.alias || upper,
      twinTaken,
      createdBothSpellings,
      tinyUrl: created.body?.data?.tiny_url || publicTinyUrl(upper),
    };
  }

  async function archiveAlias(alias) {
    const value = String(alias || '').trim();
    if (!value) {
      return { ok: true, skipped: true };
    }
    try {
      const result = await apiJson(UPDATE_URL, {
        method: 'PATCH',
        body: { domain: DOMAIN, alias: value, archived: true },
      });
      if (!result.ok) {
        log?.warn?.('TinyURL archive failed', {
          alias: value,
          status: result.status,
          error: (result.body?.errors || []).join('; ') || result.text,
        });
      }
      return { ok: result.ok, status: result.status };
    } catch (error) {
      log?.warn?.('TinyURL archive failed', error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async function renameAlias(currentAlias, nextAlias) {
    const from = String(currentAlias || '').trim();
    const to = String(nextAlias || '').trim();
    if (!from || !to || from === to) {
      return { ok: from === to, skipped: from === to };
    }
    const result = await apiJson(UPDATE_URL, {
      method: 'PATCH',
      body: { domain: DOMAIN, alias: from, new_alias: to },
    });
    if (!result.ok) {
      return {
        ok: false,
        error: (result.body?.errors || []).join('; ')
          || result.body?.message
          || `TinyURL alias update failed (${result.status})`,
      };
    }
    const lower = to.toLowerCase();
    let twinTaken = false;
    if (lower !== to) {
      const twin = await apiJson(CREATE_URL, {
        method: 'POST',
        body: {
          url: result.body?.data?.url,
          domain: DOMAIN,
          alias: lower,
        },
      });
      twinTaken = !twin.ok && isAliasTakenError(twin.status, twin.body);
    }
    return {
      ok: true,
      alias: result.body?.data?.alias || to,
      tinyUrl: result.body?.data?.tiny_url || publicTinyUrl(to),
      twinTaken,
    };
  }

  async function headLocation(alias) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
    const url = publicTinyUrl(alias);
    const attempt = async (method) => {
      const response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        headers: { Accept: '*/*' },
      });
      const location = response.headers?.get?.('location')
        || response.headers?.get?.('Location')
        || '';
      return {
        status: response.status,
        location: String(location || '').trim(),
        ok: response.status >= 300 && response.status < 400 && Boolean(location),
      };
    };
    try {
      const head = await attempt('HEAD');
      if (head.status === 405 || head.status === 501) {
        return attempt('GET');
      }
      return head;
    } catch {
      return attempt('GET');
    }
  }

  async function checkSpellings(alias, targetUrl) {
    const upper = String(alias || '').trim();
    const lower = upper.toLowerCase();
    const primary = await headLocation(upper);
    const twin = lower !== upper ? await headLocation(lower) : primary;
    const primaryMatch = primary.ok && urlsMatch(primary.location, targetUrl);
    const twinMatch = twin.ok && urlsMatch(twin.location, targetUrl);
    const twinMissing = !twin.ok && (twin.status === 404 || twin.status === 410);
    const healthy = primaryMatch && (twinMatch || twinMissing || lower === upper);
    let detail = '';
    if (healthy) {
      detail = lower === upper || twinMatch
        ? 'both spellings OK'
        : 'uppercase OK · lowercase not published';
    } else if (!primary.ok && !twin.ok) {
      detail = 'short link is gone';
    } else {
      detail = 'destination does not match';
    }
    return {
      healthy,
      primaryMatch,
      twinMatch,
      primary,
      twin,
      detail,
    };
  }

  function writeLink(name, patch) {
    const prev = sanitiseLink(state.links[name], name);
    const next = sanitiseLink({ ...prev, ...patch, name, updatedAt: nowIso(nowFn) }, name);
    state.links[name] = next;
    save();
    return { ...next };
  }

  function raiseAlert(name, message) {
    log?.warn?.('Short link needs attention', { name, message });
    return writeLink(name, {
      health: 'unhealthy',
      alert: { message, at: nowIso(nowFn) },
      lastCheckDetail: message,
      lastCheckAt: nowIso(nowFn),
    });
  }

  async function createWithLadder(name, preferredAlias, targetPath, targetUrl) {
    const tried = [];
    const candidates = aliasCandidates(preferredAlias);
    for (const alias of candidates) {
      tried.push(alias);
      const created = await createBothSpellings(alias, targetUrl);
      if (created.ok) {
        return writeLink(name, {
          preferredAlias: String(preferredAlias || '').toUpperCase(),
          alias: created.alias,
          targetPath,
          targetUrl,
          tinyUrl: created.tinyUrl,
          createdBothSpellings: created.createdBothSpellings,
          twinTaken: created.twinTaken,
          health: 'unknown',
          lastCheckDetail: created.twinTaken
            ? 'created · lowercase twin already taken (one link)'
            : 'created',
          alert: null,
        });
      }
    }
    const random = randomAlias8(randomBytes);
    tried.push(random);
    const created = await createBothSpellings(random, targetUrl);
    if (created.ok) {
      return writeLink(name, {
        preferredAlias: String(preferredAlias || '').toUpperCase(),
        alias: created.alias,
        targetPath,
        targetUrl,
        tinyUrl: created.tinyUrl,
        createdBothSpellings: created.createdBothSpellings,
        twinTaken: created.twinTaken,
        health: 'unknown',
        lastCheckDetail: `created fallback ${created.alias}`,
        alert: {
          message: `Preferred alias was taken — using ${flapLabel(created.alias)}`,
          at: nowIso(nowFn),
        },
      });
    }
    return raiseAlert(
      name,
      `Could not create a short link (tried ${tried.join(', ')})`,
    );
  }

  async function repair(name, reason) {
    const current = sanitiseLink(state.links[name], name);
    if (current.alias) {
      await archiveAlias(current.alias);
    }
    const preferred = current.preferredAlias || current.alias;
    const targetPath = current.targetPath || GUESTBOOK_PATH;
    const targetUrl = current.targetUrl || resolveTarget(targetPath);
    const next = await createWithLadder(name, preferred, targetPath, targetUrl);
    const message = reason || 'Short link was repaired';
    log?.warn?.('Short link repaired', { name, alias: next.alias, reason: message });
    return writeLink(name, {
      ...next,
      health: next.alias ? 'unknown' : 'unhealthy',
      alert: {
        message: next.alias
          ? `${message} · now ${flapLabel(next.alias)}`
          : message,
        at: nowIso(nowFn),
      },
    });
  }

  async function check(name, { repairOnFail = true } = {}) {
    load();
    const current = sanitiseLink(state.links[name], name);
    if (!current.alias) {
      const missing = writeLink(name, {
        health: 'missing',
        lastCheckAt: nowIso(nowFn),
        lastCheckDetail: 'no short link yet',
      });
      return { ...missing, checked: false };
    }
    const targetUrl = current.targetUrl || resolveTarget(current.targetPath);
    const result = await checkSpellings(current.alias, targetUrl);
    if (result.healthy) {
      return writeLink(name, {
        health: 'healthy',
        lastCheckAt: nowIso(nowFn),
        lastCheckDetail: result.detail,
        alert: null,
      });
    }
    const broken = writeLink(name, {
      health: 'unhealthy',
      lastCheckAt: nowIso(nowFn),
      lastCheckDetail: result.detail,
    });
    if (!repairOnFail) {
      return broken;
    }
    return repair(name, result.detail);
  }

  async function ensure(name, targetPath, extras = {}) {
    const key = String(name || '').trim();
    if (!key) {
      throw new Error('Short-link name is required');
    }
    const destPath = targetPath == null || targetPath === ''
      ? GUESTBOOK_PATH
      : String(targetPath);
    const { token: bearer } = token();
    if (!bearer) {
      const missing = writeLink(key, {
        targetPath: destPath,
        preferredAlias: extras.preferredAlias
          ? String(extras.preferredAlias).toUpperCase()
          : (state.links[key]?.preferredAlias || ''),
        health: 'missing',
        lastCheckDetail: 'TinyURL API token is not set',
      });
      return { ...missing, ok: false, error: 'TinyURL API token is not set' };
    }

    const target = resolveTarget(destPath);
    if (!target) {
      return {
        ...writeLink(key, {
          targetPath: destPath,
          health: 'missing',
          lastCheckDetail: 'Public base URL is not set',
        }),
        ok: false,
        error: 'Public base URL is not set',
      };
    }
    if (!isUsableShortLinkOrigin(target)) {
      return {
        ...writeLink(key, {
          targetPath: destPath,
          targetUrl: target,
          health: 'unhealthy',
          lastCheckDetail: 'Short-link target must be a public https host, not a LAN address',
          alert: {
            message: 'Short-link target must be a public https host, not a LAN address',
            at: nowIso(nowFn),
          },
        }),
        ok: false,
        error: 'Short-link target must be a public https host, not a LAN address',
      };
    }

    load();
    const current = sanitiseLink(state.links[key], key);
    const preferred = extras.preferredAlias
      ? String(extras.preferredAlias).trim().toUpperCase()
      : (current.preferredAlias || '');
    if (!preferred) {
      return {
        ...writeLink(key, {
          targetPath: destPath,
          targetUrl: target,
          health: 'missing',
          lastCheckDetail: 'Preferred alias is not set',
        }),
        ok: false,
        error: 'Preferred alias is not set',
      };
    }

    if (current.alias && current.targetUrl && !urlsMatch(current.targetUrl, target)) {
      await archiveAlias(current.alias);
      const created = await createWithLadder(key, preferred, destPath, target);
      return { ...created, ok: Boolean(created.alias), rebuilt: true };
    }

    if (current.alias && preferred && current.alias.toUpperCase() !== preferred) {
      try {
        const renamed = await renameAlias(current.alias, preferred);
        if (renamed.ok) {
          const next = writeLink(key, {
            preferredAlias: preferred,
            alias: renamed.alias || preferred,
            targetPath: destPath,
            targetUrl: target,
            tinyUrl: renamed.tinyUrl || publicTinyUrl(preferred),
            twinTaken: Boolean(renamed.twinTaken),
            health: 'unknown',
            lastCheckDetail: 'alias updated',
            alert: null,
          });
          return { ...next, ok: true, renamed: true };
        }
      } catch (error) {
        log?.warn?.('TinyURL alias rename failed', error?.message || error);
      }
      await archiveAlias(current.alias);
      const created = await createWithLadder(key, preferred, destPath, target);
      return { ...created, ok: Boolean(created.alias), rebuilt: true };
    }

    if (current.alias && urlsMatch(current.targetUrl, target)) {
      return { ...writeLink(key, { preferredAlias: preferred, targetPath: destPath, targetUrl: target }), ok: true };
    }

    const created = await createWithLadder(key, preferred, destPath, target);
    return { ...created, ok: Boolean(created.alias) };
  }

  function status(name) {
    load();
    const key = String(name || '').trim();
    const link = sanitiseLink(state.links[key], key);
    return {
      ...link,
      flapLabel: flapLabel(link.alias),
      display: link.alias
        ? `${flapLabel(link.alias)} → ${link.targetPath || GUESTBOOK_PATH}`
        : '',
    };
  }

  async function checkNow(name = GUESTBOOK_NAME) {
    return check(name, { repairOnFail: true });
  }

  async function checkAll() {
    load();
    const names = Object.keys(state.links);
    const results = {};
    for (const name of names) {
      results[name] = await check(name, { repairOnFail: true });
    }
    return results;
  }

  load();
  if (healthIntervalMs > 0) {
    timer = setInterval(() => {
      checkAll().catch((error) => {
        log?.warn?.('Short-link daily check failed', error?.message || error);
      });
    }, healthIntervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    ensure,
    status,
    check: checkNow,
    checkAll,
    repair,
    stop,
    path: statePath,
    GUESTBOOK_NAME,
    GUESTBOOK_PATH,
  };
}

module.exports = {
  CREATE_URL,
  UPDATE_URL,
  PUBLIC_HOST,
  DOMAIN,
  GUESTBOOK_NAME,
  GUESTBOOK_PATH,
  DEFAULT_HEALTH_MS,
  urlsMatch,
  isAliasTakenError,
  aliasCandidates,
  randomAlias8,
  flapLabel,
  publicTinyUrl,
  createShortlinks,
};
