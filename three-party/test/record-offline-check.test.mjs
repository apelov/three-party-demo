// The offline check: the look for a private key, the network control against
// a live listener on 127.0.0.1, and the verifier run under the profile on
// each record file, with the result file the check writes. A test that
// expects a result writes its own run, so the run the other tests share
// holds no result file.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { callVerifier, EXIT, findPrivateKeys, LINE, networkControl, offlineCheck, privateKeyKinds, PROFILE, RESULT_FILE, SANDBOX_EXEC as CHECK_SANDBOX_EXEC, VERDICT, VERIFIER } from '../src/record/check.mjs';
import { pinFileOf, PUBLIC_KEY_FILE } from '../src/record/testkey.mjs';
import { MANIFEST_FILE, writeRun } from '../src/record/writer.mjs';
import { storeZip } from '../src/record/zip.mjs';
import { filesUnder, makeRun, NEEDS_SANDBOX, PAY_ACTION, readJson, removeTempDirs, runOfflineCheck, SANDBOX_EXEC, sha256, tempDir, THREE_PARTY } from './record-support.mjs';

after(removeTempDirs);

const LIMIT = { timeout: 120000 };
const PROBE = path.join(THREE_PARTY, 'src', 'record', 'connect-probe.mjs');
const VERIFIER_FILE = path.join(THREE_PARTY, 'src', 'verifier', 'aep-verify.mjs');
const KEY_AND_NETWORK = ['private key: absent', 'network denied: yes'];
const verifierLine = () => `verifier: aep-verify.mjs sha256 ${sha256(fs.readFileSync(VERIFIER_FILE))}`;
const pinLine = (signerSha256) => `pin: sha256 ${signerSha256} (the public key captured when the run started, held outside the run directory)`;
const NOT_RUN = 'steps 7 to 10 not run by this verifier';
const STEP_3 = 'step 3: canonical.bin is neither response.txt, LF, JCS(metadata.json) nor response.txt alone';
const NETWORK = 'denied: sandbox-exec profile (version 1) (allow default) (deny network*); control: CONNECTED outside, EPERM inside';
const RESULT_KEYS = ['runId', 'at', 'verifier', 'pin', 'pinSha256', 'network', 'records', 'tampered', 'summary'];
const stateOf = (dir) => filesUnder(dir).map((file) => `${file} ${sha256(fs.readFileSync(path.join(dir, file)))}`);
const resultFile = (runDir) => path.join(runDir, 'offline-check.json');
// A written run of a test's own, with its manifest.
function writtenRun(options) {
  const own = makeRun(options);
  writeRun(own.runDir);
  return { ...own, manifestFile: path.join(own.runDir, MANIFEST_FILE), manifest: readJson(path.join(own.runDir, MANIFEST_FILE)) };
}

// A written run for the tests that read one and change nothing in it.
let run = null;
let manifest = null;
before(() => {
  run = makeRun();
  writeRun(run.runDir);
  manifest = readJson(path.join(run.runDir, MANIFEST_FILE));
});

