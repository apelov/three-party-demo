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
          : node.id === 'lens-select' ? 'lens'
            : node.getAttribute('role') === 'tab' ? `tab:${node.dataset.tab}`
              : node.closest('#run-line') ? 'copy'
                : node.closest('#trace-body') ? `trace:${node.dataset.span}`
                  : node.closest('#rows') ? `flow:${node.dataset.step}`
                    : node.id === 'next-action' ? `next:${node.dataset.next}`
                      : node.closest('#pane-inspector') ? 'inspector'
                        : node.id === 'help-button' ? 'help'
                          : node.dataset.runKind ? `start:${node.dataset.runKind}`
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
    // The ring as drawn, and the first ink it must be drawn in.
    ringSpec: `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`,
    ringOffset: style.outlineOffset,
    ink: (() => { const probe = document.createElement('span'); probe.style.color = 'var(--ink)'; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; })(),
  };
});

function assertInSight(s, where) {
  assert.ok(s, `${where}: an element holds the focus`);
  assert.equal(s.inWindow, true, `${where}: ${s.kind} lies inside the window (${s.box})`);
  assert.deepEqual(s.over, [], `${where}: nothing that stays in place lies over ${s.kind}`);
  assert.deepEqual(s.cut, [], `${where}: no pane cuts ${s.kind} off`);
  assert.equal(s.ring, true, `${where}: ${s.kind} shows its ring`);
  // One ring for every stop: 2 px, dotted, in the first ink, 3 px outside
  // the control, or 3 px inside a row or a tab that fills its place.
  assert.equal(s.ringSpec, `2px dotted ${s.ink}`, `${where}: the ring of ${s.kind}`);
  assert.ok(['3px', '-3px'].includes(s.ringOffset), `${where}: the ring of ${s.kind} stands 3 px from its edge (${s.ringOffset})`);
}

// A stopped run by the keyboard alone, from the orientation (Tab to the
// poisoned invoice, Enter), with step 4 selected; then back to the page's
// first stop, the run's copy control, and forward stop by stop to the
// control that lists the keys, the page's last stop.
async function startPoisoned(page) {
  // From the orientation: Tab to the poisoned invoice and Enter. From the
  // menu (the page opened on another tab): Down to the poisoned invoice and Enter.
  if ((await stop(page))?.kind === 'scene') {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('r');
  } else {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
  }
}

async function walk(view) {
  const { page } = view;
  await startPoisoned(page);
  await runIs(page, 'blocked');
  await view.settle();
  await page.keyboard.press('4');
  await view.settle();
  for (let i = 0; i < 40 && (await stop(page))?.kind !== 'copy'; i += 1) await page.keyboard.press('Shift+Tab');
  const stops = [];
  for (let i = 0; i < 60; i += 1) {
    const s = await stop(page);
    if (!s) break;
    stops.push(s);
    if (s.kind === 'help') break;
    await page.keyboard.press('Tab');
  }
  return stops;
}

// The path of the page: the top bar (the run's copy control, the lens, the
// mode switch), the menu (one stop), the run control, the three step
// controls, the tab list (one stop, on the tab shown), then the selected
// step (one stop for the list of steps), the outcome's next action (after
// the poisoned invoice run first, the first act not yet done: the normal
// payment), the controls of the inspector, and the control that lists the keys.
const PATH = ['copy', 'lens', 'mode:story', 'mode:inspect', 'scene', 'run', 'step-back', 'step-forward', 'step-replay'];

for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
  test(`${width}x${height}, the trace in Inspect: the stops come in the order of the page, each inside the window with its ring and nothing over it; the trace is one stop, on its selected row`, async () => {
    const view = await openView(browser, { width, height, hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
    try {
      const stops = await walk(view);
      const kinds = stops.map((s) => s.kind);
      assert.deepEqual(kinds.slice(0, PATH.length + 3), [...PATH, 'tab:trace', 'trace:intent', 'next:clean']);
      const rest = kinds.slice(PATH.length + 3);
      assert.ok(rest.length >= 3, `the inspector's controls follow (${rest.length} stops)`);
      assert.deepEqual([...new Set(rest)], ['inspector', 'help']);
      assert.equal(rest[rest.length - 1], 'help');
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
    assert.deepEqual(kinds.slice(0, PATH.length + 3), [...PATH, 'tab:sequence', 'flow:intent', 'next:clean']);
    assert.equal(kinds[kinds.length - 1], 'help');
    stops.forEach((s, i) => assertInSight(s, `stop ${i + 1}`));
  } finally {
    await view.close();
  }
});

test('1280x800, the trace in Inspect, where its rows scroll inside the pane: the focus moved row by row, down and back up, is on a row that lies whole inside the grid each time, and the grid never scrolls smoothly', async () => {
  const view = await openView(browser, { width: 1280, height: 800, hash: '#inspect-trace', server: { examples: examplesWith({ add: { 'manifest.json': poisonedManifest() } }) } });
  const { page } = view;
  try {
    await startPoisoned(page);
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
