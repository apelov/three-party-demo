// What a viewer reads first and what changes when they ask for it. Above the
// tabs, one boxed sentence says what you told your AI assistant to pay, from
// the run's own invoice, and a poisoned invoice adds the line it hides for
// the assistant; the box stays in sight on every tab. View as rewrites the
// sentence under every step on the Sequence, Trace and Records tabs, not one
// line of the side panel alone. The menu's three acts are three ruled cards.
// A finished act chosen again in the menu shows its own run, and the audit
// shows the run it checked. Every press here is a real click or a real key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runIs, runScene, removeTempDirs, COPY, EXAMPLES } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const example = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => {
  assert.ok(Object.hasOwn(values, key), `no value for {${key}}`);
  return values[key];
});
const toldFor = (invoice) => fill(COPY['task.told'], { invoiceId: invoice.invoiceId, amount: invoice.amount, currency: invoice.currency, account: invoice.payTo.account });
const LENSES = ['security', 'finance', 'platform', 'standards'];
const lensLine = (lens, stepId) => COPY[`lens.${lens}.${stepId.replace(/-again$/, '')}`];

const taskBox = (page) => page.evaluate(() => {
  const box = document.getElementById('invoice');
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  return {
    told: box.querySelector('.task-told')?.textContent ?? null,
    label: box.querySelector('.task-hidden-label')?.textContent ?? null,
    hidden: box.querySelector('mark.hidden-text')?.textContent ?? null,
    inSight: !box.hidden && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
    aboveTabs: r.bottom <= document.getElementById('tabs').getBoundingClientRect().top + 0.5,
    ruledAround: ['Top', 'Right', 'Bottom', 'Left'].every((side) => parseFloat(cs[`border${side}Width`]) >= 2),
  };
});

const audited = (page) => page.waitForFunction(() => document.body.dataset.tab === 'records' && document.querySelector('#records-tab [data-verdict-for] .verdict') !== null);

