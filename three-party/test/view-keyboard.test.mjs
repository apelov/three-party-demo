// The keyboard map, with the keyboard alone: every action here is a real key
// press through the browser, never a dispatched event.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runIs, rowsOf, selectedStep, COPY, LABELS, CLEAN_DONE, POISONED, removeTempDirs } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const focus = (page) => page.evaluate(() => {
  const node = document.activeElement;
  const style = getComputedStyle(node);
  return { id: node.id, cls: node.className, kind: node.dataset.kind ?? null, step: node.dataset.step ?? null, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
});

const ringed = (f, where) => {
  assert.notEqual(f.outlineWidth, '0px', `a focus ring ${where}`);
  assert.notEqual(f.outlineStyle, 'none', `a focus ring ${where}`);
};

test('keyboard alone, from load to the stopped step and its artifact: scene list, scene 2, R, follow to step 4, I, 4', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    // The page opens with the run control focused. The scene list is the
    // tab stop before it.
    let f = await focus(page);
    assert.equal(f.id, 'run-control');
    await page.keyboard.press('Shift+Tab');
    f = await focus(page);
    assert.equal(f.kind, 'clean', 'the scene list holds the focus, on the selected scene');
    ringed(f, 'on the scene list');

    await page.keyboard.press('ArrowDown');
    f = await focus(page);
    assert.equal(f.kind, 'poisoned');
    ringed(f, 'on scene 2');
    assert.equal(await page.evaluate(() => document.querySelector('.scene[aria-pressed="true"]').dataset.kind), 'poisoned');

    await page.keyboard.press('r');
    await runIs(page, 'blocked');
    await view.settle();
    ringed(await focus(page), 'after R');
    assert.equal(await selectedStep(page), 4, 'follow rests on the stopped step');

    const stopped = await page.evaluate(() => {
      const row = document.querySelector('#rows .row[aria-current="step"]');
      return { status: row.dataset.status, headline: row.querySelector('.outcome-head').textContent, sentence: row.querySelector('.stop-sentence').textContent, headlineAbove: row.querySelector('.outcome-head').getBoundingClientRect().bottom <= row.querySelector('.stop-sentence').getBoundingClientRect().top };
    });
    assert.equal(stopped.status, 'blocked');
    assert.equal(stopped.headline, COPY['outcome.stoppedIntent']);
    assert.equal(stopped.sentence, POISONED.reason);
    assert.equal(stopped.headlineAbove, true, 'the sentence stands under the headline');

    await page.keyboard.press('i');
    ringed(await focus(page), 'after I');
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'inspect');
    await page.keyboard.press('4');
    await view.settle();
    ringed(await focus(page), 'after 4');

    const insp = await page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      const calls = [...host.querySelectorAll('.compare-call')].map((call) => ({
        tool: call.dataset.tool,
        declared: call.dataset.declared,
        none: call.querySelector('.compare-none')?.textContent ?? null,
        why: call.querySelector('.compare-why')?.textContent ?? null,
        differing: [...call.querySelectorAll('.field[data-differs="yes"]')].map((field) => ({ field: field.dataset.field, word: field.querySelector('.differs-word').textContent })),
        underlined: [...call.querySelectorAll('.diff[data-differs="yes"]')].map((v) => ({ text: v.textContent, line: getComputedStyle(v).borderBottomWidth })),
      }));
      return { heading: host.querySelector('#inspector-heading').textContent, number: host.querySelector('#inspector-heading .row-num').textContent, tone: host.querySelector('.insp-head').dataset.tone, calls, section: host.querySelector('.insp-section-title').textContent };
    });
    const intent = POISONED.steps[3];
    assert.equal(insp.number, '4');
    assert.equal(insp.heading, `4${intent.title}`);
    assert.equal(insp.tone, 'stop', 'the heading takes the stop tokens');
    assert.equal(insp.section, COPY['intent.heading']);
    assert.equal(insp.calls.length, 2);
    const [secret, pay] = insp.calls;
    assert.equal(secret.tool, 'secrets.read');
    assert.equal(secret.declared, 'no');
    assert.equal(secret.none, COPY['intent.undeclared']);
    assert.equal(secret.why, intent.detail.calls[0].fieldsDiffering[0]);
    assert.equal(pay.tool, 'bank.payments.create');
    assert.deepEqual(pay.differing, [{ field: 'payeeAccount', word: COPY['intent.differs'] }]);
    assert.deepEqual(pay.underlined, [{ text: intent.detail.calls[1].args.payeeAccount, line: '2px' }]);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the tab order: scene list, run control, the three step controls, mode switch, the switch between the flow and the trace, then the flow rows as one stop, then the inspector', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    // A run by the keyboard, then back to the scene list with Shift+Tab, so
    // that every stop is reached by a key and shows its ring.
    await page.keyboard.press('r');
    await runIs(page, 'paid');
    await view.settle();
    for (let i = 0; i < 12 && !(await focus(page)).kind; i += 1) await page.keyboard.press('Shift+Tab');
    const seen = [];
    for (let i = 0; i < 11; i += 1) {
      const f = await focus(page);
      ringed(f, `at tab stop ${i}`);
      seen.push(f.kind ? 'scene' : f.id === 'run-control' ? 'run' : f.cls.includes('copy-btn') ? 'copy' : f.step ? 'row' : await page.evaluate(() => {
        const node = document.activeElement;
        if (node.closest('#step-controls')) return node.id;
        if (node.closest('#mode-switch')) return `mode:${node.dataset.mode}`;
        if (node.closest('#view-switch')) return `view:${node.dataset.view}`;
        return node.tagName;
      }));
      await page.keyboard.press('Tab');
    }
    // The step controls stand under the run control, and the switch between
    // the flow and the trace beside the mode switch: each is a stop of its own.
    assert.deepEqual(seen, ['scene', 'run', 'step-back', 'step-forward', 'step-replay', 'mode:story', 'mode:inspect', 'view:flow', 'view:trace', 'copy', 'row']);
    assert.equal(await page.evaluate(() => document.getElementById('pane-inspector').contains(document.activeElement)), true, 'the stop after the flow is in the inspector');
  } finally {
    await view.close();
  }
});

