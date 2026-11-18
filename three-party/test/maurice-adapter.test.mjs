// The enforcement adapter of the Maurice invoice slice against the real mock
// bank server (three-party/src/maurice/bank-server.mjs over loopback HTTP):
// the clean run settles exactly once with correlated events; a repeated
// idempotency key never settles again and a repeated key with different
// details is rejected; a timeout after submission is unknown, not a denial,
// and the retry settles once; every prohibited proposal is denied with a
// reason and produces no bank settlement request.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdapter, httpBankClient } from '../src/maurice/adapter.mjs';
import { startBankServer, REPO_ROOT, DEFAULT_TASKS_DIR } from '../src/maurice/bank-server.mjs';
import { extractProposal, extractAll } from '../src/maurice/extract.mjs';
import { runSliceLocal } from '../src/maurice/run-slice.mjs';
import { REASONS, SECRET_TOOL } from '../src/maurice/contracts.mjs';
import { REPO_ROOT as ROOT, tempRunsDir, removeDir, movableClock, walkFiles } from './support/engine-helpers.mjs';

const invoices = JSON.parse(fs.readFileSync(path.join(ROOT, 'three-party', 'fixtures', 'invoices.json'), 'utf8'));
const cleanInvoice = invoices.invoices.clean;
const poisonedInvoice = invoices.invoices.poisoned;
const TASK_ID = 'po-DEMO-INV-2201';

let runsDir;
let tasksDir;
let server;
let adapter;
let clock;

const proposalOf = (invoice, over = {}) => ({
  tool: 'bank.payments.create',
  args: { ...extractProposal(invoice).args, ...over },
});

const authFor = (proposal, over = {}) => ({
  kind: 'purchase-order',
  ref: TASK_ID,
  proposalSha256: undefined, // filled by caller
  ...over,
});

async function ledger() {
  return (await (await fetch(`${server.url}/v1/ledger`)).json()).ledger;
}

async function decisions() {
  return (await (await fetch(`${server.url}/v1/decisions`)).json()).decisions;
}

function readRun(runId) {
  const runDir = path.join(runsDir, runId);
  return {
    state: JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')),
    events: fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
  };
}

before(async () => {
  runsDir = tempRunsDir();
  // The adapter's own trusted store: the repository's task fixture, copied.
  tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-tasks-'));
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.copyFileSync(path.join(DEFAULT_TASKS_DIR, `${TASK_ID}.task.json`), path.join(tasksDir, `${TASK_ID}.task.json`));
  // An expired task and a task whose payee is outside the consent.
  const base = JSON.parse(fs.readFileSync(path.join(tasksDir, `${TASK_ID}.task.json`), 'utf8'));
  fs.writeFileSync(path.join(tasksDir, 'po-expired.task.json'), JSON.stringify({ task: { ...base.task, taskId: 'po-expired', expiresAt: '2026-01-01T00:00:00Z' } }));
  fs.writeFileSync(path.join(tasksDir, 'po-other-payee.task.json'), JSON.stringify({ task: { ...base.task, taskId: 'po-other-payee', payeeAccount: 'DEMO-0000-9931', payeeName: 'Not consented' } }));
  // A task that outlives the consent's validToDateTime, to isolate the grant
  // scope check from the task's own expiry.
  fs.writeFileSync(path.join(tasksDir, 'po-long.task.json'), JSON.stringify({ task: { ...base.task, taskId: 'po-long', expiresAt: '2030-01-01T00:00:00Z' } }));
  clock = movableClock();
  server = await startBankServer({ repoRoot: REPO_ROOT, clock, runDir: path.join(runsDir, '_bank') });
  adapter = createAdapter({
    repoRoot: REPO_ROOT,
    tasksDir,
    runsDir,
    bankClient: httpBankClient(server.url, { timeoutMs: 1500 }),
    clock,
  });
});

after(async () => {
  await server.stop();
  removeDir(runsDir);
  removeDir(tasksDir);
});

