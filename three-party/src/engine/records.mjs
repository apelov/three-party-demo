// The engine's side of the record seam. It calls the record modules
// (three-party/src/record: the test key, the writer and the offline check)
// with the places the engine keeps things, and adds no check of its own.
//
// The pin of a run is the public key captured when the run starts. The
// engine holds it beside the runs directory, in a directory of its own:
//
//   <runs directory>.pins/<runId>.pub.pem
//
// so the runs directory holds run directories and nothing else, and a pin is
// outside the run directory it speaks for.

import path from 'node:path';
import { offlineCheck } from '../record/check.mjs';
import { generateTestKey, liveTestKey } from '../record/testkey.mjs';
import { writeRun } from '../record/writer.mjs';

export const PINS_SUFFIX = '.pins';

// The directory that holds the pins of the runs under runsDir.
export function pinsDirOf(runsDir) {
  return `${path.resolve(runsDir)}${PINS_SUFFIX}`;
}

// The pin file of one run directory.
export function pinFileOf(runDir) {
  const abs = path.resolve(runDir);
  return path.join(pinsDirOf(path.dirname(abs)), `${path.basename(abs)}.pub.pem`);
}

// The tree's own record writer, as the engine's run calls it:
//
//   begin(runDir)     when the run starts: makes the run's test key and
//                     captures its pin. The private key stays in this process
//                     and reaches no file.
//   writeRun(runDir)  at the record step: one package per action file, the
//                     tampered copy and the manifest, signed with that key,
//                     which the writer deletes once the last record is signed.
//   abandon(runDir)   on a way out that did not reach the record step:
//                     deletes the key. After writeRun it changes nothing.
export const recordWriter = Object.freeze({
  begin(runDir) {
    const keys = generateTestKey(runDir, { pinFile: pinFileOf(runDir) });
    return { signerSha256: keys.signerSha256, pinFile: keys.pinFile };
  },
  writeRun(runDir) {
    const keys = liveTestKey(runDir);
    // The writer would make a key here, with its pin in another place. A run
    // has one key, made when it started, so a run without it is refused.
    if (!keys) throw new Error('this run has no live test key: the key is made when the run starts, and a run has one key');
    return writeRun(runDir, keys);
  },
  abandon(runDir) {
    const keys = liveTestKey(runDir);
    return keys ? keys.destroy({ lastRecordSigned: false }) : null;
  },
});

// Runs the offline check of three-party/src/record over one run directory,
// with the pin the engine captured when that run started, and returns what
// the check returned: its exit status, its output lines, its notes, and the
// result it wrote to offline-check.json (null when it wrote none). Text
// mode prints the lines.
export async function offlineCheckReturned(runDir) {
  const { exitCode, lines, notes, result } = await offlineCheck(runDir, { pinFile: pinFileOf(runDir) });
  return { exitCode, lines, notes, result };
}

// The answer of the offline check route for one run directory: the object
// the check wrote to offline-check.json when it wrote one (the verifier
// ran), and the check's exit status, lines and notes when it wrote none.
export async function offlineCheckOf(runDir) {
  const { exitCode, lines, notes, result } = await offlineCheckReturned(runDir);
  return result ?? { exitCode, lines, notes };
}