test('modes and keys: I opens every detail line and the artifacts, S returns to one, the hash follows and a reload keeps it', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    assert.equal(await selectedStep(page), 6, 'follow rests on the last step of a finished run');
    let rows = await rowsOf(page);
    assert.deepEqual(rows.map((r) => r.detail !== null), [false, false, false, false, false, true], 'Story opens one detail line');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#pane-inspector .artifact').length), 0, 'Story shows no artifact');

    await page.keyboard.press('i');
    await view.settle();
    assert.equal(await page.evaluate(() => location.hash), '#inspect');
    assert.equal(await page.evaluate(() => document.querySelector('#mode-switch [aria-pressed="true"]').dataset.mode), 'inspect');
    rows = await rowsOf(page);
    assert.deepEqual(rows.map((r) => r.detail !== null), [true, true, true, true, true, true], 'Inspect opens every detail line');
    await page.keyboard.press('5');
    await view.settle();
    const files = await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .artifact')].map((a) => a.dataset.file));
    assert.deepEqual(files, ['state', CLEAN_DONE.steps[4].actionFile], 'the step as the state holds it, then its action file');

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'yes');
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'inspect', 'a reload keeps the mode');

    await page.keyboard.press('s');
    assert.equal(await page.evaluate(() => location.hash), '#story');
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'story');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('step keys: arrows, Space, J and K move; Home and End; digits select; 0 shows the run; 9 on a six-step run changes nothing; moving turns follow off and End turns it on', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    // Before a run the step keys do nothing.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('3');
    assert.equal(await selectedStep(page), 0);

    await runAndWait(view, 'poisoned', 'blocked');
    assert.equal(await selectedStep(page), 4);

    const press = async (key, want, why) => {
      await page.keyboard.press(key);
      assert.equal(await selectedStep(page), want, why ?? key);
    };
    await press('Home', 1);
    await press('ArrowRight', 2);
    await press('j', 3);
    await press('Space', 4, 'Space is the next step when the focus is on a row or on the page');
    await press('ArrowLeft', 3);
    await press('k', 2);
    await press('Shift+Space', 1);
    await press('ArrowLeft', 1, 'the leading step is the end of the way back');
    await press('6', 6);
    await press('ArrowRight', 6, 'the last step is the end of the way forward');
    await press('9', 6, '9 on a six-step run changes nothing');
    await press('2', 2);

    await page.keyboard.press('0');
    assert.equal(await selectedStep(page), 0);
    const overview = await page.evaluate(() => ({ panel: document.querySelector('#pane-inspector .insp').dataset.panel, heading: document.getElementById('inspector-heading').textContent }));
    assert.equal(overview.panel, 'overview');
    assert.equal(overview.heading, LABELS.scenes.find((s) => s.kind === 'poisoned').title);

    await press('End', 6);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('follow: in Story the selection moves with the run; Left turns it off and End turns it on', async () => {
  // The finished clean run, played back on its own timeline at 12 times its pace.
  const view = await openView(browser, { server: { replay: true, speed: 12 } });
  const { page } = view;
  try {
    await page.keyboard.press('r');
    const seen = new Set();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const state = await page.evaluate(() => ({ run: document.body.dataset.run, selected: document.querySelector('#rows .row[aria-current="step"]')?.dataset.index ?? null, newest: [...document.querySelectorAll('#rows .row')].map((r) => r.dataset.status) }));
      if (state.selected !== null) {
        seen.add(Number(state.selected) + 1);
        const running = state.newest.lastIndexOf('running');
        if (running >= 0) assert.equal(Number(state.selected), running, 'the selection rests on the step being checked');
      }
      if (state.run === 'paid' && state.newest[5] === 'written') break;
      await page.waitForTimeout(40);
    }
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6], 'follow passed through every step');
    assert.equal(await selectedStep(page), 6);
    assert.equal(await page.evaluate(() => document.activeElement.closest('#rows') !== null), true, 'after R on the run control the focus is in the flow, so Space is the next step');
  } finally {
    await view.close();
  }

  const again = await openView(browser, { server: { replay: true, speed: 6 } });
  try {
    await again.page.keyboard.press('r');
    await again.page.waitForFunction(() => document.querySelector('#rows .row[data-step="grant"]').dataset.status === 'passed', null, { timeout: 15000 });
    await again.page.keyboard.press('ArrowLeft');
    const held = await selectedStep(again.page);
    await again.page.waitForFunction(() => document.querySelector('#rows .row[data-step="record"]').dataset.status === 'written', null, { timeout: 30000 });
    assert.equal(await selectedStep(again.page), held, 'with follow off the selection stays while the run goes on');
    await again.page.keyboard.press('End');
    assert.equal(await selectedStep(again.page), 6);
    await again.page.keyboard.press('i');
    await again.page.keyboard.press('s');
    assert.equal(await selectedStep(again.page), 6, 'Story follows');
  } finally {
    await again.close();
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
