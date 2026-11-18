// Milestone 4: the slice run's artifacts mapped onto the repository's
// EXISTING AEP format and verifier (three-party/src/record + verifier), used
// unextended. An intact clean run and an intact denied (poisoned) run both
// verify offline (exit 0: every record passes steps 1 to 6, the one tampered
// copy is rejected); tampering with a protected record or removing one fails
// (exit 4); a missing pin or manifest is an error (exit 1), never a pass.
// The run directory holds no private key; the WIMSE private keys lived
// outside it and are deleted with the run. The wire's original signatures
// are never stored — only their hashes — while the AEP records are the
// collector-signed observations and the bank's wimse journal stays an
// unsigned, labeled log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSliceLocal } from '../src/maurice/run-slice.mjs';
import { offlineCheck, findPrivateKeys } from '../src/record/check.mjs';
import { pinFileOf } from '../src/engine/records.mjs';

const freshRuns = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maurice-aep-')));
const rm = (dir) => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${dir}.wimse`, { recursive: true, force: true }); fs.rmSync(`${dir}.pins`, { recursive: true, force: true }); };

test('a clean slice run packages its evidence and verifies offline: records pass steps 1 to 6, the tampered copy is rejected', async () => {
  const runsDir = freshRuns();
  try {
    const result = await runSliceLocal({ kind: 'clean', runsDir, runId: 'aep-clean' });
    assert.equal(result.execution.state, 'settled');
    assert.equal(result.ledger.length, 1);

    // the package exists in the run dir, with the manifest written last
    const runDir = result.runDir;
    assert.ok(fs.existsSync(path.join(runDir, 'records', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'offline-check.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'records', 'manifest.json'), 'utf8'));
    assert.equal(manifest.runId, 'aep-clean');
    assert.ok(manifest.records.length >= 3, 'propose, execute and settlement at least');
    assert.equal(manifest.tampered.length, 1);
    assert.ok(manifest.records.every((r) => fs.existsSync(path.join(runDir, r.file))));
    assert.ok(fs.existsSync(path.join(runDir, manifest.tampered[0].file)));

    // the offline check ran inside the slice and passed
    assert.ok(result.aep, 'the run packaged its evidence');
    assert.equal(result.aep.check.exitCode, 0, JSON.stringify(result.aep.check.notes));
    assert.equal(result.aep.check.summary.pass, manifest.records.length);
    assert.equal(result.aep.check.summary.reject, 1);
    assert.equal(result.aep.check.summary.expectedRejects, 1);
    assert.equal(result.aep.check.wroteResult, true);
    // trust anchors supplied to the offline check, recorded in its result
    assert.match(result.aep.check.verifierSha256, /^[0-9a-f]{64}$/);
    assert.match(result.aep.check.pinSha256, /^[0-9a-f]{64}$/);
    assert.ok(result.evidencePin && fs.existsSync(result.evidencePin), 'the pin is held outside the run dir');
    assert.ok(!result.evidencePin.startsWith(runDir + path.sep));

    // the records link task, proposal, decision and bank outcome
    const actionsDir = path.join(runDir, 'actions');
    const names = fs.readdirSync(actionsDir).filter((f) => f.endsWith('.action.json'));
    const read = (n) => JSON.parse(fs.readFileSync(path.join(actionsDir, n), 'utf8'));
    const propose = read(names.find((n) => n.includes('-propose')));
    assert.equal(propose.taskId ?? propose.artifacts?.taskId ?? JSON.parse(fs.readFileSync(path.join(actionsDir, propose.response.bodyFile), 'utf8')).taskId, 'po-DEMO-INV-2201');
    const proposeBody = JSON.parse(fs.readFileSync(path.join(actionsDir, propose.response.bodyFile), 'utf8'));
    assert.match(proposeBody.proposalSha256, /^[0-9a-f]{64}$/);
    assert.equal(propose.decision, 'allow');
    const settle = read(names.find((n) => n.includes('-settlement')));
    assert.equal(settle.domainTo, 'bank.example.test');
    const settleBody = JSON.parse(fs.readFileSync(path.join(actionsDir, settle.response.bodyFile), 'utf8'));
    assert.equal(settleBody.ledgerRows, 1);
    assert.equal(settleBody.paymentId, result.execution.paymentId);
    const wimseGate = names.find((n) => n.includes('-wimse-gate'));
    assert.ok(wimseGate, 'the wimse-gate action records the bank decision');
    const wimseBody = JSON.parse(fs.readFileSync(path.join(actionsDir, read(wimseGate).response.bodyFile), 'utf8'));
    assert.match(wimseBody.note, /unsigned bank decision log/);
    assert.ok(wimseBody.entries.every((e) => e.wit_sha256 && !JSON.stringify(e).includes('eyJ')));

    // the run dir holds no private key; the WIMSE keys lived outside and are gone
    const look = findPrivateKeys(runDir);
    assert.deepEqual(look.found, [], JSON.stringify(look.found));
    assert.deepEqual(look.unread, [], JSON.stringify(look.unread));
    assert.ok(!fs.existsSync(path.join(`${runsDir}.wimse`, 'aep-clean')), 'the run\'s WIMSE private key directory is deleted with the run');
    const jwks = JSON.parse(fs.readFileSync(path.join(runDir, 'identity', 'jwks.json'), 'utf8'));
    assert.ok(!('d' in jwks.keys[0]));

    // the bank's wimse journal stays an unsigned, labeled log
    const journal = fs.readFileSync(path.join(runDir, 'bank', 'wimse-decisions.jsonl'), 'utf8');
    assert.match(journal, /unsigned decision log, not signed evidence/);
  } finally {
    rm(runsDir);
  }
});

test('a denied (poisoned) slice run packages and verifies offline too: the denials are signed into the records', async () => {
  const runsDir = freshRuns();
  try {
    const result = await runSliceLocal({ kind: 'poisoned', runsDir, runId: 'aep-poisoned' });
    assert.equal(result.execution.state, 'denied');
    assert.equal(result.ledger.length, 0);
    assert.ok(result.aep);
    assert.equal(result.aep.check.exitCode, 0, JSON.stringify(result.aep.check.notes));
    const manifest = JSON.parse(fs.readFileSync(path.join(result.runDir, 'records', 'manifest.json'), 'utf8'));
    assert.equal(result.aep.check.summary.pass, manifest.records.length);
    assert.equal(result.aep.check.summary.reject, 1);
    const names = fs.readdirSync(path.join(result.runDir, 'actions')).filter((f) => f.endsWith('.action.json'));
    const read = (n) => JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', n), 'utf8'));
    const secret = read(names.find((n) => n.includes('-secret-read')));
    assert.equal(secret.decision, 'deny');
    const secretBody = JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', secret.response.bodyFile), 'utf8'));
    assert.equal(secretBody.artifacts?.name ?? secretBody.name, 'bank-api-key');
    assert.ok(!JSON.stringify(secretBody).includes('"resolved":true'), 'the refusal is recorded, never a resolved value');
    const exec = read(names.find((n) => n.includes('-execute')));
    assert.equal(exec.decision, 'deny');
    const settle = read(names.find((n) => n.includes('-settlement')));
    assert.equal(settle.decision, 'deny');
    const settleBody = JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', settle.response.bodyFile), 'utf8'));
    assert.equal(settleBody.ledgerRows, 0);
    // no signed payment reached the bank: the wimse-gate record says the
    // bank's unsigned log has zero entries for this run
    const gate = read(names.find((n) => n.includes('-wimse-gate')));
    assert.equal(gate.decision, 'deny');
    assert.equal(gate.reason, 'no-wimse-decisions');
    const gateBody = JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', gate.response.bodyFile), 'utf8'));
    assert.deepEqual(gateBody.entries, []);
  } finally {
    rm(runsDir);
  }
});

test('tampering with a protected record fails the offline check (exit 4)', async () => {
  const runsDir = freshRuns();
  try {
    const result = await runSliceLocal({ kind: 'clean', runsDir, runId: 'aep-tamper' });
    const runDir = result.runDir;
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'records', 'manifest.json'), 'utf8'));
    const first = path.join(runDir, manifest.records[0].file);
    const original = fs.readFileSync(first);

    // flip one byte of the record's package bytes
    const flipped = Buffer.from(original);
    flipped[0] ^= 0x01;
    fs.writeFileSync(first, flipped);
    const tampered = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
    assert.equal(tampered.exitCode, 4, JSON.stringify(tampered.notes));
    assert.ok(tampered.notes.some((n) => n.includes('did not pass steps 1 to 6') || n.includes('differs')), JSON.stringify(tampered.notes));
    fs.writeFileSync(first, original);

    // and the check passes again once restored
    const restored = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
    assert.equal(restored.exitCode, 0, JSON.stringify(restored.notes));
  } finally {
    rm(runsDir);
  }
});

test('removing a manifest-named record, or checking without the pin, is an error (exit 1), never a pass', async () => {
  const runsDir = freshRuns();
  try {
    const result = await runSliceLocal({ kind: 'clean', runsDir, runId: 'aep-missing' });
    const runDir = result.runDir;
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'records', 'manifest.json'), 'utf8'));
    const victim = path.join(runDir, manifest.records[0].file);
    const saved = fs.readFileSync(victim);
    fs.rmSync(victim);
    const missing = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
    assert.equal(missing.exitCode, 4, JSON.stringify(missing.notes)); // manifest names a file not on disk
    fs.writeFileSync(victim, saved);

    // no pin: incomplete, reported as an error, not a pass
    const noPin = await offlineCheck(runDir, { pinFile: path.join(runsDir, 'no-such-pin.pem') });
    assert.equal(noPin.exitCode, 1);
    assert.equal(noPin.result, null);

    // no manifest at all: not a packaged run, an error
    fs.renameSync(path.join(runDir, 'records', 'manifest.json'), path.join(runDir, 'records', 'manifest.json.bak'));
    const noManifest = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
    assert.equal(noManifest.exitCode, 1);
    assert.equal(noManifest.result, null);
  } finally {
    rm(runsDir);
  }
});
