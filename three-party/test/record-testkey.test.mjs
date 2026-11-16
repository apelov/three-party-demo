// The test key of a run: one RSA 2048 key per run, a private key that is
// held in memory and reaches no file, a pin held outside the run directory,
// and a deletion that leaves a handle which signs nothing. Key bytes are
// compared with boolean assertions, so a failure prints no key.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import util from 'node:util';

import {
  deletionLine, generateTestKey, isTestKey, liveTestKey, PIN_DIRECTORY, pinFileOf, pinIsOutside, PUBLIC_KEY_FILE, TEST_KEY_LINE, TEST_KEY_NOTE_FILE,
} from '../src/record/testkey.mjs';
import { filesUnder, makeRun, NEEDS_WRITE_SANDBOX, parsesAsPrivateKey, privateKeyFilesUnder, removeTempDirs, sha256, tempDir, THREE_PARTY, writeSandbox } from './record-support.mjs';

after(removeTempDirs);

const PKCS1 = crypto.constants.RSA_PKCS1_PADDING;
const SOURCE = (name) => fs.readFileSync(path.join(THREE_PARTY, 'src', 'record', name), 'utf8');
const noteText = (runDir) => fs.readFileSync(path.join(runDir, TEST_KEY_NOTE_FILE), 'utf8');
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

test('generateTestKey makes one RSA 2048 key and writes public material and nothing else: the SPKI public key, and the one sentence of CONTRACT.md section 3', () => {
  const run = makeRun();
  const keys = generateTestKey(run.runDir);
  assert.deepEqual(filesUnder(path.join(run.runDir, 'keys')), ['TEST-KEY.txt', 'test-signer.pub.pem']);
  assert.equal(PUBLIC_KEY_FILE, 'keys/test-signer.pub.pem');
  assert.equal(TEST_KEY_NOTE_FILE, 'keys/TEST-KEY.txt');

  const publicBytes = fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE));
  const publicKey = crypto.createPublicKey(publicBytes);
  assert.equal(publicKey.type, 'public');
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(publicKey.asymmetricKeyDetails.publicExponent, 65537n);
  // The file is one SPKI block and nothing more: exporting the key again gives the file.
  assert.ok(publicKey.export({ type: 'spki', format: 'pem' }) === publicBytes.toString('utf8'), 'the public key file is one SPKI PEM block');
  assert.equal(parsesAsPrivateKey(publicBytes), false);

  assert.equal(noteText(run.runDir), 'Test key generated for this demo run; not a key in use anywhere.\n');
  assert.equal(TEST_KEY_LINE, 'Test key generated for this demo run; not a key in use anywhere.');
  assert.ok(fs.readFileSync(path.join(THREE_PARTY, 'CONTRACT.md'), 'utf8').includes(`\`${TEST_KEY_LINE}\``), 'the sentence is the one CONTRACT.md section 3 gives');

  assert.equal(keys.runDir, path.resolve(run.runDir));
  assert.ok(keys.publicKeyPem === publicBytes.toString('utf8'), 'the handle carries the public key of the file');
  assert.equal(keys.signerSha256, sha256(publicBytes));
  assert.equal(keys.deletedAt, null);
  // While the key is live, no file of the run or of its pin directory is a private key.
  assert.deepEqual(privateKeyFilesUnder(path.dirname(run.runDir)), []);
  keys.destroy();
});

