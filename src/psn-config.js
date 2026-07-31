const path = require('path');

function resolvePsnConfig(config, fileConfig = {}) {
  const psn = fileConfig.psn || config.psn || {};
  const root = config.ROOT || path.resolve(__dirname, '..');
  const sessionRel = psn.sessionFile || 'data/psn-session.json';
  const authStatusRel = psn.authStatusFile || 'data/psn-auth-status.json';

  return {
    // Unofficial PSN APIs — needs NPSSO link via Admin → Settings.
    enabled: psn.enabled !== false && process.env.PSN_ENABLED !== '0',
    pollIntervalSeconds: Math.max(10, Number(psn.pollIntervalSeconds) || 20),
    restoreAfterInterruptSeconds: Math.max(
      15,
      Number(
        process.env.PSN_RESTORE_AFTER_INTERRUPT_SEC
        || psn.restoreAfterInterruptSeconds
        || 75,
      ) || 75,
    ),
    accountId: String(process.env.PSN_ACCOUNT_ID || psn.accountId || 'me').trim() || 'me',
    sessionFile: sessionRel,
    sessionPath: path.resolve(root, sessionRel),
    authStatusFile: authStatusRel,
    authStatusPath: path.resolve(root, authStatusRel),
  };
}

module.exports = {
  resolvePsnConfig,
};
