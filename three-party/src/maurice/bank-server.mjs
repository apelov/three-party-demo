// The mock NorthBank of the Maurice invoice slice: the repository's own bank
// (three-party/src/engine/bank.mjs, started in this process with its real
// token service and payment API on loopback ports) behind one front listener
// the enforcement adapter calls. The front adds what the plan asks of the
// bank side and the repository's payment API does not have: a stable
// idempotency key per payment request, recorded durably in the run directory,
// so a repeated key settles once and a repeated key with different payment
// details is rejected with 409.
//
// Front API (all on 127.0.0.1, JSON, no auth beyond the grant reference):
//   POST /v1/grants                      -> 201 { grantRef, expiresAt }   (a real AAP grant exchange at the bank's token service; the access token value stays in this process)
//   POST /v1/payments  X-Grant-Ref, body { creditorAccount, amount: { amount, currency }, idempotencyKey }
//                                            -> the bank's own answer, recorded under the key; repeats answer from the record
//   GET  /v1/idempotency/<key>           -> the record for a key, or 404
//   GET  /v1/ledger  /v1/decisions       -> the bank's own records, for tests and evidence
//
// Test hooks: keys in `hangKeys` are forwarded to the bank (so the bank
// settles) but never answered to the caller, which simulates a timeout after
// submission; the record still lands, so the retry answers from it.
//
// Nothing of the bank's is written outside the run directory this server is
// given: the idempotency record and a snapshot of the bank's state on stop.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listen, close, readBody, sendJson } from '../../../src/http.mjs';
import { AGENTS } from '../../../src/config.mjs';
import { AGENT_ROLE, PERMISSION, consentTerms, startBank } from '../engine/bank.mjs';
import { grantIssuer } from '../engine/grant.mjs';
import { writeJsonAtomic, sha256Hex } from '../engine/store.mjs';
import { canonicalJson } from './contracts.mjs';
import { verifyWit, verifyHttpSignature, createJtiStore } from './wimse.mjs';

export const MAURICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(MAURICE_DIR, '..');
export const DEFAULT_TASKS_DIR = path.join(MAURICE_DIR, 'fixtures', 'tasks');
export const DEFAULT_RUNS_DIR = path.join(MAURICE_DIR, 'runs');

const DETAILS_FIELDS = ['creditorAccount', 'amount', 'currency'];

function detailsOf(body) {
  return {
    creditorAccount: String(body?.creditorAccount ?? ''),
    amount: String(body?.amount?.amount ?? ''),
    currency: String(body?.amount?.currency ?? ''),
  };
}

export function detailsSha256(details) {
  return sha256Hex(canonicalJson(details));
}

