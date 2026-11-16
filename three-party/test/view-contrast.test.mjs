// Contrast, measured from the colours the page computes, in light and in
// dark: WCAG 2.2 SC 1.4.3 (text, at least 4.5:1) and SC 1.4.11 (icons and
// outlines, at least 3:1), by relative luminance linearised at 0.04045.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, contrast, removeTempDirs } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// [foreground, background, what the pair is used for]
const TEXT = [
  ['--fg', '--bg', 'body text'],
  ['--fg-2', '--bg', 'second text, pending and not reached words'],
  ['--fg', '--tile-neutral', 'the Checking word on its tile'],
  ['--fg-2', '--tile-neutral', 'second text on the neutral tile'],
  ['--cta-text', '--cta', 'the run control'],
  ['--bg', '--accent', 'the pressed mode'],
  ['--ok-text', '--ok-tile', 'Passed and Written on their tile'],
  ['--ok-text', '--bg', 'the Paid headline'],
  ['--stop-text', '--stop-tile', 'Stopped on its tile, the stopped headline'],
  ['--stop-text', '--bg', 'the outcome in the top bar, the Differs word'],
  ['--fg', '--stop-tile', 'the step title on the stop tile'],
  ['--fg-2', '--stop-tile', 'the detail line on the stop tile'],
  ['--warn-text', '--warn-tile', 'Expired on its tile'],
  ['--warn-text', '--bg', 'the countdown near its end'],
  ['--fg', '--tile-neutral', 'a step control'],
  ['--fg-2', '--tile-neutral', 'a step control that is not available'],
  ['--stop-text', '--stop-tile', 'the Decided here mark of the trace'],
  ['--stop-text', '--bg', 'the words beside a blocked tool call in the trace'],
  ['--ok-text', '--tile-neutral', 'a Written or Passed verdict on a selected row of the trace'],
  ['--stop-text', '--tile-neutral', 'a Blocked verdict on a selected row of the trace'],
  ['--warn-text', '--tile-neutral', 'the verdict on a tampered copy on a selected row of the trace'],
];
const SHAPES = [
  ['--ok-icon', '--ok-tile', 'the Passed and Written icons'],
  ['--ok-icon', '--bg', 'the Paid icon'],
  ['--stop-icon', '--stop-tile', 'the Stopped icon, the differs underline on the tile'],
  ['--stop-icon', '--bg', 'the border of the stopped tile, the differs underline'],
  ['--warn-icon', '--warn-tile', 'the Expired icon'],
  ['--warn-icon', '--border', 'the countdown bar near its end, on its track'],
  ['--accent', '--bg', 'the focus ring, the selected step, the Checking outline'],
  ['--accent', '--tile-neutral', 'the Checking icon on its tile'],
  ['--accent', '--border', 'the countdown bar on its track'],
  ['--outline', '--bg', 'dashed outlines, the track line, the badge border'],
  ['--outline', '--stop-tile', 'the track line on the stop tile'],
  ['--fg-2', '--bg', 'the Pending and Not reached icons, the track dot'],
  ['--accent', '--border', 'the bar of a step being checked, passed or written, on the lane of the trace'],
  ['--stop-icon', '--border', 'the bar of the stopped step on the lane of the trace'],
  ['--warn-icon', '--border', 'the bar of an expired step on the lane of the trace'],
  ['--stop-icon', '--bg', 'the border of the Decided here mark'],
  ['--ok-icon', '--tile-neutral', 'a verdict\'s icon on a selected row of the trace'],
  ['--stop-icon', '--tile-neutral', 'a Blocked verdict\'s icon on a selected row of the trace'],
  ['--warn-icon', '--tile-neutral', 'a tampered copy\'s icon on a selected row of the trace'],
];

// The ratios the design names for its tokens, to two places.
const NAMED = {
  light: { '--stop-icon/--border': 5.23, '--warn-icon/--border': 4.06, '--fg/--bg': 17.93, '--fg-2/--bg': 7.56, '--fg-2/--tile-neutral': 6.87, '--outline/--bg': 4.83, '--accent/--bg': 5.47, '--accent/--border': 4.42, '--cta-text/--cta': 8.35, '--ok-text/--ok-tile': 7.27, '--ok-icon/--ok-tile': 5.25, '--stop-text/--stop-tile': 7.60, '--stop-icon/--stop-tile': 5.91, '--warn-text/--warn-tile': 6.84, '--warn-icon/--warn-tile': 4.84 },
  dark: { '--stop-icon/--border': 3.73, '--warn-icon/--border': 6.17, '--fg/--bg': 16.91, '--fg-2/--bg': 7.80, '--fg-2/--tile-neutral': 5.78, '--outline/--bg': 4.10, '--accent/--bg': 10.64, '--accent/--border': 5.54, '--cta-text/--cta': 11.86, '--ok-text/--ok-tile': 11.48, '--ok-icon/--ok-tile': 7.77, '--stop-text/--stop-tile': 11.16, '--stop-icon/--stop-tile': 5.84, '--warn-text/--warn-tile': 12.03, '--warn-icon/--warn-tile': 8.97 },
};

