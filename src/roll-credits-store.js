const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const MILESTONES = [25, 50, 100, 150, 200, 250, 500, 750, 1000];
const DIFFICULTY_RANK = { easy: 1, normal: 2, hard: 3, brutal: 4 };

// Sortable columns for the management page. Each returns the value to compare;
// `null` means "unknown" and always sinks to the bottom, whichever direction.
const SORT_KEYS = {
  induction: (game) => Number(game.induction) || 0,
  title: (game) => String(game.title || '').trim() || null,
  system: (game) => String(game.system || '').trim() || null,
  beatenAt: (game) => (validDateOnly(game.beatenAt) ? String(game.beatenAt) : null),
  createdAt: (game) => String(game.createdAt || '') || null,
  difficulty: (game) => DIFFICULTY_RANK[
    String(game.meta?.difficulty || '').trim().toLowerCase()
  ] || null,
  releaseDate: (game) => {
    const text = String(game.meta?.releaseDate || '').trim();
    const year = /^(\d{4})/.exec(text);
    if (!year) return null;
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : `${year[1]}-01-01`;
  },
  maxPlayers: (game) => {
    const players = Number(game.meta?.maxPlayers);
    return Number.isFinite(players) && players > 0 ? players : null;
  },
};
const SORT_COLUMNS = Object.keys(SORT_KEYS);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId() {
  return `rc_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validDateOnly(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short' })
    .format(new Date(year, month - 1, 1));
}

function createRollCreditsStore(config = {}, log = console) {
  const root = config.ROOT || path.resolve(__dirname, '..');
  const storePath = path.resolve(
    config.rollCreditsPath
      || config.rollCreditsStorePath
      || path.join(root, 'data', 'roll-credits.json'),
  );
  const systemsPath = path.resolve(
    config.rollCreditsSystemsPath || path.join(__dirname, 'roll-credits-systems.json'),
  );
  let data = { version: VERSION, games: [], order: [], orderManual: false };
  const listeners = new Set();

  function notify(reason, gameId) {
    const event = { reason };
    if (gameId) event.gameId = String(gameId);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        log?.warn?.('Roll Credits store listener failed', error?.message || error);
      }
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function load() {
    try {
      if (!fs.existsSync(storePath)) {
        data = { version: VERSION, games: [], order: [], orderManual: false };
        return data;
      }
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.games)) {
        throw new Error('expected an object with a games array');
      }
      data = {
        version: VERSION,
        games: parsed.games.filter((game) => game && typeof game === 'object'),
        order: Array.isArray(parsed.order) ? parsed.order.map(String) : [],
        orderManual: parsed.orderManual === true,
      };
      resequence();
    } catch (error) {
      data = { version: VERSION, games: [], order: [], orderManual: false };
      log?.warn?.('Could not read Roll Credits store — using an empty library', error?.message || error);
    }
    return data;
  }

  function persist() {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, storePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup; the canonical file remains untouched.
      }
      log?.warn?.('Could not persist Roll Credits store', error?.message || error);
      throw error;
    }
  }

  function loadSystems() {
    try {
      const systems = JSON.parse(fs.readFileSync(systemsPath, 'utf8'));
      return Array.isArray(systems)
        ? systems.slice().sort((a, b) => Number(a.sort) - Number(b.sort))
        : [];
    } catch (error) {
      log?.warn?.('Could not read Roll Credits systems', error?.message || error);
      return [];
    }
  }

  function getSystemById(id) {
    const wanted = String(id || '').trim().toLowerCase();
    return loadSystems().find((system) => system.id === wanted) || null;
  }

  function mapIgdbPlatformToSystem(platformId) {
    const wanted = Number(platformId);
    if (!Number.isFinite(wanted)) {
      return null;
    }
    return loadSystems().find(
      (system) => Array.isArray(system.igdbPlatformIds)
        && system.igdbPlatformIds.map(Number).includes(wanted),
    ) || null;
  }

  // Induction order runs oldest → newest, so induction #1 is the first game you
  // ever beat and the highest number is the most recent one. Games with no beat
  // date sort ahead of every dated game, which parks them at the bottom of the
  // "most recently inducted first" list the UI and the wall both show.
  function autoOrderKey(game) {
    const beaten = validDateOnly(game.beatenAt) ? String(game.beatenAt) : '';
    return [beaten ? '1' : '0', beaten, String(game.createdAt || '')].join('|');
  }

  // Same-day entries can share a createdAt down to the millisecond, so the file
  // position settles ties and keeps numbering stable across reloads.
  function autoOrderedIds() {
    return data.games
      .map((game, index) => ({ game, index }))
      .sort((a, b) => {
        const left = autoOrderKey(a.game);
        const right = autoOrderKey(b.game);
        if (left !== right) return left < right ? -1 : 1;
        return a.index - b.index;
      })
      .map((row) => row.game.id);
  }

  // Slots a game into a manual arrangement at its chronological spot, so adding
  // a back-dated game still lands between the right neighbours after you have
  // hand-sorted the list.
  function insertByDate(order, byId, id) {
    const key = autoOrderKey(byId.get(id));
    const at = order.findIndex((other) => autoOrderKey(byId.get(other)) > key);
    if (at < 0) order.push(id);
    else order.splice(at, 0, id);
  }

  function inductionOrder() {
    if (!data.orderManual) {
      return autoOrderedIds();
    }
    const byId = new Map(data.games.map((game) => [game.id, game]));
    const order = (data.order || []).filter((id) => byId.has(id));
    const placed = new Set(order);
    for (const id of autoOrderedIds()) {
      if (!placed.has(id)) insertByDate(order, byId, id);
    }
    return order;
  }

  // Renumbers every game from the current order. Returns true when something
  // actually moved so callers can skip a needless write.
  function resequence() {
    const order = inductionOrder();
    const byId = new Map(data.games.map((game) => [game.id, game]));
    let changed = order.length !== (data.order || []).length
      || order.some((id, index) => data.order?.[index] !== id);
    order.forEach((id, index) => {
      const game = byId.get(id);
      if (!game) return;
      if (Number(game.induction) !== index + 1) {
        game.induction = index + 1;
        changed = true;
      }
    });
    data.order = order;
    return changed;
  }

  // The management page and the wall both read "most recently inducted first",
  // so reorder requests arrive in that direction too.
  function displayOrder() {
    return [...inductionOrder()].reverse();
  }

  function reorderGames(ids = []) {
    const wanted = Array.isArray(ids) ? ids.map(String) : [];
    if (new Set(wanted).size !== wanted.length) {
      throw new Error('Reorder list repeats a game');
    }
    const display = displayOrder();
    const slots = wanted.map((id) => {
      const at = display.indexOf(id);
      if (at < 0) throw new Error(`Unknown game ${id}`);
      return at;
    }).sort((a, b) => a - b);
    slots.forEach((slot, index) => {
      display[slot] = wanted[index];
    });
    data.order = [...display].reverse();
    data.orderManual = true;
    resequence();
    persist();
    notify('reorder');
    return { manual: true, order: [...data.order] };
  }

  function resetInductionOrder() {
    data.orderManual = false;
    data.order = [];
    resequence();
    persist();
    notify('reorder');
    return { manual: false, order: [...data.order] };
  }

  function isOrderManual() {
    return data.orderManual === true;
  }

  function uniqueId() {
    let id = generateId();
    while (data.games.some((game) => game.id === id)) {
      id = generateId();
    }
    return id;
  }

  function createGame(fields = {}) {
    const now = new Date().toISOString();
    const unknownDate = fields.beatenDateUnknown === true;
    let beatenAt;
    if (unknownDate) {
      beatenAt = null;
    } else if (fields.beatenAt === undefined) {
      beatenAt = localDateString();
    } else {
      beatenAt = validDateOnly(fields.beatenAt) ? String(fields.beatenAt) : null;
    }
    const title = String(fields.title || '').trim();
    const system = String(fields.system || 'other').trim().toLowerCase() || 'other';
    const duplicateWarning = data.games.some(
      (game) => normalizeTitle(game.title) === normalizeTitle(title)
        && String(game.system || '').trim().toLowerCase() === system,
    );
    const game = {
      ...clone(fields),
      id: uniqueId(),
      title,
      system,
      beatenAt,
      beatenDateUnknown: unknownDate || beatenAt === null,
      induction: 0,
      createdAt: now,
      updatedAt: now,
    };
    data.games.push(game);
    resequence();
    persist();
    notify('create', game.id);
    return {
      ...clone(game),
      duplicateWarning,
      warning: duplicateWarning ? 'A game with the same title and system already exists' : null,
    };
  }

  function updateGame(id, patch = {}) {
    const index = data.games.findIndex((game) => game.id === id);
    if (index < 0) {
      return null;
    }
    const existing = data.games[index];
    const next = { ...existing, ...clone(patch) };
    next.id = existing.id;
    next.createdAt = existing.createdAt;
    next.title = String(next.title || '').trim();
    next.system = String(next.system || 'other').trim().toLowerCase() || 'other';
    if (patch.beatenDateUnknown === true) {
      next.beatenAt = null;
      next.beatenDateUnknown = true;
    } else if (patch.beatenAt !== undefined) {
      next.beatenAt = validDateOnly(patch.beatenAt) ? String(patch.beatenAt) : null;
      next.beatenDateUnknown = next.beatenAt === null;
    } else if (patch.beatenDateUnknown === false) {
      next.beatenDateUnknown = false;
    }
    next.updatedAt = new Date().toISOString();
    data.games[index] = next;
    resequence();
    persist();
    notify('update', id);
    return clone(data.games[index]);
  }

  function deleteGame(id) {
    const index = data.games.findIndex((game) => game.id === id);
    if (index < 0) {
      return false;
    }
    data.games.splice(index, 1);
    resequence();
    persist();
    notify('delete', id);
    return true;
  }

  function bulkDelete(ids = []) {
    const requested = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
    const existing = new Set(data.games.map((game) => game.id));
    const deleted = requested.filter((id) => existing.has(id));
    const failed = requested.filter((id) => !existing.has(id));
    if (deleted.length) {
      const deletedSet = new Set(deleted);
      data.games = data.games.filter((game) => !deletedSet.has(game.id));
      resequence();
      persist();
      deleted.forEach((id) => notify('delete', id));
    }
    return { deleted, failed };
  }

  function getGame(id) {
    const game = data.games.find((item) => item.id === id);
    return game ? clone(game) : null;
  }

  function getAllGames() {
    return clone(data.games);
  }

  function compareValues(left, right) {
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  function listGames(options = {}) {
    const sort = SORT_COLUMNS.includes(options.sort) ? options.sort : 'induction';
    const dir = String(options.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const system = String(options.system || '').trim().toLowerCase();
    const yearBeaten = String(options.yearBeaten || '').trim();
    const query = normalizeTitle(options.q);
    const noDate = options.noDate === true || String(options.noDate).toLowerCase() === 'true';
    const requestedPage = Math.max(1, Math.round(Number(options.page) || 1));
    const pageSize = Math.max(1, Math.min(500, Math.round(Number(options.pageSize) || 50)));

    let games = data.games.filter((game) => {
      if (system && String(game.system || '').toLowerCase() !== system) return false;
      if (yearBeaten && !String(game.beatenAt || '').startsWith(`${yearBeaten}-`)) return false;
      if (noDate && validDateOnly(game.beatenAt)) return false;
      if (query) {
        const haystack = normalizeTitle([
          game.title,
          game.system,
          game.beatenWith,
          game.notes,
          game.meta?.publisher,
          game.meta?.developer,
        ].filter(Boolean).join(' '));
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const keyOf = SORT_KEYS[sort];
    games.sort((a, b) => {
      const left = keyOf(a);
      const right = keyOf(b);
      // Unknowns (no beat date, no difficulty, …) always sink to the bottom so
      // flipping the direction never floats a pile of blanks to the top.
      if ((left == null) !== (right == null)) return left == null ? 1 : -1;
      const compared = left == null ? 0 : compareValues(left, right);
      if (compared !== 0) {
        return dir === 'asc' ? compared : -compared;
      }
      return (Number(b.induction) || 0) - (Number(a.induction) || 0);
    });

    const total = games.length;
    const start = (requestedPage - 1) * pageSize;
    return {
      games: clone(games.slice(start, start + pageSize)),
      total,
      page: requestedPage,
      pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
      sort,
      dir,
      orderManual: data.orderManual === true,
    };
  }

  function computeStats(games = data.games) {
    const source = Array.isArray(games) ? games : [];
    const now = new Date();
    const currentYear = String(now.getFullYear());
    const systems = loadSystems();
    const systemLabels = new Map(systems.map((system) => [system.id, system.label]));
    const dated = source.filter((game) => validDateOnly(game.beatenAt));
    const undatedCount = source.length - dated.length;
    const latest = source.reduce((winner, game) => {
      if (!winner) return game;
      const gameInduction = Number(game.induction) || 0;
      const winnerInduction = Number(winner.induction) || 0;
      if (gameInduction !== winnerInduction) {
        return gameInduction > winnerInduction ? game : winner;
      }
      const gameDate = `${validDateOnly(game.beatenAt) ? game.beatenAt : ''}|${game.createdAt || ''}`;
      const winnerDate = `${validDateOnly(winner.beatenAt) ? winner.beatenAt : ''}|${winner.createdAt || ''}`;
      return gameDate > winnerDate ? game : winner;
    }, null);

    const monthlyCounts = new Map();
    for (const game of dated) {
      const key = String(game.beatenAt).slice(0, 7);
      monthlyCounts.set(key, (monthlyCounts.get(key) || 0) + 1);
    }

    const months = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = monthKey(date);
      months.push({ key, label: monthLabel(key), count: monthlyCounts.get(key) || 0 });
    }

    const bySystemCounts = new Map();
    for (const game of source) {
      const id = String(game.system || 'other').toLowerCase();
      bySystemCounts.set(id, (bySystemCounts.get(id) || 0) + 1);
    }
    const rankedSystems = [...bySystemCounts]
      .map(([id, count]) => ({ id, label: systemLabels.get(id) || id || 'Other', count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const bySystem = rankedSystems.slice(0, 8);
    if (rankedSystems.length > 8) {
      bySystem.push({
        id: 'others',
        label: 'Others',
        count: rankedSystems.slice(8).reduce((sum, row) => sum + row.count, 0),
      });
    }

    let bestMonth = null;
    for (const [key, count] of monthlyCounts) {
      if (!bestMonth || count > bestMonth.count || (count === bestMonth.count && key > bestMonth.key)) {
        bestMonth = { key, label: `${monthLabel(key)} ${key.slice(0, 4)}`, count };
      }
    }

    const allMonthKeys = [...monthlyCounts.keys()].sort();
    let streakMonths = 0;
    let runningStreak = 0;
    if (allMonthKeys.length) {
      const first = allMonthKeys[0].split('-').map(Number);
      const last = allMonthKeys[allMonthKeys.length - 1].split('-').map(Number);
      let cursor = new Date(first[0], first[1] - 1, 1);
      const end = new Date(last[0], last[1] - 1, 1);
      while (cursor <= end) {
        if ((monthlyCounts.get(monthKey(cursor)) || 0) > 0) {
          runningStreak += 1;
          streakMonths = Math.max(streakMonths, runningStreak);
        } else {
          runningStreak = 0;
        }
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      }
    }

    const decadeCounts = new Map();
    for (const game of source) {
      const release = String(game.meta?.releaseDate || '');
      const match = release.match(/^(\d{4})/);
      if (!match) continue;
      const decade = Math.floor(Number(match[1]) / 10) * 10;
      decadeCounts.set(decade, (decadeCounts.get(decade) || 0) + 1);
    }
    const decades = [...decadeCounts]
      .sort(([left], [right]) => left - right)
      .map(([decade, count]) => ({ key: `${decade}s`, label: `${decade}s`, count }));
    const milestones = MILESTONES.filter((milestone) => source.length >= milestone);

    const beatenWithCounts = new Map();
    for (const game of source) {
      const name = String(game.beatenWith || '').trim();
      if (!name) continue;
      beatenWithCounts.set(name, (beatenWithCounts.get(name) || 0) + 1);
    }
    const beatenWith = [...beatenWithCounts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 8);

    return {
      total: source.length,
      thisYear: dated.filter((game) => String(game.beatenAt).startsWith(`${currentYear}-`)).length,
      systemsCount: bySystemCounts.size,
      latest: latest ? clone(latest) : null,
      months,
      undatedCount,
      bySystem,
      beatenWith,
      topBeatenWith: beatenWith[0] || null,
      bestMonth,
      avgPerMonthLastYear: Number(
        (months.reduce((sum, bucket) => sum + bucket.count, 0) / 12).toFixed(2),
      ),
      decades,
      streakMonths,
      milestones,
      latestMilestone: milestones.length ? milestones[milestones.length - 1] : null,
    };
  }

  function getSystemUsage() {
    const counts = new Map();
    for (const game of data.games) {
      const id = String(game.system || 'other').toLowerCase();
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return loadSystems()
      .map((system) => ({
        ...system,
        count: counts.get(String(system.id || '').toLowerCase()) || 0,
      }))
      .filter((system) => system.count > 0);
  }

  function getStats() {
    return computeStats(data.games);
  }

  load();

  return {
    createGame,
    updateGame,
    deleteGame,
    bulkDelete,
    getGame,
    listGames,
    getAllGames,
    reorderGames,
    resetInductionOrder,
    isOrderManual,
    inductionOrder,
    displayOrder,
    sortColumns: () => [...SORT_COLUMNS],
    getStats,
    computeStats,
    loadSystems,
    getSystemUsage,
    getSystemById,
    mapIgdbPlatformToSystem,
    onChange,
    storePath,
    dataPath: storePath,
    systemsPath,
    getStorePath: () => storePath,
    getSystemsPath: () => systemsPath,
  };
}

module.exports = {
  createRollCreditsStore,
  generateId,
  normalizeTitle,
  VERSION,
  SORT_COLUMNS,
};
