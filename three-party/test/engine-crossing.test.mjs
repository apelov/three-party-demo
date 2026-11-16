// The crossing stand-in: the delegation chain check the bank's broker already
// has, over the repository's valid chain of two hops, and the hop file it
// leaves. A chain that does not check out stops the crossing by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DELEGATION_CHAIN_OUTCOMES } from '../../src/bank/broker.mjs';
import { CHAIN_FILE, STEPS_RUN, crossDomains, hopFileContent, namedOutcome, stepRanges } from '../src/crossing/hop.mjs';
import { LABELS } from '../src/engine/labels.mjs';
import { REPO_ROOT, example } from './support/engine-helpers.mjs';

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/delegation-chain', name), 'utf8'));

test('the crossing runs the chain check over the valid chain of two hops and reports the outcome the chain file names', () => {
  const ex = example('hop-03-crossing.hop.json');
  const crossing = crossDomains({ repoRoot: REPO_ROOT });
  assert.equal(crossing.ok, true);
  assert.equal(crossing.refusal, null);
  assert.equal(crossing.expectedOutcome, 'valid');
  assert.equal(crossing.result.outcome, 'valid');
  assert.equal(crossing.result.valid, true);
  // The check holds the chain and no request: it reports no action as permitted.
  assert.equal(crossing.result.authorizes, false);
  assert.deepEqual(crossing.result.stepsNotPerformed, [6, 8]);
  assert.deepEqual(crossing.result.stepsPerformed, [1, 2, 3, 4, 5, 7]);
  assert.equal(CHAIN_FILE, ex.chainFile);
  const bytes = fs.readFileSync(path.join(REPO_ROOT, CHAIN_FILE));
  assert.deepEqual(crossing.hop, {
    from: ex.from,
    to: ex.to,
    chainFile: ex.chainFile,
    chainSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    hops: 2,
    outcome: 'valid',
    stepsRun: ex.stepsRun,
    standIn: ex.standIn,
  });
  assert.equal(crossing.hop.chainSha256, ex.chainSha256, 'the example carries the hash of the chain file as it is in the repository');
});

test('the hop file carries the contract fields in the contract order, and the stand-in words byte for byte', () => {
  const ex = example('hop-03-crossing.hop.json');
  const { hop } = crossDomains({ repoRoot: REPO_ROOT });
  const file = hopFileContent({ runId: ex.runId, seq: ex.seq, at: ex.at, hop });
  assert.deepEqual(Object.keys(file), Object.keys(ex));
  assert.deepEqual(file, ex);
  assert.equal(file.standIn, 'AI2II interop: stand-in; the real piece replaces the hop file, not code');
  assert.equal(file.standIn, LABELS.crossing.standIn);
  assert.equal(STEPS_RUN, '1 to 5 and 7 of draft-asor-wimse-agent-delegation-chain-03 section 6');
  assert.equal(file.from, LABELS.domains.agent);
  assert.equal(file.to, LABELS.domains.bank);
});

test('a chain the check denies stops the crossing: the outcome is the name the check gave, and the refusal says the chain is not valid', () => {
  for (const [name, outcome] of [['dc-compact-root-untrusted-key.json', 'signature_invalid'], ['dc-compact-par-hash-missing.json', 'malformed']]) {
    const crossing = crossDomains({ repoRoot: REPO_ROOT, chainFile: `fixtures/delegation-chain/${name}` });
    assert.equal(crossing.ok, false, name);
    assert.equal(crossing.refusal, 'crossing-chain-not-valid', name);
    assert.equal(crossing.hop.outcome, outcome, name);
    assert.equal(crossing.expectedOutcome, outcome, name);
    assert.ok(DELEGATION_CHAIN_OUTCOMES.includes(crossing.hop.outcome), 'a Table 2 name');
  }
});

test('a chain file that names an outcome the check does not give stops the crossing, whichever way they differ', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-chain-')));
  try {
    // A denied chain in a file that says a verifier must accept it.
    const denied = readFixture('dc-compact-root-untrusted-key.json');
    fs.writeFileSync(path.join(dir, 'says-accept.json'), JSON.stringify({ ...denied, expected: { verifyResult: 'ACCEPT' } }));
    const a = crossDomains({ repoRoot: dir, chainFile: 'says-accept.json' });
    assert.equal(a.ok, false);
    assert.equal(a.refusal, 'crossing-outcome-not-as-named');
    assert.equal(a.hop.outcome, 'signature_invalid');
    assert.equal(a.expectedOutcome, 'valid');
    // A valid chain in a file that says a verifier must deny it.
    const valid = readFixture('dc-compact-valid-two-hop.json');
    fs.writeFileSync(path.join(dir, 'says-reject.json'), JSON.stringify({ ...valid, expected: { verifyResult: 'REJECT', rejectCategory: 'expired' } }));
    const b = crossDomains({ repoRoot: dir, chainFile: 'says-reject.json' });
    assert.equal(b.ok, false);
    assert.equal(b.refusal, 'crossing-outcome-not-as-named');
    assert.equal(b.hop.outcome, 'valid');
    assert.equal(b.expectedOutcome, 'expired');
    // The hash is over the bytes of the file that was read.
    assert.equal(b.hop.chainSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'says-reject.json'))).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the outcome a chain file names, and the words for the steps the check runs', () => {
  assert.equal(namedOutcome({ expected: { verifyResult: 'ACCEPT' } }), 'valid');
  assert.equal(namedOutcome({ expected: { verifyResult: 'REJECT', rejectCategory: 'not_narrower' } }), 'not_narrower');
  assert.equal(namedOutcome({ expected: { verifyResult: 'REJECT' } }), null);
  assert.equal(namedOutcome({}), null);
  assert.equal(stepRanges([1, 2, 3, 4, 5, 7]), '1 to 5 and 7');
  assert.equal(stepRanges([1, 2, 3]), '1 to 3');
  assert.equal(stepRanges([4]), '4');
  assert.equal(stepRanges([1, 3, 5]), '1, 3 and 5');
  assert.equal(stepRanges([1, 2, 4, 5, 7, 8]), '1 to 2, 4 to 5 and 7 to 8');
  assert.equal(stepRanges([]), '');
});
