// The label map in the engine: each step of a run carries the label and the
// stand-in note of its part as three-party/labels.json has them, the parties
// of the state are the map's, text mode prints them and names no company,
// DID or domain of the fixtures, and the run API answers GET /api/labels with
// the map.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCapture } from '../src/engine/ai2ii-source.mjs';
import { startApi } from '../src/engine/api.mjs';
import { LABEL_MAP, labelMapWith, partFields, partOfStep, timestampNote } from '../src/engine/label-map.mjs';
import { runToEnd } from '../src/engine/run.mjs';
import { VIEW_DIR } from '../src/engine/screens.mjs';
import { partCell, stepLine, stepNotes } from '../src/engine/text.mjs';
import { REPO_ROOT, THREE_PARTY, example, readJson, removeDir, request, runStart, tempRunsDir } from './support/engine-helpers.mjs';
import { LABEL_MAP_FILE, assertLabelMapAnswer, labelMap } from './support/label-map-check.mjs';

const runsDir = tempRunsDir();
after(() => removeDir(runsDir));

// The strings of the fixtures no screen and no line of text mode may show:
// the five the brief names, and the values the fixtures themselves carry.
const FIXTURE_WORDS = ['Northwind', 'Lakeside', 'acme', 'Example Bank', 'example.test'];
function fixtureIdentifiers(states) {
  const invoices = readJson(path.join(THREE_PARTY, 'fixtures', 'invoices.json'));
  const names = new Set(FIXTURE_WORDS);
  for (const payee of invoices.consent.addedCreditorAccounts) names.add(payee.name);
  for (const invoice of Object.values(invoices.invoices)) {
    names.add(invoice.from);
    names.add(invoice.payTo.name);
  }
  for (const state of states) {
    names.add(state.agent.did);
    names.add(state.agent.domain);
    const credential = state.steps.find((s) => s.id === 'credential').detail;
    const crossing = state.steps.find((s) => s.id === 'crossing').detail;
    if (credential?.issuer) names.add(credential.issuer);
    if (crossing) {
      names.add(crossing.from);
      names.add(crossing.to);
    }
  }
  return [...names];
}

// What a step must carry, written out here from the map's own words.
const EXPECTED = {
  credential: { part: 'checkpoint', partLabel: 'OpenA2A · ATX · AAP', standIn: false, standInNote: null },
  grant: { part: 'checkpoint', partLabel: 'OpenA2A · ATX · AAP', standIn: false, standInNote: null },
  crossing: { part: 'crossing', partLabel: 'WIMSE · AI2II', standIn: true, standInNote: 'Stand-in: an OpenA2A check of a delegation chain fixture runs here in place of the AI2II capture.' },
  intent: { part: 'checkpoint', partLabel: 'OpenA2A · ATX · AAP', standIn: false, standInNote: null },
  pay: { part: 'bank', partLabel: "Supplier's bank", standIn: false, standInNote: null },
  record: { part: 'record', partLabel: 'AEP', standIn: false, standInNote: null },
};

test('the map the engine holds is three-party/labels.json, read once and frozen', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LABEL_MAP)), labelMap());
  assert.ok(Object.isFrozen(LABEL_MAP) && Object.isFrozen(LABEL_MAP.parts.crossing) && Object.isFrozen(LABEL_MAP.parts.crossing.steps) && Object.isFrozen(LABEL_MAP.scenes[0]));
  assert.throws(() => { LABEL_MAP.parts.record.label = 'changed'; }, TypeError);
  assert.equal(LABEL_MAP.parts.record.label, 'AEP');
});

test('a step takes its part from the part of the map whose steps list holds it: the checkpoint keeps the id of revision 1, the pay steps are the bank\'s', () => {
  for (const [id, want] of Object.entries(EXPECTED)) assert.deepEqual(partFields(id), want, id);
  // The steps of the later scenes are placed by the same lists.
  assert.deepEqual(partFields('grant-again'), EXPECTED.grant);
  assert.deepEqual(partFields('pay-again'), EXPECTED.pay);
  assert.equal(partOfStep('received').name, 'crossing');
  assert.equal(partOfStep('credential').name, 'checkpoint');
  assert.throws(() => partOfStep('audit'), /no part of the label map holds the step audit/);
  // Every step id the map lists has one part.
  const listed = Object.values(labelMap().parts).flatMap((part) => part.steps);
  assert.equal(new Set(listed).size, listed.length);
  for (const id of listed) assert.ok(partFields(id).partLabel.length > 0, id);
});

let clean;
let poisoned;

