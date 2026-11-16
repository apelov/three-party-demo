// The engine's own checks, each a separate function that returns a named
// refusal: the agent's credential, the declared payment against the grant's
// scope, and the grant's life. Every refusing case here is an input that
// breaks the clause it names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { BILLPAY_CONSENT_TERMS } from '../../src/config.mjs';
import { loadTrust } from '../../src/bank/broker.mjs';
import { CREDENTIAL_REFUSALS, SCOPE_CHECKS, checkCredential, checkGrantExpiry, checkGrantScope } from '../src/engine/checks.mjs';

const repoFile = (rel) => new URL(`../../${rel}`, import.meta.url);
const trust = loadTrust(repoFile('fixtures/issuer/trust.json'));
const verifier = new LocalAtxVerifier(trust);
const CAPABILITY = 'payment:billpay';
const bytes = fs.readFileSync(repoFile('fixtures/agents/billpay-agent.atx.json'));
const atx = JSON.parse(bytes.toString('utf8'));
const changed = (members) => Buffer.from(JSON.stringify({ ...atx, ...members }), 'utf8');
const check = (input, v = verifier, capability = CAPABILITY) => checkCredential({ bytes: input, verifier: v, capability });

test('the credential check accepts the agent credential from its exact bytes and returns what the verifier read', () => {
  const r = check(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.refusal, null);
  assert.equal(r.rejectCategory, null);
  assert.equal(r.verification.valid, true);
  assert.equal(r.verification.context.agentDid, atx.agentDid);
  assert.equal(r.verification.context.issuerDid, trust.trustedIssuers[0]);
  assert.equal(r.verification.context.signedCapabilities, true);
  assert.deepEqual(r.atx, atx);
});

test('the credential check names its refusal: a changed member, an added capability, an expired or revoked credential, an issuer that is not trusted, a version it does not know, a repeated member and no bytes at all', () => {
  const refused = (r, refusal, category) => {
    assert.equal(r.ok, false);
    assert.equal(r.refusal, refusal);
    assert.equal(r.rejectCategory, category);
    assert.equal(r.atx, null, 'a credential that did not verify is not handed on');
  };
  // A running build that does not match the credential: any signed member changed.
  refused(check(changed({ contentHash: 'f'.repeat(64) })), 'credential-signature-invalid', 'SIGNATURE_INVALID');
  refused(check(changed({ trustScore: 99 })), 'credential-signature-invalid', 'SIGNATURE_INVALID');
  // A capability the holder adds is under the signature too.
  refused(check(changed({ capabilities: [CAPABILITY, 'payment:wire'] }), verifier, 'payment:wire'), 'credential-signature-invalid', 'SIGNATURE_INVALID');
  refused(check(bytes, new LocalAtxVerifier({ ...trust, now: () => new Date('2100-01-01T00:00:00Z') })), 'credential-expired', 'EXPIRED');
  refused(check(fs.readFileSync(repoFile('test/fixtures/atx-lifetime/lifetime-issued-8-days-before.atx.json'))), 'credential-expired', 'EXPIRED');
  refused(check(bytes, new LocalAtxVerifier({ ...trust, crl: { entries: [{ agentId: atx.agentId }] } })), 'credential-revoked', 'REVOKED');
  refused(check(changed({ revoked: true })), 'credential-revoked', 'REVOKED');
  refused(check(bytes, new LocalAtxVerifier({ trustedIssuers: ['did:opena2a:authority:other.example'], publicKeys: trust.publicKeys })), 'credential-untrusted-issuer', 'UNTRUSTED_ISSUER');
  refused(check(changed({ atcVersion: '9.9' })), 'credential-unsupported-version', 'UNSUPPORTED_VERSION');
  // The same member twice: a parser that keeps the later one would read another agent.
  refused(check(Buffer.from(bytes.toString('utf8').replace('{', '{"agentId":"another_agent",'), 'utf8')), 'credential-malformed', 'MALFORMED');
  refused(check(Buffer.alloc(0)), 'credential-malformed', 'MALFORMED');
  refused(check(Buffer.from('not json', 'utf8')), 'credential-malformed', 'MALFORMED');
});

test('the credential check refuses a valid credential that does not carry the capability', () => {
  const r = check(bytes, verifier, 'payment:wire');
  assert.equal(r.ok, false);
  assert.equal(r.refusal, 'credential-capability-missing');
  assert.equal(r.rejectCategory, null, 'the verifier accepted the credential; the capability is what is missing');
  assert.equal(r.verification.valid, true);
  assert.equal(r.atx, null);
});

