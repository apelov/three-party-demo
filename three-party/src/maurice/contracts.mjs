// The contracts of the Maurice invoice slice (MAURICE-IMPLEMENTATION-PLAN.md,
// Milestone 1). Each contract is a plain JSON object with a fixed shape;
// validate* refuses anything else rather than coercing it. The enforcement
// adapter (adapter.mjs) is the only component that turns a proposal into a
// bank request, and it validates every one of these shapes itself: nothing
// that arrives from the untrusted invoice side is trusted because it is
// well-formed.
//
//   TrustedTask       the trusted intent, loaded by the adapter from its own
//                     trusted store (a purchase-order fixture), never from
//                     invoice text or workflow input
//   Proposal          a tool name and typed arguments; never free-form code
//   ExecutionRequest  run/task identifiers, a stable idempotency key, the
//                     proposal and the authorization artifact
//   Decision          allow/deny/error, a stable reason code, the compared
//                     fields and artifact references
//   Event             run ID, event ID, producer, sequence, timestamp and
//                     artifact references; timestamps alone do not establish
//                     cross-service ordering, so every event also carries its
//                     producer and sequence
//
// canonicalJson is a small RFC 8785-style canonicalization (object members
// sorted by UTF-16 code units, no whitespace, ECMAScript string escaping,
// integers only) used to hash proposals and authorization bindings. The
// record writer's own JCS (three-party/src/record/jcs.mjs) covers only the
// flat metadata profile and is not reused here.

import crypto from 'node:crypto';

export const PAY_TOOL = 'bank.payments.create';
export const SECRET_TOOL = 'secrets.read';
export const KNOWN_TOOLS = Object.freeze([PAY_TOOL, SECRET_TOOL]);

// The provenance labels a run carries: 'clean' is the plain invoice;
// 'poisoned-document' is the live mode fed the poisoned invoice, whose hidden
// text the deterministic extractor follows (the labeled deterministic
// adversarial proposal); 'deterministic-adversarial' marks a hand-built
// hostile proposal in tests. A safe refusal is recorded as such — the label
// says what the proposal was, never that an injection succeeded.
export const MODES = Object.freeze(['clean', 'poisoned-document', 'deterministic-adversarial']);

// The workflow states a run can be in, in the order they can happen.
// 'unknown' is the state after a submission whose answer never arrived: it
// is not a denial, and a retry with the same idempotency key must not settle
// a second time.
export const STATES = Object.freeze([
  'proposed', 'awaiting-approval', 'authorized', 'submitted', 'settled', 'denied', 'failed', 'unknown',
]);

// Stable reason codes of a Decision. A denial always has one; 'error' marks
// a failure that is not a policy decision (a timeout, an unreachable bank).
export const REASONS = Object.freeze({
  TASK_UNKNOWN: 'task-unknown',
  TASK_EXPIRED: 'task-expired',
  TASK_INVALID: 'task-invalid',
  PROPOSAL_INVALID: 'proposal-invalid',
  INTENT_MISMATCH: 'intent-mismatch',
  INTENT_UNDECLARED_CALL: 'intent-undeclared-call',
  AMOUNT_OVER_TASK_CAP: 'amount-over-task-cap',
  CURRENCY_MISMATCH: 'currency-mismatch',
  GRANT_SCOPE: 'grant-scope-violation',
  GRANT_EXPIRED: 'grant-expired',
  GRANT_MISSING: 'grant-missing',
  APPROVAL_MISSING: 'approval-missing',
  APPROVAL_WRONG_KIND: 'approval-wrong-kind',
  APPROVAL_WRONG_TASK: 'approval-wrong-task',
  APPROVAL_NOT_BOUND: 'approval-not-bound-to-proposal',
  IDEMPOTENCY_KEY_REUSED: 'idempotency-key-reused-with-different-details',
  IDEMPOTENT_REPLAY: 'idempotent-replay',
  BANK_REFUSED: 'bank-refused',
  BANK_TIMEOUT: 'bank-timeout',
  BANK_UNREACHABLE: 'bank-unreachable',
  SECRET_READ_UNDECLARED: 'secret-read-undeclared',
  SECRET_READ_REFUSED: 'secret-read-refused',
  PROPOSAL_MATCHES_TASK: 'proposal-matches-task',
  SETTLED: 'settled',
});

