#!/usr/bin/env node
/**
 * Build the shipped Amazing Facts corpus.
 *
 * Primary source: Royal-lobster/science-facts-project (MIT) — ~10k obscure,
 * verifiable science / trivia facts. Mental Floss has no free API; this dump
 * is the same “wait, really?” vibe without a runtime network call.
 *
 * Keeps facts that fold into at most 5×22 under an AMAZING FACT title.
 *
 *   node tools/build-amazing-facts.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'amazing-facts-facts.json');
const BODY_ROWS = 5;
const BODY_WIDTH = 22;
const SOURCE_URL = 'https://raw.githubusercontent.com/Royal-lobster/science-facts-project/main/facts.json';

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCategory(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw) {
    return '';
  }
  // Prefer the head bucket so botany_plants → botany, microbiology_pathogens → microbiology.
  const head = raw.split('_')[0];
  return (head || raw).slice(0, 40);
}

function factId(text, category) {
  const hash = crypto.createHash('sha1')
    .update(`${category}|${text}`)
    .digest('hex')
    .slice(0, 12);
  return `af-${hash}`;
}

function usable(text) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length < 24) {
    return null;
  }
  if (PROFANITY.test(cleaned)) {
    return null;
  }
  const folded = fold(cleaned);
  if (!folded || folded.length < 18) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { text: cleaned, rows: lines.length, folded };
}

async function main() {
  const res = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent': 'SignalBridge/1.0 (amazing-facts corpus build; local)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`${SOURCE_URL} → HTTP ${res.status}`);
  }
  const dump = await res.json();
  const rows = Array.isArray(dump) ? dump : (dump.facts || dump.data || []);
  const seen = new Set();
  const facts = [];
  const categories = new Map();
  let dropped = 0;

  for (const row of rows) {
    const fit = usable(row?.text || row?.fact || row?.value);
    if (!fit) {
      dropped += 1;
      continue;
    }
    if (seen.has(fit.folded)) {
      dropped += 1;
      continue;
    }
    seen.add(fit.folded);
    const category = cleanCategory(row.category || row.original_category || row.source_file || 'trivia')
      || 'trivia';
    categories.set(category, (categories.get(category) || 0) + 1);
    facts.push({
      id: factId(fit.text, category),
      text: fit.text,
      category,
      source: 'science-facts-project',
    });
  }

  facts.sort((a, b) => a.category.localeCompare(b.category) || a.text.localeCompare(b.text));

  const payload = {
    source: 'Royal-lobster/science-facts-project',
    license: 'MIT',
    attribution: 'Science facts adapted from the open science-facts-project dump (MIT).',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    factCount: facts.length,
    categories: [...categories.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, count })),
    facts,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${facts.length} facts → ${OUT}`);
  console.log(`Categories: ${categories.size}`);
  console.log(`Dropped unfit/duplicate: ${dropped}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
