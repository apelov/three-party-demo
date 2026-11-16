// The record writer, checked by reading each package back with
// /usr/bin/unzip, by node:crypto's own verify, and against bytes built in
// this file from RFC 8785 without the code under test. No verifier is in
// this build, so no test here reads a verifier's answer.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalize } from '../src/record/jcs.mjs';
import { deletionLine, generateTestKey, liveTestKey, pinFileOf, PUBLIC_KEY_FILE, TEST_KEY_LINE, TEST_KEY_NOTE_FILE } from '../src/record/testkey.mjs';
import { CHANGED, ENTRY_NAMES, FORMAT, MANIFEST_FILE, PROFILE, TIMESTAMP_ENTRY, TIMESTAMP_STAND_IN, WRITER, writeRecord, writeRun } from '../src/record/writer.mjs';
import { storeZip } from '../src/record/zip.mjs';
import {
  BODIES, EXAMPLE_ACTION, filesUnder, INTENT_ACTION, listEntries, makeRun, PAY_ACTION, privateKeyFilesUnder, readEntry, readJson, removeTempDirs, sha256,
  THREE_PARTY,
} from './record-support.mjs';

after(removeTempDirs);

const SEVEN = ['response.txt', 'canonical.bin', 'hash.sha256', 'signature.sig', 'public_key.pem', 'metadata.json', 'timestamp.tsr'];
const PKCS1 = crypto.constants.RSA_PKCS1_PADDING;
const noteLines = (runDir) => fs.readFileSync(path.join(runDir, TEST_KEY_NOTE_FILE), 'utf8').split('\n');

