// The offline check of one run directory. In this order it:
//
//   1. looks for a private key in the run directory. A run directory holds
//      public material and no private key, so finding one ends the check;
//   2. shows that a method denies the network to the programs it starts.
//      It starts a listener of its own on 127.0.0.1 and runs one probe
//      program twice in the same run: with no method, where the probe must
//      reach that listener, and under the method, where the connect must
//      fail with a reading the method gives (below) and the listener must
//      accept nothing. The methods, for a user with no privileges:
//
//        macOS    sandbox-exec with PROFILE: the connect is refused, EPERM.
//        Linux    a new user and network namespace made by unshare
//                 (util-linux). Its loopback is down, so there is no route
//                 to 127.0.0.1: ENETUNREACH. Where unshare cannot make one
//                 (seccomp in a container, a restriction on user
//                 namespaces), bwrap with / bound read-only, whose
//                 namespace has its own loopback up with nothing listening
//                 on it: ECONNREFUSED. A new network namespace accepts both
//                 readings, as either says the host's loopback is out of
//                 reach.
//        Windows  none: Windows Firewall does not filter loopback traffic,
//                 and an AppContainer launch is not reachable from Node.js
//                 built-ins, so nothing that works without administrator
//                 rights is used.
//
//      The tools are looked for at fixed paths, never through PATH. The
//      first method whose control is decided ends the search, with one of
//      three outcomes. Denied: the verifier runs under that method. Not
//      measured (no method here, none could be applied, or the probe did not
//      reach the listener with no method): the verifier still runs, with no
//      method and an empty environment, and the result says the denial was
//      not measured. Not denied (the probe reached the network under the
//      method meant to deny it): that contradicts the method, and nothing
//      is checked;
//   3. runs the verifier (src/verifier/aep-verify.mjs), once for each record
//      file: the files on disk under records/ and records/tampered/, and the
//      files records/manifest.json names. Each run gets an empty environment,
//      the file and the pin, and answers with one JSON line. The answers are
//      written to offline-check.json.
//
// Exit codes: 0 every record under records/ passed steps 1 to 6, every
// tampered copy was rejected, and the disk and the manifest name the same
// files with the same hashes, whether the network denial was shown or not
// measured (the result says which); 4 the verifier ran and the result is
// not that (a record that did not pass, a tampered copy that was not
// rejected, a file the verifier gave no answer on, or a difference between
// the disk and the manifest); 1 an error (nothing written); 3 the probe
// reached the network under the method meant to deny it (nothing checked,
// nothing written). offline-check.json is written on 0 and on 4, which are
// both results, and on no other ending.
//
// The pin is the public key captured when the run started. It is read from
// outside the run directory (pinFileOf in testkey.mjs, or the path the
// caller names), never from the run directory's own keys/. The verifier
// requires the key inside each package to equal it, so a run with no pin is
// not checked.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinFileOf, pinIsOutside } from './testkey.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// The sandbox profile, given to the sandbox command as text.
export const PROFILE = '(version 1) (allow default) (deny network*)';
// Where the two Linux tools are looked for, in this order. The paths are
// fixed: the check reads no environment variable, so no PATH.
export const UNSHARE_PATHS = Object.freeze(['/usr/bin/unshare', '/bin/unshare']);
export const BWRAP_PATHS = Object.freeze(['/usr/bin/bwrap', '/bin/bwrap']);
export const EXIT = Object.freeze({ ERROR: 1, NETWORK_NOT_DENIED: 3, NOT_AS_EXPECTED: 4 });
export const LINE = Object.freeze({
  KEY_ABSENT: 'private key: absent',
  KEY_PRESENT: 'private key: present',
  KEY_NOT_RULED_OUT: 'private key: not ruled out',
  NETWORK_DENIED: 'network denied: yes',
  // Printed with the reason in parentheses.
  NETWORK_NOT_MEASURED: 'network denied: not measured',
  // Printed with what the probe read in parentheses.
  NETWORK_NOT_DENIED: 'network denied: no',
});
// The values of networkDenied in the result.
const DENIAL_WORD = Object.freeze({ YES: 'yes', NOT_MEASURED: 'not measured' });
const RAN_WITH_NO_METHOD = 'the network denial was not measured, so the verifier runs with no denial method and an empty environment, and the result says network denied: not measured';
const CONTRADICTED = 'the probe reached the network under the method meant to deny it, so nothing was checked and nothing was written';
// The verifier, as offline-check.json names it.
export const VERIFIER = Object.freeze({
  entry: 'three-party/src/verifier/aep-verify.mjs',
  source: 'written for this demo from the format text, steps 1 to 6',
});
export const RESULT_FILE = 'offline-check.json';
export const VERDICT = Object.freeze({ PASS: 'pass-1-6', REJECT: 'reject' });

