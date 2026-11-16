// aep-verify: checks one Action Evidence Package, a ZIP archive that records
// one agent action, against steps 1 to 6 of the format's ordered
// verification.
//
//   node three-party/src/verifier/aep-verify.mjs <package.aep> --pin <public key PEM file>
//
// It reads its two arguments and nothing else: no environment variable, no
// other file, no network. It prints one JSON line
//
//   {"file":<the path given>,"sha256":<hex of the package bytes>,
//    "verdict":"pass-1-6"|"reject","firstFailingStep":<1 to 6, or null>,
//    "notes":[<strings>]}
//
// and exits 0 on pass-1-6 and 1 on reject. A wrong argument, or a pin that
// cannot be read, ends it with exit 2, one line on standard error and no
// verdict line. A package that cannot be read is rejected at step 1, with
// null in the place of its hash.
//
// The steps, in the order the format gives them:
//
//   1. Parse the ZIP and require the seven required entries.
//   2. Parse metadata.json as a JSON object.
//   3. Rebuild response.txt, LF, JCS(metadata) and require canonical.bin to
//      equal it. The early form, canonical.bin equal to response.txt alone,
//      is recognized, and the answer remarks on it.
//   4. Require SHA-256(canonical.bin) to equal hash.sha256.
//   5. Require public_key.pem to equal the pin, byte for byte. The pin is
//      the trusted signer key the caller supplies.
//   6. Verify signature.sig over canonical.bin as RSASSA-PKCS1-v1_5 with
//      SHA-256, against the embedded public_key.pem.
//
// Steps 7 to 10 of the format (the receipt, the second signature and the
// timestamp) are not run, and the last note of every answer says so. A
// verdict of pass-1-6 says nothing about the timestamp entry beyond its
// presence.
//
// Each step is one function, step1 to step6. A step returns null, or its
// note: a remark on a step that passed, or what made the step fail. A step
// that fails also marks the package with its number (reject, below), and no
// later step runs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const REQUIRED = Object.freeze(['response.txt', 'canonical.bin', 'hash.sha256', 'signature.sig', 'public_key.pem', 'metadata.json', 'timestamp.tsr']);
const PASS = 'pass-1-6';
const REJECT = 'reject';
const NOT_RUN = 'steps 7 to 10 not run by this verifier';
const EARLY_FORM = 'step 3: early response form (response.txt alone); metadata is not signature-bound';

// What this verifier reads. A larger package, entry or pin is refused, not
// read in part.
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PIN_BYTES = 64 * 1024;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A name taken from the package, as a note shows it: printable ASCII, cut short.
const shown = (text) => String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
// Text with the ASCII whitespace around it removed.
const trimmed = (text) => text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');

// Marks the package as rejected at a step and gives that step's note.
function reject(pkg, step, why) {
  pkg.failedStep = step;
  return `step ${step}: ${why}`;
}

// ---- The ZIP reader of step 1

const END_RECORD = 0x06054b50;
const CENTRAL_RECORD = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
const STORED = 0;
const DEFLATE = 8;
// General purpose flag bits: 0 encrypted, 6 strong encryption, 13 an
// encrypted central directory.
const ENCRYPTED = 0x0001 | 0x0040 | 0x2000;
// Bit 3: the sizes and the CRC-32 follow the data, and the local header
// holds zero in their place.
const DEFERRED = 0x0008;

// What the reader found wrong with an archive, in words step 1 reports.
class Unreadable extends Error {}
function unreadable(why) {
  throw new Unreadable(why);
}

// Where the end of central directory record starts, or -1. The record is 22
// bytes followed by a comment, and the length it states for the comment
// must end the file. The search runs back from the end of the file.
function endRecordAt(bytes) {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (bytes.readUInt32LE(at) === END_RECORD && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) return at;
  }
  return -1;
}

// True when an extra field holds a ZIP64 extended information block.
function hasZip64Block(extra) {
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
    if (extra.readUInt16LE(at) === ZIP64_EXTRA) return true;
  }
  return false;
}

