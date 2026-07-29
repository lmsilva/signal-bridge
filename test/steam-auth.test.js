const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSteamAuthorizeUrl,
  buildOpenIdReturnTo,
  createSteamLinkPending,
  consumeSteamLinkPending,
  _pendingSteamLinks,
  PENDING_TTL_MS,
} = require('../src/steam-auth');

test('createSteamLinkPending issues a unique state that consume accepts once', () => {
  _pendingSteamLinks.clear();
  const state = createSteamLinkPending();
  assert.match(state, /^[a-f0-9]{48}$/);
  assert.equal(consumeSteamLinkPending(state), true);
  assert.equal(consumeSteamLinkPending(state), false);
  assert.equal(consumeSteamLinkPending(''), false);
  assert.equal(consumeSteamLinkPending('nope'), false);
});

test('consumeSteamLinkPending rejects expired state', () => {
  _pendingSteamLinks.clear();
  const state = createSteamLinkPending({ now: 1_000_000, ttlMs: 60_000 });
  assert.equal(consumeSteamLinkPending(state, { now: 1_000_000 + 60_001 }), false);
});

test('buildSteamAuthorizeUrl embeds state on openid.return_to', () => {
  _pendingSteamLinks.clear();
  const state = createSteamLinkPending();
  const url = buildSteamAuthorizeUrl(
    { proxyOwnIp: '192.168.1.10', webServer: { https: true, port: 47810 } },
    {},
    'https://signal.example.com',
    { state },
  );
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'steamcommunity.com');
  const returnTo = parsed.searchParams.get('openid.return_to');
  assert.match(returnTo, /\/api\/auth\/steam\/callback\?state=/);
  assert.ok(returnTo.includes(encodeURIComponent(state)) || returnTo.includes(state));
});

test('buildOpenIdReturnTo without state stays bare callback path', () => {
  const returnTo = buildOpenIdReturnTo(
    { proxyOwnIp: '192.168.1.10', webServer: { https: true, port: 47810 } },
    {},
    'https://signal.example.com',
  );
  assert.equal(returnTo, 'https://signal.example.com/api/auth/steam/callback');
});

test('PENDING_TTL_MS is fifteen minutes', () => {
  assert.equal(PENDING_TTL_MS, 15 * 60 * 1000);
});
