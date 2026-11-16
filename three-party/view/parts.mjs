// Pieces the flow and the inspector share: the state chip, the stand-in
// badge, the copy control, the grant countdown and the comparison of the
// declared intent with each tool call.

import { el, put, add, from, value, fieldName, at } from './dom.mjs';
import { iconEl, setIcon } from './icons.mjs';

// What the label map says about a status: its word, icon and tone. A status
// the map does not know is shown by its own value, with the neutral shape.
export function stateOf(app, status, source) {
  const meta = app.labels.states?.[status];
  if (!meta) return { word: { text: String(status), src: source }, icon: 'circle-outline', tone: 'neutral' };
  const word = app.w.chosen(meta.wordKey, source) ?? { text: String(status), src: source };
  return { word, icon: meta.icon, tone: meta.tone };
}

export function chip(state) {
  const node = el('span', { class: 'chip', data: { tone: state.tone } }, iconEl(state.icon), put('span', 'chip-word', state.word));
  return node;
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

// The grant countdown: a text and a thin bar. The page's one ticker keeps
// every countdown in the document current (tickCountdowns below).
export function countdown(app, expiresPath = 'grant.expiresAt') {
  const grant = app.run?.grant;
  if (!grant?.expiresAt || !grant?.ttlSeconds) return null;
  const node = el('div', { class: 'countdown', data: { expires: grant.expiresAt, ttl: String(grant.ttlSeconds), path: expiresPath } },
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

// The comparison the intent rule made: for each tool call, its arguments
// beside the declared intent, field by field. A field the run lists as
// differing is underlined and marked; a call with no declared intent says so
// in place of the declared column, with the run's own sentence beside it.
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
    const block = el('div', { class: 'compare-call', data: { tool: String(call.tool), declared: call.declaredFor === null || call.declaredFor === undefined ? 'no' : 'yes' } },
      el('div', { class: 'compare-title' },
        put('span', 'meta', app.w.word('intent.call')),
        put('span', 'mono', value(app.run, `${callBase}.tool`))));
    const grid = el('div', { class: 'compare-grid' });
    if (call.declaredFor === null || call.declaredFor === undefined || !declared) {
      const list = el('div', { class: 'compare-args' });
      for (const key of Object.keys(args)) {
        add(list,
          put('span', 'field', fieldName(app.run, `${callBase}.args.${key}`)),
          el('span', { class: 'cell' }, put('span', 'mono', value(app.run, `${callBase}.args.${key}`))));
      }
      add(block, list, el('div', { class: 'compare-title' },
        put('span', 'compare-none', app.w.chosen('intent.undeclared', from.run(`${callBase}.declaredFor`))),
        differing.length ? put('span', 'compare-why', value(app.run, `${callBase}.fieldsDiffering[0]`)) : null));
    } else {
      add(grid,
        el('span', { class: 'col-head col-pad' }),
        put('span', 'col-head', app.w.word('intent.declared')),
        put('span', 'col-head', app.w.word('intent.call')));
      const keys = [...Object.keys(declared), ...Object.keys(args).filter((k) => !(k in declared))];
      for (const key of keys) {
        const inDeclared = key in declared;
        const inArgs = key in args;
        const differs = differing.indexOf(key);
        // The field's name, with the word for a difference beside it; then
        // the two values, the call's underlined when it differs.
        add(grid,
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