test('a clean run and a poisoned run: every step of state.json carries the label, the stand-in flag and the note of its part, and the state carries the parties of the map', async () => {
  // No AI2II capture: the crossing is the fallback, the delegation chain check.
  const ai2iiDir = path.join(runsDir, 'no-ai2ii-capture');
  clean = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, ai2iiDir });
  poisoned = await runToEnd({ kind: 'poisoned', paceSeconds: 0, runsDir, ai2iiDir });
  assert.equal(clean.error, null);
  assert.equal(poisoned.error, null);
  const map = labelMap();
  for (const run of [clean, poisoned]) {
    const state = readJson(path.join(run.runDir, 'state.json'));
    assert.deepEqual(state, run.state);
    assert.deepEqual(state.steps.map((s) => s.id), Object.keys(EXPECTED));
    for (const step of state.steps) {
      const { part, partLabel, standIn, standInNote } = step;
      assert.deepEqual({ part, partLabel, standIn, standInNote }, EXPECTED[step.id], `${run.runId} ${step.id}`);
      const inMap = Object.values(map.parts).find((p) => p.steps.includes(step.id));
      assert.deepEqual({ partLabel, standIn, standInNote }, { partLabel: inMap.label, standIn: inMap.standIn, standInNote: inMap.standInNote });
    }
    assert.deepEqual(state.parties, map.parties, 'the parties by role, copied from the map');
    assert.deepEqual(Object.keys(state.parties), ['agent', 'bank', 'supplier', 'domainA', 'domainB', 'rawIdentifiersNote']);
    // The values the files of the run carry are the fixtures' own, as before.
    assert.equal(state.steps.find((s) => s.id === 'crossing').detail.standIn, 'Stand-in for the AI2II capture check, which runs here when its files in three-party/external/ai2ii are present');
    assert.equal(state.agent.domain, 'payments.acme-demo.test');
  }
});

test('text mode: a stand-in part is marked after its label, the line of a stand-in step that ran ends with the part\'s note, and the record line ends with the note on its timestamp entry', () => {
  const at = new Date('2026-11-15T12:00:41Z');
  const map = labelMap();
  for (const run of [clean, poisoned]) {
    const state = run.state;
    const lineOf = (id) => stepLine(state.steps.find((s) => s.id === id), state, at);
    const cells = Object.fromEntries(state.steps.map((s) => [s.id, partCell(s)]));
    assert.deepEqual(cells, {
      credential: 'OpenA2A · ATX · AAP', grant: 'OpenA2A · ATX · AAP', crossing: 'WIMSE · AI2II (stand-in)',
      intent: 'OpenA2A · ATX · AAP', pay: "Supplier's bank", record: 'AEP',
    });
    // The fallback crossing also says where the AI2II capture belongs and how to restore it.
    assert.ok(lineOf('crossing').endsWith(`chain of 2 hops: valid. ${map.parts.crossing.standInNote} ${map.parts.crossing.variants.fallback.missingNote}`), lineOf('crossing'));
    assert.ok(lineOf('crossing').includes(`| ${map.parties.agent} to ${map.parties.bank}; `), 'the two sides by role');
    assert.ok(lineOf('record').endsWith(`signer: test key generated for this run. ${map.timestamp.standInNote}`), lineOf('record'));
    // A step of a part that is not a stand-in ends with no note.
    for (const id of ['credential', 'grant', 'intent', 'pay']) assert.deepEqual(stepNotes(state.steps.find((s) => s.id === id)), [], id);
  }
  // A stand-in step that has not run, or that the engine or its caller
  // stopped, carries the mark and no note.
  const crossing = clean.state.steps.find((s) => s.id === 'crossing');
  for (const altered of [
    { ...crossing, status: 'pending', detail: null },
    { ...crossing, status: 'running', detail: null },
    { ...crossing, status: 'not-reached', detail: null },
    { ...crossing, status: 'blocked', detail: { refusal: 'run-stopped' } },
    { ...crossing, status: 'blocked', detail: { refusal: 'engine-error', error: 'the wait failed' } },
  ]) {
    assert.deepEqual(stepNotes(altered), [], altered.status);
    assert.ok(stepLine(altered, clean.state, at).startsWith('[120041] WIMSE · AI2II (stand-in) | '));
  }
  // A crossing its own check stopped says the note too.
  const refused = { ...crossing, status: 'blocked', detail: { ...crossing.detail, outcome: 'signature_invalid', refusal: 'crossing-chain-not-valid' } };
  assert.ok(stepLine(refused, clean.state, at).endsWith(`chain of 2 hops: signature_invalid; crossing-chain-not-valid. ${map.parts.crossing.standInNote} ${map.parts.crossing.variants.fallback.missingNote}`));
  // The note on the timestamp entry follows the entry.
  assert.equal(timestampNote('stand-in: no timestamp authority'), map.timestamp.standInNote);
  assert.equal(timestampNote('test timestamp authority made for this demo'), map.timestamp.testAuthorityNote);
  const record = clean.state.steps.find((s) => s.id === 'record');
  const stamped = { ...record, detail: { ...record.detail, timestampEntry: 'test timestamp authority made for this demo' } };
  assert.deepEqual(stepNotes(stamped), [map.timestamp.testAuthorityNote]);
});

