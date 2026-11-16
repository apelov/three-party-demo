// The verifier, step by step. It is run as a program with an empty
// environment on the records of a run written by the tree's writer, and on
// packages built here with a key made while the test runs. Each package
// built here breaks one clause of one step, and the test names the step the
// verifier must stop at. The canonical form a test expects is written out
// by hand in the test, from RFC 8785, without the code under test.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { pinFileOf } from '../src/record/testkey.mjs';
import { MANIFEST_FILE, writeRun } from '../src/record/writer.mjs';
import { storeZip } from '../src/record/zip.mjs';
import { makeRun, readJson, removeTempDirs, sha256, tempDir, UNZIP } from './record-support.mjs';
import { ANSWER_KEYS, buildZip, EARLY_FORM, entriesOf, fileOf, itemsOf, makeSigner, METADATA_CANONICAL, NOT_RUN, REQUIRED, RESPONSE, runVerifier, USAGE } from './verifier-support.mjs';

after(removeTempDirs);

const LIMIT = { timeout: 120000 };
const ZIP = '/usr/bin/zip';

let signer = null;
let other = null;
before(() => {
  signer = makeSigner();
  other = makeSigner();
});

// Runs the verifier on the bytes of a package with a pin, and checks what
// every answer holds: one JSON line with the five keys in their order, the
// path it was given, the hash of the bytes, and the closing note.
function verdictOn(bytes, pinFile = signer.pinFile) {
  const file = fileOf(bytes);
  const ran = runVerifier([file, '--pin', pinFile]);
  assert.ok(ran.answer, `one JSON line (stdout ${JSON.stringify(ran.stdout)}, stderr ${JSON.stringify(ran.stderr)})`);
  assert.deepEqual(Object.keys(ran.answer), ANSWER_KEYS);
  assert.equal(ran.answer.file, file);
  assert.equal(ran.answer.sha256, sha256(bytes));
  assert.equal(ran.answer.notes.at(-1), NOT_RUN);
  assert.equal(ran.stderr, '');
  assert.equal(ran.signal, null);
  return ran;
}

function passes(ran, remarks = []) {
  assert.deepEqual(
    { status: ran.status, verdict: ran.answer.verdict, firstFailingStep: ran.answer.firstFailingStep, notes: ran.answer.notes },
    { status: 0, verdict: 'pass-1-6', firstFailingStep: null, notes: [...remarks, NOT_RUN] },
  );
}

// The answer is a rejection at `step`, and the note of that step, the one
// before the closing note, matches `pattern`.
function rejectsAt(ran, step, pattern) {
  assert.deepEqual(
    { status: ran.status, verdict: ran.answer.verdict, firstFailingStep: ran.answer.firstFailingStep },
    { status: 1, verdict: 'reject', firstFailingStep: step },
    JSON.stringify(ran.answer.notes),
  );
  const note = ran.answer.notes.at(-2);
  assert.ok(note.startsWith(`step ${step}: `), note);
  assert.match(note, pattern);
}

const stored = (entries, over) => storeZip(itemsOf(entries, over));
const withEntry = (entries, name, data) => new Map([...entries].map(([n, d]) => [n, n === name ? Buffer.from(data) : d]));