// The canonical text of a record's metadata, built here from RFC 8785 with
// no call to the code under test and none to JSON.stringify: the members
// sorted by UTF-16 code unit, a string escaped by the rules of section
// 3.2.2.2, an integer as its digits.
function escaped(text) {
  const short = new Map([[0x08, '\\b'], [0x09, '\\t'], [0x0a, '\\n'], [0x0c, '\\f'], [0x0d, '\\r'], [0x22, '\\"'], [0x5c, '\\\\']]);
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (short.has(unit)) out += short.get(unit);
    else if (unit < 0x20) out += `\\u${unit.toString(16).padStart(4, '0')}`;
    else out += text[i];
  }
  return `${out}"`;
}
function expectedMetadata(action) {
  const members = {
    profile: 'opena2a-three-party-demo/1',
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
    writer: 'OpenA2A writer, AEP format',
    timestamp_entry: 'stand-in: no timestamp authority',
  };
  const names = Object.keys(members).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = names.map((name) => `${escaped(name)}:${typeof members[name] === 'number' ? String(members[name]) : escaped(members[name])}`);
  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

// What one record holds, read back by unzip, and whether node:crypto
// verifies its signature over canonical.bin with the key it embeds.
function readRecord(file) {
  const entry = (name) => readEntry(file, name);
  const canonical = entry('canonical.bin');
  const signature = Buffer.from(entry('signature.sig').toString('ascii'), 'base64');
  return {
    response: entry('response.txt'),
    canonical,
    metadata: entry('metadata.json'),
    signature,
    verifies: crypto.verify('sha256', canonical, { key: crypto.createPublicKey(entry('public_key.pem')), padding: PKCS1 }, signature),
  };
}

// One run, written once, read by the tests below.
let run = null;
let written = null;
let writtenFrom = 0;
let writtenBy = 0;
const record = (name) => path.join(run.runDir, 'records', name);
before(() => {
  run = makeRun();
  writtenFrom = Date.now();
  written = writeRun(run.runDir);
  writtenBy = Date.now();
});

test('the entry names are the seven rows the format marks required, in the order of its entry table', () => {
  assert.deepEqual([...ENTRY_NAMES], SEVEN);
  assert.equal(Object.isFrozen(ENTRY_NAMES), true);
});

test('unzip -l lists exactly the seven required entries in each package, and no other entry', () => {
  assert.deepEqual(written.records.map((r) => r.file), ['records/04-intent.aep', 'records/05-pay.aep']);
  for (const file of ['04-intent.aep', '05-pay.aep', 'tampered/05-pay.aep']) {
    assert.deepEqual(listEntries(record(file)).map((entry) => entry.name), SEVEN, file);
  }
});

test('response.txt is the exact bytes of the action\'s body file, and canonical.bin is response.txt || LF || metadata.json', () => {
  for (const [file, body] of [['04-intent.aep', BODIES.intent], ['05-pay.aep', BODIES.pay]]) {
    const response = readEntry(record(file), 'response.txt');
    assert.ok(response.equals(Buffer.from(body, 'utf8')), `${file}: response.txt`);
    const stem = file.replace('.aep', '');
    assert.ok(response.equals(fs.readFileSync(path.join(run.runDir, 'actions', `${stem}.response.txt`))), `${file}: the body file`);
    const expected = Buffer.concat([response, Buffer.from([0x0a]), readEntry(record(file), 'metadata.json')]);
    assert.ok(readEntry(record(file), 'canonical.bin').equals(expected), `${file}: canonical.bin`);
  }
});

test('hash.sha256 is the lowercase hex of SHA-256(canonical.bin): 64 bytes, no line feed after it', () => {
  for (const file of ['04-intent.aep', '05-pay.aep']) {
    const hash = readEntry(record(file), 'hash.sha256');
    assert.equal(hash.length, 64, file);
    assert.equal(hash.toString('ascii'), sha256(readEntry(record(file), 'canonical.bin')), file);
    assert.match(hash.toString('ascii'), /^[0-9a-f]{64}$/, file);
  }
});

test('metadata.json is the JCS bytes of the contract\'s metadata: serializing its parse again gives the same bytes, and the pay record reads as written out here', () => {
  for (const file of ['04-intent.aep', '05-pay.aep']) {
    const bytes = readEntry(record(file), 'metadata.json');
    assert.ok(canonicalize(JSON.parse(bytes.toString('utf8'))).equals(bytes), file);
  }
  // The pay record's metadata, member by member in sorted order, by hand.
  const a = EXAMPLE_ACTION;
  const want = `{"actor_did":"${a.actor.did}","at":"${a.at}","credential_sha256":"${a.actor.credentialSha256}","decision":"allowed","domain_from":"payments.acme-demo.test","domain_to":"bank.example.test","kind":"clean","profile":"opena2a-three-party-demo/1","reason":"${a.reason}","runId":"${run.runId}","seq":5,"step":"pay","timestamp_entry":"stand-in: no timestamp authority","writer":"OpenA2A writer, AEP format"}`;
  assert.equal(readEntry(record('05-pay.aep'), 'metadata.json').toString('utf8'), want);
  assert.equal(PROFILE, 'opena2a-three-party-demo/1');
  assert.equal(WRITER, 'OpenA2A writer, AEP format');
  assert.equal(TIMESTAMP_ENTRY, 'stand-in: no timestamp authority');
  // CONTRACT.md section 5 names the same fourteen members and the writer value.
  const contract = fs.readFileSync(path.join(THREE_PARTY, 'CONTRACT.md'), 'utf8');
  for (const name of Object.keys(JSON.parse(want))) assert.ok(contract.includes(`\`${name}\``), name);
  assert.equal(Object.keys(JSON.parse(want)).length, 14);
  assert.ok(contract.includes('`writer` (`OpenA2A writer, AEP format`)'));
});

test('signature.sig is base64 with no line feed, and crypto.verify accepts it over canonical.bin with the run\'s public key, which is public_key.pem', () => {
  const publicFile = fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE));
  for (const file of ['04-intent.aep', '05-pay.aep']) {
    const text = readEntry(record(file), 'signature.sig').toString('ascii');
    assert.match(text, /^[A-Za-z0-9+/]+={0,2}$/, file);
    const signature = Buffer.from(text, 'base64');
    assert.equal(signature.length, 256, `${file}: an RSA 2048 signature`);
    assert.equal(signature.toString('base64'), text, `${file}: canonical base64`);
    const canonical = readEntry(record(file), 'canonical.bin');
    const embedded = readEntry(record(file), 'public_key.pem');
    assert.ok(embedded.equals(publicFile), `${file}: public_key.pem is the run's public key file`);
    assert.equal(crypto.verify('sha256', canonical, crypto.createPublicKey(embedded), signature), true, file);
    assert.equal(crypto.verify('sha256', canonical, { key: crypto.createPublicKey(embedded), padding: PKCS1 }, signature), true, `${file}: PKCS#1 v1.5`);
    // The padded block ends with the DigestInfo of RFC 8017 section 9.2 for
    // SHA-256, the form with NULL parameters, then the digest.
    const block = crypto.publicDecrypt({ key: crypto.createPublicKey(embedded), padding: crypto.constants.RSA_NO_PADDING }, signature);
    const digestInfo = Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), crypto.createHash('sha256').update(canonical).digest()]);
    assert.ok(block.subarray(block.length - digestInfo.length).equals(digestInfo), `${file}: DigestInfo with NULL parameters`);
    assert.equal(block[0], 0x00);
    assert.equal(block[1], 0x01);
    assert.ok(block.subarray(2, block.length - digestInfo.length - 1).every((byte) => byte === 0xff), `${file}: full-length padding`);
  }
});

