// Shared by the verifier tests: a runner for the verifier as a program, a
// signer whose key is generated while the test runs, the seven entries of a
// package over a response and a metadata text, and a ZIP builder that sets
// every field of an archive by hand, so that a test can state a field
// wrongly. The canonical form of a metadata text is written out by the test
// that uses it; nothing here computes it. No key is stored in this file and
// no key text is printed.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { sha256, tempDir, THREE_PARTY } from './record-support.mjs';

export const VERIFIER = path.join(THREE_PARTY, 'src', 'verifier', 'aep-verify.mjs');
export const REQUIRED = Object.freeze(['response.txt', 'canonical.bin', 'hash.sha256', 'signature.sig', 'public_key.pem', 'metadata.json', 'timestamp.tsr']);
export const ANSWER_KEYS = Object.freeze(['file', 'sha256', 'verdict', 'firstFailingStep', 'notes']);
export const NOT_RUN = 'steps 7 to 10 not run by this verifier';
export const EARLY_FORM = 'step 3: early response form (response.txt alone); metadata is not signature-bound';
export const USAGE = 'usage: node three-party/src/verifier/aep-verify.mjs <package.aep> --pin <public key PEM file>\n';

// Runs the verifier as a program with an empty environment. `answer` is its
// one JSON line as an object, or null when it printed anything else.
export function runVerifier(args, { wrap = [] } = {}) {
  const argv = [...wrap, process.execPath, VERIFIER, ...args];
  const ran = spawnSync(argv[0], argv.slice(1), { env: {}, encoding: 'utf8', timeout: 60000 });
  const stdout = ran.stdout ?? '';
  let answer = null;
  if (/^[^\n]+\n$/.test(stdout)) {
    try {
      answer = JSON.parse(stdout);
    } catch {
      answer = null;
    }
  }
  return { status: ran.status, signal: ran.signal, stdout, stderr: ran.stderr ?? '', answer };
}

// An RSA key made for the test that asks for it (2048 bits unless it asks
// for another size), its public key in SPKI PEM, and that PEM in a file to
// give as the pin.
export function makeSigner(modulusLength = 2048) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength });
  const publicPem = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  const pinFile = path.join(tempDir(), 'pin.txt');
  fs.writeFileSync(pinFile, publicPem);
  return {
    privateKey,
    publicPem,
    pinFile,
    sign: (bytes) => crypto.sign('sha256', bytes, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }),
  };
}

// A response and a metadata text of a fictional action, with the canonical
// form of the metadata written out by hand: its members sorted, no space.
export const RESPONSE = '{"paymentId":"PAY-0001","status":"accepted"}\n';
export const METADATA_TEXT = '{\n  "seq": 5,\n  "step": "pay",\n  "profile": "test-profile/1",\n  "decision": "allowed"\n}\n';
export const METADATA_CANONICAL = '{"decision":"allowed","profile":"test-profile/1","seq":5,"step":"pay"}';

// The seven entries of a package, in the order of the format's table. With
// no `canonical` given, canonical.bin is response, LF, canonicalMetadata.
export function entriesOf(signer, { response = RESPONSE, metadataText = METADATA_TEXT, canonicalMetadata = METADATA_CANONICAL, canonical = null } = {}) {
  const canonicalBytes = canonical ?? Buffer.concat([Buffer.from(response, 'utf8'), Buffer.from('\n'), Buffer.from(canonicalMetadata, 'utf8')]);
  return new Map([
    ['response.txt', Buffer.from(response, 'utf8')],
    ['canonical.bin', canonicalBytes],
    ['hash.sha256', Buffer.from(sha256(canonicalBytes))],
    ['signature.sig', Buffer.from(signer.sign(canonicalBytes).toString('base64'))],
    ['public_key.pem', signer.publicPem],
    ['metadata.json', Buffer.from(metadataText, 'utf8')],
    ['timestamp.tsr', Buffer.from('stand-in: no timestamp authority\n')],
  ]);
}

// The entries as the list the ZIP builder takes, with the fields of `over`
// laid over the entry of that name: over = { 'hash.sha256': { crc: 1 } }.
export function itemsOf(entries, over = {}) {
  return [...entries].map(([name, data]) => ({ name, data, ...(over[name] ?? {}) }));
}

// A ZIP archive built field by field. Each item is { name, data } and may
// state: method (0 stored, 8 deflate, or any number), packed (the bytes
// stored for it), crc, size, packedSize (the central directory's), flags,
// localName, localMethod, localCrc, localSize, extra (the central
// directory's extra field), offset (the central directory's offset of the
// local header), and noLocal (no local header and no data are written for
// it). An item whose flags hold bit 3 gets zero in its local header and a
// data descriptor after its data. `comment` is the archive comment, and
// `patchEnd` may change the end of central directory record.
export function buildZip(items, { comment = '', patchEnd = null } = {}) {
  const front = [];
  const directory = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'latin1');
    const data = Buffer.from(item.data);
    const method = item.method ?? 0;
    const packed = item.packed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = item.crc ?? zlib.crc32(data);
    const size = item.size ?? data.length;
    const flags = item.flags ?? 0;
    const deferred = (flags & 0x0008) !== 0;
    const localName = Buffer.from(item.localName ?? item.name, 'latin1');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(item.localMethod ?? method, 8);
    local.writeUInt32LE(deferred ? 0 : item.localCrc ?? crc, 14);
    local.writeUInt32LE(deferred ? 0 : packed.length, 18);
    local.writeUInt32LE(deferred ? 0 : item.localSize ?? size, 22);
    local.writeUInt16LE(localName.length, 26);
    const descriptor = Buffer.alloc(deferred ? 16 : 0);
    if (deferred) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }

    const extra = item.extra ?? Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(item.packedSize ?? packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(item.offset ?? offset, 42);
    directory.push(central, name, extra);

    if (item.noLocal) continue;
    front.push(local, localName, packed, descriptor);
    offset += local.length + localName.length + packed.length + descriptor.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const note = Buffer.from(comment, 'latin1');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  if (patchEnd) patchEnd(end);
  return Buffer.concat([...front, directoryBytes, end, note]);
}

// Writes bytes to a file of a temp directory and gives its path.
export function fileOf(bytes, name = 'package.aep') {
  const file = path.join(tempDir(), name);
  fs.writeFileSync(file, bytes);
  return file;
}
