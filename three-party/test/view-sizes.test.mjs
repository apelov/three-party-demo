// Sizes and schemes: at 1280x800, 1440x900 and 1920x1080, in light and in
// dark, nothing overflows sideways, the page does not scroll, the step
// selected stays in sight under the pinned lane heads, the type keeps its
// floors and the three panes stay where they are.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runScene, runIs, examplesWith, eightStepState, removeTempDirs, COPY, LABELS, POISONED } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const POISONED_STEPS = POISONED.steps.length;

const SIZES = [
  { width: 1280, height: 800, modes: ['inspect'] },
  { width: 1440, height: 900, modes: ['story', 'inspect'] },
  { width: 1920, height: 1080, modes: ['story', 'inspect'] },
];

// What the layout looks like right now, measured in the page.
const measure = (page) => page.evaluate(() => {
  const px = (node) => parseFloat(getComputedStyle(node).fontSize);
  const box = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const pane = document.getElementById('pane-flow');
  const panel = document.getElementById('panel-sequence');
  const within = (node) => { const r = node.getBoundingClientRect(); const f = pane.getBoundingClientRect(); return r.top >= f.top - 0.5 && r.bottom <= f.bottom + 0.5; };
  const rows = [...document.querySelectorAll('#rows .row')];
  const selected = document.querySelector('#rows .row[aria-current="step"]');
  const outcome = document.getElementById('outcome-end');
  const shown = (node) => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const min = (nodes) => { const seen = nodes.filter(shown); return seen.length ? Math.min(...seen.map(px)) : null; };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() && n.parentElement.closest('.live, dialog:not([open])') === null && shown(n.parentElement)) texts.push(n.parentElement);
  return {
    size: document.body.dataset.size,
    docWidth: [document.documentElement.scrollWidth, window.innerWidth],
    docHeight: [document.documentElement.scrollHeight, window.innerHeight],
    panel: [panel.scrollHeight, panel.clientHeight],
    pane: [pane.scrollHeight, pane.clientHeight],
    paneWidth: [pane.scrollWidth, pane.clientWidth],
    panes: ['pane-left', 'pane-flow', 'pane-inspector', 'topbar', 'footer'].map((id) => box(document.getElementById(id))),
    rows: rows.length,
    rowsInPane: rows.every(within),
    outcomeInPane: outcome.hidden || within(outcome),
    scrolls: panel.scrollHeight > panel.clientHeight + 1,
    // The lane heads pinned at the top of the sequence, the box of what you
    // told the agent above the tabs, and the step selected whole between the
    // lane heads and the bottom of the sequence.
    lanesInSight: (() => { const head = document.getElementById('lanes-head'); if (!shown(head)) return true; const r = head.getBoundingClientRect(); const p = panel.getBoundingClientRect(); return r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5; })(),
    taskInSight: (() => { const told = document.getElementById('invoice'); if (told.hidden) return true; const r = told.getBoundingClientRect(); return r.top >= 0 && r.bottom <= document.getElementById('tabs').getBoundingClientRect().top + 0.5; })(),
    selectedInSight: (() => { if (!selected) return true; const r = selected.getBoundingClientRect(); const head = document.getElementById('lanes-head').getBoundingClientRect(); const p = panel.getBoundingClientRect(); return r.top >= head.bottom - 0.5 && r.bottom <= p.bottom + 0.5; })(),
    floors: {
      titles: min([...document.querySelectorAll('#rows .row-title')]),
      words: min([...document.querySelectorAll('#rows .chip-word')]),
      selectedTitle: selected ? px(selected.querySelector('.row-title')) : null,
      stamp: document.querySelector('#rows .row[data-status="blocked"] .chip') ? px(document.querySelector('#rows .row[data-status="blocked"] .chip')) : null,
      labels: min([...document.querySelectorAll('.lane-title, .lane-credit, .row-detail, .footer p, .invoice-strip, .insp-note, .kv-key:not(.mono), .scene-text')]),
      values: min([...document.querySelectorAll('.row-title, .outcome-text, .insp-text, .insp-lens, .scene-title, .run-control, .tab')]),
      mono: min([...document.querySelectorAll('#rows .mono, .insp-text .mono, .kv-value .mono, .invoice .mono')]),
      smallest: min(texts),
      inspectorHeading: px(document.getElementById('inspector-heading')),
    },
  };
});

