// The grant: issued by the AAP reference implementation's grant resolver
// (secretless-ai, the code the bank's broker runs), then held in this
// process's memory until the payment is sent under it.
//
// Issuing is the resolver's own flow: it verifies the agent's credential,
// evaluates the grant policy (default deny), mints a signed broker token and
// exchanges it at the bank's token service (RFC 8693) for an access token
// that lives GRANT_TTL_SECONDS. The resolver hands that credential to a
// worker. The reference worker would use it at once; the worker here keeps it
// in a private field, so the run can show the steps between the grant and
// the payment, and uses it once, on the bank's payment API, when the pay step
// asks.
//
// The access token value stays inside this file: in a private class field
// and in the Authorization header of the one payment request. It is never
// returned, logged or written, and what this file returns about the token
// exchange has the value taken out.
//
// Both transports here speak to 127.0.0.1 and refuse any other host.

import http from 'node:http';
import { createRequire } from 'node:module';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { PROVIDER_ID } from '../../../src/bank/broker.mjs';

const require = createRequire(import.meta.url);
const broker = require('secretless-ai/dist/broker/index.js');

// What stands where the access token value was, in the saved response of the
// token exchange.
export const TOKEN_WITHHELD = 'withheld: the token value is never written';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export function loopbackUrl(text) {
  const url = new URL(text);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('this demo calls 127.0.0.1 and no other host');
  return url;
}

function post({ url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error('the response is larger than this demo reads'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('the request timed out'));
    });
    req.end(body);
  });
}

// The wire for the reference ExchangeProvider: one form-encoded POST to the
// bank's token endpoint. It keeps the status and the response text, with the
// token value taken out, for the grant's action file.
class LoopbackTokenExchange {
  #last = null;

  async exchange(req) {
    this.#last = null;
    const url = loopbackUrl(req.tokenEndpoint);
    const res = await post({
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(req.params).toString(),
    });
    const text = res.raw.toString('utf8');
    if (res.status < 200 || res.status >= 300) {
      this.#last = { status: res.status, body: text };
      throw new Error(`token exchange failed (status ${res.status})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('token endpoint returned a response that is not JSON');
    }
    if (parsed && typeof parsed.access_token === 'string' && parsed.access_token.length > 0) {
      const withheld = text.split(parsed.access_token).join(TOKEN_WITHHELD);
      if (withheld.includes(parsed.access_token)) throw new Error('the token value could not be taken out of the saved response');
      this.#last = { status: res.status, body: withheld };
    }
    return parsed;
  }

  // The status and saved text of the latest exchange, once.
  take() {
    const last = this.#last;
    this.#last = null;
    return last;
  }
}

// Sends one operation to the bank's payment API with the credential as a
// bearer token, and returns the status and the exact bytes of the response.
class LoopbackPaymentCaller {
  async call(audience, op, cred) {
    const base = loopbackUrl(audience);
    if (typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.startsWith('//')) throw new Error('operation path must be an absolute path');
    const url = new URL(op.path, base.origin);
    if (url.origin !== base.origin) throw new Error('operation path must not change the origin');
    if (op.method !== 'POST') throw new Error('this caller sends POST and no other method');
    const res = await post({
      url,
      headers: { Authorization: `${cred.tokenType} ${cred.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(op.body ?? {}),
    });
    if (res.raw.includes(Buffer.from(cred.token, 'utf8'))) throw new Error('the response carries the token value and is not kept');
    let body = null;
    try {
      body = JSON.parse(res.raw.toString('utf8'));
    } catch {
      body = null;
    }
    return { status: res.status, raw: res.raw, body };
  }
}

// A grant in memory. The credential is in a private field: it does not show
// in a listing of the object's members and does not serialize.
class HeldGrant {
  #binding;
  #cred;

  constructor(binding, cred) {
    this.#binding = binding;
    this.#cred = cred;
  }

  get spent() {
    return this.#cred === null;
  }

  // Uses the grant once. The reference worker pins the request to the
  // audience's origin before the caller sees the credential.
  async spend(operation) {
    const cred = this.#cred;
    this.#cred = null;
    if (cred === null) throw new Error('the grant was already used');
    return new broker.EphemeralWorker(new LoopbackPaymentCaller()).run(this.#binding, cred, operation);
  }

  discard() {
    this.#cred = null;
  }
}

// The worker the resolver hands the credential to. It keeps it for the pay
// step and returns what may leave: the token type and the life in seconds.
class HoldingWorker {
  #held = null;

  async run(binding, cred) {
    this.#held = new HeldGrant(binding, cred);
    return { held: true, tokenType: cred.tokenType, expiresInSeconds: cred.expiresInSeconds };
  }

  take() {
    const held = this.#held;
    this.#held = null;
    return held;
  }
}

// The issuer of grants for one run. `bank` is what startBank returns, and
// `bindings` the grant bindings of its consents.
export function grantIssuer({ bank, bindings, clock }) {
  const transport = new LoopbackTokenExchange();
  const worker = new HoldingWorker();
  const providers = new broker.MapProviderRegistry();
  providers.register(PROVIDER_ID, new broker.ExchangeProvider({ tokenEndpoint: bank.tokenEndpoint }, bank.signing.key, transport));
  const resolver = new broker.GrantResolver({
    verifier: new LocalAtxVerifier({ ...bank.trust, now: clock }),
    policy: new broker.GrantPolicy(bindings),
    providers,
    worker,
    aimClient: null,
  });

  return {
    // Asks for a grant. Returns { ok, refusal, held, tokenType,
    // expiresInSeconds, exchange }, where exchange is { status, body } of the
    // token exchange with the token value taken out, or null when the
    // resolver stopped before it reached the bank.
    //   refusal: null, 'grant-denied' (the resolver refused before any
    //   exchange: the credential or the policy) or 'grant-exchange-refused'
    //   (the bank's token service refused the broker token).
    async issue({ atx, grant, operation }) {
      const outcome = await resolver.resolve({ agentId: atx?.agentId, grant, atx, operation });
      const exchange = transport.take();
      const held = worker.take();
      if (!outcome.ok || !held) {
        held?.discard();
        return { ok: false, refusal: exchange ? 'grant-exchange-refused' : 'grant-denied', held: null, tokenType: null, expiresInSeconds: null, exchange };
      }
      return { ok: true, refusal: null, held, tokenType: outcome.result.tokenType, expiresInSeconds: outcome.result.expiresInSeconds, exchange };
    },
  };
}
