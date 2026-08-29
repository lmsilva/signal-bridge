/**
 * One-shot converter: OpenJLPT vocab JSON → src/learn-japanese-words.json
 *
 * Vestaboard cannot show kana or kanji, so every entry is stored as ASCII
 * romaji + a short English gloss + a part of speech. Re-run when refreshing
 * the shipped lexicon:
 *
 *   node tools/build-learn-japanese-words.js path/to/n5.json path/to/n4.json
 *
 * Source: OpenJLPT (JMDict / Tatoeba), https://github.com/evanclan/OpenJLPT
 */

const fs = require('fs');
const path = require('path');

const BASIC = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

const DIGRAPHS = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
};

const PARTICLE_WORDS = new Set([
  'は', 'が', 'を', 'に', 'で', 'と', 'も', 'の', 'へ', 'から', 'まで', 'より',
  'か', 'ね', 'よ', 'な', 'さ', 'ぞ', 'とも', 'でも', 'しか', 'だけ',
  'ばかり', 'ほど', 'くらい', 'ぐらい', 'など', 'なり', 'やら',
]);

const PRONOUN_WORDS = new Set([
  'わたし', 'わたくし', 'ぼく', 'おれ', 'あなた', 'きみ', 'かれ', 'かのじょ',
  'わたしたち', 'これ', 'それ', 'あれ', 'どれ', 'この', 'その', 'あの', 'どの',
  'ここ', 'そこ', 'あそこ', 'どこ', 'こちら', 'そちら', 'あちら', 'どちら',
  'だれ', '誰', 'なに', 'なん',
]);

const COUNTER_WORDS = new Set([
  'つ', 'こ', 'にん', 'ほん', 'まい', 'ひき', 'だい', 'さつ', 'はい', 'わ',
  'かい', 'えん', 'さい', 'ふん', 'ぶん', 'じかん',
]);

const PHRASE_WORDS = new Set([
  'こんにちは', 'こんばんは', 'おはよう', 'おはようございます', 'さようなら',
  'ありがとう', 'ありがとうございます', 'すみません', 'ごめんなさい',
  'はじめまして', 'よろしく', 'いただきます', 'ごちそうさま', 'いってきます',
  'いってらっしゃい', 'ただいま', 'おかえり', 'おやすみ', 'お疲れ',
  'はい', 'いいえ',
]);

const ADVERB_WORDS = new Set([
  'もう', 'まだ', 'とても', 'よく', 'すぐ', 'また', 'いつも', 'ときどき',
  'ゆっくり', 'はっきり', 'きっと', 'ぜひ', 'たぶん', 'もっと', 'ずっと',
  'ちょっと', 'どうぞ', 'どうして', 'どう', 'いかが', 'なぜ', 'あまり',
  'ぜんぜん', 'けっこう', 'かなり', 'ずいぶん', 'やっと', 'ついに',
  'まず', 'つまり', 'たとえば', 'もちろん', 'ぜひ', 'なるべく',
]);

const ADJ_WORDS = new Set([
  'いい', 'よい', 'わるい', 'おおきい', 'ちいさい', 'あたらしい', 'ふるい',
  'たかい', 'やすい', 'ひくい', 'ながい', 'みじかい', 'はやい', 'おそい',
  'おいしい', 'まずい', 'あまい', 'からい', 'にがい', 'あつい', 'さむい',
  'すずしい', 'つめたい', 'あたたかい', 'いそがしい', 'たのしい', 'うれしい',
  'かなしい', 'おもしろい', 'つまらない', 'むずかしい', 'やさしい',
  'きたない', 'きれい', 'しんせつ', 'げんき', 'しずか', 'ゆうめい',
  'すき', 'きらい', 'じょうず', 'へた', 'たいへん', 'たいせつ', 'だいじょうぶ',
  'ひま', 'べんり', 'ふべん', 'かんたん', 'すてき', 'へん', 'らく', 'ひま',
  'おもい', 'かるい', 'あつい', 'うすい', 'ひろい', 'せまい', 'ふかい',
  'あおい', 'あかい', 'しろい', 'くろい', 'きいろい', 'ちゃいろい',
  '近い', 'とおい', 'ちかい', 'おおい', 'すくない', '強い', 'つよい', 'よわい',
  '正しい', 'ただしい', '危ない', 'あぶない', '痛い', 'いたい', '眠い', 'ねむい',
]);

function toHiragana(text) {
  return String(text || '').replace(/[\u30a1-\u30f6]/g, (ch) => (
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  ));
}

function isKana(text) {
  return /^[\u3040-\u30ffー・]+$/.test(text);
}

