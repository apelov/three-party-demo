// The middle pane: the invoice, the lane header and one row per step.
//
// A row is built once for a step and then brought up to date in place, so a
// change of state changes attributes on elements that stay: that is what lets
// the colours pass through the one transition the stylesheet defines.

import { el, put, add, from, value, camel, clear } from './dom.mjs';
import { stateOf, chip, setChip, badge, countdown, compare, headlineOf } from './parts.mjs';
import { iconEl } from './icons.mjs';
import { STEP_ORDER } from './constants.mjs';

const baseId = (id) => String(id).replace(/-again$/, '');

// The width, in the units of the lane weights, that a lane showing a title
// and nothing under it gives to the lane of the party beside it.
const LANE_ROOM = 0.9;
// The width, in the same units, that a stand-in's note adds to its lane.
const NOTE_ROOM = 0.9;
// The space, in px, a line keeps for its two end markers beside its label.
const MARKER_ROOM = 10;
// The space, in px, a note that runs on leaves before the lane it stops at,
// beside that lane's own padding, so two notes do not read as one text.
const NOTE_GUTTER = 12;

// The column a step's marker sits in, and the column every line starts at
// (the party column: the one that is not a part of the label map).
function columnsOf(app) {
  const cols = app.labels.columns ?? [];
  const parts = app.labels.parts ?? {};
  const origin = Math.max(0, cols.findIndex((id) => !parts[id]));
  return { cols, parts, origin };
}

export function partOf(app, stepId) {
  const { cols, parts } = columnsOf(app);
  const col = app.labels.stepColumns?.[stepId];
  return { col, index: cols.indexOf(col), part: parts[col] ?? null };
}

// ---- Invoice

export function hiddenBox(app) {
  const run = app.run;
  if (!run?.invoice?.hidden) return null;
  return el('div', { class: 'hidden-box' },
    put('span', 'hidden-label', app.w.word('hidden.label')),
    put('p', 'hidden-text', value(run, 'invoice.hidden.text')),
    put('p', 'hidden-note', value(run, 'poisonedLine')));
}

function invoiceWords(app) {
  const inv = app.run.invoice;
  return {
    heading: app.w.lineNodes('invoice.heading', { invoiceId: [inv.invoiceId, from.run('invoice.invoiceId')] }, ['invoiceId']),
    amount: app.w.line('invoice.amountValue', { amount: [inv.amount, from.run('invoice.amount')], currency: [inv.currency, from.run('invoice.currency')] }),
    payTo: app.w.lineNodes('invoice.payToValue', { account: [inv.payTo?.account, from.run('invoice.payTo.account')] }, ['account']),
  };
}

export function invoiceStrip(app) {
  if (!app.run?.invoice) return null;
  const words = invoiceWords(app);
  return el('div', { class: 'invoice-strip' },
    put('span', 'invoice-heading', words.heading),
    put('span', 'invoice-value num', words.amount),
    put('span', 'invoice-value', words.payTo));
}

// The full card: who it is from (by role), the amount, where it pays to and
// the invoice lines; on a poisoned run, with withHidden, the hidden text.
export function invoiceCard(app, withHidden) {
  if (!app.run?.invoice) return null;
  const words = invoiceWords(app);
  const field = (key, valueNode) => (valueNode ? el('div', { class: 'invoice-field' }, put('dt', null, app.w.word(key)), el('dd', null, valueNode)) : null);
  const lines = Array.isArray(app.run.invoice.lines) ? app.run.invoice.lines : [];
  return el('div', { class: 'invoice-card' },
    el('dl', { class: 'invoice-fields' },
      put('span', 'invoice-heading', words.heading),
      field('invoice.from', put('span', null, app.w.label('parties.supplier'))),
      field('invoice.amount', put('span', 'num', words.amount)),
      field('invoice.payTo', put('span', null, words.payTo))),
    lines.length ? el('ul', { class: 'invoice-lines' }, lines.map((_, i) => put('li', null, value(app.run, `invoice.lines[${i}]`)))) : null,
    withHidden ? hiddenBox(app) : null);
}

