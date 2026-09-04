#!/usr/bin/env node
/**
 * Build the shipped Bible Verse Of The Day list.
 *
 * Source: aruljohn/Bible-kjv - the King James Version, public domain, one
 * JSON file per book. Text is copied verbatim so nothing is paraphrased.
 *
 * Two passes decide what ships:
 *
 *   1. CURATED - a reference list of the verses a house actually wants to see.
 *      These are pulled from the dump by book/chapter/verse, so the wording is
 *      the real KJV rather than something typed from memory.
 *   2. AUTO - a sweep of the wisdom books, gospels and epistles that keeps
 *      verses which read on their own: they open with a word that does not
 *      point back at the previous verse, they avoid genealogy / warfare /
 *      ritual vocabulary, and they fit the board in one or two frames.
 *
 * Every shipped row must pass `fitsBoard` from the layout module.
 *
 *   node tools/build-bible-verses.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { fold, wrap } = require('../src/vestaboard/encoder');
const { fitsBoard, referenceLabel, verseLines } = require('../src/bible-verse-layout');

const OUT = path.join(__dirname, '..', 'src', 'bible-verse-verses.json');
const BASE = 'https://raw.githubusercontent.com/aruljohn/Bible-kjv/master';

// A verse past four wrapped lines becomes a paged card. The queue shows a
// paged card as one row, so length is a reading decision, not a plumbing one:
// the sweep stays short and punchy, curated favourites may run long.
const AUTO_MAX_LINES = 6;
const CURATED_MAX_LINES = 16;
const MIN_CHARS = 28;

/** Book file name -> board/display name. */
const BOOKS = [
  ['Genesis', 'Genesis'],
  ['Exodus', 'Exodus'],
  ['Leviticus', 'Leviticus'],
  ['Numbers', 'Numbers'],
  ['Deuteronomy', 'Deuteronomy'],
  ['Joshua', 'Joshua'],
  ['Judges', 'Judges'],
  ['Ruth', 'Ruth'],
  ['1Samuel', '1 Samuel'],
  ['2Samuel', '2 Samuel'],
  ['1Kings', '1 Kings'],
  ['2Kings', '2 Kings'],
  ['1Chronicles', '1 Chronicles'],
  ['2Chronicles', '2 Chronicles'],
  ['Ezra', 'Ezra'],
  ['Nehemiah', 'Nehemiah'],
  ['Esther', 'Esther'],
  ['Job', 'Job'],
  ['Psalms', 'Psalm'],
  ['Proverbs', 'Proverbs'],
  ['Ecclesiastes', 'Ecclesiastes'],
  ['SongofSolomon', 'Song of Solomon'],
  ['Isaiah', 'Isaiah'],
  ['Jeremiah', 'Jeremiah'],
  ['Lamentations', 'Lamentations'],
  ['Ezekiel', 'Ezekiel'],
  ['Daniel', 'Daniel'],
  ['Hosea', 'Hosea'],
  ['Joel', 'Joel'],
  ['Amos', 'Amos'],
  ['Obadiah', 'Obadiah'],
  ['Jonah', 'Jonah'],
  ['Micah', 'Micah'],
  ['Nahum', 'Nahum'],
  ['Habakkuk', 'Habakkuk'],
  ['Zephaniah', 'Zephaniah'],
  ['Haggai', 'Haggai'],
  ['Zechariah', 'Zechariah'],
  ['Malachi', 'Malachi'],
  ['Matthew', 'Matthew'],
  ['Mark', 'Mark'],
  ['Luke', 'Luke'],
  ['John', 'John'],
  ['Acts', 'Acts'],
  ['Romans', 'Romans'],
  ['1Corinthians', '1 Corinthians'],
  ['2Corinthians', '2 Corinthians'],
  ['Galatians', 'Galatians'],
  ['Ephesians', 'Ephesians'],
  ['Philippians', 'Philippians'],
  ['Colossians', 'Colossians'],
  ['1Thessalonians', '1 Thessalonians'],
  ['2Thessalonians', '2 Thessalonians'],
  ['1Timothy', '1 Timothy'],
  ['2Timothy', '2 Timothy'],
  ['Titus', 'Titus'],
  ['Philemon', 'Philemon'],
  ['Hebrews', 'Hebrews'],
  ['James', 'James'],
  ['1Peter', '1 Peter'],
  ['2Peter', '2 Peter'],
  ['1John', '1 John'],
  ['2John', '2 John'],
  ['3John', '3 John'],
  ['Jude', 'Jude'],
  ['Revelation', 'Revelation'],
];

