#!/usr/bin/env node
/**
 * Build the shipped Roast Me! list.
 *
 * Source: public roast/insult collections, curated down to lines that are
 * board-legal, board-shaped and fit to hang in a family kitchen.
 *
 *   node tools/build-roasts.js raw-roasts.json [more.json ...]
 *
 * Each input is either a bare JSON array of strings, or `{ roasts: [...] }`.
 * A `.txt` input is read one roast per line.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'roast-me-roasts.json');
const BODY_ROWS = 6;
const BODY_WIDTH = 22;
const MIN_LENGTH = 18;

// A roast is meant to sting, so "sucks" and "stupid" stay. What cannot go on a
// wall in this house: profanity, slurs, anything sexual, and punching at who
// somebody is rather than at what they just did.
const BANNED = new RegExp([
  'fuck', 'shit', 'asshole', 'a[s5]{2}hat', 'bitch', 'cunt', 'bastard', 'dick',
  'pussy', 'cock', 'prick', 'twat', 'wanker', 'bollock', 'bugger', 'crap',
  'nigg', 'fagg', 'retard', 'spastic', 'tranny', 'dyke', 'chink', 'gypsy',
  'slut', 'whore', 'hoe\\b', 'skank', 'rape', 'incest', 'penis', 'vagina',
  'boob', 'tit\\b', 'tits\\b', 'nipple', 'sperm', 'orgasm', 'masturbat',
  'dildo', 'blowjob', 'handjob', 'jizz', 'cum\\b', 'anal', 'sex', 'nude',
  'naked', 'porn', 'horny', 'virgin', 'condom', 'std\\b', 'aids\\b',
  'suicide', 'kill yourself', 'kys\\b', 'jew', 'muslim', 'christian',
  'gay\\b', 'lesbian', 'transgender', 'autis', 'cripple', 'midget',
  'inbred', 'trailer park', 'obese', 'anorex', 'drunk', 'alcoholic',
].join('|'), 'i');

/** Expects text that has already been through `cleanText`. */
function usable(text) {
  if (!text || text.length < MIN_LENGTH) {
    return null;
  }
  // fold() drops anything the board cannot show, so a length change here means
  // the line carries characters that were never written for these flaps.
  const folded = fold(text);
  if (folded.length !== text.length) {
    return null;
  }
  // A roast that needs more than one frame is a story, not a punchline.
  const lines = wrap(folded, BODY_WIDTH, { orphans: false });
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { folded, lines: lines.length };
}

function cleanText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    // Dashes that stand in for a comma need their spaces back, or the words
    // either side fuse: "YOU ARE NOT STUPID-YOU JUST HAVE BAD LUCK".
    .replace(/\s*[\u2012-\u2015]\s*/g, ' - ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function readSource(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.toLowerCase().endsWith('.txt')) {
    return raw.split(/\r?\n/);
  }
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return parsed?.roasts || parsed?.lines || [];
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    process.stderr.write('Usage: node tools/build-roasts.js raw-roasts.json [more.json ...]\n');
    process.exit(1);
  }

  const seen = new Set();
  const roasts = [];
  const dropped = { short: false, illegal: 0, banned: 0, long: 0, duplicate: 0 };

  for (const input of inputs) {
    for (const row of readSource(input)) {
      const text = cleanText(typeof row === 'string' ? row : row?.text);
      if (!text) {
        dropped.illegal += 1;
        continue;
      }
      if (BANNED.test(text)) {
        dropped.banned += 1;
        continue;
      }
      const fit = usable(text);
      if (!fit) {
        dropped.long += 1;
        continue;
      }
      if (seen.has(fit.folded)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(fit.folded);
      // Content-hash ids so a rebuild does not renumber the corpus and orphan
      // every hidden id in the house settings file.
      roasts.push({
        id: `roast-${crypto.createHash('sha1').update(fit.folded).digest('hex').slice(0, 10)}`,
        text,
      });
    }
  }

  roasts.sort((a, b) => a.text.localeCompare(b.text) || a.id.localeCompare(b.id));

  const payload = {
    source: 'Public roast/insult collections, curated.',
    note: 'Profanity, slurs and anything sexual omitted. Only roasts that fit one Vestaboard frame (6x22, no title row).',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    count: roasts.length,
    roasts,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${roasts.length} roasts to ${OUT}\n`
    + `Dropped: ${dropped.banned} banned, ${dropped.long} unfit, `
    + `${dropped.duplicate} duplicate, ${dropped.illegal} empty\n`,
  );
}

main();
