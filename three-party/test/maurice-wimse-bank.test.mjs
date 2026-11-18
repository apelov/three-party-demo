// Milestone 3 at the bank: the bank server with the live WIMSE authority on
// (three-party/src/maurice/bank-server.mjs + wimse.mjs). A signed payment
// settles; a retry with a FRESH WIT under the same idempotency key answers
// from the record and settles once; a byte-identical replay (same jti) is
// refused as wimse-replay; hostile presentations are refused by name and
// settle nothing. The delegation-chain fixtures are checked through the
// repository's own verifier. The run directory is scanned to prove no token,
// signature or key value lands in the evidence — only hashes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startBankServer, REPO_ROOT } from '../src/maurice/bank-server.mjs';
import { httpBankClient } from '../src/maurice/adapter.mjs';
import { runSliceLocal } from '../src/maurice/run-slice.mjs';
import {
  createDemoIdentity, createWimseSigner, writePrivateKeyFile, wimseKeysDirOf, mintWit, signRequest,
} from '../src/maurice/wimse.mjs';
import { verifyDelegationChain } from '../../src/bank/broker.mjs';

const ISS = 'https://slice-issuer.example';
const SUB = 'wimse://slice.local/agent/payments';
const PAYEE = 'DEMO-0000-2201';

const post = (url, headers, raw) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      resolve({ status: res.statusCode ?? 0, json, text, raw: Buffer.from(raw ?? '') });
    });
  });
  req.on('error', reject);
  req.end(raw);
});

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  }).on('error', reject);
});

// One bank with WIMSE on, one demo identity per test, and a signer whose
// audience is the bank's own URL. Private keys go to mode-0600 files OUTSIDE
// the run dir (a sibling <runsDir>.wimse/, the way the slice runs do it);
// the run dir keeps only the public JWKS as evidence.
async function setup({ expectedSub = SUB } = {}) {
  const runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wimse-bank-')));
  const identity = createDemoIdentity({ iss: ISS, sub: SUB });
  const keysDir = wimseKeysDirOf(runsDir, 'setup');
  writePrivateKeyFile(path.join(keysDir, 'issuer.key.json'), identity.issuer);
  writePrivateKeyFile(path.join(keysDir, 'workload.key.json'), identity.workload);
  const runDir = path.join(runsDir, 'run');
  fs.mkdirSync(path.join(runDir, 'identity'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'identity', 'jwks.json'), JSON.stringify(identity.jwks));
  const server = await startBankServer({
    repoRoot: REPO_ROOT,
    runDir,
    wimse: { jwks: identity.jwks, trustedIssuers: identity.trustedIssuers, expectedSub },
  });
  const signer = createWimseSigner({ identity, audience: server.url });
  const client = httpBankClient(server.url);
  return { runsDir, keysDir, runDir, identity, server, signer, client };
}

const paymentBody = (key, amount = '148.20') => ({
  creditorAccount: PAYEE,
  amount: { amount, currency: 'USD' },
  idempotencyKey: key,
});

// Sign and POST one payment; returns the response plus the exact wire values
// (kept in memory only) so a test can replay them byte for byte.
async function signedPay(server, signer, body, { grantRef = null, postHeaders = {}, rawOverride = null, signerOverride = null } = {}) {
  const raw = rawOverride ?? JSON.stringify(body);
  const s = (signerOverride ?? signer).sign({ method: 'POST', url: `${server.url}/v1/payments`, body: raw });
  const headers = { ...s.headers, ...postHeaders };
  if (grantRef) headers['x-grant-ref'] = grantRef;
  const res = await post(`${server.url}/v1/payments`, headers, raw);
  return { res, wire: { headers: s.headers, raw }, evidence: s.evidence };
}

async function grantRefOf(client) {
  const grant = await client.issueGrant();
  assert.equal(grant.ok, true);
  return grant.grantRef;
}

const ledgerOf = (server) => get(`${server.url}/v1/ledger`).then((r) => r.json.ledger);
const decisionsOf = (server) => get(`${server.url}/v1/wimse-decisions`).then((r) => r.json);

