#!/usr/bin/env node
/**
 * Build src/word-scramble-words.json from public-domain English lists.
 *
 *   node tools/build-word-scramble-words.js
 *
 * Merges ENABLE1 (tournament / Scrabble), 12dicts 2of12inf (everyday
 * English and its inflections), and the public-domain words_alpha list
 * so a thorough dictionary word the board can spell is not missing.
 * Keeps A–Z words from three letters up to the sixteen a 4x4 board can
 * spell, sorted so lookups stay a binary search.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.wordlists');
const OUT = path.join(ROOT, 'src', 'word-scramble-words.json');

/**
 * Sixteen, not nine: a path may use every cell, so capping shorter than the
 * board can spell quietly makes the best finds on a grid unplayable.
 */
const MAX_LETTERS = 16;

const SOURCES = [
  {
    id: 'enable1',
    url: 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt',
    // ENABLE1 is one word per line, already lowercase A–Z.
    parse: (text) => text.split(/\r?\n/),
  },
  {
    id: '2of12inf',
    url: 'https://raw.githubusercontent.com/christianp/nulac/master/2of12inf.txt',
    // 12dicts marks inflections with a trailing `%` and some variants with `#`.
    parse: (text) => text.split(/\r?\n/).map((line) => line.replace(/[%#].*$/, '').trim()),
  },
  {
    id: 'words-alpha',
    url: 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt',
    parse: (text) => text.split(/\r?\n/),
  },
];

function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'signal-bridge-word-scramble' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (hops >= 5) {
          reject(new Error(`${url} redirected too many times`));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        download(next, hops + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} failed (${res.statusCode})`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function loadSource(source) {
  const cache = path.join(CACHE_DIR, `${source.id}.txt`);
  let text = '';
  if (fs.existsSync(cache)) {
    text = fs.readFileSync(cache, 'utf8');
  } else {
    process.stderr.write(`Downloading ${source.id} from ${source.url}\n`);
    text = await download(source.url);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cache, text);
  }
  return source.parse(text);
}

function filterWords(lines) {
  const seen = new Set();
  const out = [];
  const shape = new RegExp(`^[a-z]{3,${MAX_LETTERS}}$`);
  for (const raw of lines) {
    const word = String(raw || '').trim().toLowerCase();
    if (!shape.test(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  out.sort();
  return out;
}

async function main() {
  const lines = [];
  for (const source of SOURCES) {
    const part = await loadSource(source);
    process.stderr.write(`  ${source.id}: ${part.length} lines\n`);
    for (const line of part) lines.push(line);
  }
  const words = filterWords(lines);
  if (words.length < 1000) {
    throw new Error(`Word-list filter produced only ${words.length} words`);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(words)}\n`);
  process.stderr.write(`Wrote ${words.length} words to ${path.relative(ROOT, OUT)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
