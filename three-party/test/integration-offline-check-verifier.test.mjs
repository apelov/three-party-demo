// The offline check through the API and on the served screens, with the
// verifier in the tree. A clean run and a poisoned run are made by the
// engine; the route returns the result the check wrote; and the screens, in
// a real browser, show that result in the deck's words. A check that wrote
// no result returns its exit status and its lines, and the screens show no
// verdict word for it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { offlineCheckReturned, pinFileOf } from '../src/engine/records.mjs';
import { VERIFIER } from '../src/record/check.mjs';
import { denialHere, HERE, NETWORK_OF, runOfflineCheck, sha256 } from './record-support.mjs';
import { browserStartChecks, launchBrowser } from './support/browser.mjs';
import { walkFiles } from './support/engine-helpers.mjs';
import { finishedRun, offlineCheckFromScreens, openScreens, runFromScreens, startDemo } from './support/integration-helpers.mjs';
import { assertCensus, census, COPY, docsFrom } from './support/view-helpers.mjs';
import { NOT_RUN, VERIFIER as VERIFIER_FILE } from './verifier-support.mjs';

const RESULT_KEYS = ['runId', 'at', 'verifier', 'pin', 'pinSha256', 'network', 'records', 'tampered', 'summary', 'networkDenied'];
const STEP_3 = 'step 3: canonical.bin is neither response.txt, LF, JCS(metadata.json) nor response.txt alone';
const LIMIT = { timeout: 180000 };

let demo;
let chrome;
const views = [];

// What the check says about the network on this platform (record-support.mjs).
let here = null;
before(async () => {
  here = await denialHere();
  demo = await startDemo();
});

after(async () => {
  for (const view of views) await view.close().catch(() => {});
  if (chrome) await chrome.close();
  if (demo) await demo.stop();
});

// The offline check of one finished run through the route, with everything
// a written result must hold. `records` is the count of records the run
// wrote. Returns the body.
async function checkedThroughTheRoute(run, records) {
  const runDir = path.join(demo.runsDir, run.runId);
  const filesBefore = walkFiles(runDir);
  const manifest = (await demo.get(`/api/runs/${run.runId}/files/records/manifest.json`)).json();
  assert.equal(manifest.records.length, records);
  assert.equal(manifest.tampered.length, 1);

  const answer = await demo.post(`/api/runs/${run.runId}/offline-check`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
  const body = answer.json();

  // The result of the contract, field for field.
  assert.deepEqual(Object.keys(body), RESULT_KEYS);
  assert.equal(body.runId, run.runId);
  assert.match(body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(body.verifier, { entry: VERIFIER.entry, sha256: sha256(fs.readFileSync(VERIFIER_FILE)), source: VERIFIER.source });
  // The pin is the key the engine captured when the run started, held
  // beside the runs directory, and it is the signer the manifest names.
  assert.equal(body.pin, `../${path.basename(demo.runsDir)}.pins/${run.runId}.pub.pem`);
  assert.equal(path.resolve(demo.runsDir, body.pin), pinFileOf(runDir));
  assert.equal(body.pinSha256, manifest.signerSha256);
  assert.deepEqual([body.network, body.networkDenied], [here.network, here.networkDenied]);
  if (HERE.method !== null) assert.equal(body.network, NETWORK_OF[HERE.method]);
  assert.deepEqual(body.records, manifest.records.map((record) => ({ file: record.file, sha256: record.sha256, verdict: 'pass-1-6', firstFailingStep: null, notes: [NOT_RUN] })));
  assert.deepEqual(body.tampered, manifest.tampered.map((copy) => ({ file: copy.file, sha256: copy.sha256, verdict: 'reject', firstFailingStep: 3, notes: [STEP_3, NOT_RUN] })));
  assert.deepEqual(body.summary, { pass: records, reject: 1, expectedRejects: 1 });

  // No exit status of 2, no line of a build with no verifier, and none of
  // the fields of a check that wrote no result.
  for (const absent of ['exitCode', 'lines', 'notes']) assert.equal(Object.hasOwn(body, absent), false, absent);
  assert.doesNotMatch(answer.text, /none yet|"exitCode"/);

  // The check wrote that result to offline-check.json and changed no other
  // file of the run; the files route serves the same result.
  assert.deepEqual(walkFiles(runDir).filter((file) => !filesBefore.includes(file)), ['offline-check.json']);
  assert.equal(walkFiles(runDir).length, filesBefore.length + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'offline-check.json'), 'utf8')), body);
  assert.deepEqual((await demo.get(`/api/runs/${run.runId}/files/offline-check.json`)).json(), body);

  // The exit status of the check on this run is 0: as the engine returns
  // it, and as the check's own program ends.
  const returned = await offlineCheckReturned(runDir);
  assert.equal(returned.exitCode, 0);
  assert.deepEqual({ ...returned.result, at: null }, { ...body, at: null });
  assert.equal(returned.lines.at(-2), `result: ${records} passed steps 1 to 6, 1 rejected (1 expected)`);
  const program = runOfflineCheck([runDir, '--pin', pinFileOf(runDir)]);
  assert.equal(program.status, 0, program.stderr);
  assert.equal(program.lines.at(-2), `result: ${records} passed steps 1 to 6, 1 rejected (1 expected)`);
  assert.equal(program.lines.filter((line) => line.endsWith(': pass-1-6')).length, records);
  assert.equal(program.lines.filter((line) => /: rejected at step 3$/.test(line)).length, 1);

  assert.equal((await demo.get(`/api/runs/${run.runId}/offline-check`)).status, 405);
  return body;
}

