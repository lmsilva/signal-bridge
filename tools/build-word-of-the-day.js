#!/usr/bin/env node
/**
 * Build the shipped Word of the Day corpus.
 *
 *   node tools/build-word-of-the-day.js
 *
 * Sources:
 *   - curated seed (marketplace golden frames + board-fit vocabulary)
 *   - mhollingshead/open-dictionary (Wiktionary, CC BY-SA) — cached zip
 *
 * Only board-fit, family-safe entries ship. No network at runtime.
 */

'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  fitsBoard,
  wordHeadline,
  definitionLines,
  posLabel,
  cleanText,
} = require('../src/word-of-the-day-layout');
const SEED = require('./word-of-the-day-seed');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.word-of-the-day');
const OUT = path.join(ROOT, 'src', 'word-of-the-day-words.json');
const OPEN_DICT_ZIP = 'https://github.com/mhollingshead/open-dictionary/archive/refs/heads/main.zip';
const TARGET_MIN = 1200;

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

function normalizePos(pos) {
  const key = String(pos || '').trim().toLowerCase();
  if (key.startsWith('noun')) {
    return 'noun';
  }
  if (key.startsWith('verb')) {
    return 'verb';
  }
  if (key.startsWith('adj')) {
    return 'adj';
  }
  if (key.startsWith('adv')) {
    return 'adverb';
  }
  if (key.startsWith('prep')) {
    return 'prep';
  }
  if (key.startsWith('conj')) {
    return 'conj';
  }
  if (key.startsWith('pron')) {
    return 'pronoun';
  }
  if (key.startsWith('interj')) {
    return 'interjection';
  }
  return 'noun';
}

function cleanId(word) {
  return String(word || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function wordId(word, pos) {
  const hash = crypto.createHash('sha1')
    .update(`${word}|${pos}`)
    .digest('hex')
    .slice(0, 10);
  return `wod-${cleanId(word) || 'word'}-${hash}`;
}

function addEntry(map, word, pos, definition, source) {
  const cleanedWord = cleanText(word).toLowerCase();
  const cleanedDef = cleanText(definition);
  const cleanedPos = normalizePos(pos);
  if (!cleanedWord || !cleanedDef || !/^[a-z][a-z'-]*$/i.test(cleanedWord)) {
    return false;
  }
  if (cleanedWord.length > 16) {
    return false;
  }
  if (PROFANITY.test(`${cleanedWord} ${cleanedDef}`)) {
    return false;
  }
  if (/\b(surname|given name|plural of|initialism|abbreviation|alternative form of|obsolete form)\b/i.test(cleanedDef)) {
    return false;
  }
  if (!fitsBoard(cleanedWord, cleanedPos, cleanedDef)) {
    return false;
  }
  const id = wordId(cleanedWord, cleanedPos);
  if (map.has(id)) {
    return false;
  }
  map.set(id, {
    id,
    word: cleanedWord,
    pos: cleanedPos,
    posLabel: posLabel(cleanedPos),
    definition: cleanedDef,
    headline: wordHeadline(cleanedWord, cleanedPos),
    lines: definitionLines(cleanedDef).length,
    source,
  });
  return true;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  process.stderr.write(`Downloading ${path.basename(dest)} … `);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  process.stderr.write(`${Math.round(buffer.length / 1024)} KB\n`);
  return dest;
}

function extractZip(zipPath, destDir) {
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length) {
    return destDir;
  }
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'inherit' });
  }
  return destDir;
}

function walkJsonFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

function firstDefinition(entry = {}) {
  for (const etymology of entry.etymologies || []) {
    for (const block of etymology.partsOfSpeech || []) {
      for (const sense of block.senses || []) {
        let text = cleanText(sense.sense);
        text = text.replace(/^\([^)]+\)\s*/, '');
        if (!text || text.length > 72) {
          continue;
        }
        if (PROFANITY.test(text)) {
          continue;
        }
        if (/^[A-Z][a-zA-Z'-]+$/.test(text)) {
          continue;
        }
        return {
          pos: normalizePos(block.partOfSpeech),
          definition: text.charAt(0).toUpperCase() + text.slice(1),
        };
      }
    }
  }
  return null;
}

function loadOpenDictionary(rootDir) {
  const apiRoot = path.join(rootDir, 'open-dictionary-main', 'api');
  if (!fs.existsSync(apiRoot)) {
    throw new Error(`Open Dictionary api/ folder missing under ${rootDir}`);
  }
  const files = walkJsonFiles(apiRoot);
  const rows = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const [key, entry] of Object.entries(parsed)) {
      const word = cleanText(entry?.word || key).toLowerCase();
      if (!word || word.includes(' ') || word.length > 16) {
        continue;
      }
      const picked = firstDefinition(entry);
      if (!picked) {
        continue;
      }
      rows.push({ word, ...picked });
    }
  }
  return rows;
}

async function main() {
  const map = new Map();
  let seedCount = 0;
  for (const [word, pos, definition] of SEED) {
    if (addEntry(map, word, pos, definition, 'seed')) {
      seedCount += 1;
    }
  }

  const zipPath = path.join(CACHE, 'open-dictionary-main.zip');
  const extractRoot = path.join(CACHE, 'extract');
  await download(OPEN_DICT_ZIP, zipPath);
  extractZip(zipPath, extractRoot);
  const rows = loadOpenDictionary(extractRoot);

  let openCount = 0;
  for (const row of rows) {
    if (addEntry(map, row.word, row.pos, row.definition, 'open-dictionary')) {
      openCount += 1;
    }
  }

  const words = [...map.values()].sort((a, b) => a.word.localeCompare(b.word));
  if (words.length < TARGET_MIN) {
    throw new Error(`Expected at least ${TARGET_MIN} words, got ${words.length} (seed ${seedCount}, open-dictionary ${openCount})`);
  }

  const posCounts = new Map();
  for (const entry of words) {
    posCounts.set(entry.pos, (posCounts.get(entry.pos) || 0) + 1);
  }

  const payload = {
    source: 'open-dictionary (Wiktionary, CC BY-SA) + curated seed',
    builtAt: new Date().toISOString(),
    wordCount: words.length,
    partsOfSpeech: [...posCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: posLabel(id), count })),
    words,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  process.stderr.write(`Wrote ${words.length} words (${seedCount} seed, ${openCount} open-dictionary) to ${path.relative(ROOT, OUT)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
