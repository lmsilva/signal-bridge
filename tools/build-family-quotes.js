#!/usr/bin/env node
/**
 * Build the shipped Family Quotes list.
 *
 * Source: public quote collections, curated to warm, board-fit lines about
 * family, home, love and kindness.
 *
 *   node tools/build-family-quotes.js raw-quotes.json [more.json ...]
 *
 * Each input is a JSON array of `{ text, author }` (or `{ quote, author }`),
 * or an object with a `quotes` array of the same.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { quoteLines, BODY_ROWS, BODY_WIDTH } = require('../src/family-quotes-layout');

const OUT = path.join(__dirname, '..', 'src', 'family-quotes-quotes.json');
const MIN_LENGTH = 18;

// This card is the warm one. Anything that would land badly over breakfast is
// somebody else's channel.
const BANNED = new RegExp([
  'death', 'died', 'dying', 'funeral', 'grief', 'mourn', 'widow', 'suicide',
  'war\\b', 'kill', 'hate', 'divorce', 'abuse', 'drunk', 'hell\\b', 'damn',
  'fuck', 'shit', 'bitch', 'bastard', 'sex', 'nigg', 'fagg',
].join('|'), 'i');

function clean(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    // A dash standing in for a comma needs its spaces back, or the words
    // either side fuse on the board.
    .replace(/\s*[\u2012-\u2015]\s*/g, ' - ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

/** Expects text and author that have already been through `clean`. */
function usable(text, author) {
  if (!text || text.length < MIN_LENGTH) {
    return null;
  }
  // A quote that needs a second frame stops being a card and becomes a page.
  const lines = quoteLines(text, author);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  // quoteLines folds, and fold() drops anything the board cannot show. If the
  // characters do not survive the round trip, the line was not written for
  // these flaps.
  const flat = lines.join(' ');
  const wanted = `${text}${author ? ` -${author}` : ''}`
    .toUpperCase().replace(/\s+/g, ' ');
  if (flat.replace(/\s+/g, ' ').length !== wanted.length) {
    return null;
  }
  return { key: flat, lines: lines.length };
}

function readSource(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed?.quotes || []);
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    process.stderr.write('Usage: node tools/build-family-quotes.js raw-quotes.json [more.json ...]\n');
    process.exit(1);
  }

  const seen = new Set();
  const quotes = [];
  const dropped = {
    empty: 0, banned: 0, unfit: 0, duplicate: 0, noAuthor: 0,
  };

  for (const input of inputs) {
    for (const row of readSource(input)) {
      const text = clean(row?.text ?? row?.quote);
      const author = clean(row?.author);
      if (!text) {
        dropped.empty += 1;
        continue;
      }
      // The card prints an attribution line; an unattributed quote leaves a
      // hole where a name should be.
      if (!author || /^(unknown|anonymous|anon)\.?$/i.test(author)) {
        dropped.noAuthor += 1;
        continue;
      }
      if (BANNED.test(text) || BANNED.test(author)) {
        dropped.banned += 1;
        continue;
      }
      const fit = usable(text, author);
      if (!fit) {
        dropped.unfit += 1;
        continue;
      }
      if (seen.has(fit.key)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(fit.key);
      // Content-hash ids so a rebuild does not renumber the corpus and orphan
      // every hidden id in the house settings file.
      quotes.push({
        id: `quote-${crypto.createHash('sha1').update(fit.key).digest('hex').slice(0, 10)}`,
        text,
        author,
      });
    }
  }

  quotes.sort((a, b) => a.text.localeCompare(b.text) || a.id.localeCompare(b.id));

  const payload = {
    source: 'Public quote collections, curated.',
    note: 'Warm quotes about family, home, love and kindness. Only quotes that fit one Vestaboard frame (6 rows, wrapped at 21 columns, attribution included).',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    count: quotes.length,
    quotes,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${quotes.length} quotes to ${OUT}\n`
    + `Dropped: ${dropped.banned} banned, ${dropped.unfit} unfit, `
    + `${dropped.noAuthor} unattributed, ${dropped.duplicate} duplicate, ${dropped.empty} empty\n`,
  );
}

main();