test('through the API, the offline check of a clean run returns the written result: five records passed steps 1 to 6 and the one tampered copy rejected, with exit status 0', { ...LIMIT }, async () => {
  const clean = await finishedRun(demo, 'clean');
  assert.equal(clean.state.outcome, 'paid');
  const body = await checkedThroughTheRoute(clean, 5);
  assert.deepEqual(body.records.map((item) => item.file), ['records/01-credential.aep', 'records/02-grant.aep', 'records/03-crossing.aep', 'records/04-intent.aep', 'records/05-pay.aep']);
  assert.deepEqual(body.tampered.map((item) => item.file), ['records/tampered/05-pay.aep']);
});

test('through the API, the offline check of a poisoned run returns the written result: four records passed steps 1 to 6 and the one tampered copy rejected, with exit status 0', { ...LIMIT }, async () => {
  const poisoned = await finishedRun(demo, 'poisoned');
  assert.deepEqual({ outcome: poisoned.state.outcome, blockedAt: poisoned.state.blockedAt }, { outcome: 'blocked', blockedAt: 'intent' });
  const body = await checkedThroughTheRoute(poisoned, 4);
  assert.deepEqual(body.records.map((item) => item.file), ['records/01-credential.aep', 'records/02-grant.aep', 'records/03-crossing.aep', 'records/04-intent.aep']);
  assert.deepEqual(body.tampered.map((item) => item.file), ['records/tampered/04-intent.aep']);
});

test('through the API, a check that wrote no result returns its exit status, its lines and its notes, and no verdict: a run whose pin is gone ends with 1', { ...LIMIT }, async () => {
  const run = await finishedRun(demo, 'clean');
  const runDir = path.join(demo.runsDir, run.runId);
  const pin = pinFileOf(runDir);
  fs.rmSync(pin);
  const filesBefore = walkFiles(runDir);
  const answer = await demo.post(`/api/runs/${run.runId}/offline-check`);
  assert.equal(answer.status, 200);
  const body = answer.json();
  assert.deepEqual(Object.keys(body), ['exitCode', 'lines', 'notes']);
  assert.equal(body.exitCode, 1);
  assert.deepEqual(body.lines.slice(0, 2), ['private key: absent', here.line]);
  assert.equal(body.lines[2], `verifier: aep-verify.mjs sha256 ${sha256(fs.readFileSync(VERIFIER_FILE))}`);
  assert.equal(body.lines[3], `pin: not found (looked outside the run directory, at ${pin})`);
  assert.equal(body.lines.length, 4);
  assert.deepEqual(body.notes, [...here.notes, 'the verifier requires the key inside each record to equal the pin, and this run has none, so nothing was checked and nothing was written']);
  for (const absent of ['summary', 'records', 'tampered', 'verifier']) assert.equal(Object.hasOwn(body, absent), false, absent);
  assert.doesNotMatch(answer.text, /"verdict"|pass-1-6|"firstFailingStep"|expectedRejects/);
  assert.deepEqual(walkFiles(runDir), filesBefore, 'nothing was written');
});

