// aep-verify: checks one Action Evidence Package, a ZIP archive that records
// one agent action, against steps 1 to 6 of the format's ordered
// verification. The format is the text three-party/FORMAT-SOURCE.txt names;
// this file was written from that text.
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
// null in the place of its hash; so is a package file of more than 64 MiB,
// which is not read. A pin that is read and is not one PEM block labelled
// PUBLIC KEY matches no key: a package that reaches step 5 is rejected
// there.
//
// The steps, in the order the format gives them:
//
//   1. Parse the ZIP and require the seven required entries. The archive is
//      rejected when it repeats an entry name, when an entry name holds /,
//      \ or NUL, and past the format's safety limits: 64 MiB of archive, 32
//      entries, 16 MiB for one entry, 32 MiB expanded. Names are compared
//      exactly, byte for byte, at the root of the archive.
//   2. Parse metadata.json as an RFC 8259 JSON object: UTF-8 with no byte
//      order mark, no member name twice within one object (the names
//      compared after their escapes are decoded), no NaN or Infinity, and no
//      nesting of more than 64 objects and arrays. A failure of this step is
//      METADATA_INVALID_JSON.
//   3. Rebuild response.txt, LF, JCS(metadata) and require canonical.bin to
//      equal it. Metadata outside the profile's domain (an integer-valued
//      number outside [-(2^53 - 1), 2^53 - 1], a number that is not finite,
//      an unpaired surrogate) is METADATA_NOT_CANONICALIZABLE. The early
//      form, canonical.bin equal to response.txt alone, is recognized, and
//      the answer remarks on it.
//   4. Require SHA-256(canonical.bin) to equal hash.sha256.
//   5. Read public_key.pem as the format's entry table gives it: exactly one
//      PEM block labelled PUBLIC KEY whose body is the DER
//      SubjectPublicKeyInfo of an RSA key with nothing after it, and that
//      DER the encoding of the key it holds (RSA_VERIFY_ERROR otherwise).
//      Then require the DER to equal, byte for byte, the DER in the pin, the
//      trusted signer key the caller supplies, read by the same PEM rules.
//   6. Verify signature.sig over the bytes of canonical.bin as
//      RSASSA-PKCS1-v1_5 with SHA-256, with the key step 5 read.
//
// Steps 7 to 10 of the format (the receipt, the second signature and the
// timestamp) are not run, and the last note of every answer says so. A
// verdict of pass-1-6 says nothing about the timestamp entry beyond its
// presence.
//
// How this file reads the text where it leaves room. Where a clause can be
// read two ways, it takes the stricter reading that still accepts what the
// text says is allowed.
//
//   - A MiB is 1,048,576 bytes, and a size exceeds a limit when it is above
//     it: an archive of exactly 64 MiB is read.
//   - The name rule, the count of entries and the expanded total take in
//     every entry of the central directory, those the format lists and
//     those it does not. Every entry is also read and checked as a ZIP entry
//     (its method, sizes and CRC-32); an entry the format does not list is
//     ignored in that nothing else is done with its bytes.
//   - "16 MiB for one entry" bounds both sizes of an entry: the bytes it
//     expands to and the bytes it is stored in. "32 MiB expanded" is the sum
//     of the bytes all the entries expand to.
//   - The base64 of signature.sig and of a PEM block must be the canonical
//     encoding of RFC 4648 section 3.5: pad bits that are not zero are
//     refused, as that section lets a decoder do. Base64 that is empty once
//     the ignored bytes are out is zero bytes, which do not verify.
//   - The nesting of step 2 counts the object at the top: 64 objects and
//     arrays, one inside another, pass, and 65 do not. Every failure of step
//     2 is METADATA_INVALID_JSON: bytes that are not UTF-8, a byte order
//     mark, text that is not JSON, and JSON that is not an object as well.
//   - In a PEM block, "whitespace around the block" is TAB, LF, VT, FF, CR
//     and space before the BEGIN line and after the END line. "Any line
//     layout inside it" is read as line breaks, CR and LF, anywhere between
//     the BEGIN line and the END line, as many as there are and none at all;
//     nothing else stands inside the block beside the base64 characters (no
//     space, no tab, no header line). The two lines are exactly the BEGIN
//     and END lines of the label PUBLIC KEY, with five dashes on each side.
//   - "An RSA key" is a key of the rsaEncryption algorithm; an RSASSA-PSS
//     key is not one.
//   - The pin is read by the same PEM rules, and its DER is compared byte for
//     byte. It is not read as a key of its own: only DER equal to that of
//     public_key.pem, which step 5 has read as an RSA key, can match.
//   - The format describes one legacy encoded block for step 6 (full-length
//     padding, then a DigestInfo with the parameters absent) that its own
//     verifiers accept for packages of an older signer, and says another
//     implementation need not accept it. This verifier does not accept it.
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

