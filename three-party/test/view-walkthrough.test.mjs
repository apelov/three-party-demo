// The walkthrough a viewer is led through. The menu chooses and the run
// controls run. The outcome offers the first act not yet done, in whatever
// order the acts were taken, and the start again only once all three are
// done. Every screen has one primary action. The step controls stand only
// where there are steps to move through. The run's own facts read in plain
// words in Story and under the run's field names in Inspect. Below 1200 px
// the inspector stands under the middle pane, the lane heads stay whole and
// the outcome never lies over the step selected. Every press here is a real
// click or a real key.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runIs, runScene, removeTempDirs, COPY } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// What the page shows of the walkthrough now.
const now = (page) => page.evaluate(() => {
  const shown = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  return {
    run: document.body.dataset.run,
    chosen: document.querySelector('#scenes .scene[aria-pressed="true"]')?.dataset.kind ?? null,
    next: document.querySelector('#outcome-end #next-action')?.dataset.next ?? null,
    nextClass: document.querySelector('#outcome-end #next-action')?.className ?? null,
    primaries: [...document.querySelectorAll('.btn-primary')].filter(shown).map((b) => b.id || b.dataset.runKind || b.textContent),
    stepControls: !document.getElementById('step-controls').hidden && shown(document.getElementById('step-controls')),
    done: [...document.querySelectorAll('#scenes .scene[data-done="yes"]')].map((b) => b.dataset.kind),
  };
});
const settleFor = (page, ms = 500) => new Promise((resolve) => { setTimeout(resolve, ms); });
const audited = (page) => page.waitForFunction(() => document.body.dataset.tab === 'records' && document.querySelector('#records-tab [data-verdict-for] .verdict') !== null);

