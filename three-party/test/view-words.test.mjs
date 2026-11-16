// The words of the screen: stand-ins are marked, the intent check is a rule,
// the mock bank line stands once in the footer, and no file of the view
// names who built it. Patterns that name what they look for are built from
// fragments, so this file does not match itself.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runAndWait, viewFiles, grepLines, removeTempDirs, COPY, LABELS, VIEW, CLEAN_DONE, POISONED } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const j = (...parts) => parts.join('');

const lanes = (page) => page.evaluate(() => [...document.querySelectorAll('#lanes-head .lane')].map((lane) => ({
  col: lane.dataset.col,
  title: lane.querySelector('.lane-title').textContent,
  badge: lane.querySelector('.badge')?.textContent ?? null,
  legend: lane.querySelector('.lane-legend')?.textContent ?? null,
  note: lane.querySelector('.lane-note')?.textContent ?? null,
  noteUnderBadge: lane.querySelector('.lane-note') && lane.querySelector('.badge') ? lane.querySelector('.lane-note').getBoundingClientRect().top >= lane.querySelector('.badge').getBoundingClientRect().bottom - 1 : null,
  shown: [...lane.querySelectorAll('.badge, .lane-note')].every((n) => n.getBoundingClientRect().height > 0),
})));

test('stand-ins: at 1440 and at 1920 the crossing and record column headers carry the Stand-in badge with their note under it; no other column does', async () => {
  for (const [width, height] of [[1440, 900], [1920, 1080]]) {
    for (const hash of ['#story', '#inspect']) {
      const view = await openView(browser, { width, height, hash });
      try {
        const heads = await lanes(view.page);
        assert.deepEqual(heads.map((h) => h.col), LABELS.columns);
        assert.deepEqual(heads.map((h) => h.title), [LABELS.parties.agent, LABELS.parts.checkpoint.label, LABELS.parts.crossing.label, LABELS.parts.bank.label, LABELS.parts.record.label]);
        for (const head of heads) {
          const part = LABELS.parts[head.col];
          if (part?.standIn) {
            assert.equal(head.badge, COPY['marker.standIn'], `${width} ${hash} ${head.col}`);
            assert.equal(head.note, part.standInNote, `${width} ${hash} ${head.col}`);
            assert.equal(head.noteUnderBadge, true, `${width} ${hash} ${head.col}: the note stands under the badge`);
            assert.equal(head.shown, true);
          } else {
            assert.equal(head.badge, null, head.col);
            assert.equal(head.note, null, head.col);
          }
          // The legend line of each part: in the header from 1680 by 1000.
          if (width >= 1680) assert.equal(head.legend, part?.text ?? null, `${head.col}: the legend line`);
        }
      } finally {
        await view.close();
      }
    }
  }
});

test('stand-ins: at 1280 the headers keep the badge, and the note stands in the inspector of each stand-in step and in the run overview', async () => {
  const view = await openView(browser, { width: 1280, height: 800, hash: '#inspect' });
  try {
    const heads = await lanes(view.page);
    for (const head of heads) assert.equal(head.badge, LABELS.parts[head.col]?.standIn ? COPY['marker.standIn'] : null, head.col);
    await runAndWait(view, 'clean', 'paid');
    for (const [key, col] of [['3', 'crossing'], ['6', 'record']]) {
      await view.page.keyboard.press(key);
      const part = await view.page.evaluate(() => ({ badge: document.querySelector('#pane-inspector .insp-part .badge')?.textContent, note: document.querySelector('#pane-inspector .insp-part [data-note="stand-in"]')?.textContent }));
      assert.deepEqual(part, { badge: COPY['marker.standIn'], note: LABELS.parts[col].standInNote }, col);
    }
    await view.page.keyboard.press('0');
    const key = await view.page.evaluate(() => document.querySelector('#pane-inspector [data-key="parts"]').textContent);
    for (const col of ['crossing', 'record']) assert.ok(key.includes(LABELS.parts[col].standInNote), col);
    for (const col of ['checkpoint', 'crossing', 'record']) assert.ok(key.includes(LABELS.parts[col].text), `${col}: the legend line`);
  } finally {
    await view.close();
  }
});

