// The clean vertical slice, run locally (no Maurice): trusted task setup,
// proposal, enforcement adapter and the mock bank server, end to end, with
// the run's state and events on disk. This is the same path the Maurice
// workflow drives through the adapter's MCP tools; the live variant is
// live.mjs.
//
// Usage: node three-party/src/maurice/run-slice.mjs [--kind clean] [--runs-dir <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { createAdapter, httpBankClient } from './adapter.mjs';
import { startBankServer, REPO_ROOT, DEFAULT_TASKS_DIR, DEFAULT_RUNS_DIR } from './bank-server.mjs';
import { extractAll } from './extract.mjs';
import { compactStamp, writeJsonAtomic } from '../engine/store.mjs';
import { createDemoIdentity, createWimseSigner, writePrivateKeyFile, wimseKeysDirOf } from './wimse.mjs';
import { beginEvidence, writeSliceActions, packageRun } from './aep.mjs';

// The trusted task of each slice kind: the purchase order of the invoice the
// kind names. The invoice itself is untrusted input. The mode label says which
// document the run was fed: 'clean', or 'poisoned-document' (the hidden text
// is followed deterministically by the extractor — the labeled deterministic
// adversarial proposal).
export const TASK_OF_KIND = Object.freeze({
  clean: 'po-DEMO-INV-2201',
  poisoned: 'po-DEMO-INV-2201',
});
export const MODE_OF_KIND = Object.freeze({
  clean: 'clean',
  poisoned: 'poisoned-document',
});

export function loadInvoice(repoRoot, kind) {
  const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, 'three-party', 'fixtures', 'invoices.json'), 'utf8'));
  return fixtures.invoices[kind];
}