// A line of text mode with the values of one run set aside: the time, the
// payment id, the run directory and the pace.
const settled = (line) => line
  .replace(/^\[[0-9]{6}\]/, '[hhmmss]')
  .replace(/led_[0-9a-f]{16}/g, 'led_<payment id>')
  .replace(/^Run directory: .*$/, 'Run directory: <run directory>')
  .replace(/at least [0-9.]+ seconds per step\.$/, 'at least <pace> seconds per step.');

let printed = null;

test('node three-party/bin/start.mjs --text prints, for both runs, the lines of the kept transcript, with the times, the payment id, the run directories and the pace set aside', async () => {
  const r = await runStart(['--text', '--run', 'both', '--pace', '0', '--runs-dir', path.join(runsDir, 'text')]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  printed = r.lines;
  // The command line runs with the default AI2II folder, which this repository
  // fills: the kept transcript of the capture check, or of the fallback in a
  // checkout that is missing a file of it.
  const capture = loadCapture();
  assert.notEqual(capture.why, 'mismatch', 'three-party/external/ai2ii holds files that differ from their pins: git checkout -- three-party/external/ai2ii restores them');
  const kept = fs.readFileSync(path.join(THREE_PARTY, 'test', 'fixtures', capture.use ? 'text-mode-both-ai2ii.txt' : 'text-mode-both.txt'), 'utf8');
  assert.ok(kept.endsWith('\n'));
  const keptLines = kept.slice(0, -1).split('\n');
  assert.equal(keptLines.length, 11 + 1 + 12, 'the clean run, an empty line, the poisoned run');
  assert.deepEqual(printed.map(settled), keptLines.map(settled));
  // The kept transcript was printed at the default pace, by a paid clean run
  // and a stopped poisoned run.
  assert.equal(keptLines[2], 'Times in UTC. Paced for viewing: at least 8 seconds per step.');
  assert.match(keptLines[9], /^\[[0-9]{6}\] Outcome \| Paid \| /);
  assert.match(keptLines[22], /^\[[0-9]{6}\] Outcome \| Stopped by the intent rule \| /);
});

test('no line of text mode names a company, a DID or a domain of the fixtures: the lines of both runs, and the lines built from the contract examples', () => {
  const exampleStates = ['state-clean-done.json', 'state-clean-running.json', 'state-poisoned-blocked.json'].map(example);
  const at = new Date('2026-11-15T12:00:41Z');
  const built = exampleStates.flatMap((state) => state.steps.map((s) => stepLine(s, state, at)));
  const names = fixtureIdentifiers([clean.state, poisoned.state, ...exampleStates]);
  assert.ok(names.length >= 12, `${names.length} identifiers looked for`);
  // The run directory line names a directory of this computer, not a party.
  const lines = [...printed.filter((l) => !l.startsWith('Run directory: ')), ...built];
  assert.equal(lines.length, 11 - 1 + 12 - 1 + 1 + 18, 'both runs less their directory lines, the empty line, and the eighteen example step lines');
  const hits = [];
  for (const line of lines) for (const name of names) if (line.includes(name)) hits.push(`${name} in: ${line}`);
  assert.deepEqual(hits, []);
  // The identifiers are in the states the lines were built from, so the
  // check had something to find: the examples carry each of the five words.
  const carried = JSON.stringify(exampleStates);
  for (const word of FIXTURE_WORDS.filter((w) => w !== 'Example Bank')) assert.ok(carried.includes(word), word);
});

test('GET /api/labels: with no screens the listener answers the bytes of three-party/labels.json; with the screens it adds their words and changes no value; any other method is refused', async () => {
  const bare = await startApi({ port: 0, runsDir, paceSeconds: 0 });
  try {
    const res = await request({ port: bare.port, path: '/api/labels' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(res.bytes.equals(fs.readFileSync(LABEL_MAP_FILE)), 'the file, byte for byte');
    assert.ok(assertLabelMapAnswer(res.json(), { withWords: false }) > 40);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await request({ port: bare.port, method, path: '/api/labels' });
      assert.equal(refused.status, 405, method);
    }
  } finally {
    await bare.stop();
  }
  const screens = await startApi({ port: 0, runsDir, paceSeconds: 0, viewDir: VIEW_DIR });
  try {
    const res = await request({ port: screens.port, path: '/api/labels' });
    assert.equal(res.status, 200);
    const answer = res.json();
    assert.ok(assertLabelMapAnswer(answer, { withWords: true }) > 60);
    // The words the screens add, by hand: the line under each part, the line
    // under the crossing, and each scene's title, line and availability.
    assert.equal(answer.parts.crossing.text, "Checks the request as it crosses from the agent's trust domain into the bank's.");
    assert.match(answer.parts.crossing.detail, /^The OpenA2A check covers steps 1 to 5 and 7 of /);
    assert.deepEqual(answer.scenes.map((s) => [s.id, s.kind, s.title, s.available]), [
      [1, 'clean', 'Normal payment', true], [2, 'poisoned', 'Poisoned invoice', true], [6, 'offline-check', 'Audit the records', true],
      [3, 'tampered', 'Tampered agent', false], [4, 'expired', 'Expired grant', false], [5, 'received', "Received by the supplier's bank", false],
    ]);
    // A scene the engine does not run yet is marked so: the kinds marked
    // available are the kinds POST /api/runs takes, and the offline check.
    for (const scene of answer.scenes.filter((s) => s.kind !== 'offline-check')) {
      const started = await request({ port: screens.port, method: 'POST', path: '/api/runs', body: { kind: scene.kind }, headers: { 'Content-Type': 'application/json' } });
      assert.equal(started.status === 200, scene.available, `${scene.kind}: answered ${started.status}`);
    }
    await screens.idle();
  } finally {
    await screens.stop();
  }
});

test('the screens\' words never replace a member of the map: a word given under a name the map has is left out', () => {
  const map = labelMap();
  const words = {
    parts: {
      checkpoint: { label: 'a label of the screens', standIn: true, standInNote: 'a note of the screens', steps: [], text: 'the line under the part' },
      crossing: { text: 'the line', detail: 'the second line', other: 'a member the answer does not carry' },
      absent: { text: 'a part the map does not have' },
    },
    scenes: [
      { id: 1, kind: 'another kind', button: 'a button of the screens', priority: 'none', title: 'the title', text: 'the line', available: false },
      { id: 99, title: 'a scene the map does not have' },
    ],
    parties: { agent: 'a role of the screens' },
    timestamp: { standInNote: 'a note of the screens' },
    revision: 'a revision of the screens',
    columns: ['agent'],
  };
  const answer = labelMapWith(words);
  assert.deepEqual(Object.keys(answer), Object.keys(map));
  assert.deepEqual(answer.parties, map.parties);
  assert.deepEqual(answer.timestamp, map.timestamp);
  assert.equal(answer.revision, map.revision);
  assert.deepEqual(answer.parts.checkpoint, { ...map.parts.checkpoint, text: 'the line under the part' });
  assert.deepEqual(answer.parts.crossing, { ...map.parts.crossing, text: 'the line', detail: 'the second line' });
  assert.deepEqual(Object.keys(answer.parts), Object.keys(map.parts));
  assert.deepEqual(answer.scenes[0], { ...map.scenes[0], title: 'the title', text: 'the line', available: false });
  assert.equal(answer.scenes.length, map.scenes.length);
  assert.deepEqual(answer.scenes[1], map.scenes[1], 'a scene the words do not name is the map\'s scene as it is');
  // With no words the answer is the map, and the map itself is not changed by an answer.
  assert.deepEqual(labelMapWith(null), map);
  answer.parts.record.label = 'changed in the answer';
  assert.equal(LABEL_MAP.parts.record.label, map.parts.record.label);
});

test('the engine\'s own word file holds no part label and no party role: its words for the parties are sentences, and the roles come from the map', async () => {
  const { LABELS } = await import('../src/engine/labels.mjs');
  assert.equal(Object.hasOwn(LABELS, 'parts'), false);
  assert.equal(Object.hasOwn(LABELS, 'parties'), false);
  assert.deepEqual(Object.keys(LABELS.text), ['standInPart', 'withNotes']);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'three-party', 'labels.json')), true);
});