// Each row carries the sentence of the reader chosen in View as, and the box
// of what you told the agent stands above the tabs (owner feedback,
// 2026-11-16), so the sequence may scroll under its pinned lane heads. The
// page and the middle pane never scroll, the lane heads and the box stay in
// sight, and the step selected lies whole between the lane heads and the
// bottom of the sequence.
function assertFits(m, label) {
  assert.ok(m.docWidth[0] <= m.docWidth[1], `${label}: the document is as wide as the window (${m.docWidth})`);
  assert.ok(m.docHeight[0] <= m.docHeight[1], `${label}: the document is as high as the window (${m.docHeight})`);
  assert.ok(m.pane[0] <= m.pane[1], `${label}: the middle pane does not scroll (${m.pane})`);
  assert.ok(m.paneWidth[0] <= m.paneWidth[1], `${label}: nothing in the middle pane is wider than it (${m.paneWidth})`);
  if (!m.scrolls) assert.equal(m.rowsInPane, true, `${label}: every row is inside the middle pane`);
  assert.equal(m.lanesInSight, true, `${label}: the lane heads are in sight`);
  assert.equal(m.taskInSight, true, `${label}: the box of what you told the agent is in sight above the tabs`);
  assert.equal(m.selectedInSight, true, `${label}: the step selected lies whole under the lane heads (${m.panel})`);
  assert.equal(m.outcomeInPane, true, `${label}: the outcome line is inside the middle pane`);
}

// One type scale: Inspect sets labels at 13 px, values at 15 and the
// inspector's heading at 18; Story moves each up one step, to 15, 18 and 20.
// A stopped step is stamped at 24 px in Inspect and 30 in Story; a value in
// the monospace face is 0.88 of the size around it. A selected step is set
// apart by weight, not by a larger size.
function assertFloors(m, mode, label) {
  const f = m.floors;
  const story = mode === 'story' && m.size === 'story';
  const [labelPx, valuePx, headPx, stampPx] = story ? [15, 18, 20, 30] : [13, 15, 18, 24];
  assert.ok(f.smallest >= 12, `${label}: no text under 12 px (${f.smallest})`);
  if (f.labels !== null) assert.ok(f.labels >= labelPx, `${label}: labels at least ${labelPx} px (${f.labels})`);
  if (f.values !== null) assert.ok(f.values >= valuePx, `${label}: values at least ${valuePx} px (${f.values})`);
  if (f.titles !== null) assert.ok(f.titles >= valuePx, `${label}: step titles at least ${valuePx} px (${f.titles})`);
  if (f.words !== null) assert.ok(f.words >= labelPx, `${label}: state words at least ${labelPx} px (${f.words})`);
  if (f.selectedTitle !== null) assert.equal(f.selectedTitle, f.titles, `${label}: the selected title at the size of the others`);
  if (f.stamp !== null) assert.equal(f.stamp, stampPx, `${label}: the stop stamped at ${stampPx} px`);
  if (f.mono !== null) assert.ok(f.mono >= Math.max(12, Math.floor(labelPx * 0.88)), `${label}: monospace values at least ${Math.max(12, Math.floor(labelPx * 0.88))} px (${f.mono})`);
  assert.equal(f.inspectorHeading, headPx, `${label}: the inspector heading at ${headPx} px`);
}