const PROBE = fileURLToPath(new URL('./connect-probe.mjs', import.meta.url));
const VERIFIER_FILE = fileURLToPath(new URL('../verifier/aep-verify.mjs', import.meta.url));
const MANIFEST = 'records/manifest.json';
// A record file of each list, as the manifest names it and as the listing
// of the run directory gives it: a plain file name in that list's directory.
const RECORD_PATH = Object.freeze({
  records: /^records\/[^/\\]+\.aep$/,
  tampered: /^records\/tampered\/[^/\\]+\.aep$/,
});
const MAX_ENTRIES = 10000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PIN_BYTES = 64 * 1024;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A relative path as the record names give one: with forward slashes on
// every platform.
const portable = (relative) => relative.split(path.sep).join('/');
// Printable ASCII, cut short: what a child wrote is shown, never run.
const plain = (text) => String(text ?? '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 160);

// The armor line of a PEM block and the two words the label of a private
// key holds. Both are put together here from parts, so this file holds no
// armor line and no such label of its own.
const DASHES = '-'.repeat(5);
const PEM_BEGIN = new RegExp(`${DASHES}BEGIN ([A-Z0-9 ]+)${DASHES}`, 'g');
const PRIVATE_LABEL = ['PRIVATE', 'KEY'].join(' ');
const isPrivateLabel = (label) => label.includes(PRIVATE_LABEL);

// True when a parsed JSON value holds, at any depth, an object with a key
// type and a private member: a private JSON Web Key.
function holdsPrivateJwk(value) {
  const pending = [value];
  let visited = 0;
  while (pending.length > 0 && visited < 100000) {
    const item = pending.pop();
    visited += 1;
    if (item === null || typeof item !== 'object') continue;
    if (!Array.isArray(item) && typeof item.kty === 'string' && typeof item.d === 'string') return true;
    for (const member of Array.isArray(item) ? item : Object.values(item)) pending.push(member);
  }
  return false;
}

// The kinds of private key the bytes of one file hold: a PEM block whose
// label holds the private key words (PKCS#8, PKCS#1, SEC1 and encrypted
// PKCS#8 blocks are labelled so), found anywhere in the file, so also in
// an entry of a store-method archive; a DER file that is a PKCS#8, PKCS#1
// or SEC1 private key, encrypted PKCS#8 included; and a JSON file that
// holds a private JSON Web Key. A key in another container (PKCS#12, a
// compressed archive) is outside this look.
export function privateKeyKinds(bytes) {
  const kinds = new Set();
  for (const match of bytes.toString('latin1').matchAll(PEM_BEGIN)) {
    if (isPrivateLabel(match[1])) kinds.add(`a PEM block labelled ${match[1].toLowerCase()}`);
  }
  if (bytes.length >= 16 && bytes[0] === 0x30) {
    for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
      try {
        crypto.createPrivateKey({ key: bytes, format: 'der', type });
        kinds.add('a DER private key');
        break;
      } catch (error) {
        if (error?.code === 'ERR_MISSING_PASSPHRASE') {
          kinds.add('an encrypted DER private key');
          break;
        }
      }
    }
  }
  const lead = bytes.find((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
  if ((lead === 0x7b || lead === 0x5b) && bytes.length <= MAX_JSON_BYTES) {
    try {
      if (holdsPrivateJwk(JSON.parse(bytes.toString('utf8')))) kinds.add('a private JSON Web Key');
    } catch {
      // Not JSON, so not a JSON Web Key.
    }
  }
  return [...kinds];
}

// Looks at every entry under dir. found lists the files that hold a private
// key; unread lists what could not be looked at (an entry that is not a
// regular file or a directory, a file that cannot be read or is too large,
// a tree with too many entries). An empty found says nothing unless unread
// is empty too.
export function findPrivateKeys(dir) {
  const root = path.resolve(dir);
  const found = [];
  const unread = [];
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    let listing = null;
    try {
      listing = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      unread.push({ file: portable(path.relative(root, current)) || '.', why: `cannot be listed (${error.code ?? 'error'})` });
      continue;
    }
    for (const entry of listing) {
      const abs = path.join(current, entry.name);
      const file = portable(path.relative(root, abs));
      entries += 1;
      if (entries > MAX_ENTRIES) {
        unread.push({ file, why: `the directory has more than ${MAX_ENTRIES} entries` });
        return { found, unread };
      }
      if (entry.isDirectory()) {
        pending.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        unread.push({ file, why: 'not a regular file or a directory' });
        continue;
      }
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) {
          unread.push({ file, why: `larger than ${MAX_FILE_BYTES} bytes` });
          continue;
        }
        for (const kind of privateKeyKinds(fs.readFileSync(abs))) found.push({ file, kind });
      } catch (error) {
        unread.push({ file, why: `cannot be read (${error.code ?? 'error'})` });
      }
    }
  }
  const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { found: found.sort(byFile), unread: unread.sort(byFile) };
}

