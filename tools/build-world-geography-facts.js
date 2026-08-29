#!/usr/bin/env node
/**
 * Build the shipped World Geography Facts corpus.
 *
 * Sources (build-time only — no API keys, no runtime network):
 *   1. mledoze/countries (ODbL) — capitals, regions, languages, currencies,
 *      landlocked status, borders, calling codes, area rankings
 *   2. Open Trivia Database Geography dump (OTDB-Source) — Q&A rewritten as
 *      board-fit statements
 *   3. Curated natural-wonder / landmark / extreme-point facts (handwritten)
 *
 * Keeps facts that fold into at most 5×22 under a WORLD GEOGRAPHY title.
 *
 *   node tools/build-world-geography-facts.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fold, wrap } = require('../src/vestaboard/encoder');

const OUT = path.join(__dirname, '..', 'src', 'world-geography-facts-facts.json');
const BODY_ROWS = 5;
const BODY_WIDTH = 22;

const COUNTRIES_URL = 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json';
const OTDB_GEO_URL = 'https://raw.githubusercontent.com/QuartzWarrior/OTDB-Source/main/Geography.csv';

const PROFANITY = /\b(fuck|shit|asshole|bitch|cunt|dick|pussy|cock|nigger|faggot|slut|whore|rape|raped|incest|penis|vagina|sperm|orgasm|masturbat|dildo|blowjob|handjob|jizz|cum\b|anal|sex\b|sexual|nude|naked|porn|hentai)\b/i;

/** Classic board-fit geography quirks that structured country data won't invent. */
const CURATED = [
  { category: 'extremes', text: 'Mount Everest is the highest point on Earth at 8,849 meters above sea level.' },
  { category: 'extremes', text: 'The Marianas Trench is the deepest known spot in the oceans, about 11 kilometers down.' },
  { category: 'extremes', text: 'Death Valley holds one of the hottest air temperatures ever recorded on Earth.' },
  { category: 'extremes', text: 'Oymyakon in Siberia is among the coldest permanently inhabited places on Earth.' },
  { category: 'extremes', text: 'The equator is about 40,075 kilometers long — Earth\'s greatest circumference.' },
  { category: 'extremes', text: 'Point Nemo in the South Pacific is the farthest place from any land on Earth.' },
  { category: 'rivers', text: 'The Nile is widely treated as the world\'s longest river, stretching about 6,650 kilometers.' },
  { category: 'rivers', text: 'The Amazon River carries more water than any other river on Earth.' },
  { category: 'rivers', text: 'The Congo River is the deepest river on Earth, plunging well over 200 meters in places.' },
  { category: 'rivers', text: 'The Danube flows through more countries than any other river in Europe.' },
  { category: 'rivers', text: 'Lake Baikal in Siberia holds more fresh water than any other lake on Earth.' },
  { category: 'rivers', text: 'The Caspian Sea is the largest inland body of water on Earth.' },
  { category: 'rivers', text: 'Victoria Falls on the Zambezi is among the world\'s largest sheets of falling water.' },
  { category: 'rivers', text: 'Angel Falls in Venezuela is the world\'s tallest uninterrupted waterfall.' },
  { category: 'deserts', text: 'The Sahara is the largest hot desert on Earth, spanning much of North Africa.' },
  { category: 'deserts', text: 'Antarctica is the largest desert on Earth — a cold desert of ice, not sand.' },
  { category: 'deserts', text: 'The Atacama Desert in Chile is among the driest places on Earth.' },
  { category: 'deserts', text: 'The Gobi Desert stretches across northern China and southern Mongolia.' },
  { category: 'mountains', text: 'The Andes are the longest continental mountain range on Earth.' },
  { category: 'mountains', text: 'The Himalayas are still rising as the Indian plate pushes into Asia.' },
  { category: 'mountains', text: 'Aconcagua in Argentina is the highest peak in the Western Hemisphere.' },
  { category: 'mountains', text: 'Denali is the highest mountain peak in North America.' },
  { category: 'mountains', text: 'Kilimanjaro is Africa\'s highest mountain and a free-standing volcano.' },
  { category: 'mountains', text: 'Mauna Kea in Hawaii is taller than Everest when measured from its ocean base.' },
  { category: 'oceans', text: 'The Pacific Ocean is the largest and deepest of Earth\'s five oceans.' },
  { category: 'oceans', text: 'The Southern Ocean surrounds Antarctica and was named as a fifth ocean by many atlases.' },
  { category: 'oceans', text: 'More than 70 percent of Earth\'s surface is covered by ocean water.' },
  { category: 'oceans', text: 'The Gulf Stream carries warm water from the tropics toward northwestern Europe.' },
  { category: 'oceans', text: 'Coral reefs support a huge share of marine species despite covering little ocean area.' },
  { category: 'islands', text: 'Greenland is the world\'s largest island that is not considered a continent.' },
  { category: 'islands', text: 'Madagascar is the world\'s fourth-largest island and home to unique wildlife.' },
  { category: 'islands', text: 'Iceland sits on the Mid-Atlantic Ridge where two tectonic plates pull apart.' },
  { category: 'islands', text: 'Java is one of the most densely populated large islands on Earth.' },
  { category: 'islands', text: 'The Galápagos Islands helped shape Charles Darwin\'s ideas on natural selection.' },
  { category: 'continents', text: 'Asia is Earth\'s largest continent by both land area and population.' },
  { category: 'continents', text: 'Africa is the only continent that sits in all four hemispheres.' },
  { category: 'continents', text: 'Australia is the smallest continent and the largest country that is also a continent.' },
  { category: 'continents', text: 'Europe and Asia share one continuous landmass often called Eurasia.' },
  { category: 'continents', text: 'Antarctica holds about 90 percent of the world\'s ice.' },
  { category: 'landmarks', text: 'The Grand Canyon in Arizona reveals nearly two billion years of rock layers.' },
  { category: 'landmarks', text: 'Uluru in Australia is a massive sandstone monolith sacred to the Anangu people.' },
  { category: 'landmarks', text: 'The Great Barrier Reef is the world\'s largest coral reef system.' },
  { category: 'landmarks', text: 'Table Mountain overlooks Cape Town and is one of Africa\'s famous landmarks.' },
  { category: 'landmarks', text: 'The Dead Sea shore sits far below sea level — among Earth\'s lowest land points.' },
  { category: 'landmarks', text: 'Niagara Falls straddles the border between Canada and the United States.' },
  { category: 'landmarks', text: 'Mount Fuji is Japan\'s highest peak and an active stratovolcano.' },
  { category: 'landmarks', text: 'The Serengeti plains host one of the world\'s largest mammal migrations.' },
  { category: 'cities', text: 'Istanbul is the only major city that spans two continents: Europe and Asia.' },
  { category: 'cities', text: 'La Paz, Bolivia, is among the highest capital cities on Earth.' },
  { category: 'cities', text: 'Reykjavik is the world\'s northernmost capital of a sovereign state.' },
  { category: 'cities', text: 'Singapore is both a city and a country at the tip of the Malay Peninsula.' },
  { category: 'cities', text: 'Vatican City is the world\'s smallest independent state by area.' },
  { category: 'cities', text: 'Tokyo\'s metro area is among the most populous urban regions on Earth.' },
  { category: 'borders', text: 'Canada and the United States share the world\'s longest international land border.' },
  { category: 'borders', text: 'Chile is among the world\'s longest north-south countries, hugging the Andes.' },
  { category: 'borders', text: 'Lesotho is entirely surrounded by South Africa — a country inside a country.' },
  { category: 'borders', text: 'The Panama Canal links the Atlantic and Pacific across a narrow isthmus.' },
  { category: 'borders', text: 'The Suez Canal connects the Mediterranean Sea to the Red Sea.' },
  { category: 'climate', text: 'Rain forests near the equator get rain on most days of the year.' },
  { category: 'climate', text: 'Monsoons bring seasonal rains that shape farming across South Asia.' },
  { category: 'climate', text: 'The tropics lie between the Tropic of Cancer and the Tropic of Capricorn.' },
  { category: 'climate', text: 'The Arctic Circle marks where the midnight sun and polar night can occur.' },
  { category: 'climate', text: 'Trade winds blow steadily toward the equator from the subtropical highs.' },
  { category: 'geology', text: 'The Ring of Fire is a horseshoe of volcanoes and quakes around the Pacific.' },
  { category: 'geology', text: 'Earth\'s tectonic plates slowly rearrange continents over millions of years.' },
  { category: 'geology', text: 'Yellowstone sits above a volcanic hotspot under North America.' },
  { category: 'geology', text: 'The Mid-Atlantic Ridge is a long underwater mountain chain splitting the Atlantic.' },
  { category: 'time', text: 'There are 24 main time zones around Earth, though some countries use half-hour offsets.' },
  { category: 'time', text: 'The International Date Line mostly follows 180 degrees longitude across the Pacific.' },
  { category: 'time', text: 'A day is about 24 hours because Earth rotates once relative to the Sun.' },
  { category: 'trivia', text: 'Russia spans eleven time zones — more than any other country.' },
  { category: 'trivia', text: 'Brazil is the only country that crosses the equator and a tropic.' },
  { category: 'trivia', text: 'Africa has more countries than any other continent.' },
  { category: 'trivia', text: 'The Sahara once supported lakes and grasslands thousands of years ago.' },
  { category: 'trivia', text: 'Earth\'s continents fit together like puzzle pieces in ancient maps of Pangaea.' },
  { category: 'trivia', text: 'More people live north of the equator than south of it.' },
  { category: 'trivia', text: 'The Pacific\'s Ring of Fire holds most of the world\'s active volcanoes.' },
  { category: 'trivia', text: 'Fresh water makes up only a tiny share of all water on Earth.' },
  { category: 'trivia', text: 'The Alps were formed as Africa pushed north into Europe.' },
  { category: 'trivia', text: 'Patagonia stretches across southern Argentina and Chile toward Antarctica.' },
  { category: 'trivia', text: 'The Mekong River supports rice farming for millions across Southeast Asia.' },
  { category: 'trivia', text: 'Lake Superior is the largest of the North American Great Lakes by surface area.' },
  { category: 'trivia', text: 'The Horn of Africa juts into the Arabian Sea and the Gulf of Aden.' },
  { category: 'trivia', text: 'Cape Horn is a stormy landmark for sailors rounding southern South America.' },
  { category: 'trivia', text: 'The Strait of Gibraltar separates Europe from Africa by only about 14 kilometers.' },
  { category: 'trivia', text: 'Bering Strait once hosted a land bridge that linked Asia and North America.' },
  { category: 'trivia', text: 'The Amazon rainforest produces a large share of the world\'s river discharge to the sea.' },
  { category: 'trivia', text: 'Mount Kilimanjaro\'s summit can hold snow even though it sits near the equator.' },
  { category: 'trivia', text: 'The Sahara\'s name comes from an Arabic word for desert.' },
  { category: 'trivia', text: 'Fjord coastlines in Norway were carved by glaciers over many ice ages.' },
  { category: 'trivia', text: 'The Great Rift Valley runs thousands of kilometers through eastern Africa.' },
  { category: 'trivia', text: 'Tasmania is an island state of Australia separated by Bass Strait.' },
  { category: 'trivia', text: 'The Himalayas hold the world\'s fourteen peaks above 8,000 meters.' },
  { category: 'trivia', text: 'Earth\'s magnetic poles wander and are not fixed to the geographic poles.' },
  { category: 'trivia', text: 'A meridian is a line of longitude running from pole to pole.' },
  { category: 'trivia', text: 'Latitude lines run parallel to the equator and never meet.' },
  { category: 'trivia', text: 'The Prime Meridian at Greenwich defines zero degrees longitude.' },
  { category: 'trivia', text: 'Contour lines on a map connect points that share the same elevation.' },
  { category: 'trivia', text: 'An archipelago is a group or chain of islands.' },
  { category: 'trivia', text: 'A peninsula is land almost surrounded by water but still joined to a mainland.' },
  { category: 'trivia', text: 'An isthmus is a narrow strip of land linking two larger land areas.' },
  { category: 'trivia', text: 'A delta forms where a river drops sediment as it enters a quieter body of water.' },
  { category: 'trivia', text: 'An oasis is a fertile spot in a desert where water reaches the surface.' },
];

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/%20/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeCsvField(value) {
  let text = cleanText(value);
  try {
    text = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // keep cleaned text
  }
  return cleanText(text);
}