// The audit as the page shows it: the inspector's panel for it (what the
// check names of itself, the tampered copy with its notes, or what a check
// that wrote no result returned) and the ledger of the Records tab (one row
// per record with its verdict, and the counts above it).
const offlinePanel = (page) => page.evaluate(() => {
  const host = document.querySelector('#pane-inspector [data-panel="offline"]');
  if (!host) return null;
  const tab = document.getElementById('records-tab');
  const returned = host.querySelector('[data-returned="offline-check"]');
  const checked = host.querySelector('[data-section="checked"]');
  const pairs = checked ? [...checked.querySelectorAll('.kv > .kv-row')].map((row) => [row.querySelector('.kv-key').textContent, row.querySelector('.kv-value').innerText.replace(/\s+/g, ' ').trim()]) : [];
  return {
    text: host.innerText,
    sub: checked?.querySelector('.insp-text')?.textContent ?? null,
    pairs,
    tampered: [...host.querySelectorAll('.record[data-kind="tampered"]')].map((record) => ({
      file: record.dataset.file,
      verdict: record.querySelector('.verdict span')?.textContent ?? null,
      notes: [...record.querySelectorAll('.insp-note')].map((note) => note.textContent),
    })),
    limit: host.querySelector('[data-section="limits"] .insp-note')?.textContent ?? null,
    rows: [...tab.querySelectorAll('.ledger-row.record')].map((record) => ({
      file: record.dataset.file,
      kind: record.dataset.kind,
      flags: [...record.querySelectorAll('.record-flag')].map((flag) => flag.textContent),
      verdict: record.querySelector('[data-verdict-for] .verdict span')?.textContent ?? record.querySelector('[data-verdict-for]').textContent,
    })),
    summary: [...tab.querySelectorAll('.records-head .records-count')].map((node) => node.textContent),
    returnedLines: returned ? [...returned.querySelectorAll('ul li')].map((li) => li.textContent) : null,
    returnedStatus: returned ? [...returned.querySelectorAll('.kv-row')].map((row) => [row.querySelector('.kv-key').textContent, row.querySelector('.kv-value').textContent]) : null,
    verdicts: host.querySelectorAll('.verdict').length + tab.querySelectorAll('.verdict').length,
  };
});

// The pairs of the record section of the inspector, for the step selected.
const recordPairs = (page) => page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-section="record"] .kv > .kv-row')].map((row) => [row.querySelector('.kv-key').textContent, row.querySelector('.kv-value').innerText.replace(/\s+/g, ' ').trim()]));