// The names the format gives to the failures of steps 2, 3 and 5.
const METADATA_INVALID_JSON = 'METADATA_INVALID_JSON';
const METADATA_NOT_CANONICALIZABLE = 'METADATA_NOT_CANONICALIZABLE';
const RSA_VERIFY_ERROR = 'RSA_VERIFY_ERROR';

// The safety limits of step 1, as the format gives them, and the deepest
// nesting of objects and arrays step 2 accepts.
const MIB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * MIB;
const MAX_ENTRIES = 32;
const MAX_ENTRY_BYTES = 16 * MIB;
const MAX_EXPANDED_BYTES = 32 * MIB;
const MAX_NESTING = 64;
// What this verifier reads of a pin. A larger pin is refused, not read in
// part.
const MAX_PIN_BYTES = 64 * 1024;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A name taken from the package, as a note shows it: printable ASCII, cut short.
const shown = (text) => String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
// Text with the ASCII whitespace around it removed.
const trimmed = (text) => text.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
// A note that ends in the name the format gives to the failure.
const named = (why, name) => `${why} (${name})`;

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
// The bytes an entry name may not hold: /, \ and NUL.
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const NUL = 0x00;

// What the reader found wrong with an archive, in words step 1 reports.
class Unreadable extends Error {}
function unreadable(why) {
  throw new Unreadable(why);
}

// The note of step 1 on an archive larger than the format allows.
const archiveTooLarge = (size) => `the archive is ${size} bytes, more than the 64 MiB (${MAX_ARCHIVE_BYTES} bytes) the format allows`;

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
// taken from the central directory, and the limits of the format are held
// against those sizes before the entry is inflated. The local header is
// read to find where the data starts, and it must agree with the central
// directory on the name and the method, and on the sizes and the CRC-32
// where it states them.
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
  if (count > MAX_ENTRIES) unreadable(`the archive holds ${count} entries, more than the ${MAX_ENTRIES} the format allows`);

  const entries = new Map();
  const names = new Set();
  const spans = [];
  let expanded = 0;
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
    if (nameBytes.includes(SLASH) || nameBytes.includes(BACKSLASH) || nameBytes.includes(NUL)) unreadable(`an entry name that holds /, \\ or NUL: ${shown(name)}`);
    if (packedSize === 0xffffffff || size === 0xffffffff || headerAt === 0xffffffff || disk === 0xffff || hasZip64Block(extra)) {
      unreadable(`a ZIP64 record: ${entry} defers to one`);
    }
    if (disk !== 0) unreadable(`an archive split over more than one disk: ${entry}`);
    if ((flags & ENCRYPTED) !== 0) unreadable(`${entry} is encrypted`);
    if (method !== STORED && method !== DEFLATE) {
      unreadable(`${entry} uses compression method ${method}; this verifier reads method 0 (stored) and method 8 (deflate)`);
    }
    if (size > MAX_ENTRY_BYTES) unreadable(`${entry} expands to ${size} bytes, more than the 16 MiB (${MAX_ENTRY_BYTES} bytes) the format allows for one entry`);
    if (packedSize > MAX_ENTRY_BYTES) unreadable(`${entry} is stored in ${packedSize} bytes, more than the 16 MiB (${MAX_ENTRY_BYTES} bytes) the format allows for one entry`);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) unreadable(`the entries expand to more than the 32 MiB (${MAX_EXPANDED_BYTES} bytes) the format allows in all, at ${entry}`);

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

// ---- The JSON reader of step 2 (RFC 8259)

// What step 2 found wrong with the text of metadata.json, in words its note
// gives after the name of the entry.
class InvalidJson extends Error {}
const NOT_JSON = 'is not JSON';

