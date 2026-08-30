#!/usr/bin/env node
/**
 * Rebuild the shipped European Learn {Language} lexicons.
 *
 * House CEFR rows in tools/learn-language-concepts.js always win (European
 * Portuguese, greetings, phrases). Extra words come from WikDict bilingual
 * SQLite (Wiktionary, CC BY-SA) ranked by importance, which is what gets us
 * from ~360 concepts to a Japanese-sized list. Re-run:
 *
 *   node tools/build-learn-language-words.js
 *
 * Sources:
 *   https://www.wikdict.com/page/download
 *   https://download.wikdict.com/dictionaries/sqlite/2/{pt,es,fr,de,it}-en.sqlite3
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fold, wrap } = require('../src/vestaboard/encoder');
const CONCEPTS = require('./learn-language-concepts');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.wikdict');
const WIKDICT_BASE = 'https://download.wikdict.com/dictionaries/sqlite/2';
const TARGET_MIN = 1300;
const TARGET_MAX = 1800;
const A1_NEW = 800;
const GLOSS_WIDTH = 22;
const WORD_MAX = 22;

const LANGS = [
  { id: 'portuguese', pair: 'pt-en', index: 0 },
  { id: 'spanish', pair: 'es-en', index: 1 },
  { id: 'french', pair: 'fr-en', index: 2 },
  { id: 'german', pair: 'de-en', index: 3 },
  { id: 'italian', pair: 'it-en', index: 4 },
];

const POS_FROM_TEXT = {
  noun: 'noun',
  verb: 'verb',
  adj: 'adj',
  adjective: 'adj',
  adv: 'adverb',
  adverb: 'adverb',
  pronoun: 'pronoun',
  pron: 'pronoun',
  phrase: 'phrase',
  interjection: 'phrase',
  intj: 'phrase',
};

const STOP_NATIVE = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al',
  'le', 'les', 'des', 'du', 'au', 'aux', 'une',
  'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'einer', 'einem', 'einen',
  'il', 'lo', 'gli', 'i', 'un', 'uno', 'una',
  'o', 'os', 'as', 'um', 'uma',
  'the', 'a', 'an',
]);

const STOP_ENGLISH = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from',
  'and', 'or', 'but', 'with', 'as', 'is', 'are', 'was', 'were', 'be',
  'this', 'that', 'these', 'those', 'it',
]);

const PROFANITY = /\b(fuck|shit|cunt|dick|cock|piss|bitch|asshole|slut|whore|nigger|faggot|merde|putain|connerie|scheisse|scheiße|fotze|arschloch|cazzo|stronzo|puttana|caralho|foder|puta|joder|coño)\b/i;

const ADJECTIVES = new Set([
  'good', 'bad', 'big', 'small', 'new', 'old', 'young', 'long', 'short',
  'high', 'low', 'hot', 'cold', 'warm', 'cool', 'happy', 'sad', 'beautiful',
  'ugly', 'easy', 'hard', 'fast', 'slow', 'early', 'late', 'right', 'wrong',
  'true', 'false', 'open', 'closed', 'full', 'empty', 'clean', 'dirty',
  'rich', 'poor', 'strong', 'weak', 'dark', 'light', 'heavy', 'soft',
  'hard', 'red', 'blue', 'green', 'black', 'white', 'yellow', 'nice',
  'great', 'important', 'possible', 'ready', 'sure', 'free', 'next',
  'last', 'first', 'same', 'other', 'different',
]);

const ADVERBS = new Set([
  'very', 'too', 'also', 'only', 'already', 'still', 'almost', 'maybe',
  'here', 'there', 'now', 'then', 'always', 'never', 'often', 'sometimes',
  'today', 'tomorrow', 'yesterday', 'well', 'together', 'again', 'just',
]);

const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'this', 'that', 'who', 'what',
]);

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'word';
}

function findSqlite3() {
  const names = process.platform === 'win32'
    ? ['sqlite3.exe', 'sqlite3']
    : ['sqlite3'];
  for (const name of names) {
    try {
      execFileSync(name, ['-version'], { stdio: 'pipe' });
      return name;
    } catch {
      // try next
    }
  }
  throw new Error('sqlite3 is required to read WikDict (install sqlite3 and re-run)');
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  process.stdout.write(`  downloading ${path.basename(dest)} … `);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  process.stdout.write(`${Math.round(buffer.length / 1024)} KB\n`);
  return dest;
}

function queryJson(sqlite3, db, sql) {
  const raw = execFileSync(sqlite3, ['-json', db, sql], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }
  return JSON.parse(text);
}

function firstGloss(transList) {
  const raw = String(transList || '').trim();
  if (!raw) {
    return '';
  }
  let parts = [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parts = parsed.map((item) => String(item || '').trim());
      }
    } catch {
      parts = [];
    }
  }
  if (!parts.length) {
    parts = raw.split(/\s*[|,;/]\s*/);
  }
  for (const part of parts) {
    let gloss = part.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    gloss = gloss.replace(/^to\s+/i, 'to ');
    if (!gloss || gloss.length > 48) {
      continue;
    }
    if (PROFANITY.test(gloss)) {
      continue;
    }
    const folded = fold(gloss);
    if (!folded || wrap(folded, GLOSS_WIDTH).length > 2) {
      continue;
    }
    if (STOP_ENGLISH.has(gloss.toLowerCase())) {
      continue;
    }
    return gloss;
  }
  return '';
}

