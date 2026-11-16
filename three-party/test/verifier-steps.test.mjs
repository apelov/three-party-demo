// The verifier, step by step. It is run as a program with an empty
// environment on the records of a run written by the tree's writer, and on
// packages built here with a key made while the test runs. Each package
// built here breaks one clause of one step, and the test names the step the
// verifier must stop at. The canonical form a test expects is written out
// by hand in the test, from RFC 8785, without the code under test. The
// clauses are those of the format text FORMAT-SOURCE.txt names.

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

const MIB = 1024 * 1024;

// The armor lines of a PEM block labelled PUBLIC KEY, put together from
// parts, and a PEM text laid out by hand.
const DASHES = '-'.repeat(5);
const BEGIN = `${DASHES}BEGIN PUBLIC KEY${DASHES}`;
const END = `${DASHES}END PUBLIC KEY${DASHES}`;
// The base64 of a PEM block node:crypto wrote, on one line.
const bodyOf = (pem) => pem.toString('latin1').replace(BEGIN, '').replace(END, '').replace(/[\r\n]/g, '');
// Text cut into lines of `width` characters joined by `eol`.
const laidOut = (text, width, eol) => (text.match(new RegExp(`.{1,${width}}`, 'gs')) ?? []).join(eol);
// DER bytes as a PEM block labelled PUBLIC KEY, in lines of 64.
const pemOf = (der) => `${BEGIN}\n${laidOut(der.toString('base64'), 64, '\n')}\n${END}\n`;
// A file holding the text given, to give as the pin.
const pinOf = (text) => {
  const file = path.join(tempDir(), 'pin-as-written.txt');
  fs.writeFileSync(file, text);
  return file;
};
// A file of `size` bytes, all zero, written without its bytes (a sparse file).
const zerosOf = (size) => {
  const file = path.join(tempDir(), 'zeros.aep');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
  return file;
};

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
  const deflated = buildZip([...itemsOf(long, over), { name: 'notes-extra.txt', data: 'an entry the format does not name\n' }], { comment: 'a comment at the end of the archive' });
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
  // Two missing entries are both named, and a name in another case is not
  // the entry. (A name in a directory is refused for its slash: the test of
  // entry names below.)
  const two = new Map([...entries].filter(([n]) => n !== 'hash.sha256' && n !== 'timestamp.tsr'));
  assert.equal(verdictOn(stored(two)).answer.notes[0], 'step 1: required entries missing: hash.sha256, timestamp.tsr');
  const renamed = itemsOf(entries).map((item) => (item.name === 'response.txt' ? { ...item, name: 'Response.txt' } : item.name === 'timestamp.tsr' ? { ...item, name: 'TIMESTAMP.TSR' } : item));
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

test('step 1: an entry name that holds /, \\ or NUL is rejected, the name of a required entry and of an entry the format does not name alike', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const cases = [
    ['notes/extra.txt', 'notes/extra.txt'],
    ['notes/', 'notes/'],
    ['/extra.txt', '/extra.txt'],
    ['notes\\extra.txt', 'notes\\extra.txt'],
    ['extra\u0000.txt', 'extra?.txt'],
    ['\u0000', '?'],
  ];
  for (const [name, asShown] of cases) {
    const ran = verdictOn(buildZip([...itemsOf(entries), { name, data: 'an entry the format does not name\n' }]));
    rejectsAt(ran, 1, /^step 1: /);
    assert.equal(ran.answer.notes[0], `step 1: an entry name that holds /, \\ or NUL: ${asShown}`, JSON.stringify(name));
  }
  // A required entry under a directory, in the place of the entry at the
  // root, and one whose name ends in NUL.
  for (const [from, to] of [['timestamp.tsr', 'dir/timestamp.tsr'], ['response.txt', 'response.txt\u0000'], ['metadata.json', '.\\metadata.json']]) {
    const renamed = itemsOf(entries).map((item) => (item.name === from ? { ...item, name: to } : item));
    rejectsAt(verdictOn(buildZip(renamed)), 1, /^step 1: an entry name that holds \/, \\ or NUL: /);
  }
  // The name rule looks at every entry: a name the format does not list,
  // without those characters, is ignored.
  passes(verdictOn(buildZip([...itemsOf(entries), { name: 'extra.txt', data: 'an entry the format does not name\n' }, { name: 'a name: with spaces, and "quotes".txt', data: '' }])));
});

