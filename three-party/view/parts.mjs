// Pieces the sequence, the trace, the records and the inspector share: the
// part a step belongs to and the form of it the run used, the state chip,
// the stand-in badge, the copy control, the grant countdown, the comparison
// of the declared intent with each tool call, the outcome headline and the
// lens lines.

import { el, put, from, value, fieldName, at, camel } from './dom.mjs';
import { iconEl, setIcon } from './icons.mjs';

export const baseId = (id) => String(id).replace(/-again$/, '');

// ---- Parts and columns

// The columns of the sequence, the part map, and the column every arrow
// starts from unless the label file names another (the party column: the
// one that is not a part of the map).
export function columnsOf(app) {
  const cols = app.labels.columns ?? [];
  const parts = app.labels.parts ?? {};
  const origin = Math.max(0, cols.findIndex((id) => !parts[id]));
  return { cols, parts, origin };
}

// The column a step's arrow ends at (the part that checks or answers) and
// the column it starts from (the party that acts, unless the label file
// names another for the step).
export function partOf(app, stepId) {
  const { cols, parts, origin } = columnsOf(app);
  const col = app.labels.stepColumns?.[stepId];
  const fromCol = app.labels.stepFrom?.[baseId(stepId)] ?? cols[origin];
  return { col, index: cols.indexOf(col), part: parts[col] ?? null, fromCol, fromIndex: cols.indexOf(fromCol) };
}

// A part as the run shown uses it: the variant of the label map that a step
// of the run names (the crossing's supplied capture check or its fallback),
// with the path of its strings in the map; the part itself when the run
// names none, and before a run.
// Before a run, the variant the server says a run started now would use.
export function shownPart(app, col) {
  const part = app.labels.parts?.[col] ?? null;
  const step = (app.run?.steps ?? []).find((s) => s.variant && app.labels.stepColumns?.[s.id] === col);
  const named = step ? step.variant : (app.run ? null : app.variants?.[col] ?? null);
  const variant = named && part?.variants && Object.hasOwn(part.variants, named) ? named : null;
  return variant ? { part: part.variants[variant], path: `parts.${col}.variants.${variant}` } : { part, path: `parts.${col}` };
}

// The title of a column: a part's label as the run uses it, or a party's role.
export function columnTitle(app, col) {
  const { parts } = columnsOf(app);
  return parts[col] ? app.w.label(`${shownPart(app, col).path}.label`) : app.w.label(`parties.${col}`);
}

// The small line under a column's title: who builds the part. A stand-in is
// never credited to the author of the part it stands in for.
export function creditOf(app, col) {
  const standIn = Boolean(shownPart(app, col).part?.standIn);
  return (standIn ? app.w.word(`credit.${col}StandIn`) : null) ?? (standIn ? null : app.w.word(`credit.${col}`));
}

// The detail line of a part (view/labels.json), shown where the part is set
// out in full. A variant that is not a stand-in has no detail line of its
// own: the line describes the part's base form.
export function detailOf(app, col) {
  const { part } = shownPart(app, col);
  const base = app.labels.parts?.[col];
  if (base?.variants && !part?.standIn) return null;
  return app.w.label(`parts.${col}.detail`);
}

// ---- States

// What the label map says about a status: its word, icon and tone. A status
// the map does not know is shown by its own value, with the neutral shape.
export function stateOf(app, status, source) {
  const meta = app.labels.states?.[status];
  if (!meta) return { word: { text: String(status), src: source }, icon: 'circle-outline', tone: 'neutral' };
  const word = app.w.chosen(meta.wordKey, source) ?? { text: String(status), src: source };
  return { word, icon: meta.icon, tone: meta.tone };
}

export function chip(state) {
  return el('span', { class: 'chip', data: { tone: state.tone } }, iconEl(state.icon), put('span', 'chip-word', state.word));
}

// Bring a chip that is already in the page to a new state. The element and
// its icon element stay, so the colours pass through the transition.
export function setChip(node, state) {
  node.dataset.tone = state.tone;
  setIcon(node.querySelector('.icon'), state.icon);
  const word = node.querySelector('.chip-word');
  if (word.textContent !== state.word.text) word.textContent = state.word.text;
  word.dataset.src = state.word.src;
}

export function badge(app) {
  return put('span', 'badge', app.w.word('marker.standIn'));
}

// A part's mark: its colour swatch and its label as the run uses it.
export function partMark(app, col, labelWords = null) {
  const words = labelWords ?? columnTitle(app, col);
  if (!words) return null;
  return el('span', { class: 'part-mark', data: { col } }, el('span', { class: 'swatch', 'aria-hidden': 'true' }), put('span', 'part-name', words));
}

