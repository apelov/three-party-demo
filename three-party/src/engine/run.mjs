// One run of the three-party demo: the six steps of CONTRACT.md section 4,
// each a real local transaction against the repository's own bank, token
// service and broker code, paced so a viewer can follow it.
//
// Pacing. The run waits paceSeconds after it starts and after every step.
// A step that runs is marked running, waits a quarter of paceSeconds (two
// seconds at most) so the change can be seen, then runs its check and
// publishes the result at once. The checks themselves take milliseconds,
// except the grant, which starts the reference verifier as a child process.
// With paceSeconds 0 nothing waits.
//
// state.json is rewritten after every status change, whole and then renamed
// into place. A step's action file and hop file are written before the state
// that names them.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { AGENTS, GRANT_TTL_SECONDS } from '../../../src/config.mjs';
import { loadTrust, refusingResolver } from '../../../src/bank/broker.mjs';
import { parseCents } from '../../../src/bank/money.mjs';
import { crossDomains, hopFileContent } from '../crossing/hop.mjs';
import { applyIntentRule, declareIntent, intentAllows } from '../intent/rule.mjs';
import { TOOLS, planToolCalls } from './agent.mjs';
import { AGENT_ROLE, PAYMENTS_PATH, PERMISSION, consentTerms, startBank } from './bank.mjs';
import { checkCredential, checkGrantExpiry, checkGrantScope } from './checks.mjs';
import { grantIssuer } from './grant.mjs';
import { LABEL_MAP } from './label-map.mjs';
import { LABELS, fill, stepLabel } from './labels.mjs';
import { RUN_KINDS, actionPaths, createRunDir, sha256Hex, utcStamp, writeAction, writeJsonAtomic } from './store.mjs';
import { NO_RECORD_WRITER, intentBlockedSummary } from './text.mjs';

export { NO_RECORD_WRITER };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, 'three-party', 'runs');
export const RECORD_WRITER = path.join(REPO_ROOT, 'three-party', 'src', 'record', 'writer.mjs');
export const INVOICES_FILE = 'three-party/fixtures/invoices.json';

export const DEFAULT_PACE_SECONDS = 8;
// The grant lives GRANT_TTL_SECONDS, and three steps lie between its issue
// and its use. Above this pace it would expire before the payment.
export const MAX_PACE_SECONDS = 15;

// What each kind of run is expected to end as.
export const EXPECTED = Object.freeze({
  clean: Object.freeze({ outcome: 'paid', blockedAt: null }),
  poisoned: Object.freeze({ outcome: 'blocked', blockedAt: 'intent' }),
});

const ACTION_STEPS = Object.freeze(['credential', 'grant', 'crossing', 'intent', 'pay']);

const require = createRequire(import.meta.url);
const VERIFIER_NAME = `@opena2a/atx-verify ${require('@opena2a/atx-verify/package.json').version}`;

const realSleep = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

// The error a run ends on when its caller stops it.
export class RunStopped extends Error {
  constructor() {
    super('the run was stopped');
    this.name = 'RunStopped';
  }
}

// A promise that rejects when the run is stopped, so a wait in progress ends
// at once.
function stopSwitch() {
  let trigger;
  const stopped = new Promise((_, reject) => { trigger = reject; });
  stopped.catch(() => {});
  return { stopped, trigger: () => trigger(new RunStopped()) };
}

export function validPace(paceSeconds) {
  return typeof paceSeconds === 'number' && Number.isFinite(paceSeconds) && paceSeconds >= 0 && paceSeconds <= MAX_PACE_SECONDS;
}

export function loadFixtures(repoRoot = REPO_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, INVOICES_FILE), 'utf8'));
}

// The DID a credential file claims, read before any check, or null.
function claimedDid(bytes) {
  try {
    const did = JSON.parse(bytes.toString('utf8'))?.agentDid;
    return typeof did === 'string' ? did : null;
  } catch {
    return null;
  }
}