test('step 1: the safety limits of the format, 32 entries, 16 MiB for one entry and 32 MiB expanded: a package at each limit passes, and one past it is rejected', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const extras = (n) => Array.from({ length: n }, (_, i) => ({ name: `extra-${i}.txt`, data: `an entry the format does not name, ${i}\n` }));

  // The seven required entries and 25 more make 32 entries; one more is 33.
  passes(verdictOn(buildZip([...itemsOf(entries), ...extras(25)])));
  rejectsAt(verdictOn(buildZip([...itemsOf(entries), ...extras(26)])), 1, /^step 1: the archive holds 33 entries, more than the 32 the format allows$/);

  // One entry that expands to 16 MiB passes. Zero bytes, deflated, keep the
  // archive small; the verifier inflates them and checks their CRC-32.
  const zeros = (size) => ({ data: Buffer.alloc(size), method: 8 });
  passes(verdictOn(buildZip([...itemsOf(entries), { name: 'large.bin', ...zeros(16 * MIB) }])));

  // Past a limit, the sizes the archive states are enough: the limits are
  // held against them before an entry is inflated. Each archive here holds
  // a few bytes of data under a header that states a larger size.
  const small = { data: 'a few bytes\n' };
  const tooLarge = (name) => new RegExp(`^step 1: entry ${name.replace('.', '\\.')} expands to 16777217 bytes, more than the 16 MiB \\(16777216 bytes\\) the format allows for one entry$`);
  rejectsAt(verdictOn(buildZip([...itemsOf(entries), { name: 'large.bin', ...small, size: 16 * MIB + 1 }])), 1, tooLarge('large.bin'));
  rejectsAt(verdictOn(buildZip([...itemsOf(entries), { name: 'large.bin', ...small, method: 8, size: 16 * MIB + 1 }])), 1, tooLarge('large.bin'));
  const largeStamp = itemsOf(entries).map((item) => (item.name === 'timestamp.tsr' ? { ...item, size: 16 * MIB + 1 } : item));
  rejectsAt(verdictOn(buildZip(largeStamp)), 1, tooLarge('timestamp.tsr'));
  // An entry stated as stored in more than 16 MiB is rejected too, though
  // it states that it expands to less.
  rejectsAt(verdictOn(buildZip([...itemsOf(entries), { name: 'packed.bin', ...small, method: 8, packedSize: 16 * MIB + 1 }])), 1, /^step 1: entry packed\.bin is stored in 16777217 bytes, more than the 16 MiB \(16777216 bytes\) the format allows for one entry$/);

  // All the entries together expand to 32 MiB: the package passes; to one
  // byte more, it is rejected, though no one entry is past its limit. The
  // entry that crosses the limit states its size and holds a few bytes.
  const own = [...entries.values()].reduce((sum, data) => sum + data.length, 0);
  const rest = 32 * MIB - own;
  const half = Math.floor(rest / 2);
  assert.ok(rest - half + 1 <= 16 * MIB);
  passes(verdictOn(buildZip([...itemsOf(entries), { name: 'a.bin', ...zeros(half) }, { name: 'b.bin', ...zeros(rest - half) }])));
  rejectsAt(verdictOn(buildZip([...itemsOf(entries), { name: 'a.bin', ...zeros(half) }, { name: 'b.bin', ...small, size: rest - half + 1 }])), 1, /^step 1: the entries expand to more than the 32 MiB \(33554432 bytes\) the format allows in all, at entry b\.bin$/);
});

test('step 1: an archive of 64 MiB is read, and an archive of more than 64 MiB is rejected at step 1 by the format\'s limit, without being read', { ...LIMIT }, () => {
  // 64 MiB of zero bytes: read, named by its hash, and not a ZIP archive.
  const atLimit = zerosOf(64 * MIB);
  const read = runVerifier([atLimit, '--pin', signer.pinFile]);
  assert.deepEqual(read.answer, { file: atLimit, sha256: sha256(fs.readFileSync(atLimit)), verdict: 'reject', firstFailingStep: 1, notes: ['step 1: not a ZIP archive: no end of central directory record', NOT_RUN] });
  assert.deepEqual({ status: read.status, stderr: read.stderr }, { status: 1, stderr: '' });

  // One byte more.
  const over = zerosOf(64 * MIB + 1);
  const ran = runVerifier([over, '--pin', signer.pinFile]);
  assert.deepEqual(ran.answer, { file: over, sha256: null, verdict: 'reject', firstFailingStep: 1, notes: ['step 1: the archive is 67108865 bytes, more than the 64 MiB (67108864 bytes) the format allows; it was not read', NOT_RUN] });
  assert.deepEqual({ status: ran.status, stderr: ran.stderr }, { status: 1, stderr: '' });
});

