// The keyboard, from load: the walkthrough, the steps, the modes, the tabs,
// the lens, the list of keys and the run control.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runIs, rowsOf, selectedStep, COPY, LABELS, POISONED, removeTempDirs } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The element that holds the focus, named for these checks.
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  if (a.id === 'next-action') return `next:${a.dataset.next}`;
  if (a.dataset.runKind) return `start:${a.dataset.runKind}`;
  if (a.classList.contains('scene')) return `scene:${a.dataset.kind}`;
  if (a.id === 'run-control') return 'run';
  if (a.closest('#step-controls')) return a.id;
  if (a.closest('#mode-switch')) return `mode:${a.dataset.mode}`;
  if (a.id === 'lens-select') return 'lens';
  if (a.classList.contains('copy-btn') && a.closest('#run-line')) return 'copy';
  if (a.getAttribute('role') === 'tab') return `tab:${a.dataset.tab}`;
  if (a.closest('#rows')) return `row:${a.dataset.step}`;
  if (a.closest('#trace-body')) return `trace:${a.closest('[role="row"]').dataset.span}`;
  if (a.id === 'next-action') return `next:${a.dataset.next}`;
  if (a.closest('#pane-inspector')) return 'inspector';
  if (a.id === 'help-button') return 'help';
  return `${a.tagName.toLowerCase()}#${a.id}`;
});

const ring = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.activeElement);
  return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
});

test('keyboard alone, from load to the stopped step and its evidence: the first run is focused, Tab and Enter run the poisoned invoice, follow lands on step 4, Enter moves into the inspector, Escape comes back, I shows the declared intent beside each tool call with the differing field highlighted', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    assert.equal(await focused(page), 'start:clean');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'start:poisoned');
    await page.keyboard.press('Enter');
    await runIs(page, 'blocked');
    await view.settle();
    assert.equal(await selectedStep(page), 4, 'follow stands on the stopped step');
    assert.equal(await focused(page), 'row:intent', 'the focus moved to the steps');
    const row = await page.evaluate(() => {
      const r = document.querySelector('#rows .row[aria-current="step"]');
      return { outcome: r.dataset.outcome, word: r.querySelector('.chip-word').textContent, detail: r.querySelector('.row-detail').dataset.src };
    });
    assert.deepEqual(row, { outcome: 'blocked', word: COPY['state.stopped'], detail: row.detail });
    assert.match(row.detail, /^copy:detail\.intentStop;/);

    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'inspector-heading');
    await page.keyboard.press('Escape');
    assert.equal(await focused(page), 'row:intent');

    await page.keyboard.press('i');
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'inspect');
    await page.keyboard.press('4');
    await view.settle();
    const insp = await page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      const diff = host.querySelector('.diff[data-differs="yes"]');
      return {
        heading: document.getElementById('inspector-heading').textContent,
        tone: host.querySelector('.insp-head').dataset.tone,
        sections: [...host.querySelectorAll('.insp-section')].map((s) => [s.dataset.section, s.open]),
        calls: [...host.querySelectorAll('.compare-call')].map((c) => [c.dataset.tool, c.dataset.declared]),
        none: host.querySelector('.compare-none')?.dataset.src ?? null,
        field: host.querySelector('.field[data-differs="yes"]')?.dataset.field ?? null,
        differs: host.querySelector('.field[data-differs="yes"] .differs-word')?.textContent ?? null,
        diff: diff?.textContent ?? null,
        mark: diff ? getComputedStyle(diff).backgroundColor : null,
        highlight: getComputedStyle(document.documentElement).getPropertyValue('--highlight').trim(),
      };
    });
    const calls = POISONED.steps[3].detail.calls;
    assert.equal(insp.heading, COPY['sect.step'].replace('{n}', '4'), 'the inspector names the step by its number; the title stands once, in the sequence');
    assert.equal(insp.tone, 'stop');
    assert.deepEqual(insp.sections.map(([id]) => id).sort(), ['artifact', 'checked', 'record']);
    assert.ok(insp.sections.every(([, open]) => open), 'Inspect opens every section');
    assert.deepEqual(insp.calls, calls.map((c) => [c.tool, c.declaredFor === null ? 'no' : 'yes']));
    assert.match(insp.none, /^copy:intent\.undeclared;when=/);
    assert.equal(insp.field, calls[1].fieldsDiffering[0]);
    assert.equal(insp.differs, COPY['intent.differs']);
    assert.equal(insp.diff, calls[1].args[calls[1].fieldsDiffering[0]]);
    const hex = insp.highlight.replace('#', '');
    const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
    assert.equal(insp.mark, rgb, 'the differing value is highlighted');
  } finally {
    await view.close();
  }
});

