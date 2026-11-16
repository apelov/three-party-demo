// The crossing step with the AI2II capture: when the three files are in the
// folder and match their pins, the step runs the capture check, its action's
// response is the check's own result and the step keeps the supplied variant
// of the label map; when they are not there, or are there and differ from
// their pins, it runs the delegation chain check as before, and in the
// second case says why. The folder and the pins are injected here, with a
// synthetic capture made in the test.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToEnd, startRun } from '../src/engine/run.mjs';
import { stepLine } from '../src/engine/text.mjs';
import { captureFiles, sha256Hex, sourceFor, writeCapture } from './support/capture-fixture.mjs';
import { example, readJson, removeDir, tempRunsDir, walkFiles } from './support/engine-helpers.mjs';
import { labelMap } from './support/label-map-check.mjs';

const runsDir = tempRunsDir();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-ai2ii-run-')));
after(() => {
  removeDir(runsDir);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const STEP_KEYS = ['id', 'part', 'partLabel', 'standIn', 'standInNote', 'title', 'status', 'startedAt', 'endedAt', 'detail', 'actionFile', 'recordFile', 'variant'];
const at = new Date('2026-11-15T12:00:41Z');
const stepOf = (state, id) => state.steps.find((s) => s.id === id);
const statuses = (state) => Object.fromEntries(state.steps.map((s) => [s.id, s.status]));
let n = 0;
const folder = (made, { source = sourceFor(made.bytes), change = null } = {}) => {
  n += 1;
  const dir = writeCapture(path.join(scratch, `capture-${n}`), made.bytes, source);
  if (change) fs.writeFileSync(path.join(dir, change.name), change.bytes);
  return { ai2iiDir: dir, ai2iiSource: source };
};

const made = captureFiles();
let supplied;

test('with the capture there and pinned, the crossing runs the capture check: the step keeps the supplied variant, no hop file is written, and the action response is the check\'s result', async () => {
  supplied = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, ...folder(made) });
  assert.equal(supplied.error, null);
  const { state, runDir } = supplied;
  assert.deepEqual(readJson(path.join(runDir, 'state.json')), state);
  assert.equal(state.outcome, 'paid');
  for (const s of state.steps) assert.deepEqual(Object.keys(s), STEP_KEYS, s.id);
  assert.deepEqual(state.steps.map((s) => s.variant), [null, null, 'supplied', null, null, null]);
  const crossing = stepOf(state, 'crossing');
  const map = labelMap();
  assert.deepEqual({ partLabel: crossing.partLabel, standIn: crossing.standIn, standInNote: crossing.standInNote }, {
    partLabel: map.parts.crossing.variants.supplied.label, standIn: false, standInNote: null,
  });
  assert.equal(crossing.status, 'passed');
  const d = crossing.detail;
  assert.deepEqual(Object.keys(d).slice(0, 8), Object.keys(stepOf(example('state-clean-done.json'), 'crossing').detail), 'the members of the contract first');
  assert.deepEqual({ from: d.from, to: d.to, chainFile: d.chainFile, hops: d.hops, outcome: d.outcome, standIn: d.standIn, hopFile: d.hopFile }, {
    from: 'payments.acme-demo.test', to: 'bank.example.test', chainFile: null, hops: null, outcome: 'verified', standIn: null, hopFile: null,
  });
  assert.equal(d.stepsRun, '7 checks of the AI2II capture check: capture, witSignature, contentDigest, httpSignature, signatureCreated, response, journal');
  assert.equal(d.capture.used, true);
  assert.deepEqual(d.capture.checks.map((c) => c.answer), Array(7).fill('pass'));
  assert.equal(fs.existsSync(path.join(runDir, 'hops', '03-crossing.hop.json')), false);
  const action = readJson(path.join(runDir, crossing.actionFile));
  assert.equal(action.decision, 'observed');
  assert.equal(action.reason, 'the AI2II capture check passed 7 of 7 checks on a capture of a separate exchange published at commit 01234567; it permits no action of this run');
  const response = fs.readFileSync(path.join(runDir, 'actions', action.response.bodyFile));
  assert.equal(action.response.bodySha256, sha256Hex(response));
  const { used, ...result } = d.capture;
  assert.deepEqual(JSON.parse(response.toString('utf8')), result, 'the response is the check\'s own result');
  assert.deepEqual(result.files.map((f) => f.sha256), [sha256Hex(made.bytes.capture), sha256Hex(made.bytes.journal), sha256Hex(made.bytes.keys)]);
  // Text mode: no stand-in mark and no note on the line of the supplied crossing.
  assert.equal(stepLine(crossing, state, at), "[120041] WIMSE · AI2II | Cross into the supplier's bank's trust domain | Passed | Payments agent to Supplier's bank; AI2II capture of a separate exchange, commit 01234567: 7 of 7 checks passed");
});