test('step 2: metadata.json that is not one RFC 8259 JSON object is rejected as METADATA_INVALID_JSON: an array, a scalar, null, text that is not JSON, a byte order mark, bytes that are not UTF-8', { ...LIMIT }, () => {
  const notJson = /^step 2: metadata\.json is not JSON \(METADATA_INVALID_JSON\)$/;
  const cases = [
    ['[{"seq":5}]', /^step 2: metadata\.json is an array, and it must be a JSON object \(METADATA_INVALID_JSON\)$/],
    ['"a string"', /^step 2: metadata\.json is a string, and it must be a JSON object \(METADATA_INVALID_JSON\)$/],
    ['5', /^step 2: metadata\.json is a number, and it must be a JSON object \(METADATA_INVALID_JSON\)$/],
    ['true', /^step 2: metadata\.json is a boolean, and it must be a JSON object \(METADATA_INVALID_JSON\)$/],
    ['null', /^step 2: metadata\.json is null, and it must be a JSON object \(METADATA_INVALID_JSON\)$/],
    ['{"seq":5', notJson],
    ['', notJson],
    [' \n', notJson],
    ['{"seq":5} trailing', notJson],
    ['{"seq":5}{}', notJson],
    // The literals NaN and Infinity, and other forms RFC 8259 does not have.
    ['{"n":NaN}', notJson],
    ['{"n":Infinity}', notJson],
    ['{"n":-Infinity}', notJson],
    ['{"n":01}', notJson],
    ['{"n":1.}', notJson],
    ['{"n":.5}', notJson],
    ['{"n":+1}', notJson],
    ['{"n":1e}', notJson],
    ['{"n":-}', notJson],
    ['{"n":0x10}', notJson],
    ['{"a":1,}', notJson],
    ['{,}', notJson],
    ['{"a" 1}', notJson],
    ["{'a':1}", notJson],
    ['{a:1}', notJson],
    ['{"a":tru}', notJson],
    ['{"a":true false}', notJson],
    ['{"a":[1,]}', notJson],
    ['{"a":"\u0001"}', notJson],
    ['{"a":"line\nend"}', notJson],
    [String.raw`{"a":"\x41"}`, notJson],
    [String.raw`{"a":"\u12"}`, notJson],
    [String.raw`{"a":"\'"}`, notJson],
    ['{"a":"unterminated}', notJson],
    // Whitespace that RFC 8259 does not have between tokens.
    ['{"a":\u000b1}', notJson],
    ['{"a":\u00a01}', notJson],
    // A byte order mark is refused as such; one after the text begins is not JSON.
    ['\ufeff{"seq":5}', /^step 2: metadata\.json starts with a byte order mark \(METADATA_INVALID_JSON\)$/],
    ['{"seq":5}\ufeff', notJson],
    [Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), /^step 2: metadata\.json is not UTF-8 text \(METADATA_INVALID_JSON\)$/],
    // A surrogate written in UTF-8 bytes, which UTF-8 does not allow.
    [Buffer.from([0x7b, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x3a, 0x31, 0x7d]), /^step 2: metadata\.json is not UTF-8 text \(METADATA_INVALID_JSON\)$/],
  ];
  for (const [text, pattern] of cases) {
    const entries = withEntry(entriesOf(signer), 'metadata.json', text);
    rejectsAt(verdictOn(stored(entries)), 2, pattern);
  }
});