test('a signed payment settles through the WIMSE-gated bank, and the journal carries hashes only', async () => {
  const { runsDir, server, signer, client } = await setup();
  try {
    const grantRef = await grantRefOf(client);
    const key = 'wimse-clean-1';
    const { res, wire, evidence } = await signedPay(server, signer, paymentBody(key), { grantRef });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'accepted');
    assert.equal(typeof res.json.paymentId, 'string');
    const paymentId = res.json.paymentId;

    const ledger = await ledgerOf(server);
    assert.equal(ledger.length, 1);
    assert.ok(JSON.stringify(ledger[0]).includes(paymentId));

    const journal = await decisionsOf(server);
    assert.equal(journal.decisions.length, 1);
    assert.equal(journal.decisions[0].decision, 'accept');
    assert.equal(journal.decisions[0].reason, 'wimse-verified');
    assert.match(journal.decisions[0].wit_sha256, /^[0-9a-f]{64}$/);
    assert.match(journal.decisions[0].sig_sha256, /^[0-9a-f]{64}$/);
    assert.match(journal.note, /unsigned decision log/);
    // evidence: hashes and claims, never values
    assert.equal(evidence.iss, ISS);
    assert.equal(evidence.sub, SUB);
    assert.equal(evidence.aud, server.url);
    assert.ok(!JSON.stringify(journal).includes(wire.headers['workload-identity-token']));
    assert.ok(!JSON.stringify(journal).includes(wire.headers.signature));

    // the idempotency record carries the wimse evidence (hashes only)
    const record = await get(`${server.url}/v1/idempotency/${key}`);
    assert.equal(record.json.state, 'settled');
    assert.equal(record.json.wimse.wit_sha256, evidence.wit_sha256);
    assert.ok(!JSON.stringify(record.json).includes(wire.headers['workload-identity-token']));
  } finally {
    await server.stop();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('a retry with a FRESH WIT under the same key answers from the record and settles once; a byte-identical replay is refused as wimse-replay', async () => {
  const { runsDir, server, signer, client } = await setup();
  try {
    const key = 'wimse-retry-1';
    const grantRef = await grantRefOf(client);
    const body = paymentBody(key);

    const first = await signedPay(server, signer, body, { grantRef });
    assert.equal(first.res.status, 200, first.res.text);
    const paymentId = first.res.json.paymentId;

    // Retry 1: fresh WIT (new jti), same key, same details — safe idempotent
    // retry; the bank answers from its record without settling again.
    const grantRef2 = await grantRefOf(client);
    const second = await signedPay(server, signer, body, { grantRef: grantRef2 });
    assert.equal(second.res.status, 200, second.res.text);
    assert.equal(second.res.json.paymentId, paymentId);
    assert.notEqual(second.evidence.jti, first.evidence.jti);

    // Retry 2: byte-identical replay of the first request (same jti) —
    // refused before the grant check, and the ledger still has one row.
    const replay = await post(`${server.url}/v1/payments`, { 'x-grant-ref': grantRef, ...first.wire.headers }, first.wire.raw);
    assert.equal(replay.status, 401);
    assert.equal(replay.json.reason, 'wimse-replay');

    const ledger = await ledgerOf(server);
    assert.equal(ledger.length, 1);
    const journal = await decisionsOf(server);
    assert.deepEqual(journal.decisions.map((d) => d.decision), ['accept', 'accept', 'reject']);
    assert.equal(journal.decisions[2].reason, 'wimse-replay');
    assert.equal(journal.decisions[2].jti, first.evidence.jti);
  } finally {
    await server.stop();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('the same idempotency key with different details is a 409, and nothing new settles', async () => {
  const { runsDir, server, signer, client } = await setup();
  try {
    const key = 'wimse-conflict-1';
    const grantRef = await grantRefOf(client);
    const first = await signedPay(server, signer, paymentBody(key), { grantRef });
    assert.equal(first.res.status, 200);
    const grantRef2 = await grantRefOf(client);
    const second = await signedPay(server, signer, paymentBody(key, '999.99'), { grantRef: grantRef2 });
    assert.equal(second.res.status, 409);
    assert.equal(second.res.json.reason, 'idempotency-key-reused-with-different-details');
    assert.equal((await ledgerOf(server)).length, 1);
  } finally {
    await server.stop();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('hostile presentations are refused by name and settle nothing', async () => {
  const { runsDir, identity, server, client } = await setup();
  try {
    const key = (n) => `wimse-hostile-${n}`;
    const body = paymentBody(key(0));
    const raw = JSON.stringify(body);
    const url = `${server.url}/v1/payments`;

    // a raw signing helper for the variants the signer factory does not make
    const rawSign = ({ iss = ISS, sub = SUB, aud = server.url, ttlSeconds, workloadKey = identity.workload.privateKey, now, witNow, body: b = raw, txnToken = `txn-${crypto.randomUUID().replace(/-/g, '')}` }) => {
      const wit = mintWit({
        issuerKey: identity.issuer.privateKey, issuerKid: identity.issuer.publicJwk.kid, iss, sub,
        workloadJwk: identity.workload.publicJwk, ttlSeconds, now: witNow ?? now,
      });
      const headers = signRequest({ method: 'POST', url, body: Buffer.from(b), wit: wit.token, workloadKey, aud, txnToken, now });
      const wire = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith('_')));
      return { wit, wire };
    };

    const cases = [];
    // missing token entirely
    cases.push(['wimse-token-missing', 401, { 'x-grant-ref': 'gr_x', 'content-type': 'application/json' }, raw]);
    // untrusted issuer (signed by the trusted key, but iss is not trusted)
    {
      const { wire } = rawSign({ iss: 'https://evil.example' });
      cases.push(['wimse-wit-issuer', 401, { 'x-grant-ref': 'gr_x', ...wire }, raw]);
    }
    // expired WIT
    {
      const { wire } = rawSign({ ttlSeconds: -10 });
      cases.push(['wimse-wit-expired', 401, { 'x-grant-ref': 'gr_x', ...wire }, raw]);
    }
    // wrong audience in wimse-aud
    {
      const { wire } = rawSign({ aud: 'http://evil.example' });
      cases.push(['wimse-sig-aud', 400, { 'x-grant-ref': 'gr_x', ...wire }, raw]);
    }
    // tampered body: signed digest does not match the bytes sent
    {
      const { wire } = rawSign({});
      cases.push(['wimse-digest', 400, { 'x-grant-ref': 'gr_x', ...wire }, raw.replace('148.20', '999.99')]);
    }
    // forged workload key: the WIT names one key, another signed the request
    {
      const forged = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      const { wire } = rawSign({ workloadKey: forged });
      cases.push(['wimse-sig-signature', 400, { 'x-grant-ref': 'gr_x', ...wire }, raw]);
    }
    // expired signature window: the WIT is fresh, but created/expires are in
    // the past
    {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const { wire } = rawSign({ now: () => past, witNow: () => Math.floor(Date.now() / 1000) });
      cases.push(['wimse-sig-window', 401, { 'x-grant-ref': 'gr_x', ...wire }, raw]);
    }

    for (const [reason, status, headers, payload] of cases) {
      const res = await post(url, headers, payload);
      assert.equal(res.status, status, `${reason}: ${res.text}`);
      assert.equal(res.json.reason, reason, reason);
    }

    assert.equal((await ledgerOf(server)).length, 0, 'no hostile presentation settled');
    const journal = await decisionsOf(server);
    assert.equal(journal.decisions.length, cases.length);
    assert.ok(journal.decisions.every((d) => d.decision === 'reject'));
    assert.deepEqual(journal.decisions.map((d) => d.reason), cases.map(([r]) => r));
  } finally {
    await server.stop();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('a WIT whose sub is not the expected workload is refused with wimse-sub (403)', async () => {
  const { runsDir, identity, server, client } = await setup({ expectedSub: SUB });
  try {
    // same issuer key so the WIT itself verifies, different sub
    const signer = createWimseSigner({ identity: { ...identity, sub: 'wimse://slice.local/agent/other' }, audience: server.url });
    const grantRef = await grantRefOf(client);
    const { res } = await signedPay(server, signer, paymentBody('wimse-sub-1'), { grantRef });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'wimse-sub');
    assert.equal((await ledgerOf(server)).length, 0);
  } finally {
    await server.stop();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('the delegation-chain fixtures check out through the repository verifier: the valid two-hop accepts, the mutated ones give their Table 2 outcome', () => {
  const dir = path.join(REPO_ROOT, 'fixtures', 'delegation-chain');
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

  const valid = read('dc-compact-valid-two-hop.json');
  const ok = verifyDelegationChain(valid.chain, valid.verifierState);
  assert.equal(ok.outcome, 'valid');
  assert.equal(ok.valid, true);
  assert.equal(ok.authorizes, false, 'the chain check holds the chain and no request');
  assert.deepEqual(ok.stepsPerformed, [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(ok.stepsNotPerformed, [6, 8]);

  const expected = {
    'dc-compact-par-hash-missing.json': 'malformed',
    'dc-compact-root-untrusted-key.json': 'signature_invalid',
    'dc-compact-principal-altered.json': 'principal_altered',
    'dc-compact-depth-exceeds-max.json': 'depth_invalid',
    'dc-compact-rule1-scope-not-covered.json': 'not_narrower',
    'dc-compact-rule4-expiry-extended.json': 'expired',
  };
  for (const [name, outcome] of Object.entries(expected)) {
    const fixture = read(name);
    const result = verifyDelegationChain(fixture.chain, fixture.verifierState);
    assert.equal(result.outcome, outcome, name);
    assert.equal(result.valid, false, name);
  }
});

test('the local slice with WIMSE on: the clean run settles once through a signed request, and the run carries the signer evidence', async () => {
  const runsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wimse-slice-')));
  try {
    const result = await runSliceLocal({ kind: 'clean', runsDir, runId: 'slice-wimse-local' });
    assert.equal(result.execution.state, 'settled');
    assert.equal(result.ledger.length, 1);
    assert.equal(result.wimseDecisions.length, 1);
    assert.equal(result.wimseDecisions[0].decision, 'accept');
    const signerEvents = result.events.filter((e) => e.producer === 'wimse-signer');
    assert.equal(signerEvents.length, 1);
    assert.equal(signerEvents[0].type, 'request-signed');
    assert.match(signerEvents[0].wimse.wit_sha256, /^[0-9a-f]{64}$/);
    assert.equal(signerEvents[0].wimse.aud, result.bankUrl);
    // the poisoned slice never reaches the bank: no signed request, no accept
    const poisoned = await runSliceLocal({ kind: 'poisoned', runsDir, runId: 'slice-wimse-poisoned' });
    assert.equal(poisoned.execution.state, 'denied');
    assert.equal(poisoned.ledger.length, 0);
    assert.equal(poisoned.wimseDecisions.length, 0);
    assert.equal(poisoned.events.filter((e) => e.producer === 'wimse-signer').length, 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('the run directory holds no token, signature or key value — only hashes; the private keys sit outside it at mode 0600', async () => {
  const { runsDir, keysDir, runDir, identity, server, signer, client } = await setup();
  let wire;
  try {
    const grantRef = await grantRefOf(client);
    const { res, wire: w } = await signedPay(server, signer, paymentBody('wimse-scan-1'), { grantRef });
    wire = w;
    assert.equal(res.status, 200);
    await server.stop();

    const secretValues = [
      wire.headers['workload-identity-token'],
      wire.headers.signature,
      wire.headers['signature-input'],
      wire.headers['txn-token'],
      identity.issuer.privateKey.export({ format: 'jwk' }).d,
      identity.workload.privateKey.export({ format: 'jwk' }).d,
    ];
    // the run directory (the evidence package's scope) holds none of them
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(runDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of secretValues) {
        assert.ok(!content.includes(secret), `${path.basename(file)} must not contain a token/signature/key value`);
      }
    }
    // the private key files are outside the run dir, at mode 0600, and hold
    // no token or signature value
    const keyFiles = [path.join(keysDir, 'issuer.key.json'), path.join(keysDir, 'workload.key.json')];
    for (const file of keyFiles) {
      assert.ok(!file.startsWith(runDir + path.sep), 'the key file is outside the run directory');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the private key file is mode 0600');
      const content = fs.readFileSync(file, 'utf8');
      for (const secret of secretValues.slice(0, 4)) {
        assert.ok(!content.includes(secret), `${path.basename(file)} must not contain a token/signature value`);
      }
    }
    // the public JWKS is in the run dir, and it is public material only
    const jwks = JSON.parse(fs.readFileSync(path.join(runDir, 'identity', 'jwks.json'), 'utf8'));
    assert.equal(jwks.keys[0].kty, 'EC');
    assert.ok(!('d' in jwks.keys[0]));
  } finally {
    await server.stop().catch(() => {});
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(`${runsDir}.wimse`, { recursive: true, force: true });
  }
});