/**
 * Chapters the automatic sweep may draw from. Word filters alone cannot tell
 * a psalm of comfort from a psalm calling down fire, so the sweep only walks
 * chapters that are devotional end to end.
 */
const AUTO_CHAPTERS = {
  Psalms: [1, 4, 8, 9, 15, 16, 19, 23, 24, 25, 27, 29, 30, 32, 33, 34, 36, 37,
    40, 42, 46, 51, 61, 62, 63, 65, 67, 84, 86, 89, 90, 91, 92, 95, 96, 98, 100,
    101, 103, 107, 111, 112, 113, 116, 117, 118, 119, 121, 122, 126, 127, 128,
    130, 131, 133, 134, 136, 138, 139, 143, 145, 146, 147, 148, 149, 150],
  Proverbs: [1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 27, 28, 31],
  Ecclesiastes: [3, 4, 7, 9, 11, 12],
  Isaiah: [12, 25, 26, 30, 32, 35, 40, 41, 42, 43, 44, 45, 46, 49, 51, 52, 53,
    54, 55, 58, 60, 61, 64, 66],
  Jeremiah: [17, 29, 31, 32, 33],
  Lamentations: [3],
  Micah: [6, 7],
  Habakkuk: [3],
  Zephaniah: [3],
  Malachi: [3, 4],
  Matthew: [5, 6, 7, 11, 18, 19, 22, 28],
  Mark: [9, 10, 11, 12, 16],
  Luke: [1, 2, 6, 11, 12, 15, 18],
  John: [1, 3, 4, 6, 8, 10, 11, 13, 14, 15, 16, 17, 20],
  Acts: [1, 2, 4, 17, 20],
  Romans: [5, 6, 8, 10, 12, 13, 14, 15],
  '1Corinthians': [1, 2, 3, 10, 12, 13, 15, 16],
  '2Corinthians': [1, 3, 4, 5, 9, 12, 13],
  Galatians: [2, 5, 6],
  Ephesians: [1, 2, 3, 4, 5, 6],
  Philippians: [1, 2, 3, 4],
  Colossians: [1, 2, 3, 4],
  '1Thessalonians': [4, 5],
  '2Thessalonians': [2, 3],
  '1Timothy': [1, 4, 6],
  '2Timothy': [1, 2, 3, 4],
  Titus: [2, 3],
  Hebrews: [4, 6, 10, 11, 12, 13],
  James: [1, 2, 3, 4, 5],
  '1Peter': [1, 2, 3, 4, 5],
  '2Peter': [1, 3],
  '1John': [1, 2, 3, 4, 5],
  '2John': [1],
  '3John': [1],
  Jude: [1],
  Revelation: [1, 3, 4, 5, 7, 21, 22],
};

/**
 * Openers that can start a card without leaning on the verse before it.
 * An allowlist rather than a denylist: KJV is full of "And it came to pass".
 */
const OPENERS = new Set([
  'a', 'all', 'answer', 'ask', 'be', 'behold', 'better', 'bless', 'blessed',
  'cast', 'charity', 'children', 'come', 'commit', 'confess', 'consider',
  'create', 'delight', 'depart', 'do', 'draw', 'enter', 'every', 'faith',
  'fear', 'finally', 'follow', 'give', 'god', 'good', 'grace', 'great',
  'happy', 'have', 'hear', 'hide', 'honour', 'hope', 'how', 'humble', 'in',
  'jesus', 'judge', 'keep', 'let', 'life', 'lift', 'love', 'make', 'man',
  'many', 'mercy', 'my', 'o', 'one', 'open', 'peace', 'praise', 'pray',
  'put', 'rejoice', 'remember', 'rest', 'righteousness', 'seek', 'set',
  'shew', 'sing', 'stand', 'submit', 'take', 'teach', 'the', 'thou', 'thy',
  'train', 'trust', 'truly', 'wait', 'walk', 'watch', 'whatsoever', 'whoso',
  'whosoever', 'wisdom', 'withhold', 'ye',
]);

