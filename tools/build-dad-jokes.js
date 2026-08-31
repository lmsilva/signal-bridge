#!/usr/bin/env node
/**
 * Build the shipped Dad Jokes list.
 *
 * Source: public dad-joke collections, curated to clean two-part jokes that
 * fit one board.
 *
 *   node tools/build-dad-jokes.js raw-jokes.json [more.json ...]
 *
 * Each input is a JSON array of `{ setup, punchline }` (`delivery` is accepted
 * for the punchline), or an object with a `jokes` array of the same. A bare
 * string, or an entry with only a `joke` field, is split on its question mark
 * or first sentence end.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { jokeLines, BODY_ROWS, BODY_WIDTH } = require('../src/dad-jokes-layout');

const OUT = path.join(__dirname, '..', 'src', 'dad-jokes-jokes.json');
const MIN_LENGTH = 8;

// A kitchen wall, read by children, every morning.
const BANNED = new RegExp([
  'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'bastard', 'dick', 'pussy',
  'cock', 'prick', 'boob', 'tit\\b', 'nipple', 'sex', 'sexy', 'nude', 'naked',
  'porn', 'horny', 'virgin', 'condom', 'orgasm', 'sperm', 'penis', 'vagina',
  'nigg', 'fagg', 'retard', 'slut', 'whore', 'rape', 'incest',
  'suicide', 'kill yourself', 'drunk', 'beer', 'wine', 'vodka', 'whiskey',
  'weed\\b', 'stoned', 'cocaine', 'heroin', 'viagra', 'hell\\b', 'damn',
  // A pun can turn dark in its last three words, so the punchline gets the
  // same read as the setup.
  'on fire', 'set fire', 'burn(?:ed|ing)? (?:him|her|them|it|down)', 'murder',
  '\\bkill', '\\bdead\\b', '\\bdied\\b', '\\bdying\\b', '\\bcorpse\\b',
  '\\bgun\\b', '\\bshot\\b', '\\bstab', '\\bblood', '\\bcoffin\\b',
  // Jokes whose whole premise is a group. Not the card for it.
  '\\b(?:wo)?men (?:are|always|never)\\b', 'arguing with (?:wo)?men',
  '\\bblonde', '\\bmother-in-law\\b', '\\bmy ex\\b', '\\bnagging\\b',
  '\\bfat\\b', '\\bugly\\b', '\\bdumb\\b', '\\bidiot\\b',
  // Puns that only land if you already know the adult phrase they rhyme with.
  'dysfunction', 'birth control', '\\bpregnan', '\\bprotection\\b',
  '\\bdivorce', '\\baffair\\b', '\\d+ to life\\b',
].join('|'), 'i');

// An apostrophe never follows a space in a contraction, so one that does is a
// stray opening quote — the joke arrived with its formatting already broken.
const BROKEN_QUOTES = /(?:^|\s)'/;

// Listicle scrapes drag in the page furniture around the jokes.
const SCRAPE_NOISE = new RegExp([
  "here'?s what", 'what to know', 'read more', 'click here', 'advertisement',
  'getty', 'shutterstock', 'according to', 'scroll down', 'photo credit',
  'related:', 'source:', 'via reddit', 'subscribe',
].join('|'), 'i');

// "Balloon's What's a balloon's favorite genre of music?" — a scrape that kept
// the heading and the joke. A question word capitalised mid-sentence, with no
// sentence end before it, is that seam.
const DOUBLED_HEAD = /^[^.?!]+\s(?:What|Why|Which|When|Where|Who|How|Did|Do|Does|Can)\b/;

/**
 * Headline case ("When Do Hummingbirds Migrate?") means an article title got
 * scraped as a joke. Real setups only capitalise the first word and names.
 */
function headlineCase(text) {
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (words.length < 4) {
    return false;
  }
  const capped = words.filter((word) => /^[A-Z]/.test(word)).length;
  return capped / words.length > 0.7;
}

function clean(value) {
  return String(value || '')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    // A dash standing in for a comma needs its spaces back, or the words
    // either side fuse on the board.
    .replace(/\s*[\u2012-\u2015]\s*/g, ' - ')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/([!?])\1+/g, '$1')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .replace(/^(?:Q[:.]|A[:.])\s*/i, '')
    .trim();
}

/** Every card on the channel closes its two halves. Plenty of dumps do not. */
function punctuate(value) {
  return /[A-Za-z0-9)]$/.test(value) ? `${value}.` : value;
}

/** Turn a one-string joke into a setup and a punchline. */
function split(joke) {
  const text = clean(joke);
  const question = text.indexOf('? ');
  if (question > 0) {
    return { setup: text.slice(0, question + 1), punchline: clean(text.slice(question + 2)) };
  }
  const sentence = text.search(/[.!] /);
  if (sentence > 0) {
    return { setup: text.slice(0, sentence + 1), punchline: clean(text.slice(sentence + 2)) };
  }
  return { setup: text, punchline: '' };
}

function normalise(row) {
  if (typeof row === 'string') {
    return split(row);
  }
  const setup = clean(row?.setup);
  const punchline = clean(row?.punchline ?? row?.delivery);
  if (setup && punchline) {
    return { setup, punchline };
  }
  return split(row?.joke ?? row?.setup ?? '');
}

