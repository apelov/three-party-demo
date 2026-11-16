// The run engine at pace 0: real local transactions against the repository's
// own bank, token service and broker code, and the files of CONTRACT.md
// sections 3 to 5 that a run leaves behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GRANT_TTL_SECONDS } from '../../src/config.mjs';
import { EXPECTED, NO_RECORD_WRITER, RECORD_WRITER, RunStopped, intentReason, runToEnd, startRun, validPace } from '../src/engine/run.mjs';
import { RUN_ID } from '../src/engine/store.mjs';
import { REPO_ROOT, example, movableClock, readJson, removeDir, tempRunsDir, walkFiles } from './support/engine-helpers.mjs';

const STATE_KEYS = ['runId', 'kind', 'startedAt', 'finishedAt', 'poisonedLine', 'parties', 'invoice', 'agent', 'grant', 'steps', 'outcome', 'blockedAt', 'reason', 'paceSeconds'];
const STEP_KEYS = ['id', 'part', 'partLabel', 'standIn', 'standInNote', 'title', 'status', 'startedAt', 'endedAt', 'detail', 'actionFile', 'recordFile'];
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const statuses = (state) => Object.fromEntries(state.steps.map((s) => [s.id, s.status]));
const stepOf = (state, id) => state.steps.find((s) => s.id === id);
const labels = (state) => state.steps.map((s) => ({ id: s.id, part: s.part, partLabel: s.partLabel, standIn: s.standIn, standInNote: s.standInNote, title: s.title }));

// One run per kind, shared by the tests below that read what it left.
const runsDir = tempRunsDir();
const witness = { clean: [], poisoned: [] };
const events = { clean: [], poisoned: [] };
let clean;
let poisoned;

test('a clean run and a poisoned run complete at pace 0, with no engine error', async () => {
  clean = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriter: null, witness: witness.clean, onEvent: (e) => events.clean.push(e) });
  poisoned = await runToEnd({ kind: 'poisoned', paceSeconds: 0, runsDir, recordWriter: null, witness: witness.poisoned, onEvent: (e) => events.poisoned.push(e) });
  assert.equal(clean.error, null);
  assert.equal(poisoned.error, null);
  assert.match(clean.runId, RUN_ID);
  assert.match(poisoned.runId, RUN_ID);
  assert.ok(clean.runId.startsWith('clean-') && poisoned.runId.startsWith('poisoned-'));
  assert.equal(clean.runDir, path.join(runsDir, clean.runId));
});

test('a clean run: six steps with the statuses of the contract example, except record, which stays pending until the record writer is in the tree', () => {
  const ex = example('state-clean-done.json');
  const state = readJson(path.join(clean.runDir, 'state.json'));
  assert.deepEqual(state, clean.state, 'state.json on disk is the state the run returned');
  assert.deepEqual(Object.keys(state), STATE_KEYS);
  assert.deepEqual(Object.keys(state), Object.keys(ex));
  assert.equal(state.steps.length, 6);
  for (const s of state.steps) assert.deepEqual(Object.keys(s), STEP_KEYS);
  assert.deepEqual(labels(state), labels(ex), 'ids, parts, part labels, stand-in notes and titles byte for byte');
  assert.deepEqual(state.parties, ex.parties, 'the parties by role, as the contract example carries them');
  assert.deepEqual(statuses(state), { ...statuses(ex), record: 'pending' });
  assert.deepEqual(statuses(state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'passed', pay: 'passed', record: 'pending' });
  const record = stepOf(state, 'record');
  assert.equal(record.detail, null);
  assert.equal(record.recordFile, null);
  assert.equal(record.actionFile, null);
  assert.equal(state.outcome, 'paid');
  assert.equal(state.blockedAt, null);
  assert.equal(state.reason, null);
  assert.deepEqual({ outcome: state.outcome, blockedAt: state.blockedAt }, EXPECTED.clean);
  assert.equal(state.poisonedLine, null);
  assert.equal(state.paceSeconds, 0);
  assert.match(state.startedAt, UTC);
  assert.match(state.finishedAt, UTC);
  assert.deepEqual(state.invoice, ex.invoice);
  for (const s of state.steps.filter((x) => x.id !== 'record')) {
    assert.match(s.startedAt, UTC, s.id);
    assert.match(s.endedAt, UTC, s.id);
    assert.equal(s.actionFile, `actions/0${state.steps.indexOf(s) + 1}-${s.id}.action.json`);
    assert.equal(s.recordFile, null, 'no record until the record writer runs');
  }
});

