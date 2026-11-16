// The test signer key of one run.
//
// generateTestKey makes one RSA 2048 key pair with node:crypto when a run
// starts. The private key is held in memory and in no file: this module
// writes it nowhere, hands it to no caller, starts no process, reads no
// environment variable and prints nothing. A caller gets a handle that
// signs. The key is deleted when the run's last record is signed, and on
// every other way out of the writer; from then on the handle signs nothing,
// and no function here brings a private key back. A new run gets a new key.
//
// Node has no call that wipes a key object. Deleting the key means this
// module gives up its one reference to it, so its bytes are freed when the
// collector next runs or when the process ends.
//
// What reaches the disk is public material:
//
//   <runDir>/keys/test-signer.pub.pem   the SPKI public key
//   <runDir>/keys/TEST-KEY.txt          the sentence of CONTRACT.md section 3
//                                       and, once the key is deleted, a line
//                                       that gives the time of the deletion
//   <runDir>/../.pins/<runId>.pub.pem   the pin: the same public key bytes,
//                                       captured when the run starts and held
//                                       outside the run directory

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PUBLIC_KEY_FILE = 'keys/test-signer.pub.pem';
export const TEST_KEY_NOTE_FILE = 'keys/TEST-KEY.txt';
export const TEST_KEY_LINE = 'Test key generated for this demo run; not a key in use anywhere.';
export const PIN_DIRECTORY = '.pins';

const PKCS1 = crypto.constants.RSA_PKCS1_PADDING;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The second line of TEST-KEY.txt. The form with lastRecordSigned is the
// one a finished run carries; the other is written when the key is deleted
// on a way out that left the run's records unfinished.
export function deletionLine(at, { lastRecordSigned = true } = {}) {
  return lastRecordSigned
    ? `Private key deleted at ${at} after the last record was signed.`
    : `Private key deleted at ${at}; the run's records were not finished.`;
}

// Where the pin of a run is held unless the caller names another place: a
// directory beside the run directory, never inside it.
export function pinFileOf(runDir) {
  const abs = path.resolve(runDir);
  return path.join(path.dirname(abs), PIN_DIRECTORY, `${path.basename(abs)}.pub.pem`);
}

// True when file is inside dir, or is dir itself.
function isInside(dir, file) {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// The path with the symbolic links of its existing part resolved. The part
// that does not exist yet is kept as given.
function realPathOf(file) {
  let existing = path.resolve(file);
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

// True when pinFile is not inside the run directory, by the path as given
// and by the path with symbolic links resolved.
export function pinIsOutside(runDir, pinFile) {
  const abs = path.resolve(runDir);
  const pin = path.resolve(pinFile);
  return !isInside(abs, pin) && !isInside(realPathOf(abs), realPathOf(pin));
}

const made = new WeakSet(); // every handle generateTestKey returned
const live = new Map(); // run directory -> the handle whose key is not deleted yet

// True for a handle generateTestKey returned, live or not.
export function isTestKey(value) {
  return typeof value === 'object' && value !== null && made.has(value);
}

// The handle of a run whose key was generated in this process and is not
// deleted yet, or null.
export function liveTestKey(runDir) {
  return live.get(path.resolve(runDir)) ?? null;
}

const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function writeWhole(file, text) {
  const partial = `${file}.partial-${process.pid}`;
  fs.writeFileSync(partial, text);
  fs.renameSync(partial, file);
}

// Makes the key of one run and writes its public material. The result is a
// frozen handle:
//
//   runDir, publicKeyPem, signerSha256 (hex of the public key file's bytes),
//   pinFile, deletedAt (null while the key is live)
//   sign(bytes)      the RSASSA-PKCS1-v1_5 SHA-256 signature over bytes
//   destroy(options) deletes the key; safe to call again
//
// A run has one key: a run directory that already has a public key file, or
// a pin that already exists, is refused and left as it was.
export function generateTestKey(runDir, { pinFile = pinFileOf(runDir) } = {}) {
  const abs = path.resolve(runDir);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${runDir}: not a directory, so there is no run to make a key for`);
  const publicFile = path.join(abs, ...PUBLIC_KEY_FILE.split('/'));
  const noteFile = path.join(abs, ...TEST_KEY_NOTE_FILE.split('/'));
  if (live.has(abs) || fs.existsSync(publicFile)) {
    throw new Error(`${runDir}: this run already has a test key (${PUBLIC_KEY_FILE}); a run has one key, and a new run gets a new key`);
  }
  const pin = path.resolve(pinFile);
  if (!pinIsOutside(abs, pin)) throw new Error(`${pinFile}: the pin is held outside the run directory`);
  if (fs.existsSync(pin)) throw new Error(`${pinFile}: a pin of this run already exists; a run has one key, and a new run gets a new key`);

  // The one reference to the private key. Nothing below copies it.
  let { privateKey: key, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  publicKey = null;
  let deletedAt = null;
  let noted = false;

  const written = [];
  try {
    // The pin is captured before the run directory gets its copy, and with
    // an exclusive create, so a pin that exists is never written over.
    fs.mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pin, publicKeyPem, { flag: 'wx', mode: 0o444 });
    written.push(pin);
    fs.mkdirSync(path.dirname(publicFile), { recursive: true });
    fs.writeFileSync(publicFile, publicKeyPem, { flag: 'wx' });
    written.push(publicFile);
    fs.writeFileSync(noteFile, `${TEST_KEY_LINE}\n`, { flag: 'wx' });
    written.push(noteFile);
  } catch (error) {
    key = null;
    for (const file of written) fs.rmSync(file, { force: true });
    if (error.code === 'EEXIST') throw new Error(`${runDir}: a pin or a key file of this run already exists (${error.path}); a run has one key`);
    throw error;
  }

  const handle = Object.freeze({
    runDir: abs,
    publicKeyPem,
    signerSha256: sha256(Buffer.from(publicKeyPem, 'utf8')),
    pinFile: pin,
    get deletedAt() {
      return deletedAt;
    },
    sign(bytes) {
      if (key === null) throw new Error('the private key of this run is deleted; a new run gets a new key');
      if (!Buffer.isBuffer(bytes)) throw new TypeError('the bytes to sign are not a Buffer');
      return crypto.sign('sha256', bytes, { key, padding: PKCS1 });
    },
    // Deletes the key, then writes the deletion line. It never throws, so it
    // can stand in a finally block: noted is false when the line could not
    // be written. A later call changes nothing and returns the same answer.
    destroy({ lastRecordSigned = false } = {}) {
      if (key === null) return { deletedAt, noted, already: true };
      key = null;
      live.delete(abs);
      deletedAt = utcNow();
      try {
        writeWhole(noteFile, `${TEST_KEY_LINE}\n${deletionLine(deletedAt, { lastRecordSigned })}\n`);
        noted = true;
      } catch {
        noted = false;
      }
      return { deletedAt, noted, already: false };
    },
  });
  made.add(handle);
  live.set(abs, handle);
  return handle;
}
