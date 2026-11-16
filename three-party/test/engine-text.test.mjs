// Text mode: the label map against the contract examples, the lines built
// from a state, and the command line itself, run as a child process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LABEL_MAP } from '../src/engine/label-map.mjs';
import { LABELS, fill, stepLabel } from '../src/engine/labels.mjs';
import { NO_RECORD_WRITER, displayPath, headerLines, outcomeLine, partCell, runDirectoryLine, stepDetailText, stepLine } from '../src/engine/text.mjs';
import { REPO_ROOT, START, example, readJson, removeDir, request, runStart, tempRunsDir } from './support/engine-helpers.mjs';

const HEADER = [
  'Three parts, one payment',
  "The supplier's bank is a mock bank on this computer, and the payments agent is scripted.",
];
const POISONED_LINE = 'The poisoned invoice is modeled on what OpenA2A honeypots saw; no captured traffic is replayed.';
const paceLine = (seconds) => `Times in UTC. Paced for viewing: at least ${seconds} seconds per step.`;
const REASON = 'The credential and the grant were valid, but the agent asked for a secret and changed the payee, which its declared intent does not allow.';
const TITLES = {
  credential: "Verify the agent's ATX credential locally",
  grant: 'Issue a scoped AAP grant',
  crossing: "Cross into the supplier's bank's trust domain",
  intent: 'Apply the intent rule to each tool call',
  pay: 'Pay the invoice under the grant',
  record: 'Write one signed Action Evidence Package per action',
};
// The part labels of contract revision 3, by the part id a step carries in
// state.json, and the cell text mode prints for each: a stand-in part's label
// is followed by the stand-in mark.
const PART_LABELS = { checkpoint: 'OpenA2A · ATX · AAP', crossing: 'WIMSE · AI2II', record: 'AEP', bank: "Supplier's bank" };
const PART_CELLS = { checkpoint: 'OpenA2A · ATX · AAP', crossing: 'WIMSE · AI2II (stand-in)', record: 'AEP', bank: "Supplier's bank" };
const CROSSING_NOTE = 'Stand-in: an OpenA2A check of a delegation chain fixture runs here in place of the AI2II capture.';
const TIMESTAMP_NOTE = 'Placeholder: no timestamp authority.';
const STEP_IDS = ['credential', 'grant', 'crossing', 'intent', 'pay', 'record'];
// The command line uses the record build's writer once that file is in the
// tree. Until then the record step of a run it makes stays pending.
const WRITER_IN_TREE = fs.existsSync(path.join(REPO_ROOT, 'three-party/src/record/writer.mjs'));
const RECORD_WORD = WRITER_IN_TREE ? 'Written' : 'Pending';
const at = new Date('2026-11-15T12:00:41Z');
const stepOf = (state, id) => state.steps.find((s) => s.id === id);

