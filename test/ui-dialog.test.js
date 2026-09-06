/**
 * Shared in-app confirm/prompt dialogs (never window.confirm / prompt).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('ui-dialog.js exports SignalUiDialog.confirm and .prompt', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/web/ui-dialog.js'), 'utf8');
  const sandbox = { globalThis: {} };
  sandbox.window = sandbox.globalThis;
  sandbox.document = {
    getElementById() { return null; },
    createElement() {
      return {
        style: {},
        classList: { toggle() {} },
        setAttribute() {},
        appendChild() {},
        querySelector() { return { classList: { toggle() {} }, focus() {}, select() {} }; },
      };
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.requestAnimationFrame = () => {};
  vm.runInNewContext(code, sandbox, { filename: 'ui-dialog.js' });
  assert.equal(typeof sandbox.globalThis.SignalUiDialog.confirm, 'function');
  assert.equal(typeof sandbox.globalThis.SignalUiDialog.prompt, 'function');
});

test('admin and user portals load ui-dialog ahead of week-grid', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../src/web/admin/index.html'), 'utf8');
  const user = fs.readFileSync(path.join(__dirname, '../src/web/user/index.html'), 'utf8');
  for (const html of [admin, user]) {
    const dialog = html.indexOf('ui-dialog.js');
    const grid = html.indexOf('week-grid.js');
    assert.ok(dialog >= 0 && grid > dialog, 'ui-dialog.js must load before week-grid.js');
  }
  assert.match(admin, /ui-dialog\.js\?v=signal307/);
  assert.match(user, /ui-dialog\.js\?v=signal308/);
});

test('product UI must not call window.confirm or window.prompt', () => {
  const files = [
    'src/web/week-grid.js',
    'src/web/scheduler-ui.js',
    'src/web/admin/app.js',
    'src/web/user/app.js',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(/window\.confirm\s*\(/.test(text), false, rel + ' still calls window.confirm');
    assert.equal(/window\.prompt\s*\(/.test(text), false, rel + ' still calls window.prompt');
  }
});

test('schedule type and target buttons use short labels with title tooltips', () => {
  for (const rel of ['src/web/admin/index.html', 'src/web/user/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(html, /data-sched-type="cadence"[^>]*title="[^"]+"[^>]*>At a cadence</);
    assert.match(html, /data-sched-type="fixed"[^>]*title="[^"]+"[^>]*>At a fixed time</);
    assert.match(html, /data-sched-target="specific"[^>]*title="[^"]+"[^>]*>Specific</);
    assert.ok(!html.includes('Cadence — roughly every N minutes'));
    assert.ok(!html.includes('Specific display'));
    assert.match(html, /sched-fixed-head-copy/);
    assert.match(html, /Right-click a cell to override its minute/);
  }
});