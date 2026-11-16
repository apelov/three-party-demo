// The middle pane's Sequence tab and the outcome under every tab.
//
// Before a run it shows the orientation: one sentence, the three parts that
// take part in the payment, and the two runs to start. During and after a
// run it shows the invoice and the sequence: five lifelines, one per party
// or part, and one row per step whose arrow runs from the lifeline that acts
// to the lifeline that checks or answers, with the step's state where the
// arrow arrives. A step that acted leaves a mark on the record lifeline:
// outlined until its record is signed, filled once it is, and checked once
// the offline audit has passed it.
//
// Every resting piece sits in a grid slot. A row is built once for a step
// and then brought up to date in place, so a change of state changes
// attributes on elements that stay, and the colours pass through the one
// transition the stylesheet defines for them.

import { el, put, add, from, value, clear } from './dom.mjs';
import { stateOf, chip, setChip, badge, countdown, headlineOf, columnsOf, partOf, shownPart, columnTitle, creditOf, lensOutcomeLine, baseId } from './parts.mjs';
import { iconEl } from './icons.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
// How long a request's marker is shown travelling: the length of its
// transition in the stylesheet (--m3), and a little after it.
const TRAVEL_MS = 700;

export { partOf, shownPart };

// ---- Orientation: before any run

function sceneOf(app, kind) {
  const all = app.labels.scenes ?? [];
  const s = all.findIndex((scene) => scene.kind === kind);
  return s >= 0 ? { scene: all[s], s } : null;
}

// The action that runs a scene: the scene's own button from the label map,
// or, from a server with no label map, the deck's line for it.
export function sceneButton(app, kind, cls, press) {
  const found = sceneOf(app, kind);
  if (!found) return null;
  const words = app.w.label(`scenes[${found.s}].button`) ?? app.w.line('button.runName', { scene: [found.scene.title, from.labels(`scenes[${found.s}].title`)] });
  if (!words) return null;
  return el('button', { class: `btn ${cls}`, type: 'button', src: words.src, text: words.text, data: { runKind: kind }, on: { click: press } });
}

