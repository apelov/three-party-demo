// The three builds together, over the API: a run of the engine is recorded
// by the tree's own record writer with a test key made when the run starts,
// and the demo's listener serves the screens beside the API. The listener is
// started here the way the command line starts it, at pace 0.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pinFileOf, pinsDirOf } from '../src/engine/records.mjs';
import { runToEnd, startRun } from '../src/engine/run.mjs';
import { SCREEN_POLICY, VIEW_DIR } from '../src/engine/screens.mjs';
import { compactStamp } from '../src/engine/store.mjs';
import { findPrivateKeys } from '../src/record/check.mjs';
import { liveTestKey, TEST_KEY_LINE } from '../src/record/testkey.mjs';
import { ENTRY_NAMES, FORMAT } from '../src/record/writer.mjs';
import { startDevServer } from '../view/dev-server.mjs';
import { example, removeDir, request, tempRunsDir, walkFiles } from './support/engine-helpers.mjs';
import { finishedRun, startDemo } from './support/integration-helpers.mjs';
import { assertLabelMapAnswer } from './support/label-map-check.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const statuses = (state) => state.steps.map((s) => `${s.id}=${s.status}`);
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const witness = [];
let demo;
let clean;
let poisoned;

before(async () => {
  demo = await startDemo({ witness });
  clean = await finishedRun(demo, 'clean');
  poisoned = await finishedRun(demo, 'poisoned');
});

after(async () => {
  await demo.stop();
});

// The manifest of a run and each file it lists, read over the API.
async function recordsOf(run) {
  const base = `/api/runs/${run.runId}/files`;
  const answer = await demo.get(`${base}/records/manifest.json`);
  assert.equal(answer.status, 200);
  const manifest = answer.json();
  const files = new Map();
  for (const item of [...manifest.records, ...manifest.tampered]) {
    const file = await demo.get(`${base}/${item.file}`);
    assert.equal(file.status, 200, item.file);
    assert.equal(file.headers['content-type'], 'application/zip', item.file);
    assert.equal(sha256(file.bytes), item.sha256, `${item.file}: the bytes served are the bytes the manifest names`);
    // A package is a store-method archive, so each entry name stands in it as written.
    for (const name of ENTRY_NAMES) assert.ok(file.bytes.includes(Buffer.from(name, 'ascii')), `${item.file} holds ${name}`);
    files.set(item.file, file.bytes);
  }
  return { manifest, files };
}

// What every finished run of the demo holds beside its records: the public
// half of its test key, the note that the private half is deleted, a pin of
// the same public key outside the run directory, and no private key.
async function checkKeysOf(run, manifest) {
  const runDir = path.join(demo.runsDir, run.runId);
  const base = `/api/runs/${run.runId}/files`;
  const publicKey = await demo.get(`${base}/keys/test-signer.pub.pem`);
  assert.equal(publicKey.status, 200);
  assert.equal(manifest.signerPublicKey, 'keys/test-signer.pub.pem');
  assert.equal(manifest.signerSha256, sha256(publicKey.bytes), 'the manifest names the public key file by its hash');
  assert.equal(crypto.createPublicKey(publicKey.bytes).asymmetricKeyType, 'rsa');

  const note = (await demo.get(`${base}/keys/TEST-KEY.txt`)).text.split('\n');
  assert.equal(note[0], TEST_KEY_LINE);
  assert.match(note[1], /^Private key deleted at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z after the last record was signed\.$/);
  assert.deepEqual(note.slice(2), ['']);
  assert.equal((await demo.get(`${base}/keys/test-signer.pem`)).status, 404, 'no private key file is served, and none exists');

  const pin = pinFileOf(runDir);
  assert.equal(path.dirname(pin), pinsDirOf(demo.runsDir));
  assert.equal(pin.startsWith(`${demo.runsDir}${path.sep}`), false, 'the pin is outside the runs directory');
  assert.ok(fs.readFileSync(pin).equals(publicKey.bytes), 'the pin captured when the run started is the key the records name');

  assert.deepEqual(findPrivateKeys(runDir), { found: [], unread: [] }, 'the run directory holds no private key');
  assert.deepEqual(walkFiles(runDir).filter((f) => f.startsWith('keys/')), ['keys/TEST-KEY.txt', 'keys/test-signer.pub.pem']);
  assert.equal(walkFiles(runDir).includes('offline-check.json'), false);
}

