// The contracts of the Maurice invoice slice (three-party/src/maurice/
// contracts.mjs): shapes, reason codes, canonical hashes and the state list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATES, REASONS, DECISIONS, PAY_TOOL, SECRET_TOOL, MODES,
  validateTask, validateProposal, validateAuthorization, validateExecutionRequest,
  validateDecision, validateEvent, declaredIntentFromTask, taskExpired,
  canonicalJson, sha256Hex, proposalSha256,
} from '../src/maurice/contracts.mjs';
import { extractProposal, extractAll, sliceWorkflows, invoicePaymentWorkflow, secretProbeWorkflow } from '../src/maurice/extract.mjs';
import { THREE_PARTY, REPO_ROOT } from './support/engine-helpers.mjs';

const taskFixture = JSON.parse(fs.readFileSync(path.join(THREE_PARTY, 'fixtures', 'tasks', 'po-DEMO-INV-2201.task.json'), 'utf8')).task;
const invoice = JSON.parse(fs.readFileSync(path.join(THREE_PARTY, 'fixtures', 'invoices.json'), 'utf8')).invoices.clean;
const poisoned = JSON.parse(fs.readFileSync(path.join(THREE_PARTY, 'fixtures', 'invoices.json'), 'utf8')).invoices.poisoned;

test('the trusted task fixture validates and declares an intent from itself, not from the invoice', () => {
  assert.equal(validateTask(taskFixture), null);
  const declared = declaredIntentFromTask(taskFixture);
  assert.deepEqual(declared, {
    action: 'pay',
    invoiceId: 'DEMO-INV-2201',
    payeeAccount: 'DEMO-0000-2201',
    currency: 'USD',
    amount: '148.20',
  });
  assert.equal(taskExpired(taskFixture, new Date('2026-11-16T00:00:00Z')), false);
  assert.equal(taskExpired(taskFixture, new Date('2027-04-01T00:00:00Z')), true);
});

test('a task that is not a purchase order, or is malformed, is refused', () => {
  assert.match(validateTask({ ...taskFixture, kind: 'invoice' }), /purchase-order/);
  assert.match(validateTask({ ...taskFixture, amountCap: { amount: 'x', currency: 'USD' } }), /amount cap/);
  assert.match(validateTask(null), /not an object/);
  assert.match(validateTask({ ...taskFixture, provenance: { source: 'invoice-text' } }), /provenance/);
});

test('a proposal is one tool call with typed arguments and nothing else', () => {
  const proposal = extractProposal(invoice);
  assert.equal(validateProposal(proposal), null);
  assert.deepEqual(proposal, {
    tool: PAY_TOOL,
    args: { invoiceId: 'DEMO-INV-2201', payeeAccount: 'DEMO-0000-2201', amount: '148.20', currency: 'USD' },
  });
  assert.match(validateProposal({ tool: 'eval', args: {} }), /names tool/);
  assert.match(validateProposal({ tool: PAY_TOOL, args: { ...proposal.args, code: 'rm -rf /' } }), /undeclared argument/);
  assert.match(validateProposal({ tool: PAY_TOOL, args: { ...proposal.args, amount: '148.2' } }), /decimal string/);
  assert.match(validateProposal({ tool: PAY_TOOL }), /no args/);
});

test('the deterministic extractor follows a hidden Assistant line (the labeled adversarial proposal) and not the clean invoice', () => {
  assert.equal(extractProposal(invoice).args.payeeAccount, 'DEMO-0000-2201');
  const adversarial = extractProposal(poisoned);
  assert.equal(adversarial.args.payeeAccount, 'DEMO-0000-9931');
  assert.equal(adversarial.args.invoiceId, 'DEMO-INV-2202');
});

test('extractAll also lifts the secret probe the hidden text asks for, labeled as followed', () => {
  const clean = extractAll(invoice, 'r1');
  assert.equal(clean.followedHiddenInstruction, false);
  assert.deepEqual(clean.secretProbes, []);
  const poisonedRun = extractAll(poisoned, 'r2');
  assert.equal(poisonedRun.followedHiddenInstruction, true);
  assert.deepEqual(poisonedRun.secretProbes, [{ name: 'bank-api-key', runId: 'r2' }]);
  assert.equal(poisonedRun.proposal.args.payeeAccount, 'DEMO-0000-9931');
});

test('a secret-read proposal carries only a synthetic name', () => {
  assert.equal(validateProposal({ tool: SECRET_TOOL, args: { name: 'bank-api-key' } }), null);
  assert.match(validateProposal({ tool: SECRET_TOOL, args: { name: 'AWS_SECRET_ACCESS_KEY' } }), /synthetic name/);
  assert.match(validateProposal({ tool: SECRET_TOOL, args: { name: 'bank-api-key', value: 'x' } }), /undeclared argument/);
  assert.match(validateProposal({ tool: SECRET_TOOL, args: {} }), /synthetic name/);
  assert.equal(REASONS.SECRET_READ_UNDECLARED, 'secret-read-undeclared');
  assert.deepEqual(MODES, ['clean', 'poisoned-document', 'deterministic-adversarial']);
});

