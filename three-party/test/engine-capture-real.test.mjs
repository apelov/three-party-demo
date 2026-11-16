// The AI2II capture check over the files AI2II published, as fetched into
// three-party/external/ai2ii/ by scripts/three-party/fetch-ai2ii.mjs. The
// tree holds none of them, so with the folder absent the tests skip and say
// so; files there that differ from their pins fail the first test.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AI2II_SOURCE, DEFAULT_AI2II_DIR, loadCapture } from '../src/engine/ai2ii-source.mjs';
import { CHECK_NAMES, checkCapture, readConnection, readExchange, readPcap } from '../src/engine/capture.mjs';
import { runToEnd } from '../src/engine/run.mjs';
import { removeDir, tempRunsDir, walkFiles } from './support/engine-helpers.mjs';

const loaded = loadCapture();
const skip = loaded.why === 'absent'
  ? `the AI2II capture is not in ${path.relative(process.cwd(), DEFAULT_AI2II_DIR) || DEFAULT_AI2II_DIR} (${loaded.missing.join(', ')} missing); fetch it with node scripts/three-party/fetch-ai2ii.mjs`
  : false;
const runsDir = tempRunsDir();
after(() => removeDir(runsDir));

// The values the capture carries in its request, read here with the same
// reader, to look for in the files of a run.
function capturedValues() {
  const { up } = readConnection(readPcap(loaded.bytes.capture));
  const { request } = readExchange(up, Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
  const field = (name) => request.headers.find(([n]) => n === name)[1];
  const signature = /^wimse=:([A-Za-z0-9+/=]+):$/.exec(field('signature'))[1];
  return { token: field('workload-identity-token'), tokenSignature: field('workload-identity-token').split('.')[2], signature, signatureHex: Buffer.from(signature, 'base64').toString('hex'), txnToken: field('txn-token') };
}

test('the published files are in the folder with their pinned sizes and SHA-256, and the capture passes all seven checks', { skip }, () => {
  assert.equal(loaded.use, true, `files that differ from their pins: ${JSON.stringify(loaded.differing)}; fetch them again with node scripts/three-party/fetch-ai2ii.mjs`);
  const result = checkCapture(loaded.bytes, { source: AI2II_SOURCE, files: loaded.files });
  assert.deepEqual(result.checks.map((c) => [c.name, c.answer]), CHECK_NAMES.map((name) => [name, 'pass']), JSON.stringify(result.checks.filter((c) => c.answer !== 'pass')));
  assert.equal(result.outcome, 'verified');
  assert.deepEqual(result.files, Object.values(AI2II_SOURCE.files).map(({ name, size, sha256 }) => ({ name, size, sha256 })));
  assert.equal(result.source.commit, '32f584a2016d7ebd0d2f5156148cc404c496a086');
  assert.deepEqual(result.token.header, { alg: 'ES256', kid: 'harbor-1', typ: 'wit+jwt' });
  assert.equal(result.token.claims.iss, 'wimse://harbor.example');
  assert.equal(result.token.claims.sub, 'wimse://harbor.example/agent/payments');
  assert.equal(result.token.claims.exp - result.token.claims.iat, 3600);
  assert.equal(result.token.claims.cnf.jwk.kid, 'agent-wl-1');
  assert.deepEqual(result.exchange, { from: 'harbor.example', to: 'northbank.example', loopback: true, invoice: '4471', amount: 4200, currency: 'USD' });
  const facts = Object.fromEntries(result.checks.map((c) => [c.name, c.facts]));
  assert.deepEqual([facts.capture.link, facts.capture.client, facts.capture.server, facts.capture.request, facts.capture.status], ['NULL', '127.0.0.1:54321', '127.0.0.1:5070', 'POST /api/transfer', 200]);
  assert.deepEqual(facts.witSignature, { typ: 'wit+jwt', alg: 'ES256', kid: 'harbor-1', keySet: 'harbor.example' });
  assert.deepEqual(facts.httpSignature.covered, ['@method', '@path', '@query', 'content-type', 'content-digest', 'txn-token', 'workload-identity-token']);
  assert.equal(facts.httpSignature.audience, 'wimse://northbank.example/api/transfer');
  assert.equal(result.scope[0], 'A capture published by AI2II in https://github.com/apelov/IETF127-Hackathon-AI2II-WIMSE at commit 32f584a2, of a separate loopback exchange (harbor.example to northbank.example, invoice 4471, 4200 USD), not a crossing minted for this payment.');
  const text = JSON.stringify(result);
  for (const [name, value] of Object.entries(capturedValues())) assert.equal(text.includes(value), false, name);
});

test('a clean run with the published files takes the supplied crossing, pays, and leaves no token, signature or Txn-Token value in any file', { skip }, async () => {
  const { state, runDir, error } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir });
  assert.equal(error, null);
  assert.equal(state.outcome, 'paid');
  const crossing = state.steps.find((s) => s.id === 'crossing');
  assert.deepEqual({ variant: crossing.variant, standIn: crossing.standIn, status: crossing.status, outcome: crossing.detail.outcome }, { variant: 'supplied', standIn: false, status: 'passed', outcome: 'verified' });
  const files = walkFiles(runDir).map((f) => path.join(runDir, f));
  for (const [name, value] of Object.entries(capturedValues())) {
    assert.deepEqual(files.filter((file) => fs.readFileSync(file).includes(Buffer.from(value, 'latin1'))), [], name);
  }
});