test('a clean run: the agent, the credential hash, the grant and each step detail carry measured values in the contract shape', () => {
  const ex = example('state-clean-done.json');
  const state = clean.state;
  assert.deepEqual(Object.keys(state.agent), Object.keys(ex.agent));
  assert.equal(state.agent.role, 'payments-agent');
  assert.equal(state.agent.domain, ex.agent.domain);
  assert.equal(state.agent.credentialFile, 'fixtures/agents/billpay-agent.atx.json');
  const bytes = fs.readFileSync(new URL('../../fixtures/agents/billpay-agent.atx.json', import.meta.url));
  assert.equal(state.agent.credentialSha256, sha256(bytes), 'the hash is over the exact bytes of the credential file');
  assert.equal(state.agent.credentialSha256, ex.agent.credentialSha256);
  assert.equal(state.agent.did, JSON.parse(bytes.toString('utf8')).agentDid);

  assert.deepEqual(Object.keys(state.grant), Object.keys(ex.grant));
  assert.equal(state.grant.ttlSeconds, GRANT_TTL_SECONDS);
  assert.equal(state.grant.ttlSeconds, 60);
  assert.equal(state.grant.scope, 'payment:billpay');
  assert.equal(state.grant.tokenType, 'Bearer');
  assert.deepEqual(state.grant.maximumIndividualAmount, { amount: '250.00', currency: 'USD' });
  assert.ok(state.grant.creditorAccounts.includes('DEMO-0000-2201'));
  assert.ok(state.grant.creditorAccounts.includes('DEMO-0000-2202'));
  assert.equal(state.grant.creditorAccounts.includes('DEMO-0000-9931'), false, 'the account the hidden text names is in no consent');
  assert.equal((Date.parse(state.grant.expiresAt) - Date.parse(state.grant.issuedAt)) / 1000, 60);

  const detail = (id) => stepOf(state, id).detail;
  const exDetail = (id) => stepOf(ex, id).detail;
  // Every member the contract defines is present; members this build adds
  // come after them.
  for (const id of ['credential', 'grant', 'crossing', 'intent', 'pay']) {
    assert.deepEqual(Object.keys(detail(id)).slice(0, Object.keys(exDetail(id)).length), Object.keys(exDetail(id)), id);
  }
  assert.equal(detail('credential').verifier, exDetail('credential').verifier);
  assert.equal(detail('credential').valid, true);
  assert.equal(detail('credential').postQuantumSignature, exDetail('credential').postQuantumSignature);
  assert.equal(detail('credential').issuer, 'did:opena2a:authority:partner.example');
  assert.deepEqual(detail('grant'), { expiresInSeconds: 60, inScope: true, scopeChecked: exDetail('grant').scopeChecked });
  assert.deepEqual(detail('crossing'), exDetail('crossing'));
  assert.deepEqual(detail('intent'), exDetail('intent'));
  assert.equal(detail('pay').endpoint, '/v1/payments');
  assert.equal(detail('pay').httpStatus, 200);
  assert.match(detail('pay').paymentId, /^led_[0-9a-f]{16}$/);
  assert.equal(detail('pay').amount, '148.20');
  assert.equal(detail('pay').currency, 'USD');
  assert.equal(detail('pay').payeeAccount, 'DEMO-0000-2201');
  assert.equal(detail('pay').recordedByBank, true);
});

test('a clean run leaves state.json, five action files with the response bytes beside each, and one hop file', () => {
  assert.deepEqual(walkFiles(clean.runDir), [
    'actions/01-credential.action.json', 'actions/01-credential.response.txt',
    'actions/02-grant.action.json', 'actions/02-grant.response.txt',
    'actions/03-crossing.action.json', 'actions/03-crossing.response.txt',
    'actions/04-intent.action.json', 'actions/04-intent.response.txt',
    'actions/05-pay.action.json', 'actions/05-pay.response.txt',
    'hops/03-crossing.hop.json',
    'state.json',
  ]);
});

test('an action file has the fields of the contract example, and its response file holds the bytes its hash names', () => {
  const ex = example('action-05-pay.action.json');
  const decisions = {};
  for (const step of clean.state.steps.filter((s) => s.actionFile)) {
    const action = readJson(path.join(clean.runDir, step.actionFile));
    assert.deepEqual(Object.keys(action), Object.keys(ex), step.id);
    assert.deepEqual(Object.keys(action.actor), Object.keys(ex.actor));
    assert.deepEqual(Object.keys(action.response), Object.keys(ex.response));
    assert.equal(action.runId, clean.runId);
    assert.equal(action.seq, clean.state.steps.indexOf(step) + 1);
    assert.equal(action.step, step.id);
    assert.equal(action.kind, 'clean');
    assert.equal(action.at, step.endedAt);
    assert.deepEqual(action.actor, { did: clean.state.agent.did, role: 'payments-agent', credentialSha256: clean.state.agent.credentialSha256 });
    assert.equal(typeof action.reason, 'string');
    assert.ok(action.reason.length > 0);
    const body = fs.readFileSync(path.join(clean.runDir, 'actions', action.response.bodyFile));
    assert.equal(action.response.bodySha256, sha256(body), step.id);
    assert.ok(body.length > 0, step.id);
    decisions[step.id] = action.decision;
  }
  assert.deepEqual(decisions, { credential: 'allowed', grant: 'allowed', crossing: 'observed', intent: 'allowed', pay: 'allowed' });

  const pay = readJson(path.join(clean.runDir, 'actions/05-pay.action.json'));
  assert.equal(pay.domainFrom, ex.domainFrom);
  assert.equal(pay.domainTo, ex.domainTo);
  assert.deepEqual(pay.declaredIntent, ex.declaredIntent);
  assert.deepEqual(pay.toolCall, ex.toolCall);
  assert.equal(pay.decision, ex.decision);
  assert.equal(pay.reason, ex.reason);
  assert.equal(pay.response.status, 200);
  assert.equal(pay.response.bodyFile, ex.response.bodyFile);
  // The bank's own answer, byte for byte.
  const answer = fs.readFileSync(path.join(clean.runDir, 'actions/05-pay.response.txt'), 'utf8');
  assert.equal(answer, JSON.stringify({ status: 'accepted', paymentId: stepOf(clean.state, 'pay').detail.paymentId }));
});

