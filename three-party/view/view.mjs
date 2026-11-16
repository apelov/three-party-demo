// The page: one screen that renders from the run API of the contract.
//
// It loads the copy deck and its own label file (the structure of the screen
// and the screens' words for the parts and the scenes), asks the server for
// the contract's label map, which carries every part label, party role,
// stand-in note and button, then waits for a key or a click. Every word on
// screen is a line of the copy deck, a string of the label map or a value of
// the run; this file holds none of its own.
//
// The screen has four moments, each with one place for the eye: before a
// run, the action that starts one; during a run, the step being checked;
// at the end, the outcome and the one action that comes next; after the
// audit, the records. The menu on the left keeps the walkthrough's progress.

import { el, put, add, from, value, words, clear } from './dom.mjs';
import { installSprite, iconEl } from './icons.mjs';
import { startRun, getRun, getLabels, getFile, runOfflineCheck } from './api.mjs';
import { listZip, readEntry, entryText } from './zip.mjs';
import { copyButton, tickCountdowns, stateOf, headlineOf, lensesOf } from './parts.mjs';
import { renderOrientation, renderInvoice, renderLanes, syncRows, renderOutcome, sceneButton } from './flow.mjs';
import { renderInspector } from './inspector.mjs';
import { renderRecords } from './records.mjs';
import { renderTrace, tickTrace, traceKey, traceClick } from './trace.mjs';
import { UNHANDLED_KINDS, OFFLINE_KIND, POLL_MS, SIZES } from './constants.mjs';

const $ = (id) => document.getElementById(id);
const TABS = ['sequence', 'trace', 'records'];

// What the address names: the mode, then the tab of the middle pane, then
// the lens. An address that names no tab means the sequence; `flow` is the
// sequence's earlier name. A lens the label file does not name is left for
// the default.
function readHash() {
  const m = /^#(story|inspect)(?:-(sequence|flow|trace|records))?(?:-([a-z]+))?$/.exec(location.hash);
  const tab = m?.[2] === 'flow' ? 'sequence' : (m?.[2] ?? 'sequence');
  return { mode: m ? m[1] : 'story', tab, named: Boolean(m?.[2]), lens: m?.[3] ?? null };
}

const opened = readHash();

const app = {
  copy: {},
  labels: {},
  labelsStamp: 0,
  w: null,
  mode: opened.mode,
  tab: opened.tab,
  view: opened.tab === 'trace' ? 'trace' : 'flow',
  tabNamed: opened.named,
  lens: opened.lens,
  lensNamed: Boolean(opened.lens),
  replay: null,
  replayDone: false,
  traceOpen: new Map(),
  inspectorOpen: new Map(),
  sectionFirst: null,
  shown: null,
  stacked: false,
  size: 'inspect',
  reducedMotion: false,
  scenes: [],
  sceneIndex: 0,
  done: new Set(),
  run: null,
  runId: null,
  runText: '',
  runStamp: 0,
  runError: null,
  lastFinished: null,
  selection: { kind: 'overview' },
  follow: true,
  offline: null,
  offlineStamp: 0,
  files: new Map(),
  zips: new Map(),
  filesStamp: 0,
  openRecord: null,
  seen: new Map(),
  announcedOutcome: null,
  pollTimer: null,
  tickTimer: null,
};

// ---- Files of the run, fetched when a pane asks for them

const fileKey = (rel) => `${app.runId}|${rel}`;

app.fileOf = (rel) => {
  if (!app.runId || !rel) return null;
  const key = fileKey(rel);
  if (!app.files.has(key)) {
    app.files.set(key, { state: 'loading', file: null });
    const id = app.runId;
    getFile(id, rel).then((file) => {
      app.files.set(key, file ? { state: 'ready', file } : { state: 'absent', file: null });
      if (app.runId === id) { app.filesStamp += 1; update(); }
    });
  }
  return app.files.get(key);
};

// A record package: its entry names and, when it holds one, its metadata.
app.zipOf = (rel) => {
  if (!app.runId || !rel) return null;
  const key = fileKey(rel);
  if (!app.zips.has(key)) {
    app.zips.set(key, { state: 'loading' });
    const id = app.runId;
    (async () => {
      const file = await getFile(id, rel);
      const entries = file && file.kind === 'zip' ? listZip(file.bytes) : null;
      let entry = { state: 'absent' };
      if (entries) {
        const meta = entries.find((e) => e.name === 'metadata.json');
        let metadata = null;
        try {
          metadata = meta ? JSON.parse(entryText(await readEntry(file.bytes, meta))) : null;
        } catch {
          metadata = null;
        }
        entry = { state: 'ready', entries, metadata };
      }
      app.zips.set(key, entry);
      if (app.runId === id) { app.filesStamp += 1; update(); }
    })();
  }
  return app.zips.get(key);
};

