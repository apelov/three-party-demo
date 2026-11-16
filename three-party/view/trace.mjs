// The trace: the run again, one row per step, each with its start, how long
// it took, its state and a bar on one time lane; and under a step, the rows
// of what happened inside it (the declared intent and each tool call, each
// name a check read, each record written). It is drawn from the run state
// the flow is drawn from, so the two never disagree, and it asks the server
// for nothing of its own.
//
// A row is an object with the field names a distributed trace uses where the
// run carries the same thing: traceId, spanId, parentSpanId, name, startTime,
// endTime, status (code and message), attributes, events and resource. The
// ids stay the run's own strings and the times stay its RFC 3339 strings, so
// this is the shape of a trace and not an export of one; the screen says so.
// A field the run does not carry is left out.

import { el, put, from, value, clear, camel, secondsBetween } from './dom.mjs';
import { stateOf, chip, setChip, headlineOf } from './parts.mjs';
import { iconEl } from './icons.mjs';
import { STEP_ORDER, OFFLINE_KIND } from './constants.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const OK = 'STATUS_CODE_OK';
const ERROR = 'STATUS_CODE_ERROR';
const UNSET = 'STATUS_CODE_UNSET';
const CODES = Object.freeze({ passed: OK, written: OK, blocked: ERROR });
// The statuses whose row carries a bar on the lane, and the bar's fill.
const FILLS = Object.freeze({ running: 'accent', passed: 'accent', written: 'accent', blocked: 'stop', expired: 'warn' });
const COLUMNS = Object.freeze(['trace.colStep', 'trace.colStart', 'trace.colDuration', 'trace.colState', 'trace.colLane']);

const baseId = (id) => String(id).replace(/-again$/, '');
const bare = (call) => call.declaredFor === null || call.declaredFor === undefined;

// ---- The rows, as objects

function row(traceId, spanId, parentSpanId, name, startTime, endTime, code, message, attributes, events, resource) {
  return { traceId, spanId, parentSpanId, name, startTime, endTime, status: { code, message }, attributes, events, resource };
}

// The tool call that decided a stopped intent step: by the rule's own result,
// the earliest call that differs from its declared intent, or, when every
// held call matched, the earliest call with no declared intent. -1 when no
// call was blocked.
export function decidedCall(detail) {
  const calls = Array.isArray(detail?.calls) ? detail.calls : [];
  const blocked = calls.map((call, n) => (call.match === false ? n : -1)).filter((n) => n >= 0);
  if (!blocked.length) return -1;
  if (detail.result === 'mismatch') return blocked.find((n) => !bare(calls[n])) ?? blocked[0];
  if (detail.result === 'undeclared-call') return blocked.find((n) => bare(calls[n])) ?? blocked[0];
  return blocked[0];
}

// Every row of a run: one per step and, after each step, the rows inside it;
// then the offline check and its records once the check has run. manifest is
// the records manifest of the run and offline the offline check's result,
// each null until the page holds it.
export function rowsOfRun(run, { manifest = null, offline = null } = {}) {
  const rows = [];
  for (const step of run.steps) {
    const detail = step.detail && typeof step.detail === 'object' ? step.detail : null;
    const resource = { part: step.part ?? null, partLabel: step.partLabel ?? null };
    const events = Array.isArray(detail?.events) ? detail.events : [];
    rows.push(row(run.runId, step.id, null, step.title ?? null, step.startedAt ?? null, step.endedAt ?? null,
      CODES[step.status] ?? UNSET, step.id === run.blockedAt ? run.reason ?? null : null, step.detail ?? null, events, resource));
    const inside = (kind, n, name, code, attributes, startTime = null) => rows.push(row(run.runId, `${step.id}/${kind}/${n}`, step.id, name ?? null, startTime, null, code, null, attributes ?? null, [], resource));
    // A step that carries its own events shows those, each at its own time.
    if (events.length) {
      events.forEach((event, n) => inside('event', n, event?.name, UNSET, event?.attributes, event?.at ?? null));
      continue;
    }
    if (!detail) continue;
    const id = baseId(step.id);
    if (id === 'credential' && detail.verifier) inside('check', 0, detail.verifier, UNSET, null);
    if (id === 'grant' && Array.isArray(detail.scopeChecked)) detail.scopeChecked.forEach((name, n) => inside('check', n, name, UNSET, null));
    // The AI2II capture check: one row per check, with its answer.
    if (id === 'crossing' && detail.capture?.used === true && Array.isArray(detail.capture.checks)) {
      detail.capture.checks.forEach((check, n) => inside('check', n, check.name, check.answer === 'pass' ? OK : ERROR, check));
    }
    if (id === 'intent' && Array.isArray(detail.calls)) {
      if (detail.declared && typeof detail.declared === 'object') inside('declared', 0, null, UNSET, detail.declared);
      detail.calls.forEach((call, n) => inside('call', n, call.tool, call.match === true ? OK : ERROR, call));
    }
    if (id === 'record' && Array.isArray(manifest?.records)) manifest.records.forEach((record, n) => inside('record', n, record.file, OK, record));
  }
  if (offline && typeof offline === 'object') {
    rows.push(row(run.runId, OFFLINE_KIND, null, null, offline.at ?? null, null, UNSET, null, null, [], null));
    for (const kind of ['records', 'tampered']) {
      (Array.isArray(offline[kind]) ? offline[kind] : []).forEach((record, n) => rows.push(row(run.runId, `${OFFLINE_KIND}/${kind}/${n}`, OFFLINE_KIND, record.file ?? null, null, null, record.verdict === 'pass-1-6' ? OK : ERROR, null, record, [], null)));
    }
  }
  return rows;
}

