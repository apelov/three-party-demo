// The record writer: one Action Evidence Package per action file of a run,
// in the package format named by FORMAT below, steps 1 to 6 of its ordered
// verification. This is an OpenA2A writer of that format.
//
// What a package holds, entry by entry (the names and their order are the
// format's entry table; a package has the seven required entries and no
// optional one):
//
//   response.txt    the exact bytes of the action's body file
//   canonical.bin   response.txt || LF || JCS(metadata): the current profile form
//   hash.sha256     lowercase hex of SHA-256(canonical.bin), no line feed after it
//   signature.sig   base64 of the RSASSA-PKCS1-v1_5 SHA-256 signature over
//                   canonical.bin, no line feed after it
//   public_key.pem  the run's test signer key, SPKI PEM
//   metadata.json   the JCS bytes of the metadata (CONTRACT.md section 5)
//   timestamp.tsr   a stand-in: base64 of a sentence, not an RFC 3161 token
//
// The limits, stated where the bytes are made: the signer is a test key
// generated for the run, and the timestamp entry is a stand-in and not the
// RFC 3161 object the format's step 9 decodes.
//
// The signer is the handle testkey.mjs makes. The private key stays inside
// that handle: this file asks it for signatures and never holds the key.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalize } from './jcs.mjs';
import { generateTestKey, isTestKey, liveTestKey, PUBLIC_KEY_FILE } from './testkey.mjs';
import { storeZip } from './zip.mjs';

export const FORMAT = 'docs/aep-format.md in eatf-verifier, text SHA-256 cdf6954ab0fbd4f9c272821ee4379063dc9d396511459fef6c398a6df75827a5, steps 1 to 6';
export const PROFILE = 'opena2a-three-party-demo/1';
export const WRITER = 'OpenA2A writer, AEP format';
export const TIMESTAMP_ENTRY = 'stand-in: no timestamp authority';
export const TIMESTAMP_STAND_IN = 'stand-in: no timestamp authority in this demo';
export const CHANGED = 'one byte of response.txt';
export const MANIFEST_FILE = 'records/manifest.json';
export const ENTRY_NAMES = Object.freeze(['response.txt', 'canonical.bin', 'hash.sha256', 'signature.sig', 'public_key.pem', 'metadata.json', 'timestamp.tsr']);

const ACTION_NAME = /^(\d{2})-([a-z][a-z0-9-]*)\.action\.json$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RFC3339_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const PKCS1 = crypto.constants.RSA_PKCS1_PADDING;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isText = (value) => typeof value === 'string' && value.length > 0;

function writeWhole(file, bytes) {
  const partial = `${file}.partial-${process.pid}`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, file);
}

// Reads one action file and the response bytes saved beside it, and refuses
// a file the contract's section 5 does not describe. It needs no key.
function readAction(runDir, actionFile) {
  const actionsDir = path.join(path.resolve(runDir), 'actions');
  const abs = path.resolve(runDir, actionFile);
  const name = path.basename(abs);
  const match = ACTION_NAME.exec(name);
  if (path.dirname(abs) !== actionsDir || !match) throw new Error(`${actionFile}: not an action file of this run (actions/NN-<step>.action.json)`);
  const rel = `actions/${name}`;
  const need = (ok, what) => {
    if (!ok) throw new Error(`${rel}: ${what}`);
  };
  let action = null;
  try {
    action = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    need(false, `not readable as JSON: ${error.message}`);
  }
  need(action !== null && typeof action === 'object' && !Array.isArray(action), 'not a JSON object');
  for (const field of ['runId', 'step', 'kind', 'decision', 'domainFrom', 'domainTo']) need(isText(action[field]), `${field} is not a string`);
  need(typeof action.reason === 'string', 'reason is not a string');
  need(Number.isSafeInteger(action.seq) && action.seq >= 1, 'seq is not an integer from 1 up');
  // The record is named after the action file and its signed metadata carries
  // seq and step, so the two must say the same thing about which action it is.
  need(action.seq === Number(match[1]), `seq is ${action.seq}, and the file name says ${match[1]}`);
  need(action.step === match[2], `step is ${JSON.stringify(action.step)}, and the file name says ${match[2]}`);
  need(isText(action.at) && RFC3339_TIME.test(action.at) && !Number.isNaN(Date.parse(action.at)), 'at is not an RFC 3339 time');
  need(action.actor !== null && typeof action.actor === 'object', 'actor is not an object');
  need(isText(action.actor.did), 'actor.did is not a string');
  need(SHA256_HEX.test(action.actor.credentialSha256 ?? ''), 'actor.credentialSha256 is not 64 lowercase hex characters');
  need(action.response !== null && typeof action.response === 'object', 'response is not an object');
  const { bodyFile, bodySha256 } = action.response;
  need(isText(bodyFile) && path.basename(bodyFile) === bodyFile && bodyFile !== '.' && bodyFile !== '..', 'response.bodyFile is not a file name beside the action file');
  need(SHA256_HEX.test(bodySha256 ?? ''), 'response.bodySha256 is not 64 lowercase hex characters');
  let body = null;
  try {
    body = fs.readFileSync(path.join(actionsDir, bodyFile));
  } catch (error) {
    need(false, `the body file ${bodyFile} cannot be read: ${error.code ?? error.message}`);
  }
  need(sha256(body) === bodySha256, `the body file ${bodyFile} is not the bytes response.bodySha256 names`);
  return { rel, stem: `${match[1]}-${match[2]}`, action, body };
}

