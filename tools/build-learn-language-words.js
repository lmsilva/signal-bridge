/**
 * Build shipped CEFR lexicons from tools/learn-language-concepts.js.
 *
 * Usage: node tools/build-learn-language-words.js
 */

const fs = require('fs');
const path = require('path');
const CONCEPTS = require('./learn-language-concepts');

const LANGS = [
  { id: 'portuguese', index: 4 },
  { id: 'spanish', index: 5 },
  { id: 'french', index: 6 },
  { id: 'german', index: 7 },
  { id: 'italian', index: 8 },
];

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'word';
}

function buildWords(langIndex) {
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
  words.sort((a, b) => a.word.localeCompare(b.word, 'en') || a.id.localeCompare(b.id));
  return words;
}

function main() {
  const root = path.resolve(__dirname, '..', 'src');
  for (const lang of LANGS) {
    const words = buildWords(lang.index - 4);
    const payload = {
      source: 'House CEFR A1/A2 list (tools/learn-language-concepts.js)',
      generatedAt: new Date().toISOString().slice(0, 10),
      language: lang.id,
      words,
    };
    const dest = path.join(root, `learn-${lang.id}-words.json`);
    fs.writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`${lang.id}: ${words.length} words → ${path.basename(dest)}\n`);
  }
}

main();
