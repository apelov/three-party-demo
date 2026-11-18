// Live WIMSE workload identity for the slice's crossing (Milestone 3):
// fresh demo keys per signing principal, a WIT (Workload Identity Token,
// typ wit+jwt, ES256) minted per execution, and the request signed per
// RFC 9421 with the wimse-workload-to-workload tag and a wimse-aud parameter,
// matching the wire format of the pinned AI2II capture (decoded in Milestone
// 0) and the hackathon harness' drafts (workload-creds, http-signature).
//
// The signing side (mintWit, signRequest) and the verifying side (verifyWit,
// verifyHttpSignature, verifyContentDigest, JtiStore) are separate functions
// on purpose: the bank verifies the authority it receives independently of
// the adapter's allow decision, and nothing here trusts the signer.
//
// Private keys stay in memory (or a mode-0600 file under the gitignored runs
// directory); evidence exports carry only the public JWKS, the token's
// SHA-256, its header/claims and the signature's SHA-256 — never a token,
// signature or key value.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDictionary, signatureBase } from '../engine/capture.mjs';

export const WIT_TYP = 'wit+jwt';
export const SIG_TAG = 'wimse-workload-to-workload';
export const SIG_ALG = 'ecdsa-p256-sha256';

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
export const sha256Hex = (bytes) => sha256(bytes).toString('hex');

// ---- keys

// A fresh ES256 (P-256) demo key pair. Returns the private key object and
// the public JWK with the given kid.
export function generateKey(kid, alg = 'ES256') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg, kid } };
}

// The public JWKS document for an issuer key.
export function issuerJwks(issuerKid, issuerPublicJwk) {
  return { keys: [{ ...issuerPublicJwk, kid: issuerKid }] };
}

function signRaw(privateKey, data) {
  // ieee-p1363 is the raw r||s form JWS and RFC 9421 use for ES256.
  return crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

function verifyRaw(publicJwk, data, signature) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, format: 'jwk' });
    return signature.length === 64 && crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

// ---- the WIT

// Mints one WIT: header {alg, kid, typ: wit+jwt}, claims {iss, sub, iat,
// exp, jti, cnf: {jwk: <the workload's public key>}}. Returns the token plus
// the facts evidence may carry (never the token value in exports; the token
// itself is returned here for the signer to put on the wire).
export function mintWit({ issuerKey, issuerKid, iss, sub, workloadJwk, ttlSeconds = 300, now = () => Math.floor(Date.now() / 1000) }) {
  const iat = now();
  const header = { alg: 'ES256', kid: issuerKid, typ: WIT_TYP };
  const claims = { iss, sub, iat, exp: iat + ttlSeconds, jti: b64u(crypto.randomBytes(16)), cnf: { jwk: workloadJwk } };
  const h = b64u(Buffer.from(JSON.stringify(header)));
  const c = b64u(Buffer.from(JSON.stringify(claims)));
  const signingInput = Buffer.from(`${h}.${c}`, 'ascii');
  const token = `${h}.${c}.${b64u(signRaw(issuerKey, signingInput))}`;
  return { token, header, claims, sha256: sha256Hex(Buffer.from(token, 'ascii')) };
}

