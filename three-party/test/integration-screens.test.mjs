// The screens on the engine, in a real browser: both runs and the offline
// check, started with real clicks on a page the demo's own listener serves.
// The listener runs in this process at pace 0; the browser is the one
// support/browser.mjs starts, and its start is checked before a page of the
// demo is driven.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { browserStartChecks, launchBrowser, NAME_ERROR, OUTSIDE_URL, RESOLVER_RULE } from './support/browser.mjs';
import { example } from './support/engine-helpers.mjs';
import { offlineCheckFromScreens, openScreens, runFromScreens, startDemo } from './support/integration-helpers.mjs';
import { assertCensus, census, COPY, docsFrom, rowsOf } from './support/view-helpers.mjs';

let demo;
let chrome;
let started;
const views = [];

before(async () => {
  demo = await startDemo();
  chrome = await launchBrowser();
  started = await browserStartChecks(chrome.browser, demo.url);
});

after(async () => {
  for (const view of views) await view.close().catch(() => {});
  if (chrome) await chrome.close();
  if (demo) await demo.stop();
});

async function open(options) {
  const view = await openScreens(chrome.browser, demo.url, options);
  views.push(view);
  return view;
}

// The texts of the page that equal one sentence, with the place of each.
const placesOf = (page, sentence) => page.evaluate((text) => [...document.querySelectorAll('[data-src]')]
  .filter((node) => node.textContent === text)
  .map((node) => node.closest('footer, nav, main, aside, header')?.id ?? 'elsewhere'), sentence);

// The offline panel as the page shows it.
const offlinePanel = (page) => page.evaluate(() => {
  const panel = document.querySelector('#pane-inspector [data-panel="offline"]');
  if (!panel) return null;
  const returned = panel.querySelector('[data-returned="offline-check"]');
  return {
    text: panel.innerText,
    lines: returned ? [...returned.querySelectorAll('ul li')].map((li) => li.textContent) : null,
    keys: returned ? [...returned.querySelectorAll('.kv-key')].map((k) => k.textContent) : null,
    values: returned ? [...returned.querySelectorAll('.kv-value')].map((v) => v.textContent) : null,
    verdicts: panel.querySelectorAll('.verdict, [data-verdict], [data-verdict-for]').length,
    records: panel.querySelectorAll('.record').length,
  };
});

// What the offline panel must show for a check that wrote a result: each
// record of the result with its verdict in the deck's words, the counts,
// and the lines of the deck that speak of the verifier. The answer is a
// result, so no line is shown as a returned line.
function assertWrittenResultShown(panel, answer) {
  assert.ok(panel, 'the inspector shows the offline panel');
  assert.equal(panel.lines, null, 'no line is shown as returned');
  assert.equal(panel.keys, null);
  assert.equal(panel.records, answer.records.length + answer.tampered.length, 'each record of the result is listed');
  // Each record has its verdict line, and the verdict in it.
  assert.equal(panel.verdicts, 2 * panel.records);
  const times = (words) => panel.text.split(words).length - 1;
  assert.equal(times(COPY['offline.pass']), answer.summary.pass, 'the passed words, once for each record that passed');
  assert.equal(times(COPY['offline.reject'].replace('{n}', answer.tampered[0].firstFailingStep)), answer.summary.reject, 'the rejected words, once for the tampered copy');
  const counts = [
    COPY['offline.summaryPass'].replace('{pass}', answer.summary.pass),
    COPY['offline.summaryReject'].replace('{reject}', answer.summary.reject).replace('{expectedRejects}', answer.summary.expectedRejects),
  ];
  // The words for the network follow the result: a denial where the
  // control showed one, not measured where it was not, and never both.
  const denied = answer.networkDenied === 'yes';
  const network = denied ? [COPY['offline.sub'], COPY['offline.networkValue']] : [COPY['offline.subNotMeasured'], COPY['offline.networkNotMeasured'], answer.network];
  for (const line of [...network, COPY['offline.signerValue'], COPY['offline.tampered'], COPY['offline.expected'], COPY['limit.steps'], ...counts]) {
    assert.ok(panel.text.includes(line), `the panel shows: ${line}`);
  }
  for (const line of denied ? [COPY['offline.subNotMeasured'], COPY['offline.networkNotMeasured']] : [COPY['offline.sub'], COPY['offline.networkValue']]) {
    assert.equal(panel.text.includes(line), false, `the panel does not show: ${line}`);
  }
}

test('the browser is started sandboxed and can reach this computer alone: the start checks hold before a page of the demo is driven', () => {
  assert.deepEqual(started, {
    sandbox: 'on (no --no-sandbox on the command line)',
    resolverRule: RESOLVER_RULE,
    outside: { url: OUTSIDE_URL, refusedWith: NAME_ERROR },
    control: { url: demo.url, status: 200 },
  });
});

