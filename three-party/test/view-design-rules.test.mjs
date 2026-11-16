// The screens' design rules, measured in the page.
// Strokes have ranks: a hairline between rows, one 2 px rule under the column
// heads of the tab shown, a 2 px frame around a menu card and around the box
// of what you told the agent, and no two rules stacked with nothing between
// them. Ink has roles: the lightest ink carries metadata and what is pending,
// never a sentence. One heading style, one rule for the monospace face, at
// most three serif sizes in a region, and left edges that agree.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, contrast, removeTempDirs, COPY, POISONED, CLEAN_DONE } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// Measuring functions, set on the page once it is open.
function install() {
  const shown = (n) => n.checkVisibility({ checkVisibilityCSS: true });
  const resolve = (name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  };
  const nameOf = (n) => (n.id ? `#${n.id}` : `${n.tagName.toLowerCase()}${[...n.classList].map((c) => `.${c}`).join('')}`);
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  const drawn = (cs, side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] === 'solid' && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(cs[`border${side}Color`]);

  // The band of the window in which a node can be seen: cut by every
  // ancestor that scrolls or clips.
  const band = (n) => {
    let top = 0;
    let bottom = innerHeight;
    for (let a = n.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowY)) continue;
      const r = a.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }
    return { top, bottom };
  };
  // The lane heads stay in place while the steps scroll under them: a step
  // scrolled part of the way under them is covered, not ruled twice.
  const pinned = () => { const head = document.getElementById('lanes-head'); return head && shown(head) && getComputedStyle(head).position === 'sticky' ? head : null; };
  const underPinned = (n, r) => { const head = pinned(); if (!head || head.contains(n) || !head.parentElement.contains(n)) return false; return r.top < head.getBoundingClientRect().bottom - 0.5; };

  // A horizontal stroke: the solid top or bottom border of an element at
  // least minWidth wide that is not framed on all four sides (a frame is a
  // box, and the dashed track of an arrow is not a rule), where it can be
  // seen.
  const strokes = (root, minWidth = 120) => {
    const out = [];
    for (const n of root.querySelectorAll('*')) {
      if (!shown(n)) continue;
      const cs = getComputedStyle(n);
      if (SIDES.every((side) => drawn(cs, side))) continue;
      const r = n.getBoundingClientRect();
      if (r.width < minWidth || underPinned(n, r)) continue;
      const seen = band(n);
      for (const side of ['Top', 'Bottom']) {
        if (!drawn(cs, side)) continue;
        const px = parseFloat(cs[`border${side}Width`]);
        const y = side === 'Top' ? r.top : r.bottom - px;
        if (y < seen.top - 0.5 || y + px > seen.bottom + 0.5) continue;
        out.push({ node: n, of: nameOf(n), side: side.toLowerCase(), y, x1: r.left, x2: r.right, px, style: cs[`border${side}Style`], colour: cs[`border${side}Color`] });
      }
    }
    return out.sort((a, b) => a.y - b.y);
  };

  // Every piece of text on display under root, one entry per line box.
  const textBoxes = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement;
      if (!t.nodeValue.trim() || !shown(el) || el.closest('.live, dialog:not([open])')) continue;
      range.selectNodeContents(t);
      const seen = band(el);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1 && r.bottom > seen.top && r.top < seen.bottom) out.push({ el, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return out;
  };

  // Whether a node lies in a pane that scrolls and is longer than its
  // window: there the fold cuts a row wherever the reader stopped.
  const cutByFold = (n) => {
    for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight + 1) return true;
    return false;
  };

  // Two strokes, one under the other across the same width, with no text
  // between them. The rule over the outcome is let through under a list
  // that is scrolled: the fold, not the design, put the list's rule there.
  const stacked = (selector) => {
    const root = document.querySelector(selector);
    const list = strokes(root);
    const boxes = textBoxes(root);
    const bad = [];
    list.forEach((a, i) => {
      const b = list.slice(i + 1).find((c) => c.y - a.y >= 1.5 && Math.min(a.x2, c.x2) - Math.max(a.x1, c.x1) >= 0.5 * Math.min(a.x2 - a.x1, c.x2 - c.x1));
      if (!b) return;
      if (b.of === '#outcome-end' && cutByFold(a.node)) return;
      const x1 = Math.max(a.x1, b.x1);
      const x2 = Math.min(a.x2, b.x2);
      const between = boxes.some((t) => t.bottom > a.y + 2 && t.top < b.y - 2 && t.right > x1 && t.left < x2);
      if (!between) bad.push(`${a.of} ${a.side} then ${b.of} ${b.side}, ${Math.round(b.y - a.y)} px apart`);
    });
    return bad;
  };

  // The strokes that cross the tab shown.
  const panelStrokes = () => {
    const panel = document.querySelector('.tab-panel:not([hidden])');
    const cs = getComputedStyle(panel);
    const width = panel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return strokes(panel, width * 0.6).map(({ of, side, px, style, colour }) => ({ of, side, px, style, colour }));
  };

  const frames = () => [...document.querySelectorAll('#scenes .scene, #invoice')].filter(shown).map((n) => {
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    return {
      of: n.id ? `#${n.id}` : `card ${n.dataset.kind}`,
      card: n.classList.contains('scene'),
      sides: SIDES.map((side) => `${cs[`border${side}Width`]} ${cs[`border${side}Style`]} ${cs[`border${side}Color`]}`),
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      chosen: n.getAttribute('aria-pressed') === 'true',
      unavailable: n.getAttribute('aria-disabled') === 'true',
      top: r.top,
      bottom: r.bottom,
    };
  });

  // Each element that shows text of its own: its region, face, size, weight,
  // ink and how many words the element reads in all.
  const REGIONS = ['#topbar', '#pane-left', '#pane-flow', '#pane-inspector', '#footer'];
  // Where the muted ink may carry a line of eight words or more: a note (in
  // the side panel, under an artifact, on the trace, in the limits), the
  // footer, and what is not available, pending or not reached.
  const MUTED_ALLOWED = '.insp-note, .artifact .meta, .trace-shape, .records-limits, .footer, [aria-disabled="true"], [data-status="pending"], [data-status="not-reached"], .trace-row[data-tone="muted"]';
  const census = () => {
    const seen = new Set();
    const out = [];
    for (const region of REGIONS) {
      for (const { el } of textBoxes(document.querySelector(region))) {
        if (seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        const face = /monospace/.test(cs.fontFamily) ? 'mono' : /Condensed|Arial Narrow/.test(cs.fontFamily) ? 'stamp' : 'serif';
        out.push({ region, of: nameOf(el), face, size: Math.round(parseFloat(cs.fontSize) * 100) / 100, weight: cs.fontWeight, colour: cs.color, words: el.innerText.trim().split(/\s+/).length, mutedAllowed: el.closest(MUTED_ALLOWED) !== null, text: el.innerText.trim().slice(0, 48) });
      }
    }
    return out;
  };

  const typeOf = (selector) => [...document.querySelectorAll(selector)].filter(shown).map((n) => { const cs = getComputedStyle(n); return { size: parseFloat(cs.fontSize), weight: cs.fontWeight, colour: cs.color }; });
  const leftOfText = (n) => { const range = document.createRange(); range.selectNodeContents(n); const rects = [...range.getClientRects()].filter((r) => r.width > 1); return rects.length ? Math.min(...rects.map((r) => r.left)) : null; };
  const leftsOf = (selector) => [...document.querySelectorAll(selector)].filter(shown).map(leftOfText).filter((x) => x !== null);
  const roles = () => { const cs = getComputedStyle(document.body); return ['--t-label', '--t-value', '--t-head', '--t-lead'].map((n) => parseFloat(cs.getPropertyValue(n))); };
  const tokens = () => Object.fromEntries(['--ink', '--ink-2', '--muted', '--rule', '--rule-strong', '--page', '--paper'].map((n) => [n, resolve(n)]));

  // A token is one unspaced word in the monospace face: a key, a field
  // name, an id, a path or a hash. Its text line by line, from the box of
  // each of its characters.
  const linesOf = (n) => {
    const out = [];
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let top = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      for (let i = 0; i < t.nodeValue.length; i += 1) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getClientRects()[0];
        if (!r || r.width < 0.5) continue;
        if (top === null || Math.abs(r.top - top) > 3) { out.push(''); top = r.top; }
        out[out.length - 1] += t.nodeValue[i];
      }
    }
    return out;
  };
  const wrapped = () => [...document.querySelectorAll('.mono, .kv-key, .field > span:first-child, .artifact-path, kbd')].filter(shown).map((n) => ({ of: nameOf(n), key: n.classList.contains('kv-key'), text: n.textContent.trim(), lines: linesOf(n) })).filter((t) => t.text && !/\s/.test(t.text) && (t.lines.length > 1 || t.key));

  // The comparison of the side panel, as it reads.
  const comparison = () => [...document.querySelectorAll('#pane-inspector .compare-call')].filter(shown).map((call) => ({
    tool: call.dataset.tool,
    declared: call.dataset.declared,
    heads: call.querySelectorAll('.col-head').length,
    fields: [...call.querySelectorAll('.compare-grid > .field, .compare-args > .field')].map((field) => {
      const cell = field.nextElementSibling;
      const box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      return {
        name: field.querySelector(':scope > span')?.textContent ?? field.textContent,
        differs: field.dataset.differs === 'yes',
        word: field.querySelector('.differs-word')?.textContent ?? null,
        values: [...cell.querySelectorAll('.mono')].map((m) => m.textContent),
        pairs: [...cell.querySelectorAll(':scope > .pair-label')].map((label) => {
          const value = label.nextElementSibling;
          const mono = value.querySelector('.mono');
          return { label: label.textContent, value: mono.textContent, who: value.querySelector('.pair-who')?.textContent ?? null, marked: getComputedStyle(mono).backgroundColor, labelBox: box(label), valueBox: box(mono) };
        }),
      };
    }),
  }));

  window.design = { stacked, panelStrokes, frames, census, typeOf, leftsOf, roles, tokens, wrapped, comparison };
}

