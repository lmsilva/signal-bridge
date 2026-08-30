'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../src/vestaboard/encoder');
const { parseLayout, formatLayout } = require('../src/vestaboard/notation');
const { dwellFor } = require('../src/vestaboard/frames');
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
    ' SHOULD YOU BUILD',
    ' A GAMING SERVER?',
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

test('guest book frames are a normal push — no hold, optional invite page', () => {
  const rows = Array.from({ length: 6 }, () => new Array(22).fill(0));
  const footer = Array.from({ length: 6 }, () => new Array(22).fill(0));
  footer[5][0] = 1;
  const frames = signal.guestBookFrames({
    type: 'guest.book',
    rows,
    footerRows: footer,
    name: 'Luis',
  });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].holdSeconds, undefined);
  assert.equal(frames[0].dwellSeconds, dwellFor(rows, { base: 15 }));
  assert.equal(frames[0].source, 'guest.book');
  assert.equal(frames[0].label, 'Guest · Luis');
  assert.equal(frames[1].holdSeconds, undefined);
  assert.equal(frames[1].source, 'guest.book');
});

test('guest book invite is one snapshot page', () => {
  const rows = Array.from({ length: 6 }, () => new Array(22).fill(0));
  rows[0][0] = 1;
  const frames = signal.guestBookInviteFrames({
    type: 'guest.book.invite',
    rows,
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].holdSeconds, undefined);
  assert.equal(frames[0].dwellSeconds, dwellFor(rows, { base: 15 }));
  assert.equal(frames[0].label, 'Guest book invite');
  assert.equal(frames[0].source, 'guest.book');
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

const FLIGHT_PLAN_CTX = { timeZone: 'America/Denver', now: new Date('2026-08-26T18:00:00Z') };

test('next flight is a Flight Tracker card: trip name, route, both clocks, status, gate', () => {
  const frames = feeds.flightPlanBoardFrames({
    type: 'flightplan.flight',
    mode: 'next',
    asOf: '2026-08-26T18:00:00Z',
    trip: { name: 'Japan 2027', kind: 'ours' },
    flight: {
      airline: 'DL',
      number: 'DL167',
      origin: { iata: 'SEA' },
      destination: { iata: 'HND' },
      scheduled: {
        departure: '2026-08-26T13:45:00-06:00',
        arrival: '2026-08-27T16:40:00+09:00',
      },
      state: 'upcoming',
      latest: { departure: { gate: 'B14' } },
    },
  }, FLIGHT_PLAN_CTX);

  assert.equal(frames.length, 1);
  assertLayout(frames[0].rows, [
    'gg JAPAN 2027       gg',
    ' DL 167         TODAY',
    ' SEA -            HND',
    ' 1:45P          4:40P',
    ' ON TIME     GATE B14',
    'gg AS OF      12:00 gg',
  ], 'next flight tracker');
});

test('a delayed flight uses estimated time, orange chips, and DELAYED 25 MIN', () => {
  const frames = feeds.flightPlanBoardFrames({
    type: 'flightplan.flight',
    mode: 'next',
    asOf: '2026-08-26T18:00:00Z',
    flight: {
      airline: 'UA',
      number: '1234',
      origin: { iata: 'SLC' },
      destination: { iata: 'NRT' },
      scheduled: {
        departure: '2026-08-26T10:00:00-06:00',
        arrival: '2026-08-27T13:20:00+09:00',
      },
      state: 'upcoming',
      latest: {
        status: 'Delayed',
        departure: {
          gate: 'A5',
          scheduledTime: { local: '2026-08-26T10:00:00-06:00' },
          revisedTime: { local: '2026-08-26T10:25:00-06:00' },
        },
      },
    },
  }, FLIGHT_PLAN_CTX);

  assertLayout(frames[0].rows, [
    'oo NEXT FLIGHT      oo',
    ' UA 1234        TODAY',
    ' SLC -            NRT',
    ' 10:25A         1:20P',
    ' DELAYED 25 MIN',
    'oo AS OF      12:00 oo',
  ], 'delayed flight tracker');
});

test('an airborne flight reads IN FLIGHT with blue chips', () => {
  const frames = feeds.flightPlanBoardFrames({
    type: 'flightplan.flight',
    mode: 'next',
    asOf: '2026-08-26T18:00:00Z',
    flight: {
      airline: 'DL',
      number: '167',
      origin: { iata: 'SEA' },
      destination: { iata: 'HND' },
      scheduled: {
        departure: '2026-08-26T10:00:00-06:00',
        arrival: '2026-08-27T14:00:00+09:00',
      },
      state: 'active',
      latest: { status: 'En-Route' },
    },
  }, FLIGHT_PLAN_CTX);

  assertLayout(frames[0].rows, [
    'bb NEXT FLIGHT      bb',
    ' DL 167           NOW',
    ' SEA -            HND',
    ' 10:00A         2:00P',
    ' IN FLIGHT',
    'bb AS OF      12:00 bb',
  ], 'airborne flight tracker');
});

test('a trip board pages one tracker card per flight', () => {
  const frames = feeds.flightPlanBoardFrames({
    type: 'flightplan.flight',
    mode: 'board',
    asOf: '2026-08-26T18:00:00Z',
    trip: { name: 'Japan 2027' },
    flights: [{
      airline: 'DL',
      number: '167',
      origin: { iata: 'SEA' },
      destination: { iata: 'HND' },
      scheduled: {
        departure: '2026-08-26T13:45:00-06:00',
        arrival: '2026-08-27T16:40:00+09:00',
      },
      state: 'upcoming',
    }, {
      airline: 'DL',
      number: '168',
      origin: { iata: 'HND' },
      destination: { iata: 'SEA' },
      scheduled: {
        departure: '2026-08-30T11:00:00+09:00',
        arrival: '2026-08-30T05:30:00-07:00',
      },
      state: 'upcoming',
    }],
  }, FLIGHT_PLAN_CTX);

  assert.equal(frames.length, 2);
  assertLayout(frames[0].rows, [
    'gg JAPAN 2027       gg',
    ' DL 167     TODAY 1/2',
    ' SEA -            HND',
    ' 1:45P          4:40P',
    ' ON TIME',
    'gg AS OF      12:00 gg',
  ], 'trip board page 1');
  assertLayout(frames[1].rows, [
    'gg JAPAN 2027       gg',
    ' DL 168       D-3 2/2',
    ' HND -            SEA',
    ' 11:00A         5:30A',
    ' ON TIME',
    'gg AS OF      12:00 gg',
  ], 'trip board page 2');
});
