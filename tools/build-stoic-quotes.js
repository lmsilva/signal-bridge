#!/usr/bin/env node
/**
 * Build the shipped Stoic Quotes list.
 *
 * Primary source: benhoneywill/stoic-quotes (MIT) — Marcus Aurelius, Seneca,
 * Epictetus, and a few later Stoic-adjacent voices. Also merges
 * rishabkumar7/stoic-quotes when present.
 *
 * Keeps quotes that fold into at most 4×22 under the STOIC title, leaving one
 * body row for the author line.
 *
 *   node tools/build-stoic-quotes.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { fold, wrap, encodeText } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'stoic-quotes-quotes.json');
const QUOTE_ROWS = 4;
const BODY_WIDTH = 22;

const SOURCES = [
  {
    id: 'benhoneywill',
    url: 'https://raw.githubusercontent.com/benhoneywill/stoic-quotes/master/data/quotes.json',
    license: 'MIT',
  },
  {
    id: 'rishabkumar',
    url: 'https://raw.githubusercontent.com/rishabkumar7/stoic-quotes/main/data/quotes.json',
    license: 'MIT',
  },
];

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'signal-bridge-stoic-quotes-build' },
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

function cleanAuthor(value) {
  return cleanText(value)
    .replace(/^[-–—]\s*/, '')
    .replace(/\s+/g, ' ');
}

function authorLabel(author) {
  const name = fold(cleanAuthor(author));
  if (!name) {
    return '';
  }
  const withDash = `- ${name}`;
  return encodeText(withDash).length <= BODY_WIDTH ? withDash : name.slice(0, BODY_WIDTH);
}

function usable(text, author) {
  const cleaned = cleanText(text);
  const who = cleanAuthor(author);
  if (!cleaned || cleaned.length < 12 || !who) {
    return null;
  }
  if (PROFANITY.test(cleaned) || PROFANITY.test(who)) {
    return null;
  }
  const folded = fold(cleaned);
  if (!folded || folded.length < 10) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > QUOTE_ROWS) {
    return null;
  }
  if (!authorLabel(who)) {
    return null;
  }
  return { text: cleaned, author: who, lines: lines.length };
}

function parseList(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (Array.isArray(data?.quotes) ? data.quotes : []);
  const out = [];
  for (const row of list) {
    const text = cleanText(row?.text || row?.quote || row?.body);
    const author = cleanAuthor(row?.author || row?.attribution || row?.by);
    if (text && author) {
      out.push({ text, author });
    }
  }
  return out;
}

function stableId(text, author) {
  const digest = crypto.createHash('sha1')
    .update(`${text.toLowerCase()}|${author.toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
  return `sq-${digest}`;
}

async function main() {
  const seen = new Set();
  const quotes = [];
  const stats = { fetched: 0, kept: 0, dropped: 0, sources: [] };

  for (const source of SOURCES) {
    process.stderr.write(`Fetching ${source.id}…\n`);
    let body;
    try {
      body = await fetchText(source.url);
    } catch (error) {
      process.stderr.write(`  skip ${source.id}: ${error.message}\n`);
      continue;
    }
    const raw = parseList(body);
    stats.fetched += raw.length;
    stats.sources.push({ id: source.id, url: source.url, license: source.license, raw: raw.length });
    for (const row of raw) {
      const next = usable(row.text, row.author);
      if (!next) {
        stats.dropped += 1;
        continue;
      }
      const key = `${fold(next.text).toLowerCase()}|${fold(next.author).toLowerCase()}`;
      if (seen.has(key)) {
        stats.dropped += 1;
        continue;
      }
      seen.add(key);
      quotes.push({
        id: stableId(next.text, next.author),
        text: next.text,
        author: next.author,
        source: source.id,
      });
      stats.kept += 1;
    }
  }

  quotes.sort((a, b) => a.author.localeCompare(b.author) || a.text.localeCompare(b.text));

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    quoteRows: QUOTE_ROWS,
    bodyWidth: BODY_WIDTH,
    sources: stats.sources,
    count: quotes.length,
    quotes,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  process.stderr.write(
    `Wrote ${quotes.length} board-fit stoic quotes → ${path.relative(process.cwd(), OUT)}\n`
    + `fetched=${stats.fetched} kept=${stats.kept} dropped=${stats.dropped}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