test('a click, Enter or Space on an item of the menu chooses it and starts nothing; the R key and the run control run the item chosen', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    assert.equal((await now(page)).run, 'none');
    await page.click('.scene[data-kind="poisoned"]');
    await settleFor(page);
    let seen = await now(page);
    assert.deepEqual([seen.run, seen.chosen], ['none', 'poisoned'], 'a click chooses');
    await page.keyboard.press('ArrowUp');
    assert.equal((await now(page)).chosen, 'clean', 'Up chooses the item above');
    await page.keyboard.press('Enter');
    await settleFor(page);
    seen = await now(page);
    assert.deepEqual([seen.run, seen.chosen], ['none', 'clean'], 'Enter chooses');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await settleFor(page);
    seen = await now(page);
    assert.deepEqual([seen.run, seen.chosen], ['none', 'poisoned'], 'Space chooses');
    await page.keyboard.press('r');
    await runIs(page, 'blocked');
    await page.click('.scene[data-kind="clean"]');
    await settleFor(page);
    assert.equal((await now(page)).run, 'blocked', 'choosing again starts nothing');
    await page.click('#run-control');
    await runIs(page, 'paid');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the outcome offers the first act not yet done: after the poisoned invoice first, the normal payment; then the audit; then, all three done, the start again; one primary action on each screen, the audit\'s own on the Records tab', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    const one = async (where) => {
      const { primaries } = await now(page);
      assert.equal(primaries.length, 1, `${where}: one primary action, not ${primaries.length} (${primaries.join(', ')})`);
    };
    await one('the start');
    assert.equal((await now(page)).stepControls, false, 'no step to move through before a run');
    await runScene(page, 'poisoned');
    await runIs(page, 'blocked');
    await view.settle();
    let seen = await now(page);
    assert.equal(seen.next, 'clean', 'after the poisoned invoice first, the normal payment');
    assert.equal(seen.stepControls, true, 'a run has steps to move through');
    await one('the stop');
    // The Records tab before the audit: its own button is the primary action,
    // and the outcome's steps back.
    await page.click('#tab-records');
    await page.waitForSelector('#records-audit');
    seen = await now(page);
    assert.deepEqual(seen.primaries, ['records-audit'], 'on the Records tab before the audit, the audit is the one primary action');
    assert.equal(seen.nextClass, 'btn btn-quiet');
    await page.click('#next-action');
    await runIs(page, 'paid');
    await view.settle();
    seen = await now(page);
    assert.equal(seen.next, 'audit', 'both runs done: the audit');
    await one('the payment');
    await page.click('#next-action');
    await audited(page);
    await view.settle();
    seen = await now(page);
    assert.equal(seen.next, 'start-again', 'all three done: the start again');
    assert.deepEqual(seen.done.sort(), ['clean', 'offline-check', 'poisoned']);
    assert.equal(seen.stepControls, false, 'no step to move through on the audit');
    await one('the audit');
    await page.click('#next-action');
    await runIs(page, 'none');
    await view.settle();
    seen = await now(page);
    assert.deepEqual([seen.done, seen.stepControls], [[], false], 'back at the start: no act done, no step controls');
    await one('the start again');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('after the normal payment and its audit the outcome offers the poisoned invoice, not the start again; after the poisoned invoice, the audit of its records comes before the start again', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runScene(page, 'clean');
    await runIs(page, 'paid');
    await view.settle();
    assert.equal((await now(page)).next, 'poisoned');
    await page.keyboard.press('o');
    await audited(page);
    await view.settle();
    const seen = await now(page);
    assert.equal(seen.next, 'poisoned', 'one run not yet done');
    assert.equal(seen.primaries.length, 1);
    // The poisoned invoice next. Its records are not checked yet, so the
    // audit comes before the start again, although an audit was done before.
    await page.click('#next-action');
    await runIs(page, 'blocked');
    await view.settle();
    assert.equal((await now(page)).next, 'audit', 'a finished run whose records are not checked yet: the audit');
    await page.click('#next-action');
    await audited(page);
    await view.settle();
    assert.equal((await now(page)).next, 'start-again', 'both runs done and this run audited: the start again');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the run\'s own facts: plain words in Story (Run, Started, Finished, Credential SHA-256), the run\'s field names in Inspect', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runScene(page, 'clean');
    await runIs(page, 'paid');
    await view.settle();
    await page.keyboard.press('0');
    const keys = () => page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-panel="overview"] [data-section="run"] .insp-section-body > dl.kv:first-child > .kv-row > .kv-key')].map((k) => ({ text: k.textContent, src: k.dataset.src ?? k.closest('[data-src]')?.dataset.src ?? null })));
    const story = await keys();
    assert.deepEqual(story.map((k) => k.text), [COPY['insp.runId'], COPY['insp.started'], COPY['insp.finished'], COPY['insp.credentialSha']]);
    assert.deepEqual(story.map((k) => k.text), ['Run', 'Started', 'Finished', 'Credential SHA-256']);
    assert.ok(story.every((k) => k.src?.startsWith('copy:')), 'each a line of the deck');
    await page.keyboard.press('i');
    await view.settle();
    assert.deepEqual((await keys()).map((k) => k.text), ['runId', 'startedAt', 'finishedAt', 'credentialSha256']);
  } finally {
    await view.close();
  }
});

