'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ROWS, COLS, validate } = require('../src/vestaboard/encoder');
const { formatLayout } = require('../src/vestaboard/notation');
const { dadJokesFrames } = require('../src/vestaboard/formatters/feeds');
const { jokeLines, BODY_WIDTH } = require('../src/dad-jokes-layout');
const {
  BODY_ROWS,
  loadShipped,
  matchingJokes,
  pickJoke,
  listJokes,
  buildDadJokesPayload,
  createDadJokes,
} = require('../src/dad-jokes');
const { sanitiseSettings } = require('../src/dad-jokes-settings');

/**
 * Compare against a drawing of the whole board.
 *
 * `parseLayout` eats leading blank lines, and a vertically centred block is
 * mostly leading blank lines, so this matches `formatLayout` row for row.
 */
function assertBoard(rows, drawing, label) {
  assert.equal(validate(rows).ok, true, `${label} failed validation`);
  const actual = formatLayout(rows);
  const expected = drawing.join('\n');
  if (actual !== expected) {
    assert.fail(
      `${label} does not match the spec drawing\n\n`
      + `--- expected ---\n${expected}\n\n`
      + `--- actual ---\n${actual}\n`,
    );
  }
}

const framesFor = (setup, punchline) => dadJokesFrames(
  buildDadJokesPayload({ id: 'demo', setup, punchline }),
);

/** Settings that see only the rows the test supplies, not the shipped corpus. */
const onlyCustom = (custom) => sanitiseSettings({
  custom,
  removedIds: loadShipped().map((joke) => joke.id),
});

test('the three channel cards render flap for flap', () => {
  const frogs = framesFor('What happens when frogs park illegally?', 'They get toad.');
  assert.equal(frogs.length, 1);
  assert.equal(frogs[0].source, 'dad.jokes');
  assert.equal(frogs[0].label, 'Dad Jokes');
  assertBoard(frogs[0].rows, [
    '',
    'WHAT HAPPENS WHEN',
    'FROGS PARK ILLEGALLY?',
    '',
    'THEY GET TOAD.',
    '',
  ], 'Frogs card');

  const clock = framesFor(
    'Why is it a bad idea to eat a clock?',
    "Because it's time-consuming & you always want seconds.",
  );
  assertBoard(clock[0].rows, [
    'WHY IS IT A BAD IDEA',
    'TO EAT A CLOCK?',
    '',
    "BECAUSE IT'S",
    'TIME-CONSUMING & YOU',
    'ALWAYS WANT SECONDS.',
  ], 'Clock card');

  // The discriminating card: at 22 columns the punchline packs onto
  // "IT'S PRETTY", and with the orphan rule the setup breaks after "DOES".
  const rainbow = framesFor('How much does a rainbow weigh?', "Not much - it's pretty light.");
  assertBoard(rainbow[0].rows, [
    'HOW MUCH DOES A',
    'RAINBOW WEIGH?',
    '',
    "NOT MUCH - IT'S",
    'PRETTY LIGHT.',
    '',
  ], 'Rainbow card');
});

test('the pause between setup and punchline is a real row', () => {
  const lines = jokeLines('What do you call a fake noodle?', 'An impasta.');
  assert.deepEqual(lines, ['WHAT DO YOU CALL A', 'FAKE NOODLE?', '', 'AN IMPASTA.']);
  assert.equal(lines[2], '', 'the blank row is the joke');
});

test('a joke with only one half gets no stray blank row', () => {
  assert.deepEqual(jokeLines('Just the setup.', ''), ['JUST THE SETUP.']);
  assert.deepEqual(jokeLines('', 'Just the punchline.'), ['JUST THE PUNCHLINE.']);
  assert.deepEqual(jokeLines('', ''), []);
});

test('the wrap leaves the last column empty', () => {
  for (const line of jokeLines(
    'Why is it a bad idea to eat a clock?',
    "Because it's time-consuming & you always want seconds.",
  )) {
    assert.ok(line.length <= BODY_WIDTH, line);
  }
  assert.equal(BODY_WIDTH, COLS - 1);
});

test('an empty joke never flips the board', () => {
  assert.equal(buildDadJokesPayload({ id: 'x', setup: '  ' }), null);
  assert.deepEqual(dadJokesFrames({ type: 'dad.jokes' }), []);
  assert.deepEqual(dadJokesFrames({}), []);
});

test('a joke too long for one frame pages without opening on the pause', () => {
  const frames = dadJokesFrames(buildDadJokesPayload({
    id: 'long',
    setup: 'Why did the very long winded and rambling scarecrow with the enormous hat win a prize',
    punchline: 'Because he was quite remarkably and unusually outstanding in his own large field',
  }));
  assert.ok(frames.length >= 2, 'a long joke should page');
  for (const frame of frames) {
    assert.equal(frame.rows.length, ROWS);
    assert.equal(validate(frame.rows).ok, true);
  }
  // A frame that began on the separator would waste its first row.
  const second = formatLayout(frames[1].rows).split('\n');
  assert.notEqual(second.find((line) => line !== ''), undefined);
});