for (const { width, height, modes } of SIZES) {
  for (const mode of modes) {
    for (const scheme of ['light', 'dark']) {
      const name = `${width}x${height} ${mode} ${scheme}`;
      test(`${name}: start, a clean run finished and a poisoned run stopped fit with the step selected in sight, hold the type floors and leave the panes in place`, async (t) => {
        const view = await openView(browser, { width, height, scheme, hash: `#${mode}` });
        try {
          const start = await measure(view.page);
          assert.equal(start.size, mode === 'story' && width >= 1440 ? 'story' : 'inspect', 'the Story sizes apply from 1440 px wide');
          assertFits(start, `${name}, start`);
          assertFloors(start, mode, `${name}, start`);

          await runAndWait(view, 'clean', 'paid');
          const done = await measure(view.page);
          assertFits(done, `${name}, clean finished`);
          assertFloors(done, mode, `${name}, clean finished`);
          assert.deepEqual(done.panes, start.panes, `${name}: the panes, the top bar and the footer do not move between the start and the finished run`);

          await runAndWait(view, 'poisoned', 'blocked');
          const stopped = await measure(view.page);
          assertFits(stopped, `${name}, poisoned stopped`);
          assertFloors(stopped, mode, `${name}, poisoned stopped`);
          assert.deepEqual(stopped.panes, start.panes);
          assert.equal(stopped.rows, 6);
          assert.equal(stopped.outcomeInPane, true, `${name}: the outcome line of the stop is in the pane`);
          t.diagnostic(`sizes: ${name} | sequence ${stopped.panel[0]} of ${stopped.panel[1]} px when stopped, ${done.panel[0]} of ${done.panel[1]} when paid`);

          // The presenter walks the steps of the stopped run: each selection still fits.
          for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
            await view.page.keyboard.press(key);
            await view.settle(60);
            const walked = await measure(view.page);
            assertFits(walked, `${name}, poisoned stopped, key ${key}`);
            assert.equal(walked.outcomeInPane, true, `${name}, key ${key}: the outcome line stays in the pane`);
            assert.deepEqual(walked.panes, start.panes);
          }
        } finally {
          await view.close();
        }
      });

      test(`${name}: a run in progress fits and holds the floors`, async () => {
        const view = await openView(browser, { width, height, scheme, hash: `#${mode}`, server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
        try {
          await runScene(view.page, 'clean');
          await runIs(view.page, 'running');
          await view.settle();
          const running = await measure(view.page);
          assertFits(running, `${name}, in progress`);
          assertFloors(running, mode, `${name}, in progress`);
        } finally {
          await view.close();
        }
      });
    }
  }
}

test('1440x900 Inspect with eight steps (grant-again after grant, pay-again after pay): the step selected stays in sight and the floors hold', async (t) => {
  const state = eightStepState();
  assert.deepEqual(state.steps.map((s) => s.id), ['credential', 'grant', 'grant-again', 'crossing', 'intent', 'pay', 'pay-again', 'record']);
  for (const scheme of ['light', 'dark']) {
    const view = await openView(browser, { width: 1440, height: 900, scheme, hash: '#inspect', server: { examples: examplesWith({ omit: ['state-clean-running.json'], add: { 'state-clean-done.json': state } }) } });
    try {
      await runAndWait(view, 'clean', 'paid');
      const m = await measure(view.page);
      assert.equal(m.rows, 8);
      assertFits(m, `eight steps, ${scheme}`);
      assertFloors(m, 'inspect', `eight steps, ${scheme}`);
      t.diagnostic(`sizes: 1440x900 inspect ${scheme}, eight steps | sequence ${m.panel[0]} of ${m.panel[1]} px`);
      const titles = await view.page.evaluate(() => [...document.querySelectorAll('#rows .row-title')].map((n) => n.textContent));
      assert.equal(titles[2], COPY['step.grantAgain']);
      assert.equal(titles[6], COPY['step.payAgain']);
      // The one detail line stands on the selected step: grant-again and
      // pay-again take the grant's and the payment's lines of the copy deck.
      const detailOf = async (key) => { await view.page.keyboard.press(key); return view.page.evaluate(() => document.querySelector('#rows .row[aria-current="step"] .row-detail')?.textContent ?? null); };
      assert.equal(await detailOf('3'), await detailOf('2'), 'grant-again takes the grant line of the copy deck');
      assert.equal(await detailOf('7'), await detailOf('6'), 'pay-again takes the pay line of the copy deck');
      for (const key of ['1', '3', '5', '8', '0']) {
        await view.page.keyboard.press(key);
        await view.settle(60);
        assertFits(await measure(view.page), `eight steps, ${scheme}, key ${key}`);
      }
      // In Story the eight rows fit as well.
      await view.page.keyboard.press('s');
      await view.page.keyboard.press('End');
      await view.settle(60);
      assertFits(await measure(view.page), `eight steps, ${scheme}, Story`);
    } finally {
      await view.close();
    }
  }
});

// The sequence as the page lays it out: where each lane starts (its
// lifeline), and where each step's arrow starts and ends.
const lanesOf = (page) => page.evaluate(() => {
  const lanes = [...document.querySelectorAll('#lanes-head .lane')].map((lane) => {
    const line = lane.querySelector('.lane-line');
    const title = lane.querySelector('.lane-title');
    const box = line.getBoundingClientRect();
    return { col: lane.dataset.col, left: box.left, right: box.right, lines: title ? title.getClientRects().length : 0, titleRight: title ? title.getBoundingClientRect().right : null };
  });
  const arrows = [...document.querySelectorAll('#rows .row')].map((row) => {
    const arrow = row.querySelector('.arrow').getBoundingClientRect();
    const life = [...row.querySelectorAll('.lifeline')].map((l) => l.getBoundingClientRect().left);
    return { step: row.dataset.step, col: row.dataset.col, start: arrow.left, end: arrow.right, life };
  });
  return { lanes, arrows };
});

test('the sequence: at 1280x800, 1440x900 and 1920x1080 each lane\'s title stays on one line inside its lane; each row\'s lifelines stand where the lanes start; each arrow starts on the lifeline of the party that acts and ends on the lifeline of the part that checks', async () => {
  const from = (step) => (LABELS.stepFrom?.[step] ? LABELS.columns.indexOf(LABELS.stepFrom[step]) : 0);
  for (const [width, height, hash] of [[1280, 800, '#inspect'], [1440, 900, '#story'], [1440, 900, '#inspect'], [1920, 1080, '#story']]) {
    const view = await openView(browser, { width, height, hash });
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      const m = await lanesOf(view.page);
      const where = `${width}x${height} ${hash}`;
      assert.deepEqual(m.lanes.map((l) => l.col), LABELS.columns);
      for (const lane of m.lanes) {
        assert.equal(lane.lines, 1, `${where}: ${lane.col}'s title on one line`);
        assert.ok(lane.titleRight <= lane.right + 0.5, `${where}: ${lane.col}'s title stays in its lane`);
      }
      for (const a of m.arrows) {
        a.life.forEach((x, i) => assert.ok(Math.abs(x - m.lanes[i].left) <= 1, `${where}: ${a.step}'s lifeline ${i} stands where ${m.lanes[i].col} starts`));
        const to = LABELS.columns.indexOf(a.col);
        assert.ok(Math.abs(a.start - m.lanes[from(a.step)].left) <= 1, `${where}: ${a.step}'s arrow starts on ${LABELS.columns[from(a.step)]}`);
        assert.ok(Math.abs(a.end - m.lanes[to].left) <= 1, `${where}: ${a.step}'s arrow ends on ${a.col}`);
      }
      assert.equal(m.arrows.length, POISONED_STEPS);
    } finally {
      await view.close();
    }
  }
});

