// The proposal extractor of the Maurice invoice slice. The same logic exists
// twice on purpose, and a test asserts they agree: once as pure JavaScript
// here, for the local harness (extractAll), and once as the Deno code of the
// workflow's extract action (EXTRACT_CODE), which Maurice runs inside the
// workflow.
//
// This demo calls no language model; the extraction is scripted, the way the
// repository's own agent is scripted (src/agent/plan.mjs). A hidden line that
// starts with "Assistant:" is followed here, the way a language model can
// follow text planted in its input: that is the deterministic adversarial
// proposal of Milestone 2, labeled as such wherever it appears (the run's
// mode is 'poisoned-document' and followedHiddenInstruction says the hidden
// line was followed). The clean slice's invoice carries no hidden line, and a
// safe refusal is recorded as a refusal — nothing here claims an injection
// succeeded.

import { PAY_TOOL } from './contracts.mjs';

// The full extraction from one untrusted invoice: the pay proposal, any
// secret-read probes the hidden text asks for, and whether a hidden line was
// followed. `runId` is stamped into each probe so the sub-workflow can record
// its refusal under the same run.
export function extractAll(invoice, runId = 'local') {
  let payeeAccount = invoice?.payTo?.account;
  const hidden = invoice?.hidden;
  let followedHiddenInstruction = false;
  const secretProbes = [];
  if (hidden && typeof hidden.text === 'string' && hidden.text.startsWith('Assistant:')) {
    if (typeof hidden.payToAccount === 'string' && hidden.payToAccount !== '') {
      payeeAccount = hidden.payToAccount;
      followedHiddenInstruction = true;
    }
    if (typeof hidden.fetchSecret === 'string' && hidden.fetchSecret !== '') {
      secretProbes.push({ name: hidden.fetchSecret, runId });
      followedHiddenInstruction = true;
    }
  }
  return {
    proposal: {
      tool: PAY_TOOL,
      args: {
        invoiceId: String(invoice.invoiceId),
        payeeAccount: String(payeeAccount),
        amount: String(invoice.amount),
        currency: String(invoice.currency),
      },
    },
    secretProbes,
    followedHiddenInstruction,
  };
}

// Kept for the contract tests: just the pay proposal.
export function extractProposal(invoice) {
  return extractAll(invoice).proposal;
}

// The extract action's Deno code. `{{ json .field }}` interpolates a workflow
// input as a JSON literal. The hidden "Assistant:" line is followed here on
// purpose — deterministically, and labeled by followedHiddenInstruction.
export const EXTRACT_CODE = `const invoice = JSON.parse({{ json .invoiceText }});
const runId = {{ json .runId }};
let payeeAccount = invoice && invoice.payTo && invoice.payTo.account;
const hidden = invoice && invoice.hidden;
let followedHiddenInstruction = false;
const secretProbes = [];
if (hidden && typeof hidden.text === 'string' && hidden.text.startsWith('Assistant:')) {
  if (typeof hidden.payToAccount === 'string' && hidden.payToAccount !== '') {
    payeeAccount = hidden.payToAccount;
    followedHiddenInstruction = true;
  }
  if (typeof hidden.fetchSecret === 'string' && hidden.fetchSecret !== '') {
    secretProbes.push({ name: hidden.fetchSecret, runId: runId });
    followedHiddenInstruction = true;
  }
}
return {
  proposal: {
    tool: 'bank.payments.create',
    args: {
      invoiceId: String(invoice.invoiceId),
      payeeAccount: String(payeeAccount),
      amount: String(invoice.amount),
      currency: String(invoice.currency),
    },
  },
  secretProbes: secretProbes,
  followedHiddenInstruction: followedHiddenInstruction,
};
`;