test('timestamp.tsr is the base64 of the stand-in sentence, and says it is a stand-in', () => {
  const text = readEntry(record('05-pay.aep'), 'timestamp.tsr').toString('ascii');
  assert.equal(Buffer.from(text, 'base64').toString('ascii'), 'stand-in: no timestamp authority in this demo');
  assert.equal(TIMESTAMP_STAND_IN, 'stand-in: no timestamp authority in this demo');
  assert.doesNotMatch(text, /\s/);
});

test('the tampered copy differs from the pay record in one byte of response.txt and in nothing else', () => {
  assert.deepEqual(written.tampered.map((t) => ({ file: t.file, changed: t.changed })), [{ file: 'records/tampered/05-pay.aep', changed: 'one byte of response.txt' }]);
  assert.equal(CHANGED, 'one byte of response.txt');
  for (const name of SEVEN.filter((entry) => entry !== 'response.txt')) {
    assert.ok(readEntry(record('tampered/05-pay.aep'), name).equals(readEntry(record('05-pay.aep'), name)), `${name} is unchanged`);
  }
  const original = readEntry(record('05-pay.aep'), 'response.txt');
  const changed = readEntry(record('tampered/05-pay.aep'), 'response.txt');
  assert.equal(changed.length, original.length);
  const differing = [];
  for (let i = 0; i < original.length; i += 1) if (original[i] !== changed[i]) differing.push(i);
  assert.deepEqual(differing, [0], 'one byte differs, byte 0');
  assert.equal(original[0] ^ changed[0], 0x01, 'by one bit');
  // The copy's canonical.bin still starts with the bytes as they were, so
  // it is no longer response.txt || LF || metadata.json.
  const canonical = readEntry(record('tampered/05-pay.aep'), 'canonical.bin');
  assert.equal(canonical.equals(Buffer.concat([changed, Buffer.from([0x0a]), readEntry(record('tampered/05-pay.aep'), 'metadata.json')])), false);
  // The whole files differ in that one byte too: same length, one position.
  const whole = fs.readFileSync(record('05-pay.aep'));
  const wholeCopy = fs.readFileSync(record('tampered/05-pay.aep'));
  assert.equal(wholeCopy.length, whole.length);
  let positions = 0;
  for (let i = 0; i < whole.length; i += 1) if (whole[i] !== wholeCopy[i]) positions += 1;
  // The changed byte, and the four bytes of its CRC-32 in the local header and in the central directory.
  assert.ok(positions >= 3 && positions <= 9, String(positions));
});

test('each run has its own key: a record of another run embeds another public key, and its signature does not verify under this run\'s key or pin', () => {
  const other = makeRun();
  writeRun(other.runDir);
  const theirs = path.join(other.runDir, 'records', '05-pay.aep');
  const mine = fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE));
  const pin = fs.readFileSync(pinFileOf(run.runDir));
  const embedded = readEntry(theirs, 'public_key.pem');
  assert.equal(embedded.equals(mine), false, 'another run embeds another key');
  assert.equal(embedded.equals(pin), false, 'which is not this run\'s pin');
  const canonical = readEntry(theirs, 'canonical.bin');
  const signature = Buffer.from(readEntry(theirs, 'signature.sig').toString('ascii'), 'base64');
  // The two runs hold the same actions, so the signed bytes are the same and the key alone differs.
  assert.ok(canonical.equals(readEntry(record('05-pay.aep'), 'canonical.bin')));
  assert.equal(crypto.verify('sha256', canonical, { key: crypto.createPublicKey(embedded), padding: PKCS1 }, signature), true);
  assert.equal(crypto.verify('sha256', canonical, { key: crypto.createPublicKey(mine), padding: PKCS1 }, signature), false);
  assert.equal(crypto.verify('sha256', canonical, { key: crypto.createPublicKey(pin), padding: PKCS1 }, signature), false);
});