// Starts the mock bank with its consent already approved, the way a run of
// the demo does, and the front listener on a loopback port the system picks.
// With `wimse` ({ jwks, audience, trustedIssuers, expectedSub? }) the front
// also verifies a live WIMSE authority on every payment request — WIT
// signature under the trusted issuer JWKS, issuer trust, expiry, jti replay,
// audience, content-digest and the RFC 9421 signature under the workload key
// the WIT's cnf names — independently of the AAP grant the resource API
// checks afterwards. The bank's WIMSE journal is an unsigned log, labeled as
// such; it carries token/signature hashes, never values.
export async function startBankServer({ repoRoot = REPO_ROOT, clock = () => new Date(), runDir, hangKeys = new Set(), addedPayees = null, credentialFile = AGENTS[AGENT_ROLE].credentialFile, wimse = null }) {
  if (!runDir) throw new Error('the bank server needs a run directory for its records');
  fs.mkdirSync(path.join(runDir, 'bank'), { recursive: true });
  const bank = await startBank({ repoRoot, clock });
  const atx = JSON.parse(fs.readFileSync(path.join(repoRoot, credentialFile), 'utf8'));
  const fixtures = JSON.parse(fs.readFileSync(path.join(repoRoot, 'three-party', 'fixtures', 'invoices.json'), 'utf8'));
  const added = addedPayees ?? fixtures.consent.addedCreditorAccounts;
  const consent = bank.approveConsent({ atx, terms: consentTerms(added), payees: added });
  if (!consent) throw new Error('the bank did not accept the demo agent credential');
  const issuer = grantIssuer({ bank, bindings: [consent.binding], clock });

  // The durable idempotency record: key -> { detailsSha256, state, paymentId, status, body }.
  const recordFile = path.join(runDir, 'bank', 'idempotency.json');
  const record = new Map();
  const persist = () => writeJsonAtomic(recordFile, Object.fromEntries([...record.entries()].sort(([a], [b]) => (a < b ? -1 : 1))));
  persist();
  const held = new Map(); // grantRef -> HeldGrant

  // The bank's WIMSE state: the jti replay store and the unsigned decision
  // journal (hashes only, never token or signature values).
  const jti = wimse ? createJtiStore(path.join(runDir, 'bank', 'jti-seen.txt')) : null;
  const wimseJournalFile = path.join(runDir, 'bank', 'wimse-decisions.jsonl');
  const wimseJournal = [];
  const wimseLog = (decision, reason, witSha256, jtiValue, extra = {}) => {
    const entry = {
      at: clock().toISOString(),
      log: 'unsigned decision log, not signed evidence',
      decision,
      reason,
      wit_sha256: witSha256 ?? null,
      jti: jtiValue ?? null,
      ...extra,
    };
    wimseJournal.push(entry);
    fs.appendFileSync(wimseJournalFile, `${JSON.stringify(entry)}\n`);
    return entry;
  };
  // The audience the bank expects in wimse-aud; defaults to its own URL once
  // the port is known.
  let audience = wimse ? (wimse.audience ?? null) : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/v1/grants') {
        const issued = await issuer.issue({ atx, grant: consent.binding.grant, operation: { method: 'POST', path: '/v1/payments' } });
        if (!issued.ok || !issued.held) {
          sendJson(res, 403, { status: 'refused', refusal: issued.refusal });
          return;
        }
        const grantRef = `gr_${crypto.randomUUID().replace(/-/g, '')}`;
        held.set(grantRef, issued.held);
        sendJson(res, 201, { grantRef, expiresAt: new Date(clock().getTime() + issued.expiresInSeconds * 1000).toISOString() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/payments') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { status: 'refused', reason: 'body-not-json' });
          return;
        }
        // Live WIMSE verification runs before the AAP grant check: workload
        // authentication first, resource authorization second. Every decision
        // is journaled with hashes only — never a token or signature value.
        let witEvidence = null;
        if (wimse) {
          const nowSec = () => Math.floor(clock().getTime() / 1000);
          const witHeader = String(req.headers['workload-identity-token'] ?? '');
          const witSha = witHeader ? sha256Hex(Buffer.from(witHeader)) : null;
          if (!witHeader) {
            wimseLog('reject', 'wimse-token-missing', null, null, { aud: audience });
            sendJson(res, 401, { status: 'refused', reason: 'wimse-token-missing' });
            return;
          }
          const wit = verifyWit({ token: witHeader, jwks: wimse.jwks, trustedIssuers: wimse.trustedIssuers, now: nowSec });
          if (!wit.ok) {
            wimseLog('reject', `wimse-${wit.refusal}`, witSha, wit.claims?.jti ?? null, { aud: audience });
            sendJson(res, 401, { status: 'refused', reason: `wimse-${wit.refusal}` });
            return;
          }
          if (!jti.check(wit.claims.jti)) {
            wimseLog('reject', 'wimse-replay', witSha, wit.claims.jti, { aud: audience });
            sendJson(res, 401, { status: 'refused', reason: 'wimse-replay' });
            return;
          }
          if (wimse.expectedSub && wit.claims.sub !== wimse.expectedSub) {
            wimseLog('reject', 'wimse-sub', witSha, wit.claims.jti, { aud: audience, sub: wit.claims.sub });
            sendJson(res, 403, { status: 'refused', reason: 'wimse-sub' });
            return;
          }
          const sig = verifyHttpSignature({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: raw,
            expectedAud: audience,
            workloadJwk: wit.claims.cnf.jwk,
            now: nowSec,
          });
          if (!sig.ok) {
            const status = sig.refusal === 'sig-window' ? 401 : 400;
            wimseLog('reject', `wimse-${sig.refusal}`, witSha, wit.claims.jti, { aud: audience });
            sendJson(res, status, { status: 'refused', reason: `wimse-${sig.refusal}` });
            return;
          }
          witEvidence = {
            wit_sha256: witSha,
            jti: wit.claims.jti,
            iss: wit.claims.iss,
            sub: wit.claims.sub,
            aud: audience,
            sig_sha256: sha256Hex(Buffer.from(String(req.headers.signature ?? ''))),
            txn_sha256: sha256Hex(Buffer.from(String(req.headers['txn-token'] ?? ''))),
          };
          wimseLog('accept', 'wimse-verified', witSha, wit.claims.jti, { aud: audience, sig_sha256: witEvidence.sig_sha256, txn_sha256: witEvidence.txn_sha256 });
        }
        const grantRef = String(req.headers['x-grant-ref'] ?? '');
        const grant = held.get(grantRef);
        if (!grant || grant.spent) {
          sendJson(res, 401, { status: 'refused', reason: 'grant-unknown-or-spent' });
          return;
        }
        const key = String(body?.idempotencyKey ?? '');
        if (!key) {
          sendJson(res, 400, { status: 'refused', reason: 'idempotency-key-missing' });
          return;
        }
        const details = detailsOf(body);
        const sha = detailsSha256(details);
        const existing = record.get(key);
        if (existing) {
          if (existing.detailsSha256 !== sha) {
            sendJson(res, 409, { status: 'refused', reason: 'idempotency-key-reused-with-different-details', idempotencyKey: key });
            return;
          }
          if (existing.state === 'settled') {
            sendJson(res, existing.status, existing.body);
            return;
          }
          sendJson(res, 409, { status: 'refused', reason: 'idempotency-key-in-flight', idempotencyKey: key });
          return;
        }
        record.set(key, { detailsSha256: sha, state: 'submitted', paymentId: null, status: null, body: null, wimse: witEvidence });
        persist();
        const answer = await grant.spend({
          method: 'POST',
          path: '/v1/payments',
          body: { creditorAccount: details.creditorAccount, amount: { amount: details.amount, currency: details.currency } },
        });
        const accepted = answer.status === 200 && answer.body?.status === 'accepted' && typeof answer.body.paymentId === 'string';
        const entry = record.get(key);
        entry.state = accepted ? 'settled' : 'refused';
        entry.paymentId = accepted ? answer.body.paymentId : null;
        entry.status = answer.status;
        entry.body = answer.body ?? { status: 'refused' };
        if (witEvidence && !entry.wimse) entry.wimse = witEvidence;
        persist();
        if (hangKeys.has(key)) return; // the caller times out; the record stands
        sendJson(res, answer.status, entry.body);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/idempotency/')) {
        const key = decodeURIComponent(url.pathname.slice('/v1/idempotency/'.length));
        const entry = record.get(key);
        if (!entry) {
          sendJson(res, 404, { status: 'not-found', idempotencyKey: key });
          return;
        }
        sendJson(res, 200, { idempotencyKey: key, ...entry });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/ledger') {
        const decisions = bank.decisions();
        const ledger = decisions.filter((d) => d.ledgerRowId).map((d) => bank.ledgerRow(d.ledgerRowId));
        sendJson(res, 200, { ledger });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/decisions') {
        sendJson(res, 200, { decisions: bank.decisions() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/wimse-decisions') {
        sendJson(res, 200, {
          note: 'unsigned decision log, not signed evidence; hashes only, never token or signature values',
          decisions: wimseJournal,
        });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { status: 'refused', reason: String(err?.message ?? err) });
    }
  });
  const port = await listen(server, 0);
  if (wimse && audience === null) audience = `http://127.0.0.1:${port}`;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    bank,
    consent,
    record,
    wimseJournal,
    jti,
    async stop() {
      await close(server);
      writeJsonAtomic(path.join(runDir, 'bank', 'bank-state.json'), { decisions: bank.decisions() });
      await bank.stop().catch(() => {});
    },
  };
}
