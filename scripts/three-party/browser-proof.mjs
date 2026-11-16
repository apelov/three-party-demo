#!/usr/bin/env node
// Drives the demo's screens in a real browser, end to end, against a demo
// that is already running, and writes down what it measured: both runs
// started with real clicks, the time each took, and what the offline check
// screen showed.
//
//   node scripts/three-party/browser-proof.mjs --url http://127.0.0.1:7390/ --out <directory>
//        [--min-seconds <n>] [--max-seconds <n>] [--expect-offline written|returned]
//
// The offline check answers in one of two shapes, and the script reads the
// screen against the one it got: a written result (the verifier ran), which
// the screen must show as a verdict on each record and the counts, in the
// deck's words; or the check's exit status and lines (it wrote no result,
// for example where the demo itself runs inside a sandbox and the check
// cannot show its own network denial), which the screen must show as
// returned, with no verdict. --expect-offline says which shape this run
// must give.
//
// It runs from a development checkout (it needs playwright-core and the
// installed Google Chrome); the demo it drives may be this checkout's or a
// packaged copy started elsewhere on this computer. The browser is the one
// three-party/test/support/browser.mjs starts, and its start checks run
// before a page of the demo is driven.
//
// Written under <directory>: browser-proof.json (the measurements), and one
// picture of the screen after each run and after each offline check.
// The exit code is 0 when both runs ended as expected, each offline check
// was shown as the check returned it, the page reported no error and asked
// no other host for anything, and each run's time is inside the bounds given.

import fs from 'node:fs';
import path from 'node:path';
import { browserStartChecks, launchBrowser } from '../../three-party/test/support/browser.mjs';
import { offlineCheckFromScreens, openScreens, shownRunId } from '../../three-party/test/support/integration-helpers.mjs';

const EXPECTED = { clean: { outcome: 'paid', blockedAt: null }, poisoned: { outcome: 'blocked', blockedAt: 'intent' } };
const RUN_LIMIT_MS = 300000;

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const url = option(argv, '--url');
const out = option(argv, '--out');
const minSeconds = option(argv, '--min-seconds') === undefined ? null : Number(option(argv, '--min-seconds'));
const maxSeconds = option(argv, '--max-seconds') === undefined ? null : Number(option(argv, '--max-seconds'));
const expectOffline = option(argv, '--expect-offline') ?? null;
if (!url || !out || !/^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(url) || Number.isNaN(minSeconds) || Number.isNaN(maxSeconds) || ![null, 'written', 'returned'].includes(expectOffline)) {
  process.stderr.write('usage: node scripts/three-party/browser-proof.mjs --url http://127.0.0.1:<port>/ --out <directory> [--min-seconds <n>] [--max-seconds <n>] [--expect-offline written|returned]\n');
  process.exit(2);
}

