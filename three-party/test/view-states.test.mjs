// The seven states, the outcome and the grant countdown, read from the page
// as the run API's example states arrive.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runScene, runIs, rowsOf, COPY, LABELS, CLEAN_DONE, POISONED, examplesWith, removeTempDirs } from './support/view-helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ICON_NAMES, shapeMarkup } from '../view/icons.mjs';
import { asOf } from '../view/dev-server.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const word = (status) => COPY[LABELS.states[status].wordKey];
const icon = (status) => LABELS.states[status].icon;

test('the map names seven states, each with its own icon shape, word and tone', () => {
  const states = Object.entries(LABELS.states);
  assert.equal(states.length, 7);
  const icons = states.map(([, s]) => s.icon);
  assert.equal(new Set(icons).size, 7, 'seven icon names');
  for (const name of icons) assert.ok(ICON_NAMES.includes(name), `the view draws ${name}`);
  assert.equal(new Set(icons.map((name) => shapeMarkup(name))).size, 7, 'seven drawings');
  assert.equal(new Set(states.map(([, s]) => COPY[s.wordKey])).size, 7, 'seven words');
  for (const [status, s] of states) assert.equal(typeof COPY[s.wordKey], 'string', status);
});

test('before a run the middle pane shows the orientation: the one sentence, the three parts and the two runs to start, with the first run focused and no row, no outcome', async () => {
  const view = await openView(browser);
  try {
    const start = await view.page.evaluate(() => ({
      rows: document.querySelectorAll('#rows .row').length,
      flowHidden: document.getElementById('flow').hidden,
      sentence: document.getElementById('app-sentence')?.dataset.src,
      parts: [...document.querySelectorAll('#orient .orient-part')].map((p) => p.dataset.col),
      runs: [...document.querySelectorAll('#orient .orient-actions button')].map((b) => b.dataset.runKind),
      focused: document.activeElement?.dataset.runKind ?? null,
      outcomeHidden: document.getElementById('outcome-end').hidden,
      hash: location.hash,
      mode: document.body.dataset.mode,
    }));
    assert.deepEqual(start, {
      rows: 0,
      flowHidden: true,
      sentence: 'copy:ui.lead',
      parts: LABELS.columns.filter((id) => LABELS.parts[id] && LABELS.parts[id].text),
      runs: ['clean', 'poisoned'],
      focused: 'clean',
      outcomeHidden: true,
      hash: '',
      mode: 'story',
    });
  } finally {
    await view.close();
  }
});

test('a poisoned run: Passed three times, Stopped, Not reached, Written, each with its icon; the stopped step is stamped and says what differed, and the outcome line says it in the lens\'s words', async () => {
  const view = await openView(browser);
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    const rows = await rowsOf(view.page);
    const statuses = ['passed', 'passed', 'passed', 'blocked', 'not-reached', 'written'];
    assert.deepEqual(rows.map((r) => r.status), statuses);
    assert.deepEqual(rows.map((r) => r.word), statuses.map(word));
    assert.deepEqual(rows.map((r) => r.shown), statuses.map((s) => `#icon-${icon(s)}`));
    assert.deepEqual(rows.map((r) => r.title), POISONED.steps.map((s) => s.title));
    // Follow lands on the stopped step: it is the selected row, stamped,
    // with the one detail line on screen.
    assert.deepEqual(rows.map((r) => r.current), [null, null, null, 'step', null, null]);
    assert.deepEqual(rows.map((r) => r.detail !== null), [false, false, false, true, false, false]);
    const stopped = await view.page.evaluate(() => {
      const row = document.querySelector('#rows .row[data-outcome="blocked"]');
      const chip = row.querySelector('.row-state .chip');
      return { step: row.dataset.step, font: getComputedStyle(chip).fontFamily, border: getComputedStyle(chip).borderTopStyle, detail: row.querySelector('.row-detail').dataset.src };
    });
    assert.equal(stopped.step, POISONED.blockedAt);
    assert.match(stopped.font, /DIN Condensed|Avenir Next Condensed|Arial Narrow/, 'the stop is stamped in the condensed face');
    assert.equal(stopped.border, 'solid');
    assert.match(stopped.detail, /^copy:detail\.intentStop;/);
    const outcome = await view.page.evaluate(() => {
      const host = document.getElementById('outcome-end');
      return { hidden: host.hidden, outcome: host.dataset.outcome, headline: host.querySelector('[data-outcome-part="headline"]').dataset.src, text: host.querySelector('[data-outcome-part="text"]').textContent };
    });
    assert.deepEqual(outcome, { hidden: false, outcome: 'blocked', headline: `copy:${LABELS.outcomeHeadlines['blocked:intent']};when=run:blockedAt`, text: COPY['lens.security.blockedIntent'] });
    // In Inspect, the row of the step that was not reached says why.
    await view.page.keyboard.press('i');
    await view.page.keyboard.press('5');
    assert.equal(await view.page.evaluate(() => document.querySelector('#rows .row[data-step="pay"] .row-detail').textContent), COPY['detail.notRun']);
  } finally {
    await view.close();
  }
});

test('a clean run in progress: Passed, Checking, then Pending four times, and no outcome line yet', async () => {
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  try {
    await runScene(view.page, 'clean');
    await runIs(view.page, 'running');
    await view.settle();
    const rows = await rowsOf(view.page);
    const statuses = ['passed', 'running', 'pending', 'pending', 'pending', 'pending'];
    assert.deepEqual(rows.map((r) => r.status), statuses);
    assert.deepEqual(rows.map((r) => r.word), statuses.map(word));
    assert.equal(await view.page.evaluate(() => document.getElementById('outcome-end').hidden), true);
  } finally {
    await view.close();
  }
});