const VERDICT_WORDS = /Passed steps 1 to 6|Rejected at step|passed steps 1 to 6|rejected \(/;

test('the served screens show a written result in the deck\'s words: Passed steps 1 to 6 on each record of the ledger, Rejected at step 3 on the tampered copy with the verifier\'s notes, the counts, and the line on steps 7 to 10; they show none of those words before a check and for a check that wrote no result', { ...LIMIT }, async () => {
  chrome = await launchBrowser();
  await browserStartChecks(chrome.browser, demo.url);
  const view = await openScreens(chrome.browser, demo.url, { hash: '#inspect' });
  views.push(view);
  const { page } = view;
  const pageText = () => page.evaluate(() => document.body.innerText);

  // Before a run, and after a run with no check yet: no verdict word.
  assert.doesNotMatch(await pageText(), VERDICT_WORDS);
  const runId = await runFromScreens(view, 'clean');
  assert.doesNotMatch(await pageText(), VERDICT_WORDS);
  assert.equal(await offlinePanel(page), null);

  // The check, started from the screens with a real click.
  await offlineCheckFromScreens(view);
  const result = JSON.parse(view.served.get(`POST /api/runs/${runId}/offline-check`));
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
  assert.deepEqual(result.summary, { pass: 5, reject: 1, expectedRejects: 1 });
  const panel = await offlinePanel(page);
  assert.ok(panel, 'the inspector shows the offline panel');
  // Where the control showed the denial, the deck's words for it; where
  // the denial was not measured, the words for that and the result's
  // network line, and never the words of a denial.
  const denied = result.networkDenied === 'yes';
  assert.equal(result.networkDenied, here.networkDenied);
  assert.equal(panel.sub, denied ? 'Each record is checked by the verifier with network access denied.' : 'Each record is checked by the verifier. Network denial was not measured on this computer.');
  assert.deepEqual(panel.pairs, [
    ['Verifier', `aep-verify, OpenA2A build, SHA-256 ${result.verifier.sha256.slice(0, 16)} ${COPY['inspector.copy']}`],
    ['Network', denied ? 'Access denied while checking' : `Not measured on this computer ${result.network}`],
    ['Trusted signer', `Test key generated for this run ${result.pin}`],
  ]);
  if (!denied) assert.doesNotMatch(panel.text, /Access denied while checking|with network access denied/);
  assert.equal(result.verifier.sha256, sha256(fs.readFileSync(VERIFIER_FILE)));
  assert.deepEqual(panel.rows.slice(0, 5), result.records.map((record) => ({ file: record.file, kind: 'records', flags: [], verdict: 'Passed steps 1 to 6' })));
  assert.deepEqual(panel.rows.slice(5), [{ file: result.tampered[0].file, kind: 'tampered', flags: ['Tampered copy', 'Expected: rejected'], verdict: 'Rejected at step 3' }]);
  assert.deepEqual(panel.tampered, [{ file: result.tampered[0].file, verdict: 'Rejected at step 3', notes: [STEP_3, NOT_RUN] }], 'the inspector: the tampered copy with what the verifier wrote of it');
  assert.deepEqual(panel.summary, ['5 passed steps 1 to 6', '1 rejected (1 expected)']);
  assert.equal(panel.limit, 'Steps 7 to 10 of the format are not run by this verifier, so the timestamp is not checked.');
  assert.equal(panel.returnedLines, null, 'a written result is not shown as returned lines');
  assert.equal(panel.verdicts, 7, 'six in the ledger, and the tampered copy\'s in the inspector');
  // The strings above are the deck's.
  assert.deepEqual(
    [COPY['audit.subDenied'], COPY['offline.verifier'], COPY['audit.verifierValue'], COPY['offline.network'], COPY['offline.networkValue'], COPY['offline.signer'], COPY['offline.signerValue'], COPY['offline.pass'], COPY['offline.reject'], COPY['offline.tampered'], COPY['offline.expected'], COPY['offline.note'], COPY['offline.summaryPass'], COPY['offline.summaryReject'], COPY['limit.steps']],
    ['Each record is checked by the verifier with network access denied.', 'Verifier', 'aep-verify, OpenA2A build, SHA-256 {sha16}', 'Network', 'Access denied while checking', 'Trusted signer', 'Test key generated for this run', 'Passed steps 1 to 6', 'Rejected at step {n}', 'Tampered copy', 'Expected: rejected', 'Verifier note', '{pass} passed steps 1 to 6', '{reject} rejected ({expectedRejects} expected)', 'Steps 7 to 10 of the format are not run by this verifier, so the timestamp is not checked.'],
  );
  // Every text of the page names its source and equals it, the result included.
  const checked = assertCensus(await census(page), docsFrom(view.served, runId));
  assert.ok(checked > 40, `the census read the page (${checked} sourced texts)`);
  // A record's own notes stand with its step: chosen from the ledger, the
  // step's record section reads the verdict and what the verifier wrote.
  await page.click(`.ledger-row.record[data-file="${result.records[0].file}"] .ledger-step`);
  await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel !== 'offline');
  const pairs = await recordPairs(page);
  assert.deepEqual(pairs.filter(([key]) => ['Audit', 'Verifier note'].includes(key)), [['Audit', 'Passed steps 1 to 6'], ['Verifier note', NOT_RUN]]);
  assert.ok(assertCensus(await census(page), docsFrom(view.served, runId)) > 40, 'the step with its record notes names its sources');

  // A poisoned run: four passed, the tampered copy rejected.
  const poisonedId = await runFromScreens(view, 'poisoned');
  assert.doesNotMatch(await pageText(), VERDICT_WORDS, 'the new run shows no verdict of the run before it');
  await offlineCheckFromScreens(view);
  const poisoned = await offlinePanel(page);
  assert.deepEqual(poisoned.rows.map((row) => row.verdict), ['Passed steps 1 to 6', 'Passed steps 1 to 6', 'Passed steps 1 to 6', 'Passed steps 1 to 6', 'Rejected at step 3']);
  assert.deepEqual(poisoned.summary, ['4 passed steps 1 to 6', '1 rejected (1 expected)']);
  assert.deepEqual(JSON.parse(view.served.get(`POST /api/runs/${poisonedId}/offline-check`)).summary, { pass: 4, reject: 1, expectedRejects: 1 });

  // A run whose check writes no result: its pin is gone, so the check ends
  // before the verifier runs. The panel shows what the check returned, and
  // no verdict word, no count and no line that speaks of the verifier.
  const noResultId = await runFromScreens(view, 'clean');
  fs.rmSync(pinFileOf(path.join(demo.runsDir, noResultId)));
  await offlineCheckFromScreens(view);
  const answer = JSON.parse(view.served.get(`POST /api/runs/${noResultId}/offline-check`));
  assert.deepEqual(Object.keys(answer), ['exitCode', 'lines', 'notes']);
  assert.equal(answer.exitCode, 1);
  const none = await offlinePanel(page);
  assert.deepEqual(none.returnedLines, [...answer.lines, ...answer.notes]);
  assert.deepEqual(none.returnedStatus, [['exitCode', '1']]);
  assert.deepEqual({ verdicts: none.verdicts, tampered: none.tampered, sub: none.sub, limit: none.limit, pairs: none.pairs }, { verdicts: 0, tampered: [], sub: null, limit: null, pairs: [] });
  // The ledger lists the run's records, each one not audited, under the
  // line that says so: no verdict and no count.
  assert.ok(none.rows.length > 0);
  assert.deepEqual(new Set(none.rows.map((row) => row.verdict)), new Set([COPY['insp.notAudited']]));
  assert.deepEqual(none.summary, [COPY['insp.notAudited']]);
  assert.doesNotMatch(none.text, VERDICT_WORDS);
  assert.doesNotMatch(none.text, /Each record is checked|Access denied while checking|Not measured on this computer|Steps 7 to 10/);

  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.outside, []);
});