// ---- Copy control

// A control that copies one value of the run. Its name says which value.
export function copyButton(app, text, path) {
  const idle = app.w.word('inspector.copy');
  const done = app.w.word('inspector.copied');
  if (!idle) return null;
  const button = el('button', { class: 'copy-btn', type: 'button', src: idle.src, text: idle.text, 'aria-label': `${idle.text} ${path}`, data: { focusKey: `copy:${path}` } });
  let timer = null;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(text));
    } catch {
      return;
    }
    if (!done) return;
    button.textContent = done.text;
    button.dataset.src = done.src;
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = idle.text;
      button.dataset.src = idle.src;
    }, 2000);
  });
  return button;
}

// ---- Grant countdown

// The grant countdown: a text and a thin bar. The page's one ticker keeps
// every countdown in the document current (tickCountdowns below).
export function countdown(app, expiresPath = 'grant.expiresAt') {
  const grant = app.run?.grant;
  if (!grant?.expiresAt || !grant?.ttlSeconds) return null;
  const node = el('span', { class: 'countdown', data: { expires: grant.expiresAt, ttl: String(grant.ttlSeconds), path: expiresPath } },
    el('span', { class: 'countdown-text num' }),
    el('span', { class: 'countdown-track' }, el('span', { class: 'countdown-fill' })));
  paintCountdown(app, node, true);
  return node;
}