// The reason a run carries when the intent rule stops it.
export function intentReason(ruled) {
  const askedForSecret = ruled.calls.some((c) => c.tool === TOOLS.readSecret && c.declaredFor === null);
  const changedPayee = ruled.calls.some((c) => c.tool === TOOLS.pay && c.declaredFor !== null && c.fieldsDiffering.includes('payeeAccount'));
  const blocked = ruled.calls.filter((c) => !c.match);
  const exactlyThose = blocked.length === 2 && blocked.every((c) => (c.tool === TOOLS.readSecret && c.declaredFor === null)
    || (c.tool === TOOLS.pay && c.fieldsDiffering.length === 1 && c.fieldsDiffering[0] === 'payeeAccount'));
  if (askedForSecret && changedPayee && exactlyThose) return LABELS.intent.reasonSecretAndPayee;
  return fill(LABELS.intent.reasonOther, { what: intentBlockedSummary(ruled) || ruled.result });
}

// Starts a run and returns once its directory and its state.json exist:
//   { runId, runDir, state(), done, abort() }
// `done` resolves, and never rejects, with { state, error } when the run has
// finished; error is null unless the engine itself failed or the run was
// stopped. `abort()` stops the run where it is and resolves once the state
// on disk says so: the step in hand reads blocked with the refusal
// run-stopped, and no step is left running or pending.
//
// Options: kind ('clean' or 'poisoned'); paceSeconds; runsDir; repoRoot;
// clock (returns a Date; the bank's clock too); sleep (ms); onEvent, called
// with { type: 'step' | 'finished', at, step, state, note } as things happen
// (note is null, or NO_RECORD_WRITER on the record step's event when no
// record writer is in the tree);
// recordWriter ({ writeRun(runDir) }, null for none, or left out to use the
// module at recordWriterFile when that file exists; recordWriterFile is
// three-party/src/record/writer.mjs unless a test names another). A writer
// may also give begin(runDir), called when the run starts, and
// abandon(runDir), called when the run ends: the tree's own writer is used
// through records.mjs, which makes the run's test key in begin and deletes
// it in abandon when the record step was not reached; credentialFile
// (the agent's credential, a path under repoRoot or an absolute one); witness
// (an array a test passes to receive the access token values the bank
// issues).
export async function startRun({
  kind,
  paceSeconds = DEFAULT_PACE_SECONDS,
  runsDir = DEFAULT_RUNS_DIR,
  repoRoot = REPO_ROOT,
  clock = () => new Date(),
  sleep = realSleep,
  onEvent = null,
  recordWriter,
  recordWriterFile = RECORD_WRITER,
  credentialFile = AGENTS[AGENT_ROLE].credentialFile,
  witness = null,
} = {}) {
  if (!RUN_KINDS.includes(kind)) throw new Error(`a run is clean or poisoned, not ${JSON.stringify(kind)}`);
  if (!validPace(paceSeconds)) throw new Error(`the pace is a number of seconds from 0 to ${MAX_PACE_SECONDS}`);

  const fixtures = loadFixtures(repoRoot);
  const invoice = structuredClone(fixtures.invoices[kind]);
  // The declared intent, from the structured fields, before anything reads
  // the invoice's lines or its hidden text.
  const declared = declareIntent(invoice);
  const credentialBytes = fs.readFileSync(path.resolve(repoRoot, credentialFile));
  const credentialSha256 = sha256Hex(credentialBytes);

  const { runId, runDir, startedAt } = await createRunDir({ runsDir, kind, clock });
  const state = {
    runId,
    kind,
    startedAt: utcStamp(startedAt),
    finishedAt: null,
    fictionalLine: LABELS.header.fictionalLine,
    poisonedLine: kind === 'poisoned' ? LABELS.header.poisonedLine : null,
    // The parties by role, copied from the contract's label map.
    parties: { ...LABEL_MAP.parties },
    invoice,
    agent: {
      did: claimedDid(credentialBytes),
      role: LABELS.agentRole,
      credentialFile,
      credentialSha256,
      domain: LABELS.domains.agent,
    },
    grant: null,
    steps: LABELS.steps.map((s) => ({
      ...stepLabel(s.id),
      status: 'pending',
      startedAt: null,
      endedAt: null,
      detail: null,
      actionFile: null,
      recordFile: null,
    })),
    outcome: null,
    blockedAt: null,
    reason: null,
    paceSeconds,
  };
  const publish = () => writeJsonAtomic(path.join(runDir, 'state.json'), state);
  publish();

  const ctx = {
    kind, runId, runDir, repoRoot, clock, sleep, onEvent, recordWriter, recordWriterFile, witness, fixtures, invoice, declared,
    credentialBytes, credentialSha256, state, publish,
    paceMs: paceSeconds * 1000,
    holdMs: Math.min(2000, (paceSeconds * 1000) / 4),
    bank: null, atx: null, consent: null, issuer: null, held: null, payCall: null, aborted: false,
    // True once the record step has had its turn, whatever it ended as.
    recordHandled: false,
    // The record writer of this run, settled when the run starts; the error
    // of loading it, and the error of its begin, each kept for the record step.
    writer: null, writerError: null, beginError: null,
    stop: stopSwitch(),
  };
  // execute reports a failure in the state it returns. If writing that
  // state fails as well, the run still ends with the state in memory.
  const done = execute(ctx).catch((error) => ({ state: structuredClone(state), error }));
  return {
    runId,
    runDir,
    state: () => structuredClone(state),
    done,
    // Ends the wait in progress, stops the bank's listeners so a request in
    // flight ends too, and waits for the run to write its final state.
    async abort() {
      if (!ctx.aborted) {
        ctx.aborted = true;
        ctx.stop.trigger();
        if (ctx.bank) await ctx.bank.stop().catch(() => {});
      }
      await done;
    },
  };
}

