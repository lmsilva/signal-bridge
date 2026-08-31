#!/usr/bin/env node
/**
 * Build the shipped Periodic Table corpus.
 *
 *   node tools/build-periodic-table.js
 *
 * Validates every element against the Vestaboard layout before shipping.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  elementLines,
  elementHeadline,
  categoryLabel,
  formatWeight,
  fitsBoard,
  COLS,
} = require('../src/periodic-table-layout');
const RAW = require('./periodic-table-data');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'periodic-table-elements.json');

function cleanId(symbol) {
  return String(symbol || '').trim().toLowerCase();
}

function main() {
  const elements = [];
  const categories = new Map();
  const problems = [];

  for (const row of RAW) {
    const [number, name, symbol, category, weight] = row;
    const element = {
      id: cleanId(symbol),
      number,
      name: String(name || '').trim(),
      symbol: String(symbol || '').trim(),
      category,
      categoryLabel: categoryLabel(category),
      weight,
    };
    if (!element.id || !element.name || !element.symbol) {
      problems.push(`missing fields for ${number}`);
      continue;
    }
    const headline = elementHeadline(element);
    const weightText = formatWeight(element.weight);
    if (!fitsBoard(element)) {
      problems.push(`${headline} (${headline.length}) or ${element.categoryLabel} or ${weightText} exceeds ${COLS}`);
      continue;
    }
    if (headline.length > COLS) {
      problems.push(`${headline} headline too long (${headline.length})`);
      continue;
    }
    if (element.categoryLabel.length > COLS) {
      problems.push(`${element.categoryLabel} category too long`);
      continue;
    }
    if (weightText.length > COLS) {
      problems.push(`${weightText} weight too long`);
      continue;
    }
    elements.push(element);
    categories.set(category, (categories.get(category) || 0) + 1);
  }

  elements.sort((a, b) => a.number - b.number);

  if (elements.length !== 118) {
    throw new Error(`Expected 118 elements, got ${elements.length}${problems.length ? ` (${problems.join('; ')})` : ''}`);
  }
  if (problems.length) {
    throw new Error(problems.join('\n'));
  }

  const payload = {
    source: 'IUPAC standard periodic table (2021 atomic weights)',
    builtAt: new Date().toISOString(),
    elementCount: elements.length,
    categories: [...categories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: categoryLabel(id), count })),
    elements,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  process.stderr.write(`Wrote ${elements.length} elements to ${path.relative(ROOT, OUT)}\n`);
}

main();