/**
 * A card is worth a flip when it says something about how to live or who God
 * is. Without this the sweep happily ships "The words of the preacher".
 */
const KEEPERS = new RegExp([
  'love', 'loveth', 'faith', 'hope', 'peace', 'joy', 'joyful', 'rejoice',
  'mercy', 'merciful', 'grace', 'gracious', 'trust', 'heart', 'bless',
  'blessed', 'praise', 'thank', 'wisdom', 'wise', 'understanding', 'light',
  'strength', 'strong', 'kind', 'kindness', 'gentle', 'forgive', 'patience',
  'patient', 'righteous', 'glory', 'comfort', 'good', 'goodness', 'pray',
  'prayer', 'believe', 'life', 'truth', 'salvation', 'shepherd', 'refuge',
  'rock', 'courage', 'humble', 'meek', 'quiet', 'rest', 'delight', 'hear',
  'help', 'heal', 'give', 'giveth', 'keep', 'guide', 'teach', 'walk',
  'friend', 'brother', 'neighbour', 'child', 'children', 'father', 'home',
  'labour', 'work', 'diligent', 'honour', 'soul', 'spirit', 'word',
].map((word) => `\\b${word}`).join('|'), 'i');

/**
 * Vocabulary that means the verse is narrative, ritual, or grim rather than
 * something to read across a kitchen. Broad on purpose - the curated list is
 * where the harder verses get in.
 */
const DENY = new RegExp([
  'begat', 'genealog', 'slew', 'slay', 'slain', 'smote', 'smite', 'kill',
  'blood', 'sword', 'spear', 'battle', 'army', 'siege', 'captive', 'bondage',
  'concubine', 'harlot', 'whore', 'adulter', 'fornicat', 'bastard', 'circumcis',
  'leprosy', 'leper', 'plague', 'boil', 'dung', 'vomit', 'urine', 'pisseth',
  'menstru', 'carcase', 'corpse', 'bury', 'buried', 'grave', 'sepulchre',
  'burnt offering', 'sacrifice', 'oblation', 'tabernacle', 'cubit', 'shekel',
  'omer', 'ephah', 'firstling', 'scapegoat', 'idol', 'graven', 'baal',
  'sorcer', 'witch', 'divination', 'devil', 'demon', 'satan', 'hell',
  'damn', 'torment', 'brimstone', 'lake of fire', 'gnash', 'worm',
  'pharaoh', 'egypt', 'babylon', 'moab', 'philistine', 'amalek', 'edom',
  'assyria', 'nineveh', 'sodom', 'gomorrah', 'jezebel', 'herod', 'pilate',
  'scourge', 'crucif', 'stone him', 'stoned', 'famine', 'pestilence',
  'thereof shall', 'selah',
  // Judgement, cursing and name-calling. The wisdom books are full of the
  // contrast "the righteous ... but the wicked"; only the warm half belongs
  // on a kitchen wall.
  'wicked', 'ungodly', 'fool', 'folly', 'iniquit', 'transgress', 'heathen',
  'hateth', 'hatred', 'cursing', 'thief', 'deceit', 'froward', 'snare',
  'wrath', 'vengeance', 'avenge', 'perish', 'destroy', 'destruction',
  'punish', 'rebuke', 'reproof', 'reprove', 'scorn', 'proud', 'pride',
  'wither', 'mourn', 'weep', 'sorrow', 'affliction', 'enemy', 'enemies',
  'strive', 'strife', 'contention', 'brawling', 'slothful', 'sluggard',
  'drunk', 'wine', 'strong drink', 'poverty', 'debtor', 'usury', 'bribe',
  'meat', 'raiment', 'marrow', 'bowel', 'flesh',
  // Narration and dialogue: a card that starts mid-scene needs the chapter
  // around it to make sense.
  'saith', 'said', 'answered', 'spake', 'disciple', 'apostle', 'multitude',
  'parable', 'servant', 'brethren', 'sting', 'kiss', 'ox', 'ass',
  'ruin', 'vanity', 'molten', 'oppress', 'breaketh', 'talebearer', 'princes',
].map((word) => `\\b${word}`).join('|'), 'i');

