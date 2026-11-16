// The recording script answers --help with its usage, and refuses a call
// that names no .webm file to write. A whole recording is not made here: it
// starts the demo and plays a run, which the stills and the screens'
// checks already cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'view', 'record.mjs');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 });
const USAGE = 'usage: node three-party/view/record.mjs --out <file.webm>';

test('record.mjs --help prints its usage and exits 0', () => {
  const r = run('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), USAGE);
});

test('record.mjs with no --out, or with a file that is not .webm, exits 2 with its usage on stderr and records nothing', () => {
  for (const args of [[], ['--out', 'recording.mp4']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stderr.trim(), USAGE);
    assert.equal(r.stdout, '');
  }
});
