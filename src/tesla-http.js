function encodeFormBody(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function postForm(url, fields, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeFormBody(fields),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(data?.error_description || data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function parseRateLimitHeaders(response) {
  const retryAfter = response.headers.get('Retry-After');
  const rateLimitReset = response.headers.get('RateLimit-Reset');
  let retryAfterSec = null;
  if (retryAfter) {
    const parsed = Number(retryAfter);
    if (!Number.isNaN(parsed)) {
      retryAfterSec = parsed;
    }
  }
  let limitResetAt = null;
  if (retryAfterSec != null) {
    limitResetAt = new Date(Date.now() + retryAfterSec * 1000).toISOString();
  } else if (rateLimitReset) {
    const resetMs = Number(rateLimitReset) * 1000;
    if (!Number.isNaN(resetMs)) {
      limitResetAt = new Date(resetMs).toISOString();
    }
  }
  return { retryAfterSec, limitResetAt };
}

module.exports = {
  encodeFormBody,
  postForm,
  fetchJson,
  parseRateLimitHeaders,
};