// Runs one program with an empty environment and gives back what it wrote
// and how it ended. A program that outlives the limit is stopped.
function runChild(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(command, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ started: false, code: error.code ?? 'ERROR' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ started: true, timedOut: true, status: null, signal: 'SIGKILL', stdout, stderr });
    }, timeoutMs);
    child.stdout.setEncoding('latin1');
    child.stderr.setEncoding('latin1');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once('error', (error) => settle({ started: false, code: error.code ?? 'ERROR' }));
    child.once('close', (status, signal) => settle({ started: true, timedOut: false, status, signal, stdout, stderr }));
  });
}

// What one run of the probe read, as a word or a short phrase. CONNECTED
// is given when the probe heard this listener's own line and ended with 0,
// and for nothing else.
function readingOf(child, nonce) {
  if (!child.started) return `not started (${plain(child.code)})`;
  if (child.timedOut) return 'no answer within the time limit';
  if (child.signal !== null) return `ended by ${plain(child.signal)}`;
  if (child.status === 0 && child.stdout === `CONNECTED ${nonce}\n`) return 'CONNECTED';
  if (child.stdout.startsWith('CONNECTED')) return 'CONNECTED to something that is not this listener';
  if (child.status === 1 && /^[A-Z][A-Z0-9_]{1,31}\n$/.test(child.stdout)) return child.stdout.trim();
  const said = plain(child.stderr);
  return said === '' ? `exit ${child.status}` : `exit ${child.status} (${said})`;
}

// A method of denying the network: the command and the arguments that come
// before the program it runs (argv), the readings of the probe under it that
// show the denial (accepted), and its words: in the result (words), and in a
// note, for the run under it (under) and the run with no method (outside).
// Each maker takes the command as a list, so a test can put a program of its
// own in that place.
function methodOf(name, argv, { accepted, words, under = words, outside }) {
  return Object.freeze({ name, argv: Object.freeze(argv), accepted, words, under, outside });
}
const NAMESPACE_READINGS = Object.freeze(['ENETUNREACH', 'ECONNREFUSED']);
export function sandboxExecMethod(command = [SANDBOX_EXEC]) {
  return methodOf('sandbox-exec', [...command, '-p', PROFILE], { accepted: Object.freeze(['EPERM']), words: `sandbox-exec profile ${PROFILE}`, under: 'the sandbox profile', outside: 'the sandbox' });
}
const UNSHARE_FLAGS = Object.freeze(['--user', '--map-root-user', '--net']);
export function unshareMethod(command = [UNSHARE_PATHS[0]]) {
  return methodOf('unshare', [...command, ...UNSHARE_FLAGS, '--'], { accepted: NAMESPACE_READINGS, words: `unshare ${UNSHARE_FLAGS.join(' ')}`, outside: 'the namespace' });
}
const BWRAP_FLAGS = Object.freeze(['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--die-with-parent']);
export function bwrapMethod(command = [BWRAP_PATHS[0]]) {
  return methodOf('bwrap', [...command, ...BWRAP_FLAGS, '--'], { accepted: NAMESPACE_READINGS, words: `bwrap ${BWRAP_FLAGS.join(' ')}`, outside: 'the namespace' });
}

