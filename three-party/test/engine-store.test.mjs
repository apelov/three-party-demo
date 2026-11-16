// The run directory and the way its files are written: whole, under a
// temporary name in the same directory, then renamed into place, so a reader
// gets the previous file or the new one and never part of one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_ID, actionPaths, clockDigits, compactStamp, createRunDir, sha256Hex, utcStamp, writeAction, writeFileAtomic, writeJsonAtomic } from '../src/engine/store.mjs';
import { runToEnd } from '../src/engine/run.mjs';
import { example, removeDir, tempRunsDir } from './support/engine-helpers.mjs';

const at = new Date('2026-11-15T12:00:07.900Z');

test('times: RFC 3339 UTC to the second, the run id form, and the clock of a text line', () => {
  assert.equal(utcStamp(at), '2026-11-15T12:00:07Z');
  assert.equal(compactStamp(at), '20261115T120007Z');
  assert.equal(clockDigits(at), '120007');
  assert.match(`clean-${compactStamp(at)}`, RUN_ID);
  assert.match(example('state-clean-done.json').runId, RUN_ID);
  assert.match(example('state-poisoned-blocked.json').runId, RUN_ID);
  for (const bad of ['other-20261115T120007Z', 'clean-20261115T120007', 'clean-2026-11-15T12:00:07Z', '../clean-20261115T120007Z', 'clean-20261115T120007Z/x']) {
    assert.equal(RUN_ID.test(bad), false, bad);
  }
});

test('a written file replaces the one before it by a rename: a reader that opened the earlier file still reads all of it, and no temporary file stays', () => {
  const dir = tempRunsDir();
  try {
    const file = path.join(dir, 'state.json');
    const earlier = { status: 'running', filler: 'a'.repeat(64 * 1024) };
    const later = { status: 'passed', filler: 'b'.repeat(8) };
    writeJsonAtomic(file, earlier);
    const inodeBefore = fs.statSync(file).ino;
    // A reader that has the file open while the next state is written.
    const fd = fs.openSync(file, 'r');
    try {
      writeJsonAtomic(file, later);
      const stillOpen = fs.readFileSync(fd, 'utf8');
      assert.deepEqual(JSON.parse(stillOpen), earlier, 'the open file is the earlier file, whole');
    } finally {
      fs.closeSync(fd);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), later, 'the name gives the later file, whole');
    assert.notEqual(fs.statSync(file).ino, inodeBefore, 'a new file took the name; the earlier one was not written over');
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no temporary file stays');
    assert.equal(fs.readFileSync(file, 'utf8').endsWith('}\n'), true);
  } finally {
    removeDir(dir);
  }
});

test('a write that cannot take its place leaves the earlier file as it was and removes its temporary file', () => {
  const dir = tempRunsDir();
  try {
    const file = path.join(dir, 'state.json');
    // A directory holds the name, so the rename is refused.
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'kept.txt'), 'kept');
    assert.throws(() => writeFileAtomic(file, 'new bytes'));
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    assert.equal(fs.readFileSync(path.join(file, 'kept.txt'), 'utf8'), 'kept');
  } finally {
    removeDir(dir);
  }
});