/** References every build must include, wording pulled from the dump. */
const CURATED = `
Genesis 1:1 | Genesis 1:27 | Genesis 1:31 | Genesis 9:13 | Genesis 28:15 | Genesis 50:20
Exodus 14:14 | Exodus 15:2 | Exodus 20:12 | Exodus 33:14 | Exodus 34:6
Numbers 6:24 | Numbers 6:25 | Numbers 6:26 | Numbers 23:19
Deuteronomy 4:29 | Deuteronomy 6:5 | Deuteronomy 7:9 | Deuteronomy 31:6 | Deuteronomy 31:8 | Deuteronomy 33:27
Joshua 1:8 | Joshua 1:9 | Joshua 24:15
Ruth 1:16
1 Samuel 12:24 | 1 Samuel 16:7
2 Samuel 22:2 | 2 Samuel 22:31 | 2 Samuel 22:33
1 Chronicles 16:11 | 1 Chronicles 16:34 | 1 Chronicles 29:11
2 Chronicles 7:14 | 2 Chronicles 15:7 | 2 Chronicles 20:15
Nehemiah 8:10 | Nehemiah 9:6
Esther 4:14
Job 1:21 | Job 5:9 | Job 12:10 | Job 19:25 | Job 23:10 | Job 42:2
Psalm 1:1 | Psalm 1:2 | Psalm 1:3 | Psalm 3:3 | Psalm 4:8 | Psalm 5:3 | Psalm 8:1
Psalm 9:1 | Psalm 9:9 | Psalm 9:10 | Psalm 16:8 | Psalm 16:11 | Psalm 18:1 | Psalm 18:2
Psalm 19:1 | Psalm 19:14 | Psalm 20:4 | Psalm 23:1 | Psalm 23:2 | Psalm 23:3 | Psalm 23:4
Psalm 23:6 | Psalm 24:1 | Psalm 25:4 | Psalm 25:5 | Psalm 27:1 | Psalm 27:4 | Psalm 27:14
Psalm 28:7 | Psalm 29:11 | Psalm 30:5 | Psalm 31:24 | Psalm 32:8 | Psalm 33:4 | Psalm 33:12
Psalm 34:1 | Psalm 34:8 | Psalm 34:17 | Psalm 34:18 | Psalm 36:5 | Psalm 37:4 | Psalm 37:5
Psalm 37:7 | Psalm 37:23 | Psalm 40:1 | Psalm 42:1 | Psalm 42:11 | Psalm 46:1 | Psalm 46:5
Psalm 46:10 | Psalm 51:10 | Psalm 51:12 | Psalm 55:22 | Psalm 56:3 | Psalm 59:16 | Psalm 62:1
Psalm 62:2 | Psalm 62:8 | Psalm 63:1 | Psalm 66:1 | Psalm 71:5 | Psalm 73:26 | Psalm 84:11
Psalm 86:5 | Psalm 89:1 | Psalm 90:12 | Psalm 90:17 | Psalm 91:1 | Psalm 91:2 | Psalm 91:4
Psalm 91:11 | Psalm 94:19 | Psalm 95:1 | Psalm 95:2 | Psalm 96:1 | Psalm 100:1 | Psalm 100:2
Psalm 100:3 | Psalm 100:4 | Psalm 100:5 | Psalm 103:1 | Psalm 103:2 | Psalm 103:8 | Psalm 103:12
Psalm 107:1 | Psalm 111:10 | Psalm 116:1 | Psalm 118:1 | Psalm 118:6 | Psalm 118:8 | Psalm 118:24
Psalm 119:11 | Psalm 119:105 | Psalm 119:114 | Psalm 121:1 | Psalm 121:2 | Psalm 121:7 | Psalm 121:8
Psalm 126:3 | Psalm 127:1 | Psalm 127:3 | Psalm 130:5 | Psalm 133:1 | Psalm 136:1 | Psalm 138:8
Psalm 139:7 | Psalm 139:14 | Psalm 139:23 | Psalm 143:8 | Psalm 145:8 | Psalm 145:9 | Psalm 145:18
Psalm 146:5 | Psalm 147:3 | Psalm 147:5 | Psalm 150:6
Proverbs 1:7 | Proverbs 2:6 | Proverbs 3:5 | Proverbs 3:6 | Proverbs 3:9 | Proverbs 3:24
Proverbs 4:23 | Proverbs 8:11 | Proverbs 9:10 | Proverbs 10:12 | Proverbs 11:2 | Proverbs 11:25
Proverbs 12:25 | Proverbs 13:20 | Proverbs 14:29 | Proverbs 15:1 | Proverbs 15:13 | Proverbs 16:3
Proverbs 16:9 | Proverbs 16:24 | Proverbs 16:32 | Proverbs 17:17 | Proverbs 17:22 | Proverbs 18:10
Proverbs 18:21 | Proverbs 18:24 | Proverbs 19:20 | Proverbs 19:21 | Proverbs 20:11 | Proverbs 21:21
Proverbs 22:1 | Proverbs 22:6 | Proverbs 22:9 | Proverbs 23:12 | Proverbs 24:16 | Proverbs 25:11
Proverbs 27:1 | Proverbs 27:9 | Proverbs 27:17 | Proverbs 28:13 | Proverbs 29:11 | Proverbs 31:25
Ecclesiastes 3:1 | Ecclesiastes 3:11 | Ecclesiastes 4:9 | Ecclesiastes 4:12 | Ecclesiastes 7:8
Ecclesiastes 9:10 | Ecclesiastes 11:5 | Ecclesiastes 12:13
Isaiah 1:18 | Isaiah 6:8 | Isaiah 9:6 | Isaiah 12:2 | Isaiah 25:1 | Isaiah 26:3 | Isaiah 30:15
Isaiah 32:17 | Isaiah 35:1 | Isaiah 40:8 | Isaiah 40:28 | Isaiah 40:29 | Isaiah 40:31 | Isaiah 41:10
Isaiah 41:13 | Isaiah 42:16 | Isaiah 43:1 | Isaiah 43:2 | Isaiah 43:19 | Isaiah 46:4 | Isaiah 53:5
Isaiah 54:10 | Isaiah 55:6 | Isaiah 55:8 | Isaiah 55:9 | Isaiah 55:12 | Isaiah 58:11 | Isaiah 61:1
Isaiah 64:8 | Isaiah 66:13
Jeremiah 1:5 | Jeremiah 17:7 | Jeremiah 17:8 | Jeremiah 29:11 | Jeremiah 29:12 | Jeremiah 29:13
Jeremiah 31:3 | Jeremiah 32:17 | Jeremiah 33:3
Lamentations 3:22 | Lamentations 3:23 | Lamentations 3:25 | Lamentations 3:26
Daniel 2:20 | Daniel 3:17 | Daniel 12:3
Hosea 6:3 | Joel 2:13 | Joel 2:25 | Amos 5:24 | Jonah 2:9 | Micah 6:8 | Micah 7:7
Habakkuk 2:4 | Habakkuk 3:18 | Habakkuk 3:19 | Zephaniah 3:17 | Zechariah 4:6 | Malachi 3:6 | Malachi 3:10
Matthew 4:4 | Matthew 5:4 | Matthew 5:5 | Matthew 5:6 | Matthew 5:7 | Matthew 5:8 | Matthew 5:9
Matthew 5:14 | Matthew 5:16 | Matthew 5:44 | Matthew 6:14 | Matthew 6:21 | Matthew 6:24 | Matthew 6:33
Matthew 6:34 | Matthew 7:1 | Matthew 7:7 | Matthew 7:12 | Matthew 10:31 | Matthew 11:28 | Matthew 11:29
Matthew 11:30 | Matthew 16:26 | Matthew 18:20 | Matthew 19:26 | Matthew 21:22 | Matthew 22:37
Matthew 22:39 | Matthew 28:6 | Matthew 28:19 | Matthew 28:20
Mark 9:23 | Mark 10:27 | Mark 10:45 | Mark 11:24 | Mark 12:30 | Mark 12:31 | Mark 16:15
Luke 1:37 | Luke 2:11 | Luke 2:14 | Luke 6:31 | Luke 6:35 | Luke 6:36 | Luke 6:38 | Luke 11:9
Luke 11:28 | Luke 12:7 | Luke 12:32 | Luke 16:10 | Luke 18:27
John 1:1 | John 1:3 | John 1:5 | John 1:12 | John 1:14 | John 3:16 | John 3:17 | John 4:24
John 6:35 | John 8:12 | John 8:32 | John 10:10 | John 10:11 | John 11:25 | John 13:34 | John 13:35
John 14:1 | John 14:2 | John 14:6 | John 14:15 | John 14:27 | John 15:5 | John 15:7 | John 15:11
John 15:12 | John 15:13 | John 16:33 | John 20:29
Acts 1:8 | Acts 2:21 | Acts 4:12 | Acts 16:31 | Acts 17:28 | Acts 20:24 | Acts 20:35
Romans 1:16 | Romans 1:20 | Romans 5:1 | Romans 5:3 | Romans 5:5 | Romans 5:8 | Romans 6:23
Romans 8:1 | Romans 8:6 | Romans 8:18 | Romans 8:26 | Romans 8:28 | Romans 8:31 | Romans 8:37
Romans 8:38 | Romans 10:9 | Romans 10:13 | Romans 10:17 | Romans 12:1 | Romans 12:2 | Romans 12:9
Romans 12:10 | Romans 12:12 | Romans 12:18 | Romans 12:21 | Romans 13:8 | Romans 14:19 | Romans 15:4
Romans 15:7 | Romans 15:13
1 Corinthians 1:9 | 1 Corinthians 2:9 | 1 Corinthians 6:19 | 1 Corinthians 10:13 | 1 Corinthians 10:31
1 Corinthians 12:12 | 1 Corinthians 13:1 | 1 Corinthians 13:4 | 1 Corinthians 13:6 | 1 Corinthians 13:7
1 Corinthians 13:11 | 1 Corinthians 13:13 | 1 Corinthians 15:57 | 1 Corinthians 15:58 | 1 Corinthians 16:13
1 Corinthians 16:14
2 Corinthians 1:3 | 2 Corinthians 1:4 | 2 Corinthians 3:17 | 2 Corinthians 4:16 | 2 Corinthians 4:17
2 Corinthians 4:18 | 2 Corinthians 5:7 | 2 Corinthians 5:17 | 2 Corinthians 9:6 | 2 Corinthians 9:7
2 Corinthians 9:8 | 2 Corinthians 12:9 | 2 Corinthians 13:11
Galatians 2:20 | Galatians 5:1 | Galatians 5:13 | Galatians 5:22 | Galatians 5:23 | Galatians 6:2
Galatians 6:7 | Galatians 6:9 | Galatians 6:10
Ephesians 1:7 | Ephesians 2:8 | Ephesians 2:10 | Ephesians 3:20 | Ephesians 4:2 | Ephesians 4:29
Ephesians 4:32 | Ephesians 5:1 | Ephesians 5:2 | Ephesians 5:20 | Ephesians 6:1 | Ephesians 6:10
Ephesians 6:11 | Ephesians 6:18
Philippians 1:3 | Philippians 1:6 | Philippians 2:3 | Philippians 2:4 | Philippians 2:13 | Philippians 3:13
Philippians 3:14 | Philippians 4:4 | Philippians 4:5 | Philippians 4:6 | Philippians 4:7 | Philippians 4:8
Philippians 4:11 | Philippians 4:13 | Philippians 4:19
Colossians 1:17 | Colossians 2:6 | Colossians 3:2 | Colossians 3:12 | Colossians 3:13 | Colossians 3:14
Colossians 3:15 | Colossians 3:16 | Colossians 3:17 | Colossians 3:23 | Colossians 4:2 | Colossians 4:6
1 Thessalonians 5:11 | 1 Thessalonians 5:16 | 1 Thessalonians 5:17 | 1 Thessalonians 5:18
1 Thessalonians 5:21 | 2 Thessalonians 3:3 | 2 Thessalonians 3:13 | 2 Thessalonians 3:16
1 Timothy 1:15 | 1 Timothy 4:12 | 1 Timothy 6:6 | 1 Timothy 6:11 | 1 Timothy 6:12
2 Timothy 1:7 | 2 Timothy 2:15 | 2 Timothy 3:16 | 2 Timothy 4:7
Titus 2:11 | Titus 3:5
Hebrews 4:12 | Hebrews 4:16 | Hebrews 6:10 | Hebrews 10:23 | Hebrews 10:24 | Hebrews 10:25
Hebrews 11:1 | Hebrews 11:6 | Hebrews 12:1 | Hebrews 12:2 | Hebrews 12:11 | Hebrews 13:5
Hebrews 13:6 | Hebrews 13:8 | Hebrews 13:16
James 1:2 | James 1:3 | James 1:4 | James 1:5 | James 1:12 | James 1:17 | James 1:19 | James 1:22
James 2:17 | James 3:17 | James 4:7 | James 4:8 | James 4:10 | James 5:16
1 Peter 1:3 | 1 Peter 2:9 | 1 Peter 3:8 | 1 Peter 4:8 | 1 Peter 4:10 | 1 Peter 5:6 | 1 Peter 5:7
1 Peter 5:8 | 1 Peter 5:10 | 2 Peter 1:3 | 2 Peter 3:9 | 2 Peter 3:18
1 John 1:5 | 1 John 1:7 | 1 John 1:9 | 1 John 3:1 | 1 John 3:16 | 1 John 3:18 | 1 John 4:4
1 John 4:7 | 1 John 4:8 | 1 John 4:11 | 1 John 4:16 | 1 John 4:18 | 1 John 4:19 | 1 John 5:4
1 John 5:14 | 3 John 1:4 | Jude 1:2 | Jude 1:24
Revelation 1:8 | Revelation 3:20 | Revelation 4:11 | Revelation 21:4 | Revelation 21:5 | Revelation 22:13
`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'signal-bridge-bible-verse-build' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function cleanVerse(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\{|\}/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\bLORD\b/g, 'Lord')
    .replace(/\bGOD\b/g, 'God')
    .trim();
}