test('under 1024 px wide the three panes stack in order and nothing overflows sideways', async () => {
  for (const [width, height] of [[1000, 800], [768, 1024], [390, 844]]) {
    const view = await openView(browser, { width, height });
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      const m = await view.page.evaluate(() => {
        const top = (id) => document.getElementById(id).getBoundingClientRect().top;
        // What reaches sideways, cut to every box that scrolls or clips
        // around it: a piece wider than a phone scrolls inside its own box.
        const shownRight = (n) => {
          let right = n.getBoundingClientRect().right;
          for (let up = n.parentElement; up; up = up.parentElement) {
            const st = getComputedStyle(up);
            if (/(auto|scroll|hidden|clip)/.test(st.overflowX)) right = Math.min(right, up.getBoundingClientRect().right);
          }
          return right;
        };
        return { stacked: document.body.dataset.stacked, doc: [document.documentElement.scrollWidth, window.innerWidth], order: [top('pane-left'), top('pane-flow'), top('pane-inspector'), top('footer')], widest: Math.max(...[...document.querySelectorAll('body *')].filter((n) => n.closest('.live, .sprite, dialog:not([open])') === null).map(shownRight)) };
      });
      assert.equal(m.stacked, 'yes');
      assert.ok(m.doc[0] <= m.doc[1], `${width}: no sideways scroll (${m.doc})`);
      assert.ok(m.widest <= width + 0.5, `${width}: nothing reaches past the window (${m.widest})`);
      assert.deepEqual([...m.order].sort((a, b) => a - b), m.order, `${width}: left, middle, right, footer`);
    } finally {
      await view.close();
    }
  }
});
