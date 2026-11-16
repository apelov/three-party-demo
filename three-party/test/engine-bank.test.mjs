// The repository's own bank, started in this process for a run, and the
// grant issued against it: where it listens, what a grant can do, and what
// the bank and the token service refuse.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BILLPAY_CONSENT_TERMS, GRANT_TTL_SECONDS } from '../../src/config.mjs';
import { makeSigningKey } from '../../src/bank/broker.mjs';
import { PAYMENTS_PATH, PERMISSION, consentTerms, startBank } from '../src/engine/bank.mjs';
import { TOKEN_WITHHELD, grantIssuer, loopbackUrl } from '../src/engine/grant.mjs';
import { REPO_ROOT, request } from './support/engine-helpers.mjs';

const atx = JSON.parse(fs.readFileSync(new URL('../../fixtures/agents/billpay-agent.atx.json', import.meta.url), 'utf8'));
const added = [{ name: 'Northwind Office Supply', account: 'DEMO-0000-2201' }];
const clock = () => new Date();
const operation = { method: 'POST', path: PAYMENTS_PATH };
const payment = (account, amount) => ({ method: 'POST', path: PAYMENTS_PATH, body: { creditorAccount: account, amount: { amount, currency: 'USD' } } });

const witness = [];
let bank;
let consent;
let issuer;

before(async () => {
  bank = await startBank({ repoRoot: REPO_ROOT, clock, witness });
  consent = bank.approveConsent({ atx, terms: consentTerms(added), payees: added });
  issuer = grantIssuer({ bank, bindings: [consent.binding], clock });
});

after(async () => {
  await bank.stop();
});

test('the bank listens on 127.0.0.1, on two ports the system picked, and keeps its working files in a directory of its own', () => {
  assert.deepEqual(bank.addresses, { resource: '127.0.0.1', token: '127.0.0.1' });
  assert.ok(Number.isInteger(bank.ports.resource) && bank.ports.resource > 0);
  assert.ok(Number.isInteger(bank.ports.token) && bank.ports.token > 0);
  assert.notEqual(bank.ports.resource, bank.ports.token);
  assert.equal(bank.audience, `http://127.0.0.1:${bank.ports.resource}`);
  assert.equal(bank.tokenEndpoint, `http://127.0.0.1:${bank.ports.token}/token`);
  assert.equal(fs.statSync(bank.workDir).mode & 0o777, 0o700);
  assert.equal(bank.workDir.startsWith(REPO_ROOT), false, 'nothing of the bank is written into the repository');
});

test('the consent of a run is the bill pay terms with the two payee accounts after its own, and the grant binding lives 60 seconds', () => {
  const terms = consentTerms([{ name: 'A', account: 'DEMO-0000-2201' }, { name: 'B', account: 'DEMO-0000-2202' }]);
  assert.deepEqual(terms.creditorAccounts, [...BILLPAY_CONSENT_TERMS.creditorAccounts, 'DEMO-0000-2201', 'DEMO-0000-2202']);
  assert.deepEqual(terms.permissions, ['payment:billpay']);
  assert.deepEqual(terms.maximumIndividualAmount, { amount: '250.00', currency: 'USD' });
  assert.equal(terms.validToDateTime, BILLPAY_CONSENT_TERMS.validToDateTime);
  assert.equal(terms.creditorAccounts.includes('DEMO-0000-9931'), false);
  // The terms of the repository are left as they were.
  assert.equal(BILLPAY_CONSENT_TERMS.creditorAccounts.includes('DEMO-0000-2201'), false);

  assert.equal(PERMISSION, 'payment:billpay');
  assert.equal(consent.record.agentDid, atx.agentDid);
  assert.equal(consent.record.status, 'active');
  assert.deepEqual(consent.record.terms.creditorAccounts, [...BILLPAY_CONSENT_TERMS.creditorAccounts, 'DEMO-0000-2201']);
  assert.match(consent.binding.grant, /^grant:\/\/g-[0-9a-f]{24}$/);
  assert.deepEqual(consent.binding.match, { trustClass: 'payment:billpay' });
  assert.equal(consent.binding.resolve.ttlSeconds, GRANT_TTL_SECONDS);
  assert.equal(consent.binding.resolve.ttlSeconds, 60);
  assert.equal(consent.binding.resolve.audience, bank.audience);
  assert.equal(consent.binding.resolve.scope, consent.record.consentId, 'the scope of the broker token is the consent, by its opaque id');
});

test('the bank records no consent for a credential it does not accept', () => {
  assert.equal(bank.approveConsent({ atx: { ...atx, contentHash: 'f'.repeat(64) }, terms: consentTerms(added) }), null);
  assert.equal(bank.approveConsent({ atx: { ...atx, capabilities: ['payment:billpay', 'payment:wire'] }, terms: consentTerms(added) }), null);
  assert.throws(() => bank.approveConsent({ atx, terms: { permissions: ['payment:billpay'] } }), /not in the shape the bank accepts/);
});

