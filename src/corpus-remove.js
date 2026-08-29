'use strict';

/**
 * Shared house-edit remove for shipped+custom corpora (Chuck, Amazing Facts, …).
 * Custom rows are deleted. Shipped rows are recorded in `removedIds` so they
 * leave the manage list and the rotation (Hide remains a reversible suppress).
 */
function applyCorpusRemove(settings = {}, key, { isShipped = false } = {}) {
  const id = String(key || '').trim();
  if (!id) {
    return { ok: false, error: 'Missing id' };
  }
  const custom = (settings.custom || []).filter((row) => row.id !== id);
  const wasCustom = custom.length !== (settings.custom || []).length;
  if (!wasCustom && !isShipped) {
    return { ok: false, error: 'Unknown item' };
  }
  const overrides = { ...(settings.overrides || {}) };
  delete overrides[id];
  return {
    ok: true,
    patch: {
      custom,
      hiddenIds: (settings.hiddenIds || []).filter((item) => item !== id),
      removedIds: wasCustom
        ? (settings.removedIds || []).filter((item) => item !== id)
        : [...new Set([...(settings.removedIds || []), id])],
      recentIds: (settings.recentIds || []).filter((item) => item !== id),
      overrides,
    },
  };
}

module.exports = {
  applyCorpusRemove,
};
