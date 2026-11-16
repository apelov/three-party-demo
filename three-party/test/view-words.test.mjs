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

test('stand-ins in the lane heads, at 1280, 1440 and 1920, in Story and in Inspect: the crossing\'s head alone carries the Stand-in mark, under its title in place of a credit, with its note as the mark\'s tooltip; the record part is no stand-in', async () => {
  for (const [width, height, hash] of [[1280, 800, '#inspect'], [1440, 900, '#story'], [1440, 900, '#inspect'], [1920, 1080, '#story']]) {
    const view = await openView(browser, { width, height, hash });
    try {
      await runAndWait(view, 'clean', 'paid');
      const lanes = await view.page.evaluate(() => [...document.querySelectorAll('#lanes-head .lane')].map((lane) => ({ col: lane.dataset.col, badge: lane.querySelector('.lane-credit .badge')?.textContent ?? null, tip: lane.querySelector('.lane-credit').getAttribute('title'), credit: lane.querySelector('.lane-credit').textContent })));
      const at = `${width} ${hash}`;
      assert.deepEqual(lanes.filter((l) => l.badge).map((l) => l.col), ['crossing'], at);
      const crossing = lanes.find((l) => l.col === 'crossing');
      assert.deepEqual([crossing.badge, crossing.tip], [COPY['marker.standIn'], LABELS.parts.crossing.standInNote], at);
      const record = lanes.find((l) => l.col === 'record');
      assert.deepEqual([record.badge, record.tip, record.credit], [null, null, COPY['credit.record']], at);
      assert.equal(LABELS.parts.record.standIn, false);
    } finally {
      await view.close();
    }
  }
});

test('stand-ins in the inspector: the crossing step carries the mark in its head, and its note in full with its detail line in the artifact; the run overview\'s parts carry the note too', async () => {
  const view = await openView(browser, { width: 1280, height: 800, hash: '#inspect' });
  try {
    await runAndWait(view, 'clean', 'paid');
    await view.page.keyboard.press('3');
    await view.settle();
    const crossing = await view.page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      return { badge: host.querySelector('.insp-head .badge')?.textContent ?? null, note: host.querySelector('[data-note="stand-in"]')?.textContent ?? null, detail: host.querySelector('[data-section="artifact"] [data-note="detail"]')?.textContent ?? null };
    });
    assert.deepEqual(crossing, { badge: COPY['marker.standIn'], note: LABELS.parts.crossing.standInNote, detail: LABELS.parts.crossing.detail });
    await view.page.keyboard.press('0');
    await view.settle();
    const parts = await view.page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-key="parts"] [data-note="stand-in"]')].map((n) => n.textContent));
    assert.deepEqual(parts, [LABELS.parts.crossing.standInNote]);
    // The record step: no mark; its timestamp line carries the map's note, and
    // the run's own entry stands in the step as the run state holds it.
    await view.page.keyboard.press('6');
    await view.settle();
    const record = await view.page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      const stamp = host.querySelector('[data-note="timestamp"]');
      return { badge: host.querySelector('.insp-head .badge')?.textContent ?? null, key: stamp.closest('.kv-row').querySelector('.kv-key').textContent, note: stamp.textContent, raw: host.querySelector('.artifact[data-file="state"] .artifact-body').textContent };
    });
    assert.deepEqual({ badge: record.badge, key: record.key, note: record.note }, { badge: null, key: COPY['record.timestamp'], note: LABELS.timestamp.standInNote });
    assert.ok(record.raw.includes(`"timestampEntry": "${CLEAN_DONE.steps[5].detail.timestampEntry}"`));
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

test('the intent check is a rule: the row, the inspector and the outcome name it so, in the deck\'s words', async () => {
  const view = await openView(browser, { hash: '#inspect' });
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await view.page.keyboard.press('4');
    await view.settle();
    const seen = await view.page.evaluate(() => ({ row: document.querySelector('#rows .row[data-step="intent"]').textContent, heading: document.querySelector('#pane-inspector [data-section="checked"] .insp-section-title').textContent, rule: document.querySelector('#pane-inspector [data-section="checked"] .insp-text').textContent, outcome: document.querySelector('#outcome-end [data-outcome-part="headline"]').textContent }));
    assert.equal(seen.heading, COPY['sect.checked']);
    assert.equal(seen.rule, POISONED.steps[3].detail.rule);
    assert.equal(seen.rule, COPY['intent.rule'], 'the run\'s own sentence of the rule is the deck\'s');
    assert.ok(seen.row.includes(POISONED.steps[3].title) && /intent rule/.test(seen.row));
    assert.equal(seen.outcome, COPY['outcome.stoppedIntent']);
    // No lens line calls the check anything but a rule.
    const banned = new RegExp(j('mod', 'el|detec', 'tor|classi', 'fier|\\bA', 'I\\b|sm', 'art|intelli', 'gent'), 'i');
    for (const [key, value] of Object.entries(COPY).filter(([k]) => /^lens\./.test(k))) assert.equal(banned.test(value), false, key);
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

test('the footer: the mock bank line once, in the footer, on every state, beside the line of keys; the poisoned line once, in the run overview\'s invoice box, and the hidden text highlighted in the sequence', async () => {
  const keysLine = COPY['ui.keys'].replace('{next}', LABELS.keys.next).replace('{prev}', LABELS.keys.prev).replace('{run}', LABELS.keys.run).replace('{audit}', LABELS.keys.audit).replace('{help}', LABELS.keys.help);
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
      assert.deepEqual(seen.footer, [COPY['footer.mock'], keysLine], label);
      assert.deepEqual(seen.poisoned, withPoisoned ? [true] : [], `${label}: the poisoned line`);
    };
    await check('start', false);
    await runAndWait(view, 'clean', 'paid');
    await check('clean, finished', false);
    assert.equal(Object.hasOwn(CLEAN_DONE, 'fictionalLine'), false, 'the run carries no fictional line');
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
    await check('audit', false);
    await runAndWait(view, 'poisoned', 'blocked');
    assert.equal(Object.hasOwn(POISONED, 'fictionalLine'), false);
    await check('poisoned, stopped, step selected', false);
    const hidden = await page.evaluate(() => ({ label: document.querySelector('#invoice .hidden-label').textContent, text: document.querySelector('#invoice mark.hidden-text').textContent }));
    assert.deepEqual(hidden, { label: COPY['hidden.label'], text: POISONED.invoice.hidden.text }, 'the sequence shows the hidden text, highlighted');
    await page.keyboard.press('0');
    await check('poisoned, run overview', true);
    await page.keyboard.press('i');
    await check('poisoned, run overview, Inspect', true);
    const box = await page.evaluate(() => ({ label: document.querySelector('.hidden-box .hidden-label').textContent, text: document.querySelector('.hidden-box .hidden-text').textContent }));
    assert.deepEqual(box, { label: COPY['hidden.label'], text: POISONED.invoice.hidden.text });
  } finally {
    await view.close();
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
