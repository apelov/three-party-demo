// The step controls under the run control: Back, Forward and Replay. With
// the scene list and the run control they make the left pane a menu a viewer
// drives without knowing a key: pick a scene, run it, step back and forward,
// replay a finished run step by step, run it again. Every press here is a
// real click or a real key.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, rowsOf, selectedStep, removeTempDirs, COPY, LABELS, CLEAN_DONE, POISONED } from './support/view-helpers.mjs';
import { filled, traceRows } from './support/trace-helpers.mjs';
import { startDemo, openScreens, startFromScreens, shownRunId } from './support/integration-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const NAMES = ['back', 'forward', 'replay'];
const WORDS = (state) => state.steps.map((s) => COPY[LABELS.states[s.status].wordKey]);
const PENDING = COPY['state.pending'];

const controls = (page) => page.evaluate(() => {
  const group = document.getElementById('step-controls');
  const run = document.getElementById('run-control');
  const pane = document.getElementById('pane-left');
  const style = getComputedStyle(pane);
  return {
    role: group.getAttribute('role'),
    name: group.getAttribute('aria-label'),
    underRun: group.getBoundingClientRect().top >= run.getBoundingClientRect().bottom,
    run: { disabled: run.disabled, ariaDisabled: run.getAttribute('aria-disabled'), label: run.getAttribute('aria-label'), text: run.textContent },
    paneContent: pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    pane: [pane.scrollHeight, pane.clientHeight],
    buttons: [...group.children].map((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return { id: b.id, tag: b.tagName, type: b.type, text: b.textContent, label: b.getAttribute('aria-label'), title: b.getAttribute('title'), disabled: b.disabled, left: r.left, top: r.top, width: r.width, height: r.height, color: s.color, background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, radius: s.borderTopLeftRadius, inPane: r.left >= pane.getBoundingClientRect().left && r.right <= pane.getBoundingClientRect().right };
    }),
  };
});

const banner = (page) => page.evaluate(() => {
  const end = document.getElementById('outcome-end');
  const pane = document.getElementById('pane-flow').getBoundingClientRect();
  const flow = document.getElementById('flow');
  const box = end.getBoundingClientRect();
  return { hidden: end.hidden, text: end.hidden ? null : end.textContent, part: end.querySelector('[data-outcome-part]')?.dataset.outcomePart ?? null, inPane: end.hidden || (box.top >= pane.top && box.bottom <= pane.bottom + 0.5 && box.height > 0), flow: [flow.scrollHeight, flow.clientHeight], replay: flow.dataset.replay };
});

const inspector = (page) => page.evaluate(() => ({ panel: document.querySelector('#pane-inspector .insp').dataset.panel, number: document.querySelector('#inspector-heading .row-num')?.textContent ?? null }));
const live = (page) => page.evaluate(() => document.getElementById('live').textContent);
const token = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const hex = (rgb) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(rgb);
  return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb;
};