test('the hop file has the fields of the contract example and its values, with this run\'s id and time', () => {
  const ex = example('hop-03-crossing.hop.json');
  for (const run of [clean, poisoned]) {
    const hop = readJson(path.join(run.runDir, 'hops/03-crossing.hop.json'));
    assert.deepEqual(Object.keys(hop), Object.keys(ex));
    assert.deepEqual({ ...hop, runId: ex.runId, at: ex.at }, ex, 'every field but the run id and the time equals the example');
    assert.equal(hop.runId, run.runId);
    assert.equal(hop.at, stepOf(run.state, 'crossing').endedAt);
    assert.equal(hop.seq, 3);
    assert.equal(hop.chainSha256, sha256(fs.readFileSync(new URL(`../../${hop.chainFile}`, import.meta.url))));
    assert.equal(stepOf(run.state, 'crossing').detail.hopFile, 'hops/03-crossing.hop.json');
  }
});

test('a poisoned run ends blocked at intent, with pay not reached and the two calls of the contract example', () => {
  const ex = example('state-poisoned-blocked.json');
  const state = readJson(path.join(poisoned.runDir, 'state.json'));
  assert.deepEqual(state, poisoned.state);
  assert.deepEqual(Object.keys(state), Object.keys(ex));
  assert.deepEqual(labels(state), labels(ex));
  assert.deepEqual(statuses(state), { ...statuses(ex), record: 'pending' });
  assert.deepEqual(statuses(state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'blocked', pay: 'not-reached', record: 'pending' });
  assert.equal(state.outcome, 'blocked');
  assert.equal(state.blockedAt, 'intent');
  assert.deepEqual({ outcome: state.outcome, blockedAt: state.blockedAt }, EXPECTED.poisoned);
  assert.equal(state.reason, ex.reason);
  assert.equal(state.reason, 'The credential and the grant were valid, but the agent asked for a secret and changed the payee, which its declared intent does not allow.');
  assert.equal(state.poisonedLine, ex.poisonedLine);
  assert.equal(state.poisonedLine, 'The poisoned invoice is modeled on what OpenA2A honeypots saw; no captured traffic is replayed.');
  assert.deepEqual(state.invoice, ex.invoice);
  assert.deepEqual(stepOf(state, 'pay'), stepOf(ex, 'pay'), 'the pay step is the example pay step: not reached, every other member null');

  const detail = stepOf(state, 'intent').detail;
  const exDetail = stepOf(ex, 'intent').detail;
  assert.equal(detail.rule, exDetail.rule);
  assert.deepEqual(detail.declared, exDetail.declared);
  assert.equal(detail.result, exDetail.result);
  assert.equal(detail.calls.length, 2);
  const contractFields = ({ tool, args, declaredFor, match, fieldsDiffering }) => ({ tool, args, declaredFor, match, fieldsDiffering });
  assert.deepEqual(detail.calls.map(contractFields), exDetail.calls);
  // The credential and the grant were valid: both steps passed, and a grant was issued.
  assert.equal(stepOf(state, 'credential').detail.valid, true);
  assert.equal(stepOf(state, 'grant').detail.inScope, true);
  assert.equal(state.grant.tokenType, 'Bearer');
});

test('a poisoned run: the request for the secret also went to the resolver the bank\'s broker is built with, and its refusal is in the call', () => {
  const [secret, pay] = stepOf(poisoned.state, 'intent').detail.calls;
  assert.deepEqual(secret.brokerResolver, {
    asked: "the resolver the bank's broker is built with, which refuses every name",
    name: 'bank-api-key',
    exists: false,
    resolved: false,
    refused: true,
  });
  assert.equal(Object.hasOwn(pay, 'brokerResolver'), false);
  assert.equal(stepOf(poisoned.state, 'intent').detail.refusal, 'intent-mismatch');
});