test('the record writer packs the capture check\'s result as the crossing record\'s response, and no file of the run holds the token, its signature, the HTTP message signature or the Txn-Token value', () => {
  const { runDir, state } = supplied;
  const crossing = stepOf(state, 'crossing');
  assert.equal(crossing.recordFile, 'records/03-crossing.aep');
  const response = fs.readFileSync(path.join(runDir, 'actions', '03-crossing.response.txt'));
  assert.ok(fs.readFileSync(path.join(runDir, crossing.recordFile)).includes(response), 'the package holds the response bytes (a store-method archive)');
  const files = [...walkFiles(runDir).map((f) => path.join(runDir, f)), ...walkFiles(`${runsDir}.pins`).map((f) => path.join(`${runsDir}.pins`, f))];
  assert.ok(files.length >= 14, `${files.length} files read`);
  const secrets = { token: made.wit, tokenSignature: made.witSignature, signature: made.signature.toString('base64'), signatureHex: made.signature.toString('hex'), txnToken: made.txnToken };
  for (const [name, value] of Object.entries(secrets)) {
    const hits = files.filter((file) => fs.readFileSync(file).includes(Buffer.from(value, 'utf8')));
    assert.deepEqual(hits, [], `files that hold the ${name} value`);
    assert.equal(JSON.stringify(state).includes(value), false, name);
  }
  // What stands in their place: the token's claims and SHA-256.
  assert.deepEqual(crossing.detail.capture.token.claims, made.claims);
  assert.equal(crossing.detail.capture.token.sha256, sha256Hex(Buffer.from(made.wit)));
});

test('the variant is set when the run starts: a crossing still pending carries the supplied label fields when the capture is there', async () => {
  const run = await startRun({ kind: 'clean', paceSeconds: 5, runsDir, recordWriter: null, sleep: () => new Promise(() => {}), ...folder(made) });
  try {
    const crossing = stepOf(run.state(), 'crossing');
    assert.deepEqual({ status: crossing.status, variant: crossing.variant, standIn: crossing.standIn, standInNote: crossing.standInNote }, { status: 'pending', variant: 'supplied', standIn: false, standInNote: null });
  } finally {
    await run.abort();
  }
});

test('with no capture, the crossing runs the delegation chain check as before: the fallback variant, the stand-in note and the note on the AI2II capture', async () => {
  const { state, runDir, error } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriter: null, ai2iiDir: path.join(scratch, 'no-capture-here') });
  assert.equal(error, null);
  const crossing = stepOf(state, 'crossing');
  const map = labelMap();
  assert.deepEqual({ variant: crossing.variant, standIn: crossing.standIn, standInNote: crossing.standInNote }, { variant: 'fallback', standIn: true, standInNote: map.parts.crossing.standInNote });
  assert.deepEqual(crossing.detail, stepOf(example('state-clean-done.json'), 'crossing').detail, 'the detail of the contract example, member for member');
  assert.ok(fs.existsSync(path.join(runDir, 'hops', '03-crossing.hop.json')));
  const fallback = map.parts.crossing.variants.fallback;
  assert.equal(stepLine(crossing, state, at), `[120041] WIMSE · AI2II (stand-in) | Cross into the supplier's bank's trust domain | Passed | Payments agent to Supplier's bank; chain of 2 hops: valid. ${fallback.standInNote} ${fallback.missingNote}`);
  assert.ok(fallback.missingNote.includes('three-party/external/ai2ii') && fallback.missingNote.includes('git checkout -- three-party/external/ai2ii'), fallback.missingNote);
  assert.ok(!/fetch/i.test(JSON.stringify(map.parts.crossing)), 'nothing about the crossing tells anyone to fetch the capture');
});

test('with the files there and one of them not matching its pin, the capture is not used: the crossing falls back and names the file and both digests', async () => {
  const changed = Buffer.from(made.bytes.keys.toString('utf8').replace('test-receiver-1', 'test-receiver-2'));
  const { state, error } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriter: null, ...folder(made, { change: { name: 'jwks.json', bytes: changed } }) });
  assert.equal(error, null);
  assert.equal(state.outcome, 'paid');
  const crossing = stepOf(state, 'crossing');
  assert.deepEqual({ variant: crossing.variant, standIn: crossing.standIn, outcome: crossing.detail.outcome }, { variant: 'fallback', standIn: true, outcome: 'valid' });
  const reason = `AI2II capture not used: jwks.json does not match its pin (size ${changed.length}, sha256 ${sha256Hex(changed)}; pinned size ${made.bytes.keys.length}, sha256 ${sha256Hex(made.bytes.keys)})`;
  assert.deepEqual({ used: crossing.detail.capture.used, why: crossing.detail.capture.why, reason: crossing.detail.capture.reason }, { used: false, why: 'mismatch', reason });
  assert.ok(stepLine(crossing, state, at).includes(`| Passed | Payments agent to Supplier's bank; chain of 2 hops: valid; ${reason}. Stand-in: `), stepLine(crossing, state, at));
});

test('a pinned capture that fails a check stops the crossing by name: the run ends there and sends no payment', async () => {
  const wrong = captureFiles({ wrongKey: true });
  const { state, error } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriter: null, ...folder(wrong) });
  assert.equal(error, null);
  assert.deepEqual(statuses(state), { credential: 'passed', grant: 'passed', crossing: 'blocked', intent: 'not-reached', pay: 'not-reached', record: 'pending' });
  assert.equal(state.blockedAt, 'crossing');
  assert.equal(state.reason, "The credential and the grant were valid, but the crossing into the supplier's bank's trust domain did not check out (crossing-capture-not-verified), so no payment was sent.");
  const crossing = stepOf(state, 'crossing');
  assert.equal(crossing.variant, 'supplied');
  assert.equal(crossing.detail.refusal, 'crossing-capture-not-verified');
  assert.equal(crossing.detail.capture.checks.find((c) => c.name === 'witSignature').answer, 'fail');
  assert.equal(stepLine(crossing, state, at), "[120041] WIMSE · AI2II | Cross into the supplier's bank's trust domain | Stopped | Payments agent to Supplier's bank; AI2II capture of a separate exchange, commit 01234567: 6 of 7 checks passed; not passed: witSignature; crossing-capture-not-verified");
});