test('stand-ins in the inspector: the crossing step carries its note and its detail line; the record step carries the timestamp note under the badge and the raw entry in the artifact pane', async () => {
  const view = await openView(browser, { hash: '#inspect' });
  try {
    await runAndWait(view, 'clean', 'paid');
    await view.page.keyboard.press('3');
    await view.settle();
    const crossing = await view.page.evaluate(() => document.querySelector('#pane-inspector .insp-part').textContent);
    assert.ok(crossing.includes(COPY['marker.standIn']));
    assert.ok(crossing.includes(LABELS.parts.crossing.standInNote));
    assert.ok(crossing.includes(LABELS.parts.crossing.detail));
    assert.ok(crossing.includes(CLEAN_DONE.steps[2].partLabel));

    await view.page.keyboard.press('6');
    await view.settle();
    const record = await view.page.evaluate(() => {
      const note = document.querySelector('#pane-inspector [data-note="timestamp"]');
      const rowOf = note.closest('.kv-row');
      return { key: rowOf.querySelector('.kv-key').textContent, badge: rowOf.querySelector('.badge').textContent, note: note.textContent, badgeBefore: Boolean(rowOf.querySelector('.badge').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING), summary: [...document.querySelectorAll('#pane-inspector .kv')].map((n) => n.textContent).join(' '), artifacts: [...document.querySelectorAll('#pane-inspector .artifact-body')].map((n) => n.textContent).join('\n') };
    });
    const raw = CLEAN_DONE.steps[5].detail.timestampEntry;
    assert.equal(record.key, COPY['record.timestamp']);
    assert.equal(record.badge, COPY['marker.standIn']);
    assert.equal(record.note, LABELS.timestamp.standInNote);
    assert.equal(record.badgeBefore, true, 'the note follows the badge');
    assert.equal(record.summary.includes(raw), false, 'the summary shows the note, not the raw entry');
    assert.ok(record.artifacts.includes(`"timestampEntry": "${raw}"`), 'the raw entry is in the artifact pane');
  } finally {
    await view.close();
  }
});

test('a record whose timestamp entry names a test authority takes the test authority note', async () => {
  const { examplesWith } = await import('./support/view-helpers.mjs');
  const state = structuredClone(CLEAN_DONE);
  state.steps[5].detail.timestampEntry = 'test timestamp authority made for this demo';
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-running.json'], add: { 'state-clean-done.json': state } }) } });
  try {
    await runAndWait(view, 'clean', 'paid');
    await view.page.keyboard.press('6');
    assert.equal(await view.page.evaluate(() => document.querySelector('#pane-inspector [data-note="timestamp"]').textContent), LABELS.timestamp.testAuthorityNote);
  } finally {
    await view.close();
  }
});

test('the intent check is a rule: the row and the inspector name it so, in the deck\'s words', async () => {
  const view = await openView(browser, { hash: '#inspect' });
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await view.page.keyboard.press('4');
    await view.settle();
    const seen = await view.page.evaluate(() => ({ row: document.querySelector('#rows .row[data-step="intent"]').textContent, heading: document.querySelector('#pane-inspector .insp-section-title').textContent, rule: document.querySelector('#pane-inspector .insp-section .insp-text').textContent, body: document.body.innerText }));
    assert.equal(seen.heading, COPY['intent.heading']);
    assert.equal(seen.rule, COPY['intent.rule']);
    assert.ok(seen.row.includes(POISONED.steps[3].title) && /intent rule/.test(seen.row));
    // Outside the bytes the run wrote, no word on the screen names the
    // check as anything but a rule.
    const outside = await view.page.evaluate(() => {
      const copy = document.body.cloneNode(true);
      for (const node of copy.querySelectorAll('.artifact-body, .hidden-box')) node.remove();
      return copy.textContent;
    });
    assert.equal(new RegExp(j('mod', 'el|detec', 'tor|classi', 'fier|\\bA', 'I\\b|sm', 'art|intelli', 'gent'), 'i').test(outside), false);
  } finally {
    await view.close();
  }
});

test('no file of the view calls the check anything but a rule', () => {
  const pattern = new RegExp(j('mod', 'el|detec', 'tor|classi', 'fier|\\bA', 'I\\b|sm', 'art|intelli', 'gent'), 'i');
  const lines = grepLines(viewFiles(['.mjs', '.json', '.html', '.css']), pattern);
  // The copy deck is a byte for byte copy, and one of its lines is the
  // contract's sentence on where the poisoned invoice comes from. That
  // sentence uses the word as a verb about the invoice. It is the one line
  // the pattern finds, and it must stay the contract's sentence.
  assert.deepEqual(lines.map((l) => l.name), ['copy.json']);
  assert.equal(lines[0].text, `  "hidden.poisoned": ${JSON.stringify(POISONED.poisonedLine)},`);
  assert.equal(COPY['hidden.poisoned'], POISONED.poisonedLine);
});

