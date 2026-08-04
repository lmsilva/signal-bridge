const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { triviaArtworkStemVariants } = require('../src/web-server');

describe('trivia artwork stem variants', () => {
  it('maps hyphen URLs to underscore upload names', () => {
    const stems = triviaArtworkStemVariants('film-portrait');
    assert.deepEqual(stems, ['film-portrait', 'film_portrait']);
  });

  it('maps underscore upload names back to hyphen URLs', () => {
    const stems = triviaArtworkStemVariants('film_portrait');
    assert.deepEqual(stems, ['film_portrait', 'film-portrait']);
  });

  it('aliases American theater spelling for musicals', () => {
    const stems = triviaArtworkStemVariants('musicals-theatre-portrait');
    assert.ok(stems.includes('musicals-theatre-portrait'));
    assert.ok(stems.includes('musicals-theater-portrait'));
    assert.ok(stems.includes('musicals-theatre_portrait'));
    assert.ok(stems.includes('musicals-theater_portrait'));
  });
});

describe('shipped trivia artwork pack', () => {
  it('serves the new cinema film portrait instead of the old magenta pattern', () => {
    const file = path.join(__dirname, '..', 'src', 'web', 'trivia-artwork', 'film-portrait.jpg');
    assert.ok(fs.existsSync(file), 'film-portrait.jpg must ship with the bridge');
    // Magenta pack was bright; the cinema pack is near-black in the corners.
    const buf = fs.readFileSync(file);
    assert.ok(buf.length > 20_000);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
  });
});