function mmss(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function paintCountdown(app, node, fresh) {
  const expires = Date.parse(node.dataset.expires);
  const ttl = Number(node.dataset.ttl) * 1000;
  const left = expires - Date.now();
  const text = node.querySelector('.countdown-text');
  const fill = node.querySelector('.countdown-fill');
  if (!(left > 0)) {
    const done = app.w.word('detail.countdownDone');
    node.dataset.done = 'yes';
    node.dataset.expiring = 'no';
    if (done) { text.textContent = done.text; text.dataset.src = done.src; }
    fill.style.width = '0%';
    return;
  }
  const seconds = Math.ceil(left / 1000);
  const line = app.w.line('detail.countdown', { mmss: [mmss(seconds), from.clock(node.dataset.path)] });
  node.dataset.done = 'no';
  node.dataset.expiring = seconds <= Number(app.labels.countdown?.expiringSeconds ?? 0) ? 'yes' : 'no';
  if (line) { text.textContent = line.text; text.dataset.src = line.src; }
  // With motion, the bar travels during the coming second to where the time
  // will be then; a fresh bar, and a bar under reduced motion, shows now.
  const still = fresh || app.reducedMotion;
  const shown = still ? left : Math.max(0, left - 1000);
  fill.style.width = `${Math.max(0, Math.min(100, (shown / ttl) * 100))}%`;
}

// Repaint every countdown in the page; returns the milliseconds until the
// next whole second of the nearest one, or null when none is running.
export function tickCountdowns(app, root = document) {
  let next = null;
  for (const node of root.querySelectorAll('.countdown')) {
    paintCountdown(app, node, false);
    const left = Date.parse(node.dataset.expires) - Date.now();
    if (left > 0) {
      const wait = left % 1000 || 1000;
      next = next === null ? wait : Math.min(next, wait);
    }
  }
  return next;
}

// ---- The intent rule's comparison

// The comparison the intent rule made: for each tool call, its arguments
// beside the declared intent, field by field. A field the run lists as
// differing is marked and its value highlighted; a call with no declared
// intent says so in place of the declared column, with the run's own words
// beside it.
export function compare(app, stepIndex) {
  const base = `steps[${stepIndex}].detail`;
  const detail = at(app.run, base);
  if (!detail || !Array.isArray(detail.calls)) return null;
  const declared = detail.declared && typeof detail.declared === 'object' ? detail.declared : null;
  const root = el('div', { class: 'compare' });
  detail.calls.forEach((call, c) => {
    const callBase = `${base}.calls[${c}]`;
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const differing = Array.isArray(call.fieldsDiffering) ? call.fieldsDiffering : [];
    const bare = call.declaredFor === null || call.declaredFor === undefined || !declared;
    const block = el('div', { class: 'compare-call', data: { tool: String(call.tool), declared: bare ? 'no' : 'yes' } },
      el('div', { class: 'compare-title' },
        put('span', 'meta', app.w.word('intent.call')),
        put('span', 'mono', value(app.run, `${callBase}.tool`))));
    if (bare) {
      const list = el('div', { class: 'compare-args' });
      for (const key of Object.keys(args)) {
        list.append(
          put('span', 'field', fieldName(app.run, `${callBase}.args.${key}`)),
          el('span', { class: 'cell' }, put('span', 'mono', value(app.run, `${callBase}.args.${key}`))));
      }
      block.append(list, el('div', { class: 'compare-verdict' },
        put('span', 'compare-none', app.w.chosen('intent.undeclared', from.run(`${callBase}.declaredFor`)))));
    } else {
      const grid = el('div', { class: 'compare-grid' },
        el('span', { class: 'col-head col-pad' }),
        put('span', 'col-head', app.w.word('intent.declared')),
        put('span', 'col-head', app.w.word('intent.call')));
      const keys = [...Object.keys(declared), ...Object.keys(args).filter((k) => !(k in declared))];
      for (const key of keys) {
        const inDeclared = key in declared;
        const inArgs = key in args;
        const differs = differing.indexOf(key);
        grid.append(
          el('span', { class: 'field', data: differs >= 0 ? { field: key, differs: 'yes' } : { field: key } },
            put('span', null, fieldName(app.run, inDeclared ? `${base}.declared.${key}` : `${callBase}.args.${key}`)),
            differs >= 0 ? put('span', 'differs-word', app.w.chosen('intent.differs', from.run(`${callBase}.fieldsDiffering[${differs}]`))) : null),
          el('span', { class: 'cell' }, inDeclared ? put('span', 'mono', value(app.run, `${base}.declared.${key}`)) : null),
          el('span', { class: 'cell' },
            inArgs ? put('span', 'mono diff', value(app.run, `${callBase}.args.${key}`), { 'data-differs': differs >= 0 ? 'yes' : 'no' }) : null));
      }
      block.append(grid);
    }
    root.append(block);
  });
  return root;
}

// ---- Outcome and lens

// The key of the outcome headline for a run, by the label map.
export function headlineOf(app, run) {
  const map = app.labels.outcomeHeadlines ?? {};
  if (!run || !run.outcome) return { key: map.running, source: from.run('outcome'), tone: 'neutral' };
  if (run.outcome === 'blocked') {
    const key = map[`blocked:${run.blockedAt}`] ?? map.blocked;
    return { key, source: from.run('blockedAt'), tone: 'stop' };
  }
  return { key: map[run.outcome], source: from.run('outcome'), tone: run.outcome === 'paid' ? 'ok' : 'neutral' };
}

// The lenses the label file names, and the one in use.
export function lensesOf(app) {
  return Array.isArray(app.labels.lenses) ? app.labels.lenses.filter((l) => l && typeof l.id === 'string') : [];
}

export function lensOf(app) {
  const all = lensesOf(app);
  return all.find((l) => l.id === app.lens) ?? all[0] ?? { id: app.lens, sections: ['checked', 'artifact', 'record'] };
}

// What a step means for the reader the lens names: one sentence of the deck,
// the same whatever the step's state. Null for a step the deck has no line for.
export function lensStepLine(app, i) {
  const step = app.run?.steps?.[i];
  if (!step) return null;
  return app.w.chosen(`lens.${lensOf(app).id}.${camel(baseId(step.id))}`, from.run(`steps[${i}].id`));
}

// The outcome in the lens's words, with the run's own values where the line
// names them; the run's own reason for an outcome the deck has no line for.
export function lensOutcomeLine(app) {
  const run = app.run;
  if (!run?.outcome) return null;
  const lens = lensOf(app).id;
  if (run.outcome === 'paid') {
    const i = run.steps.findIndex((s) => baseId(s.id) === 'pay' && s.detail?.paymentId);
    const d = i >= 0 ? run.steps[i].detail : {};
    const base = `steps[${i}].detail`;
    const fills = {
      amount: [d.amount, from.run(`${base}.amount`)],
      currency: [d.currency, from.run(`${base}.currency`)],
      account: [d.payeeAccount, from.run(`${base}.payeeAccount`)],
    };
    return app.w.lineNodes(`lens.${lens}.paid`, fills, ['account']) ?? value(run, 'reason');
  }
  if (run.outcome === 'blocked' && run.blockedAt === 'intent') {
    const i = run.steps.findIndex((s) => s.id === run.blockedAt);
    return app.w.line(`lens.${lens}.blockedIntent`, { n: [i >= 0 ? String(i + 1) : null, from.run(`steps[${i}]`, 'ordinal')] }) ?? value(run, 'reason');
  }
  return value(run, 'reason');
}