test('a clean run through the API ends paid with five records and a manifest', async () => {
  const { state } = clean;
  assert.equal(state.outcome, 'paid');
  assert.equal(state.blockedAt, null);
  assert.match(state.finishedAt, UTC);
  assert.deepEqual(statuses(state), statuses(example('state-clean-done.json')), 'every status of the contract example');

  const record = state.steps.find((s) => s.id === 'record');
  assert.deepEqual(Object.keys(record.detail), Object.keys(example('state-clean-done.json').steps.find((s) => s.id === 'record').detail));
  assert.equal(record.detail.written, 5);
  assert.equal(record.detail.format, FORMAT);
  assert.equal(record.recordFile, 'records/manifest.json');
  assert.deepEqual(state.steps.map((s) => s.recordFile), example('state-clean-done.json').steps.map((s) => s.recordFile), 'each action step names its record, as the contract example does');

  const { manifest, files } = await recordsOf(clean);
  assert.deepEqual(Object.keys(manifest), Object.keys(example('manifest.json')));
  assert.equal(manifest.runId, clean.runId);
  assert.equal(manifest.format, FORMAT);
  assert.equal(manifest.credentialSha256, state.agent.credentialSha256);
  assert.deepEqual(manifest.records.map((r) => [r.file, r.action]), state.steps.filter((s) => s.actionFile !== null).map((s) => [s.recordFile, s.actionFile]));
  assert.equal(manifest.records.length, 5);
  assert.deepEqual(manifest.tampered.map((t) => t.file), ['records/tampered/05-pay.aep']);
  assert.equal(files.get('records/tampered/05-pay.aep').equals(files.get('records/05-pay.aep')), false, 'the tampered copy is not the record');
  await checkKeysOf(clean, manifest);
});

test('a poisoned run through the API ends blocked at intent with four records', async () => {
  const { state } = poisoned;
  const ex = example('state-poisoned-blocked.json');
  assert.equal(state.outcome, 'blocked');
  assert.equal(state.blockedAt, 'intent');
  assert.equal(state.reason, ex.reason);
  assert.equal(state.poisonedLine, ex.poisonedLine);
  assert.deepEqual(statuses(state), statuses(ex), 'every status of the contract example');

  const record = state.steps.find((s) => s.id === 'record');
  assert.equal(record.detail.written, 4);
  assert.deepEqual(state.steps.map((s) => s.recordFile), ex.steps.map((s) => s.recordFile));
  assert.equal(state.steps.find((s) => s.id === 'pay').actionFile, null, 'no payment was sent, so there is no pay action to record');

  const { manifest } = await recordsOf(poisoned);
  assert.equal(manifest.runId, poisoned.runId);
  assert.equal(manifest.records.length, 4);
  assert.deepEqual(manifest.records.map((r) => r.file), ['records/01-credential.aep', 'records/02-grant.aep', 'records/03-crossing.aep', 'records/04-intent.aep']);
  assert.deepEqual(manifest.tampered.map((t) => t.file), ['records/tampered/04-intent.aep']);
  await checkKeysOf(poisoned, manifest);
});

test('the runs directory holds the run directories and nothing else, and each run has its own key', async () => {
  assert.deepEqual(fs.readdirSync(demo.runsDir).sort(), [clean.runId, poisoned.runId].sort());
  assert.deepEqual(fs.readdirSync(pinsDirOf(demo.runsDir)).sort(), [`${clean.runId}.pub.pem`, `${poisoned.runId}.pub.pem`].sort());
  const pins = [clean, poisoned].map((run) => sha256(fs.readFileSync(pinFileOf(path.join(demo.runsDir, run.runId)))));
  assert.notEqual(pins[0], pins[1], 'a new run gets a new key');
  assert.deepEqual(findPrivateKeys(pinsDirOf(demo.runsDir)), { found: [], unread: [] });
});