// Reads the archive and gives a map from entry name to entry bytes for the
// names in `wanted`. Every entry of the archive is read and checked, wanted
// or not. The method, the sizes, the CRC-32 and the offset of an entry are
// taken from the central directory. The local header is read to find where
// the data starts, and it must agree with the central directory on the
// name and the method, and on the sizes and the CRC-32 where it states them.
function readZip(bytes, wanted) {
  const end = endRecordAt(bytes);
  if (end === -1) {
    const startsAsZip = bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;
    unreadable(startsAsZip
      ? 'a damaged or truncated archive: it starts as a ZIP archive and has no end of central directory record'
      : 'not a ZIP archive: no end of central directory record');
  }
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryAt = bytes.readUInt32LE(end + 16);
  if (end >= 20 && bytes.readUInt32LE(end - 20) === ZIP64_LOCATOR) unreadable('a ZIP64 record: the archive has a ZIP64 end of central directory locator');
  if (count === 0xffff || bytes.readUInt16LE(end + 8) === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    unreadable('a ZIP64 record: the end of central directory record defers to one');
  }
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) {
    unreadable('an archive split over more than one disk');
  }
  if (directoryAt + directorySize !== end) {
    unreadable('a damaged archive: the central directory does not end where the end of central directory record begins');
  }

  const entries = new Map();
  const names = new Set();
  const spans = [];
  let at = directoryAt;
  for (let n = 1; n <= count; n += 1) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== CENTRAL_RECORD) {
      unreadable(`a damaged archive: central directory record ${n} of ${count} is not where the directory puts it`);
    }
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const packedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const disk = bytes.readUInt16LE(at + 34);
    const headerAt = bytes.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) unreadable(`a damaged archive: central directory record ${n} of ${count} runs past the directory`);
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    // One character per byte, so two names are equal when their bytes are.
    const name = nameBytes.toString('latin1');
    const entry = `entry ${shown(name)}`;
    at = next;

    if (names.has(name)) unreadable(`a duplicate entry name: ${shown(name)}`);
    names.add(name);
    if (packedSize === 0xffffffff || size === 0xffffffff || headerAt === 0xffffffff || disk === 0xffff || hasZip64Block(extra)) {
      unreadable(`a ZIP64 record: ${entry} defers to one`);
    }
    if (disk !== 0) unreadable(`an archive split over more than one disk: ${entry}`);
    if ((flags & ENCRYPTED) !== 0) unreadable(`${entry} is encrypted`);
    if (method !== STORED && method !== DEFLATE) {
      unreadable(`${entry} uses compression method ${method}; this verifier reads method 0 (stored) and method 8 (deflate)`);
    }
    if (size > MAX_ENTRY_BYTES) unreadable(`${entry} is ${size} bytes, more than this verifier reads`);

    if (headerAt + 30 > directoryAt || bytes.readUInt32LE(headerAt) !== LOCAL_HEADER) {
      unreadable(`a damaged archive: ${entry} has no local header at the offset the central directory gives`);
    }
    const localNameLength = bytes.readUInt16LE(headerAt + 26);
    const dataAt = headerAt + 30 + localNameLength + bytes.readUInt16LE(headerAt + 28);
    const dataEnd = dataAt + packedSize;
    if (dataEnd > directoryAt) unreadable(`a damaged or truncated archive: the data of ${entry} runs past the central directory`);
    if (!bytes.subarray(headerAt + 30, headerAt + 30 + localNameLength).equals(nameBytes)) {
      unreadable(`a damaged archive: the local header of ${entry} carries another name`);
    }
    if (bytes.readUInt16LE(headerAt + 8) !== method) {
      unreadable(`a damaged archive: the local header of ${entry} states another compression method`);
    }
    const local = { crc: bytes.readUInt32LE(headerAt + 14), packedSize: bytes.readUInt32LE(headerAt + 18), size: bytes.readUInt32LE(headerAt + 22) };
    const deferred = (bytes.readUInt16LE(headerAt + 6) & DEFERRED) !== 0 && local.crc === 0 && local.packedSize === 0 && local.size === 0;
    if (!deferred && (local.crc !== crc || local.packedSize !== packedSize || local.size !== size)) {
      unreadable(`a size or CRC-32 that does not match: the local header of ${entry} differs from the central directory`);
    }

    const packed = bytes.subarray(dataAt, dataEnd);
    let data = packed;
    if (method === DEFLATE) {
      try {
        data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
      } catch {
        unreadable(`a damaged archive: ${entry} does not inflate to the size the central directory gives`);
      }
    }
    if (data.length !== size) unreadable(`a size that does not match: ${entry} is ${data.length} bytes, and the central directory says ${size}`);
    if (zlib.crc32(data) !== crc) unreadable(`a CRC-32 that does not match: ${entry}`);
    spans.push({ from: headerAt, to: dataEnd, entry });
    if (wanted.includes(name)) entries.set(name, data);
  }
  if (at !== end) unreadable('a damaged archive: the central directory holds bytes after its last record');

  // No two entries share bytes of the file.
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].from < spans[i - 1].to) unreadable(`a damaged archive: ${spans[i - 1].entry} and ${spans[i].entry} overlap`);
  }
  return entries;
}

