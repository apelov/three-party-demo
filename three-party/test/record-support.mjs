// Shared by the record tests: a run directory built in a temp directory from
// the shape of examples/action-05-pay.action.json, readers that go through
// /usr/bin/unzip (so a package is read back by a tool that is not the writer
// under test), a runner for the offline check, and a look for private keys
// that does not use the check's own. Every key these tests use is generated
// while the test runs; none is stored here, and no key text is printed (key
// bytes are compared with boolean assertions, so a failure prints no value).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { networkDenial } from '../src/record/check.mjs';

export const THREE_PARTY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OFFLINE_CHECK = path.join(THREE_PARTY, 'bin', 'offline-check.mjs');
export const UNZIP = '/usr/bin/unzip';
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// The method of denying the network that applies on the platform the tests
// run on, found apart from the check, the way a person would check it by
// hand: each command is run once on a Node.js program that does nothing,
// and the first that runs it is the method. macOS: sandbox-exec, which
// cannot apply a profile inside a process that is already sandboxed. Linux:
// unshare, then bwrap; each needs the kernel and the container to allow a
// user namespace to a user without privileges (Docker's default seccomp
// profile does not). Windows and any other platform: none. The tests that
// need a method are skipped where none applies, and say why.
const LINUX_METHODS = Object.freeze([
  ['unshare', ['/usr/bin/unshare', '/bin/unshare'], ['--user', '--map-root-user', '--net', '--']],
  ['bwrap', ['/usr/bin/bwrap', '/bin/bwrap'], ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--die-with-parent', '--']],
]);
const runsNode = (argv) => spawnSync(argv[0], [...argv.slice(1), process.execPath, '-e', ''], { env: {}, timeout: 30000 }).status === 0;
function methodHere() {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(SANDBOX_EXEC)) return { method: null, argv: null, skip: `needs ${SANDBOX_EXEC} (macOS), and it is not there` };
    const argv = [SANDBOX_EXEC, '-p', '(version 1) (allow default) (deny network*)'];
    return runsNode(argv) ? { method: 'sandbox-exec', argv, skip: null } : { method: null, argv: null, skip: `${SANDBOX_EXEC} cannot apply a profile here; a process that is already sandboxed cannot` };
  }
  if (process.platform === 'linux') {
    const found = [];
    for (const [method, places, flags] of LINUX_METHODS) {
      const at = places.find((place) => fs.existsSync(place));
      if (!at) continue;
      found.push(method);
      if (runsNode([at, ...flags])) return { method, argv: [at, ...flags], skip: null };
    }
    return {
      method: null,
      argv: null,
      skip: found.length === 0
        ? 'needs unshare or bwrap to deny the network (Linux), and neither is installed'
        : `needs ${found.join(' or ')} to create a network namespace, and this system does not let ${found.length > 1 ? 'either' : 'it'} (for example Docker's default seccomp profile, or a restriction on user namespaces)`,
    };
  }
  return { method: null, argv: null, skip: `needs a method of denying the network, and none is used on ${process.platform}` };
}
export const HERE = Object.freeze(methodHere());
export const NEEDS_DENIAL = HERE.method === null ? { skip: HERE.skip } : {};

// The reading of the probe under each method, measured: the sandbox
// refuses the connect; the new namespace of unshare has its loopback down,
// so there is no route to 127.0.0.1; the one of bwrap has its own loopback
// up with nothing listening on it. And the result's network line each
// method gives when the control shows the denial.
export const INSIDE_OF = Object.freeze({ 'sandbox-exec': 'EPERM', unshare: 'ENETUNREACH', bwrap: 'ECONNREFUSED' });
export const NETWORK_OF = Object.freeze({
  'sandbox-exec': 'denied: sandbox-exec profile (version 1) (allow default) (deny network*); control: CONNECTED outside, EPERM inside',
  unshare: 'denied: unshare --user --map-root-user --net; control: CONNECTED outside, ENETUNREACH inside',
  bwrap: 'denied: bwrap --unshare-user --unshare-net --ro-bind / / --die-with-parent; control: CONNECTED outside, ECONNREFUSED inside',
});

// What the check itself decides about the network here, asked once: the
// line it prints, the notes it adds, and the two fields of its result. It
// must agree with HERE: the denial of the method found above where there is
// one, and not measured where there is none.
let decided = null;
export function denialHere() {
  decided ??= networkDenial().then((denial) => {
    if (HERE.method === null) {
      assert.equal(denial.state, 'not-measured', `no method applies here (${HERE.skip}), so the check measures no denial`);
      assert.equal(denial.networkDenied, 'not measured');
      assert.match(denial.line, /^network denied: not measured \(.+\)$/);
      assert.match(denial.network, /^not measured: /);
      assert.ok(denial.notes.length >= 2, 'the notes say why, and that the verifier runs with no method');
    } else {
      assert.deepEqual({ state: denial.state, method: denial.method?.name, line: denial.line, notes: denial.notes, network: denial.network, networkDenied: denial.networkDenied },
        { state: 'denied', method: HERE.method, line: 'network denied: yes', notes: [], network: NETWORK_OF[HERE.method], networkDenied: 'yes' });
    }
    return denial;
  });
  return decided;
}

