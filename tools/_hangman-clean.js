'use strict';
const fs = require('fs');
const path = require('path');

const { loadWords, hasWord } = require('../src/word-scramble');

const file = path.join(__dirname, '..', 'src', 'hangman-words.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const dictionary = loadWords();
const seen = new Set();
const dropped = [];

for (const cat of data.categories) {
  const kept = [];
  for (const word of cat.words) {
    if (!/^[A-Z]{4,14}$/.test(word)) { dropped.push(`${cat.id}:${word} (shape)`); continue; }
    if (seen.has(word)) { dropped.push(`${cat.id}:${word} (dupe)`); continue; }
    // A phrase with its spaces taken out (MEASURINGCUP) is not guessable one
    // letter at a time, and the dictionary is the only honest way to tell
    // those from real compounds.
    if (!hasWord(dictionary, word.toLowerCase())) { dropped.push(`${cat.id}:${word} (not a word)`); continue; }
    seen.add(word);
    kept.push(word);
  }
  cat.words = kept.sort();
}

const lines = ['{'];
lines.push(`  "source": ${JSON.stringify(data.source)},`);
lines.push(`  "note": ${JSON.stringify(data.note)},`);
lines.push('  "categories": [');
data.categories.forEach((cat, index) => {
  lines.push('    {');
  lines.push(`      "id": ${JSON.stringify(cat.id)},`);
  lines.push(`      "label": ${JSON.stringify(cat.label)},`);
  lines.push('      "words": [');
  for (let i = 0; i < cat.words.length; i += 6) {
    const row = cat.words.slice(i, i + 6).map((w) => JSON.stringify(w)).join(', ');
    const tail = i + 6 < cat.words.length ? ',' : '';
    lines.push(`        ${row}${tail}`);
  }
  lines.push('      ]');
  lines.push(index === data.categories.length - 1 ? '    }' : '    },');
});
lines.push('  ]');
lines.push('}');

fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
console.log('kept', seen.size, 'words in', data.categories.length, 'categories');
console.log('dropped:', dropped.join(' | ') || 'none');
console.log('shortest', Math.min(...[...seen].map((w) => w.length)), 'longest', Math.max(...[...seen].map((w) => w.length)));
