#!/usr/bin/env node
/**
 * Expand Party Prompts and Wheel of Fortune from open, family-safe sources.
 *
 *   node tools/build-game-decks.js
 *
 * Wheel phrases come from real English idiom / proverb lists (MIT + CC0),
 * not from a TV-show puzzle dump. Other categories are everyday places,
 * foods, events and public-domain songs. Party Prompts stay house-written
 * in the living-room style — Jackbox decks are not copied.
 *
 * Every row is re-gated through the same board checks the games use.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.wordlists');
const PROMPTS_OUT = path.join(ROOT, 'src', 'party-prompts-prompts.json');
const PUZZLES_OUT = path.join(ROOT, 'src', 'wheel-of-fortune-puzzles.json');

const { fold } = require('../src/vestaboard/encoder');
const { promptFits } = require('../src/party-prompts');
const { puzzleFits } = require('../src/wheel-of-fortune');

const SOURCES = [
  {
    id: 'english-idioms',
    url: 'https://raw.githubusercontent.com/WithEnglishWeCan/generated-english-idioms/master/idioms.build.json',
    license: 'MIT',
    parse(text) {
      const data = JSON.parse(text);
      return Object.keys(data || {});
    },
  },
  {
    id: 'corpora-proverbs',
    url: 'https://raw.githubusercontent.com/dariusk/corpora/master/data/words/proverbs.json',
    license: 'CC0',
    parse(text) {
      const data = JSON.parse(text);
      const out = [];
      for (const group of data.proverbs || []) {
        for (const list of Object.values(group)) {
          if (Array.isArray(list)) out.push(...list);
        }
      }
      return out;
    },
  },
  {
    id: 'lingoo-idioms',
    url: 'https://raw.githubusercontent.com/homayounmmdy/Lingoo/main/public/community/idioms.json',
    license: 'MIT',
    parse(text) {
      const data = JSON.parse(text);
      return (Array.isArray(data) ? data : []).map((row) => row.idiom).filter(Boolean);
    },
  },
];

const COMMON_WORDS_URL =
  'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears.txt';
const HARVEST_CAP = 360;
const SMALL = new Set(['A', 'I', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'OR', 'OX', 'SO', 'TO', 'UP', 'US', 'WE']);
const FRAGMENT = /\b(BARKUS|PEGGY|GIDDY|SACKCLOTH|MUCHNESS|EDGEWAYS|BLUE BLAZES|JUST COMING|TO LITTLE AVAIL|LITTLE AND OFTEN|ALL MY EYE|SHEETS TO THE WIND|ONE OVER THE EIGHT|NOT KNOW BEANS|NOT KNOW YOU ARE BORN|NOT WORTH THE CANDLE|PUT SOME DIRT|PIN DOWN WITH A LABEL|PIECES OF THE SAME CAKE|ON THE FACTORY FLOOR|RUN INTO THE SAND|PUSHING AT AN OPEN DOOR|OUT OF THE GATE RUNNING|OUT OF THE LEFT FIELD)\b/;

const YES_NO = /^(is|are|do|does|did|can|will|would|should|have|has)\b/i;
const TEMPLATE = /\b(someone|somebody|something|one's|sth|sb)\b|[{}[\]<>]|^\s*a poor man/i;
const UNSAFE = /\b(HELL|DAMN|DAMNED|ASS|ASSES|BASTARD|BITCH|CRAP|PISS|SEX|SEXY|NUDE|NAKED|WHORE|SLUT|SHIT|FUCK|DICK|COCK|BOOB|BOOBS|BREAST|BREASTS|SUICIDE|RAPE|NAZI|DRUNK|DRUNKEN|BEER|WHISKEY|WINE|HANGOVER|BLOODY|DEVIL|GAY|RETARD|RETARDED|HOOKER|PORN|WEED|JOINT|CIGAR|CIGARETTE)\b/;

function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'signal-bridge-game-decks' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (hops >= 5) {
          reject(new Error(`${url} redirected too many times`));
          return;
        }
        download(new URL(res.headers.location, url).href, hops + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} → ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function loadSource(source) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cache = path.join(CACHE_DIR, `${source.id}.txt`);
  if (fs.existsSync(cache)) {
    return source.parse(fs.readFileSync(cache, 'utf8'));
  }
  const body = await download(source.url);
  fs.writeFileSync(cache, body, 'utf8');
  return source.parse(body);
}

function lettersOf(folded) {
  return folded.replace(/[^A-Z]/g, '');
}

function cleanPhrase(raw) {
  return String(raw || '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseStem(folded) {
  return folded
    .replace(/\b(YOUR|MY|MINE|ONES)\b/g, '')
    .replace(/\b(THE|A|AN)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function playablePhrase(raw, common) {
  const cleaned = cleanPhrase(raw);
  if (!cleaned || TEMPLATE.test(cleaned) || /\d/.test(cleaned)) return '';
  if (/[()]/.test(cleaned)) return '';
  const folded = fold(cleaned.replace(/[.'’]/g, ''));
  if (!folded || !/^[A-Z ]+$/.test(folded)) return '';
  const words = folded.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 6) return '';
  const letters = lettersOf(folded);
  if (letters.length < 14 || letters.length > 36) return '';
  if (words.some((w) => w.length === 1 && w !== 'A' && w !== 'I')) return '';
  if (UNSAFE.test(folded) || FRAGMENT.test(folded)) return '';
  if (common) {
    const rare = words.filter((w) => !SMALL.has(w) && !common.has(w.toLowerCase()));
    if (rare.length) return '';
  }
  if (!puzzleFits({ category: 'PHRASE', puzzle: folded })) return '';
  return folded;
}

function scorePhrase(folded, votes) {
  const words = folded.split(/\s+/).filter(Boolean);
  const letters = lettersOf(folded);
  let score = 0;
  score += (votes.proverb || 0) * 4;
  score += (votes.lingoo || 0) * 3;
  score += (votes.idiom || 0);
  if (words.length === 4 || words.length === 5) score += 2;
  if (letters >= 16 && letters <= 28) score += 2;
  if (/\b(YOUR|MY|MINE)\b/.test(folded)) score -= 3;
  if (votes.proverb && votes.idiom) score += 3;
  return score;
}

function keepExistingPuzzle(row) {
  if (!row || !puzzleFits(row)) return false;
  const puzzle = fold(row.puzzle);
  const letters = lettersOf(puzzle);
  if (letters.length < 6) return false;
  if (UNSAFE.test(puzzle) || UNSAFE.test(fold(row.category))) return false;
  return true;
}

function puzzleDedupeKey(row) {
  return phraseStem(fold(row.puzzle)) || fold(row.puzzle);
}

function addPuzzle(out, seen, category, puzzle) {
  const row = { category: fold(category), puzzle: fold(puzzle) };
  if (!puzzleFits(row)) return false;
  if (UNSAFE.test(row.puzzle) || UNSAFE.test(row.category)) return false;
  const key = puzzleDedupeKey(row);
  if (seen.has(key)) return false;
  seen.add(key);
  out.push(row);
  return true;
}

const DROP_EXISTING = new Set([
  'UP',
  'YO YO',
  'THE FRENCH QUARTER',
  'FOOT BALL GAME',
  'RAIN BOW TIE',
  'SUN FLOWER POT',
]);

const REPLACE_EXISTING = {
  'FIREPLACE MANTLE': { category: 'AROUND THE HOUSE', puzzle: 'FIREPLACE MANTEL' },
};

const EXTRA_PUZZLES = [
  ['BEFORE AND AFTER', 'FLOWER POT LUCK'],
  ['BEFORE AND AFTER', 'BALL GAME SHOW'],
  ['BEFORE AND AFTER', 'BOW TIE THE KNOT'],
  ['BEFORE AND AFTER', 'HIGH SCHOOL OF FISH'],
  ['BEFORE AND AFTER', 'CREDIT CARD TRICK'],
  ['BEFORE AND AFTER', 'CHICKEN SOUP KITCHEN'],
  ['BEFORE AND AFTER', 'BIRTHDAY CAKE WALK'],
  ['BEFORE AND AFTER', 'MAGIC CARPET CLEANER'],
  ['BEFORE AND AFTER', 'POLAR BEAR HUG'],
  ['BEFORE AND AFTER', 'PINEAPPLE JUICE BOX'],
  ['BEFORE AND AFTER', 'TENNIS SHOE STORE'],
  ['BEFORE AND AFTER', 'FRENCH FRY COOK'],
  ['BEFORE AND AFTER', 'CHRISTMAS TREE HOUSE'],
  ['BEFORE AND AFTER', 'PEANUT BUTTER FINGERS'],
  ['BEFORE AND AFTER', 'TOOTH FAIRY TALE'],
  ['BEFORE AND AFTER', 'TRAFFIC JAM SESSION'],
  ['BEFORE AND AFTER', 'PLAY GROUND BEEF'],
  ['BEFORE AND AFTER', 'FRONT DOOR PRIZE'],
  ['BEFORE AND AFTER', 'CROSS WALK OF FAME'],
  ['BEFORE AND AFTER', 'POP CORN ON THE COB'],
  ['BEFORE AND AFTER', 'APPLE PIE IN THE SKY'],
  ['BEFORE AND AFTER', 'ICE CREAM SOCIAL'],
  ['BEFORE AND AFTER', 'SODA FOUNTAIN PEN'],
  ['BEFORE AND AFTER', 'SCHOOL BUS STOP'],
  ['BEFORE AND AFTER', 'HOME WORK OF ART'],
  ['BEFORE AND AFTER', 'SWIM SUIT CASE'],
  ['BEFORE AND AFTER', 'BEACH BALL GOWN'],
  ['BEFORE AND AFTER', 'SAND CASTLE IN THE SKY'],
  ['BEFORE AND AFTER', 'DOG HOUSE WARMING'],
  ['BEFORE AND AFTER', 'GREEN HOUSE PLANT'],
  ['PLACE', 'MOUNT EVEREST'],
  ['PLACE', 'TAJ MAHAL'],
  ['PLACE', 'SYDNEY OPERA HOUSE'],
  ['PLACE', 'BUCKINGHAM PALACE'],
  ['PLACE', 'TOWER OF LONDON'],
  ['PLACE', 'LOUVRE MUSEUM'],
  ['PLACE', 'GRAND CENTRAL STATION'],
  ['PLACE', 'YOSEMITE VALLEY'],
  ['PLACE', 'LIBERTY BELL'],
  ['PLACE', 'CRATER LAKE'],
  ['PLACE', 'REDWOOD FOREST'],
  ['PLACE', 'THE PANTHEON'],
  ['PLACE', 'TOWER BRIDGE'],
  ['PLACE', 'LONDON EYE'],
  ['PLACE', 'EDINBURGH CASTLE'],
  ['PLACE', 'BANFF NATIONAL PARK'],
  ['PLACE', 'THE ACROPOLIS'],
  ['PLACE', 'PYRAMIDS OF GIZA'],
  ['PLACE', 'VICTORIA FALLS'],
  ['PLACE', 'TABLE MOUNTAIN'],
  ['PLACE', 'THE ALHAMBRA'],
  ['PLACE', 'HOLLYWOOD SIGN'],
  ['PLACE', 'GRIFFITH OBSERVATORY'],
  ['PLACE', 'PIKE PLACE MARKET'],
  ['PLACE', 'FREEDOM TRAIL'],
  ['PLACE', 'FENWAY PARK'],
  ['PLACE', 'WRIGLEY FIELD'],
  ['PLACE', 'LAMBEAU FIELD'],
  ['PLACE', 'MOUNT RAINIER'],
  ['PLACE', 'MONUMENT VALLEY'],
  ['PLACE', 'THE SMITHSONIAN CASTLE'],
  ['ON THE MAP', 'ATLANTIC OCEAN'],
  ['ON THE MAP', 'GULF OF MEXICO'],
  ['ON THE MAP', 'HUDSON RIVER'],
  ['ON THE MAP', 'AMAZON RIVER'],
  ['ON THE MAP', 'NILE RIVER'],
  ['ON THE MAP', 'SAHARA DESERT'],
  ['ON THE MAP', 'ANDES MOUNTAINS'],
  ['ON THE MAP', 'APPALACHIAN TRAIL'],
  ['ON THE MAP', 'ENGLISH CHANNEL'],
  ['ON THE MAP', 'MEDITERRANEAN SEA'],
  ['ON THE MAP', 'CARIBBEAN SEA'],
  ['ON THE MAP', 'THE PACIFIC NORTHWEST'],
  ['ON THE MAP', 'THE GREAT PLAINS'],
  ['ON THE MAP', 'THE CANADIAN ROCKIES'],
  ['ON THE MAP', 'THE SCOTTISH HIGHLANDS'],
  ['ON THE MAP', 'YUCATAN PENINSULA'],
  ['ON THE MAP', 'WASHINGTON DC'],
  ['ON THE MAP', 'SAN FRANCISCO'],
  ['ON THE MAP', 'NEW ORLEANS'],
  ['ON THE MAP', 'SALT LAKE CITY'],
  ['ON THE MAP', 'HONOLULU HAWAII'],
  ['ON THE MAP', 'PORTLAND OREGON'],
  ['ON THE MAP', 'MIAMI FLORIDA'],
  ['ON THE MAP', 'BOSTON MASSACHUSETTS'],
  ['FOOD', 'CHICKEN PARMESAN'],
  ['FOOD', 'EGGS BENEDICT'],
  ['FOOD', 'CAESAR SALAD'],
  ['FOOD', 'CLAM CHOWDER'],
  ['FOOD', 'LOBSTER ROLL'],
  ['FOOD', 'CHICKEN TIKKA MASALA'],
  ['FOOD', 'PAD THAI'],
  ['FOOD', 'GUACAMOLE AND CHIPS'],
  ['FOOD', 'KEY LIME PIE'],
  ['FOOD', 'SHEPHERDS PIE'],
  ['FOOD', 'BANGERS AND MASH'],
  ['FOOD', 'YORKSHIRE PUDDING'],
  ['FOOD', 'CHICKEN AND WAFFLES'],
  ['FOOD', 'BISCUITS AND GRAVY'],
  ['FOOD', 'PHILLY CHEESESTEAK'],
  ['FOOD', 'CHICAGO DEEP DISH PIZZA'],
  ['FOOD', 'SHRIMP AND GRITS'],
  ['FOOD', 'BEIGNETS AND COFFEE'],
  ['FOOD', 'TURKEY CLUB SANDWICH'],
  ['FOOD', 'BELGIAN WAFFLES'],
  ['FOOD', 'BLUEBERRY PANCAKES'],
  ['FOOD', 'BAGEL AND CREAM CHEESE'],
  ['FOOD', 'FETTUCCINE ALFREDO'],
  ['FOOD', 'LOADED BAKED POTATO'],
  ['FOOD', 'ROOT BEER FLOAT'],
  ['FOOD', 'COTTON CANDY'],
  ['FOOD', 'CANDY APPLE'],
  ['FOOD', 'SWEET POTATO PIE'],
  ['FOOD', 'NEW ENGLAND CLAM CHOWDER'],
  ['FOOD', 'CORNISH PASTY'],
  ['THING', 'FIRST AID KIT'],
  ['THING', 'FIRE EXTINGUISHER'],
  ['THING', 'SMOKE DETECTOR'],
  ['THING', 'PICNIC BASKET'],
  ['THING', 'BOARDING PASS'],
  ['THING', 'SPIRAL NOTEBOOK'],
  ['THING', 'PENCIL SHARPENER'],
  ['THING', 'WATERING CAN'],
  ['THING', 'WHEELBARROW'],
  ['THING', 'BIRD FEEDER'],
  ['THING', 'RECORD PLAYER'],
  ['THING', 'EXTENSION CORD'],
  ['THING', 'JUMPER CABLES'],
  ['THING', 'WINDSHIELD WIPER'],
  ['THING', 'LICENSE PLATE'],
  ['THING', 'SWIM GOGGLES'],
  ['THING', 'BEACH TOWEL'],
  ['THING', 'LUNCH BOX'],
  ['THING', 'PAPER CLIP'],
  ['THING', 'STICKY NOTE'],
  ['AROUND THE HOUSE', 'KITCHEN COUNTER'],
  ['AROUND THE HOUSE', 'CUTTING BOARD'],
  ['AROUND THE HOUSE', 'COFFEE MAKER'],
  ['AROUND THE HOUSE', 'TEA KETTLE'],
  ['AROUND THE HOUSE', 'OVEN MITT'],
  ['AROUND THE HOUSE', 'VACUUM CLEANER'],
  ['AROUND THE HOUSE', 'IRONING BOARD'],
  ['AROUND THE HOUSE', 'THROW PILLOW'],
  ['AROUND THE HOUSE', 'MAGAZINE RACK'],
  ['AROUND THE HOUSE', 'POWER STRIP'],
  ['AROUND THE HOUSE', 'PORCH LIGHT'],
  ['AROUND THE HOUSE', 'PATIO CHAIR'],
  ['AROUND THE HOUSE', 'STORM DOOR'],
  ['AROUND THE HOUSE', 'GARAGE DOOR'],
  ['AROUND THE HOUSE', 'WATER HEATER'],
  ['AROUND THE HOUSE', 'CIRCUIT BREAKER'],
  ['AROUND THE HOUSE', 'WEATHER VANE'],
  ['AROUND THE HOUSE', 'SILVERWARE DRAWER'],
  ['AROUND THE HOUSE', 'COOKIE JAR'],
  ['AROUND THE HOUSE', 'LAUNDRY HAMPER'],
  ['PERSON', 'MOTHER NATURE'],
  ['PERSON', 'FATHER TIME'],
  ['PERSON', 'JACK FROST'],
  ['PERSON', 'UNCLE SAM'],
  ['PERSON', 'LITTLE BO PEEP'],
  ['PERSON', 'THE THREE LITTLE PIGS'],
  ['PERSON', 'GOLDILOCKS'],
  ['PERSON', 'THE LIGHTHOUSE KEEPER'],
  ['PERSON', 'THE CROSSING GUARD'],
  ['PERSON', 'THE ICE CREAM MAN'],
  ['PERSON', 'AMELIA EARHART'],
  ['PERSON', 'HELEN KELLER'],
  ['PERSON', 'HARRIET TUBMAN'],
  ['PERSON', 'BENJAMIN FRANKLIN'],
  ['PERSON', 'FLORENCE NIGHTINGALE'],
  ['LIVING THING', 'AFRICAN ELEPHANT'],
  ['LIVING THING', 'BENGAL TIGER'],
  ['LIVING THING', 'SNOW LEOPARD'],
  ['LIVING THING', 'GRIZZLY BEAR'],
  ['LIVING THING', 'EMPEROR PENGUIN'],
  ['LIVING THING', 'GREAT HORNED OWL'],
  ['LIVING THING', 'CANADA GOOSE'],
  ['LIVING THING', 'GREAT WHITE SHARK'],
  ['LIVING THING', 'SEA OTTER'],
  ['LIVING THING', 'WHITE TAILED DEER'],
  ['LIVING THING', 'AMERICAN ALLIGATOR'],
  ['LIVING THING', 'PRAYING MANTIS'],
  ['LIVING THING', 'CHERRY BLOSSOM'],
  ['LIVING THING', 'WILLOW TREE'],
  ['LIVING THING', 'REDWOOD TREE'],
  ['EVENT', 'HOUSEWARMING PARTY'],
  ['EVENT', 'POTLUCK DINNER'],
  ['EVENT', 'TAILGATE PARTY'],
  ['EVENT', 'HOMECOMING DANCE'],
  ['EVENT', 'CLASS REUNION'],
  ['EVENT', 'SPELLING BEE'],
  ['EVENT', 'FARMERS MARKET'],
  ['EVENT', 'FIREWORKS SHOW'],
  ['EVENT', 'EASTER EGG HUNT'],
  ['EVENT', 'CHRISTMAS MORNING'],
  ['EVENT', 'FIRST DAY OF SCHOOL'],
  ['EVENT', 'SUMMER VACATION'],
  ['EVENT', 'LITTLE LEAGUE GAME'],
  ['EVENT', 'DANCE RECITAL'],
  ['EVENT', 'CHILI COOK OFF'],
  ['EVENT', 'STATE FAIR'],
  ['EVENT', 'SNOW DAY'],
  ['WHAT ARE YOU DOING', 'WASHING THE CAR'],
  ['WHAT ARE YOU DOING', 'RAKING THE LEAVES'],
  ['WHAT ARE YOU DOING', 'SHOVELING SNOW'],
  ['WHAT ARE YOU DOING', 'WATERING THE PLANTS'],
  ['WHAT ARE YOU DOING', 'WRAPPING A PRESENT'],
  ['WHAT ARE YOU DOING', 'CARVING A PUMPKIN'],
  ['WHAT ARE YOU DOING', 'BUILDING A SNOWMAN'],
  ['WHAT ARE YOU DOING', 'PICKING APPLES'],
  ['WHAT ARE YOU DOING', 'ROASTING MARSHMALLOWS'],
  ['WHAT ARE YOU DOING', 'SKIPPING STONES'],
  ['WHAT ARE YOU DOING', 'LOADING THE DISHWASHER'],
  ['WHAT ARE YOU DOING', 'MATCHING THE SOCKS'],
  ['WHAT ARE YOU DOING', 'READING A BEDTIME STORY'],
  ['WHAT ARE YOU DOING', 'TURNING OUT THE LIGHTS'],
  ['WHAT ARE YOU DOING', 'CROSSING THE FINISH LINE'],
  ['MOVIE TITLE', 'GONE WITH THE WIND'],
  ['MOVIE TITLE', 'THE PRINCESS BRIDE'],
  ['MOVIE TITLE', 'THE SECRET GARDEN'],
  ['MOVIE TITLE', 'THE LORD OF THE RINGS'],
  ['MOVIE TITLE', 'THE EMPIRE STRIKES BACK'],
  ['MOVIE TITLE', 'THE KARATE KID'],
  ['MOVIE TITLE', 'A LEAGUE OF THEIR OWN'],
  ['MOVIE TITLE', 'FIELD OF DREAMS'],
  ['MOVIE TITLE', 'THE SANDLOT'],
  ['MOVIE TITLE', 'SINGIN IN THE RAIN'],
  ['MOVIE TITLE', 'THE JUNGLE BOOK'],
  ['MOVIE TITLE', 'SNOW WHITE AND THE SEVEN DWARFS'],
  ['MOVIE TITLE', 'ALICE IN WONDERLAND'],
  ['MOVIE TITLE', 'HOW TO TRAIN YOUR DRAGON'],
  ['MOVIE TITLE', 'CHARLIE AND THE CHOCOLATE FACTORY'],
  ['MOVIE TITLE', 'MIRACLE ON THIRTY FOURTH STREET'],
  ['SONG TITLE', 'AULD LANG SYNE'],
  ['SONG TITLE', 'THE STAR SPANGLED BANNER'],
  ['SONG TITLE', 'WHEN THE SAINTS GO MARCHING IN'],
  ['SONG TITLE', 'AMAZING GRACE'],
  ['SONG TITLE', 'THIS LITTLE LIGHT OF MINE'],
  ['SONG TITLE', 'LONDON BRIDGE IS FALLING DOWN'],
  ['SONG TITLE', 'MARY HAD A LITTLE LAMB'],
  ['SONG TITLE', 'JINGLE BELLS'],
  ['SONG TITLE', 'SILENT NIGHT'],
  ['SONG TITLE', 'DECK THE HALLS'],
  ['SONG TITLE', 'WE WISH YOU A MERRY CHRISTMAS'],
  ['SONG TITLE', 'THE TWELVE DAYS OF CHRISTMAS'],
  ['SONG TITLE', 'FROSTY THE SNOWMAN'],
  ['SONG TITLE', 'WINTER WONDERLAND'],
  ['SONG TITLE', 'WHAT A WONDERFUL WORLD'],
  ['SONG TITLE', 'SHELL BE COMING ROUND THE MOUNTAIN'],
  ['SONG TITLE', 'IVE BEEN WORKING ON THE RAILROAD'],
  ['SONG TITLE', 'MY BONNIE LIES OVER THE OCEAN'],
];

const NEW_PROMPTS = [
  'A terrible name for a WiFi network',
  'The worst caption for a family photo',
  'Something a GPS should never say',
  'A rejected Olympic sport',
  'The worst thing to 3D print',
  'A bad name for a weather app',
  'Invent a new traffic law nobody asked for',
  'The most suspicious leftover in the fridge',
  'A terrible slogan for a library',
  'The worst thing to name a houseplant',
  'A bad reason to press the elevator alarm',
  'Something you should never write on a cake',
  'The worst prize in a cereal box',
  'A terrible name for a toothpaste flavour',
  'The most useless smartphone app',
  'A bad name for a rollercoaster',
  'Something a weather presenter should never say',
  'The worst thing to find in a coat pocket',
  'A terrible theme for a school dance',
  'Invent a new holiday that lasts one hour',
  'The worst thing to shout during a toast',
  'A bad name for a moving company',
  'Something you should never laminate',
  'The worst job for someone who hates mornings',
  'A terrible name for a toothpaste for dogs',
  'The most confusing label on a jar',
  'A bad slogan for a car wash',
  'Something you should not do with glitter',
  'The worst thing to keep in a lunchbox overnight',
  'A terrible name for a hiking trail',
  'The worst thing to hear from a tour guide',
  'A bad name for a pencil',
  'Something you should never autograph',
  'The worst possible museum exhibit',
  'A terrible name for a laundry detergent',
  'The most dramatic way to return a library book',
  'A bad reason to climb a tree',
  'Something a robot vacuum should never do',
  'The worst thing to write on a sticky note',
  'A terrible name for a flashlight',
  'The worst sound to hear in a tent',
  'A bad name for a cookbook',
  'Something you should never gift wrap',
  'The worst thing to say while cutting a cake',
  'A terrible slogan for a hardware store',
  'Invent a new rule for board game night',
  'The worst thing to name a group chat',
  'A bad name for a bicycle',
  'Something you should not store in a jar',
  'The worst possible hold music',
  'A terrible name for a pair of slippers',
  'The most unhelpful packing tip',
  'A bad way to label leftovers',
  'Something you should never say to a magician',
  'The worst thing to find in a picnic basket',
  'A terrible name for a lighthouse',
  'The worst job at a theme park',
  'A bad slogan for a bakery',
  'Something you should not do with a paperclip',
  'The worst thing to hear from a GPS in a tunnel',
  'A terrible name for a snowman',
  'The most useless kitchen gadget',
  'A bad name for an umbrella company',
  'Something you should never engrave',
  'The worst thing to say at a potluck',
  'A terrible theme for a book club',
  'Invent a new sport using only a spoon',
  'The worst thing to name a WiFi printer',
  'A bad reason to skip dessert',
  'Something a scarecrow should never wear',
  'The worst possible fortune in a cookie',
  'A terrible name for a ferry',
  'The worst thing to keep in a desk drawer',
  'A bad name for a marching band',
  'Something you should not do at a farmers market',
  'The worst thing to shout on a silent hike',
  'A terrible slogan for a zoo',
  'The most suspicious item in a lost and found',
  'A bad way to start a campfire story',
  'Something you should never put on a sandwich board',
  'The worst thing to hear from a dental hygienist',
  'A terrible name for a pencil case',
  'The worst prize at a county fair',
  'A bad name for a weather balloon',
  'Something you should not say to a crossing guard',
  'The worst thing to find in a sleeping bag',
  'A terrible name for a salad dressing',
  'Invent a new chore for a rainy Sunday',
  'The worst thing to name a stuffed animal in public',
  'A bad slogan for a train station',
  'Something you should never write in wet cement',
  'The worst possible class field trip',
  'A terrible name for a paper airplane',
  'The most useless button on a remote',
  'A bad name for a garden gnome',
  'Something you should not do with a rubber band',
  'The worst thing to say while opening a present',
  'A terrible theme for a bake sale',
  'The worst job for someone afraid of loud noises',
  'A bad reason to honk the horn',
  'Something a talking toy should never say',
  'The worst thing to keep in a picnic cooler',
  'A terrible name for a rowboat',
  'The most confusing street name',
  'A bad slogan for a post office',
  'Something you should never iron',
  'The worst thing to hear from a substitute teacher',
  'A terrible name for a glue stick',
  'The worst possible school announcement',
  'A bad name for a compass',
  'Something you should not do in a photo booth',
  'The worst thing to find in a toolbox that is not a tool',
  'A terrible name for a pancake house',
  'Invent a new rule for the car ride',
  'The worst thing to name a playlist',
  'A bad way to ask for the last cookie',
  'Something you should never put on a bumper sticker',
  'The worst thing to shout during a quiet exam',
  'A terrible slogan for a swimming pool',
  'The most dramatic way to water a plant',
  'A bad name for a pair of rain boots',
  'Something you should not keep in a sock drawer',
  'The worst thing to hear from a tour bus driver',
  'A terrible name for a science fair project',
  'The worst prize in a claw machine',
  'A bad name for a stapler',
  'Something you should never say to a bus driver',
  'The worst thing to find taped to the fridge',
  'A terrible theme for a talent show',
  'Invent a new use for a leftover paper plate',
  'The worst thing to name a team of goldfish',
  'A bad slogan for a museum gift shop',
  'Something you should not do with a measuring tape',
  'The worst thing to hear at a lost and found window',
  'A terrible name for a flashlight app',
  'The most unhelpful map legend',
  'A bad name for a tent',
  'Something you should never write on a whiteboard',
  'The worst thing to say while someone is juggling',
  'A terrible name for a juice box flavour',
  'The worst job at a bakery before dawn',
  'A bad reason to ring a bicycle bell',
  'Something a talking fridge should never announce',
  'The worst thing to keep in a glove for luck',
  'A terrible name for a skate park',
  'The most suspicious casserole title',
  'A bad slogan for a bicycle shop',
  'Something you should not do with leftover wrapping paper',
  'The worst thing to hear from a camp counsellor',
  'A terrible name for a pair of mittens',
  'The worst possible message on a birthday balloon',
  'A bad name for a rubber duck',
  'Something you should never hide in a cake',
  'The worst thing to shout from a Ferris wheel',
  'A terrible theme for a neighbourhood potluck',
  'Invent a new handshake that uses a spoon',
  'The worst thing to name a house alarm',
  'A bad way to explain a traffic cone',
  'Something you should not put in a time capsule',
  'The worst thing to find in a coat check',
  'A terrible name for a bubble bath',
  'The most useless instruction on a box',
  'A bad slogan for a kite shop',
  'Something you should never say into a megaphone',
  'The worst thing to hear from a puppet',
  'A terrible name for a sandwich press',
  'The worst job for someone who hates waiting',
  'A bad name for a calendar app',
  'Something you should not do with a snow globe',
  'The worst thing to write on a foggy window',
  'A terrible theme for a retirement cake',
  'Invent a new rule for sharing a sofa',
  'The worst thing to name a house key',
  'A bad reason to start a conga line',
  'Something a garden gnome is secretly judging',
  'The worst thing to keep in a piano bench',
  'A terrible name for a bus route',
  'The most confusing warning label',
  'A bad slogan for a candle shop',
  'Something you should never whisper in a cave',
  'The worst thing to hear from a fortune teller at a fair',
  'A terrible name for a pair of binoculars',
  'The worst possible dedication in a yearbook',
  'A bad name for a thermos',
  'Something you should not do during a quiet car ride',
  'The worst thing to find in a hotel ice bucket',
  'A terrible name for a boardwalk stand',
  'Invent a new Olympic event for leftover leftovers',
  'The worst thing to shout when the lights come back on',
  'A bad way to introduce a surprise guest',
  'Something you should never print on a family T shirt',
  'The worst thing to hear from a talking alarm clock',
  'A terrible slogan for a hardware aisle',
  'The most dramatic way to open a bag of chips',
  'A bad name for a paper towel brand',
  'Something you should not keep in a fishbowl',
  'The worst thing to say while someone ties a tie',
  'A terrible name for a rest stop',
  'The worst prize in a supermarket sweep',
  'A bad name for a flashlight dog toy',
  'Something you should never announce on a PA system',
  'The worst thing to find in a raincoat pocket',
  'A terrible theme for a science museum sleepover',
  'Invent a new chore that uses only a sock',
  'The worst thing to name a neighbourhood watch group',
  'A bad slogan for a clock shop',
  'Something you should not do with a whoopee cushion at brunch',
  'The worst thing to hear from the person holding the map',
  'A terrible name for a picnic blanket',
  'The most useless souvenir from a rest stop',
  'A bad name for a weather vane',
  'Something you should never write on a steamed bathroom mirror',
  'The worst thing to shout at a silent auction',
  'A terrible name for a leftover mystery stew',
  'Complete this: the house plant is named',
  'Complete this: my backup career would be',
  'Complete this: the family motto should be',
  'Complete this: I would ban from picnics',
  'Complete this: the dog is secretly',
  'Complete this: never pack for a trip',
  'Complete this: the attic is hiding',
  'Complete this: I would rename Monday',
  'Complete this: the fridge light knows',
  'Complete this: my acceptance speech begins',
  'A rejected name for a constellation',
  'The worst thing to sculpt out of mashed potatoes',
  'A bad name for a public park fountain',
  'Something you should never demonstrate at a hardware store',
  'The worst possible title for a lost cat poster',
  'A terrible name for a community choir',
  'The most unhelpful tip on a hiking sign',
  'A bad reason to start a parade',
  'Something a museum audio guide should never add',
  'The worst thing to hear from the person with the tickets',
];

function addPrompt(out, seen, text) {
  const raw = String(text || '').trim();
  if (!raw || YES_NO.test(raw) || /\?$/.test(raw)) return false;
  if (!promptFits(raw)) return false;
  const key = fold(raw);
  if (!key || seen.has(key)) return false;
  if (UNSAFE.test(key)) return false;
  seen.add(key);
  out.push(raw);
  return true;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const existingPrompts = JSON.parse(fs.readFileSync(PROMPTS_OUT, 'utf8'));
  const existingPuzzles = JSON.parse(fs.readFileSync(PUZZLES_OUT, 'utf8'));

  const promptSeen = new Set();
  const prompts = [];
  for (const row of existingPrompts) addPrompt(prompts, promptSeen, row);
  const keptPrompts = prompts.length;
  for (const row of NEW_PROMPTS) addPrompt(prompts, promptSeen, row);

  const phraseSeen = new Set();
  const puzzles = [];
  for (const row of existingPuzzles) {
    const swapped = REPLACE_EXISTING[fold(row.puzzle)];
    const next = swapped || row;
    if (DROP_EXISTING.has(fold(next.puzzle))) continue;
    if (!keepExistingPuzzle(next)) continue;
    addPuzzle(puzzles, phraseSeen, next.category, next.puzzle);
  }
  const keptPuzzles = puzzles.length;

  const commonText = await download(COMMON_WORDS_URL);
  const common = new Set(commonText.split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter(Boolean));
  console.log(`common words: ${common.size}`);

  const votes = new Map();
  for (const source of SOURCES) {
    const rows = await loadSource(source);
    const tag = source.id === 'corpora-proverbs' ? 'proverb' : source.id === 'lingoo-idioms' ? 'lingoo' : 'idiom';
    let playable = 0;
    for (const row of rows) {
      const phrase = playablePhrase(row, common);
      if (!phrase) continue;
      playable += 1;
      const cur = votes.get(phrase) || { phrase, idiom: 0, proverb: 0, lingoo: 0 };
      cur[tag] += 1;
      votes.set(phrase, cur);
    }
    console.log(`${source.id} (${source.license}): ${rows.length} raw, ${playable} playable`);
  }

  const ranked = [...votes.values()]
    .map((row) => ({ ...row, score: scorePhrase(row.phrase, row) }))
    .sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));

  const harvested = [];
  for (const row of ranked) {
    if (harvested.length >= HARVEST_CAP) break;
    if (addPuzzle(puzzles, phraseSeen, 'PHRASE', row.phrase)) harvested.push(row.phrase);
  }

  let extras = 0;
  for (const [category, puzzle] of EXTRA_PUZZLES) {
    if (addPuzzle(puzzles, phraseSeen, category, puzzle)) extras += 1;
  }

  writeJson(PROMPTS_OUT, prompts);
  writeJson(PUZZLES_OUT, puzzles);

  const byCat = {};
  for (const row of puzzles) {
    byCat[row.category] = (byCat[row.category] || 0) + 1;
  }

  console.log(`prompts: ${keptPrompts} kept + ${prompts.length - keptPrompts} new = ${prompts.length}`);
  console.log(`puzzles: ${keptPuzzles} kept + ${harvested.length} harvested + ${extras} extras = ${puzzles.length}`);
  console.log(byCat);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
