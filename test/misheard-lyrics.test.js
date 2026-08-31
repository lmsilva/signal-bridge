'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { misheardLyricsFrames } = require('../src/vestaboard/formatters/feeds');
const { lyricLines, lyricRows, INDENT, TEXT_WIDTH } = require('../src/misheard-lyrics-layout');
const {
  BODY_ROWS,
  loadShipped,
  matchingLyrics,
  pickLyric,
  listLyrics,
  buildMisheardLyricsPayload,
  createMisheardLyrics,
} = require('../src/misheard-lyrics');
const { sanitiseSettings } = require('../src/misheard-lyrics-settings');

function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

const framesFor = (text, artist) => misheardLyricsFrames(
  buildMisheardLyricsPayload({ id: 'demo', text, artist }),
);

const onlyCustom = (custom) => sanitiseSettings({
  custom,
  removedIds: loadShipped().map((lyric) => lyric.id),
});

test('the three channel cards render flap for flap', () => {
  const starship = framesFor('We built this city on sausage rolls', 'Starship');
  assert.equal(starship.length, 1);
  assert.equal(starship[0].source, 'misheard.lyrics');
  assert.equal(starship[0].label, 'Misheard Lyrics');
  assertBoard(starship[0].rows, [
    '',
    '  WE BUILT THIS CITY',
    '  ON SAUSAGE ROLLS.',
    '  - STARSHIP',
    '',
    '',
  ], 'Starship card');

  const rihanna = framesFor('We found dove in a soapless place', 'Rihanna');
  assertBoard(rihanna[0].rows, [
    '',
    '  WE FOUND DOVE IN',
    '  A SOAPLESS PLACE.',
    '  - RIHANNA',
    '',
    '',
  ], 'Rihanna card');

  const ccr = framesFor("There's a bathroom on the right", 'Creedence Clearwater Revival');
  assertBoard(ccr[0].rows, [
    '',
    "  THERE'S A BATHROOM",
    '  ON THE RIGHT.',
    '  - CREEDENCE',
    '  CLEARWATER REVIVAL',
    '',
  ], 'Creedence card');
});

test('the wrap leaves two columns of air and stops at 20', () => {
  for (const line of lyricLines(
    "There's a bathroom on the right",
    'Creedence Clearwater Revival',
  )) {
    assert.ok(line.length <= TEXT_WIDTH, line);
  }
  assert.equal(TEXT_WIDTH, COLS - INDENT);
  assert.equal(INDENT, 2);
});

test('a lyric without a stop gets a period', () => {
  assert.deepEqual(
    lyricLines('We built this city on sausage rolls', 'Starship'),
    ['WE BUILT THIS CITY', 'ON SAUSAGE ROLLS.', '- STARSHIP'],
  );
});

test('a lyric with no artist gets no credit line', () => {
  assert.deepEqual(
    lyricLines('Excuse me while I kiss this guy', ''),
    ['EXCUSE ME WHILE', 'I KISS THIS GUY.'],
  );
});

test('an empty lyric never flips the board', () => {
  assert.equal(buildMisheardLyricsPayload({ id: 'x', text: '  ' }), null);
  assert.deepEqual(misheardLyricsFrames({ type: 'misheard.lyrics' }), []);
  assert.deepEqual(misheardLyricsFrames({}), []);
  assert.deepEqual(lyricRows('   ', 'Starship'), []);
});

test('a lyric too long for one frame is refused, not paged', () => {
  const long = `${'We built this city on sausage rolls and gravy boats and pastry '.repeat(3)}ends.`;
  assert.equal(framesFor(long, 'Starship').length, 0);
  assert.ok(lyricLines(long, 'Starship').length > BODY_ROWS);
});

