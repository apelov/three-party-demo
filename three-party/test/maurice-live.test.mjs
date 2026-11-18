// The live slice against a real Maurice One instance: the invoice-payment
// Workflow deployed on an isolated test Agent, the enforcement adapter
// installed as its only bank route, and the real workflow invoked twice with
// the same input. This test runs only when MAURICE_LIVE=1 and the maurice
// binary is on PATH; otherwise it skips and says so, and nothing here claims
// a live integration that did not run.
//
//   MAURICE_LIVE=1 node --test three-party/test/maurice-live.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSliceLive } from '../src/maurice/live.mjs';
import { tempRunsDir, removeDir, REPO_ROOT } from './support/engine-helpers.mjs';

const live = process.env.MAURICE_LIVE === '1';
const which = spawnSync('sh', ['-c', 'command -v maurice || ls ~/.local/bin/maurice'], { encoding: 'utf8' });
const mauriceBin = which.status === 0 ? which.stdout.trim().split('\n').pop() : null;
const canRun = live && Boolean(mauriceBin);

test('live Maurice: one clean invoice through a real deployed workflow settles exactly once, and the same key twice settles once', { skip: !canRun && 'set MAURICE_LIVE=1 with the maurice binary on PATH to run the live slice', timeout: 600000 }, async () => {
  const runsDir = tempRunsDir();
  let failed = false;
  try {
    const result = await runSliceLive({ mauriceBin, runsDir, deploymentName: `maurice-slice-test-${Date.now().toString(36)}` });
    const summary = JSON.parse(fs.readFileSync(path.join(result.runDir, 'summary.json'), 'utf8'));
    for (const step of summary.steps) assert.ok(step.ok, `step ${step.name}: ${JSON.stringify(step.detail)}`);

    // Both workflow executions completed.
    assert.equal(result.executions.length, 2);
    for (const ex of result.executions) assert.equal(ex.state, 'completed', JSON.stringify(ex));

    // Exactly one settlement in the mock bank's ledger.
    assert.equal(result.ledger.length, 1, `ledger: ${JSON.stringify(result.ledger)}`);
    assert.equal(result.ledger[0].payeeAccount, 'DEMO-0000-2201');
    assert.equal(result.ledger[0].amountCents, 14820);

    // The adapter's run state settled with the same payment id, and its
    // events correlate with the run.
    assert.equal(result.state.state, 'settled');
    assert.equal(result.state.paymentId, result.ledger[0].rowId);
    assert.ok(result.events.length >= 5);
    assert.ok(result.events.every((e) => e.runId === result.runId));
    assert.deepEqual(result.events.map((e) => e.sequence), result.events.map((_, i) => i + 1));
    assert.ok(result.events.some((e) => e.type === 'proposed'));
    assert.ok(result.events.some((e) => e.type === 'settled'));

    // The live WIMSE exchange: the adapter's payment POST carried a fresh WIT
    // + RFC 9421 signature (producer 'wimse-signer', hashes only), and the
    // bank's journal accepted it under the trusted issuer before the grant
    // check. The second call answered from the idempotency record, so exactly
    // one signed payment reached the bank.
    const signerEvents = result.events.filter((e) => e.producer === 'wimse-signer');
    assert.equal(signerEvents.length, 1, JSON.stringify(result.events.map((e) => [e.producer, e.type])));
    assert.equal(signerEvents[0].type, 'request-signed');
    assert.match(signerEvents[0].wimse.wit_sha256, /^[0-9a-f]{64}$/);
    assert.equal(signerEvents[0].wimse.iss, 'https://slice-issuer.example');
    assert.equal(signerEvents[0].wimse.sub, `wimse://slice.local/agent/${result.runId}`);
    assert.equal(result.wimseDecisions.length, 1);
    assert.equal(result.wimseDecisions[0].decision, 'accept');
    assert.equal(result.wimseDecisions[0].reason, 'wimse-verified');
    assert.equal(result.wimseDecisions[0].wit_sha256, signerEvents[0].wimse.wit_sha256);
    const bankRecord = JSON.parse(fs.readFileSync(path.join(result.runDir, 'bank', 'idempotency.json'), 'utf8'));
    const entry = Object.values(bankRecord)[0];
    assert.equal(entry.wimse.wit_sha256, signerEvents[0].wimse.wit_sha256);
    // no WIT token value in the slice's own evidence, and no private key
    // file anywhere in the run dir (the WIMSE keys live outside it and are
    // deleted with the run) — the Maurice CLI journals and the spec project
    // are not the slice's evidence
    const evidenceFiles = fs.readdirSync(result.runDir, { recursive: true })
      .filter((f) => {
        const s = String(f);
        return fs.statSync(path.join(result.runDir, s)).isFile() && !s.startsWith('maurice-') && !s.includes(`${path.sep}spec${path.sep}`) && !s.includes(`${path.sep}mcp${path.sep}`);
      });
    assert.ok(!evidenceFiles.some((f) => String(f).endsWith('.key.json')), 'no private key file in the run directory');
    const all = evidenceFiles.map((f) => fs.readFileSync(path.join(result.runDir, String(f)), 'utf8')).join('\n');
    const witToken = all.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    assert.equal(witToken, null, 'no WIT token value in the slice evidence');

    // Milestone 4: the run's evidence package verifies offline — intact
    // records pass steps 1 to 6, the tampered copy is rejected, and the
    // offline check wrote its result with the verifier and pin hashes.
    assert.ok(result.aep, 'the live run packaged its evidence');
    assert.equal(result.aep.check.exitCode, 0, JSON.stringify(result.aep.check.notes));
    assert.equal(result.aep.check.summary.pass, result.aep.records.length);
    assert.equal(result.aep.check.summary.reject, 1, 'the one tampered copy is rejected');
    assert.equal(result.aep.check.summary.expectedRejects, 1);
    assert.match(result.aep.check.verifierSha256, /^[0-9a-f]{64}$/);
    assert.match(result.aep.check.pinSha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(result.runDir, 'records', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'offline-check.json')));
    // the actions link task, proposal, decision and bank outcome
    const actionFiles = fs.readdirSync(path.join(result.runDir, 'actions')).filter((f) => f.endsWith('.action.json'));
    assert.ok(actionFiles.length >= 3, JSON.stringify(actionFiles));
    const settle = JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', actionFiles.find((f) => f.includes('-settlement'))), 'utf8'));
    assert.equal(settle.runId, result.runId);
    assert.equal(settle.domainTo, 'bank.example.test');
    const settleBody = fs.readFileSync(path.join(result.runDir, 'actions', settle.response.bodyFile), 'utf8');
    assert.ok(JSON.parse(settleBody).ledgerRow, 'the settlement action carries the ledger row');
    const propose = JSON.parse(fs.readFileSync(path.join(result.runDir, 'actions', actionFiles.find((f) => f.includes('-propose'))), 'utf8'));
    assert.match(propose.response.bodySha256, /^[0-9a-f]{64}$/);

    // The Maurice execution journals were saved beside the adapter's events.
    for (const n of [1, 2]) {
      const saved = JSON.parse(fs.readFileSync(path.join(result.runDir, `maurice-events-${n}.json`), 'utf8'));
      const events = saved.stdout?.events ?? [];
      assert.ok(events.length > 0, `execution ${n} journal has events`);
      assert.ok(events.every((e) => typeof e.event_id === 'string' && Number.isInteger(e.sequence)));
    }
  } catch (err) {
    failed = true;
    if (err?.runDir) console.error(`live slice failed; artifacts kept at ${err.runDir}`);
    throw err;
  } finally {
    if (!failed) removeDir(runsDir);
  }
});