function cleanCategory(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!raw) {
    return '';
  }
  const head = raw.split('_')[0];
  return (head || raw).slice(0, 40);
}

function factId(text, category) {
  const hash = crypto.createHash('sha1')
    .update(`${category}|${text}`)
    .digest('hex')
    .slice(0, 12);
  return `wg-${hash}`;
}

function usable(text) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length < 20) {
    return null;
  }
  if (PROFANITY.test(cleaned)) {
    return null;
  }
  const folded = fold(cleaned);
  if (!folded || folded.length < 16) {
    return null;
  }
  const lines = wrap(folded, BODY_WIDTH);
  if (!lines.length || lines.length > BODY_ROWS) {
    return null;
  }
  return { text: cleaned, rows: lines.length, folded };
}

function formatArea(km2) {
  const n = Number(km2);
  if (!Number.isFinite(n) || n <= 0) {
    return '';
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} million`;
  }
  if (n >= 10_000) {
    return `${Math.round(n).toLocaleString('en-US')}`;
  }
  return `${Math.round(n)}`;
}

function countryName(row) {
  return cleanText(row?.name?.common || row?.name?.official || '');
}

function capitalName(row) {
  const caps = Array.isArray(row?.capital) ? row.capital : [];
  return cleanText(caps[0] || '');
}

function regionOf(row) {
  return cleanText(row?.region || '');
}

function subregionOf(row) {
  return cleanText(row?.subregion || '');
}

function languageList(row) {
  const langs = row?.languages && typeof row.languages === 'object'
    ? Object.values(row.languages).map(cleanText).filter(Boolean)
    : [];
  return langs;
}

function currencyList(row) {
  const currencies = row?.currencies && typeof row.currencies === 'object'
    ? Object.values(row.currencies).map((item) => cleanText(item?.name)).filter(Boolean)
    : [];
  return currencies;
}

function callingCode(row) {
  const root = cleanText(row?.idd?.root || '');
  const suffixes = Array.isArray(row?.idd?.suffixes) ? row.idd.suffixes : [];
  if (!root) {
    return '';
  }
  if (suffixes.length === 1) {
    return `${root}${cleanText(suffixes[0])}`;
  }
  return root;
}

function addCandidate(bucket, seen, text, category, source) {
  const fit = usable(text);
  if (!fit) {
    return false;
  }
  if (seen.has(fit.folded)) {
    return false;
  }
  seen.add(fit.folded);
  const cat = cleanCategory(category) || 'trivia';
  bucket.push({
    id: factId(fit.text, cat),
    text: fit.text,
    category: cat,
    source,
  });
  return true;
}

function generateFromCountries(countries, bucket, seen) {
  const independent = countries.filter((row) => row?.independent !== false && countryName(row));
  const byCca3 = new Map();
  for (const row of independent) {
    if (row.cca3) {
      byCca3.set(String(row.cca3).toUpperCase(), row);
    }
  }

  const byArea = independent
    .filter((row) => Number(row.area) > 0)
    .slice()
    .sort((a, b) => Number(b.area) - Number(a.area));

  for (const row of independent) {
    const name = countryName(row);
    const capital = capitalName(row);
    const region = regionOf(row);
    const subregion = subregionOf(row);
    const langs = languageList(row);
    const currencies = currencyList(row);
    const dial = callingCode(row);
    const area = formatArea(row.area);
    if (capital) {
      addCandidate(bucket, seen, `The capital of ${name} is ${capital}.`, 'capitals', 'mledoze-countries');
      addCandidate(bucket, seen, `${capital} is the capital city of ${name}.`, 'capitals', 'mledoze-countries');
    }
    if (region) {
      addCandidate(bucket, seen, `${name} is a country in ${region}.`, 'regions', 'mledoze-countries');
    }
    if (subregion && subregion !== region) {
      addCandidate(bucket, seen, `${name} lies in the ${subregion} region.`, 'regions', 'mledoze-countries');
    }
    if (row.landlocked) {
      addCandidate(bucket, seen, `${name} is landlocked — it has no coastline on an ocean.`, 'borders', 'mledoze-countries');
    }
    if (langs.length === 1) {
      addCandidate(bucket, seen, `${langs[0]} is an official language of ${name}.`, 'languages', 'mledoze-countries');
    } else if (langs.length === 2) {
      addCandidate(bucket, seen, `${name} recognizes ${langs[0]} and ${langs[1]} among its languages.`, 'languages', 'mledoze-countries');
    } else if (langs.length > 2) {
      addCandidate(bucket, seen, `${name} lists ${langs[0]}, ${langs[1]}, and more among its languages.`, 'languages', 'mledoze-countries');
    }
    if (currencies.length === 1) {
      addCandidate(bucket, seen, `${name} uses the ${currencies[0]} as its currency.`, 'currencies', 'mledoze-countries');
    }
    if (dial) {
      addCandidate(bucket, seen, `Telephone numbers in ${name} use the international dialing code ${dial}.`, 'trivia', 'mledoze-countries');
    }
    if (area) {
      addCandidate(bucket, seen, `${name} covers about ${area} square kilometers of land.`, 'area', 'mledoze-countries');
    }

    const borders = Array.isArray(row.borders) ? row.borders : [];
    for (const code of borders) {
      const neighbor = byCca3.get(String(code).toUpperCase());
      const neighborName = countryName(neighbor);
      if (!neighborName) {
        continue;
      }
      // Emit each unordered pair once using alphabetical country names.
      if (name.localeCompare(neighborName) < 0) {
        addCandidate(
          bucket,
          seen,
          `${name} and ${neighborName} share a land border.`,
          'borders',
          'mledoze-countries',
        );
      }
    }
  }

  // Ranked extremes from area list
  if (byArea.length >= 5) {
    addCandidate(bucket, seen, `${countryName(byArea[0])} is the largest country on Earth by land area.`, 'extremes', 'mledoze-countries');
    addCandidate(bucket, seen, `${countryName(byArea[1])} ranks among the world\'s largest countries by area.`, 'area', 'mledoze-countries');
    addCandidate(bucket, seen, `${countryName(byArea[byArea.length - 1])} is among the world\'s smallest countries by land area.`, 'extremes', 'mledoze-countries');
  }

  const landlocked = independent.filter((row) => row.landlocked);
  if (landlocked.length) {
    addCandidate(
      bucket,
      seen,
      `About ${landlocked.length} independent countries in this dataset are landlocked.`,
      'borders',
      'mledoze-countries',
    );
  }

  const byRegion = new Map();
  for (const row of independent) {
    const region = regionOf(row);
    if (!region) {
      continue;
    }
    byRegion.set(region, (byRegion.get(region) || 0) + 1);
  }
  for (const [region, count] of byRegion.entries()) {
    addCandidate(
      bucket,
      seen,
      `${region} includes about ${count} independent countries in this atlas.`,
      'regions',
      'mledoze-countries',
    );
  }
}

