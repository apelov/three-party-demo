// Milestone 5: the MiniApp and its wrapper workflow, declared in the Agent
// Spec V2 project next to the slice workflows, so the presenter runs the
// clean, poisoned and adversarial cases from the One home viewer.
//
//   run-slice-ui (workflow)  input { kind: clean|poisoned } — a code step
//     builds the run's inputs deterministically (runId, taskId, idempotency
//     key, the synthetic invoice text of the chosen case — no model call),
//     calls the existing invoice-payment workflow synchronously, then calls
//     the adapter's evidence_package_v1 tool, which packages the run's
//     artifacts as AEP records and runs the offline check. The output
//     carries everything the MiniApp binds to: review, execution, events,
//     evidence and measured start/end times.
//   invoice-payment (miniapp)  two buttons — run clean, run poisoned — each
//     firing one event that calls run-slice-ui and puts the whole result in
//     state.run. The layout shows the trusted-vs-extracted comparison table,
//     the event timeline, the decision and outcome, the WIMSE gate counts,
//     and the evidence package (records, hashes, offline-check verdict, run
//     directory to download from). Waiting/error/unknown are states of the
//     same bindings; nothing shows success before execution.state=settled.

import { loadInvoice } from './run-slice.mjs';
import { REPO_ROOT } from './bank-server.mjs';

// The wrapper workflow. invoices maps kind -> the synthetic invoice object
// (from the repo fixtures); the code step embeds them as JSON literals.
export function uiWorkflow({ packageTool, invoices }) {
  const prepareCode = `const kind = {{ json .kind }};
const invoices = ${JSON.stringify(invoices)};
const invoice = invoices[kind];
if (!invoice) throw new Error('unknown kind ' + kind);
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[^0-9A-Za-z]/g, '');
const runId = 'ui-' + kind + '-' + stamp;
const taskId = 'po-DEMO-INV-2201';
return {
  runId: runId,
  taskId: taskId,
  idempotencyKey: runId + ':' + taskId,
  invoiceText: JSON.stringify(invoice),
  kind: kind,
  mode: kind === 'poisoned' ? 'poisoned-document' : 'clean',
  startedAt: startedAt,
};
`;
  const finishCode = `return { endedAt: new Date().toISOString() };
`;
  return {
    $schema: 'agentmaurice.workflow/v2',
    schema_version: 2,
    workflow_id: 'run-slice-ui',
    kind: 'workflow',
    title: 'Run the invoice slice case from the MiniApp (deterministic; no model call)',
    description: 'Builds the run inputs for one case kind deterministically in a code step (no model call anywhere in this workflow), runs the invoice-payment workflow synchronously, then packages the run as AEP evidence and runs the offline check through the adapter. Measured start and end times are in the output.',
    version: '1',
    input_schema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['clean', 'poisoned'], description: 'The case to run: the clean invoice, or the poisoned document (the hidden line is followed deterministically by the extractor and labeled).' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    actions: [
      { id: 'prepare', type: 'code_execution', output_key: 'prepared', code: prepareCode },
      {
        id: 'run',
        type: 'workflow_call',
        workflow_id: 'invoice-payment',
        execution: 'sync',
        timeout_ms: 180000,
        input: {
          runId: '{{ prepared.runId }}',
          taskId: '{{ prepared.taskId }}',
          idempotencyKey: '{{ prepared.idempotencyKey }}',
          invoiceText: '{{ prepared.invoiceText }}',
        },
        output_key: 'run',
      },
      {
        id: 'package',
        type: 'tool_call',
        tool: packageTool,
        // scalars only: object template references stringify in tool params,
        // so the tool derives the decisions from the run's own records
        params: {
          runId: '{{ prepared.runId }}',
          taskId: '{{ prepared.taskId }}',
          kind: '{{ prepared.mode }}',
        },
        output_key: 'evidence',
      },
      { id: 'finish', type: 'code_execution', output_key: 'timing', code: finishCode },
    ],
    output: {
      kind: '{{ prepared.kind }}',
      runId: '{{ prepared.runId }}',
      startedAt: '{{ prepared.startedAt }}',
      endedAt: '{{ timing.endedAt }}',
      followedHiddenInstruction: '{{ run.data.followedHiddenInstruction }}',
      secretReviews: '{{ run.data.secret_reviews }}',
      review: '{{ run.data.review }}',
      execution: '{{ run.data.execution }}',
      evidence: '{{ evidence }}',
    },
  };
}