test('the test key is made when the run starts, and a run stopped before its record step gives it up: the note says so, and no record is written', async () => {
  const dir = tempRunsDir();
  try {
    // A wait that never ends holds the run before its credential step.
    const run = await startRun({ kind: 'clean', paceSeconds: 5, runsDir: dir, sleep: () => new Promise(() => {}) });
    const deadline = Date.now() + 10000;
    while (liveTestKey(run.runDir) === null) {
      assert.ok(Date.now() < deadline, 'the key was made within 10 seconds of the start');
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(run.state().steps.find((s) => s.id === 'credential').status, 'pending', 'the key is there before the credential step has run');
    assert.deepEqual(walkFiles(run.runDir), ['keys/TEST-KEY.txt', 'keys/test-signer.pub.pem', 'state.json']);
    assert.ok(fs.readFileSync(pinFileOf(run.runDir)).equals(fs.readFileSync(path.join(run.runDir, 'keys/test-signer.pub.pem'))), 'the pin is captured at the start');
    assert.equal(fs.readFileSync(path.join(run.runDir, 'keys/TEST-KEY.txt'), 'utf8'), `${TEST_KEY_LINE}\n`);

    await run.abort();
    const { state } = await run.done;
    assert.equal(liveTestKey(run.runDir), null, 'the key is deleted');
    const note = fs.readFileSync(path.join(run.runDir, 'keys/TEST-KEY.txt'), 'utf8').split('\n');
    assert.equal(note[0], TEST_KEY_LINE);
    assert.match(note[1], /^Private key deleted at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z; the run's records were not finished\.$/);
    assert.equal(state.steps.find((s) => s.id === 'record').status, 'not-reached');
    assert.equal(fs.existsSync(path.join(run.runDir, 'records')), false);
    assert.deepEqual(findPrivateKeys(run.runDir), { found: [], unread: [] });
  } finally {
    removeDir(dir);
  }
});

test('a run whose test key cannot be made still pays; its record step says why no record was written, and the writer makes no other key', async () => {
  const dir = tempRunsDir();
  try {
    // A clock held at one moment names the run before it starts, so a pin
    // can be put in its place: a pin that exists is never written over.
    const at = new Date();
    const runId = `clean-${compactStamp(at)}`;
    const pin = pinFileOf(path.join(dir, runId));
    fs.mkdirSync(path.dirname(pin), { recursive: true });
    fs.writeFileSync(pin, 'a pin that was here before the run\n');

    const { state, error, runDir } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir: dir, clock: () => new Date(at) });
    assert.equal(path.basename(runDir), runId);
    assert.equal(error, null);
    assert.equal(state.outcome, 'paid', 'the payment does not wait on the record key');
    const record = state.steps.find((s) => s.id === 'record');
    assert.equal(record.status, 'blocked');
    assert.equal(record.detail.written, 0);
    assert.equal(record.detail.refusal, 'record-writer-failed');
    assert.match(record.detail.error, /a pin of this run already exists/);
    assert.equal(fs.existsSync(path.join(runDir, 'records')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'keys')), false, 'no key was made at the record step in place of the one refused at the start');
    assert.equal(fs.readFileSync(pin, 'utf8'), 'a pin that was here before the run\n');
    assert.deepEqual(fs.readdirSync(dir), [runId]);
  } finally {
    removeDir(dir);
  }
});