test('the label map carries the part labels, the step titles and the set lines byte for byte, as the contract examples do', () => {
  assert.deepEqual(Object.fromEntries(STEP_IDS.map((id) => [stepLabel(id).part, stepLabel(id).partLabel])), PART_LABELS);
  assert.deepEqual(LABELS.steps.map((s) => s.id), STEP_IDS);
  assert.deepEqual(Object.fromEntries(LABELS.steps.map((s) => [s.id, s.title])), TITLES);
  for (const name of ['state-clean-done.json', 'state-clean-running.json', 'state-poisoned-blocked.json']) {
    const ex = example(name);
    assert.deepEqual(ex.steps.map((s) => s.id), STEP_IDS, name);
    for (const s of ex.steps) assert.deepEqual(stepLabel(s.id), { id: s.id, part: s.part, partLabel: s.partLabel, standIn: s.standIn, standInNote: s.standInNote, title: s.title }, `${name} ${s.id}`);
    assert.deepEqual(ex.parties, LABEL_MAP.parties, name);
    assert.equal(Object.hasOwn(ex, 'fictionalLine'), false, name);
    assert.equal(LABELS.domains.agent, ex.agent.domain, name);
    assert.equal(LABELS.agentRole, ex.agent.role, name);
  }
  const poisoned = example('state-poisoned-blocked.json');
  const clean = example('state-clean-done.json');
  assert.equal(Object.hasOwn(LABELS.header, 'fictionalLine'), false);
  assert.equal(LABELS.header.poisonedLine, POISONED_LINE);
  assert.equal(LABELS.header.poisonedLine, poisoned.poisonedLine);
  assert.equal(LABELS.intent.reasonSecretAndPayee, REASON);
  assert.equal(LABELS.intent.reasonSecretAndPayee, poisoned.reason);
  assert.equal(LABELS.intent.rule, stepOf(clean, 'intent').detail.rule);
  assert.equal(LABELS.intent.noDeclaredIntent, stepOf(poisoned, 'intent').detail.calls[0].fieldsDiffering[0]);
  assert.equal(LABELS.crossing.standIn, stepOf(clean, 'crossing').detail.standIn);
  assert.equal(LABELS.domains.bank, stepOf(clean, 'crossing').detail.to);
  assert.equal(LABELS.credential.postQuantumSignature, stepOf(clean, 'credential').detail.postQuantumSignature);
  const record = stepOf(clean, 'record').detail;
  assert.deepEqual(LABELS.record, { signer: record.signer, credentialCitedBy: record.credentialCitedBy, timestampEntry: record.timestampEntry });
  assert.equal(LABELS.actionReasons.payAllowed, example('action-05-pay.action.json').reason);
  assert.deepEqual({ ...LABEL_MAP.parties }, { agent: 'Payments agent', bank: "Supplier's bank", supplier: 'Supplier', domainA: "Payments agent's domain", domainB: "Supplier's bank's domain", rawIdentifiersNote: 'Test identifiers, used by nothing outside this demo.' });
  assert.equal(LABELS.text.standInPart, '{partLabel} (stand-in)');
  assert.deepEqual(LABELS.statusWords, { pending: 'Pending', running: 'Checking', passed: 'Passed', blocked: 'Stopped', 'not-reached': 'Not reached', written: 'Written' });
  assert.deepEqual(LABELS.outcome, {
    label: 'Outcome',
    paid: 'Paid',
    blockedAtIntent: 'Stopped by the intent rule',
    blockedElsewhere: 'Stopped at: {title}',
    paidText: "Every tool call passed the intent rule, and the supplier's bank accepted payment {paymentId}.",
  });
});

test('no label calls the intent rule a model, a detector or AI, describes the hidden text as replayed or captured, or names a count of events', () => {
  const strings = [];
  const collect = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(LABELS);
  assert.ok(strings.length > 60);
  for (const s of strings) {
    assert.doesNotMatch(s, /\b(model|detector|classifier|AI|LLM|machine learning)\b/, s);
    if (/honeypot/i.test(s)) assert.equal(s, POISONED_LINE, 'the one line that names the honeypots is the set line');
    if (/\b(replayed|captured)\b/i.test(s)) assert.equal(s, POISONED_LINE);
    assert.doesNotMatch(s, /\breal traffic\b/i, s);
  }
  const fixtures = fs.readFileSync(path.join(REPO_ROOT, 'three-party/fixtures/invoices.json'), 'utf8');
  assert.doesNotMatch(fixtures, /\b[0-9][0-9,]* (events|hits|attacks|requests)\b/);
  assert.match(JSON.parse(fixtures).note, /modeled on what OpenA2A honeypots saw; no captured traffic is replayed\.$/);
});