// The verification workflow behind the MiniApp's third button: packages and
// offline-checks the newest ui-* run — this is how a DENIED run gets its
// evidence package too, since the wrapper workflow ends at the denial (a
// refusal is a business failure, not a harness error).
export function verifyLastRunWorkflow({ packageTool }) {
  return {
    $schema: 'agentmaurice.workflow/v2',
    schema_version: 2,
    workflow_id: 'verify-last-run',
    kind: 'workflow',
    title: 'Package and offline-verify the latest slice run',
    description: 'Calls the adapter\'s evidence_package_v1 with runId "latest": the tool finds the newest ui-* run under the runs directory, derives the task and case kind from the run\'s own records, signs its actions as AEP records with the run\'s test key and runs the offline check. Deterministic; no model call.',
    version: '1',
    input_schema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string', description: 'Pass "latest" to verify the newest ui-* run.' },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'object' },
    actions: [
      {
        id: 'package',
        type: 'tool_call',
        tool: packageTool,
        params: { runId: '{{ runId }}' },
        output_key: 'evidence',
      },
    ],
    output: {
      packagedRunId: '{{ evidence.runId }}',
      evidence: '{{ evidence }}',
    },
  };
}

export function uiWorkflows(tools, { repoRoot = REPO_ROOT } = {}) {
  return {
    'run-slice-ui.json': uiWorkflow({
      packageTool: tools.packageTool,
      invoices: { clean: loadInvoice(repoRoot, 'clean'), poisoned: loadInvoice(repoRoot, 'poisoned') },
    }),
    'verify-last-run.json': verifyLastRunWorkflow({ packageTool: tools.packageTool }),
  };
}

