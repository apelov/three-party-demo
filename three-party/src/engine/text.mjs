// The lines of text mode, built from state.json values and the engine's
// words. Nothing here reads a clock: each function takes the state (or a step
// of it) and the time of the event it prints. A part label, a party role and
// a stand-in note are printed as the state carries them, which is as the
// engine wrote them from the contract's label map; the note on a record's
// timestamp entry is read from that map here.

import path from 'node:path';
import { LABEL_MAP, timestampNote } from './label-map.mjs';
import { LABELS, fill } from './labels.mjs';
import { clockDigits } from './store.mjs';

const NOTHING = 'nothing';

// The header of one run: three lines, and the poisoned line after the
// title on a poisoned run.
export function headerLines(state) {
  const h = LABELS.header;
  const lines = [h.title];
  if (state.poisonedLine) lines.push(state.poisonedLine);
  lines.push(h.mockLine, fill(h.paceLine, { paceSeconds: state.paceSeconds }));
  return lines;
}

function intentBlockedText(detail) {
  const d = LABELS.details;
  const parts = [];
  for (const call of detail.calls) {
    if (call.match) continue;
    if (call.declaredFor === null) {
      const refused = call.brokerResolver && call.brokerResolver.refused === true;
      parts.push(refused
        ? fill(d.intentUndeclaredRefused, { tool: call.tool, name: call.brokerResolver.name })
        : fill(d.intentUndeclared, { tool: call.tool }));
      continue;
    }
    const declared = Array.isArray(detail.declared)
      ? detail.declared.find((i) => i.action === call.declaredFor) ?? {}
      : detail.declared;
    for (const field of call.fieldsDiffering) {
      parts.push(fill(d.intentDiffers, {
        tool: call.tool,
        fields: field,
        declared: Object.hasOwn(declared, field) ? declared[field] : NOTHING,
        called: Object.hasOwn(call.args, field) ? JSON.stringify(call.args[field]).replace(/^"|"$/g, '') : NOTHING,
      }));
    }
  }
  return parts.join('; ');
}

// What the intent rule stopped, in words, for a run's reason and an action
// file's reason.
export function intentBlockedSummary(detail) {
  return intentBlockedText(detail);
}

// The note the engine puts on the record step's event when the step stays
// pending because no record writer is in the tree.
export const NO_RECORD_WRITER = 'no-record-writer';

// The one-line detail of a step, by its status. `note` is the note of the
// event the line is printed for, if any.
export function stepDetailText(step, state, note = null) {
  const d = LABELS.details;
  const detail = step.detail ?? {};
  if (step.status === 'not-reached') return step.id === 'pay' ? d.payNotReached : d.notReached;
  if (step.status === 'running') return d.stepRunning;
  if (step.status === 'pending') return step.id === 'record' && note === NO_RECORD_WRITER ? d.recordPending : d.stepPending;
  if (detail.refusal === 'engine-error') return fill(d.engineError, { message: detail.error });
  if (detail.refusal === 'run-stopped') return d.runStopped;
  switch (step.id) {
    case 'credential':
      if (step.status === 'passed') return fill(d.credentialPassed, { notAfter: detail.notAfter, sha12: state.agent.credentialSha256.slice(0, 12) });
      return fill(d.credentialBlocked, { refusal: detail.refusal });
    case 'grant':
      if (step.status === 'passed') {
        return fill(d.grantPassed, { tokenType: state.grant.tokenType, scope: state.grant.scope, seconds: detail.expiresInSeconds, checked: detail.scopeChecked.join(', ') });
      }
      return fill(d.grantBlocked, { refusal: detail.refusal });
    case 'crossing': {
      // The two sides by role, as the state carries them from the label map.
      const roles = state.parties ?? LABEL_MAP.parties;
      const parties = { agent: roles.agent, bank: roles.bank };
      if (step.status === 'passed') return fill(d.crossingPassed, { ...parties, hops: detail.hops, outcome: detail.outcome });
      return fill(d.crossingBlocked, { ...parties, hops: detail.hops, outcome: detail.outcome, refusal: detail.refusal });
    }
    case 'intent':
      if (step.status === 'passed') return fill(d.intentPassed, { count: detail.calls.length });
      return fill(d.intentBlocked, { what: intentBlockedText(detail) || detail.refusal });
    case 'pay':
      if (step.status === 'passed') {
        return fill(d.payPassed, { endpoint: detail.endpoint, httpStatus: detail.httpStatus, paymentId: detail.paymentId, amount: detail.amount, currency: detail.currency, payeeAccount: detail.payeeAccount });
      }
      return fill(d.payBlocked, { refusal: detail.refusal });
    case 'record':
      if (step.status === 'written') return fill(d.recordWritten, { written: detail.written, format: detail.format, signer: detail.signer });
      return fill(d.recordBlocked, { refusal: detail.refusal });
    default:
      throw new Error(`unknown step ${step.id}`);
  }
}