// A program a test puts in the place of the sandbox command. Each is a
// Node.js script written to a temp directory when the test runs; it gets
// the arguments the sandbox command would get: -p, the profile, then the
// command to run.
function standIn(name, lines, extra = []) {
  const file = path.join(tempDir(), `${name}.mjs`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return [process.execPath, file, ...extra];
}
const AFTER_PROFILE = 'const command = process.argv.slice(process.argv.indexOf("-p") + 2);';
const RUNS_IT_UNSANDBOXED = () => standIn('applies-no-profile', [
  'import { spawnSync } from "node:child_process";',
  AFTER_PROFILE,
  'const ran = spawnSync(command[0], command.slice(1), { stdio: "inherit", env: {} });',
  'process.exit(ran.status ?? 1);',
]);
const ENDS_WITH_71 = () => standIn('ends-with-71', ['process.stderr.write("stand-in: cannot apply a profile\\n");', 'process.exit(71);']);
const NEVER_ANSWERS = () => standIn('never-answers', ['setInterval(() => {}, 1000);']);

// Runs a program without blocking this process, so a listener held here
// can answer it.
function runProgram(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ status: null, stdout, stderr: String(error.code) }));
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the offline check on a written run prints private key: absent, network denied: yes, the verifier and its hash, the pin, one line per record, the result and the file written, in that order; it exits 0 and writes offline-check.json in the shape of the contract', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  const own = writtenRun();
  const before = stateOf(path.dirname(own.runDir));
  const ran = runOfflineCheck([own.runDir]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.signal, null);
  assert.equal(own.manifest.tampered.length, 1);
  assert.deepEqual(ran.lines, [
    ...KEY_AND_NETWORK,
    verifierLine(),
    pinLine(own.manifest.signerSha256),
    ...own.manifest.records.map((record) => `${record.file}: pass-1-6`),
    `${own.manifest.tampered[0].file}: rejected at step 3`,
    `result: ${own.manifest.records.length} passed steps 1 to 6, 1 rejected (1 expected)`,
    'written: offline-check.json',
  ]);
  assert.equal(ran.stderr, '');

  // The result file: the fields of the contract in their order, each
  // record with the verifier's answer on it, and the count of each verdict.
  const text = fs.readFileSync(resultFile(own.runDir), 'utf8');
  const result = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(result, null, 2)}\n`);
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  assert.equal(result.runId, own.runId);
  assert.match(result.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(result.verifier, { entry: 'three-party/src/verifier/aep-verify.mjs', sha256: sha256(fs.readFileSync(VERIFIER_FILE)), source: 'written for this demo from the format text, steps 1 to 6' });
  assert.deepEqual(result.verifier, { entry: VERIFIER.entry, sha256: result.verifier.sha256, source: VERIFIER.source });
  // The pin is named by its path from the directory that holds the run directory.
  assert.equal(result.pin, `.pins/${own.runId}.pub.pem`);
  assert.equal(path.resolve(path.dirname(own.runDir), result.pin), pinFileOf(own.runDir));
  assert.equal(result.pinSha256, own.manifest.signerSha256);
  assert.equal(result.pinSha256, sha256(fs.readFileSync(pinFileOf(own.runDir))));
  assert.equal(result.network, NETWORK);
  assert.deepEqual(result.records, own.manifest.records.map((record) => ({ file: record.file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] })));
  assert.deepEqual(result.tampered, own.manifest.tampered.map((copy) => ({ file: copy.file, sha256: copy.sha256, verdict: 'reject', firstFailingStep: 3, notes: [STEP_3, NOT_RUN] })));
  assert.deepEqual(result.summary, { pass: own.manifest.records.length, reject: 1, expectedRejects: 1 });
  for (const item of [...result.records, ...result.tampered]) assert.equal(item.sha256, sha256(fs.readFileSync(path.join(own.runDir, item.file))), item.file);

  // The check wrote that one file and changed no other file of the run or of its pin directory.
  const after = stateOf(path.dirname(own.runDir));
  assert.deepEqual(after.filter((line) => !line.startsWith(`${own.runId}/offline-check.json `)), before);
  assert.equal(after.length, before.length + 1);

  // The lines and the names the check keeps.
  assert.deepEqual([LINE.KEY_ABSENT, LINE.NETWORK_DENIED], KEY_AND_NETWORK);
  assert.deepEqual({ ...EXIT }, { ERROR: 1, NETWORK_NOT_MEASURED: 3, NOT_AS_EXPECTED: 4 });
  assert.deepEqual({ ...VERDICT }, { PASS: 'pass-1-6', REJECT: 'reject' });
  assert.equal(RESULT_FILE, 'offline-check.json');
  for (const gone of ['VERIFIER_NONE', 'RESULT_NONE']) assert.equal(Object.hasOwn(LINE, gone), false, gone);
  assert.equal(Object.hasOwn(EXIT, 'NO_VERIFIER'), false);
});

test('--out names where the result is written, and nothing is written in the run directory then; a result file that is there before the check is replaced, and a note says so', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  const own = writtenRun();
  const out = path.join(tempDir(), 'result.json');
  const ran = runOfflineCheck([own.runDir, '--out', out]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.lines.slice(0, 2), KEY_AND_NETWORK);
  assert.equal(ran.lines.at(-1), `written: ${out}`);
  assert.equal(ran.stderr, '');
  assert.equal(fs.existsSync(resultFile(own.runDir)), false);
  assert.deepEqual(Object.keys(readJson(out)), RESULT_KEYS);
  assert.deepEqual(readJson(out).summary, { pass: own.manifest.records.length, reject: 1, expectedRejects: 1 });

  // A file from elsewhere in the place of the result.
  fs.writeFileSync(resultFile(own.runDir), '{"from":"somewhere else"}\n');
  const replaced = `offline-check: ${resultFile(own.runDir)} was there before this check, and this check's result replaced it\n`;
  const again = runOfflineCheck([own.runDir]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.lines.at(-1), 'written: offline-check.json');
  assert.equal(again.stderr, replaced);
  assert.equal(readJson(resultFile(own.runDir)).runId, own.runId);
  assert.equal(Object.hasOwn(readJson(resultFile(own.runDir)), 'from'), false);
  // The check run once more replaces its own earlier result, and says so again.
  const third = runOfflineCheck([own.runDir]);
  assert.deepEqual({ status: third.status, stderr: third.stderr, lines: third.lines }, { status: 0, stderr: replaced, lines: again.lines });
});

test('a run whose tampered copy was replaced by a copy of the untampered record ends with exit 4, with offline-check.json written', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  const own = writtenRun();
  const copy = own.manifest.tampered[0];
  const original = own.manifest.records.find((record) => path.basename(record.file) === path.basename(copy.file));
  assert.ok(original, 'the tampered copy is a copy of a record of the run');
  fs.copyFileSync(path.join(own.runDir, original.file), path.join(own.runDir, copy.file));

  const ran = runOfflineCheck([own.runDir]);
  assert.equal(ran.status, 4, ran.stderr);
  assert.deepEqual(ran.lines, [
    ...KEY_AND_NETWORK,
    verifierLine(),
    pinLine(own.manifest.signerSha256),
    ...own.manifest.records.map((record) => `${record.file}: pass-1-6`),
    `${copy.file}: pass-1-6`,
    `result: ${own.manifest.records.length + 1} passed steps 1 to 6, 0 rejected (1 expected)`,
    'written: offline-check.json',
  ]);
  assert.equal(ran.stderr, [
    `offline-check: ${copy.file}: a tampered copy that was not rejected`,
    `offline-check: ${copy.file}: its SHA-256 differs from the one records/manifest.json gives`,
    '',
  ].join('\n'));
  const result = readJson(resultFile(own.runDir));
  assert.deepEqual(result.tampered, [{ file: copy.file, sha256: original.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: ['offline check: its SHA-256 differs from the one records/manifest.json gives', NOT_RUN] }]);
  assert.deepEqual(result.summary, { pass: own.manifest.records.length + 1, reject: 0, expectedRejects: 1 });
  assert.equal(EXIT.NOT_AS_EXPECTED, 4);
});