test('on a run written by the tree\'s writer, every record passes steps 1 to 6 with the run\'s pin, and the tampered copy is rejected at step 3', { ...LIMIT }, () => {
  const run = makeRun();
  writeRun(run.runDir);
  const manifest = readJson(path.join(run.runDir, MANIFEST_FILE));
  const pin = pinFileOf(run.runDir);
  assert.ok(manifest.records.length >= 2);
  for (const record of manifest.records) {
    const file = path.join(run.runDir, record.file);
    const ran = runVerifier([file, '--pin', pin]);
    assert.deepEqual(ran.answer, { file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] }, record.file);
    assert.equal(ran.answer.sha256, sha256(fs.readFileSync(file)));
    assert.deepEqual({ status: ran.status, stderr: ran.stderr }, { status: 0, stderr: '' });
  }
  // The copy has one byte of response.txt changed, so the form of step 3
  // no longer equals canonical.bin.
  assert.equal(manifest.tampered.length, 1);
  const copy = path.join(run.runDir, manifest.tampered[0].file);
  const ran = runVerifier([copy, '--pin', pin]);
  assert.deepEqual(ran.answer, {
    file: copy,
    sha256: manifest.tampered[0].sha256,
    verdict: 'reject',
    firstFailingStep: 3,
    notes: ['step 3: canonical.bin is neither response.txt, LF, JCS(metadata.json) nor response.txt alone', NOT_RUN],
  });
  assert.equal(ran.status, 1);

  // A record of this run does not pass with the pin of another run.
  const elsewhere = makeRun();
  writeRun(elsewhere.runDir);
  const wrongPin = runVerifier([path.join(run.runDir, manifest.records[0].file), '--pin', pinFileOf(elsewhere.runDir)]);
  assert.deepEqual({ status: wrongPin.status, verdict: wrongPin.answer.verdict, firstFailingStep: wrongPin.answer.firstFailingStep }, { status: 1, verdict: 'reject', firstFailingStep: 5 });
});

test('a package built here passes steps 1 to 6: stored by the tree\'s writer, stored and deflated by the builder of these tests, and zipped by /usr/bin/zip', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  passes(verdictOn(stored(entries)));

  // Method 8 on every entry, a data descriptor after two of them, an
  // archive comment, and an entry the format does not name.
  const long = entriesOf(signer, { response: `${'{"line":"a response that deflates"}\n'.repeat(200)}` });
  const over = Object.fromEntries(REQUIRED.map((name) => [name, { method: 8 }]));
  over['response.txt'] = { method: 8, flags: 0x0008 };
  over['metadata.json'] = { flags: 0x0008 };
  const deflated = buildZip([...itemsOf(long, over), { name: 'notes/extra.txt', data: 'an entry the format does not name\n' }], { comment: 'a comment at the end of the archive' });
  passes(verdictOn(deflated));
  // The builder's archive is one the system's unzip reads too.
  const builderFile = fileOf(deflated, 'built.zip');
  assert.match(execFileSync(UNZIP, ['-t', builderFile], { encoding: 'utf8' }), /No errors detected/);
  assert.ok(execFileSync(UNZIP, ['-p', builderFile, 'response.txt']).equals(long.get('response.txt')));

  // The same entries zipped by another program, which deflates the long
  // one and adds extra fields of its own to each header.
  const dir = tempDir();
  for (const [name, data] of long) fs.writeFileSync(path.join(dir, name), data);
  const zipped = path.join(tempDir(), 'zipped.aep');
  execFileSync(ZIP, ['-q', '-j', zipped, ...REQUIRED.map((name) => path.join(dir, name))]);
  const bytes = fs.readFileSync(zipped);
  assert.match(execFileSync(UNZIP, ['-v', zipped], { encoding: 'utf8' }), /Defl:/, 'the other program deflated an entry');
  passes(verdictOn(bytes));
});

test('step 1: a package that lacks a required entry is rejected and the entry is named, for each of the seven', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  assert.deepEqual([...entries.keys()], [...REQUIRED]);
  for (const name of REQUIRED) {
    const without = new Map([...entries].filter(([n]) => n !== name));
    const ran = verdictOn(stored(without));
    rejectsAt(ran, 1, /^step 1: required entry missing: /);
    assert.equal(ran.answer.notes[0], `step 1: required entry missing: ${name}`);
  }
  // Two missing entries are both named, and a name in another case or in a
  // directory is not the entry.
  const two = new Map([...entries].filter(([n]) => n !== 'hash.sha256' && n !== 'timestamp.tsr'));
  assert.equal(verdictOn(stored(two)).answer.notes[0], 'step 1: required entries missing: hash.sha256, timestamp.tsr');
  const renamed = itemsOf(entries).map((item) => (item.name === 'response.txt' ? { ...item, name: 'Response.txt' } : item.name === 'timestamp.tsr' ? { ...item, name: 'dir/timestamp.tsr' } : item));
  assert.equal(verdictOn(buildZip(renamed)).answer.notes[0], 'step 1: required entries missing: response.txt, timestamp.tsr');
  // An archive with no entry at all.
  assert.equal(verdictOn(buildZip([])).answer.notes[0], `step 1: required entries missing: ${REQUIRED.join(', ')}`);
});

