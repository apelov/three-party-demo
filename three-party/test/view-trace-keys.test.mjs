// The trace by the keyboard and the mouse: the switch and its key, the keys
// of a tree grid whose rows hold the focus, the control that opens a step,
// and the way from any row to the step's real data in the inspector. Every
// action is a real key press or a real click.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, selectedStep, examplesWith, removeTempDirs, example, secondsApart, COPY, LABELS, POISONED } from './support/view-helpers.mjs';
import { filled, poisonedManifest, traceRows } from './support/trace-helpers.mjs';
import { startDemo, openScreens, startFromScreens } from './support/integration-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The element that holds the focus: where it is, and its ring.
const focus = (page) => page.evaluate(() => {
  const node = document.activeElement;
  const style = getComputedStyle(node);
  const row = node.closest('#trace-body [role="row"]');
  return {
    span: row && row === node ? row.dataset.span : null,
    flowStep: node.closest('#rows') ? node.dataset.step ?? null : null,
    id: node.id,
    view: node.closest('#view-switch') ? node.dataset.view : null,
    copy: node.classList.contains('copy-btn'),
    outlineWidth: style.outlineWidth,
    outlineStyle: style.outlineStyle,
  };
});
const ringed = (f, where) => {
  assert.notEqual(f.outlineWidth, '0px', `a focus ring ${where}`);
  assert.notEqual(f.outlineStyle, 'none', `a focus ring ${where}`);
};
const state = (page) => page.evaluate(() => ({ hash: location.hash, view: document.body.dataset.view, mode: document.body.dataset.mode, pressed: [...document.querySelectorAll('#view-switch button')].map((b) => `${b.dataset.view}:${b.getAttribute('aria-pressed')}`), flowShown: !document.getElementById('rows').hidden, traceShown: !document.getElementById('trace').hidden }));
const inspector = (page) => page.evaluate(() => {
  const host = document.getElementById('pane-inspector');
  return {
    panel: host.querySelector('.insp').dataset.panel,
    number: host.querySelector('#inspector-heading .row-num')?.textContent ?? null,
    heading: host.querySelector('#inspector-heading').textContent,
    marked: [...host.querySelectorAll('[data-highlight="yes"]')].map((n) => ({ cls: n.className, tool: n.dataset.tool ?? null, file: n.dataset.file ?? null, kind: n.dataset.kind ?? null, text: n.textContent.slice(0, 60) })),
    artifacts: [...host.querySelectorAll('.artifact')].map((a) => a.dataset.file),
  };
});
const expandedOf = async (page, span) => (await traceRows(page)).find((r) => r.span === span).expanded;

const SERVER = () => ({ examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) });