test('a difference between the disk and the manifest ends with exit 4 and names the file: a record the manifest omits, a record the manifest names that is not on disk, a name that is not a record file', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  // The manifest omits a record that is on disk. The verifier is still run on it.
  const omitted = writtenRun();
  const dropped = omitted.manifest.records[0];
  fs.writeFileSync(omitted.manifestFile, `${JSON.stringify({ ...omitted.manifest, records: omitted.manifest.records.slice(1) }, null, 2)}\n`);
  const omittedRan = runOfflineCheck([omitted.runDir]);
  assert.equal(omittedRan.status, 4, omittedRan.stderr);
  assert.equal(omittedRan.stderr, `offline-check: ${dropped.file}: on disk and not named in records/manifest.json\n`);
  assert.ok(omittedRan.lines.includes(`${dropped.file}: pass-1-6`));
  assert.equal(omittedRan.lines.at(-2), `result: ${omitted.manifest.records.length} passed steps 1 to 6, 1 rejected (1 expected)`);
  const firstResult = readJson(resultFile(omitted.runDir));
  assert.deepEqual(firstResult.records.find((item) => item.file === dropped.file), { file: dropped.file, sha256: dropped.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: ['offline check: on disk and not named in records/manifest.json', NOT_RUN] });
  assert.deepEqual(firstResult.records.map((item) => item.file), omitted.manifest.records.map((record) => record.file));

  // The manifest names a record, and a tampered copy, that are not on disk.
  const missing = writtenRun();
  const gone = missing.manifest.records[0];
  const goneCopy = missing.manifest.tampered[0];
  fs.rmSync(path.join(missing.runDir, gone.file));
  fs.rmSync(path.join(missing.runDir, goneCopy.file));
  const second = runOfflineCheck([missing.runDir]);
  assert.equal(second.status, 4, second.stderr);
  assert.ok(second.lines.includes(`${gone.file}: rejected at step 1`));
  assert.ok(second.lines.includes(`${goneCopy.file}: rejected at step 1`));
  assert.equal(second.stderr, [
    `offline-check: ${gone.file}: a record under records/ that did not pass steps 1 to 6`,
    `offline-check: ${gone.file}: named in records/manifest.json and not on disk`,
    `offline-check: ${goneCopy.file}: named in records/manifest.json and not on disk`,
    '',
  ].join('\n'));
  const secondResult = readJson(resultFile(missing.runDir));
  const cannotBeRead = { sha256: null, verdict: 'reject', firstFailingStep: 1, notes: ['offline check: named in records/manifest.json and not on disk', 'step 1: the package cannot be read (ENOENT)', NOT_RUN] };
  assert.deepEqual(secondResult.records[0], { file: gone.file, ...cannotBeRead });
  assert.deepEqual(secondResult.tampered, [{ file: goneCopy.file, ...cannotBeRead }]);
  // The copy that is not there counts as rejected, and the exit status still says the result is not as expected.
  assert.deepEqual(secondResult.summary, { pass: missing.manifest.records.length - 1, reject: 2, expectedRejects: 1 });

  // A name of the manifest that is not a record file of its list: no program is run on it.
  const strayed = writtenRun();
  const outside = path.join(tempDir(), 'outside.aep');
  fs.copyFileSync(path.join(strayed.runDir, strayed.manifest.records[0].file), outside);
  const names = ['../outside.aep', outside, 'records/tampered/../../../outside.aep', 'keys/test-signer.pub.pem'];
  fs.writeFileSync(strayed.manifestFile, `${JSON.stringify({ ...strayed.manifest, records: [...strayed.manifest.records, ...names.map((file) => ({ file, sha256: strayed.manifest.records[0].sha256 }))] }, null, 2)}\n`);
  const third = runOfflineCheck([strayed.runDir]);
  assert.equal(third.status, 4, third.stderr);
  const thirdResult = readJson(resultFile(strayed.runDir));
  const strays = thirdResult.records.slice(strayed.manifest.records.length);
  assert.deepEqual(strays.map((item) => item.file), names);
  for (const item of strays) {
    assert.deepEqual({ sha256: item.sha256, verdict: item.verdict, firstFailingStep: item.firstFailingStep, notes: item.notes }, { sha256: null, verdict: 'reject', firstFailingStep: null, notes: ['offline check: named in the records list of records/manifest.json, and not a record file of that list; the verifier was not run on it'] });
    assert.ok(third.lines.includes(`${item.file}: rejected (no answer of the verifier on it)`));
  }
});