/**
 * Does this actually read as a setup and a punchline?
 *
 * Sources split their one-liners badly and often, and a bad split is worse
 * than a missing joke: "A book never written: Yellow Rivers by L. O." /
 * "Tsoftea." lands on the board as nonsense. So the split is re-checked here
 * no matter who made it.
 */
function splitLooksRight(setup, punchline) {
  // A punchline that asks its own question is a second joke that got glued on.
  if (punchline.includes('?')) {
    return false;
  }
  if (setup.includes('?')) {
    return setup.indexOf('?') === setup.length - 1;
  }
  // Without a question mark the seam is a guess, so demand both halves be
  // substantial enough that the guess is unlikely to be a mid-sentence cut.
  const words = (text) => text.split(/\s+/).filter(Boolean).length;
  if (words(setup) < 5 || words(punchline) < 3) {
    return false;
  }
  // Two sentences in the setup means the seam was picked late.
  if (/[.!]\s/.test(setup)) {
    return false;
  }
  // "…by L. O." — the split fell inside an initial.
  return !/\b[A-Za-z]\.$/.test(setup);
}

function usable(setup, punchline) {
  if (!setup || setup.length < MIN_LENGTH) {
    return null;
  }
  const whole = `${setup} ${punchline}`;
  if (BROKEN_QUOTES.test(whole) || (whole.match(/"/g) || []).length % 2) {
    return null;
  }
  if (SCRAPE_NOISE.test(whole) || DOUBLED_HEAD.test(setup)) {
    return null;
  }
  if (headlineCase(setup) || headlineCase(punchline)) {
    return null;
  }
  // A trailing ellipsis means the source truncated the line.
  if (/\.\.\./.test(whole)) {
    return null;
  }
  // A joke opens with a word. Anything starting on a digit or a symbol is a
  // list marker or a stray table row that survived the scrape.
  // Both halves open on a word. A leading digit or symbol is a list marker, a
  // stray table row, or the place an emoji used to be.
  if (!/^[A-Za-z"]/.test(setup) || !/^[A-Za-z0-9"(]/.test(punchline)) {
    return null;
  }
  if (/[=|<>*_[\]{}]/.test(whole)) {
    return null;
  }
  if (!/[.?!]$/.test(setup) || !/[.?!]$/.test(punchline)) {
    return null;
  }
  if (!splitLooksRight(setup, punchline)) {
    return null;
  }
  // The blank row between setup and punchline is the pause, and the pause is
  // the joke. An entry with nothing under the line is not this card.
  if (!punchline) {
    return null;
  }
  const lines = jokeLines(setup, punchline);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  // jokeLines folds, and fold() drops anything the board cannot show. If the
  // characters do not survive the round trip, the joke was not written for
  // these flaps.
  const flat = lines.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const wanted = `${setup} ${punchline}`.toUpperCase().replace(/\s+/g, ' ');
  if (flat.length !== wanted.length) {
    return null;
  }
  return { key: flat, lines: lines.length };
}

function readSource(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed?.jokes || parsed?.body || []);
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    process.stderr.write('Usage: node tools/build-dad-jokes.js raw-jokes.json [more.json ...]\n');
    process.exit(1);
  }

  const seen = new Set();
  const jokes = [];
  const dropped = {
    empty: 0, banned: 0, unfit: 0, duplicate: 0,
  };
  const histogram = {};

  for (const input of inputs) {
    for (const row of readSource(input)) {
      const raw = normalise(row);
      if (!raw.setup || !raw.punchline) {
        dropped.empty += 1;
        continue;
      }
      const setup = punctuate(raw.setup);
      const punchline = punctuate(raw.punchline);
      if (BANNED.test(setup) || BANNED.test(punchline)) {
        dropped.banned += 1;
        continue;
      }
      const fit = usable(setup, punchline);
      if (!fit) {
        dropped.unfit += 1;
        continue;
      }
      if (seen.has(fit.key)) {
        dropped.duplicate += 1;
        continue;
      }
      seen.add(fit.key);
      histogram[fit.lines] = (histogram[fit.lines] || 0) + 1;
      // Content-hash ids so a rebuild does not renumber the corpus and orphan
      // every hidden id in the house settings file.
      jokes.push({
        id: `joke-${crypto.createHash('sha1').update(fit.key).digest('hex').slice(0, 10)}`,
        setup,
        punchline,
      });
    }
  }

  jokes.sort((a, b) => a.setup.localeCompare(b.setup) || a.id.localeCompare(b.id));

  const payload = {
    source: 'Public dad-joke collections, curated.',
    note: 'Clean two-part jokes only. Setup, a blank row, then the punchline, all inside one Vestaboard frame (6 rows, wrapped at 21 columns).',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    count: jokes.length,
    jokes,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${jokes.length} jokes to ${OUT}\n`
    + `Rows used: ${Object.keys(histogram).sort().map((n) => `${n}=${histogram[n]}`).join(' ')}\n`
    + `Dropped: ${dropped.banned} banned, ${dropped.unfit} unfit, `
    + `${dropped.duplicate} duplicate, ${dropped.empty} empty\n`,
  );
}

main();
