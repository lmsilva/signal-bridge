#!/usr/bin/env node
/**
 * Build the shipped On This Day in History corpus.
 *
 * Primary source: byabbe.se static On This Day JSON (Wikipedia harvest,
 * CC BY-SA). Falls back to the Wikimedia Feed API if a day fails.
 *
 * Keeps events that fold into at most 4×22 under an ON THIS DAY title + date
 * line. Fetches all 366 calendar days (including Feb 29).
 *
 *   node tools/build-on-this-day.js
 *   node tools/build-on-this-day.js --limit-days=3
 *   node tools/build-on-this-day.js --resume
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'on-this-day-events.json');
const BODY_ROWS = 4;
const BODY_WIDTH = 22;
const USER_AGENT = 'SignalBridge/1.0 (local corpus build; on-this-day; contact: house)';
const BYABBE = 'https://byabbe.se/on-this-day';
const WIKIMEDIA = 'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events';
const DELAY_MS = 80;

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function argFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\[[\d\s,]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseYear(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  const bc = /(?:^|\s)(BC|BCE)\s*$/i.test(raw) || /^-/.test(raw);
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    return null;
  }
  const n = Number(digits);
  if (!Number.isFinite(n) || n === 0) {
    return null;
  }
  return bc ? -n : n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function eventId(month, day, year, text) {
  const hash = crypto.createHash('sha1')
    .update(`${pad2(month)}-${pad2(day)}|${year}|${text}`)
    .digest('hex')
    .slice(0, 10);
  return `${pad2(month)}-${pad2(day)}-${year}-${hash}`;
}

function usable(text) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length < 18) {
    return null;
  }
  if (PROFANITY.test(cleaned)) {
    return null;
  }
  const folded = fold(cleaned);
  if (!folded || folded.length < 14) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { text: cleaned, rows: lines.length };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchDay(month, day) {
  try {
    const data = await fetchJson(`${BYABBE}/${month}/${day}/events.json`);
    return (Array.isArray(data.events) ? data.events : []).map((row) => ({
      year: parseYear(row.year),
      text: row.description || row.text || '',
      source: 'byabbe',
    }));
  } catch (byabbeError) {
    const data = await fetchJson(`${WIKIMEDIA}/${pad2(month)}/${pad2(day)}`);
    return (Array.isArray(data.events) ? data.events : []).map((row) => ({
      year: parseYear(row.year),
      text: row.text || '',
      source: 'wikimedia-onthisday',
    }));
  }
}

function allCalendarDays() {
  const out = [];
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= DAYS_IN_MONTH[month]; day += 1) {
      out.push({ month, day });
    }
  }
  return out;
}

function loadResume() {
  try {
    if (!fs.existsSync(OUT)) {
      return [];
    }
    const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  }
}

async function main() {
  const limitDays = Number(argValue('limit-days', '0')) || 0;
  const resume = argFlag('resume');
  let days = allCalendarDays();
  if (limitDays > 0) {
    days = days.slice(0, limitDays);
  }

  const events = resume ? loadResume() : [];
  const seen = new Set(events.map((row) => row.id));
  const doneDays = new Set(events.map((row) => `${pad2(row.month)}-${pad2(row.day)}`));
  let fetched = 0;
  let kept = events.length;
  let skipped = 0;

  for (const { month, day } of days) {
    const key = `${pad2(month)}-${pad2(day)}`;
    if (resume && doneDays.has(key)) {
      fetched += 1;
      continue;
    }
    let rows;
    try {
      rows = await fetchDay(month, day);
    } catch (error) {
      console.error(`Fail ${key}:`, error.message || error);
      await sleep(DELAY_MS * 8);
      try {
        rows = await fetchDay(month, day);
      } catch (retryError) {
        console.error(`Retry fail ${key}:`, retryError.message || retryError);
        await sleep(DELAY_MS);
        continue;
      }
    }
    fetched += 1;
    for (const row of rows) {
      const year = Number(row?.year);
      if (!Number.isFinite(year) || year === 0) {
        skipped += 1;
        continue;
      }
      const fit = usable(row?.text);
      if (!fit) {
        skipped += 1;
        continue;
      }
      const id = eventId(month, day, year, fit.text);
      if (seen.has(id)) {
        skipped += 1;
        continue;
      }
      seen.add(id);
      events.push({
        id,
        month,
        day,
        year,
        text: fit.text,
        source: row.source || 'byabbe',
      });
      kept += 1;
    }
    doneDays.add(key);
    process.stdout.write(
      `\r${key}  kept=${kept}  days=${fetched}/${days.length}   `,
    );
    await sleep(DELAY_MS);
  }
  process.stdout.write('\n');

  events.sort((a, b) => (
    a.month - b.month
    || a.day - b.day
    || a.year - b.year
    || a.text.localeCompare(b.text)
  ));

  const byDay = {};
  for (const event of events) {
    const dayKey = `${pad2(event.month)}-${pad2(event.day)}`;
    byDay[dayKey] = (byDay[dayKey] || 0) + 1;
  }
  const dayCounts = Object.values(byDay);
  const minPerDay = dayCounts.length ? Math.min(...dayCounts) : 0;
  const maxPerDay = dayCounts.length ? Math.max(...dayCounts) : 0;

  const payload = {
    source: 'byabbe.se On This Day (Wikipedia harvest)',
    license: 'CC BY-SA 3.0',
    attribution: 'Text adapted from English Wikipedia via byabbe.se On This Day.',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    eventCount: events.length,
    dayCount: dayCounts.length,
    minPerDay,
    maxPerDay,
    events,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${events.length} events → ${OUT}`);
  console.log(`Days covered: ${dayCounts.length} (min ${minPerDay}, max ${maxPerDay} per day)`);
  console.log(`Skipped unfit/duplicate: ${skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
