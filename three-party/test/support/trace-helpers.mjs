// What the tests of the trace, the step controls and the focus path share:
// the rows of the tree grid as the page shows them, a copy line with its
// placeholders filled, and the records manifest of the poisoned run, derived
// from the example files.

import { example, COPY, POISONED } from './view-helpers.mjs';

// A copy line with each {name} replaced by a value.
export function filled(key, values = {}) {
  let text = COPY[key];
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

// The poisoned run wrote four records: its pay step was not reached. The
// example manifest is the clean run's, with five. The manifest of the
// poisoned run is derived from it by keeping the records of the actions the
// poisoned state names; the tampered copy (of the pay record) goes with it.
export function poisonedManifest() {
  const manifest = example('manifest.json');
  const actions = POISONED.steps.map((s) => s.actionFile).filter(Boolean);
  return { ...manifest, runId: POISONED.runId, records: manifest.records.filter((r) => actions.includes(r.action)), tampered: [] };
}

// Every row of the trace's body, in the order of the page: its attributes,
// the text of each of its five cells, the state it shows and its bar.
export const traceRows = (page) => page.evaluate(() => [...document.querySelectorAll('#trace-body [role="row"]')].map((row) => {
  const cells = [...row.children].filter((c) => c.getAttribute('role') === 'gridcell');
  const [step, start, duration, state, time] = cells;
  const bar = time?.querySelector('.trace-bar');
  const lane = time?.querySelector('.trace-lane');
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  return {
    span: row.dataset.span,
    parent: row.dataset.parent ?? null,
    kind: row.dataset.kind ?? null,
    level: Number(row.getAttribute('aria-level')),
    posinset: Number(row.getAttribute('aria-posinset')),
    setsize: Number(row.getAttribute('aria-setsize')),
    expanded: row.getAttribute('aria-expanded'),
    selected: row.getAttribute('aria-selected'),
    current: row.dataset.current ?? null,
    tabindex: row.getAttribute('tabindex'),
    title: row.getAttribute('title'),
    status: row.dataset.status ?? null,
    tone: row.dataset.tone ?? null,
    icon: row.dataset.state ?? null,
    cells: cells.length,
    number: (() => { const n = step.querySelector('.trace-num'); return n && !n.hidden ? n.textContent : null; })(),
    name: (step.querySelector('.trace-title') ?? step).textContent,
    start: start.textContent,
    duration: duration.textContent,
    state: state.textContent,
    word: state.querySelector('.chip-word, .verdict > span')?.textContent ?? null,
    shown: state.querySelector('.icon')?.dataset.icon ?? null,
    why: [...state.querySelectorAll('.trace-why')].map((n) => n.textContent),
    field: state.querySelector('.mono')?.textContent ?? null,
    pill: state.querySelector('.trace-pill')?.textContent ?? null,
    decided: row.dataset.decided ?? null,
    headline: row.querySelector('.trace-stop-head')?.textContent ?? null,
    sentence: row.querySelector('.trace-stop-text')?.textContent ?? null,
    toggle: (() => { const t = row.querySelector('.trace-toggle'); return t && !t.hidden ? { label: t.getAttribute('aria-label'), labelledby: t.getAttribute('aria-labelledby'), tabindex: t.getAttribute('tabindex'), box: box(t) } : null; })(),
    lane: lane && !lane.hidden ? box(lane) : null,
    bar: bar && !bar.hidden ? { ...box(bar), fill: bar.dataset.fill } : null,
    box: box(row),
  };
}));

// The grid as a whole: its role and name, its column headers, the line
// under them, the line that closes it, and whether it scrolls.
export const traceGrid = (page) => page.evaluate(() => {
  const grid = document.getElementById('trace-grid');
  if (!grid) return null;
  const body = document.getElementById('trace-body');
  const shape = document.getElementById('trace-shape');
  return {
    role: grid.getAttribute('role'),
    label: grid.getAttribute('aria-label'),
    readonly: grid.getAttribute('aria-readonly'),
    headers: [...grid.querySelectorAll('.trace-cols [role="columnheader"]')].map((h) => ({ text: h.textContent, left: h.getBoundingClientRect().left })),
    shape: shape.textContent,
    shapeSize: parseFloat(getComputedStyle(shape).fontSize),
    shapeUnderHeaders: shape.getBoundingClientRect().top >= grid.querySelector('.trace-cols').getBoundingClientRect().bottom - 0.5,
    count: document.getElementById('trace-count').textContent,
    grid: [grid.scrollHeight, grid.clientHeight],
    body: [body.scrollHeight, body.clientHeight],
    scrollBehavior: getComputedStyle(body).scrollBehavior,
  };
});

// Show the trace with the T key, unless it is showing.
export async function showTrace(page) {
  if ((await page.evaluate(() => document.body.dataset.view)) !== 'trace') await page.keyboard.press('t');
  await page.waitForFunction(() => document.body.dataset.view === 'trace' && document.getElementById('trace-body') !== null);
}
