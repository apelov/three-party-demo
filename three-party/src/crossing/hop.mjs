// The crossing from the payments agent's trust domain into the supplier's
// bank's trust domain, as a stand-in for the AI2II interop piece.
//
// What runs is real and local: the delegation chain check the bank's broker
// already has (verifyDelegationChain of src/bank/broker.mjs) over the
// repository's valid chain of two hops, under the verifier state that chain
// file carries (its own clock and its trusted root key). The result goes to a
// hop file in the run directory. The real piece replaces that hop file, not
// this code.
//
// What it is not: the check holds the chain and no request, so it runs steps
// 1 to 5 and 7 of the draft's section 6 and reports no action as permitted.
// The chain is a fixture, not one minted for this payment.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyDelegationChain } from '../../../src/bank/broker.mjs';
import { DRAFT, STEPS_PERFORMED } from '../../../src/bank/delegation-chain.mjs';
import { LABELS, fill } from '../engine/labels.mjs';

export const CHAIN_FILE = 'fixtures/delegation-chain/dc-compact-valid-two-hop.json';

// [1, 2, 3, 4, 5, 7] reads "1 to 5 and 7".
export function stepRanges(steps) {
  const runs = [];
  for (const n of steps) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const words = runs.map(([a, b]) => (a === b ? String(a) : `${a} to ${b}`));
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

export const STEPS_RUN = fill(LABELS.crossing.stepsRun, { steps: stepRanges(STEPS_PERFORMED), draft: DRAFT });

// The outcome a chain file names: 'valid' for a chain a verifier must
// accept, else the Table 2 name it must give.
export function namedOutcome(fixture) {
  if (fixture?.expected?.verifyResult === 'ACCEPT') return 'valid';
  return fixture?.expected?.rejectCategory ?? null;
}

// Runs the crossing. Returns the hop (the fields of the hop file that do not
// depend on the run), the chain check's own result, and whether the hop went
// through: the check returned 'valid', and that is the outcome the chain file
// names.
//   refusal: null, 'crossing-chain-not-valid' or 'crossing-outcome-not-as-named'.
export function crossDomains({ repoRoot, chainFile = CHAIN_FILE, from = LABELS.domains.agent, to = LABELS.domains.bank }) {
  const bytes = fs.readFileSync(path.join(repoRoot, chainFile));
  const fixture = JSON.parse(bytes.toString('utf8'));
  const result = verifyDelegationChain(fixture.chain, fixture.verifierState);
  const expected = namedOutcome(fixture);
  let refusal = null;
  if (result.outcome !== expected) refusal = 'crossing-outcome-not-as-named';
  else if (result.valid !== true) refusal = 'crossing-chain-not-valid';
  return {
    ok: refusal === null,
    refusal,
    expectedOutcome: expected,
    result,
    hop: {
      from,
      to,
      chainFile,
      chainSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      hops: fixture.chain.length - 1,
      outcome: result.outcome,
      stepsRun: STEPS_RUN,
      standIn: LABELS.crossing.standIn,
    },
  };
}

// The hop file of CONTRACT.md section 5, in its field order.
export function hopFileContent({ runId, seq, at, hop }) {
  return {
    runId,
    seq,
    at,
    from: hop.from,
    to: hop.to,
    chainFile: hop.chainFile,
    chainSha256: hop.chainSha256,
    hops: hop.hops,
    outcome: hop.outcome,
    stepsRun: hop.stepsRun,
    standIn: hop.standIn,
  };
}