test('fill puts values where the names are, and a name with no value is an error, not a brace in a line', () => {
  assert.equal(fill('at least {paceSeconds} seconds', { paceSeconds: 0 }), 'at least 0 seconds');
  assert.equal(fill('{a} and {a} and {b}', { a: 'x', b: false }), 'x and x and false');
  assert.throws(() => fill('payment {paymentId}', {}), /no value for \{paymentId\}/);
  assert.throws(() => fill('payment {paymentId}', { paymentId: null }), /no value/);
  assert.throws(() => fill('payment {paymentId}', { paymentId: undefined }), /no value/);
  assert.throws(() => stepLabel('audit'), /unknown step/);
});

test('the header: three lines, with the pace the run applied, and the poisoned line after the title on a poisoned run', () => {
  assert.deepEqual(headerLines(example('state-clean-done.json')), [...HEADER, paceLine(8)]);
  assert.deepEqual(headerLines({ ...example('state-clean-done.json'), paceSeconds: 12 }), [...HEADER, paceLine(12)]);
  assert.deepEqual(headerLines(example('state-poisoned-blocked.json')), [HEADER[0], POISONED_LINE, HEADER[1], paceLine(8)]);
});

test('a step line is [hhmmss] part label | title | state word | detail, for every step and status of the contract examples', () => {
  const clean = example('state-clean-done.json');
  const lines = Object.fromEntries(clean.steps.map((s) => [s.id, stepLine(s, clean, at)]));
  assert.equal(lines.credential, "[120041] OpenA2A · ATX · AAP | Verify the agent's ATX credential locally | Passed | valid; signed by the test issuer; not after 2027-10-01T00:00:00Z; file sha256 8e66c6db3c16...");
  assert.equal(lines.grant, '[120041] OpenA2A · ATX · AAP | Issue a scoped AAP grant | Passed | Bearer grant for payment:billpay, expires in 60 seconds; the declared payment is in scope (permissions, creditorAccounts, maximumIndividualAmount, validToDateTime)');
  assert.equal(lines.crossing, `[120041] WIMSE · AI2II (stand-in) | Cross into the supplier's bank's trust domain | Passed | Payments agent to Supplier's bank; chain of 2 hops: valid. ${CROSSING_NOTE}`);
  assert.equal(lines.intent, '[120041] OpenA2A · ATX · AAP | Apply the intent rule to each tool call | Passed | tool calls checked: 1; each equals the declared intent field for field');
  assert.equal(lines.pay, "[120041] Supplier's bank | Pay the invoice under the grant | Passed | POST /payments answered 201; payment DEMO-PAY-000031; 148.20 USD to DEMO-0000-2201; in the bank ledger");
  const record = stepOf(clean, 'record');
  assert.equal(lines.record, `[120041] AEP | Write one signed Action Evidence Package per action | Written | 5 records; ${record.detail.format}; signer: test key generated for this run. ${TIMESTAMP_NOTE}`);

  const poisoned = example('state-poisoned-blocked.json');
  assert.equal(
    stepLine(stepOf(poisoned, 'intent'), poisoned, at),
    '[120041] OpenA2A · ATX · AAP | Apply the intent rule to each tool call | Stopped | secrets.read has no declared intent; bank.payments.create differs in payeeAccount (declared DEMO-0000-2202, called with DEMO-0000-9931)',
  );
  assert.equal(stepLine(stepOf(poisoned, 'pay'), poisoned, at), "[120041] Supplier's bank | Pay the invoice under the grant | Not reached | no payment was sent: the run stopped at an earlier step");

  const running = example('state-clean-running.json');
  assert.equal(stepLine(stepOf(running, 'grant'), running, at), '[120041] OpenA2A · ATX · AAP | Issue a scoped AAP grant | Checking | in progress');
  assert.equal(stepLine(stepOf(running, 'pay'), running, at), "[120041] Supplier's bank | Pay the invoice under the grant | Pending | not started");
  assert.equal(stepLine(stepOf(running, 'record'), running, at), '[120041] AEP | Write one signed Action Evidence Package per action | Pending | not started');
  // The record step of a run that ended with no record writer in the tree.
  assert.equal(
    stepLine(stepOf(running, 'record'), running, at, NO_RECORD_WRITER),
    '[120041] AEP | Write one signed Action Evidence Package per action | Pending | no record written: the record writer (three-party/src/record/writer.mjs) is not in this build',
  );
  // Every line has the four separators and no line break.
  for (const state of [clean, poisoned, running]) {
    for (const s of state.steps) {
      const line = stepLine(s, state, at);
      assert.match(line, /^\[[0-9]{6}\] [^|]+ \| [^|]+ \| (Pending|Checking|Passed|Stopped|Not reached|Written) \| .+$/);
      assert.equal(line.includes('\n'), false);
    }
  }
});