// The methods to try on a platform, in order. Where there is none, reason
// says so in a few words, for the printed line, and why in a sentence, for a
// note.
export function methodsFor(platform, { exists = fs.existsSync } = {}) {
  if (platform === 'darwin') return { methods: [sandboxExecMethod()], reason: null, why: null };
  if (platform === 'linux') {
    const unshare = UNSHARE_PATHS.find((file) => exists(file));
    const bwrap = BWRAP_PATHS.find((file) => exists(file));
    const methods = [...(unshare ? [unshareMethod([unshare])] : []), ...(bwrap ? [bwrapMethod([bwrap])] : [])];
    if (methods.length > 0) return { methods, reason: null, why: null };
    return { methods, reason: 'neither unshare nor bwrap is installed', why: `looked for unshare at ${UNSHARE_PATHS.join(' and ')}, and for bwrap at ${BWRAP_PATHS.join(' and ')}` };
  }
  if (platform === 'win32') {
    return {
      methods: [],
      reason: 'no method that works without administrator rights is used on Windows',
      why: 'Windows Firewall does not filter loopback traffic, and an AppContainer launch is not reachable from Node.js built-ins',
    };
  }
  const name = plain(platform);
  return { methods: [], reason: `no method is used on ${name}`, why: `a method is used on macOS (sandbox-exec) and on Linux (unshare, bwrap), and none on ${name}` };
}

