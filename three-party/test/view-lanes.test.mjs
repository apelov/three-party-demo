// The lane header with labels of several words. The label of the lane
// beside the party's stays on one line and has room on its line between the
// two markers; in the standard tier a stand-in's note runs on under the lane
// to its right that shows a title alone, and meets nothing; and a label too
// long for its lane gives up its one line, so the header is never wider
// than its pane.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runAndWait, tempDir, removeTempDirs, LABELS, CONTRACT_LABELS } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The header and the rows as the page lays them out.
const layout = (page) => page.evaluate(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
  const head = document.getElementById('lanes-head');
  const lanes = Object.fromEntries([...head.querySelectorAll('.lane')].map((lane) => {
    const title = lane.querySelector('.lane-title');
    const note = lane.querySelector('.lane-note');
    const lines = [...title.getClientRects()];
    return [lane.dataset.col, {
      box: box(lane), keep: lane.dataset.keep, wish: lane.dataset.wish, note: lane.dataset.note, origin: lane.dataset.origin,
      run: lane.style.getPropertyValue('--note-run'),
      title: { lines: lines.length, right: Math.max(...lines.map((r) => r.right)), bottom: Math.max(...lines.map((r) => r.bottom)) },
      noteBox: note ? box(note) : null,
      noteLines: note ? Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)) : 0,
    }];
  }));
  const tracks = [...document.querySelectorAll('#rows .row')].map((row) => {
    const name = row.querySelector('.track-name');
    return { step: row.dataset.step, to: Number(row.querySelector('.track').dataset.to), nameWidth: name ? name.offsetWidth : 0, label: name ? box(name.firstElementChild) : null, labelWidth: name ? name.firstElementChild.offsetWidth : 0, from: box(row.querySelector('.track-from')), dot: box(row.querySelector('.track-dot')) };
  });
  return { tier: document.body.dataset.tier, room: head.style.getPropertyValue('--line-room'), head: [head.scrollWidth, head.clientWidth], headHeight: head.getBoundingClientRect().height, doc: [document.documentElement.scrollWidth, window.innerWidth], lanes, tracks };
});

const cols = LABELS.columns;
const origin = cols.findIndex((id) => !LABELS.parts[id]);
const beside = cols[origin + 1];

