// The intent rule on its own: a pure function over a declared intent and a
// list of tool calls. No bank, no file and no clock is involved here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NO_DECLARED_INTENT, RULE_TEXT, TOOL_FOR_ACTION, applyIntentRule, declareIntent, intentAllows } from '../src/intent/rule.mjs';
import { planToolCalls } from '../src/engine/agent.mjs';

const fixtures = JSON.parse(fs.readFileSync(new URL('../fixtures/invoices.json', import.meta.url), 'utf8'));
const example = (name) => JSON.parse(fs.readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
const intentDetail = (state) => state.steps.find((s) => s.id === 'intent').detail;

const DECLARED = Object.freeze({ action: 'pay', invoiceId: 'DEMO-INV-2201', payeeAccount: 'DEMO-0000-2201', amount: '148.20', currency: 'USD' });
const payCall = (over = {}) => ({ tool: 'bank.payments.create', args: { invoiceId: 'DEMO-INV-2201', payeeAccount: 'DEMO-0000-2201', amount: '148.20', currency: 'USD', ...over } });

test('match: a call that carries every declared field with its declared value passes', () => {
  const r = applyIntentRule(DECLARED, [payCall()]);
  assert.equal(r.result, 'match');
  assert.equal(intentAllows(r), true);
  assert.deepEqual(r.calls, [{ ...payCall(), declaredFor: 'pay', match: true, fieldsDiffering: [] }]);
  assert.equal(r.rule, RULE_TEXT);
  assert.deepEqual(r.declared, DECLARED);
});

test('payee differs: the call is held against the declared intent and names payeeAccount', () => {
  const r = applyIntentRule(DECLARED, [payCall({ payeeAccount: 'DEMO-0000-9931' })]);
  assert.equal(r.result, 'mismatch');
  assert.equal(intentAllows(r), false);
  assert.equal(r.calls[0].declaredFor, 'pay');
  assert.equal(r.calls[0].match, false);
  assert.deepEqual(r.calls[0].fieldsDiffering, ['payeeAccount']);
});

test('amount differs: one cent more names amount, and so does the same value spelled another way', () => {
  assert.deepEqual(applyIntentRule(DECLARED, [payCall({ amount: '148.21' })]).calls[0].fieldsDiffering, ['amount']);
  assert.deepEqual(applyIntentRule(DECLARED, [payCall({ amount: '148.2' })]).calls[0].fieldsDiffering, ['amount']);
  assert.deepEqual(applyIntentRule(DECLARED, [payCall({ amount: 148.2 })]).calls[0].fieldsDiffering, ['amount']);
  assert.equal(applyIntentRule(DECLARED, [payCall({ amount: '148.21' })]).result, 'mismatch');
});

test('undeclared call: a call for a tool no declared intent names is blocked, with the marker in place of field names', () => {
  const r = applyIntentRule(DECLARED, [{ tool: 'secrets.read', args: { name: 'bank-api-key' } }, payCall()]);
  assert.equal(r.result, 'undeclared-call');
  assert.equal(intentAllows(r), false);
  assert.deepEqual(r.calls[0], { tool: 'secrets.read', args: { name: 'bank-api-key' }, declaredFor: null, match: false, fieldsDiffering: [NO_DECLARED_INTENT] });
  assert.equal(r.calls[1].match, true);
});

test('an undeclared call beside a call that differs reads mismatch, as the contract example does', () => {
  const r = applyIntentRule(DECLARED, [{ tool: 'secrets.read', args: { name: 'bank-api-key' } }, payCall({ payeeAccount: 'DEMO-0000-9931' })]);
  assert.equal(r.result, 'mismatch');
  assert.deepEqual(r.calls.map((c) => c.match), [false, false]);
});

test('every field counts: several differing fields are named in declared order, then an argument the intent does not declare', () => {
  const r = applyIntentRule(DECLARED, [payCall({ currency: 'EUR', invoiceId: 'DEMO-INV-9999', memo: 'urgent' })]);
  assert.deepEqual(r.calls[0].fieldsDiffering, ['invoiceId', 'currency', 'memo']);
  assert.equal(r.result, 'mismatch');
});

test('a declared field the call leaves out counts as differing', () => {
  const call = payCall();
  delete call.args.currency;
  assert.deepEqual(applyIntentRule(DECLARED, [call]).calls[0].fieldsDiffering, ['currency']);
});

test('a declared intent covers one call: a second call for it has no declared intent left', () => {
  const r = applyIntentRule(DECLARED, [payCall(), payCall()]);
  assert.equal(r.calls[0].match, true);
  assert.deepEqual(r.calls[1], { ...payCall(), declaredFor: null, match: false, fieldsDiffering: [NO_DECLARED_INTENT] });
  assert.equal(r.result, 'undeclared-call');
});

test('the rule is a pure function: it leaves its inputs as they were and gives the same result twice', () => {
  const declared = { ...DECLARED };
  const calls = [{ tool: 'secrets.read', args: { name: 'bank-api-key' } }, payCall({ payeeAccount: 'DEMO-0000-9931' })];
  const before = JSON.stringify({ declared, calls });
  const once = applyIntentRule(declared, calls);
  const twice = applyIntentRule(declared, calls);
  assert.equal(JSON.stringify({ declared, calls }), before);
  assert.deepEqual(once, twice);
  once.calls[0].args.name = 'changed';
  assert.equal(calls[0].args.name, 'bank-api-key', 'the result holds copies of the arguments');
});

test('the rule refuses inputs it cannot hold a call against', () => {
  assert.throws(() => applyIntentRule({ action: 'transfer' }, []), TypeError);
  assert.throws(() => applyIntentRule(null, []), TypeError);
  assert.throws(() => applyIntentRule(DECLARED, 'bank.payments.create'), TypeError);
  assert.deepEqual(TOOL_FOR_ACTION, { pay: 'bank.payments.create' });
});

test('the declared intent comes from the structured fields: the hidden text and the lines change nothing', () => {
  const poisoned = fixtures.invoices.poisoned;
  const declared = declareIntent(poisoned);
  assert.deepEqual(declared, { action: 'pay', invoiceId: 'DEMO-INV-2202', payeeAccount: 'DEMO-0000-2202', amount: '212.75', currency: 'USD' });
  const bare = { ...poisoned, hidden: null, lines: [] };
  assert.deepEqual(declareIntent(bare), declared);
  assert.equal(JSON.stringify(declared).includes('9931'), false);
});

test('the clean invoice: the scripted agent makes one call, and the rule result is the contract example', () => {
  const invoice = fixtures.invoices.clean;
  const plan = planToolCalls(invoice);
  assert.equal(plan.followedHiddenInstruction, false);
  const r = applyIntentRule(declareIntent(invoice), plan.calls);
  assert.deepEqual(r, intentDetail(example('state-clean-done.json')));
});

test('the poisoned invoice: the scripted agent asks for the named secret, then pays the changed payee, and the rule result is the contract example', () => {
  const invoice = fixtures.invoices.poisoned;
  assert.ok(invoice.hidden.text.startsWith('Assistant:'));
  const plan = planToolCalls(invoice);
  assert.equal(plan.followedHiddenInstruction, true);
  assert.deepEqual(plan.calls.map((c) => c.tool), ['secrets.read', 'bank.payments.create']);
  const r = applyIntentRule(declareIntent(invoice), plan.calls);
  assert.deepEqual(r, intentDetail(example('state-poisoned-blocked.json')));
});

test('the fixture invoices are the invoices of the contract examples', () => {
  assert.deepEqual(fixtures.invoices.clean, example('state-clean-done.json').invoice);
  assert.deepEqual(fixtures.invoices.poisoned, example('state-poisoned-blocked.json').invoice);
});