test('the slice workflows reference the adapter tools and the secret probe sub-workflow', () => {
  const tools = { proposeTool: 'srv--proposals_create_v1', executeTool: 'srv--payments_execute_v1', secretReadTool: 'srv--secrets_read_v1' };
  const wf = invoicePaymentWorkflow(tools);
  assert.deepEqual(wf.actions.map((a) => a.type), ['code_execution', 'for_each', 'tool_call', 'tool_call']);
  assert.equal(wf.actions[1].workflow_id, 'secret-probe');
  assert.equal(wf.actions[1].on_empty, 'continue');
  assert.equal(wf.actions[1].output_key, 'secret_reviews');
  assert.equal(wf.actions[2].tool, 'srv--proposals_create_v1');
  assert.equal(wf.actions[3].tool, 'srv--payments_execute_v1');
  const probe = secretProbeWorkflow(tools);
  assert.equal(probe.workflow_id, 'secret-probe');
  assert.equal(probe.actions[0].tool, 'srv--secrets_read_v1');
  assert.equal(probe.input_schema.required[0], 'probe');
  assert.deepEqual(Object.keys(sliceWorkflows(tools)), ['invoice-payment.json', 'secret-probe.json']);
});

test('the execution request carries run and task identifiers, a stable key, the proposal and the authorization', () => {
  const proposal = extractProposal(invoice);
  const request = {
    runId: 'slice-test-1',
    taskId: taskFixture.taskId,
    idempotencyKey: 'slice-test-1:po-DEMO-INV-2201',
    proposal,
    authorization: { kind: 'purchase-order', ref: taskFixture.taskId, proposalSha256: proposalSha256(proposal) },
  };
  assert.equal(validateExecutionRequest(request), null);
  assert.match(validateExecutionRequest({ ...request, idempotencyKey: '' }), /idempotencyKey/);
  assert.match(validateExecutionRequest({ ...request, proposal: { tool: 'x' } }), /proposal/);
  assert.match(validateExecutionRequest({ ...request, authorization: { kind: 'whim', ref: 'r', proposalSha256: '0'.repeat(64) } }), /authorization/);
});

test('an authorization must name a known kind, a reference and a 64-hex proposal hash', () => {
  assert.equal(validateAuthorization({ kind: 'human-approval', ref: 'ui-1', proposalSha256: 'a'.repeat(64) }), null);
  assert.match(validateAuthorization({ kind: 'purchase-order', ref: 'r', proposalSha256: 'xyz' }), /SHA-256/);
  assert.match(validateAuthorization({ kind: 'invoice-text', ref: 'r', proposalSha256: 'a'.repeat(64) }), /kind/);
});

test('decisions and events validate, and the states cover the plan’s list', () => {
  assert.deepEqual(STATES, ['proposed', 'awaiting-approval', 'authorized', 'submitted', 'settled', 'denied', 'failed', 'unknown']);
  assert.deepEqual(DECISIONS, ['allow', 'deny', 'error']);
  const decision = {
    decision: 'deny',
    reasonCode: REASONS.INTENT_MISMATCH,
    comparedFields: [{ field: 'payeeAccount', expected: 'DEMO-0000-2201', actual: 'DEMO-0000-9931', result: 'differ' }],
    artifacts: { taskId: taskFixture.taskId },
  };
  assert.equal(validateDecision(decision), null);
  assert.match(validateDecision({ ...decision, decision: 'maybe' }), /not allow, deny or error/);
  assert.match(validateDecision({ ...decision, comparedFields: [{ field: 'x' }] }), /compared field/);
  const event = {
    runId: 'slice-test-1', eventId: 'slice-test-1-1', producer: 'enforcement-adapter', sequence: 1,
    at: '2026-11-16T20:00:00.000Z', type: 'proposed', artifacts: {},
  };
  assert.equal(validateEvent(event), null);
  assert.match(validateEvent({ ...event, producer: 'model' }), /producer/);
  assert.match(validateEvent({ ...event, sequence: 0 }), /sequence/);
});

test('canonical JSON sorts members and hashes stably across key order', () => {
  assert.equal(canonicalJson({ b: '2', a: '1' }), '{"a":"1","b":"2"}');
  assert.equal(canonicalJson({ args: { y: '1', x: '2' }, tool: 't' }), '{"args":{"x":"2","y":"1"},"tool":"t"}');
  const proposal = extractProposal(invoice);
  const reordered = { tool: proposal.tool, args: { currency: proposal.args.currency, amount: proposal.args.amount, payeeAccount: proposal.args.payeeAccount, invoiceId: proposal.args.invoiceId } };
  assert.equal(proposalSha256(reordered), proposalSha256(proposal));
  assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
  assert.throws(() => canonicalJson({ a: 1.5 }), /integers only/);
});