// The words the screen shows for a written result.
const WORDS = Object.freeze({
  sub: 'Each record is checked by our verifier with network access denied.',
  network: 'Network: Access denied while checking',
  signer: 'Trusted signer: Test key generated for this run',
  pass: 'Passed steps 1 to 6',
  reject: (step) => `Rejected at step ${step}`,
  tampered: ['Tampered copy', 'Expected: rejected'],
  note: 'Verifier note',
  summaryPass: (pass) => `${pass} passed steps 1 to 6`,
  summaryReject: (reject, expected) => `${reject} rejected (${expected} expected)`,
  limit: 'Steps 7 to 10 of the format are not run by this verifier, so the timestamp is not checked.',
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
fs.mkdirSync(out, { recursive: true });

const seconds = (ms) => Math.round(ms / 100) / 10;
const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const failures = [];
const need = (ok, what) => { if (!ok) failures.push(what); };

async function stateOf(runId) {
  const res = await fetch(`${url}api/runs/${runId}`);
  return res.json();
}

// One run from the screens: the scene chosen and the run control pressed
// with real clicks, then the page watched until the run has finished.
async function runOnce(view, kind) {
  const { page } = view;
  const previous = await shownRunId(page);
  await page.click(`.scene[data-kind="${kind}"]`);
  const clickedAt = Date.now();
  await page.click('#run-control');
  // The page shows the new run before anything is read from it, so that no
  // reading below is of the run the page showed before.
  await page.waitForFunction(([wanted, earlier]) => {
    const id = document.querySelector('#run-line .run-id .mono')?.textContent ?? null;
    return id !== null && id !== earlier && id.startsWith(`${wanted}-`);
  }, [kind, previous], { timeout: RUN_LIMIT_MS });
  const runId = await shownRunId(page);
  await page.waitForFunction(() => ['paid', 'blocked'].includes(document.body.dataset.run), null, { timeout: RUN_LIMIT_MS });
  const outcomeShownMs = Date.now() - clickedAt;
  await page.waitForFunction(() => {
    const row = document.querySelector('#rows .row[data-step="record"]');
    return Boolean(row) && !['pending', 'running'].includes(row.dataset.status);
  }, null, { timeout: RUN_LIMIT_MS });
  const recordShownMs = Date.now() - clickedAt;
  let state = await stateOf(runId);
  while (state.finishedAt === null) {
    if (Date.now() - clickedAt > RUN_LIMIT_MS) throw new Error(`the ${kind} run did not finish within ${RUN_LIMIT_MS / 1000} seconds`);
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    state = await stateOf(runId);
  }
  const finishedMs = Date.now() - clickedAt;
  await view.settle();
  const rows = await page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((row) => ({ step: row.dataset.step, status: row.dataset.status, word: row.querySelector('.chip-word').textContent })));
  const headline = await page.locator('#run-line .run-outcome').innerText();
  await page.screenshot({ path: path.join(out, `${kind}-finished.png`) });

  await offlineCheckFromScreens(view, 60000);
  const answer = JSON.parse(view.served.get(`POST /api/runs/${runId}/offline-check`));
  const panel = await page.evaluate(() => {
    const host = document.querySelector('#pane-inspector [data-panel="offline"]');
    const returned = host.querySelector('[data-returned="offline-check"]');
    const facts = [...host.querySelectorAll('.insp-section > .kv > .kv-row')].filter((row) => !row.closest('[data-returned]'));
    return {
      text: host.innerText,
      lines: returned ? [...returned.querySelectorAll('ul li')].map((li) => li.textContent) : [],
      exit: returned ? [...returned.querySelectorAll('.kv-row')].map((row) => `${row.querySelector('.kv-key').textContent} ${row.querySelector('.kv-value').textContent}`) : [],
      verdicts: host.querySelectorAll('.verdict, [data-verdict]').length,
      sub: host.querySelector('.insp-head .insp-sub')?.textContent ?? null,
      facts: facts.map((row) => `${row.querySelector('.kv-key').textContent}: ${row.querySelector('.kv-value').innerText.replace(/\s+/g, ' ').trim()}`),
      rows: [...host.querySelectorAll('.record')].map((record) => ({
        file: record.dataset.file,
        flags: [...record.querySelectorAll('.record-line')[0].querySelectorAll('.record-flag')].map((flag) => flag.textContent),
        verdict: record.querySelector('.verdict span')?.textContent ?? null,
        notes: [...record.querySelectorAll('.record-line .record-line')].map((line) => `${line.querySelector('.record-flag').textContent}: ${line.querySelector('.insp-note').textContent}`),
      })),
      summary: [...host.querySelectorAll('.insp-big')].map((node) => node.textContent),
      limit: host.querySelector('.insp > .insp-sub')?.textContent ?? null,
    };
  });
  await page.screenshot({ path: path.join(out, `${kind}-offline-check.png`) });

  const engineSeconds = (Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 1000;
  const expected = EXPECTED[kind];
  need(state.outcome === expected.outcome && state.blockedAt === expected.blockedAt, `the ${kind} run ended ${state.outcome} (blockedAt ${state.blockedAt}), not ${expected.outcome}`);
  // A written result carries the count of each verdict; a check that wrote
  // none answers with its exit status and its lines.
  const written = Boolean(answer.summary);
  const screen = `the offline check screen of the ${kind} run`;
  if (written) {
    const records = Array.isArray(answer.records) ? answer.records : [];
    const copies = Array.isArray(answer.tampered) ? answer.tampered : [];
    const wordOf = (item) => (item.verdict === 'pass-1-6' ? WORDS.pass : WORDS.reject(item.firstFailingStep));
    need(panel.lines.length === 0 && panel.exit.length === 0, `${screen} shows returned lines beside a written result`);
    need(panel.sub === WORDS.sub, `${screen} does not say the records are checked by our verifier with network access denied`);
    need(panel.facts.some((fact) => fact.startsWith(`Verifier: aep-verify, our build, SHA-256 ${String(answer.verifier?.sha256).slice(0, 16)}`)), `${screen} does not name the verifier by its hash`);
    need(panel.facts.includes(WORDS.network), `${screen} does not show that network access was denied while checking`);
    need(panel.facts.some((fact) => fact.startsWith(WORDS.signer)), `${screen} does not name the trusted signer`);
    need(same(panel.rows.map((row) => row.file), [...records, ...copies].map((item) => item.file)), `${screen} does not list the records of the result`);
    need(same(panel.rows.map((row) => row.verdict), [...records, ...copies].map(wordOf)), `${screen} does not show the verdict of each record in the deck's words`);
    need(same(panel.rows.slice(records.length).map((row) => row.flags), copies.map(() => WORDS.tampered)), `${screen} does not mark the tampered copy and what is expected of it`);
    need(panel.rows.every((row) => row.notes.every((note) => note.startsWith(`${WORDS.note}: `))), `${screen} shows a note without its label`);
    need(panel.verdicts === records.length + copies.length, `${screen} shows ${panel.verdicts} verdicts for ${records.length + copies.length} records`);
    need(same(panel.summary, [WORDS.summaryPass(answer.summary.pass), WORDS.summaryReject(answer.summary.reject, answer.summary.expectedRejects)]), `${screen} does not show the counts of the result`);
    need(panel.limit === WORDS.limit, `${screen} does not say that steps 7 to 10 are not run`);
    need(records.length > 0 && records.every((item) => item.verdict === 'pass-1-6'), `a record of the ${kind} run did not pass steps 1 to 6`);
    need(copies.length > 0 && copies.every((item) => item.verdict === 'reject'), `a tampered copy of the ${kind} run was not rejected`);
  } else {
    need(same(panel.lines, [...answer.lines, ...answer.notes]), `${screen} does not show the lines the check returned`);
    need(panel.exit.length === 1 && panel.exit[0] === `exitCode ${answer.exitCode}`, `${screen} does not show the exit status the check returned`);
    need(panel.verdicts === 0 && panel.rows.length === 0 && panel.summary.length === 0 && !/passed|rejected/i.test(panel.text), `${screen} shows a verdict, and the check wrote no result`);
  }
  if (expectOffline !== null) need(written === (expectOffline === 'written'), `the offline check of the ${kind} run ${written ? 'wrote a result' : 'wrote no result'}, and this proof expects ${expectOffline === 'written' ? 'a written result' : 'the returned state'}`);
  if (minSeconds !== null) need(finishedMs / 1000 >= minSeconds, `the ${kind} run took ${seconds(finishedMs)} s, under ${minSeconds} s`);
  if (maxSeconds !== null) need(finishedMs / 1000 <= maxSeconds, `the ${kind} run took ${seconds(finishedMs)} s, over ${maxSeconds} s`);

  return {
    kind,
    runId,
    outcome: state.outcome,
    blockedAt: state.blockedAt,
    headline,
    paceSeconds: state.paceSeconds,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    engineSeconds,
    secondsFromClick: { outcomeShown: seconds(outcomeShownMs), recordRowShown: seconds(recordShownMs), runFinished: seconds(finishedMs) },
    rows: rows.map((r) => `${r.step}=${r.status} (${r.word})`),
    recordsWritten: state.steps.find((s) => s.id === 'record')?.detail?.written ?? null,
    offlineCheck: written
      ? {
        written: true,
        result: answer,
        shown: { sub: panel.sub, facts: panel.facts, records: panel.rows, summary: panel.summary, limit: panel.limit },
        verdictsShown: panel.verdicts,
      }
      : { written: false, exitCode: answer.exitCode, lines: answer.lines, notes: answer.notes, shownLines: panel.lines, shownExit: panel.exit, verdictsShown: panel.verdicts },
  };
}

const startedAt = utc();
const chrome = await launchBrowser();
let summary = null;
try {
  const startChecks = await browserStartChecks(chrome.browser, url);
  const health = await (await fetch(`${url}api/health`)).json();
  const view = await openScreens(chrome.browser, url, { width: 1440, height: 900 });
  const footer = await view.page.locator('#footer p').allInnerTexts();
  await view.page.screenshot({ path: path.join(out, 'start.png') });
  const runs = [];
  for (const kind of ['clean', 'poisoned']) runs.push(await runOnce(view, kind));
  need(view.errors.length === 0, `the page reported ${view.errors.length} error(s): ${view.errors.join(' | ')}`);
  need(view.outside.length === 0, `the page asked another host for ${view.outside.length} thing(s): ${view.outside.join(' | ')}`);
  summary = {
    url,
    startedAt,
    finishedAt: utc(),
    build: health.build,
    browser: { version: chrome.browser.version(), viewport: '1440x900', startChecks },
    footer,
    runs,
    pageErrors: view.errors,
    requestsToOtherHosts: view.outside,
    bounds: { minSeconds, maxSeconds },
    expectOffline,
    failures,
  };
  await view.close();
} finally {
  await chrome.close();
}

fs.writeFileSync(path.join(out, 'browser-proof.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