test('a poisoned run leaves state.json, four action files, the fourth the blocked intent action, and one hop file; no payment is sent', () => {
  assert.deepEqual(walkFiles(poisoned.runDir), [
    'actions/01-credential.action.json', 'actions/01-credential.response.txt',
    'actions/02-grant.action.json', 'actions/02-grant.response.txt',
    'actions/03-crossing.action.json', 'actions/03-crossing.response.txt',
    'actions/04-intent.action.json', 'actions/04-intent.response.txt',
    'hops/03-crossing.hop.json',
    'state.json',
  ]);
  const action = readJson(path.join(poisoned.runDir, 'actions/04-intent.action.json'));
  assert.equal(action.decision, 'blocked');
  assert.equal(action.seq, 4);
  assert.deepEqual(action.declaredIntent, stepOf(poisoned.state, 'intent').detail.declared);
  assert.deepEqual(action.toolCall, { tool: 'secrets.read', args: { name: 'bank-api-key' } });
  assert.match(action.reason, /^the intent rule stopped the tool calls: /);
  assert.equal(action.response.status, null);
  const body = JSON.parse(fs.readFileSync(path.join(poisoned.runDir, 'actions/04-intent.response.txt'), 'utf8'));
  assert.equal(body.result, 'mismatch');
  assert.equal(body.calls.length, 2);
});

test('no file under a run directory, and no state, holds the access token value the bank issued', () => {
  for (const [run, tokens] of [[clean, witness.clean], [poisoned, witness.poisoned]]) {
    assert.equal(tokens.length, 1, 'the bank issued one access token in the run');
    const [token] = tokens;
    assert.match(token, /^[0-9a-f]{64}$/);
    const files = walkFiles(run.runDir);
    assert.ok(files.length >= 10);
    const hits = files.filter((f) => fs.readFileSync(path.join(run.runDir, f)).includes(Buffer.from(token, 'utf8')));
    assert.deepEqual(hits, [], 'files that hold the token value');
    assert.equal(JSON.stringify(run.state).includes(token), false);
    const grant = fs.readFileSync(path.join(run.runDir, 'actions/02-grant.response.txt'), 'utf8');
    const saved = JSON.parse(grant);
    assert.equal(saved.access_token, 'withheld: the token value is never written');
    assert.equal(saved.token_type, 'Bearer');
    assert.equal(saved.expires_in, 60);
    assert.equal(JSON.stringify(run.state.grant).includes('token') && Object.keys(run.state.grant).some((k) => /access|value/i.test(k)), false);
  }
});

test('the events a run reports: one per step in step order, each with the step as it stood, then finished', () => {
  for (const [kind, list] of Object.entries(events)) {
    const steps = list.filter((e) => e.type === 'step');
    assert.deepEqual(steps.map((e) => e.step.id), ['credential', 'grant', 'crossing', 'intent', 'pay', 'record'], kind);
    assert.equal(list.at(-1).type, 'finished');
    assert.equal(list.filter((e) => e.type === 'finished').length, 1);
    for (const e of list) assert.ok(e.at instanceof Date);
    assert.equal(list.at(-1).state.finishedAt !== null, true);
  }
  assert.deepEqual(events.poisoned.filter((e) => e.type === 'step').map((e) => e.step.status), ['passed', 'passed', 'passed', 'blocked', 'not-reached', 'pending']);
});

test('a grant that has expired when the payment is due is not presented: the run stops at pay with the named refusal grant-expired', async () => {
  const clock = movableClock();
  const dir = tempRunsDir();
  try {
    const { state, error, runDir } = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      clock,
      // The grant lives 60 seconds. Once the intent rule has passed, the
      // clock of the engine and the bank moves 61 seconds on.
      onEvent: (e) => { if (e.type === 'step' && e.step.id === 'intent') clock.advance(61000); },
    });
    assert.equal(error, null);
    assert.deepEqual(statuses(state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'passed', pay: 'blocked', record: 'pending' });
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'pay');
    const pay = stepOf(state, 'pay').detail;
    assert.equal(pay.refusal, 'grant-expired');
    assert.equal(pay.httpStatus, null, 'nothing was sent to the bank');
    assert.equal(pay.paymentId, null);
    assert.equal(pay.recordedByBank, false);
    assert.match(state.reason, /grant-expired/);
    const action = readJson(path.join(runDir, 'actions/05-pay.action.json'));
    assert.equal(action.decision, 'blocked');
    assert.equal(action.response.status, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'actions/05-pay.response.txt'), 'utf8')), { sent: false, refusal: 'grant-expired' });
  } finally {
    removeDir(dir);
  }
});

test('a credential the verifier rejects stops the run at the credential step: no grant, and no later step is reached', async () => {
  const dir = tempRunsDir();
  try {
    // A credential of the repository's lifetime fixtures, expired on any clock after 2026-05-24.
    const { state, error, runDir } = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      credentialFile: 'test/fixtures/atx-lifetime/lifetime-issued-8-days-before.atx.json',
    });
    assert.equal(error, null);
    assert.deepEqual(statuses(state), { credential: 'blocked', grant: 'not-reached', crossing: 'not-reached', intent: 'not-reached', pay: 'not-reached', record: 'pending' });
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'credential');
    assert.equal(state.grant, null);
    const detail = stepOf(state, 'credential').detail;
    assert.equal(detail.valid, false);
    assert.equal(detail.refusal, 'credential-expired');
    assert.equal(detail.issuer, null, 'a claim of a credential that did not verify is not shown as a fact');
    assert.match(state.reason, /credential-expired/);
    assert.deepEqual(walkFiles(runDir), ['actions/01-credential.action.json', 'actions/01-credential.response.txt', 'state.json']);
    assert.equal(readJson(path.join(runDir, 'actions/01-credential.action.json')).decision, 'blocked');
  } finally {
    removeDir(dir);
  }
});

