/**
 * Append-only activity log for the Display Scheduler (display-scheduler.md §5, §8).
 *
 * Roughly 2,900 events a day at a 30-second tick with ten rules, because we log
 * every skip — skips are the whole diagnostic value of the activity page (§8).
 * Files are partitioned by local date (`YYYY-MM-DD.jsonl`) so honouring
 * `historyRetentionDays` is a directory listing and an unlink, not a table scan.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUTCOMES = [
  'aired',
  'lost-dice',
  'lost-tiebreak',
  'expired-pending',
  'blocked-guard',
  'blocked-cooldown',
  'blocked-window',
  'blocked-cap',
  'blocked-display',
  'blocked-quiet-hours',
  'blocked-global-gap',
  'error',
  'disabled',
];

/** Outcomes where the rule genuinely contested the display (§8.3 hit rate). */
const CONTESTED_OUTCOMES = new Set(['aired', 'lost-dice', 'lost-tiebreak']);

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Local calendar parts for a UTC instant.
 *
 * Windows, quiet hours, the daily counter and the heatmap all run on the wall
 * clock a person reads, so every one of them goes through here. Doing the maths
 * on UTC hours breaks twice a year (§11.8).
 */
function localParts(ms, timeZone) {
  const date = new Date(ms);
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    weekday: weekdays[pick('weekday')] ?? new Date(ms).getDay(),
  };
}