test('step 1: a file that is not a ZIP archive, and an archive that is cut short, are rejected', { ...LIMIT }, () => {
  const whole = stored(entriesOf(signer));
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an archive\n'), Buffer.from(RESPONSE), crypto.randomBytes(4096)]) {
    rejectsAt(verdictOn(bytes), 1, /^step 1: not a ZIP archive: no end of central directory record$/);
  }
  for (const cut of [whole.length - 1, whole.length - 22, Math.floor(whole.length / 2), 40]) {
    rejectsAt(verdictOn(whole.subarray(0, cut)), 1, /^step 1: a damaged or truncated archive: it starts as a ZIP archive and has no end of central directory record$/);
  }
  // Bytes after the end record, and a byte taken out of the middle.
  rejectsAt(verdictOn(Buffer.concat([whole, Buffer.from('x')])), 1, /no end of central directory record$/);
  const shifted = Buffer.concat([whole.subarray(0, 100), whole.subarray(101)]);
  rejectsAt(verdictOn(shifted), 1, /^step 1: a damaged archive: the central directory does not end where the end of central directory record begins$/);
});

test('step 1: a damaged archive is rejected with a note that says which: a CRC-32 or a size that does not match, another method, a duplicate name, a ZIP64 record, an encrypted entry, a local header that disagrees, entries that overlap', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const built = (over, options) => verdictOn(buildZip(itemsOf(entries, over), options));
  passes(built({}));

  rejectsAt(built({ 'hash.sha256': { crc: 0x12345678 } }), 1, /^step 1: a CRC-32 that does not match: entry hash\.sha256$/);
  // One byte of a stored entry changed after the archive was made.
  const whole = buildZip(itemsOf(entries));
  const at = whole.indexOf(Buffer.from(RESPONSE));
  assert.ok(at > 0);
  const flipped = Buffer.from(whole);
  flipped[at + 5] ^= 0x01;
  rejectsAt(verdictOn(flipped), 1, /^step 1: a CRC-32 that does not match: entry response\.txt$/);

  rejectsAt(built({ 'metadata.json': { size: entries.get('metadata.json').length + 1 } }), 1, /^step 1: a size that does not match: entry metadata\.json is \d+ bytes, and the central directory says \d+$/);
  rejectsAt(built({ 'metadata.json': { method: 8, size: 3 } }), 1, /^step 1: a damaged archive: entry metadata\.json does not inflate to the size the central directory gives$/);
  rejectsAt(built({ 'metadata.json': { method: 8, packed: Buffer.from('not a deflate stream') } }), 1, /does not inflate/);
  rejectsAt(built({ 'canonical.bin': { packedSize: 1 << 20 } }), 1, /^step 1: a damaged or truncated archive: the data of entry canonical\.bin runs past the central directory$/);

  for (const method of [1, 9, 12, 14, 93, 99]) {
    rejectsAt(built({ 'timestamp.tsr': { method, packed: entries.get('timestamp.tsr') } }), 1, new RegExp(`^step 1: entry timestamp\\.tsr uses compression method ${method}; this verifier reads method 0 \\(stored\\) and method 8 \\(deflate\\)$`));
  }

  const twice = [...itemsOf(entries), { name: 'response.txt', data: 'a second entry of the same name\n' }];
  rejectsAt(verdictOn(buildZip(twice)), 1, /^step 1: a duplicate entry name: response\.txt$/);

  rejectsAt(built({}, { patchEnd: (end) => { end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); } }), 1, /^step 1: a ZIP64 record: the end of central directory record defers to one$/);
  rejectsAt(built({}, { patchEnd: (end) => end.writeUInt32LE(0xffffffff, 16) }), 1, /^step 1: a ZIP64 record: /);
  const zip64Block = Buffer.from([0x01, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  rejectsAt(built({ 'signature.sig': { extra: zip64Block } }), 1, /^step 1: a ZIP64 record: entry signature\.sig defers to one$/);
  rejectsAt(built({}, { patchEnd: (end) => end.writeUInt16LE(1, 4) }), 1, /^step 1: an archive split over more than one disk$/);
  rejectsAt(built({}, { patchEnd: (end) => end.writeUInt16LE(3, 10) }), 1, /^step 1: an archive split over more than one disk$/);

  rejectsAt(built({ 'public_key.pem': { flags: 0x0001 } }), 1, /^step 1: entry public_key\.pem is encrypted$/);

  rejectsAt(built({ 'response.txt': { localName: 'response.bin' } }), 1, /^step 1: a damaged archive: the local header of entry response\.txt carries another name$/);
  rejectsAt(built({ 'response.txt': { localMethod: 8 } }), 1, /^step 1: a damaged archive: the local header of entry response\.txt states another compression method$/);
  rejectsAt(built({ 'response.txt': { localCrc: 1 } }), 1, /^step 1: a size or CRC-32 that does not match: the local header of entry response\.txt differs from the central directory$/);
  rejectsAt(built({ 'response.txt': { localSize: 1 } }), 1, /^step 1: a size or CRC-32 that does not match: /);
  rejectsAt(built({ 'canonical.bin': { offset: 3 } }), 1, /^step 1: a damaged archive: entry canonical\.bin has no local header at the offset the central directory gives$/);

  // Two names of the central directory whose bytes are the same bytes of
  // the file: the second entry lies inside the data of the one before it.
  const inner = buildZip([{ name: 'timestamp.tsr', data: entries.get('timestamp.tsr') }]);
  const innerLocal = inner.subarray(0, 30 + 'timestamp.tsr'.length + entries.get('timestamp.tsr').length);
  const outer = itemsOf(new Map([...entries].filter(([n]) => n !== 'timestamp.tsr')));
  const holder = { name: 'holder.bin', data: innerLocal };
  const outerBytes = buildZip([...outer, holder]);
  const holderDataAt = outerBytes.indexOf(innerLocal);
  assert.ok(holderDataAt > 0);
  const overlapping = buildZip([...outer, holder, { name: 'timestamp.tsr', data: entries.get('timestamp.tsr'), offset: holderDataAt, noLocal: true }]);
  rejectsAt(verdictOn(overlapping), 1, /^step 1: a damaged archive: entry holder\.bin and entry timestamp\.tsr overlap$/);
});