test('the switch and its key: T shows the trace and the flow in turn, the address names the view beside the mode from then on, a click on either half does the same, the three panes stay where they are and a reload keeps the trace showing', async () => {
  const view = await openView(browser, { hash: '#inspect' });
  const { page } = view;
  try {
    const sw = await page.evaluate(() => {
      const group = document.getElementById('view-switch');
      return { role: group.getAttribute('role'), name: group.getAttribute('aria-label'), buttons: [...group.children].map((b) => ({ tag: b.tagName, text: b.textContent, pressed: b.getAttribute('aria-pressed'), height: b.getBoundingClientRect().height, width: b.getBoundingClientRect().width })) };
    });
    assert.equal(sw.role, 'group');
    assert.equal(sw.name, COPY['view.switchName']);
    assert.deepEqual(sw.buttons.map((b) => [b.tag, b.text, b.pressed]), [['BUTTON', COPY['view.flow'], 'true'], ['BUTTON', COPY['view.trace'], 'false']]);
    for (const b of sw.buttons) assert.ok(b.height >= 24 && b.width >= 24, `a half of the switch is at least 24 by 24 px (${b.width} by ${b.height})`);
    assert.deepEqual(await state(page), { hash: '#inspect', view: 'flow', mode: 'inspect', pressed: ['flow:true', 'trace:false'], flowShown: true, traceShown: false }, 'an address that names no view means the flow');

    await runAndWait(view, 'poisoned', 'blocked');
    const panes = () => page.evaluate(() => ['pane-left', 'pane-flow', 'pane-inspector', 'topbar', 'footer', 'invoice', 'mode-switch', 'view-switch'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }));
    const before = await panes();

    await page.keyboard.press('t');
    assert.deepEqual(await state(page), { hash: '#inspect-trace', view: 'trace', mode: 'inspect', pressed: ['flow:false', 'trace:true'], flowShown: false, traceShown: true });
    assert.deepEqual(await panes(), before, 'the panes, the invoice and the switches do not move');
    await page.keyboard.press('t');
    assert.deepEqual(await state(page), { hash: '#inspect-flow', view: 'flow', mode: 'inspect', pressed: ['flow:true', 'trace:false'], flowShown: true, traceShown: false });
    assert.deepEqual(await panes(), before);

    // The mode keys keep the view, and the address says both.
    await page.keyboard.press('Shift+T');
    assert.equal((await state(page)).view, 'flow', 'with Shift the key is not the switch');
    await page.keyboard.press('t');
    await page.keyboard.press('s');
    assert.deepEqual([(await state(page)).hash, (await state(page)).view, (await state(page)).mode], ['#story-trace', 'trace', 'story']);
    await page.keyboard.press('i');
    assert.equal((await state(page)).hash, '#inspect-trace');

    // A click on a half of the switch.
    await page.click('#view-switch [data-view="flow"]');
    assert.deepEqual([(await state(page)).hash, (await state(page)).view], ['#inspect-flow', 'flow']);
    await page.click('#view-switch [data-view="trace"]');
    assert.deepEqual([(await state(page)).hash, (await state(page)).view], ['#inspect-trace', 'trace']);
    await page.click('#view-switch [data-view="trace"]');
    assert.equal((await state(page)).view, 'trace', 'the half that is pressed stays pressed');

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === 'yes');
    assert.deepEqual(await state(page), { hash: '#inspect-trace', view: 'trace', mode: 'inspect', pressed: ['flow:false', 'trace:true'], flowShown: false, traceShown: true }, 'a reload keeps the trace showing');

    // The address drives the page too.
    await page.evaluate(() => { location.hash = '#story-flow'; });
    await page.waitForFunction(() => document.body.dataset.view === 'flow' && document.body.dataset.mode === 'story');
    await page.evaluate(() => { location.hash = '#story-trace'; });
    await page.waitForFunction(() => document.body.dataset.view === 'trace');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the keys of the grid: Tab reaches the switch and then the trace\'s selected row; Down, Up, Home and End move the focus from row to row with its ring; Left closes an open step and Right opens it; on a row with nothing inside neither moves the focus; the digits still select', async () => {
  const view = await openView(browser, { hash: '#inspect', server: SERVER() });
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await page.keyboard.press('4');
    await view.settle();
    assert.equal((await focus(page)).flowStep, 'intent', 'the focus is on the selected row of the flow');
    await page.keyboard.press('t');
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0);
    let f = await focus(page);
    assert.equal(f.span, 'intent', 'with the focus on a step when the view changes, it moves to that step\'s row of the trace');
    ringed(f, 'on the selected row of the trace');

    // Back to the switch with Shift+Tab, then forward with Tab: the two
    // halves of the switch, the run's copy control, then the selected row.
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+Tab');
    const stops = [];
    for (let i = 0; i < 4; i += 1) {
      f = await focus(page);
      ringed(f, `at stop ${i}`);
      stops.push(f.view ? `view:${f.view}` : f.copy ? 'copy' : f.span ? `row:${f.span}` : f.id);
      if (i < 3) await page.keyboard.press('Tab');
    }
    assert.deepEqual(stops, ['view:flow', 'view:trace', 'copy', 'row:intent']);

    const rows = await traceRows(page);
    const order = rows.map((r) => r.span);
    assert.equal(order.length, 18);
    assert.deepEqual(rows.filter((r) => r.tabindex === '0').map((r) => r.span), ['intent'], 'one tab stop: the selected row');
    const at = order.indexOf('intent');
    const press = async (key, want, why) => {
      await page.keyboard.press(key);
      const now = await focus(page);
      assert.equal(now.span, want, why ?? `${key} moves the focus to ${want}`);
      ringed(now, `after ${key}`);
    };
    await press('ArrowDown', order[at + 1]);
    await press('ArrowDown', order[at + 2]);
    await press('ArrowUp', order[at + 1]);
    await press('ArrowUp', 'intent');
    await press('ArrowUp', order[at - 1]);
    await press('Home', order[0]);
    await press('ArrowUp', order[0], 'Up on the leading row stays');
    await press('End', order[order.length - 1]);
    await press('ArrowDown', order[order.length - 1], 'Down on the last row stays');
    // Moving the focus selects nothing: the selection is where it was.
    assert.equal((await traceRows(page)).filter((r) => r.selected === 'true').map((r) => r.span).join(), 'intent');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '4');

    // The digits still select while a row holds the focus, and the focus goes with the selection.
    await press('2', 'grant', 'a digit selects its step and the focus follows');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '2');
    await press('4', 'intent');

    // Left closes the open step, Right opens it.
    assert.equal(await expandedOf(page, 'intent'), 'true');
    await press('ArrowLeft', 'intent', 'Left on an open step keeps the focus on it');
    assert.equal(await expandedOf(page, 'intent'), 'false');
    assert.equal((await traceRows(page)).filter((r) => r.parent === 'intent').length, 0);
    assert.equal((await traceRows(page)).length, 15);
    await press('ArrowLeft', 'intent', 'Left on a closed step does nothing');
    assert.equal(await expandedOf(page, 'intent'), 'false');
    await press('ArrowRight', 'intent', 'Right on a closed step keeps the focus on it');
    assert.equal(await expandedOf(page, 'intent'), 'true');
    assert.equal((await traceRows(page)).filter((r) => r.parent === 'intent').length, 3);
    await press('ArrowRight', 'intent', 'Right on an open step does nothing');

    // A row with nothing inside: neither key moves the focus, opens anything or changes the selection.
    await press('ArrowDown', 'intent/declared/0');
    await press('ArrowRight', 'intent/declared/0', 'Right on a row inside a step leaves the focus where it is');
    await press('ArrowLeft', 'intent/declared/0', 'Left on a row inside a step leaves the focus where it is');
    assert.equal(await expandedOf(page, 'intent'), 'true');
    await press('3', 'crossing');
    await press('ArrowRight', 'crossing', 'a step with nothing inside');
    await press('ArrowLeft', 'crossing');
    assert.equal(await selectedStep(page), 3, 'Left and Right on a row of the trace are not the previous and the next step');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '3');

    // With the focus outside the trace the keys of the page keep their meaning.
    await page.focus('#run-control');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '4', 'Right is the next step');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '2', 'Left is the previous step');
    await page.keyboard.press('0');
    assert.equal(await page.evaluate(() => document.querySelector('#pane-inspector .insp').dataset.panel), 'overview');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('from a row to the step\'s real data: Enter on the second tool call opens step 4 in the inspector with that call marked and the step as the run holds it under it; Space on the row above marks the call before it; a click on a record row opens the record step with that file\'s row of the manifest marked; a check and the declared intent are marked the same way', async () => {
  const manifest = poisonedManifest();
  const view = await openView(browser, { hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': manifest } }) } });
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0);
    assert.equal((await inspector(page)).panel, 'overview', 'Inspect starts on the run as a whole');

    // By keys: from the leading row down to the second call.
    await page.keyboard.press('4');
    await page.focus('#trace-body [data-span="intent"]');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
    assert.equal((await focus(page)).span, 'intent/call/1');
    await page.keyboard.press('1');
    await page.focus('#trace-body [data-span="intent/call/1"]');
    await page.keyboard.press('Enter');
    await view.settle();
    let insp = await inspector(page);
    assert.equal(insp.panel, 'intent');
    assert.equal(insp.number, '4');
    assert.equal(insp.heading, `4${POISONED.steps[3].title}`);
    assert.deepEqual(insp.marked.map((m) => m.tool), [POISONED.steps[3].detail.calls[1].tool], 'the second call is the one marked');
    // The example files hold the action file of the pay step alone, so on
    // this server the intent step shows its state pane and no action file.
    // The test of a run on the engine, below, reads the action file pane.
    assert.deepEqual(insp.artifacts, ['state'], 'the step as the run state holds it is there');
    let rows = await traceRows(page);
    assert.deepEqual(rows.filter((r) => r.selected === 'true').map((r) => r.span), ['intent/call/1'], 'one row is selected: the one opened');
    assert.deepEqual(rows.filter((r) => r.tabindex === '0').map((r) => r.span), ['intent/call/1']);
    assert.equal(rows.find((r) => r.span === 'intent').current, 'yes', 'its step is the step shown');
    assert.equal((await focus(page)).span, 'intent/call/1', 'the focus stays on the row');
    assert.equal(await selectedStep(page), 4, 'the flow, when it shows again, has step 4 selected');

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await view.settle();
    insp = await inspector(page);
    assert.deepEqual(insp.marked.map((m) => m.tool), [POISONED.steps[3].detail.calls[0].tool]);
    assert.equal((await focus(page)).span, 'intent/call/0');

    // The declared intent: the comparison as a whole.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    insp = await inspector(page);
    assert.equal(insp.marked.length, 1);
    assert.equal(insp.marked[0].cls, 'compare');

    // By the mouse: a record row.
    await page.click('#trace-body [data-span="record/record/1"]');
    await view.settle();
    insp = await inspector(page);
    assert.equal(insp.panel, 'record');
    assert.equal(insp.number, '6');
    assert.deepEqual(insp.marked.map((m) => [m.file, m.kind]), [[manifest.records[1].file, 'records']], 'that file\'s row of the manifest is marked');
    assert.ok(insp.artifacts.includes(POISONED.steps[5].recordFile), 'the manifest is there as written');
    rows = await traceRows(page);
    assert.deepEqual(rows.filter((r) => r.selected === 'true').map((r) => r.span), ['record/record/1']);
    assert.equal((await focus(page)).span, 'record/record/1', 'a click puts the focus on the row');

    // A check of the grant: its name in the list of what was checked.
    await page.click('#trace-body [data-span="grant/check/2"]');
    insp = await inspector(page);
    assert.equal(insp.panel, 'grant');
    assert.deepEqual(insp.marked.map((m) => m.text), [POISONED.steps[1].detail.scopeChecked[2]]);
    await page.click('#trace-body [data-span="credential/check/0"]');
    insp = await inspector(page);
    assert.equal(insp.panel, 'credential');
    assert.deepEqual(insp.marked.map((m) => m.text), [POISONED.steps[0].detail.verifier]);

    // A step row: the step, with nothing marked. A step with no file of its own opens too.
    await page.click('#trace-body [data-span="crossing"] .trace-title');
    await view.settle();
    insp = await inspector(page);
    assert.deepEqual([insp.panel, insp.number, insp.marked.length], ['crossing', '3', 0]);
    assert.ok(insp.artifacts.includes(POISONED.steps[2].detail.hopFile), 'the hop file is there');
    await page.click('#trace-body [data-span="pay"] .trace-title');
    assert.deepEqual([(await inspector(page)).panel, (await inspector(page)).number], ['pay', '5']);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the control at a row\'s start opens and closes the rows inside the step by a click, names what it will do, and is not a tab stop; in Story a closed step opens the same way, and a click on the control selects nothing', async () => {
  const view = await openView(browser, { hash: '#story-trace', server: SERVER() });
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="record"]')?.getAttribute('aria-expanded') === 'false');
    let rows = await traceRows(page);
    const grant = rows.find((r) => r.span === 'grant');
    assert.equal(grant.expanded, 'false');
    assert.deepEqual([grant.toggle.label, grant.toggle.tabindex], [filled('trace.expand', { n: 2 }), '-1']);
    assert.ok(grant.toggle.box.width >= 24 && grant.toggle.box.height >= 24, `24 by 24 px at least (${grant.toggle.box.width} by ${grant.toggle.box.height})`);
    assert.equal(rows.find((r) => r.span === 'intent').toggle.label, filled('trace.collapse', { n: 4 }));

    await page.click('#trace-body [data-span="grant"] .trace-toggle');
    rows = await traceRows(page);
    assert.equal(rows.find((r) => r.span === 'grant').expanded, 'true');
    assert.equal(rows.find((r) => r.span === 'grant').toggle.label, filled('trace.collapse', { n: 2 }));
    assert.equal(rows.filter((r) => r.parent === 'grant').length, 4);
    assert.equal(await selectedStep(page), 4, 'opening a step selects nothing');
    assert.equal(await page.evaluate(() => document.querySelector('#inspector-heading .row-num').textContent), '4');

    await page.click('#trace-body [data-span="grant"] .trace-toggle');
    assert.equal(await expandedOf(page, 'grant'), 'false');
    await page.click('#trace-body [data-span="intent"] .trace-toggle');
    assert.equal(await expandedOf(page, 'intent'), 'false', 'the stopped step closes too');
    await page.click('#trace-body [data-span="intent"] .trace-toggle');
    assert.equal(await expandedOf(page, 'intent'), 'true');

    // By the keyboard in Story: Right opens a closed step, Left closes it.
    await page.click('#trace-body [data-span="credential"] .trace-title');
    await page.keyboard.press('ArrowRight');
    assert.equal(await expandedOf(page, 'credential'), 'true');
    assert.equal((await traceRows(page)).filter((r) => r.parent === 'credential').length, 1);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await expandedOf(page, 'credential'), 'false');

    // What a viewer opened stays open when the mode changes, and a new run starts from the mode's own rule.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('i');
    await page.keyboard.press('s');
    assert.equal(await expandedOf(page, 'credential'), 'true');
    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="record"]')?.getAttribute('aria-expanded') === 'false');
    assert.deepEqual((await traceRows(page)).filter((r) => r.level === 1).map((r) => r.expanded), ['false', 'false', null, 'true', null, 'false']);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the offline check from the trace: Enter on its row opens the check in the inspector, and Enter on a record inside it marks that record there', async () => {
  const offline = example('offline-check.json');
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="offline-check"]') !== null);
    await page.keyboard.press('1');
    assert.equal((await inspector(page)).panel, 'credential');
    await page.focus('#trace-body [data-span="offline-check"]');
    await page.keyboard.press('Enter');
    let insp = await inspector(page);
    assert.deepEqual([insp.panel, insp.marked.length], ['offline', 0]);
    await page.keyboard.press('End');
    assert.equal((await focus(page)).span, 'offline-check/tampered/0');
    await page.keyboard.press('Enter');
    insp = await inspector(page);
    assert.equal(insp.panel, 'offline');
    assert.deepEqual(insp.marked.map((m) => [m.file, m.kind]), [[offline.tampered[0].file, 'tampered']]);
    await page.click('#trace-body [data-span="offline-check/records/2"]');
    insp = await inspector(page);
    assert.deepEqual(insp.marked.map((m) => [m.file, m.kind]), [[offline.records[2].file, 'records']]);
    assert.deepEqual((await traceRows(page)).filter((r) => r.selected === 'true').map((r) => r.span), ['offline-check/records/2']);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a stopped run on the engine itself: the trace shows the run\'s own times and the four records of its manifest, and Enter on the call that decided opens step 4 with the comparison, that call marked, and the action file the run wrote', async () => {
  const demo = await startDemo();
  const view = await openScreens(browser, demo.url, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    const runId = await startFromScreens(view, 'poisoned');
    const scene = LABELS.scenes.find((sc) => sc.kind === 'poisoned');
    await page.waitForFunction((want) => document.getElementById('run-control').getAttribute('aria-label') === want, filled('menu.runAgainName', { scene: scene.title }), { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0, null, { timeout: 30000 });
    await view.settle();
    const run = (await demo.get(`/api/runs/${runId}`)).json();
    assert.equal(run.outcome, 'blocked');
    assert.equal(run.blockedAt, 'intent');
    const manifest = (await demo.get(`/api/runs/${runId}/files/records/manifest.json`)).json();

    const rows = await traceRows(page);
    const steps = rows.filter((r) => r.level === 1);
    assert.deepEqual(steps.map((r) => r.span), run.steps.map((st) => st.id));
    assert.deepEqual(steps.map((r) => r.start), run.steps.map((st) => (st.startedAt ? filled('trace.offset', { seconds: secondsApart(run.startedAt, st.startedAt) }) : '')), 'each start is the run\'s own time');
    assert.deepEqual(steps.map((r) => r.duration), run.steps.map((st) => (st.startedAt && st.endedAt ? filled('trace.duration', { seconds: secondsApart(st.startedAt, st.endedAt) }) : '')));
    assert.deepEqual(steps.map((r) => r.status), run.steps.map((st) => st.status));
    const records = rows.filter((r) => r.parent === 'record');
    assert.equal(manifest.records.length, 4);
    assert.deepEqual(records.map((r) => r.name), manifest.records.map((rec) => filled('trace.record', { file: rec.file })), 'one row per record of the run\'s manifest');
    const calls = rows.filter((r) => r.parent === 'intent' && r.kind === 'call');
    assert.deepEqual(calls.map((r) => r.name), run.steps[3].detail.calls.map((c) => filled('trace.call', { tool: c.tool })));
    assert.deepEqual(calls.map((r) => r.pill), [null, COPY['trace.decidedHere']]);

    await page.focus('#trace-body [data-span="intent/call/1"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#pane-inspector .artifact-body[data-focus-key^="body:actions/"]', { timeout: 30000 });
    await view.settle();
    const insp = await inspector(page);
    assert.deepEqual([insp.panel, insp.number], ['intent', '4']);
    assert.deepEqual(insp.marked.map((m) => m.tool), [run.steps[3].detail.calls[1].tool]);
    assert.deepEqual(insp.artifacts, ['state', run.steps[3].actionFile], 'the step as the run holds it, then the action file the run wrote');
    const action = (await demo.get(`/api/runs/${runId}/files/${run.steps[3].actionFile}`)).json();
    assert.equal(action.decision, 'blocked');
    assert.equal(await page.evaluate((file) => document.querySelector(`#pane-inspector .artifact[data-file="${file}"] .artifact-body`).textContent, run.steps[3].actionFile), JSON.stringify(action, null, 2), 'the pane holds the file as the run wrote it');
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.outside, []);
  } finally {
    await view.close();
    await demo.stop();
  }
});