// ---- The canonical form of step 3 (RFC 8785, the JSON Canonicalization Scheme)

// A value the scheme, as the format's metadata profile bounds it, does not
// canonicalize.
class NotCanonical extends Error {}

// The canonical text of a parsed JSON value: the members of an object
// sorted by the UTF-16 code units of their names, no whitespace, a string
// escaped as JSON.stringify escapes it, a number as ECMAScript prints it.
// The profile refuses a number that is not finite, an integer outside the
// safe range, and a string that holds an unpaired surrogate.
function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotCanonical('a number that is not finite');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new NotCanonical('an integer outside the safe range');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new NotCanonical('an unpaired surrogate');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  // The default order of sort() is the order of UTF-16 code units.
  const names = Object.keys(value).sort();
  return `{${names.map((name) => `${canonicalJson(name)}:${canonicalJson(value[name])}`).join(',')}}`;
}

// ---- The steps

// 1. Parse ZIP and require all required entries.
function step1(pkg) {
  let entries = null;
  try {
    entries = readZip(pkg.bytes, REQUIRED);
  } catch (error) {
    if (error instanceof Unreadable) return reject(pkg, 1, error.message);
    throw error;
  }
  const missing = REQUIRED.filter((name) => !entries.has(name));
  if (missing.length > 0) return reject(pkg, 1, `required ${missing.length === 1 ? 'entry' : 'entries'} missing: ${missing.join(', ')}`);
  pkg.entries = entries;
  return null;
}

// 2. Parse metadata.json as an object. The text is UTF-8 with no byte
//    order mark. A member name that the text repeats is read as JSON.parse
//    reads it: the last one stands.
function step2(pkg) {
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(pkg.entries.get('metadata.json'));
  } catch {
    return reject(pkg, 2, 'metadata.json is not UTF-8 text');
  }
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    return reject(pkg, 2, 'metadata.json is not JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
    return reject(pkg, 2, `metadata.json is ${kind}, and it must be a JSON object`);
  }
  pkg.metadata = value;
  return null;
}

// 3. Reconstruct response.txt || LF || JCS(metadata), the form writers use
//    now, and require canonical.bin to equal it. The early form,
//    canonical.bin equal to response.txt alone, is recognized for old
//    packages; the step then passes with a remark, because nothing binds
//    the metadata to the signature.
function step3(pkg) {
  let canonicalMetadata = null;
  try {
    canonicalMetadata = canonicalJson(pkg.metadata);
  } catch (error) {
    if (error instanceof NotCanonical) return reject(pkg, 3, `metadata.json holds ${error.message}, which the metadata profile does not canonicalize`);
    if (error instanceof RangeError) return reject(pkg, 3, 'metadata.json is nested too deeply for this verifier to canonicalize');
    throw error;
  }
  const response = pkg.entries.get('response.txt');
  const canonical = pkg.entries.get('canonical.bin');
  if (canonical.equals(Buffer.concat([response, Buffer.from('\n'), Buffer.from(canonicalMetadata, 'utf8')]))) return null;
  if (canonical.equals(response)) return EARLY_FORM;
  return reject(pkg, 3, 'canonical.bin is neither response.txt, LF, JCS(metadata.json) nor response.txt alone');
}

// 4. Require SHA-256(canonical.bin) to equal hash.sha256. The entry is hex;
//    the whitespace around it and the case of its letters are ignored.
function step4(pkg) {
  const stated = trimmed(pkg.entries.get('hash.sha256').toString('latin1'));
  if (!/^[0-9a-fA-F]{64}$/.test(stated)) return reject(pkg, 4, 'hash.sha256 is not 64 hexadecimal characters');
  if (stated.toLowerCase() !== sha256(pkg.entries.get('canonical.bin'))) return reject(pkg, 4, 'SHA-256(canonical.bin) differs from hash.sha256');
  return null;
}

// 5. Require public_key.pem to match the trusted signer PEM the caller
//    supplied (the pin) exactly: the same bytes.
function step5(pkg) {
  if (!pkg.entries.get('public_key.pem').equals(pkg.pin)) return reject(pkg, 5, 'public_key.pem differs from the pin, the trusted signer key the caller supplied');
  return null;
}

