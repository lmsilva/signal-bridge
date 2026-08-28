const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createVestaboardSimulator,
  readPostedMessage,
  blankBoard,
  ENABLEMENT_HEADER,
  KEY_HEADER,
} = require('../src/vestaboard/simulator');
const { badgeFrame } = require('../src/vestaboard/frames');

function quietLog() {
  const lines = [];
  const capture = (level) => (message, details) => {
    lines.push(`${level} ${message} ${details === undefined ? '' : JSON.stringify(details)}`);
  };
  return {
    lines,
    info: capture('INFO'),
    warn: capture('WARN'),
    error: capture('ERROR'),
    debug: capture('DEBUG'),
  };
}

/** Boot a simulator on an ephemeral port with its own throwaway data dir. */
async function startSim({ rateWindowSeconds = 15, clock } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-sim-'));
  const log = quietLog();
  let fakeNow = clock ? clock.value : Date.now();

  const sim = createVestaboardSimulator({
    config: {
      ROOT: root,
      vestaboardSimulator: { port: 0, host: '127.0.0.1', rateWindowSeconds },
    },
    log,
    now: clock ? () => fakeNow : undefined,
  });

  await sim.start();
  const { port } = sim.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    sim,
    log,
    root,
    base,
    advance(ms) { fakeNow += ms; },
    async stop() {
      await sim.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function post(base, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

async function get(base, pathname, headers = {}) {
  const res = await fetch(`${base}${pathname}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

/** Walk the enablement handshake the way a real owner would. */
async function enable(harness) {
  const res = await post(harness.base, '/local-api/enablement', undefined, {
    [ENABLEMENT_HEADER]: harness.sim.enablementToken(),
  });
  assert.equal(res.status, 200);
  return res.body.apiKey;
}

function sampleFrame(title) {
  return badgeFrame({ color: 'green', title, rows: ['HELLO'] });
}

test('enablement refuses a wrong token and issues a key for the right one', async () => {
  const harness = await startSim();
  try {
    const bad = await post(harness.base, '/local-api/enablement', undefined, {
      [ENABLEMENT_HEADER]: 'not-the-token',
    });
    assert.equal(bad.status, 401);

    const missing = await post(harness.base, '/local-api/enablement');
    assert.equal(missing.status, 401);

    const good = await post(harness.base, '/local-api/enablement', undefined, {
      [ENABLEMENT_HEADER]: harness.sim.enablementToken(),
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.message, 'Local API enabled');
    assert.ok(good.body.apiKey && good.body.apiKey.length > 10);
  } finally {
    await harness.stop();
  }
});

test('enabling twice returns the same key rather than rotating it', async () => {
  const harness = await startSim();
  try {
    const first = await enable(harness);
    const second = await enable(harness);
    assert.equal(first, second);
  } finally {
    await harness.stop();
  }
});

test('reads and writes are refused until the board has been enabled', async () => {
  const harness = await startSim();
  try {
    assert.equal((await get(harness.base, '/local-api/message')).status, 401);
    assert.equal((await post(harness.base, '/local-api/message', blankBoard())).status, 401);
  } finally {
    await harness.stop();
  }
});

test('a wrong key is refused even after the board is enabled', async () => {
  const harness = await startSim();
  try {
    await enable(harness);
    const res = await post(harness.base, '/local-api/message', sampleFrame('HI'), {
      [KEY_HEADER]: 'wrong-key',
    });
    assert.equal(res.status, 401);
  } finally {
    await harness.stop();
  }
});

test('a posted layout flips the board and can be read back', async () => {
  const harness = await startSim();
  try {
    const key = await enable(harness);
    const frame = sampleFrame('SHOPPING LIST');

    const wrote = await post(harness.base, '/local-api/message', frame, { [KEY_HEADER]: key });
    assert.equal(wrote.status, 200);
    assert.equal(wrote.body.status, 'ok');

    const read = await get(harness.base, '/local-api/message', { [KEY_HEADER]: key });
    assert.equal(read.status, 200);
    // The Local API answers with the bare grid, not a wrapper object.
    assert.ok(Array.isArray(read.body), 'expected a bare array');
    assert.deepEqual(read.body, frame);
  } finally {
    await harness.stop();
  }
});

test('an unwritten board reads as blank rather than erroring', async () => {
  const harness = await startSim();
  try {
    const key = await enable(harness);
    const read = await get(harness.base, '/local-api/message', { [KEY_HEADER]: key });
    assert.deepEqual(read.body, blankBoard());
  } finally {
    await harness.stop();
  }
});

test('the animation form is accepted and its strategy remembered', async () => {
  const harness = await startSim();
  try {
    const key = await enable(harness);
    const res = await post(harness.base, '/local-api/message', {
      characters: sampleFrame('WAVE'),
      strategy: 'edges-to-center',
      step_interval_ms: 3000,
      step_size: 2,
    }, { [KEY_HEADER]: key });

    assert.equal(res.status, 200);
    assert.equal(harness.sim.state().lastStrategy, 'edges-to-center');
  } finally {
    await harness.stop();
  }
});

test('a body the local api would not understand is refused', async () => {
  const harness = await startSim();
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    // The cloud API centres {"text": ...}; the local API has no such form.
    assert.equal((await post(harness.base, '/local-api/message', { text: 'HELLO' }, headers)).status, 400);
    assert.equal((await post(harness.base, '/local-api/message', {
      characters: sampleFrame('X'),
      strategy: 'kaleidoscope',
    }, headers)).status, 400);
  } finally {
    await harness.stop();
  }
});

test('a layout the flaps could not show is refused', async () => {
  const harness = await startSim();
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    const tooFewRows = blankBoard().slice(0, 5);
    assert.equal((await post(harness.base, '/local-api/message', tooFewRows, headers)).status, 400);

    const shortRow = blankBoard();
    shortRow[3] = shortRow[3].slice(0, 21);
    assert.equal((await post(harness.base, '/local-api/message', shortRow, headers)).status, 400);

    const illegal = blankBoard();
    illegal[0][0] = 99;
    assert.equal((await post(harness.base, '/local-api/message', illegal, headers)).status, 400);

    // 43 is inside the code range but the board reserves it.
    const reserved = blankBoard();
    reserved[0][0] = 43;
    assert.equal((await post(harness.base, '/local-api/message', reserved, headers)).status, 400);
  } finally {
    await harness.stop();
  }
});

test('posting the layout already showing changes nothing and does not re-flip', async () => {
  const clock = { value: 1_000_000 };
  const harness = await startSim({ rateWindowSeconds: 15, clock });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };
    const frame = sampleFrame('SAME');

    let flips = 0;
    harness.sim.onChange((event) => { if (event === 'flip') flips += 1; });

    assert.equal((await post(harness.base, '/local-api/message', frame, headers)).status, 200);
    assert.equal(flips, 1);

    // Immediately re-posting the same thing is accepted, not rate limited: the
    // board is not moving, so there is nothing to wait for.
    const again = await post(harness.base, '/local-api/message', frame, headers);
    assert.equal(again.status, 200);
    assert.equal(flips, 1, 'no second flip for identical content');
  } finally {
    await harness.stop();
  }
});

test('a duplicate does not restart the rate window', async () => {
  // Otherwise a page that repeats itself would lock the board out forever.
  const clock = { value: 5_000_000 };
  const harness = await startSim({ rateWindowSeconds: 15, clock });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };
    const first = sampleFrame('ONE');

    await post(harness.base, '/local-api/message', first, headers);
    harness.advance(14_000);
    await post(harness.base, '/local-api/message', first, headers);
    harness.advance(1_000);

    const second = await post(harness.base, '/local-api/message', sampleFrame('TWO'), headers);
    assert.equal(second.status, 200, 'the window ran from the real flip, not the duplicate');
  } finally {
    await harness.stop();
  }
});

test('a second flip inside the rate window is refused with 503', async () => {
  const clock = { value: 2_000_000 };
  const harness = await startSim({ rateWindowSeconds: 15, clock });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    assert.equal((await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers)).status, 200);

    const tooSoon = await post(harness.base, '/local-api/message', sampleFrame('TWO'), headers);
    assert.equal(tooSoon.status, 503);
    assert.equal(tooSoon.body.message, 'rate limited');

    harness.advance(15_000);
    const later = await post(harness.base, '/local-api/message', sampleFrame('TWO'), headers);
    assert.equal(later.status, 200);
  } finally {
    await harness.stop();
  }
});

test('a board toggled off answers 503 so error paths can be exercised on purpose', async () => {
  const harness = await startSim({ rateWindowSeconds: 0 });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    harness.sim.setOnline(false);
    const offline = await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    assert.equal(offline.status, 503);
    assert.equal(offline.body.message, 'board offline');

    harness.sim.setOnline(true);
    const back = await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    assert.equal(back.status, 200);
  } finally {
    await harness.stop();
  }
});

test('toggling the board announces the change to anything watching', async () => {
  const harness = await startSim();
  try {
    const seen = [];
    harness.sim.onChange((event, detail) => {
      if (event === 'state') seen.push(detail.online);
    });

    harness.sim.setOnline(false);
    harness.sim.setOnline(false);
    harness.sim.setOnline(true);

    assert.deepEqual(seen, [false, true], 'only real changes are announced');
  } finally {
    await harness.stop();
  }
});

test('the call log records outcomes without ever recording the key', async () => {
  const harness = await startSim({ rateWindowSeconds: 0 });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    await post(harness.base, '/local-api/message', { text: 'no' }, headers);
    await get(harness.base, '/local-api/message', { [KEY_HEADER]: 'bad' });

    const results = harness.sim.calls().map((entry) => entry.result);
    assert.deepEqual(results, [
      '200 enabled',
      '200 flipped',
      '200 duplicate',
      '400 bad layout',
      '401 auth bad',
    ]);

    const serialised = JSON.stringify(harness.sim.calls());
    assert.ok(!serialised.includes(key), 'the key must never reach the call log');
  } finally {
    await harness.stop();
  }
});

test('each call names the endpoint and says why it landed the way it did', async () => {
  // The admin page is the only place this traffic is visible, so an entry has
  // to answer "what was posted where, and why was it refused" on its own.
  const harness = await startSim({ rateWindowSeconds: 0 });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };

    await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    await get(harness.base, '/local-api/message', headers);
    await post(harness.base, '/local-api/message', sampleFrame('TWO'), {});

    const [enabled, flipped, duplicate, read, refused] = harness.sim.calls();

    assert.equal(enabled.endpoint, '/local-api/enablement');
    assert.equal(enabled.verb, 'POST');
    assert.equal(enabled.status, 200);
    assert.match(enabled.detail, /issued a new local API key/);

    assert.equal(flipped.endpoint, '/local-api/message');
    assert.match(flipped.detail, /of 132 cells changed/);

    assert.match(duplicate.detail, /identical to the frame already on the board/);

    assert.equal(read.verb, 'GET');
    assert.match(read.detail, /returned the 6x22 grid/);

    assert.equal(refused.status, 401);
    assert.match(refused.detail, /no x-vestaboard-local-api-key header/);

    // Kept so an older page and the outcome assertions above still read the
    // same two fields they always did.
    assert.equal(flipped.method, 'POST message');
    assert.ok(!JSON.stringify(harness.sim.calls()).includes(key));
  } finally {
    await harness.stop();
  }
});

test('a refused write says which limit stopped it', async () => {
  const harness = await startSim({ rateWindowSeconds: 15 });
  try {
    const key = await enable(harness);
    const headers = { [KEY_HEADER]: key };
    await post(harness.base, '/local-api/message', sampleFrame('ONE'), headers);
    await post(harness.base, '/local-api/message', sampleFrame('TWO'), headers);

    const rate = harness.sim.calls().at(-1);
    assert.equal(rate.result, '503 rate');
    assert.match(rate.detail, /flaps still moving — \d+s left of the 15s window/);

    harness.sim.setOnline(false);
    await post(harness.base, '/local-api/message', sampleFrame('TRE'), headers);
    assert.match(harness.sim.calls().at(-1).detail, /switched off on this page/);
  } finally {
    await harness.stop();
  }
});

test('neither the key nor the enablement token is ever logged or published', async () => {
  const harness = await startSim({ rateWindowSeconds: 0 });
  try {
    const token = harness.sim.enablementToken();
    const key = await enable(harness);

    await post(harness.base, '/local-api/message', sampleFrame('ONE'), { [KEY_HEADER]: key });
    await post(harness.base, '/local-api/message', sampleFrame('BAD'), { [KEY_HEADER]: 'nope' });

    const logged = harness.log.lines.join('\n');
    assert.ok(!logged.includes(key), 'key leaked into a log line');
    assert.ok(!logged.includes(token), 'enablement token leaked into a log line');

    // The state snapshot feeds the admin page over SSE, so it must be clean too.
    const published = JSON.stringify(harness.sim.state());
    assert.ok(!published.includes(key));
    assert.ok(!published.includes(token));
  } finally {
    await harness.stop();
  }
});

test('the board remembers its key and its face across a restart', async () => {
  const harness = await startSim({ rateWindowSeconds: 0 });
  const frame = sampleFrame('PERSIST');
  let key;
  try {
    key = await enable(harness);
    await post(harness.base, '/local-api/message', frame, { [KEY_HEADER]: key });
    await harness.sim.stop();

    const revived = createVestaboardSimulator({
      config: {
        ROOT: harness.root,
        vestaboardSimulator: { port: 0, host: '127.0.0.1' },
      },
      log: quietLog(),
    });

    assert.equal(revived.apiKey(), key, 'a restart must not invalidate the key');
    assert.deepEqual(revived.state().current, frame);
  } finally {
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

test('unknown paths and methods are not treated as board traffic', async () => {
  const harness = await startSim();
  try {
    assert.equal((await get(harness.base, '/')).status, 404, 'not a board path at all');
    assert.equal((await get(harness.base, '/nope')).status, 404);

    // These paths exist but only take the one method the board documents.
    assert.equal((await get(harness.base, '/local-api/enablement')).status, 405);
    const res = await fetch(`${harness.base}/local-api/message`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  } finally {
    await harness.stop();
  }
});

test('body parsing accepts both real request shapes and rejects the rest', () => {
  const grid = blankBoard();
  assert.deepEqual(readPostedMessage(grid).characters, grid);
  assert.equal(readPostedMessage(grid).strategy, null);

  const withAnimation = readPostedMessage({ characters: grid, strategy: 'row', step_size: 3 });
  assert.equal(withAnimation.strategy, 'row');
  assert.equal(withAnimation.stepSize, 3);

  assert.ok(readPostedMessage({ text: 'hello' }).error);
  assert.ok(readPostedMessage(null).error);
  assert.ok(readPostedMessage('nope').error);
});
