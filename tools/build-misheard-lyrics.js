#!/usr/bin/env node
/**
 * Build the shipped Misheard Lyrics corpus.
 *
 * Sources, merged and cached under tools/.misheard-lyrics/:
 *   - a curated seed of famous family-safe mondegreens (the Vestaboard
 *     marketplace drawings live here)
 *   - Wikipedia "Mondegreen" (CC BY-SA)
 *   - MondegreenBench curated pairs (CC BY 4.0)
 *   - KissThisGuy (kissthisguy.com) letter indexes, song pages, and the
 *     funny/newest lists — title attributes and detail headings
 *
 *   node tools/build-misheard-lyrics.js
 *
 * Only board-fit, family-safe lines ship. No network at runtime.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { lyricLines, BODY_ROWS, cleanLine, withStop } = require('../src/misheard-lyrics-layout');
const SEED = require('./misheard-lyrics-seed');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.misheard-lyrics');
const OUT = path.join(ROOT, 'src', 'misheard-lyrics-lyrics.json');
const KTG = 'https://www.kissthisguy.com';

const WIKI = 'https://en.wikipedia.org/w/api.php?action=parse&page=Mondegreen&prop=wikitext&format=json&formatversion=2';
const BENCH_URLS = [
  'https://raw.githubusercontent.com/soarhigh/mondegreenbench/master/data/curated_pairs.json',
  'https://raw.githubusercontent.com/soarhigh/mondegreenbench/main/data/curated_pairs.json',
];

const SONGS_PER_LETTER = 18;
const DETAIL_CAP = 220;
const REQUEST_GAP_MS = 120;

const BANNED = new RegExp([
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'nigg', 'fagg', 'cunt',
  'cock', 'dick', 'pussy', 'whore', 'slut', 'rape', 'nude', 'naked',
  'sex', 'horny', 'orgasm', 'douche', 'penis', 'vagina', 'porn', 'booty',
  'weed', 'meth', 'blunt', 'pee', 'poop', 'kill myself', 'suicide',
].join('|'), 'i');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'signal-bridge-misheard-lyrics/1.0 (household display)',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (hops >= 5) {
          reject(new Error(`${url} redirected too many times`));
          return;
        }
        download(new URL(res.headers.location, url).href, hops + 1).then(resolve, reject);
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

function cacheName(id) {
  return path.join(CACHE, `${id.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80)}.txt`);
}

async function loadCached(id, url) {
  const file = cacheName(id);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 40) {
      return text;
    }
  }
  process.stderr.write(`Downloading ${id}\n`);
  const text = await download(url);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  await sleep(REQUEST_GAP_MS);
  return text;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, ' ');
}

function hashId(text, artist) {
  return `ml-${crypto.createHash('sha1').update(`${text}|${artist}`).digest('hex').slice(0, 10)}`;
}

function usable(text, artist) {
  const lyric = withStop(text);
  const who = cleanLine(artist);
  if (!lyric || !who || lyric.length < 8 || who.length < 2) {
    return null;
  }
  if (BANNED.test(lyric) || BANNED.test(who)) {
    return null;
  }
  const lines = lyricLines(lyric, who);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { text: lyric, artist: who, lines: lines.length, key: `${lyric.toLowerCase()}|${who.toLowerCase()}` };
}

function fromSeed() {
  return SEED.map(([text, artist]) => ({ text, artist, source: 'seed' }));
}

function fromBench(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed?.pairs || parsed?.data || []);
  const out = [];
  for (const row of rows) {
    const category = String(row?.category || '');
    if (category && !/song|lyric|music|mondegreen/i.test(category)) {
      continue;
    }
    const text = row.mondegreen_text || row.mondegreen || row.misheard || row.hypothesis || '';
    const source = String(row.source || row.reference || row.artist || '');
    const artist = cleanLine(
      source.split(/[–—]/).pop().replace(/^.*\s+by\s+/i, '').trim()
      || source.split(/\s+-\s+/).pop()
      || 'Unknown',
    );
    if (text) {
      out.push({ text, artist: artist || 'Unknown', source: 'mondegreenbench' });
    }
  }
  return out;
}

function fromWiki(raw) {
  let wikitext = raw;
  try {
    const parsed = JSON.parse(raw);
    wikitext = parsed?.parse?.wikitext || raw;
  } catch {
    // already plaintext
  }
  const out = [];
  const blocks = String(wikitext).split(/\n+/);
  for (const block of blocks) {
    const quotes = [
      ...block.matchAll(/"([^"]{8,90})"/g),
      ...block.matchAll(/''([^']{8,90})''/g),
    ].map((m) => m[1]);
    if (!quotes.length) {
      continue;
    }
    const by = block.match(/\bby\s+\[\[([^|\]]+)/i)
      || block.match(/\bby\s+([A-Z][\w.'’ -]{1,40})/);
    const artist = cleanLine((by && (by[1] || '')) || '');
    if (!artist) {
      continue;
    }
    out.push({ text: quotes[quotes.length - 1], artist, source: 'wikipedia' });
  }
  return out;
}

function ktgLinks(html, pattern) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`href="([^"]*${pattern}[^"]*)"`, 'gi');
  let match = re.exec(html);
  while (match) {
    const href = match[1].replace(/^\//, '');
    if (!seen.has(href)) {
      seen.add(href);
      out.push(href);
    }
    match = re.exec(html);
  }
  return out;
}

function fromKtgSongPage(html) {
  const out = [];
  const re = /title="\s*'([^']{6,90})'\s+is a misheard lyric of ([^"]+)"/gi;
  let match = re.exec(html);
  while (match) {
    out.push({
      text: decodeEntities(match[1]).replace(/\s+/g, ' ').trim(),
      artist: decodeEntities(match[2]).replace(/\s+/g, ' ').trim(),
      source: 'kissthisguy',
    });
    match = re.exec(html);
  }
  return out;
}

function fromKtgDetail(html) {
  const title = html.match(/<h1 class="songTitle">([\s\S]*?)<\/h1>/i);
  const artist = html.match(/class="MisheardArtistLink">([\s\S]*?)<\/a>/i);
  const text = decodeEntities((title && title[1]) || '').replace(/\s+/g, ' ').trim();
  const who = decodeEntities((artist && artist[1]) || '').replace(/\s+/g, ' ').trim();
  if (!text || !who) {
    return [];
  }
  return [{ text, artist: who, source: 'kissthisguy' }];
}

function fromKtgIndexLinks(html) {
  const out = [];
  const re = /href="([^"]*-misheard-\d+\.htm)"[^>]*>([^<]+)</gi;
  let match = re.exec(html);
  while (match) {
    const label = decodeEntities(match[2]).replace(/\s+/g, ' ').trim();
    const parts = label.split(':');
    const artist = (parts[0] || '').trim();
    const slug = match[1].replace(/-misheard-\d+\.htm$/i, '').replace(/-/g, ' ');
    if (artist && slug) {
      out.push({ text: slug, artist, source: 'kissthisguy' });
    }
    match = re.exec(html);
  }
  return out;
}

async function loadBench() {
  let lastError;
  for (const [index, url] of BENCH_URLS.entries()) {
    try {
      return fromBench(await loadCached(`mondegreenbench-${index}`, url));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('MondegreenBench unavailable');
}

async function loadKissThisGuy() {
  const collected = [];
  const funny = await loadCached('ktg-funny', `${KTG}/funny.php`);
  collected.push(...fromKtgIndexLinks(funny));
  try {
    const newest = await loadCached('ktg-newest', `${KTG}/newest.php`);
    collected.push(...fromKtgIndexLinks(newest));
  } catch (error) {
    process.stderr.write(`KissThisGuy newest skipped: ${error.message}\n`);
  }

  const detailHrefs = [];
  const seenDetail = new Set();
  for (const href of [...ktgLinks(funny, '-misheard-\\d+\\.htm')]) {
    if (!seenDetail.has(href) && detailHrefs.length < DETAIL_CAP) {
      seenDetail.add(href);
      detailHrefs.push(href);
    }
  }
  try {
    const newest = fs.readFileSync(cacheName('ktg-newest'), 'utf8');
    for (const href of ktgLinks(newest, '-misheard-\\d+\\.htm')) {
      if (!seenDetail.has(href) && detailHrefs.length < DETAIL_CAP) {
        seenDetail.add(href);
        detailHrefs.push(href);
      }
    }
  } catch {
    // newest may be missing
  }

  for (const [index, href] of detailHrefs.entries()) {
    try {
      const html = await loadCached(`ktg-detail-${index}`, `${KTG}/${href}`);
      collected.push(...fromKtgDetail(html));
    } catch (error) {
      process.stderr.write(`KissThisGuy detail skipped (${href}): ${error.message}\n`);
    }
  }

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of letters) {
    let indexHtml;
    try {
      indexHtml = await loadCached(`ktg-${letter}-songs`, `${KTG}/${letter}-songs.htm`);
    } catch (error) {
      process.stderr.write(`KissThisGuy ${letter} index skipped: ${error.message}\n`);
      continue;
    }
    const songs = [
      ...ktgLinks(indexHtml, 'misheard-song-'),
      ...ktgLinks(indexHtml, '\\d+song-'),
    ].slice(0, SONGS_PER_LETTER);
    for (const [songIndex, href] of songs.entries()) {
      try {
        const html = await loadCached(`ktg-song-${letter}-${songIndex}`, `${KTG}/${href}`);
        collected.push(...fromKtgSongPage(html));
      } catch (error) {
        process.stderr.write(`KissThisGuy song skipped (${href}): ${error.message}\n`);
      }
    }
  }

  return collected;
}

function main() {
  return Promise.resolve().then(async () => {
    const collected = [...fromSeed()];
    try {
      collected.push(...await loadBench());
    } catch (error) {
      process.stderr.write(`MondegreenBench skipped: ${error.message}\n`);
    }
    try {
      collected.push(...fromWiki(await loadCached('wikipedia-mondegreen', WIKI)));
    } catch (error) {
      process.stderr.write(`Wikipedia skipped: ${error.message}\n`);
    }
    try {
      collected.push(...await loadKissThisGuy());
    } catch (error) {
      process.stderr.write(`KissThisGuy skipped: ${error.message}\n`);
    }

    const seen = new Set();
    const lyrics = [];
    const dropped = { banned: 0, unfit: 0, short: 0, dup: 0 };
    for (const row of collected) {
      const next = usable(row.text, row.artist);
      if (!next) {
        if (BANNED.test(String(row.text || '')) || BANNED.test(String(row.artist || ''))) {
          dropped.banned += 1;
        } else if (!cleanLine(row.text) || cleanLine(row.text).length < 8) {
          dropped.short += 1;
        } else {
          dropped.unfit += 1;
        }
        continue;
      }
      if (seen.has(next.key)) {
        dropped.dup += 1;
        continue;
      }
      seen.add(next.key);
      lyrics.push({
        id: hashId(next.text, next.artist),
        text: next.text,
        artist: next.artist,
      });
    }
    lyrics.sort((a, b) => a.artist.localeCompare(b.artist) || a.text.localeCompare(b.text));

    const payload = {
      source: 'seed + Wikipedia Mondegreen + MondegreenBench + KissThisGuy',
      license: 'Public-domain seed; Wikipedia CC BY-SA; MondegreenBench CC BY 4.0; KissThisGuy user submissions used as locally cached examples',
      attribution: 'Famous misheard lyrics compiled for a household Vestaboard. Wikipedia text adapted under CC BY-SA. MondegreenBench pairs (CC BY 4.0). KissThisGuy (kissthisguy.com) submissions cached locally; no runtime API.',
      builtAt: new Date().toISOString(),
      bodyRows: BODY_ROWS,
      bodyWidth: 20,
      lyricCount: lyrics.length,
      lyrics,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
    process.stderr.write(
      `Wrote ${lyrics.length} lyrics to ${path.relative(ROOT, OUT)} `
      + `(dropped banned=${dropped.banned} unfit=${dropped.unfit} short=${dropped.short} dup=${dropped.dup})\n`,
    );
    if (lyrics.length < 200) {
      throw new Error(`Corpus too small (${lyrics.length})`);
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exit(1);
});