test('step 2: a member name repeated within one object is rejected as METADATA_INVALID_JSON, the names compared after their escapes are decoded; the same name in two objects is not repeated', { ...LIMIT }, () => {
  const cases = [
    ['{"a":1,"a":2}', '"a"'],
    ['{"a":1,"a":1}', '"a"'],
    [String.raw`{"a":1,"\u0061":2}`, '"a"'],
    [String.raw`{"\/":1,"/":2}`, '"/"'],
    [String.raw`{"a\"b":1,"a\u0022b":2}`, String.raw`"a\"b"`],
    [String.raw`{"\ud83d\ude00":1,"😀":2}`, '"??"'],
    [String.raw`{"\ud800":1,"\uD800":2}`, String.raw`"\ud800"`],
    ['{"seq":5,"x":{"k":1,"y":[{"m":true,"m":false}]}}', '"m"'],
    ['{"seq":5,"seq":5,"step":"pay"}', '"seq"'],
  ];
  for (const [metadataText, asShown] of cases) {
    const ran = verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata: metadataText })));
    rejectsAt(ran, 2, /^step 2: /);
    assert.equal(ran.answer.notes[0], `step 2: metadata.json repeats the member name ${asShown} within one object (METADATA_INVALID_JSON)`, metadataText);
  }
  // Names that differ in case or in the form of a character are two names,
  // and one name in two objects is not repeated.
  const distinct = [
    ['{"a":1,"A":2}', '{"A":2,"a":1}'],
    [String.raw`{"\u00e9":1,"e\u0301":2}`, '{"e\u0301":2,"\u00e9":1}'],
    ['{"x":{"k":1},"y":{"k":1},"z":[{"k":1},{"k":2}]}', '{"x":{"k":1},"y":{"k":1},"z":[{"k":1},{"k":2}]}'],
    ['{"__proto__":{"k":1},"constructor":2}', '{"__proto__":{"k":1},"constructor":2}'],
  ];
  for (const [metadataText, canonicalMetadata] of distinct) passes(verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata }))));
});

test('step 2: nesting of 64 objects and arrays passes, and of 65 is rejected as METADATA_INVALID_JSON; whitespace RFC 8259 allows between tokens passes', { ...LIMIT }, () => {
  // The object at the top and `levels` - 1 objects and arrays inside it.
  const nested = (levels) => {
    let inner = '1';
    for (let i = 1; i < levels; i += 1) inner = i % 2 === 1 ? `[${inner}]` : `{"k":${inner}}`;
    return `{"n":${inner}}`;
  };
  assert.equal(nested(3), '{"n":{"k":[1]}}');
  const deep = nested(64);
  assert.equal(deep.split('').filter((c) => c === '{' || c === '[').length, 64);
  passes(verdictOn(stored(entriesOf(signer, { metadataText: deep, canonicalMetadata: deep }))));
  const nests = /^step 2: metadata\.json nests more than 64 objects and arrays \(METADATA_INVALID_JSON\)$/;
  for (const text of [nested(65), nested(66), nested(5000), `{"a":${'['.repeat(100000)}${']'.repeat(100000)}}`, `{"a":${'['.repeat(100000)}`]) {
    rejectsAt(verdictOn(stored(entriesOf(signer, { metadataText: text, canonicalMetadata: text }))), 2, nests);
  }
  // The four whitespace characters of RFC 8259 around every token.
  passes(verdictOn(stored(entriesOf(signer, { metadataText: ' \t\r\n{ \t\r\n"a" \t\r\n: \t\r\n[ \t\r\n1 \t\r\n, \t\r\n{ } \t\r\n] \t\r\n} \t\r\n', canonicalMetadata: '{"a":[1,{}]}' }))));
  // A byte order mark inside a string is a character of the string.
  passes(verdictOn(stored(entriesOf(signer, { metadataText: '{"s":"\ufeff"}', canonicalMetadata: '{"s":"\ufeff"}' }))));
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

test('step 3: metadata outside the profile\'s domain is rejected as METADATA_NOT_CANONICALIZABLE: an integer-valued number outside +/-(2^53 - 1), 1e300 among them, a number that is not finite, 1e400 among them, an unpaired surrogate in a value or in a name', { ...LIMIT }, () => {
  const outside = /^step 3: metadata\.json holds an integer-valued number outside \[-9007199254740991, 9007199254740991\], which the metadata profile does not canonicalize \(METADATA_NOT_CANONICALIZABLE\)$/;
  const notFinite = /^step 3: metadata\.json holds a number that is not finite, which the metadata profile does not canonicalize \(METADATA_NOT_CANONICALIZABLE\)$/;
  const surrogate = /^step 3: metadata\.json holds an unpaired surrogate, which the metadata profile does not canonicalize \(METADATA_NOT_CANONICALIZABLE\)$/;
  const cases = [
    ['{"n":9007199254740993}', outside],
    ['{"n":9007199254740992}', outside],
    ['{"n":-9007199254740992}', outside],
    ['{"a":{"b":[1,1e21]}}', outside],
    ['{"n":1e300}', outside],
    ['{"n":-1e300}', outside],
    ['{"n":1.5e300}', outside],
    // Its double is 2^53, a whole number: integer-valued, as the text defines it.
    ['{"n":9007199254740991.5}', outside],
    ['{"n":1e400}', notFinite],
    ['{"n":-1e400}', notFinite],
    ['{"a":[{"n":1E+999}]}', notFinite],
    [String.raw`{"s":"\ud800"}`, surrogate],
    [String.raw`{"s":"\ude00\ud83d"}`, surrogate],
    [String.raw`{"\udfff":1}`, surrogate],
    [String.raw`{"a":["ok",{"b":"x\udbff"}]}`, surrogate],
  ];
  for (const [metadataText, pattern] of cases) {
    // Whatever canonical.bin holds, the profile form or the early form.
    rejectsAt(verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata: metadataText }))), 3, pattern);
    rejectsAt(verdictOn(stored(entriesOf(signer, { metadataText, canonical: Buffer.from(RESPONSE) }))), 3, pattern);
  }
  // The largest safe integer on each side is inside the range; so is a
  // number whose double is whole inside it (2^52 + 0.5 is 2^52 as a
  // double), and a fraction of any size.
  const inside = [
    ['{"hi":9007199254740991,"lo":-9007199254740991}', '{"hi":9007199254740991,"lo":-9007199254740991}'],
    ['{"n":4503599627370496.5}', '{"n":4503599627370496}'],
    ['{"f":1.5e-300,"g":-0.5,"h":123456789.125}', '{"f":1.5e-300,"g":-0.5,"h":123456789.125}'],
  ];
  for (const [metadataText, canonicalMetadata] of inside) passes(verdictOn(stored(entriesOf(signer, { metadataText, canonicalMetadata }))));
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

