// The trace: a tree grid beside the message flow, with one row per step of
// the run (its start, how long it took, its state word and icon, and a bar
// to scale on one time lane) and, under a step, the rows of what happened
// inside it. Every value is read from the page and compared with the example
// the server sent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runAndWait, runScene, runIs, examplesWith, removeTempDirs, example, secondsApart, COPY, LABELS, ROOT, CLEAN_DONE, CLEAN_RUNNING, POISONED } from './support/view-helpers.mjs';
import { filled, poisonedManifest, traceRows, traceGrid } from './support/trace-helpers.mjs';
import { rowsOfRun, decidedCall } from '../view/trace.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const HEADERS = ['trace.colStep', 'trace.colStart', 'trace.colDuration', 'trace.colState', 'trace.colLane'].map((key) => COPY[key]);
const inside = (rows, id) => rows.filter((r) => r.parent === id);
const tops = (rows) => rows.filter((r) => r.level === 1);
const near = (got, want, slack, what) => assert.ok(Math.abs(got - want) <= slack, `${what}: ${got} is within ${slack} of ${want}`);

// The start and the time taken of a step, as the trace words them.
const startOf = (state, step) => (step.startedAt ? filled('trace.offset', { seconds: secondsApart(state.startedAt, step.startedAt) }) : '');
const tookOf = (step) => (step.startedAt && step.endedAt ? filled('trace.duration', { seconds: secondsApart(step.startedAt, step.endedAt) }) : '');

// A step's bar, against the lane: its left edge at the start and its width
// the time taken, over the span of the lane in seconds.
function assertBar(row, state, step, span, what) {
  assert.ok(row.lane && row.bar, `${what}: a bar on the lane`);
  const offset = (Date.parse(step.startedAt) - Date.parse(state.startedAt)) / 1000;
  const took = (Date.parse(step.endedAt) - Date.parse(step.startedAt)) / 1000;
  near(row.bar.left - row.lane.left, (offset / span) * row.lane.width, 1, `${what}: the bar starts at the step's start`);
  near(row.bar.width, Math.max(2, (took / span) * row.lane.width), 1, `${what}: the bar is as wide as the time taken`);
  assert.equal(row.lane.height, 8, `${what}: the lane is 8 px high`);
}