app.toggleRecord = (rel) => {
  app.openRecord = app.openRecord === rel ? null : rel;
  update();
};

// What the trace and the records ask of the page: open a row's step in the
// inspector, and open or close the rows inside a step.
app.choose = (selection) => select(selection);
app.setOpen = (id, open) => {
  app.traceOpen.set(id, open);
  update();
};

// ---- Window size: whether the Story sizes fit, and whether the panes stack

function readWindow() {
  const wide = window.innerWidth;
  const high = window.innerHeight;
  const roomy = wide >= SIZES.storyWidth && high >= SIZES.storyHeight;
  app.stacked = wide < SIZES.stack;
  app.size = app.mode === 'story' && roomy ? 'story' : 'inspect';
  app.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- Selection and follow

const stepCount = () => (app.run ? app.run.steps.length : 0);

// The step the story is at: the stopped step, else the step being checked,
// else the last step that has left the pending state.
function newest(run) {
  if (!run) return -1;
  if (run.blockedAt) {
    const at = run.steps.findIndex((s) => s.id === run.blockedAt);
    if (at >= 0) return at;
  }
  let last = -1;
  run.steps.forEach((s, i) => {
    if (s.status === 'running') last = i;
  });
  if (last >= 0) return last;
  run.steps.forEach((s, i) => {
    if (s.status !== 'pending' && s.status !== 'not-reached') last = i;
  });
  return last;
}

function applyFollow() {
  if (!app.follow || !app.run || app.replay || app.selection.kind === 'offline') return;
  const i = newest(app.run);
  if (i >= 0) app.selection = { kind: 'step', index: i };
}

function select(selection, follow = false) {
  // During a replay a step chosen any way is where the replay stands. The
  // run as a whole (key 0) and the offline check end the replay.
  if (app.replay && selection.kind === 'step') {
    replayTo(selection.index + 1, selection);
    return;
  }
  app.replay = null;
  app.replayDone = false;
  app.selection = selection;
  app.follow = follow;
  update();
  focusSelectedRowIfInList();
}

function step(delta) {
  const n = stepCount();
  if (!n) return;
  if (app.replay) {
    replayTo(app.replay.n + delta);
    return;
  }
  const cur = app.selection.kind === 'step' ? app.selection.index : delta > 0 ? -1 : n;
  select({ kind: 'step', index: Math.max(0, Math.min(n - 1, cur + delta)) });
}

// The last step, with follow on: the selection then moves with the run.
function toEnd() {
  const n = stepCount();
  if (!n) return;
  if (app.replay) {
    replayTo(n);
    return;
  }
  app.replayDone = false;
  app.follow = true;
  app.selection = { kind: 'step', index: n - 1 };
  update();
  focusSelectedRowIfInList();
}

function back() {
  step(-1);
}

function forward() {
  const n = stepCount();
  if (!n) return;
  if (!app.replay && app.selection.kind === 'step' && app.selection.index >= n - 1) toEnd(); else step(1);
}

// The list of steps on screen: the rows of the sequence, or of the trace.
const stepList = () => $(app.tab === 'trace' ? 'trace' : 'rows');

function focusSelectedRowIfInList() {
  const list = stepList();
  if (!list.contains(document.activeElement)) return;
  list.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
}

// The trace may be taller than its pane in Inspect: its selected row is
// brought into sight once for each selection, so a reader who scrolls is
// not pulled back.
function revealSelected() {
  if (app.tab !== 'trace') {
    app.shown = null;
    return;
  }
  const body = $('trace').querySelector('.trace-body');
  const key = `${app.runId}|${JSON.stringify(app.selection)}`;
  if (!body || app.shown === key) return;
  app.shown = key;
  if (body.scrollHeight > body.clientHeight) body.querySelector('[tabindex="0"]')?.scrollIntoView({ block: 'nearest' });
}

function writeHash() {
  const lens = app.lensNamed ? `-${app.lens}` : '';
  const tab = app.tabNamed || lens ? `-${app.tab}` : '';
  history.replaceState(null, '', `#${app.mode}${tab}${lens}`);
}

function setMode(mode) {
  if (app.mode === mode) return;
  app.mode = mode;
  app.follow = mode === 'story';
  writeHash();
  applyFollow();
  update();
}

// Show a tab of the middle pane. The panes stay where they are.
function setTab(tab, { focus = false } = {}) {
  if (!TABS.includes(tab)) return;
  const held = stepList().contains(document.activeElement) && !document.activeElement.closest('button');
  const changed = app.tab !== tab;
  app.tab = tab;
  app.view = tab === 'trace' ? 'trace' : 'flow';
  app.tabNamed = true;
  writeHash();
  if (!changed) return;
  update();
  if (held || focus) {
    const target = tab === 'records' ? $('records-tab').querySelector('button, a[href]') : stepList().querySelector('[tabindex="0"]');
    target?.focus({ preventScroll: true });
  }
}

function setLens(id) {
  const all = lensesOf(app);
  if (!all.some((l) => l.id === id) || app.lens === id) return;
  app.lens = id;
  app.lensNamed = true;
  writeHash();
  update();
}

function nextLens() {
  const all = lensesOf(app);
  if (!all.length) return;
  const at = all.findIndex((l) => l.id === app.lens);
  setLens(all[(at + 1) % all.length].id);
}

// ---- Replay: a finished run walked step by step. Nothing runs again: the
// page shows the steps after the one the replay stands at as not yet begun.

function startReplay() {
  if (!app.run?.outcome) return;
  app.replay = { n: 0 };
  app.replayDone = false;
  app.follow = false;
  app.selection = { kind: 'overview' };
  update();
  focusSelectedRowIfInList();
}

function replayTo(n, selection = null) {
  const count = stepCount();
  const before = app.replay ? app.replay.n : 0;
  const to = Math.max(0, Math.min(count, n));
  app.replay = to >= count ? null : { n: to };
  app.replayDone = to >= count;
  app.follow = false;
  app.selection = to === 0 ? { kind: 'overview' } : (selection ?? { kind: 'step', index: to - 1 });
  update();
  focusSelectedRowIfInList();
  if (to > before) announceShown(before, to);
}

// ---- Runs

function stopPolling() {
  clearTimeout(app.pollTimer);
  app.pollTimer = null;
}

async function poll(id) {
  if (app.runId !== id) return;
  const res = await getRun(id);
  if (app.runId !== id) return;
  if (res) {
    const text = JSON.stringify(res);
    if (text !== app.runText) {
      app.runText = text;
      app.run = res;
      app.runStamp += 1;
      if (res.outcome) app.done.add(res.kind);
      applyFollow();
      update();
      focusSelectedRowIfInList();
      announce();
    } else {
      // The state is as it was, and the clock has moved.
      tickTrace(app, $('trace'));
    }
    if (res.finishedAt) {
      app.lastFinished = id;
      update();
      return;
    }
  }
  app.pollTimer = setTimeout(() => poll(id), POLL_MS);
}

async function runKind(kind) {
  const at = app.scenes.findIndex((s) => s.kind === kind);
  if (at >= 0) app.sceneIndex = at;
  if (kind === OFFLINE_KIND) {
    await audit();
    return;
  }
  app.runError = null;
  const res = await startRun(kind);
  if (!res.runId) {
    app.runError = res.error ? { text: res.error, src: from.doc('post', 'error') } : null;
    update();
    return;
  }
  stopPolling();
  app.runId = res.runId;
  app.run = null;
  app.runText = '';
  app.runStamp += 1;
  app.selection = { kind: 'overview' };
  app.follow = true;
  app.replay = null;
  app.replayDone = false;
  app.traceOpen = new Map();
  app.offline = null;
  app.offlineStamp += 1;
  app.openRecord = null;
  app.seen = new Map();
  app.announcedOutcome = null;
  if (app.tab === 'records') { app.tab = 'sequence'; app.view = 'flow'; writeHash(); }
  update();
  // The run is chosen and running: the keys that follow act on the steps,
  // so the focus moves there from a control that started it.
  const active = document.activeElement;
  if (!active || active === document.body || $('pane-left').contains(active) || $('pane-flow').contains(active)) {
    stepList().querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  }
  await poll(res.runId);
}

function runScene() {
  const scene = app.scenes[app.sceneIndex];
  if (scene) runKind(scene.kind);
}

const auditReady = () => Boolean(app.lastFinished && app.lastFinished === app.runId && app.run?.finishedAt);

async function audit() {
  if (!auditReady()) return;
  const at = app.scenes.findIndex((s) => s.kind === OFFLINE_KIND);
  if (at >= 0) app.sceneIndex = at;
  const id = app.runId;
  const result = await runOfflineCheck(id);
  if (app.runId !== id || !result) return;
  app.offline = { runId: id, result };
  app.offlineStamp += 1;
  app.done.add(OFFLINE_KIND);
  app.tab = 'records';
  app.view = 'flow';
  app.tabNamed = true;
  writeHash();
  select({ kind: 'offline' });
  const active = document.activeElement;
  if (!active || active === document.body || active.closest('#outcome-end, #pane-left, #records-tab')) $('tab-records')?.focus({ preventScroll: true });
}

// Back to the start of the walkthrough: no run on screen and no act done.
function startAgain() {
  stopPolling();
  Object.assign(app, {
    run: null, runId: null, runText: '', runError: null, lastFinished: null,
    selection: { kind: 'overview' }, follow: true, replay: null, replayDone: false,
    traceOpen: new Map(), offline: null, openRecord: null, seen: new Map(), announcedOutcome: null,
    sceneIndex: 0, done: new Set(), tab: 'sequence', view: 'flow',
  });
  app.runStamp += 1;
  app.offlineStamp += 1;
  writeHash();
  update();
  $('orient').querySelector('button')?.focus({ preventScroll: true });
}

// The one action the outcome offers next: after a payment that went
// through, the poisoned invoice; after a stop, the audit; after the audit,
// the start again.
function nextAction() {
  const run = app.run;
  if (!run?.outcome) return null;
  if (app.offline && app.offline.runId === app.runId) {
    const words = app.w.word('ui.startAgain');
    return words ? { id: 'start-again', button: put('button', 'btn btn-primary', words, { type: 'button', id: 'next-action', 'data-next': 'start-again', on: null }) } : null;
  }
  if (run.outcome === 'paid' && !app.done.has('poisoned')) {
    const button = sceneButton(app, 'poisoned', 'btn-primary', () => runKind('poisoned'));
    if (button) { button.id = 'next-action'; button.dataset.next = 'poisoned'; }
    return button ? { id: 'poisoned', button } : null;
  }
  if (!auditReady()) return null;
  const words = app.w.word('ui.audit');
  return words ? { id: 'audit', button: put('button', 'btn btn-primary', words, { type: 'button', id: 'next-action', 'data-next': 'audit' }) } : null;
}

function onNextAction(event) {
  const button = event.target.closest('#next-action');
  if (!button) return;
  if (button.dataset.next === 'start-again') startAgain();
  else if (button.dataset.next === 'audit') audit();
}

// ---- Rendering

function sceneTitle(kind) {
  const all = app.labels.scenes ?? [];
  const s = all.findIndex((scene) => scene.kind === kind);
  return s >= 0 ? [all[s].title, from.labels(`scenes[${s}].title`)] : null;
}

// Where the walkthrough stands: which act of the menu, and which step.
function whereWords() {
  if (!app.run) return null;
  const auditShown = app.offline && app.offline.runId === app.runId && (app.selection.kind === 'offline' || app.tab === 'records');
  const kind = auditShown ? OFFLINE_KIND : app.run.kind;
  const act = app.scenes.findIndex((s) => s.kind === kind);
  const title = sceneTitle(kind);
  if (act < 0 || !title) return null;
  const base = { n: [String(act + 1), from.view('act')], total: [String(app.scenes.length), from.view('acts')], scene: title };
  const at = app.selection.kind === 'step' ? app.selection.index + 1 : 0;
  if (!auditShown && at > 0) return app.w.line('ui.whereStep', { ...base, step: [String(at), from.view('step')], steps: [String(stepCount()), from.run('steps', 'count')] });
  return app.w.line('ui.where', base);
}

function renderTop() {
  const title = app.w.word('ui.title');
  document.querySelector('title').textContent = title?.text ?? '';
  const h1 = $('app-title');
  if (title && h1.textContent !== title.text) { h1.textContent = title.text; h1.dataset.src = title.src; }

  const where = whereWords();
  const host = $('where');
  if (!where) { if (host.firstChild) host.replaceChildren(); delete host.dataset.src; } else if (host.textContent !== where.text || host.dataset.src !== where.src) { host.textContent = where.text; host.dataset.src = where.src; }

  const sw = $('mode-switch');
  if (!sw.firstElementChild) {
    const name = app.w.word('ui.modeName');
    if (name) sw.setAttribute('aria-label', name.text);
    for (const mode of ['story', 'inspect']) {
      const word = app.w.word(`mode.${mode}`);
      sw.append(el('button', { type: 'button', src: word?.src, text: word?.text, data: { mode }, on: { click: () => setMode(mode) } }));
    }
  }
  for (const button of sw.children) button.setAttribute('aria-pressed', button.dataset.mode === app.mode ? 'true' : 'false');

  const pick = $('lens-pick');
  const lenses = lensesOf(app);
  if (!pick.firstElementChild && lenses.length) {
    const label = app.w.word('ui.lens');
    const select = el('select', { id: 'lens-select', on: { change: (event) => setLens(event.target.value) } },
      lenses.map((lens) => put('option', null, app.w.word(`lens.${lens.id}`), { value: lens.id })));
    add(pick, put('label', 'lens-label', label, { for: 'lens-select' }), select);
  }
  const select = $('lens-select');
  if (select && select.value !== app.lens) select.value = app.lens;

  const line = $('run-line');
  const signature = app.run ? app.runId : 'none';
  if (line.dataset.signature === signature) return;
  line.dataset.signature = signature;
  clear(line);
  if (!app.run) return;
  add(line, el('span', { class: 'run-id' }, put('span', 'mono', value(app.run, 'runId')), copyButton(app, app.run.runId, 'runId')));
}

function renderTabs() {
  const host = $('tabs');
  if (!host.firstElementChild) {
    const name = app.w.word('ui.tabsName');
    if (name) host.setAttribute('aria-label', name.text);
    for (const tab of TABS) {
      const word = app.w.word(`ui.tab${tab[0].toUpperCase()}${tab.slice(1)}`);
      host.append(el('button', { class: 'tab', type: 'button', role: 'tab', id: `tab-${tab}`, 'aria-controls': `panel-${tab}`, src: word?.src, text: word?.text, data: { tab }, on: { click: () => setTab(tab, { focus: true }) } }));
    }
  }
  for (const button of host.children) {
    const on = button.dataset.tab === app.tab;
    button.setAttribute('aria-selected', on ? 'true' : 'false');
    button.setAttribute('tabindex', on ? '0' : '-1');
  }
  for (const tab of TABS) $(`panel-${tab}`).hidden = tab !== app.tab;
}

function buildLeft() {
  const host = clear($('pane-left'));
  const name = app.w.word('ui.menuName');
  if (name) host.setAttribute('aria-label', name.text);
  const list = el('div', { class: 'scenes', id: 'scenes' });
  const all = app.labels.scenes ?? [];
  app.scenes.forEach((scene, n) => {
    const s = all.indexOf(scene);
    list.append(el('button', { class: 'scene', type: 'button', data: { scene: String(n), kind: scene.kind }, on: { click: () => chooseAndRun(n) } },
      el('span', { class: 'scene-num num', src: from.view('position'), text: String(n + 1) }),
      el('span', { class: 'scene-words' },
        put('span', 'scene-title', app.w.label(`scenes[${s}].title`)),
        put('span', 'scene-text', app.w.label(`scenes[${s}].text`))),
      el('span', { class: 'scene-done', hidden: true }, iconEl(app.labels.states?.passed?.icon), el('span', { class: 'scene-done-word' }))));
  });
  const keys = app.labels.keys ?? {};
  const stepControl = (key, press) => {
    const word = app.w.word(`menu.${key}`);
    return word ? el('button', { class: 'step-control', id: `step-${key}`, type: 'button', src: word.src, text: word.text, 'aria-label': app.w.word(`menu.${key}Name`)?.text, title: keys[key], disabled: true, on: { click: press } }) : null;
  };
  add(host,
    list,
    el('div', { class: 'run-block' },
      el('button', { class: 'btn btn-quiet run-control', id: 'run-control', type: 'button', on: { click: onRunControl } }),
      put('p', 'run-help', app.w.word('help.offlineDisabled'), { id: 'run-help', hidden: true }),
      el('p', { class: 'run-error', id: 'run-error', role: 'alert', hidden: true })),
    el('div', { class: 'step-controls', id: 'step-controls', role: 'group', 'aria-label': app.w.word('menu.controlsName')?.text },
      stepControl('back', back),
      el('span', { class: 'step-of num', id: 'step-of' }),
      stepControl('forward', forward),
      stepControl('replay', startReplay)));
}

function updateLeft() {
  const scene = app.scenes[app.sceneIndex];
  const all = app.labels.scenes ?? [];
  const s = scene ? all.indexOf(scene) : -1;
  const doneWord = app.w.word('ui.done');
  for (const button of $('scenes').children) {
    const on = Number(button.dataset.scene) === app.sceneIndex;
    const done = app.done.has(button.dataset.kind);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('tabindex', on ? '0' : '-1');
    button.dataset.done = done ? 'yes' : 'no';
    const mark = button.querySelector('.scene-done');
    const word = mark.querySelector('.scene-done-word');
    mark.hidden = !done;
    if (done && doneWord && word.textContent !== doneWord.text) { word.textContent = doneWord.text; word.dataset.src = doneWord.src; }
    const unavailable = button.dataset.kind === OFFLINE_KIND && !auditReady();
    button.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
    if (unavailable) button.setAttribute('aria-describedby', 'run-help'); else button.removeAttribute('aria-describedby');
  }

  const control = $('run-control');
  const title = s >= 0 ? { scene: [scene.title, from.labels(`scenes[${s}].title`)] } : null;
  const name = title ? app.w.line('button.runName', title) : null;
  const again = Boolean(title && app.run?.finishedAt && app.run.kind === scene.kind);
  const spoken = (again ? app.w.line('menu.runAgainName', title) : null) ?? name;
  const text = scene?.kind === OFFLINE_KIND ? app.w.word('ui.audit') : s >= 0 ? (app.w.label(`scenes[${s}].button`) ?? name) : null;
  if (text && control.textContent !== text.text) control.textContent = text.text;
  if (text) control.dataset.src = text.src;
  if (spoken) control.setAttribute('aria-label', spoken.text);

  for (const [id, off] of [['step-back', !app.run], ['step-forward', !app.run], ['step-replay', !app.run?.outcome]]) {
    const button = $(id);
    if (button) button.disabled = off;
  }
  const blocked = scene?.kind === OFFLINE_KIND && !auditReady();
  control.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  $('run-help').hidden = !blocked;
  if (blocked) control.setAttribute('aria-describedby', 'run-help'); else control.removeAttribute('aria-describedby');

  const of = $('step-of');
  const at = app.replay ? app.replay.n : app.selection.kind === 'step' ? app.selection.index + 1 : 0;
  const position = app.run && at > 0 ? app.w.line('ui.stepOf', { n: [String(at), from.view(app.replay ? 'replay' : 'step')], total: [String(stepCount()), from.run('steps', 'count')] }) : app.w.word('ui.stepNone');
  if (position && (of.textContent !== position.text || of.dataset.src !== position.src)) { of.textContent = position.text; of.dataset.src = position.src; }

  const error = $('run-error');
  error.hidden = !app.runError;
  if (app.runError) { error.textContent = app.runError.text; error.dataset.src = app.runError.src; } else { error.textContent = ''; delete error.dataset.src; }
}

function renderFooter() {
  const host = $('footer');
  if (host.firstElementChild) return;
  const keys = app.labels.keys ?? {};
  const help = app.w.word('ui.help');
  add(host,
    put('p', 'footer-mock', app.w.word('footer.mock')),
    put('p', 'footer-keys', app.w.line('ui.keys', {
      next: [keys.next, from.labels('keys.next')], prev: [keys.prev, from.labels('keys.prev')], run: [keys.run, from.labels('keys.run')],
      audit: [keys.audit, from.labels('keys.audit')], help: [keys.help, from.labels('keys.help')],
    })),
    help ? el('button', { class: 'help-btn', type: 'button', id: 'help-button', src: help.src, text: help.text, 'aria-label': app.w.word('ui.helpName')?.text, 'aria-haspopup': 'dialog', on: { click: openKeys } }) : null);
}

// The list of every key, in a dialog of its own.
const KEY_ROWS = [['next', 'keyhelp.next'], ['prev', 'keyhelp.prev'], ['digits', 'keyhelp.digits'], ['overview', 'keyhelp.overview'], ['home', 'keyhelp.home'], ['end', 'keyhelp.end'], ['run', 'keyhelp.run'], ['audit', 'keyhelp.audit'], ['story', 'keyhelp.story'], ['inspect', 'keyhelp.inspect'], ['trace', 'keyhelp.trace'], ['replay', 'keyhelp.replay'], ['lens', 'keyhelp.lens'], ['inspector', 'keyhelp.inspector'], ['help', 'keyhelp.help'], ['close', 'keyhelp.close']];

function buildKeys() {
  const dialog = $('keys-dialog');
  const keys = app.labels.keys ?? {};
  const close = app.w.word('ui.close');
  add(clear(dialog),
    el('div', { class: 'keys-head' },
      put('h2', 'keys-title', app.w.word('ui.keysTitle'), { id: 'keys-title' }),
      close ? el('button', { class: 'btn btn-quiet', type: 'button', src: close.src, text: close.text, on: { click: () => dialog.close() } }) : null),
    el('dl', { class: 'kv keys-list' }, KEY_ROWS.filter(([key]) => keys[key]).map(([key, words]) => el('div', { class: 'kv-row' },
      el('dt', { class: 'kv-key' }, el('kbd', { src: from.labels(`keys.${key}`), text: keys[key] })),
      put('dd', 'kv-value', app.w.word(words))))));
}

let keysOpener = null;
function openKeys() {
  const dialog = $('keys-dialog');
  if (dialog.open) return;
  keysOpener = document.activeElement;
  dialog.showModal();
}

// Say a change of state once: the step number and its state word, the run's
// reason when a step is stopped, and the outcome when it is decided.
function stepSaid(run, i) {
  const s = run.steps[i];
  const state = stateOf(app, s.status, from.run(`steps[${i}].status`));
  return el('span', null,
    el('span', { src: from.run(`steps[${i}]`, 'ordinal'), text: String(i + 1) }), ' ',
    put('span', null, state.word),
    s.status === 'blocked' ? [' ', put('span', null, value(run, 'reason'))] : null, ' ');
}

function announceShown(before, to) {
  const run = app.run;
  if (!run) return;
  const said = [];
  for (let i = before; i < to; i += 1) said.push(stepSaid(run, i));
  if (app.replayDone) said.push(put('span', null, app.w.word('menu.replayDone')));
  if (said.length) add(clear($('live')), said);
}

function announce() {
  const run = app.run;
  if (!run) return;
  const said = [];
  run.steps.forEach((s, i) => {
    const before = app.seen.get(s.id);
    app.seen.set(s.id, s.status);
    if (before === undefined && s.status === 'pending') return;
    if (before === s.status) return;
    said.push(stepSaid(run, i));
  });
  if (run.outcome && app.announcedOutcome !== run.outcome) {
    app.announcedOutcome = run.outcome;
    const headline = headlineOf(app, run);
    said.push(put('span', null, app.w.chosen(headline.key, headline.source)));
  }
  if (said.length) add(clear($('live')), said);
}

function scheduleTick() {
  clearTimeout(app.tickTimer);
  const wait = tickCountdowns(app);
  if (wait !== null) app.tickTimer = setTimeout(scheduleTick, wait + 4);
}

function update() {
  readWindow();
  const body = document.body.dataset;
  body.mode = app.mode;
  body.tab = app.tab;
  body.view = app.view;
  body.lens = app.lens;
  body.size = app.size;
  body.stacked = app.stacked ? 'yes' : 'no';
  body.run = app.run ? (app.run.outcome ?? 'running') : 'none';
  body.step = app.selection.kind === 'step' ? String(app.selection.index + 1) : '0';

  renderTop();
  renderTabs();
  updateLeft();
  renderOrientation(app, $('orient'), (kind) => runKind(kind));
  renderInvoice(app, $('invoice'));
  const head = $('lanes-head');
  const variants = (app.run?.steps ?? []).map((s) => s.variant ?? '').join(',');
  const laneSignature = `${app.labelsStamp}|${variants}`;
  if (head.dataset.signature !== laneSignature) {
    head.dataset.signature = laneSignature;
    renderLanes(app, head);
  }
  syncRows(app, $('rows'), $('flow'));
  renderTrace(app, $('trace'));
  renderRecords(app, $('records-tab'), { auditReady, audit, choose: (selection) => select(selection) });
  renderOutcome(app, $('outcome-end'), nextAction);
  renderInspector(app, $('pane-inspector'));
  body.act = $('where').dataset.src ? String(1 + app.scenes.findIndex((s) => s.kind === ((app.offline && app.offline.runId === app.runId && (app.selection.kind === 'offline' || app.tab === 'records')) ? OFFLINE_KIND : app.run?.kind))) : '0';
  revealSelected();
  scheduleTick();
}

// ---- Keys and clicks

function chooseScene(n) {
  if (n < 0 || n >= app.scenes.length) return;
  app.sceneIndex = n;
  app.runError = null;
  update();
}

// A click on an item of the menu chooses it and runs it: one click per act.
function chooseAndRun(n) {
  chooseScene(n);
  onRunControl();
}

function onRunControl() {
  const scene = app.scenes[app.sceneIndex];
  if (scene?.kind === OFFLINE_KIND && !auditReady()) return;
  runScene();
}

function onRowsClick(event) {
  const row = event.target.closest('.row');
  if (!row || !app.run) return;
  select({ kind: 'step', index: Number(row.dataset.index) });
  row.focus();
}

function onTabKey(event) {
  const tab = event.target.closest?.('[role="tab"]');
  if (!tab) return false;
  const at = TABS.indexOf(tab.dataset.tab);
  let next = null;
  if (event.key === 'ArrowRight') next = TABS[(at + 1) % TABS.length];
  else if (event.key === 'ArrowLeft') next = TABS[(at + TABS.length - 1) % TABS.length];
  else if (event.key === 'Home') next = TABS[0];
  else if (event.key === 'End') next = TABS[TABS.length - 1];
  if (!next) return false;
  event.preventDefault();
  setTab(next);
  $(`tab-${next}`).focus();
  return true;
}

function onKey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if ($('keys-dialog').open) return;
  const target = event.target;
  const key = event.key;
  const inScenes = $('scenes').contains(target);

  if (inScenes && (key === 'ArrowDown' || key === 'ArrowUp')) {
    event.preventDefault();
    chooseScene(app.sceneIndex + (key === 'ArrowDown' ? 1 : -1));
    $('scenes').children[app.sceneIndex]?.focus();
    return;
  }
  if (onTabKey(event)) return;
  // A row of the trace that holds the focus takes the keys of a tree grid.
  if (traceKey(app, event)) return;
  // The lens control keeps its own arrows; a focused control its Enter and Space.
  if (target instanceof HTMLSelectElement) return;
  const onControl = target instanceof HTMLElement && target.closest('button, a[href], summary');
  if (onControl && (key === 'Enter' || key === ' ')) return;
  if (key === '?') { event.preventDefault(); openKeys(); return; }
  // Enter on a step of the sequence moves into the inspector; Escape there
  // comes back to the step.
  if (key === 'Enter' && $('rows').contains(target)) { event.preventDefault(); $('inspector-heading')?.focus(); return; }
  if (key === 'Escape' && $('pane-inspector').contains(target)) { event.preventDefault(); stepList().querySelector('[tabindex="0"]')?.focus(); return; }

  const handle = () => { event.preventDefault(); return true; };
  if (key === 'ArrowRight' || (key === ' ' && !event.shiftKey)) return handle() && step(1);
  if (key === 'ArrowLeft' || (key === ' ' && event.shiftKey)) return handle() && step(-1);
  if (key === 'Home') return handle() && stepCount() && select({ kind: 'step', index: 0 });
  if (key === 'End') return handle() && toEnd();
  if (/^[0-9]$/.test(key)) {
    event.preventDefault();
    if (!app.run) return undefined;
    const n = Number(key);
    if (n === 0) return select({ kind: 'overview' });
    if (n <= stepCount()) return select({ kind: 'step', index: n - 1 });
    return undefined;
  }
  if (event.shiftKey) return undefined;
  const letter = key.length === 1 ? key.toLowerCase() : '';
  if (letter === 'j') return handle() && step(1);
  if (letter === 'k') return handle() && step(-1);
  if (letter === 'r') return handle() && onRunControl();
  if (letter === 'o') { event.preventDefault(); return audit(); }
  if (letter === 's') return handle() && setMode('story');
  if (letter === 'i') return handle() && setMode('inspect');
  if (letter === 't') return handle() && setTab(app.tab === 'trace' ? 'sequence' : 'trace');
  if (letter === 'p') return handle() && startReplay();
  if (letter === 'v') return handle() && nextLens();
  return undefined;
}