// ---- The rows the page shows now

function offlineOf(app) {
  return app.offline && app.offline.runId === app.runId ? app.offline.result : null;
}

// The step rows in order, each with the rows inside it and whether they are
// open. Before a run: the steps of the contract, as the flow lists them.
// During a replay the steps not yet reached are veiled: they show as pending
// and carry nothing of the run.
function shownRows(app) {
  const run = app.run;
  if (!run) return STEP_ORDER.map((id, index) => ({ id, index, preview: true, veiled: false, kids: [], open: false }));
  const reached = app.replay ? app.replay.n : Infinity;
  const writer = run.steps.findIndex((s) => baseId(s.id) === 'record' && s.recordFile);
  const entry = writer >= 0 && writer < reached ? app.fileOf(run.steps[writer].recordFile) : null;
  const manifest = entry?.state === 'ready' && entry.file.kind === 'json' ? entry.file.value : null;
  const tops = [];
  const byId = new Map();
  for (const span of rowsOfRun(run, { manifest, offline: offlineOf(app) })) {
    if (span.parentSpanId === null) {
      const index = run.steps.findIndex((s) => s.id === span.spanId);
      const top = { id: span.spanId, span, index, preview: false, veiled: index >= reached, kids: [], open: false };
      byId.set(top.id, top);
      tops.push(top);
    } else {
      const [, kind, n] = /\/([a-z]+)\/(\d+)$/.exec(span.spanId);
      const top = byId.get(span.parentSpanId);
      if (!top.veiled) top.kids.push({ id: span.spanId, span, top, kind, n: Number(n) });
    }
  }
  const rule = app.mode === 'story' ? app.labels.trace?.nestedInStory : app.labels.trace?.nestedInInspect;
  for (const top of tops) {
    const byRule = rule === 'all' || (rule === 'decided' && top.index >= 0 && run.steps[top.index].id === run.blockedAt);
    top.open = top.kids.length > 0 && (app.traceOpen.get(top.id) ?? byRule);
  }
  return tops;
}

// ---- Timing

// The lane: where it starts and how long it is, in milliseconds. It is as
// long as the label map says while the run goes on, and as long as the run
// once the run has finished.
function laneOf(app) {
  const run = app.run;
  if (!run) return null;
  const t0 = Date.parse(run.startedAt);
  const whole = run.finishedAt ? Date.parse(run.finishedAt) - t0 : NaN;
  const span = whole > 0 ? whole : Number(app.labels.trace?.laneSeconds) * 1000;
  return Number.isFinite(t0) && span > 0 ? { t0, span } : null;
}

function offsetWords(app, time, path) {
  const seconds = secondsBetween(app.run.startedAt, time);
  return seconds === null ? null : app.w.line('trace.offset', { seconds: [seconds, from.run(path, 'sinceStart')] });
}