test('the tab order after a run: the top bar\'s copy control, lens and mode switch, then the chosen menu item, the run control, the step controls, the selected tab, the selected row, the next action, the inspector and the list of keys; every stop shows its ring', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    // A key first, so the browser shows the focus as it does for a keyboard user.
    await page.keyboard.press('Shift');
    await page.focus('#run-line .copy-btn');
    const seen = [await focused(page)];
    for (let i = 0; i < 12; i += 1) {
      const r = await ring(page);
      assert.notEqual(r.style, 'none', `${seen[seen.length - 1]} shows a ring`);
      assert.ok(r.width >= 2, `${seen[seen.length - 1]} ring is ${r.width} px`);
      await page.keyboard.press('Tab');
      seen.push(await focused(page));
      if (seen[seen.length - 1] === 'inspector') break;
    }
    assert.deepEqual(seen, ['copy', 'lens', 'mode:story', 'mode:inspect', 'scene:clean', 'run', 'step-back', 'step-forward', 'step-replay', 'tab:sequence', 'row:record', 'next:poisoned', 'inspector']);
    // The list of steps is one stop; the menu is one stop.
    assert.equal(await page.evaluate(() => document.querySelectorAll('#rows [tabindex="0"]').length), 1);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#scenes [tabindex="0"]').length), 1);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(page), 'next:poisoned');
  } finally {
    await view.close();
  }
});

test('modes, tabs and lens by key: I opens every section and the files as written, S returns to the lens\'s first section, T shows the trace, V the next lens; the address follows and a reload keeps it', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    await page.keyboard.press('5');
    await view.settle();
    const sections = () => page.evaluate(() => [...document.querySelectorAll('#pane-inspector .insp-section')].map((s) => [s.dataset.section, s.open]));
    const order = LABELS.lenses[0].sections;
    assert.deepEqual(await sections(), order.map((id, n) => [id, n === 0]), 'Story opens the lens\'s first section');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#pane-inspector .artifact').length), 0);
    assert.deepEqual((await rowsOf(page)).map((r) => r.detail !== null), [false, false, false, false, true, false], 'one detail line, on the selected step');
    await page.keyboard.press('i');
    await view.settle();
    assert.equal(await page.evaluate(() => location.hash), '#inspect');
    assert.ok((await sections()).every(([, open]) => open));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .artifact')].map((a) => a.dataset.file)), ['state', POISONED.steps[4].actionFile === null ? 'actions/05-pay.action.json' : POISONED.steps[4].actionFile]);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'yes');
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'inspect', 'a reload keeps the mode');
    await page.keyboard.press('s');
    assert.equal(await page.evaluate(() => location.hash), '#story');
    await page.keyboard.press('t');
    assert.deepEqual(await page.evaluate(() => [location.hash, document.body.dataset.tab]), ['#story-trace', 'trace']);
    await page.keyboard.press('v');
    const lens = LABELS.lenses[1].id;
    assert.deepEqual(await page.evaluate(() => [location.hash, document.body.dataset.lens, document.getElementById('lens-select').value]), [`#story-trace-${lens}`, lens, lens]);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'yes');
    assert.deepEqual(await page.evaluate(() => [document.body.dataset.mode, document.body.dataset.tab, document.body.dataset.lens]), ['story', 'trace', lens], 'a reload keeps the mode, the tab and the lens');
  } finally {
    await view.close();
  }
});

test('step keys: arrows, Space, J and K move; Home and End; digits select; 0 shows the run; 9 on a six-step run changes nothing; moving turns follow off and End turns it on', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('3');
    assert.equal(await selectedStep(page), 0, 'before a run the step keys do nothing');
    await runAndWait(view, 'poisoned', 'blocked');
    await page.evaluate(() => document.activeElement.blur());
    const at = async (key, want) => {
      await page.keyboard.press(key);
      assert.equal(await selectedStep(page), want, key);
    };
    await at('Home', 1);
    await at('ArrowRight', 2);
    await at('j', 3);
    await at(' ', 4);
    await at('ArrowLeft', 3);
    await at('k', 2);
    await at('Shift+Space', 1);
    await at('6', 6);
    await at('9', 6);
    await at('2', 2);
    await page.keyboard.press('0');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#pane-inspector .insp').dataset.panel, document.getElementById('inspector-heading').textContent]), ['overview', LABELS.scenes.find((s) => s.kind === 'poisoned').title]);
    assert.equal(await selectedStep(page), 0);
    await at('End', 6);
    assert.match(await page.evaluate(() => document.getElementById('step-of').textContent), /6/);
  } finally {
    await view.close();
  }
});

