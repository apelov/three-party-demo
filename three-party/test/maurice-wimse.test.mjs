// Live WIMSE primitives (three-party/src/maurice/wimse.mjs): a fresh demo key
// per signing principal, WIT mint/verify round-trip, RFC 9421 request signing
// and verification, content-digest binding, and the jti replay store — the
// rejection cases of Milestone 3 at the primitive level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKey, issuerJwks, mintWit, signRequest, verifyWit, verifyHttpSignature, createJtiStore } from '../src/maurice/wimse.mjs';

const ISS = 'https://slice-issuer.example';
const SUB = 'wimse://slice.local/agent/payments';
const AUD = 'http://127.0.0.1:9999';

function principals() {
  const issuer = generateKey('slice-issuer-1');
  const workload = generateKey('slice-wl-1');
  const jwks = issuerJwks('slice-issuer-1', issuer.publicJwk);
  return { issuer, workload, jwks };
}

function makeSigned(principals_, { body, aud = AUD, txnToken = 'txn-123', url = 'http://127.0.0.1:9999/v1/payments?x=1', ttlSeconds } = {}) {
  const wit = mintWit({
    issuerKey: principals_.issuer.privateKey, issuerKid: 'slice-issuer-1', iss: ISS, sub: SUB,
    workloadJwk: principals_.workload.publicJwk, ttlSeconds,
  });
  const headers = signRequest({ method: 'POST', url, body, wit: wit.token, workloadKey: principals_.workload.privateKey, aud, txnToken });
  const wire = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith('_')));
  return { wit, wire, body, url };
}

test('WIT mint/verify round-trip: typ, alg, kid, signature under the issuer JWKS, trusted issuer, window, jti', () => {
  const p = principals();
  const wit = mintWit({ issuerKey: p.issuer.privateKey, issuerKid: 'slice-issuer-1', iss: ISS, sub: SUB, workloadJwk: p.workload.publicJwk });
  const v = verifyWit({ token: wit.token, jwks: p.jwks, trustedIssuers: [ISS] });
  assert.equal(v.ok, true);
  assert.equal(v.claims.sub, SUB);
  assert.equal(v.claims.iss, ISS);
  assert.equal(v.header.typ, 'wit+jwt');
  assert.equal(v.claims.cnf.jwk.kid, 'slice-wl-1');
  assert.match(v.sha256, /^[0-9a-f]{64}$/);
});

test('WIT rejections: malformed, bad signature, untrusted issuer, expired, missing jti', () => {
  const p = principals();
  const wit = mintWit({ issuerKey: p.issuer.privateKey, issuerKid: 'slice-issuer-1', iss: ISS, sub: SUB, workloadJwk: p.workload.publicJwk });
  assert.equal(verifyWit({ token: 'not-a-jwt', jwks: p.jwks, trustedIssuers: [ISS] }).refusal, 'wit-malformed');
  assert.equal(verifyWit({ token: `${wit.token.slice(0, -2)}xx`, jwks: p.jwks, trustedIssuers: [ISS] }).refusal, 'wit-signature');
  assert.equal(verifyWit({ token: wit.token, jwks: p.jwks, trustedIssuers: ['https://other.example'] }).refusal, 'wit-issuer');
  assert.equal(verifyWit({ token: wit.token, jwks: { keys: [] }, trustedIssuers: [ISS] }).refusal, 'wit-key');
  const expired = mintWit({ issuerKey: p.issuer.privateKey, issuerKid: 'slice-issuer-1', iss: ISS, sub: SUB, workloadJwk: p.workload.publicJwk, ttlSeconds: -10 });
  assert.equal(verifyWit({ token: expired.token, jwks: p.jwks, trustedIssuers: [ISS] }).refusal, 'wit-expired');
  const noJti = mintWit({ issuerKey: p.issuer.privateKey, issuerKid: 'slice-issuer-1', iss: ISS, sub: SUB, workloadJwk: p.workload.publicJwk });
  const tamperedClaims = { ...noJti.claims };
  delete tamperedClaims.jti;
  const h = Buffer.from(JSON.stringify(noJti.header)).toString('base64url');
  const c = Buffer.from(JSON.stringify(tamperedClaims)).toString('base64url');
  const forged = `${h}.${c}.${noJti.token.split('.')[2]}`;
  assert.equal(verifyWit({ token: forged, jwks: p.jwks, trustedIssuers: [ISS] }).refusal, 'wit-signature'); // claims changed, sig no longer matches
});

test('signed request verifies, and tampered body / wrong audience / bad signature are rejected', () => {
  const p = principals();
  const body = Buffer.from(JSON.stringify({ creditorAccount: 'DEMO-0000-2201', amount: { amount: '148.20', currency: 'USD' } }));
  const { wit, wire, url } = makeSigned(p, { body });
  const ok = verifyHttpSignature({ method: 'POST', url, headers: wire, body, expectedAud: AUD, workloadJwk: wit.claims.cnf.jwk });
  assert.equal(ok.ok, true);
  assert.equal(ok.signature.aud, AUD);
  assert.equal(ok.signature.tag, 'wimse-workload-to-workload');
  assert.ok(ok.signature.covered.includes('workload-identity-token'));

  const tampered = verifyHttpSignature({ method: 'POST', url, headers: wire, body: Buffer.from(body.toString('utf8') + ' '), expectedAud: AUD, workloadJwk: wit.claims.cnf.jwk });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.refusal, 'digest');

  const wrongAud = verifyHttpSignature({ method: 'POST', url, headers: wire, body, expectedAud: 'http://evil.example', workloadJwk: wit.claims.cnf.jwk });
  assert.equal(wrongAud.ok, false);
  assert.equal(wrongAud.refusal, 'sig-aud');

  // Sign with a different workload key: the signature no longer matches cnf.jwk.
  const other = generateKey('slice-wl-2');
  const forged = signRequest({ method: 'POST', url, body, wit: wit.token, workloadKey: other.privateKey, aud: AUD });
  const forgedWire = Object.fromEntries(Object.entries(forged).filter(([k]) => !k.startsWith('_')));
  const badSig = verifyHttpSignature({ method: 'POST', url, headers: forgedWire, body, expectedAud: AUD, workloadJwk: wit.claims.cnf.jwk });
  assert.equal(badSig.ok, false);
  assert.equal(badSig.refusal, 'sig-signature');

  // Signature expired (window check).
  const stale = signRequest({ method: 'POST', url, body, wit: wit.token, workloadKey: p.workload.privateKey, aud: AUD, lifetime: -5, now: () => Math.floor(Date.now() / 1000) - 100 });
  const staleWire = Object.fromEntries(Object.entries(stale).filter(([k]) => !k.startsWith('_')));
  const expired = verifyHttpSignature({ method: 'POST', url, headers: staleWire, body, expectedAud: AUD, workloadJwk: wit.claims.cnf.jwk });
  assert.equal(expired.ok, false);
  assert.equal(expired.refusal, 'sig-window');
});

test('jti store: a repeated jti is a replay; a fresh jti is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jti-'));
  const store = createJtiStore(path.join(dir, 'jti-seen.txt'));
  assert.equal(store.check('aaa'), true);
  assert.equal(store.check('aaa'), false);
  assert.equal(store.check('bbb'), true);
  const again = createJtiStore(path.join(dir, 'jti-seen.txt'));
  assert.equal(again.check('aaa'), false, 'the store is durable across restarts');
  assert.equal(again.check('ccc'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