test('the served / is the screens, and neither the deck the page loads nor the state of a run carries a fictional line', async () => {
  const page = await demo.get('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['content-security-policy'], SCREEN_POLICY);
  assert.ok(page.bytes.equals(fs.readFileSync(path.join(VIEW_DIR, 'index.html'))), 'the page is the view, byte for byte');
  assert.match(page.text, /<script type="module" src="\.\/view\.mjs"><\/script>/);

  const deck = await demo.get('/copy.json');
  assert.equal(deck.status, 200);
  assert.equal(Object.hasOwn(deck.json(), 'footer.fictional'), false, 'the deck has no fictional line');
  assert.equal(Object.hasOwn(clean.state, 'fictionalLine'), false);
  assert.equal(Object.hasOwn(poisoned.state, 'fictionalLine'), false);

  // The page's own files, each under its type, and the label map at both places the page reads it.
  const types = { '/view.mjs': 'text/javascript; charset=utf-8', '/view.css': 'text/css; charset=utf-8', '/labels.json': 'application/json; charset=utf-8', '/fonts/inter-latin-wght.woff2': 'font/woff2' };
  for (const [target, type] of Object.entries(types)) {
    const file = await demo.get(target);
    assert.equal(file.status, 200, target);
    assert.equal(file.headers['content-type'], type, target);
    assert.ok(file.bytes.equals(fs.readFileSync(path.join(VIEW_DIR, ...target.split('/').filter(Boolean)))), target);
  }
  // The label route: the contract's label map, each member as
  // three-party/labels.json has it, with the screens' words beside them.
  const labels = await demo.get('/api/labels');
  assert.equal(labels.status, 200);
  assert.equal(labels.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(assertLabelMapAnswer(labels.json(), { withWords: true }) > 60);

  // The same policy the view was built and tested under.
  const dev = await startDevServer();
  try {
    const devPage = await request({ port: dev.port, path: '/' });
    assert.equal(devPage.headers['content-security-policy'], SCREEN_POLICY);
  } finally {
    await dev.close();
  }
});

test('the listener serves the page\'s files and no other file: not the view\'s tools, not a path that leaves the view, and a foreign Host is refused', async () => {
  for (const target of ['/dev-server.mjs', '/stills.mjs', '/%2e%2e/package.json', '/..%2fpackage.json', '/.gitignore', '/fonts', '/no-such-file.mjs', '/view.mjs/', '/README.md']) {
    assert.equal((await demo.get(target)).status, 404, target);
  }
  assert.equal((await demo.post('/')).status, 405);
  assert.equal((await demo.post('/view.mjs')).status, 405);
  assert.equal((await demo.get('/favicon.ico')).status, 204);
  assert.equal((await demo.get('/', { Host: 'example.test' })).status, 403);
  assert.equal((await demo.get('/view.mjs', { Host: `127.0.0.1:${demo.port}`, Origin: 'http://example.test' })).status, 403);
  // A HEAD request names the file and carries no body.
  const head = await request({ port: demo.port, method: 'HEAD', path: '/view.css' });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
});

test('no file under a run directory, and no pin, contains an access token value', async () => {
  assert.ok(witness.length >= 2, `the bank issued a token to each run (${witness.length} seen)`);
  for (const token of witness) assert.ok(typeof token === 'string' && token.length >= 16, 'a token value is a string long enough to look for');
  let looked = 0;
  for (const dir of [demo.runsDir, pinsDirOf(demo.runsDir)]) {
    for (const file of walkFiles(dir)) {
      const bytes = fs.readFileSync(path.join(dir, file));
      for (const token of witness) {
        assert.equal(bytes.includes(Buffer.from(token, 'utf8')), false, `${file} holds an access token value`);
        assert.equal(bytes.includes(Buffer.from(Buffer.from(token, 'utf8').toString('base64'), 'ascii')), false, `${file} holds an access token value in base64`);
      }
      looked += 1;
    }
  }
  // A crossing that ran the AI2II capture check writes no hop file.
  const hopless = [clean, poisoned].filter((run) => run.state.steps.find((s) => s.id === 'crossing').detail.hopFile === null).length;
  assert.ok(looked >= 40 - hopless, `every file of the two runs and their pins was read (${looked})`);
  // The grant of each run is in its state without the token.
  for (const run of [clean, poisoned]) {
    assert.equal(run.state.grant.tokenType, 'Bearer');
    assert.equal(Object.keys(run.state.grant).some((k) => /token$/i.test(k) && k !== 'tokenType'), false);
  }
});