test('a clean run finished: Passed five times, Written, the outcome Paid in the lens\'s words, and the next run it offers', async () => {
  const view = await openView(browser);
  try {
    await runAndWait(view, 'clean', 'paid');
    const rows = await rowsOf(view.page);
    const statuses = ['passed', 'passed', 'passed', 'passed', 'passed', 'written'];
    assert.deepEqual(rows.map((r) => r.status), statuses);
    assert.deepEqual(rows.map((r) => r.word), statuses.map(word));
    const outcome = await view.page.evaluate(() => {
      const host = document.getElementById('outcome-end');
      return { outcome: host.dataset.outcome, headline: host.querySelector('[data-outcome-part="headline"]').textContent, text: host.querySelector('[data-outcome-part="text"]').textContent, next: host.querySelector('#next-action')?.dataset.next ?? null };
    });
    assert.deepEqual(outcome, { outcome: 'paid', headline: COPY['outcome.paid'], text: COPY['lens.security.paid'], next: 'poisoned' });
  } finally {
    await view.close();
  }
});

test('a status the map names for a later run kind is drawn now: Expired, with the clock face', async () => {
  const state = structuredClone(CLEAN_DONE);
  state.steps[1].status = 'expired';
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-running.json'], add: { 'state-clean-done.json': state } }) } });
  try {
    await runAndWait(view, 'clean', 'paid');
    const row = (await rowsOf(view.page))[1];
    assert.deepEqual([row.status, row.word, row.icon, row.tone], ['expired', COPY['state.expired'], 'clock', 'warn']);
  } finally {
    await view.close();
  }
});

test('a status the map does not name is shown by its own value, with the hollow circle', async () => {
  const state = structuredClone(CLEAN_DONE);
  state.steps[2].status = 'deferred';
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-running.json'], add: { 'state-clean-done.json': state } }) } });
  try {
    await runAndWait(view, 'clean', 'paid');
    const row = (await rowsOf(view.page))[2];
    assert.deepEqual([row.word, row.shown, row.tone], ['deferred', '#icon-circle-outline', 'neutral']);
  } finally {
    await view.close();
  }
});

test('the grant countdown: on the grant row while the run goes on, gone from it once the outcome is decided; in the grant\'s inspector row it reads a time within the grant\'s minute, a bar that shortens each second, warn colours near the end, then Expired with an empty bar', async () => {
  const grant = CLEAN_DONE.grant;
  // A run held as it stood 15 s in: the grant has passed, the crossing is next.
  const dir = examplesWith({ omit: ['state-clean-done.json'] });
  fs.writeFileSync(path.join(dir, 'state-clean-running.json'), `${JSON.stringify(asOf(CLEAN_DONE, Date.parse(CLEAN_DONE.startedAt) + 15000), null, 2)}\n`);
  const running = await openView(browser, { server: { examples: dir }, clockAt: new Date(Date.parse(CLEAN_DONE.startedAt) + 15000).toISOString() });
  try {
    await runScene(running.page, 'clean');
    await runIs(running.page, 'running');
    await running.page.waitForSelector('#rows .row[data-step="grant"] .countdown');
    const onRow = await running.page.evaluate(() => document.querySelector('#rows .row[data-step="grant"] .countdown-text').textContent);
    assert.match(onRow, new RegExp(`^${COPY['detail.countdown'].replace('{mmss}', '\\d\\d:\\d\\d')}$`));
  } finally {
    await running.close();
  }

  const view = await openView(browser, { hash: '#inspect', motion: 'no-preference', clockAt: new Date(Date.parse(grant.expiresAt) - 30000).toISOString() });
  try {
    await runAndWait(view, 'clean', 'paid');
    assert.equal(await view.page.evaluate(() => document.querySelector('#rows .countdown')), null, 'no countdown on the rows once the outcome is decided');
    await view.page.keyboard.press('2');
    await view.settle();
    const read = () => view.page.evaluate(() => {
      const node = document.querySelector('#pane-inspector .countdown');
      return { key: node.closest('.kv-row').querySelector('.kv-key').textContent, text: node.querySelector('.countdown-text').textContent, width: node.querySelector('.countdown-fill').getBoundingClientRect().width, track: node.querySelector('.countdown-track').getBoundingClientRect().width, expiring: node.dataset.expiring, done: node.dataset.done };
    });
    const one = await read();
    assert.equal(one.key, COPY['inspector.lifetime']);
    const shape = new RegExp(`^${COPY['detail.countdown'].replace('{mmss}', '(\\d\\d):(\\d\\d)')}$`);
    assert.match(one.text, shape);
    const [, mm, ss] = shape.exec(one.text);
    assert.equal(mm, '00');
    assert.ok(Number(ss) > 0 && Number(ss) <= 30, one.text);
    assert.equal(one.expiring, 'no');
    assert.ok(one.width > 0 && one.width < one.track, `the bar is part of its track: ${one.width} of ${one.track}`);
    await view.page.waitForTimeout(1200);
    const two = await read();
    assert.match(two.text, shape);
    assert.notEqual(two.text, one.text, 'the number changes each second');
    assert.ok(two.width < one.width, `the bar shortens: ${one.width} then ${two.width}`);

    await view.page.clock.fastForward(22000);
    await view.page.waitForTimeout(1200);
    const near = await read();
    assert.match(near.text, shape);
    assert.equal(near.expiring, 'yes', `under ${LABELS.countdown.expiringSeconds} seconds the countdown takes the warn colours`);

    await view.page.clock.fastForward(30000);
    await view.page.waitForTimeout(300);
    const end = await read();
    assert.equal(end.text, COPY['detail.countdownDone']);
    assert.equal(end.done, 'yes');
    await view.page.waitForTimeout(1200);
    assert.equal((await read()).width, 0, 'the bar is empty');
  } finally {
    await view.close();
  }
});