test('live Maurice, poisoned document: every prohibited action is denied with a reason and zero bank settlements occur', { skip: !canRun && 'set MAURICE_LIVE=1 with the maurice binary on PATH to run the live slice', timeout: 600000 }, async () => {
  const runsDir = tempRunsDir();
  let failed = false;
  try {
    const result = await runSliceLive({ kind: 'poisoned', mauriceBin, runsDir, deploymentName: `maurice-slice-poisoned-${Date.now().toString(36)}` });
    const summary = JSON.parse(fs.readFileSync(path.join(result.runDir, 'summary.json'), 'utf8'));
    for (const step of summary.steps) assert.ok(step.ok, `step ${step.name}: ${JSON.stringify(step.detail)}`);
    assert.equal(result.mode, 'poisoned-document');

    // Both workflow executions were refused (business failure, nonzero exit),
    // never completed.
    assert.equal(result.executions.length, 2);
    for (const ex of result.executions) {
      assert.notEqual(ex.state, 'completed', JSON.stringify(ex));
      assert.notEqual(ex.code, 0);
    }

    // Zero bank settlement requests and no ledger row, and no signed
    // payment ever reached the WIMSE gate.
    assert.equal(result.ledger.length, 0, `ledger: ${JSON.stringify(result.ledger)}`);
    assert.equal(result.wimseDecisions.length, 0, JSON.stringify(result.wimseDecisions));
    assert.equal(result.events.filter((e) => e.producer === 'wimse-signer').length, 0);

    // The denied run's evidence package verifies offline too: intact records
    // pass, the tampered copy is rejected, and the decisions in the records
    // are the denials.
    assert.ok(result.aep, 'the poisoned live run packaged its evidence');
    assert.equal(result.aep.check.exitCode, 0, JSON.stringify(result.aep.check.notes));
    assert.equal(result.aep.check.summary.pass, result.aep.records.length);
    assert.equal(result.aep.check.summary.reject, 1);
    const denyBody = fs.readFileSync(path.join(result.runDir, 'actions', fs.readdirSync(path.join(result.runDir, 'actions')).find((f) => f.includes('-execute'))), 'utf8');
    assert.equal(JSON.parse(denyBody).decision, 'deny');

    // The adapter recorded the denials under the run, labeled by mode: the
    // secret read refused, the proposal denied, the execution denied again at
    // execution time.
    const types = result.events.map((e) => e.type);
    assert.ok(types.includes('secret-read-denied'), JSON.stringify(types));
    assert.ok(types.includes('proposal-denied'), JSON.stringify(types));
    assert.ok(types.includes('execution-denied'), JSON.stringify(types));
    assert.ok(result.events.every((e) => e.runId === result.runId && e.mode === 'poisoned-document'));
    const secretEvent = result.events.find((e) => e.type === 'secret-read-denied');
    assert.equal(secretEvent.artifacts.name, 'bank-api-key');
    assert.equal(secretEvent.resolver.refused, true);
    assert.equal(secretEvent.resolver.resolved, false);
    const denied = result.events.find((e) => e.type === 'execution-denied');
    assert.equal(denied.reasonCode, 'intent-mismatch');
    assert.ok(denied.comparedFields.some((c) => c.field === 'payeeAccount' && c.result === 'differ'));
    assert.equal(result.state.state, 'denied');

    // No secret value or private credential material anywhere in the run's
    // evidence (the run's public signer key PEM is public material and is
    // allowed; a private key PEM is not).
    const all = fs.readdirSync(result.runDir, { recursive: true })
      .filter((f) => fs.statSync(path.join(result.runDir, String(f))).isFile())
      .map((f) => fs.readFileSync(path.join(result.runDir, String(f)), 'utf8')).join('\n');
    assert.ok(!all.includes('"resolved": true'));
    assert.ok(!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(all), 'no private key PEM in the run directory');
  } catch (err) {
    failed = true;
    if (err?.runDir) console.error(`live poisoned slice failed; artifacts kept at ${err.runDir}`);
    throw err;
  } finally {
    if (!failed) removeDir(runsDir);
  }
});
