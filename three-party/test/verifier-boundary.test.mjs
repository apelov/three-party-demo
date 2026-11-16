// The boundary of the verifier: it is one tracked file that imports node:
// modules and nothing else, no verifier directory stands beside src, the
// offline check runs it from one place, and run by the check under the
// sandbox profile with an empty environment it answers for a written run.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { callVerifier, PROFILE, VERIFIER } from '../src/record/check.mjs';
import { pinFileOf } from '../src/record/testkey.mjs';
import { MANIFEST_FILE, writeRun } from '../src/record/writer.mjs';
import { makeRun, NEEDS_SANDBOX, readJson, removeTempDirs, SANDBOX_EXEC, sha256, tempDir, THREE_PARTY } from './record-support.mjs';
import { NOT_RUN, VERIFIER as VERIFIER_FILE } from './verifier-support.mjs';

after(removeTempDirs);

const REPO_ROOT = path.resolve(THREE_PARTY, '..');
const ENTRY = 'three-party/src/verifier/aep-verify.mjs';
const source = () => fs.readFileSync(VERIFIER_FILE, 'utf8');
const lsFiles = (dir) => execFileSync('git', ['-C', REPO_ROOT, 'ls-files', dir], { encoding: 'utf8' }).split('\n').filter((line) => line !== '');

// The tracked files are read from git. A copy of the tree that is not a git
// clone has none to list.
const notAClone = () => (spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() === REPO_ROOT
  ? false
  : 'this tree is not a git clone, so there are no tracked files to list');

test('the verifier is one tracked file, three-party/src/verifier/aep-verify.mjs, and no path under three-party/verifier is tracked or on disk', { skip: notAClone() }, () => {
  assert.deepEqual(lsFiles('three-party/src/verifier'), [ENTRY]);
  assert.deepEqual(lsFiles('three-party/verifier'), []);
  assert.equal(fs.existsSync(path.join(THREE_PARTY, 'verifier')), false);
  assert.deepEqual(fs.readdirSync(path.join(THREE_PARTY, 'src', 'verifier')), ['aep-verify.mjs']);
  assert.equal(path.join(REPO_ROOT, ENTRY), VERIFIER_FILE);
  assert.equal(VERIFIER.entry, ENTRY, 'the path the result file names is the file the check runs');
});