test('with a record writer in place the record step reads written, each action step names its record, and the count is the manifest\'s', async () => {
  const dir = tempRunsDir();
  const calls = [];
  // A stand-in for the record build's writer: it writes the manifest of
  // CONTRACT.md section 5 and one file per action file.
  const recordWriter = {
    async writeRun(runDir) {
      calls.push(runDir);
      const actions = fs.readdirSync(path.join(runDir, 'actions')).filter((f) => f.endsWith('.action.json')).sort();
      fs.mkdirSync(path.join(runDir, 'records'));
      const records = actions.map((f) => {
        const file = `records/${f.replace('.action.json', '.aep')}`;
        fs.writeFileSync(path.join(runDir, file), 'stand-in package');
        return { file, sha256: sha256(Buffer.from('stand-in package')), action: `actions/${f}` };
      });
      fs.writeFileSync(path.join(runDir, 'records/manifest.json'), JSON.stringify({ runId: path.basename(runDir), format: 'the format the manifest names', records, tampered: [] }));
    },
  };
  try {
    const { state, error, runDir } = await runToEnd({ kind: 'poisoned', paceSeconds: 0, runsDir: dir, recordWriter });
    assert.equal(error, null);
    assert.deepEqual(calls, [runDir]);
    const ex = example('state-poisoned-blocked.json');
    assert.deepEqual(statuses(state), statuses(ex), 'every status of the contract example, record included');
    const record = stepOf(state, 'record');
    assert.deepEqual(Object.keys(record.detail), Object.keys(stepOf(ex, 'record').detail));
    assert.equal(record.detail.written, 4);
    assert.equal(record.detail.format, 'the format the manifest names');
    assert.equal(record.detail.signer, stepOf(ex, 'record').detail.signer);
    assert.equal(record.detail.credentialCitedBy, stepOf(ex, 'record').detail.credentialCitedBy);
    assert.equal(record.detail.timestampEntry, stepOf(ex, 'record').detail.timestampEntry);
    assert.equal(record.recordFile, 'records/manifest.json');
    assert.equal(record.actionFile, null);
    assert.match(record.startedAt, UTC);
    assert.match(record.endedAt, UTC);
    assert.deepEqual(state.steps.map((s) => s.recordFile), ex.steps.map((s) => s.recordFile));
    assert.equal(state.outcome, 'blocked', 'the record step does not change the outcome');
  } finally {
    removeDir(dir);
  }
});

test('the record writer is the module at three-party/src/record/writer.mjs: a run uses it when that file exists, and leaves the record step pending when it does not', async () => {
  assert.equal(RECORD_WRITER, path.join(REPO_ROOT, 'three-party', 'src', 'record', 'writer.mjs'));
  const dir = tempRunsDir();
  try {
    // A module that stands in for the record build's writer, written for this test.
    const moduleFile = path.join(dir, 'writer.mjs');
    fs.writeFileSync(moduleFile, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      'export async function writeRun(runDir) {',
      "  fs.mkdirSync(path.join(runDir, 'records'));",
      "  fs.writeFileSync(path.join(runDir, 'records/01-credential.aep'), 'stand-in package');",
      "  const records = [{ file: 'records/01-credential.aep', sha256: null, action: 'actions/01-credential.action.json' }];",
      "  fs.writeFileSync(path.join(runDir, 'records/manifest.json'), JSON.stringify({ format: 'the format the manifest names', records }));",
      '}',
      '',
    ].join('\n'));
    const runsDir = path.join(dir, 'runs');
    const notes = [];
    const found = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriterFile: moduleFile, onEvent: (e) => { if (e.type === 'step' && e.step.id === 'record') notes.push(e.note); } });
    assert.equal(found.error, null);
    assert.equal(stepOf(found.state, 'record').status, 'written');
    assert.equal(stepOf(found.state, 'record').detail.written, 1);
    assert.equal(stepOf(found.state, 'credential').recordFile, 'records/01-credential.aep');
    assert.equal(stepOf(found.state, 'grant').recordFile, null, 'a step the manifest does not name has no record');
    assert.deepEqual(notes, [null]);

    const absent = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriterFile: path.join(dir, 'no-such-writer.mjs'), onEvent: (e) => { if (e.type === 'step' && e.step.id === 'record') notes.push(e.note); } });
    assert.equal(absent.error, null);
    assert.equal(stepOf(absent.state, 'record').status, 'pending');
    assert.equal(stepOf(absent.state, 'record').detail, null);
    assert.equal(stepOf(absent.state, 'record').recordFile, null);
    assert.deepEqual(notes, [null, NO_RECORD_WRITER], 'the event of a record step left pending says no writer is in the tree');
    assert.equal(fs.existsSync(path.join(absent.runDir, 'records')), false);

    // A module at that path with no writeRun is not a record writer.
    const empty = path.join(dir, 'empty.mjs');
    fs.writeFileSync(empty, 'export const nothing = true;\n');
    const unusable = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriterFile: empty });
    assert.equal(stepOf(unusable.state, 'record').status, 'pending');
  } finally {
    removeDir(dir);
  }
});