test('step 2: metadata.json that is not a JSON object is rejected: an array, a scalar, null, text that is not JSON, a byte order mark, bytes that are not UTF-8', { ...LIMIT }, () => {
  const cases = [
    ['[{"seq":5}]', /^step 2: metadata\.json is an array, and it must be a JSON object$/],
    ['"a string"', /^step 2: metadata\.json is a string, and it must be a JSON object$/],
    ['5', /^step 2: metadata\.json is a number, and it must be a JSON object$/],
    ['true', /^step 2: metadata\.json is a boolean, and it must be a JSON object$/],
    ['null', /^step 2: metadata\.json is null, and it must be a JSON object$/],
    ['{"seq":5', /^step 2: metadata\.json is not JSON$/],
    ['', /^step 2: metadata\.json is not JSON$/],
    ['{"seq":5} trailing', /^step 2: metadata\.json is not JSON$/],
    ['\ufeff{"seq":5}', /^step 2: metadata\.json is not JSON$/],
    [Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), /^step 2: metadata\.json is not UTF-8 text$/],
  ];
  for (const [text, pattern] of cases) {
    const entries = withEntry(entriesOf(signer), 'metadata.json', text);
    rejectsAt(verdictOn(stored(entries)), 2, pattern);
  }
});

test('step 3: canonical.bin equals response.txt, LF and the RFC 8785 form of the metadata: members sorted by UTF-16 code units, no whitespace, strings and numbers as ECMAScript writes them', { ...LIMIT }, () => {
  const cases = [
    // Members out of order, whitespace, nested values.
    ['{ "b": 1,\n "a": [true, null, false, {"z": "x", "y": 1.5, "": []}], "c": {} }', '{"a":[true,null,false,{"":[],"y":1.5,"z":"x"}],"b":1,"c":{}}'],
    // Numbers as ECMAScript prints them.
    ['{"a":1e3,"b":1.0,"c":-0,"d":0.000001,"e":1e-7,"f":4.50,"g":2e-3,"h":-12.5e1,"i":9007199254740991}', '{"a":1000,"b":1,"c":0,"d":0.000001,"e":1e-7,"f":4.5,"g":0.002,"h":-125,"i":9007199254740991}'],
    ['{"n":333333333.33333329,"m":1e-27,"k":5e-324}', '{"k":5e-324,"m":1e-27,"n":333333333.3333333}'],
    // Strings: the escapes of the text are read, and the canonical form
    // writes the short escapes, lower case hex for other controls, and
    // every other character as itself.
    [String.raw`{"s":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","t":"\b\f\n\r\t\u001f\u007f"}`, String.raw`{"s":"€$\u000f\nA'B\"\\\\\"/","t":"\b\f\n\r\t\u001f` + '\u007f"}'],
    // Member names sorted by UTF-16 code units, not by code point: the
    // name written with a surrogate pair sorts before U+FF5E.
    [String.raw`{"\uff5e":1,"\ud83d\ude00":2,"\u20ac":3,"\r":4,"1":5,"\u0080":6,"\u00f6":7}`, '{"\\r":4,"1":5,"\u0080":6,"\u00f6":7,"\u20ac":3,"\ud83d\ude00":2,"\uff5e":1}'],
  ];
  for (const [metadataText, canonicalMetadata] of cases) {
    passes(verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata }))));
  }
});