test('a step that was stopped, at any step, says why in its line', () => {
  const state = example('state-clean-done.json');
  const stopped = (id, detail) => stepDetailText({ ...stepOf(state, id), status: 'blocked', detail: { ...stepOf(state, id).detail, ...detail } }, state);
  assert.equal(stopped('credential', { valid: false, refusal: 'credential-signature-invalid' }), 'not accepted: credential-signature-invalid');
  assert.equal(stopped('grant', { refusal: 'grant-scope-creditorAccounts' }), 'no grant: grant-scope-creditorAccounts');
  assert.equal(stopped('crossing', { outcome: 'signature_invalid', refusal: 'crossing-chain-not-valid' }), "Payments agent to Supplier's bank; chain of 2 hops: signature_invalid; crossing-chain-not-valid");
  assert.equal(stopped('pay', { refusal: 'grant-expired' }), 'not paid: grant-expired');
  assert.equal(stopped('record', { refusal: 'record-writer-failed' }), 'the record writer did not finish: record-writer-failed');
  assert.equal(stepDetailText({ ...stepOf(state, 'grant'), status: 'blocked', detail: { refusal: 'engine-error', error: 'the wait failed' } }, state), 'the engine stopped on an error: the wait failed');
  assert.equal(stepDetailText({ ...stepOf(state, 'grant'), status: 'blocked', detail: { refusal: 'run-stopped' } }, state), 'the run was stopped before this step finished');
  assert.equal(stepDetailText({ ...stepOf(state, 'crossing'), status: 'not-reached', detail: null }, state), 'the run stopped at an earlier step');
  // A call the rule stopped that also reached the broker's resolver says so.
  const poisoned = example('state-poisoned-blocked.json');
  const intent = structuredClone(stepOf(poisoned, 'intent'));
  intent.detail.calls[0].brokerResolver = { name: 'bank-api-key', exists: false, resolved: false, refused: true };
  assert.equal(
    stepDetailText(intent, poisoned),
    "secrets.read has no declared intent (the broker's resolver also refused the name bank-api-key); bank.payments.create differs in payeeAccount (declared DEMO-0000-2202, called with DEMO-0000-9931)",
  );
  assert.throws(() => stepLine({ ...stepOf(state, 'pay'), status: 'unknown' }, state, at), /no state word/);
});

test('the outcome line: Paid with the payment id, Stopped by the intent rule with the run\'s reason, and the step named when another step stopped the run', () => {
  const clean = example('state-clean-done.json');
  assert.equal(outcomeLine(clean, new Date('2026-11-15T12:01:12Z')), "[120112] Outcome | Paid | Every tool call passed the intent rule, and the supplier's bank accepted payment DEMO-PAY-000031.");
  const poisoned = example('state-poisoned-blocked.json');
  assert.equal(outcomeLine(poisoned, new Date('2026-11-15T12:04:05Z')), `[120405] Outcome | Stopped by the intent rule | ${REASON}`);
  const atPay = { ...clean, outcome: 'blocked', blockedAt: 'pay', reason: "Every tool call passed the intent rule, but the supplier's bank did not accept the payment (grant-expired)." };
  assert.equal(outcomeLine(atPay, at), "[120041] Outcome | Stopped at: Pay the invoice under the grant | Every tool call passed the intent rule, but the supplier's bank did not accept the payment (grant-expired).");
});