test('the shipped corpus is board-fit, two-part and clean', () => {
  const jokes = loadShipped();
  assert.ok(jokes.length > 20, `only ${jokes.length} jokes shipped`);

  const seenIds = new Set();
  const seenText = new Set();
  for (const joke of jokes) {
    assert.match(joke.id, /^joke-[0-9a-f]{10}$/);
    assert.equal(seenIds.has(joke.id), false, `duplicate id ${joke.id}`);
    seenIds.add(joke.id);
    assert.ok(joke.punchline, `${joke.setup} has no punchline`);

    const lines = jokeLines(joke.setup, joke.punchline);
    assert.ok(lines.length >= 1 && lines.length <= BODY_ROWS, joke.setup);
    for (const line of lines) {
      assert.ok(line.length <= BODY_WIDTH, joke.setup);
    }

    const key = lines.join('\n');
    assert.equal(seenText.has(key), false, `duplicate joke ${joke.setup}`);
    seenText.add(key);

    // Groan-worthy, not eyebrow-raising — this hangs in the kitchen.
    const whole = `${joke.setup} ${joke.punchline}`;
    assert.doesNotMatch(whole, /\b(sex|damn|hell|drunk|beer|stupid)\b/i, whole);
  }
});

test('the rotation skips what it just showed', () => {
  const settings = {
    ...onlyCustom([
      { id: 'a', setup: 'Knock knock?', punchline: 'Who is there.' },
      { id: 'b', setup: 'Why the long face?', punchline: 'I am a horse.' },
    ]),
    recentIds: ['a'],
  };
  assert.equal(pickJoke(settings, { random: () => 0 }).id, 'b');
  assert.equal(pickJoke({ ...settings, recentIds: ['a', 'b'] }, { random: () => 0 }).id, 'a');
});

test('the list searches setups and punchlines, and paginates', () => {
  const settings = onlyCustom(Array.from({ length: 30 }, (_, index) => ({
    id: `c${index}`,
    setup: `What is joke number ${index}?`,
    punchline: `Punchline ${index}.`,
  })));
  const page = listJokes(settings, { page: 2, pageSize: 10 });
  assert.equal(page.pages, 3);
  assert.equal(page.jokes.length, 10);
  assert.ok(page.jokes[0].rows >= 1);

  assert.equal(listJokes(settings, { query: 'number 7?' }).total, 1);
  assert.equal(listJokes(settings, { query: 'punchline 12.' }).total, 1);
});

test('house edits hide, override both halves, add and remove jokes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-jokes-'));
  const jokes = createDadJokes({
    ROOT: root,
    dadJokesSettingsPath: path.join(root, 'dad-jokes-settings.json'),
  });
  const shipped = loadShipped()[0];

  const hidden = jokes.updateJoke(shipped.id, { hidden: true });
  assert.equal(hidden.ok, true);
  assert.ok(hidden.hiddenCount >= 1);
  assert.equal(matchingJokes(jokes.getSettings()).some((row) => row.id === shipped.id), false);

  const edited = jokes.updateJoke(shipped.id, {
    hidden: false,
    setup: 'What do you call a house joke?',
    punchline: 'A home run.',
  });
  assert.equal(edited.ok, true);
  const override = matchingJokes(jokes.getSettings()).find((row) => row.id === shipped.id);
  assert.match(override.setup, /house joke/);
  assert.equal(override.punchline, 'A home run.');

  // Typing a shipped joke back to what it was drops the override entirely.
  jokes.updateJoke(shipped.id, { setup: shipped.setup, punchline: shipped.punchline });
  assert.deepEqual(jokes.getSettings().overrides, {});

  const added = jokes.addJoke('Why is the kitchen so funny?', 'It cracks eggs.');
  assert.equal(added.ok, true);
  assert.equal(added.customCount, 1);
  assert.equal(jokes.addJoke('   ', 'Nothing').ok, false);

  const payload = jokes.nextPayload({ random: () => 0 });
  assert.equal(payload.type, 'dad.jokes');
  assert.ok(payload.joke.setup);
  assert.ok(jokes.getSettings().recentIds.includes(payload.joke.id));

  const customId = jokes.getSettings().custom[0].id;
  assert.equal(jokes.updateJoke(customId, { punchline: 'It cracks up.' }).ok, true);
  assert.equal(jokes.getSettings().custom[0].punchline, 'It cracks up.');
  assert.equal(jokes.updateJoke(customId, { remove: true }).ok, true);
  assert.equal(jokes.getSettings().custom.length, 0);

  assert.equal(jokes.updateJoke(shipped.id, { remove: true }).ok, true);
  assert.ok(jokes.getSettings().removedIds.includes(shipped.id));
  assert.equal(
    listJokes(jokes.getSettings(), { hidden: true }).jokes.some((row) => row.id === shipped.id),
    false,
  );
  assert.equal(jokes.updateJoke('nope', { setup: 'x' }).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
});
