// The seven states, the outcome and the grant countdown, read from the page
// as the run API's example states arrive.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runScene, runIs, rowsOf, COPY, LABELS, CLEAN_DONE, POISONED, examplesWith, removeTempDirs } from './support/view-helpers.mjs';
import { ICON_NAMES, shapeMarkup } from '../view/icons.mjs';

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

test('before a run the flow shows the six steps of the contract as pending, with no step selected and the run control focused', async () => {
  const view = await openView(browser);
  try {
    const rows = await rowsOf(view.page);
    assert.deepEqual(rows.map((r) => r.title), ['credential', 'grant', 'crossing', 'intent', 'pay', 'record'].map((id) => COPY[`step.${id}`]));
    assert.deepEqual(rows.map((r) => r.word), Array(6).fill(word('pending')));
    assert.deepEqual(rows.map((r) => r.number), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(rows.map((r) => r.current), Array(6).fill(null));
    assert.equal(await view.page.evaluate(() => document.activeElement.id), 'run-control');
    assert.equal(await view.page.evaluate(() => document.getElementById('outcome-end').textContent), '');
    assert.equal(await view.page.evaluate(() => document.getElementById('app-sentence').textContent), COPY['app.sentence']);
    assert.equal(await view.page.evaluate(() => location.hash), '');
    assert.equal(await view.page.evaluate(() => document.body.dataset.mode), 'story');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a poisoned run: Passed three times, Stopped, Not reached, Written, each with its icon; the stopped step carries the headline and the run\'s reason', async () => {
  const view = await openView(browser);
  try {
    await runAndWait(view, 'poisoned', 'blocked');
    const rows = await rowsOf(view.page);
    const want = ['passed', 'passed', 'passed', 'blocked', 'not-reached', 'written'];
    assert.deepEqual(rows.map((r) => r.status), want);
    assert.deepEqual(rows.map((r) => r.word), want.map(word));
    assert.deepEqual(rows.map((r) => r.icon), want.map(icon));
    assert.deepEqual(rows.map((r) => r.shown), want.map((s) => `#icon-${icon(s)}`));
    assert.deepEqual(rows.map((r) => r.tone), want.map((s) => LABELS.states[s].tone));
    assert.deepEqual(rows.map((r) => r.title), POISONED.steps.map((s) => s.title));

    const banner = await view.page.evaluate(() => {
      const row = document.querySelector('#rows .row[data-outcome="blocked"]');
      return {
        step: row.dataset.step,
        headline: row.querySelector('[data-outcome-part="headline"]').textContent,
        text: row.querySelector('[data-outcome-part="text"]').textContent,
        endHidden: document.getElementById('outcome-end').hidden,
        top: document.querySelector('.run-outcome').textContent,
      };
    });
    assert.equal(banner.step, POISONED.blockedAt);
    assert.equal(banner.headline, COPY[LABELS.outcomeHeadlines['blocked:intent']]);
    assert.equal(banner.headline, COPY['outcome.stoppedIntent']);
    assert.equal(banner.text, POISONED.reason);
    assert.equal(banner.endHidden, true, 'the outcome is stated once, at the stopped step');
    assert.equal(banner.top, COPY['outcome.stoppedIntent']);
    assert.equal(rows[4].detail, null, 'Story opens the detail line of the selected row alone');
    await view.page.keyboard.press('i');
    assert.equal((await rowsOf(view.page))[4].detail, COPY['detail.notRun']);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a clean run in progress: Passed, Checking, then Pending four times, and the outcome reads In progress', async () => {
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  try {
    await runScene(view.page, 'clean');
    await runIs(view.page, 'running');
    const rows = await rowsOf(view.page);
    const want = ['passed', 'running', 'pending', 'pending', 'pending', 'pending'];
    assert.deepEqual(rows.map((r) => r.status), want);
    assert.deepEqual(rows.map((r) => r.word), want.map(word));
    assert.deepEqual(rows.map((r) => r.icon), want.map(icon));
    assert.equal(word('running'), COPY['state.checking']);
    const end = await view.page.evaluate(() => ({ outcome: document.getElementById('outcome-end').dataset.outcome, text: document.querySelector('#outcome-end [data-outcome-part="headline"]').textContent }));
    assert.deepEqual(end, { outcome: 'pending', text: COPY['outcome.pending'] });
    assert.equal(await view.page.evaluate(() => document.querySelector('.countdown')), null, 'no countdown before the grant has passed');
  } finally {
    await view.close();
  }
});

test('a clean run finished: Passed five times, Written, and the outcome Paid with the payment the bank accepted', async () => {
  const view = await openView(browser);
  try {
    await runAndWait(view, 'clean', 'paid');
    const rows = await rowsOf(view.page);
    const want = ['passed', 'passed', 'passed', 'passed', 'passed', 'written'];
    assert.deepEqual(rows.map((r) => r.status), want);
    assert.deepEqual(rows.map((r) => r.word), want.map(word));
    assert.deepEqual(rows.map((r) => r.icon), want.map(icon));
    const end = await view.page.evaluate(() => ({
      outcome: document.getElementById('outcome-end').dataset.outcome,
      headline: document.querySelector('#outcome-end [data-outcome-part="headline"]').textContent,
      text: document.querySelector('#outcome-end [data-outcome-part="text"]').textContent,
      stopSentences: document.querySelectorAll('.stop-sentence').length,
    }));
    const paymentId = CLEAN_DONE.steps.find((s) => s.id === 'pay').detail.paymentId;
    assert.equal(end.outcome, 'paid');
    assert.equal(end.headline, COPY['outcome.paid']);
    assert.equal(end.text, COPY['outcome.paidText'].replace('{paymentId}', paymentId));
    assert.equal(end.stopSentences, 0);
    assert.deepEqual(view.errors, []);
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

test('the grant countdown: Expires in a time within the grant\'s minute, a bar that shortens each second, warn colours near the end, then Expired with an empty bar', async () => {
  const grant = CLEAN_DONE.grant;
  const view = await openView(browser, { motion: 'no-preference', clockAt: new Date(Date.parse(grant.expiresAt) - 30000).toISOString() });
  try {
    await runAndWait(view, 'clean', 'paid');
    const read = () => view.page.evaluate(() => {
      const node = document.querySelector('#rows .row[data-step="grant"] .countdown');
      return { text: node.querySelector('.countdown-text').textContent, width: node.querySelector('.countdown-fill').getBoundingClientRect().width, track: node.querySelector('.countdown-track').getBoundingClientRect().width, expiring: node.dataset.expiring, done: node.dataset.done };
    });
    const one = await read();
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

    // The same countdown stands in the grant inspector.
    await view.page.keyboard.press('2');
    const insp = await view.page.evaluate(() => ({ key: document.querySelector('#pane-inspector .countdown').closest('.kv-row').querySelector('.kv-key').textContent, text: document.querySelector('#pane-inspector .countdown-text').textContent }));
    assert.deepEqual(insp, { key: COPY['inspector.lifetime'], text: COPY['detail.countdownDone'] });
  } finally {
    await view.close();
  }
});
