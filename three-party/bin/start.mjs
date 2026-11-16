#!/usr/bin/env node
// The three-party demo, from a terminal.
//
//   node three-party/bin/start.mjs
//       starts the demo: the screens and the run API on 127.0.0.1, and
//       prints the address to open in a browser
//   node three-party/bin/start.mjs --text [--run clean|poisoned|both] [--offline-check] [--pace <seconds>]
//       runs in this terminal and prints one line per step as it happens
//   node three-party/bin/start.mjs --serve [--port <n>] [--pace <seconds>]
//       starts the same listener with options, and prints one line
//
// This file imports node: modules alone until it has checked the Node.js
// version and that the dependencies are installed, so a missing `npm ci`
// reads as one line with its fix and not as a module error.

import path from 'node:path';

const USAGE = [
  'Usage:',
  '  node three-party/bin/start.mjs',
  '  node three-party/bin/start.mjs --text [--run clean|poisoned|both] [--offline-check] [--pace <seconds>] [--runs-dir <dir>]',
  '  node three-party/bin/start.mjs --serve [--port <n>] [--pace <seconds>] [--runs-dir <dir>]',
  '',
  '  (no option)      start the demo: the screens and the run API on 127.0.0.1 (port 7390, or the next free port)',
  '  --text           run in this terminal, one line per step as it happens',
  '  --run            which run: clean, poisoned or both (default both, clean then poisoned)',
  '  --offline-check  with --text: after each run, run the offline check and print what it returned',
  '  --serve          start the same listener as with no option, with the options below; it prints one line',
  '  --port           the port for --serve; the demo stops if it is in use',
  '  --pace           seconds to wait after each step, 0 to 15 (default 8)',
  '  --runs-dir       where run directories are written (default three-party/runs)',
];

const MIN_NODE = [22, 12, 0];

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

// A reader that closes the pipe early (for example `| head`) ends the demo
// quietly.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); });

function refuse(lines, code = 1) {
  for (const l of lines) err(l);
  process.exit(code);
}

// Ends the process once everything written so far has left it: a write to a
// pipe can still be on its way when the last line is written.
function exitWhenWritten(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

function usageError(message) {
  refuse([message, ...USAGE], 2);
}

function parseArgs(argv) {
  const opts = { mode: null, run: 'both', offlineCheck: false, pace: null, port: null, runsDir: null, help: false };
  const value = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) usageError(`${name} needs a value.`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--text' || a === '--serve') {
      if (opts.mode && opts.mode !== a.slice(2)) usageError('Give --text or --serve, not both.');
      opts.mode = a.slice(2);
    } else if (a === '--run') {
      opts.run = value(i, a);
      i += 1;
      if (!['clean', 'poisoned', 'both'].includes(opts.run)) usageError(`--run is clean, poisoned or both, not ${JSON.stringify(opts.run)}.`);
    } else if (a === '--offline-check') {
      opts.offlineCheck = true;
    } else if (a === '--pace') {
      const text = value(i, a);
      i += 1;
      opts.pace = /^[0-9]+(\.[0-9]+)?$/.test(text) ? Number(text) : NaN;
      if (Number.isNaN(opts.pace)) usageError(`--pace is a number of seconds, not ${JSON.stringify(text)}.`);
    } else if (a === '--port') {
      const text = value(i, a);
      i += 1;
      opts.port = /^[0-9]+$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) usageError(`--port is a port number from 1 to 65535, not ${JSON.stringify(text)}.`);
    } else if (a === '--runs-dir') {
      opts.runsDir = path.resolve(value(i, a));
      i += 1;
    } else {
      usageError(`Unknown argument ${JSON.stringify(a)}.`);
    }
  }
  return opts;
}

function startChecks() {
  const v = process.versions.node.split('.').map(Number);
  const tooOld = v[0] < MIN_NODE[0] || (v[0] === MIN_NODE[0] && (v[1] < MIN_NODE[1] || (v[1] === MIN_NODE[1] && v[2] < MIN_NODE[2])));
  if (tooOld) {
    refuse([`This demo needs Node.js ${MIN_NODE.join('.')} or later. This is Node.js ${process.versions.node}.`, `Fix: install Node.js ${MIN_NODE.join('.')} or later, then run: npm ci`]);
  }
  for (const dep of ['secretless-ai/dist/broker/index.js', '@opena2a/atx-verify', '@noble/post-quantum/ml-dsa.js']) {
    try {
      import.meta.resolve(dep);
    } catch {
      refuse(['Dependencies are not installed.', 'Fix: npm ci']);
    }
  }
}

