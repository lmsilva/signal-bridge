const path = require('path');

function installAuthProxyPatch() {
  const target = require.resolve('alexa-cookie2/lib/proxy');
  const vendor = path.join(__dirname, 'vendor', 'alexa-cookie-proxy.js');
  const patched = require(vendor);

  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: patched,
  };

  return true;
}

module.exports = {
  installAuthProxyPatch,
};
