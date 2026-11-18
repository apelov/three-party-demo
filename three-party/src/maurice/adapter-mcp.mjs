// The enforcement adapter as a local STDIO MCP server, so a Maurice agent
// can call it by tool name and no other bank route is exposed to the agent.
// This process is the adapter: a separate component from Maurice, and it says
// so in its serverInfo. MCP over stdio is newline-delimited JSON-RPC 2.0.
//
// Configuration comes from the ADAPTER_CONFIG environment variable: the path
// of a JSON file { repoRoot, tasksDir, runsDir, bankUrl } written by the slice
// harness before the server is installed on the agent. The bank URL is the
// front listener of bank-server.mjs on 127.0.0.1.
//
// Tools:
//   proposals_create_v1  { runId, taskId, proposal }
//       -> the adapter's Decision for the proposal, with the proposal's
//          SHA-256 when it is accepted (state awaiting-approval)
//   payments_execute_v1  { runId, taskId, idempotencyKey, proposal, authorization }
//       -> the adapter's Decision and the settlement outcome; a deny or
//          error answer is reported as an MCP error result, and a denied
//          call has made no bank settlement request
//
// Run it by hand:  ADAPTER_CONFIG=/path/config.json node adapter-mcp.mjs

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createAdapter, httpBankClient } from './adapter.mjs';
import { REPO_ROOT, DEFAULT_TASKS_DIR, DEFAULT_RUNS_DIR } from './bank-server.mjs';
import { createWimseSigner, identityFromKeyFiles } from './wimse.mjs';
import { beginEvidence, writeSliceActions, packageRun } from './aep.mjs';
import { offlineCheck } from '../record/check.mjs';
import { pinFileOf } from '../engine/records.mjs';

function loadConfig() {
  const spec = process.env.ADAPTER_CONFIG;
  if (!spec) throw new Error('ADAPTER_CONFIG names the adapter configuration file');
  const config = JSON.parse(fs.readFileSync(spec, 'utf8'));
  for (const key of ['bankUrl', 'runsDir']) {
    if (typeof config[key] !== 'string' || config[key] === '') throw new Error(`the adapter configuration carries no ${key}`);
  }
  return {
    repoRoot: config.repoRoot ?? REPO_ROOT,
    tasksDir: config.tasksDir ?? DEFAULT_TASKS_DIR,
    runsDir: config.runsDir ?? DEFAULT_RUNS_DIR,
    bankUrl: config.bankUrl,
    // optional WIMSE signing identity of the run (live slice): the private
    // key files live under the run dir, the audience is the bank's URL
    wimse: config.wimse ?? null,
  };
}