function localDateKey(ms, timeZone) {
  const parts = localParts(ms, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function minutesOfDay(parts) {
  return parts.hour * 60 + parts.minute;
}

function hhmmToMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Inclusive of start, exclusive of end; wraps past midnight (23:00–07:00). */
function withinWindow(ms, window, timeZone) {
  const start = hhmmToMinutes(window?.start);
  const end = hhmmToMinutes(window?.end);
  if (start == null || end == null) {
    return true;
  }
  const current = minutesOfDay(localParts(ms, timeZone));
  if (start === end) {
    return true;
  }
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function createActivityLog(
  directory,
  // `now` is injected so the log shares the engine's clock. A virtual-clock
  // test writes events dated months away from wall time, and a query anchored
  // to `Date.now()` would silently return nothing.
  { log = console, timeZone = null, now = () => Date.now() } = {},
) {
  // Buffer the current day in memory: the timeline re-reads the last 24 hours
  // on every poll, and re-parsing a 3,000-line file each time is wasteful.
  let cacheKey = null;
  let cache = [];

  function fileFor(dateKey) {
    return path.join(directory, `${dateKey}.jsonl`);
  }

  function readDay(dateKey) {
    if (dateKey === cacheKey) {
      return cache;
    }
    let events = [];
    try {
      const raw = fs.readFileSync(fileFor(dateKey), 'utf8');
      events = raw.split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            // One corrupt line must not lose the rest of the day.
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      events = [];
    }
    return events;
  }

  function record(event) {
    const at = event.at || new Date(now()).toISOString();
    const full = {
      id: event.id || crypto.randomUUID(),
      ruleId: String(event.ruleId || ''),
      at,
      outcome: event.outcome,
      ...(event.score != null ? { score: Number(event.score.toFixed?.(4) ?? event.score) } : {}),
      ...(event.rolledValue != null ? { rolledValue: event.rolledValue } : {}),
      ...(event.competingRuleIds?.length ? { competingRuleIds: event.competingRuleIds } : {}),
      ...(event.durationSeconds != null ? { durationSeconds: event.durationSeconds } : {}),
      ...(event.interrupted ? { interrupted: true } : {}),
      ...(event.detail ? { detail: String(event.detail).slice(0, 400) } : {}),
      ...(event.target ? { target: String(event.target) } : {}),
      ...(Array.isArray(event.boardOutcomes) && event.boardOutcomes.length
        ? { boardOutcomes: event.boardOutcomes } : {}),
    };
    const dateKey = localDateKey(Date.parse(at), timeZone);
    if (dateKey !== cacheKey) {
      // Load before claiming the key: `readDay` short-circuits to the cache
      // whenever the key matches, so assigning first hands back yesterday's
      // events as today's and every query counts them twice.
      cache = readDay(dateKey);
      cacheKey = dateKey;
    }
    cache.push(full);
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.appendFileSync(fileFor(dateKey), `${JSON.stringify(full)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.('Could not append scheduler activity', error?.message || error);
    }
    return full;
  }

  /** Amend an already-written event — used when a variable-duration airing ends. */
  function amend(eventId, patch) {
    if (!eventId || !cacheKey) {
      return null;
    }
    const index = cache.findIndex((event) => event.id === eventId);
    if (index < 0) {
      return null;
    }
    cache[index] = { ...cache[index], ...patch };
    try {
      // JSONL has no in-place update; rewriting the day file is cheap at this
      // size and keeps the file an honest reflection of the cache.
      fs.writeFileSync(
        fileFor(cacheKey),
        cache.map((event) => JSON.stringify(event)).join('\n') + '\n',
        'utf8',
      );
    } catch (error) {
      log?.warn?.('Could not amend scheduler activity', error?.message || error);
    }
    return cache[index];
  }

  function dateKeysBetween(fromMs, toMs) {
    const keys = [];
    const oneDay = 24 * 60 * 60 * 1000;
    // Walk from a day early to a day late so a timezone offset cannot clip the
    // edges of the requested range.
    for (let ms = fromMs - oneDay; ms <= toMs + oneDay; ms += oneDay) {
      const key = localDateKey(ms, timeZone);
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  function query({ from, to, ruleId, outcomes, limit = 5000 } = {}) {
    const toMs = to ? Date.parse(to) : now();
    const fromMs = from ? Date.parse(from) : toMs - 24 * 60 * 60 * 1000;
    const wanted = outcomes?.length ? new Set(outcomes) : null;
    const results = [];
    for (const key of dateKeysBetween(fromMs, toMs)) {
      for (const event of readDay(key)) {
        const at = Date.parse(event.at);
        if (!(at >= fromMs && at <= toMs)) continue;
        if (ruleId && event.ruleId !== ruleId) continue;
        if (wanted && !wanted.has(event.outcome)) continue;
        results.push(event);
      }
    }
    results.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return results.length > limit ? results.slice(-limit) : results;
  }

  /**
   * Pre-aggregated per-rule figures (§10): the client must never be handed
   * 30 days of raw events to reduce itself.
   */
  function stats({ from, to, ruleId } = {}) {
    const events = query({ from, to, ruleId, limit: Number.MAX_SAFE_INTEGER });
    const perRule = new Map();
    for (const event of events) {
      if (!perRule.has(event.ruleId)) {
        perRule.set(event.ruleId, {
          ruleId: event.ruleId,
          aired: 0,
          evaluations: 0,
          contested: 0,
          outcomes: {},
          airedAt: [],
          totalDurationSeconds: 0,
          boards: {},
        });
      }
      const bucket = perRule.get(event.ruleId);
      bucket.evaluations += 1;
      bucket.outcomes[event.outcome] = (bucket.outcomes[event.outcome] || 0) + 1;
      if (CONTESTED_OUTCOMES.has(event.outcome)) {
        bucket.contested += 1;
      }
      if (event.outcome === 'aired') {
        bucket.aired += 1;
        bucket.airedAt.push(Date.parse(event.at));
        bucket.totalDurationSeconds += Number(event.durationSeconds || 0);
      }
      for (const row of event.boardOutcomes || []) {
        const boardId = String(row.boardId || row.id || '').trim();
        if (!boardId) {
          continue;
        }
        const reason = String(row.reason || (row.skipped ? 'skipped' : 'posted'));
        if (!bucket.boards[boardId]) {
          bucket.boards[boardId] = {};
        }
        bucket.boards[boardId][reason] = (bucket.boards[boardId][reason] || 0) + 1;
      }
    }

    return [...perRule.values()].map((bucket) => {
      const gaps = [];
      for (let i = 1; i < bucket.airedAt.length; i += 1) {
        gaps.push((bucket.airedAt[i] - bucket.airedAt[i - 1]) / 1000);
      }
      // Name the dominant reason a rule under-aired rather than just showing a
      // discrepancy — "21 skipped, nothing was playing" (§8.3).
      const blocking = Object.entries(bucket.outcomes)
        .filter(([outcome]) => outcome !== 'aired')
        .sort((a, b) => b[1] - a[1])[0];
      return {
        ruleId: bucket.ruleId,
        aired: bucket.aired,
        evaluations: bucket.evaluations,
        outcomes: bucket.outcomes,
        hitRate: bucket.contested ? bucket.aired / bucket.contested : null,
        avgGapSeconds: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
        longestGapSeconds: gaps.length ? Math.round(Math.max(...gaps)) : null,
        totalDurationSeconds: Math.round(bucket.totalDurationSeconds),
        dominantSkip: blocking ? { outcome: blocking[0], count: blocking[1] } : null,
        boards: Object.keys(bucket.boards).length ? bucket.boards : undefined,
      };
    }).sort((a, b) => b.aired - a.aired);
  }

  /** Days (rows) × hours (columns) airing counts for the patterns grid (§8.4). */
  function heatmap({ days = 14, ruleId } = {}) {
    const nowMs = now();
    const oneDay = 24 * 60 * 60 * 1000;
    const rows = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const dayMs = nowMs - offset * oneDay;
      const key = localDateKey(dayMs, timeZone);
      const hours = new Array(24).fill(0);
      for (const event of readDay(key)) {
        if (event.outcome !== 'aired') continue;
        if (ruleId && event.ruleId !== ruleId) continue;
        hours[localParts(Date.parse(event.at), timeZone).hour] += 1;
      }
      rows.push({ date: key, weekday: localParts(dayMs, timeZone).weekday, hours });
    }
    return rows;
  }

  /** Daily airing counts per rule, for the §8.3 sparklines. */
  function dailySeries({ days = 7, ruleId } = {}) {
    const nowMs = now();
    const oneDay = 24 * 60 * 60 * 1000;
    const series = new Map();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const key = localDateKey(nowMs - offset * oneDay, timeZone);
      const index = days - 1 - offset;
      for (const event of readDay(key)) {
        if (event.outcome !== 'aired') continue;
        if (ruleId && event.ruleId !== ruleId) continue;
        if (!series.has(event.ruleId)) {
          series.set(event.ruleId, new Array(days).fill(0));
        }
        series.get(event.ruleId)[index] += 1;
      }
    }
    return Object.fromEntries(series);
  }

  /** Nightly prune — `historyRetentionDays` is a file delete, by design. */
  function prune(retentionDays = 30) {
    const cutoff = localDateKey(now() - retentionDays * 24 * 60 * 60 * 1000, timeZone);
    let removed = 0;
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!name.endsWith('.jsonl')) continue;
        if (name.slice(0, 10) < cutoff) {
          fs.unlinkSync(path.join(directory, name));
          removed += 1;
        }
      }
    } catch {
      // Directory may not exist yet.
    }
    return removed;
  }

  return {
    record, amend, query, stats, heatmap, dailySeries, prune,
    directory,
    invalidate: () => { cacheKey = null; cache = []; },
  };
}

module.exports = {
  OUTCOMES,
  CONTESTED_OUTCOMES,
  localParts,
  localDateKey,
  minutesOfDay,
  hhmmToMinutes,
  withinWindow,
  createActivityLog,
};