test('the pin is the public key captured when the run starts: held outside the run directory, the same bytes, written once and never written over', () => {
  const run = makeRun();
  const keys = generateTestKey(run.runDir);
  const pin = pinFileOf(run.runDir);
  assert.equal(PIN_DIRECTORY, '.pins');
  assert.equal(pin, path.join(path.dirname(run.runDir), '.pins', `${run.runId}.pub.pem`));
  assert.equal(keys.pinFile, pin);
  assert.equal(pinIsOutside(run.runDir, pin), true);
  assert.equal(path.relative(run.runDir, pin).startsWith('..'), true, 'the pin is not under the run directory');
  const pinBytes = fs.readFileSync(pin);
  assert.ok(pinBytes.equals(fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE))), 'the pin is the run\'s public key, byte for byte');
  assert.equal(fs.statSync(pin).mode & 0o222, 0, 'the pin file has no write bit');

  // A run has one key: a second call is refused and changes nothing.
  assert.throws(() => generateTestKey(run.runDir), /this run already has a test key \(keys\/test-signer\.pub\.pem\); a run has one key, and a new run gets a new key/);
  keys.destroy();
  assert.throws(() => generateTestKey(run.runDir), /this run already has a test key/);
  assert.ok(fs.readFileSync(pin).equals(pinBytes), 'the pin is as it was');

  // A pin that already exists is never written over, and the run gets no key file.
  const later = makeRun();
  const held = pinFileOf(later.runDir);
  fs.mkdirSync(path.dirname(held), { recursive: true });
  fs.writeFileSync(held, 'a pin from an earlier run of this id\n');
  assert.throws(() => generateTestKey(later.runDir), /a pin of this run already exists; a run has one key, and a new run gets a new key/);
  assert.equal(fs.readFileSync(held, 'utf8'), 'a pin from an earlier run of this id\n');
  assert.equal(fs.existsSync(path.join(later.runDir, 'keys')), false);
  assert.equal(liveTestKey(later.runDir), null);
});

test('the caller may name where the pin is held, and a place inside the run directory is refused, by its path and through a symbolic link', () => {
  const run = makeRun();
  const elsewhere = path.join(tempDir(), 'held', 'pin.pub.pem');
  const keys = generateTestKey(run.runDir, { pinFile: elsewhere });
  assert.equal(keys.pinFile, elsewhere);
  assert.ok(fs.readFileSync(elsewhere).equals(fs.readFileSync(path.join(run.runDir, PUBLIC_KEY_FILE))));
  assert.equal(fs.existsSync(pinFileOf(run.runDir)), false, 'the usual place is not written when another is named');
  keys.destroy();

  const inside = makeRun();
  const before = filesUnder(path.dirname(inside.runDir));
  assert.equal(pinIsOutside(inside.runDir, path.join(inside.runDir, 'keys', 'pin.pub.pem')), false);
  assert.equal(pinIsOutside(inside.runDir, inside.runDir), false);
  assert.throws(() => generateTestKey(inside.runDir, { pinFile: path.join(inside.runDir, 'keys', 'pin.pub.pem') }), /the pin is held outside the run directory/);
  // A link beside the run directory that leads into it is the same place.
  const link = path.join(path.dirname(inside.runDir), 'link');
  fs.symlinkSync(inside.runDir, link);
  assert.equal(pinIsOutside(inside.runDir, path.join(link, 'pin.pub.pem')), false);
  assert.throws(() => generateTestKey(inside.runDir, { pinFile: path.join(link, 'pin.pub.pem') }), /the pin is held outside the run directory/);
  fs.rmSync(link);
  assert.deepEqual(filesUnder(path.dirname(inside.runDir)), before, 'a refused call writes nothing');
  assert.equal(liveTestKey(inside.runDir), null);
});

test('a new key for every run: two runs have different public keys, and a signature of one does not verify under the other', () => {
  const one = makeRun();
  const two = makeRun();
  const keysOne = generateTestKey(one.runDir);
  const keysTwo = generateTestKey(two.runDir);
  assert.equal(keysOne.publicKeyPem === keysTwo.publicKeyPem, false, 'the two public keys differ');
  assert.equal(keysOne.signerSha256 === keysTwo.signerSha256, false);
  const bytes = Buffer.from('the same bytes for both keys');
  const verifies = (keys, signature) => crypto.verify('sha256', bytes, { key: keys.publicKeyPem, padding: PKCS1 }, signature);
  assert.equal(verifies(keysOne, keysOne.sign(bytes)), true);
  assert.equal(verifies(keysTwo, keysTwo.sign(bytes)), true);
  assert.equal(verifies(keysTwo, keysOne.sign(bytes)), false);
  assert.equal(verifies(keysOne, keysTwo.sign(bytes)), false);
  keysOne.destroy();
  keysTwo.destroy();
});

