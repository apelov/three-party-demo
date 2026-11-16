// Sizes and schemes: at 1280x800, 1440x900 and 1920x1080, in light and in
// dark, nothing overflows sideways, the flow does not scroll, the type keeps
// its floors and the three panes stay where they are.

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
  const inView = (node) => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth && r.height > 0; };
  const flow = document.getElementById('flow');
  const pane = document.getElementById('pane-flow');
  const within = (node) => { const r = node.getBoundingClientRect(); const f = pane.getBoundingClientRect(); return r.top >= f.top - 0.5 && r.bottom <= f.bottom + 0.5; };
  const rows = [...document.querySelectorAll('#rows .row')];
  const selected = document.querySelector('#rows .row[aria-current="step"]');
  const sentence = document.querySelector('.stop-sentence');
  const min = (nodes) => (nodes.length ? Math.min(...nodes.map(px)) : null);
  const metaMono = '.kv-key, .field, .meta, .left-foot, .artifact-path, .limits, .insp-note';
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() && n.parentElement.closest('.live') === null) texts.push(n.parentElement);
  return {
    size: document.body.dataset.size,
    tier: document.body.dataset.tier,
    docWidth: [document.documentElement.scrollWidth, window.innerWidth],
    docHeight: [document.documentElement.scrollHeight, window.innerHeight],
    flow: [flow.scrollHeight, flow.clientHeight],
    pane: [pane.scrollHeight, pane.clientHeight],
    paneWidth: [pane.scrollWidth, pane.clientWidth],
    slack: Math.round(document.querySelector('.flow-space').getBoundingClientRect().height),
    panes: ['pane-left', 'pane-flow', 'pane-inspector', 'topbar', 'footer'].map((id) => box(document.getElementById(id))),
    rows: rows.length,
    rowsInView: rows.every(inView),
    rowsInPane: rows.every(within),
    sentenceInView: sentence ? inView(sentence) && within(sentence) : null,
    floors: {
      titles: min([...document.querySelectorAll('#rows .row-title')]),
      others: min(rows.filter((r) => r !== selected).map((r) => r.querySelector('.row-title'))),
      words: min([...document.querySelectorAll('#rows .chip-word')]),
      selectedTitle: selected ? px(selected.querySelector('.row-title')) : null,
      selectedWord: selected ? px(selected.querySelector('.chip-word')) : null,
      sentence: sentence ? px(sentence) : null,
      headline: document.querySelector('.outcome-head') ? px(document.querySelector('.outcome-head')) : null,
      body: min([...document.querySelectorAll('.row-detail, .footer p, .invoice-strip > *, .outcome-text, .insp-text, .scene-title, .run-control')]),
      mono: min([...document.querySelectorAll('.mono')].filter((n) => !n.closest(metaMono))),
      smallest: min(texts),
      inspectorHeading: px(document.getElementById('inspector-heading')),
    },
  };
});

function assertFits(m, label) {
  assert.ok(m.docWidth[0] <= m.docWidth[1], `${label}: the document is as wide as the window (${m.docWidth})`);
  assert.ok(m.docHeight[0] <= m.docHeight[1], `${label}: the document is as high as the window (${m.docHeight})`);
  assert.ok(m.flow[0] <= m.flow[1], `${label}: the flow does not scroll (${m.flow})`);
  assert.ok(m.pane[0] <= m.pane[1], `${label}: the middle pane does not scroll (${m.pane})`);
  assert.ok(m.paneWidth[0] <= m.paneWidth[1], `${label}: nothing in the middle pane is wider than it (${m.paneWidth})`);
  assert.equal(m.rowsInPane, true, `${label}: every row is inside the middle pane`);
}