// A sandbox that lets a process write under one directory and nowhere else:
// sandbox-exec with a file-write profile on macOS, and bwrap with the root
// bound read-only and that one directory bound writable on Linux. The
// answer is the command to put before the program and the code the
// writer's earliest write, a recursive mkdirSync of the pins directory,
// fails with: EPERM under the profile; ENOENT under bwrap, where mkdir
// fails with EROFS and Node.js then reports the stat of the directory it
// could not make. It is null where neither applies here.
export function writeSandbox(root) {
  if (HERE.method === 'sandbox-exec') {
    return { argv: [SANDBOX_EXEC, '-p', `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}))`], refusal: 'EPERM' };
  }
  if (process.platform !== 'linux') return null;
  const at = LINUX_METHODS[1][1].find((place) => fs.existsSync(place));
  const argv = at ? [at, '--unshare-user', '--ro-bind', '/', '/', '--bind', root, root, '--die-with-parent', '--'] : null;
  return argv && runsNode(argv) ? { argv, refusal: 'ENOENT' } : null;
}
export const NEEDS_WRITE_SANDBOX = writeSandbox(os.tmpdir()) ? {} : { skip: 'needs a sandbox that limits where a process writes: sandbox-exec that applies here (macOS), or bwrap that can create a user namespace here (Linux)' };

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const EXAMPLE_ACTION = readJson(path.join(THREE_PARTY, 'examples', 'action-05-pay.action.json'));

const made = [];
export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-record-'));
  made.push(dir);
  return dir;
}
export function removeTempDirs() {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// The response bodies of the two actions a test run holds.
export const BODIES = Object.freeze({
  intent: '{"result":"match","calls":1}\n',
  pay: '{"paymentId":"PAY-0001","status":"accepted","amount":"148.20","currency":"USD","payeeAccount":"0000-2201"}\n',
});

// Writes actions/NN-<step>.action.json and the response file beside it. The
// action is the example's shape with the fields of this action laid over it.
export function writeAction(runDir, { seq, step, body, over = {} }) {
  const stem = `${String(seq).padStart(2, '0')}-${step}`;
  const bodyFile = `${stem}.response.txt`;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  fs.mkdirSync(path.join(runDir, 'actions'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'actions', bodyFile), bytes);
  const action = {
    ...EXAMPLE_ACTION,
    runId: path.basename(runDir),
    seq,
    step,
    ...over,
    response: { status: 200, bodySha256: sha256(bytes), bodyFile, ...(over.response ?? {}) },
  };
  fs.writeFileSync(path.join(runDir, 'actions', `${stem}.action.json`), `${JSON.stringify(action, null, 2)}\n`);
  return `actions/${stem}.action.json`;
}

export const INTENT_ACTION = Object.freeze({
  seq: 4,
  step: 'intent',
  body: BODIES.intent,
  over: { at: '2026-11-15T12:00:31Z', toolCall: null, reason: 'the tool call equals the declared intent field for field' },
});
export const PAY_ACTION = Object.freeze({ seq: 5, step: 'pay', body: BODIES.pay, over: { response: { status: 201 } } });

// A run directory <temp>/<runId>/ holding the action files given: by
// default an intent action and a pay action. The pin of such a run is held
// in <temp>/.pins/, so everything a run leaves is inside its temp directory.
export function makeRun({ kind = 'clean', actions = [INTENT_ACTION, PAY_ACTION] } = {}) {
  const runId = `${kind}-20261115T120000Z`;
  const runDir = path.join(tempDir(), runId);
  fs.mkdirSync(runDir);
  for (const action of actions) writeAction(runDir, action);
  return { runDir, runId };
}

// The entries unzip -l lists: [{ length, name }] in archive order.
export function listEntries(file) {
  const lines = execFileSync(UNZIP, ['-l', file], { encoding: 'utf8' }).split('\n');
  const rules = lines.flatMap((line, i) => (/^-{5,}/.test(line.trim()) ? [i] : []));
  if (rules.length !== 2) throw new Error(`unzip -l ${file}: no entry table`);
  return lines.slice(rules[0] + 1, rules[1]).map((line) => {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    return { length: Number(match[1]), name: match[2] };
  });
}

// One entry's bytes, read by unzip, which also checks the entry's CRC-32.
export function readEntry(file, name) {
  return execFileSync(UNZIP, ['-p', file, name], { maxBuffer: 128 * 1024 * 1024 });
}

// Every regular file under dir, as paths relative to it, sorted.
export function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(path.relative(dir, abs));
    }
  };
  walk(dir);
  return out.sort();
}

// True when node:crypto reads the bytes as a private key, as PEM or as DER.
// An encrypted key counts: node:crypto then stops to ask for a passphrase,
// which it reports with one of the two codes below. This is the tests' own
// look, apart from the one the offline check makes.
const ASKS_FOR_A_PASSPHRASE = new Set(['ERR_MISSING_PASSPHRASE', 'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED']);
export function parsesAsPrivateKey(bytes) {
  const attempts = [() => crypto.createPrivateKey(bytes)];
  for (const type of ['pkcs8', 'pkcs1', 'sec1']) attempts.push(() => crypto.createPrivateKey({ key: bytes, format: 'der', type }));
  return attempts.some((attempt) => {
    try {
      attempt();
      return true;
    } catch (error) {
      return ASKS_FOR_A_PASSPHRASE.has(error?.code);
    }
  });
}

// The files under dir that node:crypto reads as a private key.
export function privateKeyFilesUnder(dir) {
  return filesUnder(dir).filter((file) => parsesAsPrivateKey(fs.readFileSync(path.join(dir, file))));
}

// Runs the offline check as a program with an empty environment. The answer
// gives its exit status, the lines of its standard output, and its standard
// error as text.
export function runOfflineCheck(args, { wrap = [] } = {}) {
  const argv = [...wrap, process.execPath, OFFLINE_CHECK, ...args];
  const ran = spawnSync(argv[0], argv.slice(1), { env: {}, encoding: 'utf8', timeout: 60000 });
  return { status: ran.status, signal: ran.signal, lines: (ran.stdout ?? '').split('\n').filter((line) => line !== ''), stderr: ran.stderr ?? '' };
}