test('the manifest names the run, the format, the signer key and its hash, the credential, each record with its action, and the tampered copy', () => {
  const manifest = readJson(path.join(run.runDir, MANIFEST_FILE));
  const example = readJson(path.join(THREE_PARTY, 'examples', 'manifest.json'));
  assert.deepEqual(Object.keys(manifest), ['runId', 'format', 'signerPublicKey', 'signerSha256', 'credentialSha256', 'records', 'tampered']);
  assert.deepEqual(Object.keys(manifest), Object.keys(example), 'the members of the example manifest, in its order');
  assert.equal(manifest.runId, run.runId);
  // The format value is the example's, which is the one CONTRACT.md section 4 gives.
  assert.equal(manifest.format, example.format);
  assert.equal(FORMAT, manifest.format);
  assert.ok(fs.readFileSync(path.join(THREE_PARTY, 'CONTRACT.md'), 'utf8').includes(`\`format\` (\`${FORMAT}\`)`));
  assert.equal(manifest.signerPublicKey, 'keys/test-signer.pub.pem');
  assert.equal(manifest.signerSha256, sha256(fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE))));
  assert.equal(manifest.signerSha256, sha256(fs.readFileSync(pinFileOf(run.runDir))), 'the pin holds the same key');
  assert.equal(manifest.credentialSha256, EXAMPLE_ACTION.actor.credentialSha256);
  assert.deepEqual(manifest.records, [
    { file: 'records/04-intent.aep', sha256: sha256(fs.readFileSync(record('04-intent.aep'))), action: 'actions/04-intent.action.json' },
    { file: 'records/05-pay.aep', sha256: sha256(fs.readFileSync(record('05-pay.aep'))), action: 'actions/05-pay.action.json' },
  ]);
  assert.deepEqual(manifest.tampered, [{ file: 'records/tampered/05-pay.aep', sha256: sha256(fs.readFileSync(record('tampered/05-pay.aep'))), changed: 'one byte of response.txt' }]);
  assert.deepEqual(Object.keys(written), ['manifest', 'runId', 'records', 'tampered', 'signerSha256', 'privateKeyDeletedAt']);
  assert.deepEqual(written, {
    manifest: 'records/manifest.json',
    runId: run.runId,
    records: manifest.records,
    tampered: manifest.tampered,
    signerSha256: manifest.signerSha256,
    privateKeyDeletedAt: /^Private key deleted at (\S+) after the last record was signed\.$/.exec(noteLines(run.runDir)[1])[1],
  });
  // Nothing partial is left beside the files.
  const leftovers = filesUnder(path.dirname(run.runDir)).filter((name) => name.includes('.partial-'));
  assert.deepEqual(leftovers, []);
});

test('after the last record is signed the private key is deleted: no file of the run or of its pin directory is a private key, and TEST-KEY.txt carries the deletion line', () => {
  const root = path.dirname(run.runDir);
  assert.deepEqual(filesUnder(root), [
    `.pins/${run.runId}.pub.pem`,
    `${run.runId}/actions/04-intent.action.json`,
    `${run.runId}/actions/04-intent.response.txt`,
    `${run.runId}/actions/05-pay.action.json`,
    `${run.runId}/actions/05-pay.response.txt`,
    `${run.runId}/keys/TEST-KEY.txt`,
    `${run.runId}/keys/test-signer.pub.pem`,
    `${run.runId}/records/04-intent.aep`,
    `${run.runId}/records/05-pay.aep`,
    `${run.runId}/records/manifest.json`,
    `${run.runId}/records/tampered/05-pay.aep`,
  ]);
  assert.deepEqual(privateKeyFilesUnder(root), []);
  assert.equal(liveTestKey(run.runDir), null);
  const lines = noteLines(run.runDir);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Test key generated for this demo run; not a key in use anywhere.');
  assert.equal(lines[0], TEST_KEY_LINE);
  const match = /^Private key deleted at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) after the last record was signed\.$/.exec(lines[1]);
  assert.notEqual(match, null, 'the second line is the deletion line');
  assert.equal(lines[2], '');
  const at = Date.parse(match[1]);
  assert.ok(at >= writtenFrom - 1000 && at <= writtenBy, 'the time is when this run was written');
  // The line is written before a record file is: the key was gone by then.
  for (const file of ['04-intent.aep', '05-pay.aep', 'manifest.json']) {
    assert.ok(fs.statSync(path.join(run.runDir, TEST_KEY_NOTE_FILE)).mtimeMs <= fs.statSync(record(file)).mtimeMs, file);
  }
});