test('a record under records/ that the verifier rejects ends with exit 4, and a run with no pin, or with no record, ends with 1 and writes nothing', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  // A record replaced by the tampered copy of itself.
  const own = writtenRun();
  const copy = own.manifest.tampered[0];
  const original = own.manifest.records.find((record) => path.basename(record.file) === path.basename(copy.file));
  fs.copyFileSync(path.join(own.runDir, copy.file), path.join(own.runDir, original.file));
  const ran = runOfflineCheck([own.runDir]);
  assert.equal(ran.status, 4, ran.stderr);
  assert.ok(ran.lines.includes(`${original.file}: rejected at step 3`));
  assert.equal(ran.lines.at(-2), `result: ${own.manifest.records.length - 1} passed steps 1 to 6, 2 rejected (1 expected)`);
  assert.equal(ran.stderr, [
    `offline-check: ${original.file}: a record under records/ that did not pass steps 1 to 6`,
    `offline-check: ${original.file}: its SHA-256 differs from the one records/manifest.json gives`,
    '',
  ].join('\n'));
  assert.deepEqual(readJson(resultFile(own.runDir)).summary, { pass: own.manifest.records.length - 1, reject: 2, expectedRejects: 1 });

  // The pin of another run: every record is rejected at step 5, the tampered copy at step 3.
  const elsewhere = writtenRun();
  const wrongPin = runOfflineCheck([elsewhere.runDir, '--pin', pinFileOf(own.runDir)]);
  assert.equal(wrongPin.status, 4);
  assert.deepEqual(wrongPin.lines.slice(4, -2), [...elsewhere.manifest.records.map((record) => `${record.file}: rejected at step 5`), `${elsewhere.manifest.tampered[0].file}: rejected at step 3`]);

  // No record on disk and none named.
  const empty = writtenRun();
  for (const item of [...empty.manifest.records, ...empty.manifest.tampered]) fs.rmSync(path.join(empty.runDir, item.file));
  fs.writeFileSync(empty.manifestFile, `${JSON.stringify({ ...empty.manifest, records: [], tampered: [] })}\n`);
  const none = runOfflineCheck([empty.runDir]);
  assert.equal(none.status, 1);
  assert.deepEqual(none.lines, [...KEY_AND_NETWORK, verifierLine(), pinLine(empty.manifest.signerSha256)]);
  assert.match(none.stderr, /no record file under records\/ and none named in records\/manifest\.json, so nothing was checked and nothing was written\n$/);
  assert.equal(fs.existsSync(resultFile(empty.runDir)), false);
});

test('a verifier run that gives no answer is not read as a verdict of the verifier: the record is listed as rejected with no step, the note says what was read, and the check ends with 4', { ...NEEDS_SANDBOX, ...LIMIT }, async () => {
  const own = writtenRun({ actions: [PAY_ACTION] });
  const files = [...own.manifest.records, ...own.manifest.tampered].map((item) => item.file);
  assert.equal(files.length, 2);
  // Stand-ins for the sandbox command that run the probe under the real
  // sandbox, so the network control passes, and answer in the place of the
  // verifier.
  const answering = (name, lines) => standIn(name, [
    'import { spawnSync } from "node:child_process";',
    'const profile = process.argv[process.argv.indexOf("-p") + 1];',
    AFTER_PROFILE,
    'if (command.some((word) => word.endsWith("connect-probe.mjs"))) {',
    `  const ran = spawnSync(${JSON.stringify(SANDBOX_EXEC)}, ["-p", profile, ...command], { stdio: "inherit", env: {} });`,
    '  process.exit(ran.status ?? 1);',
    '}',
    ...lines,
  ]);
  const cases = [
    [answering('two-lines', ['process.stdout.write("one\\ntwo\\n");']), 'exit 0, and what it printed is not one line', {}],
    [answering('nothing', []), 'exit 0, and what it printed is not one line', {}],
    [answering('not-json', ['process.stdout.write("pass-1-6\\n");']), 'exit 0, and its line is not JSON', {}],
    [answering('part-of-an-answer', ['process.stdout.write(JSON.stringify({ verdict: "pass-1-6", firstFailingStep: null }) + "\\n");']), 'exit 0, and its line is not the verifier\'s answer', {}],
    [answering('another-file', ['process.stdout.write(JSON.stringify({ file: "/another/file.aep", sha256: null, verdict: "pass-1-6", firstFailingStep: null, notes: ["steps 7 to 10 not run by this verifier"] }) + "\\n");']), 'exit 0, and its line is not the verifier\'s answer', {}],
    [answering('pass-with-exit-1', ['process.stdout.write(JSON.stringify({ file: command[2], sha256: null, verdict: "pass-1-6", firstFailingStep: null, notes: ["steps 7 to 10 not run by this verifier"] }) + "\\n");', 'process.exit(1);']), 'exit 1, and its line is not the verifier\'s answer', {}],
    [answering('exit-2', ['process.stderr.write("aep-verify: the pin cannot be read (ENOENT)\\n");', 'process.exit(2);']), 'exit 2 (aep-verify: the pin cannot be read (ENOENT))', {}],
    [answering('never-answers', ['setInterval(() => {}, 1000);']), 'no answer within the time limit', { timeoutMs: 1500 }],
  ];
  for (const [sandboxArgv, reading, options] of cases) {
    const answer = await offlineCheck(own.runDir, { sandboxArgv, ...options });
    assert.equal(answer.exitCode, 4, reading);
    assert.deepEqual(answer.lines.slice(0, 2), KEY_AND_NETWORK, reading);
    assert.deepEqual(answer.lines.slice(4), [...files.map((file) => `${file}: rejected (no answer of the verifier on it)`), 'result: 0 passed steps 1 to 6, 2 rejected (1 expected)', 'written: offline-check.json'], reading);
    const noAnswer = files.map((file) => ({ file, sha256: null, verdict: 'reject', firstFailingStep: null, notes: [`verifier did not answer: ${reading}`] }));
    assert.deepEqual([...answer.result.records, ...answer.result.tampered], noAnswer, reading);
    assert.deepEqual(answer.result, readJson(resultFile(own.runDir)), reading);
    for (const file of files) assert.ok(answer.notes.includes(`${file}: the verifier did not answer: ${reading}`), reading);
    assert.ok(answer.notes.includes(`${files[0]}: a record under records/ that did not pass steps 1 to 6`), reading);
  }
});