// The network control of one method. Its state is denied when, in this one
// call and against this call's own listener on 127.0.0.1, the probe read
// CONNECTED with no method and a reading the method accepts under it, and
// the listener accepted the connection made with no method and no other. It
// is not-denied when under the method the probe read CONNECTED, or the
// listener accepted one more connection: the method ran the probe and the
// probe reached the network. Any other reading is not-measured.
export async function networkControl({ method = sandboxExecMethod(), timeoutMs = 10000 } = {}) {
  const result = { state: 'not-measured', method: method.name, listener: null, outside: null, inside: null, accepted: 0, why: null };
  const nonce = crypto.randomBytes(16).toString('hex');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    result.accepted += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.end(`${nonce}\n`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
  } catch (error) {
    result.why = `the check's own listener did not start on 127.0.0.1 (${plain(error.code)})`;
    return result;
  }
  try {
    const { address, port } = server.address();
    result.listener = address;
    const probe = [process.execPath, PROBE, address, String(port)];

    result.outside = readingOf(await runChild(probe[0], probe.slice(1), timeoutMs), nonce);
    if (result.outside !== 'CONNECTED' || result.accepted !== 1) {
      result.why = `outside ${method.outside} the probe read "${result.outside}" and the listener accepted ${result.accepted} connection(s); it must read CONNECTED, and the listener must accept that one connection`;
      return result;
    }

    const inside = await runChild(method.argv[0], [...method.argv.slice(1), ...probe], timeoutMs);
    // A connect that got through the method is accepted by now.
    await new Promise((resolve) => setImmediate(resolve));
    result.inside = readingOf(inside, nonce);
    const more = result.accepted - 1;
    if (result.inside.startsWith('CONNECTED') || more > 0) {
      result.state = 'not-denied';
    } else if (method.accepted.includes(result.inside)) {
      result.state = 'denied';
      return result;
    }
    result.why = `under ${method.under} the probe read "${result.inside}" and the listener accepted ${more} more connection(s); it must read ${method.accepted.join(' or ')}, and the listener must accept nothing`;
    return result;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// What the check finds about the network. The methods of the platform, or
// the ones given, are tried in order, and the first control that is denied
// or not-denied ends the search. The answer gives the state, the method the
// verifier is run under (null when there is none), the line to print, the
// notes, the network line of the result and its networkDenied (both null
// when not denied, as nothing is written then), and the controls made.
export async function networkDenial({ platform = process.platform, methods = null, timeoutMs = 10000 } = {}) {
  const planned = methods === null ? methodsFor(platform) : { methods, reason: methods.length === 0 ? 'no method was given' : null, why: null };
  const controls = [];
  for (const method of planned.methods) {
    const control = await networkControl({ method, timeoutMs });
    controls.push(control);
    if (control.state === 'denied') {
      return { state: 'denied', method, line: LINE.NETWORK_DENIED, notes: [], network: `denied: ${method.words}; control: ${control.outside} outside, ${control.inside} inside`, networkDenied: DENIAL_WORD.YES, controls };
    }
    if (control.state === 'not-denied') {
      const more = control.accepted - 1;
      const read = `under ${method.name} the probe read ${control.inside}${more > 0 ? `, and the listener accepted ${more} more connection(s)` : ''}`;
      return { state: 'not-denied', method, line: `${LINE.NETWORK_NOT_DENIED} (${read})`, notes: [control.why, CONTRADICTED], network: null, networkDenied: null, controls };
    }
  }
  // Not measured. The reason: none to try, none that could be applied, or
  // no control that reached its own listener with no method.
  const applied = controls.filter((control) => control.inside !== null).map((control) => control.method);
  const reason = planned.reason
    ?? (applied.length > 0 ? `${applied.join(' and ')} could not be applied here`
      : controls[0].listener === null ? 'the check\'s own listener did not start on 127.0.0.1'
        : 'the probe did not reach the check\'s own listener with no method');
  const words = new Map(planned.methods.map((method) => [method.name, method.words]));
  const network = [`not measured: ${reason}`, ...controls.map((control) => `${words.get(control.method)}; control: ${control.outside ?? 'not run'} outside, ${control.inside ?? 'not run'} inside`)].join('; ');
  const notes = [...(planned.why ? [planned.why] : []), ...controls.map((control) => control.why), RAN_WITH_NO_METHOD];
  return { state: 'not-measured', method: null, line: `${LINE.NETWORK_NOT_MEASURED} (${reason})`, notes, network, networkDenied: DENIAL_WORD.NOT_MEASURED, controls };
}

// The pin file's facts, or null when there is no such file. A pin is one
// SPKI public key in PEM, an RSA key, and nothing else: a file that holds a
// private key, or that is not such a key, is refused.
function readPin(pinFile) {
  const stat = fs.statSync(pinFile, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_PIN_BYTES) throw new Error(`${pinFile}: not a pin file`);
  const bytes = fs.readFileSync(pinFile);
  if (privateKeyKinds(bytes).length > 0) throw new Error(`${pinFile}: holds a private key, and a pin is a public key`);
  let key = null;
  try {
    key = crypto.createPublicKey(bytes);
  } catch {
    throw new Error(`${pinFile}: not a public key in PEM`);
  }
  if (key.asymmetricKeyType !== 'rsa' || key.export({ type: 'spki', format: 'pem' }) !== bytes.toString('utf8')) {
    throw new Error(`${pinFile}: not one RSA public key in SPKI PEM`);
  }
  return { file: pinFile, sha256: sha256(bytes) };
}

// The record files of a run, list by list: every file on disk under
// records/ and records/tampered/ whose name ends in .aep, and every file
// records/manifest.json names in its records and tampered lists. Each item
// says where it was found; a file that is in one place and not the other
// stays in the list, so that it is reported. A name of the manifest that is
// not a record file of its list is given back under `stray`, and no
// program is run on it. A manifest that cannot be read names nothing.
function recordFilesOf(runDir) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runDir, MANIFEST), 'utf8'));
  } catch {
    manifest = null;
  }
  const lists = {};
  for (const kind of ['records', 'tampered']) {
    const dir = kind === 'records' ? 'records' : 'records/tampered';
    let listing = [];
    try {
      listing = fs.readdirSync(path.join(runDir, dir), { withFileTypes: true });
    } catch {
      listing = [];
    }
    const found = new Map();
    for (const entry of listing) {
      const file = `${dir}/${entry.name}`;
      if (entry.isFile() && RECORD_PATH[kind].test(file)) found.set(file, { file, onDisk: true, inManifest: false, manifestSha256: null });
    }
    const stray = [];
    for (const item of Array.isArray(manifest?.[kind]) ? manifest[kind] : []) {
      const file = item?.file;
      if (typeof file !== 'string' || !RECORD_PATH[kind].test(file)) {
        stray.push(plain(typeof file === 'string' ? file : JSON.stringify(file) ?? 'no name'));
        continue;
      }
      const known = found.get(file) ?? { file, onDisk: false, inManifest: false, manifestSha256: null };
      known.inManifest = true;
      known.manifestSha256 = typeof item.sha256 === 'string' ? item.sha256 : null;
      found.set(file, known);
    }
    const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    lists[kind] = { files: [...found.values()].sort(byFile), stray };
  }
  return lists;
}