test('the task above the tabs says what you told your AI assistant to pay, from the run\'s own invoice; a poisoned invoice adds the line it hides; the ruled box stays in sight on every tab', async () => {
  const view = await openView(browser, { width: 1440, height: 900 });
  const { page } = view;
  try {
    assert.equal((await taskBox(page)).told, null, 'no task before a run');
    await runScene(page, 'clean');
    await runIs(page, 'paid');
    await view.settle();
    const clean = example('state-clean-done.json').invoice;
    for (const tab of ['sequence', 'trace', 'records']) {
      await page.click(`#tab-${tab}`);
      await view.settle();
      assert.deepEqual(await taskBox(page), { told: toldFor(clean), label: null, hidden: null, inSight: true, aboveTabs: true, ruledAround: true }, `the ${tab} tab`);
    }
    await page.click('#tab-sequence');
    await runScene(page, 'poisoned');
    await runIs(page, 'blocked');
    await view.settle();
    const poisoned = example('state-poisoned-blocked.json').invoice;
    assert.notEqual(poisoned.invoiceId, clean.invoiceId);
    assert.deepEqual(await taskBox(page), { told: toldFor(poisoned), label: COPY['task.hidden'], hidden: poisoned.hidden.text, inSight: true, aboveTabs: true, ruledAround: true });
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('View as rewrites the sentence under every step on the Sequence, Trace and Records tabs, in the words of the reader chosen', async () => {
  const view = await openView(browser, { width: 1440, height: 900 });
  const { page } = view;
  try {
    await runScene(page, 'poisoned');
    await runIs(page, 'blocked');
    await view.settle();
    const seen = {};
    for (const lens of LENSES) {
      await page.selectOption('#lens-select', lens);
      await view.settle();
      assert.equal(await page.evaluate(() => document.body.dataset.lens), lens);
      await page.click('#tab-sequence');
      await view.settle();
      const sequence = await page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((row) => [row.dataset.step, row.querySelector(':scope > .row-lens')?.textContent ?? null]));
      assert.equal(sequence.length, 6);
      for (const [step, line] of sequence) assert.equal(line, lensLine(lens, step), `${lens}: the sequence row of ${step}`);
      await page.click('#tab-trace');
      await view.settle();
      const trace = await page.evaluate(() => [...document.querySelectorAll('.trace-row[aria-level="1"]')].filter((row) => Number(row.dataset.index) >= 0).map((row) => [row.dataset.span, row.querySelector(':scope > .trace-lens')?.textContent ?? null]));
      assert.equal(trace.length, 6);
      for (const [step, line] of trace) assert.equal(line, lensLine(lens, step), `${lens}: the trace row of ${step}`);
      await page.click('#tab-records');
      await view.settle();
      const records = await page.evaluate(() => [...document.querySelectorAll('#records-tab .ledger-row.record[data-kind="records"] .ledger-lens')].map((n) => n.textContent));
      assert.ok(records.length >= 4, `${lens}: ${records.length} records carry the sentence`);
      const lines = new Set(['credential', 'grant', 'crossing', 'intent', 'pay', 'record'].map((step) => lensLine(lens, step)));
      for (const line of records) assert.ok(lines.has(line), `${lens}: a record's sentence is the lens's line for its step: ${line}`);
      seen[lens] = sequence.map(([, line]) => line).join('\n');
    }
    assert.equal(new Set(Object.values(seen)).size, LENSES.length, 'each reader reads different sentences');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the menu holds three cards, each ruled all around and set apart from the next, the one chosen ruled heavier', async () => {
  const view = await openView(browser, { width: 1440, height: 900 });
  const { page } = view;
  try {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#scenes .scene')].map((card) => {
      const cs = getComputedStyle(card);
      const r = card.getBoundingClientRect();
      return { kind: card.dataset.kind, top: r.top, bottom: r.bottom, ruled: ['Top', 'Right', 'Bottom', 'Left'].every((side) => parseFloat(cs[`border${side}Width`]) >= 1 && cs[`border${side}Style`] === 'solid'), color: cs.borderTopColor, heavier: cs.boxShadow !== 'none', chosen: card.getAttribute('aria-pressed') === 'true' };
    }));
    assert.equal(cards.length, 3);
    for (const card of cards) assert.equal(card.ruled, true, `${card.kind}: ruled on all four sides`);
    assert.equal(new Set(cards.map((c) => c.color)).size, 1, 'one ink for all three rules');
    for (let i = 1; i < cards.length; i += 1) assert.ok(cards[i].top - cards[i - 1].bottom >= 8, `a gap of ${cards[i].top - cards[i - 1].bottom} px between card ${i} and card ${i + 1}`);
    assert.deepEqual(cards.map((c) => c.chosen), [true, false, false]);
    assert.deepEqual(cards.map((c) => c.heavier), [true, false, false]);
  } finally {
    await view.close();
  }
});

test('a finished act chosen again in the menu shows its own run, the audit shows the run it checked on the Records tab, and nothing is started by the choosing', async () => {
  const view = await openView(browser, { width: 1440, height: 900 });
  const { page } = view;
  try {
    const clean = example('state-clean-done.json').invoice;
    const poisoned = example('state-poisoned-blocked.json').invoice;
    let posts = 0;
    page.on('request', (req) => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/runs') posts += 1; });
    await runScene(page, 'clean');
    await runIs(page, 'paid');
    await view.settle();
    await runScene(page, 'poisoned');
    await runIs(page, 'blocked');
    await view.settle();
    await page.keyboard.press('o');
    await audited(page);
    await view.settle();
    assert.equal(posts, 2, 'two runs started, by the R key');
    const started = posts;

    await page.click('.scene[data-kind="clean"]');
    await runIs(page, 'paid');
    await view.settle();
    assert.equal((await taskBox(page)).told, toldFor(clean), 'the normal payment again, as it ended');
    assert.equal(await page.evaluate(() => document.body.dataset.tab), 'sequence', 'its own run has no audit: the sequence');

    await page.click('.scene[data-kind="poisoned"]');
    await runIs(page, 'blocked');
    await view.settle();
    assert.equal((await taskBox(page)).told, toldFor(poisoned), 'the poisoned invoice again, as it ended');

    await page.click('.scene[data-kind="clean"]');
    await runIs(page, 'paid');
    await page.click('.scene[data-kind="offline-check"]');
    await audited(page);
    await view.settle();
    assert.equal((await taskBox(page)).told, toldFor(poisoned), 'the audit shows the run it checked');
    assert.ok(await page.evaluate(() => document.querySelectorAll('#records-tab [data-verdict-for] .verdict').length >= 4), 'with its verdicts');

    assert.equal(posts, started, 'choosing in the menu started no run');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