test('step 5: the DER SubjectPublicKeyInfo in public_key.pem must equal the DER in the pin byte for byte; the whitespace around the block and the line layout inside it may differ, a pin of another key is rejected', { ...LIMIT }, () => {
  const bytes = stored(entriesOf(signer));
  passes(verdictOn(bytes, signer.pinFile));
  const differs = /^step 5: the DER SubjectPublicKeyInfo in public_key\.pem differs from the DER in the pin, the trusted signer key the caller supplied$/;
  rejectsAt(verdictOn(bytes, other.pinFile), 5, differs);

  // The same key in other PEM text: whitespace around the block, and lines
  // of any length, with LF, CR LF or CR, inside it.
  const body = bodyOf(signer.publicPem);
  const layouts = [
    `${signer.publicPem}\n`,
    `\r\n\t  ${BEGIN}\r\n${laidOut(body, 76, '\r\n')}\r\n${END}\r\n \t\n`,
    `${BEGIN}\n${body}\n${END}`,
    `${BEGIN}${body}${END}`,
    `${BEGIN}\r${laidOut(body, 1, '\r')}\r${END}\r`,
    `${BEGIN}\n\n${laidOut(body, 64, '\n\n')}\n\n${END}\n`,
    `\v\f ${signer.publicPem.toString('latin1').replaceAll('\n', '\r\n')}\f\v`,
  ];
  for (const text of layouts) {
    assert.notEqual(text, signer.publicPem.toString('latin1'));
    // As the pin, beside the PEM text node:crypto wrote in the package.
    passes(verdictOn(bytes, pinOf(text)));
    // As the package's public_key.pem, beside the pin node:crypto wrote.
    passes(verdictOn(stored(withEntry(entriesOf(signer), 'public_key.pem', text)), signer.pinFile));
  }
  // Both in another layout, each its own.
  passes(verdictOn(stored(withEntry(entriesOf(signer), 'public_key.pem', layouts[1])), pinOf(layouts[4])));

  // A package that carries its own key and a signature made with it is
  // consistent in itself, and is still not the pinned signer's.
  rejectsAt(verdictOn(stored(entriesOf(other)), signer.pinFile), 5, differs);
  rejectsAt(verdictOn(stored(entriesOf(other)), pinOf(layouts[1])), 5, differs);
  passes(verdictOn(stored(entriesOf(other)), other.pinFile));
  // A pin that is one block of other DER: the key cut short, the key with
  // a byte after it.
  const der = crypto.createPublicKey(signer.publicPem).export({ type: 'spki', format: 'der' });
  rejectsAt(verdictOn(bytes, pinOf(pemOf(der.subarray(0, der.length - 3)))), 5, differs);
  rejectsAt(verdictOn(bytes, pinOf(pemOf(Buffer.concat([der, Buffer.from([0])])))), 5, differs);
});

