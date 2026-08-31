#!/usr/bin/env node
/**
 * Build the shipped Daily Bucket Fillers corpus.
 *
 *   node tools/build-daily-bucket-fillers.js
 *
 * Merges the curated seed with template-generated kindness challenges,
 * then keeps only board-fit, family-safe lines. No network at runtime.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fitsBoard, cleanText } = require('../src/daily-bucket-fillers-layout');
const SEED = require('./daily-bucket-fillers-seed');

const OUT = path.join(__dirname, '..', 'src', 'daily-bucket-fillers-fillers.json');

const BANNED = new RegExp([
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'nigg', 'fagg', 'cunt',
  'cock', 'dick', 'pussy', 'whore', 'slut', 'rape', 'nude', 'naked',
  'sex', 'horny', 'orgasm', 'douche', 'penis', 'vagina', 'porn',
  'kill myself', 'suicide', 'damn', 'hell\\b',
].join('|'), 'i');

function slug(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

function familySafe(text) {
  const folded = cleanText(text);
  return folded && !BANNED.test(folded);
}

function expandTemplates() {
  const out = [];

  const writeA = [
    'thank you note to someone who helped you',
    'kind note for a friend who had a hard day',
    'joke on a sticky note for someone you love',
    'welcome note for someone new',
    'compliment and hide it in a lunchbox',
    'thank you to the person who cooked',
    'note that just says I noticed you',
    'letter to a grandparent you miss',
    'kind bookmark and leave it in a library book',
    'card for the mail carrier',
    'poem for someone in this house',
    'note that says you make ordinary days better',
  ];
  for (const tail of writeA) {
    out.push(`Write a ${tail}.`);
  }

  const shareYour = [
    'snack with someone who forgot theirs',
    'umbrella on a rainy walk',
    'best stickers without asking for them back',
    'favorite song with someone who needs it',
    'crayons without being asked',
    'fries and the nicer half',
    'quiet book with a younger kid',
    'best joke, then listen to theirs',
    'sidewalk chalk with the next kid',
    'extra pencil with someone who needs one',
    'favorite playlist with a friend',
    'last good seat if someone else wants it',
  ];
  for (const tail of shareYour) {
    out.push(`Share your ${tail}.`);
  }

  const help = [
    'set the table without being asked',
    'unload the groceries',
    'a sibling with homework',
    'fold the laundry',
    'a neighbor take in their bins',
    'someone pick up dropped papers',
    'wipe a table after lunch',
    'a friend find a lost hat',
    'carry a heavy bag',
    'put away sports gear',
    'a younger kid reach the sink',
    'stack chairs after class',
    'a neighbor water their flowers',
    'clean a room you did not mess up',
    'someone learn a skill you know well',
    'a friend practice a speech',
  ];
  for (const tail of help) {
    out.push(`Help ${tail}.`);
  }

  const leaveA = [
    'kind note in a library book',
    'thank you on a sticky note',
    'painted rock on a walking path',
    'kind note in a lunchbox',
    'flower on a doorstep',
    'kind bookmark for the next reader',
    'treat for the mail carrier',
    'kind note on a fridge',
    'book you loved in a little free library',
    'thank you for the bus driver',
    'painted kindness stone outside',
    'kind note under a pillow',
  ];
  for (const tail of leaveA) {
    out.push(`Leave a ${tail}.`);
  }

  const thankThe = [
    'person who cooked dinner',
    'crossing guard by name',
    'person who drives you places',
    'librarian for a good recommendation',
    'person who does the laundry',
    'coach who stayed late',
    'mail carrier with a wave and a smile',
    'person who packed the snacks',
    'substitute teacher with a real thank you',
    'person who finds lost things',
    'night custodian if you see them',
    'volunteer who showed up',
  ];
  for (const tail of thankThe) {
    out.push(`Thank the ${tail}.`);
  }

  const give = [
    'someone else the last cookie',
    'a genuine high five',
    'someone the nicer seat',
    'a friend the better half',
    'someone else the first turn',
    'a shy person an easy hello',
    'someone a second chance today',
    'a teammate credit out loud',
    'someone the window seat',
    'a new kid a tour of the playground',
    'someone a drawing you made for them',
    'a neighbor homemade cookies',
  ];
  for (const tail of give) {
    out.push(`Give ${tail}.`);
  }

  const letSomeone = [
    'go ahead of you in line',
    'else pick the game tonight',
    'else choose the movie',
    'else have the last ice cream',
    'else have the comfy chair',
    'else blow out a candle',
    'new join your group',
    'else have the window seat',
    'else have the first pancake',
    'else have the last marshmallow',
    'younger go first on the slide',
    'else have the better controller',
  ];
  for (const tail of letSomeone) {
    out.push(`Let someone ${tail}.`);
  }

  const say = [
    'good morning to everyone you see',
    'I missed you to someone you did',
    'I believe in you before a test',
    'I am glad you are here',
    'please and thank you extra today',
    'I like how you think',
    'you did great after a small try',
    'I am on your team today',
    'I like playing with you',
    'take your time to someone rushing',
    'I like your questions',
    'I am happy you came',
  ];
  for (const tail of say) {
    out.push(`Say ${tail}.`);
  }

  const offerTo = [
    'walk a neighbor’s dog',
    'take a family photo for strangers',
    'refill someone’s water',
    'play the game someone else likes',
    'be the one who goes last',
    'hold someone’s place in line',
    'take notes for a friend who is out',
    'put the game back in the box',
    'refill the pet water bowl',
    'be the one who sweeps',
    'turn out the extra lights',
    'collect the balls after the game',
  ];
  for (const tail of offerTo) {
    out.push(`Offer to ${tail}.`);
  }

  const donate = [
    'toys you no longer use',
    'a coat you outgrew',
    'books you already loved',
    'puzzles you finished',
    'art supplies you have extras of',
    'a stuffed animal you outgrew',
    'games you do not play anymore',
    'clothes that still have life in them',
  ];
  for (const tail of donate) {
    out.push(`Donate ${tail}.`);
  }

  const makeA = [
    'feel good playlist and share it',
    'card for someone who helped you',
    'breakfast for someone else',
    'drawing and give it away',
    'kindness stone and leave it on a path',
    'thank you video for a grandparent',
    'list of things you like about a sibling',
    'welcome sign for a guest',
  ];
  for (const tail of makeA) {
    out.push(`Make a ${tail}.`);
  }

  const pickUp = [
    'litter you did not drop',
    'someone else’s dropped papers',
    'toys you did not take out',
    'spilled crayons without being asked',
    'a neighbor’s bins if they forgot',
    'the game pieces after someone else played',
  ];
  for (const tail of pickUp) {
    out.push(`Pick up ${tail}.`);
  }

  const sitWith = [
    'someone who is sitting alone',
    'a new kid at lunch',
    'a younger sibling during a hard moment',
    'someone who looks left out',
  ];
  for (const tail of sitWith) {
    out.push(`Sit with ${tail}.`);
  }

  const invite = [
    'someone new to join your group',
    'a shy friend to play first',
    'a neighbor kid to draw on the sidewalk',
    'someone who was left out last time',
  ];
  for (const tail of invite) {
    out.push(`Invite ${tail}.`);
  }

  const extra = [
    'Hold the door for the next person and wait.',
    'Return a stray cart at the store.',
    'Wave to a neighbor you usually pass.',
    'Smile at five people today.',
    'Listen without interrupting once today.',
    'Ask someone how their day really was.',
    'Cheer for a teammate who missed a shot.',
    'Clap for someone who tried something hard.',
    'High five the person who lost.',
    'Save a seat for someone late.',
    'Wait patiently without sighing.',
    'Turn down your music for the house.',
    'Feed the birds in the yard.',
    'Water a plant that is not yours.',
    'Open a jar for someone who cannot.',
    'Offer your seat on the bus.',
    'Share your umbrella if it starts to rain.',
    'Let a friend pick the playlist.',
    'Be the first to say hello.',
    'Include the person standing at the edge.',
    'Do a chore that is usually someone else’s.',
    'Tell a parent one thing you appreciate.',
    'Tell a sibling you are proud of them.',
    'Compliment a classmate on their work.',
    'Give a compliment that is specific.',
    'Leave extra change in a kind place.',
    'Read a story to someone younger.',
    'Teach someone a skill you know well.',
    'Call a grandparent just to say hello.',
    'Send a voice message that just says thanks.',
    'Text a friend a favorite memory.',
    'Draw a picture and give it away.',
    'Make someone laugh on purpose.',
    'Tell a joke that is kind, not mean.',
    'Be patient with someone who is learning.',
    'Forgive a small mistake today.',
    'Give someone a real apology if you were sharp.',
    'Notice who is left out and invite them in.',
    'Use someone’s name when you thank them.',
    'Look up from your screen when someone talks.',
    'Put your phone away at dinner.',
    'Let someone else have the last word, kindly.',
    'Celebrate someone else’s good news first.',
    'Pass along a compliment you heard about them.',
    'Remind someone they are good at something.',
    'Help without announcing that you helped.',
    'Do the small job nobody wants.',
    'Be the person who puts the lid back on.',
    'Refill something you did not empty.',
    'Leave a place nicer than you found it.',
    'Say after you and mean it.',
    'Walk on the outside of the sidewalk.',
    'Carry the heavier bag on purpose.',
    'Take the worse seat on purpose.',
    'Be early so someone else can be late.',
    'Wait for the slowest person without rushing them.',
    'Learn one fact about someone you see every day.',
    'Remember a detail someone told you last week.',
    'Ask a follow-up question and listen.',
    'Keep a secret that is safe to keep.',
    'Defend someone who is not in the room.',
    'Change the subject when gossip starts.',
    'Include the new person in the photo.',
    'Save the last swing for someone else.',
    'Be kind when you win.',
    'Be kind when you lose.',
    'Cheer like it matters even if it is practice.',
    'Thank the referee or the judge.',
    'Help clean the field after the game.',
    'Shake hands like you mean it.',
    'Tell the cook the food was good.',
    'Clear your own place and one extra.',
    'Start the dishwasher if it is full.',
    'Take out trash that is not only yours.',
    'Bring in the bins before you are asked.',
    'Wipe the sink after you use it.',
    'Hang up a towel that is not yours.',
    'Make the guest bed extra nice.',
    'Leave a light on for someone coming home late.',
    'Save the last cookie and then give it away.',
    'Split the good snack evenly.',
    'Trade if someone got the smaller half.',
    'Let a younger kid explain the rules.',
    'Play the game the youngest person wants.',
    'Lose on purpose once if it makes someone’s day.',
    'Teach a rule without making anyone feel small.',
    'Wait your turn like it is easy.',
    'Return what you borrowed in better shape.',
    'Write the name on the leftover container.',
    'Offer the charger before you are asked.',
    'Share the outlet.',
    'Give someone else the better headphones.',
    'Pause the show if someone walks in.',
    'Explain the joke to the person who missed it.',
    'Translate if someone is left out of the language.',
    'Save a snack for the person who is still traveling.',
    'Text the person who could not come.',
    'Send photos to the person who missed it.',
    'Introduce two people who would like each other.',
    'Remember someone’s allergy without being reminded.',
    'Make space on the bench.',
    'Scoot over without being asked.',
    'Keep the sidewalk clear after you play.',
    'Put the balls back in the bin.',
    'Leave the park cleaner than you found it.',
    'Thank the person who organized the day.',
    'Be the one who writes the thank you later.',
    'Mail a real letter to someone you miss.',
    'Draw a map to your favorite tree and share it.',
    'Show someone the best view from the yard.',
    'Point out a kind thing someone else did.',
    'Name the kindness when you see it.',
    'Fill a bucket on purpose before noon.',
    'Fill someone else’s bucket before your own.',
  ];
  out.push(...extra);

  return out;
}

function uniqueFolded(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const text = cleanText(raw);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(text);
  }
  return out;
}

function main() {
  const merged = uniqueFolded([...SEED, ...expandTemplates()]);
  const fillers = [];
  let skipped = 0;
  for (const text of merged) {
    if (!familySafe(text) || !fitsBoard(text)) {
      skipped += 1;
      continue;
    }
    fillers.push({ id: slug(text), text });
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: fillers.length,
    fillers,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${fillers.length} bucket fillers (${skipped} skipped) to ${path.relative(process.cwd(), OUT)}`);
}

main();
