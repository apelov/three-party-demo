// The package for another computer, made by scripts/three-party/package.sh from
// a clean export of the commit this tree is at. The script is run for real
// here, into a directory of the test's own: it exports the commit, installs
// the dependencies the demo runs on from the lockfile (from the npm cache
// where it has them, else from the registry), and writes the files.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { REPO_ROOT } from './support/engine-helpers.mjs';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'three-party', 'package.sh');
const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The script packages a commit of a branch that is checked out. A tree that
// is not a git clone, or whose HEAD is not on a branch, has nothing to package.
function cannotPackage() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) return 'this tree is not a git clone, so there is no commit to package';
  if (spawnSync('git', ['-C', REPO_ROOT, 'symbolic-ref', '--quiet', 'HEAD']).status !== 0) return 'HEAD is not on a branch, and the bundle is of a branch';
  return false;
}

let out = null;
let made = null;
let sha = null;
let base = null;

before(() => {
  if (cannotPackage()) return;
  out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-package-test-')));
  sha = git('rev-parse', 'HEAD');
  base = `three-party-demo-${sha.slice(0, 7)}`;
  made = spawnSync('/bin/bash', [SCRIPT, '--out', out], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 240000 });
});

after(() => {
  if (out) fs.rmSync(out, { recursive: true, force: true });
});

const listing = () => execFileSync('tar', ['-tzf', path.join(out, `${base}.tar.gz`)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
const member = (name) => execFileSync('tar', ['-xzOf', path.join(out, `${base}.tar.gz`), `three-party-demo/${name}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

test('the package script writes the tarball, the bundle, their hashes and the one command, and nothing else', { skip: cannotPackage() }, () => {
  assert.equal(made.status, 0, `the script ended with ${made.status}: ${made.stderr}`);
  assert.equal(made.stderr, '');
  assert.deepEqual(fs.readdirSync(out).sort(), ['ONE-COMMAND.txt', `${base}.bundle`, `${base}.bundle.sha256`, `${base}.tar.gz`, `${base}.tar.gz.sha256`]);
  for (const name of [`${base}.tar.gz`, `${base}.bundle`]) {
    assert.equal(fs.readFileSync(path.join(out, `${name}.sha256`), 'utf8'), `${sha256(path.join(out, name))}  ${name}\n`, `${name}.sha256 is the hash of ${name}, in the form shasum -c reads`);
  }
  assert.match(made.stdout, new RegExp(`^commit ${sha}$`, 'm'));
  assert.match(made.stdout, /^checks: verifier paths 0, native executables outside node_modules 0, native executables in node_modules 0, git entries 0, run directories 0, key files 0$/m);
});

test('the tarball lists no .git, runs, .pem or TEST-KEY.txt entry, no verifier and no native executable, under one top-level directory', { skip: cannotPackage() }, () => {
  const entries = listing();
  assert.ok(entries.length > 400, `the tarball lists the export and its dependencies (${entries.length} entries)`);
  // The whole listing, read line by line: no line holds one of these, anywhere in its path.
  assert.deepEqual(entries.filter((e) => /\.git|runs|\.pem|TEST-KEY\.txt/.test(e)), []);
  assert.deepEqual(entries.filter((e) => /(^|\/)(\.git|runs|runs\.pins|keys)(\/|$)|\.(pem|key|p12|pfx)$|(^|\/)TEST-KEY\.txt$/.test(e)), []);
  assert.deepEqual(entries.filter((e) => e.includes('three-party/verifier')), []);
  assert.deepEqual(entries.filter((e) => !e.startsWith('three-party-demo/')), [], 'every entry is under three-party-demo/');
  assert.deepEqual(entries.filter((e) => /(^|\/)\._/.test(e)), [], 'no metadata file that the tar of macOS writes');
  assert.deepEqual(entries.filter((e) => e.startsWith('three-party-demo/three-party/stills/')), [], 'the pictures of the example files are left out');

  // What the demo runs on is there: its command line, the screens, the engine, the record writer, the dependencies.
  for (const name of ['package.json', 'package-lock.json', 'three-party/bin/start.mjs', 'three-party/view/index.html', 'three-party/src/engine/run.mjs', 'three-party/src/record/writer.mjs', 'three-party/fixtures/invoices.json', 'fixtures/agents/billpay-agent.atx.json', 'node_modules/@opena2a/atx-verify/package.json', 'node_modules/secretless-ai/package.json', 'three-party/BUILD.txt']) {
    assert.ok(entries.includes(`three-party-demo/${name}`), `the tarball holds ${name}`);
  }
  // The development dependency is not installed: the demo does not run on it.
  assert.deepEqual(entries.filter((e) => e.startsWith('three-party-demo/node_modules/playwright-core/')), []);
});

test('the tarball names its build and its one script; the one command is the two set lines', { skip: cannotPackage() }, () => {
  const build = member('three-party/BUILD.txt').split('\n');
  assert.equal(build[0], `commit ${sha}`);
  assert.match(build[1], /^built \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(build[2], /^node v\d+\.\d+\.\d+$/);
  assert.deepEqual(build.slice(3), ['']);

  assert.equal(JSON.parse(member('package.json')).scripts['three-party'], 'node three-party/bin/start.mjs');
  assert.deepEqual(JSON.parse(member('package.json')), JSON.parse(git('show', `${sha}:package.json`)), 'the packaged package.json is the commit\'s');

  assert.equal(fs.readFileSync(path.join(out, 'ONE-COMMAND.txt'), 'utf8'), [
    `tar -xzf ~/Downloads/${base}.tar.gz -C ~ && cd ~/three-party-demo && npm run three-party`,
    'Needs Node.js 22.12 or later, a browser, and tar and a POSIX shell for the command above; no login, no network.',
    '',
  ].join('\n'));
});

test('the bundle is the branch at the packaged commit', { skip: cannotPackage() }, () => {
  const heads = execFileSync('git', ['-C', REPO_ROOT, 'bundle', 'list-heads', path.join(out, `${base}.bundle`)], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(heads.length, 1);
  assert.equal(heads[0], `${sha} refs/heads/${git('symbolic-ref', '--short', 'HEAD')}`);
});

test('the script refuses a call with no directory to write to, and writes nothing', { skip: cannotPackage() }, () => {
  const r = spawnSync('/bin/bash', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^package\.sh: give the directory the files are written to: --out <directory>\n$/);
  const unknown = spawnSync('/bin/bash', [SCRIPT, '--out', out, '--verbose'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^package\.sh: unknown argument: --verbose\n$/);
});
