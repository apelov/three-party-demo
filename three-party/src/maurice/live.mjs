// The live slice: the same clean invoice processed by a real Maurice One
// instance. The harness drives the public MauriceCLI contract end to end:
//
//   1. start the mock bank server (bank-server.mjs) and write the adapter
//      configuration it reads (ADAPTER_CONFIG)
//   2. maurice test setup --fresh --save=false      -> an isolated test Agent
//   3. maurice spec init                             -> an Agent Spec V2 project
//   4. maurice test mcp install --wait               -> the adapter's tools,
//                                                      the only bank route on the Agent
//   5. write the invoice-payment Workflow with those tool names, spec check,
//      git commit, maurice spec deploy --tests auto  -> verified deployment
//   6. maurice test workflow call invoice-payment    -> the real run, twice with
//      the same input, to prove the idempotency key settles once
//   7. maurice workflow execution events             -> the execution journal,
//                                                      saved beside the adapter's events
//   8. maurice test cleanup                         -> the test Agent removed
//
// Nothing here assumes Maurice is a WIMSE gateway: the WIMSE inbound check on
// the executions route is Maurice's own relying-party behavior (see
// `maurice wimse status`), and this slice authenticates as the local operator
// through the CLI's test path. The original replay demo is untouched and
// stays labeled in its own UI.
//
// Requires the maurice binary and a running local One instance. The caller
// passes the binary path; the instance comes from the CLI's own context.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter, httpBankClient } from './adapter.mjs';
import { startBankServer, REPO_ROOT, DEFAULT_TASKS_DIR, DEFAULT_RUNS_DIR } from './bank-server.mjs';
import { sliceWorkflows, extractAll } from './extract.mjs';
import { TASK_OF_KIND, MODE_OF_KIND, loadInvoice } from './run-slice.mjs';
import { compactStamp, writeJsonAtomic } from '../engine/store.mjs';
import { createDemoIdentity, writePrivateKeyFile, wimseKeysDirOf } from './wimse.mjs';
import { beginEvidence, writeSliceActions, packageRun } from './aep.mjs';

const MAURICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The MCP definition's command allowlist is npx/uvx/go/docker, so the adapter
// is packaged as a local package the runtime launches with npx.
const ADAPTER_MCP_PACKAGE = path.join(MAURICE_DIR, 'src', 'maurice', 'mcp-package');

// Runs one command line and resolves with { code, stdout, stderr, json }.
export function runCli(command, args, { cwd = REPO_ROOT, env = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ code, timedOut, stdout, stderr, json });
    });
  });
}

export function maurice(mauriceBin, args, options = {}) {
  return runCli(mauriceBin, args, options);
}

// Extracts the qualified tool names the adapter's MCP published, from the
// tools/list shape the install command returns.
export function adapterToolNames(installJson) {
  const tools = installJson?.tools ?? installJson?.published_tools ?? [];
  const list = Array.isArray(tools) ? tools : [];
  const names = list.map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
  const propose = names.find((n) => n.includes('proposals_create_v1'));
  const execute = names.find((n) => n.includes('payments_execute_v1'));
  const secretRead = names.find((n) => n.includes('secrets_read_v1'));
  if (!propose || !execute || !secretRead) throw new Error(`the adapter's tools did not publish: ${JSON.stringify(list)}`);
  return { proposeTool: propose, executeTool: execute, secretReadTool: secretRead };
}

