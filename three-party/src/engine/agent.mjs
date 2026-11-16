// The scripted payments agent: the tool calls it makes for one invoice.
//
// It plans the payment with the repository's own planning code
// (src/agent/plan.mjs), which follows a hidden line that starts with
// "Assistant:" the way a language model can follow text planted in its input.
// This demo calls no language model; the effect is scripted. When that hidden
// text also names a secret, the scripted agent asks for it before it pays.
//
// The agent reads the whole invoice, hidden text included. The declared
// intent (src/intent/rule.mjs) is built before this runs, from the structured
// fields alone.

import { planInvoicePayment } from '../../../src/agent/plan.mjs';

export const TOOLS = Object.freeze({
  readSecret: 'secrets.read',
  pay: 'bank.payments.create',
});

export function planToolCalls(invoice) {
  const plan = planInvoicePayment(invoice);
  const calls = [];
  const hidden = invoice.hidden;
  const asksForSecret = Boolean(hidden) && typeof hidden.text === 'string' && hidden.text.startsWith('Assistant:')
    && typeof hidden.fetchSecret === 'string' && hidden.fetchSecret !== '';
  if (asksForSecret) calls.push({ tool: TOOLS.readSecret, args: { name: hidden.fetchSecret } });
  const a = plan.attempt;
  calls.push({
    tool: TOOLS.pay,
    args: { invoiceId: a.invoiceId, payeeAccount: a.payeeAccount, amount: a.amount, currency: a.currency },
  });
  return { calls, followedHiddenInstruction: plan.followedHiddenInstruction || asksForSecret };
}