for (const [width, height, under] of [[1024, 768, true], [1280, 720, false]]) {
  test(`${width}x${height}: the inspector ${under ? 'stands under' : 'stands beside'} the middle pane, every lane head stays whole, and the outcome never lies over the step selected`, async () => {
    const view = await openView(browser, { width, height });
    const { page } = view;
    try {
      const layout = () => page.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const head = box('lanes-head');
        const pane = box('pane-flow');
        const pieces = [...document.querySelectorAll('#lanes-head .lane-line, #lanes-head .lane-credit, #lanes-head .badge')].filter((n) => n.getClientRects().length > 0);
        const where = document.getElementById('where');
        return {
          lanes: head.width > 0,
          whereWhole: where.scrollWidth <= where.clientWidth + 1 && where.getClientRects().length > 0,
          flow: box('pane-flow').toJSON(),
          inspector: box('pane-inspector').toJSON(),
          left: box('pane-left').toJSON(),
          headInPane: head.left >= pane.left - 0.5 && head.right <= pane.right + 0.5,
          cut: pieces.filter((n) => {
            const r = n.getBoundingClientRect();
            return n.scrollWidth > n.clientWidth + 1 || r.left < head.left - 0.5 || r.right > head.right + 0.5;
          }).map((n) => n.textContent),
          pieces: pieces.length,
          pageWide: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      const check = async (where) => {
        const seen = await layout();
        assert.equal(seen.whereWhole, true, `${where}: the where-you-are line is shown whole`);
        if (seen.lanes) {
          assert.equal(seen.headInPane, true, `${where}: the lane heads lie inside the middle pane`);
          assert.ok(seen.pieces >= 10, `${where}: ${seen.pieces} lane pieces`);
          assert.deepEqual(seen.cut, [], `${where}: no lane head is cut`);
        }
        assert.equal(seen.pageWide, false, `${where}: nothing runs off the side of the page`);
        if (under) {
          assert.ok(seen.inspector.top >= seen.flow.bottom - 1, `${where}: the inspector stands under the middle pane`);
          assert.ok(Math.abs(seen.inspector.left - seen.flow.left) <= 1 && Math.abs(seen.inspector.right - seen.flow.right) <= 1, `${where}: as wide as the middle pane`);
          assert.ok(seen.left.left < seen.flow.left, `${where}: the menu keeps its column`);
        } else {
          assert.ok(seen.inspector.left >= seen.flow.right - 1, `${where}: the inspector stands beside the middle pane`);
        }
      };
      await check('the start');
      await runScene(page, 'poisoned');
      await runIs(page, 'blocked');
      await view.settle();
      await check('the stop');
      assert.equal((await layout()).lanes, true, 'the stop shows the lanes');
      for (const key of ['1', '2', '3', '4', '5', '6']) {
        await page.keyboard.press(key);
        await view.settle();
        const seen = await page.evaluate(() => {
          const row = document.querySelector('#rows .row[aria-current="step"]').getBoundingClientRect();
          const end = document.getElementById('outcome-end');
          const bar = end.hidden ? null : end.getBoundingClientRect();
          return {
            over: Boolean(bar) && row.bottom > bar.top + 0.5 && row.top < bar.bottom - 0.5,
            inWindow: row.top >= -0.5 && row.bottom <= window.innerHeight + 0.5,
          };
        });
        assert.deepEqual(seen, { over: false, inWindow: true }, `step ${key}: the row lies whole in the window and the outcome is not over it`);
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('a window that shrinks after a step is chosen, as when a laptop is mirrored to a projector, brings that step back into sight above the outcome', async () => {
  const view = await openView(browser, { width: 1440, height: 900 });
  const { page } = view;
  try {
    await runScene(page, 'poisoned');
    await runIs(page, 'blocked');
    await view.settle();
    await page.keyboard.press('4');
    await view.settle();
    // 577 px high: what a 1280x720 Chrome window leaves the page under its
    // own bars, measured in Chrome on 2026-11-16.
    await page.setViewportSize({ width: 1280, height: 577 });
    await view.settle();
    const seen = await page.evaluate(() => {
      const row = document.querySelector('#rows .row[aria-current="step"]').getBoundingClientRect();
      const end = document.getElementById('outcome-end');
      const bar = end.hidden ? null : end.getBoundingClientRect();
      return {
        over: Boolean(bar) && row.bottom > bar.top + 0.5 && row.top < bar.bottom - 0.5,
        inWindow: row.top >= -0.5 && row.bottom <= window.innerHeight + 0.5,
      };
    });
    assert.deepEqual(seen, { over: false, inWindow: true }, 'step 4 lies whole in the smaller window and the outcome is not over it');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