const hex = (rgb) => {
  const m = /^rgba?\((\d+), (\d+), (\d+)/.exec(rgb);
  return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb;
};

async function open(options) {
  const view = await openView(browser, options);
  await view.page.evaluate(install);
  return view;
}

const tab = async (view, name) => { await view.page.click(`#tab-${name}`); await view.settle(); };
const audited = (page) => page.waitForFunction(() => document.body.dataset.tab === 'records' && document.querySelector('#records-tab [data-verdict-for] .verdict') !== null);
// Open every closed section of the side panel with a real click.
async function openSections(view) {
  for (let i = 0; i < 8; i += 1) {
    const closed = await view.page.$('#pane-inspector details:not([open]) > summary');
    if (!closed) break;
    await closed.click();
    await view.settle(60);
  }
}

const COLUMN_HEADS = { sequence: '#lanes-head', trace: 'div.trace-cols', records: 'div.ledger-row.ledger-head' };

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: a menu card and the box of what you told the agent are framed at 2 px in the strong rule, square; only the chosen card is ruled heavier, and the cards stand 16 px apart`, async () => {
    const view = await open({ width: 1440, height: 900, scheme, hash: '#story' });
    const { page } = view;
    try {
      const tok = await page.evaluate(() => window.design.tokens());
      const frame = `2px solid ${tok['--rule-strong']}`;
      const check = async (where) => {
        const frames = await page.evaluate(() => window.design.frames());
        const cards = frames.filter((f) => f.card);
        assert.equal(cards.length, 3, `${where}: three cards`);
        for (const f of frames) {
          assert.deepEqual(f.sides, [frame, frame, frame, frame], `${where}: ${f.of} is framed at 2 px in the strong rule`);
          assert.equal(f.radius, '0px', `${where}: ${f.of} is square`);
          if (!f.card) assert.equal(f.shadow, 'none', `${where}: the box carries no second rule`);
        }
        for (const card of cards) {
          if (card.chosen) assert.equal(card.shadow, `${card.unavailable ? tok['--muted'] : tok['--rule-strong']} 0px 0px 0px 2px inset`, `${where}: the chosen card is ruled 2 px more, inside`);
          else assert.equal(card.shadow, 'none', `${where}: ${card.of} is not ruled heavier`);
        }
        assert.equal(cards.filter((c) => c.chosen).length, 1, `${where}: one card chosen`);
        for (let i = 1; i < cards.length; i += 1) assert.equal(Math.round(cards[i].top - cards[i - 1].bottom), 16, `${where}: 16 px between card ${i} and card ${i + 1}`);
        return frames;
      };
      assert.equal((await check('start')).length, 3, 'no box before a run');
      await runAndWait(view, 'clean', 'paid');
      assert.equal((await check('paid')).length, 4, 'the box stands above the tabs');
      await runAndWait(view, 'poisoned', 'blocked');
      await check('stopped');
      // The third card chosen while it cannot run yet keeps the frame; its
      // heavier rule is in the muted ink.
      const fresh = await open({ width: 1440, height: 900, scheme, hash: '#story' });
      try {
        await fresh.page.click('.scene[data-kind="offline-check"]', { force: true });
        await fresh.settle();
        const cards = (await fresh.page.evaluate(() => window.design.frames())).filter((f) => f.card);
        const third = cards[2];
        assert.deepEqual([third.chosen, third.unavailable], [true, true], 'the audit is chosen before any run, and cannot run');
        assert.deepEqual(third.sides, [frame, frame, frame, frame]);
        assert.equal(third.shadow, `${tok['--muted']} 0px 0px 0px 2px inset`);
      } finally {
        await fresh.close();
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('a short window sets the cards 8 px apart', async () => {
  const view = await open({ width: 1280, height: 577, hash: '#story' });
  try {
    const cards = (await view.page.evaluate(() => window.design.frames())).filter((f) => f.card);
    for (let i = 1; i < cards.length; i += 1) assert.equal(Math.round(cards[i].top - cards[i - 1].bottom), 8);
  } finally {
    await view.close();
  }
});

for (const mode of ['story', 'inspect']) {
  test(`${mode}: each tab has one 2 px rule, under its column heads, and hairlines elsewhere; no two rules stand one under the other with nothing between them, in the middle pane or the side panel`, async () => {
    const view = await open({ width: 1440, height: 900, hash: `#${mode}` });
    const { page } = view;
    try {
      const tok = await page.evaluate(() => window.design.tokens());
      const ranks = async (name, where) => {
        const strokes = await page.evaluate(() => window.design.panelStrokes());
        const heavy = strokes.filter((s) => s.px !== 1);
        assert.deepEqual(heavy, [{ of: COLUMN_HEADS[name], side: 'bottom', px: 2, style: 'solid', colour: tok['--rule-strong'] }], `${where}, ${name}: one 2 px rule, under the column heads`);
        const light = strokes.filter((s) => s.px === 1);
        assert.ok(light.length >= 2, `${where}, ${name}: ${light.length} hairlines in sight`);
        for (const s of light) assert.deepEqual([s.style, s.colour], ['solid', tok['--rule']], `${where}, ${name}: ${s.of} ${s.side} is a hairline`);
      };
      const stacks = async (where) => {
        await openSections(view);
        for (const pane of ['#pane-flow', '#pane-inspector']) assert.deepEqual(await page.evaluate((p) => window.design.stacked(p), pane), [], `${where}: no stacked rules in ${pane}`);
      };

      await stacks('start');
      await runAndWait(view, 'clean', 'paid');
      for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
        await page.keyboard.press(key);
        await view.settle(60);
        await stacks(`paid, key ${key}`);
      }
      await page.keyboard.press('2');
      for (const name of ['sequence', 'trace', 'records']) {
        await tab(view, name);
        await ranks(name, 'paid');
        await stacks(`paid, ${name}`);
      }
      await tab(view, 'sequence');
      await runAndWait(view, 'poisoned', 'blocked');
      for (const key of ['4', '5']) {
        await page.keyboard.press(key);
        await view.settle(60);
        for (const name of ['sequence', 'trace', 'records']) {
          await tab(view, name);
          await ranks(name, `stopped, key ${key}`);
          await stacks(`stopped, key ${key}, ${name}`);
        }
      }
      // The audit, started from the sequence, shows the Records tab.
      await tab(view, 'sequence');
      await page.keyboard.press('o');
      await audited(page);
      await view.settle();
      // The panel holds the focus after the audit and draws no ring around the pane.
      assert.deepEqual(await page.evaluate(() => [document.activeElement.id, getComputedStyle(document.activeElement).outlineStyle]), ['panel-records', 'none'], 'the Records panel holds the focus, with no ring');
      await ranks('records', 'audited');
      await stacks('audited');
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

// Every state walked for the ink and type rules: the start, a paid run with
// a step selected on each tab, a stopped run, and the audit.
async function walk(view, each) {
  const { page } = view;
  await each('start');
  // The audit chosen in the menu before any run: the card that cannot run
  // yet, and the line that says why.
  await page.click('.scene[data-kind="offline-check"]', { force: true });
  await view.settle(60);
  await each('start, the audit chosen');
  await runAndWait(view, 'clean', 'paid');
  await page.keyboard.press('2');
  await view.settle(60);
  await openSections(view);
  for (const name of ['sequence', 'trace', 'records']) { await tab(view, name); await each(`paid, ${name}`); }
  await tab(view, 'sequence');
  await runAndWait(view, 'poisoned', 'blocked');
  await openSections(view);
  for (const name of ['sequence', 'trace', 'records']) { await tab(view, name); await each(`stopped, ${name}`); }
  await page.keyboard.press('o');
  await audited(page);
  await view.settle();
  await each('audited');
}

for (const [mode, scheme] of [['story', 'light'], ['story', 'dark'], ['inspect', 'light']]) {
  test(`${mode} ${scheme}: no sentence is set in the muted ink; a region holds at most three serif sizes and two monospace sizes; a monospace value is 0.88 of its role's size and never under 13 px`, async () => {
    const view = await open({ width: 1440, height: 900, scheme, hash: `#${mode}` });
    const { page } = view;
    try {
      const tok = await page.evaluate(() => window.design.tokens());
      const second = contrast(hex(tok['--ink-2']), hex(tok['--page']));
      assert.ok(second >= 7, `the second ink reads ${second.toFixed(2)}:1 on the page`);
      const found = new Set();
      let states = 0;
      await walk(view, async (where) => {
        states += 1;
        const roles = await page.evaluate(() => window.design.roles());
        assert.deepEqual(roles, mode === 'story' ? [15, 18, 20, 28] : [13, 15, 18, 24]);
        const monoSizes = roles.map((r) => Math.round(Math.max(13, r * 0.88) * 100) / 100);
        const census = await page.evaluate(() => window.design.census());
        for (const t of census) {
          if (t.words >= 8 && t.colour === tok['--muted'] && !t.mutedAllowed) found.add(`eight words or more in the muted ink: ${t.of} "${t.text}"`);
          if (t.size < 13) found.add(`under 13 px: ${t.of} at ${t.size} px "${t.text}"`);
          if (t.face === 'mono' && !monoSizes.includes(t.size)) found.add(`monospace at ${t.size} px, not one of ${monoSizes.join(', ')}: ${t.of} "${t.text}"`);
        }
        for (const region of new Set(census.map((t) => t.region))) {
          const sizes = (face) => [...new Set(census.filter((t) => t.region === region && t.face === face).map((t) => t.size))].sort((a, b) => a - b);
          if (sizes('serif').length > 3) found.add(`${where}: ${region} holds serif sizes ${sizes('serif').join(', ')}`);
          if (sizes('mono').length > 2) found.add(`${where}: ${region} holds monospace sizes ${sizes('mono').join(', ')}`);
        }
      });
      assert.equal(states, 9, 'the start twice, three tabs of a paid run, three of a stopped run, and the audit');
      assert.deepEqual([...found], []);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

for (const mode of ['story', 'inspect']) {
  test(`${mode}: a card's title, the tab shown, the selected step's title on the sequence and on the trace, and the side panel's section heads are one style (value size, bold, the first ink); each number is at its title's size`, async () => {
    const view = await open({ width: 1440, height: 900, hash: `#${mode}` });
    const { page } = view;
    try {
      const tok = await page.evaluate(() => window.design.tokens());
      const value = mode === 'story' ? 18 : 15;
      const one = { size: value, weight: '700', colour: tok['--ink'] };
      const typeOf = (selector) => page.evaluate((s) => window.design.typeOf(s), selector);
      await runAndWait(view, 'clean', 'paid');
      await page.keyboard.press('2');
      await view.settle(60);

      const titles = await typeOf('#scenes .scene:not([aria-disabled="true"]) .scene-title');
      assert.equal(titles.length, 3);
      for (const t of titles) assert.deepEqual(t, one, 'a card\'s title');
      assert.deepEqual(await typeOf('#tabs .tab[aria-selected="true"]'), [one], 'the tab shown');
      assert.deepEqual(await typeOf('#rows .row[aria-current="step"] .row-title'), [one], 'the selected step on the sequence');
      const heads = await typeOf('#pane-inspector .insp-section-title');
      assert.ok(heads.length >= 3, `${heads.length} section heads`);
      for (const h of heads) assert.deepEqual(h, one, 'a section head of the side panel');
      // Tabs not shown: the second ink, regular weight, the same size.
      for (const t of await typeOf('#tabs .tab[aria-selected="false"]')) assert.deepEqual(t, { size: value, weight: '400', colour: tok['--ink-2'] }, 'a tab not shown');
      // The side panel's title, "Step n" included: head size, bold, the first ink.
      assert.deepEqual(await typeOf('#inspector-heading'), [{ size: mode === 'story' ? 20 : 18, weight: '700', colour: tok['--ink'] }]);
      for (const t of await typeOf('#inspector-heading *')) assert.deepEqual(t, { size: mode === 'story' ? 20 : 18, weight: '700', colour: tok['--ink'] }, 'the words of the side panel\'s title');

      const sizes = async (selector) => [...new Set((await typeOf(selector)).map((t) => t.size))];
      assert.deepEqual(await sizes('#scenes .scene-num'), [value], 'a card\'s number at its title\'s size');
      assert.deepEqual(await sizes('#rows .row-num'), [value], 'a step\'s number at its title\'s size');
      assert.deepEqual(await sizes('#rows .row-title'), [value]);
      // A number is regular and muted unless its step is selected.
      for (const n of await typeOf('#rows .row:not([aria-current="step"]) .row-num')) assert.deepEqual([n.weight, n.colour], ['400', tok['--muted']]);
      assert.deepEqual((await typeOf('#rows .row[aria-current="step"] .row-num')).map((n) => n.colour), [tok['--ink']]);

      await tab(view, 'trace');
      assert.deepEqual(await typeOf('#trace-body .trace-row[data-current="yes"] .trace-title'), [one], 'the selected step on the trace');
      assert.deepEqual(await sizes('#trace-body .trace-row[aria-level="1"] .trace-num'), [value], 'a trace number at its title\'s size');
      assert.deepEqual(await sizes('#trace-body .trace-row[aria-level="1"] .trace-title'), [value]);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('left edges agree: the side panel\'s title and its text; its section heads, open or closed; from 1440 px wide the trace\'s step title, its Start head and the sentence of the selected step', async () => {
  for (const [width, height, mode] of [[1440, 900, 'story'], [1728, 996, 'story'], [1920, 1080, 'story'], [1440, 900, 'inspect']]) {
    const view = await open({ width, height, hash: `#${mode}` });
    const { page } = view;
    const where = `${width}x${height} ${mode}`;
    try {
      const lefts = (selector) => page.evaluate((s) => window.design.leftsOf(s), selector);
      const spread = (xs) => Math.max(...xs) - Math.min(...xs);
      await runAndWait(view, 'clean', 'paid');
      await page.keyboard.press('2');
      await view.settle(60);
      const title = await lefts('#inspector-heading');
      const text = await lefts('#pane-inspector .insp-text');
      assert.ok(title.length === 1 && text.length >= 1, `${where}: a title and its text are shown`);
      assert.ok(Math.abs(title[0] - text[0]) <= 0.5, `${where}: the side panel's title starts at ${title[0]}, its text at ${text[0]}`);
      const sections = () => page.evaluate(() => [...document.querySelectorAll('#pane-inspector details.insp-section')].map((d) => d.open));
      if (new Set(await sections()).size === 1) { await page.click('#pane-inspector details.insp-section:last-of-type > summary'); await view.settle(60); }
      const heads = await lefts('#pane-inspector .insp-section-title');
      const open = await sections();
      assert.ok(open.includes(true) && open.includes(false), `${where}: one section open and one closed (${open})`);
      assert.ok(spread(heads) <= 0.5, `${where}: the section heads start at ${heads}`);

      await tab(view, 'trace');
      const edges = [...await lefts('#trace-body .trace-row[data-current="yes"] .trace-title'), ...await lefts('#trace-grid .trace-cols .trace-col:nth-child(2)'), ...await lefts('#trace-body .trace-row[data-current="yes"] > .trace-lens')];
      assert.equal(edges.length, 3, `${where}: the title, the Start head and the sentence are shown`);
      assert.ok(spread(edges) <= 1, `${where}: the title, the Start head and the sentence start at ${edges}`);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});

test('the light scheme lets the system smooth its type and the dark scheme keeps the thinner smoothing', async () => {
  for (const [scheme, smoothing] of [['light', 'auto'], ['dark', 'antialiased']]) {
    const view = await open({ width: 1440, height: 900, scheme });
    try {
      assert.equal(await view.page.evaluate(() => getComputedStyle(document.body).webkitFontSmoothing), smoothing, scheme);
    } finally {
      await view.close();
    }
  }
});

// A break inside a token is fair after a slash, a hyphen, a dot, a colon or
// an underscore, at the hump of a camel-cased name, and after every
// sixteenth digit of a long hash.
function fairBreak(text, at) {
  if (/^[0-9a-f]{32,}$/i.test(text)) return at % 16 === 0;
  return '/-.:_'.includes(text[at - 1]) || (/[a-z0-9]/.test(text[at - 1]) && /[A-Z]/.test(text[at]));
}

for (const [width, height, mode] of [[1440, 900, 'story'], [1440, 900, 'inspect'], [1280, 800, 'inspect']]) {
  test(`${width}x${height} ${mode}: a key of up to 24 letters stays on one line; an id, a path or a hash too long for its column breaks at a separator, a camel-case hump or a 16-digit group, and no line of it is shorter than four characters`, async () => {
    const view = await open({ width, height, hash: `#${mode}` });
    const { page } = view;
    try {
      const found = new Set();
      let keys = 0;
      let broken = 0;
      const check = async () => {
        await openSections(view);
        for (const t of await page.evaluate(() => window.design.wrapped())) {
          if (t.key) keys += 1;
          if (t.lines.length === 1) continue;
          broken += 1;
          const split = t.lines.join(' | ');
          if (t.key && t.text.length <= 24) found.add(`a key on ${t.lines.length} lines: ${split}`);
          if (t.lines.some((line) => line.length < 4)) found.add(`a line under four characters: ${split}`);
          let at = 0;
          for (const line of t.lines.slice(0, -1)) {
            at += line.length;
            if (!fairBreak(t.text, at)) found.add(`broken inside a word: ${split}`);
          }
        }
      };
      for (const [kind, end] of [['clean', 'paid'], ['poisoned', 'blocked']]) {
        await tab(view, 'sequence');
        await runAndWait(view, kind, end);
        for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
          await page.keyboard.press(key);
          await view.settle(60);
          await check();
        }
        await tab(view, 'records');
        await check();
      }
      await page.keyboard.press('o');
      await audited(page);
      await view.settle();
      await check();
      assert.ok(keys > 40, `${keys} keys read`);
      assert.deepEqual([...found], [], `${broken} tokens stand on more than one line`);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  });
}

test('the comparison says whose value each one is: a field the declared intent and the tool call agree on shows one value; the field that differs shows two labelled lines, the declared intent\'s value and the tool call\'s, the second highlighted, each with a note of whose account it is', async () => {
  for (const mode of ['story', 'inspect']) {
    const view = await open({ width: 1440, height: 900, hash: `#${mode}` });
    const { page } = view;
    try {
      const highlight = await page.evaluate(() => { const p = document.createElement('span'); p.style.color = 'var(--highlight)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
      await runAndWait(view, 'clean', 'paid');
      await page.keyboard.press('4');
      await view.settle(60);
      await openSections(view);
      const paid = await page.evaluate(() => window.design.comparison());
      const call = CLEAN_DONE.steps[3].detail.calls[0];
      assert.deepEqual(paid.map((c) => [c.tool, c.declared, c.heads]), [[call.tool, 'yes', 0]], `${mode}: one tool call, declared, with no column heads`);
      for (const field of paid[0].fields) {
        assert.deepEqual([field.differs, field.word, field.pairs.length, field.values.length], [false, null, 0, 1], `${mode}, paid: ${field.name} shows one value`);
        assert.equal(field.values[0], String(call.args[field.name] ?? CLEAN_DONE.steps[3].detail.declared[field.name]), `${mode}, paid: ${field.name}`);
      }

      await runAndWait(view, 'poisoned', 'blocked');
      await page.keyboard.press('4');
      await view.settle(60);
      await openSections(view);
      const stopped = await page.evaluate(() => window.design.comparison());
      const detail = POISONED.steps[3].detail;
      assert.deepEqual(stopped.map((c) => [c.tool, c.declared]), [[detail.calls[0].tool, 'no'], [detail.calls[1].tool, 'yes']]);
      const fields = stopped[1].fields;
      assert.deepEqual(fields.filter((f) => f.differs).map((f) => f.name), detail.calls[1].fieldsDiffering);
      for (const field of fields.filter((f) => !f.differs)) assert.deepEqual([field.pairs.length, field.values.length], [0, 1], `${mode}, stopped: ${field.name} shows one value`);
      const payee = fields.find((f) => f.name === 'payeeAccount');
      assert.equal(payee.word, COPY['intent.differs']);
      assert.deepEqual(payee.pairs.map((p) => [p.label, p.value, p.who]), [
        [COPY['intent.declared'], detail.declared.payeeAccount, COPY['intent.onInvoice']],
        [COPY['intent.call'], detail.calls[1].args.payeeAccount, COPY['intent.fromHidden']],
      ], `${mode}: each account under its label, with whose it is`);
      for (const text of [COPY['intent.declared'], COPY['intent.call'], COPY['intent.onInvoice'], COPY['intent.fromHidden']]) assert.ok(typeof text === 'string' && text.length > 0, 'the words are in the copy deck');
      assert.equal(detail.declared.payeeAccount, POISONED.invoice.payTo.account, 'the declared account is the one the invoice names');
      assert.equal(detail.calls[1].args.payeeAccount, POISONED.invoice.hidden.payToAccount, 'the account the agent tried is the one the hidden text names');
      assert.notEqual(payee.pairs[0].marked, highlight, `${mode}: the declared account is not highlighted`);
      assert.equal(payee.pairs[1].marked, highlight, `${mode}: the tool call's account is highlighted`);
      // Each label stands on its value's line, to its left.
      for (const p of payee.pairs) {
        assert.ok(p.labelBox[2] <= p.valueBox[0] + 1, `${mode}: "${p.label}" ends before its value starts (${p.labelBox} | ${p.valueBox})`);
        assert.ok(Math.abs((p.labelBox[1] + p.labelBox[3]) / 2 - (p.valueBox[1] + p.valueBox[3]) / 2) <= 6, `${mode}: "${p.label}" stands on its value's line (${p.labelBox} | ${p.valueBox})`);
      }
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});
