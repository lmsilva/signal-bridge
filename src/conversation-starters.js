/**
 * Conversation Starters — pick a shipped (or house-edited) prompt for the board.
 *
 * Corpus is local JSON from open icebreaker dumps. No network at runtime.
 */

const crypto = require('crypto');
const SHIPPED = require('./conversation-starters-prompts.json');
const { cleanText, createConversationStartersSettings } = require('./conversation-starters-settings');
const { fold, wrap } = require('./vestaboard/encoder');

const TYPE = 'talk.starters';
const BODY_ROWS = 5;
const BODY_WIDTH = 22;

function loadShipped() {
  return Array.isArray(SHIPPED?.prompts) ? SHIPPED.prompts : [];
}

function promptRows(text) {
  const folded = fold(cleanText(text));
  if (!folded) {
    return [];
  }
  return wrap(folded, BODY_WIDTH);
}

function fitsBoard(text) {
  const lines = promptRows(text);
  return lines.length > 0 && lines.length <= BODY_ROWS * 2;
}

function newCustomId() {
  return `custom-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function resolvePrompts(settings = {}) {
  const hidden = new Set(settings.hiddenIds || []);
  const overrides = settings.overrides || {};
  const rows = [];

  for (const prompt of loadShipped()) {
    const id = String(prompt.id || '').trim();
    if (!id) {
      continue;
    }
    const text = cleanText(overrides[id] != null ? overrides[id] : prompt.text);
    rows.push({
      id,
      text,
      custom: false,
      hidden: hidden.has(id),
      rows: promptRows(text).length,
      source: prompt.source || 'shipped',
    });
  }

  for (const prompt of settings.custom || []) {
    const id = String(prompt.id || '').trim();
    const text = cleanText(prompt.text);
    if (!id || !text) {
      continue;
    }
    rows.push({
      id,
      text,
      custom: true,
      hidden: false,
      rows: promptRows(text).length,
      source: 'custom',
    });
  }

  return rows;
}

function matchingPrompts(settings = {}) {
  return resolvePrompts(settings).filter((prompt) => !prompt.hidden && prompt.text && prompt.rows > 0);
}

function pickPrompt(settings = {}, { random = Math.random } = {}) {
  const pool = matchingPrompts(settings);
  if (!pool.length) {
    return null;
  }
  const recent = new Set(settings.recentIds || []);
  const fresh = pool.filter((prompt) => !recent.has(prompt.id));
  const choices = fresh.length ? fresh : pool;
  const index = Math.min(choices.length - 1, Math.floor(Number(random()) * choices.length));
  return choices[Math.max(0, index)] || null;
}

function buildConversationStartersPayload(prompt, { asOf } = {}) {
  const text = cleanText(prompt?.text);
  if (!text) {
    return null;
  }
  return {
    type: TYPE,
    asOf: asOf || new Date().toISOString(),
    prompt: {
      id: prompt.id || '',
      text,
    },
  };
}

function listPrompts(settings = {}, { query = '', hidden = false, page = 1, pageSize = 20 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  let rows = resolvePrompts(settings);
  if (!hidden) {
    rows = rows.filter((prompt) => !prompt.hidden);
  }
  if (needle) {
    rows = rows.filter((prompt) => prompt.text.toLowerCase().includes(needle)
      || prompt.id.toLowerCase().includes(needle));
  }
  const size = Math.min(50, Math.max(5, Number(pageSize) || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    query: needle,
    page: current,
    pageSize: size,
    pages,
    total,
    prompts: rows.slice(start, start + size),
  };
}

function createConversationStarters(config, log) {
  const settingsApi = createConversationStartersSettings(config, log);

  function snapshot(extra = {}) {
    const settings = settingsApi.get();
    const all = resolvePrompts(settings);
    return {
      available: all.filter((prompt) => !prompt.hidden && prompt.rows > 0).length,
      total: loadShipped().length + settings.custom.length,
      customCount: settings.custom.length,
      hiddenCount: settings.hiddenIds.length,
      ...extra,
    };
  }

  return {
    getSettings: () => settingsApi.get(),
    statusSnapshot(query) {
      const settings = settingsApi.get();
      return snapshot(listPrompts(settings, query));
    },
    addPrompt(text) {
      const next = cleanText(text);
      if (!next) {
        return { ok: false, error: 'Type a conversation starter' };
      }
      const settings = settingsApi.get();
      const custom = [...settings.custom, { id: newCustomId(), text: next }];
      settingsApi.update({ custom });
      return { ok: true, ...this.statusSnapshot() };
    },
    updatePrompt(id, { text, hidden } = {}) {
      const key = String(id || '').trim();
      if (!key) {
        return { ok: false, error: 'Missing prompt id' };
      }
      const settings = settingsApi.get();
      const customIndex = settings.custom.findIndex((row) => row.id === key);
      const shipped = loadShipped().some((row) => row.id === key);

      if (customIndex >= 0) {
        const custom = [...settings.custom];
        if (hidden) {
          custom.splice(customIndex, 1);
        } else if (text != null) {
          const next = cleanText(text);
          if (!next) {
            return { ok: false, error: 'Type a conversation starter' };
          }
          custom[customIndex] = { ...custom[customIndex], text: next };
        }
        settingsApi.update({ custom });
        return { ok: true, ...this.statusSnapshot() };
      }

      if (!shipped) {
        return { ok: false, error: 'Unknown prompt' };
      }

      const hiddenIds = new Set(settings.hiddenIds);
      const overrides = { ...settings.overrides };
      if (hidden === true) {
        hiddenIds.add(key);
      } else if (hidden === false) {
        hiddenIds.delete(key);
      }
      if (text != null) {
        const next = cleanText(text);
        if (!next) {
          return { ok: false, error: 'Type a conversation starter' };
        }
        const original = loadShipped().find((row) => row.id === key);
        if (original && cleanText(original.text) === next) {
          delete overrides[key];
        } else {
          overrides[key] = next;
        }
      }
      settingsApi.update({
        hiddenIds: [...hiddenIds],
        overrides,
      });
      return { ok: true, ...this.statusSnapshot() };
    },
    nextPayload(options = {}) {
      const settings = settingsApi.get();
      const prompt = pickPrompt(settings, options);
      if (!prompt) {
        return null;
      }
      settingsApi.remember(prompt.id);
      return buildConversationStartersPayload(prompt, options);
    },
  };
}

module.exports = {
  TYPE,
  BODY_ROWS,
  BODY_WIDTH,
  loadShipped,
  promptRows,
  fitsBoard,
  resolvePrompts,
  matchingPrompts,
  pickPrompt,
  listPrompts,
  buildConversationStartersPayload,
  createConversationStarters,
};