// Runs the live slice. Returns a summary with the run directory, both Maurice
// executions, the adapter's state and events, and the bank ledger.
export async function runSliceLive({
  kind = 'clean',
  mauriceBin = 'maurice',
  deploymentName = `maurice-invoice-slice-${Date.now().toString(36)}`,
  repoRoot = REPO_ROOT,
  tasksDir = DEFAULT_TASKS_DIR,
  runsDir = DEFAULT_RUNS_DIR,
  clock = () => new Date(),
  timeoutMs = 3000,
} = {}) {
  const id = `slice-${compactStamp(clock())}-${Math.random().toString(16).slice(2, 8)}`;
  const runDir = path.join(runsDir, id);
  const specDir = path.join(runDir, 'spec');
  fs.mkdirSync(specDir, { recursive: true });

  // The run's WIMSE identity: fresh keys per run. The private halves live in
  // a mode-0600 directory OUTSIDE the run dir (the run dir is the evidence
  // package's scope and must hold no private key); the bank trusts the
  // public JWKS, the adapter's MCP process loads the private halves from the
  // outside dir, and the run dir keeps only the public JWKS as evidence.
  const wimseIss = 'https://slice-issuer.example';
  const wimseSub = `wimse://slice.local/agent/${id}`;
  const identity = createDemoIdentity({ iss: wimseIss, sub: wimseSub });
  const keysDir = wimseKeysDirOf(runsDir, id);
  writePrivateKeyFile(path.join(keysDir, 'issuer.key.json'), identity.issuer);
  writePrivateKeyFile(path.join(keysDir, 'workload.key.json'), identity.workload);
  const identityDir = keysDir;
  fs.mkdirSync(path.join(runDir, 'identity'), { recursive: true });
  writeJsonAtomic(path.join(runDir, 'identity', 'jwks.json'), identity.jwks);

  // The run's AEP test signer key and pin (Milestone 4), made in this
  // process; the records are signed when the run ends.
  const evidence = beginEvidence(runDir);

  const server = await startBankServer({
    repoRoot,
    clock,
    runDir,
    wimse: { jwks: identity.jwks, trustedIssuers: identity.trustedIssuers, expectedSub: wimseSub },
  });
  const steps = [];
  const note = (name, ok, detail = null) => { steps.push({ name, ok, detail }); };

  let agentId = null;
  let agentName = null;
  try {
    // 1-2. adapter configuration and the isolated test Agent.
    const adapterConfig = {
      repoRoot,
      tasksDir,
      runsDir,
      bankUrl: server.url,
      wimse: { identityDir, iss: wimseIss, sub: wimseSub },
    };
    const configPath = path.join(runDir, 'adapter-config.json');
    writeJsonAtomic(configPath, adapterConfig);

    let r = await maurice(mauriceBin, ['test', 'setup', '--fresh', '--save=false', '--deployment-name', deploymentName, '--json']);
    if (r.code !== 0 || !r.json?.agent_id) throw new Error(`test setup failed: ${r.stdout} ${r.stderr}`);
    agentId = r.json.agent_id;
    agentName = r.json.agent_name ?? r.json.name ?? null;
    note('test setup', true, agentId);

    // 3. the Agent Spec project.
    r = await maurice(mauriceBin, ['spec', 'init', '--env', 'local', '--agent-alias', 'slice', '--agent-id', agentId, '--dir', specDir, '--json']);
    if (r.code !== 0) throw new Error(`spec init failed: ${r.stdout} ${r.stderr}`);
    note('spec init', true);

    // 4. install the adapter MCP and wait for its tools.
    const mcpDir = path.join(runDir, 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const mcpDef = {
      name: 'enforcement-adapter',
      command: 'npx',
      arguments: ['-y', ADAPTER_MCP_PACKAGE],
      env: [`ADAPTER_CONFIG=${configPath}`],
    };
    const mcpDefPath = path.join(mcpDir, 'enforcement-adapter.json');
    writeJsonAtomic(mcpDefPath, mcpDef);
    r = await maurice(mauriceBin, ['test', 'mcp', 'install', '--agent-id', agentId, '--file', mcpDefPath, '--wait', '--json'], { timeoutMs: 240000 });
    writeJsonAtomic(path.join(runDir, 'mcp-install.json'), { code: r.code, stdout: r.json ?? r.stdout, stderr: r.stderr });
    if (r.code !== 0) throw new Error(`mcp install failed: ${r.stdout} ${r.stderr}`);
    const tools = adapterToolNames(r.json);
    note('mcp install', true, tools);

    // 5. the Workflows, spec check, git commit, deploy.
    const workflows = sliceWorkflows(tools);
    const workflowsDir = path.join(specDir, 'agents', 'slice', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    for (const [name, wf] of Object.entries(workflows)) writeJsonAtomic(path.join(workflowsDir, name), wf);
    writeJsonAtomic(path.join(runDir, 'workflows-written.json'), workflows);

    r = await maurice(mauriceBin, ['spec', 'check', '--env', 'local', '--agent-alias', 'slice', '--dir', specDir, '--json']);
    if (r.code !== 0) throw new Error(`spec check failed: ${r.stdout} ${r.stderr}`);
    note('spec check', true);

    await runCli('git', ['init'], { cwd: specDir });
    await runCli('git', ['add', '-A'], { cwd: specDir });
    await runCli('git', ['-c', 'user.email=slice@demo.local', '-c', 'user.name=slice', 'commit', '-m', 'invoice-payment workflow (slice)'], { cwd: specDir });

    r = await maurice(mauriceBin, ['spec', 'deploy', '--env', 'local', '--agent-alias', 'slice', '--dir', specDir, '--tests', 'auto', '--json'], { timeoutMs: 240000 });
    writeJsonAtomic(path.join(runDir, 'spec-deploy.json'), { code: r.code, stdout: r.json ?? r.stdout, stderr: r.stderr });
    const verified = (v) => {
      if (v && typeof v === 'object') return v.verified === true || Object.values(v).some(verified);
      return false;
    };
    if (r.code !== 0 || !verified(r.json)) throw new Error(`spec deploy failed or unverified: ${r.stdout} ${r.stderr}`);
    note('spec deploy', true);

    // 6. the real runs: the same input twice, to prove the key settles once
    // (clean) or is denied every time (poisoned).
    const taskId = TASK_OF_KIND[kind];
    const mode = MODE_OF_KIND[kind] ?? kind;
    const invoice = loadInvoice(repoRoot, kind);
    const idempotencyKey = `${id}:${taskId}`;
    writeJsonAtomic(path.join(runDir, 'meta.json'), {
      mode,
      provenance: mode === 'poisoned-document'
        ? 'poisoned invoice document; the hidden "Assistant:" line is followed deterministically by the extractor (deterministic adversarial proposal); enforcement is deterministic, no model was called'
        : 'clean invoice document',
    });
    const input = { runId: id, taskId, idempotencyKey, invoiceText: JSON.stringify(invoice) };
    const inputPath = path.join(runDir, 'input.json');
    writeJsonAtomic(inputPath, input);

    const executions = [];
    for (let n = 1; n <= 2; n += 1) {
      r = await maurice(mauriceBin, ['test', 'workflow', 'call', 'invoice-payment', '--agent-id', agentId, '--input-file', inputPath, '--json'], { timeoutMs: 240000 });
      writeJsonAtomic(path.join(runDir, `maurice-execution-${n}.json`), { code: r.code, stdout: r.json ?? r.stdout, stderr: r.stderr });
      // A denied execution is a business failure: the CLI exits nonzero and
      // the execution sits in the error envelope's details.
      const execution = r.json?.execution ?? r.json?.error?.details?.execution;
      if (!execution) throw new Error(`workflow call ${n} returned no execution: ${r.stdout} ${r.stderr}`);
      // A denied execution is a business failure: the CLI exits nonzero with
      // the execution in the payload. That is the honest result of a poisoned
      // run, not a harness error.
      executions.push({ n, code: r.code, executionId: execution.execution_id, state: execution.state, data: execution.data, traceId: execution.trace_id });
      note(`workflow call ${n}`, true, `${execution.state} (exit ${r.code})`);

      // 7. the execution journal of this run.
      const ev = await maurice(mauriceBin, ['workflow', 'execution', 'events', execution.execution_id, '--agent', agentId, '--json'], { timeoutMs: 120000 });
      writeJsonAtomic(path.join(runDir, `maurice-events-${n}.json`), { code: ev.code, stdout: ev.json ?? ev.stdout });
    }

    // The adapter's own records and the bank's ledger.
    const eventsPath = path.join(runDir, 'events.jsonl');
    const events = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    const ledger = (await (await fetch(`${server.url}/v1/ledger`)).json()).ledger;
    const wimseDecisions = (await (await fetch(`${server.url}/v1/wimse-decisions`)).json()).decisions;

    // Milestone 4: the run's artifacts as AEP records, then the offline check.
    // The proposal is reconstructed deterministically (the extractor is
    // deterministic, no model); the decisions come from the adapter's durable
    // events and final state, which the run dir already carries.
    const extracted = extractAll(invoice, id);
    const ev = (type) => events.find((e) => e.type === type);
    const proposed = ev('proposed') ?? ev('proposal-denied');
    const review = proposed
      ? { decision: proposed.decision ?? (proposed.type === 'proposed' ? 'allow' : 'deny'), reasonCode: proposed.reasonCode ?? null, proposalSha256: proposed.artifacts?.proposalSha256 ?? null, comparedFields: proposed.comparedFields ?? [], artifacts: proposed.artifacts ?? {} }
      : { decision: 'error', reasonCode: 'no-proposal-event', proposalSha256: null, comparedFields: [], artifacts: {} };
    const secretReviews = events.filter((e) => e.type === 'secret-read-denied').map((e) => ({ name: e.artifacts?.name ?? null, decision: 'deny', reasonCode: e.reasonCode ?? null }));
    const execEvent = ev('settled') ?? ev('execution-denied') ?? ev('execution-failed') ?? ev('bank-unanswered');
    const execution = {
      decision: state.decision ?? (execEvent?.type === 'settled' ? 'allow' : 'error'),
      reasonCode: state.reasonCode ?? execEvent?.reasonCode ?? null,
      state: state.state,
      paymentId: state.paymentId ?? null,
      artifacts: execEvent?.artifacts ?? { idempotencyKey },
    };
    writeSliceActions({
      runDir, runId: id, kind: mode, taskId, proposal: extracted.proposal, review, secretReviews, execution,
      ledger, wimseDecisions, identity, clock,
    });
    const aep = await packageRun(runDir);

    writeJsonAtomic(path.join(runDir, 'summary.json'), { runId: id, mode, steps, executions, state, ledgerRows: ledger.length, wimseAccepts: wimseDecisions.filter((d) => d.decision === 'accept').length, aepCheckExit: aep.check.exitCode });
    return { runId: id, runDir, mode, steps, executions, state, events, ledger, wimseDecisions, wimseEvidence: { iss: wimseIss, sub: wimseSub, jwks: identity.jwks }, evidencePin: evidence.pinFile, aep };
  } catch (err) {
    // Keep the run directory and the bank record when a step fails, so the
    // failure can be inspected; attach the run directory to the error.
    err.runDir = runDir;
    try {
      writeJsonAtomic(path.join(runDir, 'summary.json'), { runId: id, steps, error: String(err?.message ?? err) });
    } catch { /* the run directory may not exist yet */ }
    throw err;
  } finally {
    if (agentId) {
      const c = await maurice(mauriceBin, ['test', 'cleanup', '--agent-id', agentId, ...(agentName ? ['--expect-name', agentName] : []), '--apply', '--json'], { timeoutMs: 180000 });
      note('test cleanup', c.code === 0, c.json ?? c.stdout);
    }
    await server.stop();
    fs.rmSync(keysDir, { recursive: true, force: true }); // the WIMSE private keys leave with the run
  }
}
