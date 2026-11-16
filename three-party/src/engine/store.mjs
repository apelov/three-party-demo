// The run directory and the files the engine writes into it (CONTRACT.md
// sections 3 to 5): state.json, the action files with the response bytes
// beside them, and the hop file. Every file is written whole under a
// temporary name in the directory it belongs to and then renamed into place,
// so a reader sees the previous file or the new one and never part of one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUN_KINDS = Object.freeze(['clean', 'poisoned']);
export const RUN_ID = /^(clean|poisoned)-[0-9]{8}T[0-9]{6}Z$/;

// RFC 3339 UTC to the second: 2026-11-15T12:00:00Z.
export function utcStamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

// The time part of a run id: 20261115T120000Z.
export function compactStamp(date) {
  return utcStamp(date).replace(/[-:]/g, '');
}

// The clock of a text mode line: 120000.
export function clockDigits(date) {
  return date.toISOString().slice(11, 19).replace(/:/g, '');
}

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

let tempCounter = 0;

// Writes a file whole, then renames it into place.
export function writeFileAtomic(file, bytes) {
  tempCounter += 1;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${tempCounter}.tmp`);
  fs.writeFileSync(temp, bytes);
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Makes the directory of a new run and returns its id. A run id names its
// kind and the second it started, so a run of the same kind started within
// the same second waits for the next one.
export async function createRunDir({ runsDir, kind, clock }) {
  if (!RUN_KINDS.includes(kind)) throw new Error(`a run is clean or poisoned, not ${JSON.stringify(kind)}`);
  fs.mkdirSync(runsDir, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const startedAt = clock();
    const runId = `${kind}-${compactStamp(startedAt)}`;
    const runDir = path.join(runsDir, runId);
    try {
      fs.mkdirSync(runDir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await wait(1000 - (Date.now() % 1000) + 5);
      continue;
    }
    fs.mkdirSync(path.join(runDir, 'actions'));
    fs.mkdirSync(path.join(runDir, 'hops'));
    return { runId, runDir, startedAt };
  }
  throw new Error('no free run id: too many runs of one kind started at once');
}

const two = (n) => String(n).padStart(2, '0');

// Relative paths of a step's files inside the run directory.
export function actionPaths(seq, step) {
  const base = `${two(seq)}-${step}`;
  return {
    action: `actions/${base}.action.json`,
    response: `actions/${base}.response.txt`,
    responseName: `${base}.response.txt`,
    hop: `hops/${base}.hop.json`,
    record: `records/${base}.aep`,
  };
}

// Writes one action: the response bytes beside the action file, then the
// action file of CONTRACT.md section 5, in its field order. Returns the
// action file's relative path.
export function writeAction(runDir, { runId, seq, step, kind, at, actor, domainFrom, domainTo, declaredIntent, toolCall, decision, reason, responseStatus, responseBody }) {
  const paths = actionPaths(seq, step);
  const body = Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(String(responseBody), 'utf8');
  writeFileAtomic(path.join(runDir, paths.response), body);
  writeJsonAtomic(path.join(runDir, paths.action), {
    runId,
    seq,
    step,
    kind,
    at,
    actor,
    domainFrom,
    domainTo,
    declaredIntent: declaredIntent ?? null,
    toolCall: toolCall ?? null,
    decision,
    reason,
    response: { status: responseStatus ?? null, bodySha256: sha256Hex(body), bodyFile: paths.responseName },
  });
  return paths.action;
}
