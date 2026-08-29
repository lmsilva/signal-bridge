#!/usr/bin/env node
/**
 * Build the shipped Chuck Norris fact list.
 *
 * Source: chucknorris.io search dump (ICNDB-derived, hand-curated).
 * We persist a local JSON so the board never calls the API at runtime.
 *
 *   node tools/build-chuck-norris-facts.js [path-to-search.json]
 *
 * Without a file, fetches https://api.chucknorris.io/jokes/search?query=chuck
 */

const fs = require('fs');
const path = require('path');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'chuck-norris-facts.json');
const BODY_ROWS = 5;
const BODY_WIDTH = 22;
const DROP_CATEGORIES = new Set(['explicit']);

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

function usable(text) {
  const folded = fold(text);
  if (!folded || folded.length < 20) {
    return null;
  }
  if (!/\bCHUCK NORRIS\b/.test(folded)) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { folded, lines: lines.length };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function loadDump(filePath) {
  if (filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const url = 'https://api.chucknorris.io/jokes/search?query=chuck';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`chucknorris.io search failed: ${res.status}`);
  }
  return res.json();
}

async function main() {
  const dump = await loadDump(process.argv[2]);
  const seen = new Set();
  const facts = [];
  let dropped = 0;

  for (const row of dump.result || []) {
    const categories = Array.isArray(row.categories) ? row.categories : [];
    if (categories.some((cat) => DROP_CATEGORIES.has(String(cat).toLowerCase()))) {
      dropped += 1;
      continue;
    }
    const text = cleanText(row.value);
    if (!text || PROFANITY.test(text)) {
      dropped += 1;
      continue;
    }
    const fit = usable(text);
    if (!fit) {
      dropped += 1;
      continue;
    }
    if (seen.has(fit.folded)) {
      dropped += 1;
      continue;
    }
    seen.add(fit.folded);
    facts.push({
      id: String(row.id || '').trim() || `fact-${facts.length + 1}`,
      text,
    });
  }

  facts.sort((a, b) => a.text.localeCompare(b.text) || a.id.localeCompare(b.id));

  const payload = {
    source: 'chucknorris.io',
    note: 'Hand-curated ICNDB-derived facts. Explicit/NSFW omitted. Only jokes that fit one Vestaboard frame (5x22 under the title).',
    builtAt: new Date().toISOString(),
    facts,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`Wrote ${facts.length} facts (${dropped} dropped) to ${OUT}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