test('a record writer that fails stops the record step and leaves the payment outcome as it was', async () => {
  const dir = tempRunsDir();
  try {
    const { state, error } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir: dir, recordWriter: { writeRun: async () => { throw new Error('no key'); } } });
    assert.equal(error, null);
    assert.equal(state.outcome, 'paid');
    assert.equal(state.blockedAt, null);
    const record = stepOf(state, 'record');
    assert.equal(record.status, 'blocked');
    assert.deepEqual(record.detail, { written: 0, refusal: 'record-writer-failed', error: 'no key' });
    assert.equal(record.recordFile, null);
  } finally {
    removeDir(dir);
  }
});

// The waits of a run, in order: one after the start, then for each step that
// runs one while it reads running and one after its result.
test('an engine failure while a step runs ends the run in a state a reader can trust: stopped at that step, nothing left running, the error returned', async () => {
  const dir = tempRunsDir();
  let sleeps = 0;
  try {
    const { state, error, runDir } = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      // The fourth wait is the one the grant step makes while it reads running.
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 4) throw new Error('the wait failed');
      },
    });
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'the wait failed');
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'grant');
    assert.equal(state.reason, 'The run stopped on an engine error at the step grant: the wait failed');
    assert.match(state.finishedAt, UTC);
    assert.equal(state.steps.some((s) => s.status === 'running' || s.status === 'pending'), false);
    assert.deepEqual(statuses(state), { credential: 'passed', grant: 'blocked', crossing: 'not-reached', intent: 'not-reached', pay: 'not-reached', record: 'not-reached' });
    assert.deepEqual(stepOf(state, 'grant').detail, { refusal: 'engine-error', error: 'the wait failed' });
    assert.equal(state.grant, null, 'no grant was issued');
    assert.deepEqual(readJson(path.join(runDir, 'state.json')), state);
    assert.deepEqual(walkFiles(runDir), ['actions/01-credential.action.json', 'actions/01-credential.response.txt', 'state.json']);
  } finally {
    removeDir(dir);
  }
});

test('an engine failure between two steps stops the run at the step it had not started, and a payment already made stays paid', async () => {
  const dir = tempRunsDir();
  try {
    let sleeps = 0;
    const between = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      // The fifth wait follows the grant step's result.
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 5) throw new Error('the wait failed');
      },
    });
    assert.equal(between.error.message, 'the wait failed');
    assert.equal(between.state.blockedAt, 'crossing');
    assert.deepEqual(statuses(between.state), { credential: 'passed', grant: 'passed', crossing: 'blocked', intent: 'not-reached', pay: 'not-reached', record: 'not-reached' });
    assert.equal(between.state.grant.tokenType, 'Bearer', 'the grant that was issued stays in the state');

    sleeps = 0;
    const afterPay = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      // The eleventh wait follows the pay step's result.
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 11) throw new Error('the wait failed');
      },
    });
    assert.equal(afterPay.error.message, 'the wait failed');
    assert.equal(afterPay.state.outcome, 'paid', 'the bank accepted the payment before the engine failed');
    assert.equal(afterPay.state.blockedAt, null);
    assert.equal(afterPay.state.reason, null);
    assert.deepEqual(statuses(afterPay.state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'passed', pay: 'passed', record: 'blocked' });
    assert.deepEqual(stepOf(afterPay.state, 'record').detail, { refusal: 'engine-error', error: 'the wait failed' });
  } finally {
    removeDir(dir);
  }
});

test('an engine failure after the intent rule has stopped a run leaves that outcome and its reason as they were', async () => {
  const dir = tempRunsDir();
  let sleeps = 0;
  try {
    const { state, error } = await runToEnd({
      kind: 'poisoned',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      // The ninth wait follows the intent step's result.
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 9) throw new Error('the wait failed');
      },
    });
    assert.equal(error.message, 'the wait failed');
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'intent', 'the step that stopped the run is still the intent rule');
    assert.equal(state.reason, 'The credential and the grant were valid, but the agent asked for a secret and changed the payee, which its declared intent does not allow.');
    // Pay was never due. The record step was, and the failure kept it from running.
    assert.deepEqual(statuses(state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'blocked', pay: 'not-reached', record: 'blocked' });
    assert.equal(stepOf(state, 'intent').detail.result, 'mismatch', 'the intent step keeps its own result');
    assert.deepEqual(stepOf(state, 'record').detail, { refusal: 'engine-error', error: 'the wait failed' });
    assert.match(state.finishedAt, UTC);
  } finally {
    removeDir(dir);
  }
});

