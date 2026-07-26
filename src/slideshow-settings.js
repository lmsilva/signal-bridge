const fs = require('fs');
const path = require('path');

const VALID_ORDERS = ['recent', 'oldest', 'random'];
const DEFAULT_ORDER = 'recent';

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Persists the one user-facing preference for the Shared Photo Slideshow —
 * playback order — to a small JSON file (mirrors `tesla-session.js`'s
 * load/save-a-JSON-file pattern) so it survives bridge restarts without
 * touching the rest of `config.json`.
 */
function createSlideshowSettings(config = {}, log = console) {
  const settingsPath = config.slideshowSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/slideshow-settings.json');

  let order = DEFAULT_ORDER;
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (VALID_ORDERS.includes(data?.order)) {
        order = data.order;
      }
    }
  } catch (error) {
    log?.warn?.('Could not read slideshow settings — using defaults', error?.message || error);
  }

  function getOrder() {
    return order;
  }

  function setOrder(next) {
    const value = String(next || '').trim().toLowerCase();
    if (!VALID_ORDERS.includes(value)) {
      return { ok: false, error: `Unknown slideshow order: ${next || '(none)'}` };
    }
    order = value;
    try {
      ensureParentDir(settingsPath);
      fs.writeFileSync(settingsPath, `${JSON.stringify({ order }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not persist slideshow settings', error?.message || error);
    }
    return { ok: true, order };
  }

  return { getOrder, setOrder };
}

module.exports = {
  createSlideshowSettings,
  VALID_ORDERS,
  DEFAULT_ORDER,
};
