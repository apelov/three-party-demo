// The lane heads of the sequence: one per column of the label map, in its
// order, each with its title, the line under it (who builds the part, or
// the Stand-in mark, whose note is the mark's tooltip), at 1280, 1440 and
// 1920 px; and a label too long for its lane wraps inside the lane, so the
// header is never wider than its pane and no title leaves its lane.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runAndWait, tempDir, removeTempDirs, COPY, LABELS, CONTRACT_LABELS } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const SIZES = [[1280, 800, '#inspect'], [1440, 900, '#story'], [1440, 900, '#inspect'], [1920, 1080, '#story']];

const layout = (page) => page.evaluate(() => {
  const head = document.getElementById('lanes-head');
  const lanes = Object.fromEntries([...head.querySelectorAll('.lane')].map((lane) => {
    const line = lane.querySelector('.lane-line');
    const credit = lane.querySelector('.lane-credit');
    const title = lane.querySelector('.lane-title');
    const box = line.getBoundingClientRect();
    return [lane.dataset.col, {
      box: { left: box.left, right: box.right },
      // The title is a box of its own in the head's grid: its lines are its
      // height over its line height.
      title: title ? { text: title.textContent, src: title.dataset.src, lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)), right: title.getBoundingClientRect().right } : null,
      credit: credit.textContent,
      badge: credit.querySelector('.badge')?.textContent ?? null,
      tip: credit.getAttribute('title'),
      creditBelow: credit.getBoundingClientRect().top >= box.bottom - 0.5,
    }];
  }));
  return { order: [...head.querySelectorAll('.lane')].map((l) => l.dataset.col), lanes, head: [head.scrollWidth, head.clientWidth], doc: [document.documentElement.scrollWidth, window.innerWidth] };
});

test('one lane head per column, in the map\'s order: the part\'s label or the party\'s role on one line, and under it the credit or, for a stand-in, the mark with its note as the tooltip', async () => {
  for (const [width, height, hash] of SIZES) {
    const view = await openView(browser, { width, height, hash });
    try {
      await runAndWait(view, 'clean', 'paid');
      const m = await layout(view.page);
      const at = `${width}x${height} ${hash}`;
      assert.deepEqual(m.order, LABELS.columns, at);
      for (const col of LABELS.columns) {
        const lane = m.lanes[col];
        const part = CONTRACT_LABELS.parts[col];
        assert.equal(lane.title.text, part ? part.label : CONTRACT_LABELS.parties[col], `${at}: ${col}`);
        assert.equal(lane.title.src, part ? `labels:parts.${col}.label` : `labels:parties.${col}`, `${at}: ${col}'s source`);
        assert.equal(lane.title.lines, 1, `${at}: ${col}'s title on one line`);
        assert.ok(lane.title.right <= lane.box.right + 0.5, `${at}: ${col}'s title stays in its lane`);
        assert.equal(lane.creditBelow, true, `${at}: ${col}'s second line stands under its title`);
        if (part?.standIn) {
          assert.deepEqual([lane.badge, lane.tip], [COPY['marker.standIn'], part.standInNote], `${at}: ${col} is marked, with its note`);
        } else {
          assert.deepEqual([lane.badge, lane.tip, lane.credit], [null, null, COPY[`credit.${col}`]], `${at}: ${col} is credited`);
        }
      }
      assert.ok(m.head[0] <= m.head[1], `${at}: the header is as wide as its pane (${m.head})`);
    } finally {
      await view.close();
    }
  }
});

test('a label too long to stay on one line wraps inside its lane: the header is never wider than its pane and no title leaves its lane', async () => {
  const long = 'a label of a later revision that is far too long to stay on one line in the lane it is given';
  const cases = [
    { name: 'the crossing', change: (parts) => { parts.crossing.label = long; }, wrapped: ['crossing'] },
    { name: 'the checkpoint', change: (parts) => { parts.checkpoint.label = long; }, wrapped: ['checkpoint'] },
    { name: 'three parts', change: (parts) => { parts.crossing.label = long; parts.checkpoint.label = long; parts.record.label = long; }, wrapped: ['crossing', 'checkpoint', 'record'] },
  ];
  for (const c of cases) {
    const parts = structuredClone(LABELS.parts);
    c.change(parts);
    const file = path.join(tempDir('three-party-labels-'), 'labels.json');
    fs.writeFileSync(file, JSON.stringify({ ...Object.fromEntries(Object.keys(CONTRACT_LABELS).map((key) => [key, LABELS[key]])), parts }));
    for (const [width, height, hash] of [[1280, 800, '#inspect'], [1440, 900, '#story'], [1920, 1080, '#story']]) {
      const view = await openView(browser, { width, height, hash, server: { labels: file } });
      try {
        await runAndWait(view, 'clean', 'paid');
        const m = await layout(view.page);
        const at = `${c.name}, ${width}x${height}`;
        assert.ok(m.head[0] <= m.head[1], `${at}: the header is as wide as its pane (${m.head})`);
        assert.ok(m.doc[0] <= m.doc[1], `${at}: the page is as wide as the window (${m.doc})`);
        for (const id of LABELS.columns) assert.ok(m.lanes[id].title.right <= m.lanes[id].box.right + 0.5, `${at}: the title of ${id} stays in its lane`);
        for (const id of c.wrapped) assert.ok(m.lanes[id].title.lines > 1, `${at}: ${id} wraps (${m.lanes[id].title.lines} lines)`);
        assert.deepEqual(view.errors, []);
      } finally {
        await view.close();
      }
    }
  }
});