test('the handle signs and gives no way to read the private key: its members are five values and two functions, and printing it prints no key', () => {
  const run = makeRun();
  const keys = generateTestKey(run.runDir);
  assert.deepEqual(Object.keys(keys), ['runDir', 'publicKeyPem', 'signerSha256', 'pinFile', 'deletedAt', 'sign', 'destroy']);
  assert.deepEqual(Reflect.ownKeys(keys), Object.keys(keys), 'no member is hidden or keyed by a symbol');
  assert.equal(Object.isFrozen(keys), true);
  assert.equal(Object.getPrototypeOf(keys), Object.prototype);
  for (const name of Object.keys(keys)) assert.equal(keys[name] instanceof crypto.KeyObject, false, name);
  for (const name of ['runDir', 'publicKeyPem', 'signerSha256', 'pinFile']) assert.equal(typeof keys[name], 'string', name);
  assert.equal(isTestKey(keys), true);
  assert.equal(isTestKey({ ...keys }), false, 'a copy of the handle is not the handle');
  assert.equal(isTestKey(null), false);

  // What a log line would hold if the handle were printed.
  const printed = [util.inspect(keys, { showHidden: true, depth: 8, getters: true }), JSON.stringify(keys), String(keys), `${keys.sign}`, `${keys.destroy}`];
  for (const text of printed) {
    assert.doesNotMatch(text, /KeyObject/);
    assert.equal(parsesAsPrivateKey(Buffer.from(text, 'utf8')), false);
  }
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(keys))), ['runDir', 'publicKeyPem', 'signerSha256', 'pinFile', 'deletedAt']);

  const bytes = Buffer.from('bytes to sign');
  const signature = keys.sign(bytes);
  assert.equal(signature.length, 256);
  assert.equal(crypto.verify('sha256', bytes, { key: keys.publicKeyPem, padding: PKCS1 }, signature), true);
  assert.ok(keys.sign(bytes).equals(signature), 'the same bytes give the same signature');
  assert.throws(() => keys.sign('bytes to sign'), /the bytes to sign are not a Buffer/);
  keys.destroy();
});

test('destroy deletes the key: the handle signs nothing afterwards, TEST-KEY.txt gains the deletion line, and a second call changes nothing', () => {
  assert.equal(deletionLine('2026-11-15T12:00:41Z'), 'Private key deleted at 2026-11-15T12:00:41Z after the last record was signed.');
  assert.equal(deletionLine('2026-11-15T12:00:41Z', { lastRecordSigned: false }), 'Private key deleted at 2026-11-15T12:00:41Z; the run\'s records were not finished.');

  const run = makeRun();
  const keys = generateTestKey(run.runDir);
  assert.equal(liveTestKey(run.runDir), keys);
  const from = Date.now();
  const done = keys.destroy({ lastRecordSigned: true });
  assert.deepEqual(Object.keys(done), ['deletedAt', 'noted', 'already']);
  assert.match(done.deletedAt, UTC);
  assert.ok(Date.parse(done.deletedAt) >= from - 1000 && Date.parse(done.deletedAt) <= Date.now());
  assert.deepEqual({ noted: done.noted, already: done.already }, { noted: true, already: false });
  assert.equal(keys.deletedAt, done.deletedAt);
  assert.equal(liveTestKey(run.runDir), null);
  assert.throws(() => keys.sign(Buffer.from('more')), /the private key of this run is deleted; a new run gets a new key/);
  assert.equal(noteText(run.runDir), `Test key generated for this demo run; not a key in use anywhere.\nPrivate key deleted at ${done.deletedAt} after the last record was signed.\n`);

  // A second call, whatever it says, changes neither the time nor the file.
  const noteBefore = fs.statSync(path.join(run.runDir, TEST_KEY_NOTE_FILE)).mtimeMs;
  assert.deepEqual(keys.destroy(), { deletedAt: done.deletedAt, noted: true, already: true });
  assert.equal(fs.statSync(path.join(run.runDir, TEST_KEY_NOTE_FILE)).mtimeMs, noteBefore);
  assert.equal(noteText(run.runDir).split('\n')[1], deletionLine(done.deletedAt));
  // The public material is as it was, and still no file is a private key.
  assert.deepEqual(filesUnder(path.join(run.runDir, 'keys')), ['TEST-KEY.txt', 'test-signer.pub.pem']);
  assert.deepEqual(privateKeyFilesUnder(path.dirname(run.runDir)), []);
});

