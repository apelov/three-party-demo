// The intent rule. A rule, not a model: it compares values for equality and
// nothing else. It reads no file, makes no call and keeps no state, so the
// same inputs always give the same result.
//
// The declared intent is built from the invoice's structured fields before
// the agent reads the invoice body, so nothing the body says can change it.
// Each tool call the agent then makes is held against that declared intent:
//   - a call for a tool no declared intent names has no declared intent, and
//     is blocked;
//   - a call for a declared intent must carry exactly the declared fields,
//     each with exactly the declared value. A field with another value, a
//     declared field the call leaves out and an argument the intent does not
//     declare all count as differing;
//   - a declared intent covers one call. A second call for the same intent
//     has no declared intent left, and is blocked.

import { LABELS } from '../engine/labels.mjs';

export const RULE_TEXT = LABELS.intent.rule;
export const NO_DECLARED_INTENT = LABELS.intent.noDeclaredIntent;

// The tool that carries out each action an intent can declare.
export const TOOL_FOR_ACTION = Object.freeze({
  pay: 'bank.payments.create',
});

// The declared intent for paying one invoice. It reads the invoice's
// structured fields and never its lines or its hidden text.
export function declareIntent(invoice) {
  return {
    action: 'pay',
    invoiceId: invoice.invoiceId,
    payeeAccount: invoice.payTo.account,
    amount: invoice.amount,
    currency: invoice.currency,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The names of the fields that differ between a declared intent and a call's
// arguments: declared fields in their declared order, then any argument the
// intent does not declare, in the call's order. Values are equal when they
// are the same string; a number is never equal to a string that spells it.
function fieldsDiffering(declared, args) {
  const differing = [];
  const declaredFields = Object.keys(declared).filter((k) => k !== 'action');
  for (const field of declaredFields) {
    if (!Object.hasOwn(args, field) || typeof args[field] !== 'string' || args[field] !== declared[field]) differing.push(field);
  }
  for (const field of Object.keys(args)) {
    if (!declaredFields.includes(field)) differing.push(field);
  }
  return differing;
}

// Applies the rule to the agent's tool calls, in order.
//   declared: one declared intent, or an array of them
//   calls:    [{ tool, args }]
// Returns { rule, declared, calls, result }, where each call carries
// declaredFor (the action of the intent it was held against, or null), match
// and fieldsDiffering, and result is 'match', 'mismatch' (a call differs from
// its declared intent) or 'undeclared-call' (every held call matches, and a
// call has no declared intent).
export function applyIntentRule(declared, calls) {
  const intents = Array.isArray(declared) ? declared : [declared];
  for (const intent of intents) {
    if (!isPlainObject(intent) || !Object.hasOwn(TOOL_FOR_ACTION, intent.action)) throw new TypeError('a declared intent names an action this rule knows');
  }
  if (!Array.isArray(calls)) throw new TypeError('the tool calls are an array');
  const unused = intents.map((intent) => ({ intent, tool: TOOL_FOR_ACTION[intent.action] }));
  const checked = calls.map((call) => {
    const tool = String(call?.tool ?? '');
    const args = isPlainObject(call?.args) ? { ...call.args } : {};
    const at = unused.findIndex((u) => u.tool === tool);
    if (at === -1) {
      return { tool, args, declaredFor: null, match: false, fieldsDiffering: [NO_DECLARED_INTENT] };
    }
    const [{ intent }] = unused.splice(at, 1);
    const differing = fieldsDiffering(intent, args);
    return { tool, args, declaredFor: intent.action, match: differing.length === 0, fieldsDiffering: differing };
  });
  let result = 'match';
  if (checked.some((c) => c.declaredFor !== null && !c.match)) result = 'mismatch';
  else if (checked.some((c) => c.declaredFor === null)) result = 'undeclared-call';
  return {
    rule: RULE_TEXT,
    declared: Array.isArray(declared) ? intents.map((i) => ({ ...i })) : { ...declared },
    calls: checked,
    result,
  };
}

// Whether the rule's result lets the calls go ahead.
export function intentAllows(ruleResult) {
  return ruleResult.result === 'match';
}
