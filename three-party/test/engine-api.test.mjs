// The run API of CONTRACT.md section 7, on a loopback port of its own: the
// routes, what each answers, and what it refuses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInfo } from '../../src/build-info.mjs';
import { DEFAULT_PORT, fileInRun, startApi } from '../src/engine/api.mjs';
import { runToEnd } from '../src/engine/run.mjs';
import { RUN_ID } from '../src/engine/store.mjs';
import { example, removeDir, request, tempRunsDir, walkFiles } from './support/engine-helpers.mjs';

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
// A pace small enough for a test and large enough that a reader meets the run in progress.
const PACE_SECONDS = 0.02;

const runsDir = tempRunsDir();
const witness = [];
let api;
let port;
let cleanRunId;

const get = (target, headers = {}) => request({ port, path: target, headers });
const post = (target, body = null, headers = {}) => request({
  port, method: 'POST', path: target, body, headers: body === null ? headers : { 'Content-Type': 'application/json', ...headers },
});

// Reads a run's state until it has finished, and returns every reading.
async function followRun(runId) {
  const readings = [];
  const deadline = Date.now() + 30000;
  for (;;) {
    const res = await get(`/api/runs/${runId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], JSON_TYPE);
    readings.push(res.json());
    if (readings.at(-1).finishedAt !== null) return readings;
    assert.ok(Date.now() < deadline, 'the run finished within 30 seconds');
  }
}

before(async () => {
  api = await startApi({ port: 0, runsDir, paceSeconds: PACE_SECONDS, runOptions: { recordWriter: null, witness } });
  port = api.port;
});

after(async () => {
  await api.stop();
  removeDir(runsDir);
});

test('the listener is bound to 127.0.0.1', () => {
  assert.equal(api.address, '127.0.0.1');
  assert.ok(Number.isInteger(port) && port > 0);
});

test('GET /api/health answers ok and the short sha of the build', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], JSON_TYPE);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.deepEqual(Object.keys(body), ['ok', 'build']);
  assert.equal(body.ok, true);
  assert.equal(body.build, buildInfo().sha7);
  if (body.build !== null) assert.match(body.build, /^[0-9a-f]{7}$/);
});

test('GET / answers 200 with one line of text until the screens are wired', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], TEXT_TYPE);
  assert.equal(res.text, 'Three-party demo run API. The screens are added by the integration build; see /api/health.\n');
});

test('POST /api/runs starts a run and returns its id at once; GET /api/runs/<runId> returns a state.json that parses at every reading while the run advances', async () => {
  const started = await post('/api/runs', { kind: 'clean' });
  assert.equal(started.status, 200);
  assert.equal(started.headers['content-type'], JSON_TYPE);
  const body = started.json();
  assert.deepEqual(Object.keys(body), ['runId']);
  assert.match(body.runId, RUN_ID);
  assert.ok(body.runId.startsWith('clean-'));
  cleanRunId = body.runId;
  assert.deepEqual(api.activeRuns(), [cleanRunId]);

  const readings = await followRun(cleanRunId);
  const ex = example('state-clean-done.json');
  for (const state of readings) {
    assert.deepEqual(Object.keys(state), Object.keys(ex));
    assert.equal(state.runId, cleanRunId);
    assert.equal(state.steps.length, 6);
    assert.equal(state.paceSeconds, PACE_SECONDS, 'the run advances on the pace the API was started with');
  }
  assert.equal(readings[0].finishedAt, null, 'the id came back before the run had finished');
  assert.ok(readings.length > 3, `the run was read ${readings.length} times while it advanced`);
  assert.ok(readings.some((s) => s.steps.some((x) => x.status === 'running')), 'a reader met a step in progress');
  // A step never goes back: the count of steps with a result does not fall from one reading to the next.
  const settled = readings.map((s) => s.steps.filter((x) => x.status !== 'pending' && x.status !== 'running').length);
  for (let i = 1; i < settled.length; i += 1) assert.ok(settled[i] >= settled[i - 1]);

  const final = readings.at(-1);
  assert.equal(final.outcome, 'paid');
  assert.deepEqual(final.steps.map((s) => s.status), ['passed', 'passed', 'passed', 'passed', 'passed', 'pending']);
  await api.idle();
  assert.deepEqual(api.activeRuns(), []);
});

test('GET /api/runs/<runId>/files/<path> returns a file of the run directory: JSON as application/json, text as text/plain, a package as application/zip', async () => {
  const runDir = path.join(runsDir, cleanRunId);
  const state = await get(`/api/runs/${cleanRunId}/files/state.json`);
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-type'], JSON_TYPE);
  assert.deepEqual(state.bytes, fs.readFileSync(path.join(runDir, 'state.json')));
  assert.deepEqual(state.bytes, (await get(`/api/runs/${cleanRunId}`)).bytes, 'the state route and the file route give the same bytes');

  const action = await get(`/api/runs/${cleanRunId}/files/actions/05-pay.action.json`);
  assert.equal(action.status, 200);
  assert.equal(action.headers['content-type'], JSON_TYPE);
  assert.equal(action.json().step, 'pay');

  const answer = await get(`/api/runs/${cleanRunId}/files/actions/05-pay.response.txt`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], TEXT_TYPE);
  assert.equal(answer.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(answer.bytes, fs.readFileSync(path.join(runDir, 'actions/05-pay.response.txt')));
  assert.equal(answer.json().status, 'accepted');

  const hop = await get(`/api/runs/${cleanRunId}/files/hops/03-crossing.hop.json`);
  assert.equal(hop.status, 200);
  assert.equal(hop.json().outcome, 'valid');

  // Every file the run left is served, byte for byte.
  for (const file of walkFiles(runDir)) {
    const res = await get(`/api/runs/${cleanRunId}/files/${file}`);
    assert.equal(res.status, 200, file);
    assert.deepEqual(res.bytes, fs.readFileSync(path.join(runDir, file)), file);
  }

  // What the record build adds later is served by its type. These stand in for its files.
  fs.mkdirSync(path.join(runDir, 'records'));
  fs.mkdirSync(path.join(runDir, 'keys'));
  const packageBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  fs.writeFileSync(path.join(runDir, 'records/01-credential.aep'), packageBytes);
  fs.writeFileSync(path.join(runDir, 'keys/test-signer.pub.pem'), 'stand-in for the public key file\n');
  fs.writeFileSync(path.join(runDir, 'keys/TEST-KEY.txt'), 'Test key generated for this demo run; not a key in use anywhere.\n');
  fs.writeFileSync(path.join(runDir, 'keys/test-signer.pem'), 'stand-in for the private key file\n');
  const record = await get(`/api/runs/${cleanRunId}/files/records/01-credential.aep`);
  assert.equal(record.status, 200);
  assert.equal(record.headers['content-type'], 'application/zip');
  assert.deepEqual(record.bytes, packageBytes);
  const publicKey = await get(`/api/runs/${cleanRunId}/files/keys/test-signer.pub.pem`);
  assert.equal(publicKey.status, 200);
  assert.equal(publicKey.headers['content-type'], TEXT_TYPE);
  assert.equal((await get(`/api/runs/${cleanRunId}/files/keys/TEST-KEY.txt`)).status, 200);
  const privateKey = await get(`/api/runs/${cleanRunId}/files/keys/test-signer.pem`);
  assert.equal(privateKey.status, 404, "the run's private test key is not served");
  assert.equal(privateKey.text.includes('stand-in for the private key file'), false);
});

test('the file route serves nothing outside the run directory: no dot segment, no hidden name, no link that leaves it, no directory', async () => {
  const runDir = path.join(runsDir, cleanRunId);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-outside-')));
  try {
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside the run directory');
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(runDir, 'actions', 'link.txt'));
    fs.symlinkSync(outside, path.join(runDir, 'linked-dir'));
    fs.writeFileSync(path.join(runDir, '.hidden.json'), '{}');
    const refused = [
      'files/..%2Fstate.json',
      'files/actions%2F..%2F..%2Fstate.json',
      `files/..%2F${cleanRunId}%2Fstate.json`,
      'files/%2E%2E/state.json',
      'files/actions/link.txt',
      'files/linked-dir/outside.txt',
      'files/.hidden.json',
      'files/actions',
      'files/actions/',
      'files/',
      'files/actions//05-pay.action.json',
      'files/actions%5C05-pay.action.json',
      'files/no-such-file.json',
      'files/%E0%A4%A',
    ];
    for (const target of refused) {
      const res = await get(`/api/runs/${cleanRunId}/${target}`);
      assert.ok(res.status === 404 || res.status === 400, `${target} answered ${res.status}`);
      assert.equal(res.text.includes('outside the run directory'), false, target);
    }
    assert.equal(fileInRun(runDir, 'actions/05-pay.action.json'), fs.realpathSync(path.join(runDir, 'actions/05-pay.action.json')));
    assert.equal(fileInRun(runDir, '../state.json'), null);
    assert.equal(fileInRun(runDir, 'actions/link.txt'), null);
    assert.equal(fileInRun(runDir, 'keys/test-signer.pem'), null);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('POST /api/runs/<runId>/offline-check answers 501 with the set error until the offline check is wired, and the check\'s result once it is', async () => {
  const res = await post(`/api/runs/${cleanRunId}/offline-check`);
  assert.equal(res.status, 501);
  assert.equal(res.text, '{"error":"offline check not wired"}');
  assert.equal((await get(`/api/runs/${cleanRunId}/offline-check`)).status, 405);

  const asked = [];
  const wired = await startApi({ port: 0, runsDir, paceSeconds: 0, offlineCheck: async (runDir) => { asked.push(runDir); return { runId: path.basename(runDir), summary: { pass: 5, reject: 1, expectedRejects: 1 } }; } });
  try {
    const done = await request({ port: wired.port, method: 'POST', path: `/api/runs/${cleanRunId}/offline-check` });
    assert.equal(done.status, 200);
    assert.deepEqual(done.json(), { runId: cleanRunId, summary: { pass: 5, reject: 1, expectedRejects: 1 } });
    assert.deepEqual(asked, [path.join(runsDir, cleanRunId)]);
  } finally {
    await wired.stop();
  }
});

test('a poisoned run started over the API ends blocked at intent, and a run made outside the API is read through it', async () => {
  const started = await post('/api/runs', { kind: 'poisoned' });
  assert.equal(started.status, 200);
  const { runId } = started.json();
  assert.ok(runId.startsWith('poisoned-'));
  const final = (await followRun(runId)).at(-1);
  assert.equal(final.outcome, 'blocked');
  assert.equal(final.blockedAt, 'intent');
  assert.equal(final.reason, example('state-poisoned-blocked.json').reason);
  assert.equal(final.poisonedLine, example('state-poisoned-blocked.json').poisonedLine);
  assert.deepEqual(final.steps.map((s) => s.status), ['passed', 'passed', 'passed', 'blocked', 'not-reached', 'pending']);
  await api.idle();

  // A run the terminal made is in the same directory, and the API reads it.
  const other = await runToEnd({ kind: 'poisoned', paceSeconds: 0, runsDir, recordWriter: null });
  const read = await get(`/api/runs/${other.runId}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json(), other.state);
});

