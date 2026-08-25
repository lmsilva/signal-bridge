'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const feeds = require('../src/vestaboard/formatters/feeds');
const signal = require('../src/vestaboard/formatters/signal');

function assertLayout(actual, drawing, label) {
  assert.equal(validate(actual).ok, true, `${label} failed validation`);
  const expected = parseLayout(drawing.join('\n'), { label });
  if (formatLayout(actual) !== formatLayout(expected)) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${formatLayout(expected)}\n\n`
      + `--- actual ---\n${formatLayout(actual)}\n`,
    );
  }
}

test('youtube wraps the title and abbreviates the view count', () => {
  const frames = feeds.youtubeFrames({
    type: 'youtube.now-playing',
    youtube: {
      videoId: 'abc',
      mode: 'playing',
      title: 'Should you build a gaming server?',
      channelTitle: 'Jake Simmons',
      viewCount: 37285,
      likeCount: 1482,
      dislikeCount: 12,
      deviceLabel: 'Movie Theater TV',
    },
  });

  assertLayout(frames[0].rows, [
    'rr YOUTUBE          rr',
    ' SHOULD YOU BUILD A',
    ' GAMING SERVER?',
    ' JAKE SIMMONS',
    ' 37K VIEWS 1482+ 12-',
    'rr MOVIE THEATER TV rr',
  ], 'youtube');
});

test('youtube hides a device whose link is not healthy, and never prints a hidden count as zero', () => {
  const frames = feeds.youtubeFrames({
    type: 'youtube.now-playing',
    youtube: {
      videoId: 'abc',
      mode: 'playing',
      title: 'Hello',
      channelTitle: 'A',
      viewCount: null,
      likeCount: null,
      dislikeCount: null,
      deviceLabel: 'Movie Theater TV',
    },
  }, { deviceStatus: 'needs-relink' });

  const drawn = formatLayout(frames[0].rows).split('\n');
  assert.match(drawn[5], /^rr\s+rr$/);
  assert.doesNotMatch(drawn[4], /0 VIEWS/);
});

test('the upside intro then pages each headline, wrapping at the full 22', () => {
  const frames = feeds.upsideFrames({
    type: 'upside-news.round',
    upsideNews: {
      storyCount: 5,
      stories: [{
        headline: 'First river otter spotted in the Bronx in 100 years along the Bronx River',
      }, {
        headline: 'Short one',
      }, {
        headline: 'Another',
      }, {
        headline: 'Fourth',
      }, {
        headline: 'Fifth',
      }],
    },
  });

  assertLayout(frames[0].rows, [
    'yy THE UPSIDE       yy',
    '',
    '  GOOD NEWS ONLY',
    '  5 STORIES TODAY',
    '',
    'yy                  yy',
  ], 'upside intro');

  assertLayout(frames[1].rows, [
    'yy THE UPSIDE   1/5 yy',
    'FIRST RIVER OTTER',
    'SPOTTED IN THE BRONX',
    'IN 100 YEARS ALONG',
    'THE BRONX RIVER',
    'yy                  yy',
  ], 'upside story');
});

test('wiki puts a leftover teaser line in the footer rather than dropping it', () => {
  const frames = feeds.wikiFrames({
    type: 'wiki-common-knowledge.round',
    wikiCommonKnowledge: {
      stories: [
        { title: 'Skip me', description: 'x', extract: 'x' },
        {
          title: 'The Antikythera Mechanism',
          description: '',
          extract: 'A 2000 year old analog computer',
        },
        { title: 'Three', description: 'x' },
        { title: 'Four', description: 'x' },
        { title: 'Five', description: 'x' },
      ],
    },
  });

  assertLayout(frames[0].rows, [
    'ww WIKIPEDIA        ww',
    '',
    '  COMMON KNOWLEDGE',
    '  TOP READS TODAY',
    '',
    'ww                  ww',
  ], 'wiki intro');

  assertLayout(frames[2].rows, [
    'ww WIKI READS   2/5 ww',
    ' THE ANTIKYTHERA',
    ' MECHANISM',
    '',
    ' A 2000 YEAR OLD',
    'ww ANALOG COMPUTER  ww',
  ], 'wiki story');
});

test('overhead looks up routes by hex and prints two flights per frame', () => {
  const frames = feeds.overheadFrames({
    type: 'overhead.round',
    overhead: {
      aircraftCount: 2,
      aircraft: [
        {
          hex: 'abc123', callsign: 'UA1642', label: 'UA1642', altFt: 34000, dstNm: 2, bearingLabel: 'NE',
        },
        {
          hex: 'def456', callsign: 'DL889', label: 'DL889', altFt: 38000, dstNm: 9, bearingLabel: 'SW',
        },
      ],
      routes: {
        abc123: { originIata: 'SFO', destIata: 'DEN' },
        def456: { originIata: 'LAX', destIata: 'JFK' },
      },
    },
  });

  assertLayout(frames[0].rows, [
    'bb OVERHEAD         bb',
    ' UA1642  SFO-DEN',
    '  34000FT  2MI NE',
    ' DL889   LAX-JFK',
    '  38000FT  9MI SW',
    'bb 2 OVERHEAD NOW   bb',
  ], 'overhead');
});

test('overhead does not read a route off the aircraft object', () => {
  const frames = feeds.overheadFrames({
    type: 'overhead.round',
    overhead: {
      aircraft: [{
        hex: 'abc', callsign: 'UA1', label: 'UA1', altFt: 10000, dstNm: 1, bearingLabel: 'N',
        route: { originIata: 'SFO', destIata: 'DEN' },
      }],
      routes: {},
    },
  });
  assert.doesNotMatch(formatLayout(frames[0].rows), /SFO/);
});

test('a two-column trivia question and its reveal match the spec drawings', () => {
  const frames = feeds.triviaFrames({
    type: 'trivia.round',
    trivia: {
      questionSeconds: 30,
      answerSeconds: 7,
      questions: [{
        type: 'multiple',
        categoryLabel: 'General',
        text: 'What is the zodiac symbol for Gemini?',
        answers: ['Twins', 'Fish', 'Scales', 'Maiden'],
        correctIndex: 0,
      }],
    },
  });

  assert.equal(frames.length, 2);
  assert.equal(frames[0].dwellSeconds, 30);
  assertLayout(frames[0].rows, [
    'yy TRIVIA   GENERAL yy',
    ' WHAT IS THE ZODIAC',
    ' SYMBOL FOR GEMINI?',
    ' A TWINS    B FISH',
    ' C SCALES   D MAIDEN',
    'yy ANSWER IN 30S    yy',
  ], 'trivia question');

  assertLayout(frames[1].rows, [
    'yy TRIVIA   GENERAL yy',
    ' WHAT IS THE ZODIAC',
    ' SYMBOL FOR GEMINI?',
    'g A TWINS   B rrrr',
    ' C rrrrrr   D rrrrrr',
    'yy A - TWINS!       yy',
  ], 'trivia reveal');
});

test('trivia skips a question that cannot fit a single frame', () => {
  const long = 'Why did the authors of this very long question write so many words that the board cannot hold them in two lines at width twenty?';
  assert.equal(feeds.triviaGate({
    type: 'multiple',
    text: long,
    answers: ['One', 'Two', 'Three', 'Four'],
  }), null);

  const frames = feeds.triviaFrames({
    type: 'trivia.round',
    trivia: {
      questions: [{
        type: 'multiple',
        text: long,
        answers: ['One', 'Two', 'Three', 'Four'],
        correctIndex: 0,
      }],
    },
  });
  assert.deepEqual(frames, []);
});

test('boolean trivia fits when the question is three lines or fewer', () => {
  assert.equal(feeds.triviaGate({
    type: 'boolean',
    text: 'Is the sky blue?',
    answers: ['True', 'False'],
  }), 'boolean');
});

test('guest snaps types the wifi and the booth host, never the QR payload', () => {
  const frames = signal.guestSnapsFrames({
    type: 'guest.photobooth',
    displaySeconds: 180,
    guestPhotobooth: {
      wifi: { ssid: 'CASA-GUEST', content: 'WIFI:T:WPA;S:CASA-GUEST;P:secret;;' },
      booth: { content: 'https://192.168.1.10:47810/' },
    },
  }, { password: 'SUNNY-TRAILS24' });

  assert.equal(frames.length, 6);
  assert.equal(frames[0].dwellSeconds, 30);
  assertLayout(frames[0].rows, [
    'bb GUEST SNAPS      bb',
    ' WIFI CASA-GUEST',
    ' PASS SUNNY-TRAILS24',
    '',
    ' SHARE PHOTOS AT:',
    'b 192.168.1.10:47810 b',
  ], 'guest snaps');
  assert.doesNotMatch(formatLayout(frames[0].rows), /WIFI:T:/);
});

test('guest snaps keeps a long password and host by wrapping, never cutting', () => {
  const frames = signal.guestSnapsFrames({
    type: 'guest.photobooth',
    displaySeconds: 180,
    guestPhotobooth: {
      wifi: { ssid: 'PANDAMONIUM' },
      booth: { content: 'https://signal.wittydigital.com/' },
    },
  }, { password: 'thoseportuguesepigs2' });

  const drawn = formatLayout(frames[0].rows);
  assert.match(drawn, /WIFI PANDAMONIUM/);
  assert.match(drawn, /THOSEPORTUGUESEPIGS2/);
  assert.match(drawn, /SIGNAL\.WITTYDIGITAL\./);
  assert.match(drawn, /\bCOM\b/);
  assert.doesNotMatch(drawn, /THOSEPORTUGUESEPI[^G]/);
  assert.doesNotMatch(drawn, /WITTYDIGITA[^L]/);

  assertLayout(frames[0].rows, [
    'bb GUEST SNAPS      bb',
    ' WIFI PANDAMONIUM',
    ' PASS',
    ' THOSEPORTUGUESEPIGS2',
    ' SIGNAL.WITTYDIGITAL.',
    'b COM                b',
  ], 'guest snaps long wifi');
});

test('a booth host splits at a dot rather than hyphenating', () => {
  assert.deepEqual(
    signal.splitHost('SIGNAL.WITTYDIGITAL.COM', 20),
    ['SIGNAL.WITTYDIGITAL.', 'COM'],
  );
});

test('a missing booth host is not rendered as localhost', () => {
  assert.equal(signal.boothHost('https://127.0.1.10:47810/'), '127.0.1.10:47810');
  assert.equal(signal.boothHost('https://192.168.1.10:47810/'), '192.168.1.10:47810');
});