// Checks that `text` is one JSON text by the grammar of RFC 8259, with no
// member name twice within one object and no nesting of more than
// MAX_NESTING objects and arrays, and throws InvalidJson when it is not.
// The whitespace between tokens is RFC 8259's four characters: space, TAB,
// LF and CR. Names are compared once their escapes are decoded, UTF-16 code
// unit for code unit. The value itself is then the one JSON.parse gives: a
// text with no name twice in one object has one reading.
function checkJson(text) {
  let at = 0;
  const fail = (why = NOT_JSON) => {
    throw new InvalidJson(why);
  };
  const digit = (c) => c !== undefined && c >= '0' && c <= '9';
  const space = () => {
    while (at < text.length && (text[at] === ' ' || text[at] === '\t' || text[at] === '\n' || text[at] === '\r')) at += 1;
  };
  // A string, from its opening quote. It gives the string decoded when
  // `decoded` is true, and null otherwise.
  const string = (decoded) => {
    const from = at;
    at += 1;
    for (;;) {
      if (at >= text.length) fail();
      const code = text.charCodeAt(at);
      if (code === 0x22) break;
      if (code < 0x20) fail();
      if (code !== 0x5c) {
        at += 1;
        continue;
      }
      const escape = text[at + 1];
      if (escape === 'u' && /^[0-9A-Fa-f]{4}$/.test(text.slice(at + 2, at + 6))) at += 6;
      else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) at += 2;
      else fail();
    }
    at += 1;
    return decoded ? JSON.parse(text.slice(from, at)) : null;
  };
  const number = () => {
    if (text[at] === '-') at += 1;
    if (text[at] === '0') {
      at += 1;
    } else {
      if (!digit(text[at])) fail();
      while (digit(text[at])) at += 1;
    }
    if (text[at] === '.') {
      at += 1;
      if (!digit(text[at])) fail();
      while (digit(text[at])) at += 1;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at += 1;
      if (text[at] === '+' || text[at] === '-') at += 1;
      if (!digit(text[at])) fail();
      while (digit(text[at])) at += 1;
    }
  };
  const literal = (word) => {
    if (!text.startsWith(word, at)) fail();
    at += word.length;
  };
  // A value that starts at `at`, inside `depth` objects and arrays.
  const value = (depth) => {
    const c = text[at];
    if (c === '{' || c === '[') {
      if (depth >= MAX_NESTING) fail(`nests more than ${MAX_NESTING} objects and arrays`);
      const close = c === '{' ? '}' : ']';
      const names = c === '{' ? new Set() : null;
      at += 1;
      space();
      if (text[at] === close) {
        at += 1;
        return;
      }
      for (;;) {
        if (names !== null) {
          if (text[at] !== '"') fail();
          const name = string(true);
          if (names.has(name)) fail(`repeats the member name ${shown(JSON.stringify(name))} within one object`);
          names.add(name);
          space();
          if (text[at] !== ':') fail();
          at += 1;
          space();
        }
        value(depth + 1);
        space();
        if (text[at] === close) {
          at += 1;
          return;
        }
        if (text[at] !== ',') fail();
        at += 1;
        space();
      }
    }
    if (c === '"') string(false);
    else if (c === 't') literal('true');
    else if (c === 'f') literal('false');
    else if (c === 'n') literal('null');
    else if (c === '-' || digit(c)) number();
    else fail();
  };
  space();
  value(0);
  space();
  if (at !== text.length) fail();
}

// ---- The canonical form of step 3 (RFC 8785, the JSON Canonicalization Scheme)

// A value the scheme, as the format's metadata profile bounds it, does not
// canonicalize.
class NotCanonical extends Error {}

// The canonical text of a parsed JSON value: the members of an object
// sorted by the UTF-16 code units of their names, no whitespace, a string
// escaped as JSON.stringify escapes it, a number as ECMAScript prints it.
// The profile refuses a number that is not finite, an integer-valued number
// outside the safe range (a double whose value is whole, 1e300 among them),
// and a string that holds an unpaired surrogate. Step 2 bounds the nesting,
// so the recursion here is at most that deep.
function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotCanonical('a number that is not finite');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new NotCanonical('an integer-valued number outside [-9007199254740991, 9007199254740991]');
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

// ---- The PEM block of step 5, and the base64 of steps 5 and 6

// The armor lines of a PEM block labelled PUBLIC KEY, put together from
// parts. The block: whitespace around it, and inside it the characters of
// base64 with line breaks among them.
const DASHES = '-'.repeat(5);
const PUBLIC_KEY_BLOCK = new RegExp(`^[\\t\\n\\v\\f\\r ]*${DASHES}BEGIN PUBLIC KEY${DASHES}([A-Za-z0-9+/=\\r\\n]*)${DASHES}END PUBLIC KEY${DASHES}[\\t\\n\\v\\f\\r ]*$`);
// Base64 characters of the standard alphabet, then at most two of padding.
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;
// The bytes the format's base64 rule ignores wherever they occur: TAB, LF,
// VT, FF, CR and space.
const BASE64_IGNORED = /[\t\n\v\f\r ]/g;