export function renderOrientation(app, host, press) {
  const signature = `${app.run ? 'run' : 'none'}|${app.labelsStamp}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  clear(host);
  host.hidden = Boolean(app.run);
  if (app.run) return;
  const { cols, parts } = columnsOf(app);
  // The parts that check or record: those the screens' own file gives a line.
  const shown = cols.filter((id) => parts[id] && typeof parts[id].text === 'string' && parts[id].text !== '');
  add(host,
    put('p', 'orient-lead', app.w.word('ui.lead'), { id: 'app-sentence' }),
    el('div', { class: 'orient-parts', role: 'list' }, shown.map((id) => {
      const { part } = shownPart(app, id);
      return el('div', { class: 'orient-part', role: 'listitem', data: { col: id } },
        el('div', { class: 'orient-name' }, put('span', 'lane-title', columnTitle(app, id))),
        part?.standIn ? el('p', { class: 'orient-credit' }, badge(app)) : put('p', 'orient-credit', creditOf(app, id)),
        put('p', 'orient-text', app.w.label(`parts.${id}.text`)));
    })),
    el('div', { class: 'orient-actions' },
      sceneButton(app, 'clean', 'btn-primary', () => press('clean')),
      sceneButton(app, 'poisoned', 'btn-quiet', () => press('poisoned'))));
}

// ---- Invoice: one ruled line, and the hidden text of a poisoned invoice

export function renderInvoice(app, host) {
  const run = app.run;
  const signature = run ? `${app.runId}|${app.labelsStamp}` : 'none';
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  clear(host);
  host.hidden = !run?.invoice;
  if (!run?.invoice) return;
  const inv = run.invoice;
  const field = (labelKey, words, cls) => (words ? el('span', { class: 'invoice-field' }, put('span', 'invoice-key', app.w.word(labelKey)), put('span', `invoice-value${cls ? ` ${cls}` : ''}`, words)) : null);
  add(host,
    el('div', { class: 'invoice-strip' },
      put('span', 'invoice-heading', app.w.lineNodes('invoice.heading', { invoiceId: [inv.invoiceId, from.run('invoice.invoiceId')] }, ['invoiceId'])),
      field('invoice.amount', app.w.line('invoice.amountValue', { amount: [inv.amount, from.run('invoice.amount')], currency: [inv.currency, from.run('invoice.currency')] }), 'num'),
      field('invoice.payTo', app.w.lineNodes('invoice.payToValue', { account: [inv.payTo?.account, from.run('invoice.payTo.account')] }, ['account']))),
    inv.hidden ? el('div', { class: 'hidden-line' },
      put('span', 'hidden-label', app.w.word('hidden.label')),
      put('mark', 'hidden-text', value(run, 'invoice.hidden.text'))) : null);
}

// ---- The lane heads

export function renderLanes(app, host) {
  clear(host);
  const { cols, parts } = columnsOf(app);
  // The lanes' widths, in the weights the label file gives each column.
  const weights = app.labels.columnWeights ?? {};
  host.parentElement.style.gridTemplateColumns = `var(--num) ${cols.map((id) => `minmax(0, ${Number(weights[id]) > 0 ? Number(weights[id]) : 1}fr)`).join(' ')}`;
  for (const [i, id] of cols.entries()) {
    const shown = shownPart(app, id);
    const standIn = Boolean(shown.part?.standIn);
    const note = standIn ? app.w.label(`${shown.path}.standInNote`) : null;
    // The lane is a pair of slots in the head's grid: its title (with the
    // stand-in mark, whose note is its tooltip) and the line under it.
    add(host, el('div', { class: 'lane', data: { col: id, standIn: standIn ? 'yes' : 'no', origin: parts[id] ? 'no' : 'yes' } },
      el('span', { class: 'lane-line', style: { gridColumn: `${i + 2}` }, title: note?.text },
        put('span', 'lane-title', columnTitle(app, id))),
      el('span', { class: 'lane-credit', style: { gridColumn: `${i + 2}` }, title: note?.text },
        standIn ? badge(app) : put('span', null, creditOf(app, id)))));
  }
}

// ---- Rows

// The one detail line of a step, composed from the copy deck's template for
// the step with the run's values; null when the run carries no value for it.
export function detailLine(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const id = baseId(step.id);
  if (step.status === 'not-reached') return app.w.word('detail.notRun');
  if (step.status === 'pending' || step.status === 'running') return null;
  if (id === 'credential') {
    if (step.status === 'blocked') return app.w.word('detail.credentialMismatch');
    return app.w.lineNodes('detail.credential', {
      version: [d.verifier ? String(d.verifier).slice(String(d.verifier).lastIndexOf(' ') + 1) : null, from.run(`${base}.verifier`, 'afterLastSpace')],
      sha16: [run.agent?.credentialSha256 ? String(run.agent.credentialSha256).slice(0, 16) : null, from.run('agent.credentialSha256', 'hex16')],
    }, ['sha16']);
  }
  if (id === 'grant') {
    const max = run.grant?.maximumIndividualAmount;
    return app.w.line('detail.grant', {
      maxAmount: [max?.amount, from.run('grant.maximumIndividualAmount.amount')],
      currency: [max?.currency, from.run('grant.maximumIndividualAmount.currency')],
    });
  }
  if (id === 'crossing') {
    // The supplied capture check says its own summary line.
    if (d.capture?.used === true) return value(run, `${base}.capture.summary`);
    return app.w.line('detail.crossing', {
      domainA: [app.labels.parties?.domainA, from.labels('parties.domainA')],
      domainB: [app.labels.parties?.domainB, from.labels('parties.domainB')],
      hops: [d.hops, from.run(`${base}.hops`)],
      outcome: [d.outcome, from.run(`${base}.outcome`)],
    });
  }
  if (id === 'intent') {
    if (d.result === 'match') return app.w.word('detail.intentPass');
    const calls = Array.isArray(d.calls) ? d.calls : [];
    const bare = calls.findIndex((c) => c.declaredFor === null || c.declaredFor === undefined);
    const off = calls.findIndex((c) => c.declaredFor !== null && c.declaredFor !== undefined && Array.isArray(c.fieldsDiffering) && c.fieldsDiffering.length > 0);
    return app.w.lineNodes('detail.intentStop', {
      call: [bare >= 0 ? calls[bare].tool : null, from.run(`${base}.calls[${bare}].tool`)],
      field: [off >= 0 ? calls[off].fieldsDiffering[0] : null, from.run(`${base}.calls[${off}].fieldsDiffering[0]`)],
    }, ['call', 'field']);
  }
  if (id === 'pay') {
    return app.w.lineNodes('detail.pay', {
      paymentId: [d.paymentId, from.run(`${base}.paymentId`)],
      amount: [d.amount, from.run(`${base}.amount`)],
      currency: [d.currency, from.run(`${base}.currency`)],
      payeeAccount: [d.payeeAccount, from.run(`${base}.payeeAccount`)],
    }, ['paymentId', 'payeeAccount']);
  }
  if (id === 'record') return app.w.line('detail.record', { written: [d.written, from.run(`${base}.written`)] });
  return null;
}

// The offline check's answer for the run on screen, or null.
export function offlineOf(app) {
  return app.offline && app.offline.runId === app.runId ? app.offline.result : null;
}

// The record mark of a step: none when the step did not act; pending while
// the action waits for its record; signed once the run's record step has
// signed it; verified or failed once the audit has answered for that file.
export function recordStateOf(app, step) {
  if (!step || baseId(step.id) === 'record') return null;
  if (!step.actionFile && !step.recordFile) return null;
  if (!step.recordFile) return 'pending';
  const offline = offlineOf(app);
  const row = Array.isArray(offline?.records) ? offline.records.find((r) => r.file === step.recordFile) : null;
  if (!row) return 'signed';
  return row.verdict === 'pass-1-6' ? 'verified' : 'failed';
}

const MARK_WORDS = { pending: 'seq.recordPending', signed: 'seq.recordSigned', verified: 'seq.recordVerified', failed: 'seq.recordFailed' };

function markShape(state) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const page = document.createElementNS(SVG_NS, 'path');
  page.setAttribute('d', 'M3.5 1.5h6l3 3v10h-9z');
  page.setAttribute('class', 'mark-page');
  svg.append(page);
  if (state === 'verified' || state === 'failed') {
    const sign = document.createElementNS(SVG_NS, 'path');
    sign.setAttribute('d', state === 'verified' ? 'm5.4 9.2 1.9 1.9 3.4-3.7' : 'm5.6 6.6 4.8 4.8m0-4.8-4.8 4.8');
    sign.setAttribute('class', 'mark-sign');
    svg.append(sign);
  }
  return svg;
}

function paintMark(app, node, state) {
  if (node.dataset.state === (state ?? 'none')) return;
  node.dataset.state = state ?? 'none';
  node.replaceChildren();
  node.removeAttribute('aria-label');
  node.removeAttribute('title');
  node.hidden = !state;
  if (!state) return;
  const words = app.w.word(MARK_WORDS[state]);
  node.append(markShape(state));
  if (words) {
    node.setAttribute('aria-label', words.text);
    node.setAttribute('title', words.text);
    node.dataset.words = words.src;
  }
}

function buildRow(app, i, step, cols) {
  const { index, fromIndex, col } = partOf(app, step.id);
  const recordCol = cols.indexOf('record');
  const to = Math.max(0, index);
  const start = Math.max(0, fromIndex);
  const arrowEnd = to > start ? to : start + 1;
  // The state's room ends at the record lifeline, where the record mark
  // stands, for a step whose arrow ends before it.
  const stateEnd = recordCol > arrowEnd ? recordCol + 2 : cols.length + 2;
  const row = el('div', { class: 'row', role: 'listitem', tabindex: '-1', data: { step: step.id, index: String(i), col: col ?? '' } });
  // One slot per lifeline, behind the row's pieces.
  for (let c = 0; c < cols.length; c += 1) row.append(el('span', { class: 'lifeline', 'aria-hidden': 'true', style: { gridColumn: `${c + 2}` } }));
  add(row,
    el('span', { class: 'row-num', src: from.run(`steps[${i}]`, 'ordinal'), text: String(i + 1) }),
    el('span', { class: 'row-head', style: { gridColumn: `${start + 2} / -1` } }, put('span', 'row-title', value(app.run, `steps[${i}].title`)) ?? el('span', { class: 'row-title' })),
    el('span', { class: 'arrow', 'aria-hidden': 'true', style: { gridColumn: `${start + 2} / ${arrowEnd + 2}` } },
      el('span', { class: 'arrow-from' }), el('span', { class: 'arrow-track' }, el('span', { class: 'arrow-line' }), el('span', { class: 'arrow-pulse' })), el('span', { class: 'arrow-head' })),
    el('span', { class: 'row-state', style: { gridColumn: `${arrowEnd + 2} / ${stateEnd}` } }, chip(stateOf(app, 'pending', from.run(`steps[${i}].status`)))),
    recordCol >= 0 && baseId(step.id) !== 'record' ? el('span', { class: 'rec-mark', role: 'img', hidden: true, style: { gridColumn: `${recordCol + 2}` } }) : null);
  return row;
}

function setLine(row, cls, line) {
  let node = row.querySelector(`:scope > .${cls}`);
  if (!line) {
    node?.remove();
    return null;
  }
  if (node && node.dataset.src === line.src && node.textContent === line.text) return node;
  const fresh = put('p', cls, line);
  if (node) node.replaceWith(fresh); else row.append(fresh);
  return fresh;
}

function updateRow(app, row, i, step) {
  // A replay shows the steps after the one it stands at as not yet begun:
  // pending, with no detail and no record.
  const veiled = app.replay !== null && i >= app.replay.n;
  const status = veiled ? 'pending' : step.status;
  const state = stateOf(app, status, veiled ? from.view('replay') : from.run(`steps[${i}].status`));
  const selected = app.selection.kind === 'step' && app.selection.index === i;

  // A step that leaves pending while the page watches sends its request
  // along the arrow once: the marker travels from the lifeline that acts to
  // the one that checks, and the state settles where it arrives.
  const before = row.dataset.status;
  if (before === 'pending' && status !== 'pending' && !app.reducedMotion) {
    row.dataset.travel = 'yes';
    clearTimeout(row.travelTimer);
    row.travelTimer = setTimeout(() => { delete row.dataset.travel; }, TRAVEL_MS);
  }
  row.dataset.status = status;
  row.dataset.tone = state.tone;
  row.dataset.state = state.icon;
  if (selected) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
  setChip(row.querySelector('.row-state > .chip'), state);
  const title = row.querySelector('.row-title');
  if (title && title.textContent !== step.title) title.textContent = step.title;

  // The detail line: on the selected step alone.
  setLine(row, 'row-detail', selected && !veiled ? detailLine(app, i, step) : null);

  // The grant countdown, while the run goes on, on the step that issued the
  // grant in force (the last grant step that passed).
  const counts = !veiled && !app.run.outcome && baseId(step.id) === 'grant' && status === 'passed' && Boolean(app.run.grant?.expiresAt)
    && app.run.steps.findLastIndex((s) => baseId(s.id) === 'grant' && s.status === 'passed') === i;
  const slot = row.querySelector('.row-state');
  let count = slot.querySelector(':scope > .countdown');
  if (counts && (!count || count.dataset.expires !== app.run.grant.expiresAt)) {
    const fresh = countdown(app);
    if (count) count.replaceWith(fresh); else slot.append(fresh);
    count = fresh;
  } else if (!counts && count) {
    count.remove();
  }

  const mark = row.querySelector(':scope > .rec-mark');
  if (mark) paintMark(app, mark, veiled ? null : recordStateOf(app, step));

  if (status === 'blocked') row.dataset.outcome = 'blocked'; else delete row.dataset.outcome;
}

// Bring the rows to the run.
export function syncRows(app, host, flow) {
  const steps = app.run ? app.run.steps : [];
  const { cols } = columnsOf(app);
  const variants = steps.map((s) => s.variant ?? '').join(',');
  const signature = `${app.run ? app.runId : 'none'}|${steps.map((s) => s.id).join(',')}|${app.labelsStamp}|${variants}`;
  const held = host.contains(document.activeElement);
  const rebuilt = host.dataset.signature !== signature;
  if (rebuilt) {
    clear(host);
    steps.forEach((step, i) => host.append(buildRow(app, i, step, cols)));
    host.dataset.signature = signature;
  }
  flow.hidden = !app.run;
  flow.dataset.many = steps.length > 6 ? 'yes' : 'no';
  const rows = [...host.children];
  steps.forEach((step, i) => updateRow(app, rows[i], i, step));

  // One tab stop for the list: the selected row, or the leading row.
  const current = app.selection.kind === 'step' ? app.selection.index : 0;
  rows.forEach((row, i) => row.setAttribute('tabindex', i === current ? '0' : '-1'));
  if (held && rebuilt) rows[current]?.focus({ preventScroll: true });
  const name = app.run ? app.w.line('seq.name', { runId: [app.run.runId, from.run('runId')] }) : null;
  if (name) host.setAttribute('aria-label', name.text); else host.removeAttribute('aria-label');
}

// ---- The outcome under the middle pane
//
// One line once the run has ended: the outcome's word, one sentence in the
// words of the lens, and the one action that comes next. During a replay it
// says which run is replayed and where the replay stands.

export function renderOutcome(app, host, nextAction) {
  const run = app.run;
  if (run && (app.replay || app.replayDone)) {
    const signature = `replay|${app.runId}|${app.replay ? app.replay.n : 'done'}`;
    host.hidden = false;
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    host.dataset.outcome = 'replay';
    delete host.dataset.tone;
    const words = app.replay
      ? app.w.lineNodes('menu.replaying', { runId: [run.runId, from.run('runId')], n: [String(app.replay.n), from.view('replay')] }, ['runId'])
      : app.w.word('menu.replayDone');
    add(clear(host), el('div', { class: 'outcome-line' }, put('p', 'outcome-text', words, { 'data-outcome-part': 'replay' })));
    return;
  }
  const next = run?.outcome ? nextAction() : null;
  const signature = run?.outcome ? `${app.runId}|${run.outcome}|${app.lens}|${next?.id ?? ''}|${app.labelsStamp}` : 'none';
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  clear(host);
  if (!run?.outcome) {
    host.hidden = true;
    delete host.dataset.outcome;
    delete host.dataset.tone;
    return;
  }
  host.hidden = false;
  const headline = headlineOf(app, run);
  const states = app.labels.states ?? {};
  const icon = run.outcome === 'blocked' ? states.blocked?.icon : states.passed?.icon;
  host.dataset.outcome = run.outcome;
  host.dataset.tone = headline.tone;
  add(host, el('div', { class: 'outcome-line' },
    el('div', { class: 'outcome-words' },
      el('span', { class: 'outcome-chip', data: { tone: headline.tone } }, iconEl(icon), put('span', 'outcome-headline', app.w.chosen(headline.key, headline.source), { 'data-outcome-part': 'headline' })),
      put('p', 'outcome-text', lensOutcomeLine(app), { 'data-outcome-part': 'text' })),
    next ? el('div', { class: 'outcome-actions' }, next.button) : null));
}