function kanaToRomaji(input) {
  const kana = toHiragana(String(input || '').trim());
  if (!kana) {
    return '';
  }
  if (kana === 'は') return 'wa';
  if (kana === 'へ') return 'e';
  if (kana === 'を') return 'o';
  const greetings = {
    こんにちは: 'konnichiwa',
    こんばんは: 'konbanwa',
    では: 'dewa',
    または: 'matawa',
  };
  if (greetings[kana]) {
    return greetings[kana];
  }

  let out = '';
  let i = 0;
  while (i < kana.length) {
    const pair = kana.slice(i, i + 2);
    if (kana[i] === 'っ' || kana[i] === 'ッ') {
      const next = kana.slice(i + 1, i + 3);
      const romaji = DIGRAPHS[toHiragana(next)] || BASIC[toHiragana(kana[i + 1])] || '';
      const cons = romaji.replace(/[^bcdfghjklmnpqrstvwxyz].*$/i, '') || romaji.charAt(0);
      out += cons;
      i += 1;
      continue;
    }
    if (kana[i] === 'ー') {
      const lastVowel = out.match(/[aeiou]$/i);
      out += lastVowel ? lastVowel[0] : '';
      i += 1;
      continue;
    }
    if (DIGRAPHS[toHiragana(pair)]) {
      out += DIGRAPHS[toHiragana(pair)];
      i += 2;
      continue;
    }
    const one = toHiragana(kana[i]);
    if (BASIC[one]) {
      if (one === 'ん' && /[aeiouy]/i.test((BASIC[toHiragana(kana[i + 1])] || DIGRAPHS[toHiragana(kana.slice(i + 1, i + 3))] || 'x')[0])) {
        out += "n'";
      } else {
        out += BASIC[one];
      }
      i += 1;
      continue;
    }
    if (kana[i] === '・' || kana[i] === ' ') {
      out += ' ';
      i += 1;
      continue;
    }
    return '';
  }
  return out.replace(/n'/g, (match, offset, full) => (
    /[aeiouy]/i.test(full[offset + 2] || '') ? match : 'n'
  ));
}

function inferPos(reading, meanings) {
  const kana = toHiragana(reading);
  const meaning = String(meanings[0] || '').toLowerCase();
  if (PARTICLE_WORDS.has(kana)) return 'particle';
  if (PRONOUN_WORDS.has(kana)) return 'pronoun';
  if (COUNTER_WORDS.has(kana)) return 'counter';
  if (PHRASE_WORDS.has(kana)) return 'phrase';
  if (ADVERB_WORDS.has(kana) || /^(very |more )?\w+ly$/.test(meaning)) return 'adverb';
  if (ADJ_WORDS.has(kana) || meaning.includes('adjective')) return 'adj';
  if (/^to\s/.test(meaning) || meaning.startsWith('to,')) return 'verb';
  return 'noun';
}

function shortEnglish(meanings) {
  const first = String(meanings[0] || '')
    .split(/[;(]/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  return first.slice(0, 48);
}

function slug(romaji, english, level) {
  const key = `${romaji}|${english}|${level}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return key.replace(/^-|-$/g, '') || romaji;
}

function convertFile(filePath) {
  const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const out = [];
  for (const row of rows) {
    const reading = String(row.reading || '').trim() || (isKana(row.word) ? row.word : '');
    if (!reading || !isKana(reading)) {
      continue;
    }
    const romaji = kanaToRomaji(reading);
    if (!romaji || /[^a-z'\s]/.test(romaji)) {
      continue;
    }
    const english = shortEnglish(row.meanings || []);
    if (!english) {
      continue;
    }
    const level = String(row.level || 'N5').toUpperCase();
    out.push({
      id: slug(romaji, english, level),
      romaji,
      english,
      pos: inferPos(reading, row.meanings || []),
      level: ['N5', 'N4', 'N3', 'N2', 'N1'].includes(level) ? level : 'N5',
    });
  }
  return out;
}

function main(argv) {
  const sources = argv.slice(2);
  if (!sources.length) {
    throw new Error('Pass one or more OpenJLPT vocab JSON files');
  }
  const seen = new Set();
  const words = [];
  for (const file of sources) {
    for (const word of convertFile(file)) {
      if (seen.has(word.id)) {
        continue;
      }
      seen.add(word.id);
      words.push(word);
    }
  }
  words.sort((a, b) => a.romaji.localeCompare(b.romaji) || a.level.localeCompare(b.level));
  const dest = path.resolve(__dirname, '..', 'src', 'learn-japanese-words.json');
  fs.writeFileSync(dest, `${JSON.stringify({
    source: 'OpenJLPT / JMDict (https://github.com/evanclan/OpenJLPT)',
    generatedAt: new Date().toISOString().slice(0, 10),
    words,
  }, null, 2)}\n`);
  const byLevel = words.reduce((acc, word) => {
    acc[word.level] = (acc[word.level] || 0) + 1;
    return acc;
  }, {});
  console.log(`Wrote ${words.length} words to ${dest}`, byLevel);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  kanaToRomaji,
  inferPos,
  convertFile,
};
