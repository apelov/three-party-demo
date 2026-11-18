// The live half of Milestone 5: deploy the MiniApp slice on a real isolated
// test Agent (bank with live WIMSE authority + adapter MCP + spec deploy
// verified), then drive the wrapper workflow the MiniApp's buttons call —
// run-slice-ui with kind clean and kind poisoned — and check the outcomes
// and the evidence packages. Runs only with MAURICE_LIVE=1 and the maurice
// binary on PATH; otherwise it skips.
//
//   MAURICE_LIVE=1 node --test three-party/test/maurice-ui-live.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deployUiSlice } from '../src/maurice/ui-demo.mjs';
import { maurice } from '../src/maurice/live.mjs';
import { tempRunsDir, removeDir } from './support/engine-helpers.mjs';

const live = process.env.MAURICE_LIVE === '1';
const which = spawnSync('sh', ['-c', 'command -v maurice || ls ~/.local/bin/maurice'], { encoding: 'utf8' });
const mauriceBin = which.status === 0 ? which.stdout.trim().split('\n').pop() : null;
const canRun = live && Boolean(mauriceBin);

const callUi = async (agentId, kind) => {
  const input = { kind };
  const inputFile = path.join(tempRunsDir(), `input-${kind}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = await maurice(mauriceBin, ['test', 'workflow', 'call', 'run-slice-ui', '--agent-id', agentId, '--input-file', inputFile, '--json'], { timeoutMs: 300000 });
  const execution = r.json?.execution ?? r.json?.error?.details?.execution;
  if (!execution) throw new Error(`run-slice-ui ${kind} returned no execution: ${r.stdout} ${r.stderr}`);
  return { code: r.code, execution };
};

const latestRun = (runsDir, kindPrefix) => {
  const names = fs.readdirSync(runsDir).filter((n) => n.startsWith(kindPrefix)).sort();
  assert.ok(names.length > 0, `a ${kindPrefix} run dir exists under ${runsDir}`);
  return path.join(runsDir, names.at(-1));
};

test('live MiniApp slice: deployed verified; run-slice-ui clean settles once with a WIMSE-signed payment and an offline-verifiable package; poisoned is denied with zero settlements', { skip: !canRun && 'set MAURICE_LIVE=1 with the maurice binary on PATH to run the live UI slice', timeout: 600000 }, async () => {
  const runsDir = tempRunsDir();
  let handle = null;
  let failed = false;
  try {
    handle = await deployUiSlice({ mauriceBin, runsDir, deploymentName: `maurice-ui-live-${Date.now().toString(36)}` });
    for (const step of handle.steps) assert.ok(step.ok, `step ${step.name}: ${JSON.stringify(step.detail)}`);
    assert.equal(handle.miniappId, 'invoice-payment-demo');
    const miniappFile = path.join(handle.specDir, 'agents', 'slice', 'miniapps', 'invoice-payment-demo.json');
    assert.ok(fs.existsSync(miniappFile), 'the MiniApp is in the deployed spec project');

    // clean case, as the MiniApp's "Run clean invoice" button does
    const clean = await callUi(handle.agentId, 'clean');
    assert.equal(clean.execution.state, 'completed', JSON.stringify(clean.execution).slice(0, 400));
    const cleanDir = latestRun(runsDir, 'ui-clean-');
    const cleanState = JSON.parse(fs.readFileSync(path.join(cleanDir, 'state.json'), 'utf8'));
    assert.equal(cleanState.state, 'settled');
    const cleanEvents = fs.readFileSync(path.join(cleanDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(cleanEvents.filter((e) => e.producer === 'wimse-signer').length, 1);
    // the wrapper workflow's output reached the caller, including evidence
    const out = clean.execution.data ?? {};
    assert.equal(out.execution?.state ?? out.run?.execution?.state, 'settled');
    const evidence = out.evidence ?? out.run?.evidence;
    assert.ok(evidence, 'the workflow output carries the evidence package summary');
    assert.equal(evidence.check.exitCode, 0, JSON.stringify(evidence.check.notes));
    assert.ok(evidence.records.length >= 3);
    assert.equal(evidence.wimse.accepts, 1);
    assert.equal(evidence.ledgerRows, 1);
    // measured latency, not claimed
    assert.ok(out.startedAt && out.endedAt, 'start/end times are measured');
    // the package is on disk and verifies offline
    const manifest = JSON.parse(fs.readFileSync(path.join(cleanDir, 'records', 'manifest.json'), 'utf8'));
    assert.equal(manifest.runId, path.basename(cleanDir));
    const offline = JSON.parse(fs.readFileSync(path.join(cleanDir, 'offline-check.json'), 'utf8'));
    assert.equal(offline.summary.reject, 1, 'the tampered copy was rejected');
    assert.equal(offline.summary.pass, manifest.records.length);
    // downloadable from the evidence server
    const dl = await fetch(`${handle.evidenceUrl}/${path.basename(cleanDir)}/records/manifest.json`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal((await dl.json()).runId, path.basename(cleanDir));

    // poisoned case, as the "Run poisoned document" button does: the wrapper
    // ends at the denial (a refusal is a business failure, nonzero exit)...
    const poisoned = await callUi(handle.agentId, 'poisoned');
    assert.notEqual(poisoned.code, 0);
    assert.notEqual(poisoned.execution.state, 'completed');
    const poisonedDir = latestRun(runsDir, 'ui-poisoned-');
    const pEvents = fs.readFileSync(path.join(poisonedDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(pEvents.some((e) => e.type === 'secret-read-denied'));
    assert.ok(pEvents.some((e) => e.type === 'proposal-denied'));
    assert.ok(pEvents.some((e) => e.type === 'execution-denied'));
    assert.equal(pEvents.filter((e) => e.producer === 'wimse-signer').length, 0);
    const pState = JSON.parse(fs.readFileSync(path.join(poisonedDir, 'state.json'), 'utf8'));
    assert.equal(pState.state, 'denied');

    // ...and the "Package & verify latest run offline" button packages it
    const vf = path.join(tempRunsDir(), 'verify.json');
    fs.writeFileSync(vf, JSON.stringify({ runId: 'latest' }));
    const vr = await maurice(mauriceBin, ['test', 'workflow', 'call', 'verify-last-run', '--agent-id', handle.agentId, '--input-file', vf, '--json'], { timeoutMs: 300000 });
    const vExec = vr.json?.execution ?? vr.json?.error?.details?.execution;
    assert.ok(vExec, `verify-last-run returned no execution: ${vr.stdout} ${vr.stderr}`);
    assert.equal(vExec.state, 'completed', JSON.stringify(vExec).slice(0, 300));
    const vData = vExec.data ?? {};
    assert.equal(vData.packagedRunId, path.basename(poisonedDir));
    const pEvidence = vData.evidence;
    assert.equal(pEvidence.check.exitCode, 0, 'the denied package verifies offline too');
    assert.ok(pEvidence.records.length >= 3);
    assert.equal(pEvidence.ledgerRows, 1, 'still exactly one settlement across the session');
    assert.equal(pEvidence.wimse.accepts, 1, 'no new signed payment for the poisoned run');
    assert.ok(fs.existsSync(path.join(poisonedDir, 'records', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(poisonedDir, 'offline-check.json')));
    // no secret value in the run's evidence
    const all = fs.readdirSync(poisonedDir, { recursive: true })
      .filter((f) => fs.statSync(path.join(poisonedDir, String(f))).isFile())
      .map((f) => fs.readFileSync(path.join(poisonedDir, String(f)), 'utf8')).join('\n');
    assert.ok(!all.includes('"resolved":true'));
    assert.ok(!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(all));
  } catch (err) {
    failed = true;
    if (handle?.agentId) console.error(`live UI slice failed; agent ${handle.agentId}, spec at ${handle.specDir}`);
    throw err;
  } finally {
    if (handle) await handle.cleanup({ purgeEvidence: false }).catch(() => {});
    if (!failed) removeDir(runsDir);
    else console.error(`artifacts kept at ${runsDir}`);
  }
});

// The complete MiniApp path through the viewer protocol: connect, open an
// instance of the deployed MiniApp, submit the run-clean event (what the
// button does), and poll the instance state until the workflow's result —
// settled once, with the offline-verified evidence — is back in the UI state.
test('live MiniApp viewer path: open instance, submit run-clean, state returns settled + evidence', { skip: !canRun && 'set MAURICE_LIVE=1 with the maurice binary on PATH to run the live UI slice', timeout: 600000 }, async () => {
  const runsDir = tempRunsDir();
  let handle = null;
  let failed = false;
  try {
    handle = await deployUiSlice({ mauriceBin, runsDir, deploymentName: `maurice-ui-viewer-${Date.now().toString(36)}` });
    for (const step of handle.steps) assert.ok(step.ok, `step ${step.name}: ${JSON.stringify(step.detail)}`);

    let r = await maurice(mauriceBin, ['viewer', 'connect', '--deployment', handle.agentId, '--json']);
    if (r.code !== 0) r = await maurice(mauriceBin, ['viewer', 'connect', '--json']);
    assert.equal(r.code, 0, `viewer connect: ${r.stdout} ${r.stderr}`);

    r = await maurice(mauriceBin, ['viewer', 'open', handle.miniappId, '--deployment', handle.agentId, '--recipe-server', 'http://127.0.0.1:5011', '--json'], { timeoutMs: 120000 });
    assert.equal(r.code, 0, `viewer open: ${r.stdout} ${r.stderr}`);
    const instance = r.json?.instance ?? r.json;
    const instanceId = r.json?.app_instance_id ?? instance?.instance_id ?? instance?.id;
    assert.ok(instanceId, `instance id in ${JSON.stringify(r.json).slice(0, 300)}`);
    let version = r.json?.state_version ?? instance?.state_version ?? instance?.state?.state_version ?? 1;

    r = await maurice(mauriceBin, ['viewer', 'submit', instanceId, 'run-clean', '--recipe-server', 'http://127.0.0.1:5011', '--expected-state-version', String(version), '--json'], { timeoutMs: 300000 });
    assert.equal(r.code, 0, `viewer submit run-clean: ${r.stdout} ${r.stderr}`);

    // poll the instance state until the run settles (the workflow runs async
    // under the event)
    let state = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = await maurice(mauriceBin, ['viewer', 'show', instanceId, '--recipe-server', 'http://127.0.0.1:5011', '--json'], { timeoutMs: 60000 });
      if (s.code !== 0) continue;
      state = s.json?.state ?? s.json;
      const runState = state?.run?.execution?.state;
      if (runState === 'settled' || runState === 'denied' || state?.run?.execution) break;
    }
    assert.ok(state?.run?.execution, `instance state carries the run: ${JSON.stringify(state).slice(0, 400)}`);
    assert.equal(state.run.execution.state, 'settled');
    assert.equal(state.run.execution.paymentId, JSON.parse(fs.readFileSync(path.join(latestRun(runsDir, 'ui-clean-'), 'state.json'), 'utf8')).paymentId);
    assert.equal(state.run.evidence.check.exitCode, 0);
    assert.equal(state.run.evidence.ledgerRows, 1);
    assert.equal(state.run.evidence.wimse.accepts, 1);
    assert.equal(state.run.kind, 'clean');
    // the timeline and the compared fields are in the UI state
    assert.ok(Array.isArray(state.run.evidence.events) && state.run.evidence.events.length >= 3);
    assert.ok(Array.isArray(state.run.review.comparedFields) && state.run.review.comparedFields.length > 0);
  } catch (err) {
    failed = true;
    if (handle?.agentId) console.error(`live viewer path failed; agent ${handle.agentId}`);
    throw err;
  } finally {
    if (handle) await handle.cleanup({ purgeEvidence: false }).catch(() => {});
    if (!failed) removeDir(runsDir);
    else console.error(`artifacts kept at ${runsDir}`);
  }
});
