#!/usr/bin/env node
/**
 * Build the shipped Word Riddles corpus.
 *
 * Sources (no network at runtime):
 *   - crawsome/riddles (Unlicense) — poetic + classic English riddles
 *   - nkilm/riddles-api (MIT) — short question/answer riddles
 *   - a small set of well-known public-domain word riddles
 *
 *   node tools/build-word-riddles.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fold, wrap, encodeText } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'word-riddles-riddles.json');
const CRAWSOME = 'https://raw.githubusercontent.com/crawsome/riddles/master/riddles.csv';
const NKILM = 'https://raw.githubusercontent.com/nkilm/riddles-api/main/data/riddles.json';

const RIDDLE_ROWS = 4;
const ANSWER_ROWS = 2;
const BODY_WIDTH = 22;
const RIDDLE_MAX = 220;
const ANSWER_MAX = 80;

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai|suicide|kill yourself|cocaine|heroin|marijuana|weed\b|alcohol|whiskey|beer\b|wine\b)\b/i;
const BAD_ANSWER = /comment section|please tell us|good luck|see below|too many|unknown|n\/a|none of the/i;

const EXTRA = [
  ['I am an odd number. Take away a letter and I become even. What number am I?', 'Seven'],
  ['What has keys but can\'t open locks?', 'A piano'],
  ['What has hands but can\'t clap?', 'A clock'],
  ['What has a head and a tail but no body?', 'A coin'],
  ['What has to be broken before you can use it?', 'An egg'],
  ['I\'m tall when I\'m young and short when I\'m old. What am I?', 'A candle'],
  ['What gets wetter the more it dries?', 'A towel'],
  ['What can travel around the world while staying in a corner?', 'A stamp'],
  ['What has many teeth but can\'t bite?', 'A comb'],
  ['What has one eye but can\'t see?', 'A needle'],
  ['What has a neck but no head?', 'A bottle'],
  ['What has words but never speaks?', 'A book'],
  ['What has a thumb and four fingers but is not alive?', 'A glove'],
  ['What invention lets you look through a wall?', 'A window'],
  ['What building has the most stories?', 'A library'],
  ['What kind of band never plays music?', 'A rubber band'],
  ['What kind of tree can you carry in your hand?', 'A palm'],
  ['What has four wheels and flies?', 'A garbage truck'],
  ['What runs but never walks?', 'A river'],
  ['What can you catch but not throw?', 'A cold'],
  ['What has an eye but cannot see?', 'A storm'],
  ['What is full of holes but still holds water?', 'A sponge'],
  ['What goes up but never comes down?', 'Your age'],
  ['What has a face and two hands but no arms or legs?', 'A clock'],
  ['The more you take, the more you leave behind. What am I?', 'Footsteps'],
  ['What belongs to you but is used more by others?', 'Your name'],
  ['What can fill a room but takes up no space?', 'Light'],
  ['What has cities but no houses, forests but no trees, and water but no fish?', 'A map'],
  ['What word is spelled incorrectly in every dictionary?', 'Incorrectly'],
  ['What comes once in a minute, twice in a moment, but never in a thousand years?', 'The letter M'],
  ['What is so fragile that saying its name breaks it?', 'Silence'],
  ['What has a bottom at the top?', 'Your legs'],
  ['What can you hold in your left hand but not in your right?', 'Your right elbow'],
  ['What gets bigger the more you take away?', 'A hole'],
  ['What has 13 hearts but no other organs?', 'A deck of cards'],
  ['What kind of room has no doors or windows?', 'A mushroom'],
  ['What kind of coat is always wet when you put it on?', 'A coat of paint'],
  ['What has ears but cannot hear?', 'Corn'],
  ['What has a ring but no finger?', 'A telephone'],
  ['What has legs but doesn\'t walk?', 'A table'],
  ['What has a bank but no money?', 'A river'],
  ['What has a bed but never sleeps?', 'A river'],
  ['What has a mouth but never speaks?', 'A river'],
  ['What has branches but no fruit, trunk, or leaves?', 'A bank'],
  ['What has a spine but no bones?', 'A book'],
  ['What has pages but is not a book?', 'A calendar'],
  ['What has a bark but no bite?', 'A tree'],
  ['What has a foot but no legs?', 'A snail'],
  ['What has a head but never weeps, and a bed but never sleeps?', 'A river'],
  ['What is always in front of you but can\'t be seen?', 'The future'],
  ['What goes through cities and fields but never moves?', 'A road'],
  ['What can you break, even if you never pick it up or touch it?', 'A promise'],
  ['What can you keep after giving it to someone?', 'Your word'],
  ['What disappears as soon as you say its name?', 'Silence'],
  ['What has many keys but can\'t open a single door?', 'A piano'],
  ['What has a golden head and a golden tail but no body?', 'A gold coin'],
  ['What is black when you buy it, red when you use it, and gray when you throw it away?', 'Charcoal'],
  ['What is always coming but never arrives?', 'Tomorrow'],
  ['What has no beginning, end, or middle?', 'A doughnut'],
  ['What has 88 keys but can\'t open a single door?', 'A piano'],
  ['What kind of cup can\'t hold water?', 'A cupcake'],
  ['What kind of ship has two mates but no captain?', 'A relationship'],
  ['What has a horn but does not honk?', 'A rhinoceros'],
  ['What has a tongue but cannot taste?', 'A shoe'],
  ['What has a sole but is not alive?', 'A shoe'],
  ['What has a cap but no head?', 'A bottle'],
  ['What has a lid but is not a pot?', 'An eye'],
  ['What has a pupil but is not a student?', 'An eye'],
  ['What has a brow but cannot frown?', 'An eye'],
  ['What has lashes but cannot blink on its own?', 'An eye'],
  ['What has a white cap and a red coat and stands in a garden?', 'A mushroom'],
  ['What has a yellow coat and a white vest and lives in a hive?', 'A bee'],
  ['What has a sting but is not angry?', 'A bee'],
  ['What has a comb but does not brush hair?', 'A rooster'],
  ['What has a bill but is not a duck?', 'A cap'],
  ['What has wings but is not a bird and is found on a stage?', 'A play'],
  ['What has a stage but no actors?', 'A rocket'],
  ['What has a launch but never leaves a dock?', 'A rocket'],
  ['What has a payload but is not a truck?', 'A rocket'],
  ['What has a trail but leaves no footprints?', 'A comet'],
  ['What has a tail and a head and is found in the sky?', 'A comet'],
  ['What is brighter than the sun but cannot be seen at night from Earth?', 'The sun'],
  ['I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?', 'An echo'],
  ['You see me once in June, twice in November, and not at all in May. What am I?', 'The letter E'],
  ['I have cities but no houses, mountains but no trees, and water but no fish. What am I?', 'A map'],
  ['The person who makes it sells it. The person who buys it never uses it. What is it?', 'A coffin'],
  ['What five-letter word becomes shorter when you add two letters to it?', 'Short'],
  ['What word becomes a palindrome when you take away its first letter?', 'Racecar'],
  ['Forward I am heavy, backward I am not. What am I?', 'Ton'],
  ['What starts with T, ends with T, and has T in it?', 'A teapot'],
  ['What begins with an E, ends with an E, but only has one letter?', 'An envelope'],
  ['Which letter of the alphabet has the most water?', 'C'],
  ['What letter is a drink?', 'T'],
  ['What letter is an insect?', 'B'],
  ['What letter is a body of water?', 'C'],
  ['What two things can you never eat for breakfast?', 'Lunch and dinner'],
  ['If you drop me I\'m sure to crack, but smile at me and I\'ll smile back. What am I?', 'A mirror'],
  ['What has a heart that doesn\'t beat?', 'An artichoke'],
  ['What is as light as a feather but even the strongest person can\'t hold it for long?', 'Breath'],
  ['What is easy to get into but hard to get out of?', 'Trouble'],
  ['What is always the last thing to mend, the middle of middle, and the end of the end?', 'The letter D'],
  ['What word looks the same upside down and backward?', 'SWIMS'],
  ['What occurs once in every minute, twice in every moment, yet never in a thousand years?', 'The letter M'],
  ['I am taken from a mine and shut up in a wooden case, from which I am never released, and yet I am used by almost everybody. What am I?', 'Pencil lead'],
  ['What is put on a table, cut, but never eaten?', 'A deck of cards'],
  ['What has four fingers and a thumb but is not alive?', 'A glove'],
  ['What has a neck, no head, and wears a cap?', 'A bottle'],
  ['What has a face that doesn\'t frown, hands that don\'t wave, and tells you something useful?', 'A clock'],
  ['What can run but never walks, has a mouth but never talks, has a head but never weeps, has a bed but never sleeps?', 'A river'],
  ['What English word has three consecutive double letters?', 'Bookkeeper'],
  ['What is the longest word in the dictionary?', 'Smiles. There is a mile between the first and last letter.'],
  ['What word of five letters has one left when two are removed?', 'Stone'],
  ['What is at the end of a rainbow?', 'The letter W'],
  ['What is in the middle of Paris?', 'R'],
  ['What is at the end of everything?', 'The letter G'],
  ['What comes at the end of time?', 'The letter E'],
  ['How many months have 28 days?', 'All of them'],
  ['What has 365 spots but never moves?', 'A calendar'],
  ['What is a witch\'s favorite subject in school?', 'Spelling'],
  ['What do you call a snowman in July?', 'A puddle'],
  ['What do you call cheese that isn\'t yours?', 'Nacho cheese'],
  ['What has a lot of bread and is very wealthy?', 'A bakery'],
  ['What kind of music do mummies listen to?', 'Wrap music'],
  ['What do you get when you cross a snowman and a dog?', 'Frostbite'],
  ['What has a bark but no bite and grows in a yard?', 'A tree'],
  ['What do you call a bear with no teeth?', 'A gummy bear'],
  ['What has a sweet tooth but is not a person?', 'A candy jar'],
  ['What has a yolk but is not an egg?', 'The sun'],
  ['What has a crust but is not bread?', 'The earth'],
  ['What has a core but is not an apple?', 'The earth'],
  ['What has poles but is not a tent?', 'The earth'],
  ['What has an equator but is not a planetarium?', 'The earth'],
  ['What has continents but no countries you can visit?', 'A globe'],
  ['What has oceans but no water you can drink?', 'A globe'],
  ['What has countries but no people?', 'A map'],
  ['What has roads but no cars?', 'A map'],
  ['What has streets but no traffic?', 'A map'],
  ['What has a scale but is not a fish?', 'A map'],
  ['What has a legend but is not a story?', 'A map'],
  ['What has a compass rose but no thorns?', 'A map'],
  ['What is a room you cannot enter?', 'A mushroom'],
  ['What is a house you cannot live in?', 'A greenhouse'],
  ['What is a school with no students?', 'A school of fish'],
  ['What is a bed you cannot sleep in?', 'A riverbed'],
  ['What is a bank you cannot rob?', 'A riverbank'],
  ['What is a fork in the road that you cannot eat with?', 'A junction'],
  ['What is a spring that is not a season?', 'A coil'],
  ['What is a fall that is not a season?', 'A waterfall'],
  ['What is a jam you cannot eat?', 'A traffic jam'],
  ['What is a date you cannot eat?', 'A calendar date'],
  ['What is a chip you cannot eat?', 'A poker chip'],
  ['What is a nail you cannot hammer?', 'A fingernail'],
  ['What is a fly you cannot swat?', 'A fly on a zipper'],
  ['What is a bat that never flies at night and is not alive?', 'A baseball bat'],
  ['What is a pitcher that never throws a ball?', 'A water pitcher'],
  ['What is a diamond that is not a gem?', 'A baseball field'],
  ['What has innings but is not a tavern?', 'A baseball game'],
  ['What has a strike but is not a union?', 'Bowling'],
  ['What has a spare but is not a tire?', 'Bowling'],
  ['What has a gutter but is not a street?', 'A bowling lane'],
  ['What has pins but is not a sewing kit?', 'Bowling'],
  ['What has a king but is not a country?', 'Chess'],
  ['What has a queen but is not a monarchy?', 'Chess'],
  ['What has a knight but no horse you can ride?', 'Chess'],
  ['What has a castle that never has a moat?', 'Chess'],
  ['What has pawns but is not a shop?', 'Chess'],
  ['What has a check but is not a bank?', 'Chess'],
  ['What has a mate but is not a pair of socks?', 'Chess'],
  ['What has a board but is not wood you walk on?', 'Chess'],
  ['What has squares but is not a city block?', 'A chessboard'],
  ['What has 64 squares and two colors?', 'A chessboard'],
  ['What has a deck but is not a porch?', 'A pack of cards'],
  ['What has suits but is not clothing?', 'A pack of cards'],
  ['What has clubs that are not for hitting golf balls?', 'A pack of cards'],
  ['What has hearts that do not beat?', 'A pack of cards'],
  ['What has spades that do not dig?', 'A pack of cards'],
  ['What has diamonds that are not jewels?', 'A pack of cards'],
  ['What has jokers but is not a comedy club?', 'A pack of cards'],
  ['What has an ace but is not a pilot?', 'A pack of cards'],
  ['What has a king and queen but no castle?', 'A pack of cards'],
  ['What has a jack but is not a car?', 'A pack of cards'],
  ['What question can you never answer yes to?', 'Are you asleep?'],
  ['What is yours but others use it more than you do?', 'Your name'],
  ['If you have me, you want to share me. If you share me, you haven\'t got me. What am I?', 'A secret'],
  ['What kind of button cannot be undone?', 'A belly button'],
  ['What kind of nail does a carpenter hate to hit?', 'A fingernail'],
  ['What kind of stone is never found in the sea?', 'A milestone'],
  ['What kind of star is afraid of the night?', 'A shooting star'],
  ['What is a draw you cannot sketch?', 'A tie'],
  ['What is a tie you cannot wear?', 'A draw'],
  ['What is a match you cannot light?', 'A contest'],
  ['What is a race you cannot run?', 'The human race'],
  ['What is a wave you cannot surf?', 'A wave of the hand'],
  ['What is a current you cannot swim in?', 'An electric current'],
  ['What is a charge you cannot pay with a card?', 'An electric charge'],
  ['What is a bolt that is not hardware?', 'A lightning bolt'],
  ['What is a strike that is not bowling?', 'Lightning'],
  ['What is a flash that is not a camera?', 'Lightning'],
  ['What is a clap that has no hands?', 'Thunder'],
  ['What is a boom you should not fear in a parade?', 'A bass drum'],
  ['What is a roll that is not bread?', 'A drum roll'],
  ['What is a beat you cannot eat?', 'A drumbeat'],
  ['What is a note you cannot pass in class?', 'A musical note'],
  ['What is a rest you cannot take on a couch?', 'A musical rest'],
  ['What is a scale you cannot climb?', 'A musical scale'],
  ['What is a staff that is not a stick?', 'A musical staff'],
  ['What is a bar you cannot drink at?', 'A measure of music'],
  ['What is a measure you cannot take with a ruler?', 'A bar of music'],
  ['What is a chord you cannot tie?', 'A musical chord'],
  ['What is a pitch you cannot throw?', 'A musical pitch'],
  ['What is a key that opens no door and starts no car?', 'A musical key'],
  ['What is a sharp that will not cut you?', 'A musical sharp'],
  ['What is a flat that is not an apartment?', 'A musical flat'],
  ['What is a natural that is not a park?', 'A musical natural'],
  ['What is a major that is not a soldier?', 'A musical major'],
  ['What is a minor that is not a child?', 'A musical minor'],
  ['What is an octave you cannot climb?', 'Eight notes'],
  ['What is a trio that is not three friends?', 'Three musicians'],
  ['What is a quartet that is not four cups?', 'Four musicians'],
  ['What is a solo you cannot fly?', 'A single musician'],
  ['What is a duet that is not a pair of shoes?', 'Two musicians'],
  ['What is a chorus you cannot join with only your feet?', 'Singers'],
  ['What is a verse that is not in church?', 'A song verse'],
  ['What is a bridge that cars cannot cross?', 'A song bridge'],
  ['What is a hook you cannot hang a coat on?', 'A song hook'],
  ['What is a refrain you cannot stop saying?', 'A chorus'],
  ['What is an album that is not a photo book?', 'A record'],
  ['What is a track that trains do not use?', 'A song'],
  ['What is a single that is not one person?', 'A song'],
  ['What is a record that is not a sports score?', 'A vinyl disc'],
  ['What is a disc that is not a plate?', 'A record'],
  ['What is a needle that does not sew?', 'A record needle'],
  ['What is a turntable that is not furniture you sit at?', 'A record player'],
  ['What is a speaker that never gives a speech?', 'A loudspeaker'],
  ['What is an amp that is not a unit of current?', 'A guitar amp'],
  ['What is a pick you cannot choose?', 'A guitar pick'],
  ['What is a fret you should not worry about?', 'A guitar fret'],
  ['What is a string that is not for a kite?', 'A guitar string'],
  ['What is a bow that is not a ribbon?', 'A violin bow'],
  ['What is a reed that does not grow in a pond?', 'A clarinet reed'],
  ['What is a slide that is not on a playground?', 'A trombone slide'],
  ['What is a mute that is not a person who is quiet?', 'A trumpet mute'],
  ['What is a pedal that is not on a bike?', 'A piano pedal'],
  ['What is a bench you sit on but never picnic on?', 'A piano bench'],
  ['What is a lid that is not on a jar?', 'A piano lid'],
  ['What is a hammer that does not hit a nail?', 'A piano hammer'],
  ['What is a damper that is not wet weather?', 'A piano damper'],
  ['What is a fallboard that is not autumn?', 'A piano cover'],
  ['What has 88 of me and makes music?', 'Keys'],
  ['I have no life, but I can die. What am I?', 'A battery'],
  ['I have no lungs but I need air. What am I?', 'A fire'],
  ['I have no legs but I can run. What am I?', 'A nose'],
  ['I have no wings but I can fly. What am I?', 'Time'],
  ['I have no voice but I can tell you stories. What am I?', 'A book'],
  ['I have no mouth but I can whisper. What am I?', 'The wind'],
  ['I have no eyes but I can shed tears. What am I?', 'A cloud'],
  ['I have no hands but I can wave. What am I?', 'A flag'],
  ['I have no feet but I can dance. What am I?', 'A flame'],
  ['I have no ears but I am told. What am I?', 'A story'],
  ['What has a lock but no key and holds your hair?', 'A lock of hair'],
  ['What has a part but is not a machine?', 'Hair'],
  ['What has a bang but is not a gun?', 'Hair'],
  ['What has a fringe but is not a lamp?', 'Hair'],
  ['What has a braid but is not bread?', 'Hair'],
  ['What has a curl but is not a ribbon alone?', 'Hair'],
  ['What has a split end but is not a road?', 'Hair'],
  ['What has roots you cannot see and grows on your head?', 'Hair'],
  ['What gets cut but never bleeds and grows back?', 'Hair'],
  ['What has a salon but is not a wild west town?', 'Hair'],
  ['What has a brush that is not for painting walls?', 'Hair'],
  ['What has a comb that is not a rooster?', 'Hair'],
  ['What has a clip that is not a movie?', 'Hair'],
  ['What has a tie that is not clothing?', 'Hair'],
  ['What has a pin that is not for bowling?', 'Hair'],
  ['What has a net that is not for fish?', 'Hair'],
  ['What has a bun that is not bread?', 'Hair'],
  ['What has a pony that is not a horse?', 'A ponytail'],
  ['What has a crown that is not for a king?', 'A tooth'],
  ['What has a root that is not a plant?', 'A tooth'],
  ['What has enamel but is not paint?', 'A tooth'],
  ['What has a cavity that is not a cave?', 'A tooth'],
  ['What has a filling that is not a pie?', 'A tooth'],
  ['What has a bite but is not a snack?', 'A tooth'],
  ['What has wisdom but is not a sage?', 'A wisdom tooth'],
  ['What has a dentist but is not a person?', 'A smile'],
  ['What has braces that are not for pants?', 'Teeth'],
  ['What has a gap that is not a store?', 'Teeth'],
];

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function letterSpaced(word) {
  const folded = fold(word);
  if (!folded || /\s/.test(folded) || folded.length < 2 || folded.length > 11) {
    return '';
  }
  const spaced = folded.split('').join(' ');
  return encodeText(spaced).length <= BODY_WIDTH ? spaced : '';
}

function usable(riddle, answer) {
  const q = clean(riddle, RIDDLE_MAX);
  const a = clean(answer, ANSWER_MAX);
  if (!q || !a || q.length < 12 || a.length < 1) {
    return null;
  }
  if (PROFANITY.test(q) || PROFANITY.test(a) || BAD_ANSWER.test(a)) {
    return null;
  }
  const foldedQ = fold(q);
  const foldedA = fold(a);
  if (!foldedQ || !foldedA) {
    return null;
  }
  const qLines = wrap(foldedQ, BODY_WIDTH);
  if (!qLines.length || qLines.length > RIDDLE_ROWS) {
    return null;
  }
  const spaced = letterSpaced(foldedA);
  const aLines = spaced ? [spaced] : wrap(foldedA, BODY_WIDTH);
  if (!aLines.length || aLines.length > ANSWER_ROWS) {
    return null;
  }
  return { riddle: q, answer: a, folded: `${foldedQ}|${foldedA}` };
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    if (row.length) {
      rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      continue;
    }
    if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    pushField();
    pushRow();
  }
  return rows;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: 'text/plain, application/json' } });
  if (!res.ok) {
    throw new Error(`${url} failed: ${res.status}`);
  }
  return res.text();
}

function addPair(pairs, riddle, answer, source) {
  const fit = usable(riddle, answer);
  if (!fit) {
    return false;
  }
  pairs.push({ ...fit, source });
  return true;
}

function loadNkilm(raw) {
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.riddles || data.data || []);
  return list.map((row) => ({
    riddle: row.riddle || row.question || row.q,
    answer: row.answer || row.a,
  }));
}

async function main() {
  const pairs = [];
  let dropped = 0;

  try {
    const csv = await fetchText(CRAWSOME);
    const rows = parseCsv(csv);
    for (const row of rows.slice(1)) {
      if (!addPair(pairs, row[0], row[1], 'crawsome')) {
        dropped += 1;
      }
    }
  } catch (error) {
    console.warn(`crawsome fetch skipped: ${error.message}`);
  }

  try {
    const raw = await fetchText(NKILM);
    for (const row of loadNkilm(raw)) {
      if (!addPair(pairs, row.riddle, row.answer, 'nkilm')) {
        dropped += 1;
      }
    }
  } catch (error) {
    console.warn(`nkilm fetch skipped: ${error.message}`);
  }

  for (const [riddle, answer] of EXTRA) {
    if (!addPair(pairs, riddle, answer, 'classic')) {
      dropped += 1;
    }
  }

  const seen = new Set();
  const riddles = [];
  for (const row of pairs) {
    if (seen.has(row.folded)) {
      dropped += 1;
      continue;
    }
    seen.add(row.folded);
    const id = `wr-${crypto.createHash('sha1').update(row.folded).digest('hex').slice(0, 10)}`;
    riddles.push({
      id,
      riddle: row.riddle,
      answer: row.answer,
    });
  }

  riddles.sort((a, b) => a.riddle.localeCompare(b.riddle) || a.answer.localeCompare(b.answer));

  const payload = {
    source: 'crawsome/riddles (Unlicense), nkilm/riddles-api (MIT), public-domain classics',
    builtAt: new Date().toISOString(),
    count: riddles.length,
    riddles,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${riddles.length} riddles to ${path.relative(process.cwd(), OUT)} (dropped ${dropped})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