function statementFromTrivia(question, answer) {
  const q = cleanText(question).replace(/\?+$/, '');
  const a = cleanText(answer);
  if (!q || !a) {
    return '';
  }
  // Prefer natural statement forms when the question matches common templates.
  const capitalOf = q.match(/^what is the capital(?: city)? of (.+)$/i);
  if (capitalOf) {
    return `The capital of ${capitalOf[1]} is ${a}.`;
  }
  const whichCapital = q.match(/^which city is the capital of (.+)$/i);
  if (whichCapital) {
    return `${a} is the capital of ${whichCapital[1]}.`;
  }
  const largest = q.match(/^what is the largest (.+)\?*$/i);
  if (largest) {
    return `The largest ${largest[1]} is ${a}.`;
  }
  const only = q.match(/^what is the only (.+)$/i);
  if (only) {
    return `The only ${only[1]} is ${a}.`;
  }
  // Fallback: keep as a compact Q → A fact sentence.
  const combined = `${q}? ${a}.`;
  if (combined.length <= 160) {
    return combined;
  }
  return `${a} — ${q}.`;
}

function generateFromOtdb(csvText, bucket, seen) {
  const lines = String(csvText || '').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    // OTDB dump is URL-encoded CSV: question,correct,incorrect...
    const parts = line.split(',');
    if (parts.length < 2) {
      continue;
    }
    const question = decodeCsvField(parts[0]);
    const answer = decodeCsvField(parts[1]);
    if (!question || !answer) {
      continue;
    }
    // Skip true/false noise that reads awkwardly as a "fun fact"
    if (/^(true|false)$/i.test(answer) && /\btrue or false\b/i.test(question)) {
      continue;
    }
    const statement = statementFromTrivia(question, answer);
    addCandidate(bucket, seen, statement, 'trivia', 'opentdb-geography');
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'SignalBridge/1.0 (world-geography-facts corpus build; local)',
      Accept: '*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`${url} → HTTP ${res.status}`);
  }
  return res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

