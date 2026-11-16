// The stills: the pair of the stopped step in the flow and the pair in the
// trace are in the stills directory, every still is named
// <scene>-<state>-<mode>-<scheme>-<width>.png (a still that names its view
// has it before the mode) and is as wide as its name says, and the script
// that takes them runs through the dev server with clicks and keys.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tempDir, removeTempDirs } from './support/view-helpers.mjs';
import { takeStills } from '../view/stills.mjs';

const STILLS = path.join(ROOT, 'stills');
// The scene and the state (a state may be two words, as in a replay that
// stands at a step), then the view where the still names it, the mode, the
// scheme and the width.
const NAME = /^(start|s\d)((?:-[a-z0-9]+){0,2}?)(?:-(sequence|trace|records))?-(story|inspect)-(light|dark)-(1280|1440|1920)\.png$/;
const HEIGHTS = { 1280: 800, 1440: 900, 1920: 1080 };
const PAIR = ['s2-stopped-inspect-light-1440.png', 's2-stopped-story-light-1440.png'];
const TRACE_PAIR = ['s2-stopped-trace-story-light-1440.png'];
// The three stills the repository's README shows.
const README = ['s1-paid-story-light-1440.png', 's2-stopped-story-light-1440.png', 's6-offline-inspect-light-1440.png'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sizeOf(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bytes.subarray(0, 8), PNG, `${file} is a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

after(() => removeTempDirs());

test('the stills directory holds the pair of the stopped step in the flow and the pair in the trace, and every still is named for its scene, state, view where it names one, mode, scheme and width and is that wide', () => {
  const files = fs.readdirSync(STILLS).sort();
  for (const name of [...PAIR, ...TRACE_PAIR, ...README]) assert.ok(files.includes(name), name);
  for (const name of files) {
    const m = NAME.exec(name);
    assert.ok(m, `${name} follows the naming convention`);
    assert.deepEqual(sizeOf(path.join(STILLS, name)), [Number(m[6]), HEIGHTS[m[6]]], name);
  }
  // The names the convention reads, and one it does not.
  for (const name of ['s2-stopped-trace-story-light-1440.png', 's2-stopped-finance-story-light-1440.png', 's6-offline-records-story-dark-1440.png', 's1-running-story-light-1440.png', 'start-story-light-1440.png', 'start-inspect-light-1280.png']) assert.ok(NAME.test(name), name);
  assert.equal(NAME.exec('s6-offline-records-story-dark-1440.png')[3], 'records');
  assert.equal(NAME.exec('s2-stopped-finance-story-light-1440.png')[2], '-stopped-finance', 'a lens other than the default is named after the state');
  assert.equal(NAME.exec('s2-stopped-trace-story-light-1440.png')[3], 'trace');
  assert.equal(NAME.exec('s2-stopped-story-light-1440.png')[3], undefined);
  assert.equal(NAME.test('s2-stopped-trace-light-1440.png'), false, 'a still names its mode');
});

test('the stills script takes the pair of the stopped step through the dev server, in Story and in Inspect', async () => {
  const out = tempDir('three-party-stills-');
  const written = await takeStills({ out, pair: true });
  assert.deepEqual(written.map((w) => path.basename(w.file)).sort(), PAIR);
  assert.deepEqual(fs.readdirSync(out).sort(), PAIR);
  for (const w of written) {
    assert.deepEqual(sizeOf(w.file), [1440, 900]);
    assert.equal(w.pixels, '1440x900');
    assert.equal(w.bytes, fs.statSync(w.file).size);
  }
  // The two modes are two different pictures of the same step.
  assert.notDeepEqual(fs.readFileSync(path.join(out, PAIR[0])), fs.readFileSync(path.join(out, PAIR[1])));
});

test('the stills script takes the pair of the stopped step in the trace through the dev server: in Story with the step\'s rows open, in Inspect with the row of the call that decided opened in the inspector', async () => {
  const out = tempDir('three-party-stills-');
  const written = await takeStills({ out, tracePair: true });
  assert.deepEqual(written.map((w) => path.basename(w.file)), [...TRACE_PAIR].reverse(), 'Story, then Inspect');
  assert.deepEqual(fs.readdirSync(out).sort(), TRACE_PAIR);
  for (const w of written) {
    assert.deepEqual(sizeOf(w.file), [1440, 900]);
    assert.equal(w.pixels, '1440x900');
    assert.ok(w.pageWidth <= w.windowWidth, 'the page fits its window');
  }
  assert.notDeepEqual(fs.readFileSync(path.join(out, TRACE_PAIR[0])), fs.readFileSync(path.join(out, TRACE_PAIR[1])));
});
