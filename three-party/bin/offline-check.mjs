// node three-party/bin/offline-check.mjs <runDir> [--out <file>] [--pin <file>]
//
// The offline check of one run directory (src/record/check.mjs). It prints
// what it found on standard output, one line per fact, and what explains an
// ending on standard error. This file reads its arguments and nothing else:
// no environment variable, and no file of its own.

import { EXIT, offlineCheck } from '../src/record/check.mjs';

const USAGE = `usage: node three-party/bin/offline-check.mjs <runDir> [--out <file>] [--pin <file>]

  <runDir>       a run directory whose records are written (it has records/manifest.json)
  --out <file>   where the result is written (default: <runDir>/offline-check.json)
  --pin <file>   the public key captured when the run started (default: beside the
                 run directory, in .pins/<runId>.pub.pem); never a file inside <runDir>

The check looks for a private key in the run directory, then shows that a
method denies the network: a probe started with no method reaches the check's
own listener on 127.0.0.1, and started under the method it does not. The
method is sandbox-exec on macOS, and on Linux a new network namespace made by
unshare, or by bwrap where unshare cannot make one. The verifier then runs
under that method on each record file: the files under records/ and
records/tampered/, and the files records/manifest.json names. Where no method
shows the denial (Windows has none that works without administrator rights),
the check prints network denied: not measured, still runs the verifier with an
empty environment and no method, and the result says so.

exit 0  every record passed steps 1 to 6, every tampered copy was rejected, and the
        disk and the manifest agree; the result is written, and says whether the
        network denial was measured
exit 4  the verifier ran and the result is not that; the result is written
exit 1  an error: a wrong argument, a directory that is not a run, a private key in
        the run directory, no pin; nothing is written
exit 3  the probe reached the network under the method meant to deny it: nothing
        was checked, nothing was written
`;

function readArguments(argv) {
  const options = { runDir: null, out: null, pinFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === '--out' || word === '--pin') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return null;
      options[word === '--out' ? 'out' : 'pinFile'] = value;
      i += 1;
    } else if (word.startsWith('-') || options.runDir !== null) {
      return null;
    } else {
      options.runDir = word;
    }
  }
  return options.runDir === null || options.runDir === '' ? null : options;
}

const tell = (line) => process.stderr.write(`offline-check: ${line}\n`);
const options = readArguments(process.argv.slice(2));
if (options === null) {
  process.stderr.write(USAGE);
  process.exitCode = EXIT.ERROR;
} else {
  try {
    const { exitCode } = await offlineCheck(options.runDir, {
      out: options.out,
      pinFile: options.pinFile,
      print: (line) => process.stdout.write(`${line}\n`),
      note: tell,
    });
    process.exitCode = exitCode;
  } catch (error) {
    tell(`the check ended on an error and reports nothing: ${error.message}`);
    process.exitCode = EXIT.ERROR;
  }
}
