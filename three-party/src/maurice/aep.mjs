// Milestone 4: map the slice run's artifacts onto the repository's EXISTING
// AEP format and verifier (three-party/src/record, three-party/src/verifier)
// — the writer, the manifest, the tampered copy and the offline check are
// used as they are, not extended.
//
// What a slice run adds under its run directory:
//
//   actions/NN-<step>.action.json + actions/NN-<step>.response.txt
//     one action per run step — propose, each secret-read probe, execute,
//     settlement (the bank outcome) and, with WIMSE on, the bank's wimse-gate
//     decision — in the CONTRACT.md section 5 shape the writer reads. The
//     response body is the exact canonical JSON of the artifact, so the task,
//     proposal (by SHA-256), decision and bank outcome are all linked into
//     the signed record.
//   keys/test-signer.pub.pem + keys/TEST-KEY.txt + <runsDir>.pins/<runId>.pub.pem
//     the run's test signer key and pin, made by beginEvidence at run start.
//   records/NN-<step>.aep + records/tampered/ + records/manifest.json
//     written by packageRun through the tree's own recordWriter.
//   offline-check.json
//     written by the offline check itself: the verifier's sha256, the pin's
//     sha256, the network-denial measurement, and one verdict per record.
//
// The three kinds of evidence stay distinguishable:
//   - original signed messages (the WIT and the RFC 9421 signature on the
//     wire) are never stored; the run keeps only their SHA-256, in the
//     wimse-signer events and the bank journal;
//   - collector-signed observations: the AEP records, signed by the run's
//     test key, each binding one action's exact response bytes;
//   - unsigned logs: events.jsonl and bank/wimse-decisions.jsonl, the latter
//     labeled 'unsigned decision log, not signed evidence'.
//
// Offline verification (offlineCheck) checks the supported signatures and
// commitments without contacting Maurice. The trust anchors it uses are the
// pin (the run's public signer key, captured at run start and held outside
// the run directory) and the verifier file itself (its sha256 is printed and
// recorded). What it cannot prove offline: format steps 7 to 10 (receipt,
// second signature, timestamp — the verifier says so in its notes), and that
// no alternative request ever reached the bank — absence of settlement is
// shown only by the instrumented mock bank's ledger within the test scope.

import fs from 'node:fs';
import path from 'node:path';
import { writeAction } from '../engine/store.mjs';
import { recordWriter, pinFileOf } from '../engine/records.mjs';
import { offlineCheck } from '../record/check.mjs';
import { LABELS } from '../engine/labels.mjs';
import { canonicalJson, sha256Hex, REASONS } from './contracts.mjs';

// Makes the run's test signer key and captures its pin (held outside the run
// directory). Call once when the run starts, in the same process that later
// calls packageRun: the key handle stays in memory and is deleted by the
// writer when the last record is signed.
export function beginEvidence(runDir) {
  return recordWriter.begin(runDir);
}

const DOMAIN_AGENT = LABELS.domains.agent;
const DOMAIN_BANK = LABELS.domains.bank;