// How long a step took; for a step still being checked, how long it has
// taken so far on the browser clock.
function durationWords(app, step, path, now) {
  if (!step.startedAt) return null;
  if (step.endedAt) {
    const seconds = secondsBetween(step.startedAt, step.endedAt);
    return seconds === null ? null : app.w.line('trace.duration', { seconds: [seconds, from.run(path, 'span')] });
  }
  const started = Date.parse(step.startedAt);
  if (step.status !== 'running' || Number.isNaN(started)) return null;
  return app.w.line('trace.soFar', { seconds: [String(Math.max(0, Math.floor((now - started) / 1000))), from.clock(`${path}.startedAt`, 'since')] });
}

// Put a bar on its lane: its left edge at the start and its width the time
// taken, over the lane's span. With no time, or no fill, the bar is left out.
function paintBar(bar, lane, start, end, fill) {
  const from0 = Date.parse(start);
  if (!lane || !fill || Number.isNaN(from0)) {
    bar.hidden = true;
    return;
  }
  const left = Math.max(0, Math.min(100, ((from0 - lane.t0) / lane.span) * 100));
  const width = Math.max(0, Math.min(100 - left, ((Math.max(end, from0) - from0) / lane.span) * 100));
  bar.hidden = false;
  bar.dataset.fill = fill;
  bar.style.insetInlineStart = `${left.toFixed(3)}%`;
  bar.style.width = `${width.toFixed(3)}%`;
}

// ---- Elements

function setText(node, w) {
  if (!w) {
    if (node.firstChild) node.replaceChildren();
    delete node.dataset.src;
    return;
  }
  if (node.dataset.src === w.src && node.textContent === w.text) return;
  if (w.nodes) node.replaceChildren(...w.nodes); else node.textContent = w.text;
  node.dataset.src = w.src;
}

// The mark on the control that opens and closes the rows inside a step.
function chevron() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'trace-chevron');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

const cell = (cls, ...kids) => el('span', { class: cls, role: 'gridcell' }, kids);

function buildTop(top) {
  const node = el('div', { class: 'trace-row', role: 'row', 'aria-level': '1', tabindex: '-1', data: { span: top.id, index: String(top.index) } });
  node.append(
    cell('trace-step',
      el('button', { class: 'trace-toggle', type: 'button', tabindex: '-1', hidden: true }, chevron()),
      el('span', { class: 'trace-num num' }),
      el('span', { class: 'trace-title', id: `trace-title-${top.id}` })),
    cell('trace-start num'),
    cell('trace-dur num'),
    cell('trace-state'),
    cell('trace-time', el('span', { class: 'trace-lane' }, el('span', { class: 'trace-bar', hidden: true }))));
  return node;
}

// What a step row shows now: its number and title, its state, its start and
// how long it took, its bar, and for the stopped step the headline and the
// run's sentence.
function topFacts(app, top, now) {
  const run = app.run;
  if (top.preview) {
    const source = from.constant(`stepOrder[${top.index}]`);
    return { n: null, number: { text: String(top.index + 1), src: `${source}|ordinal` }, title: app.w.word(`step.${camel(top.id)}`), status: 'pending', state: stateOf(app, 'pending', source) };
  }
  if (top.index < 0) {
    const result = offlineOf(app);
    return { n: null, title: app.w.word('trace.offlineRow'), start: value(result, 'at', 'clock', (path, shape) => from.doc('offline-check', path, shape)) };
  }
  const i = top.index;
  const step = run.steps[i];
  const path = `steps[${i}]`;
  const facts = { n: i + 1, number: { text: String(i + 1), src: from.run(path, 'ordinal') }, title: value(run, `${path}.title`) };
  if (top.veiled) return { ...facts, status: 'pending', state: stateOf(app, 'pending', from.view('replay')) };
  const status = step.status;
  const headline = status === 'blocked' ? headlineOf(app, run) : null;
  return {
    ...facts,
    status,
    state: stateOf(app, status, from.run(`${path}.status`)),
    start: step.startedAt ? offsetWords(app, step.startedAt, `${path}.startedAt`) : null,
    duration: durationWords(app, step, path, now),
    bar: FILLS[status] && step.startedAt ? { start: step.startedAt, end: step.endedAt ? Date.parse(step.endedAt) : now, fill: FILLS[status] } : null,
    stopped: headline ? { headline: app.w.chosen(headline.key, headline.source), reason: value(run, 'reason') } : null,
  };
}