test('a key deleted on a way out that left the records unfinished says so, and a deletion whose line cannot be written still deletes the key', () => {
  const unfinished = makeRun();
  const keys = generateTestKey(unfinished.runDir);
  const done = keys.destroy();
  assert.equal(done.noted, true);
  assert.equal(noteText(unfinished.runDir), `${TEST_KEY_LINE}\nPrivate key deleted at ${done.deletedAt}; the run's records were not finished.\n`);
  assert.throws(() => keys.sign(Buffer.from('more')), /deleted/);

  const gone = makeRun();
  const goneKeys = generateTestKey(gone.runDir);
  fs.rmSync(gone.runDir, { recursive: true });
  const answer = goneKeys.destroy({ lastRecordSigned: true });
  assert.equal(answer.noted, false, 'the line had nowhere to go');
  assert.match(answer.deletedAt, UTC);
  assert.throws(() => goneKeys.sign(Buffer.from('more')), /deleted/);
  assert.equal(liveTestKey(gone.runDir), null);
});

test('liveTestKey gives the handle of a run whose key is live in this process, and null otherwise; a path that is not a directory gets no key', () => {
  const run = makeRun();
  assert.equal(liveTestKey(run.runDir), null);
  const keys = generateTestKey(run.runDir);
  assert.equal(liveTestKey(run.runDir), keys);
  assert.equal(liveTestKey(path.join(run.runDir, '.')), keys, 'the same directory, written another way');
  assert.equal(liveTestKey(path.dirname(run.runDir)), null);
  keys.destroy();
  assert.equal(liveTestKey(run.runDir), null);

  const absent = path.join(tempDir(), 'clean-20261115T120000Z');
  assert.throws(() => generateTestKey(absent), /not a directory, so there is no run to make a key for/);
  assert.equal(fs.existsSync(absent), false);
  assert.equal(fs.existsSync(pinFileOf(absent)), false);
  const file = path.join(tempDir(), 'a-file');
  fs.writeFileSync(file, 'not a run\n');
  assert.throws(() => generateTestKey(file), /not a directory/);
});

test('the tests\' own look for a private key finds a key in each form it is planted in, and none in public material', () => {
  const dir = tempDir();
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const passphrase = crypto.randomBytes(12).toString('hex');
  const planted = {
    'a-pkcs8.pem': rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    'b-pkcs1.pem': rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    'c-sec1.pem': ec.privateKey.export({ type: 'sec1', format: 'pem' }),
    'd-encrypted.pem': rsa.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }),
    'e-pkcs8.der': rsa.privateKey.export({ type: 'pkcs8', format: 'der' }),
    'f-sec1.der': ec.privateKey.export({ type: 'sec1', format: 'der' }),
    'g-encrypted.der': rsa.privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase }),
  };
  const publicMaterial = {
    'p-spki.pem': rsa.publicKey.export({ type: 'spki', format: 'pem' }),
    'q-spki.der': rsa.publicKey.export({ type: 'spki', format: 'der' }),
    'r-pkcs1-public.pem': rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }),
    's-note.txt': `${TEST_KEY_LINE}\n`,
  };
  for (const [name, bytes] of Object.entries({ ...planted, ...publicMaterial })) fs.writeFileSync(path.join(dir, name), bytes);
  assert.deepEqual(privateKeyFilesUnder(dir), Object.keys(planted));
});

test('the private key reaches no file: a whole run written in a process with a temp directory, a home and a working directory of its own leaves no private key in any of them, in the run, or in this tree', () => {
  const run = makeRun();
  const own = { tmp: tempDir(), home: tempDir(), cwd: tempDir() };
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(THREE_PARTY, 'src', 'record', name)).href);
  const script = [
    'import os from "node:os";',
    `import { generateTestKey } from ${moduleUrl('testkey.mjs')};`,
    `import { writeRun } from ${moduleUrl('writer.mjs')};`,
    'const keys = generateTestKey(process.argv[1]);',
    'const out = writeRun(process.argv[1]);',
    'process.stdout.write(JSON.stringify({ records: out.records.length, deletedAt: keys.deletedAt, tmp: os.tmpdir() }));',
  ].join('\n');
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script, run.runDir], { env: { TMPDIR: own.tmp, HOME: own.home }, cwd: own.cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(ran.status, 0, ran.stderr);
  const said = JSON.parse(ran.stdout);
  assert.equal(said.records, 2);
  assert.equal(fs.realpathSync(said.tmp), fs.realpathSync(own.tmp), 'the process used the temp directory it was given');
  assert.match(said.deletedAt, UTC);

  // The process wrote nothing at all outside the run and its pin directory.
  for (const [name, dir] of Object.entries(own)) assert.deepEqual(fs.readdirSync(dir), [], name);
  // What it wrote holds no private key, and neither does what it printed.
  const root = path.dirname(run.runDir);
  assert.deepEqual(privateKeyFilesUnder(root), []);
  assert.equal(parsesAsPrivateKey(Buffer.from(ran.stdout + ran.stderr, 'utf8')), false);
  assert.equal(filesUnder(root).some((file) => /\.(pem|key|der|p8|p12|pfx)$/.test(file) && !file.endsWith('.pub.pem')), false, 'no key file but the two public ones');
  assert.equal(noteText(run.runDir).split('\n')[1], deletionLine(said.deletedAt));
  // This tree, where the code and a run's output live, holds no private key.
  assert.deepEqual(privateKeyFilesUnder(THREE_PARTY), []);
});