test('step 3: a changed canonical.bin, a changed response.txt and changed metadata are rejected, each signed or not', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const note = /^step 3: canonical\.bin is neither response\.txt, LF, JCS\(metadata\.json\) nor response\.txt alone$/;
  const canonical = entries.get('canonical.bin');

  // canonical.bin changed, the other entries as they were.
  const changed = Buffer.from(canonical);
  changed[changed.length - 3] ^= 0x01;
  rejectsAt(verdictOn(stored(withEntry(entries, 'canonical.bin', changed))), 3, note);
  // The same change with a hash and a signature made over the changed bytes.
  rejectsAt(verdictOn(stored(entriesOf(signer, { canonical: changed }))), 3, note);
  // One byte of response.txt changed, as in the tampered copy of a run.
  const response = Buffer.from(RESPONSE);
  response[2] ^= 0x01;
  rejectsAt(verdictOn(stored(withEntry(entries, 'response.txt', response))), 3, note);
  // One value of the metadata changed.
  rejectsAt(verdictOn(stored(withEntry(entries, 'metadata.json', '{"decision":"blocked","profile":"test-profile/1","seq":5,"step":"pay"}'))), 3, note);
  // canonical.bin that is the metadata text as written, not its canonical form.
  const asWritten = Buffer.concat([Buffer.from(RESPONSE), Buffer.from('\n'), entries.get('metadata.json')]);
  rejectsAt(verdictOn(stored(entriesOf(signer, { canonical: asWritten }))), 3, note);
  // CR LF in the place of LF, no separator, and a line end after the form.
  for (const joined of [`${RESPONSE}\r\n${METADATA_CANONICAL}`, `${RESPONSE}${METADATA_CANONICAL}`, `${RESPONSE}\n${METADATA_CANONICAL}\n`]) {
    rejectsAt(verdictOn(stored(entriesOf(signer, { canonical: Buffer.from(joined) }))), 3, note);
  }
});

