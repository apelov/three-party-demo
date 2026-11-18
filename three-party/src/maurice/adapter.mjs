// The enforcement adapter of the Maurice invoice slice: the only route from
// a Maurice workflow to the mock bank. It is a separate component from
// Maurice, and it never claims to be Maurice. Deterministic policy runs here,
// outside any model's discretion:
//
//   propose   holds the proposal against the trusted task (the intent rule of
//             three-party/src/intent/rule.mjs, with the declared intent built
//             from the trusted purchase-order fixture, never from invoice
//             text) and against the AAP grant's scope (checkGrantScope over the
//             bank's consent terms). An accepted proposal is recorded as
//             awaiting-approval, bound to the SHA-256 of its canonical form.
//   execute   re-validates everything at execution time, checks the
//             authorization binds the exact proposal (same SHA-256) and the
//             same task, then submits to the bank under a stable idempotency
//             key. A repeated key answers from the bank's record and never
//             settles again; a repeated key with different details is denied.
//             A timeout after submission is recorded as 'unknown', never as a
//             denial, and a retry with the same key does not pay again.
//
// Every transition appends one Event to the run's events.jsonl and rewrites
// its state.json, so proposed, awaiting-approval, authorized, submitted,
// settled, denied, failed and unknown are all distinguishable on disk.
//
// The adapter talks to the bank only through the bank client it is given
// (bank-server.mjs over loopback HTTP in the live slice). A denied call makes
// no bank settlement request: the bank is called only after every check
// allows.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { applyIntentRule } from '../intent/rule.mjs';
import { checkGrantScope } from '../engine/checks.mjs';
import { consentTerms as bankConsentTerms, PERMISSION } from '../engine/bank.mjs';
import { parseCents } from '../../../src/bank/money.mjs';
import { refusingResolver } from '../../../src/bank/broker.mjs';
import { writeJsonAtomic } from '../engine/store.mjs';
import {
  REASONS, STATES, SECRET_TOOL, validateTask, validateProposal, validateAuthorization, validateExecutionRequest,
  declaredIntentFromTask, taskExpired, proposalSha256, canonicalJson, sha256Hex,
} from './contracts.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

// ---- the bank client: loopback HTTP to bank-server.mjs

export function httpBankClient(bankUrl, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const call = (method, pathname, { headers = {}, body = null, raw = null } = {}) => new Promise((resolve, reject) => {
    const url = new URL(pathname, bankUrl);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method, headers, timeout: timeoutMs, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (raw !== null) req.end(raw);
    else if (body !== null) req.end(JSON.stringify(body));
    else req.end();
  });
  return {
    url: bankUrl,
    async issueGrant() {
      const res = await call('POST', '/v1/grants');
      if (res.status !== 201 || !res.json?.grantRef) return { ok: false, refusal: res.json?.refusal ?? `grant-status-${res.status}` };
      return { ok: true, grantRef: res.json.grantRef, expiresAt: res.json.expiresAt };
    },
    // pay({ grantRef, body, raw, headers }) — `raw` is sent byte-for-byte
    // (a WIMSE signer signs exactly those bytes); `headers` are merged over
    // the defaults, so a signed request carries its WIT, digest, txn-token
    // and RFC 9421 signature headers.
    async pay({ grantRef, body = null, raw = null, headers = {} }) {
      const payload = raw ?? (body !== null ? JSON.stringify(body) : null);
      return call('POST', '/v1/payments', {
        headers: { 'x-grant-ref': grantRef, ...(payload !== null ? { 'content-type': 'application/json' } : {}), ...headers },
        raw: payload,
      });
    },
    async idempotency(key) {
      const res = await call('GET', `/v1/idempotency/${encodeURIComponent(key)}`);
      return res.status === 200 ? { found: true, ...res.json } : { found: false };
    },
    // Read-only bank views for the evidence/UI surface (never a write route).
    async ledger() {
      const res = await call('GET', '/v1/ledger');
      return res.status === 200 ? { ok: true, ledger: res.json.ledger } : { ok: false, status: res.status };
    },
    async wimseDecisions() {
      const res = await call('GET', '/v1/wimse-decisions');
      return res.status === 200 ? { ok: true, decisions: res.json.decisions } : { ok: false, status: res.status };
    },
  };
}

// ---- the run's persisted state and events

