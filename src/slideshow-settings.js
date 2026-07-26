const fs = require('fs');
const path = require('path');

const VALID_ORDERS = ['recent', 'oldest', 'random'];
const DEFAULT_ORDER = 'recent';
const DEFAULT_SECONDS_PER_PHOTO = 5;
const MIN_SECONDS_PER_PHOTO = 5;
const MAX_SECONDS_PER_PHOTO = 60;

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function clampSecondsPerPhoto(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return DEFAULT_SECONDS_PER_PHOTO;
  }
  return Math.max(
    MIN_SECONDS_PER_PHOTO,
    Math.min(MAX_SECONDS_PER_PHOTO, Math.round(n)),
  );
}

/**
 * Persists Shared Photo Slideshow preferences — playback order and seconds
 * per photo — to a small JSON file (mirrors `tesla-session.js`'s load/save
 * pattern) so they survive bridge restarts without touching `config.json`.
 */
function createSlideshowSettings(config = {}, log = console) {
  const settingsPath = config.slideshowSettingsPath
    || path.resolve(config.ROOT || path.resolve(__dirname, '..'), 'data/slideshow-settings.json');

  let order = DEFAULT_ORDER;
  let secondsPerPhoto = DEFAULT_SECONDS_PER_PHOTO;
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (VALID_ORDERS.includes(data?.order)) {
        order = data.order;
      }
      if (data?.secondsPerPhoto != null) {
        secondsPerPhoto = clampSecondsPerPhoto(data.secondsPerPhoto);
      }
    }
  } catch (error) {
    log?.warn?.('Could not read slideshow settings — using defaults', error?.message || error);
  }

  function persist() {
    try {
      ensureParentDir(settingsPath);
      fs.writeFileSync(
        settingsPath,
        `${JSON.stringify({ order, secondsPerPhoto }, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      log?.warn?.('Could not persist slideshow settings', error?.message || error);
    }
  }

  function get() {
    return { order, secondsPerPhoto };
  }

  function getOrder() {
    return order;
  }

  function getSecondsPerPhoto() {
    return secondsPerPhoto;
  }

  function setOrder(next) {
    return update({ order: next });
  }

  function setSecondsPerPhoto(next) {
    return update({ secondsPerPhoto: next });
  }

  function update(patch = {}) {
    let nextOrder = order;
    let nextSeconds = secondsPerPhoto;
    let touched = false;

    if (patch.order !== undefined) {
      const value = String(patch.order || '').trim().toLowerCase();
      if (!VALID_ORDERS.includes(value)) {
        return { ok: false, error: `Unknown slideshow order: ${patch.order || '(none)'}` };
      }
      nextOrder = value;
      touched = true;
    }

    if (patch.secondsPerPhoto !== undefined) {
      const n = Number(patch.secondsPerPhoto);
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'secondsPerPhoto must be a number between 5 and 60' };
      }
      nextSeconds = clampSecondsPerPhoto(n);
      touched = true;
    }

    if (!touched) {
      return { ok: false, error: 'No slideshow settings to update' };
    }

    order = nextOrder;
    secondsPerPhoto = nextSeconds;
    persist();
    return { ok: true, order, secondsPerPhoto };
  }

  return {
    get,
    getOrder,
    getSecondsPerPhoto,
    setOrder,
    setSecondsPerPhoto,
    update,
  };
}

module.exports = {
  createSlideshowSettings,
  VALID_ORDERS,
  DEFAULT_ORDER,
  DEFAULT_SECONDS_PER_PHOTO,
  MIN_SECONDS_PER_PHOTO,
  MAX_SECONDS_PER_PHOTO,
  clampSecondsPerPhoto,
};