test('step 5: a pin that is not one PEM block labelled PUBLIC KEY matches no key: the package is rejected at step 5, and the command line does not stop on it', { ...LIMIT }, () => {
  const bytes = stored(entriesOf(signer));
  const pem = signer.publicPem.toString('latin1');
  const body = bodyOf(signer.publicPem);
  const noBlock = /^step 5: the pin, the trusted signer key the caller supplied, is not one PEM block labelled PUBLIC KEY, so it matches no key$/;
  const pins = [
    crypto.createPublicKey(signer.publicPem).export({ type: 'pkcs1', format: 'pem' }),
    crypto.createPublicKey(signer.publicPem).export({ type: 'spki', format: 'der' }),
    '',
    '\n',
    'not a key\n',
    `${pem}${pem}`,
    `${pem}${other.publicPem.toString('latin1')}`,
    `a line before the key\n${pem}`,
    `${pem}a line after the key\n`,
    `\ufeff${pem}`,
    `${BEGIN}\n${laidOut(body, 64, ' \n')}\n${END}\n`,
    `${BEGIN}\n\t${laidOut(body, 64, '\n\t')}\n${END}\n`,
    pem.replace('PUBLIC KEY', 'public key'),
    pem.replace(`${DASHES}END PUBLIC KEY`, `${DASHES}END RSA PUBLIC KEY`),
    pem.replace(BEGIN, `${DASHES}BEGIN  PUBLIC KEY${DASHES}`),
    `${BEGIN}\n${body.replaceAll('+', '-').replaceAll('/', '_')}x\n${END}\n`,
    `${BEGIN}\n${body.slice(0, -1)}\n${END}\n`,
    `${BEGIN}\n${body.slice(0, 40)}=${body.slice(41)}\n${END}\n`,
    `${BEGIN}\nHeader: value\n\n${body}\n${END}\n`,
  ];
  for (const text of pins) {
    const pin = pinOf(text);
    rejectsAt(verdictOn(bytes, pin), 5, noBlock);
  }
});