// The armor lines of an SPKI public key in PEM, put together from parts.
const DASHES = '-'.repeat(5);
const PUBLIC_KEY_PEM = new RegExp(`^${DASHES}BEGIN PUBLIC KEY${DASHES}[\\t\\n\\r ]+([A-Za-z0-9+/=\\t\\n\\r ]+)${DASHES}END PUBLIC KEY${DASHES}[\\t\\n\\r ]*$`);
// Padded base64 in the standard alphabet, with no whitespace inside it.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// 6. Verify signature.sig over canonical.bin as RSASSA-PKCS1-v1_5 with
//    SHA-256. signature.sig is base64, and the whitespace around it is
//    ignored. public_key.pem is one PEM block that holds an RSA key as a
//    SubjectPublicKeyInfo.
//
//    The encoded block that is accepted is the one RFC 8017 section 9.2
//    gives, whose DigestInfo carries NULL algorithm parameters. The format
//    also describes one legacy block (full-length padding, then a
//    DigestInfo with the parameters absent) that its own verifiers accept
//    for packages of an older signer, and it says another implementation
//    need not accept it. This verifier does not accept it.
function step6(pkg) {
  const encoded = trimmed(pkg.entries.get('signature.sig').toString('latin1'));
  if (!BASE64.test(encoded)) return reject(pkg, 6, 'signature.sig is not base64');
  const armored = PUBLIC_KEY_PEM.exec(pkg.entries.get('public_key.pem').toString('latin1'));
  let key = null;
  try {
    key = armored ? crypto.createPublicKey({ key: Buffer.from(armored[1].replace(/[\t\n\r ]+/g, ''), 'base64'), format: 'der', type: 'spki' }) : null;
  } catch {
    key = null;
  }
  if (key === null || key.asymmetricKeyType !== 'rsa') return reject(pkg, 6, 'public_key.pem is not one RSA public key as a SubjectPublicKeyInfo in PEM');
  let verified = false;
  try {
    verified = crypto.verify('sha256', pkg.entries.get('canonical.bin'), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encoded, 'base64'));
  } catch {
    verified = false;
  }
  if (!verified) return reject(pkg, 6, 'signature.sig does not verify over canonical.bin as RSASSA-PKCS1-v1_5 with SHA-256');
  return null;
}

const STEPS = Object.freeze([step1, step2, step3, step4, step5, step6]);

// Runs the steps in order over the bytes of one package and gives the
// answer. A step that ends on an error of this program is a failed step:
// nothing is reported as passing that was not checked.
function verify(file, bytes, pin) {
  const pkg = { bytes, pin, entries: null, metadata: null, failedStep: null };
  const notes = [];
  for (const [index, step] of STEPS.entries()) {
    let note = null;
    try {
      note = step(pkg);
    } catch {
      note = reject(pkg, index + 1, 'the step ended on an error of this verifier');
    }
    if (note !== null) notes.push(note);
    if (pkg.failedStep !== null) break;
  }
  notes.push(NOT_RUN);
  return { file, sha256: sha256(bytes), verdict: pkg.failedStep === null ? PASS : REJECT, firstFailingStep: pkg.failedStep, notes };
}

// ---- The command line

const USAGE = 'usage: node three-party/src/verifier/aep-verify.mjs <package.aep> --pin <public key PEM file>\n';

// The package path and the pin path, or null for any other arguments.
function readArguments(argv) {
  if (argv.length !== 3) return null;
  const flagAt = argv.indexOf('--pin');
  if (flagAt !== 0 && flagAt !== 1) return null;
  const pin = argv[flagAt + 1];
  const file = argv[flagAt === 0 ? 2 : 0];
  return pin === '' || file === '' || file.startsWith('--') ? null : { file, pin };
}

// The bytes of a regular file of at most `limit` bytes.
function readFile(file, limit) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'not a regular file' });
  if (stat.size > limit) throw Object.assign(new Error('too large'), { code: `larger than ${limit} bytes` });
  return fs.readFileSync(file);
}
const reasonOf = (error) => shown(error?.code ?? 'error');

const asked = readArguments(process.argv.slice(2));
if (asked === null) {
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  let pin = null;
  try {
    pin = readFile(asked.pin, MAX_PIN_BYTES);
  } catch (error) {
    process.stderr.write(`aep-verify: the pin cannot be read (${reasonOf(error)})\n`);
    process.exitCode = 2;
  }
  if (pin !== null) {
    let bytes = null;
    let answer = null;
    try {
      bytes = readFile(asked.file, MAX_PACKAGE_BYTES);
    } catch (error) {
      answer = { file: asked.file, sha256: null, verdict: REJECT, firstFailingStep: 1, notes: [`step 1: the package cannot be read (${reasonOf(error)})`, NOT_RUN] };
    }
    if (bytes !== null) answer = verify(asked.file, bytes, pin);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.exitCode = answer.verdict === PASS ? 0 : 1;
  }
}