test('nothing the API serves for a run holds the access token value the bank issued', async () => {
  assert.equal(witness.length, 2, 'one access token per run the API started');
  const runIds = fs.readdirSync(runsDir).filter((name) => RUN_ID.test(name));
  assert.ok(runIds.length >= 2);
  let served = 0;
  for (const runId of runIds) {
    const bodies = [(await get(`/api/runs/${runId}`)).bytes];
    for (const file of walkFiles(path.join(runsDir, runId))) {
      const res = await get(`/api/runs/${runId}/files/${file}`);
      if (res.status === 200) bodies.push(res.bytes);
    }
    for (const token of witness) {
      assert.match(token, /^[0-9a-f]{64}$/);
      for (const bytes of bodies) assert.equal(bytes.includes(Buffer.from(token, 'utf8')), false);
    }
    served += bodies.length;
  }
  assert.ok(served >= 20, `${served} responses were searched`);
});

test('the API refuses what it does not know: a kind, a body that is not JSON, a method, a run id, a path', async () => {
  const kind = await post('/api/runs', { kind: 'tampered' });
  assert.equal(kind.status, 400);
  assert.deepEqual(kind.json(), { error: 'kind must be clean or poisoned' });
  assert.equal((await post('/api/runs', {})).status, 400);
  assert.equal((await post('/api/runs', '{"kind":', { 'Content-Type': 'application/json' })).status, 400);
  const large = await post('/api/runs', JSON.stringify({ kind: 'clean', filler: 'x'.repeat(8192) }));
  assert.equal(large.status, 413, 'a body larger than the route reads');
  assert.deepEqual(large.json(), { error: 'the body is too large' });
  assert.equal((await post('/api/runs', '[]')).status, 400);
  assert.equal((await post('/api/runs', 'null')).status, 400);
  assert.equal((await get('/api/runs')).status, 405);
  assert.equal((await post('/api/health')).status, 405);
  assert.equal((await post('/')).status, 405);
  assert.equal((await post(`/api/runs/${cleanRunId}`)).status, 405);
  assert.equal((await post(`/api/runs/${cleanRunId}/files/state.json`)).status, 405);
  assert.equal((await get('/api/runs/clean-20200101T000000Z')).status, 404, 'a run id of the right form with no run');
  assert.equal((await get('/api/runs/..')).status, 404);
  assert.equal((await get('/api/runs/%2E%2E/files/state.json')).status, 404);
  assert.equal((await get(`/api/runs/${cleanRunId}/other`)).status, 404);
  assert.equal((await get('/api/other')).status, 404);
  assert.equal((await get('/state.json')).status, 404);
  assert.deepEqual(fs.readdirSync(runsDir).filter((name) => name.startsWith('tampered')), []);
});