function posFromLexentry(lexentry, sense, english) {
  const blob = `${lexentry || ''} ${sense || ''}`.toLowerCase();
  for (const [needle, pos] of Object.entries(POS_FROM_TEXT)) {
    if (blob.includes(needle)) {
      return pos;
    }
  }
  const e = String(english || '').toLowerCase();
  if (/^to [a-z]/.test(e)) {
    return 'verb';
  }
  if (PRONOUNS.has(e)) {
    return 'pronoun';
  }
  if (ADVERBS.has(e) || /ly$/.test(e)) {
    return 'adverb';
  }
  if (ADJECTIVES.has(e)) {
    return 'adj';
  }
  return 'noun';
}

function boardWord(native) {
  const folded = fold(native);
  if (!folded || folded.length < 2 || folded.length > WORD_MAX) {
    return '';
  }
  if (/[0-9]/.test(folded)) {
    return '';
  }
  return folded;
}

function houseWords(langIndex) {
  const seen = new Set();
  const words = [];
  for (const row of CONCEPTS) {
    const [id, english, pos, level, ...forms] = row;
    const native = String(forms[langIndex] || '').trim();
    if (!native || !english) {
      continue;
    }
    let key = `${slug(native)}-${slug(english)}-${String(level).toLowerCase()}`;
    if (seen.has(key)) {
      key = `${slug(id)}-${key}`;
    }
    seen.add(key);
    words.push({
      id: key,
      word: native,
      english,
      pos,
      level,
    });
  }
  return words;
}

function nativeKey(word) {
  return fold(word).toLowerCase();
}

async function buildLanguage(lang, sqlite3) {
  const destDb = path.join(CACHE, `${lang.pair}.sqlite3`);
  await download(`${WIKDICT_BASE}/${lang.pair}.sqlite3`, destDb);

  const rows = queryJson(sqlite3, destDb, `
    SELECT written_rep, trans_list, lexentry, sense, importance, is_good
    FROM translation
    WHERE written_rep IS NOT NULL AND trans_list IS NOT NULL
    ORDER BY importance DESC
    LIMIT 20000
  `);

  const house = houseWords(lang.index);
  const usedNative = new Set(house.map((row) => nativeKey(row.word)));
  const extra = [];

  for (const row of rows) {
    const native = String(row.written_rep || '').trim();
    if (!native || usedNative.has(nativeKey(native))) {
      continue;
    }
    if (STOP_NATIVE.has(native.toLowerCase())) {
      continue;
    }
    if (native.split(/\s+/).length > 3) {
      continue;
    }
    if (!boardWord(native)) {
      continue;
    }
    if (PROFANITY.test(native)) {
      continue;
    }
    const meta = `${row.lexentry || ''} ${row.sense || ''}`;
    if (/\b(proper|surname|given name|place name|toponym)\b/i.test(meta)) {
      continue;
    }
    const english = firstGloss(row.trans_list);
    if (!english) {
      continue;
    }
    if (/^ass$/i.test(english)) {
      continue;
    }
    // "Abkhazia", "Germany" — keep house days/months; drop encyclopedia names.
    if (/^[A-Z][a-zA-ZÀ-ÿ'-]+$/.test(english) && english !== 'I') {
      continue;
    }
    if (lang.id !== 'german' && /^[A-ZÀ-Ý]/.test(native)) {
      continue;
    }
    if (String(row.is_good) === '0') {
      continue;
    }
    const pos = posFromLexentry(row.lexentry, row.sense, english);
    const level = extra.length < A1_NEW ? 'A1' : 'A2';
    extra.push({
      id: `${slug(native)}-${slug(english)}-${level.toLowerCase()}`,
      word: native,
      english,
      pos,
      level,
    });
    usedNative.add(nativeKey(native));
    if (house.length + extra.length >= TARGET_MAX) {
      break;
    }
  }

  const words = [...house, ...extra];
  words.sort((a, b) => a.word.localeCompare(b.word, 'en') || a.id.localeCompare(b.id));
  return { house: house.length, extra: extra.length, words };
}

async function main() {
  const sqlite3 = findSqlite3();
  fs.mkdirSync(CACHE, { recursive: true });
  const srcDir = path.join(ROOT, 'src');
  for (const lang of LANGS) {
    process.stdout.write(`${lang.id}:\n`);
    const built = await buildLanguage(lang, sqlite3);
    if (built.words.length < TARGET_MIN) {
      throw new Error(`${lang.id} only produced ${built.words.length} words (want ≥ ${TARGET_MIN})`);
    }
    const payload = {
      source: 'House CEFR list + WikDict (Wiktionary CC BY-SA, https://www.wikdict.com/)',
      generatedAt: new Date().toISOString().slice(0, 10),
      language: lang.id,
      words: built.words,
    };
    const dest = path.join(srcDir, `learn-${lang.id}-words.json`);
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `  ${built.house} house + ${built.extra} WikDict = ${built.words.length} → ${path.basename(dest)}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