test('every import of the verifier names a node: module, and the file reads no environment variable, opens no socket, starts no program and writes no file', () => {
  const text = source();
  const specifiers = [
    ...[...text.matchAll(/^\s*import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ];
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.ok(specifier.startsWith('node:'), specifier);
  assert.deepEqual([...new Set(specifiers)].sort(), ['node:crypto', 'node:fs', 'node:zlib']);
  // No import that is computed, so the list above is the whole list.
  assert.doesNotMatch(text, /\bimport\s*\(\s*[^'")\s]/);
  assert.doesNotMatch(text, /process\.env|\bfetch\s*\(|child_process|node:net|node:http|node:https|node:dns|node:dgram|node:tls|node:worker_threads/);
  assert.doesNotMatch(text, /writeFile|appendFile|createWriteStream|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|openSync/);
  // The files it reads are the two its arguments name.
  assert.equal(text.split('fs.readFileSync(').length - 1, 1);
  assert.equal(text.split('fs.statSync(').length - 1, 1);
  // One function per step.
  for (const n of [1, 2, 3, 4, 5, 6]) assert.equal(text.split(`\nfunction step${n}(pkg) {`).length - 1, 1, `step${n}`);
  assert.match(text, /\nconst STEPS = Object\.freeze\(\[step1, step2, step3, step4, step5, step6\]\);\n/);
  assert.doesNotMatch(text, /function step[07-9]/);
});

test('the example result is a result of this tree: it names the verifier by the hash of the file as it is here, in the fields and the words a run writes', () => {
  const example = readJson(path.join(THREE_PARTY, 'examples', 'offline-check.json'));
  assert.deepEqual(Object.keys(example), ['runId', 'at', 'verifier', 'pin', 'pinSha256', 'network', 'records', 'tampered', 'summary']);
  assert.deepEqual(example.verifier, { entry: VERIFIER.entry, sha256: sha256(fs.readFileSync(VERIFIER_FILE)), source: VERIFIER.source });
  assert.match(example.runId, /^clean-[0-9]{8}T[0-9]{6}Z$/);
  assert.equal(example.pin, `../runs.pins/${example.runId}.pub.pem`);
  assert.equal(example.network, `denied: sandbox-exec profile ${PROFILE}; control: CONNECTED outside, EPERM inside`);
  for (const item of [...example.records, ...example.tampered]) {
    assert.deepEqual(Object.keys(item), ['file', 'sha256', 'verdict', 'firstFailingStep', 'notes']);
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.equal(item.notes.at(-1), NOT_RUN);
  }
  assert.deepEqual(example.records.map((item) => [item.verdict, item.firstFailingStep]), example.records.map(() => ['pass-1-6', null]));
  assert.deepEqual(example.tampered.map((item) => [item.verdict, item.firstFailingStep]), [['reject', 3]]);
  assert.deepEqual(example.summary, { pass: example.records.length, reject: 1, expectedRejects: 1 });
  // The records it names are the ones the example manifest names.
  const manifest = readJson(path.join(THREE_PARTY, 'examples', 'manifest.json'));
  assert.deepEqual(example.records.map((item) => item.file), manifest.records.map((item) => item.file));
  assert.deepEqual(example.tampered.map((item) => item.file), manifest.tampered.map((item) => item.file));
});

test('the offline check runs the verifier from one place: callVerifier( stands twice in check.mjs, its definition and its call', () => {
  const check = fs.readFileSync(path.join(THREE_PARTY, 'src', 'record', 'check.mjs'), 'utf8');
  assert.equal(check.split('callVerifier(').length - 1, 2);
  assert.equal(check.split('VERIFIER_FILE').length - 1, 3, 'the path of the verifier file is set once and read twice: to hash it and to run it');
  for (const other of ['engine/api.mjs', 'engine/records.mjs', 'engine/run.mjs']) {
    assert.doesNotMatch(fs.readFileSync(path.join(THREE_PARTY, 'src', other), 'utf8'), /aep-verify|callVerifier/, other);
  }
});

test('run by the check under the sandbox profile with an empty environment, the verifier answers for each record of a written run', { ...NEEDS_SANDBOX, timeout: 120000 }, async () => {
  const run = makeRun();
  writeRun(run.runDir);
  const manifest = readJson(path.join(run.runDir, MANIFEST_FILE));

  // In the place of the sandbox command: a program that writes down the
  // arguments and the environment it was started with, and the environment
  // a program started the same way gets, then runs the command it was given
  // under the real sandbox command and the profile it was given.
  const seen = path.join(tempDir(), 'seen.jsonl');
  const witness = path.join(tempDir(), 'witness.mjs');
  fs.writeFileSync(witness, [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'const at = process.argv.indexOf("-p");',
    'const profile = process.argv[at + 1];',
    'const command = process.argv.slice(at + 2);',
    'const child = spawnSync(command[0], ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });',
    'fs.appendFileSync(process.argv[2], JSON.stringify({ profile, command, own: Object.keys(process.env), inherited: JSON.parse(child.stdout) }) + "\\n");',
    `const ran = spawnSync(${JSON.stringify(SANDBOX_EXEC)}, ["-p", profile, ...command], { stdio: "inherit", env: {} });`,
    'process.exit(ran.status ?? 1);',
    '',
  ].join('\n'));

  assert.ok(Object.keys(process.env).length > 0, 'this process has variables to hand on');
  const pin = pinFileOf(run.runDir);
  const answer = await callVerifier({ runDir: run.runDir, pinFile: pin, sandboxArgv: [process.execPath, witness, seen], profile: PROFILE });
  assert.deepEqual(answer.findings, []);
  assert.deepEqual(answer.records, manifest.records.map((record) => ({ file: record.file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] })));
  assert.deepEqual(answer.tampered.map((copy) => ({ file: copy.file, verdict: copy.verdict, firstFailingStep: copy.firstFailingStep })), manifest.tampered.map((copy) => ({ file: copy.file, verdict: 'reject', firstFailingStep: 3 })));

  // One run of the verifier per record file, each under the profile, each
  // given the file and the pin and nothing else, each with no variable of
  // this process.
  const runs = fs.readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const files = [...manifest.records, ...manifest.tampered].map((item) => path.join(run.runDir, item.file));
  assert.deepEqual(runs.map((r) => r.command), files.map((file) => [process.execPath, VERIFIER_FILE, file, '--pin', pin]));
  // macOS adds one variable of its own to a process it starts; nothing else is there.
  const allowed = new Set(['__CF_USER_TEXT_ENCODING']);
  for (const r of runs) {
    assert.equal(r.profile, '(version 1) (allow default) (deny network*)');
    assert.deepEqual(r.own.filter((name) => !allowed.has(name)), []);
    assert.deepEqual(r.inherited.filter((name) => !allowed.has(name)), []);
  }
});

test('under the profile the verifier cannot reach a listener on 127.0.0.1 that a program outside the sandbox reaches, and it still answers', { ...NEEDS_SANDBOX, timeout: 120000 }, async () => {
  // The same control the check makes, with the verifier's own run beside it:
  // node, started as the check starts the verifier, is refused the connect.
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    socket.on('error', () => {});
    socket.end('heard\n');
  });
  await new Promise((resolve) => { server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  try {
    const { port } = server.address();
    const connect = `const s = require("node:net").connect({ host: "127.0.0.1", port: ${port} }); s.on("connect", () => { process.stdout.write("CONNECTED\\n"); s.destroy(); }); s.on("error", (e) => { process.stdout.write(e.code + "\\n"); });`;
    const run = (argv) => new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.once('close', (status) => resolve({ status, stdout }));
    });
    assert.deepEqual(await run([process.execPath, '-e', connect]), { status: 0, stdout: 'CONNECTED\n' });
    assert.equal(accepted, 1);
    assert.deepEqual(await run([SANDBOX_EXEC, '-p', PROFILE, process.execPath, '-e', connect]), { status: 0, stdout: 'EPERM\n' });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.equal(accepted, 1, 'nothing reached the listener from under the profile');

    // Under the same profile the verifier reads its two files and answers.
    const written = makeRun();
    writeRun(written.runDir);
    const record = readJson(path.join(written.runDir, MANIFEST_FILE)).records[0];
    const file = path.join(written.runDir, record.file);
    const answered = await run([SANDBOX_EXEC, '-p', PROFILE, process.execPath, VERIFIER_FILE, file, '--pin', pinFileOf(written.runDir)]);
    assert.equal(answered.status, 0);
    assert.deepEqual(JSON.parse(answered.stdout), { file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});