const TOOLS = [
  {
    name: 'proposals_create_v1',
    description: 'Validate a structured payment proposal against the trusted task and the AAP grant scope. Returns the decision; an accepted proposal is recorded as awaiting-approval, bound to the proposal SHA-256. A denied proposal is a recorded decision, not a tool error: the execution step still re-validates and refuses.',
    inputSchema: {
      type: 'object',
      required: ['runId', 'taskId', 'proposal'],
      properties: {
        runId: { type: 'string' },
        taskId: { type: 'string' },
        proposal: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'secrets_read_v1',
    description: 'Attempt one secret read by its synthetic name. No trusted task ever declares a secret read, so this always refuses; the refusal is recorded under the run and no secret value is ever returned, logged or written.',
    inputSchema: {
      type: 'object',
      required: ['runId', 'name'],
      properties: {
        runId: { type: 'string' },
        name: { type: 'string', description: 'Synthetic secret name only (lowercase letters, digits, dashes).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'evidence_package_v1',
    description: 'Package one run\'s artifacts as AEP records (the repository\'s existing format/verifier) and run the offline check over them. Signs the records with the run\'s test key (made here, deleted after the last signature), reads the bank ledger and WIMSE decision log read-only, and returns the manifest, the per-record hashes, the offline-check verdict with the verifier and pin sha256, and the run\'s event timeline for the presenter UI. Re-calling it for a packaged run re-runs the offline check only. This tool never writes a secret, token or signature value.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string', description: 'The run to package, or "latest" for the newest ui-* run under the configured runs directory.' },
        taskId: { type: 'string' },
        kind: { type: 'string', description: 'clean | poisoned-document (derived from the run when omitted)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'payments_execute_v1',
    description: 'Execute an authorized payment proposal at the mock bank under a stable idempotency key. This is the only bank execution route. Re-validates the proposal, task, grant scope and the authorization binding at execution time. A denied call makes no bank settlement request; a timeout is unknown, never a denial. The `approval` argument is the authorization artifact of the execution request.',
    inputSchema: {
      type: 'object',
      required: ['runId', 'taskId', 'idempotencyKey', 'proposal', 'approval'],
      properties: {
        runId: { type: 'string' },
        taskId: { type: 'string' },
        idempotencyKey: { type: 'string' },
        proposal: { type: 'object' },
        approval: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
];

async function main() {
  const config = loadConfig();
  let signer = null;
  if (config.wimse?.identityDir) {
    const identity = identityFromKeyFiles({ dir: config.wimse.identityDir, iss: config.wimse.iss, sub: config.wimse.sub });
    signer = createWimseSigner({ identity, audience: config.bankUrl });
  }
  const adapter = createAdapter({
    repoRoot: config.repoRoot,
    tasksDir: config.tasksDir,
    runsDir: config.runsDir,
    bankClient: httpBankClient(config.bankUrl),
    signer,
  });

  const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // Packages one run's evidence in this process (the run's test key is made
  // and deleted here), then re-reads the bank's ledger and WIMSE journal
  // read-only and returns all of it for the presenter UI. The decisions are
  // derived from the run's own durable records (events.jsonl, state.json) —
  // tool params render whole-object references as Go map strings, so the
  // run dir is the source of truth, not the template. Idempotent: a run
  // already packaged is only re-checked.
  const evidencePackage = async (rawArgs) => {
    let args = { ...rawArgs };
    if (args.runId === 'latest') {
      // the newest ui-* run under the configured runs directory
      const names = fs.readdirSync(config.runsDir).filter((n) => /^ui-/.test(n)).sort();
      if (names.length === 0) throw new Error('no ui-* run under the runs directory yet');
      args.runId = names.at(-1);
    }
    const runDir = adapter.runDirOf(args.runId);
    const ledger = await adapterBankLedger();
    const wimse = await adapterBankWimse();
    const events = fs.existsSync(path.join(runDir, 'events.jsonl'))
      ? fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const timeline = events.map((e) => ({ seq: e.sequence, step: e.type, producer: e.producer, at: e.at, reasonCode: e.reasonCode ?? null }));
    const state = fs.existsSync(path.join(runDir, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')) : {};
    const ev = (type) => events.find((e) => e.type === type);
    const proposed = ev('proposed') ?? ev('proposal-denied');
    const review = {
      decision: proposed?.decision ?? (proposed?.type === 'proposed' ? 'allow' : 'deny'),
      reasonCode: proposed?.reasonCode ?? null,
      proposalSha256: proposed?.artifacts?.proposalSha256 ?? null,
      comparedFields: proposed?.comparedFields ?? [],
      artifacts: proposed?.artifacts ?? {},
    };
    const secretReviews = events.filter((e) => e.type === 'secret-read-denied')
      .map((e) => ({ name: e.artifacts?.name ?? null, decision: 'deny', reasonCode: e.reasonCode ?? null }));
    const execEvent = ev('settled') ?? ev('execution-denied') ?? ev('execution-failed') ?? ev('bank-unanswered');
    const execution = {
      decision: state.decision ?? (execEvent?.type === 'settled' ? 'allow' : 'error'),
      reasonCode: state.reasonCode ?? execEvent?.reasonCode ?? null,
      state: state.state ?? null,
      paymentId: state.paymentId ?? null,
      artifacts: execEvent?.artifacts ?? { idempotencyKey: state.idempotencyKey ?? null },
    };
    const identity = config.wimse?.identityDir
      ? identityFromKeyFiles({ dir: config.wimse.identityDir, iss: config.wimse.iss, sub: config.wimse.sub })
      : null;
    // taskId and kind come from the run itself when the caller did not pass them
    const anyEvent = events[0] ?? {};
    const taskId = args.taskId ?? anyEvent.artifacts?.taskId ?? 'po-DEMO-INV-2201';
    const kind = args.kind ?? (/poisoned/.test(args.runId) ? 'poisoned-document' : 'clean');
    args = { ...args, taskId, kind };
    const manifestPath = path.join(runDir, 'records', 'manifest.json');
    let pkg;
    if (fs.existsSync(manifestPath)) {
      const check = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      pkg = {
        manifest: manifestPath, runId: args.runId,
        records: manifest.records, tampered: manifest.tampered,
        signerSha256: manifest.signerSha256, privateKeyDeletedAt: null, alreadyPackaged: true,
        check: {
          exitCode: check.exitCode, lines: check.lines, notes: check.notes,
          summary: check.result?.summary ?? null,
          verifierSha256: check.result?.verifier?.sha256 ?? null,
          pinSha256: check.result?.pinSha256 ?? null,
          networkDenied: check.result?.networkDenied ?? null,
          wroteResult: check.result !== null,
        },
      };
    } else {
      beginEvidence(runDir);
      writeSliceActions({
        runDir, runId: args.runId, kind: args.kind, taskId: args.taskId,
        proposal: null, review, secretReviews,
        execution, ledger: ledger.ledger ?? [], wimseDecisions: wimse.decisions ?? [],
        identity, clock: () => new Date(),
      });
      const written = await packageRun(runDir);
      pkg = { ...written, alreadyPackaged: false };
    }
    return {
      runId: args.runId,
      runDir,
      records: pkg.records,
      tampered: pkg.tampered,
      signerSha256: pkg.signerSha256 ?? null,
      alreadyPackaged: pkg.alreadyPackaged,
      check: pkg.check,
      events: timeline,
      ledgerRows: ledger.ledger?.length ?? null,
      wimse: {
        accepts: (wimse.decisions ?? []).filter((d) => d.decision === 'accept').length,
        rejects: (wimse.decisions ?? []).filter((d) => d.decision === 'reject').length,
        reasons: [...new Set((wimse.decisions ?? []).map((d) => d.reason))],
      },
      note: 'original wire signatures are never stored, only their sha256; the AEP records are collector-signed observations; events.jsonl and the bank wimse journal are unsigned logs',
    };
  };

  const adapterBank = httpBankClient(config.bankUrl);
  // Read-only bank views fail soft: the package must still be written when the
  // bank is unreachable (the run's own records are the evidence).
  const adapterBankLedger = async () => { try { return await adapterBank.ledger(); } catch { return { ok: false, ledger: [] }; } };
  const adapterBankWimse = async () => { try { return await adapterBank.wimseDecisions(); } catch { return { ok: false, decisions: [] }; } };

  const callTool = async (name, args) => {
    if (name === 'proposals_create_v1') return adapter.propose(args);
    if (name === 'secrets_read_v1') return adapter.readSecret(args);
    if (name === 'evidence_package_v1') return evidencePackage(args);
    if (name === 'payments_execute_v1') {
      // The tool argument is `approval`; the execution-request contract calls
      // the same artifact `authorization`.
      const { approval, ...rest } = args;
      return adapter.execute({ ...rest, authorization: approval });
    }
    throw new Error(`no tool ${name}`);
  };

  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'enforcement-adapter (separate from Maurice; the only bank execution route)', version: '1.0.0' },
        },
      });
      continue;
    }
    if (message.method === 'notifications/initialized' || message.id === undefined) continue;
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      continue;
    }
    if (message.method === 'tools/call') {
      try {
        const result = await callTool(message.params?.name, message.params?.arguments ?? {});
        // Only the bank execution route fails the step on a refusal; a denied
        // proposal or secret read is a recorded decision the workflow may
        // continue past (the execute step still refuses at execution time).
        const isError = message.params?.name === 'payments_execute_v1' && (result.decision === 'deny' || result.decision === 'error');
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError,
            structuredContent: result,
          },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true },
        });
      }
      continue;
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
  }
}

main().catch((err) => {
  process.stderr.write(`adapter-mcp: ${err?.message ?? err}\n`);
  process.exit(1);
});