test('the footer: the mock bank line once, in the footer, on every state; the poisoned line once, in the invoice box', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    const read = () => page.evaluate(([mock, poisoned]) => {
      const all = [...document.querySelectorAll('body *')];
      const holding = (text) => all.filter((n) => n.childElementCount === 0 && n.textContent === text);
      const lines = [...document.querySelectorAll('#footer p')].map((p) => p.textContent);
      return { mock: holding(mock).map((n) => n.closest('footer') !== null), footer: lines, poisoned: holding(poisoned).map((n) => n.closest('.hidden-box') !== null && n.closest('.invoice-card') !== null), inBody: document.body.textContent.split(mock).length - 1 };
    }, [COPY['footer.mock'], POISONED.poisonedLine]);
    const check = async (label, withPoisoned) => {
      const seen = await read();
      assert.deepEqual(seen.mock, [true], `${label}: the mock bank line, once, in the footer`);
      assert.equal(seen.inBody, 1, `${label}: no second copy inside a longer text`);
      assert.deepEqual(seen.footer, [COPY['footer.mock']], label);
      assert.deepEqual(seen.poisoned, withPoisoned ? [true] : [], `${label}: the poisoned line`);
    };
    await check('start', false);
    await runAndWait(view, 'clean', 'paid');
    await check('clean, finished', false);
    assert.equal(Object.hasOwn(CLEAN_DONE, 'fictionalLine'), false, 'the run carries no fictional line');
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
    await check('offline check', false);
    await runAndWait(view, 'poisoned', 'blocked');
    assert.equal(Object.hasOwn(POISONED, 'fictionalLine'), false);
    // The invoice box with the hidden text is in the run overview at this size.
    await check('poisoned, stopped, step selected', false);
    await page.keyboard.press('0');
    await check('poisoned, run overview', true);
    await page.keyboard.press('i');
    await check('poisoned, run overview, Inspect', true);
    const box = await page.evaluate(() => ({ label: document.querySelector('.hidden-box .hidden-label').textContent, text: document.querySelector('.hidden-box .hidden-text').textContent }));
    assert.deepEqual(box, { label: COPY['hidden.label'], text: POISONED.invoice.hidden.text });
  } finally {
    await view.close();
  }

  // From 1680 by 1000, Inspect shows the full card with the hidden text in the middle pane, and the overview shows it without.
  const wide = await openView(browser, { width: 1920, height: 1080, hash: '#inspect' });
  try {
    await runAndWait(wide, 'poisoned', 'blocked');
    await wide.page.keyboard.press('0');
    const where = await wide.page.evaluate((poisoned) => [...document.querySelectorAll('.hidden-note')].filter((n) => n.textContent === poisoned).map((n) => n.closest('#invoice') !== null), POISONED.poisonedLine);
    assert.deepEqual(where, [true], 'once, in the invoice card of the middle pane');
  } finally {
    await wide.close();
  }
});

test('no file of the view names a maker, a vendor, a role or the process behind it', () => {
  const names = new RegExp(j('Cla', 'ude|Anth', 'ropic|Op', 'us|Fa', 'ble|G', 'PT|Open', 'AI|CI', 'SO|C', 'CO|C', 'DO|C', 'PO|Chi', 'ef|rul', 'ing|ta', 'sk '));
  const files = fs.readdirSync(VIEW, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(VIEW, f)).isFile()).sort();
  // The font's licence text has one tracked copy, three-party/licenses/OFL.txt,
  // which the stylesheet's header names; the view carries no second one.
  assert.ok(!files.includes('fonts/OFL.txt') && files.includes('labels.json'));
  assert.match(fs.readFileSync(path.join(VIEW, 'view.css'), 'utf8'), /three-party\/licenses\/OFL\.txt/);
  const found = [];
  for (const f of files) {
    if (f.endsWith('.woff2')) continue;
    fs.readFileSync(path.join(VIEW, f), 'utf8').split('\n').forEach((line, i) => {
      if (names.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  // No line of the view names one, the revision note of its label file
  // included (a note for maintainers that the page never shows).
  assert.deepEqual(found, []);
  assert.ok(fs.readFileSync(path.join(VIEW, 'labels.json'), 'utf8').split('\n')[1].startsWith('  "revision": '));
});

test('the words the screen can show carry no claim of quality, and the revision note is never shown', async () => {
  const claims = new RegExp(j('enter', 'prise|gra', 'de|production re', 'ady|re', 'al |li', 've '), 'i');
  const shown = [];
  const collect = (node) => {
    if (typeof node === 'string') shown.push(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === 'object') Object.values(node).forEach(collect);
  };
  collect(Object.values(COPY));
  for (const [key, value] of Object.entries(LABELS)) if (key !== 'revision') collect(value);
  assert.ok(shown.length > 150);
  assert.deepEqual(shown.filter((text) => claims.test(text)), []);

  const view = await openView(browser, { hash: '#inspect' });
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    const page = await view.page.evaluate(() => ({ text: document.documentElement.textContent, sources: [...document.querySelectorAll('[data-src]')].map((n) => n.dataset.src) }));
    assert.equal(page.text.includes(LABELS.revision), false);
    assert.equal(page.sources.some((src) => /labels:revision/.test(src)), false);
  } finally {
    await view.close();
  }
});