// Where the hidden text of a poisoned invoice shows: in the middle pane when
// Inspect has the height for the full card there, in the run overview of the
// inspector otherwise. It is on screen in one place at a time.
export function cardInFlow(app) {
  return app.mode === 'inspect' && app.tier === 'wide';
}

export function renderInvoice(app, host) {
  clear(host);
  if (!app.run) return;
  add(host, cardInFlow(app) ? invoiceCard(app, true) : invoiceStrip(app));
}

// ---- Lane header

export function renderLanes(app, host) {
  clear(host);
  const { cols, parts, origin } = columnsOf(app);
  // A run of more than six steps needs the height the notes would take.
  const showNote = (app.tier === 'wide' || app.tier === 'standard') && !app.many;
  const showLegend = app.tier === 'wide';
  // A lane that shows a title and nothing under it.
  const alone = (id) => Boolean(parts[id]) && !parts[id].standIn && !(showLegend && parts[id].text);
  // In the standard tier the window has no room for a stand-in's note inside
  // its own lane. The note runs on under the lane to its right where that
  // lane shows a title alone (measureLanes sets how far), and the stand-in's
  // lane takes no width for it.
  const runsOn = cols.map((id, i) => app.tier === 'standard' && showNote && Boolean(parts[id]?.standIn) && i + 1 < cols.length && alone(cols[i + 1]));
  const weights = cols.map((id, i) => {
    const part = parts[id];
    return 1.3 + (part?.text ? 0.4 : 0) + (part?.standIn && !runsOn[i] ? NOTE_ROOM : 0);
  });
  // Where the panes stand at their measured widths, the party every line
  // starts from keeps its name on one line while the lane beside it shows a
  // title and nothing under it: the room comes from that lane, so the lanes
  // after the two keep their share of the width.
  const beside = parts[cols[origin + 1]];
  const oneLine = app.full && Boolean(beside) && !beside.standIn && !(showLegend && beside.text);
  if (oneLine) {
    weights[origin] += LANE_ROOM;
    weights[origin + 1] -= LANE_ROOM;
  }
  // Each lane is at least as wide as the longest word of its title; in a
  // window too narrow for that, the stylesheet takes the tight form.
  host.style.setProperty('--lanes', weights.map((wt) => `minmax(min-content, ${wt}fr)`).join(' '));
  host.style.setProperty('--lanes-tight', weights.map((wt) => `minmax(0, ${wt}fr)`).join(' '));
  for (const [i, id] of cols.entries()) {
    const part = parts[id];
    const title = part ? app.w.label(`parts.${id}.label`) : app.w.label(`parties.${id}`);
    // The titles that are to stay on one line where the panes stand at
    // their measured widths: the lane beside the party's, and the stand-ins.
    const wish = app.full && (i === origin + 1 || Boolean(part?.standIn)) ? 'one-line' : 'any';
    add(host, el('div', { class: 'lane', data: { col: id, standIn: part?.standIn ? 'yes' : 'no', origin: i === origin ? 'yes' : 'no', line: oneLine && i === origin ? 'one' : 'any', note: runsOn[i] ? 'runs-on' : 'in-lane', wish } },
      put('span', 'lane-title', title),
      part?.standIn ? [' ', badge(app)] : null,
      showLegend && part ? put('span', 'lane-legend', app.w.label(`parts.${id}.text`)) : null,
      showNote && part?.standIn ? put('span', 'lane-note', app.w.label(`parts.${id}.standInNote`)) : null));
  }
}