test('writeRecord with the run\'s live key writes the package writeRun then writes again, byte for byte; a run is written once, and after it the key signs nothing', () => {
  const again = makeRun();
  const keys = generateTestKey(again.runDir);
  assert.equal(liveTestKey(again.runDir), keys);
  const single = writeRecord(again.runDir, 'actions/05-pay.action.json', keys);
  assert.deepEqual(Object.keys(single), ['file', 'sha256']);
  assert.equal(single.file, 'records/05-pay.aep');
  assert.equal(single.sha256, sha256(fs.readFileSync(path.join(again.runDir, 'records', '05-pay.aep'))));
  // An absolute path to the same action file is the same request.
  assert.deepEqual(writeRecord(again.runDir, path.join(again.runDir, 'actions', '05-pay.action.json'), keys), single);
  assert.equal(keys.deletedAt, null, 'writeRecord leaves the key live');
  assert.deepEqual(noteLines(again.runDir), [TEST_KEY_LINE, '']);

  // writeRun takes the live key of this run directory without being handed it.
  const out = writeRun(again.runDir);
  assert.deepEqual(out.records.map((r) => r.file), ['records/04-intent.aep', 'records/05-pay.aep']);
  assert.equal(out.records[1].sha256, single.sha256);
  assert.notEqual(keys.deletedAt, null);
  assert.equal(liveTestKey(again.runDir), null);
  assert.deepEqual(noteLines(again.runDir), [TEST_KEY_LINE, deletionLine(keys.deletedAt), '']);
  assert.equal(readJson(path.join(again.runDir, MANIFEST_FILE)).signerSha256, keys.signerSha256);

  // The key is deleted, so nothing more is signed for this run.
  const before = filesUnder(again.runDir).map((file) => `${file} ${sha256(fs.readFileSync(path.join(again.runDir, file)))}`);
  assert.throws(() => keys.sign(Buffer.from('more')), /the private key of this run is deleted/);
  assert.throws(() => writeRecord(again.runDir, 'actions/05-pay.action.json', keys), /the private key of this run is deleted; a new run gets a new key/);
  assert.throws(() => writeRun(again.runDir, keys), /the private key of this run is deleted; a new run gets a new key/);
  assert.throws(() => writeRun(again.runDir), /this run already has a test key \(keys\/test-signer\.pub\.pem\); a run has one key, and a new run gets a new key/);
  assert.deepEqual(filesUnder(again.runDir).map((file) => `${file} ${sha256(fs.readFileSync(path.join(again.runDir, file)))}`), before, 'the refused calls changed no file');
});

test('writeRun with the handle given writes the same run, and deletes that handle\'s key', () => {
  const given = makeRun();
  const keys = generateTestKey(given.runDir);
  const out = writeRun(given.runDir, keys);
  assert.equal(out.records.length, 2);
  assert.notEqual(keys.deletedAt, null);
  assert.deepEqual(noteLines(given.runDir), [TEST_KEY_LINE, deletionLine(keys.deletedAt), '']);
  for (const { file } of out.records) assert.equal(readRecord(path.join(given.runDir, file)).verifies, true, file);
});