// Parses and verifies a WIT against a JWKS document and a list of trusted
// issuer URIs. Returns { ok, refusal, header, claims, sha256 }.
//   refusal: 'wit-malformed' | 'wit-typ' | 'wit-alg' | 'wit-kid' |
//            'wit-key' | 'wit-signature' | 'wit-issuer' | 'wit-expired' |
//            'wit-iat' | 'wit-jti'
export function verifyWit({ token, jwks, trustedIssuers, now = () => Math.floor(Date.now() / 1000) }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, refusal: 'wit-malformed' };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, refusal: 'wit-malformed' };
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return { ok: false, refusal: 'wit-malformed' };
  const sha256 = sha256Hex(Buffer.from(token, 'ascii'));
  if (header.typ !== WIT_TYP) return { ok: false, refusal: 'wit-typ', header, claims, sha256 };
  if (header.alg !== 'ES256') return { ok: false, refusal: 'wit-alg', header, claims, sha256 };
  if (typeof header.kid !== 'string') return { ok: false, refusal: 'wit-kid', header, claims, sha256 };
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const key = keys.find((k) => k?.kid === header.kid);
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') {
    return { ok: false, refusal: 'wit-key', header, claims, sha256 };
  }
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  if (!verifyRaw(key, signingInput, Buffer.from(parts[2], 'base64url'))) return { ok: false, refusal: 'wit-signature', header, claims, sha256 };
  if (!trustedIssuers.includes(claims.iss)) return { ok: false, refusal: 'wit-issuer', header, claims, sha256 };
  const t = now();
  if (!Number.isFinite(claims.exp) || claims.exp <= t) return { ok: false, refusal: 'wit-expired', header, claims, sha256 };
  if (!Number.isFinite(claims.iat) || claims.iat > t + 60) return { ok: false, refusal: 'wit-iat', header, claims, sha256 };
  if (typeof claims.jti !== 'string' || claims.jti === '') return { ok: false, refusal: 'wit-jti', header, claims, sha256 };
  return { ok: true, refusal: null, header, claims, sha256 };
}

// ---- the signed request (RFC 9421, wit+http-sig mechanism)

// Builds the headers of one signed request: Workload-Identity-Token,
// Content-Digest (sha-256 of the body), Txn-Token, Signature-Input and
// Signature over @method @path @query content-type content-digest txn-token
// workload-identity-token, with created/expires, a nonce, the
// wimse-workload-to-workload tag and the wimse-aud parameter.
export function signRequest({ method, url, body, wit, workloadKey, aud, txnToken, lifetime = 60, now = () => Math.floor(Date.now() / 1000), nonce = b64u(crypto.randomBytes(16)) }) {
  const u = new URL(url);
  const query = u.search ? u.search.slice(1) : null;
  const headers = {
    'workload-identity-token': wit,
    'content-type': 'application/json',
    'content-digest': `sha-256=:${sha256(body).toString('base64')}:`,
    'txn-token': txnToken,
  };
  const components = ['@method', '@path', '@query', 'content-type', 'content-digest', 'txn-token', 'workload-identity-token'];
  const values = {
    '@method': method.toUpperCase(),
    '@path': u.pathname,
    '@query': query === null ? '?' : `?${query}`,
    ...Object.fromEntries(Object.entries(headers)),
  };
  const created = now();
  const params = `(${components.map((c) => `"${c}"`).join(' ')});created=${created};expires=${created + lifetime};nonce="${nonce}";tag="${SIG_TAG}";wimse-aud="${aud}"`;
  // Parse the params back through the same RFC 8941 parser the verifier uses,
  // so both sides build the identical @signature-params line.
  const member = parseDictionary(`wimse=${params}`).get('wimse');
  const sig = signRaw(workloadKey, signatureBase(
    { method: method.toUpperCase(), path: u.pathname, query, headers: Object.entries(headers) },
    member,
  ));
  return {
    ...headers,
    'signature-input': `wimse=${params}`,
    'signature': `wimse=:${sig.toString('base64')}:`,
    'content-length': String(body.length),
    _values: values,
    _params: params,
  };
}