// Runs to the end and returns the final state with the engine's error, if
// any. Used by text mode and the tests.
export async function runToEnd(options) {
  const run = await startRun(options);
  const { state, error } = await run.done;
  return { runId: run.runId, runDir: run.runDir, state, error };
}

async function execute(ctx) {
  const { state, publish, clock } = ctx;
  // Every wait of the run. It ends early, with RunStopped, when the run is stopped.
  const sleep = (ms) => (ctx.aborted ? Promise.reject(new RunStopped()) : Promise.race([ctx.sleep(ms), ctx.stop.stopped]));
  const stepOf = (id) => state.steps.find((s) => s.id === id);
  const emit = (type, step, at, note = null) => {
    if (ctx.onEvent) ctx.onEvent({ type, at, step: step ? structuredClone(step) : null, state: structuredClone(state), note });
  };
  const dwell = () => sleep(ctx.paceMs);
  const actor = () => ({ did: state.agent.did, role: state.agent.role, credentialSha256: state.agent.credentialSha256 });
  let current = null;
  let error = null;

  // One step that runs: mark it running, wait a moment, run the check, write
  // its files, publish the result.
  const runStep = async (id, work) => {
    if (ctx.aborted) throw new RunStopped();
    const step = stepOf(id);
    const seq = ACTION_STEPS.indexOf(id) + 1;
    current = step;
    step.status = 'running';
    step.startedAt = utcStamp(clock());
    publish();
    await sleep(ctx.holdMs);
    if (ctx.aborted) throw new RunStopped();
    const out = await work();
    // A check that fails while the run is being stopped may have failed
    // because of the stop (the bank's listeners close with it), so it is not
    // written as the step's own refusal. A check that went through did
    // happen, and is written.
    if (ctx.aborted && !out.ok) throw new RunStopped();
    const at = clock();
    const stamp = utcStamp(at);
    const paths = actionPaths(seq, id);
    if (out.hop) {
      writeJsonAtomic(path.join(ctx.runDir, paths.hop), hopFileContent({ runId: ctx.runId, seq, at: stamp, hop: out.hop }));
      out.detail.hopFile = paths.hop;
    }
    if (!out.ok) out.detail.refusal = out.refusal;
    const actionFile = writeAction(ctx.runDir, {
      runId: ctx.runId, seq, step: id, kind: ctx.kind, at: stamp, actor: actor(), ...out.action,
    });
    step.endedAt = stamp;
    step.detail = out.detail;
    step.actionFile = actionFile;
    step.status = out.ok ? 'passed' : 'blocked';
    if (out.ok) {
      if (out.apply) out.apply();
    } else {
      state.outcome = 'blocked';
      state.blockedAt = id;
      state.reason = out.runReason;
    }
    publish();
    current = null;
    emit('step', step, at);
    await dwell();
    return out.ok;
  };

  // A step the run did not reach.
  const skipStep = async (id) => {
    const step = stepOf(id);
    step.status = 'not-reached';
    publish();
    emit('step', step, clock());
    await dwell();
  };

  const works = {
    credential: async () => {
      const check = checkCredential({ bytes: ctx.credentialBytes, verifier: ctx.verifier, capability: PERMISSION });
      const v = check.verification;
      ctx.atx = check.atx;
      const detail = {
        verifier: VERIFIER_NAME,
        valid: v?.valid === true,
        issuer: check.ok ? v.context.issuerDid : null,
        notBefore: check.ok ? check.atx.issuedAt : null,
        notAfter: check.ok ? check.atx.expiresAt : null,
        postQuantumSignature: LABELS.credential.postQuantumSignature,
        windowSource: LABELS.credential.windowSource,
      };
      return {
        ok: check.ok,
        refusal: check.refusal,
        runReason: check.ok ? null : fill(LABELS.reasons.credential, { refusal: check.refusal }),
        detail,
        apply: () => { state.agent.did = v.context.agentDid; },
        action: {
          domainFrom: LABELS.domains.agent,
          domainTo: LABELS.domains.agent,
          declaredIntent: null,
          toolCall: null,
          decision: check.ok ? 'allowed' : 'blocked',
          reason: check.ok
            ? fill(LABELS.actionReasons.credentialAllowed, { capability: PERMISSION })
            : fill(LABELS.actionReasons.credentialBlocked, { refusal: check.refusal }),
          responseStatus: null,
          responseBody: JSON.stringify(v ?? null),
        },
      };
    },

    grant: async () => {
      const blocked = (refusal, detail, response) => ({
        ok: false,
        refusal,
        runReason: fill(LABELS.reasons.grant, { refusal }),
        detail,
        action: {
          domainFrom: LABELS.domains.agent,
          domainTo: LABELS.domains.bank,
          declaredIntent: ctx.declared,
          toolCall: null,
          decision: 'blocked',
          reason: fill(LABELS.actionReasons.grantBlocked, { refusal }),
          responseStatus: response.status,
          responseBody: response.body,
        },
      });
      if (!ctx.consent) {
        return blocked('grant-no-consent', { expiresInSeconds: null, inScope: false, scopeChecked: [] }, { status: null, body: JSON.stringify({ consent: null }) });
      }
      const terms = ctx.consent.record.terms;
      const scope = checkGrantScope({ terms, permission: PERMISSION, declared: ctx.declared, now: clock() });
      if (!scope.ok) {
        return blocked(scope.refusal, { expiresInSeconds: null, inScope: false, scopeChecked: scope.scopeChecked }, { status: null, body: JSON.stringify(scope) });
      }
      // The engine's clock when it asks, to the second below: the bank
      // counts the grant's life from a reading at or after this one, so the
      // expiry the state shows is never later than the bank's.
      const askedAt = Math.floor(clock().getTime() / 1000) * 1000;
      const issued = await ctx.issuer.issue({ atx: ctx.atx, grant: ctx.consent.binding.grant, operation: { method: 'POST', path: PAYMENTS_PATH } });
      if (!issued.ok) {
        return blocked(issued.refusal, { expiresInSeconds: null, inScope: true, scopeChecked: scope.scopeChecked },
          issued.exchange ?? { status: null, body: JSON.stringify({ code: 'denied' }) });
      }
      ctx.held = issued.held;
      return {
        ok: true,
        refusal: null,
        runReason: null,
        detail: { expiresInSeconds: issued.expiresInSeconds, inScope: true, scopeChecked: scope.scopeChecked },
        apply: () => {
          state.grant = {
            issuedAt: utcStamp(new Date(askedAt)),
            expiresAt: utcStamp(new Date(askedAt + issued.expiresInSeconds * 1000)),
            ttlSeconds: GRANT_TTL_SECONDS,
            scope: PERMISSION,
            maximumIndividualAmount: terms.maximumIndividualAmount ? { ...terms.maximumIndividualAmount } : null,
            creditorAccounts: [...terms.creditorAccounts],
            tokenType: issued.tokenType,
          };
        },
        action: {
          domainFrom: LABELS.domains.agent,
          domainTo: LABELS.domains.bank,
          declaredIntent: ctx.declared,
          toolCall: null,
          decision: 'allowed',
          reason: fill(LABELS.actionReasons.grantAllowed, { seconds: issued.expiresInSeconds }),
          responseStatus: issued.exchange.status,
          responseBody: issued.exchange.body,
        },
      };
    },

    crossing: async () => {
      const crossing = crossDomains({ repoRoot: ctx.repoRoot });
      const { hop } = crossing;
      return {
        ok: crossing.ok,
        refusal: crossing.refusal,
        runReason: crossing.ok ? null : fill(LABELS.reasons.crossing, { refusal: crossing.refusal }),
        hop,
        detail: { from: hop.from, to: hop.to, chainFile: hop.chainFile, hops: hop.hops, outcome: hop.outcome, stepsRun: hop.stepsRun, standIn: hop.standIn, hopFile: null },
        action: {
          domainFrom: hop.from,
          domainTo: hop.to,
          declaredIntent: null,
          toolCall: null,
          decision: crossing.ok ? 'observed' : 'blocked',
          reason: crossing.ok
            ? fill(LABELS.actionReasons.crossingObserved, { outcome: hop.outcome, hops: hop.hops })
            : fill(LABELS.actionReasons.crossingBlocked, { outcome: hop.outcome, expected: crossing.expectedOutcome ?? 'no outcome', refusal: crossing.refusal }),
          responseStatus: null,
          responseBody: JSON.stringify(crossing.result),
        },
      };
    },

    intent: async () => {
      // The agent reads the whole invoice here, hidden text included.
      const plan = planToolCalls(ctx.invoice);
      const ruled = applyIntentRule(ctx.declared, plan.calls);
      // A call for a secret that the rule stopped is also put to the
      // resolver the bank's broker is built with, which refuses every name.
      // What it answered is kept; a value, if one ever came back, is not.
      for (const call of ruled.calls) {
        if (call.declaredFor === null && call.tool === TOOLS.readSecret) {
          const name = String(call.args.name ?? '');
          const exists = await refusingResolver.exists(name);
          const value = await refusingResolver.resolve(name);
          call.brokerResolver = { asked: LABELS.intent.resolverAsked, name, exists, resolved: value !== undefined, refused: exists === false && value === undefined };
        }
      }
      const payCall = ruled.calls.find((c) => c.declaredFor === 'pay' && c.match) ?? null;
      const allowed = intentAllows(ruled);
      const ok = allowed && payCall !== null;
      let refusal = null;
      if (!allowed) refusal = ruled.result === 'mismatch' ? 'intent-mismatch' : 'intent-undeclared-call';
      else if (!payCall) refusal = 'intent-no-call-for-the-declared-intent';
      ctx.payCall = ok ? payCall : null;
      const stopped = ruled.calls.find((c) => !c.match) ?? null;
      const shown = stopped ?? payCall ?? ruled.calls[0] ?? null;
      const what = allowed ? refusal : intentBlockedSummary(ruled);
      return {
        ok,
        refusal,
        runReason: ok ? null : (allowed ? fill(LABELS.intent.reasonOther, { what: refusal }) : intentReason(ruled)),
        detail: ruled,
        action: {
          domainFrom: LABELS.domains.agent,
          domainTo: LABELS.domains.agent,
          declaredIntent: ctx.declared,
          toolCall: shown ? { tool: shown.tool, args: shown.args } : null,
          decision: ok ? 'allowed' : 'blocked',
          reason: ok ? LABELS.actionReasons.intentAllowed : fill(LABELS.actionReasons.intentBlocked, { what }),
          responseStatus: null,
          responseBody: JSON.stringify(ruled),
        },
      };
    },

    pay: async () => {
      const args = ctx.payCall.args;
      const base = { endpoint: PAYMENTS_PATH, httpStatus: null, paymentId: null, amount: args.amount, currency: args.currency, payeeAccount: args.payeeAccount, recordedByBank: false };
      const result = (ok, refusal, detail, response) => ({
        ok,
        refusal,
        runReason: ok ? null : fill(LABELS.reasons.pay, { refusal }),
        detail,
        apply: () => { state.outcome = 'paid'; },
        action: {
          domainFrom: LABELS.domains.agent,
          domainTo: LABELS.domains.bank,
          declaredIntent: ctx.declared,
          toolCall: { tool: ctx.payCall.tool, args },
          decision: ok ? 'allowed' : 'blocked',
          reason: ok ? LABELS.actionReasons.payAllowed : fill(LABELS.actionReasons.payBlocked, { refusal }),
          responseStatus: response.status,
          responseBody: response.body,
        },
      });
      // The grant's life is checked here, before anything is sent. An
      // expired grant is not presented: the agent has to ask for a new one.
      const expiry = checkGrantExpiry({ grant: state.grant, now: clock() });
      if (!expiry.ok || !ctx.held) {
        ctx.held?.discard();
        const refusal = expiry.ok ? 'grant-missing' : expiry.refusal;
        return result(false, refusal, base, { status: null, body: JSON.stringify({ sent: false, refusal }) });
      }
      const answer = await ctx.held.spend({
        method: 'POST',
        path: PAYMENTS_PATH,
        body: { creditorAccount: args.payeeAccount, amount: { amount: args.amount, currency: args.currency } },
      });
      const accepted = answer.status === 200 && answer.body?.status === 'accepted' && typeof answer.body.paymentId === 'string';
      const paymentId = accepted ? answer.body.paymentId : null;
      const row = paymentId ? ctx.bank.ledgerRow(paymentId) : null;
      const recordedByBank = Boolean(row) && row.payeeAccount === args.payeeAccount && row.amountCents === parseCents(args.amount) && row.currency === args.currency;
      const detail = { ...base, httpStatus: answer.status, paymentId, recordedByBank };
      const response = { status: answer.status, body: answer.raw };
      if (!accepted) return result(false, `payment-refused-status-${answer.status}`, detail, response);
      if (!recordedByBank) return result(false, 'payment-not-in-the-bank-ledger', detail, response);
      return result(true, null, detail, response);
    },
  };

  // The record writer of this run: the one the caller gave, none, or the
  // module at recordWriterFile. The tree's own writer is used through
  // records.mjs, whose begin makes the run's test key. It is settled when the
  // run starts, so that key is made before the run's steps. A writer that
  // cannot be loaded, or whose begin fails, does not stop the payment steps:
  // the error is kept for the record step.
  const settleWriter = async () => {
    try {
      let writer = ctx.recordWriter;
      if (writer === undefined) {
        if (!fs.existsSync(ctx.recordWriterFile)) writer = null;
        else if (ctx.recordWriterFile === RECORD_WRITER) writer = (await import('./records.mjs')).recordWriter;
        else writer = await import(pathToFileURL(ctx.recordWriterFile).href);
      }
      ctx.writer = writer && typeof writer.writeRun === 'function' ? writer : null;
    } catch (err) {
      ctx.writerError = err;
      return;
    }
    if (ctx.writer && typeof ctx.writer.begin === 'function') {
      try {
        await ctx.writer.begin(ctx.runDir);
      } catch (err) {
        ctx.beginError = err;
      }
    }
  };

  // The record step. The record writer writes the packages; with no writer
  // in the tree the step stays pending.
  const recordStep = async () => {
    const step = stepOf('record');
    if (ctx.writerError) throw ctx.writerError;
    const writer = ctx.writer;
    if (!writer) {
      ctx.recordHandled = true;
      emit('step', step, clock(), NO_RECORD_WRITER);
      await dwell();
      return;
    }
    current = step;
    step.status = 'running';
    step.startedAt = utcStamp(clock());
    publish();
    await sleep(ctx.holdMs);
    try {
      if (ctx.beginError) throw ctx.beginError;
      await writer.writeRun(ctx.runDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(ctx.runDir, 'records', 'manifest.json'), 'utf8'));
      const records = Array.isArray(manifest.records) ? manifest.records : [];
      for (const r of records) {
        const of = state.steps.find((s) => s.actionFile !== null && s.actionFile === r.action);
        if (of && typeof r.file === 'string' && r.file.startsWith('records/') && fs.existsSync(path.join(ctx.runDir, r.file))) of.recordFile = r.file;
      }
      step.detail = {
        written: records.length,
        format: manifest.format ?? null,
        signer: LABELS.record.signer,
        credentialCitedBy: LABELS.record.credentialCitedBy,
        timestampEntry: LABELS.record.timestampEntry,
      };
      step.recordFile = 'records/manifest.json';
      step.status = 'written';
    } catch (err) {
      step.detail = { written: 0, refusal: 'record-writer-failed', error: String(err?.message ?? err) };
      step.status = 'blocked';
    }
    const at = clock();
    step.endedAt = utcStamp(at);
    publish();
    current = null;
    ctx.recordHandled = true;
    emit('step', step, at);
    await dwell();
  };

  try {
    await settleWriter();
    const trust = loadTrust(path.join(ctx.repoRoot, 'fixtures/issuer/trust.json'));
    ctx.verifier = new LocalAtxVerifier({ ...trust, now: clock });
    ctx.bank = await startBank({ repoRoot: ctx.repoRoot, clock, witness: ctx.witness });
    // The customer's consent is on file at the bank before the run's steps:
    // the bank accepts the agent's credential and records the terms. A
    // credential the bank does not accept leaves no consent, and the run
    // stops at its credential step.
    const added = ctx.fixtures.consent.addedCreditorAccounts;
    let atx = null;
    try {
      atx = JSON.parse(ctx.credentialBytes.toString('utf8'));
    } catch {
      atx = null;
    }
    ctx.consent = atx ? ctx.bank.approveConsent({ atx, terms: consentTerms(added), payees: added }) : null;
    ctx.issuer = grantIssuer({ bank: ctx.bank, bindings: ctx.consent ? [ctx.consent.binding] : [], clock });

    await dwell();
    let stopped = false;
    for (const id of ACTION_STEPS) {
      if (stopped) await skipStep(id);
      else if (!(await runStep(id, works[id]))) stopped = true;
    }
    ctx.held?.discard();
    await recordStep();
  } catch (err) {
    // The run ends here: on an error of the engine itself, or because its
    // caller stopped it (whatever was in flight then fails as well).
    const stopped = ctx.aborted;
    error = stopped && !(err instanceof RunStopped) ? new RunStopped() : err;
    const message = String(error?.message ?? error);
    const at = clock();
    // The step that reads blocked: the one in hand or, between two steps, the
    // one that was due next. After a step has stopped the run that is the
    // record step, since the steps before it are not reached. A step that has
    // had its turn keeps its result, and so does an outcome already reached.
    const due = state.steps.filter((s) => s.status === 'pending' && !(s.id === 'record' && ctx.recordHandled));
    const failed = current ?? (state.outcome === 'blocked' ? due.find((s) => s.id === 'record') : due[0]) ?? null;
    if (failed) {
      failed.status = 'blocked';
      failed.endedAt = utcStamp(at);
      failed.detail = stopped ? { refusal: 'run-stopped' } : { refusal: 'engine-error', error: message };
      if (state.outcome === null) {
        state.outcome = 'blocked';
        state.blockedAt = failed.id;
        state.reason = stopped ? fill(LABELS.reasons.stopped, { step: failed.id }) : fill(LABELS.reasons.engine, { step: failed.id, message });
      }
    }
    for (const s of due) if (s !== failed) s.status = 'not-reached';
    publish();
    if (failed) emit('step', failed, at);
  } finally {
    ctx.held?.discard();
    if (ctx.bank) await ctx.bank.stop().catch(() => {});
    // A run that ended before its record step gives up its test key here.
    // After the record step the writer has deleted it, and this changes nothing.
    if (ctx.writer && typeof ctx.writer.abandon === 'function') {
      try {
        await ctx.writer.abandon(ctx.runDir);
      } catch {
        // The key is in this process alone, and goes with it at the latest.
      }
    }
  }
  const finishedAt = clock();
  state.finishedAt = utcStamp(finishedAt);
  publish();
  emit('finished', null, finishedAt);
  return { state: structuredClone(state), error };
}