test('step 6: signature.sig must be base64 of an RSASSA-PKCS1-v1_5 SHA-256 signature over canonical.bin by the embedded key', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const canonical = entries.get('canonical.bin');
  const base64 = entries.get('signature.sig').toString('latin1');
  const fails = /^step 6: signature\.sig does not verify over canonical\.bin as RSASSA-PKCS1-v1_5 with SHA-256$/;
  const notBase64 = /^step 6: signature\.sig is not padded base64 in the standard alphabet once TAB, LF, VT, FF, CR and space are taken out$/;

  // TAB, LF, VT, FF, CR and space are ignored wherever they stand: around
  // the base64, between its lines, inside a line, between the padding.
  const accepted = [
    `${base64}\n`,
    `  ${base64}\r\n`,
    laidOut(base64, 64, '\n'),
    `${laidOut(base64, 76, '\r\n')}\r\n`,
    laidOut(base64, 1, '\r'),
    `${base64.slice(0, 100)} ${base64.slice(100)}`,
    base64.split('').join(' '),
    `\t${base64.slice(0, 10)}\v${base64.slice(10, 20)}\f${base64.slice(20, 30)}\r${base64.slice(30)}\n`,
    `${base64.slice(0, -1)} =`,
    `${base64.slice(0, -2)}\n=\n=\n`,
  ];
  for (const text of accepted) passes(verdictOn(stored(withEntry(entries, 'signature.sig', text))));

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
  // The same number in one octet more (RFC 8017 section 8.2.2 asks for k
  // octets), and a zero octet after it.
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', Buffer.concat([Buffer.from([0]), Buffer.from(base64, 'base64')]).toString('base64')))), 6, fails);
  rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', Buffer.concat([Buffer.from(base64, 'base64'), Buffer.from([0])]).toString('base64')))), 6, fails);

  // What is not padded base64 in the standard alphabet once the six bytes
  // are out: other characters, other whitespace, no padding, padding in
  // the middle or too much of it, the URL alphabet, the raw bytes, and pad
  // bits that are not zero (RFC 4648 section 3.5).
  assert.match(base64, /^[A-Za-z0-9+/]{342}==$/);
  const urlForm = Buffer.from(base64, 'base64').toString('base64url');
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padBits = `${base64.slice(0, 341)}${ALPHABET[ALPHABET.indexOf(base64[341]) | 1]}==`;
  assert.ok(Buffer.from(padBits, 'base64').equals(Buffer.from(base64, 'base64')), 'the pad bits change no byte');
  const rejected = [
    'not base64 !!',
    base64.slice(0, -2),
    `${base64}=`,
    `${base64}==`,
    `${base64.slice(0, -2)}===`,
    `${base64.slice(0, 100)}=${base64.slice(100)}`,
    `${urlForm}~~`,
    `${base64.slice(0, 100)}-_${base64.slice(102)}`,
    `${base64.slice(0, 100)}\u00a0${base64.slice(100)}`,
    `${base64.slice(0, 100)}\u0000${base64.slice(100)}`,
    `${base64.slice(0, 100)}\u001c${base64.slice(100)}`,
    `${base64.slice(0, 100)}\u0085${base64.slice(100)}`,
    `\ufeff${base64}`,
    padBits,
    `${padBits}\n`,
  ];
  for (const text of rejected) rejectsAt(verdictOn(stored(withEntry(entries, 'signature.sig', text))), 6, notBase64);
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

test('step 5: public_key.pem must be one PEM block labelled PUBLIC KEY whose body is the DER SubjectPublicKeyInfo of an RSA key and the encoding of that key, or the package is rejected as RSA_VERIFY_ERROR, also when the pin holds the same text', { ...LIMIT }, () => {
  const entries = entriesOf(signer);
  const pem = signer.publicPem.toString('latin1');
  const body = bodyOf(signer.publicPem);
  const publicKey = crypto.createPublicKey(signer.publicPem);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const notBlock = /^step 5: public_key\.pem is not one PEM block labelled PUBLIC KEY as the format's entry table gives it \(RSA_VERIFY_ERROR\)$/;
  const notRsa = /^step 5: the body of public_key\.pem is not the DER SubjectPublicKeyInfo of an RSA key \(RSA_VERIFY_ERROR\)$/;
  const notItsEncoding = /^step 5: the DER in public_key\.pem is not the encoding of the RSA key it holds \(RSA_VERIFY_ERROR\)$/;

  // The same key as node:crypto reads it, in DER that is not the encoding
  // of that key: a byte after the SubjectPublicKeyInfo, the NULL parameters
  // of the algorithm left out, a length written in more octets than it needs.
  assert.equal(der.subarray(0, 24).toString('hex'), '30820122300d06092a864886f70d01010105000382010f00');
  const withoutNull = Buffer.concat([Buffer.from('30820120300b', 'hex'), der.subarray(6, 17), der.subarray(19)]);
  const longLength = Buffer.concat([Buffer.from('308300', 'hex'), der.subarray(2)]);
  for (const bytes of [Buffer.concat([der, Buffer.from([0])]), Buffer.concat([der, Buffer.from('more')]), withoutNull, longLength]) {
    assert.equal(crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' }).asymmetricKeyType, 'rsa', 'node:crypto reads the key');
  }
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pss = crypto.generateKeyPairSync('rsa-pss', { modulusLength: 2048 });
  const cases = [
    [publicKey.export({ type: 'pkcs1', format: 'pem' }), notBlock],
    [der, notBlock],
    [`${pem}${pem}`, notBlock],
    [`${pem}${other.publicPem.toString('latin1')}`, notBlock],
    [`a line before the key\n${pem}`, notBlock],
    [`${pem}a line after the key\n`, notBlock],
    ['not a key\n', notBlock],
    ['', notBlock],
    [`${BEGIN}\n${laidOut(body, 64, ' \n')}\n${END}\n`, notBlock],
    [`${BEGIN}\n  ${laidOut(body, 64, '\n  ')}\n${END}\n`, notBlock],
    [pem.replace('PUBLIC KEY', 'public key'), notBlock],
    [pem.replace(`${DASHES}END PUBLIC KEY`, `${DASHES}END RSA PUBLIC KEY`), notBlock],
    [`${BEGIN}\n${body.slice(0, -1)}\n${END}\n`, notBlock],
    [`${BEGIN}\n${body.slice(0, 40)}=${body.slice(41)}\n${END}\n`, notBlock],
    [`${BEGIN}\n${body.slice(0, 100)}-_${body.slice(102)}\n${END}\n`, notBlock],
    [ec.publicKey.export({ type: 'spki', format: 'pem' }), notRsa],
    [pss.publicKey.export({ type: 'spki', format: 'pem' }), notRsa],
    [pemOf(Buffer.from('not the DER of a key')), notRsa],
    [pemOf(der.subarray(0, der.length - 3)), notRsa],
    [pemOf(Buffer.concat([der, Buffer.from([0])])), notItsEncoding],
    [pemOf(Buffer.concat([der, Buffer.from('more')])), notItsEncoding],
    [pemOf(withoutNull), notItsEncoding],
    [pemOf(longLength), notItsEncoding],
  ];
  for (const [text, pattern] of cases) {
    // The pin holds the same text, so under a rule that compares text the
    // pin would match; step 5 reads the key before it looks at the pin.
    rejectsAt(verdictOn(stored(withEntry(entries, 'public_key.pem', text)), pinOf(text)), 5, pattern);
  }
  // The same rejection with the pin node:crypto wrote.
  rejectsAt(verdictOn(stored(withEntry(entries, 'public_key.pem', pemOf(withoutNull)))), 5, notItsEncoding);
});

test('step 5: base64 in public_key.pem whose pad bits are not zero is not the block the entry table gives (RSA_VERIFY_ERROR); the same key with zero pad bits passes', { ...LIMIT }, () => {
  // The DER of a 3072-bit key is not a multiple of three bytes long, so its
  // base64 ends in padding, and the last character before it holds pad bits.
  const wide = makeSigner(3072);
  const entries = entriesOf(wide);
  passes(verdictOn(stored(entries), wide.pinFile));
  const body = bodyOf(wide.publicPem);
  assert.match(body, /[^=]=$/);
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const at = body.length - 2;
  const padBits = `${body.slice(0, at)}${ALPHABET[ALPHABET.indexOf(body[at]) | 1]}=`;
  assert.ok(Buffer.from(padBits, 'base64').equals(Buffer.from(body, 'base64')), 'the pad bits change no byte');
  const text = `${BEGIN}\n${laidOut(padBits, 64, '\n')}\n${END}\n`;
  rejectsAt(verdictOn(stored(withEntry(entries, 'public_key.pem', text)), pinOf(text)), 5, /^step 5: public_key\.pem is not one PEM block labelled PUBLIC KEY as the format's entry table gives it \(RSA_VERIFY_ERROR\)$/);
  // As the pin, the same text matches no key.
  rejectsAt(verdictOn(stored(entries), pinOf(text)), 5, /^step 5: the pin, the trusted signer key the caller supplied, is not one PEM block labelled PUBLIC KEY, so it matches no key$/);
});

test('step 6: the signature is verified with the key step 5 read, in whatever layout public_key.pem holds it', { ...LIMIT }, () => {
  const text = `\n${BEGIN}${bodyOf(signer.publicPem)}${END}\n`;
  const entries = withEntry(entriesOf(signer), 'public_key.pem', text);
  passes(verdictOn(stored(entries), signer.pinFile));
  // A signature of another key over the same bytes does not verify with it.
  const otherSignature = other.sign(entries.get('canonical.bin')).toString('base64');
  const ran = verdictOn(stored(withEntry(entries, 'signature.sig', otherSignature)), signer.pinFile);
  rejectsAt(ran, 6, /^step 6: signature\.sig does not verify over canonical\.bin as RSASSA-PKCS1-v1_5 with SHA-256$/);
  assert.deepEqual(ran.answer.notes, ['step 6: signature.sig does not verify over canonical.bin as RSASSA-PKCS1-v1_5 with SHA-256', NOT_RUN]);
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
