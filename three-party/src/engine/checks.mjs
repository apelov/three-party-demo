// The engine's own checks, each a separate function that returns
// { ok, refusal, ... }, where refusal is null or a named reason. None of
// them reads a file, makes a call or keeps state.
//
//   checkCredential   the agent's ATX credential, from its exact bytes
//   checkGrantScope   the declared payment against the grant's scope
//   checkGrantExpiry  whether the grant still lives at a given time

import { parseCents } from '../../../src/bank/money.mjs';

// The named refusal for each reject category of @opena2a/atx-verify.
export const CREDENTIAL_REFUSALS = Object.freeze({
  UNSUPPORTED_VERSION: 'credential-unsupported-version',
  EXPIRED: 'credential-expired',
  REVOKED: 'credential-revoked',
  UNTRUSTED_ISSUER: 'credential-untrusted-issuer',
  SIGNATURE_INVALID: 'credential-signature-invalid',
  MALFORMED: 'credential-malformed',
});

// Verifies a credential from the exact bytes of its file. The verifier's
// verifyCredential refuses a repeated member before it reads any field, and
// does not throw on bad input. The credential must also carry `capability`
// among capabilities its signature covers.
//   refusal: one of CREDENTIAL_REFUSALS, 'credential-not-accepted' (a reject
//   category this file does not name) or 'credential-capability-missing'.
export function checkCredential({ bytes, verifier, capability }) {
  const verification = verifier.verifyCredential(bytes);
  if (!verification || verification.valid !== true || !verification.context) {
    const category = verification?.rejectCategory ?? null;
    return {
      ok: false,
      refusal: (category && CREDENTIAL_REFUSALS[category]) || 'credential-not-accepted',
      rejectCategory: category,
      verification,
      atx: null,
    };
  }
  const context = verification.context;
  if (context.signedCapabilities !== true || !Array.isArray(context.capabilities) || !context.capabilities.includes(capability)) {
    return { ok: false, refusal: 'credential-capability-missing', rejectCategory: null, verification, atx: null };
  }
  // The bytes passed the strict parse above, so this parse reads what the
  // verifier read.
  const atx = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return { ok: true, refusal: null, rejectCategory: null, verification, atx };
}

// The names checkGrantScope checks, in order.
export const SCOPE_CHECKS = Object.freeze(['permissions', 'creditorAccounts', 'maximumIndividualAmount', 'validToDateTime']);

function amountWithin(amount, currency, cap) {
  if (!cap || cap.currency !== currency) return false;
  try {
    return parseCents(amount) <= parseCents(cap.amount);
  } catch {
    return false;
  }
}

// Holds a declared payment against the scope a grant gives: the consent
// terms the customer set. The bank runs its own check when the payment
// arrives; this one runs before anything is sent.
//   refusal: 'grant-scope-<name>' for the earliest check that fails.
export function checkGrantScope({ terms, permission, declared, now }) {
  const results = {
    permissions: Array.isArray(terms?.permissions) && terms.permissions.includes(permission),
    creditorAccounts: Array.isArray(terms?.creditorAccounts) && terms.creditorAccounts.includes(declared.payeeAccount),
    maximumIndividualAmount: amountWithin(declared.amount, declared.currency, terms?.maximumIndividualAmount),
    validToDateTime: typeof terms?.validToDateTime === 'string' && now.getTime() <= Date.parse(terms.validToDateTime),
  };
  const failing = SCOPE_CHECKS.find((name) => results[name] !== true) ?? null;
  return {
    ok: failing === null,
    refusal: failing === null ? null : `grant-scope-${failing}`,
    inScope: failing === null,
    scopeChecked: [...SCOPE_CHECKS],
    failing,
  };
}

// Whether a grant still lives at `now`. A grant is spent or refused once its
// expiresAt is reached: the agent has to ask for a new one.
//   refusal: 'grant-missing' or 'grant-expired'.
export function checkGrantExpiry({ grant, now }) {
  if (!grant || typeof grant.expiresAt !== 'string' || Number.isNaN(Date.parse(grant.expiresAt))) {
    return { ok: false, refusal: 'grant-missing', secondsLeft: null };
  }
  const millisLeft = Date.parse(grant.expiresAt) - now.getTime();
  if (millisLeft <= 0) return { ok: false, refusal: 'grant-expired', secondsLeft: 0 };
  return { ok: true, refusal: null, secondsLeft: Math.floor(millisLeft / 1000) };
}