// What one run of the verifier answered about one file: its JSON line as
// an object, or the words for a run that gave no answer. An answer is one
// line that holds the five fields, names the file it was given, and agrees
// with the exit status: 0 with pass-1-6, 1 with reject and the step.
function answerOf(child, file) {
  if (!child.started) return { reading: `not started (${plain(child.code)})` };
  if (child.timedOut) return { reading: 'no answer within the time limit' };
  if (child.signal !== null) return { reading: `ended by ${plain(child.signal)}` };
  const said = plain(child.stderr);
  if (child.status !== 0 && child.status !== 1) return { reading: said === '' ? `exit ${child.status}` : `exit ${child.status} (${said})` };
  // The child's output was read one character per byte; the line is UTF-8.
  const text = Buffer.from(child.stdout, 'latin1').toString('utf8');
  if (!/^[^\n]+\n$/.test(text)) return { reading: `exit ${child.status}, and what it printed is not one line` };
  let answer = null;
  try {
    answer = JSON.parse(text);
  } catch {
    return { reading: `exit ${child.status}, and its line is not JSON` };
  }
  const passed = answer?.verdict === VERDICT.PASS && answer.firstFailingStep === null && child.status === 0;
  const rejected = answer?.verdict === VERDICT.REJECT && [1, 2, 3, 4, 5, 6].includes(answer.firstFailingStep) && child.status === 1;
  const shaped = answer !== null && typeof answer === 'object' && !Array.isArray(answer)
    && Object.keys(answer).join(',') === 'file,sha256,verdict,firstFailingStep,notes'
    && answer.file === file
    && (answer.sha256 === null || /^[0-9a-f]{64}$/.test(answer.sha256))
    && Array.isArray(answer.notes) && answer.notes.length > 0 && answer.notes.every((note) => typeof note === 'string')
    && (passed || rejected);
  return shaped ? { answer } : { reading: `exit ${child.status}, and its line is not the verifier's answer` };
}

// The one place the verifier is run from. It is handed the run directory,
// the pin file, and the command of the method to run under with the
// arguments before its program (prefix; empty when the denial was not
// measured), and it runs the verifier once for each record file, under that
// method, with an empty environment and the time limit. The answer holds, for the records
// and for the tampered copies, one item per file ({ file, sha256, verdict,
// firstFailingStep, notes }), and `findings`: each thing that makes the
// result not as expected whatever the verdicts are (a file on disk that the
// manifest does not name, a file the manifest names that is not on disk, a
// hash that differs from the manifest's, a name of the manifest that is not
// a record file, a file the verifier gave no answer on, a record in the early
// response form). A finding is also
// the leading note of its file.
// The verifier's note, word for word, on a package in the format's early
// response form: canonical.bin is response.txt alone, so metadata.json is
// not bound by the signature. The format allows that form; this writer writes
// only the profile form, so a record of a run in the early form is a finding:
// its decision and reason could have been edited after signing.
const EARLY_FORM_NOTE = 'step 3: early response form (response.txt alone); metadata is not signature-bound';
const EARLY_FORM_FINDING = 'in the early response form, in which metadata.json is not bound by the signature; this writer writes only the profile form';