test('every reject category of the verifier has a named refusal, and a category this file does not name still refuses', () => {
  assert.deepEqual(Object.keys(CREDENTIAL_REFUSALS).sort(), ['EXPIRED', 'MALFORMED', 'REVOKED', 'SIGNATURE_INVALID', 'UNSUPPORTED_VERSION', 'UNTRUSTED_ISSUER']);
  for (const name of Object.values(CREDENTIAL_REFUSALS)) assert.match(name, /^credential-[a-z-]+$/);
  const later = { verifyCredential: () => ({ valid: false, rejectCategory: 'A_LATER_CATEGORY' }) };
  assert.equal(check(bytes, later).refusal, 'credential-not-accepted');
  const silent = { verifyCredential: () => undefined };
  assert.equal(check(bytes, silent).refusal, 'credential-not-accepted');
  assert.equal(check(bytes, silent).ok, false);
  // A result that says valid and carries no context is not a verified credential.
  assert.equal(check(bytes, { verifyCredential: () => ({ valid: true }) }).ok, false);
});

const terms = {
  permissions: [...BILLPAY_CONSENT_TERMS.permissions],
  creditorAccounts: [...BILLPAY_CONSENT_TERMS.creditorAccounts, 'DEMO-0000-2201'],
  maximumIndividualAmount: { ...BILLPAY_CONSENT_TERMS.maximumIndividualAmount },
  periodicLimits: [],
  validToDateTime: BILLPAY_CONSENT_TERMS.validToDateTime,
};
const declared = { action: 'pay', invoiceId: 'DEMO-INV-2201', payeeAccount: 'DEMO-0000-2201', amount: '148.20', currency: 'USD' };
const now = new Date('2026-11-15T12:00:00Z');
const scope = (over = {}) => checkGrantScope({ terms, permission: CAPABILITY, declared, now, ...over });

test('the grant scope check passes a declared payment inside the consent, and lists the four names it checked', () => {
  const r = scope();
  assert.deepEqual(r, { ok: true, refusal: null, inScope: true, scopeChecked: ['permissions', 'creditorAccounts', 'maximumIndividualAmount', 'validToDateTime'], failing: null });
  assert.deepEqual(SCOPE_CHECKS, ['permissions', 'creditorAccounts', 'maximumIndividualAmount', 'validToDateTime']);
  // The cap itself is inside the scope.
  assert.equal(scope({ declared: { ...declared, amount: '250.00' } }).ok, true);
});

test('the grant scope check names the check that fails: the permission, the payee, the amount, the currency, the end date', () => {
  const failing = (over, name) => {
    const r = scope(over);
    assert.equal(r.ok, false);
    assert.equal(r.inScope, false);
    assert.equal(r.failing, name);
    assert.equal(r.refusal, `grant-scope-${name}`);
  };
  failing({ permission: 'balance:read' }, 'permissions');
  failing({ declared: { ...declared, payeeAccount: 'DEMO-0000-9931' } }, 'creditorAccounts');
  failing({ declared: { ...declared, amount: '250.01' } }, 'maximumIndividualAmount');
  failing({ declared: { ...declared, currency: 'EUR' } }, 'maximumIndividualAmount');
  failing({ declared: { ...declared, amount: 'a lot' } }, 'maximumIndividualAmount');
  failing({ terms: { ...terms, maximumIndividualAmount: null } }, 'maximumIndividualAmount');
  failing({ now: new Date('2027-04-01T00:00:00Z') }, 'validToDateTime');
  failing({ terms: { ...terms, validToDateTime: 'no date' } }, 'validToDateTime');
  // With two checks failing, the refusal names the earlier one in the list.
  failing({ permission: 'balance:read', declared: { ...declared, payeeAccount: 'DEMO-0000-9931' } }, 'permissions');
  failing({ terms: null }, 'permissions');
});

test('the grant expiry check: a living grant passes with the seconds it has left; a grant at or past its expiry, and no grant, are refused by name', () => {
  const grant = { issuedAt: '2026-11-15T12:00:12Z', expiresAt: '2026-11-15T12:01:12Z' };
  assert.deepEqual(checkGrantExpiry({ grant, now: new Date('2026-11-15T12:00:42Z') }), { ok: true, refusal: null, secondsLeft: 30 });
  assert.deepEqual(checkGrantExpiry({ grant, now: new Date('2026-11-15T12:01:11.900Z') }), { ok: true, refusal: null, secondsLeft: 0 });
  assert.deepEqual(checkGrantExpiry({ grant, now: new Date('2026-11-15T12:01:12Z') }), { ok: false, refusal: 'grant-expired', secondsLeft: 0 });
  assert.deepEqual(checkGrantExpiry({ grant, now: new Date('2026-11-15T12:05:00Z') }), { ok: false, refusal: 'grant-expired', secondsLeft: 0 });
  assert.deepEqual(checkGrantExpiry({ grant: null, now }), { ok: false, refusal: 'grant-missing', secondsLeft: null });
  assert.deepEqual(checkGrantExpiry({ grant: {}, now }), { ok: false, refusal: 'grant-missing', secondsLeft: null });
  assert.deepEqual(checkGrantExpiry({ grant: { expiresAt: 'no date' }, now }), { ok: false, refusal: 'grant-missing', secondsLeft: null });
});