test('a whole run is written by a process the sandbox lets write under the run\'s own temp directory and nowhere else, so nothing of the key is written to any other place', NEEDS_WRITE_SANDBOX, () => {
  const moduleUrl = JSON.stringify(pathToFileURL(path.join(THREE_PARTY, 'src', 'record', 'writer.mjs')).href);
  const script = `import { writeRun } from ${moduleUrl}; const out = writeRun(process.argv[1]); process.stdout.write(String(out.records.length));`;
  const run = makeRun();
  // The sandbox names paths with symbolic links resolved: sandbox-exec with
  // a file-write profile on macOS, bwrap with the root read-only and this
  // one directory writable on Linux.
  const root = fs.realpathSync(path.dirname(run.runDir));
  const sandbox = writeSandbox(root);
  const write = (runDir) => spawnSync(sandbox.argv[0], [...sandbox.argv.slice(1), process.execPath, '--input-type=module', '-e', script, runDir], { env: {}, encoding: 'utf8', timeout: 60000 });

  const ran = write(path.join(root, run.runId));
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, '2');
  assert.deepEqual(filesUnder(root).filter((file) => !file.includes('/actions/')), [
    `.pins/${run.runId}.pub.pem`,
    `${run.runId}/keys/TEST-KEY.txt`,
    `${run.runId}/keys/test-signer.pub.pem`,
    `${run.runId}/records/04-intent.aep`,
    `${run.runId}/records/05-pay.aep`,
    `${run.runId}/records/manifest.json`,
    `${run.runId}/records/tampered/05-pay.aep`,
  ]);
  assert.deepEqual(privateKeyFilesUnder(root), []);

  // The profile does deny: the same process, aimed at a run outside the
  // place it may write, is stopped at its earliest write and leaves nothing.
  const other = makeRun();
  const refused = write(fs.realpathSync(other.runDir));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(`Error: ${sandbox.refusal}: [a-z ]+, mkdir '[^']+/\\.pins'`));
  assert.deepEqual(filesUnder(path.dirname(other.runDir)).filter((file) => !file.includes('/actions/')), []);
});

test('the two modules that hold or use the key start no process, read no environment variable, print nothing, and serialize one key: the public one', () => {
  const testkey = SOURCE('testkey.mjs');
  const writer = SOURCE('writer.mjs');
  const imports = (source) => [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports(testkey), ['node:crypto', 'node:fs', 'node:path']);
  assert.deepEqual(imports(writer), ['./jcs.mjs', './testkey.mjs', './zip.mjs', 'node:crypto', 'node:fs', 'node:path']);
  for (const [name, source] of [['testkey.mjs', testkey], ['writer.mjs', writer]]) {
    assert.doesNotMatch(source, /child_process|process\.env|console\.|process\.std(out|err)|import\(/, name);
  }
  // A key leaves a key object through export. The one such call writes the public key.
  const exportCalls = testkey.split('\n').filter((line) => line.includes('.export('));
  assert.equal(exportCalls.length, 1);
  assert.match(exportCalls[0], /publicKey\.export\(\{ type: 'spki', format: 'pem' \}\)/);
  assert.equal(writer.includes('.export('), false);
  // The private key object is bound to one name, which no return, write or throw line carries.
  const keyLines = testkey.split('\n').filter((line) => /\bkey\b/.test(line) && !/^\s*\/\//.test(line));
  assert.equal(keyLines.some((line) => /return key\b|writeFileSync\([^)]*\bkey\b|throw [^;]*\$\{key\}/.test(line)), false);
});
