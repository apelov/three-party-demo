// Helpers the engine tests share: a runs directory of their own under the
// system temporary directory, the contract's example files, a walk over
// every file of a directory, the command line as a child process and one
// HTTP request to a loopback port.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THREE_PARTY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO_ROOT = path.resolve(THREE_PARTY, '..');
export const START = path.join(THREE_PARTY, 'bin', 'start.mjs');

export function example(name) {
  return JSON.parse(fs.readFileSync(path.join(THREE_PARTY, 'examples', name), 'utf8'));
}

// A new empty runs directory. The caller removes it with removeDir.
export function tempRunsDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-test-')));
}

// Removes a directory a test made and, when it was used as a runs directory
// with the tree's own record writer, the pins directory the engine keeps
// beside it (<dir>.pins).
export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(`${dir}.pins`, { recursive: true, force: true });
}

// Every file under a directory, as paths relative to it, sorted.
export function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Runs the command line and resolves with its exit code and what it wrote.
// A run that outlasts limitMs is stopped and reported as such. `env` adds to
// the environment the test runs in; `cwd` is the directory it starts from.
export function runStart(args, { limitMs = 60000, env = {}, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [START, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limitMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, lines: stdout.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === '')) });
    });
  });
}

// A clock that reads the system clock plus an offset the test can move.
export function movableClock() {
  let offsetMs = 0;
  const clock = () => new Date(Date.now() + offsetMs);
  clock.advance = (ms) => { offsetMs += ms; };
  return clock;
}

// One request to 127.0.0.1:<port>, with the headers as given (a Host or an
// Origin of the test's choosing included). Resolves with the status, the
// response headers and the body bytes.
export function request({ port, method = 'GET', path: target = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bytes,
          text: bytes.toString('utf8'),
          json: () => JSON.parse(bytes.toString('utf8')),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== null) req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    else req.end();
  });
}
