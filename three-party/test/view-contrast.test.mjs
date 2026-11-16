// Colour: every pair of the stylesheet's tokens that carries text reads at
// least 4.5:1, and every pair that carries an icon, a rule or an outline
// with meaning at least 3:1 (WCAG 2.2 SC 1.4.3 and 1.4.11), in the light
// scheme and the dark one; and the states on screen wear those tokens, with
// no tile behind a state and no colour standing alone for its meaning.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runScene, runIs, contrast, examplesWith, CLEAN_DONE, removeTempDirs } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The grounds text and marks stand on.
const GROUNDS = ['--page', '--paper'];
// Inks that carry text: the three of the statement, the three of the states,
// and the ink of each part.
const TEXT_INKS = ['--ink', '--ink-2', '--muted', '--green', '--red', '--amber', '--p-agent', '--p-checkpoint', '--p-crossing', '--p-bank', '--p-record'];
// Inks that carry an icon, a rule or an outline with meaning.
const SHAPE_INKS = ['--green', '--red', '--amber', '--muted', '--rule-strong', '--p-agent', '--p-checkpoint', '--p-crossing', '--p-bank', '--p-record'];
// Text set on a fill: the primary action, the highlighted value, the mode chosen.
const ON_FILL = [['--cta-ink', '--cta'], ['--highlight-ink', '--highlight'], ['--page', '--ink']];

const tokens = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  const names = ['--page', '--paper', '--ink', '--ink-2', '--muted', '--rule', '--rule-strong', '--green', '--red', '--amber', '--highlight', '--highlight-ink', '--cta', '--cta-ink', '--p-agent', '--p-checkpoint', '--p-crossing', '--p-bank', '--p-record'];
  return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n).trim()]));
});

