#!/usr/bin/env node
/**
 * Rewrite any UTF-16LE source file as UTF-8.
 *
 * Some editors on this repo's SMB share create new files as UTF-16 without a
 * BOM, which Node then refuses to parse. Run this after adding files.
 */

const fs = require('fs');
const path = require('path');

const SKIP = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.venv']);
const EXTENSIONS = /\.(js|json|css|html|md|txt|py|yml|yaml)$/i;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

function isUtf16(buffer) {
  // No BOM to go on, so look for the tell: an ASCII byte followed by a null.
  return buffer.length > 1 && buffer[0] !== 0 && buffer[1] === 0;
}

const roots = process.argv.slice(2);
const targets = roots.length ? roots : ['src', 'test', 'tools'];
let fixed = 0;
for (const root of targets) {
  if (!fs.existsSync(root)) continue;
  const files = fs.statSync(root).isDirectory() ? walk(root) : [root];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    if (!isUtf16(buffer)) continue;
    fs.writeFileSync(file, Buffer.from(buffer.toString('utf16le'), 'utf8'));
    console.log('utf-8', file);
    fixed += 1;
  }
}
console.log(`${fixed} file(s) rewritten`);