export const DECISIONS = Object.freeze(['allow', 'deny', 'error']);

export const EVENT_PRODUCERS = Object.freeze(['workflow', 'enforcement-adapter', 'bank']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.length > 0;
const DECIMAL = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;

// ---- canonical JSON and hashes

function canonicalValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('the contract admits integers only, no other number');
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (isPlainObject(value)) {
    const names = Object.keys(value).sort();
    return `{${names.map((n) => `${JSON.stringify(n)}:${canonicalValue(value[n])}`).join(',')}}`;
  }
  throw new TypeError(`a contract value is not JSON: ${typeof value}`);
}

export function canonicalJson(value) {
  return canonicalValue(value);
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function proposalSha256(proposal) {
  return sha256Hex(canonicalJson(proposal));
}

// ---- TrustedTask

// The trusted intent of one task. `amountCap` is a bound, not an exact
// amount: the invoice's extracted amount must not exceed it. `expiresAt` is
// an RFC 3339 UTC time. `provenance` names where the task came from; only a
// purchase order (or an equally trusted record) is accepted, never invoice
// text.
export function validateTask(task) {
  if (!isPlainObject(task)) return 'the task is not an object';
  if (!isString(task.taskId)) return 'the task carries no taskId';
  if (task.kind !== 'purchase-order') return `the task kind is ${JSON.stringify(task.kind ?? null)}, not purchase-order`;
  if (!isString(task.invoiceId)) return 'the task carries no invoiceId';
  if (!isString(task.payeeName) || !isString(task.payeeAccount)) return 'the task carries no payee name or account';
  if (!isPlainObject(task.amountCap) || !isString(task.amountCap.amount) || !DECIMAL.test(task.amountCap.amount)
    || !isString(task.amountCap.currency)) return 'the task carries no amount cap of a decimal string and a currency';
  if (!isString(task.expiresAt) || Number.isNaN(Date.parse(task.expiresAt))) return 'the task carries no RFC 3339 expiresAt';
  if (!isPlainObject(task.provenance) || !isString(task.provenance.source) || !isString(task.provenance.ref)) {
    return 'the task carries no provenance source and reference';
  }
  return null;
}

// The declared intent the intent rule is applied to, built from the trusted
// task alone. When the task fixes an exact amount it is a declared field;
// otherwise the amount is checked against the cap separately.
export function declaredIntentFromTask(task) {
  const declared = {
    action: 'pay',
    invoiceId: task.invoiceId,
    payeeAccount: task.payeeAccount,
    currency: task.amountCap.currency,
  };
  if (isString(task.amountExact)) declared.amount = task.amountExact;
  return declared;
}

export function taskExpired(task, now) {
  return now.getTime() > Date.parse(task.expiresAt);
}

// ---- Proposal

// A proposal is one tool call with typed arguments. Never executable
// free-form code. The pay tool's args are the four payment fields; a secret
// read carries only a name, and only synthetic names are exposed anywhere.
export function validateProposal(proposal) {
  if (!isPlainObject(proposal)) return 'the proposal is not an object';
  if (!KNOWN_TOOLS.includes(proposal.tool)) return `the proposal names tool ${JSON.stringify(proposal.tool ?? null)}, not one of ${KNOWN_TOOLS.join(', ')}`;
  const args = proposal.args;
  if (!isPlainObject(args)) return 'the proposal carries no args object';
  if (proposal.tool === PAY_TOOL) {
    for (const field of ['invoiceId', 'payeeAccount', 'amount', 'currency']) {
      if (!isString(args[field])) return `the proposal's args carry no ${field}`;
    }
    if (!DECIMAL.test(args.amount)) return 'the proposal amount is not a decimal string of two places';
    for (const field of Object.keys(args)) {
      if (!['invoiceId', 'payeeAccount', 'amount', 'currency'].includes(field)) return `the proposal args name an undeclared argument ${field}`;
    }
  } else {
    if (!isString(args.name) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.name)) return 'a secret read carries only a synthetic name (lowercase letters, digits, dashes)';
    for (const field of Object.keys(args)) {
      if (field !== 'name') return `the secret read args name an undeclared argument ${field}`;
    }
  }
  return null;
}

