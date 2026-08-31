#!/usr/bin/env node
/**
 * Build src/word-scramble-words.json from ENABLE1 (public domain).
 *
 *   node tools/build-word-scramble-words.js
 *
 * Downloads https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt
 * unless tools/.enable1/enable1.txt already exists. Keeps A–Z words from three
 * letters up to the sixteen a 4x4 board can spell, sorted so the solver can
 * binary-search.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.enable1', 'enable1.txt');
const OUT = path.join(ROOT, 'src', 'word-scramble-words.json');
const SOURCE = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt';

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'signal-bridge-word-scramble' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`ENABLE1 download failed (${res.statusCode})`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Sixteen, not nine: a path may use every cell, so capping shorter than the
 * board can spell quietly makes the best finds on a grid unplayable.
 */
const MAX_LETTERS = 16;

function filterWords(text) {
  const seen = new Set();
  const out = [];
  const shape = new RegExp(`^[a-z]{3,${MAX_LETTERS}}$`);
  for (const raw of String(text || '').split(/\r?\n/)) {
    const word = raw.trim().toLowerCase();
    if (!shape.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  out.sort();
  return out;
}

async function main() {
  let text = '';
  if (fs.existsSync(CACHE)) {
    text = fs.readFileSync(CACHE, 'utf8');
  } else {
    process.stderr.write(`Downloading ENABLE1 from ${SOURCE}\n`);
    text = await download(SOURCE);
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, text);
  }
  const words = filterWords(text);
  if (words.length < 1000) {
    throw new Error(`ENABLE1 filter produced only ${words.length} words`);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(words)}\n`);
  process.stderr.write(`Wrote ${words.length} words to ${path.relative(ROOT, OUT)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