test('the network control, both ways, against a live listener on 127.0.0.1: the probe reads CONNECTED outside the sandbox and EPERM under the profile', { ...NEEDS_SANDBOX, ...LIMIT }, async () => {
  assert.equal(PROFILE, '(version 1) (allow default) (deny network*)');
  assert.equal(CHECK_SANDBOX_EXEC, '/usr/bin/sandbox-exec');
  assert.equal(SANDBOX_EXEC, CHECK_SANDBOX_EXEC);

  // The control as the check runs it, against the check's own listener.
  assert.deepEqual(await networkControl(), { denied: true, listener: '127.0.0.1', outside: 'CONNECTED', inside: 'EPERM', accepted: 1, why: null });

  // The same two runs made here, against a listener this test holds, with
  // the probe's own words read as it wrote them.
  const line = crypto.randomBytes(16).toString('hex');
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    socket.on('error', () => {});
    socket.end(`${line}\n`);
  });
  await new Promise((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  try {
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    const probe = [process.execPath, PROBE, '127.0.0.1', String(port)];
    const outside = await runProgram(probe[0], probe.slice(1));
    assert.deepEqual(outside, { status: 0, stdout: `CONNECTED ${line}\n`, stderr: '' });
    assert.equal(accepted, 1, 'the listener accepted the connection made outside the sandbox');
    const inside = await runProgram(SANDBOX_EXEC, ['-p', PROFILE, ...probe]);
    assert.deepEqual(inside, { status: 1, stdout: 'EPERM\n', stderr: '' });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(accepted, 1, 'nothing reached the listener from under the profile');
    // The listener is still live after the refused connect: the refusal was the sandbox's.
    assert.deepEqual(await runProgram(probe[0], probe.slice(1)), { status: 0, stdout: `CONNECTED ${line}\n`, stderr: '' });
    assert.equal(accepted, 2);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('the probe connects to a loopback address and to nothing else, and says what it read: a refused connect, a listener that says nothing, a line of another shape', { ...LIMIT }, async () => {
  for (const args of [[], ['example.com', '80'], ['10.0.0.1', '80'], ['127.0.0.1'], ['127.0.0.1', '0'], ['127.0.0.1', '70000'], ['127.0.0.1', 'http']]) {
    const ran = await runProgram(process.execPath, [PROBE, ...args]);
    assert.deepEqual({ status: ran.status, stdout: ran.stdout }, { status: 2, stdout: '' }, JSON.stringify(args));
    assert.match(ran.stderr, /^connect-probe: give 127\.0\.0\.1 or ::1, then a port from 1 to 65535\n$/);
  }
  // A port nothing listens on: the listener is closed before the probe runs.
  const closed = net.createServer();
  await new Promise((resolve) => { closed.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const closedPort = closed.address().port;
  await new Promise((resolve) => { closed.close(resolve); });
  assert.deepEqual(await runProgram(process.execPath, [PROBE, '127.0.0.1', String(closedPort)]), { status: 1, stdout: 'ECONNREFUSED\n', stderr: '' });

  // A listener that closes without a line, and one whose line is not 32 hex characters.
  for (const [say, want] of [[null, 'CLOSED\n'], ['hello\n', 'UNEXPECTED\n'], [`${'a'.repeat(31)}g\n`, 'UNEXPECTED\n'], ['x'.repeat(200), 'UNEXPECTED\n']]) {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end(say ?? undefined);
    });
    await new Promise((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
    const ran = await runProgram(process.execPath, [PROBE, '127.0.0.1', String(server.address().port)]);
    await new Promise((resolve) => { server.close(resolve); });
    assert.deepEqual(ran, { status: 1, stdout: want, stderr: '' }, JSON.stringify(say));
  }
});

test('any other reading under the sandbox command is not a pass: a command that is absent, one that applies no profile, one that ends with 71, one that never answers, and a refused connect', { ...LIMIT }, async () => {
  const absent = await networkControl({ sandboxArgv: [path.join(tempDir(), 'no-such-command')] });
  assert.deepEqual({ denied: absent.denied, outside: absent.outside, inside: absent.inside, accepted: absent.accepted }, { denied: false, outside: 'CONNECTED', inside: 'not started (ENOENT)', accepted: 1 });
  assert.match(absent.why, /under the sandbox profile the probe read "not started \(ENOENT\)" and the listener accepted 0 more connection\(s\); it must read EPERM/);

  // The probe runs with no sandbox and reaches the listener a second time.
  const unsandboxed = await networkControl({ sandboxArgv: RUNS_IT_UNSANDBOXED() });
  assert.deepEqual({ denied: unsandboxed.denied, outside: unsandboxed.outside, inside: unsandboxed.inside, accepted: unsandboxed.accepted }, { denied: false, outside: 'CONNECTED', inside: 'CONNECTED', accepted: 2 });
  assert.match(unsandboxed.why, /read "CONNECTED" and the listener accepted 1 more connection\(s\)/);

  const seventyOne = await networkControl({ sandboxArgv: ENDS_WITH_71() });
  assert.deepEqual({ denied: seventyOne.denied, inside: seventyOne.inside, accepted: seventyOne.accepted }, { denied: false, inside: 'exit 71 (stand-in: cannot apply a profile)', accepted: 1 });

  const silent = await networkControl({ sandboxArgv: NEVER_ANSWERS(), timeoutMs: 2500 });
  assert.deepEqual({ denied: silent.denied, inside: silent.inside, accepted: silent.accepted }, { denied: false, inside: 'no answer within the time limit', accepted: 1 });

  // The probe is run against a port nothing listens on, so its connect is refused by the host, not by a sandbox.
  const closed = net.createServer();
  await new Promise((resolve) => { closed.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const closedPort = closed.address().port;
  await new Promise((resolve) => { closed.close(resolve); });
  const elsewhere = standIn('probes-a-closed-port', [
    'import { spawnSync } from "node:child_process";',
    AFTER_PROFILE,
    'const ran = spawnSync(command[0], [command[1], command[2], process.argv[2]], { stdio: "inherit", env: {} });',
    'process.exit(ran.status ?? 1);',
  ], [String(closedPort)]);
  const refused = await networkControl({ sandboxArgv: elsewhere });
  assert.deepEqual({ denied: refused.denied, inside: refused.inside, accepted: refused.accepted }, { denied: false, inside: 'ECONNREFUSED', accepted: 1 });
});

test('when the network denial is not shown the check prints network denied: not measured, ends with 3 and writes no offline-check.json, and no verifier line follows', { ...LIMIT }, async () => {
  const before = stateOf(path.dirname(run.runDir));
  for (const sandboxArgv of [[path.join(tempDir(), 'no-such-command')], RUNS_IT_UNSANDBOXED(), ENDS_WITH_71()]) {
    const printed = [];
    const explained = [];
    const answer = await offlineCheck(run.runDir, { sandboxArgv, print: (line) => printed.push(line), note: (line) => explained.push(line) });
    assert.equal(answer.exitCode, 3);
    assert.deepEqual(answer.lines, ['private key: absent', 'network denied: not measured']);
    assert.deepEqual(printed, answer.lines);
    assert.deepEqual(explained, answer.notes);
    assert.equal(answer.notes.length, 2);
    assert.match(answer.notes[0], /it must read EPERM/);
    assert.equal(answer.notes[1], 'the sandbox was not shown to deny the network, so nothing was checked and nothing was written');
    assert.equal(fs.existsSync(resultFile(run.runDir)), false);
  }
  assert.deepEqual(stateOf(path.dirname(run.runDir)), before);
  assert.equal(LINE.NETWORK_NOT_MEASURED, 'network denied: not measured');
});

test('run inside a process that is already sandboxed, the sandbox command itself ends with 71: the check prints network denied: not measured, exits 3 and writes no offline-check.json', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  const ran = runOfflineCheck([run.runDir], { wrap: [SANDBOX_EXEC, '-p', '(version 1) (allow default)'] });
  assert.equal(ran.status, 3, ran.stderr);
  assert.deepEqual(ran.lines, ['private key: absent', 'network denied: not measured']);
  assert.match(ran.stderr, /^offline-check: under the sandbox profile the probe read "exit 71 \(sandbox-exec: sandbox_apply: Operation not permitted\)" and the listener accepted 0 more connection\(s\); it must read EPERM, and the listener must accept nothing\n/);
  assert.match(ran.stderr, /offline-check: the sandbox was not shown to deny the network, so nothing was checked and nothing was written\n$/);
  assert.equal(fs.existsSync(resultFile(run.runDir)), false);
});

test('the sandbox command and the probe get an empty environment: no variable of this process reaches them', { ...LIMIT }, async () => {
  const seen = path.join(tempDir(), 'environment-names.json');
  const reports = standIn('reports-its-environment', [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    AFTER_PROFILE,
    'const probe = spawnSync(command[0], ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });',
    'fs.writeFileSync(process.argv[2], JSON.stringify({ own: Object.keys(process.env), inherited: JSON.parse(probe.stdout) }));',
    'process.exit(71);',
  ], [seen]);
  assert.ok(Object.keys(process.env).length > 0, 'this process has variables to hand on');
  await networkControl({ sandboxArgv: reports });
  const names = readJson(seen);
  // macOS adds one variable of its own to a process it starts; nothing else is there.
  const allowed = new Set(['__CF_USER_TEXT_ENCODING']);
  assert.deepEqual(names.own.filter((name) => !allowed.has(name)), []);
  assert.deepEqual(names.inherited.filter((name) => !allowed.has(name)), []);
});

test('a run directory that holds a private key ends the check with an error and no result, in whatever form the key is', { ...LIMIT }, () => {
  const held = makeRun();
  writeRun(held.runDir);
  assert.deepEqual(findPrivateKeys(held.runDir), { found: [], unread: [] });

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const passphrase = crypto.randomBytes(12).toString('hex');
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const planted = [
    ['keys/test-signer.pem', pem, 'a PEM block labelled private key'],
    ['actions/deeper/still/key.txt', rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }), 'a PEM block labelled rsa private key'],
    ['keys/ec.pem', ec.privateKey.export({ type: 'sec1', format: 'pem' }), 'a PEM block labelled ec private key'],
    ['keys/locked.pem', rsa.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), 'a PEM block labelled encrypted private key'],
    ['keys/test-signer.der', rsa.privateKey.export({ type: 'pkcs8', format: 'der' }), 'a DER private key'],
    ['keys/ec.der', ec.privateKey.export({ type: 'sec1', format: 'der' }), 'a DER private key'],
    ['keys/locked.der', rsa.privateKey.export({ type: 'pkcs8', format: 'der', cipher: 'aes-256-cbc', passphrase }), 'an encrypted DER private key'],
    ['keys/signer.jwk.json', JSON.stringify(rsa.privateKey.export({ format: 'jwk' })), 'a private JSON Web Key'],
    ['state.json', JSON.stringify({ runId: held.runId, steps: [{ id: 'record', detail: { keys: [ec.privateKey.export({ format: 'jwk' })] } }] }), 'a private JSON Web Key'],
    // A stored archive entry is plain bytes, so a key inside a package is seen too.
    ['records/extra.aep', storeZip([{ name: 'response.txt', data: Buffer.from('{}\n') }, { name: 'signer.pem', data: Buffer.from(pem, 'utf8') }]), 'a PEM block labelled private key'],
  ];
  for (const [file, bytes, kind] of planted) {
    const abs = path.join(held.runDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    assert.deepEqual(findPrivateKeys(held.runDir), { found: [{ file, kind }], unread: [] }, file);
    const ran = runOfflineCheck([held.runDir]);
    assert.equal(ran.status, 1, file);
    assert.deepEqual(ran.lines, ['private key: present'], file);
    assert.equal(ran.stderr, `offline-check: ${file}: ${kind}\noffline-check: a run directory holds public material and no private key, so this run is not checked; a new run gets a new key\n`, file);
    assert.equal(fs.existsSync(resultFile(held.runDir)), false, file);
    fs.rmSync(abs);
  }
  assert.equal(LINE.KEY_PRESENT, 'private key: present');

  // Public material in the same forms is not a private key.
  const publicMaterial = [
    ['keys/other.pub.pem', rsa.publicKey.export({ type: 'spki', format: 'pem' })],
    ['keys/other.pkcs1.pub.pem', rsa.publicKey.export({ type: 'pkcs1', format: 'pem' })],
    ['keys/other.pub.der', rsa.publicKey.export({ type: 'spki', format: 'der' })],
    ['keys/other.pub.jwk.json', JSON.stringify(rsa.publicKey.export({ format: 'jwk' }))],
    ['notes.json', JSON.stringify({ d: 'a member named d with no key type beside it', list: [{ kty: 'RSA' }] })],
  ];
  for (const [file, bytes] of publicMaterial) fs.writeFileSync(path.join(held.runDir, file), bytes);
  assert.deepEqual(findPrivateKeys(held.runDir), { found: [], unread: [] });
  assert.deepEqual(privateKeyKinds(Buffer.alloc(0)), []);
  assert.deepEqual(privateKeyKinds(Buffer.from('{not json')), []);
});

test('what the look cannot read is not read as absent: a symbolic link in the run directory ends the check with an error', { ...LIMIT }, () => {
  const linked = makeRun();
  writeRun(linked.runDir);
  const target = path.join(tempDir(), 'elsewhere.txt');
  fs.writeFileSync(target, 'a file outside the run directory\n');
  fs.symlinkSync(target, path.join(linked.runDir, 'keys', 'link'));
  assert.deepEqual(findPrivateKeys(linked.runDir), { found: [], unread: [{ file: 'keys/link', why: 'not a regular file or a directory' }] });
  const ran = runOfflineCheck([linked.runDir]);
  assert.equal(ran.status, 1);
  assert.deepEqual(ran.lines, ['private key: not ruled out']);
  assert.equal(ran.stderr, 'offline-check: keys/link: not a regular file or a directory\noffline-check: the look for a private key did not cover the whole run directory, so this run is not checked\n');
  assert.equal(fs.existsSync(resultFile(linked.runDir)), false);
  assert.equal(LINE.KEY_NOT_RULED_OUT, 'private key: not ruled out');
});

test('the pin is read from outside the run directory: the check prints its SHA-256, refuses a pin inside the run directory or one that is not a public key, and says so when there is none', { ...NEEDS_SANDBOX, ...LIMIT }, () => {
  const pinned = makeRun();
  writeRun(pinned.runDir);
  const pin = pinFileOf(pinned.runDir);
  const signerSha256 = readJson(path.join(pinned.runDir, MANIFEST_FILE)).signerSha256;
  assert.equal(sha256(fs.readFileSync(pin)), signerSha256);

  // The run directory's own key file is not a pin.
  const inside = runOfflineCheck([pinned.runDir, '--pin', path.join(pinned.runDir, PUBLIC_KEY_FILE)]);
  assert.equal(inside.status, 1);
  assert.deepEqual(inside.lines, []);
  assert.match(inside.stderr, /^offline-check: .*test-signer\.pub\.pem: the pin is held outside the run directory, and a key file inside it is not a pin\n$/);

  // A pin named by the caller, held somewhere else.
  const elsewhere = path.join(tempDir(), 'held.pub.pem');
  fs.copyFileSync(pin, elsewhere);
  const named = runOfflineCheck([pinned.runDir, '--pin', elsewhere]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.lines[3], `pin: sha256 ${signerSha256} (the public key captured when the run started, held outside the run directory)`);

  // A file that holds a private key, and one that is no key, are not pins.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notPublic = path.join(tempDir(), 'not-public.pem');
  fs.writeFileSync(notPublic, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const refused = runOfflineCheck([pinned.runDir, '--pin', notPublic]);
  assert.deepEqual({ status: refused.status, lines: refused.lines }, { status: 1, lines: [] });
  assert.match(refused.stderr, /not-public\.pem: holds a private key, and a pin is a public key\n$/);
  const notKey = path.join(tempDir(), 'not-a-key.pem');
  fs.writeFileSync(notKey, 'not a key\n');
  const unread = runOfflineCheck([pinned.runDir, '--pin', notKey]);
  assert.deepEqual({ status: unread.status, lines: unread.lines }, { status: 1, lines: [] });
  assert.match(unread.stderr, /not-a-key\.pem: not a public key in PEM\n$/);
  const ecPin = path.join(tempDir(), 'ec.pub.pem');
  fs.writeFileSync(ecPin, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
  assert.match(runOfflineCheck([pinned.runDir, '--pin', ecPin]).stderr, /ec\.pub\.pem: not one RSA public key in SPKI PEM\n$/);

  // With no pin held, the check says so, reports nothing about a record and ends with an error.
  fs.rmSync(pin);
  const none = runOfflineCheck([pinned.runDir]);
  assert.equal(none.status, 1, none.stderr);
  assert.deepEqual(none.lines.slice(0, 3), [...KEY_AND_NETWORK, verifierLine()]);
  assert.equal(none.lines[3], `pin: not found (looked outside the run directory, at ${pin})`);
  assert.equal(none.lines.length, 4);
  assert.equal(none.stderr, 'offline-check: the verifier requires the key inside each record to equal the pin, and this run has none, so nothing was checked and nothing was written\n');
});

test('a wrong argument, or a directory that is not a written run, ends with 1 and says why; none of these endings is 0', { ...LIMIT }, () => {
  const statuses = [];
  const usage = (args) => {
    const ran = runOfflineCheck(args);
    statuses.push(ran.status);
    assert.equal(ran.status, 1, JSON.stringify(args));
    assert.deepEqual(ran.lines, [], JSON.stringify(args));
    assert.match(ran.stderr, /^usage: node three-party\/bin\/offline-check\.mjs <runDir> \[--out <file>\] \[--pin <file>\]\n/, JSON.stringify(args));
    assert.match(ran.stderr, /\nexit 0  every record passed steps 1 to 6, every tampered copy was rejected, and the\n/);
    assert.match(ran.stderr, /\nexit 4  the verifier ran and the result is not that; the result is written\n/);
    assert.match(ran.stderr, /\nexit 1  an error: /);
    assert.match(ran.stderr, /\nexit 3  the network denial was not shown: nothing was checked, nothing was written\n$/);
    assert.doesNotMatch(ran.stderr, /exit 2/);
  };
  usage([]);
  usage(['--help']);
  usage(['-h']);
  usage([run.runDir, run.runDir]);
  usage([run.runDir, '--verbose']);
  usage([run.runDir, '--out']);
  usage([run.runDir, '--pin', '--out']);
  usage(['--out', 'result.json']);
  usage(['']);

  const reason = (args, pattern) => {
    const ran = runOfflineCheck(args);
    statuses.push(ran.status);
    assert.equal(ran.status, 1, JSON.stringify(args));
    assert.deepEqual(ran.lines, []);
    assert.match(ran.stderr, pattern);
  };
  reason([path.join(tempDir(), 'absent')], /^offline-check: .*absent: not a directory\n$/);
  reason([path.join(run.runDir, MANIFEST_FILE)], /manifest\.json: not a directory\n$/);
  const unwritten = makeRun();
  reason([unwritten.runDir], /no records\/manifest\.json, so this is not a run whose records are written\n$/);
  reason([tempDir()], /no records\/manifest\.json, so this is not a run whose records are written\n$/);
  assert.equal(statuses.includes(0), false);
  assert.equal(statuses.length, 13);
});

test('the one place the verifier is run from runs it on each record file of a written run and writes nothing; the check starts every program through one spawn call and writes one file, the result', { ...NEEDS_SANDBOX, ...LIMIT }, async () => {
  const before = stateOf(path.dirname(run.runDir));
  const answer = await callVerifier({ runDir: run.runDir, pinFile: pinFileOf(run.runDir), sandboxArgv: [SANDBOX_EXEC], profile: PROFILE });
  assert.deepEqual(Object.keys(answer), ['records', 'tampered', 'findings']);
  assert.deepEqual(answer.records, manifest.records.map((record) => ({ file: record.file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] })));
  assert.deepEqual(answer.tampered, manifest.tampered.map((copy) => ({ file: copy.file, sha256: copy.sha256, verdict: 'reject', firstFailingStep: 3, notes: [STEP_3, NOT_RUN] })));
  assert.deepEqual(answer.findings, []);
  assert.deepEqual(stateOf(path.dirname(run.runDir)), before, 'the run it read is as it was');

  const check = fs.readFileSync(path.join(THREE_PARTY, 'src', 'record', 'check.mjs'), 'utf8');
  const cli = fs.readFileSync(path.join(THREE_PARTY, 'bin', 'offline-check.mjs'), 'utf8');
  // callVerifier is defined once and called from one place.
  assert.equal(check.split('callVerifier(').length - 1, 2);
  assert.match(check, /\nexport async function callVerifier\(/);
  assert.match(check, /= await callVerifier\(/);
  // The check starts three kinds of program: the probe, the sandbox command with the probe, and the sandbox command with the verifier. All go through one spawn call.
  assert.equal(check.split('spawn(').length - 1, 1);
  // The check writes one file, the result, and its command line writes none.
  assert.equal(check.split('writeFileSync(').length - 1, 1);
  assert.match(check, /fs\.writeFileSync\(outFile, /);
  assert.doesNotMatch(check, /appendFile|createWriteStream|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|openSync/, 'check.mjs writes no other file');
  assert.doesNotMatch(cli, /writeFile|appendFile|createWriteStream|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|openSync/, 'offline-check.mjs writes no file');
  for (const [name, source] of [['check.mjs', check], ['offline-check.mjs', cli]]) assert.doesNotMatch(source, /process\.env|console\./, name);
  // The listener is bound to the loopback address and to no other.
  const listens = check.split('\n').filter((line) => line.includes('.listen('));
  assert.equal(listens.length, 1);
  assert.match(listens[0], /host: '127\.0\.0\.1'/);
  // The verifier is one file under src/verifier, and no directory of a verifier is beside src.
  assert.deepEqual(fs.readdirSync(path.join(THREE_PARTY, 'src', 'verifier')), ['aep-verify.mjs']);
  assert.equal(fs.existsSync(path.join(THREE_PARTY, 'verifier')), false);
});