export async function callVerifier({ runDir, pinFile, prefix = [], timeoutMs = 10000 }) {
  const lists = recordFilesOf(runDir);
  const result = { records: [], tampered: [], findings: [] };
  const finding = (item, what) => {
    result.findings.push({ file: item.file, what });
    item.notes.unshift(`offline check: ${what}`);
  };
  for (const kind of ['records', 'tampered']) {
    for (const { file, onDisk, inManifest, manifestSha256 } of lists[kind].files) {
      const target = path.join(runDir, file);
      const argv = [...prefix, process.execPath, VERIFIER_FILE, target, '--pin', pinFile];
      const child = await runChild(argv[0], argv.slice(1), timeoutMs);
      const { answer, reading } = answerOf(child, target);
      const item = answer
        ? { file, sha256: answer.sha256, verdict: answer.verdict, firstFailingStep: answer.firstFailingStep, notes: [...answer.notes] }
        : { file, sha256: null, verdict: VERDICT.REJECT, firstFailingStep: null, notes: [`verifier did not answer: ${reading}`] };
      if (!answer) result.findings.push({ file, what: `the verifier did not answer: ${reading}` });
      if (onDisk && inManifest && item.sha256 !== null && item.sha256 !== manifestSha256) {
        finding(item, manifestSha256 === null ? `${MANIFEST} gives no SHA-256 for it` : `its SHA-256 differs from the one ${MANIFEST} gives`);
      }
      if (kind === 'records' && answer && answer.notes.includes(EARLY_FORM_NOTE)) finding(item, EARLY_FORM_FINDING);
      if (!onDisk) finding(item, `named in ${MANIFEST} and not on disk`);
      if (!inManifest) finding(item, `on disk and not named in ${MANIFEST}`);
      result[kind].push(item);
    }
    for (const name of lists[kind].stray) {
      const item = { file: name, sha256: null, verdict: VERDICT.REJECT, firstFailingStep: null, notes: [] };
      finding(item, `named in the ${kind} list of ${MANIFEST}, and not a record file of that list; the verifier was not run on it`);
      result[kind].push(item);
    }
  }
  return result;
}