test('with no run the three step controls are not available and the run control is; each is a button under the run control with its word, its name and the key that does the same; with a run Back and Forward are available, and Replay once the outcome is decided', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    const start = await controls(page);
    assert.equal(start.role, 'group');
    assert.equal(start.name, COPY['menu.controlsName']);
    assert.equal(start.underRun, true);
    assert.deepEqual(start.buttons.map((b) => b.id), NAMES.map((n) => `step-${n}`), 'left to right in the document: Back, Forward, Replay');
    assert.deepEqual(start.buttons.map((b) => [b.tag, b.type]), Array(3).fill(['BUTTON', 'button']));
    assert.deepEqual(start.buttons.map((b) => b.text), NAMES.map((n) => COPY[`menu.${n}`]));
    assert.deepEqual(start.buttons.map((b) => b.label), NAMES.map((n) => COPY[`menu.${n}Name`]));
    assert.deepEqual(start.buttons.map((b) => b.title), NAMES.map((n) => LABELS.keys[n]));
    assert.deepEqual(start.buttons.map((b) => b.disabled), [true, true, true]);
    assert.deepEqual([start.run.disabled, start.run.ariaDisabled], [false, 'false'], 'the run control is available');
    assert.equal(start.run.label, filled('button.runName', { scene: LABELS.scenes[0].title }));

    // The secondary style: the text colour on the neutral tile, a 1 px
    // border, the one corner radius; a control that is not available takes
    // the second text colour.
    const colour = Object.fromEntries(await Promise.all(['--fg', '--fg-2', '--tile-neutral', '--border'].map(async (n) => [n, await token(page, n)])));
    for (const b of start.buttons) {
      assert.equal(hex(b.color), colour['--fg-2'], `${b.id}: not available`);
      assert.equal(hex(b.background), colour['--tile-neutral']);
      assert.equal(b.border.replace(/rgb.*/, (c) => hex(c)), `1px solid ${colour['--border']}`);
      assert.equal(b.radius, '6px');
    }

    await runAndWait(view, 'poisoned', 'blocked');
    const after = await controls(page);
    assert.deepEqual(after.buttons.map((b) => b.disabled), [false, false, false]);
    for (const b of after.buttons) assert.equal(hex(b.color), colour['--fg'], `${b.id}: available`);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

for (const [width, height, mode] of [[1280, 800, 'inspect'], [1440, 900, 'story'], [1920, 1080, 'story']]) {
  test(`${width}x${height}: the three step controls stand in one row, each at least 36 px high, inside the left pane, and the left pane does not scroll before a run or after one`, async (t) => {
    const view = await openView(browser, { width, height, hash: `#${mode}` });
    const { page } = view;
    try {
      const check = (m, what) => {
        assert.equal(new Set(m.buttons.map((b) => Math.round(b.top))).size, 1, `${what}: one row`);
        assert.ok(m.buttons[0].left < m.buttons[1].left && m.buttons[1].left < m.buttons[2].left, `${what}: left to right`);
        for (const b of m.buttons) {
          assert.ok(b.height >= 36, `${what}: ${b.id} is at least 36 px high (${b.height})`);
          assert.ok(b.width >= 48, `${what}: ${b.id} is at least 48 px wide (${b.width})`);
          assert.equal(b.inPane, true, `${what}: ${b.id} is inside the left pane`);
        }
        assert.ok(m.pane[0] <= m.pane[1], `${what}: the left pane does not scroll (${m.pane})`);
      };
      const start = await controls(page);
      check(start, 'start');
      // Three controls of 88 px with two gaps of 8 px need 280 px. The left
      // pane has less than that for its content at every one of these
      // windows, so a row of three cannot hold controls 88 px wide: each
      // takes the width its word needs and a share of what is left.
      assert.ok(start.paneContent < 3 * 88 + 2 * 8, `the left pane holds ${start.paneContent} px of content`);
      t.diagnostic(`step controls: ${width}x${height} | pane content ${start.paneContent} px | ${start.buttons.map((b) => `${b.text} ${Math.round(b.width)} by ${Math.round(b.height)}`).join(', ')}`);
      for (const [kind, outcome] of [['poisoned', 'blocked'], ['clean', 'paid']]) {
        await runAndWait(view, kind, outcome);
        check(await controls(page), kind);
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('Back and Forward move the selection as the Left and Right keys do, and the inspector follows; Back turns follow off; Forward on the last step turns it on, and the selection then moves with the run', async () => {
  const view = await openView(browser);
  const { page } = view;
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    assert.equal(await selectedStep(page), 4, 'follow rests on the stopped step');
    const click = async (name, want) => {
      await page.click(`#step-${name}`);
      assert.equal(await selectedStep(page), want, `${name} selects step ${want}`);
      assert.deepEqual(await inspector(page), { panel: POISONED.steps[want - 1].id, number: String(want) });
    };
    await click('back', 3);
    await click('back', 2);
    await click('forward', 3);
    // The keys give the same steps from the same place.
    await page.keyboard.press('ArrowLeft');
    assert.equal(await selectedStep(page), 2);
    await page.keyboard.press('ArrowRight');
    assert.equal(await selectedStep(page), 3);
    await click('forward', 4);
    await click('forward', 5);
    await click('forward', 6);
    await click('forward', 6);
    await page.keyboard.press('1');
    await click('back', 1);
    // From the run as a whole, Forward is the leading step and Back the last.
    await page.keyboard.press('0');
    await click('forward', 1);
    await page.keyboard.press('0');
    await click('back', 6);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }

  // A run in progress: the finished clean run played back at 6 times its pace.
  const running = await openView(browser, { server: { replay: true, speed: 6 } });
  try {
    const { page } = running;
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#rows .row[data-step="credential"]').dataset.status === 'passed', null, { timeout: 15000 });
    await page.click('#step-back');
    const held = await selectedStep(page);
    await page.waitForFunction(() => document.querySelector('#rows .row[data-step="crossing"]').dataset.status === 'passed', null, { timeout: 30000 });
    assert.equal(await selectedStep(page), held, 'after Back the selection stays while the run goes on');
    await page.keyboard.press('6');
    assert.equal(await selectedStep(page), 6);
    await page.click('#step-forward');
    // Follow is on: at the next change of state the selection is the step the run is at.
    await page.waitForFunction(() => {
      const row = document.querySelector('#rows .row[aria-current="step"]');
      return row && ['running', 'passed'].includes(row.dataset.status) && Number(row.dataset.index) < 5;
    }, null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#rows .row[data-step="record"]').dataset.status === 'written', null, { timeout: 60000 });
    assert.equal(await selectedStep(page), 6, 'and it ends on the last step with the run');
  } finally {
    await running.close();
  }
});

test('Replay walks a finished run step by step: the P key or a click stands it at step 0 with every row pending, each Forward shows one more step as it ended and says it, the stopped step arrives with its headline and the run\'s sentence, and after the last step the banner reads that the replay is over and the run shows as recorded', async () => {
  const view = await openView(browser);
  const { page } = view;
  // Every request that starts a run, counted as the page makes it.
  let started = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/runs') started += 1;
  });
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    const recorded = WORDS(POISONED);
    assert.deepEqual((await rowsOf(page)).map((r) => r.word), recorded);
    assert.equal(started, 1);
    assert.deepEqual(await banner(page).then((b) => [b.hidden, b.replay]), [true, 'no'], 'a stopped run has no banner at the pane\'s foot');

    await page.click('#step-replay');
    assert.equal(await selectedStep(page), 0);
    assert.equal((await inspector(page)).panel, 'overview');
    let b = await banner(page);
    assert.equal(b.text, filled('menu.replaying', { runId: POISONED.runId, n: 0 }));
    assert.deepEqual([b.hidden, b.part, b.inPane, b.replay], [false, 'replay', true, 'stopped']);
    let rows = await rowsOf(page);
    assert.deepEqual(rows.map((r) => r.word), Array(6).fill(PENDING), 'no step is shown yet');
    assert.deepEqual(rows.map((r) => r.detail), Array(6).fill(null));
    assert.equal(await page.evaluate(() => document.querySelector('#rows .outcome-head, #rows .stop-sentence, #rows .countdown')), null, 'no headline, no sentence, no countdown');
    assert.equal(await page.evaluate(() => document.body.dataset.run), 'blocked', 'the run itself is as it was: nothing runs again');

    for (let n = 1; n <= 5; n += 1) {
      await page.click('#step-forward');
      b = await banner(page);
      assert.equal(b.text, filled('menu.replaying', { runId: POISONED.runId, n }), `the banner stands at step ${n}`);
      assert.ok(b.flow[0] <= b.flow[1] && b.inPane, `step ${n}: the flow does not scroll and the banner is inside the pane (${b.flow})`);
      rows = await rowsOf(page);
      assert.deepEqual(rows.map((r) => r.word), [...recorded.slice(0, n), ...Array(6 - n).fill(PENDING)], `steps 1 to ${n} as they ended, the rows after them pending`);
      assert.equal(await selectedStep(page), n);
      assert.deepEqual(await inspector(page), { panel: POISONED.steps[n - 1].id, number: String(n) }, 'the inspector shows the step\'s own data');
      const said = await live(page);
      assert.ok(said.startsWith(`${n} ${recorded[n - 1]}`), `the step is said: ${said}`);
      if (n === 4) {
        assert.ok(said.includes(POISONED.reason), 'the stopped step is said with the run\'s sentence');
        const stopped = await page.evaluate(() => ({ headline: document.querySelector('#rows .outcome-head').textContent, sentence: document.querySelector('#rows .stop-sentence').textContent }));
        assert.deepEqual(stopped, { headline: COPY['outcome.stoppedIntent'], sentence: POISONED.reason });
      }
    }

    await page.click('#step-forward');
    b = await banner(page);
    assert.equal(b.text, COPY['menu.replayDone']);
    assert.ok(b.flow[0] <= b.flow[1] && b.inPane, `after the last step the flow does not scroll (${b.flow})`);
    assert.deepEqual((await rowsOf(page)).map((r) => r.word), recorded, 'the recorded states are back');
    assert.equal(await selectedStep(page), 6);
    assert.ok((await live(page)).endsWith(COPY['menu.replayDone']));

    // The next move leaves the replay behind: the banner goes, as a stopped run has none.
    await page.click('#step-back');
    assert.deepEqual(await banner(page).then((x) => [x.hidden, x.replay]), [true, 'no']);
    assert.equal(await selectedStep(page), 5);

    // The P key starts it; Back moves back; a digit stands it at that step; 0 ends it.
    await page.keyboard.press('p');
    assert.equal((await banner(page)).text, filled('menu.replaying', { runId: POISONED.runId, n: 0 }));
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
    assert.equal((await banner(page)).text, filled('menu.replaying', { runId: POISONED.runId, n: 3 }), 'the Right key is Forward');
    await page.click('#step-back');
    assert.equal((await banner(page)).text, filled('menu.replaying', { runId: POISONED.runId, n: 2 }));
    assert.deepEqual((await rowsOf(page)).map((r) => r.word), [...recorded.slice(0, 2), ...Array(4).fill(PENDING)]);
    await page.keyboard.press('5');
    assert.equal((await banner(page)).text, filled('menu.replaying', { runId: POISONED.runId, n: 5 }));
    for (let i = 0; i < 8; i += 1) await page.click('#step-back');
    assert.equal((await banner(page)).text, filled('menu.replaying', { runId: POISONED.runId, n: 0 }), 'Back stops at step 0');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('0');
    assert.deepEqual(await banner(page).then((x) => [x.hidden, x.replay]), [true, 'no'], 'key 0 ends the replay');
    assert.deepEqual((await rowsOf(page)).map((r) => r.word), recorded);
    assert.equal(await selectedStep(page), 0);
    assert.equal(started, 1, 'two replays started no run');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a replay on the trace: the rows after the step it stands at read pending with no start, no time taken, no bar and nothing inside; the finished clean run keeps its banner, which reads the replay and then Paid again', async () => {
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    const recorded = WORDS(CLEAN_DONE);
    const before = await banner(page);
    assert.equal(before.part, 'headline');
    await page.keyboard.press('p');
    for (let n = 0; n <= 5; n += 1) {
      if (n > 0) await page.click('#step-forward');
      const rows = await traceRows(page);
      const steps = rows.filter((r) => r.level === 1);
      assert.deepEqual(steps.map((r) => r.word), [...recorded.slice(0, n), ...Array(6 - n).fill(PENDING)], `as of step ${n}`);
      for (const row of steps.slice(n)) {
        assert.deepEqual([row.start, row.duration, row.bar, row.expanded], ['', '', null, null], `${row.span} is not shown yet`);
        assert.equal(rows.filter((r) => r.parent === row.span).length, 0);
      }
      for (const row of steps.slice(0, n)) assert.ok(row.start !== '' && row.bar !== null, `${row.span} shows its time`);
      assert.equal((await banner(page)).text, filled('menu.replaying', { runId: CLEAN_DONE.runId, n }));
      assert.equal(steps.filter((r) => r.selected === 'true').map((r) => r.number).join(), n === 0 ? '' : String(n));
    }
    await page.click('#step-forward');
    assert.equal((await banner(page)).text, COPY['menu.replayDone']);
    assert.deepEqual((await traceRows(page)).filter((r) => r.level === 1).map((r) => r.word), recorded);
    await page.keyboard.press('0');
    const end = await banner(page);
    assert.deepEqual([end.part, end.text, end.replay], [before.part, before.text, 'no'], 'the banner reads the outcome again');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

for (const [width, height, mode] of [[1280, 800, 'inspect'], [1440, 900, 'inspect'], [1920, 1080, 'story']]) {
  test(`${width}x${height} ${mode}: through a replay of the stopped run, and when it is over, the flow does not scroll and the replay's line stays inside the pane`, async () => {
    const view = await openView(browser, { width, height, hash: `#${mode}` });
    const { page } = view;
    try {
      await runAndWait(view, 'poisoned', 'blocked');
      await page.keyboard.press('p');
      for (let n = 0; n <= 6; n += 1) {
        if (n > 0) await page.click('#step-forward');
        await view.settle(60);
        const b = await banner(page);
        assert.equal(b.hidden, false);
        assert.ok(b.flow[0] <= b.flow[1], `step ${n}: the flow does not scroll (${b.flow})`);
        assert.equal(b.inPane, true, `step ${n}: the line is inside the pane`);
        const doc = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollHeight, innerHeight]);
        assert.ok(doc[0] <= doc[1] && doc[2] <= doc[3], `step ${n}: the page does not scroll (${doc})`);
      }
    } finally {
      await view.close();
    }
  });
}

test('the run control runs the scene again once its run has ended: its name says so before the press, its word stays the scene\'s, and the press starts a run with an id of its own and follows it', async () => {
  const demo = await startDemo();
  const view = await openScreens(browser, demo.url, { hash: '#inspect' });
  const { page } = view;
  try {
    const scene = LABELS.scenes.find((s) => s.kind === 'clean');
    const name = () => page.evaluate(() => document.getElementById('run-control').getAttribute('aria-label'));
    assert.equal(await name(), filled('button.runName', { scene: scene.title }));
    const earlier = await startFromScreens(view, 'clean');
    await page.waitForFunction((want) => document.getElementById('run-control').getAttribute('aria-label') === want, filled('menu.runAgainName', { scene: scene.title }), { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.getElementById('run-control').textContent), scene.button, 'the visible word stays the scene\'s button');
    assert.equal(await page.evaluate(() => document.body.dataset.run), 'paid');

    // Another scene chosen: the control would run that scene, not this run again.
    await page.click('.scene[data-kind="poisoned"]');
    assert.equal(await name(), filled('button.runName', { scene: LABELS.scenes.find((s) => s.kind === 'poisoned').title }));
    await page.click('.scene[data-kind="clean"]');
    assert.equal(await name(), filled('menu.runAgainName', { scene: scene.title }));

    // Run ids are stamped to the second: the next run starts in a later one.
    await page.waitForTimeout(1100);
    await page.keyboard.press('2');
    await page.click('#run-control');
    await page.waitForFunction((before) => {
      const id = document.querySelector('#run-line .run-id .mono')?.textContent ?? null;
      return id !== null && id !== before;
    }, earlier, { timeout: 30000 });
    const second = await shownRunId(page);
    assert.notEqual(second, earlier);
    assert.match(second, /^clean-\d{8}T\d{6}Z$/);
    await page.waitForFunction((want) => document.getElementById('run-control').getAttribute('aria-label') === want, filled('menu.runAgainName', { scene: scene.title }), { timeout: 30000 });
    // Follow is on for the run started again, in Inspect too: the selection rests on its last step.
    assert.equal(await selectedStep(page), 6);
    // The listener holds two runs: each finished, each with its own start.
    const [one, two] = [earlier, second].map((id) => demo.get(`/api/runs/${id}`));
    const states = [(await one).json(), (await two).json()];
    assert.deepEqual(states.map((st) => st.runId), [earlier, second]);
    assert.ok(states.every((st) => st.finishedAt !== null && st.outcome === 'paid'));
    assert.ok(Date.parse(states[1].startedAt) > Date.parse(states[0].startedAt));
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.outside, []);
  } finally {
    await view.close();
    await demo.stop();
  }
});