function assertFloors(m, mode, label) {
  const f = m.floors;
  assert.ok(f.smallest >= 13, `${label}: no text under 13 px (${f.smallest})`);
  assert.ok(f.titles >= 22, `${label}: step titles at least 22 px (${f.titles})`);
  assert.ok(f.words >= 18, `${label}: state words at least 18 px (${f.words})`);
  assert.ok(f.body >= 16, `${label}: body text at least 16 px (${f.body})`);
  if (f.mono !== null) assert.ok(f.mono >= 15, `${label}: monospace values at least 15 px (${f.mono})`);
  if (mode === 'story' && m.size === 'story') {
    if (f.selectedTitle !== null) {
      assert.ok(f.selectedTitle >= 32, `${label}: the selected title at least 32 px (${f.selectedTitle})`);
      assert.ok(f.selectedWord >= 24, `${label}: its state word at least 24 px (${f.selectedWord})`);
      assert.ok(f.others >= 22, `${label}: every other step at least 22 px (${f.others})`);
    }
    if (f.sentence !== null) assert.ok(f.sentence >= 24, `${label}: the stopped sentence at least 24 px (${f.sentence})`);
    if (f.headline !== null) assert.ok(f.headline >= 32, `${label}: the stopped headline at least 32 px (${f.headline})`);
    assert.ok(f.inspectorHeading >= 32, `${label}: the inspector heading at least 32 px (${f.inspectorHeading})`);
  } else {
    if (f.sentence !== null) assert.ok(f.sentence >= 18, `${label}: the stopped sentence at least 18 px (${f.sentence})`);
  }
}

