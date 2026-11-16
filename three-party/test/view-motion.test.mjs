// Motion. Exactly four things move, all CSS transitions:
//   M1  a step's change of state: background-color, color, border-color and
//       fill, 200 ms ease-out, on the row and its chip and icon;
//   M2  the grant countdown bar: its width, linear, one second per tick;
//   M3  the stopped tile and the differs underline, which take M1's
//       transition and have no motion of their own;
//   M4  the bars of the trace: their start and their width, 200 ms ease-out,
//       on the bar of the step being checked as its time goes on, and on
//       every bar once when the lane takes the run's own length.
// There is no @keyframes, nothing runs for ever, nothing moves on load, the
// change between the flow and the trace and the opening of a row move
// nothing, and under prefers-reduced-motion every duration is 0 s.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runScene, runIs, examplesWith, viewFiles, removeTempDirs, LABELS, CLEAN_DONE, CLEAN_RUNNING } from './support/view-helpers.mjs';
import { filled, traceRows } from './support/trace-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const j = (...parts) => parts.join('');
const M1 = ['color', 'background-color', 'border-color'];
const M4 = ['width', 'inset-inline-start'];

function motionRules(css) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls = Object.fromEntries(m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
    const moving = Object.keys(decls).filter((k) => /^(transition|animation)/.test(k));
    if (moving.length) rules.push({ selector, decls: Object.fromEntries(moving.map((k) => [k, decls[k]])) });
  }
  return { plain, rules };
}