test('the run directory is printed relative to the directory the demo was started from when it lies inside it, and whole when it does not', () => {
  assert.equal(displayPath('/demo/three-party/runs/clean-20261115T120000Z', '/demo'), 'three-party/runs/clean-20261115T120000Z');
  assert.equal(displayPath('/demo/three-party/runs/clean-20261115T120000Z', '/demo/three-party'), 'runs/clean-20261115T120000Z');
  assert.equal(displayPath('/tmp/runs/clean-20261115T120000Z', '/demo'), '/tmp/runs/clean-20261115T120000Z');
  assert.equal(displayPath('/demo-other/runs', '/demo'), '/demo-other/runs', 'a directory beside it is not inside it');
  assert.equal(displayPath('/demo', '/demo'), '/demo');
  assert.equal(runDirectoryLine('/demo/three-party/runs/clean-20261115T120000Z', '/demo'), 'Run directory: three-party/runs/clean-20261115T120000Z');
});

const STEP_LINE = /^\[([0-9]{6})\] (.+?) \| (.+?) \| (.+?) \| (.+)$/;

// Checks the lines text mode printed for one run against the state.json the
// run left, and returns that state. `cwd` is the directory the command line
// was started from.
function checkRunLines(lines, { kind, paceSeconds, runsDir, cwd = REPO_ROOT }) {
  const poisoned = kind === 'poisoned';
  const header = poisoned ? [HEADER[0], POISONED_LINE, HEADER[1], paceLine(paceSeconds)] : [...HEADER, paceLine(paceSeconds)];
  assert.deepEqual(lines.slice(0, header.length), header);
  const rest = lines.slice(header.length);
  assert.equal(rest.length, 8, 'six step lines, the outcome line and the run directory');
  const dirLine = /^Run directory: (.+)$/.exec(rest[7]);
  assert.ok(dirLine, rest[7]);
  const runDir = path.resolve(cwd, dirLine[1]);
  assert.equal(path.dirname(runDir), runsDir);
  assert.match(path.basename(runDir), new RegExp(`^${kind}-[0-9]{8}T[0-9]{6}Z$`));
  const state = readJson(path.join(runDir, 'state.json'));
  const words = poisoned
    ? ['Passed', 'Passed', 'Passed', 'Stopped', 'Not reached', RECORD_WORD]
    : ['Passed', 'Passed', 'Passed', 'Passed', 'Passed', RECORD_WORD];
  let clock = '000000';
  rest.slice(0, 6).forEach((line, i) => {
    const m = STEP_LINE.exec(line);
    assert.ok(m, line);
    const step = state.steps[i];
    assert.equal(m[2], partCell(step));
    // A crossing that ran the supplied AI2II capture check is no stand-in (the
    // command line uses the default AI2II folder, fetched or not).
    assert.equal(m[2], step.variant === 'supplied' ? PART_LABELS[step.part] : PART_CELLS[step.part]);
    assert.equal(step.partLabel, PART_LABELS[step.part]);
    assert.equal(m[3], step.title);
    assert.equal(m[3], TITLES[STEP_IDS[i]]);
    assert.equal(m[4], words[i]);
    assert.equal(m[4], LABELS.statusWords[step.status]);
    assert.ok(m[5].length > 0);
    assert.ok(m[1] >= clock, 'the lines are in time order');
    clock = m[1];
  });
  if (poisoned) {
    assert.match(rest[6], /^\[[0-9]{6}\] Outcome \| Stopped by the intent rule \| /);
    assert.equal(rest[6].split(' | ')[2], REASON);
    assert.equal(state.reason, REASON);
    assert.match(rest[3], /secrets\.read has no declared intent \(the broker's resolver also refused the name bank-api-key\); bank\.payments\.create differs in payeeAccount \(declared DEMO-0000-2202, called with DEMO-0000-9931\)$/);
  } else {
    const paid = /^\[[0-9]{6}\] Outcome \| Paid \| Every tool call passed the intent rule, and the supplier's bank accepted payment (led_[0-9a-f]{16})\.$/.exec(rest[6]);
    assert.ok(paid, rest[6]);
    assert.equal(paid[1], stepOf(state, 'pay').detail.paymentId, 'the payment id on the line is the one the bank gave');
    assert.match(rest[4], new RegExp(`payment ${paid[1]}; 148\\.20 USD to DEMO-0000-2201; in the bank ledger$`));
  }
  if (!WRITER_IN_TREE) assert.match(rest[5], / \| Pending \| no record written: the record writer \(three-party\/src\/record\/writer\.mjs\) is not in this build$/);
  assert.equal(state.paceSeconds, paceSeconds);
  return state;
}

test('node three-party/bin/start.mjs --text --run both: a clean run then a poisoned run, one line per step, exit 0', async () => {
  const dir = tempRunsDir();
  try {
    const r = await runStart(['--text', '--run', 'both', '--pace', '0', '--runs-dir', dir]);
    assert.equal(r.timedOut, false);
    assert.equal(r.stderr, '');
    assert.equal(r.code, 0);
    const gap = r.lines.indexOf('');
    assert.equal(gap, 11, 'the clean run prints three header lines and eight more, then an empty line');
    assert.equal(r.lines.length, 11 + 1 + 12);
    const clean = checkRunLines(r.lines.slice(0, gap), { kind: 'clean', paceSeconds: 0, runsDir: dir });
    const poisoned = checkRunLines(r.lines.slice(gap + 1), { kind: 'poisoned', paceSeconds: 0, runsDir: dir });
    assert.equal(clean.outcome, 'paid');
    assert.equal(poisoned.outcome, 'blocked');
    assert.equal(poisoned.blockedAt, 'intent');
    assert.equal(fs.readdirSync(dir).length, 2);
    // No line names a vendor, a role or a task, and none calls the rule anything but a rule.
    for (const line of r.lines) assert.doesNotMatch(line, /\b(model|detector|classifier|AI|LLM)\b/, line);
  } finally {
    removeDir(dir);
  }
});

test('--run clean and --run poisoned each print one run; a pace is carried into the header and the state', async () => {
  const dir = tempRunsDir();
  try {
    const clean = await runStart(['--text', '--run', 'clean', '--pace', '0', '--runs-dir', dir]);
    assert.equal(clean.code, 0);
    assert.equal(clean.lines.length, 11);
    checkRunLines(clean.lines, { kind: 'clean', paceSeconds: 0, runsDir: dir });
    const poisoned = await runStart(['--text', '--run', 'poisoned', '--pace', '0.05', '--runs-dir', dir]);
    assert.equal(poisoned.code, 0);
    assert.equal(poisoned.lines.length, 12);
    assert.equal(poisoned.lines[3], 'Times in UTC. Paced for viewing: at least 0.05 seconds per step.');
    checkRunLines(poisoned.lines, { kind: 'poisoned', paceSeconds: 0.05, runsDir: dir });
  } finally {
    removeDir(dir);
  }
});

test('started from a directory that holds the runs directory, the command line prints the run directory relative to it', async () => {
  const dir = tempRunsDir();
  try {
    const r = await runStart(['--text', '--run', 'clean', '--pace', '0', '--runs-dir', 'runs'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.match(r.lines.at(-1), /^Run directory: runs\/clean-[0-9]{8}T[0-9]{6}Z$/);
    checkRunLines(r.lines, { kind: 'clean', paceSeconds: 0, runsDir: path.join(dir, 'runs'), cwd: dir });
  } finally {
    removeDir(dir);
  }
});

test('the two runs open connections to 127.0.0.1 and to no other host, resolve no name, and start no process but the reference verifier', async () => {
  const dir = tempRunsDir();
  try {
    // The repository's egress counter writes one line for every connection,
    // name lookup and child process, before the call runs.
    const log = path.join(dir, 'egress.jsonl');
    const r = await runStart(['--text', '--run', 'both', '--pace', '0', '--runs-dir', path.join(dir, 'runs')], {
      env: { NODE_OPTIONS: `--require ${JSON.stringify(path.join(REPO_ROOT, 'src/egress/counter.cjs'))}`, DEMO_EGRESS_LOG: log },
    });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const of = (kind) => lines.filter((l) => l.kind === kind);
    for (const l of lines) assert.ok(['child', 'dns', 'hello', 'tcp'].includes(l.kind), `a call of kind ${l.kind} was counted`);
    // Every connection goes to 127.0.0.1, and the one name looked up is that literal.
    assert.ok(of('tcp').length >= 3);
    for (const l of of('tcp')) assert.equal(l.host, '127.0.0.1');
    assert.ok(of('dns').length >= 4);
    for (const l of of('dns')) assert.equal(l.name, '127.0.0.1');
    // The token service checks each broker token with the vendored reference verifier.
    assert.equal(of('hello').filter((l) => path.basename(l.argv1) === 'verify.mjs').length, 2);
    assert.equal(of('hello').filter((l) => path.basename(l.argv1) === 'start.mjs').length, 1);
    if (!WRITER_IN_TREE) {
      // The engine alone: the token exchange of each run and the payment of
      // the clean run; two listeners per run; the two verifier processes.
      assert.equal(of('tcp').length, 3);
      assert.equal(of('dns').length, 4);
      assert.equal(of('child').length, 2);
      assert.equal(of('hello').length, 3);
    }
  } finally {
    removeDir(dir);
  }
});

test('Ctrl+C during a text run stops it where it is: the step due reads Stopped, the outcome says the run was stopped, state.json is final, no other run starts, exit 130', async () => {
  const dir = tempRunsDir();
  const child = spawn(process.execPath, [START, '--text', '--run', 'both', '--pace', '2', '--runs-dir', dir], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => { child.on('close', (code, signal) => resolve({ code, signal })); });
  const guard = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    // Wait for the credential step's line, then stop the run during the wait that follows it.
    const deadline = Date.now() + 20000;
    while (!/\| Passed \| valid; /.test(stdout)) {
      assert.ok(Date.now() < deadline, `the credential line was printed within 20 seconds (stderr: ${stderr})`);
      assert.equal(child.exitCode, null, `the run is still going (stderr: ${stderr})`);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    child.kill('SIGINT');
    const end = await exited;
    assert.deepEqual(end, { code: 130, signal: null });
    assert.equal(stderr, '');
    const lines = stdout.split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 3 + 1 + 3, 'the header, the credential line, then the stopped step, the outcome and the run directory');
    assert.match(lines[4], /^\[[0-9]{6}\] OpenA2A · ATX · AAP \| Issue a scoped AAP grant \| Stopped \| the run was stopped before this step finished$/);
    assert.match(lines[5], /^\[[0-9]{6}\] Outcome \| Stopped at: Issue a scoped AAP grant \| The run was stopped before it finished, at the step grant\.$/);
    assert.match(lines[6], /^Run directory: /);
    const runs = fs.readdirSync(dir);
    assert.equal(runs.length, 1, 'the poisoned run was not started');
    assert.ok(runs[0].startsWith('clean-'));
    const state = readJson(path.join(dir, runs[0], 'state.json'));
    assert.notEqual(state.finishedAt, null);
    assert.deepEqual(state.steps.map((x) => x.status), ['passed', 'blocked', 'not-reached', 'not-reached', 'not-reached', 'not-reached']);
    assert.equal(state.outcome, 'blocked');
    assert.equal(state.blockedAt, 'grant');
    assert.equal(state.grant, null, 'no grant was asked for');
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    removeDir(dir);
  }
});

test('the command line refuses what it does not know with exit 2 and the usage, and starts nothing', async () => {
  const dir = tempRunsDir();
  try {
    const cases = [
      [[], /^Give --text or --serve\.$/],
      [['--text', '--serve'], /^Give --text or --serve, not both\.$/],
      [['--text', '--run', 'tampered'], /^--run is clean, poisoned or both, not "tampered"\.$/],
      [['--text', '--run'], /^--run needs a value\.$/],
      [['--text', '--pace', 'fast'], /^--pace is a number of seconds, not "fast"\.$/],
      [['--text', '--pace', '16'], /^--pace is from 0 to 15 seconds: the grant lives 60 seconds, and a longer pace would let it expire before the payment\.$/],
      [['--text', '--port', '7390'], /^--port goes with --serve\.$/],
      [['--serve', '--run', 'clean'], /^--run goes with --text\.$/],
      [['--serve', '--port', '0'], /^--port is a port number from 1 to 65535, not "0"\.$/],
      [['--text', '--verbose'], /^Unknown argument "--verbose"\.$/],
    ];
    for (const [args, message] of cases) {
      const r = await runStart([...args, '--runs-dir', dir]);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
      const errLines = r.stderr.split('\n');
      assert.match(errLines[0], message, args.join(' '));
      assert.equal(errLines[1], 'Usage:');
    }
    assert.deepEqual(fs.readdirSync(dir), []);
    const help = await runStart(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    assert.equal(help.lines[0], 'Usage:');
    assert.ok(help.lines.some((l) => l.includes('--text') && l.includes('--run clean|poisoned|both') && l.includes('--pace <seconds>')));
    assert.ok(help.lines.some((l) => l.includes('--serve') && l.includes('--port <n>')));
  } finally {
    removeDir(dir);
  }
});

test('node three-party/bin/start.mjs --serve prints its loopback address, serves the run API there, and stops on Ctrl+C with exit 0', async () => {
  const dir = tempRunsDir();
  const child = spawn(process.execPath, [START, '--serve', '--pace', '0', '--runs-dir', dir], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const exited = new Promise((resolve) => { child.on('close', (code, signal) => resolve({ code, signal })); });
  const guard = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const deadline = Date.now() + 20000;
    while (!stdout.includes('\n')) {
      assert.ok(Date.now() < deadline, `the API printed its address within 20 seconds (stderr: ${stderr})`);
      assert.equal(child.exitCode, null, `the API is still running (stderr: ${stderr})`);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
    const line = /^Run API on http:\/\/127\.0\.0\.1:([0-9]+)\/ \(build ([0-9a-f]{7}|not from a git clone)\)\. Press Ctrl\+C to stop\.\n$/.exec(stdout);
    assert.ok(line, stdout);
    const port = Number(line[1]);
    assert.ok(port >= 7390 && port <= 7410, `port ${port} is 7390 or the next free port`);

    const health = await request({ port, path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json().ok, true);
    const started = await request({ port, method: 'POST', path: '/api/runs', body: { kind: 'clean' }, headers: { 'Content-Type': 'application/json' } });
    assert.equal(started.status, 200);
    const { runId } = started.json();
    let state = null;
    const until = Date.now() + 20000;
    do {
      state = (await request({ port, path: `/api/runs/${runId}` })).json();
      assert.ok(Date.now() < until, 'the run finished within 20 seconds');
    } while (state.finishedAt === null);
    assert.equal(state.outcome, 'paid');
    assert.equal(state.paceSeconds, 0);
    assert.deepEqual(fs.readdirSync(dir), [runId]);

    child.kill('SIGINT');
    const end = await exited;
    assert.deepEqual(end, { code: 0, signal: null });
    assert.equal(stderr, '');
    await assert.rejects(request({ port, path: '/api/health' }), 'the listener is closed');
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    removeDir(dir);
  }
});