// The part cell of a step line: the step's part label, and for a stand-in
// part the label with the stand-in mark after it.
export function partCell(step) {
  return step.standIn === true ? fill(LABELS.text.standInPart, { partLabel: step.partLabel }) : step.partLabel;
}

// The notes a step line ends with. A step of a stand-in part that gave a
// result of its own (passed, written, or stopped by its own check) carries
// the part's stand-in note; a written record also carries the note on its
// timestamp entry.
export function stepNotes(step) {
  const notes = [];
  const refusal = step.detail?.refusal;
  const ownResult = step.status === 'passed' || step.status === 'written'
    || (step.status === 'blocked' && refusal !== 'engine-error' && refusal !== 'run-stopped');
  if (ownResult && step.standIn === true && step.standInNote) notes.push(step.standInNote);
  if (step.status === 'written' && step.detail?.timestampEntry) notes.push(timestampNote(step.detail.timestampEntry));
  return notes;
}

// [hhmmss] part label | title | state word | detail
export function stepLine(step, state, at, note = null) {
  const word = LABELS.statusWords[step.status];
  if (!word) throw new Error(`no state word for status ${step.status}`);
  const detail = stepDetailText(step, state, note);
  const notes = stepNotes(step);
  const tail = notes.length ? fill(LABELS.text.withNotes, { detail, notes: notes.join(' ') }) : detail;
  return `[${clockDigits(at)}] ${partCell(step)} | ${step.title} | ${word} | ${tail}`;
}

// [hhmmss] Outcome | outcome | outcome text
export function outcomeLine(state, at) {
  const o = LABELS.outcome;
  if (state.outcome === 'paid') {
    const pay = state.steps.find((s) => s.id === 'pay');
    return `[${clockDigits(at)}] ${o.label} | ${o.paid} | ${fill(o.paidText, { paymentId: pay.detail.paymentId })}`;
  }
  const where = state.blockedAt === 'intent'
    ? o.blockedAtIntent
    : fill(o.blockedElsewhere, { title: state.steps.find((s) => s.id === state.blockedAt)?.title ?? state.blockedAt });
  return `[${clockDigits(at)}] ${o.label} | ${where} | ${state.reason}`;
}

// A path as text mode prints it: relative to the directory the demo was
// started from when it lies inside that directory, and whole when it does
// not.
export function displayPath(target, from) {
  const relative = path.relative(from, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return relative;
}

// The line that names the run directory.
export function runDirectoryLine(runDir, from) {
  return fill(LABELS.cli.runDirectory, { runDir: displayPath(runDir, from) });
}

// The lines of the offline check: each line and each note the check
// returned, as returned, then its exit status. `result` is what the check
// answered ({ exitCode, lines, notes }); nothing is added to it and no
// verdict is drawn from it here.
export function offlineCheckLines(result, at) {
  const c = LABELS.cli;
  const hhmmss = clockDigits(at);
  const said = [...(Array.isArray(result.lines) ? result.lines : []), ...(Array.isArray(result.notes) ? result.notes : [])];
  return [...said, fill(c.offlineCheckExit, { exitCode: result.exitCode })].map((line) => fill(c.offlineCheckLine, { hhmmss, line }));
}