const tokens = (page) => page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  const names = ['--bg', '--fg', '--fg-2', '--tile-neutral', '--border', '--outline', '--accent', '--cta', '--cta-text', '--ok-text', '--ok-tile', '--ok-icon', '--stop-text', '--stop-tile', '--stop-icon', '--warn-text', '--warn-tile', '--warn-icon'];
  return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
});

const hex = (rgb) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(rgb);
  return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb;
};

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: every text pair reads at least 4.5:1 and every icon and outline pair at least 3:1, and the named ratios hold`, async (t) => {
    const view = await openView(browser, { scheme });
    try {
      const colour = await tokens(view.page);
      t.diagnostic(`contrast, ${scheme}: pair | colours | ratio | floor | use`);
      for (const [fg, bg, use] of TEXT) {
        const ratio = contrast(colour[fg], colour[bg]);
        t.diagnostic(`contrast, ${scheme}: ${fg} on ${bg} | ${colour[fg]} on ${colour[bg]} | ${ratio.toFixed(2)} | 4.5 | ${use}`);
        assert.ok(ratio >= 4.5, `${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (${use})`);
      }
      for (const [fg, bg, use] of SHAPES) {
        const ratio = contrast(colour[fg], colour[bg]);
        t.diagnostic(`contrast, ${scheme}: ${fg} on ${bg} | ${colour[fg]} on ${colour[bg]} | ${ratio.toFixed(2)} | 3 | ${use}`);
        assert.ok(ratio >= 3, `${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1 (${use})`);
      }
      for (const [pair, want] of Object.entries(NAMED[scheme])) {
        const [fg, bg] = pair.split('/');
        assert.equal(contrast(colour[fg], colour[bg]).toFixed(2), want.toFixed(2), `${scheme}: ${pair}`);
      }
    } finally {
      await view.close();
    }
  });

  test(`${scheme}: the states on screen wear those colours: each chip's word, tile and icon, the stopped tile and the run control`, async () => {
    const view = await openView(browser, { scheme });
    try {
      const colour = await tokens(view.page);
      await runAndWait(view, 'poisoned', 'blocked');
      const seen = await view.page.evaluate(() => {
        const paint = (node) => {
          const s = getComputedStyle(node);
          return { color: s.color, background: s.backgroundColor, border: s.borderTopColor, borderStyle: s.borderTopStyle };
        };
        const rows = Object.fromEntries([...document.querySelectorAll('#rows .row')].map((row) => [row.dataset.status, { chip: paint(row.querySelector('.chip')), icon: paint(row.querySelector('.chip .icon')), tile: paint(row.querySelector('.row-tile')), title: paint(row.querySelector('.row-title')) }]));
        return { rows, run: paint(document.getElementById('run-control')), body: paint(document.body), headline: paint(document.querySelector('.outcome-head')), sentence: paint(document.querySelector('.stop-sentence')), marker: getComputedStyle(document.querySelector('#rows .row[aria-current="step"]'), '::before').backgroundColor };
      });
      const is = (got, token, what) => assert.equal(hex(got), colour[token], `${scheme}: ${what} is ${token}`);
      is(seen.body.background, '--bg', 'the page');
      is(seen.body.color, '--fg', 'the text');
      is(seen.rows.passed.chip.color, '--ok-text', 'the Passed word');
      is(seen.rows.passed.chip.background, '--ok-tile', 'the Passed tile');
      is(seen.rows.passed.icon.color, '--ok-icon', 'the Passed icon');
      is(seen.rows.written.chip.color, '--ok-text', 'the Written word');
      is(seen.rows.written.icon.color, '--ok-icon', 'the Written icon');
      is(seen.rows.blocked.chip.color, '--stop-text', 'the Stopped word');
      is(seen.rows.blocked.icon.color, '--stop-icon', 'the Stopped icon');
      is(seen.rows.blocked.tile.background, '--stop-tile', 'the stopped row');
      is(seen.rows.blocked.tile.border, '--stop-icon', 'the border of the stopped row');
      is(seen.rows.blocked.title.color, '--fg', 'the title on the stop tile');
      is(seen.headline.color, '--stop-text', 'the stopped headline');
      is(seen.sentence.color, '--fg', 'the stopped sentence');
      is(seen.rows['not-reached'].chip.color, '--fg-2', 'the Not reached word');
      is(seen.rows['not-reached'].chip.border, '--outline', 'the Not reached outline');
      assert.equal(seen.rows['not-reached'].chip.borderStyle, 'dashed');
      assert.equal(seen.rows['not-reached'].chip.background, 'rgba(0, 0, 0, 0)', 'Not reached has no tile');
      is(seen.rows['not-reached'].title.color, '--fg-2', 'the title of a step not reached');
      is(seen.run.background, '--cta', 'the run control');
      is(seen.run.color, '--cta-text', 'the run control\'s word');
      is(seen.marker, '--accent', 'the selected step marker');
    } finally {
      await view.close();
    }
  });
}

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: the trace and the step controls wear those colours: each bar on the track of the lane, the stopped row, the Decided here mark, the pressed half of the switch, and a step control that is and is not available`, async () => {
    const { examplesWith, CLEAN_DONE } = await import('./support/view-helpers.mjs');
    // A run with an expired grant step, derived from the finished clean run, for the bar of that state.
    const expired = structuredClone(CLEAN_DONE);
    expired.steps[1].status = 'expired';
    const view = await openView(browser, { scheme, hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'state-clean-done.json': expired } }) } });
    const { page } = view;
    try {
      const colour = await tokens(page);
      const is = (got, token, what) => assert.equal(hex(got), colour[token], `${scheme}: ${what} is ${token}`);
      const paint = (selector) => page.evaluate((s) => {
        const node = document.querySelector(s);
        const st = getComputedStyle(node);
        return { color: st.color, background: st.backgroundColor, border: st.borderTopColor, borderWidth: st.borderTopWidth };
      }, selector);
      is((await paint('#step-back')).color, '--fg-2', 'a step control that is not available');
      is((await paint('#step-back')).background, '--tile-neutral', 'its tile');
      is((await paint('#view-switch [aria-pressed="true"]')).background, '--accent', 'the pressed half of the switch');
      is((await paint('#view-switch [aria-pressed="true"]')).color, '--bg', 'its word');

      await runAndWait(view, 'clean', 'paid');
      is((await paint('#step-back')).color, '--fg', 'a step control');
      is((await paint('#trace-body [data-span="credential"] .trace-lane')).background, '--border', 'the track of the lane');
      is((await paint('#trace-body [data-span="credential"] .trace-bar')).background, '--accent', 'the bar of a passed step');
      is((await paint('#trace-body [data-span="record"] .trace-bar')).background, '--accent', 'the bar of the record step');
      is((await paint('#trace-body [data-span="grant"] .trace-bar')).background, '--warn-icon', 'the bar of an expired step');
      is((await paint('#trace-body [data-span="grant"] .chip')).color, '--warn-text', 'the Expired word');

      await runAndWait(view, 'poisoned', 'blocked');
      is((await paint('#trace-body [data-span="intent"] .trace-bar')).background, '--stop-icon', 'the bar of the stopped step');
      const row = await paint('#trace-body [data-span="intent"]');
      is(row.background, '--stop-tile', 'the stopped row');
      is(row.border, '--stop-icon', 'its border');
      assert.equal(row.borderWidth, '2px');
      is((await paint('#trace-body [data-span="intent"] .trace-stop-head')).color, '--stop-text', 'the headline');
      is((await paint('#trace-body [data-span="intent"] .trace-stop-text')).color, '--fg', 'the run\'s sentence');
      const pill = await paint('#trace-body .trace-pill');
      is(pill.color, '--stop-text', 'the Decided here mark');
      is(pill.background, '--stop-tile', 'its tile');
      is(pill.border, '--stop-icon', 'its border');
      is((await paint('#trace-body [data-span="intent/call/1"] .verdict')).color, '--stop-text', 'the Blocked word');
      is((await paint('#trace-body [data-span="intent/call/1"] .verdict .icon')).color, '--stop-icon', 'its icon');
      is((await paint('#trace-body [data-span="intent/call/1"] .trace-why')).color, '--stop-text', 'the Differs word');
      is((await paint('#trace-body [data-span="pay"] .trace-title')).color, '--fg-2', 'the title of a step not reached');
      // The running bar: a run in progress.
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('a step being checked: the neutral tile, the accent icon and a 2 px accent outline on its row; a pending step has no tile', async () => {
  const { examplesWith } = await import('./support/view-helpers.mjs');
  const view = await openView(browser, { server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
  try {
    const colour = await tokens(view.page);
    await view.page.keyboard.press('r');
    await view.page.waitForFunction(() => document.body.dataset.run === 'running');
    const seen = await view.page.evaluate(() => {
      const of = (status) => {
        const row = document.querySelector(`#rows .row[data-status="${status}"]`);
        const chip = getComputedStyle(row.querySelector('.chip'));
        const tile = getComputedStyle(row.querySelector('.row-tile'));
        return { word: chip.color, tile: chip.backgroundColor, icon: getComputedStyle(row.querySelector('.chip .icon')).color, outline: tile.borderTopColor, width: tile.borderTopWidth };
      };
      return { running: of('running'), pending: of('pending') };
    });
    assert.equal(hex(seen.running.word), colour['--fg']);
    assert.equal(hex(seen.running.tile), colour['--tile-neutral']);
    assert.equal(hex(seen.running.icon), colour['--accent']);
    assert.equal(hex(seen.running.outline), colour['--accent']);
    assert.equal(seen.running.width, '2px');
    assert.equal(hex(seen.pending.word), colour['--fg-2']);
    assert.equal(seen.pending.tile, 'rgba(0, 0, 0, 0)');
  } finally {
    await view.close();
  }
});