// The metadata of a record: CONTRACT.md section 5, strings and integers.
function metadataOf(action) {
  return {
    profile: PROFILE,
    runId: action.runId,
    seq: action.seq,
    step: action.step,
    kind: action.kind,
    at: action.at,
    decision: action.decision,
    reason: action.reason,
    actor_did: action.actor.did,
    credential_sha256: action.actor.credentialSha256,
    domain_from: action.domainFrom,
    domain_to: action.domainTo,
    writer: WRITER,
    timestamp_entry: TIMESTAMP_ENTRY,
  };
}

function pack(entries, at) {
  return storeZip(entries, { date: new Date(at) });
}

// A record is signed by the test key of its own run, while that key is
// live, and by nothing else.
function requireKey(runDir, keys) {
  if (!isTestKey(keys)) throw new Error('the signer is not a key generateTestKey made; a record is signed by the test key of its run');
  if (keys.runDir !== path.resolve(runDir)) throw new Error('the signer key was generated for another run; a run has its own key');
  if (keys.deletedAt !== null) throw new Error('the private key of this run is deleted; a new run gets a new key');
}

// Builds the package of one action, read by readAction, in memory.
function signRecord({ rel, stem, action, body }, keys) {
  const metadata = canonicalize(metadataOf(action));
  const canonical = Buffer.concat([body, Buffer.from('\n'), metadata]);
  const signature = keys.sign(canonical);
  // The signature is checked with the key the package embeds before the
  // package is made, so a package whose signature and key disagree is never
  // written.
  if (!crypto.verify('sha256', canonical, { key: keys.publicKeyPem, padding: PKCS1 }, signature)) {
    throw new Error(`${rel}: the signature does not verify with the run's public key`);
  }
  const entries = [
    { name: 'response.txt', data: body },
    { name: 'canonical.bin', data: canonical },
    { name: 'hash.sha256', data: Buffer.from(sha256(canonical), 'ascii') },
    { name: 'signature.sig', data: Buffer.from(signature.toString('base64'), 'ascii') },
    { name: 'public_key.pem', data: Buffer.from(keys.publicKeyPem, 'utf8') },
    { name: 'metadata.json', data: metadata },
    { name: 'timestamp.tsr', data: Buffer.from(Buffer.from(TIMESTAMP_STAND_IN, 'ascii').toString('base64'), 'ascii') },
  ];
  return { rel, stem, action, body, entries, bytes: pack(entries, action.at) };
}

function saveRecord(runDir, record) {
  const file = `records/${record.stem}.aep`;
  fs.mkdirSync(path.join(runDir, 'records'), { recursive: true });
  writeWhole(path.join(runDir, 'records', `${record.stem}.aep`), record.bytes);
  return { file, sha256: sha256(record.bytes) };
}

// Writes records/NN-<step>.aep for one action file (a path under the run
// directory, or an absolute one inside its actions directory). keys is the
// handle generateTestKey returned for this run. The result names the file
// relative to the run directory and gives the SHA-256 of the package bytes.
//
// This call leaves the key live, because it cannot know which record is the
// run's last. A caller that writes records one by one deletes the key
// itself, with keys.destroy, after the last one and on its own ways out;
// writeRun does both for the caller.
export function writeRecord(runDir, actionFile, keys) {
  requireKey(runDir, keys);
  return saveRecord(runDir, signRecord(readAction(runDir, actionFile), keys));
}