test('an engine failure after every step has had its turn changes no step: the results, the outcome and a record already written stay', async () => {
  const dir = tempRunsDir();
  try {
    let sleeps = 0;
    // With no record writer the twelfth wait is the last one of a clean run.
    const bare = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 12) throw new Error('the wait failed');
      },
    });
    assert.equal(bare.error.message, 'the wait failed');
    assert.deepEqual(statuses(bare.state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'passed', pay: 'passed', record: 'pending' });
    assert.equal(bare.state.outcome, 'paid');
    assert.equal(stepOf(bare.state, 'record').detail, null);
    assert.match(bare.state.finishedAt, UTC);

    sleeps = 0;
    const recordWriter = {
      async writeRun(runDir) {
        fs.mkdirSync(path.join(runDir, 'records'));
        fs.writeFileSync(path.join(runDir, 'records/manifest.json'), JSON.stringify({ format: 'the format the manifest names', records: [] }));
      },
    };
    // With a record writer the record step waits twice, so the thirteenth wait is the last one.
    const written = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 13) throw new Error('the wait failed');
      },
    });
    assert.equal(written.error.message, 'the wait failed');
    assert.equal(stepOf(written.state, 'record').status, 'written', 'the record step keeps its result');
    assert.equal(stepOf(written.state, 'record').recordFile, 'records/manifest.json');
    assert.equal(written.state.outcome, 'paid');
    assert.equal(written.state.steps.some((s) => s.status === 'blocked'), false);
  } finally {
    removeDir(dir);
  }
});

test('a run its caller stops ends at once and says so: the step due reads blocked with the refusal run-stopped, and nothing is left running or pending', async () => {
  const dir = tempRunsDir();
  try {
    // A pace of 15 seconds: without the stop, the wait in progress would last that long.
    const run = await startRun({ kind: 'clean', paceSeconds: 15, runsDir: dir, recordWriter: null });
    const before = Date.now();
    await run.abort();
    assert.ok(Date.now() - before < 5000, 'the stop did not wait out the pace');
    const { state, error } = await run.done;
    assert.ok(error instanceof RunStopped);
    assert.equal(error.message, 'the run was stopped');
    assert.deepEqual(statuses(state), { credential: 'blocked', grant: 'not-reached', crossing: 'not-reached', intent: 'not-reached', pay: 'not-reached', record: 'not-reached' });
    assert.deepEqual(stepOf(state, 'credential').detail, { refusal: 'run-stopped' });
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'credential');
    assert.equal(state.reason, 'The run was stopped before it finished, at the step credential.');
    assert.equal(state.grant, null);
    assert.match(state.finishedAt, UTC);
    assert.deepEqual(readJson(path.join(run.runDir, 'state.json')), state, 'the state on disk is the final state when abort returns');
    assert.deepEqual(walkFiles(run.runDir), ['state.json'], 'no action was taken');
    // A second stop changes nothing.
    await run.abort();
    assert.deepEqual(readJson(path.join(run.runDir, 'state.json')), state);
  } finally {
    removeDir(dir);
  }
});

test('a run stopped while a step is in progress stops at that step, and a run stopped after the payment stays paid', async () => {
  const dir = tempRunsDir();
  try {
    // Stopped during the wait the grant step makes while it reads running.
    let waits = 0;
    let midStep;
    const during = await startRun({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      sleep: () => {
        waits += 1;
        if (waits === 4) return new Promise(() => { setImmediate(() => { midStep = during.abort(); }); });
        return Promise.resolve();
      },
    });
    const stoppedMidStep = await during.done;
    await midStep;
    assert.ok(stoppedMidStep.error instanceof RunStopped);
    assert.deepEqual(statuses(stoppedMidStep.state), { credential: 'passed', grant: 'blocked', crossing: 'not-reached', intent: 'not-reached', pay: 'not-reached', record: 'not-reached' });
    assert.deepEqual(stepOf(stoppedMidStep.state, 'grant').detail, { refusal: 'run-stopped' });
    assert.equal(stoppedMidStep.state.blockedAt, 'grant');
    assert.equal(stoppedMidStep.state.reason, 'The run was stopped before it finished, at the step grant.');
    assert.equal(stoppedMidStep.state.grant, null);

    // Stopped as soon as the bank has accepted the payment.
    let afterPay;
    let stopping;
    afterPay = await startRun({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      onEvent: (e) => { if (e.type === 'step' && e.step.id === 'pay') stopping = afterPay.abort(); },
    });
    const paid = await afterPay.done;
    await stopping;
    assert.ok(paid.error instanceof RunStopped);
    assert.equal(paid.state.outcome, 'paid', 'the payment was made; stopping the run does not unmake it');
    assert.equal(paid.state.blockedAt, null);
    assert.equal(paid.state.reason, null);
    assert.deepEqual(statuses(paid.state), { credential: 'passed', grant: 'passed', crossing: 'passed', intent: 'passed', pay: 'passed', record: 'blocked' });
    assert.deepEqual(stepOf(paid.state, 'record').detail, { refusal: 'run-stopped' });
    assert.equal(stepOf(paid.state, 'pay').detail.recordedByBank, true);
  } finally {
    removeDir(dir);
  }
});