function loadRunState(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---- the adapter

// createAdapter({ repoRoot, tasksDir, runsDir, bankClient, clock, signer })
//   tasksDir   the adapter's own trusted store of task fixtures
//   runsDir    where run directories live; each run gets runsDir/<runId>
//   bankClient what httpBankClient returns
//   clock      returns a Date
//   signer     optional wimse.mjs createWimseSigner result; when present, the
//              payment POST carries a fresh WIT + RFC 9421 signature per
//              attempt (producer 'wimse-signer'), and the evidence — hashes
//              and claims only — is journaled in the run's events
export function createAdapter({ repoRoot, tasksDir, runsDir, bankClient, clock = () => new Date(), signer = null }) {
  const sequences = new Map(); // runId -> last event sequence

  const loadTask = (taskId) => {
    let raw;
    try {
      raw = fs.readFileSync(path.join(tasksDir, `${taskId}.task.json`), 'utf8');
    } catch {
      return { task: null, problem: REASONS.TASK_UNKNOWN };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { task: null, problem: REASONS.TASK_INVALID };
    }
    const task = parsed?.task ?? null;
    const problem = validateTask(task);
    if (problem) return { task: null, problem: REASONS.TASK_INVALID };
    return { task, problem: null, taskSha256: sha256Hex(raw) };
  };

  const runDirOf = (runId) => {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/i.test(runId)) throw new Error(`bad runId ${JSON.stringify(runId)}`);
    return path.join(runsDir, runId);
  };

  // The run's provenance label, written by the harness at run start
  // (meta.json: { mode, provenance }). Events and state carry it, so the
  // interface and the evidence say which mode produced them.
  const runMeta = (runId) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(runDirOf(runId), 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const emit = (runId, producer, type, artifacts = {}, extra = {}) => {
    const runDir = runDirOf(runId);
    fs.mkdirSync(runDir, { recursive: true });
    const seq = (sequences.get(runId) ?? 0) + 1;
    sequences.set(runId, seq);
    const meta = runMeta(runId);
    const event = {
      runId,
      eventId: `${runId}-${seq}`,
      producer,
      sequence: seq,
      at: clock().toISOString(),
      type,
      mode: meta?.mode ?? null,
      artifacts,
      ...extra,
    };
    fs.appendFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    return event;
  };

  const setState = (runId, patch) => {
    const runDir = runDirOf(runId);
    fs.mkdirSync(runDir, { recursive: true });
    const meta = runMeta(runId);
    const state = {
      ...(loadRunState(runDir) ?? { runId, createdAt: clock().toISOString() }),
      ...(meta?.mode ? { mode: meta.mode } : {}),
      ...patch,
      runId,
      updatedAt: clock().toISOString(),
    };
    writeJsonAtomic(path.join(runDir, 'state.json'), state);
    return state;
  };

  // The deterministic checks every proposal and every execution passes
  // through. Returns { decision } where decision is null when everything
  // allows, else a deny Decision. `now` is the execution-time clock.
  const enforce = ({ task, taskSha256, proposal, now, consentTerms }) => {
    if (taskExpired(task, now)) {
      return { decision: deny(REASONS.TASK_EXPIRED, [{ field: 'expiresAt', expected: task.expiresAt, actual: now.toISOString(), result: 'differ' }], { taskSha256 }), compared: null, ruled: null };
    }
    const declared = declaredIntentFromTask(task);
    // The intent rule compares the declared fields for exact equality; the
    // amount, when the task fixes it exactly, is one of them.
    const argsForRule = { ...proposal.args };
    if (!Object.hasOwn(declared, 'amount')) delete argsForRule.amount;
    const ruled = applyIntentRule(declared, [{ tool: proposal.tool, args: argsForRule }]);
    const call = ruled.calls[0];
    const compared = [
      ...Object.keys(declared).filter((k) => k !== 'action').map((field) => ({
        field,
        expected: String(declared[field]),
        actual: String(proposal.args[field] ?? null),
        result: call.fieldsDiffering.includes(field) ? 'differ' : 'match',
      })),
      ...(!Object.hasOwn(declared, 'amount') ? [{
        field: 'amount',
        expected: `<= ${task.amountCap.amount} ${task.amountCap.currency}`,
        actual: `${proposal.args.amount} ${proposal.args.currency}`,
        result: proposal.args.currency === task.amountCap.currency && parseCents(proposal.args.amount) <= parseCents(task.amountCap.amount) ? 'match' : 'differ',
      }] : []),
    ];
    if (call.declaredFor === null) return { decision: deny(REASONS.INTENT_UNDECLARED_CALL, compared, { taskSha256, ruled: ruled.result }), compared, ruled };
    if (!call.match) return { decision: deny(REASONS.INTENT_MISMATCH, compared, { taskSha256, ruled: ruled.result, fieldsDiffering: call.fieldsDiffering }), compared, ruled };
    if (proposal.args.currency !== task.amountCap.currency) {
      return { decision: deny(REASONS.CURRENCY_MISMATCH, compared, { taskSha256 }), compared, ruled };
    }
    if (parseCents(proposal.args.amount) > parseCents(task.amountCap.amount)) {
      return { decision: deny(REASONS.AMOUNT_OVER_TASK_CAP, compared, { taskSha256 }), compared, ruled };
    }
    const scope = checkGrantScope({
      terms: consentTerms,
      permission: PERMISSION,
      declared: { payeeAccount: proposal.args.payeeAccount, amount: proposal.args.amount, currency: proposal.args.currency },
      now,
    });
    if (!scope.ok) {
      return { decision: deny(`${REASONS.GRANT_SCOPE}:${scope.refusal}`, compared, { taskSha256, scopeChecked: scope.scopeChecked, failing: scope.failing }), compared, ruled };
    }
    return { decision: null, compared, ruled };
  };

  const deny = (reasonCode, comparedFields, artifacts) => ({
    decision: 'deny',
    reasonCode,
    comparedFields,
    artifacts: { ...artifacts },
  });

  // The consent terms the grant scope is checked against: the same terms the
  // bank-server approved for the demo agent's consent.
  const loadConsentTerms = () => {
    const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, 'three-party', 'fixtures', 'invoices.json'), 'utf8'));
    return bankConsentTerms(fixtures.consent.addedCreditorAccounts);
  };

  // ---- propose

  // propose({ runId, taskId, proposal }) -> Decision & { state, proposalSha256 }
  const propose = async ({ runId, taskId, proposal }) => {
    const now = clock();
    const proposalProblem = validateProposal(proposal);
    const { task, problem, taskSha256 } = loadTask(taskId);
    const artifacts = { taskId, taskSha256: taskSha256 ?? null, proposalSha256: proposalProblem ? null : proposalSha256(proposal), mode: runMeta(runId)?.mode ?? null };
    let decision;
    if (proposalProblem) decision = deny(REASONS.PROPOSAL_INVALID, [], artifacts);
    else if (problem) decision = deny(problem, [], artifacts);
    else {
      const enforced = enforce({ task, taskSha256, proposal, now, consentTerms: loadConsentTerms() });
      decision = enforced.decision ?? {
        decision: 'allow',
        reasonCode: REASONS.PROPOSAL_MATCHES_TASK,
        comparedFields: enforced.compared,
        artifacts,
      };
    }
    const sha = artifacts.proposalSha256;
    if (decision.decision === 'allow') {
      setState(runId, { taskId, state: 'awaiting-approval', proposalSha256: sha, decision: 'allow', reasonCode: decision.reasonCode });
      emit(runId, 'enforcement-adapter', 'proposed', { proposalSha256: sha, taskId }, { state: 'awaiting-approval', decision: decision.decision, reasonCode: decision.reasonCode });
    } else {
      setState(runId, { taskId, state: 'denied', decision: decision.decision, reasonCode: decision.reasonCode });
      emit(runId, 'enforcement-adapter', 'proposal-denied', { proposalSha256: sha, taskId }, { state: 'denied', decision: decision.decision, reasonCode: decision.reasonCode, comparedFields: decision.comparedFields });
    }
    return { ...decision, state: decision.decision === 'allow' ? 'awaiting-approval' : 'denied', proposalSha256: sha };
  };

  // ---- execute

  // execute({ runId, taskId, idempotencyKey, proposal, authorization })
  // -> Decision & { state, paymentId? }
  const execute = async (request) => {
    const now = clock();
    const requestProblem = validateExecutionRequest(request);
    const { runId, taskId, idempotencyKey, proposal, authorization } = request;
    const { task, problem, taskSha256 } = loadTask(taskId);
    const sha = requestProblem ? null : proposalSha256(proposal);
    const artifacts = { taskId, taskSha256: taskSha256 ?? null, proposalSha256: sha, idempotencyKey, mode: runMeta(runId)?.mode ?? null };

    const fail = (decision, state) => {
      setState(runId, { taskId, state, decision: decision.decision, reasonCode: decision.reasonCode, idempotencyKey, proposalSha256: sha });
      emit(runId, 'enforcement-adapter', state === 'denied' ? 'execution-denied' : 'execution-failed', artifacts, { state, decision: decision.decision, reasonCode: decision.reasonCode, comparedFields: decision.comparedFields });
      return { ...decision, state, paymentId: null };
    };

    if (requestProblem) {
      const reasonCode = validateAuthorization(request.authorization) ? REASONS.APPROVAL_MISSING : REASONS.PROPOSAL_INVALID;
      return fail(deny(reasonCode, [], artifacts), 'denied');
    }
    if (problem) return fail(deny(problem, [], artifacts), 'denied');

    // Re-validate at execution time, not only at proposal time.
    const enforced = enforce({ task, taskSha256, proposal, now, consentTerms: loadConsentTerms() });
    if (enforced.decision) return fail(enforced.decision, 'denied');

    // The authorization must bind the exact proposal and the same task.
    const authProblem = validateAuthorization(authorization);
    if (authProblem) return fail(deny(REASONS.APPROVAL_MISSING, enforced.compared, artifacts), 'denied');
    if (authorization.kind !== 'purchase-order' && authorization.kind !== 'human-approval') {
      return fail(deny(REASONS.APPROVAL_WRONG_KIND, enforced.compared, artifacts), 'denied');
    }
    if (authorization.ref !== task.provenance.ref && authorization.ref !== taskId) {
      return fail(deny(REASONS.APPROVAL_WRONG_TASK, enforced.compared, artifacts), 'denied');
    }
    if (authorization.proposalSha256 !== sha) {
      return fail(deny(REASONS.APPROVAL_NOT_BOUND, enforced.compared, artifacts), 'denied');
    }
    const runState = loadRunState(runDirOf(runId));
    if (runState?.proposalSha256 && runState.proposalSha256 !== sha) {
      return fail(deny(REASONS.APPROVAL_NOT_BOUND, enforced.compared, artifacts), 'denied');
    }

    setState(runId, { taskId, state: 'authorized', decision: 'allow', reasonCode: REASONS.PROPOSAL_MATCHES_TASK, idempotencyKey, proposalSha256: sha });
    emit(runId, 'enforcement-adapter', 'authorized', artifacts, { state: 'authorized' });

    // The bank's own idempotency record answers first: a repeated key never
    // reaches the payment API again.
    let replay;
    try {
      replay = await bankClient.idempotency(idempotencyKey);
    } catch {
      return fail(deny(REASONS.BANK_UNREACHABLE, enforced.compared, artifacts), 'failed');
    }
    const detailsSha = sha256Hex(canonicalJson({
      creditorAccount: proposal.args.payeeAccount, amount: proposal.args.amount, currency: proposal.args.currency,
    }));
    if (replay.found) {
      if (replay.detailsSha256 && replay.detailsSha256 !== detailsSha) {
        return fail(deny(REASONS.IDEMPOTENCY_KEY_REUSED, enforced.compared, artifacts), 'denied');
      }
      if (replay.state === 'settled') {
        setState(runId, { state: 'settled', paymentId: replay.paymentId, decision: 'allow', reasonCode: REASONS.IDEMPOTENT_REPLAY });
        emit(runId, 'enforcement-adapter', 'settled', { ...artifacts, paymentId: replay.paymentId }, { state: 'settled', reasonCode: REASONS.IDEMPOTENT_REPLAY });
        return { decision: 'allow', reasonCode: REASONS.IDEMPOTENT_REPLAY, comparedFields: enforced.compared, artifacts, state: 'settled', paymentId: replay.paymentId };
      }
      if (replay.state === 'refused') {
        return fail(deny(`${REASONS.BANK_REFUSED}:${replay.status ?? 'recorded'}`, enforced.compared, { ...artifacts, bankStatus: replay.status ?? null }), 'denied');
      }
      // 'submitted' and still in flight: unknown, not a denial; the retry
      // answers from the record once the bank has answered.
      setState(runId, { state: 'unknown', decision: 'error', reasonCode: REASONS.BANK_TIMEOUT });
      emit(runId, 'enforcement-adapter', 'bank-unanswered', artifacts, { state: 'unknown', decision: 'error', reasonCode: REASONS.BANK_TIMEOUT });
      return { decision: 'error', reasonCode: REASONS.BANK_TIMEOUT, comparedFields: enforced.compared, artifacts, state: 'unknown', paymentId: null };
    }

    // Issue a grant at the bank and submit the payment under the key.
    setState(runId, { state: 'submitted' });
    emit(runId, 'enforcement-adapter', 'submitted', artifacts, { state: 'submitted' });
    const grant = await bankClient.issueGrant();
    if (!grant.ok) return fail(deny(`${REASONS.GRANT_MISSING}:${grant.refusal}`, enforced.compared, artifacts), 'denied');
    const payBody = {
      creditorAccount: proposal.args.payeeAccount,
      amount: { amount: proposal.args.amount, currency: proposal.args.currency },
      idempotencyKey,
    };
    const raw = JSON.stringify(payBody);
    let answer;
    try {
      let signedHeaders = {};
      if (signer) {
        // A fresh WIT (fresh jti) per attempt: a retry under the same
        // idempotency key stays a safe idempotent retry, while a
        // byte-identical replay is refused by the bank's jti store.
        const signed = signer.sign({ method: 'POST', url: `${bankClient.url}/v1/payments`, body: raw });
        signedHeaders = signed.headers;
        emit(runId, 'wimse-signer', 'request-signed', { idempotencyKey }, { wimse: signed.evidence });
      }
      answer = await bankClient.pay({ grantRef: grant.grantRef, raw, headers: signedHeaders });
    } catch (err) {
      // A timeout after submission is unknown, not a denial, and the retry
      // with the same key answers from the bank's record.
      const reasonCode = /timeout/i.test(String(err?.message ?? err)) ? REASONS.BANK_TIMEOUT : REASONS.BANK_UNREACHABLE;
      setState(runId, { state: 'unknown', decision: 'error', reasonCode });
      emit(runId, 'enforcement-adapter', 'bank-unanswered', artifacts, { state: 'unknown', decision: 'error', reasonCode });
      return { decision: 'error', reasonCode, comparedFields: enforced.compared, artifacts, state: 'unknown', paymentId: null };
    }
    if (answer.status === 409 && answer.json?.reason === 'idempotency-key-reused-with-different-details') {
      return fail(deny(REASONS.IDEMPOTENCY_KEY_REUSED, enforced.compared, artifacts), 'denied');
    }
    const accepted = answer.status === 200 && answer.json?.status === 'accepted' && typeof answer.json.paymentId === 'string';
    if (!accepted) {
      return fail(deny(`${REASONS.BANK_REFUSED}:${answer.json?.reason ?? answer.status}`, enforced.compared, { ...artifacts, bankStatus: answer.status, bankReason: answer.json?.reason ?? null }), 'denied');
    }
    const paymentId = answer.json.paymentId;
    setState(runId, { state: 'settled', paymentId, decision: 'allow', reasonCode: REASONS.SETTLED });
    emit(runId, 'enforcement-adapter', 'settled', { ...artifacts, paymentId }, { state: 'settled', reasonCode: REASONS.SETTLED });
    emit(runId, 'bank', 'ledger-row', { paymentId, idempotencyKey }, { state: 'settled' });
    return { decision: 'allow', reasonCode: REASONS.SETTLED, comparedFields: enforced.compared, artifacts, state: 'settled', paymentId };
  };

  // ---- readSecret

  // A secret read is never declared by any trusted task, so it is always
  // denied as an undeclared call; the bank's refusing resolver is also put to
  // the synthetic name, which refuses every name. What is recorded is the
  // name and the refusal — never a value. Only synthetic names (lowercase
  // letters, digits, dashes) are accepted by validateProposal, and no real
  // credential can enter an event or receipt through this path.
  const readSecret = async ({ runId, name }) => {
    const proposal = { tool: SECRET_TOOL, args: { name: String(name ?? '') } };
    const problem = validateProposal(proposal);
    const artifacts = { name: problem ? String(name ?? '') : proposal.args.name };
    let resolver = null;
    if (!problem) {
      const exists = await refusingResolver.exists(proposal.args.name);
      const value = await refusingResolver.resolve(proposal.args.name);
      resolver = { asked: true, exists, resolved: value !== undefined, refused: exists === false && value === undefined };
    }
    const reasonCode = problem ? REASONS.PROPOSAL_INVALID : REASONS.SECRET_READ_UNDECLARED;
    const decision = {
      decision: 'deny',
      reasonCode: problem ? REASONS.PROPOSAL_INVALID : (resolver?.refused ? `${REASONS.SECRET_READ_UNDECLARED}:${REASONS.SECRET_READ_REFUSED}` : REASONS.SECRET_READ_UNDECLARED),
      comparedFields: [{ field: 'tool', expected: 'a tool a trusted task declares', actual: SECRET_TOOL, result: 'not-declared' }],
      artifacts: { ...artifacts, resolver },
    };
    // The refusal is evidence in the event log; the run's payment state machine
    // is not clobbered by a probe.
    const prior = loadRunState(runDirOf(runId));
    setState(runId, { secretReads: [...(prior?.secretReads ?? []), { name: artifacts.name, reasonCode: decision.reasonCode, refused: resolver?.refused ?? null }] });
    emit(runId, 'enforcement-adapter', 'secret-read-denied', artifacts, { decision: 'deny', reasonCode: decision.reasonCode, resolver });
    return { ...decision, state: 'denied' };
  };

  return { propose, execute, readSecret, loadTask, runDirOf, loadRunState };
}

export { STATES };