function updateTop(app, node, top, at, of, lane, now) {
  const facts = topFacts(app, top, now);
  const [stepCell, startCell, durCell, stateCell, timeCell] = node.children;
  const [toggle, number, title] = stepCell.children;
  const bar = timeCell.firstElementChild.firstElementChild;

  node.setAttribute('aria-posinset', String(at));
  node.setAttribute('aria-setsize', String(of));
  if (facts.status) {
    node.dataset.status = facts.status;
    node.dataset.tone = facts.state.tone;
    node.dataset.state = facts.state.icon;
  }
  const open = app.w.line('trace.openStep', { n: [facts.n, from.run(`steps[${top.index}]`, 'ordinal')] });
  if (open) node.setAttribute('title', open.text); else node.removeAttribute('title');

  // The control that opens the rows inside: on a row that has some.
  if (top.kids.length) {
    node.setAttribute('aria-expanded', top.open ? 'true' : 'false');
    const name = app.w.line(top.open ? 'trace.collapse' : 'trace.expand', { n: [facts.n, from.run(`steps[${top.index}]`, 'ordinal')] });
    if (name) {
      toggle.setAttribute('aria-label', name.text);
      toggle.removeAttribute('aria-labelledby');
    } else {
      toggle.removeAttribute('aria-label');
      toggle.setAttribute('aria-labelledby', title.id);
    }
    toggle.firstElementChild.firstElementChild.setAttribute('d', top.open ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5');
    toggle.hidden = false;
  } else {
    node.removeAttribute('aria-expanded');
    toggle.hidden = true;
  }

  setText(number, facts.number ?? null);
  number.hidden = !facts.number;
  setText(title, facts.title ?? null);
  setText(startCell, facts.start ?? null);
  setText(durCell, facts.duration ?? null);
  if (facts.state) {
    if (stateCell.firstElementChild) setChip(stateCell.firstElementChild, facts.state); else stateCell.append(chip(facts.state));
  }
  if (facts.bar) paintBar(bar, lane, facts.bar.start, facts.bar.end, facts.bar.fill); else bar.hidden = true;
  timeCell.firstElementChild.hidden = top.index < 0 && !top.preview;

  // The stopped step: the headline and the run's sentence, under its cells.
  let stop = node.querySelector(':scope > .trace-stop');
  if (facts.stopped) {
    if (!stop) {
      stop = el('span', { class: 'trace-stop', role: 'gridcell', 'aria-colspan': String(COLUMNS.length) }, el('span', { class: 'trace-stop-head' }), el('span', { class: 'trace-stop-text' }));
      node.append(stop);
    }
    setText(stop.firstElementChild, facts.stopped.headline);
    setText(stop.lastElementChild, facts.stopped.reason);
    node.dataset.outcome = 'blocked';
  } else {
    stop?.remove();
    delete node.dataset.outcome;
  }
}

// The words of a verdict beside its icon, as the inspector sets them.
function verdictEl(app, tone, icon, words) {
  return words ? el('span', { class: 'verdict', data: { tone } }, iconEl(icon), put('span', null, words)) : null;
}

// A row inside a step. It is built whole: what it shows changes when the
// run's own values change and at no other time, and then it is built again.
function buildKid(app, kid, at, of) {
  const run = app.run;
  const { top, kind, n, span } = kid;
  const i = top.index;
  const base = `steps[${i}].detail`;
  const states = app.labels.states ?? {};
  let name = null;
  let start = null;
  let duration = app.w.word('trace.notTimed');
  let state = null;
  let lane = null;
  let decided = false;

  if (kind === 'check' && baseId(run.steps[i].id) === 'crossing') {
    const path = `${base}.capture.checks[${n}]`;
    const pass = span.attributes?.answer === 'pass';
    name = app.w.lineNodes('trace.check', { name: [span.name, from.run(`${path}.name`)] }, ['name']);
    state = verdictEl(app, pass ? 'ok' : 'stop', pass ? states.passed?.icon : states.blocked?.icon, value(run, `${path}.answer`));
  } else if (kind === 'check') {
    const path = baseId(run.steps[i].id) === 'credential' ? `${base}.verifier` : `${base}.scopeChecked[${n}]`;
    name = app.w.lineNodes('trace.check', { name: [span.name, from.run(path)] }, ['name']);
  } else if (kind === 'declared') {
    name = app.w.word('trace.declared');
  } else if (kind === 'call') {
    const path = `${base}.calls[${n}]`;
    const call = run.steps[i].detail.calls[n];
    const allowed = call.match === true;
    const differing = Array.isArray(call.fieldsDiffering) ? call.fieldsDiffering : [];
    decided = run.steps[i].id === run.blockedAt && decidedCall(run.steps[i].detail) === n;
    name = app.w.lineNodes('trace.call', { tool: [span.name, from.run(`${path}.tool`)] }, ['tool']);
    state = [
      verdictEl(app, allowed ? 'ok' : 'stop', allowed ? states.passed?.icon : states.blocked?.icon, app.w.chosen(allowed ? 'decision.allowed' : 'decision.blocked', from.run(`${path}.match`))),
      allowed ? null : bare(call) ? put('span', 'trace-why', app.w.chosen('intent.undeclared', from.run(`${path}.declaredFor`)))
        : differing.length ? [put('span', 'trace-why', app.w.chosen('intent.differs', from.run(`${path}.fieldsDiffering[0]`))), put('span', 'mono', value(run, `${path}.fieldsDiffering[0]`))] : null,
      decided ? put('span', 'trace-pill', app.w.chosen('trace.decidedHere', from.run('blockedAt'))) : null,
    ];
  } else if (kind === 'record') {
    const source = (path, shape) => from.file(run.steps[i].recordFile, path, shape);
    const written = stateOf(app, 'written', source(`records[${n}].file`));
    name = app.w.lineNodes('trace.record', { file: [span.name, source(`records[${n}].file`)] }, ['file']);
    state = verdictEl(app, written.tone, written.icon, written.word);
  } else if (kind === 'event') {
    name = value(run, `${base}.events[${n}].name`);
    start = span.startTime ? offsetWords(app, span.startTime, `${base}.events[${n}].at`) : null;
    duration = null;
    lane = span.startTime;
  } else {
    // A record of the offline check: its verdict in the deck's words.
    const source = (path, shape) => from.doc('offline-check', `${kind}[${n}].${path}`, shape);
    const record = span.attributes;
    const pass = record.verdict === 'pass-1-6';
    const tampered = kind === 'tampered';
    name = app.w.lineNodes('trace.record', { file: [span.name, source('file')] }, ['file']);
    state = verdictEl(app, pass ? (tampered ? 'warn' : 'ok') : (tampered ? 'neutral' : 'stop'), pass ? states.passed?.icon : states.blocked?.icon,
      pass ? app.w.chosen('offline.pass', source('verdict')) : app.w.line('offline.reject', { n: [record.firstFailingStep, source('firstFailingStep')] }));
  }

  const open = i >= 0 ? app.w.line('trace.openStep', { n: [i + 1, from.run(`steps[${i}]`, 'ordinal')] }) : null;
  const node = el('div', { class: lane ? 'trace-row trace-nested trace-timed' : 'trace-row trace-nested', role: 'row', 'aria-level': '2', 'aria-posinset': String(at), 'aria-setsize': String(of), tabindex: '-1', title: open?.text, data: { span: kid.id, parent: top.id, index: String(i), kind, n: String(n), decided: decided ? 'yes' : null } });
  const stepCell = cell('trace-step');
  setText(stepCell, name);
  const startCell = cell('trace-start num');
  setText(startCell, start);
  const durCell = cell('trace-dur num');
  setText(durCell, duration);
  const timeCell = cell('trace-time');
  if (lane) {
    const bar = el('span', { class: 'trace-bar' });
    timeCell.append(el('span', { class: 'trace-lane' }, bar));
    paintBar(bar, laneOf(app), lane, Date.parse(lane), 'accent');
  }
  node.append(stepCell, startCell, durCell, cell('trace-state', state), timeCell);
  return node;
}

// What a row inside a step is built from: when this changes the row is
// built again.
function kidSignature(app, kid, at, of) {
  return [app.labelsStamp, app.runStamp, app.filesStamp, app.offlineStamp, at, of].join('|');
}

// The row the selection rests on: the row inside a step that was opened
// from the trace, else the row of the selected step, else none.
function selectedSpan(app, tops) {
  const sel = app.selection;
  const top = sel.kind === 'offline' ? tops.find((t) => t.id === OFFLINE_KIND) : sel.kind === 'step' ? tops.find((t) => t.index === sel.index) : null;
  if (!top) return { top: null, row: null };
  const kid = sel.item && top.open ? top.kids.find((k) => k.kind === sel.item.kind && k.n === sel.item.n) : null;
  return { top: top.id, row: kid ? kid.id : top.id };
}

function buildFrame(app, host) {
  const head = el('div', { class: 'trace-head', role: 'rowgroup' },
    el('div', { class: 'trace-cols', role: 'row' }, COLUMNS.map((key) => put('span', 'trace-col', app.w.word(key), { role: 'columnheader' }))),
    el('div', { class: 'trace-note', role: 'row' }, put('span', 'trace-shape', app.w.word('trace.shape'), { role: 'gridcell', id: 'trace-shape', 'aria-colspan': String(COLUMNS.length) })));
  const body = el('div', { class: 'trace-body', role: 'rowgroup', id: 'trace-body' });
  host.append(
    el('div', { class: 'trace-grid', id: 'trace-grid', role: 'treegrid', 'aria-readonly': 'true', 'aria-describedby': 'trace-shape' }, head, body),
    el('p', { class: 'trace-count', id: 'trace-count' }));
}

// Bring the trace to the run. The rows stay where they are from one state to
// the next (a step row is brought up to date in place, so its bar and its
// state pass through the transitions of the stylesheet), and the focus stays
// on the row that held it.
export function renderTrace(app, host) {
  if (app.view !== 'trace') {
    host.hidden = true;
    if (host.firstElementChild) clear(host);
    delete host.dataset.frame;
    return;
  }
  host.hidden = false;
  const frame = String(app.labelsStamp);
  if (host.dataset.frame !== frame) {
    clear(host);
    buildFrame(app, host);
    host.dataset.frame = frame;
  }
  const grid = host.firstElementChild;
  const body = grid.lastElementChild;
  const run = app.run;
  const name = run ? app.w.line('trace.name', { runId: [run.runId, from.run('runId')] }) : app.w.word('view.trace');
  if (name) grid.setAttribute('aria-label', name.text);
  grid.dataset.run = run ? 'yes' : 'no';

  // The row that holds the focus, read before any row is taken away.
  const active = document.activeElement;
  const held = body.contains(active) ? active.closest('[role="row"]').dataset.span : null;

  // A run of its own starts from rows of its own.
  const key = run ? app.runId : 'preview';
  if (body.dataset.run !== key) {
    clear(body);
    body.dataset.run = key;
  }
  const tops = shownRows(app);
  const lane = laneOf(app);
  const now = Date.now();
  const kept = new Map([...body.children].map((node) => [node.dataset.span, node]));
  const selected = selectedSpan(app, tops);
  let cursor = body.firstElementChild;
  let count = 0;
  const place = (node) => {
    if (node === cursor) cursor = cursor.nextElementSibling; else body.insertBefore(node, cursor);
    count += 1;
  };
  const mark = (node, id) => {
    if (selected.row === id) node.setAttribute('aria-selected', 'true'); else node.removeAttribute('aria-selected');
  };

  tops.forEach((top, t) => {
    let node = kept.get(top.id);
    kept.delete(top.id);
    if (!node) node = buildTop(top);
    updateTop(app, node, top, t + 1, tops.length, lane, now);
    node.dataset.current = selected.top === top.id ? 'yes' : 'no';
    mark(node, top.id);
    place(node);
    if (!top.open) return;
    top.kids.forEach((kid, k) => {
      const signature = kidSignature(app, kid, k + 1, top.kids.length);
      let inner = kept.get(kid.id);
      kept.delete(kid.id);
      if (!inner || inner.dataset.signature !== signature) {
        const fresh = buildKid(app, kid, k + 1, top.kids.length);
        fresh.dataset.signature = signature;
        if (inner) {
          if (inner === cursor) cursor = cursor.nextElementSibling;
          inner.remove();
        }
        inner = fresh;
      }
      mark(inner, kid.id);
      place(inner);
    });
  });
  for (const stale of kept.values()) stale.remove();

  // One tab stop for the grid: the selected row, or the leading row.
  const stop = body.querySelector('[aria-selected="true"]') ?? body.firstElementChild;
  for (const node of body.children) node.setAttribute('tabindex', node === stop ? '0' : '-1');

  // The focus stays in the grid: on the row that held it, or, when that row
  // is no longer shown, on the row of its step.
  if (held && !body.contains(document.activeElement)) {
    const again = [...body.children].find((node) => node.dataset.span === held) ?? [...body.children].find((node) => node.dataset.span === held.split('/')[0]) ?? stop;
    again?.focus({ preventScroll: true });
  }

  setText(host.lastElementChild, app.w.line('trace.rows', { count: [String(count), from.view('rows')] }));
}

// Between two states of the run the clock still moves: the step being
// checked shows how long it has taken so far, and its bar grows.
export function tickTrace(app, host) {
  if (app.view !== 'trace' || !app.run || host.hidden) return;
  const body = host.querySelector('.trace-body');
  if (!body) return;
  const lane = laneOf(app);
  const now = Date.now();
  const reached = app.replay ? app.replay.n : Infinity;
  app.run.steps.forEach((step, i) => {
    if (step.status !== 'running' || i >= reached) return;
    const node = [...body.children].find((n) => n.dataset.span === step.id);
    if (!node) return;
    setText(node.children[2], durationWords(app, step, `steps[${i}]`, now));
    if (step.startedAt) paintBar(node.children[4].firstElementChild.firstElementChild, lane, step.startedAt, now, FILLS.running);
  });
}

// ---- Keys and clicks

// The selection a row stands for: its step, and for a row inside a step,
// which one it is.
function selectionOf(node) {
  const inside = node.dataset.parent !== undefined;
  const item = inside ? { kind: node.dataset.kind, n: Number(node.dataset.n) } : null;
  const offline = (inside ? node.dataset.parent : node.dataset.span) === OFFLINE_KIND;
  const base = offline ? { kind: 'offline' } : { kind: 'step', index: Number(node.dataset.index) };
  return item ? { ...base, item } : base;
}

function show(node) {
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest' });
}

// The keys of a tree grid whose rows hold the focus: Up and Down move it one
// row, Home and End to the ends, Right opens a closed row and Left closes an
// open one (on a row with nothing inside neither does anything), Enter and
// Space open the row's step in the inspector. True when the key was one of
// these; every other key is left to the page.
export function traceKey(app, event) {
  const node = event.target instanceof Element ? event.target.closest('#trace-body [role="row"]') : null;
  if (!node) return false;
  const rows = [...node.parentElement.children];
  const at = rows.indexOf(node);
  const key = event.key;
  // The control at a row's start keeps its own Enter and Space.
  if ((key === 'Enter' || key === ' ') && event.target.closest('button')) return false;
  if (key === 'ArrowDown') show(rows[at + 1]);
  else if (key === 'ArrowUp') show(rows[at - 1]);
  else if (key === 'Home') show(rows[0]);
  else if (key === 'End') show(rows[rows.length - 1]);
  else if (key === 'ArrowRight') { if (node.getAttribute('aria-expanded') === 'false') app.setOpen(node.dataset.span, true); }
  else if (key === 'ArrowLeft') { if (node.getAttribute('aria-expanded') === 'true') app.setOpen(node.dataset.span, false); }
  else if (key === 'Enter' || key === ' ') { if (app.run) app.choose(selectionOf(node)); }
  else return false;
  event.preventDefault();
  return true;
}

// A click on the control at a row's start opens or closes the rows inside
// it; a click anywhere else on a row opens its step in the inspector.
export function traceClick(app, event) {
  const node = event.target instanceof Element ? event.target.closest('#trace-body [role="row"]') : null;
  if (!node) return;
  if (event.target.closest('.trace-toggle')) {
    app.setOpen(node.dataset.span, node.getAttribute('aria-expanded') !== 'true');
    return;
  }
  if (!app.run) return;
  app.choose(selectionOf(node));
  document.querySelector(`#trace-body [role="row"][data-span="${CSS.escape(node.dataset.span)}"]`)?.focus({ preventScroll: true });
}