test('in the standard tier the note of a stand-in runs on under the lane to its right that shows a title alone: it starts under its own mark, stops short of the next lane that carries a note, and meets no title; the last stand-in\'s note stays in its lane', async () => {
  for (const hash of ['#story', '#inspect']) {
    const view = await openView(browser, { width: 1440, height: 900, hash });
    try {
      for (const state of ['start', 'finished']) {
        if (state === 'finished') await runAndWait(view, 'clean', 'paid');
        const m = await layout(view.page);
        const at = `1440x900 ${hash} ${state}`;
        assert.equal(m.tier, 'standard', at);
        const { crossing, bank, record } = m.lanes;
        // The crossing: its note runs on under the bank's lane.
        assert.equal(crossing.note, 'runs-on', at);
        assert.match(crossing.run, /^[1-9][0-9]*px$/, `${at}: the page measured a reach`);
        assert.ok(Math.abs(crossing.noteBox.left - crossing.box.left) <= 0.5, `${at}: the note starts where its lane starts`);
        assert.ok(crossing.noteBox.right > crossing.box.right, `${at}: the note reaches past its own lane (${crossing.noteBox.right} of ${crossing.box.right})`);
        assert.ok(crossing.noteBox.right <= bank.box.right - 23.5, `${at}: and stops a lane's padding and a gutter before the record's lane (${crossing.noteBox.right} of ${bank.box.right})`);
        assert.ok(crossing.noteBox.right <= record.box.left - 23.5, at);
        assert.ok(crossing.noteBox.top >= bank.title.bottom - 0.5, `${at}: the note starts under the bank's title (${crossing.noteBox.top} of ${bank.title.bottom})`);
        assert.ok(crossing.noteBox.top >= crossing.title.bottom - 0.5, at);
        // The bank's lane shows a title and nothing under it.
        assert.equal(bank.noteBox, null, at);
        // The record: no lane to its right, so its note stays in its lane.
        assert.equal(record.note, 'in-lane', at);
        assert.equal(record.run, '', at);
        assert.ok(record.noteBox.right <= record.box.right + 0.5, `${at}: the record's note stays in its lane`);
        // The reach buys lines: the longer note takes no more lines than the shorter one.
        assert.ok(crossing.noteLines >= 1 && crossing.noteLines <= record.noteLines, `${at}: ${crossing.noteLines} lines beside ${record.noteLines}`);
        // The header is as wide as its pane, and so is the page.
        assert.ok(m.head[0] <= m.head[1], `${at}: the header is as wide as its pane (${m.head})`);
        assert.ok(m.doc[0] <= m.doc[1], at);
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});

test('in the wide tier each note stays in its own lane, and in the compact tier the header carries no note', async () => {
  const wide = await openView(browser, { width: 1920, height: 1080 });
  try {
    await runAndWait(wide, 'clean', 'paid');
    const m = await layout(wide.page);
    assert.equal(m.tier, 'wide');
    for (const id of cols) {
      const lane = m.lanes[id];
      assert.equal(lane.note, 'in-lane', id);
      assert.equal(lane.run, '', id);
      if (lane.noteBox) assert.ok(lane.noteBox.right <= lane.box.right + 0.5, `${id}: the note stays in its lane`);
    }
    assert.deepEqual(cols.filter((id) => m.lanes[id].noteBox !== null), cols.filter((id) => LABELS.parts[id]?.standIn));
  } finally {
    await wide.close();
  }
  const compact = await openView(browser, { width: 1280, height: 800, hash: '#inspect' });
  try {
    await runAndWait(compact, 'clean', 'paid');
    const m = await layout(compact.page);
    assert.equal(m.tier, 'compact');
    for (const id of cols) {
      assert.equal(m.lanes[id].noteBox, null, id);
      assert.equal(m.lanes[id].run, '', id);
    }
  } finally {
    await compact.close();
  }
});

test('the label of the lane beside the party\'s: on one line in the header at 1280, 1440 and 1920, and on each row that shows it the label stands between the two markers of its line', async () => {
  for (const [width, height, hash, shown] of [[1280, 800, '#inspect', false], [1440, 900, '#story', true], [1440, 900, '#inspect', true], [1920, 1080, '#story', true]]) {
    const view = await openView(browser, { width, height, hash });
    try {
      await runAndWait(view, 'clean', 'paid');
      const m = await layout(view.page);
      const at = `${width}x${height} ${hash}`;
      assert.equal(m.lanes[beside].keep, 'yes', at);
      assert.equal(m.lanes[beside].title.lines, 1, `${at}: ${CONTRACT_LABELS.parts[beside].label} on one line`);
      assert.ok(m.lanes[beside].title.right <= m.lanes[beside].box.right + 0.5, `${at}: and inside its lane`);
      // The stand-ins keep their titles on one line too; their mark and note stand under.
      for (const id of cols.filter((c) => LABELS.parts[c]?.standIn)) assert.equal(m.lanes[id].title.lines, 1, `${at}: ${id}`);
      assert.equal(m.lanes[cols[origin]].origin, 'yes', at);
      const lines = m.tracks.filter((t) => t.to === origin + 1);
      assert.equal(lines.length, 3, `${at}: the credential, the grant and the intent rule end at the lane beside the party's`);
      if (!shown) {
        // The compact tier does not show the label on the row: no room is kept for it.
        for (const t of lines) assert.ok(t.nameWidth <= 1, `${at}: ${t.step}`);
        assert.equal(m.room, '', at);
        continue;
      }
      const widest = Math.max(...lines.map((t) => t.labelWidth));
      assert.equal(m.room, `${widest + 10}px`, `${at}: the room is the label and the two markers`);
      assert.ok(m.lanes[cols[origin]].box.right - m.lanes[cols[origin]].box.left >= widest + 10 - 0.5, `${at}: the party's lane is that wide`);
      for (const t of lines) {
        assert.ok(t.label.left >= t.from.right - 0.5, `${at}, ${t.step}: the label starts after the marker the line starts at (${t.label.left} of ${t.from.right})`);
        assert.ok(t.label.right <= t.dot.left + 0.5, `${at}, ${t.step}: and ends before the marker it ends at (${t.label.right} of ${t.dot.left})`);
      }
      // Every other row's label stands between its markers as well.
      for (const t of m.tracks.filter((x) => x.label)) {
        assert.ok(t.label.left >= t.from.right - 0.5 && t.label.right <= t.dot.left + 0.5, `${at}, ${t.step}: the label is between its markers`);
      }
    } finally {
      await view.close();
    }
  }
});

test('a label too long to stay on one line gives up the mark: the header is never wider than its pane, and the long title wraps inside its lane', async () => {
  const long = 'a label of a later revision that is far too long to stay on one line in the lane it is given';
  const cases = [
    { name: 'the crossing', change: (parts) => { parts.crossing.label = long; }, wrapped: ['crossing'] },
    { name: 'the lane beside the party\'s', change: (parts) => { parts[beside].label = long; }, wrapped: [beside] },
    { name: 'both, and the record', change: (parts) => { parts.crossing.label = long; parts[beside].label = long; parts.record.label = long; }, wrapped: ['crossing', beside, 'record'] },
  ];
  for (const c of cases) {
    const parts = structuredClone(LABELS.parts);
    c.change(parts);
    const file = path.join(tempDir('three-party-labels-'), 'labels.json');
    fs.writeFileSync(file, JSON.stringify({ ...Object.fromEntries(Object.keys(CONTRACT_LABELS).map((key) => [key, LABELS[key]])), parts }));
    for (const [width, height, hash] of [[1280, 800, '#inspect'], [1440, 900, '#story'], [1920, 1080, '#story']]) {
      const view = await openView(browser, { width, height, hash, server: { labels: file } });
      try {
        const m = await layout(view.page);
        const at = `${c.name}, ${width}x${height}`;
        assert.ok(m.head[0] <= m.head[1], `${at}: the header is as wide as its pane (${m.head})`);
        assert.ok(m.doc[0] <= m.doc[1], `${at}: the page is as wide as the window (${m.doc})`);
        for (const id of cols) assert.ok(m.lanes[id].title.right <= m.lanes[id].box.right + 0.5, `${at}: the title of ${id} stays in its lane`);
        for (const id of c.wrapped) {
          assert.equal(m.lanes[id].wish, 'one-line', `${at}: ${id} was to stay on one line`);
          assert.equal(m.lanes[id].keep, 'no', `${at}: ${id} gave up the mark`);
          assert.ok(m.lanes[id].title.lines > 1, `${at}: ${id} wraps (${m.lanes[id].title.lines} lines)`);
        }
        assert.deepEqual(view.errors, []);
      } finally {
        await view.close();
      }
    }
  }
});