// ---- Authorization

// The authorization artifact a human (or a trusted purchase order) issues
// for one exact proposal: it binds the proposal by its SHA-256 over the
// canonical proposal. A change to the proposal needs a new authorization.
export function validateAuthorization(authorization) {
  if (!isPlainObject(authorization)) return 'the authorization is not an object';
  if (authorization.kind !== 'purchase-order' && authorization.kind !== 'human-approval') {
    return `the authorization kind is ${JSON.stringify(authorization.kind ?? null)}, not purchase-order or human-approval`;
  }
  if (!isString(authorization.ref)) return 'the authorization carries no reference';
  if (!isString(authorization.proposalSha256) || !/^[0-9a-f]{64}$/.test(authorization.proposalSha256)) {
    return 'the authorization carries no proposal SHA-256';
  }
  return null;
}

// ---- ExecutionRequest

export function validateExecutionRequest(request) {
  if (!isPlainObject(request)) return 'the execution request is not an object';
  if (!isString(request.runId)) return 'the execution request carries no runId';
  if (!isString(request.taskId)) return 'the execution request carries no taskId';
  if (!isString(request.idempotencyKey) || request.idempotencyKey.length > 512) return 'the execution request carries no stable idempotencyKey';
  const proposalProblem = validateProposal(request.proposal);
  if (proposalProblem) return `the execution request's proposal: ${proposalProblem}`;
  const authorizationProblem = validateAuthorization(request.authorization);
  if (authorizationProblem) return `the execution request's authorization: ${authorizationProblem}`;
  return null;
}

// ---- Decision and Event

// comparedFields: one entry per field the adapter compared, in order, with
// the expected (trusted) value, the actual (proposed) value and the result.
export function validateDecision(decision) {
  if (!isPlainObject(decision)) return 'the decision is not an object';
  if (!DECISIONS.includes(decision.decision)) return `the decision is ${JSON.stringify(decision.decision ?? null)}, not allow, deny or error`;
  if (!isString(decision.reasonCode)) return 'the decision carries no reasonCode';
  if (!Array.isArray(decision.comparedFields)) return 'the decision carries no comparedFields array';
  for (const c of decision.comparedFields) {
    if (!isPlainObject(c) || !isString(c.field) || !('expected' in c) || !('actual' in c) || !['match', 'differ', 'not-declared'].includes(c.result)) {
      return 'a compared field is not {field, expected, actual, result}';
    }
  }
  if (!isPlainObject(decision.artifacts)) return 'the decision carries no artifacts object';
  return null;
}

export function validateEvent(event) {
  if (!isPlainObject(event)) return 'the event is not an object';
  if (!isString(event.runId)) return 'the event carries no runId';
  if (!isString(event.eventId)) return 'the event carries no eventId';
  if (!EVENT_PRODUCERS.includes(event.producer)) return `the event producer is ${JSON.stringify(event.producer ?? null)}, not one of ${EVENT_PRODUCERS.join(', ')}`;
  if (!Number.isInteger(event.sequence) || event.sequence < 1) return 'the event carries no positive integer sequence';
  if (!isString(event.at) || Number.isNaN(Date.parse(event.at))) return 'the event carries no RFC 3339 at';
  if (!isString(event.type)) return 'the event carries no type';
  if (!isPlainObject(event.artifacts)) return 'the event carries no artifacts object';
  return null;
}
