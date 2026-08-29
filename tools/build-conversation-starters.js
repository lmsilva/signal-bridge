#!/usr/bin/env node
/**
 * Build the shipped Conversation Starters list.
 *
 * Sources (open / community icebreaker dumps — no runtime API):
 *   1. ParabolInc/icebreakers (MIT, inclusive meeting questions)
 *   2. rendall/icebreakers QUESTIONS.md (community aggregation)
 *
 * Keeps prompts that fold into at most 5×22 under the LET'S TALK title row.
 *
 *   node tools/build-conversation-starters.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'conversation-starters-prompts.json');
const BODY_ROWS = 5;
const BODY_WIDTH = 22;

const SOURCES = [
  {
    id: 'parabol',
    url: 'https://raw.githubusercontent.com/ParabolInc/icebreakers/main/lib/api.ts',
    license: 'MIT',
  },
  {
    id: 'rendall',
    url: 'https://raw.githubusercontent.com/rendall/icebreakers/master/QUESTIONS.md',
    license: 'community aggregation (see upstream)',
  },
];

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai|kill yourself|suicide)\b/i;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'signal-bridge-conversation-starters-build' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} → HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function cleanText(value) {
  return String(value || '')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function usable(text) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length < 12) {
    return null;
  }
  if (PROFANITY.test(cleaned)) {
    return null;
  }
  // Prefer questions / prompts, not one-word answers.
  if (!/[?]/.test(cleaned) && cleaned.split(/\s+/).length < 5) {
    return null;
  }
  const folded = fold(cleaned);
  if (!folded || folded.length < 10) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { text: cleaned, lines: lines.length };
}

function parseParabol(source) {
  const out = [];
  const re = /question:\s*\n?\s*"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    out.push(cleanText(match[1]));
  }
  // Also catch single-line question: "..."
  const re2 = /question:\s*"((?:\\.|[^"\\])*)"/g;
  while ((match = re2.exec(source)) !== null) {
    out.push(cleanText(match[1]));
  }
  return out;
}

function parseRendall(source) {
  const out = [];
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    // Markdown list items: - question? or * question?
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      out.push(cleanText(bullet[1].replace(/^#+\s*/, '')));
      continue;
    }
    // Numbered: 1. question?
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      out.push(cleanText(numbered[1]));
    }
  }
  return out;
}

function stableId(text) {
  const digest = crypto.createHash('sha1').update(text.toLowerCase()).digest('hex').slice(0, 12);
  return `cs-${digest}`;
}

async function main() {
  const seen = new Set();
  const prompts = [];
  const stats = { fetched: 0, kept: 0, dropped: 0 };

  for (const source of SOURCES) {
    process.stderr.write(`Fetching ${source.id}…\n`);
    const body = await fetchText(source.url);
    const raw = source.id === 'parabol' ? parseParabol(body) : parseRendall(body);
    stats.fetched += raw.length;
    for (const text of raw) {
      const next = usable(text);
      if (!next) {
        stats.dropped += 1;
        continue;
      }
      const key = fold(next.text).toLowerCase();
      if (seen.has(key)) {
        stats.dropped += 1;
        continue;
      }
      seen.add(key);
      prompts.push({
        id: stableId(next.text),
        text: next.text,
        source: source.id,
      });
      stats.kept += 1;
    }
  }

  prompts.sort((a, b) => a.text.localeCompare(b.text));

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    sources: SOURCES.map((row) => ({ id: row.id, url: row.url, license: row.license })),
    count: prompts.length,
    prompts,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  process.stderr.write(
    `Wrote ${prompts.length} board-fit starters → ${path.relative(process.cwd(), OUT)}\n`
    + `fetched=${stats.fetched} kept=${stats.kept} dropped=${stats.dropped}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