test('the census of the stylesheet: a change of state (M1), the request travelling once along its arrow (M3), the countdown bar (M2) and the trace bars (M4) are the transitions it declares; no keyframes, nothing infinite, no opacity, and one transform, the stamp\'s still tilt', (t) => {
  const sheets = viewFiles(['.css']);
  assert.deepEqual(sheets.map((s) => s.name), ['view.css']);
  const { plain, rules } = motionRules(sheets[0].text);

  assert.equal((plain.match(/@keyframes/g) ?? []).length, 0, 'no @keyframes');
  assert.equal(/infinite/.test(plain), false, 'nothing runs for ever');
  assert.equal(/\btransition\s*:/.test(plain), false, 'no transition shorthand, so no property is moved by default');
  assert.equal(/\banimation(-name)?\s*:/.test(plain), false, 'no animation');
  assert.equal(new RegExp(j('\\b(trans', 'form|trans', 'late|sca', 'le|opa', 'city)\\s*:')).test(plain), false, 'the stylesheet sets none of the properties that slide, grow or fade');
  // One still tilt, on the stamp: the stopped step's state and a payment's outcome.
  const tilts = [...plain.matchAll(/([^{}]+)\{[^{}]*\brot(?:ate)\s*:\s*([^;]+);/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2].trim()]);
  assert.deepEqual(tilts, [['.row[data-status="blocked"] .chip, .outcome[data-outcome="paid"] .outcome-chip', '-1.5deg']]);

  t.diagnostic('motion census: selector | property | duration | timing');
  for (const rule of rules) t.diagnostic(`motion census: ${rule.selector} | ${rule.decls['transition-property'] ?? ''} | ${rule.decls['transition-duration'] ?? rule.decls['animation-duration'] ?? ''} | ${rule.decls['transition-timing-function'] ?? ''}`);

  const listed = (r) => (r.decls['transition-property'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const byProps = (props) => rules.filter((r) => listed(r).join() === props.join());
  const m1 = byProps(M1);
  const m3 = [...byProps(['clip-path']), ...byProps(['inset-inline-start'])];
  const m2 = byProps(['width']);
  const m4 = byProps(M4);
  const travelling = rules.filter((r) => r.selector === '.row[data-travel="yes"] .arrow-pulse');
  const reduced = rules.filter((r) => !r.decls['transition-property'] && !travelling.includes(r));

  assert.equal(m1.length, 1, 'one rule for a change of state');
  assert.equal(m1[0].selector, '.chip, .chip .icon, .arrow, .rec-mark, .verdict', 'on the state, its icon, its arrow, its record mark and a verdict; a selection, which sets a step\'s title and number apart, moves nothing');
  assert.equal(m1[0].decls['transition-duration'], 'var(--m1)');
  assert.match(plain, /--m1:\s*200ms;/);
  assert.equal(m1[0].decls['transition-timing-function'], 'ease-out');

  assert.deepEqual(m3.map((r) => r.selector), ['.arrow-line', '.arrow-pulse'], 'the request drawn along its arrow, and its marker');
  for (const r of m3) assert.equal(r.decls['transition-timing-function'], 'ease-out');
  assert.equal(m3[0].decls['transition-duration'], 'var(--m3)');
  // The marker moves only on its way out, while its step's travel lasts; it
  // comes back unseen at once.
  assert.equal(m3[1].decls['transition-duration'], '0s');
  assert.deepEqual(travelling.map((r) => r.decls), [{ 'transition-duration': 'var(--m3)' }]);
  assert.match(plain, /--m3:\s*600ms;/);

  assert.equal(m2.length, 1, 'one rule for the countdown bar');
  assert.equal(m2[0].selector, '.countdown-fill');
  assert.equal(m2[0].decls['transition-duration'], '1s');
  assert.equal(m2[0].decls['transition-timing-function'], 'linear');

  assert.equal(m4.length, 1, 'one rule for the bars of the trace');
  assert.equal(m4[0].selector, '.trace-bar');
  assert.equal(m4[0].decls['transition-duration'], 'var(--m1)');

  assert.equal(reduced.length, 1, 'and the reduced motion rule');
  assert.deepEqual(reduced[0].decls, { 'transition-duration': '0s !important', 'animation-duration': '0s !important' });
  assert.match(plain, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{/);
  assert.match(plain, /prefers-reduced-motion: reduce\) \{[^@]*\.row:not\(\[data-status="blocked"\]\) \.arrow-pulse \{ display: none; \}/, 'with reduced motion the travelling marker is not drawn');
  assert.equal(rules.length, 7);
});

test('with motion allowed a state\'s colours pass through 0.2 s, and a request\'s arrow is drawn in 0.6 s', async () => {
  const view = await openView(browser, { motion: 'no-preference' });
  try {
    await runAndWait(view, 'clean', 'paid');
    const seen = await view.page.evaluate(() => {
      const chip = getComputedStyle(document.querySelector('#rows .row-state .chip'));
      const line = getComputedStyle(document.querySelector('#rows .arrow-line'));
      return { chip: [chip.transitionDuration, chip.transitionProperty], line: [line.transitionDuration, line.transitionProperty] };
    });
    assert.deepEqual(seen.chip, ['0.2s', 'color, background-color, border-color']);
    assert.deepEqual(seen.line, ['0.6s', 'clip-path']);
  } finally {
    await view.close();
  }
});

test('nothing moves on load: two seconds after the page opens, with no run, no animation is running', async () => {
  const view = await openView(browser, { motion: 'no-preference' });
  try {
    const counts = [];
    for (let i = 0; i < 8; i += 1) {
      counts.push(await view.page.evaluate(() => document.getAnimations().length));
      await view.page.waitForTimeout(250);
    }
    assert.deepEqual(counts, Array(8).fill(0));
  } finally {
    await view.close();
  }
});

// Watch every animation the document runs, from inside the page.
const watch = (page) => page.evaluate((allowed) => {
  const changed = new Map();
  new MutationObserver((records) => {
    for (const r of records) changed.set(r.target, performance.now());
  }).observe(document.getElementById('rows'), { subtree: true, attributes: true, attributeFilter: ['data-status'] });
  window.motionLog = { samples: 0, properties: new Set(), faults: [], most: 0 };
  setInterval(() => {
    const log = window.motionLog;
    log.samples += 1;
    const rows = new Set();
    for (const a of document.getAnimations()) {
      const target = a.effect?.target;
      const property = a.transitionProperty;
      if (!(a instanceof CSSTransition)) { log.faults.push(`not a transition: ${a.constructor.name}`); continue; }
      log.properties.add(property);
      if (property === 'width') {
        if (!target.matches('.countdown-fill')) log.faults.push(`width moves on ${target.className}`);
        continue;
      }
      // M3: the request drawn along its arrow, and its marker, on the row of
      // the step that began; they last 600 ms.
      const travel = (property === 'clip-path' && target.matches('.arrow-line')) || (property === 'left' && target.matches('.arrow-pulse'));
      if (!travel && !allowed.includes(property) && !/^border-(top|right|bottom|left)-color$/.test(property)) log.faults.push(`${property} moves on ${target.className}`);
      const row = target.closest('#rows .row');
      if (!row) { log.faults.push(`${property} moves outside the rows, on ${target.className}`); continue; }
      rows.add(row);
      const at = changed.get(row);
      if (at === undefined || performance.now() - at > (travel ? 800 : 400)) log.faults.push(`${property} moves on step ${row.dataset.step} with no change of its state`);
    }
    log.most = Math.max(log.most, rows.size);
  }, 25);
}, M1);

const report = (page) => page.evaluate(() => ({ samples: window.motionLog.samples, properties: [...window.motionLog.properties].sort(), faults: [...new Set(window.motionLog.faults)], most: window.motionLog.most }));

test('during a run the transitions running are those of the step that changed state, and the countdown bar: nothing else, and nothing for a selection or a mode', async () => {
  // The finished clean run played back on its own timeline at 8 times its pace.
  const view = await openView(browser, { motion: 'no-preference', server: { replay: true, speed: 8 } });
  const { page } = view;
  try {
    await watch(page);
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#rows .row[data-step="record"]')?.dataset.status === 'written', null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const run = await report(page);
    assert.deepEqual(run.faults, []);
    assert.ok(run.samples > 100, `${run.samples} samples`);
    assert.ok(run.properties.includes('width'), 'the bar moved');
    assert.ok(run.properties.includes('color'), `a change of state moved: ${run.properties}`);
    assert.ok(run.properties.includes('clip-path'), `a request travelled along its arrow: ${run.properties}`);
    assert.ok(run.most >= 1 && run.most <= 2, `at most the step that ended and the step that began at once: ${run.most}`);

    // Selection, mode and the inspector cause no motion. The countdown leaves
    // the rows once the outcome is decided.
    await page.waitForFunction(() => document.body.dataset.run === 'paid' && document.querySelector('#rows .countdown') === null, null, { timeout: 15000 });
    await page.waitForTimeout(1300);
    const before = await report(page);
    for (const key of ['1', 'ArrowRight', 'i', '4', '0', 's', 'End', 'Home']) {
      await page.keyboard.press(key);
      const now = await page.evaluate(() => document.getAnimations().length);
      assert.equal(now, 0, `after ${key}`);
      await page.waitForTimeout(60);
    }
    const afterKeys = await report(page);
    assert.deepEqual(afterKeys.faults, []);
    assert.ok(afterKeys.samples > before.samples);
  } finally {
    await view.close();
  }
});

test('the stop arrives by M1 and its request by M3: its colours pass through the 200 ms transition, its stamp does not move, and nothing else moves', async () => {
  const view = await openView(browser, { motion: 'no-preference', server: { replay: true, speed: 10 } });
  const { page } = view;
  try {
    await watch(page);
    await page.click('.scene[data-kind="poisoned"]');
    await runIs(page, 'blocked', 30000);
    const mid = await page.evaluate(() => {
      const chip = document.querySelector('#rows .row[data-status="blocked"] .row-state .chip');
      return { duration: getComputedStyle(chip).transitionDuration, rotate: getComputedStyle(chip).rotate };
    });
    assert.equal(mid.duration, '0.2s');
    assert.equal(mid.rotate, '-1.5deg', 'the stamp\'s tilt is still: it is not in a transition');
    await page.waitForFunction(() => document.querySelector('#rows .row[data-step="record"]')?.dataset.status === 'written', null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const run = await report(page);
    assert.deepEqual(run.faults, []);
    assert.ok(run.properties.includes('color'), `the stop's colour moved: ${run.properties}`);
  } finally {
    await view.close();
  }
});

test('reduced motion: no animation runs through a whole run, the countdown number still changes each second and the bar steps', async () => {
  const grant = CLEAN_DONE.grant;
  const view = await openView(browser, { motion: 'reduce', clockAt: new Date(Date.parse(grant.expiresAt) - 20000).toISOString() });
  const { page } = view;
  try {
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tab')).transitionDuration), '0s');
    await page.evaluate(() => {
      window.seenAnimations = 0;
      setInterval(() => { window.seenAnimations = Math.max(window.seenAnimations, document.getAnimations().length); }, 20);
    });
    await runAndWait(view, 'clean', 'paid');
    // The grant's countdown, in the inspector's row of its remaining lifetime.
    await page.keyboard.press('i');
    await page.keyboard.press('2');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#pane-inspector .countdown-fill')).transitionDuration), '0s');
    const read = () => page.evaluate(() => ({ text: document.querySelector('#pane-inspector .countdown-text').textContent, width: document.querySelector('#pane-inspector .countdown-fill').getBoundingClientRect().width }));
    const texts = [];
    const widths = [];
    for (let i = 0; i < 4; i += 1) {
      const now = await read();
      texts.push(now.text);
      widths.push(now.width);
      await page.waitForTimeout(1000);
    }
    assert.equal(new Set(texts).size, 4, `the number changes each second: ${texts}`);
    assert.ok(widths[0] > widths[1] && widths[1] > widths[2] && widths[2] > widths[3], `the bar steps down: ${widths}`);
    assert.equal(await page.evaluate(() => window.seenAnimations), 0);
  } finally {
    await view.close();
  }
});

// ---- The trace

test('nothing moves on load with the trace showing: two seconds after the page opens, with no run, no animation is running; the change between the flow and the trace and the opening of a row start none', async () => {
  const view = await openView(browser, { motion: 'no-preference', hash: '#inspect-trace' });
  const { page } = view;
  try {
    const counts = [];
    for (let i = 0; i < 8; i += 1) {
      counts.push(await page.evaluate(() => document.getAnimations().length));
      await page.waitForTimeout(250);
    }
    assert.deepEqual(counts, Array(8).fill(0));
    assert.equal(await page.evaluate(() => document.body.dataset.view), 'trace');

    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForTimeout(400);
    const animations = () => page.evaluate(() => document.getAnimations().length);
    assert.equal(await animations(), 0, 'a finished run at rest');
    // The switch is an instant swap, by key and by click.
    for (const press of [() => page.keyboard.press('t'), () => page.keyboard.press('t'), () => page.click('#tab-sequence'), () => page.click('#tab-trace')]) {
      await press();
      assert.equal(await animations(), 0, 'right after the switch');
      await page.waitForTimeout(60);
      assert.equal(await animations(), 0, 'and a moment later');
    }
    // A row opens and closes with no animation, by key and by its control.
    await page.keyboard.press('2');
    await page.click('#trace-body [data-span="grant"] .trace-title');
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key);
      assert.equal(await animations(), 0, `right after ${key}`);
    }
    for (let i = 0; i < 2; i += 1) {
      await page.click('#trace-body [data-span="grant"] .trace-toggle');
      assert.equal(await animations(), 0, 'right after a click on the control');
    }
    // A selection and a mode move nothing either.
    for (const key of ['1', 'ArrowDown', 'Enter', 's', 'i']) {
      await page.keyboard.press(key);
      assert.equal(await animations(), 0, `after ${key}`);
    }
    // A replay changes the state a row shows, so the state chip of a row it
    // hides or shows passes through M1, as in a run: nothing else moves, and
    // it is over within the 200 ms.
    const running = () => page.evaluate((allowed) => document.getAnimations().map((a) => {
      const target = a.effect.target;
      const property = a.transitionProperty;
      const known = a instanceof CSSTransition && target.matches('#trace-body .chip, #trace-body .chip .icon') && (allowed.includes(property) || /^border-(top|right|bottom|left)-color$/.test(property));
      return known ? null : `${a.constructor.name} of ${property} on ${target.className}`;
    }).filter(Boolean), M1);
    for (const key of ['p', 'j', 'j', '0']) {
      await page.keyboard.press(key);
      assert.deepEqual(await running(), [], `right after ${key}`);
      await page.waitForTimeout(350);
      assert.equal(await animations(), 0, `350 ms after ${key}`);
    }
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

// Watch every animation the document runs while the trace shows.
const watchTrace = (page) => page.evaluate((allowed) => {
  const changed = new Map();
  new MutationObserver((records) => {
    for (const r of records) changed.set(r.target, performance.now());
  }).observe(document.getElementById('trace'), { subtree: true, attributes: true, attributeFilter: ['data-status'] });
  window.motionLog = { samples: 0, properties: new Set(), faults: [], bars: new Set(), most: 0 };
  setInterval(() => {
    const log = window.motionLog;
    log.samples += 1;
    const rows = new Set();
    for (const a of document.getAnimations()) {
      const target = a.effect?.target;
      const property = a.transitionProperty;
      if (!(a instanceof CSSTransition)) { log.faults.push(`not a transition: ${a.constructor.name}`); continue; }
      // M2: the countdown of the grant, which the inspector shows while its step is selected.
      if (target.matches('.countdown-fill')) {
        if (property !== 'width') log.faults.push(`${property} moves on the countdown bar`);
        continue;
      }
      if (target.matches('.trace-bar')) {
        // M4: the bar's width and its start (the start is the left edge in this writing direction).
        if (!['width', 'left', 'inset-inline-start'].includes(property)) log.faults.push(`${property} moves on a bar`);
        log.bars.add(property);
        continue;
      }
      log.properties.add(property);
      if (!allowed.includes(property) && !/^border-(top|right|bottom|left)-color$/.test(property)) log.faults.push(`${property} moves on ${target.className}`);
      const row = target.closest('#trace-body [role="row"]');
      if (!row) { log.faults.push(`${property} moves outside the trace, on ${target.className}`); continue; }
      if (!target.matches('.chip, .chip .icon')) log.faults.push(`${property} moves on ${target.className}, which is not a state chip`);
      rows.add(row);
      const at = changed.get(row);
      if (at === undefined || performance.now() - at > 400) log.faults.push(`${property} moves on step ${row.dataset.span} with no change of its state`);
    }
    log.most = Math.max(log.most, rows.size);
  }, 25);
}, M1);

const reportTrace = (page) => page.evaluate(() => ({ samples: window.motionLog.samples, properties: [...window.motionLog.properties].sort(), bars: [...window.motionLog.bars].sort(), faults: [...new Set(window.motionLog.faults)], most: window.motionLog.most }));

test('during a run on the trace the transitions running are the state chip of the step that changed state (M1) and the bars (M4): the bar of the step being checked grows, and every bar moves once when the lane takes the run\'s own length', async () => {
  // The finished clean run played back on its own timeline at 8 times its pace.
  const view = await openView(browser, { motion: 'no-preference', hash: '#story-trace', server: { replay: true, speed: 8 } });
  const { page } = view;
  try {
    await watchTrace(page);
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="record"]')?.dataset.status === 'written', null, { timeout: 30000 });
    // The run ends a moment after its record is written: the lane then takes the run's length.
    await runIs(page, 'paid', 30000);
    await page.waitForFunction((name) => document.getElementById('run-control').getAttribute('aria-label') === name, filled('menu.runAgainName', { scene: LABELS.scenes[0].title }), { timeout: 30000 });
    await page.waitForTimeout(600);
    const run = await reportTrace(page);
    assert.deepEqual(run.faults, []);
    assert.ok(run.samples > 100, `${run.samples} samples`);
    assert.ok(run.bars.includes('width'), `a bar's width moved: ${run.bars}`);
    assert.ok(run.bars.some((p) => p !== 'width'), `a bar's start moved when the lane took the run's length: ${run.bars}`);
    assert.ok(run.properties.includes('color'), `a state chip moved: ${run.properties}`);
    assert.ok(run.most >= 1 && run.most <= 2, `at most the step that ended and the step that began at once: ${run.most}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.trace-bar')).transitionDuration), '0.2s');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.trace-bar')).transitionTimingFunction), 'ease-out');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.trace-bar')).transitionProperty), M4.join(', '));

    // At rest nothing runs, and a selection, a mode or the inspector start nothing.
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    const before = await reportTrace(page);
    for (const key of ['1', 'ArrowRight', 'i', '4', '0', 's', 'End', 'Home']) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0, `after ${key}`);
      await page.waitForTimeout(60);
    }
    const afterKeys = await reportTrace(page);
    assert.deepEqual(afterKeys.faults, []);
    assert.ok(afterKeys.samples > before.samples);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('reduced motion on the trace: no animation runs through a whole run, and the bar of a step being checked is still wider from one second to the next', async () => {
  // A whole run: the finished clean run played back at 8 times its pace.
  const whole = await openView(browser, { motion: 'reduce', hash: '#story-trace', server: { replay: true, speed: 8 } });
  try {
    const { page } = whole;
    await page.evaluate(() => {
      window.seenAnimations = 0;
      setInterval(() => { window.seenAnimations = Math.max(window.seenAnimations, document.getAnimations().length); }, 20);
    });
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="credential"]')?.dataset.status === 'passed', null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.trace-bar')).transitionDuration), '0s');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#trace-body .chip')).transitionDuration), '0s');
    await page.waitForFunction((name) => document.getElementById('run-control').getAttribute('aria-label') === name, filled('menu.runAgainName', { scene: LABELS.scenes[0].title }), { timeout: 60000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.seenAnimations), 0);
    assert.deepEqual((await traceRows(page)).filter((r) => r.level === 1).map((r) => r.bar !== null), Array(6).fill(true), 'every step of the finished run has its bar');
    assert.deepEqual(whole.errors, []);
  } finally {
    await whole.close();
  }

  // A step that stays in progress: its bar is wider at each reading, as content, with no animation.
  const grant = CLEAN_RUNNING.steps[1];
  const view = await openView(browser, { motion: 'reduce', hash: '#story-trace', clockAt: new Date(Date.parse(grant.startedAt) + 3000).toISOString(), server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  try {
    const { page } = view;
    await page.evaluate(() => {
      window.seenAnimations = 0;
      setInterval(() => { window.seenAnimations = Math.max(window.seenAnimations, document.getAnimations().length); }, 20);
    });
    await runScene(page, 'clean');
    await runIs(page, 'running');
    await view.settle();
    const widths = [];
    for (let i = 0; i < 3; i += 1) {
      widths.push((await traceRows(page)).find((r) => r.span === 'grant').bar.width);
      await page.waitForTimeout(1100);
    }
    assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `the bar grows from one second to the next: ${widths}`);
    assert.equal(await page.evaluate(() => window.seenAnimations), 0);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
