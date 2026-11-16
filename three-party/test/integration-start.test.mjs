// The command line of the integrated demo: started with no option it serves
// the screens and the run API and prints three lines; --serve starts the
// same listener with options; text mode prints the offline check when asked;
// and the build each of them names comes from the git clone or, in a
// packaged copy, from three-party/BUILD.txt.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildInfo } from '../../src/build-info.mjs';
import { BUILD_FILE, demoBuild, demoBuildWords } from '../src/engine/build.mjs';
import { LABELS } from '../src/engine/labels.mjs';
import { offlineCheckOf, offlineCheckReturned, pinsDirOf } from '../src/engine/records.mjs';
import { REPO_ROOT, START, removeDir, request, runStart, tempRunsDir } from './support/engine-helpers.mjs';

// Starts the command line and resolves once it has printed `lines` lines.
// The answer carries those lines, what it wrote to standard error so far,
// and stop(), which sends Ctrl+C and resolves with how the process ended.
async function startCommand(args, lines) {
  const child = spawn(process.execPath, [START, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => { child.on('close', (code, signal) => resolve({ code, signal })); });
  const guard = setTimeout(() => child.kill('SIGKILL'), 60000);
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGINT');
    const end = await exited;
    clearTimeout(guard);
    return { ...end, stdout, stderr };
  };
  const deadline = Date.now() + 20000;
  while (stdout.split('\n').length - 1 < lines) {
    if (Date.now() > deadline || child.exitCode !== null) {
      const end = await stop();
      assert.fail(`the command printed ${lines} line(s) within 20 seconds (stdout: ${JSON.stringify(end.stdout)}, stderr: ${JSON.stringify(end.stderr)})`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return { printed: stdout.split('\n').slice(0, lines), all: () => stdout, stop };
}

async function finishedOver(port, kind) {
  const started = await request({ port, method: 'POST', path: '/api/runs', body: { kind }, headers: { 'Content-Type': 'application/json' } });
  assert.equal(started.status, 200, started.text);
  const { runId } = started.json();
  const until = Date.now() + 30000;
  for (;;) {
    const state = (await request({ port, path: `/api/runs/${runId}` })).json();
    if (state.finishedAt !== null) return { runId, state };
    assert.ok(Date.now() < until, 'the run finished within 30 seconds');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

test('node three-party/bin/start.mjs with no option prints the three lines of the demo, serves the screens and the run API on 127.0.0.1, and stops on Ctrl+C with exit 0', async () => {
  const command = await startCommand([], 3);
  let end = null;
  try {
    const [title, ready, stopLine] = command.printed;
    const build = /^Three-party demo, build (?:([0-9a-f]{7})( \(modified\))?|not from a git clone)$/.exec(title);
    assert.ok(build, title);
    const sha7 = build[1] ?? null;
    assert.equal(sha7, demoBuild().sha7, 'the build named is the commit this tree is at');
    const address = /^Ready\. Open http:\/\/127\.0\.0\.1:([0-9]+)\/ in a browser\.$/.exec(ready);
    assert.ok(address, ready);
    assert.equal(stopLine, 'Press Ctrl+C to stop.');
    const port = Number(address[1]);
    assert.ok(port >= 7390 && port <= 7410, `port ${port} is 7390 or the next free port`);

    const page = await request({ port, path: '/' });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(page.text, /<script type="module" src="\.\/view\.mjs"><\/script>/);
    const health = await request({ port, path: '/api/health' });
    assert.deepEqual(health.json(), { ok: true, build: sha7 });
    assert.equal((await request({ port, path: '/api/labels' })).status, 200);

    end = await command.stop();
    assert.deepEqual({ code: end.code, signal: end.signal }, { code: 0, signal: null });
    assert.equal(end.stderr, '');
    assert.equal(end.stdout, `${command.printed.join('\n')}\n`, 'the three lines, and no line after them');
    await assert.rejects(request({ port, path: '/api/health' }), 'the listener is closed');
  } finally {
    if (end === null) await command.stop();
  }
});

test('--serve starts the same listener with options: the screens at /, and the offline check of three-party/src/record behind the API', async () => {
  const dir = tempRunsDir();
  const command = await startCommand(['--serve', '--pace', '0', '--runs-dir', dir], 1);
  let end = null;
  try {
    const line = /^Run API on http:\/\/127\.0\.0\.1:([0-9]+)\/ \(build (?:[0-9a-f]{7}|not from a git clone)\)\. Press Ctrl\+C to stop\.$/.exec(command.printed[0]);
    assert.ok(line, command.printed[0]);
    const port = Number(line[1]);
    const page = await request({ port, path: '/' });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');

    const { runId, state } = await finishedOver(port, 'clean');
    assert.equal(state.outcome, 'paid');
    assert.equal(state.steps.find((s) => s.id === 'record').status, 'written');
    assert.deepEqual(fs.readdirSync(dir), [runId]);
    assert.deepEqual(fs.readdirSync(pinsDirOf(dir)), [`${runId}.pub.pem`]);

    // The route answers the result the check wrote for this run directory:
    // the same result the check gives when asked again here, but for its time.
    const checked = await request({ port, method: 'POST', path: `/api/runs/${runId}/offline-check` });
    assert.equal(checked.status, 200);
    assert.deepEqual({ ...checked.json(), at: null }, { ...(await offlineCheckOf(path.join(dir, runId))), at: null });
    assert.deepEqual(Object.keys(checked.json()), ['runId', 'at', 'verifier', 'pin', 'pinSha256', 'network', 'records', 'tampered', 'summary']);
    assert.deepEqual(checked.json().summary, { pass: 5, reject: 1, expectedRejects: 1 });

    end = await command.stop();
    assert.deepEqual({ code: end.code, signal: end.signal }, { code: 0, signal: null });
    assert.equal(end.stderr, '');
  } finally {
    if (end === null) await command.stop();
    removeDir(dir);
  }
});

test('--text --offline-check prints, after each run, each line the offline check returned and its exit status, and still exits 0', async () => {
  const dir = tempRunsDir();
  try {
    const plain = await runStart(['--text', '--run', 'clean', '--pace', '0', '--runs-dir', dir]);
    assert.equal(plain.code, 0);
    assert.equal(plain.lines.length, 12, 'without the option a clean run prints its twelve lines');
    assert.equal(plain.lines.some((l) => l.includes('Offline check')), false);

    const r = await runStart(['--text', '--run', 'clean', '--pace', '0', '--offline-check', '--runs-dir', dir]);
    assert.equal(r.timedOut, false);
    assert.equal(r.stderr, '');
    assert.equal(r.code, 0, 'the exit code says how the run ended, not what the check returned');
    const directory = r.lines.findIndex((l) => l.startsWith('Run directory: '));
    assert.equal(directory, 11);
    const runDir = r.lines[directory].slice('Run directory: '.length);
    assert.equal(path.dirname(runDir), dir);

    // The check, asked again here, returns the same lines and the same exit
    // status. Its one note is that it replaced the result the command wrote.
    const again = await offlineCheckReturned(runDir);
    const said = r.lines.slice(directory + 1);
    const lead = /^\[[0-9]{6}\] Offline check \| /;
    for (const line of said) assert.match(line, lead);
    assert.deepEqual(said.map((l) => l.replace(lead, '')), [...again.lines, `exitCode: ${again.exitCode}`]);
    assert.equal(again.exitCode, 0);
    assert.equal(again.lines.at(-2), 'result: 5 passed steps 1 to 6, 1 rejected (1 expected)');
    assert.equal(again.lines.at(-1), 'written: offline-check.json');
    assert.deepEqual(again.notes, [`${path.join(runDir, 'offline-check.json')} was there before this check, and this check's result replaced it`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'offline-check.json'), 'utf8')).summary, { pass: 5, reject: 1, expectedRejects: 1 });
  } finally {
    removeDir(dir);
  }
});

test('the command line refuses --offline-check outside text mode, and the usage names the form with no option and the offline check', async () => {
  const dir = tempRunsDir();
  try {
    const r = await runStart(['--serve', '--offline-check', '--runs-dir', dir]);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.split('\n')[0], '--offline-check goes with --text.');
    assert.equal(r.stderr.split('\n')[1], 'Usage:');
    assert.deepEqual(fs.readdirSync(dir), []);

    const help = await runStart(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.lines[1], '  node three-party/bin/start.mjs');
    assert.ok(help.lines.some((l) => l.includes('--text') && l.includes('[--offline-check]')));
    assert.ok(help.lines.some((l) => l.trim().startsWith('(no option)') && l.includes('the screens and the run API on 127.0.0.1')));
    assert.ok(help.lines.some((l) => l.trim().startsWith('--offline-check') && l.includes('with --text')));
  } finally {
    removeDir(dir);
  }
});

test('the build the demo names: the commit of a git clone, the commit in three-party/BUILD.txt for a packaged copy, and words for a tree with neither', () => {
  if (buildInfo().fromGit) {
    const clone = demoBuild();
    assert.equal(clone.source, 'git');
    assert.equal(clone.sha7, buildInfo().sha7);
    assert.match(demoBuildWords(clone), /^[0-9a-f]{7}( \(modified\))?$/);
  }

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-build-')));
  try {
    assert.deepEqual({ ...demoBuild(dir) }, { sha7: null, modified: null, source: null });
    assert.equal(demoBuildWords(demoBuild(dir)), 'not from a git clone');

    const commit = '0123456789abcdef0123456789abcdef01234567';
    fs.mkdirSync(path.join(dir, path.dirname(BUILD_FILE)), { recursive: true });
    fs.writeFileSync(path.join(dir, BUILD_FILE), `commit ${commit}\nbuilt 2026-11-15T12:00:00Z\nnode v22.12.0\n`);
    assert.deepEqual({ ...demoBuild(dir) }, { sha7: '0123456', modified: false, source: 'build-file' });
    assert.equal(demoBuildWords(demoBuild(dir)), '0123456');

    // A file that names no whole commit names no build.
    fs.writeFileSync(path.join(dir, BUILD_FILE), 'commit 0123456\n');
    assert.equal(demoBuild(dir).sha7, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(LABELS.cli.demoTitle, 'Three-party demo, build {build}');
  assert.equal(LABELS.cli.demoReady, 'Ready. Open http://127.0.0.1:{port}/ in a browser.');
  assert.equal(LABELS.cli.demoStop, 'Press Ctrl+C to stop.');
});