async function main() {
  const seen = new Set();
  const facts = [];

  for (const row of CURATED) {
    addCandidate(facts, seen, row.text, row.category, 'curated');
  }

  console.log('Fetching mledoze/countries…');
  const countries = await fetchJson(COUNTRIES_URL);
  if (!Array.isArray(countries)) {
    throw new Error('countries.json was not an array');
  }
  generateFromCountries(countries, facts, seen);
  console.log(`  after countries: ${facts.length} facts`);

  console.log('Fetching OTDB Geography.csv…');
  try {
    const csv = await fetchText(OTDB_GEO_URL);
    generateFromOtdb(csv, facts, seen);
    console.log(`  after OTDB: ${facts.length} facts`);
  } catch (error) {
    console.warn(`  OTDB skipped: ${error.message || error}`);
  }

  facts.sort((a, b) => a.category.localeCompare(b.category) || a.text.localeCompare(b.text));

  const categories = new Map();
  for (const fact of facts) {
    categories.set(fact.category, (categories.get(fact.category) || 0) + 1);
  }

  const payload = {
    source: 'mledoze/countries + OTDB Geography + curated',
    license: 'ODbL-1.0 / public trivia / curated',
    attribution: 'Country facts generated from mledoze/countries (ODbL). Extra trivia adapted from the Open Trivia Database Geography dump. Landmark and extreme-point lines are curated for Vestaboard.',
    builtAt: new Date().toISOString(),
    bodyRows: BODY_ROWS,
    bodyWidth: BODY_WIDTH,
    count: facts.length,
    categories: [...categories.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, count })),
    facts,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${facts.length} facts → ${path.relative(process.cwd(), OUT)}`);
  console.log(payload.categories.map((row) => `${row.id}:${row.count}`).join('  '));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
