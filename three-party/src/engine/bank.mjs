// The repository's own bank, started in this process for one run: its
// records (src/bank/state.mjs), its token service (src/bank/token-service.mjs,
// which checks every broker token with the vendored reference verifier, run
// as a child process) and its payment API (src/bank/resource.mjs), each on a
// loopback port the system picks.
//
// The bank's working files (the token service's list of token ids it has
// seen, and the verifier's input file, which holds a broker token while one
// check runs) go to a directory of their own under the system temporary
// directory, mode 0700, removed when the run stops. Nothing of the bank's is
// written to the run directory.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { BILLPAY_CONSENT_TERMS, CUSTOMERS, GRANT_TTL_SECONDS, TRUST_CLASS } from '../../../src/config.mjs';
import { close, listen } from '../../../src/http.mjs';
import { childEnv } from '../../../src/orchestrator/env.mjs';
import { PROVIDER_ID, loadTrust, makeSigningKey } from '../../../src/bank/broker.mjs';
import { normalizeTerms } from '../../../src/bank/path-b.mjs';
import { resourceHandler } from '../../../src/bank/resource.mjs';
import { BankState } from '../../../src/bank/state.mjs';
import { TokenService } from '../../../src/bank/token-service.mjs';

// The path of the bank's payment API the grant is used on.
export const PAYMENTS_PATH = '/v1/payments';

// The customer whose account pays, and the agent role its consent names.
export const PAYING_CUSTOMER = CUSTOMERS.B;
export const AGENT_ROLE = 'billpay';
export const PERMISSION = TRUST_CLASS[AGENT_ROLE];

// The consent of a three-party run: the terms of BILLPAY_CONSENT_TERMS, with
// the creditor accounts of `added` ([{ name, account }]) after its own.
export function consentTerms(added) {
  return {
    permissions: [...BILLPAY_CONSENT_TERMS.permissions],
    creditorAccounts: [...BILLPAY_CONSENT_TERMS.creditorAccounts, ...added.map((p) => p.account)],
    maximumIndividualAmount: { ...BILLPAY_CONSENT_TERMS.maximumIndividualAmount },
    periodicLimits: BILLPAY_CONSENT_TERMS.periodicLimits.map((l) => ({ ...l })),
    validToDateTime: BILLPAY_CONSENT_TERMS.validToDateTime,
  };
}

const mkdir700 = (p) => {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
};

// Starts the bank. `clock` returns a Date and is the bank's clock as well as
// the engine's. `witness`, when a test passes an array, receives every access
// token the token service issues, so the test can look for it in the run
// directory; a run that passes none keeps none.
export async function startBank({ repoRoot, clock, witness = null }) {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-bank-')));
  fs.chmodSync(workDir, 0o700);
  const servers = [];
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vendor/pins.json'), 'utf8'));
    const trust = loadTrust(path.join(repoRoot, 'fixtures/issuer/trust.json'));
    const verifier = new LocalAtxVerifier({ ...trust, now: clock });
    const signing = makeSigningKey();
    const bank = new BankState({ now: clock });

    // The payment API's handler needs the token service, and the token
    // service needs the payment API's address as its audience, so the
    // listener starts with a handler that is set once both exist.
    let payments = null;
    const resource = http.createServer((req, res) => payments(req, res));
    servers.push(resource);
    const resourcePort = await listen(resource, 0);
    const audience = `http://127.0.0.1:${resourcePort}`;

    const tokens = new TokenService({
      key: { kid: signing.kid, publicJwk: signing.publicJwk },
      audience,
      verifyPath: path.join(repoRoot, pins.aapConformance.vendoredPath),
      workDir: mkdir700(path.join(workDir, 'verifier')),
      verifierEnv: childEnv({ home: mkdir700(path.join(workDir, 'home')) }),
      jtiFile: path.join(workDir, 'jti-seen.txt'),
      now: () => clock().getTime(),
      onIssue: Array.isArray(witness) ? (accessToken) => witness.push(accessToken) : null,
    });
    payments = resourceHandler(bank, tokens);

    const tokenServer = http.createServer(tokens.handler());
    servers.push(tokenServer);
    const tokenPort = await listen(tokenServer, 0);
    const tokenEndpoint = `http://127.0.0.1:${tokenPort}/token`;

    return {
      trust,
      signing,
      audience,
      tokenEndpoint,
      ports: { resource: resourcePort, token: tokenPort },
      // Where each listener is bound, and the bank's working directory.
      addresses: { resource: resource.address().address, token: tokenServer.address().address },
      workDir,

      // The customer's consent for the agent, made the way the bank's consent
      // route makes one: the bank verifies the agent's credential, checks the
      // capability its signature covers and the shape of the terms, then
      // records the consent. Returns the consent record and the grant
      // binding the broker's policy holds for it, or null when the bank does
      // not accept the credential.
      approveConsent({ atx, terms, payees = [] }) {
        const v = verifier.verify(atx);
        if (!v.valid || !v.context || !v.context.signedCapabilities || !v.context.capabilities.includes(PERMISSION)) return null;
        const shaped = normalizeTerms(terms);
        if (!shaped) throw new Error('the consent terms are not in the shape the bank accepts');
        const customer = bank.customers.get(PAYING_CUSTOMER.key);
        for (const p of payees) {
          if (!customer.payees.some((known) => known.account === p.account)) {
            customer.payees.push({ name: p.name, account: p.account, addedAt: bank.iso(), addedBy: 'consent' });
          }
        }
        const record = bank.createConsent({
          customerKey: PAYING_CUSTOMER.key,
          agentId: v.context.agentId,
          agentDid: v.context.agentDid,
          agentRole: AGENT_ROLE,
          terms: shaped,
          trustClass: PERMISSION,
        });
        const binding = {
          grant: `grant://${record.grantName}`,
          match: { trustClass: record.trustClass },
          resolve: { mode: 'exchange', providerId: PROVIDER_ID, scope: record.consentId, audience, ttlSeconds: GRANT_TTL_SECONDS },
        };
        return { record, binding };
      },

      // The bank's ledger row for a payment id, or null.
      ledgerRow(paymentId) {
        return bank.snapshot().ledger.find((row) => row.rowId === paymentId) ?? null;
      },

      // The bank's own decision log, for the tests.
      decisions() {
        return bank.snapshot().decisions;
      },

      async stop() {
        for (const s of servers) await close(s);
        fs.rmSync(workDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    for (const s of servers) await close(s);
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}
