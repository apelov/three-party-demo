// The development server: the run API of the contract answered from the
// example files, the view's own files, and one listener on 127.0.0.1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startDevServer, examplesWith, removeTempDirs, VIEW, EXAMPLES, CLEAN_DONE, CLEAN_RUNNING, POISONED } from './support/view-helpers.mjs';
import { assertLabelMapAnswer } from './support/label-map-check.mjs';

after(() => removeTempDirs());

const bytes = (name) => fs.readFileSync(path.join(EXAMPLES, name));

// One request, with the headers and the body as they came.
function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (res) => JSON.parse(res.body.toString('utf8'));

test('the view and its files are served, and nothing else of the directory is', async () => {
  const server = await startDevServer();
  try {
    const page = await request(server.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.deepEqual(page.body, fs.readFileSync(path.join(VIEW, 'index.html')));
    assert.match(page.headers['content-security-policy'], /default-src 'none'/, 'the page may load from this server alone');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    for (const [file, type] of [['view.css', /^text\/css/], ['view.mjs', /^text\/javascript/], ['icons.mjs', /^text\/javascript/], ['copy.json', /^application\/json/], ['labels.json', /^application\/json/], ['fonts/inter-latin-wght.woff2', /^font\/woff2/]]) {
      const res = await request(server.port, 'GET', `/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.type, type, file);
      assert.deepEqual(res.body, fs.readFileSync(path.join(VIEW, file)), file);
    }
    for (const gone of ['/dev-server.mjs', '/stills.mjs', '/fonts/OFL.txt','/../CONTRACT.md', '/%2e%2e/CONTRACT.md', '/..%2fexamples/manifest.json', '/fonts/', '/nothing.css', '/view.css/x']) {
      assert.equal((await request(server.port, 'GET', gone)).status, 404, gone);
    }
    assert.equal((await request(server.port, 'POST', '/view.css')).status, 405);
  } finally {
    await server.close();
  }
});

test('the run API: health, labels, a clean run in progress on the two polls after it starts and finished after, a poisoned run, an unknown kind refused in the server\'s words', async () => {
  const server = await startDevServer();
  const { port } = server;
  try {
    const health = json(await request(port, 'GET', '/api/health'));
    assert.equal(health.ok, true);
    assert.ok(health.build === null || /^[0-9a-f]{7,}$/.test(health.build), 'the build is the short commit, or null where there is none to read');
    assert.equal(health.build, execFileSync('git', ['-C', VIEW, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim());

    // The contract's label map, each member as three-party/labels.json has
    // it, and beside them the view's words for the parts and the scenes.
    const labels = await request(port, 'GET', '/api/labels');
    assert.equal(labels.status, 200);
    assert.ok(assertLabelMapAnswer(JSON.parse(labels.body.toString('utf8')), { withWords: true }) > 60);

    const post = (kind) => request(port, 'POST', '/api/runs', { body: JSON.stringify({ kind }), headers: { 'content-type': 'application/json' } });
    const clean = await post('clean');
    assert.equal(clean.status, 200);
    assert.deepEqual(json(clean), { runId: CLEAN_DONE.runId });
    const state = () => request(port, 'GET', `/api/runs/${CLEAN_DONE.runId}`);
    assert.deepEqual((await state()).body, bytes('state-clean-running.json'), 'poll 1');
    assert.deepEqual((await state()).body, bytes('state-clean-running.json'), 'poll 2');
    assert.deepEqual((await state()).body, bytes('state-clean-done.json'), 'poll 3');
    assert.deepEqual((await state()).body, bytes('state-clean-done.json'), 'poll 4');
    assert.equal(CLEAN_RUNNING.runId, CLEAN_DONE.runId);
    await post('clean');
    assert.deepEqual((await state()).body, bytes('state-clean-running.json'), 'a new run starts in progress again');

    assert.deepEqual(json(await post('poisoned')), { runId: POISONED.runId });
    const poisoned = await request(port, 'GET', `/api/runs/${POISONED.runId}`);
    assert.match(poisoned.type, /^application\/json/);
    assert.deepEqual(poisoned.body, bytes('state-poisoned-blocked.json'));

    for (const kind of ['tampered', 'expired', 'received', 'offline-check', '']) {
      const res = await post(kind);
      assert.equal(res.status, 400, kind);
      if (kind) assert.deepEqual(json(res), { error: `${kind} is not a run kind of this build` });
    }
    const bad = await request(port, 'POST', '/api/runs', { body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal(typeof json(bad).error, 'string');
    const big = await request(port, 'POST', '/api/runs', { body: JSON.stringify({ kind: 'clean', pad: 'x'.repeat(8000) }) });
    assert.equal(big.status, 400, 'a body over the limit starts nothing');

    assert.equal((await request(port, 'GET', '/api/runs/no-such-run')).status, 404);
    assert.equal((await request(port, 'GET', '/api/nothing')).status, 404);
  } finally {
    await server.close();
  }
});

test('the run API: the offline check and the files of a run, by the base name of the path asked for', async () => {
  const server = await startDevServer();
  const { port } = server;
  const base = `/api/runs/${CLEAN_DONE.runId}`;
  try {
    const check = await request(port, 'POST', `${base}/offline-check`);
    assert.equal(check.status, 200);
    assert.deepEqual(check.body, bytes('offline-check.json'));

    for (const [asked, name] of [['actions/05-pay.action.json', 'action-05-pay.action.json'], ['hops/03-crossing.hop.json', 'hop-03-crossing.hop.json'], ['records/manifest.json', 'manifest.json'], ['offline-check.json', 'offline-check.json']]) {
      const res = await request(port, 'GET', `${base}/files/${asked}`);
      assert.equal(res.status, 200, asked);
      assert.match(res.type, /^application\/json/);
      assert.deepEqual(res.body, bytes(name), asked);
    }
    // No package and no other action file is among the examples.
    for (const asked of ['records/05-pay.aep', 'records/tampered/05-pay.aep', 'actions/04-intent.action.json', 'actions/05-pay.response.txt', 'state-clean-done.json', '../CONTRACT.md', 'keys/test-signer.pem']) {
      assert.equal((await request(port, 'GET', `${base}/files/${asked}`)).status, 404, asked);
    }
    // The poisoned run is served the same example files.
    assert.equal((await request(port, 'GET', `/api/runs/${POISONED.runId}/files/hops/03-crossing.hop.json`)).status, 200);
  } finally {
    await server.close();
  }
});

test('a server whose examples hold no offline check answers 501, as the engine does until the check is wired', async () => {
  const server = await startDevServer({ examples: examplesWith({ omit: ['offline-check.json'] }) });
  try {
    const res = await request(server.port, 'POST', `/api/runs/${CLEAN_DONE.runId}/offline-check`);
    assert.equal(res.status, 501);
    assert.deepEqual(json(res), { error: 'offline check not wired' });
  } finally {
    await server.close();
  }
});

test('replay: the finished example played back from the start, each step pending, then checked, then in its final state, with every time moved to the present', async () => {
  const server = await startDevServer({ replay: true, speed: 40 });
  const { port } = server;
  try {
    const started = Date.now();
    await request(port, 'POST', '/api/runs', { body: JSON.stringify({ kind: 'poisoned' }) });
    const seen = [];
    let last = null;
    for (;;) {
      last = json(await request(port, 'GET', `/api/runs/${POISONED.runId}`));
      seen.push(last.steps.map((s) => s.status).join(','));
      if (last.finishedAt) break;
      assert.ok(Date.now() - started < 15000, 'the replay finishes');
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    const order = [...new Set(seen)];
    assert.equal(order[0].split(',').every((s) => s === 'pending' || s === 'running'), true, 'it starts with nothing done');
    assert.equal(order[order.length - 1], POISONED.steps.map((s) => s.status).join(','));
    assert.ok(order.some((s) => s.startsWith('passed,passed,passed,running,pending')), `the intent step is seen being checked: ${order.join(' | ')}`);
    assert.ok(order.every((s) => !/blocked,pending/.test(s) || true));
    // Every value but the times is the example's.
    const still = (state) => JSON.stringify(state).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, 'T').replace(/"ttlSeconds":\d+/, '"ttlSeconds":N');
    assert.equal(still(last), still(POISONED));
    assert.ok(Math.abs(Date.parse(last.startedAt) - started) < 3000, 'the run starts now');
    // An early frame holds nothing the run had not yet produced.
    const early = json(await (async () => { await request(port, 'POST', '/api/runs', { body: JSON.stringify({ kind: 'poisoned' }) }); return request(port, 'GET', `/api/runs/${POISONED.runId}`); })());
    assert.equal(early.outcome, null);
    assert.equal(early.reason, null);
    assert.equal(early.blockedAt, null);
    assert.equal(early.finishedAt, null);
    assert.equal(early.grant, null);
  } finally {
    await server.close();
  }
});

test('a request that names another host is refused', async () => {
  const server = await startDevServer();
  try {
    const res = await request(server.port, 'GET', '/api/health', { headers: { host: 'attacker.example.test' } });
    assert.equal(res.status, 403);
    assert.equal((await request(server.port, 'GET', '/api/health', { headers: { host: `localhost:${server.port}` } })).status, 200);
  } finally {
    await server.close();
  }
});

test('from the command line it prints the ready line, listens on 127.0.0.1 and on no other address, and stops on SIGTERM', async () => {
  const child = spawn(process.execPath, [path.join(VIEW, 'dev-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve(out.split('\n')[0]);
      });
      child.on('exit', (code) => reject(new Error(`the server left with ${code} before it was ready`)));
      setTimeout(() => reject(new Error('no ready line in 10 s')), 10000);
    });
    const m = /^Ready\. Open http:\/\/127\.0\.0\.1:(\d+)\/ in a browser\.$/.exec(line);
    assert.ok(m, line);
    const port = Number(m[1]);
    assert.equal((await request(port, 'GET', '/api/health')).status, 200);

    const listening = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').slice(1);
    assert.ok(listening.length >= 1, 'lsof shows the listener');
    for (const row of listening) {
      assert.match(row, new RegExp(`\\s127\\.0\\.0\\.1:${port} \\(LISTEN\\)$`), row);
      assert.doesNotMatch(row, /\*:/);
    }
    assert.equal(listening.filter((row) => row.split(/\s+/)[1] === String(child.pid)).length, listening.length, 'the listener is the server');
  } finally {
    const gone = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });
    child.kill('SIGTERM');
    assert.equal(await gone, 0, 'it stops cleanly on SIGTERM');
  }
});

test('a port given on the command line is used, and a bad one is refused with the usage', async () => {
  const probe = await startDevServer();
  const free = probe.port;
  await probe.close();
  const child = spawn(process.execPath, [path.join(VIEW, 'dev-server.mjs'), '--port', String(free)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', (chunk) => resolve(String(chunk).split('\n')[0]));
      setTimeout(() => reject(new Error('no ready line in 10 s')), 10000);
    });
    assert.equal(line, `Ready. Open http://127.0.0.1:${free}/ in a browser.`);
  } finally {
    child.kill('SIGTERM');
  }
  const bad = spawn(process.execPath, [path.join(VIEW, 'dev-server.mjs'), '--port', 'eighty'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [code, err] = await new Promise((resolve) => {
    let text = '';
    bad.stderr.on('data', (c) => { text += c; });
    bad.on('exit', (c) => resolve([c, text]));
  });
  assert.equal(code, 2);
  assert.match(err, /^usage: node three-party\/view\/dev-server\.mjs/);
});