test('the shipped corpus is board-fit, attributed and family-safe', () => {
  const lyrics = loadShipped();
  assert.ok(lyrics.length >= 200, `only ${lyrics.length} lyrics shipped`);

  const seenIds = new Set();
  const seenText = new Set();
  for (const lyric of lyrics) {
    assert.match(lyric.id, /^ml-[0-9a-f]{10}$/);
    assert.equal(seenIds.has(lyric.id), false, `duplicate id ${lyric.id}`);
    seenIds.add(lyric.id);
    assert.ok(lyric.artist, `${lyric.text} has no artist`);

    const lines = lyricLines(lyric.text, lyric.artist);
    assert.ok(lines.length >= 1 && lines.length <= BODY_ROWS, lyric.text);
    for (const line of lines) {
      assert.ok(line.length <= TEXT_WIDTH, lyric.text);
    }

    const key = `${lyric.text.toLowerCase()}|${lyric.artist.toLowerCase()}`;
    assert.equal(seenText.has(key), false, `duplicate lyric ${lyric.text}`);
    seenText.add(key);

    assert.doesNotMatch(
      `${lyric.text} ${lyric.artist}`,
      /\b(fuck|shit|bitch|sex|nude|naked|porn)\b/i,
      lyric.text,
    );
  }
});

test('the rotation skips what it just showed', () => {
  const settings = {
    ...onlyCustom([
      { id: 'a', text: 'We built this city on sausage rolls', artist: 'Starship' },
      { id: 'b', text: 'Hold me closer, Tony Danza', artist: 'Elton John' },
    ]),
    recentIds: ['a'],
  };
  assert.equal(pickLyric(settings, { random: () => 0 }).id, 'b');
  assert.equal(pickLyric({ ...settings, recentIds: ['a', 'b'] }, { random: () => 0 }).id, 'a');
});

test('the list searches by lyric or artist, and paginates', () => {
  const settings = onlyCustom(Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`,
    text: `Misheard number ${index} on the radio.`,
    artist: `Artist ${index}`,
  })));
  const page = listLyrics(settings, { page: 2, pageSize: 10 });
  assert.equal(page.pages, 3);
  assert.equal(page.lyrics.length, 10);
  assert.ok(page.lyrics[0].rows >= 1);

  assert.equal(listLyrics(settings, { query: 'number 7 ' }).total, 1);
  assert.equal(listLyrics(settings, { query: 'artist 12' }).total, 1);
});

test('house edits hide, override text and artist, add and remove lyrics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'misheard-lyrics-'));
  const lyrics = createMisheardLyrics({
    ROOT: root,
    misheardLyricsSettingsPath: path.join(root, 'misheard-lyrics-settings.json'),
  });
  const shipped = loadShipped()[0];

  const hidden = lyrics.updateLyric(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
  assert.equal(matchingLyrics(lyrics.getSettings()).some((row) => row.id === shipped.id), false);

  const edited = lyrics.updateLyric(shipped.id, {
    hidden: false,
    text: 'We built this city on pastry rolls',
    artist: 'The House',
  });
  assert.equal(edited.ok, true);
  const override = matchingLyrics(lyrics.getSettings()).find((row) => row.id === shipped.id);
  assert.match(override.text, /pastry rolls/);
  assert.equal(override.artist, 'The House');

  const added = lyrics.addLyric('Excuse me while I kiss this pie', 'Jimi Hendrix');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);

  const blank = lyrics.addLyric('   ', 'Starship');
  assert.equal(blank.ok, false);

  const noArtist = lyrics.addLyric('Hold me closer, Tony Danza', '  ');
  assert.equal(noArtist.ok, false);

  const customId = lyrics.statusSnapshot({ query: 'kiss this pie', page: 1, pageSize: 10 })
    .lyrics.find((row) => row.custom)?.id;
  assert.ok(customId);
  const removed = lyrics.updateLyric(customId, { remove: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.customCount, 0);

  const payload = lyrics.nextPayload();
  assert.ok(payload);
  assert.equal(payload.type, 'misheard.lyrics');
  assert.ok(payload.lyric.text);
  assert.ok(payload.lyric.artist);
  assert.equal(validate(misheardLyricsFrames(payload)[0].rows).ok, true);
  assert.equal(misheardLyricsFrames(payload)[0].rows.length, ROWS);
});