async function textMode(opts) {
  const { EXPECTED, startRun } = await import('../src/engine/run.mjs');
  const { LABELS, fill } = await import('../src/engine/labels.mjs');
  const { headerLines, offlineCheckLines, outcomeLine, runDirectoryLine, stepLine } = await import('../src/engine/text.mjs');
  const kinds = opts.run === 'both' ? ['clean', 'poisoned'] : [opts.run];
  let failed = false;
  let live = null;
  // Ctrl+C: the run in progress is stopped and writes its final state, its
  // last lines are printed, and the process ends with 130.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (live) await live.abort();
    exitWhenWritten(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  for (const [i, kind] of kinds.entries()) {
    if (i > 0) out('');
    let headerDone = false;
    const header = (state) => {
      if (headerDone) return;
      headerDone = true;
      for (const line of headerLines(state)) out(line);
    };
    let finishedAt = null;
    const run = await startRun({
      kind,
      ...(opts.pace === null ? {} : { paceSeconds: opts.pace }),
      ...(opts.runsDir === null ? {} : { runsDir: opts.runsDir }),
      onEvent: (event) => {
        header(event.state);
        if (event.type === 'step') out(stepLine(event.step, event.state, event.at, event.note));
        if (event.type === 'finished') finishedAt = event.at;
      },
    });
    live = run;
    header(run.state());
    const { state, error } = await run.done;
    live = null;
    out(outcomeLine(state, finishedAt ?? new Date()));
    out(runDirectoryLine(run.runDir, process.cwd()));
    if (stopping) return;
    // The offline check of the run just made, when asked for: its lines as
    // the check returned them, and its exit status. The exit code of this
    // command still says how the runs ended, not what the check returned.
    if (opts.offlineCheck) {
      const { offlineCheckReturned } = await import('../src/engine/records.mjs');
      const result = await offlineCheckReturned(run.runDir);
      for (const line of offlineCheckLines(result, new Date())) out(line);
      if (stopping) return;
    }
    const expected = EXPECTED[kind];
    if (state.outcome !== expected.outcome || state.blockedAt !== expected.blockedAt) {
      failed = true;
      const ended = state.outcome === 'blocked' ? `blocked at ${state.blockedAt}` : String(state.outcome);
      const wanted = expected.outcome === 'blocked' ? `blocked at ${expected.blockedAt}` : expected.outcome;
      err(fill(LABELS.cli.unexpected, { kind, outcome: ended, expected: wanted }));
    }
    if (error) {
      failed = true;
      err(fill(LABELS.cli.engineError, { kind, message: error?.message ?? String(error) }));
    }
  }
  exitWhenWritten(failed ? 1 : 0);
}

// The demo's listener: the run API, the screens, and the offline check of
// three-party/src/record behind the API's offline check route. Started with
// no option it prints the three lines of the demo; with --serve, one line.
async function serveMode(opts) {
  const { startApi } = await import('../src/engine/api.mjs');
  const { demoBuild, demoBuildWords } = await import('../src/engine/build.mjs');
  const { LABELS, fill } = await import('../src/engine/labels.mjs');
  const { offlineCheckOf } = await import('../src/engine/records.mjs');
  const { VIEW_DIR } = await import('../src/engine/screens.mjs');
  const build = demoBuild();
  let api;
  try {
    api = await startApi({
      port: opts.port,
      ...(opts.pace === null ? {} : { paceSeconds: opts.pace }),
      ...(opts.runsDir === null ? {} : { runsDir: opts.runsDir }),
      viewDir: VIEW_DIR,
      offlineCheck: offlineCheckOf,
      build: build.sha7,
    });
  } catch (e) {
    if (e.code === 'EADDRINUSE') refuse([`Port ${opts.port ?? 'from 7390 on'} on 127.0.0.1 is in use.`, 'Fix: stop the process that holds it, or give another port with --port.']);
    throw e;
  }
  if (opts.mode === 'demo') {
    out(fill(LABELS.cli.demoTitle, { build: demoBuildWords(build) }));
    out(fill(LABELS.cli.demoReady, { port: api.port }));
    out(LABELS.cli.demoStop);
  } else {
    out(fill(LABELS.cli.serving, { port: api.port, build: api.build ?? 'not from a git clone' }));
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await api.stop().catch(() => {});
    exitWhenWritten(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) {
    for (const l of USAGE) out(l);
    return;
  }
  // With no argument at all the demo starts. An option names its mode.
  if (argv.length === 0) opts.mode = 'demo';
  if (!opts.mode) usageError('Give --text or --serve.');
  if (opts.mode === 'serve' && opts.run !== 'both') usageError('--run goes with --text.');
  if (opts.mode === 'serve' && opts.offlineCheck) usageError('--offline-check goes with --text.');
  if (opts.mode === 'text' && opts.port !== null) usageError('--port goes with --serve.');
  if (opts.pace !== null && (opts.pace < 0 || opts.pace > 15)) {
    usageError('--pace is from 0 to 15 seconds: the grant lives 60 seconds, and a longer pace would let it expire before the payment.');
  }
  startChecks();
  if (opts.mode === 'text') await textMode(opts);
  else await serveMode(opts);
}

main().catch((e) => {
  err(`The demo stopped on an error: ${e?.message ?? e}`);
  exitWhenWritten(1);
});