for (const { width, height, modes } of SIZES) {
  for (const mode of modes) {
    for (const scheme of ['light', 'dark']) {
      const name = `${width}x${height} ${mode} ${scheme}`;
      test(`${name}: start, a clean run finished and a poisoned run stopped fit without a scroll, hold the type floors and leave the panes in place`, async (t) => {
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
          assert.equal(stopped.sentenceInView, true, `${name}: the stopped sentence is in view`);
          assert.equal(stopped.rowsInView, true, `${name}: every numbered row is in view`);
          t.diagnostic(`sizes: ${name} | tier ${stopped.tier} | flow needs ${start.flow[1] - start.slack} of ${start.flow[1]} at start, ${done.flow[1] - done.slack} finished, ${stopped.flow[1] - stopped.slack} stopped | spare ${start.slack} ${done.slack} ${stopped.slack} px`);

          // The presenter walks the steps of the stopped run: each selection still fits.
          for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
            await view.page.keyboard.press(key);
            await view.settle(60);
            const walked = await measure(view.page);
            assertFits(walked, `${name}, poisoned stopped, key ${key}`);
            assert.equal(walked.sentenceInView, true, `${name}, key ${key}: the stopped sentence stays in view`);
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

test('1440x900 Inspect with eight steps (grant-again after grant, pay-again after pay): the flow does not scroll and the floors hold', async (t) => {
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
      assert.equal(m.rowsInView, true);
      t.diagnostic(`sizes: 1440x900 inspect ${scheme}, eight steps | flow needs ${m.flow[1] - m.slack} of ${m.flow[1]} | spare ${m.slack} px`);
      const titles = await view.page.evaluate(() => [...document.querySelectorAll('#rows .row-title')].map((n) => n.textContent));
      assert.equal(titles[2], COPY['step.grantAgain']);
      assert.equal(titles[6], COPY['step.payAgain']);
      const details = await view.page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((r) => r.querySelector('.row-detail')?.textContent ?? null));
      assert.equal(details[2], details[1], 'grant-again takes the grant line of the copy deck');
      assert.equal(details[6], details[5], 'pay-again takes the pay line of the copy deck');
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

// The lane header as the page lays it out: each lane's box, the lines its
// title takes, what stands under the title, and where each step's line starts
// and ends.
const lanesOf = (page) => page.evaluate(() => {
  const mid = (node) => { const r = node.getBoundingClientRect(); return r.left + r.width / 2; };
  const lanes = [...document.querySelectorAll('#lanes-head .lane')].map((lane) => {
    const title = lane.querySelector('.lane-title');
    const box = lane.getBoundingClientRect();
    const lines = [...title.getClientRects()];
    return { col: lane.dataset.col, line: lane.dataset.line, lines: lines.length, left: box.left, right: box.right, titleRight: Math.max(...lines.map((r) => r.right)), under: lane.querySelectorAll('.badge, .lane-legend, .lane-note').length };
  });
  const tracks = [...document.querySelectorAll('#rows .row')].map((row) => {
    const track = row.querySelector('.track');
    const dot = track.querySelector('.track-dot');
    const start = track.querySelector('.track-from');
    return { step: row.dataset.step, to: Number(track.dataset.to), dot: dot ? mid(dot) : null, start: start ? mid(start) : null };
  });
  return { lanes, tracks, tier: document.body.dataset.tier };
});

test('the lane header: at 1280x800 and 1440x900 the party every line starts from keeps its title on one line beside a lane that shows a title alone; no title leaves its lane and every marker stands at the start of its own lane; at 1920x1080 and in the stacked layout the header keeps its form', async () => {
  const origin = LABELS.columns.findIndex((id) => !LABELS.parts[id]);
  const at = async (width, height, hash) => {
    const view = await openView(browser, { width, height, hash });
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      const m = await lanesOf(view.page);
      const where = `${width}x${height} ${hash}`;
      assert.deepEqual(m.lanes.map((l) => l.col), LABELS.columns, where);
      m.lanes.forEach((lane, i) => {
        assert.ok(lane.titleRight <= lane.right + 0.5, `${where}: the title of ${lane.col} stays in its lane (${lane.titleRight} of ${lane.right})`);
        if (i > 0) assert.ok(m.lanes[i - 1].right <= lane.left + 0.5, `${where}: ${lane.col} starts where the lane before it ends`);
      });
      for (const track of m.tracks) {
        if (track.dot === null) continue;
        const lane = m.lanes[track.to];
        assert.ok(track.dot >= lane.left - 0.5 && track.dot <= lane.left + 12, `${where}: the marker of ${track.step} stands at the start of ${lane.col} (${track.dot} from ${lane.left})`);
        assert.ok(track.start >= m.lanes[origin].left - 0.5 && track.start <= m.lanes[origin].left + 12, `${where}: the line of ${track.step} starts at ${m.lanes[origin].col}`);
      }
      assert.equal(m.tracks.filter((t) => t.dot !== null).length, POISONED_STEPS, `${where}: every step has its marker`);
      return m;
    } finally {
      await view.close();
    }
  };
  for (const [width, height, hash] of [[1280, 800, '#inspect'], [1440, 900, '#story'], [1440, 900, '#inspect']]) {
    const m = await at(width, height, hash);
    const where = `${width}x${height} ${hash}`;
    assert.equal(m.lanes[origin].line, 'one', where);
    assert.equal(m.lanes[origin].lines, 1, `${where}: ${m.lanes[origin].col} on one line`);
    assert.equal(m.lanes[origin + 1].under, 0, `${where}: the lane beside it shows a title alone`);
    assert.equal(m.lanes[origin + 1].lines, 1, `${where}: ${m.lanes[origin + 1].col} on one line`);
    assert.deepEqual(m.lanes.filter((l) => l.line === 'one').map((l) => l.col), [m.lanes[origin].col], `${where}: no other lane is marked`);
  }
  // The wide tier sets the legend under the title of the lane beside it, and
  // the stacked layout is narrower than the measured widths: the header keeps
  // the form it has there.
  const wide = await at(1920, 1080, '#story');
  assert.equal(wide.tier, 'wide');
  assert.ok(wide.lanes[origin + 1].under > 0, 'at 1920 the lane beside it shows its legend');
  assert.deepEqual(wide.lanes.map((l) => l.line), LABELS.columns.map(() => 'any'), '1920: no lane is marked');
  const stacked = await at(1000, 800, '#inspect');
  assert.deepEqual(stacked.lanes.map((l) => l.line), LABELS.columns.map(() => 'any'), '1000: no lane is marked');
});

test('under 1024 px wide the three panes stack in order and nothing overflows sideways', async () => {
  for (const [width, height] of [[1000, 800], [768, 1024], [390, 844]]) {
    const view = await openView(browser, { width, height });
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      const m = await view.page.evaluate(() => {
        const top = (id) => document.getElementById(id).getBoundingClientRect().top;
        return { stacked: document.body.dataset.stacked, doc: [document.documentElement.scrollWidth, window.innerWidth], order: [top('pane-left'), top('pane-flow'), top('pane-inspector'), top('footer')], widest: Math.max(...[...document.querySelectorAll('body *')].filter((n) => n.closest('.live, .sprite') === null).map((n) => n.getBoundingClientRect().right)) };
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