test('a run with no pay action gets its tampered copy from the last record; one whose last response is empty, from the last record that has a byte', () => {
  const blocked = makeRun({ kind: 'poisoned', actions: [{ seq: 1, step: 'credential', body: '{"valid":true}\n' }, { ...INTENT_ACTION, over: { ...INTENT_ACTION.over, kind: 'poisoned', decision: 'blocked' } }] });
  const out = writeRun(blocked.runDir);
  assert.deepEqual(out.tampered.map((t) => t.file), ['records/tampered/04-intent.aep']);
  assert.equal(out.runId, 'poisoned-20261115T120000Z');

  const emptyLast = makeRun({ actions: [INTENT_ACTION, { seq: 6, step: 'notify', body: '' }] });
  assert.deepEqual(writeRun(emptyLast.runDir).tampered.map((t) => t.file), ['records/tampered/04-intent.aep']);
  assert.equal(readEntry(path.join(emptyLast.runDir, 'records', '06-notify.aep'), 'response.txt').length, 0);

  // A run the writer refuses before it needs a key gets no key, no pin, no record and no manifest.
  const allEmpty = makeRun({ actions: [{ seq: 1, step: 'credential', body: '' }] });
  assert.throws(() => writeRun(allEmpty.runDir), /every response\.txt is empty/);
  assert.deepEqual(filesUnder(path.dirname(allEmpty.runDir)), [`${allEmpty.runId}/actions/01-credential.action.json`, `${allEmpty.runId}/actions/01-credential.response.txt`]);
});

test('strings that need escaping, and characters outside ASCII, in the metadata: metadata.json is the bytes RFC 8785 gives, built here by hand, and the signature verifies', () => {
  const chr = (...codePoints) => String.fromCodePoint(...codePoints);
  const reason = `quote " backslash \\ tab \t line\nfeed control ${chr(0x0f)} delete ${chr(0x7f)} e-acute ${chr(0xe9)} euro ${chr(0x20ac)} separator ${chr(0x2028)} face ${chr(0x1f600)} end`;
  const odd = makeRun({ actions: [{ ...PAY_ACTION, over: { ...PAY_ACTION.over, reason } }] });
  writeRun(odd.runDir);
  const read = readRecord(path.join(odd.runDir, 'records', '05-pay.aep'));
  assert.equal(JSON.parse(read.metadata.toString('utf8')).reason, reason);
  const action = readJson(path.join(odd.runDir, 'actions', '05-pay.action.json'));
  assert.ok(read.metadata.equals(expectedMetadata(action)), 'metadata.json is the bytes built by hand');
  // The escapes, spelled out: the two-character forms, the lowercase unicode escape, and every other character as itself.
  const text = read.metadata.toString('utf8');
  assert.ok(text.includes(`quote \\" backslash \\\\ tab \\t line\\nfeed control \\u000f delete ${chr(0x7f)} e-acute ${chr(0xe9)} euro ${chr(0x20ac)} separator ${chr(0x2028)} face ${chr(0x1f600)} end`));
  assert.ok(read.canonical.equals(Buffer.concat([read.response, Buffer.from([0x0a]), read.metadata])));
  assert.equal(read.verifies, true);
});

test('ninety-nine records whose reasons are drawn, from a fixed seed, from every range of code points: each metadata.json is the bytes built here by hand, and each signature verifies', () => {
  // A small generator with a fixed seed, so the strings are the same on every run.
  let a = 20261115;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  // Controls, printable ASCII, DEL and the C1 controls, two-byte and
  // three-byte UTF-8 on each side of the surrogates, and the astral planes.
  const ranges = [[0x00, 0x1f], [0x20, 0x7e], [0x7f, 0xa0], [0xa1, 0x7ff], [0x800, 0xd7ff], [0xe000, 0xffff], [0x10000, 0x10ffff]];
  const pick = () => {
    const [low, high] = ranges[next() % ranges.length];
    return String.fromCodePoint(low + (next() % (high - low + 1)));
  };
  // The reason at index 0 holds the code points at the edges of each escaping rule.
  const edges = [0x00, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x22, 0x2f, 0x5c, 0x7f, 0x80, 0x9f, 0xa0, 0x2028, 0x2029, 0xd7ff, 0xe000, 0xfeff, 0xfffd, 0xfffe, 0xffff, 0x10000, 0x1f600, 0x10ffff];
  const reasons = [edges.map((codePoint) => String.fromCodePoint(codePoint)).join('|')];
  while (reasons.length < 99) reasons.push(Array.from({ length: 1 + (next() % 48) }, pick).join(''));

  const many = makeRun({ actions: reasons.map((reason, i) => ({ seq: i + 1, step: 'intent', body: `{"n":${i + 1}}\n`, over: { reason, toolCall: null } })) });
  const out = writeRun(many.runDir);
  assert.equal(out.records.length, 99);
  const wrong = [];
  for (const [i, { file }] of out.records.entries()) {
    const read = readRecord(path.join(many.runDir, file));
    const action = readJson(path.join(many.runDir, 'actions', `${String(i + 1).padStart(2, '0')}-intent.action.json`));
    if (action.reason !== reasons[i]) wrong.push(`${file}: the action file's reason`);
    if (!read.metadata.equals(expectedMetadata(action))) wrong.push(`${file}: metadata.json`);
    if (!read.canonical.equals(Buffer.concat([read.response, Buffer.from([0x0a]), read.metadata]))) wrong.push(`${file}: canonical.bin`);
    if (!read.verifies) wrong.push(`${file}: the signature`);
  }
  assert.deepEqual(wrong, []);
  // Each reason went into its record as it was given.
  for (const i of [0, 1, 49, 98]) {
    const metadata = JSON.parse(readEntry(path.join(many.runDir, out.records[i].file), 'metadata.json').toString('utf8'));
    assert.ok(metadata.reason === reasons[i], `the reason of record ${i + 1}`);
    assert.equal(metadata.seq, i + 1);
  }
});