test('a grant is issued by a real token exchange, lives 60 seconds, pays once inside the consent, and what is kept of the exchange has no token value', async () => {
  const before = witness.length;
  const issued = await issuer.issue({ atx, grant: consent.binding.grant, operation });
  assert.equal(issued.ok, true);
  assert.equal(issued.refusal, null);
  assert.equal(issued.tokenType, 'Bearer');
  assert.equal(issued.expiresInSeconds, 60);
  assert.equal(witness.length, before + 1, 'the token service issued one access token');
  const token = witness.at(-1);
  assert.equal(issued.exchange.status, 200);
  const saved = JSON.parse(issued.exchange.body);
  assert.deepEqual(saved, { access_token: TOKEN_WITHHELD, token_type: 'Bearer', expires_in: 60, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' });
  assert.equal(JSON.stringify(issued).includes(token), false, 'nothing the issuer returns holds the token value');
  assert.deepEqual(Object.keys(issued.held), [], 'the held grant shows no member');
  assert.equal(issued.held.spent, false);

  const answer = await issued.held.spend(payment('DEMO-0000-2201', '148.20'));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'accepted');
  assert.equal(answer.raw.toString('utf8'), JSON.stringify({ status: 'accepted', paymentId: answer.body.paymentId }), 'the exact bytes the bank answered');
  const row = bank.ledgerRow(answer.body.paymentId);
  assert.deepEqual({ payeeName: row.payeeName, payeeAccount: row.payeeAccount, amountCents: row.amountCents, currency: row.currency }, { payeeName: 'Northwind Office Supply', payeeAccount: 'DEMO-0000-2201', amountCents: 14820, currency: 'USD' });
  assert.equal(row.agentDid, atx.agentDid, "the bank's ledger names the agent, not a customer password session");
  assert.equal(issued.held.spent, true);
  await assert.rejects(issued.held.spend(payment('DEMO-0000-2201', '1.00')), /already used/);
});

test('the bank decides each payment against the consent: an account the consent does not name, and an amount above its limit, are refused', async () => {
  for (const [account, amount] of [['DEMO-0000-9931', '212.75'], ['DEMO-0000-2201', '250.01']]) {
    const issued = await issuer.issue({ atx, grant: consent.binding.grant, operation });
    assert.equal(issued.ok, true);
    const decisionsBefore = bank.decisions().length;
    const answer = await issued.held.spend(payment(account, amount));
    assert.equal(answer.status, 403, `${account} ${amount}`);
    assert.equal(answer.raw.toString('utf8'), '{"status":"refused"}');
    const decision = bank.decisions().at(-1);
    assert.equal(bank.decisions().length, decisionsBefore + 1);
    assert.equal(decision.decision, 'refused');
    assert.equal(decision.ledgerRowId, null, 'no money moved');
  }
});

test('an access token is good for one request: the bank refuses the same token a second time, a request with no token, and a token that was never issued', async () => {
  const headers = { 'Content-Type': 'application/json' };
  const body = { creditorAccount: 'DEMO-0000-2201', amount: { amount: '1.00', currency: 'USD' } };
  const issued = await issuer.issue({ atx, grant: consent.binding.grant, operation });
  // The test's witness holds the value the bank issued; the engine keeps none outside the held grant.
  const token = witness.at(-1);
  const paid = await issued.held.spend(payment('DEMO-0000-2201', '1.00'));
  assert.equal(paid.status, 200);
  const again = await request({ port: bank.ports.resource, method: 'POST', path: PAYMENTS_PATH, headers: { ...headers, Authorization: `Bearer ${token}` }, body });
  assert.equal(again.status, 401, 'the token was spent by the payment above');
  assert.equal(again.text, '{"status":"refused"}');
  const none = await request({ port: bank.ports.resource, method: 'POST', path: PAYMENTS_PATH, headers, body });
  assert.equal(none.status, 401);
  const made = await request({ port: bank.ports.resource, method: 'POST', path: PAYMENTS_PATH, headers: { ...headers, Authorization: `Bearer ${'0'.repeat(64)}` }, body });
  assert.equal(made.status, 401);
});

test('no grant is issued for a grant name the policy does not hold, for a credential that does not verify, or under a key the token service does not know', async () => {
  const before = witness.length;
  const unknown = await issuer.issue({ atx, grant: 'grant://g-000000000000000000000000', operation });
  assert.deepEqual({ ok: unknown.ok, refusal: unknown.refusal, held: unknown.held, exchange: unknown.exchange }, { ok: false, refusal: 'grant-denied', held: null, exchange: null });
  const changed = await issuer.issue({ atx: { ...atx, trustScore: 99 }, grant: consent.binding.grant, operation });
  assert.equal(changed.ok, false);
  assert.equal(changed.refusal, 'grant-denied');
  assert.equal(changed.exchange, null, 'the resolver stopped before it reached the bank');
  // A broker token signed with a key that is not the one this bank's token service holds.
  const otherKey = grantIssuer({ bank: { ...bank, signing: makeSigningKey() }, bindings: [consent.binding], clock });
  const refused = await otherKey.issue({ atx, grant: consent.binding.grant, operation });
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal, 'grant-exchange-refused');
  assert.equal(refused.held, null);
  assert.equal(refused.exchange.status, 400);
  assert.equal(refused.exchange.body, '{"error":"invalid_grant"}');
  assert.equal(witness.length, before, 'the token service issued nothing');
});

test('the engine calls 127.0.0.1 over http and no other host', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:7390/token').port, '7390');
  for (const other of ['http://localhost:7390/token', 'https://127.0.0.1:7390/token', 'http://bank.example.test/token', 'http://127.0.0.1.example.test/token', 'http://[::1]:7390/token']) {
    assert.throws(() => loopbackUrl(other), /127\.0\.0\.1 and no other host/, other);
  }
});

test('stopping the bank closes both listeners and removes its working directory', async () => {
  const other = await startBank({ repoRoot: REPO_ROOT, clock });
  const { workDir, ports } = other;
  assert.equal(fs.existsSync(workDir), true);
  assert.equal((await request({ port: ports.resource, path: '/v1/balance' })).status, 401);
  await other.stop();
  assert.equal(fs.existsSync(workDir), false);
  await assert.rejects(request({ port: ports.resource, path: '/v1/balance' }));
  await assert.rejects(request({ port: ports.token, method: 'POST', path: '/token' }));
});
