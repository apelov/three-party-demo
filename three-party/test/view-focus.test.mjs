// The keyboard path, stop by stop, with the keyboard alone: the order of the
// stops, a visible ring on each, and the focus never out of sight (WCAG 2.2
// SC 2.4.3, 2.4.7 and 2.4.11): the element that holds the focus lies inside
// the window and inside every pane that scrolls around it, and no element
// that stays in place while the page scrolls lies over it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runIs, examplesWith, removeTempDirs } from './support/view-helpers.mjs';
import { poisonedManifest, traceRows } from './support/trace-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The element that holds the focus: which stop it is, its ring, and whether
// any of it is out of sight.
const stop = (page) => page.evaluate(() => {
  const node = document.activeElement;
  if (!node || node === document.body) return null;
  const r = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const kind = node.classList.contains('scene') ? 'scene'
    : node.id === 'run-control' ? 'run'
      : node.closest('#step-controls') ? node.id
        : node.closest('#mode-switch') ? `mode:${node.dataset.mode}`
          : node.closest('#view-switch') ? `view:${node.dataset.view}`
            : node.closest('#run-line') ? 'copy'
              : node.closest('#trace-body') ? `trace:${node.dataset.span}`
                : node.closest('#rows') ? `flow:${node.dataset.step}`
                  : node.closest('#pane-inspector') ? 'inspector'
                    : node.tagName;
  // Elements that stay in place while the page scrolls, and lie over it.
  const over = [...document.querySelectorAll('body *')].filter((other) => other !== node && !other.contains(node) && !node.contains(other) && ['sticky', 'fixed'].includes(getComputedStyle(other).position)).filter((other) => {
    const o = other.getBoundingClientRect();
    return o.width > 0 && o.height > 0 && o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top;
  }).map((other) => other.id || other.className);
  // A pane that scrolls or clips, and cuts a part of it off. The browser's
  // own scroll to an element that takes the focus may leave its last pixel
  // at the pane's edge (it rounds to whole pixels): that pixel is let through.
  const cut = [];
  for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (!/auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) continue;
    const box = a.getBoundingClientRect();
    if (r.top < box.top - 1.5 || r.bottom > box.bottom + 1.5 || r.left < box.left - 1.5 || r.right > box.right + 1.5) cut.push(a.id || a.className);
  }
  return {
    kind,
    inWindow: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    over,
    cut,
    ring: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
  };
});

function assertInSight(s, where) {
  assert.ok(s, `${where}: an element holds the focus`);
  assert.equal(s.inWindow, true, `${where}: ${s.kind} lies inside the window (${s.box})`);
  assert.deepEqual(s.over, [], `${where}: nothing that stays in place lies over ${s.kind}`);
  assert.deepEqual(s.cut, [], `${where}: no pane cuts ${s.kind} off`);
  assert.equal(s.ring, true, `${where}: ${s.kind} shows its ring`);
}

// A stopped run by the keyboard alone, with step 4 selected; then back to
// the scene list, and forward stop by stop until the focus leaves the page
// or comes round again.
async function walk(view) {
  const { page } = view;
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('r');
  await runIs(page, 'blocked');
  await view.settle();
  await page.keyboard.press('4');
  await view.settle();
  for (let i = 0; i < 40 && (await stop(page))?.kind !== 'scene'; i += 1) await page.keyboard.press('Shift+Tab');
  const stops = [];
  for (let i = 0; i < 60; i += 1) {
    const s = await stop(page);
    if (!s || (stops.length > 0 && s.kind === 'scene')) break;
    stops.push(s);
    await page.keyboard.press('Tab');
  }
  return stops;
}

// The path of the page: the scene list, the run control, the three step
// controls, the mode switch, the switch between the flow and the trace, the
// run's copy control, the selected step (one stop for the list of steps),
// then the controls of the inspector. The offline check has no control of
// its own: it is scene 6 of the scene list, run by the run control.
const PATH = ['scene', 'run', 'step-back', 'step-forward', 'step-replay', 'mode:story', 'mode:inspect', 'view:flow', 'view:trace', 'copy'];

for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
  test(`${width}x${height}, the trace in Inspect: the stops come in the order of the page, each inside the window with its ring and nothing over it; the trace is one stop, on its selected row`, async () => {
    const view = await openView(browser, { width, height, hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
    try {
      const stops = await walk(view);
      const kinds = stops.map((s) => s.kind);
      assert.deepEqual(kinds.slice(0, PATH.length + 1), [...PATH, 'trace:intent']);
      const rest = kinds.slice(PATH.length + 1);
      assert.ok(rest.length >= 2, `the inspector's controls follow (${rest.length} stops)`);
      assert.deepEqual([...new Set(rest)], ['inspector']);
      stops.forEach((s, i) => assertInSight(s, `stop ${i + 1}`));
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('1440x900, the flow in Story: the same path, with the flow\'s selected row as its one stop for the steps', async () => {
  const view = await openView(browser, { width: 1440, height: 900, hash: '#story' });
  try {
    const stops = await walk(view);
    const kinds = stops.map((s) => s.kind);
    assert.deepEqual(kinds.slice(0, PATH.length + 1), [...PATH, 'flow:intent']);
    stops.forEach((s, i) => assertInSight(s, `stop ${i + 1}`));
  } finally {
    await view.close();
  }
});

test('1280x800, the trace in Inspect, where its rows scroll inside the pane: the focus moved row by row, down and back up, is on a row that lies whole inside the grid each time, and the grid never scrolls smoothly', async () => {
  const view = await openView(browser, { width: 1280, height: 800, hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
  const { page } = view;
  try {
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('r');
    await runIs(page, 'blocked');
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0);
    await view.settle();
    const body = await page.evaluate(() => { const b = document.getElementById('trace-body'); return [b.scrollHeight, b.clientHeight]; });
    assert.ok(body[0] > body[1], `the rows are taller than the pane, so they scroll inside it (${body})`);
    const order = (await traceRows(page)).map((r) => r.span);
    assert.equal(order.length, 18);
    await page.keyboard.press('1');
    assertInSight(await stop(page), 'the selected row');
    for (const [key, spans] of [['ArrowDown', order.slice(1)], ['ArrowUp', order.slice(0, -1).reverse()]]) {
      for (const span of spans) {
        await page.keyboard.press(key);
        const s = await stop(page);
        assert.equal(s.kind, `trace:${span}`);
        assertInSight(s, `${key} to ${span}`);
      }
    }
    await page.keyboard.press('End');
    assertInSight(await stop(page), 'End');
    await page.keyboard.press('Home');
    assertInSight(await stop(page), 'Home');
    // A digit selects a step far down the grid: its row comes into sight.
    await page.keyboard.press('6');
    const six = await stop(page);
    assert.equal(six.kind, 'trace:record');
    assertInSight(six, 'key 6');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('trace-body')).scrollBehavior), 'auto');
    assert.equal(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, document.documentElement.scrollHeight <= innerHeight].join()), 'true,true', 'the page itself does not scroll');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
