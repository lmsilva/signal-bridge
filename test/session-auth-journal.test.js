const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSessionAuthJournal,
  readLastLines,
} = require('../src/session-auth-journal');

describe('session-auth-journal', () => {
  let dir;
  let journalPath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-journal-'));
    journalPath = path.join(dir, 'session-auth-journal.jsonl');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readLastLines returns the end of a large file without reading it all', () => {
    const lines = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(JSON.stringify({ i, pad: 'x'.repeat(80) }));
    }
    fs.writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8');
    const size = fs.statSync(journalPath).size;
    assert.ok(size > 100_000);

    const last = readLastLines(journalPath, 5, { chunkBytes: 8 * 1024 });
    assert.equal(last.length, 5);
    assert.deepEqual(JSON.parse(last[4]), JSON.parse(lines[4999]));
    assert.deepEqual(JSON.parse(last[0]), JSON.parse(lines[4995]));
  });

  it('readRecent and getSummary use the in-memory ring, not a full-file scan', () => {
    fs.writeFileSync(journalPath, '', 'utf8');
    // Pre-seed a bulky file so a naive full read would be expensive / wrong.
    const bulky = [];
    for (let i = 0; i < 2000; i += 1) {
      bulky.push(JSON.stringify({ type: 'old', i, level: 'info', message: 'pad'.repeat(40) }));
    }
    fs.writeFileSync(journalPath, `${bulky.join('\n')}\n`, 'utf8');

    const journal = createSessionAuthJournal({
      config: { sessionPath: path.join(dir, 'alexa-session.json'), sessionAuthJournalPath: journalPath },
      log: { info() {}, warn() {}, error() {} },
      recentCap: 12,
      maxFileBytes: 50 * 1024,
      maxKeepLines: 40,
    });

    journal.recordSuccess({ type: 'auth_ping_ok', source: 'test', message: 'ok-1' });
    journal.recordFailure({
      type: 'auth_ping_invalid',
      source: 'test',
      reason: 'unauthorized',
      message: '401 unauthorized',
    });
    journal.recordSuccess({ type: 'auth_ping_ok', source: 'test', message: 'ok-2' });

    const recent = journal.readRecent(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[2].message, 'ok-2');
    assert.equal(recent[1].type, 'auth_ping_invalid');

    const summary = journal.getSummary();
    assert.equal(summary.path, journalPath);
    assert.equal(summary.lastEvent.message, 'ok-2');
    assert.ok(summary.recentFailureCount >= 1);
    assert.equal(summary.lastFailure.type, 'auth_ping_invalid');

    // Rotate should have trimmed the oversized seed file.
    const afterSize = fs.statSync(journalPath).size;
    assert.ok(afterSize < 80 * 1024, `expected rotation, size=${afterSize}`);
  });

  it('seeds recent events from an existing tail on create', () => {
    const seedPath = path.join(dir, 'seed-journal.jsonl');
    const rows = [
      { type: 'a', level: 'info', message: 'one' },
      { type: 'b', level: 'warn', message: 'two' },
      { type: 'c', level: 'info', message: 'three' },
    ];
    fs.writeFileSync(seedPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const journal = createSessionAuthJournal({
      config: { sessionPath: path.join(dir, 'alexa-session.json'), sessionAuthJournalPath: seedPath },
      log: { info() {}, warn() {}, error() {} },
      recentCap: 10,
    });

    const recent = journal.readRecent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[1].message, 'two');
    assert.equal(journal.getSummary().lastEvent.message, 'three');
  });
});