test('state.json parses at every wait of a run, between one write and the next, and each reading is a whole state', async () => {
  const dir = tempRunsDir();
  const readings = [];
  let runDir = null;
  try {
    const result = await runToEnd({
      kind: 'clean',
      paceSeconds: 0,
      runsDir: dir,
      recordWriter: null,
      // Every wait of the engine lies between two writes of state.json.
      sleep: async () => {
        runDir ??= path.join(dir, fs.readdirSync(dir)[0]);
        const text = fs.readFileSync(path.join(runDir, 'state.json'), 'utf8');
        readings.push(JSON.parse(text));
        assert.deepEqual(fs.readdirSync(runDir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left between writes');
      },
    });
    assert.equal(result.error, null);
    // One wait after the start, two for each of the five steps that run, one at the record step.
    assert.equal(readings.length, 12);
    for (const state of readings) {
      assert.equal(state.runId, result.runId);
      assert.equal(state.steps.length, 6);
      assert.equal(state.finishedAt, null);
    }
    // What a reader sees over time: nothing started, then each step running, then its result.
    const seen = readings.map((s) => s.steps.map((x) => x.status).join(','));
    assert.equal(seen[0], 'pending,pending,pending,pending,pending,pending');
    assert.equal(seen[1], 'running,pending,pending,pending,pending,pending');
    assert.equal(seen[2], 'passed,pending,pending,pending,pending,pending');
    assert.equal(seen[3], 'passed,running,pending,pending,pending,pending');
    assert.equal(seen[9], 'passed,passed,passed,passed,running,pending');
    assert.equal(seen[10], 'passed,passed,passed,passed,passed,pending');
    assert.equal(seen[11], 'passed,passed,passed,passed,passed,pending');
    assert.equal(readings[2].grant, null);
    assert.equal(readings[4].grant.tokenType, 'Bearer', 'the grant shows once its step has passed');
    assert.equal(readings[9].outcome, null);
    assert.equal(readings[10].outcome, 'paid');
    // A step that reads running has a start time and no result yet.
    const running = readings[3].steps[1];
    assert.match(running.startedAt, /Z$/);
    assert.deepEqual({ endedAt: running.endedAt, detail: running.detail, actionFile: running.actionFile }, { endedAt: null, detail: null, actionFile: null });
    // A step's action file is on disk before the state that names it.
    assert.equal(readings[2].steps[0].actionFile, 'actions/01-credential.action.json');
  } finally {
    removeDir(dir);
  }
});

test('a run directory is made once per run id, with its actions and hops directories, and a kind that is not a run kind is refused', async () => {
  const dir = tempRunsDir();
  try {
    const made = await createRunDir({ runsDir: path.join(dir, 'nested', 'runs'), kind: 'clean', clock: () => at });
    assert.equal(made.runId, 'clean-20261115T120007Z');
    assert.equal(made.runDir, path.join(dir, 'nested', 'runs', made.runId));
    assert.deepEqual(fs.readdirSync(made.runDir).sort(), ['actions', 'hops']);
    await assert.rejects(createRunDir({ runsDir: dir, kind: 'tampered', clock: () => at }), /clean or poisoned/);
    assert.deepEqual(fs.readdirSync(dir), ['nested']);
  } finally {
    removeDir(dir);
  }
});

test('an action is written as the response bytes, then the action file that names their hash, in the contract field order', () => {
  const dir = tempRunsDir();
  try {
    fs.mkdirSync(path.join(dir, 'actions'));
    const ex = example('action-05-pay.action.json');
    const body = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x0a, 0x00, 0xff]);
    const rel = writeAction(dir, {
      runId: ex.runId, seq: 5, step: 'pay', kind: 'clean', at: ex.at, actor: ex.actor, domainFrom: ex.domainFrom, domainTo: ex.domainTo,
      declaredIntent: ex.declaredIntent, toolCall: ex.toolCall, decision: ex.decision, reason: ex.reason, responseStatus: 201, responseBody: body,
    });
    assert.equal(rel, 'actions/05-pay.action.json');
    const action = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    assert.deepEqual(Object.keys(action), Object.keys(ex));
    assert.deepEqual({ ...action, response: { ...action.response, bodySha256: ex.response.bodySha256 } }, ex, 'every field of the example but the hash, which is measured');
    const saved = fs.readFileSync(path.join(dir, 'actions', action.response.bodyFile));
    assert.deepEqual(saved, body, 'the response bytes are saved as they came, not as text');
    assert.equal(action.response.bodySha256, crypto.createHash('sha256').update(body).digest('hex'));
    assert.equal(action.response.bodySha256, sha256Hex(body));
    // No intent, no tool call and no status are written as null, not left out.
    const bare = writeAction(dir, { runId: ex.runId, seq: 1, step: 'credential', kind: 'clean', at: ex.at, actor: ex.actor, domainFrom: 'a', domainTo: 'a', decision: 'allowed', reason: 'r', responseBody: 'text' });
    const plain = JSON.parse(fs.readFileSync(path.join(dir, bare), 'utf8'));
    assert.deepEqual(Object.keys(plain), Object.keys(ex));
    assert.deepEqual({ declaredIntent: plain.declaredIntent, toolCall: plain.toolCall, status: plain.response.status }, { declaredIntent: null, toolCall: null, status: null });
    assert.deepEqual(actionPaths(3, 'crossing'), {
      action: 'actions/03-crossing.action.json',
      response: 'actions/03-crossing.response.txt',
      responseName: '03-crossing.response.txt',
      hop: 'hops/03-crossing.hop.json',
      record: 'records/03-crossing.aep',
    });
  } finally {
    removeDir(dir);
  }
});