// The record a tampered copy is made from: the pay record when the run has
// one, else the last record. A record whose response.txt is empty has no
// byte to change and is passed over.
function recordToTamper(records) {
  const withBytes = records.filter((record) => record.body.length > 0);
  return withBytes.findLast((record) => record.action.step === 'pay') ?? withBytes.at(-1) ?? null;
}

// The same package with bit 0 of byte 0 of response.txt flipped and every
// other entry as it was.
function tamperedCopy(record) {
  const changed = Buffer.from(record.body);
  changed[0] ^= 0x01;
  const entries = record.entries.map((entry) => (entry.name === 'response.txt' ? { name: entry.name, data: changed } : entry));
  return pack(entries, record.action.at);
}

// Reads every action file of the run and refuses what cannot be recorded.
// No key is needed here, so a refused run is refused before a key is made.
function readRun(runDir) {
  const actionsDir = path.join(runDir, 'actions');
  const names = fs.existsSync(actionsDir) ? fs.readdirSync(actionsDir).filter((name) => ACTION_NAME.test(name)).sort() : [];
  if (names.length === 0) throw new Error(`${runDir}: no action file under actions/, so there is nothing to record`);
  const read = names.map((name) => readAction(runDir, `actions/${name}`));
  const one = (label, values) => {
    const distinct = [...new Set(values)];
    if (distinct.length !== 1) throw new Error(`${runDir}: the action files name ${distinct.length} values of ${label}; a run has one`);
    return distinct[0];
  };
  const runId = one('runId', read.map((record) => record.action.runId));
  const credentialSha256 = one('actor.credentialSha256', read.map((record) => record.action.actor.credentialSha256));
  if (recordToTamper(read) === null) throw new Error(`${runDir}: every response.txt is empty, so no byte can be changed for the tampered copy`);
  return { read, runId, credentialSha256 };
}

// Writes a record for every actions/NN-<step>.action.json of the run, one
// tampered copy under records/tampered/, and records/manifest.json, which is
// written last so that it never lists a file that is not on disk.
//
// The signer is, in this order: the handle given as keys, the live handle
// generateTestKey returned for this run directory earlier in this process,
// or a key made here. The key is deleted when the last record is signed and
// on every other way out of this call, before a record file is written, so
// a run is written once: a later call for the same run is refused, and a
// new run gets a new key.
//
// The answer names the manifest, the run, each record and the tampered copy
// as the manifest lists them, the SHA-256 of the signer's public key file,
// and the time the private key was deleted.
export function writeRun(runDir, keys = null) {
  if (keys !== null) requireKey(runDir, keys);
  let signer = keys ?? liveTestKey(runDir);
  let plan = null;
  let built = null;
  let deletion = null;
  try {
    plan = readRun(runDir);
    signer ??= generateTestKey(runDir);
    requireKey(runDir, signer);
    const publicFile = fs.readFileSync(path.join(runDir, ...PUBLIC_KEY_FILE.split('/')));
    if (!publicFile.equals(Buffer.from(signer.publicKeyPem, 'utf8'))) {
      throw new Error(`${runDir}: ${PUBLIC_KEY_FILE} is not the public key this run started with`);
    }
    built = plan.read.map((record) => signRecord(record, signer));
  } finally {
    if (isTestKey(signer)) deletion = signer.destroy({ lastRecordSigned: built !== null });
  }
  if (!deletion.noted) throw new Error(`${runDir}: the private key is deleted, and the line that says so could not be written to keys/TEST-KEY.txt; no record was written`);

  // Every refusal comes before a file under records/ is written, so a
  // refused run has no record and no manifest.
  const source = recordToTamper(built);
  const tamperedBytes = tamperedCopy(source);

  const records = built.map((record) => ({ ...saveRecord(runDir, record), action: record.rel }));
  const tamperedFile = `records/tampered/${source.stem}.aep`;
  fs.mkdirSync(path.join(runDir, 'records', 'tampered'), { recursive: true });
  writeWhole(path.join(runDir, 'records', 'tampered', `${source.stem}.aep`), tamperedBytes);
  const tampered = [{ file: tamperedFile, sha256: sha256(tamperedBytes), changed: CHANGED }];

  const manifest = {
    runId: plan.runId,
    format: FORMAT,
    signerPublicKey: PUBLIC_KEY_FILE,
    signerSha256: signer.signerSha256,
    credentialSha256: plan.credentialSha256,
    records,
    tampered,
  };
  writeWhole(path.join(runDir, ...MANIFEST_FILE.split('/')), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest: MANIFEST_FILE, runId: plan.runId, records, tampered, signerSha256: signer.signerSha256, privateKeyDeletedAt: deletion.deletedAt };
}