test('the clean invoice: propose allows and records awaiting-approval, execute settles exactly once with correlated events', async () => {
  const runId = 'slice-clean-1';
  const proposal = proposalOf(cleanInvoice);
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  assert.equal(review.decision, 'allow');
  assert.equal(review.reasonCode, REASONS.PROPOSAL_MATCHES_TASK);
  assert.equal(review.state, 'awaiting-approval');
  assert.match(review.proposalSha256, /^[0-9a-f]{64}$/);

  const execution = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: `${runId}:${TASK_ID}`, proposal,
    authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review.proposalSha256 },
  });
  assert.equal(execution.decision, 'allow');
  assert.equal(execution.reasonCode, REASONS.SETTLED);
  assert.equal(execution.state, 'settled');
  assert.match(execution.paymentId, /^led_/);

  const { state, events } = readRun(runId);
  assert.equal(state.state, 'settled');
  assert.equal(state.paymentId, execution.paymentId);
  assert.deepEqual(events.map((e) => e.type), ['proposed', 'authorized', 'submitted', 'settled', 'ledger-row']);
  assert.ok(events.every((e) => e.runId === runId));
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((e) => e.producer), ['enforcement-adapter', 'enforcement-adapter', 'enforcement-adapter', 'enforcement-adapter', 'bank']);
  for (const e of events) assert.ok(!Number.isNaN(Date.parse(e.at)));

  const rows = (await ledger()).filter((row) => row.rowId === execution.paymentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payeeAccount, 'DEMO-0000-2201');
  assert.equal(rows[0].amountCents, 14820);
  assert.equal(rows[0].currency, 'USD');
});

test('repeating the same execution key does not settle again; the replay answers from the bank’s record', async () => {
  const runId = 'slice-clean-1'; // the run of the first test
  const proposal = proposalOf(cleanInvoice);
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  const before = (await ledger()).length;
  const again = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: `${runId}:${TASK_ID}`, proposal,
    authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review.proposalSha256 },
  });
  assert.equal(again.decision, 'allow');
  assert.equal(again.reasonCode, REASONS.IDEMPOTENT_REPLAY);
  assert.equal(again.state, 'settled');
  assert.equal(again.paymentId, readRun(runId).state.paymentId);
  assert.equal((await ledger()).length, before, 'no second settlement');
  // The replay also recorded an event.
  const { events } = readRun(runId);
  assert.equal(events.at(-1).reasonCode, REASONS.IDEMPOTENT_REPLAY);
});