// The bytes that `text` encodes when it is base64 in the standard alphabet,
// padded to a multiple of four characters and written as RFC 4648 section
// 3.5 gives the canonical encoding, or null. Empty text is zero bytes.
function base64Bytes(text) {
  if (text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

// The DER in a text that is one PEM block labelled PUBLIC KEY by the rules
// of the format's entry table, or null.
function publicKeyDer(bytes) {
  const block = PUBLIC_KEY_BLOCK.exec(bytes.toString('latin1'));
  return block === null ? null : base64Bytes(block[1].replace(/[\r\n]/g, ''));
}

// ---- The steps

// 1. Parse ZIP and require all required entries, within the format's
//    limits.
function step1(pkg) {
  if (pkg.bytes.length > MAX_ARCHIVE_BYTES) return reject(pkg, 1, archiveTooLarge(pkg.bytes.length));
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

// 2. Parse metadata.json as an RFC 8259 JSON object: UTF-8 without a byte
//    order mark, no member name twice within one object, no nesting of more
//    than 64 objects and arrays.
function step2(pkg) {
  const bytes = pkg.entries.get('metadata.json');
  const invalid = (why) => reject(pkg, 2, named(`metadata.json ${why}`, METADATA_INVALID_JSON));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return invalid('starts with a byte order mark');
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid('is not UTF-8 text');
  }
  let value = null;
  try {
    checkJson(text);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof InvalidJson) return invalid(error.message);
    if (error instanceof SyntaxError) return invalid(NOT_JSON);
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
    return invalid(`is ${kind}, and it must be a JSON object`);
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
    if (error instanceof NotCanonical) return reject(pkg, 3, named(`metadata.json holds ${error.message}, which the metadata profile does not canonicalize`, METADATA_NOT_CANONICALIZABLE));
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

// 5. Read public_key.pem as the entry table gives it, and require its DER
//    SubjectPublicKeyInfo to equal the DER in the trusted signer PEM the
//    caller supplied (the pin), byte for byte.
function step5(pkg) {
  const unreadableKey = (why) => reject(pkg, 5, named(why, RSA_VERIFY_ERROR));
  const der = publicKeyDer(pkg.entries.get('public_key.pem'));
  if (der === null) return unreadableKey('public_key.pem is not one PEM block labelled PUBLIC KEY as the format\'s entry table gives it');
  let key = null;
  try {
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    key = null;
  }
  if (key === null || key.asymmetricKeyType !== 'rsa') return unreadableKey('the body of public_key.pem is not the DER SubjectPublicKeyInfo of an RSA key');
  // node:crypto reads some DER that is not the encoding of the key it
  // gives (a byte after it, parameters left out, a long form length): the
  // key written out again must be the same bytes.
  if (!key.export({ type: 'spki', format: 'der' }).equals(der)) return unreadableKey('the DER in public_key.pem is not the encoding of the RSA key it holds');
  const pinned = publicKeyDer(pkg.pin);
  if (pinned === null) return reject(pkg, 5, 'the pin, the trusted signer key the caller supplied, is not one PEM block labelled PUBLIC KEY, so it matches no key');
  if (!pinned.equals(der)) return reject(pkg, 5, 'the DER SubjectPublicKeyInfo in public_key.pem differs from the DER in the pin, the trusted signer key the caller supplied');
  pkg.key = key;
  return null;
}

// 6. Verify signature.sig over the bytes of canonical.bin as
//    RSASSA-PKCS1-v1_5 with SHA-256 (RFC 8017 section 8.2), with the key
//    step 5 read. signature.sig is base64 by the format's rule: TAB, LF,
//    VT, FF, CR and space are ignored wherever they occur, and the rest is
//    padded base64 in the standard alphabet.
//
//    The encoded block that is accepted is the one RFC 8017 section 9.2
//    gives, whose DigestInfo carries NULL algorithm parameters, which is
//    the block node:crypto checks for. The legacy block is not accepted
//    (see the readings above).
function step6(pkg) {
  const signature = base64Bytes(pkg.entries.get('signature.sig').toString('latin1').replace(BASE64_IGNORED, ''));
  if (signature === null) return reject(pkg, 6, 'signature.sig is not padded base64 in the standard alphabet once TAB, LF, VT, FF, CR and space are taken out');
  let verified = false;
  try {
    verified = crypto.verify('sha256', pkg.entries.get('canonical.bin'), { key: pkg.key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
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
  const pkg = { bytes, pin, entries: null, metadata: null, key: null, failedStep: null };
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

// A file larger than the reader takes, and its size.
class TooLarge extends Error {
  constructor(size, limit) {
    super('too large');
    this.size = size;
    this.code = `larger than ${limit} bytes`;
  }
}

// The bytes of a regular file of at most `limit` bytes. A larger file is
// not read.
function readFile(file, limit) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'not a regular file' });
  if (stat.size > limit) throw new TooLarge(stat.size, limit);
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
      // The file is not read past the format's 64 MiB; step 1 holds the
      // same limit against the bytes that were read.
      bytes = readFile(asked.file, MAX_ARCHIVE_BYTES);
    } catch (error) {
      const why = error instanceof TooLarge ? `${archiveTooLarge(error.size)}; it was not read` : `the package cannot be read (${reasonOf(error)})`;
      answer = { file: asked.file, sha256: null, verdict: REJECT, firstFailingStep: 1, notes: [`step 1: ${why}`, NOT_RUN] };
    }
    if (bytes !== null) answer = verify(asked.file, bytes, pin);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.exitCode = answer.verdict === PASS ? 0 : 1;
  }
}