// Runs the check. print gets each line of the result as it is known, and
// note gets each line that explains an ending or a finding. The methods are
// those of platform, or the ones given. The answer is
// { exitCode, lines, notes, result }; exitCode is 0 or one of EXIT, and
// result is the object written to offline-check.json, or null when nothing
// was written.
export async function offlineCheck(runDir, { out = null, pinFile = null, print = () => {}, note = () => {}, platform = process.platform, methods = null, timeoutMs = 10000 } = {}) {
  const lines = [];
  const notes = [];
  const say = (line) => {
    lines.push(line);
    print(line);
  };
  const explain = (line) => {
    notes.push(line);
    note(line);
  };
  const end = (exitCode) => ({ exitCode, lines, notes, result: null });

  // What was asked for.
  if (typeof runDir !== 'string' || runDir === '') {
    explain('no run directory was given');
    return end(EXIT.ERROR);
  }
  const abs = path.resolve(runDir);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    explain(`${runDir}: not a directory`);
    return end(EXIT.ERROR);
  }
  if (!fs.statSync(path.join(abs, 'records', 'manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    explain(`${runDir}: no records/manifest.json, so this is not a run whose records are written`);
    return end(EXIT.ERROR);
  }
  const pin = path.resolve(pinFile ?? pinFileOf(abs));
  if (!pinIsOutside(abs, pin)) {
    explain(`${pin}: the pin is held outside the run directory, and a key file inside it is not a pin`);
    return end(EXIT.ERROR);
  }
  let pinned = null;
  try {
    pinned = readPin(pin);
  } catch (error) {
    explain(error.message);
    return end(EXIT.ERROR);
  }
  const outFile = path.resolve(out ?? path.join(abs, 'offline-check.json'));

  // 1. The look for a private key.
  const look = findPrivateKeys(abs);
  if (look.found.length > 0) {
    say(LINE.KEY_PRESENT);
    for (const { file, kind } of look.found) explain(`${file}: ${kind}`);
    explain('a run directory holds public material and no private key, so this run is not checked; a new run gets a new key');
    return end(EXIT.ERROR);
  }
  if (look.unread.length > 0) {
    say(LINE.KEY_NOT_RULED_OUT);
    for (const { file, why } of look.unread) explain(`${file}: ${why}`);
    explain('the look for a private key did not cover the whole run directory, so this run is not checked');
    return end(EXIT.ERROR);
  }
  say(LINE.KEY_ABSENT);

  // 2. The network control.
  const denial = await networkDenial({ platform, methods, timeoutMs });
  say(denial.line);
  for (const line of denial.notes) explain(line);
  if (denial.state === 'not-denied') return end(EXIT.NETWORK_NOT_DENIED);

  // 3. The verifier. Its file is hashed before it is run and again after,
  //    so the hash reported is of the bytes that ran.
  const verifierSha256 = () => {
    try {
      return sha256(fs.readFileSync(VERIFIER_FILE));
    } catch {
      return null;
    }
  };
  const ranAs = verifierSha256();
  if (ranAs === null) {
    explain('the verifier file cannot be read, so nothing was checked and nothing was written');
    return end(EXIT.ERROR);
  }
  say(`verifier: aep-verify.mjs sha256 ${ranAs}`);
  say(pinned
    ? `pin: sha256 ${pinned.sha256} (the public key captured when the run started, held outside the run directory)`
    : `pin: not found (looked outside the run directory, at ${pin})`);
  if (!pinned) {
    explain('the verifier requires the key inside each record to equal the pin, and this run has none, so nothing was checked and nothing was written');
    return end(EXIT.ERROR);
  }
  const answer = await callVerifier({ runDir: abs, pinFile: pinned.file, prefix: denial.method?.argv ?? [], timeoutMs });
  if (verifierSha256() !== ranAs) {
    explain('the verifier file changed while the check ran, so nothing is reported and nothing was written');
    return end(EXIT.ERROR);
  }
  const checked = [...answer.records, ...answer.tampered];
  if (checked.length === 0) {
    explain(`${runDir}: no record file under records/ and none named in ${MANIFEST}, so nothing was checked and nothing was written`);
    return end(EXIT.ERROR);
  }
  for (const item of checked) {
    if (item.verdict === VERDICT.PASS) say(`${item.file}: ${VERDICT.PASS}`);
    else say(item.firstFailingStep === null ? `${item.file}: rejected (no answer of the verifier on it)` : `${item.file}: rejected at step ${item.firstFailingStep}`);
  }
  const summary = {
    pass: checked.filter((item) => item.verdict === VERDICT.PASS).length,
    reject: checked.filter((item) => item.verdict === VERDICT.REJECT).length,
    expectedRejects: answer.tampered.length,
  };
  say(`result: ${summary.pass} passed steps 1 to 6, ${summary.reject} rejected (${summary.expectedRejects} expected)`);

  // The result file, in the order of its fields. `pin` is the path of the
  // pin the check read, from the directory that holds the run directory.
  // networkDenied, added after summary, is yes or not measured.
  const result = {
    runId: path.basename(abs),
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    verifier: { entry: VERIFIER.entry, sha256: ranAs, source: VERIFIER.source },
    pin: portable(path.relative(path.dirname(abs), pinned.file)),
    pinSha256: pinned.sha256,
    network: denial.network,
    records: answer.records,
    tampered: answer.tampered,
    summary,
    networkDenied: denial.networkDenied,
  };
  const replaced = fs.existsSync(outFile);
  try {
    fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    explain(`${outFile}: the result could not be written (${plain(error.code)})`);
    return end(EXIT.ERROR);
  }
  say(`written: ${out ?? RESULT_FILE}`);
  if (replaced) explain(`${outFile} was there before this check, and this check's result replaced it`);

  // What makes the result not as expected, each named.
  const notPassed = answer.records.filter((item) => item.verdict !== VERDICT.PASS);
  const notRejected = answer.tampered.filter((item) => item.verdict !== VERDICT.REJECT);
  for (const item of notPassed) explain(`${item.file}: a record under records/ that did not pass steps 1 to 6`);
  for (const item of notRejected) explain(`${item.file}: a tampered copy that was not rejected`);
  for (const { file, what } of answer.findings) explain(`${file}: ${what}`);
  const asExpected = notPassed.length === 0 && notRejected.length === 0 && answer.findings.length === 0;
  return { ...end(asExpected ? 0 : EXIT.NOT_AS_EXPECTED), result };
}