// The MiniApp itself. Two buttons fire the two events; both put the whole
// workflow result at state.run, and every panel binds into run.*.
export function sliceMiniapp() {
  return {
    $schema: 'agentmaurice.miniapp/v2',
    schema_version: 2,
    miniapp_id: 'invoice-payment-demo',
    kind: 'miniapp',
    title: 'Invoice payment — Maurice slice',
    description: 'Runs the invoice-payment slice cases through a real deployed Workflow: deterministic extraction and policy enforcement (no model call), a WIMSE-signed payment at the mock bank, and an AEP evidence package verified offline.',
    version: '1',
    ui: {
      renderer: 'component',
      component: 'invoice-payment-demo',
      configuration: {
        layout: [
          {
            type: 'section',
            title: 'Invoice payment (Maurice slice)',
            children: [
              {
                type: 'text',
                value: 'Deterministic workflow steps only — this workflow makes no model call. The enforcement adapter (separate from Maurice) holds the policy; the bank verifies a live WIMSE authority on the payment request before the grant check. Choose a case:',
              },
              {
                type: 'action_bar',
                actions: [
                  { type: 'button', label: 'Run clean invoice', on_click: 'run-clean' },
                  { type: 'button', label: 'Run poisoned document', on_click: 'run-poisoned' },
                  { type: 'button', label: 'Package & verify latest run offline', on_click: 'verify-evidence' },
                ],
              },
              { type: 'callout', tone: 'info', value: { state: 'status' } },
              { type: 'stat', label: 'Case mode', value: { state: 'run.kind' } },
              { type: 'stat', label: 'Run started (measured)', value: { state: 'run.startedAt' } },
              { type: 'stat', label: 'Run ended (measured)', value: { state: 'run.endedAt' } },
            ],
          },
          {
            type: 'section',
            title: 'Trusted task vs extracted proposal',
            children: [
              {
                type: 'table',
                columns: ['field', 'expected', 'actual', 'result'],
                rows: { state: 'run.review.comparedFields' },
              },
              { type: 'callout', tone: 'warning', value: { state: 'run.kind' } },
            ],
          },
          {
            type: 'section',
            title: 'Timeline (adapter events)',
            children: [
              {
                type: 'table',
                columns: ['seq', 'step', 'producer', 'at', 'reasonCode'],
                rows: { state: 'run.evidence.events' },
              },
            ],
          },
          {
            type: 'section',
            title: 'Decision and outcome',
            children: [
              { type: 'stat', label: 'Proposal decision', value: { state: 'run.review.decision' } },
              { type: 'stat', label: 'Proposal reason', value: { state: 'run.review.reasonCode' } },
              { type: 'stat', label: 'Execution state', value: { state: 'run.execution.state' } },
              { type: 'stat', label: 'Payment id', value: { state: 'run.execution.paymentId' } },
              { type: 'stat', label: 'Hidden instruction followed', value: { state: 'run.followedHiddenInstruction' } },
              { type: 'stat', label: 'Bank ledger rows', value: { state: 'run.evidence.ledgerRows' } },
            ],
          },
          {
            type: 'section',
            title: 'WIMSE gate at the bank (unsigned log; hashes only)',
            children: [
              { type: 'stat', label: 'Accepted signed requests', value: { state: 'run.evidence.wimse.accepts' } },
              { type: 'stat', label: 'Rejected presentations', value: { state: 'run.evidence.wimse.rejects' } },
            ],
          },
          {
            type: 'section',
            title: 'Offline verification of the latest run (works for denied runs too)',
            children: [
              { type: 'stat', label: 'Packaged run', value: { state: 'verify.packagedRunId' } },
              { type: 'stat', label: 'Offline check exit code', value: { state: 'verify.evidence.check.exitCode' } },
              { type: 'stat', label: 'Records passed (steps 1-6)', value: { state: 'verify.evidence.check.summary.pass' } },
              { type: 'stat', label: 'Tampered copies rejected', value: { state: 'verify.evidence.check.summary.reject' } },
              { type: 'stat', label: 'Pin sha256', value: { state: 'verify.evidence.check.pinSha256' } },
            ],
          },
          {
            type: 'section',
            title: 'Evidence package (AEP records, verified offline)',
            children: [
              { type: 'stat', label: 'Offline check exit code', value: { state: 'run.evidence.check.exitCode' } },
              { type: 'stat', label: 'Records passed (steps 1-6)', value: { state: 'run.evidence.check.summary.pass' } },
              { type: 'stat', label: 'Tampered copies rejected', value: { state: 'run.evidence.check.summary.reject' } },
              { type: 'stat', label: 'Verifier sha256', value: { state: 'run.evidence.check.verifierSha256' } },
              { type: 'stat', label: 'Pin sha256', value: { state: 'run.evidence.check.pinSha256' } },
              { type: 'stat', label: 'Run directory (download the package here)', value: { state: 'run.evidence.runDir' } },
              { type: 'table', columns: ['file', 'sha256'], rows: { state: 'run.evidence.records' } },
              {
                type: 'text',
                value: 'The wire WIT and RFC 9421 signature are never stored, only their sha256. The AEP records are collector-signed observations (run test key); events.jsonl and the bank wimse journal are unsigned logs. Verify offline: node three-party/bin/offline-check.mjs <run directory>.',
              },
            ],
          },
        ],
      },
    },
    state_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        run: { type: 'object' },
        verify: { type: 'object' },
      },
    },
    // the bound paths exist from the start (empty), so the viewer renders the
    // initial state without missing-path errors
    initial_state: {
      status: 'idle — choose a case',
      run: {
        kind: '', startedAt: '', endedAt: '', followedHiddenInstruction: false,
        review: { decision: '', reasonCode: '', comparedFields: [] },
        execution: { state: '', paymentId: '', decision: '', reasonCode: '' },
        evidence: {
          runDir: '', ledgerRows: 0, events: [], records: [],
          wimse: { accepts: 0, rejects: 0 },
          check: { exitCode: null, summary: { pass: 0, reject: 0 }, verifierSha256: '', pinSha256: '' },
        },
      },
      verify: { packagedRunId: '', evidence: { check: { exitCode: null, summary: { pass: 0, reject: 0 }, pinSha256: '' } } },
    },
    events: [
      {
        event_id: 'run-clean',
        trigger: 'action.click',
        workflow: { workflow_id: 'run-slice-ui', input: { kind: 'clean' } },
        result_to_state: 'run',
      },
      {
        event_id: 'run-poisoned',
        trigger: 'action.click',
        workflow: { workflow_id: 'run-slice-ui', input: { kind: 'poisoned' } },
        result_to_state: 'run',
      },
      {
        event_id: 'verify-evidence',
        trigger: 'action.click',
        workflow: { workflow_id: 'verify-last-run', input: { runId: 'latest' } },
        result_to_state: 'verify',
      },
    ],
  };
}