test('follow: in Story the selection moves with the run; Left turns it off and End turns it on', async () => {
  const view = await openView(browser, { server: { replay: true, speed: 12 } });
  const { page } = view;
  try {
    await page.click('.scene[data-kind="clean"]');
    const seen = new Set();
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const n = await selectedStep(page);
      if (n) seen.add(n);
      if (await page.evaluate(() => document.querySelector('#rows .row[data-step="record"]')?.dataset.status === 'written')) break;
      await page.waitForTimeout(40);
    }
    seen.add(await selectedStep(page));
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
    assert.equal(await page.evaluate(() => document.getElementById('rows').contains(document.activeElement)), true);
  } finally {
    await view.close();
  }
  const again = await openView(browser, { server: { replay: true, speed: 6 } });
  try {
    await again.page.click('.scene[data-kind="clean"]');
    await again.page.waitForFunction(() => document.querySelector('#rows .row[data-step="grant"]')?.dataset.status === 'passed', null, { timeout: 30000 });
    await again.page.keyboard.press('ArrowLeft');
    const held = await selectedStep(again.page);
    await again.page.waitForFunction(() => document.querySelector('#rows .row[data-step="record"]')?.dataset.status === 'written', null, { timeout: 30000 });
    assert.equal(await selectedStep(again.page), held, 'with follow off the selection stays');
    await again.page.keyboard.press('End');
    assert.equal(await selectedStep(again.page), 6);
  } finally {
    await again.close();
  }
});

test('the list of keys: ? opens it over the page with every key the label map names and the deck\'s word for each, Escape closes it and gives the focus back', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await page.keyboard.press('?');
    const open = await page.evaluate(() => {
      const d = document.getElementById('keys-dialog');
      return { open: d.open, rows: [...d.querySelectorAll('.kv-row')].map((r) => [r.querySelector('kbd').dataset.src, r.querySelector('dd').dataset.src]) };
    });
    assert.equal(open.open, true);
    assert.ok(open.rows.length >= 12);
    for (const [key, word] of open.rows) {
      assert.equal(typeof LABELS.keys[key.replace('labels:keys.', '')], 'string', key);
      assert.equal(typeof COPY[word.replace('copy:', '')], 'string', word);
    }
    await page.keyboard.press('ArrowRight');
    assert.equal(await selectedStep(page), 0, 'the keys of the page wait while the list is open');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('keys-dialog').open), false);
    assert.equal(await focused(page), 'start:clean', 'the focus returns to where it was');
    await page.click('#help-button');
    assert.equal(await page.evaluate(() => document.getElementById('keys-dialog').open), true, 'the ? control opens it too');
  } finally {
    await view.close();
  }
});

test('the run control: Space on it runs the scene, and a scene the server has no run for shows the server\'s own words under it', async () => {
  const labels = structuredClone(LABELS);
  labels.scenes = labels.scenes.map((s) => (s.kind === 'tampered' ? { ...s, available: true } : s));
  const dir = (await import('./support/view-helpers.mjs')).tempDir('three-party-labels-');
  const file = `${dir}/labels.json`;
  (await import('node:fs')).writeFileSync(file, JSON.stringify(labels));
  const view = await openView(browser, { server: { labels: file } });
  const { page } = view;
  try {
    assert.equal(await page.evaluate(() => document.querySelectorAll('.scene').length), 4, 'a scene the served map marks available is listed');
    await page.click('.scene[data-kind="tampered"]');
    await page.keyboard.press('r');
    await page.waitForFunction(() => !document.getElementById('run-error').hidden);
    const shown = await page.evaluate(() => ({ text: document.getElementById('run-error').textContent, src: document.getElementById('run-error').dataset.src, run: document.body.dataset.run }));
    assert.equal(shown.text, JSON.parse(view.served.get('POST /api/runs')).error);
    assert.equal(shown.text, 'tampered is not a run kind of this build');
    assert.equal(shown.src, 'run:post#error');
    assert.equal(shown.run, 'none');

    await page.click('.scene[data-kind="clean"]');
    assert.equal(await page.evaluate(() => document.getElementById('run-error').hidden), true, 'choosing another scene clears the message');
    await page.focus('#run-control');
    await page.keyboard.press('Space');
    await runIs(page, 'paid');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
