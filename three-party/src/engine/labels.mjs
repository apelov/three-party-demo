// The strings the engine prints in text mode or writes into state.json, an
// action file or a hop file, apart from the part labels, the party roles and
// the stand-in notes. Those are in the contract's label map,
// three-party/labels.json (label-map.mjs reads it), and nowhere in this file:
// a change of a part label, a party role or a stand-in note is one edit of
// that map.
//
// The values the shared contract fixes (three-party/CONTRACT.md and its
// examples) are carried byte for byte. The engine tests compare this map with
// the example files, so a change that leaves the contract shows as a failing
// test.

import { partFields } from './label-map.mjs';

export const LABELS = Object.freeze({
  // Text mode header. The poisoned line follows the title on a poisoned
  // run. {paceSeconds} is the run's own value.
  header: Object.freeze({
    title: 'Three parts, one payment',
    poisonedLine: 'The poisoned invoice is modeled on what OpenA2A honeypots saw; no captured traffic is replayed.',
    mockLine: "The supplier's bank is a mock bank on this computer, and the payments agent is scripted.",
    paceLine: 'Times in UTC. Paced for viewing: at least {paceSeconds} seconds per step.',
  }),

  // Text mode's part cell for a stand-in part, and a step line that ends with
  // notes: the facts, a full stop, then the notes of the label map.
  text: Object.freeze({
    standInPart: '{partLabel} (stand-in)',
    withNotes: '{detail}. {notes}',
  }),

  // The agent's role id, and the two trust domains as state.json and the
  // files carry them. On screen and in text mode the parties go by the roles
  // of the label map.
  agentRole: 'payments-agent',
  domains: Object.freeze({
    agent: 'payments.acme-demo.test',
    bank: 'bank.example.test',
  }),

  // The six steps, in order, with their titles. The part a step belongs to is
  // the part of the label map whose steps list holds its id.
  steps: Object.freeze([
    Object.freeze({ id: 'credential', title: "Verify the agent's ATX credential locally" }),
    Object.freeze({ id: 'grant', title: 'Issue a scoped AAP grant' }),
    Object.freeze({ id: 'crossing', title: "Cross into the supplier's bank's trust domain" }),
    Object.freeze({ id: 'intent', title: 'Apply the intent rule to each tool call' }),
    Object.freeze({ id: 'pay', title: 'Pay the invoice under the grant' }),
    Object.freeze({ id: 'record', title: 'Write one signed Action Evidence Package per action' }),
  ]),

  // The state word text mode prints for each status id of state.json.
  statusWords: Object.freeze({
    pending: 'Pending',
    running: 'Checking',
    passed: 'Passed',
    blocked: 'Stopped',
    'not-reached': 'Not reached',
    written: 'Written',
  }),

  // The outcome line of text mode.
  outcome: Object.freeze({
    label: 'Outcome',
    paid: 'Paid',
    blockedAtIntent: 'Stopped by the intent rule',
    blockedElsewhere: 'Stopped at: {title}',
    paidText: "Every tool call passed the intent rule, and the supplier's bank accepted payment {paymentId}.",
  }),

  // The intent rule: its sentence, the marker for a call that has no declared
  // intent, and the reason a run carries when the rule stops it.
  intent: Object.freeze({
    rule: 'Every argument of a tool call must equal the same field of the declared intent. A call with no declared intent is blocked.',
    noDeclaredIntent: 'no declared intent for this call',
    // The poisoned invoice: a secret asked for and the payee changed.
    reasonSecretAndPayee: 'The credential and the grant were valid, but the agent asked for a secret and changed the payee, which its declared intent does not allow.',
    // Any other mismatch, with what differed.
    reasonOther: 'The credential and the grant were valid, but a tool call did not equal the declared intent: {what}.',
    resolverAsked: "the resolver the bank's broker is built with, which refuses every name",
  }),

  // The crossing stand-in.
  crossing: Object.freeze({
    standIn: 'AI2II interop: stand-in; the real piece replaces the hop file, not code',
    stepsRun: '{steps} of {draft} section 6',
  }),

  credential: Object.freeze({
    postQuantumSignature: 'not verified in this demo',
    windowSource: 'issuedAt and expiresAt of the credential; the verifier checks expiresAt',
  }),

  // The record step (the record build writes the packages).
  record: Object.freeze({
    signer: 'test key generated for this run',
    credentialCitedBy: "sha256 over the credential's exact bytes",
    timestampEntry: 'stand-in: no timestamp authority',
  }),

  // The reason each action file carries, by step and decision.
  actionReasons: Object.freeze({
    credentialAllowed: 'the credential verified under the pinned test issuer key, and it carries the capability {capability}',
    credentialBlocked: 'the credential was not accepted ({refusal})',
    grantAllowed: "the broker's grant policy matched the verified credential; the bank's token service issued a grant that lives {seconds} seconds; the declared payment is inside the consent",
    grantBlocked: 'no grant was issued ({refusal})',
    crossingObserved: 'the delegation chain check returned {outcome} for the chain of {hops} hops; the check holds no request, so it reports no action as permitted; stand-in for the AI2II interop piece',
    crossingBlocked: 'the delegation chain check returned {outcome}, and the chain file names {expected} ({refusal})',
    intentAllowed: 'every tool call equals the declared intent field for field',
    intentBlocked: 'the intent rule stopped the tool calls: {what}',
    payAllowed: 'the tool call equals the declared intent field for field; the grant is in scope; the bank accepted the payment',
    payBlocked: 'the payment was not accepted ({refusal})',
  }),

  // The one-line detail text mode prints for each step and status.
  details: Object.freeze({
    credentialPassed: 'valid; signed by the test issuer; not after {notAfter}; file sha256 {sha12}...',
    credentialBlocked: 'not accepted: {refusal}',
    grantPassed: '{tokenType} grant for {scope}, expires in {seconds} seconds; the declared payment is in scope ({checked})',
    grantBlocked: 'no grant: {refusal}',
    crossingPassed: '{agent} to {bank}; chain of {hops} hops: {outcome}',
    crossingBlocked: '{agent} to {bank}; chain of {hops} hops: {outcome}; {refusal}',
    intentPassed: 'tool calls checked: {count}; each equals the declared intent field for field',
    intentBlocked: '{what}',
    intentUndeclared: '{tool} has no declared intent',
    intentUndeclaredRefused: "{tool} has no declared intent (the broker's resolver also refused the name {name})",
    intentDiffers: '{tool} differs in {fields} (declared {declared}, called with {called})',
    payPassed: 'POST {endpoint} answered {httpStatus}; payment {paymentId}; {amount} {currency} to {payeeAccount}; in the bank ledger',
    payBlocked: 'not paid: {refusal}',
    payNotReached: 'no payment was sent: the run stopped at an earlier step',
    recordWritten: '{written} records; {format}; signer: {signer}',
    recordPending: 'no record written: the record writer (three-party/src/record/writer.mjs) is not in this build',
    recordBlocked: 'the record writer did not finish: {refusal}',
    notReached: 'the run stopped at an earlier step',
    stepPending: 'not started',
    stepRunning: 'in progress',
    engineError: 'the engine stopped on an error: {message}',
    runStopped: 'the run was stopped before this step finished',
  }),

  // A sentence for a run that stops at a step other than the intent rule.
  reasons: Object.freeze({
    credential: "The agent's credential was not accepted ({refusal}), so no grant was issued and no payment was sent.",
    grant: 'The credential was valid, but no grant was issued ({refusal}), so no payment was sent.',
    crossing: "The credential and the grant were valid, but the crossing into the supplier's bank's trust domain did not check out ({refusal}), so no payment was sent.",
    pay: "Every tool call passed the intent rule, but the supplier's bank did not accept the payment ({refusal}).",
    engine: 'The run stopped on an engine error at the step {step}: {message}',
    stopped: 'The run was stopped before it finished, at the step {step}.',
  }),

  // Lines the command line prints around a run.
  cli: Object.freeze({
    runDirectory: 'Run directory: {runDir}',
    // The three lines the demo prints when it is started with no option.
    demoTitle: 'Three-party demo, build {build}',
    demoReady: 'Ready. Open http://127.0.0.1:{port}/ in a browser.',
    demoStop: 'Press Ctrl+C to stop.',
    // The offline check in text mode: one line for each line the check
    // returned, as returned, and one for its exit status under the name the
    // check's answer gives it.
    offlineCheckLine: '[{hhmmss}] Offline check | {line}',
    offlineCheckExit: 'exitCode: {exitCode}',
    serving: 'Run API on http://127.0.0.1:{port}/ (build {build}). Press Ctrl+C to stop.',
    rootText: 'Three-party demo run API. The screens are added by the integration build; see /api/health.',
    unexpected: 'The {kind} run ended {outcome}, not {expected}.',
    engineError: 'The engine stopped on an error during the {kind} run: {message}',
  }),
});

// Fills {name} placeholders. A placeholder with no value is a defect, so it
// throws rather than print a brace.
export function fill(template, values = {}) {
  return template.replace(/\{([A-Za-z0-9]+)\}/g, (_, name) => {
    if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) {
      throw new Error(`no value for {${name}} in: ${template}`);
    }
    return String(values[name]);
  });
}

// What a step of state.json carries before it runs, in the contract's member
// order: its id, then its part, part label and stand-in note from the label
// map, then its title.
export function stepLabel(id) {
  const step = LABELS.steps.find((s) => s.id === id);
  if (!step) throw new Error(`unknown step ${id}`);
  return { id: step.id, ...partFields(step.id), title: step.title };
}