// Verifies one signed request. `headers` is a map of lower-case name -> value
// as received. Returns { ok, refusal, signature? }.
//   refusal: 'sig-input' | 'sig-label' | 'sig-params' | 'sig-covered' |
//            'sig-aud' | 'sig-window' | 'sig-tag' | 'sig-value' |
//            'sig-key' | 'sig-signature' | 'digest' | 'txn'
export function verifyHttpSignature({ method, url, headers, body, expectedAud, workloadJwk, now = () => Math.floor(Date.now() / 1000) }) {
  const u = new URL(url, 'http://127.0.0.1');
  const input = headers['signature-input'];
  const sig = headers['signature'];
  if (typeof input !== 'string' || typeof sig !== 'string') return { ok: false, refusal: 'sig-input' };
  let inputs;
  try {
    inputs = parseDictionary(input);
  } catch {
    return { ok: false, refusal: 'sig-input' };
  }
  const label = inputs.size === 1 ? [...inputs.keys()][0] : (inputs.has('wimse') ? 'wimse' : null);
  if (label === null) return { ok: false, refusal: 'sig-label' };
  const member = inputs.get(label);
  if (!member?.list) return { ok: false, refusal: 'sig-params' };
  const params = member.params;
  const covered = member.list.map((i) => (typeof i.value === 'string' ? i.value : null));
  const required = ['@method', '@path', 'content-digest', 'workload-identity-token'];
  if (!required.every((c) => covered.includes(c))) return { ok: false, refusal: 'sig-covered', covered };
  const text = (name) => (typeof params.get(name) === 'string' ? params.get(name) : null);
  const aud = text('wimse-aud');
  if (aud !== expectedAud) return { ok: false, refusal: 'sig-aud', aud };
  if (text('tag') !== SIG_TAG) return { ok: false, refusal: 'sig-tag' };
  const created = params.get('created');
  const expires = params.get('expires');
  if (!Number.isInteger(created) || !Number.isInteger(expires)) return { ok: false, refusal: 'sig-params' };
  const t = now();
  if (t < created - 60 || t > expires) return { ok: false, refusal: 'sig-window', created, expires };
  // The body must match the signed Content-Digest.
  const digestHeader = headers['content-digest'];
  if (typeof digestHeader !== 'string') return { ok: false, refusal: 'digest' };
  let digestMember;
  try {
    digestMember = parseDictionary(digestHeader).get('sha-256');
  } catch {
    return { ok: false, refusal: 'digest' };
  }
  if (!digestMember || !Buffer.isBuffer(digestMember.value) || !digestMember.value.equals(sha256(body))) {
    return { ok: false, refusal: 'digest' };
  }
  // The signature value, under the workload key the WIT confirmed.
  let sigMember;
  try {
    sigMember = parseDictionary(sig).get(label);
  } catch {
    return { ok: false, refusal: 'sig-value' };
  }
  if (!sigMember || !Buffer.isBuffer(sigMember.value)) return { ok: false, refusal: 'sig-value' };
  if (!workloadJwk || workloadJwk.kty !== 'EC' || workloadJwk.crv !== 'P-256') return { ok: false, refusal: 'sig-key' };
  const request = { method: method.toUpperCase(), path: u.pathname, query: u.search ? u.search.slice(1) : null, headers: Object.entries(headers) };
  const base = signatureBase(request, member);
  if (!verifyRaw(workloadJwk, base, sigMember.value)) return { ok: false, refusal: 'sig-signature' };
  const txn = headers['txn-token'];
  if (typeof txn !== 'string' || txn === '') return { ok: false, refusal: 'txn' };
  return {
    ok: true,
    refusal: null,
    signature: {
      label, covered, aud, tag: text('tag'), created, expires, nonce: text('nonce'),
      sha256: sha256Hex(sigMember.value), txnSha256: sha256Hex(Buffer.from(txn, 'latin1')),
    },
  };
}

// ---- the demo signing identity and signer

// One demo identity per run: a fresh issuer key (whose public JWKS the bank
// trusts) and a fresh workload key (whose public JWK the WIT's cnf names).
// Private keys never leave memory or a mode-0600 file under the gitignored
// runs directory; every export below carries public material and hashes only.
export function createDemoIdentity({ iss, sub, issuerKid = 'slice-issuer', workloadKid = 'slice-workload' }) {
  const issuer = generateKey(issuerKid);
  const workload = generateKey(workloadKid);
  return {
    iss,
    sub,
    issuer,
    workload,
    jwks: issuerJwks(issuerKid, issuer.publicJwk),
    trustedIssuers: [iss],
  };
}

// Writes a private JWK to a mode-0600 file under the (gitignored) runs dir.
export function writePrivateKeyFile(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(key.privateKey.export({ format: 'jwk' })), { mode: 0o600 });
}