// Writes the slice's action files under the run directory. Each step's
// response body is the exact canonical JSON of its artifact, so the record
// the writer signs links the task, the proposal (by SHA-256), the decision
// and the bank outcome. Returns the action paths written.
export function writeSliceActions({
  runDir, runId, kind, taskId, proposal, review, secretReviews = [], execution, ledger = [], wimseDecisions = null, identity = null, clock = () => new Date(),
}) {
  const actor = {
    did: identity?.sub ?? `slice-agent:${runId}`,
    role: LABELS.agentRole,
    // public material only: the hash of the run's workload public JWK
    credentialSha256: sha256Hex(canonicalJson(identity ? identity.workload.publicJwk : { runId })),
  };
  const at = () => clock().toISOString();
  fs.mkdirSync(path.join(runDir, 'actions'), { recursive: true });
  const actions = [];
  const add = (step, { body, decision, reason, status, domainFrom = DOMAIN_AGENT, domainTo = DOMAIN_AGENT, toolCall = null }) => {
    const seq = actions.length + 1;
    if (typeof reason !== 'string' || reason === '') reason = 'recorded'; // the contract requires a string
    if (typeof decision !== 'string' || decision === '') decision = 'recorded';
    const rel = writeAction(runDir, {
      runId,
      seq,
      step,
      kind,
      at: at(),
      actor,
      domainFrom,
      domainTo,
      toolCall,
      decision,
      reason,
      responseStatus: status,
      responseBody: canonicalJson(body),
    });
    actions.push(rel);
    return rel;
  };

  // 1. the proposal decision, bound to the proposal's SHA-256 and the task
  add('propose', {
    body: { runId, taskId, kind, ...review },
    decision: review.decision,
    reason: review.reasonCode,
    status: review.decision === 'allow' ? 200 : 403,
    toolCall: proposal,
  });

  // 2. each secret-read probe, refused by name only
  for (const secretReview of secretReviews) {
    add('secret-read', {
      body: { runId, taskId, kind, ...secretReview },
      decision: 'deny',
      reason: secretReview.reasonCode,
      status: 403,
    });
  }

  // 3. the execution decision, re-validated at execution time
  add('execute', {
    body: { runId, taskId, kind, ...execution },
    decision: execution.decision,
    reason: execution.reasonCode,
    status: execution.state === 'settled' ? 200 : (execution.state === 'unknown' ? 504 : 403),
    toolCall: proposal,
  });

  // 4. the bank outcome: the ledger row that proves settlement, or the refusal
  const settled = execution.state === 'settled' && ledger.length === 1;
  add('settlement', {
    body: {
      runId, taskId, kind, idempotencyKey: execution.artifacts?.idempotencyKey ?? null,
      paymentId: execution.paymentId ?? null, ledgerRows: ledger.length, ledgerRow: ledger[0] ?? null,
    },
    decision: settled ? 'allow' : 'deny',
    reason: settled ? REASONS.SETTLED : (execution.reasonCode ?? 'not-settled'),
    status: settled ? 200 : 403,
    domainFrom: DOMAIN_AGENT,
    domainTo: DOMAIN_BANK,
  });

  // 5. the bank's WIMSE gate decision, when the run had WIMSE on: a
  // collector-signed observation of the bank's UNSIGNED log (hashes only)
  if (wimseDecisions) {
    const accepts = wimseDecisions.filter((d) => d.decision === 'accept');
    add('wimse-gate', {
      body: {
        runId, taskId, kind,
        note: 'observation of the unsigned bank decision log (bank/wimse-decisions.jsonl, "unsigned decision log, not signed evidence"); this record is signed by the run key, the log entry itself is not; hashes only, never a token or signature value',
        entries: wimseDecisions,
      },
      decision: accepts.length === wimseDecisions.length && wimseDecisions.length > 0 ? 'allow' : 'deny',
      reason: wimseDecisions.map((d) => d.reason).join(',') || 'no-wimse-decisions',
      status: accepts.length === wimseDecisions.length ? 200 : 401,
      domainFrom: DOMAIN_AGENT,
      domainTo: DOMAIN_BANK,
    });
  }

  return actions;
}

// Writes the AEP records (one per action, plus the tampered copy and the
// manifest) through the tree's own recordWriter — which deletes the run's
// private test key once the last record is signed — then runs the offline
// check over the run directory with its pin. Returns what both produced.
export async function packageRun(runDir) {
  const written = recordWriter.writeRun(runDir);
  const check = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
  return {
    manifest: written.manifest,
    runId: written.runId,
    records: written.records.map((r) => ({ file: r.file, sha256: r.sha256 })),
    tampered: written.tampered.map((t) => ({ file: t.file, sha256: t.sha256 })),
    signerSha256: written.signerSha256,
    privateKeyDeletedAt: written.privateKeyDeletedAt,
    check: {
      exitCode: check.exitCode,
      lines: check.lines,
      notes: check.notes,
      summary: check.result?.summary ?? null,
      verifierSha256: check.result?.verifier?.sha256 ?? null,
      pinSha256: check.result?.pinSha256 ?? null,
      networkDenied: check.result?.networkDenied ?? null,
      wroteResult: check.result !== null,
    },
  };
}