// What the header is measured for, after the rows are in place.
//
// The lane of the party every line starts from is made as wide as the label
// of the lane beside it needs on the line between the two, where the rows
// show that label (--line-room). Then where each lane starts is read from
// the header cells and kept as custom properties on the flow, so every track
// reads the same numbers. Last, a stand-in's note that runs on is given its
// reach: the lanes to its right that show a title alone, each as long as its
// title ends above the note, up to the next lane that carries something
// under its title (--note-run). A lane's width does not depend on that
// reach, so one pass settles it.
export function measureLanes(flow, head) {
  const lanes = [...head.children];
  for (const lane of lanes) {
    lane.style.removeProperty('--note-run');
    lane.dataset.keep = lane.dataset.wish === 'one-line' ? 'yes' : 'no';
  }
  const origin = lanes.findIndex((lane) => lane.dataset.origin === 'yes');
  let room = 0;
  if (origin >= 0) {
    for (const name of flow.querySelectorAll(`.track[data-to="${origin + 1}"] .track-name`)) {
      // A name the stylesheet hides (the compact tier, a run of many steps) takes no room.
      if (name.offsetWidth > 1) room = Math.max(room, Math.ceil(name.firstElementChild.offsetWidth) + MARKER_ROOM);
    }
  }
  if (room > 0) head.style.setProperty('--line-room', `${room}px`); else head.style.removeProperty('--line-room');
  // The lanes fit the header, whatever the labels: where the titles kept on
  // one line make the five lanes wider than the header, the mark is taken
  // off, from the last lane back, and then the room for the label.
  const fits = () => head.scrollWidth <= head.clientWidth;
  for (const lane of [...lanes].reverse()) {
    if (fits()) break;
    lane.dataset.keep = 'no';
  }
  if (!fits()) head.style.removeProperty('--line-room');

  const pad = parseFloat(getComputedStyle(head).paddingLeft) || 0;
  lanes.forEach((cell, i) => {
    flow.style.setProperty(`--lane-${i}`, `${Math.round(cell.offsetLeft - pad + 5)}px`);
  });

  lanes.forEach((lane, i) => {
    const note = lane.querySelector(':scope > .lane-note');
    if (!note || lane.dataset.note !== 'runs-on') return;
    const top = note.getBoundingClientRect().top;
    const own = lane.getBoundingClientRect().right;
    let reach = own;
    for (const next of lanes.slice(i + 1)) {
      if (next.querySelector('.badge, .lane-legend, .lane-note')) break;
      const title = next.querySelector('.lane-title');
      if (title && title.getBoundingClientRect().bottom > top + 0.5) break;
      reach = next.getBoundingClientRect().right;
    }
    const run = Math.floor(reach - own - NOTE_GUTTER);
    if (run > 0) lane.style.setProperty('--note-run', `${run}px`);
  });
}

// ---- Rows