test('the stopped run in Inspect: six step rows in order with their states; the intent row open with the declared intent and each tool call, the call that decided marked; the stopped row carries the headline and the run\'s sentence; each check and each record is a row, and no row inside a step is timed', async () => {
  const manifest = poisonedManifest();
  assert.equal(manifest.records.length, POISONED.steps[5].detail.written, 'the derived manifest holds the records the poisoned run wrote');
  const view = await openView(browser, { hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': manifest } }) } });
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0);

    const grid = await traceGrid(page);
    assert.equal(grid.role, 'treegrid');
    assert.equal(grid.label, filled('trace.name', { runId: POISONED.runId }));
    assert.equal(grid.readonly, 'true');
    assert.deepEqual(grid.headers.map((h) => h.text), HEADERS);
    assert.equal(grid.shape, COPY['trace.shape']);
    assert.equal(grid.shapeUnderHeaders, true, 'the line on the shape stands under the column headers');
    assert.equal(grid.shapeSize, 13);

    const rows = await traceRows(page);
    const steps = tops(rows);
    assert.deepEqual(steps.map((r) => r.span), POISONED.steps.map((s) => s.id), 'one row per step, in the run\'s order');
    assert.deepEqual(steps.map((r) => r.number), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(steps.map((r) => r.name), POISONED.steps.map((s) => s.title));
    assert.deepEqual(steps.map((r) => [r.posinset, r.setsize]), [[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]]);
    assert.deepEqual(steps.map((r) => r.word), [COPY['state.passed'], COPY['state.passed'], COPY['state.passed'], COPY['state.stopped'], COPY['state.notReached'], COPY['state.written']]);
    assert.deepEqual(steps.map((r) => r.shown), POISONED.steps.map((s) => LABELS.states[s.status].icon), 'each state cell shows the icon of its state');
    assert.deepEqual(steps.map((r) => r.status), POISONED.steps.map((s) => s.status));
    assert.deepEqual(steps.map((r) => r.start), POISONED.steps.map((s) => startOf(POISONED, s)));
    assert.deepEqual(steps.map((r) => r.duration), POISONED.steps.map((s) => tookOf(s)));
    assert.deepEqual(steps.map((r) => r.title), POISONED.steps.map((_, i) => filled('trace.openStep', { n: i + 1 })));

    // The stopped step: the stop tile, the headline, the run's own sentence.
    const [credential, grant, crossing, intent, pay, record] = steps;
    assert.equal(intent.tone, 'stop');
    assert.equal(intent.expanded, 'true');
    assert.equal(intent.headline, COPY[LABELS.outcomeHeadlines['blocked:intent']]);
    assert.equal(intent.sentence, POISONED.reason);
    assert.equal(intent.cells, 6, 'its five cells, and the cell under them that holds the headline and the sentence');
    for (const row of [credential, grant, crossing, pay, record]) assert.equal(row.cells, 5, row.span);

    // Inside the intent step: the declared intent, then each tool call.
    const calls = POISONED.steps[3].detail.calls;
    const within = inside(rows, 'intent');
    assert.deepEqual(within.map((r) => r.name), [COPY['trace.declared'], filled('trace.call', { tool: calls[0].tool }), filled('trace.call', { tool: calls[1].tool })]);
    assert.deepEqual(within.map((r) => r.word), [null, COPY['decision.blocked'], COPY['decision.blocked']]);
    assert.deepEqual(within[1].why, [COPY['intent.undeclared']]);
    assert.equal(within[1].pill, null);
    assert.deepEqual(within[2].why, [COPY['intent.differs']]);
    assert.equal(within[2].field, calls[1].fieldsDiffering[0]);
    assert.equal(within[2].field, 'payeeAccount');
    assert.equal(within[2].pill, COPY['trace.decidedHere']);
    assert.equal(within[2].decided, 'yes');
    assert.equal(rows.filter((r) => r.pill !== null).length, 1, 'one row carries the mark');
    assert.deepEqual(within.map((r) => [r.level, r.posinset, r.setsize]), [[2, 1, 3], [2, 2, 3], [2, 3, 3]]);

    // The checks of the credential and the grant, and the records.
    const checked = POISONED.steps[1].detail.scopeChecked;
    assert.deepEqual(inside(rows, 'credential').map((r) => r.name), [filled('trace.check', { name: POISONED.steps[0].detail.verifier })]);
    assert.equal(checked.length, 4);
    assert.deepEqual(inside(rows, 'grant').map((r) => r.name), checked.map((name) => filled('trace.check', { name })));
    assert.deepEqual(inside(rows, 'record').map((r) => r.name), manifest.records.map((r) => filled('trace.record', { file: r.file })));
    assert.equal(inside(rows, 'record').length, 4);
    assert.deepEqual(inside(rows, 'record').map((r) => r.word), Array(4).fill(COPY['state.written']));
    for (const row of [credential, grant, record]) assert.equal(row.expanded, 'true', `${row.span}: Inspect opens every step that has rows inside`);
    for (const row of [crossing, pay]) {
      assert.equal(row.expanded, null, `${row.span} has no rows inside in this contract`);
      assert.equal(row.toggle, null);
      assert.equal(inside(rows, row.span).length, 0);
    }

    // No row inside a step is timed: it says so once, and its lane is empty.
    const nested = rows.filter((r) => r.level === 2);
    assert.equal(nested.length, 1 + 4 + 3 + 4);
    for (const row of nested) {
      assert.equal(row.duration, COPY['trace.notTimed'], row.span);
      assert.equal(row.start, '', row.span);
      assert.equal(row.lane, null, row.span);
      assert.equal(row.cells, 5, row.span);
      assert.equal(row.title, filled('trace.openStep', { n: POISONED.steps.findIndex((s) => s.id === row.parent) + 1 }));
    }

    // The bars, to scale over the run's own length; the stopped step's bar
    // takes the stop colour; a step not reached has a lane and no bar.
    const span = (Date.parse(POISONED.finishedAt) - Date.parse(POISONED.startedAt)) / 1000;
    for (const [i, row] of steps.entries()) {
      if (POISONED.steps[i].startedAt) assertBar(row, POISONED, POISONED.steps[i], span, row.span);
    }
    assert.deepEqual(steps.map((r) => r.bar?.fill ?? null), ['accent', 'accent', 'accent', 'stop', null, 'accent']);
    assert.ok(pay.lane !== null && pay.bar === null);

    assert.equal(grid.count, filled('trace.rows', { count: rows.length }));
    assert.equal(rows.length, 18);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the finished clean run: the starts read +1 s to +50 s and the times taken 1 s and 2 s, from the example\'s own times; every step row is one tab stop\'s worth of the grid, and the outcome banner stays at the pane\'s foot', async () => {
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    const steps = tops(await traceRows(page));
    assert.deepEqual(steps.map((r) => r.start), ['+1 s', '+10 s', '+20 s', '+30 s', '+40 s', '+50 s']);
    assert.deepEqual(steps.map((r) => r.duration), ['1 s', '2 s', '1 s', '1 s', '1 s', '2 s']);
    assert.deepEqual(steps.map((r) => r.start), CLEAN_DONE.steps.map((s) => startOf(CLEAN_DONE, s)));
    assert.deepEqual(steps.map((r) => r.duration), CLEAN_DONE.steps.map((s) => tookOf(s)));
    assert.deepEqual(steps.map((r) => r.word), [...Array(5).fill(COPY['state.passed']), COPY['state.written']]);
    const span = (Date.parse(CLEAN_DONE.finishedAt) - Date.parse(CLEAN_DONE.startedAt)) / 1000;
    for (const [i, row] of steps.entries()) assertBar(row, CLEAN_DONE, CLEAN_DONE.steps[i], span, row.span);
    assert.equal(steps.filter((r) => r.tabindex === '0').length, 1, 'one tab stop for the grid');

    // A finished clean run passed every tool call: the call row reads Allowed, and no row is marked.
    const rows = await traceRows(page);
    const call = inside(rows, 'intent').find((r) => r.kind === 'call');
    assert.equal(call.word, COPY['decision.allowed']);
    assert.deepEqual(call.why, []);
    assert.equal(rows.some((r) => r.pill !== null), false);

    const banner = await page.evaluate(() => {
      const end = document.getElementById('outcome-end');
      const pane = document.getElementById('pane-flow').getBoundingClientRect();
      const box = end.getBoundingClientRect();
      return { hidden: end.hidden, headline: end.querySelector('[data-outcome-part="headline"]').textContent, underTrace: box.top >= document.getElementById('trace').getBoundingClientRect().bottom - 0.5, inPane: box.bottom <= pane.bottom + 0.5 };
    });
    assert.deepEqual(banner, { hidden: false, headline: COPY['outcome.paid'], underTrace: true, inPane: true });
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a run in progress: the step being checked reads how long it has taken so far on the browser clock, its bar grows from one second to the next over the lane of the label map, and the steps not begun have no time and no bar', async () => {
  const grant = CLEAN_RUNNING.steps[1];
  assert.equal(grant.status, 'running');
  const view = await openView(browser, { hash: '#inspect-trace', clockAt: new Date(Date.parse(grant.startedAt) + 4000).toISOString(), server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  const { page } = view;
  try {
    await runScene(page, 'clean');
    await runIs(page, 'running');
    await view.settle();
    const read = async () => tops(await traceRows(page));
    const before = await read();
    assert.deepEqual(before.map((r) => r.word), [COPY['state.passed'], COPY['state.checking'], ...Array(4).fill(COPY['state.pending'])]);
    const soFar = new RegExp(`^${COPY['trace.soFar'].replace('{seconds}', '(\\d+)')}$`);
    assert.match(before[1].duration, soFar);
    assert.ok(Number(soFar.exec(before[1].duration)[1]) >= 4, `the clock stood four seconds after the step began: ${before[1].duration}`);
    assert.equal(before[1].start, startOf(CLEAN_RUNNING, grant));
    assert.equal(before[1].bar.fill, 'accent');
    // While the run goes on the lane is as long as the label map says.
    const lane = LABELS.trace.laneSeconds;
    assert.equal(lane, 120);
    near(before[1].bar.left - before[1].lane.left, (10 / lane) * before[1].lane.width, 1, 'the bar starts ten seconds along a lane of 120 seconds');
    for (const row of before.slice(2)) {
      assert.equal(row.start, '', row.span);
      assert.equal(row.duration, '', row.span);
      assert.equal(row.bar, null, row.span);
      assert.ok(row.lane !== null, `${row.span}: the track of the lane stays`);
    }
    await page.waitForTimeout(1000);
    const second = await read();
    assert.ok(second[1].bar.width > before[1].bar.width, `the bar grows: ${before[1].bar.width} then ${second[1].bar.width}`);
    assert.ok(Number(soFar.exec(second[1].duration)[1]) > Number(soFar.exec(before[1].duration)[1]), `the time so far grows: ${before[1].duration} then ${second[1].duration}`);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

for (const [width, height] of [[1440, 900], [1920, 1080]]) {
  test(`${width}x${height} Story: the stopped step's rows alone are open, the six rows and the sentence lie inside the window and the grid does not scroll, on the stopped run and on the finished clean run; the type holds the Story sizes`, async () => {
    const view = await openView(browser, { width, height, hash: '#story-trace', server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
    const { page } = view;
    try {
      const measure = () => page.evaluate(() => {
        const px = (node) => (node ? parseFloat(getComputedStyle(node).fontSize) : null);
        const inView = (node) => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.height > 0; };
        const body = document.getElementById('trace-body');
        const grid = document.getElementById('trace-grid');
        const level1 = [...body.querySelectorAll('[aria-level="1"]')];
        const current = body.querySelector('[data-current="yes"]');
        const others = level1.filter((r) => r !== current);
        const min = (nodes) => Math.min(...nodes.map(px));
        const sentence = body.querySelector('.trace-stop-text');
        return {
          size: document.body.dataset.size,
          body: [body.scrollHeight, body.clientHeight],
          grid: [grid.scrollHeight, grid.clientHeight],
          doc: [document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight, innerHeight],
          rowsInView: level1.every(inView),
          sentenceInView: sentence ? inView(sentence) : null,
          countInView: inView(document.getElementById('trace-count')),
          heights: level1.map((r) => r.getBoundingClientRect().height),
          names: min(others.map((r) => r.querySelector('.trace-title'))),
          currentName: px(current?.querySelector('.trace-title')),
          currentWord: px(current?.querySelector('.chip-word')),
          words: min(level1.map((r) => r.querySelector('.chip-word'))),
          times: min([...body.querySelectorAll('[aria-level="1"] > .trace-start, [aria-level="1"] > .trace-dur')]),
          nested: [...body.querySelectorAll('[aria-level="2"]')].map((r) => px(r)),
          sentence: px(sentence),
          headline: px(body.querySelector('.trace-stop-head')),
          pill: px(body.querySelector('.trace-pill')),
          shape: px(document.getElementById('trace-shape')),
          smallest: Math.min(...[...document.querySelectorAll('#trace *')].filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim())).map(px)),
        };
      });
      const fits = (m, what) => {
        assert.equal(m.size, 'story');
        assert.ok(m.body[0] <= m.body[1], `${what}: the rows do not scroll (${m.body})`);
        assert.ok(m.grid[0] <= m.grid[1], `${what}: the grid does not scroll (${m.grid})`);
        assert.ok(m.doc[0] <= m.doc[1] && m.doc[2] <= m.doc[3], `${what}: the page does not scroll (${m.doc})`);
        assert.equal(m.rowsInView, true, `${what}: every step row is inside the window`);
        assert.equal(m.countInView, true, `${what}: the line that closes the grid is inside the window`);
        for (const h of m.heights) assert.ok(h >= 48, `${what}: a step row is at least 48 px high (${h})`);
        // One type scale: Story's value size for the names, its label size for
        // the words, the times and the line on the shape.
        assert.ok(m.names >= 18, `${what}: step names at least 18 px (${m.names})`);
        assert.ok(m.words >= 15 && m.times >= 15, `${what}: state words and times at least 15 px (${m.words}, ${m.times})`);
        assert.equal(m.shape, 15, `${what}: the line on the shape at 15 px`);
        assert.ok(m.smallest >= 13, `${what}: no text under 13 px (${m.smallest})`);
      };

      await runAndWait(view, 'poisoned', 'blocked');
      const rows = await traceRows(page);
      assert.deepEqual([...new Set(rows.filter((r) => r.level === 2).map((r) => r.parent))], ['intent'], 'the stopped step alone is open');
      assert.deepEqual(tops(rows).map((r) => r.expanded), ['false', 'false', null, 'true', null, 'false']);
      assert.equal(rows.filter((r) => r.selected === 'true').map((r) => r.span).join(), 'intent', 'follow rests on the stopped step');
      const stopped = await measure();
      fits(stopped, 'stopped');
      // The selected step is set apart by weight, not by a larger size; in
      // Story the run's sentence is the outcome line's, under the pane.
      assert.ok(stopped.currentName >= 18, `the selected step's name at least 18 px (${stopped.currentName})`);
      assert.ok(stopped.currentWord >= 15, `its state word at least 15 px (${stopped.currentWord})`);
      assert.ok(stopped.headline >= 18, `the headline at least 18 px (${stopped.headline})`);
      assert.equal(await page.evaluate(() => document.querySelector('#outcome-end [data-outcome-part="text"]') !== null), true, 'the outcome line carries the sentence');
      assert.deepEqual(stopped.nested, [15, 15, 15], 'the rows inside a step at 15 px');
      assert.equal(stopped.pill, 15, 'the mark at 15 px');

      // Every selection of the stopped run still fits.
      for (const key of ['1', '2', '3', '5', '6', '0', '4']) {
        await page.keyboard.press(key);
        await view.settle(60);
        fits(await measure(), `stopped, key ${key}`);
      }

      await runAndWait(view, 'clean', 'paid');
      const done = await measure();
      fits(done, 'clean finished');
      assert.equal((await traceRows(page)).filter((r) => r.level === 2).length, 0, 'a run that was not stopped opens no step in Story');
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

for (const [width, height, lane, mode] of [[1280, 800, 200, 'inspect'], [1440, 900, 240, 'inspect'], [1920, 1080, 320, 'inspect'], [1440, 900, 240, 'story'], [1920, 1080, 320, 'story']]) {
  test(`${width}x${height} ${mode}: the page is no wider than the window, the lane is at least ${lane} px wide, each cell of a step row stands under its column header, and in Inspect the type holds the Inspect sizes while the rows may scroll inside the pane`, async () => {
    const view = await openView(browser, { width, height, hash: `#${mode}-trace`, server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
    const { page } = view;
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      await page.waitForFunction((want) => document.querySelectorAll('#trace-body [aria-level="1"]').length === want, 6);
      const m = await page.evaluate(() => {
        const px = (node) => parseFloat(getComputedStyle(node).fontSize);
        const body = document.getElementById('trace-body');
        const pane = document.getElementById('pane-flow');
        const row = body.querySelector('[aria-level="1"]');
        const heads = [...document.querySelectorAll('.trace-cols [role="columnheader"]')].map((h) => h.getBoundingClientRect().left);
        const cells = [...row.children].map((c) => c.getBoundingClientRect());
        const level1 = [...body.querySelectorAll('[aria-level="1"]')];
        return {
          doc: [document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight, innerHeight],
          pane: [pane.scrollWidth, pane.clientWidth, pane.scrollHeight, pane.clientHeight],
          bodyWide: [body.scrollWidth, body.clientWidth],
          lanes: [...body.querySelectorAll('[aria-level="1"] .trace-lane')].map((l) => l.getBoundingClientRect().width),
          heads,
          cells: cells.map((c) => c.left),
          widths: cells.map((c) => c.width),
          heights: level1.map((r) => r.getBoundingClientRect().height),
          names: level1.map((r) => px(r.querySelector('.trace-title'))),
          words: level1.map((r) => px(r.querySelector('.chip-word'))),
          times: [...body.querySelectorAll('[aria-level="1"] > .trace-start, [aria-level="1"] > .trace-dur')].map(px),
          nested: [...body.querySelectorAll('[aria-level="2"]')].map(px),
          sentence: px(body.querySelector('.trace-stop-text')),
          pill: px(body.querySelector('.trace-pill')),
          overflowY: getComputedStyle(body).overflowY,
          scrollBehavior: getComputedStyle(body).scrollBehavior,
          toggles: [...body.querySelectorAll('.trace-toggle:not([hidden])')].map((t) => { const r = t.getBoundingClientRect(); return [r.width, r.height]; }),
        };
      });
      assert.ok(m.doc[0] <= m.doc[1], `the page is as wide as the window (${m.doc})`);
      assert.ok(m.doc[2] <= m.doc[3], `the page is as high as the window (${m.doc})`);
      assert.ok(m.pane[0] <= m.pane[1] && m.pane[2] <= m.pane[3], `the middle pane itself does not scroll (${m.pane})`);
      assert.ok(m.bodyWide[0] <= m.bodyWide[1], `no row is wider than the grid (${m.bodyWide})`);
      assert.equal(m.lanes.length, 6);
      for (const w of m.lanes) assert.ok(w >= lane, `the lane is at least ${lane} px wide (${w})`);
      assert.equal(new Set(m.lanes.map((w) => Math.round(w))).size, 1, 'every lane is as wide as the others, so the bars share one scale');
      // The title has the row's leading line to itself; the four cells of the
      // second line stand under their headers.
      for (const n of [1, 2, 3, 4]) near(m.cells[n], m.heads[n], 0.5, `cell ${n} under its header`);
      near(m.cells[0], m.heads[0], 0.5, 'the step cell starts under the Step header');
      const startWidth = width >= 1920 ? 112 : 96;
      near(m.widths[1], startWidth, 0.5, 'the Start column');
      near(m.widths[2], startWidth, 0.5, 'the Duration column');
      near(m.widths[3], mode === 'story' ? 184 : 160, 0.5, 'the State column');
      assert.equal(m.overflowY, 'auto');
      assert.equal(m.scrollBehavior, 'auto', 'the rows never scroll smoothly');
      for (const [w, h] of m.toggles) assert.ok(w >= 24 && h >= 24, `the control that opens a step is at least 24 by 24 px (${w} by ${h})`);
      if (mode === 'inspect') {
        for (const h of m.heights) assert.ok(h >= 40, `a step row is at least 40 px high (${h})`);
        // Inspect's scale: value 15 for the names, label 13 for the words,
        // the times, the rows inside a step, the sentence and the mark.
        assert.deepEqual([...new Set(m.names)], [15], 'step names at 15 px');
        assert.deepEqual([...new Set(m.words)], [13], 'state words at 13 px');
        assert.deepEqual([...new Set(m.times)], [13], 'times at 13 px');
        assert.deepEqual([...new Set(m.nested)], [13], 'the rows inside a step at 13 px');
        assert.equal(m.sentence, 13, 'the run\'s sentence at 13 px');
        assert.equal(m.pill, 13, 'the mark at 13 px');
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('before a run the trace lists the six steps of the contract as pending, with no time, no bar and nothing inside; a key or a click on a row opens nothing', async () => {
  const view = await openView(browser, { hash: '#story-trace' });
  const { page } = view;
  try {
    const grid = await traceGrid(page);
    assert.equal(grid.label, COPY['view.trace'], 'with no run to name, the grid is named for the view');
    assert.equal(grid.count, filled('trace.rows', { count: 6 }));
    const rows = await traceRows(page);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((r) => r.name), ['credential', 'grant', 'crossing', 'intent', 'pay', 'record'].map((id) => COPY[`step.${id}`]));
    assert.deepEqual(rows.map((r) => r.word), Array(6).fill(COPY['state.pending']));
    for (const row of rows) {
      assert.deepEqual([row.start, row.duration, row.bar, row.expanded, row.selected, row.title], ['', '', null, null, null, null], row.span);
    }
    await page.click('#trace-body [role="row"]:nth-child(3)');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.querySelector('#pane-inspector .insp').dataset.panel), 'start');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the offline check is a row of its own after the steps: its start is the time the check ran, and inside it each record and each tampered copy reads its verdict in the deck\'s words', async () => {
  const offline = example('offline-check.json');
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    // The audit opens the Records tab; T brings the trace back with its row.
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.body.dataset.tab === 'records');
    await page.keyboard.press('t');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="offline-check"]') !== null);
    await view.settle();
    const rows = await traceRows(page);
    const steps = tops(rows);
    assert.equal(steps.length, 7);
    const row = steps[6];
    assert.equal(row.name, COPY['trace.offlineRow']);
    assert.equal(row.number, null, 'the check is not a step and takes no number');
    assert.equal(row.start, offline.at.split('T')[1]);
    assert.deepEqual([row.duration, row.state, row.lane, row.bar, row.title], ['', '', null, null, null]);
    assert.deepEqual([row.posinset, row.setsize, row.expanded, row.selected], [7, 7, 'true', 'true']);
    assert.equal(row.toggle.label, null);
    assert.ok(row.toggle.labelledby, 'the control that opens it is named by the row\'s own title');
    const within = inside(rows, 'offline-check');
    assert.deepEqual(within.map((r) => r.name), [...offline.records, ...offline.tampered].map((r) => filled('trace.record', { file: r.file })));
    assert.deepEqual(within.map((r) => r.word), [...offline.records.map(() => COPY['offline.pass']), filled('offline.reject', { n: offline.tampered[0].firstFailingStep })]);
    assert.deepEqual(within.map((r) => r.kind), [...offline.records.map(() => 'records'), 'tampered']);
    for (const r of within) assert.equal(r.duration, COPY['trace.notTimed']);
    assert.equal(await page.evaluate(() => document.querySelector('#pane-inspector .insp').dataset.panel), 'offline');

    // In Story the rows inside it are closed; Right opens them.
    await page.keyboard.press('s');
    await view.settle(60);
    assert.equal(inside(await traceRows(page), 'offline-check').length, 0);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a step that carries its own events (a later revision of the contract) shows those as the rows inside it, each at its own time on the lane, in place of the rows derived from its detail', async () => {
  const state = structuredClone(CLEAN_DONE);
  const intent = state.steps[3];
  intent.detail.events = [
    { name: 'declared', at: intent.startedAt, attributes: { action: 'pay' } },
    { name: 'call', at: intent.endedAt, attributes: { tool: intent.detail.calls[0].tool } },
  ];
  const view = await openView(browser, { hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'state-clean-done.json': state } }) } });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    const rows = await traceRows(page);
    const within = inside(rows, 'intent');
    assert.deepEqual(within.map((r) => r.kind), ['event', 'event']);
    assert.deepEqual(within.map((r) => r.name), ['declared', 'call']);
    assert.deepEqual(within.map((r) => r.start), [filled('trace.offset', { seconds: 30 }), filled('trace.offset', { seconds: 31 })]);
    assert.deepEqual(within.map((r) => r.duration), ['', ''], 'an event is a moment: it has a start and takes no time');
    for (const r of within) assert.ok(r.lane !== null && r.bar !== null && r.bar.width <= 3, `${r.span}: a mark on the lane at its time`);
    assert.ok(within[1].bar.left > within[0].bar.left);
    // The marks stand on the lane of the step rows: the same left edge, the
    // same width, and the earlier of them where the step's own bar starts.
    const step = rows.find((r) => r.span === 'intent');
    for (const r of within) {
      near(r.lane.left, step.lane.left, 0.5, `${r.span}: the lane starts where the step's lane starts`);
      near(r.lane.width, step.lane.width, 0.5, `${r.span}: the lane is as wide as the step's lane`);
    }
    near(within[0].bar.left, step.bar.left, 0.5, 'the earlier mark stands where the step began');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('with the colour taken out the six step rows still read apart: each state cell carries a word and an icon shape, a state has one shape and one word of its own, and one row carries the mark', async () => {
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).filter), 'grayscale(1)');
    const rows = await traceRows(page);
    const steps = tops(rows);
    assert.equal(steps.length, 6);
    for (const row of steps) {
      assert.ok(row.icon && row.shown === row.icon, `${row.span}: an icon shape in the state cell`);
      assert.ok(row.word, `${row.span}: a word in the state cell`);
    }
    assert.deepEqual(steps.map((r) => r.icon), ['circle-check', 'circle-check', 'circle-check', 'octagon-bar', 'circle-dashed', 'document-folded']);
    assert.deepEqual(steps.map((r) => r.word), [COPY['state.passed'], COPY['state.passed'], COPY['state.passed'], COPY['state.stopped'], COPY['state.notReached'], COPY['state.written']]);
    // The run has four states among its six steps. Each has its own shape
    // and its own word, so a row differs from every row of another state by
    // both, whatever the colours.
    const statuses = new Set(steps.map((r) => r.status));
    assert.equal(statuses.size, 4);
    assert.equal(new Set(steps.map((r) => r.icon)).size, statuses.size);
    assert.equal(new Set(steps.map((r) => r.word)).size, statuses.size);
    for (const a of steps) for (const b of steps) if (a.status !== b.status) assert.ok(a.icon !== b.icon && a.word !== b.word, `${a.span} and ${b.span}`);
    assert.equal(rows.filter((r) => r.pill === COPY['trace.decidedHere']).length, 1);
  } finally {
    await view.close();
  }
});

// ---- The rows as objects, apart from the page

// The row fields of the field map's leading table, with what the map says
// of each: carried by the run, or not carried and so left out.
function fieldMap() {
  const text = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'trace-field-map.md'), 'utf8');
  const table = text.slice(text.indexOf('| row field |')).split('\n\n')[0].split('\n').slice(2);
  return table.map((line) => {
    const cols = line.split('|').map((c) => c.trim());
    return { field: cols[1].replaceAll('`', ''), source: cols[2] };
  });
}

test('the rows as objects carry the fields of the field map and no other: the run\'s ids, titles and times as strings, the status code by the map\'s rule, the run\'s reason on the stopped step, the detail as written; kind and links are left out', () => {
  const map = fieldMap();
  assert.deepEqual(map.map((f) => f.field), ['traceId', 'spanId', 'parentSpanId', 'name', 'startTime', 'endTime', 'status.code', 'status.message', 'attributes', 'events', 'resource', 'kind', 'links']);
  const carried = map.filter((f) => f.source !== 'not carried').map((f) => f.field);
  const leftOut = map.filter((f) => f.source === 'not carried').map((f) => f.field);
  assert.deepEqual(leftOut, ['kind', 'links']);
  const names = [...new Set(carried.map((f) => f.split('.')[0]))];
  const inner = carried.filter((f) => f.startsWith('status.')).map((f) => f.split('.')[1]);

  const manifest = poisonedManifest();
  const offline = example('offline-check.json');
  const rows = rowsOfRun(POISONED, { manifest, offline });
  assert.equal(rows.length, 6 + (1 + 4 + 3 + 4) + 1 + 6);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), names, row.spanId);
    assert.deepEqual(Object.keys(row.status), inner, row.spanId);
    assert.equal(row.traceId, POISONED.runId);
  }

  const steps = rows.filter((r) => r.parentSpanId === null && r.spanId !== 'offline-check');
  assert.deepEqual(steps.map((r) => r.spanId), POISONED.steps.map((s) => s.id));
  assert.deepEqual(steps.map((r) => r.name), POISONED.steps.map((s) => s.title));
  assert.deepEqual(steps.map((r) => [r.startTime, r.endTime]), POISONED.steps.map((s) => [s.startedAt, s.endedAt]), 'the times stay the run\'s strings');
  assert.deepEqual(steps.map((r) => r.status.code), ['STATUS_CODE_OK', 'STATUS_CODE_OK', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR', 'STATUS_CODE_UNSET', 'STATUS_CODE_OK']);
  assert.deepEqual(steps.map((r) => r.status.message), [null, null, null, POISONED.reason, null, null]);
  assert.deepEqual(steps.map((r) => r.attributes), POISONED.steps.map((s) => s.detail));
  assert.deepEqual(steps.map((r) => r.resource), POISONED.steps.map((s) => ({ part: s.part, partLabel: s.partLabel })));
  for (const row of steps) assert.deepEqual(row.events, []);

  // The rows inside a step name their step as their parent.
  const calls = rows.filter((r) => r.parentSpanId === 'intent');
  assert.deepEqual(calls.map((r) => r.spanId), ['intent/declared/0', 'intent/call/0', 'intent/call/1']);
  assert.deepEqual(calls.map((r) => r.name), [null, 'secrets.read', 'bank.payments.create']);
  assert.deepEqual(calls.map((r) => r.status.code), ['STATUS_CODE_UNSET', 'STATUS_CODE_ERROR', 'STATUS_CODE_ERROR']);
  assert.deepEqual(rows.filter((r) => r.parentSpanId === 'grant').map((r) => r.name), POISONED.steps[1].detail.scopeChecked);
  assert.deepEqual(rows.filter((r) => r.parentSpanId === 'credential').map((r) => r.name), [POISONED.steps[0].detail.verifier]);
  assert.deepEqual(rows.filter((r) => r.parentSpanId === 'record').map((r) => r.name), manifest.records.map((r) => r.file));
  for (const row of rows.filter((r) => r.parentSpanId !== null)) assert.deepEqual([row.startTime, row.endTime], [null, null], `${row.spanId} is not timed in this contract`);

  // The offline check and its records.
  const check = rows.find((r) => r.spanId === 'offline-check');
  assert.deepEqual([check.parentSpanId, check.startTime, check.endTime, check.name], [null, offline.at, null, null]);
  assert.deepEqual(rows.filter((r) => r.parentSpanId === 'offline-check').map((r) => r.status.code), [...Array(5).fill('STATUS_CODE_OK'), 'STATUS_CODE_ERROR']);

  // Status codes by the map's rule, for every status of the contract.
  const codeOf = (status) => rowsOfRun({ runId: 'r', blockedAt: null, reason: null, steps: [{ id: 'credential', status }] })[0].status.code;
  assert.deepEqual(['passed', 'written', 'blocked', 'pending', 'running', 'not-reached', 'expired'].map(codeOf), ['STATUS_CODE_OK', 'STATUS_CODE_OK', 'STATUS_CODE_ERROR', 'STATUS_CODE_UNSET', 'STATUS_CODE_UNSET', 'STATUS_CODE_UNSET', 'STATUS_CODE_UNSET']);

  // A running step has no end, and a run with no manifest and no check has neither's rows.
  const running = rowsOfRun(CLEAN_RUNNING);
  assert.deepEqual(running.map((r) => r.spanId), ['credential', 'credential/check/0', 'grant', 'crossing', 'intent', 'pay', 'record']);
  assert.deepEqual([running[2].startTime, running[2].endTime], [CLEAN_RUNNING.steps[1].startedAt, null]);
});

test('the call that decided: by the rule\'s own result, the earliest call that differs from its declared intent, or, when every held call matched, the earliest call with no declared intent', () => {
  const detail = POISONED.steps[3].detail;
  assert.equal(detail.result, 'mismatch');
  assert.deepEqual(detail.calls.map((c) => c.match), [false, false], 'both calls of the poisoned run were blocked');
  assert.equal(decidedCall(detail), 1, 'the result is a mismatch, and the call that differs is the second');
  const undeclared = { result: 'undeclared-call', calls: [{ tool: 'a', declaredFor: 'pay', match: true, fieldsDiffering: [] }, { tool: 'b', declaredFor: null, match: false, fieldsDiffering: ['x'] }] };
  assert.equal(decidedCall(undeclared), 1);
  assert.equal(decidedCall({ result: 'mismatch', calls: [{ declaredFor: 'pay', match: false, fieldsDiffering: ['amount'] }, { declaredFor: null, match: false }] }), 0);
  assert.equal(decidedCall(CLEAN_DONE.steps[3].detail), -1, 'a run whose calls all matched has no such call');
  assert.equal(decidedCall(null), -1);
  assert.equal(decidedCall({ calls: [{ declaredFor: null, match: false }] }), 0, 'with no result named, the earliest blocked call');
});