test('the served / carries the mock bank line: once, in the footer, before a run and after each run', async () => {
  const MOCK_LINE = JSON.parse(readFileSync(new URL('../view/copy.json', import.meta.url), 'utf8'))['footer.mock'];
  const view = await open();
  assert.deepEqual(await placesOf(view.page, MOCK_LINE), ['footer']);
  assert.equal(await view.page.locator('#footer p').nth(0).innerText(), MOCK_LINE);
  for (const kind of ['clean', 'poisoned']) {
    await runFromScreens(view, kind);
    assert.deepEqual(await placesOf(view.page, MOCK_LINE), ['footer'], `after the ${kind} run`);
  }
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.outside, []);
});

test('a clean run from the screens ends Paid with every row in the state of the contract example, and the offline check shows the result the check wrote: five records passed, the tampered copy rejected', async () => {
  const view = await open({ hash: '#inspect' });
  const { page } = view;
  const runId = await runFromScreens(view, 'clean');
  assert.match(runId, /^clean-[0-9]{8}T[0-9]{6}Z$/);
  assert.equal(await page.evaluate(() => document.body.dataset.run), 'paid');
  const rows = await rowsOf(page);
  assert.deepEqual(rows.map((r) => `${r.step}=${r.status}`), example('state-clean-done.json').steps.map((s) => `${s.id}=${s.status}`));
  assert.deepEqual(rows.map((r) => r.word), ['Passed', 'Passed', 'Passed', 'Passed', 'Passed', 'Written']);
  assert.equal(rows[5].detail, COPY['detail.record'].replace('{written}', '5'));

  await offlineCheckFromScreens(view);
  const answer = JSON.parse(view.served.get(`POST /api/runs/${runId}/offline-check`));
  assert.deepEqual(answer.summary, { pass: 5, reject: 1, expectedRejects: 1 });
  assert.equal(Object.hasOwn(answer, 'exitCode'), false);
  assertWrittenResultShown(await offlinePanel(page), answer);

  // Every text of the page names its source and equals it, the offline panel included.
  const checked = assertCensus(await census(page), docsFrom(view.served, runId));
  assert.ok(checked > 40, `the census read the page (${checked} sourced texts)`);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.outside, []);
});

test('a poisoned run from the screens is Stopped by the intent rule at step 4 with the payment not reached, four records written, and the offline check shows four records passed and the tampered copy rejected', async () => {
  const view = await open({ hash: '#inspect' });
  const { page } = view;
  const ex = example('state-poisoned-blocked.json');
  const runId = await runFromScreens(view, 'poisoned');
  assert.match(runId, /^poisoned-[0-9]{8}T[0-9]{6}Z$/);
  assert.equal(await page.evaluate(() => document.body.dataset.run), 'blocked');
  const rows = await rowsOf(page);
  assert.deepEqual(rows.map((r) => `${r.step}=${r.status}`), ex.steps.map((s) => `${s.id}=${s.status}`));
  assert.deepEqual(rows.map((r) => r.word), ['Passed', 'Passed', 'Passed', 'Stopped', 'Not reached', 'Written']);
  assert.equal(rows[5].detail, COPY['detail.record'].replace('{written}', '4'));
  assert.equal(await page.locator('#run-line .run-outcome').innerText(), COPY['outcome.stoppedIntent']);
  // The poisoned line is the run's own, shown once, in the invoice box with
  // the hidden text (at this size the box stands in the run overview).
  assert.equal((await placesOf(page, ex.poisonedLine)).length, 1);
  const inBox = await page.evaluate((text) => [...document.querySelectorAll('[data-src]')]
    .filter((node) => node.textContent === text)
    .map((node) => node.closest('.hidden-box') !== null && node.closest('.invoice-card') !== null), ex.poisonedLine);
  assert.deepEqual(inBox, [true]);
  const state = docsFrom(view.served, runId).state;
  assert.equal(state.poisonedLine, ex.poisonedLine);
  assert.equal(await page.locator('.hidden-box .hidden-text').textContent(), state.invoice.hidden.text, 'the hidden text shown is the text of the run\'s own invoice');

  await offlineCheckFromScreens(view);
  const answer = JSON.parse(view.served.get(`POST /api/runs/${runId}/offline-check`));
  assert.deepEqual(answer.summary, { pass: 4, reject: 1, expectedRejects: 1 });
  assertWrittenResultShown(await offlinePanel(page), answer);
  const checked = assertCensus(await census(page), docsFrom(view.served, runId));
  assert.ok(checked > 40, `the census read the page (${checked} sourced texts)`);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.outside, []);
});