// Where a run's WIMSE private keys live: a sibling of the runs directory
// (`<runsDir>.wimse/<runId>/`), never inside the run directory — the run
// directory is the evidence package's scope, and the AEP offline check
// refuses a run directory that holds a private key. Only the public JWKS
// goes into the run directory. The key directory is deleted when the run
// ends.
export function wimseKeysDirOf(runsDir, runId) {
  return path.join(`${path.resolve(runsDir)}.wimse`, runId);
}

// Rebuilds a demo identity from the key files writePrivateKeyFile wrote (the
// live path: the MCP adapter is a separate process and loads its signing
// identity from the run directory, never from the network).
export function identityFromKeyFiles({ dir, iss, sub, issuerKid = 'slice-issuer', workloadKid = 'slice-workload' }) {
  const issuerJwk = JSON.parse(fs.readFileSync(path.join(dir, 'issuer.key.json'), 'utf8'));
  const workloadJwk = JSON.parse(fs.readFileSync(path.join(dir, 'workload.key.json'), 'utf8'));
  const pub = (jwk, kid) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: 'ES256', kid });
  const issuer = { privateKey: crypto.createPrivateKey({ key: issuerJwk, format: 'jwk' }), publicJwk: pub(issuerJwk, issuerKid) };
  const workload = { privateKey: crypto.createPrivateKey({ key: workloadJwk, format: 'jwk' }), publicJwk: pub(workloadJwk, workloadKid) };
  return { iss, sub, issuer, workload, jwks: issuerJwks(issuerKid, issuer.publicJwk), trustedIssuers: [iss] };
}

// The signing half of a run. sign() mints a FRESH WIT (fresh jti) per call and
// signs the exact request bytes, so an idempotent retry with the same key is
// safe, while a byte-identical replay (same jti) is caught by the bank's jti
// store. The returned evidence carries hashes and claims only — never a
// token, signature or key value.
export function createWimseSigner({ identity, audience, ttlSeconds = 300, now = () => Math.floor(Date.now() / 1000) }) {
  const { iss, sub, issuer, workload } = identity;
  const workloadJwk = { kty: workload.publicJwk.kty, crv: workload.publicJwk.crv, x: workload.publicJwk.x, y: workload.publicJwk.y };
  return {
    iss,
    sub,
    audience,
    jwks: identity.jwks,
    trustedIssuers: identity.trustedIssuers,
    sign({ method, url, body, txnToken = `txn_${crypto.randomUUID().replace(/-/g, '')}`, witTtlSeconds = ttlSeconds }) {
      const wit = mintWit({
        issuerKey: issuer.privateKey,
        issuerKid: issuer.publicJwk.kid,
        iss,
        sub,
        workloadJwk,
        ttlSeconds: witTtlSeconds,
        now,
      });
      const signed = signRequest({
        method,
        url,
        body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
        wit: wit.token,
        workloadKey: workload.privateKey,
        aud: audience,
        txnToken,
        now,
      });
      const { _values, _params, ...headers } = signed;
      return {
        headers,
        evidence: {
          wit_sha256: wit.sha256,
          jti: wit.claims.jti,
          iss,
          sub,
          aud: audience,
          sig_sha256: sha256Hex(Buffer.from(signed.signature, 'ascii')),
          txn_sha256: sha256Hex(Buffer.from(txnToken, 'ascii')),
        },
      };
    },
  };
}

// ---- replay protection

// A durable jti store: one line per seen jti, in the run directory. A jti
// seen before is a replay; a retry with the SAME idempotency key is safe only
// because it carries a FRESH WIT (a new jti) — the idempotency layer above
// decides whether it settles again.
export function createJtiStore(file) {
  const seen = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) seen.add(line.trim());
  } catch { /* no store yet */ }
  return {
    check(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      fs.appendFileSync(file, `${jti}\n`);
      return true;
    },
    get size() { return seen.size; },
  };
}