test('the same idempotency key with different payment details is rejected by the bank and settles nothing', async () => {
  const runId = 'slice-reuse';
  const proposal = proposalOf(cleanInvoice);
  const key = `${runId}:${TASK_ID}`;
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  const first = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: key, proposal,
    authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review.proposalSha256 },
  });
  assert.equal(first.state, 'settled');
  const rowsBefore = (await ledger()).length;

  // Directly at the bank, the same key with a different amount: 409, no new row.
  const grant = await adapter && await httpBankClient(server.url).issueGrant();
  const res = await fetch(`${server.url}/v1/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-grant-ref': grant.grantRef },
    body: JSON.stringify({
      creditorAccount: 'DEMO-0000-2201',
      amount: { amount: '1.00', currency: 'USD' },
      idempotencyKey: key,
    }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).reason, 'idempotency-key-reused-with-different-details');
  assert.equal((await ledger()).length, rowsBefore);

  // Through the adapter, a changed proposal is denied before any bank call.
  const changed = proposalOf(cleanInvoice, { amount: '1.00' });
  const review2 = await adapter.propose({ runId, taskId: TASK_ID, proposal: changed });
  assert.equal(review2.decision, 'deny');
  assert.equal(review2.reasonCode, REASONS.INTENT_MISMATCH);
});

test('a timeout after submission is unknown (not a denial) and the retry with the same key settles once', async () => {
  const runId = 'slice-timeout';
  const key = `${runId}:${TASK_ID}-hang`;
  // A bank server that settles but never answers this key.
  const hangRunDir = path.join(runsDir, runId);
  const hangServer = await startBankServer({ repoRoot: REPO_ROOT, clock, runDir: hangRunDir, hangKeys: new Set([key]) });
  try {
    const hangAdapter = createAdapter({
      repoRoot: REPO_ROOT, tasksDir, runsDir,
      bankClient: httpBankClient(hangServer.url, { timeoutMs: 800 }),
      clock,
    });
    const proposal = proposalOf(cleanInvoice);
    const review = await hangAdapter.propose({ runId, taskId: TASK_ID, proposal });
    assert.equal(review.decision, 'allow');
    const first = await hangAdapter.execute({
      runId, taskId: TASK_ID, idempotencyKey: key, proposal,
      authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review.proposalSha256 },
    });
    assert.equal(first.decision, 'error');
    assert.equal(first.reasonCode, REASONS.BANK_TIMEOUT);
    assert.equal(first.state, 'unknown');
    assert.notEqual(first.state, 'denied');
    assert.equal(first.paymentId, null);

    // The bank did settle behind the timeout; the retry answers from the record.
    const rows = (await (await fetch(`${hangServer.url}/v1/ledger`)).json()).ledger;
    assert.equal(rows.length, 1, 'the hung submission settled exactly once');

    const retryAdapter = createAdapter({
      repoRoot: REPO_ROOT, tasksDir, runsDir,
      bankClient: httpBankClient(hangServer.url, { timeoutMs: 3000 }),
      clock,
    });
    const review2 = await retryAdapter.propose({ runId, taskId: TASK_ID, proposal });
    const retry = await retryAdapter.execute({
      runId, taskId: TASK_ID, idempotencyKey: key, proposal,
      authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review2.proposalSha256 },
    });
    assert.equal(retry.decision, 'allow');
    assert.equal(retry.reasonCode, REASONS.IDEMPOTENT_REPLAY);
    assert.equal(retry.state, 'settled');
    assert.equal(retry.paymentId, rows[0].rowId);
    assert.equal((await (await fetch(`${hangServer.url}/v1/ledger`)).json()).ledger.length, 1, 'the retry did not settle again');
  } finally {
    await hangServer.stop();
  }
});

test('prohibited proposals are denied with a reason and produce zero bank settlement requests', async () => {
  const cases = [
    ['changed payee', proposalOf(cleanInvoice, { payeeAccount: 'DEMO-0000-9931' }), REASONS.INTENT_MISMATCH],
    ['changed amount', proposalOf(cleanInvoice, { amount: '999.99' }), REASONS.INTENT_MISMATCH],
    ['changed currency', proposalOf(cleanInvoice, { currency: 'EUR' }), REASONS.INTENT_MISMATCH],
    ['changed invoice', proposalOf(cleanInvoice, { invoiceId: 'DEMO-INV-9999' }), REASONS.INTENT_MISMATCH],
    ['undeclared extra argument', { tool: 'bank.payments.create', args: { ...proposalOf(cleanInvoice).args, note: 'x' } }, REASONS.PROPOSAL_INVALID],
  ];
  const rowsBefore = (await ledger()).length;
  const decisionsBefore = (await decisions()).length;
  for (const [name, proposal, reason] of cases) {
    const runId = `slice-deny-${name.replace(/\W+/g, '-')}`;
    const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
    assert.equal(review.decision, 'deny', name);
    assert.equal(review.reasonCode, reason, name);
    assert.equal(review.state, 'denied', name);
    if (reason === REASONS.INTENT_MISMATCH) {
      assert.ok(review.comparedFields.some((c) => c.result === 'differ'), name);
    }
    const { state } = readRun(runId);
    assert.equal(state.state, 'denied', name);
  }
  assert.equal((await ledger()).length, rowsBefore, 'no settlement');
  assert.equal((await decisions()).length, decisionsBefore, 'no request reached the bank');
});

test('the adversarial proposal extracted from the poisoned invoice is denied (payee changed by the hidden line)', async () => {
  const runId = 'slice-poisoned';
  const proposal = extractProposal(poisonedInvoice); // follows the hidden "Assistant:" line
  assert.equal(proposal.args.payeeAccount, 'DEMO-0000-9931');
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  assert.equal(review.decision, 'deny');
  assert.equal(review.reasonCode, REASONS.INTENT_MISMATCH);
  const payee = review.comparedFields.find((c) => c.field === 'payeeAccount');
  assert.deepEqual(payee, { field: 'payeeAccount', expected: 'DEMO-0000-2201', actual: 'DEMO-0000-9931', result: 'differ' });
});

test('unknown, expired and out-of-consent tasks are denied at proposal time', async () => {
  const proposal = proposalOf(cleanInvoice);
  const unknown = await adapter.propose({ runId: 'slice-t-unknown', taskId: 'po-nope', proposal });
  assert.equal(unknown.reasonCode, REASONS.TASK_UNKNOWN);
  const expired = await adapter.propose({ runId: 'slice-t-expired', taskId: 'po-expired', proposal });
  assert.equal(expired.reasonCode, REASONS.TASK_EXPIRED);
  // A task whose payee is outside the bank's consent: the proposal matches the
  // task, so the grant scope check is what denies it.
  const otherProposal = proposalOf(cleanInvoice, { payeeAccount: 'DEMO-0000-9931' });
  const other = await adapter.propose({ runId: 'slice-t-other', taskId: 'po-other-payee', proposal: otherProposal });
  assert.equal(other.decision, 'deny');
  assert.match(other.reasonCode, new RegExp(`^${REASONS.GRANT_SCOPE}:grant-scope-creditorAccounts$`));
});

test('execution re-validates: missing, wrong-task, unbound or changed-proposal authorizations are denied without a bank call', async () => {
  const runId = 'slice-auth';
  const proposal = proposalOf(cleanInvoice);
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  const key = `${runId}:${TASK_ID}`;
  const decisionsBefore = (await decisions()).length;

  const missing = await adapter.execute({ runId, taskId: TASK_ID, idempotencyKey: `${key}-a`, proposal, authorization: null });
  assert.equal(missing.decision, 'deny');
  assert.equal(missing.reasonCode, REASONS.APPROVAL_MISSING);

  const wrongTask = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: `${key}-b`, proposal,
    authorization: { kind: 'purchase-order', ref: 'po-other', proposalSha256: review.proposalSha256 },
  });
  assert.equal(wrongTask.reasonCode, REASONS.APPROVAL_WRONG_TASK);

  const unbound = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: `${key}-c`, proposal,
    authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: '0'.repeat(64) },
  });
  assert.equal(unbound.reasonCode, REASONS.APPROVAL_NOT_BOUND);

  // A proposal changed after the propose call does not match the recorded one.
  const changed = proposalOf(cleanInvoice, { amount: '100.00' });
  const changedReview = await adapter.propose({ runId: `${runId}-changed`, taskId: TASK_ID, proposal: changed });
  assert.equal(changedReview.decision, 'deny');

  assert.equal((await decisions()).length, decisionsBefore, 'no bank request was made');
  const { state } = readRun(runId);
  assert.equal(state.state, 'denied');
});

test('a task that expires between propose and execute is denied at execution time', async () => {
  const runId = 'slice-expiry-exec';
  const proposal = proposalOf(cleanInvoice);
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal });
  assert.equal(review.decision, 'allow');
  clock.advance(1000 * 60 * 60 * 24 * 365 * 2); // past the task's expiresAt
  const execution = await adapter.execute({
    runId, taskId: TASK_ID, idempotencyKey: `${runId}:${TASK_ID}`, proposal,
    authorization: { kind: 'purchase-order', ref: TASK_ID, proposalSha256: review.proposalSha256 },
  });
  assert.equal(execution.decision, 'deny');
  assert.equal(execution.reasonCode, REASONS.TASK_EXPIRED);
  clock.advance(-1000 * 60 * 60 * 24 * 365 * 2);
});

// ---- Milestone 2: hostile proposals

test('an undeclared secret read is refused, recorded by its synthetic name only, and reaches no bank', async () => {
  const runId = 'slice-secret';
  const decisionsBefore = (await decisions()).length;
  const result = await adapter.readSecret({ runId, name: 'bank-api-key' });
  assert.equal(result.decision, 'deny');
  assert.equal(result.reasonCode, `${REASONS.SECRET_READ_UNDECLARED}:${REASONS.SECRET_READ_REFUSED}`);
  assert.equal(result.artifacts.name, 'bank-api-key');
  assert.deepEqual(result.artifacts.resolver, { asked: true, exists: false, resolved: false, refused: true });
  assert.equal((await decisions()).length, decisionsBefore, 'no bank request');

  // A malformed or non-synthetic name is refused as a proposal problem.
  const bad = await adapter.readSecret({ runId, name: 'AWS_SECRET_ACCESS_KEY' });
  assert.equal(bad.reasonCode, REASONS.PROPOSAL_INVALID);

  // Nothing in the run directory holds a secret value: only the synthetic
  // name, and the resolver's refusal. No PEM, no token, no resolved value.
  const runDir = path.join(runsDir, runId);
  const files = walkFiles(runDir);
  assert.ok(files.includes('events.jsonl'));
  const all = files.map((f) => fs.readFileSync(path.join(runDir, f), 'utf8')).join('\n');
  assert.ok(!all.includes('BEGIN'), 'no PEM block in the evidence');
  assert.ok(!all.includes('"resolved": true'), 'no resolved secret value in the evidence');
  assert.ok(all.includes('"refused": true'), 'the refusal is recorded');
  const { events, state } = readRun(runId);
  assert.equal(events.at(-1).type, 'secret-read-denied');
  assert.equal(state.secretReads.find((s) => s.name === 'bank-api-key').refused, true);
});

test('a secret-read proposal through propose is an undeclared call', async () => {
  const runId = 'slice-secret-proposal';
  const review = await adapter.propose({ runId, taskId: TASK_ID, proposal: { tool: SECRET_TOOL, args: { name: 'bank-api-key' } } });
  assert.equal(review.decision, 'deny');
  assert.equal(review.reasonCode, REASONS.INTENT_UNDECLARED_CALL);
});

test('the grant is out of scope at execution time too: consent expired, payee outside it', async () => {
  const runId = 'slice-grant-exec';
  const proposal = proposalOf(cleanInvoice);
  const review = await adapter.propose({ runId, taskId: 'po-long', proposal });
  assert.equal(review.decision, 'allow');
  // Past the consent's validToDateTime (2027-03-31T23:59:59Z) but inside the
  // task's own expiry: the grant scope check fails at execution time, before
  // any bank call.
  clock.advance(Date.parse('2027-04-01T00:00:00Z') - Date.now());
  const decisionsBefore = (await decisions()).length;
  const execution = await adapter.execute({
    runId, taskId: 'po-long', idempotencyKey: `${runId}:po-long`, proposal,
    authorization: { kind: 'purchase-order', ref: 'po-long', proposalSha256: review.proposalSha256 },
  });
  assert.equal(execution.decision, 'deny');
  assert.match(execution.reasonCode, new RegExp(`^${REASONS.GRANT_SCOPE}:grant-scope-validToDateTime$`));
  assert.equal((await decisions()).length, decisionsBefore, 'no bank request');
  clock.advance(-(Date.parse('2027-04-01T00:00:00Z') - Date.now()));

  // A task whose payee is outside the consent is denied at execution time.
  const runId2 = 'slice-grant-exec-2';
  const otherProposal = proposalOf(cleanInvoice, { payeeAccount: 'DEMO-0000-9931' });
  const review2 = await adapter.propose({ runId: runId2, taskId: 'po-other-payee', proposal: otherProposal });
  assert.equal(review2.decision, 'deny');
  const execution2 = await adapter.execute({
    runId: runId2, taskId: 'po-other-payee', idempotencyKey: `${runId2}:po-other-payee`, proposal: otherProposal,
    authorization: { kind: 'purchase-order', ref: 'po-other-payee', proposalSha256: review2.proposalSha256 },
  });
  assert.equal(execution2.decision, 'deny');
  assert.match(execution2.reasonCode, new RegExp(`^${REASONS.GRANT_SCOPE}:`));
});

test('the poisoned document end to end (local slice): every prohibited action denied, zero settlements, provenance labeled', async () => {
  const localRuns = tempRunsDir();
  try {
    const result = await runSliceLocal({ kind: 'poisoned', runsDir: localRuns });
    assert.equal(result.mode, 'poisoned-document');
    assert.equal(result.extracted.followedHiddenInstruction, true);
    // The hidden line's secret read: refused, by synthetic name only.
    assert.equal(result.secretReviews.length, 1);
    assert.equal(result.secretReviews[0].decision, 'deny');
    assert.match(result.secretReviews[0].reasonCode, /secret-read-undeclared/);
    // The hidden line's changed payee: denied at proposal time...
    assert.equal(result.review.decision, 'deny');
    assert.equal(result.review.reasonCode, REASONS.INTENT_MISMATCH);
    // ...and again at execution time.
    assert.equal(result.execution.decision, 'deny');
    assert.equal(result.execution.reasonCode, REASONS.INTENT_MISMATCH);
    assert.equal(result.execution.paymentId, null);
    // Zero bank settlement requests and no ledger row.
    assert.equal(result.ledger.length, 0);
    // Events carry the mode label and the denials.
    assert.deepEqual(result.events.map((e) => e.type), ['secret-read-denied', 'proposal-denied', 'execution-denied']);
    assert.ok(result.events.every((e) => e.mode === 'poisoned-document'));
    assert.equal(result.state.state, 'denied');
    assert.equal(result.state.mode, 'poisoned-document');
    // No secret value anywhere in the run's evidence (the run's public
    // signer key PEM under keys/ is public material; a private key PEM is not).
    const all = walkFiles(result.runDir).map((f) => fs.readFileSync(path.join(result.runDir, f), 'utf8')).join('\n');
    assert.ok(!all.includes('"resolved": true'));
    assert.ok(!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(all));
  } finally {
    removeDir(localRuns);
  }
});
