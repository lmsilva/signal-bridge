const { createAlexaCookieRefresh } = require('./vendor/alexa-cookie-refresh');

/**
 * Replace alexa-cookie2's broken refreshAlexaCookie with the vendored
 * skip-register version. alexa-cookie2 exports a singleton, and
 * alexa-remote2 lazy-requires the same cached instance, so patching the
 * exported object is enough.
 *
 * Must be installed before the first refreshCookie() call (listener
 * startup is fine — alexa-remote2 requires alexa-cookie2 lazily).
 */
function installRefreshPatch({ log } = {}) {
  const alexaCookie = require('alexa-cookie2');
  if (alexaCookie.__bridgeRefreshPatched) {
    return alexaCookie;
  }

  const patched = createAlexaCookieRefresh();
  alexaCookie.refreshAlexaCookie = patched.refreshAlexaCookie;
  alexaCookie.__bridgeRefreshPatched = true;

  log?.info?.('Installed patched cookie refresh (skip /auth/register during refresh)');
  return alexaCookie;
}

module.exports = {
  installRefreshPatch,
};