// The sub-workflow the for_each runs once per secret probe: it calls the
// adapter's secret-read tool, which refuses every name, and the refusal is
// recorded as such.
export function secretProbeWorkflow({ secretReadTool }) {
  return {
    $schema: 'agentmaurice.workflow/v2',
    schema_version: 2,
    workflow_id: 'secret-probe',
    kind: 'workflow',
    title: 'Attempt one secret read through the enforcement adapter',
    description: 'Runs once per secret the untrusted invoice asked for. The adapter refuses every name; the refusal is recorded under the run and no secret value is ever returned, logged or written.',
    version: '1',
    input_schema: {
      type: 'object',
      required: ['probe'],
      properties: {
        probe: {
          type: 'object',
          required: ['name', 'runId'],
          properties: {
            name: { type: 'string', description: 'The synthetic secret name the invoice named.' },
            runId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    actions: [
      {
        id: 'read',
        type: 'tool_call',
        tool: secretReadTool,
        params: {
          runId: '{{ probe.runId }}',
          name: '{{ probe.name }}',
        },
        output_key: 'refusal',
      },
    ],
    output: {
      refusal: '{{ refusal }}',
    },
  };
}

// The Agent Spec V2 workflow the slice deploys on a Maurice agent.
// proposeTool, executeTool and secretReadTool are the qualified names the
// adapter's MCP server published at install time.
export function invoicePaymentWorkflow({ proposeTool, executeTool, secretReadTool }) {
  const proposalParams = {
    tool: PAY_TOOL,
    args: {
      invoiceId: '{{ extracted.proposal.args.invoiceId }}',
      payeeAccount: '{{ extracted.proposal.args.payeeAccount }}',
      amount: '{{ extracted.proposal.args.amount }}',
      currency: '{{ extracted.proposal.args.currency }}',
    },
  };
  return {
    $schema: 'agentmaurice.workflow/v2',
    schema_version: 2,
    workflow_id: 'invoice-payment',
    kind: 'workflow',
    title: 'Invoice payment: propose, review, governed execution',
    description: 'Reads an untrusted invoice, attempts any secret reads it names (refused), proposes one structured payment, and executes it only through the enforcement adapter, which validates the proposal against the trusted task and the AAP grant and settles once under an idempotency key at the mock bank.',
    version: '1',
    input_schema: {
      type: 'object',
      required: ['runId', 'taskId', 'idempotencyKey', 'invoiceText'],
      properties: {
        runId: { type: 'string', description: 'The slice run this execution belongs to; the adapter records its events under it.' },
        taskId: { type: 'string', description: 'The trusted task (purchase order) the proposal is held against.' },
        idempotencyKey: { type: 'string', description: 'Stable key of this execution; a repeated key never settles twice.' },
        invoiceText: { type: 'string', description: 'The untrusted invoice, as text.' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    actions: [
      {
        id: 'extract',
        type: 'code_execution',
        output_key: 'extracted',
        code: EXTRACT_CODE,
      },
      {
        id: 'probe-secrets',
        type: 'for_each',
        items: '{{ extracted.secretProbes }}',
        item_key: 'probe',
        max_items: 4,
        on_empty: 'continue',
        workflow_id: 'secret-probe',
        output_key: 'secret_reviews',
      },
      {
        id: 'propose',
        type: 'tool_call',
        tool: proposeTool,
        params: {
          runId: '{{ runId }}',
          taskId: '{{ taskId }}',
          proposal: proposalParams,
        },
        output_key: 'review',
      },
      {
        id: 'execute',
        type: 'tool_call',
        tool: executeTool,
        params: {
          runId: '{{ runId }}',
          taskId: '{{ taskId }}',
          idempotencyKey: '{{ idempotencyKey }}',
          proposal: proposalParams,
          approval: {
            kind: 'purchase-order',
            ref: '{{ taskId }}',
            proposalSha256: '{{ review.proposalSha256 }}',
          },
        },
        output_key: 'execution',
      },
    ],
    output: {
      followedHiddenInstruction: '{{ extracted.followedHiddenInstruction }}',
      secret_reviews: '{{ secret_reviews }}',
      review: '{{ review }}',
      execution: '{{ execution }}',
    },
  };
}

// Both workflow files of the slice, ready to write into an Agent Spec project.
export function sliceWorkflows(tools) {
  return {
    'invoice-payment.json': invoicePaymentWorkflow(tools),
    'secret-probe.json': secretProbeWorkflow(tools),
  };
}