// Runs one slice locally. Returns { runId, runDir, mode, extracted, secretReviews, review, execution, state, events, ledger, wimse }.
// `hangKeys` makes the bank settle but never answer those idempotency keys,
// to exercise the timeout path; `timeoutMs` is the adapter's bank timeout.
// `wimse` (default on) gives the run a fresh demo identity: the bank verifies
// a live WIT + RFC 9421 signature on every payment, the adapter signs each
// attempt with a fresh WIT, and the evidence on disk is hashes only.
export async function runSliceLocal({
  kind = 'clean',
  repoRoot = REPO_ROOT,
  tasksDir = DEFAULT_TASKS_DIR,
  runsDir = DEFAULT_RUNS_DIR,
  clock = () => new Date(),
  hangKeys = new Set(),
  timeoutMs = 3000,
  runId = null,
  wimse = true,
  aep = true,
} = {}) {
  const stamp = compactStamp(clock());
  const id = runId ?? `slice-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const runDir = path.join(runsDir, id);
  fs.mkdirSync(runDir, { recursive: true });

  // The run's AEP test signer key and pin (Milestone 4): made when the run
  // starts, in this process; the records are signed at the end.
  const evidence = aep ? beginEvidence(runDir) : null;

  // The run's WIMSE identity: fresh keys per run. The private halves live in
  // a mode-0600 directory OUTSIDE the run dir (the run dir is the evidence
  // package's scope and must hold no private key); only the public JWKS goes
  // into the run dir as the evidence the bank trusted.
  let identity = null;
  let signer = null;
  let keysDir = null;
  if (wimse) {
    identity = createDemoIdentity({
      iss: 'https://slice-issuer.example',
      sub: `wimse://slice.local/agent/${id}`,
    });
    keysDir = wimseKeysDirOf(runsDir, id);
    writePrivateKeyFile(path.join(keysDir, 'issuer.key.json'), identity.issuer);
    writePrivateKeyFile(path.join(keysDir, 'workload.key.json'), identity.workload);
    fs.mkdirSync(path.join(runDir, 'identity'), { recursive: true });
    writeJsonAtomic(path.join(runDir, 'identity', 'jwks.json'), identity.jwks);
  }

  const server = await startBankServer({
    repoRoot,
    clock,
    runDir,
    hangKeys,
    wimse: wimse ? { jwks: identity.jwks, trustedIssuers: identity.trustedIssuers, expectedSub: identity.sub } : null,
  });
  try {
    if (wimse) signer = createWimseSigner({ identity, audience: server.url });
    const adapter = createAdapter({
      repoRoot,
      tasksDir,
      runsDir,
      bankClient: httpBankClient(server.url, { timeoutMs }),
      clock,
      signer,
    });
    const taskId = TASK_OF_KIND[kind];
    const mode = MODE_OF_KIND[kind] ?? kind;
    const invoice = loadInvoice(repoRoot, kind);
    const idempotencyKey = `${id}:${taskId}`;
    const extracted = extractAll(invoice, id);
    const proposal = extracted.proposal;

    writeJsonAtomic(path.join(runDir, 'meta.json'), {
      mode,
      provenance: mode === 'poisoned-document'
        ? 'poisoned invoice document; the hidden "Assistant:" line is followed deterministically by the extractor (deterministic adversarial proposal); enforcement is deterministic, no model was called'
        : 'clean invoice document',
    });
    writeJsonAtomic(path.join(runDir, 'input.json'), {
      runId: id,
      taskId,
      idempotencyKey,
      kind,
      mode,
      invoiceText: JSON.stringify(invoice, null, 2),
      harness: 'local (no Maurice; the workflow steps drive the adapter directly)',
    });

    // The secret probes the invoice asked for, each refused and recorded.
    const secretReviews = [];
    for (const probe of extracted.secretProbes) {
      secretReviews.push(await adapter.readSecret({ runId: id, name: probe.name }));
    }
    writeJsonAtomic(path.join(runDir, 'secret-reviews.json'), secretReviews);

    const review = await adapter.propose({ runId: id, taskId, proposal });
    writeJsonAtomic(path.join(runDir, 'review.json'), review);
    // Execute is attempted even when the proposal was denied: enforcement is
    // re-validated at execution time, and the refusal is recorded there too.
    const execution = await adapter.execute({
      runId: id,
      taskId,
      idempotencyKey,
      proposal,
      authorization: { kind: 'purchase-order', ref: taskId, proposalSha256: review.proposalSha256 ?? '0'.repeat(64) },
    });
    writeJsonAtomic(path.join(runDir, 'execution.json'), execution);

    const events = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    const ledger = (await (await fetch(`${server.url}/v1/ledger`)).json()).ledger;
    const wimseDecisions = wimse ? (await (await fetch(`${server.url}/v1/wimse-decisions`)).json()).decisions : null;

    // Milestone 4: the run's artifacts as AEP records, then the offline check.
    let aepResult = null;
    if (aep) {
      writeSliceActions({
        runDir, runId: id, kind: mode, taskId, proposal, review, secretReviews, execution, ledger, wimseDecisions, identity, clock,
      });
      aepResult = await packageRun(runDir);
    }
    return {
      runId: id, runDir, mode, extracted, secretReviews, review, execution, state, events, ledger, bankUrl: server.url,
      wimseDecisions, wimseEvidence: identity ? { iss: identity.iss, sub: identity.sub, jwks: identity.jwks } : null,
      evidencePin: evidence?.pinFile ?? null, aep: aepResult,
    };
  } finally {
    await server.stop();
    if (keysDir) fs.rmSync(keysDir, { recursive: true, force: true }); // the WIMSE private keys leave with the run
  }
}

// CLI entry.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const kind = opt('--kind', 'clean');
  const runsDir = opt('--runs-dir', DEFAULT_RUNS_DIR);
  const result = await runSliceLocal({ kind, runsDir });
  console.log(JSON.stringify({
    runId: result.runId,
    runDir: result.runDir,
    mode: result.mode,
    followedHiddenInstruction: result.extracted.followedHiddenInstruction,
    secretReviews: result.secretReviews.map((s) => ({ decision: s.decision, reasonCode: s.reasonCode })),
    review: { decision: result.review.decision, reasonCode: result.review.reasonCode, state: result.review.state },
    execution: { decision: result.execution.decision, reasonCode: result.execution.reasonCode, state: result.execution.state, paymentId: result.execution.paymentId ?? null },
    ledgerRows: result.ledger.length,
    events: result.events.map((e) => `${e.producer}:${e.type}`),
  }, null, 2));
}