const hex = (rgb) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(rgb);
  return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb;
};

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: every text pair reads at least 4.5:1, every icon, rule and outline pair at least 3:1, and the light and dark tokens differ`, async (t) => {
    const view = await openView(browser, { scheme });
    try {
      const tok = await tokens(view.page);
      for (const [name, value] of Object.entries(tok)) assert.match(value, /^#[0-9a-f]{6}$/i, `${name} is a colour`);
      let pairs = 0;
      for (const ground of GROUNDS) {
        for (const ink of TEXT_INKS) {
          const ratio = contrast(tok[ink], tok[ground]);
          assert.ok(ratio >= 4.5, `${scheme}: ${ink} on ${ground} reads ${ratio.toFixed(2)}:1`);
          pairs += 1;
        }
        for (const ink of SHAPE_INKS) {
          const ratio = contrast(tok[ink], tok[ground]);
          assert.ok(ratio >= 3, `${scheme}: ${ink} as a mark on ${ground} reads ${ratio.toFixed(2)}:1`);
          pairs += 1;
        }
      }
      for (const [ink, fill] of ON_FILL) {
        const ratio = contrast(tok[ink], tok[fill]);
        assert.ok(ratio >= 4.5, `${scheme}: ${ink} on ${fill} reads ${ratio.toFixed(2)}:1`);
        pairs += 1;
      }
      // The part inks read apart from each other and from the state inks.
      const parts = ['--p-checkpoint', '--p-crossing', '--p-record'];
      assert.equal(new Set(parts.map((p) => tok[p].toLowerCase())).size, parts.length);
      for (const p of parts) for (const s of ['--green', '--red', '--amber']) assert.notEqual(tok[p].toLowerCase(), tok[s].toLowerCase(), `${p} is not ${s}`);
      t.diagnostic(`${scheme}: ${pairs} pairs measured; ink on page ${contrast(tok['--ink'], tok['--page']).toFixed(2)}:1, muted on page ${contrast(tok['--muted'], tok['--page']).toFixed(2)}:1, red on page ${contrast(tok['--red'], tok['--page']).toFixed(2)}:1`);
    } finally {
      await view.close();
    }
  });

  test(`${scheme}: the states on screen wear their tokens: each state's word and icon in its ink with no tile, the stop stamped in red, the not-reached arrow dashed, the outcome and the primary action`, async () => {
    const view = await openView(browser, { scheme });
    try {
      const tok = await tokens(view.page);
      await runAndWait(view, 'poisoned', 'blocked');
      const seen = await view.page.evaluate(() => {
        const of = (status) => {
          const row = document.querySelector(`#rows .row[data-status="${status}"]`);
          const chip = row.querySelector('.row-state .chip');
          const icon = chip.querySelector('.icon');
          return { word: getComputedStyle(chip.querySelector('.chip-word')).color, icon: getComputedStyle(icon).color, background: getComputedStyle(chip).backgroundColor, border: `${getComputedStyle(chip).borderTopStyle} ${getComputedStyle(chip).borderTopColor}`, track: getComputedStyle(row.querySelector('.arrow-track')).borderTopStyle, arrow: getComputedStyle(row.querySelector('.arrow')).color };
        };
        const outcome = document.querySelector('#outcome-end .outcome-chip');
        const next = document.getElementById('next-action');
        return {
          passed: of('passed'), blocked: of('blocked'), notReached: of('not-reached'), written: of('written'),
          page: getComputedStyle(document.body).backgroundColor,
          outcome: getComputedStyle(outcome).color,
          next: next ? { color: getComputedStyle(next).color, background: getComputedStyle(next).backgroundColor } : null,
          run: { color: getComputedStyle(document.getElementById('run-control')).color, border: getComputedStyle(document.getElementById('run-control')).borderTopColor },
        };
      });
      assert.equal(hex(seen.page), tok['--page']);
      assert.deepEqual([hex(seen.passed.word), hex(seen.passed.icon)], [tok['--green'], tok['--green']]);
      assert.deepEqual([hex(seen.written.word), hex(seen.written.icon)], [tok['--green'], tok['--green']]);
      assert.deepEqual([hex(seen.blocked.word), hex(seen.blocked.icon)], [tok['--red'], tok['--red']]);
      assert.deepEqual([hex(seen.notReached.word), hex(seen.notReached.icon)], [tok['--muted'], tok['--muted']]);
      for (const s of [seen.passed, seen.notReached, seen.written]) assert.equal(hex(s.background), tok['--page'], 'no tile behind a state: the page shows through');
      assert.equal(seen.blocked.border, `solid ${seen.blocked.word}`, 'the stop is stamped: a solid border in its ink');
      assert.equal(hex(seen.blocked.arrow), tok['--red'], 'the stopped request\'s arrow is red');
      assert.equal(seen.notReached.track, 'dashed', 'the not-reached arrow is dashed');
      assert.equal(hex(seen.notReached.arrow), tok['--muted']);
      assert.equal(hex(seen.outcome), tok['--red']);
      assert.deepEqual([hex(seen.next.color), hex(seen.next.background)], [tok['--cta-ink'], tok['--cta']], 'the one primary action in the amber of a call to action');
      assert.deepEqual([hex(seen.run.color), hex(seen.run.border)], [tok['--ink'], tok['--ink']], 'the run control is a quiet outline');
    } finally {
      await view.close();
    }
  });

  test(`${scheme}: the trace and the step controls wear those colours: a passed step's bar in the second ink, the stopped step's bar, headline, marks and verdict in red, a step control available in ink and not available in the muted ink`, async () => {
    const view = await openView(browser, { scheme, hash: '#inspect-trace' });
    try {
      const tok = await tokens(view.page);
      const back = () => view.page.evaluate(() => getComputedStyle(document.getElementById('step-back')).color);
      assert.equal(hex(await back()), tok['--muted'], 'not available before a run');
      await runAndWait(view, 'poisoned', 'blocked');
      assert.equal(hex(await back()), tok['--ink'], 'available with a run');
      const seen = await view.page.evaluate(() => {
        const color = (sel, prop = 'color') => { const n = document.querySelector(sel); return n ? getComputedStyle(n)[prop] : null; };
        return {
          passedBar: color('#trace-body [data-span="credential"] .trace-bar', 'backgroundColor'),
          stoppedBar: color('#trace-body [data-span="intent"] .trace-bar', 'backgroundColor'),
          lane: color('#trace-body [data-span="credential"] .trace-lane', 'backgroundColor'),
          head: color('#trace-body [data-span="intent"] .trace-stop-head'),
          pill: color('#trace-body .trace-pill'),
          pillBorder: color('#trace-body .trace-pill', 'borderTopColor'),
          verdict: color('#trace-body [data-span="intent/call/1"] .verdict'),
          why: color('#trace-body [data-span="intent/call/1"] .trace-why'),
          passedWord: color('#trace-body [data-span="credential"] .chip-word'),
        };
      });
      assert.equal(hex(seen.passedBar), tok['--ink-2']);
      assert.equal(hex(seen.stoppedBar), tok['--red']);
      assert.equal(hex(seen.lane), tok['--rule']);
      for (const key of ['head', 'pill', 'pillBorder', 'verdict', 'why']) assert.equal(hex(seen[key]), tok['--red'], key);
      assert.equal(hex(seen.passedWord), tok['--green']);
    } finally {
      await view.close();
    }
  });
}

test('a step being checked: its word and icon in the ink of a check under way, its request drawn on its arrow; a pending step\'s arrow is a dashed track with no line drawn on it', async () => {
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  try {
    const tok = await tokens(view.page);
    await runScene(view.page, 'clean');
    await runIs(view.page, 'running');
    await view.settle();
    const seen = await view.page.evaluate(() => {
      const of = (status) => {
        const row = document.querySelector(`#rows .row[data-status="${status}"]`);
        return { word: getComputedStyle(row.querySelector('.chip-word')).color, line: getComputedStyle(row.querySelector('.arrow-line')).clipPath, track: getComputedStyle(row.querySelector('.arrow-track')).borderTopStyle, title: getComputedStyle(row.querySelector('.row-title')).color };
      };
      return { running: of('running'), pending: of('pending') };
    });
    assert.equal(hex(seen.running.word), tok['--ink']);
    assert.equal(seen.running.line, 'inset(0px)', 'the request is drawn the whole length of its arrow');
    assert.equal(seen.pending.line, 'inset(0px 100% 0px 0px)', 'no request is drawn on a pending arrow');
    assert.equal(seen.pending.track, 'dashed');
    assert.equal(hex(seen.pending.title), tok['--muted']);
    assert.ok(CLEAN_DONE.steps.length >= 2);
  } finally {
    await view.close();
  }
});