test('the writer refuses an action it cannot record faithfully: a body that is not the bytes its hash names, a body file with a path, a file outside actions/, a missing member, a seq or step that is not the file name\'s, a time that is not RFC 3339', () => {
  const bad = makeRun({ actions: [PAY_ACTION] });
  const keys = generateTestKey(bad.runDir);
  const actionFile = path.join(bad.runDir, 'actions', '05-pay.action.json');
  const good = readJson(actionFile);
  const withAction = (change) => {
    const action = structuredClone(good);
    change(action);
    fs.writeFileSync(actionFile, JSON.stringify(action));
  };
  const refuses = (pattern) => assert.throws(() => writeRecord(bad.runDir, 'actions/05-pay.action.json', keys), pattern);

  withAction((a) => { a.response.bodySha256 = sha256(Buffer.from('other bytes')); });
  refuses(/is not the bytes response\.bodySha256 names/);
  withAction((a) => { a.response.bodyFile = '../actions/05-pay.response.txt'; });
  refuses(/response\.bodyFile is not a file name beside the action file/);
  withAction((a) => { a.response.bodyFile = 'absent.response.txt'; });
  refuses(/the body file absent\.response\.txt cannot be read: ENOENT/);
  withAction((a) => { delete a.actor.credentialSha256; });
  refuses(/actor\.credentialSha256 is not 64 lowercase hex characters/);
  withAction((a) => { delete a.reason; });
  refuses(/reason is not a string/);
  withAction((a) => { a.seq = '5'; });
  refuses(/seq is not an integer from 1 up/);
  // The file name and the signed metadata must name the same action.
  withAction((a) => { a.seq = 4; });
  refuses(/actions\/05-pay\.action\.json: seq is 4, and the file name says 05/);
  withAction((a) => { a.step = 'intent'; });
  refuses(/actions\/05-pay\.action\.json: step is "intent", and the file name says pay/);
  withAction((a) => { a.at = 'yesterday'; });
  refuses(/at is not an RFC 3339 time/);
  fs.writeFileSync(actionFile, '{not json');
  refuses(/not readable as JSON/);
  withAction(() => {});

  assert.throws(() => writeRecord(bad.runDir, '../elsewhere/05-pay.action.json', keys), /not an action file of this run/);
  assert.throws(() => writeRecord(bad.runDir, 'actions/pay.json', keys), /not an action file of this run/);
  assert.equal(fs.existsSync(path.join(bad.runDir, 'records')), false, 'no record was written by a refused call');
  assert.equal(keys.deletedAt, null, 'a refused writeRecord leaves the key to its caller');
  // The action as it was is recorded.
  assert.deepEqual(Object.keys(writeRecord(bad.runDir, 'actions/05-pay.action.json', keys)), ['file', 'sha256']);
  assert.equal(keys.destroy({ lastRecordSigned: true }).noted, true);

  const none = makeRun({ actions: [] });
  assert.throws(() => writeRun(none.runDir), /no action file under actions\//);
  const mixed = makeRun({ actions: [INTENT_ACTION, { ...PAY_ACTION, over: { ...PAY_ACTION.over, runId: 'clean-20261115T130000Z' } }] });
  assert.throws(() => writeRun(mixed.runDir), /the action files name 2 values of runId/);
  // Both were refused before a key was needed, so neither has a key file or a pin.
  assert.deepEqual(filesUnder(path.dirname(none.runDir)), []);
  assert.equal(filesUnder(path.dirname(mixed.runDir)).some((file) => file.startsWith('.pins/') || file.includes('/keys/') || file.includes('/records/')), false);
});

test('the signer is the test key of the run and nothing else: a key object from elsewhere, a copy of the handle, and the key of another run are refused', () => {
  const mine = makeRun({ actions: [PAY_ACTION] });
  const keys = generateTestKey(mine.runDir);
  const request = (signer) => () => writeRecord(mine.runDir, 'actions/05-pay.action.json', signer);
  const elsewhere = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(request({ privateKey: elsewhere.privateKey, publicKeyPem: keys.publicKeyPem }), /the signer is not a key generateTestKey made/);
  assert.throws(request({ ...keys }), /the signer is not a key generateTestKey made/);
  assert.throws(request(elsewhere.privateKey), /the signer is not a key generateTestKey made/);
  assert.throws(request(undefined), /the signer is not a key generateTestKey made/);
  assert.throws(request(null), /the signer is not a key generateTestKey made/);
  assert.throws(() => writeRun(mine.runDir, { ...keys }), /the signer is not a key generateTestKey made/);

  const other = makeRun({ actions: [PAY_ACTION] });
  const otherKeys = generateTestKey(other.runDir);
  assert.throws(request(otherKeys), /the signer key was generated for another run; a run has its own key/);
  assert.throws(() => writeRun(mine.runDir, otherKeys), /the signer key was generated for another run/);
  assert.equal(otherKeys.deletedAt, null, 'a key given to the wrong run is left to its caller');
  otherKeys.destroy();
  assert.equal(fs.existsSync(path.join(mine.runDir, 'records')), false, 'no record was written by a refused call');
  assert.equal(keys.deletedAt, null);
  keys.destroy();
});

test('a run refused after its key was made: the key is deleted on that way out, TEST-KEY.txt says the records were not finished, and no record is written', () => {
  const mixed = makeRun({ actions: [INTENT_ACTION, { ...PAY_ACTION, over: { ...PAY_ACTION.over, runId: 'clean-20261115T130000Z' } }] });
  const keys = generateTestKey(mixed.runDir);
  assert.throws(() => writeRun(mixed.runDir), /the action files name 2 values of runId/);
  assert.notEqual(keys.deletedAt, null);
  assert.equal(liveTestKey(mixed.runDir), null);
  assert.throws(() => keys.sign(Buffer.from('more')), /the private key of this run is deleted/);
  assert.deepEqual(noteLines(mixed.runDir), [TEST_KEY_LINE, `Private key deleted at ${keys.deletedAt}; the run's records were not finished.`, '']);
  assert.equal(fs.existsSync(path.join(mixed.runDir, 'records')), false);

  // A public key file that is no longer the one the run started with is refused the same way.
  const swapped = makeRun();
  const swappedKeys = generateTestKey(swapped.runDir);
  const elsewhere = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(swapped.runDir, PUBLIC_KEY_FILE), elsewhere);
  assert.throws(() => writeRun(swapped.runDir), /keys\/test-signer\.pub\.pem is not the public key this run started with/);
  assert.notEqual(swappedKeys.deletedAt, null);
  assert.equal(fs.existsSync(path.join(swapped.runDir, 'records')), false);
});

test('a record is storeZip of its seven entries at the action time and nothing more, and neither hash.sha256 nor signature.sig ends with a line feed', () => {
  const entries = SEVEN.map((name) => ({ name, data: readEntry(record('05-pay.aep'), name) }));
  const date = new Date(EXAMPLE_ACTION.at);
  assert.ok(storeZip(entries, { date }).equals(fs.readFileSync(record('05-pay.aep'))), 'the record is storeZip of its seven entries at the action time');
  assert.equal(entries.find((entry) => entry.name === 'hash.sha256').data.at(-1) !== 0x0a, true);
  assert.equal(entries.find((entry) => entry.name === 'signature.sig').data.at(-1) !== 0x0a, true);
});