test('step 3: the early response form (response.txt alone) passes with its note, and the note stays when a later step fails', { ...LIMIT }, () => {
  const early = entriesOf(signer, { canonical: Buffer.from(RESPONSE) });
  assert.ok(early.get('canonical.bin').equals(early.get('response.txt')));
  const ran = verdictOn(stored(early));
  passes(ran, [EARLY_FORM]);
  assert.equal(EARLY_FORM, 'step 3: early response form (response.txt alone); metadata is not signature-bound');

  // With the early form the metadata is not bound: another metadata text
  // passes too, and the note says why.
  passes(verdictOn(stored(withEntry(early, 'metadata.json', '{"seq":99}'))), [EARLY_FORM]);

  // The early form with a signature of another key: the remark of step 3,
  // then the note of the step that failed.
  const signedByAnother = withEntry(early, 'signature.sig', other.sign(Buffer.from(RESPONSE)).toString('base64'));
  const failed = verdictOn(stored(signedByAnother));
  rejectsAt(failed, 6, /does not verify/);
  assert.deepEqual(failed.answer.notes, [EARLY_FORM, 'step 6: signature.sig does not verify over canonical.bin as RSASSA-PKCS1-v1_5 with SHA-256', NOT_RUN]);
});

test('step 3: metadata the profile does not canonicalize is rejected: an integer outside the safe range, a number that is not finite, an unpaired surrogate in a value or in a name', { ...LIMIT }, () => {
  const cases = [
    ['{"n":9007199254740993}', /^step 3: metadata\.json holds an integer outside the safe range, which the metadata profile does not canonicalize$/],
    ['{"n":-9007199254740992}', /an integer outside the safe range/],
    ['{"a":{"b":[1,1e21]}}', /an integer outside the safe range/],
    ['{"n":1e400}', /^step 3: metadata\.json holds a number that is not finite, which the metadata profile does not canonicalize$/],
    [String.raw`{"s":"\ud800"}`, /^step 3: metadata\.json holds an unpaired surrogate, which the metadata profile does not canonicalize$/],
    [String.raw`{"s":"\ude00\ud83d"}`, /an unpaired surrogate/],
    [String.raw`{"\udfff":1}`, /an unpaired surrogate/],
  ];
  for (const [metadataText, pattern] of cases) {
    // Whatever canonical.bin holds, the profile form or the early form.
    rejectsAt(verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata: metadataText }))), 3, pattern);
    rejectsAt(verdictOn(stored(entriesOf(signer, { metadataText, canonical: Buffer.from(RESPONSE) }))), 3, pattern);
  }
  // The largest safe integer on each side is inside the range.
  passes(verdictOn(stored(entriesOf(signer, { metadataText: '{"hi":9007199254740991,"lo":-9007199254740991}', canonicalMetadata: '{"hi":9007199254740991,"lo":-9007199254740991}' }))));
});