// ---- Start

async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function start() {
  installSprite();
  const [copy, bundled, served] = await Promise.all([loadJson('./copy.json'), loadJson('./labels.json'), getLabels()]);
  app.copy = copy;
  // A key the server returns replaces the bundled key whole; a key it lacks stays.
  app.labels = served && typeof served === 'object' ? { ...bundled, ...served } : bundled;
  app.labelsStamp += 1;
  app.w = words(app.copy, app.labels);
  app.scenes = (app.labels.scenes ?? []).filter((s) => s.available !== false && !UNHANDLED_KINDS.includes(s.kind));
  const lenses = lensesOf(app);
  if (!lenses.some((l) => l.id === app.lens)) {
    app.lens = lenses[0]?.id ?? null;
    app.lensNamed = false;
  }

  buildLeft();
  buildKeys();
  renderFooter();
  update();

  document.addEventListener('keydown', onKey);
  $('rows').addEventListener('click', onRowsClick);
  $('trace').addEventListener('click', (event) => traceClick(app, event));
  $('outcome-end').addEventListener('click', onNextAction);
  $('keys-dialog').addEventListener('close', () => { keysOpener?.focus?.(); keysOpener = null; });
  window.addEventListener('resize', update);
  window.addEventListener('hashchange', () => {
    const next = readHash();
    app.tab = next.tab;
    app.view = next.tab === 'trace' ? 'trace' : 'flow';
    app.tabNamed = next.named;
    if (next.lens && lensesOf(app).some((l) => l.id === next.lens)) { app.lens = next.lens; app.lensNamed = true; }
    if (app.mode === next.mode) update(); else setMode(next.mode);
  });
  if (document.fonts?.ready) document.fonts.ready.then(update);

  document.body.dataset.ready = 'yes';
  $('orient').querySelector('button')?.focus();
}

start();