test('a request that names another host, or comes from another origin, is refused before any route runs', async () => {
  const before = fs.readdirSync(runsDir).length;
  const otherHost = await request({ port, path: '/api/health', headers: { Host: 'bank.example.test' } });
  assert.equal(otherHost.status, 403);
  assert.deepEqual(otherHost.json(), { error: 'request refused' });
  assert.equal((await request({ port, path: '/api/health', headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403);
  const otherOrigin = await post('/api/runs', { kind: 'clean' }, { Origin: 'http://other.example.test' });
  assert.equal(otherOrigin.status, 403);
  assert.equal((await get(`/api/runs/${cleanRunId}`, { Origin: 'null' })).status, 403);
  assert.equal(fs.readdirSync(runsDir).length, before, 'no run was started');
  // The API's own pages, on either loopback name, are let through.
  assert.equal((await get('/api/health', { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await request({ port, path: '/api/health', headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
});

test('the API holds four runs at a time and refuses the next; stopping it ends the runs in progress', async () => {
  const dir = tempRunsDir();
  // Runs that wait at their start until the test lets them go.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = await startApi({ port: 0, runsDir: dir, paceSeconds: 0, runOptions: { recordWriter: null, sleep: () => held } });
  try {
    const kinds = ['clean', 'poisoned', 'clean', 'poisoned'];
    const ids = [];
    for (const kind of kinds) {
      const res = await request({ port: slow.port, method: 'POST', path: '/api/runs', body: { kind }, headers: { 'Content-Type': 'application/json' } });
      assert.equal(res.status, 200);
      ids.push(res.json().runId);
    }
    assert.equal(new Set(ids).size, 4, 'four runs, four ids');
    assert.deepEqual(slow.activeRuns().sort(), [...ids].sort());
    const fifth = await request({ port: slow.port, method: 'POST', path: '/api/runs', body: { kind: 'clean' }, headers: { 'Content-Type': 'application/json' } });
    assert.equal(fifth.status, 429);
    assert.deepEqual(fifth.json(), { error: 'too many runs in progress' });
    assert.equal(fs.readdirSync(dir).length, 4);
    // The runs are still held at their start. Stopping the API ends them, and
    // each has written its final state by the time stop returns.
    await slow.stop();
    for (const id of ids) {
      const state = JSON.parse(fs.readFileSync(path.join(dir, id, 'state.json'), 'utf8'));
      assert.notEqual(state.finishedAt, null, 'a stopped run is written as finished');
      assert.equal(state.outcome, 'blocked');
      assert.equal(state.blockedAt, 'credential');
      assert.deepEqual(state.steps[0].detail, { refusal: 'run-stopped' });
      assert.equal(state.reason, 'The run was stopped before it finished, at the step credential.');
      assert.equal(state.steps.some((s) => s.status === 'running' || s.status === 'pending'), false);
    }
    assert.deepEqual(slow.activeRuns(), []);
    await assert.rejects(request({ port: slow.port, path: '/api/health' }), 'the listener is closed');
  } finally {
    release();
    await slow.stop();
    removeDir(dir);
  }
});

test('without a port the API takes 7390 or the next free loopback port; with a port that is in use it fails and does not move', async () => {
  const a = await startApi({ runsDir });
  let b = null;
  try {
    assert.equal(DEFAULT_PORT, 7390);
    assert.ok(a.port >= DEFAULT_PORT && a.port <= DEFAULT_PORT + 20, `port ${a.port}`);
    assert.equal(a.address, '127.0.0.1');
    b = await startApi({ runsDir });
    assert.ok(b.port > a.port && b.port <= DEFAULT_PORT + 20, `port ${b.port} is the next free one after ${a.port}`);
    assert.equal(b.address, '127.0.0.1');
    await assert.rejects(startApi({ runsDir, port: a.port }), (err) => err.code === 'EADDRINUSE');
  } finally {
    await a.stop();
    if (b) await b.stop();
  }
});