// The one detail line of a step, composed from the copy deck's template for
// the step with the run's values; null when the run carries no value for it.
function detailLine(app, i, step) {
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

function previewSteps(app) {
  return STEP_ORDER.map((id, i) => ({ id, preview: i }));
}

function buildTrack(app, i, step) {
  const { origin } = columnsOf(app);
  const { col, index, part } = partOf(app, step.id);
  const label = step.preview === undefined
    ? value(app.run, `steps[${i}].partLabel`)
    : (part ? app.w.label(`parts.${col}.label`) : null);
  const track = el('div', { class: 'track', data: { to: String(index) } });
  if (index >= 0) {
    track.style.setProperty('--from', `var(--lane-${origin})`);
    track.style.setProperty('--to', `var(--lane-${index})`);
    track.append(el('span', { class: 'track-line' }), el('span', { class: 'track-from' }), el('span', { class: 'track-dot' }));
  }
  if (label) track.append(el('span', { class: 'track-name' }, put('span', 'track-label', label)));
  return track;
}

function buildRow(app, i, step) {
  const preview = step.preview !== undefined;
  const row = el('div', { class: 'row', role: 'listitem', tabindex: '-1', data: { step: step.id, index: String(i) } });
  const numberSrc = preview ? `${from.constant(`stepOrder[${i}]`)}|ordinal` : from.run(`steps[${i}]`, 'ordinal');
  const title = preview ? app.w.word(`step.${camel(step.id)}`) : value(app.run, `steps[${i}].title`);
  const tile = el('div', { class: 'row-tile' },
    el('span', { class: 'row-num', src: numberSrc, text: String(i + 1) }),
    put('span', 'row-title', title) ?? el('span', { class: 'row-title' }),
    chip(stateOf(app, 'pending', from.constant(`stepOrder[${i}]`))),
    buildTrack(app, i, step));
  row.append(tile);
  return row;
}

function setLine(tile, cls, before, line) {
  let node = tile.querySelector(`:scope > .${cls}`);
  if (!line) {
    node?.remove();
    return null;
  }
  if (node && node.dataset.src === line.src && node.textContent === line.text) return node;
  const fresh = put('p', cls, line);
  if (node) node.replaceWith(fresh); else tile.insertBefore(fresh, before);
  return fresh;
}

function updateRow(app, row, i, step) {
  const preview = step.preview !== undefined;
  const tile = row.firstElementChild;
  const track = tile.querySelector(':scope > .track');
  // A replay shows the steps after the one it stands at as not yet begun:
  // pending, with no detail.
  const veiled = !preview && app.replay !== null && i >= app.replay.n;
  const status = preview || veiled ? 'pending' : step.status;
  const state = stateOf(app, status, preview ? from.constant(`stepOrder[${i}]`) : veiled ? from.view('replay') : from.run(`steps[${i}].status`));
  const selected = !preview && app.selection.kind === 'step' && app.selection.index === i;

  row.dataset.status = status;
  row.dataset.tone = state.tone;
  row.dataset.state = state.icon;
  if (selected) row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
  setChip(tile.querySelector(':scope > .chip'), state);

  if (!preview) {
    const title = tile.querySelector(':scope > .row-title');
    if (title.textContent !== step.title) title.textContent = step.title;
  }

  // The detail line: every row in Inspect, the selected row in Story.
  const open = !preview && !veiled && (app.mode === 'inspect' || selected);
  setLine(tile, 'row-detail', track, open ? detailLine(app, i, step) : null);

  // The grant countdown, once the grant has passed: on the step that issued
  // the grant in force (the last grant step that passed).
  const counts = !preview && !veiled && baseId(step.id) === 'grant' && status === 'passed' && Boolean(app.run.grant?.expiresAt)
    && app.run.steps.findLastIndex((s) => baseId(s.id) === 'grant' && s.status === 'passed') === i;
  let count = track.querySelector(':scope > .countdown');
  if (counts && (!count || count.dataset.expires !== app.run.grant.expiresAt)) {
    const fresh = countdown(app);
    if (count) count.replaceWith(fresh); else track.append(fresh);
    count = fresh;
  } else if (!counts && count) {
    count.remove();
  }
  // The grant row keeps the countdown's line from the start.
  row.dataset.counts = baseId(step.id) === 'grant' ? 'yes' : 'no';

  // The stopped step: headline in the tile, the comparison where the pane
  // has the height, and the run's one sentence under the tile.
  const stopped = !preview && status === 'blocked';
  let head = tile.querySelector(':scope > .outcome-head');
  let table = tile.querySelector(':scope > .row-compare');
  let sentence = row.querySelector(':scope > .stop-sentence');
  if (stopped) {
    row.dataset.outcome = 'blocked';
    const headline = headlineOf(app, app.run);
    const words = app.w.chosen(headline.key, headline.source);
    if (!head && words) {
      head = put('p', 'outcome-head', words, { 'data-outcome-part': 'headline' });
      tile.append(head);
    }
    // The comparison stands in the row where the pane has the height for
    // it: Story in the wide tier. The inspector shows it at every size.
    const wantTable = app.tier === 'wide' && app.mode === 'story' && Array.isArray(step.detail?.calls);
    if (wantTable && !table) {
      const built = compare(app, i);
      if (built) tile.append(el('div', { class: 'row-compare' }, built));
    } else if (!wantTable && table) {
      table.remove();
    }
    const reason = value(app.run, 'reason');
    if (reason && (!sentence || sentence.textContent !== reason.text)) {
      const fresh = put('p', 'stop-sentence', reason, { 'data-outcome-part': 'text' });
      if (sentence) sentence.replaceWith(fresh); else row.append(fresh);
    } else if (!reason && sentence) {
      sentence.remove();
    }
  } else {
    delete row.dataset.outcome;
    head?.remove();
    table?.remove();
    sentence?.remove();
  }
}

// Bring the rows to the run (or, before a run, to the contract's step order).
export function syncRows(app, host, flow) {
  const steps = app.run ? app.run.steps : previewSteps(app);
  const signature = `${app.run ? app.runId : 'preview'}|${steps.map((s) => s.id).join(',')}|${app.labelsStamp}`;
  const held = host.contains(document.activeElement);
  const rebuilt = host.dataset.signature !== signature;
  if (rebuilt) {
    clear(host);
    steps.forEach((step, i) => host.append(buildRow(app, i, step)));
    host.dataset.signature = signature;
  }
  flow.dataset.many = app.many ? 'yes' : 'no';
  // A replay puts its line at the pane's foot. A stopped run has no banner
  // there, so the stylesheet takes the room for the line from the rows.
  flow.dataset.replay = !app.run || !(app.replay || app.replayDone) ? 'no' : app.run.outcome === 'blocked' ? 'stopped' : 'yes';
  const rows = [...host.children];
  steps.forEach((step, i) => updateRow(app, rows[i], i, step));

  // One tab stop for the list: the selected row, or the leading row.
  const current = app.run && app.selection.kind === 'step' ? app.selection.index : 0;
  rows.forEach((row, i) => row.setAttribute('tabindex', i === current ? '0' : '-1'));
  // The focus stays in the list when its rows are built again.
  if (held && rebuilt) rows[current]?.focus({ preventScroll: true });
}

// ---- The outcome at the end of the flow (a run that was not stopped)

export function renderOutcomeEnd(app, host) {
  const run = app.run;
  // A replay: the banner says which run is replayed and the step the replay
  // stands at, and, after the last step, that the replay is over.
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
    add(clear(host), el('p', { class: 'outcome-line' }, put('span', 'outcome-headline', words, { 'data-outcome-part': 'replay' })));
    return;
  }
  if (run?.outcome === 'blocked') {
    host.hidden = true;
    clear(host);
    host.dataset.outcome = 'blocked';
    delete host.dataset.signature;
    return;
  }
  host.hidden = false;
  const signature = run ? `${app.runId}|${run.outcome ?? ''}|${app.size}` : 'none';
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  clear(host);
  if (!run) {
    delete host.dataset.outcome;
    delete host.dataset.tone;
    return;
  }
  const headline = headlineOf(app, run);
  const words = app.w.chosen(headline.key, headline.source);
  const states = app.labels.states ?? {};
  const icon = iconEl(run.outcome ? states.passed?.icon : states.running?.icon);
  host.dataset.outcome = run.outcome ?? 'pending';
  host.dataset.tone = headline.tone;
  let text = null;
  if (run.outcome === 'paid') {
    const i = run.steps.findIndex((s) => baseId(s.id) === 'pay' && s.detail?.paymentId);
    const paid = i >= 0 ? app.w.lineNodes('outcome.paidText', { paymentId: [run.steps[i].detail.paymentId, from.run(`steps[${i}].detail.paymentId`)] }, ['paymentId']) : null;
    text = put('span', 'outcome-text', paid, { 'data-outcome-part': 'text' });
  }
  add(host, el('p', { class: 'outcome-line' }, icon, put('span', 'outcome-headline', words, { 'data-outcome-part': 'headline' }), text));
}