function slug(displayName) {
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseCurated() {
  const out = [];
  for (const line of CURATED.split('\n')) {
    for (const entry of line.split('|')) {
      const ref = entry.trim();
      if (!ref) continue;
      const match = ref.match(/^(.+)\s+(\d+):(\d+)$/);
      if (!match) {
        throw new Error(`bad curated reference: ${ref}`);
      }
      out.push({ book: match[1].trim(), chapter: Number(match[2]), verse: Number(match[3]) });
    }
  }
  return out;
}

/** Display names the curated list may use, mapped to the dump's file name. */
function curatedFileFor(name) {
  const wanted = slug(name);
  for (const [file, display] of BOOKS) {
    if (slug(display) === wanted || slug(file) === wanted) {
      return file;
    }
  }
  // The list writes full names where the board label is abbreviated.
  const ALIASES = {
    '1thessalonians': '1Thessalonians',
    '2thessalonians': '2Thessalonians',
    songofsolomon: 'SongofSolomon',
    psalms: 'Psalms',
  };
  return ALIASES[wanted] || null;
}

function autoKeeps(text) {
  if (text.length < MIN_CHARS) return false;
  if (DENY.test(text)) return false;
  if (!KEEPERS.test(text)) return false;
  if (/[0-9]/.test(text)) return false;
  // A verse that opens mid-argument, or answers a question nobody heard, is
  // half a thought on the wall.
  if (/[?]/.test(text)) return false;
  // KJV punctuates a verse that runs into the next one with a colon or a
  // semicolon. Only take the ones that finish their own sentence.
  if (!/[.!]$/.test(text)) return false;
  if (/^(.{0,40})\bthem\b/i.test(text) && !/\bthem that\b/i.test(text)) return false;
  const opener = (text.match(/^[A-Za-z']+/) || [''])[0].toLowerCase();
  if (!OPENERS.has(opener)) return false;
  // A verse that names someone the card never introduces reads like a
  // fragment of a story. Allow only the names the whole book is about.
  const names = text.match(/\b[A-Z][a-z]+/g) || [];
  const ALLOWED_NAMES = new Set(['God', 'Lord', 'Jesus', 'Christ', 'Spirit', 'Father', 'Son', 'Holy', 'Ghost', 'I']);
  for (const name of names) {
    if (!ALLOWED_NAMES.has(name) && !/^(The|A|An|And|But|For|In|If|It|He|She|They|We|Ye|Thou|Thy|My|This|That|There|These|Those|As|So|Be|Blessed|Behold|Let|Now|Not|No|Of|Or|To|When|Where|What|Who|Whoso|Whosoever|Wherefore|With|Yea|Every|All|Come|Give|Have|How|Keep|Love|Make|Man|Many|One|Only|Put|Seek|Set|Take|Trust|Wait|Walk|Watch)$/.test(name)) {
      return false;
    }
  }
  return true;
}

async function main() {
  const cacheDir = path.join(require('os').tmpdir(), 'kjv-build-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const byFile = new Map();
  for (const [file] of BOOKS) {
    const cached = path.join(cacheDir, `${file}.json`);
    if (fs.existsSync(cached)) {
      byFile.set(file, JSON.parse(fs.readFileSync(cached, 'utf8')));
      continue;
    }
    process.stdout.write(`\rfetching ${file}...            `);
    const book = await fetchJson(`${BASE}/${file}.json`);
    fs.writeFileSync(cached, JSON.stringify(book), 'utf8');
    byFile.set(file, book);
  }
  process.stdout.write('\r');

  const displayByFile = new Map(BOOKS);
  const rows = new Map();

  function add(file, chapter, verse, text, source) {
    const display = displayByFile.get(file);
    const reference = `${display} ${chapter}:${verse}`;
    const id = `${slug(display)}-${chapter}-${verse}`;
    if (rows.has(id)) return false;
    if (!referenceLabel(reference)) return false;
    const lines = verseLines(text).length;
    const cap = source === 'curated' ? CURATED_MAX_LINES : AUTO_MAX_LINES;
    if (!lines || lines > cap) return false;
    if (!fitsBoard(reference, text)) return false;
    rows.set(id, {
      id, reference, text, order: [file, chapter, verse], source,
    });
    return true;
  }

  function verseText(file, chapter, verse) {
    const book = byFile.get(file);
    const chap = book?.chapters?.find((row) => Number(row.chapter) === chapter);
    const hit = chap?.verses?.find((row) => Number(row.verse) === verse);
    return hit ? cleanVerse(hit.text) : null;
  }

  let missing = 0;
  for (const ref of parseCurated()) {
    const file = curatedFileFor(ref.book);
    const text = file && verseText(file, ref.chapter, ref.verse);
    if (!text) {
      missing += 1;
      console.warn(`  curated miss: ${ref.book} ${ref.chapter}:${ref.verse}`);
      continue;
    }
    if (!add(file, ref.chapter, ref.verse, text, 'curated')) {
      console.warn(`  curated dropped (too long / bad ref): ${ref.book} ${ref.chapter}:${ref.verse}`);
    }
  }
  const curatedCount = rows.size;

  for (const [file] of BOOKS) {
    const chapters = AUTO_CHAPTERS[file];
    if (!chapters) continue;
    const allowed = new Set(chapters);
    for (const chap of byFile.get(file).chapters) {
      if (!allowed.has(Number(chap.chapter))) continue;
      for (const row of chap.verses) {
        const text = cleanVerse(row.text);
        if (!autoKeeps(text)) continue;
        add(file, Number(chap.chapter), Number(row.verse), text, 'kjv');
      }
    }
  }

  const bookIndex = new Map(BOOKS.map(([file], index) => [file, index]));
  const verses = [...rows.values()]
    .sort((a, b) => (
      bookIndex.get(a.order[0]) - bookIndex.get(b.order[0])
      || a.order[1] - b.order[1]
      || a.order[2] - b.order[2]
    ))
    .map(({ id, reference, text, source }) => ({ id, reference, text, source }));

  fs.writeFileSync(OUT, `${JSON.stringify({
    translation: 'KJV',
    source: 'King James Version, public domain (aruljohn/Bible-kjv)',
    verses,
  }, null, 2)}\n`, 'utf8');

  console.log(`wrote ${verses.length} verses (${curatedCount} curated, ${verses.length - curatedCount} swept)`);
  if (missing) {
    console.log(`${missing} curated references were not found in the dump`);
  }
  const frames = verses.map((row) => Math.ceil(wrap(fold(row.text), 22).length / 4));
  console.log(`frames: 1x${frames.filter((n) => n === 1).length} 2x${frames.filter((n) => n === 2).length} 3x${frames.filter((n) => n === 3).length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