test('step 4: hash.sha256 must be the SHA-256 of canonical.bin; whitespace around it and upper case hex are accepted', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const hex = entries.get('hash.sha256').toString('latin1');
  assert.equal(hex, sha256(entries.get('canonical.bin')));
  for (const accepted of [`${hex}\n`, hex.toUpperCase(), `${hex.toUpperCase()}\n`, `  ${hex}\r\n`, `\t${hex} \n\n`]) {
    passes(verdictOn(stored(withEntry(entries, 'hash.sha256', accepted))));
  }
  const differs = /^step 4: SHA-256\(canonical\.bin\) differs from hash\.sha256$/;
  const changed = `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
  rejectsAt(verdictOn(stored(withEntry(entries, 'hash.sha256', changed))), 4, differs);
  rejectsAt(verdictOn(stored(withEntry(entries, 'hash.sha256', sha256(entries.get('response.txt'))))), 4, differs);
  const notHex = /^step 4: hash\.sha256 is not 64 hexadecimal characters$/;
  for (const text of ['', hex.slice(0, 63), `${hex}0`, `${hex.slice(0, 32)} ${hex.slice(32)}`, `sha256:${hex}`, `${hex.slice(0, 63)}g`, `${hex}  response.txt`]) {
    rejectsAt(verdictOn(stored(withEntry(entries, 'hash.sha256', text))), 4, notHex);
  }
});

test('step 5: public_key.pem must be the pin byte for byte: a pin that is another key, and a pin that is the same key in other bytes, are rejected', { ...LIMIT }, () => {
  const bytes = stored(entriesOf(signer));
  passes(verdictOn(bytes, signer.pinFile));
  const note = /^step 5: public_key\.pem differs from the pin, the trusted signer key the caller supplied$/;
  rejectsAt(verdictOn(bytes, other.pinFile), 5, note);

  // The same key, written with one more line end, and in another encoding.
  const spaced = path.join(tempDir(), 'pin-with-a-line.txt');
  fs.writeFileSync(spaced, Buffer.concat([signer.publicPem, Buffer.from('\n')]));
  rejectsAt(verdictOn(bytes, spaced), 5, note);
  const pkcs1 = path.join(tempDir(), 'pin-pkcs1.txt');
  fs.writeFileSync(pkcs1, crypto.createPublicKey(signer.publicPem).export({ type: 'pkcs1', format: 'pem' }));
  rejectsAt(verdictOn(bytes, pkcs1), 5, note);
  const empty = path.join(tempDir(), 'pin-empty.txt');
  fs.writeFileSync(empty, '');
  rejectsAt(verdictOn(bytes, empty), 5, note);

  // A package that carries its own key and a signature made with it is
  // consistent in itself, and is still not the pinned signer's.
  rejectsAt(verdictOn(stored(entriesOf(other)), signer.pinFile), 5, note);
  passes(verdictOn(stored(entriesOf(other)), other.pinFile));
});

test('step 6: signature.sig must be base64 of an RSASSA-PKCS1-v1_5 SHA-256 signature over canonical.bin by the embedded key', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const canonical = entries.get('canonical.bin');
  const base64 = entries.get('signature.sig').toString('latin1');
  const fails = /^step 6: signature\.sig does not verify over canonical\.bin as RSASSA-PKCS1-v1_5 with SHA-256$/;
  const notBase64 = /^step 6: signature\.sig is not base64$/;

  // Whitespace around the base64 is ignored.
  for (const accepted of [`${base64}\n`, `  ${base64}\r\n`]) passes(verdictOn(stored(withEntry(entries, 'signature.sig', accepted))));

  // A signature over other bytes, a signature of another key, one changed
  // byte, an empty entry.
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', signer.sign(Buffer.from(RESPONSE)).toString('base64')))), 6, fails);
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', other.sign(canonical).toString('base64')))), 6, fails);
  const raw = Buffer.from(base64, 'base64');
  raw[10] ^= 0x01;
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', raw.toString('base64')))), 6, fails);
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', ''))), 6, fails);
  // The signature written as hex: its characters are base64 characters, so
  // it decodes, to other bytes.
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', Buffer.from(base64, 'base64').toString('hex')))), 6, fails);
  // A PSS signature of the same key over the same bytes is not this scheme.
  const pss = crypto.sign('sha256', canonical, { key: signer.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING });
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', pss.toString('base64')))), 6, fails);

  // What is not padded base64 in the standard alphabet: other characters,
  // no padding, the URL alphabet, whitespace inside it, the raw bytes.
  assert.match(base64, /^[A-Za-z0-9+/]{342}==$/);
  const urlForm = Buffer.from(base64, 'base64').toString('base64url');
  for (const text of ['not base64 !!', base64.slice(0, -2), `${urlForm}~~`, `${base64.slice(0, 64)}\n${base64.slice(64)}`, `${base64.slice(0, 100)} ${base64.slice(100)}`]) {
    rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', text))), 6, notBase64);
  }
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', Buffer.from(base64, 'base64')))), 6, notBase64);

  // The block RFC 8017 section 9.2 gives, with NULL parameters, is the
  // signature node:crypto makes, and it passes. The legacy block, whose
  // DigestInfo leaves the parameters out, is not accepted.
  const digest = crypto.createHash('sha256').update(canonical).digest();
  const block = (digestInfoHex) => crypto.privateEncrypt({ key: signer.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([Buffer.from(digestInfoHex, 'hex'), digest]));
  const standard = block('3031300d060960864801650304020105000420');
  assert.ok(standard.equals(Buffer.from(base64, 'base64')), 'the block with NULL parameters is the signature in the package');
  passes(verdictOn(stored(withEntry(entries, 'signature.sig', standard.toString('base64')))));
  const legacy = block('302f300b06096086480165030402010420');
  assert.equal(legacy.length, standard.length);
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', legacy.toString('base64')))), 6, fails);
});

test('step 6: public_key.pem must be one RSA public key as a SubjectPublicKeyInfo in PEM, also when the pin holds the same bytes', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const note = /^step 6: public_key\.pem is not one RSA public key as a SubjectPublicKeyInfo in PEM$/;
  const publicKey = crypto.createPublicKey(signer.publicPem);
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forms = [
    publicKey.export({ type: 'pkcs1', format: 'pem' }),
    publicKey.export({ type: 'spki', format: 'der' }),
    ec.publicKey.export({ type: 'spki', format: 'pem' }),
    `${signer.publicPem.toString('latin1')}${other.publicPem.toString('latin1')}`,
    `a line before the key\n${signer.publicPem.toString('latin1')}`,
    'not a key\n',
    '',
  ];
  for (const form of forms) {
    // The pin is the same bytes, so step 5 passes and step 6 reads the key.
    const pin = path.join(tempDir(), 'pin-of-this-form.txt');
    fs.writeFileSync(pin, form);
    rejectsAt(verdictOn(stored(withEntry(entries, 'public_key.pem', form)), pin), 6, note);
  }
});

test('the command line: exit 0 on pass-1-6, 1 on reject, 2 with no verdict line on a wrong argument or a pin that cannot be read; a package that cannot be read is rejected at step 1', { ...LIMIT }, () => {
  const file = fileOf(stored(entriesOf(signer)));

  // Both orders of the two arguments.
  for (const args of [[file, '--pin', signer.pinFile], ['--pin', signer.pinFile, file]]) {
    const ran = runVerifier(args);
    assert.deepEqual({ status: ran.status, stderr: ran.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(ran.answer, { file, sha256: sha256(fs.readFileSync(file)), verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] });
    assert.equal(ran.stdout, `${JSON.stringify(ran.answer)}\n`, 'one line, and nothing else on standard output');
  }
  assert.equal(runVerifier([file, '--pin', other.pinFile]).status, 1);

  for (const args of [[], [file], [file, '--pin'], ['--pin', signer.pinFile], [file, signer.pinFile], [file, '--pin', signer.pinFile, 'more'], [file, '--key', signer.pinFile], ['--pin', signer.pinFile, '--verbose'], ['', '--pin', signer.pinFile], [file, '--pin', ''], ['--help']]) {
    const ran = runVerifier(args);
    assert.deepEqual({ status: ran.status, stdout: ran.stdout, stderr: ran.stderr }, { status: 2, stdout: '', stderr: USAGE }, JSON.stringify(args));
  }

  // A pin that is absent, a directory, or too large.
  const large = path.join(tempDir(), 'large-pin.txt');
  fs.writeFileSync(large, Buffer.alloc(64 * 1024 + 1, 0x41));
  for (const [pin, reason] of [[path.join(tempDir(), 'absent.txt'), 'ENOENT'], [tempDir(), 'not a regular file'], [large, 'larger than 65536 bytes']]) {
    const ran = runVerifier([file, '--pin', pin]);
    assert.deepEqual({ status: ran.status, stdout: ran.stdout, stderr: ran.stderr }, { status: 2, stdout: '', stderr: `aep-verify: the pin cannot be read (${reason})\n` }, reason);
  }

  // A package that is absent, or a directory: one line, rejected at step 1, no hash.
  for (const [target, reason] of [[path.join(tempDir(), 'absent.aep'), 'ENOENT'], [tempDir(), 'not a regular file']]) {
    const ran = runVerifier([target, '--pin', signer.pinFile]);
    assert.equal(ran.status, 1);
    assert.equal(ran.stderr, '');
    assert.deepEqual(ran.answer, { file: target, sha256: null, verdict: 'reject', firstFailingStep: 1, notes: [`step 1: the package cannot be read (${reason})`, NOT_RUN] });
  }
});
