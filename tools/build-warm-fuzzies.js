#!/usr/bin/env node
/**
 * Build the shipped Warm Fuzzies corpus.
 *
 *   node tools/build-warm-fuzzies.js
 *
 * Merges the curated seed with template-generated compliments, then keeps
 * only board-fit lines. No network at runtime.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fitsBoard, cleanText } = require('../src/warm-fuzzies-layout');
const SEED = require('./warm-fuzzies-seed');

const OUT = path.join(__dirname, '..', 'src', 'warm-fuzzies-fuzzies.json');

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
  const youAlways = [
    'pick the best karaoke song',
    'know the perfect song',
    'find the best parking spot',
    'order for the whole table',
    'make everyone feel welcome',
    'remember the little things',
    'bring the best snacks',
    'choose the perfect movie',
    'pick the best playlist',
    'make a room feel brighter',
    'know when someone needs help',
    'make people laugh at the right time',
    'find the silver lining',
    'make hard days feel lighter',
    'show up when it counts',
    'make ordinary moments special',
    'keep the group chat fun',
    'make coffee taste better',
    'pick the best seat in the house',
    'make plans people actually want to join',
  ];
  for (const tail of youAlways) {
    out.push(`You always ${tail}.`);
  }

  const your = [
    ['smile', 'lights up a room'],
    ['kindness', 'makes hard days easier'],
    ['patience', 'helps everyone breathe'],
    ['humor', 'turns awkward into fun'],
    ['energy', 'gets good things started'],
    ['calm', 'keeps everyone steady'],
    ['curiosity', 'makes conversations better'],
    ['honesty', 'builds real trust'],
    ['creativity', 'makes life more colorful'],
    ['generosity', 'makes people feel seen'],
    ['optimism', 'pulls the room forward'],
    ['empathy', 'makes people feel safe'],
    ['enthusiasm', 'makes work feel lighter'],
    ['warmth', 'makes guests feel at home'],
    ['grit', 'inspires the people around you'],
    ['grace', 'makes tough moments softer'],
    ['focus', 'helps teams finish strong'],
    ['loyalty', 'makes friendships last'],
    ['courage', 'encourages others to try'],
    ['thoughtfulness', 'makes people feel valued'],
  ];
  for (const [noun, rest] of your) {
    out.push(`Your ${noun} ${rest}.`);
  }

  const starters = [
    'The world is better because you are in it.',
    'You make people feel like they belong.',
    'You have a gift for making others feel seen.',
    'People are lucky to know you.',
    'You bring out the best in people.',
    'You make ordinary days feel special.',
    'Your presence makes everything warmer.',
    'You are someone people can count on.',
    'You make teamwork feel easy.',
    'You have a heart of gold.',
    'You make kindness look effortless.',
    'You are a bright spot in any room.',
    'You make people feel comfortable being themselves.',
    'You have a way of making people smile.',
    'You are proof that good people exist.',
    'You make hard conversations feel safe.',
    'You are the friend everyone hopes for.',
    'You make celebrations feel complete.',
    'You have excellent taste in people.',
    'You make life feel less lonely.',
    'You are quietly extraordinary.',
    'You make people feel proud to know you.',
    'You are a joy to be around.',
    'You make good moments unforgettable.',
    'You are someone worth celebrating.',
    'You make people feel heard.',
    'You are a steady light for others.',
    'You make generosity look natural.',
    'You are deeply appreciated.',
    'You make hope feel realistic.',
  ];
  out.push(...starters);

  const longer = [
    'That thing you do not like about yourself is what makes you really interesting.',
    'Who raised you? They deserve a medal for a job well done.',
    'The way you show up for people says more than you realize.',
    'You have a talent for making other people feel capable.',
    'Your weird little hobbies are part of what makes you charming.',
    'The care you put into details does not go unnoticed.',
    'You make it easier for people to be honest with you.',
    'Your laugh is one of the best sounds in the house.',
    'You have a way of turning setbacks into stories worth telling.',
    'The kindness you give out always finds its way back.',
    'You make people feel like their ideas matter.',
    'Your effort is one of the most inspiring things about you.',
    'You have a gift for noticing what other people miss.',
    'The world needs more people who care the way you do.',
    'You make it safe for people to ask for help.',
    'Your confidence is contagious in the best way.',
    'You make people feel like they are enough.',
    'The way you listen is a real superpower.',
    'You turn small gestures into big comfort.',
    'Your integrity makes you someone people trust.',
  ];
  out.push(...longer);

  const compliments = [
    'Nice work today.',
    'You nailed it.',
    'Well done.',
    'Great job.',
    'You crushed it.',
    'That was excellent.',
    'You made that look easy.',
    'Impressive work.',
    'You should be proud.',
    'That was beautifully done.',
    'You are on fire today.',
    'Keep being awesome.',
    'You are doing great.',
    'That was a win.',
    'You made a difference today.',
    'You handled that perfectly.',
    'That was smart thinking.',
    'You saved the day.',
    'You are a star.',
    'That was exactly right.',
  ];
  out.push(...compliments);

  const talents = [
    'You are a great listener.',
    'You are an excellent friend.',
    'You are a wonderful host.',
    'You are a natural leader.',
    'You are a creative thinker.',
    'You are a problem solver.',
    'You are a calming presence.',
    'You are a loyal teammate.',
    'You are a thoughtful gift giver.',
    'You are a patient teacher.',
    'You are a brave voice.',
    'You are a generous soul.',
    'You are a quick learner.',
    'You are a steady helper.',
    'You are a bright mind.',
    'You are a warm welcome.',
    'You are a trusted advisor.',
    'You are a fun adventure buddy.',
    'You are a reliable planner.',
    'You are a kind heart.',
  ];
  out.push(...talents);

  const thanks = [
    'Thank you for being you.',
    'Thank you for showing up.',
    'Thank you for caring.',
    'Thank you for helping.',
    'Thank you for listening.',
    'Thank you for your patience.',
    'Thank you for your kindness.',
    'Thank you for making time.',
    'Thank you for the laugh.',
    'Thank you for the support.',
    'Thank you for the encouragement.',
    'Thank you for keeping us grounded.',
    'Thank you for the good energy.',
    'Thank you for being reliable.',
    'Thank you for the thoughtful note.',
    'Thank you for the extra effort.',
    'Thank you for the honest feedback.',
    'Thank you for the warm welcome.',
    'Thank you for the calm presence.',
    'Thank you for the great idea.',
  ];
  out.push(...thanks);

  return out;
}

function main() {
  const seen = new Set();
  const fuzzies = [];

  for (const raw of [...SEED, ...expandTemplates()]) {
    const text = cleanText(raw);
    if (!text || seen.has(text.toLowerCase()) || !familySafe(text) || !fitsBoard(text)) {
      continue;
    }
    seen.add(text.toLowerCase());
    fuzzies.push({ id: `wf-${slug(text)}`, text });
  }

  fuzzies.sort((a, b) => a.text.localeCompare(b.text));
  fs.writeFileSync(OUT, `${JSON.stringify({ fuzzies }, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${fuzzies.length} warm fuzzies to ${OUT}`);
  if (fuzzies.length < 200) {
    process.exitCode = 1;
    console.error('Expected at least 200 board-fit fuzzies');
  }
}

main();
