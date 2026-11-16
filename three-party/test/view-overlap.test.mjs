// No piece of the screen lies on another, and none spills out of its pane:
// at each moment of the walkthrough (the start, a run in progress, a payment
// that went through, a stopped run, the audit), in Story and in Inspect, at
// 1024x768, 1280x720, 1440x900 and 1920x1080. A piece is an element that holds text of its own,
// an icon, a control, a record mark or an arrow; its box is cut to the panes
// and lists that scroll around it, so a row scrolled out of sight is not
// counted. Two pieces overlap when they share more than one pixel each way
// and neither holds the other. The audit first finds a collision planted on
// the page, so a clean result is a result of looking.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, runIs, runScene, examplesWith, removeTempDirs } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// Runs in the page: every overlap and every spill among the resting pieces.
function auditPage() {
  const PANES = ['topbar', 'pane-left', 'pane-flow', 'pane-inspector', 'footer'];
  const cut = (a, b) => {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent ?? '').trim().slice(0, 32)}"`;
  const pieces = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.live, .sprite, dialog:not([open]), [hidden]')) continue;
    // The body of a closed section is laid out but not drawn.
    const closed = el.closest('details:not([open])');
    if (closed && !el.closest('summary')) continue;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.display === 'contents') continue;
    const own = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
    const kind = el.matches('svg.icon, button, select, .rec-mark, .arrow, .badge, .countdown-track, .copy-btn') || own;
    if (!kind) continue;
    if (el.closest('svg.icon') && !el.matches('svg.icon')) continue;
    const box = el.getBoundingClientRect();
    // A piece of text that runs over two lines is two boxes, one per line.
    const clips = [];
    for (let up = el.parentElement; up; up = up.parentElement) {
      const s = getComputedStyle(up);
      if (/(hidden|auto|scroll|clip)/.test(`${s.overflowX} ${s.overflowY}`)) clips.push(up.getBoundingClientRect());
    }
    const shown = [...el.getClientRects()].map((r) => clips.reduce((acc, c) => (acc ? cut(acc, c) : null), { left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
      .filter((r) => r && r.right - r.left >= 1 && r.bottom - r.top >= 1);
    if (!shown.length) continue;
    const pane = PANES.map((id) => document.getElementById(id)).find((p) => p && p.contains(el)) ?? null;
    pieces.push({ el, box, shown, pane });
  }
  const findings = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const a = pieces[i];
    // Out of its pane sideways, or past the window.
    if (a.pane) {
      const p = a.pane.getBoundingClientRect();
      if (a.box.left < p.left - 0.5 || a.box.right > p.right + 0.5) findings.push(`spills out of #${a.pane.id}: ${name(a.el)}`);
    }
    if (a.box.right > window.innerWidth + 0.5) findings.push(`past the window: ${name(a.el)}`);
    for (let j = i + 1; j < pieces.length; j += 1) {
      const b = pieces[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const hit = a.shown.some((ra) => b.shown.some((rb) => {
        const both = cut(ra, rb);
        return both && both.right - both.left > 1 && both.bottom - both.top > 1;
      }));
      if (hit) findings.push(`${name(a.el)} lies on ${name(b.el)}`);
    }
  }
  return { findings, pieces: pieces.length };
}

async function auditNow(page, beat) {
  const { findings, pieces } = await page.evaluate(auditPage);
  assert.ok(pieces > 20, `${beat}: ${pieces} pieces read`);
  assert.deepEqual(findings, [], beat);
  return pieces;
}

test('the audit finds a collision planted on the page, and only that one', async () => {
  const view = await openView(browser);
  try {
    const clean = await view.page.evaluate(auditPage);
    assert.deepEqual(clean.findings, []);
    // Two words set 20 px apart on one line, in an empty strip at the foot
    // of the middle pane.
    await view.page.evaluate(() => {
      const strip = document.createElement('div');
      strip.style.position = 'relative';
      strip.style.height = '40px';
      strip.style.flex = 'none';
      for (const [left, text] of [[40, 'planted one'], [60, 'planted two']]) {
        const span = document.createElement('span');
        span.className = 'planted';
        span.textContent = text;
        span.style.position = 'absolute';
        span.style.top = '8px';
        span.style.left = `${left}px`;
        strip.append(span);
      }
      document.getElementById('pane-flow').append(strip);
    });
    const planted = await view.page.evaluate(auditPage);
    assert.equal(planted.findings.length, 1, planted.findings.join('\n'));
    assert.match(planted.findings[0], /planted/);
  } finally {
    await view.close();
  }
});

for (const [width, height] of [[1024, 768], [1280, 720], [1440, 900], [1920, 1080]]) {
  test(`${width}x${height}: nothing lies on anything at the start, during a run, when paid, when stopped and at the audit, in Story and in Inspect`, async () => {
    const view = await openView(browser, { width, height });
    const { page } = view;
    try {
      let read = 0;
      const both = async (beat) => {
        await page.keyboard.press('s');
        await view.settle();
        read += await auditNow(page, `${beat}, Story`);
        await page.keyboard.press('i');
        await view.settle();
        read += await auditNow(page, `${beat}, Inspect`);
        await page.keyboard.press('s');
      };
      await both('start');
      await runAndWait(view, 'clean', 'paid');
      await both('paid');
      for (const key of ['1', '2', '3', '5']) {
        await page.keyboard.press(key);
        await both(`paid, step ${key}`);
      }
      await runAndWait(view, 'poisoned', 'blocked');
      await both('stopped');
      await page.keyboard.press('o');
      await page.waitForFunction(() => document.body.dataset.tab === 'records');
      await both('audit');
      await page.keyboard.press('t');
      await both('audit, the trace');
      assert.ok(read > 500, `${read} pieces read`);
    } finally {
      await view.close();
    }
  });

  test(`${width}x${height}: nothing lies on anything while a run is in progress`, async () => {
    const view = await openView(browser, { width, height, server: { examples: examplesWith({ omit: ['state-clean-done.json'] }) } });
    try {
      await runScene(view.page, 'clean');
      await runIs(view.page, 'running');
      await view.settle();
      await auditNow(view.page, 'running, Story');
      await view.page.keyboard.press('i');
      await view.settle();
      await auditNow(view.page, 'running, Inspect');
    } finally {
      await view.close();
    }
  });
}