test('a check that fails because the run is being stopped is not written as that step\'s own refusal', async () => {
  const dir = tempRunsDir();
  try {
    // The run is stopped while the grant step's check is under way: the
    // bank's listeners close, and the token exchange cannot go through.
    let waits = 0;
    let inGrantCheck = false;
    let stopping = null;
    let run = null;
    const clock = () => {
      if (inGrantCheck && stopping === null) stopping = run.abort();
      return new Date();
    };
    run = await startRun({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      clock,
      // The fourth wait is the one the grant step makes before its check.
      sleep: async () => {
        waits += 1;
        if (waits === 4) inGrantCheck = true;
      },
    });
    const { state, error } = await run.done;
    await stopping;
    assert.ok(error instanceof RunStopped);
    assert.deepEqual(statuses(state), { credential: 'passed', grant: 'blocked', crossing: 'not-reached', intent: 'not-reached', pay: 'not-reached', record: 'not-reached' });
    assert.deepEqual(stepOf(state, 'grant').detail, { refusal: 'run-stopped' }, 'not grant-denied: the bank refused nothing');
    assert.equal(state.reason, 'The run was stopped before it finished, at the step grant.');
    assert.equal(state.grant, null);
    assert.equal(stepOf(state, 'grant').actionFile, null);
    assert.deepEqual(walkFiles(run.runDir), ['actions/01-credential.action.json', 'actions/01-credential.response.txt', 'state.json'], 'no action is written for the step that did not finish');
  } finally {
    removeDir(dir);
  }
});

test('two runs of one kind started in the same second get two run ids', async () => {
  const dir = tempRunsDir();
  try {
    const a = await startRun({ kind: 'poisoned', paceSeconds: 0, runsDir: dir, recordWriter: null });
    const b = await startRun({ kind: 'poisoned', paceSeconds: 0, runsDir: dir, recordWriter: null });
    assert.notEqual(a.runId, b.runId);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.error, null);
    assert.equal(rb.error, null);
    assert.equal(ra.state.blockedAt, 'intent');
    assert.equal(rb.state.blockedAt, 'intent');
    assert.deepEqual(fs.readdirSync(dir).sort(), [a.runId, b.runId].sort());
  } finally {
    removeDir(dir);
  }
});

test('a run refuses a kind or a pace it does not know before it writes anything', async () => {
  const dir = tempRunsDir();
  try {
    await assert.rejects(startRun({ kind: 'other', paceSeconds: 0, runsDir: dir }), /clean or poisoned/);
    await assert.rejects(startRun({ kind: 'clean', paceSeconds: -1, runsDir: dir }), /pace/);
    await assert.rejects(startRun({ kind: 'clean', paceSeconds: 16, runsDir: dir }), /pace/);
    await assert.rejects(startRun({ kind: 'clean', paceSeconds: '8', runsDir: dir }), /pace/);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(validPace(0), true);
    assert.equal(validPace(8), true);
    assert.equal(validPace(15), true);
    assert.equal(validPace(Number.NaN), false);
  } finally {
    removeDir(dir);
  }
});

test('the reason of a run the intent rule stops: the set sentence for a secret asked for and a changed payee, and other words for any other mismatch', () => {
  const secret = { tool: 'secrets.read', args: { name: 'bank-api-key' }, declaredFor: null, match: false, fieldsDiffering: ['no declared intent for this call'] };
  const pay = (fieldsDiffering, args = {}) => ({ tool: 'bank.payments.create', args: { invoiceId: 'DEMO-INV-2202', payeeAccount: 'DEMO-0000-9931', amount: '212.75', currency: 'USD', ...args }, declaredFor: 'pay', match: fieldsDiffering.length === 0, fieldsDiffering });
  const declared = { action: 'pay', invoiceId: 'DEMO-INV-2202', payeeAccount: 'DEMO-0000-2202', amount: '212.75', currency: 'USD' };
  const set = 'The credential and the grant were valid, but the agent asked for a secret and changed the payee, which its declared intent does not allow.';
  assert.equal(intentReason({ declared, calls: [secret, pay(['payeeAccount'])], result: 'mismatch' }), set);
  const amount = intentReason({ declared, calls: [pay(['amount'], { payeeAccount: 'DEMO-0000-2202', amount: '999.00' })], result: 'mismatch' });
  assert.notEqual(amount, set);
  assert.match(amount, /^The credential and the grant were valid, but a tool call did not equal the declared intent: bank\.payments\.create differs in amount \(declared 212\.75, called with 999\.00\)\.$/);
  const alone = intentReason({ declared, calls: [secret, pay([], { payeeAccount: 'DEMO-0000-2202' })], result: 'undeclared-call' });
  assert.notEqual(alone, set);
  assert.match(alone, /secrets\.read has no declared intent/);
});

test.after(() => removeDir(runsDir));
