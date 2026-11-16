// The screens for a run whose crossing ran the AI2II capture check: the
// crossing lane and the inspector carry no stand-in mark, the inspector lists
// one line per check with its answer and what it shows, then the check's
// scope, the trace has one row per check under the crossing, and every text
// names its source. The run is the clean example with its crossing step
// taken from an engine run over a synthetic capture made in the test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToEnd } from '../src/engine/run.mjs';
import { captureFiles, sourceFor, writeCapture } from './support/capture-fixture.mjs';
import { removeDir, tempRunsDir } from './support/engine-helpers.mjs';
import { launchChrome, openView, runAndWait, census, assertCensus, docsFrom, examplesWith, removeTempDirs, CLEAN_DONE, CLEAN_RUNNING, COPY, LABELS } from './support/view-helpers.mjs';

let browser;
let examples;
let capture;
let captureDir;
let captureSource;
const runsDir = tempRunsDir();
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-ai2ii-view-')));

before(async () => {
  browser = await launchChrome();
  const made = captureFiles();
  const source = sourceFor(made.bytes);
  captureDir = writeCapture(path.join(scratch, 'capture'), made.bytes, source);
  captureSource = source;
  const { state } = await runToEnd({ kind: 'clean', paceSeconds: 0, runsDir, recordWriter: null, ai2iiDir: captureDir, ai2iiSource: source });
  const crossing = state.steps.find((s) => s.id === 'crossing');
  capture = crossing.detail.capture;
  // The example runs with each step's variant, and the crossing as the engine ran it.
  const withVariant = (example, detail) => ({
    ...example,
    steps: example.steps.map((s) => (s.id === 'crossing'
      ? { ...s, partLabel: crossing.partLabel, standIn: crossing.standIn, standInNote: crossing.standInNote, detail: detail ? crossing.detail : s.detail, variant: 'supplied' }
      : { ...s, variant: null })),
  });
  examples = examplesWith({ add: { 'state-clean-done.json': withVariant(CLEAN_DONE, true), 'state-clean-running.json': withVariant(CLEAN_RUNNING, false) } });
});
after(async () => {
  await browser?.close();
  removeTempDirs();
  removeDir(runsDir);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a crossing that ran the capture check: no stand-in mark on its lane or in the inspector, one line per check with what it shows, the scope stated, a trace row per check, and every text sourced', async () => {
  const view = await openView(browser, { width: 1440, height: 900, server: { examples } });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    const lanes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#lanes-head .lane')].map((lane) => [lane.dataset.col, { badge: lane.querySelector('.badge')?.textContent ?? null, tip: lane.querySelector('.lane-credit').getAttribute('title'), title: lane.querySelector('.lane-title')?.textContent ?? null, credit: lane.querySelector('.lane-credit').textContent }])));
    assert.deepEqual(lanes.crossing, { badge: null, tip: null, title: LABELS.parts.crossing.variants.supplied.label, credit: COPY['credit.crossing'] }, 'the supplied crossing is credited to its maker, with no stand-in mark');
    assert.equal(lanes.record.badge, null, 'the record part is no stand-in in this revision of the map');
    // The flow row of the crossing, once selected: the check's own summary line.
    await page.click('#rows .row[data-step="crossing"]');
    await view.settle();
    const line = await page.evaluate(() => [...document.querySelectorAll('#rows .row[data-step="crossing"] .row-detail')].map((p) => p.textContent));
    assert.deepEqual(line, [capture.summary]);

    for (const mode of ['s', 'i']) {
      await page.keyboard.press(mode);
      await page.click('#rows .row[data-step="crossing"]');
      await view.settle();
      const shown = await page.evaluate(() => {
        const pane = document.querySelector('#pane-inspector');
        return {
          badge: pane.querySelector('.insp-head .badge')?.textContent ?? null,
          note: pane.querySelector('[data-note="stand-in"]')?.textContent ?? null,
          checks: [...pane.querySelectorAll('[data-capture-check]')].map((li) => ({ answer: li.dataset.answer, texts: [...li.querySelectorAll('[data-src]')].map((n) => n.textContent) })),
          scope: [...pane.querySelectorAll('[data-note="scope"]')].map((p) => p.textContent),
        };
      });
      assert.equal(shown.badge, null, mode);
      assert.equal(shown.note, null, mode);
      assert.equal(shown.checks.length, 7, mode);
      shown.checks.forEach((c, n) => {
        assert.equal(c.answer, 'pass');
        assert.deepEqual(c.texts, [COPY['capture.pass'], capture.checks[n].name, capture.checks[n].claim], `${mode} check ${n}: the deck's word for the answer, then the run's name and claim`);
      });
      assert.deepEqual(shown.scope, capture.scope, mode);
      const result = await census(page);
      assertCensus(result, docsFrom(view.served, CLEAN_DONE.runId));
    }

    // The trace: under the crossing, one row per check with its answer.
    await page.keyboard.press('t');
    await view.settle();
    const rows = await page.evaluate(() => {
      const crossing = document.querySelector('.trace-row[data-span="crossing"]');
      if (crossing && crossing.getAttribute('aria-expanded') === 'false') crossing.querySelector('button, .trace-toggle')?.click();
      return [...document.querySelectorAll('.trace-row[data-parent="crossing"]')].map((row) => ({ kind: row.dataset.kind, text: row.textContent }));
    });
    assert.equal(rows.length, 7, JSON.stringify(rows));
    rows.forEach((row, n) => {
      assert.equal(row.kind, 'check');
      assert.ok(row.text.includes(capture.checks[n].name) && row.text.includes('pass'), row.text);
    });
    assertCensus(await census(page), docsFrom(view.served, CLEAN_DONE.runId));
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('before any run, the crossing shows as a run started now would use it: the server answers that at /api/variants by the check of the AI2II files a run makes, and the start screen follows it', async () => {
  const { startApi } = await import('../src/engine/api.mjs');
  const variantOf = async (runOptions) => {
    const api = await startApi({ port: 0, runsDir, paceSeconds: 0, runOptions });
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/variants`);
      assert.equal(res.status, 200);
      return (await res.json()).crossing;
    } finally {
      await api.stop();
    }
  };
  assert.equal(await variantOf({ ai2iiDir: captureDir, ai2iiSource: captureSource }), 'supplied', 'the three files there, each as pinned');
  assert.equal(await variantOf({ ai2iiDir: path.join(scratch, 'no-such-folder'), ai2iiSource: captureSource }), 'fallback', 'no files');
  // A file that differs from its pin falls back, as a run does.
  const changed = path.join(scratch, 'changed');
  fs.cpSync(captureDir, changed, { recursive: true });
  const first = fs.readdirSync(changed)[0];
  fs.appendFileSync(path.join(changed, first), 'x');
  assert.equal(await variantOf({ ai2iiDir: changed, ai2iiSource: captureSource }), 'fallback', 'a file that differs from its pin');

  // The start screen, before any run: the supplied crossing carries no
  // stand-in mark and is credited to its maker; the fallback carries the mark.
  for (const [server, standIn] of [[{ examples }, false], [{}, true]]) {
    const view = await openView(browser, { server });
    try {
      const shown = await view.page.evaluate(() => ({
        lane: document.querySelector('#lanes-head .lane[data-col="crossing"] .lane-credit').textContent,
        laneBadge: document.querySelector('#lanes-head .lane[data-col="crossing"] .badge') !== null,
        orientBadge: document.querySelector('#orient .orient-part[data-col="crossing"] .badge') !== null,
        legendBadge: document.querySelector('#pane-inspector [data-key="parts"] .insp-part[data-col="crossing"] .badge') !== null,
      }));
      assert.deepEqual([shown.laneBadge, shown.orientBadge, shown.legendBadge], [standIn, standIn, standIn], standIn ? 'the fallback is marked' : 'the supplied crossing is not');
      if (!standIn) assert.equal(shown.lane, COPY['credit.crossing']);
    } finally {
      await view.close();
    }
  }
});
