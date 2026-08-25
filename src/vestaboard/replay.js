#!/usr/bin/env node
/**
 * Replay a slice of voice-events.jsonl through the real Vestaboard router.
 *
 * This is the main integration test for the board: the real family traffic,
 * aimed at the simulator, at an accelerated pace. Queue pacing still applies
 * — lower `rateWindowSeconds` (here, or on the sim board) to run fast without
 * special-casing the send path.
 *
 *   npm run board-replay -- --file data/voice-events.jsonl --last 50 --speed 10
 */

const fs = require('fs');
const path = require('path');

const { formatterFor } = require('./router');

function parseArgs(argv) {
  const out = {
    file: '',
    last: 50,
    types: null,
    speed: 1,
    board: 'sim',
    rateWindowSeconds: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next) {
      out.file = next;
      i += 1;
    } else if (arg === '--last' && next) {
      out.last = Math.max(1, Number(next) || 50);
      i += 1;
    } else if (arg === '--types' && next) {
      out.types = next.split(',').map((item) => item.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--speed' && next) {
      out.speed = Math.max(0.1, Number(next) || 1);
      i += 1;
    } else if (arg === '--board' && next) {
      out.board = next;
      i += 1;
    } else if (arg === '--rate-window' && next) {
      out.rateWindowSeconds = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`No such file: ${file}`);
  }
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSON on line ${index + 1} of ${file}`);
      }
    });
}

/**
 * The log stores a summary, not always the UDP payload. Rebuild enough of
 * one that the formatter can decide whether the event is worth a flip.
 */
function payloadFromLog(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (entry.payload && typeof entry.payload === 'object') {
    return { type: entry.type || entry.payload.type, ...entry.payload };
  }
  const type = entry.type;
  if (!type) {
    return null;
  }
  if (type === 'broadcast') {
    return {
      type: 'broadcast',
      sender: entry.device || entry.sender,
      device: entry.device,
      message: entry.message,
      destination: entry.destination || null,
      timestamp: entry.ts,
    };
  }
  if (type === 'timer.snapshot') {
    return {
      type: 'timer.snapshot',
      event: entry.event || { kind: 'list' },
      timers: entry.timers || [],
      timestamp: entry.ts,
    };
  }
  if (type === 'alarm.snapshot') {
    return {
      type: 'alarm.snapshot',
      event: entry.event || { kind: 'list' },
      alarms: entry.alarms || [],
      timestamp: entry.ts,
    };
  }
  if (type === 'reminder.fired') {
    return {
      type: 'reminder.fired',
      reminder: { label: entry.label },
      event: entry.event,
      timestamp: entry.ts,
    };
  }
  return { ...entry, type };
}

function atMs(entry) {
  const parsed = Date.parse(entry?.ts || entry?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(hub, boardId, { now = () => Date.now(), wait = sleep } = {}) {
  const queue = hub.queueFor(boardId);
  if (!queue) {
    return;
  }
  const deadline = now() + 30_000;
  while (now() < deadline) {
    const pending = queue.pending?.() || [];
    const result = await queue.tick();
    if (!pending.length && result !== 'busy') {
      return;
    }
    await wait(25);
  }
}

/**
 * Replay log entries through an already-running hub. Returns a summary
 * the CLI (and tests) can assert on.
 */
async function replayEvents({
  entries = [],
  hub,
  boardId = 'sim',
  speed = 1,
  wait = sleep,
  log = console,
  now = () => Date.now(),
} = {}) {
  const results = [];
  let produced = 0;
  let accepted = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const payload = payloadFromLog(entry);
    const type = payload?.type || entry?.type || 'unknown';
    const formatter = formatterFor(type);

    if (i > 0 && speed > 0) {
      const gap = Math.max(0, atMs(entry) - atMs(entries[i - 1]));
      const delay = gap / speed;
      if (delay > 5) {
        await wait(Math.min(delay, 60_000));
      }
    }

    if (!formatter) {
      log.info?.(`[skip] ${type} — no board formatter`);
      results.push({ type, skipped: true, reason: 'no-formatter' });
      continue;
    }

    const outcome = hub.pushEvent(payload, {
      targetId: boardId,
      explicit: true,
    });
    const row = outcome?.boards?.[0];
    const frames = row?.accepted || 0;
    if (row?.reason === 'empty' || row?.skipped && row?.reason === 'empty') {
      log.info?.(`[empty] ${type}`);
      results.push({ type, skipped: true, reason: 'empty' });
      continue;
    }
    if (row?.reason === 'no-formatter') {
      log.info?.(`[skip] ${type} — no board formatter`);
      results.push({ type, skipped: true, reason: 'no-formatter' });
      continue;
    }

    produced += Math.max(1, frames);
    await drainQueue(hub, boardId, { now, wait });
    const posted = row?.reason === 'posted' || row?.accepted > 0;
    if (posted || row?.reason === 'queued') {
      accepted += 1;
      log.info?.(`[ok] ${type} — ${row?.reason || 'posted'}${frames ? ` (${frames} frame${frames === 1 ? '' : 's'})` : ''}`);
    } else {
      failed += 1;
      log.info?.(`[fail] ${type} — ${row?.reason || 'rejected'}`);
    }
    results.push({ type, skipped: false, reason: row?.reason, accepted: frames });
  }

  return { results, produced, accepted, failed };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: npm run board-replay -- [--file data/voice-events.jsonl] [--last 50]\n'
      + '                                [--types broadcast,timer.snapshot] [--speed 10]\n'
      + '                                [--board sim] [--rate-window 0]\n',
    );
    return 0;
  }

  const { loadConfig } = require('../config');
  const { createVestaboardSimulator } = require('./simulator');
  const { createVestaboardHub } = require('./index');

  const config = loadConfig();
  const file = path.resolve(args.file || config.voiceEventsLogPath);
  const all = readJsonl(file);
  const typed = args.types
    ? all.filter((entry) => args.types.includes(entry.type))
    : all;
  const slice = typed.slice(-args.last);

  if (!slice.length) {
    process.stderr.write(`No events to replay in ${file}\n`);
    return 1;
  }

  const log = {
    info: (message) => process.stdout.write(`${message}\n`),
    warn: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
    debug() {},
  };

  const dataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vb-replay-'));
  const replayConfig = {
    ROOT: dataDir,
    vestaboardSimulator: {
      ...(config.vestaboardSimulator || {}),
      port: 0,
      host: '127.0.0.1',
      rateWindowSeconds: args.rateWindowSeconds,
    },
  };

  const simulator = createVestaboardSimulator({ config: replayConfig, log });
  const hub = createVestaboardHub({ config: replayConfig, log, simulator });
  await simulator.start();
  await hub.start();

  try {
    hub.settings.upsert({
      id: args.board,
      quietHours: null,
      rateWindowSeconds: args.rateWindowSeconds,
    });
    const summary = await replayEvents({
      entries: slice,
      hub,
      boardId: args.board,
      speed: args.speed,
      log,
    });
    log.info(
      `Replayed ${slice.length} events: ${summary.accepted} posted, `
      + `${summary.failed} failed, ${summary.results.filter((row) => row.skipped).length} skipped`,
    );
    return summary.failed ? 1 : 0;
  } finally {
    hub.stop();
    await simulator.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  readJsonl,
  payloadFromLog,
  replayEvents,
  main,
};
