// The page: one screen that renders from the run API of the contract.
//
// It loads the copy deck and its own label file (the structure of the screen
// and the screens' words for the parts and the scenes), asks the server for
// the contract's label map, which carries every part label, party role,
// stand-in note and button, then waits for a key or a click. Every word on
// screen is a line of the copy deck, a string of the label map or a value of
// the run; this file holds none of its own.

import { el, put, add, from, value, words, clear } from './dom.mjs';
import { installSprite, iconEl } from './icons.mjs';
import { startRun, getRun, getLabels, getFile, runOfflineCheck } from './api.mjs';
import { listZip, readEntry, entryText } from './zip.mjs';
import { copyButton, tickCountdowns, stateOf, headlineOf } from './parts.mjs';
import { renderInvoice, renderLanes, measureLanes, syncRows, renderOutcomeEnd } from './flow.mjs';
import { renderInspector } from './inspector.mjs';
import { renderTrace, tickTrace, traceKey, traceClick } from './trace.mjs';
import { UNHANDLED_KINDS, OFFLINE_KIND, TEXT_MODE_COMMAND, POLL_MS, SIZES } from './constants.mjs';

const $ = (id) => document.getElementById(id);

// What the address names: the mode (#story or #inspect) and, after it, the
// view of the middle pane (-flow or -trace). An address that names no view
// means the flow.
function readHash() {
  const m = /^#(story|inspect)(?:-(flow|trace))?$/.exec(location.hash);
  return { mode: m ? m[1] : 'story', view: m?.[2] ?? 'flow', named: Boolean(m?.[2]) };
}

const opened = readHash();

const app = {
  copy: {},
  labels: {},
  labelsStamp: 0,
  w: null,
  mode: opened.mode,
  view: opened.view,
  viewNamed: opened.named,
  replay: null,
  replayDone: false,
  traceOpen: new Map(),
  shown: null,
  tier: 'standard',
  stacked: false,
  full: true,
  size: 'inspect',
  reducedMotion: false,
  scenes: [],
  sceneIndex: 0,
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
  many: false,
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

// What the trace asks of the page: open a row's step in the inspector, and
// open or close the rows inside a step.
app.choose = (selection) => select(selection);
app.setOpen = (id, open) => {
  app.traceOpen.set(id, open);
  update();
};

// ---- Window size: the tier and whether the Story sizes fit

function readWindow() {
  const wide = window.innerWidth;
  const high = window.innerHeight;
  const roomy = wide >= SIZES.storyWidth && high >= SIZES.storyHeight;
  app.tier = !roomy ? 'compact' : wide >= SIZES.wideWidth && high >= SIZES.wideHeight ? 'wide' : 'standard';
  app.stacked = wide < SIZES.stack;
  app.full = wide >= SIZES.fullWidth;
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
  focusSelectedRowIfInFlow();
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
  focusSelectedRowIfInFlow();
}

// The step controls. Back is the previous step. Forward is the next one,
// and on the last step it turns follow on, as the End key does.
function back() {
  step(-1);
}

function forward() {
  const n = stepCount();
  if (!n) return;
  if (!app.replay && app.selection.kind === 'step' && app.selection.index >= n - 1) toEnd(); else step(1);
}

// The list of steps on screen: the rows of the flow, or the rows of the trace.
const stepList = () => $(app.view === 'trace' ? 'trace' : 'rows');

function focusSelectedRowIfInFlow() {
  const list = stepList();
  if (!list.contains(document.activeElement)) return;
  list.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
}

// Should the flow ever be taller than its pane (a small window, longer
// labels), the selected row is brought into sight. The trace may be taller
// than its pane in Inspect: its selected row is brought into sight once for
// each selection, so a reader who scrolls is not pulled back.
function revealSelected() {
  if (app.view === 'trace') {
    const body = $('trace').querySelector('.trace-body');
    const key = `${app.runId}|${JSON.stringify(app.selection)}`;
    if (!body || app.shown === key) return;
    app.shown = key;
    if (body.scrollHeight > body.clientHeight) body.querySelector('[tabindex="0"]')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  app.shown = null;
  const flow = $('flow');
  if (flow.scrollHeight <= flow.clientHeight) return;
  $('rows').querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
}

function writeHash() {
  history.replaceState(null, '', `#${app.mode}${app.viewNamed ? `-${app.view}` : ''}`);
}

function setMode(mode) {
  if (app.mode === mode) return;
  app.mode = mode;
  app.follow = mode === 'story';
  writeHash();
  applyFollow();
  update();
}

// Show the flow or the trace. The panes stay where they are: what changes
// is what the middle pane shows under the invoice. From then on the address
// names the view beside the mode.
function setView(view) {
  const held = stepList().contains(document.activeElement) && !document.activeElement.closest('button');
  const changed = app.view !== view;
  app.view = view;
  app.viewNamed = true;
  writeHash();
  if (!changed) return;
  update();
  if (held) stepList().querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
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
  focusSelectedRowIfInFlow();
}

// Stand the replay at a step: that many steps show as they ended. Past the
// last step the replay is over and the run shows as it was recorded.
function replayTo(n, selection = null) {
  const count = stepCount();
  const before = app.replay ? app.replay.n : 0;
  const to = Math.max(0, Math.min(count, n));
  app.replay = to >= count ? null : { n: to };
  app.replayDone = to >= count;
  app.follow = false;
  app.selection = to === 0 ? { kind: 'overview' } : (selection ?? { kind: 'step', index: to - 1 });
  update();
  focusSelectedRowIfInFlow();
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
      applyFollow();
      update();
      focusSelectedRowIfInFlow();
      announce();
    } else {
      // The state is as it was, and the clock has moved.
      tickTrace(app, $('trace'));
    }
    if (res.finishedAt) {
      app.lastFinished = id;
      updateLeft();
      return;
    }
  }
  app.pollTimer = setTimeout(() => poll(id), POLL_MS);
}

async function runScene() {
  const scene = app.scenes[app.sceneIndex];
  if (!scene) return;
  if (scene.kind === OFFLINE_KIND) {
    await offlineCheck();
    return;
  }
  app.runError = null;
  // A finished run of this scene on screen: the control runs it again.
  const again = Boolean(app.run?.finishedAt && app.run.kind === scene.kind);
  const res = await startRun(scene.kind);
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
  app.follow = again || app.mode === 'story';
  app.replay = null;
  app.replayDone = false;
  app.traceOpen = new Map();
  app.offline = null;
  app.offlineStamp += 1;
  app.openRecord = null;
  app.seen = new Map();
  app.announcedOutcome = null;
  update();
  // The scene is chosen and running: the keys that follow act on the steps,
  // so the focus moves there from the scene list, the run control (where
  // Space would press the control again) or a step control.
  const active = document.activeElement;
  if (!active || active === document.body || $('pane-left').contains(active)) stepList().querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  await poll(res.runId);
}

const offlineReady = () => Boolean(app.lastFinished && app.lastFinished === app.runId && app.run?.finishedAt);

async function offlineCheck() {
  if (!offlineReady()) return;
  const id = app.runId;
  const result = await runOfflineCheck(id);
  if (app.runId !== id || !result) return;
  app.offline = { runId: id, result };
  app.offlineStamp += 1;
  select({ kind: 'offline' });
}

// ---- Rendering

function renderTop() {
  const title = app.w.word('app.title');
  document.querySelector('title').textContent = title?.text ?? '';
  const h1 = $('app-title');
  if (title && h1.textContent !== title.text) { h1.textContent = title.text; h1.dataset.src = title.src; }

  const sw = $('mode-switch');
  if (!sw.firstElementChild) {
    for (const mode of ['story', 'inspect']) {
      const word = app.w.word(`mode.${mode}`);
      sw.append(el('button', { type: 'button', src: word?.src, text: word?.text, data: { mode }, on: { click: () => setMode(mode) } }));
    }
  }
  for (const button of sw.children) button.setAttribute('aria-pressed', button.dataset.mode === app.mode ? 'true' : 'false');

  const views = $('view-switch');
  if (!views.firstElementChild) {
    const name = app.w.word('view.switchName');
    if (name) views.setAttribute('aria-label', name.text);
    for (const view of ['flow', 'trace']) {
      const word = app.w.word(`view.${view}`);
      views.append(el('button', { type: 'button', src: word?.src, text: word?.text, data: { view }, on: { click: () => setView(view) } }));
    }
  }
  for (const button of views.children) button.setAttribute('aria-pressed', button.dataset.view === app.view ? 'true' : 'false');

  const line = $('run-line');
  const signature = app.run ? `${app.runId}|${app.run.outcome ?? ''}|${app.run.blockedAt ?? ''}` : 'none';
  if (line.dataset.signature === signature) return;
  line.dataset.signature = signature;
  clear(line);
  if (!app.run) return;
  const headline = headlineOf(app, app.run);
  const states = app.labels.states ?? {};
  const icon = app.run.outcome === 'blocked' ? states.blocked?.icon : app.run.outcome ? states.passed?.icon : states.running?.icon;
  add(line,
    el('span', { class: 'run-id' }, put('span', 'mono', value(app.run, 'runId')), copyButton(app, app.run.runId, 'runId')),
    app.run.startedAt ? el('time', { class: 'run-started num', datetime: app.run.startedAt, src: from.run('startedAt', 'clock'), text: String(app.run.startedAt).slice(11) }) : null,
    el('span', { class: 'run-outcome', data: { tone: headline.tone } }, iconEl(icon), put('span', null, app.w.chosen(headline.key, headline.source))));
}

function buildLeft() {
  const host = clear($('pane-left'));
  const sceneList = el('div', { class: 'scenes', id: 'scenes' });
  const all = app.labels.scenes ?? [];
  app.scenes.forEach((scene, n) => {
    const s = all.indexOf(scene);
    sceneList.append(el('button', { class: 'scene', type: 'button', data: { scene: String(n), kind: scene.kind }, on: { click: () => chooseScene(n) } },
      put('span', 'scene-id', { text: String(scene.id), src: from.labels(`scenes[${s}].id`) }),
      put('span', 'scene-title', app.w.label(`scenes[${s}].title`)),
      put('span', 'scene-text', app.w.label(`scenes[${s}].text`))));
  });
  const keys = app.labels.keys ?? {};
  const command = app.w.lineNodes('app.textMode', { command: [TEXT_MODE_COMMAND, from.constant('textModeCommand')] }, ['command']);
  // A step control: its word, its name for a screen reader and, as its
  // title, the key that does the same.
  const stepControl = (name, press) => {
    const word = app.w.word(`menu.${name}`);
    return word ? el('button', { class: 'step-control', id: `step-${name}`, type: 'button', src: word.src, text: word.text, 'aria-label': app.w.word(`menu.${name}Name`)?.text, title: keys[name], disabled: true, on: { click: press } }) : null;
  };
  add(host,
    put('h2', 'pane-heading', app.w.word('app.scenes'), { id: 'scenes-heading' }),
    put('p', 'app-sentence', app.w.word('app.sentence'), { id: 'app-sentence' }),
    sceneList,
    el('div', { class: 'run-block' },
      el('button', { class: 'run-control', id: 'run-control', type: 'button', on: { click: onRunControl } }),
      put('p', 'run-help', app.w.word('help.offlineDisabled'), { id: 'run-help', hidden: true }),
      el('p', { class: 'run-error', id: 'run-error', role: 'alert', hidden: true }),
      el('div', { class: 'step-controls', id: 'step-controls', role: 'group', 'aria-label': app.w.word('menu.controlsName')?.text },
        stepControl('back', back), stepControl('forward', forward), stepControl('replay', startReplay))),
    el('div', { class: 'limits', id: 'limits' }),
    el('div', { class: 'left-foot' },
      put('p', null, app.w.line('keys.hint', { nextKey: [keys.next, from.labels('keys.next')], prevKey: [keys.prev, from.labels('keys.prev')], modeKey: [keys.mode, from.labels('keys.mode')] })),
      put('p', null, app.w.line('keys.hintMore', { traceKey: [keys.trace, from.labels('keys.trace')], replayKey: [keys.replay, from.labels('keys.replay')] })),
      put('p', null, command)));
}

function updateLeft() {
  const scene = app.scenes[app.sceneIndex];
  const all = app.labels.scenes ?? [];
  const s = scene ? all.indexOf(scene) : -1;
  for (const button of $('scenes').children) {
    const on = Number(button.dataset.scene) === app.sceneIndex;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('tabindex', on ? '0' : '-1');
  }
  $('app-sentence').hidden = Boolean(app.run);

  const control = $('run-control');
  const title = s >= 0 ? { scene: [scene.title, from.labels(`scenes[${s}].title`)] } : null;
  const name = title ? app.w.line('button.runName', title) : null;
  // While a finished run of the scene is on screen the control runs it again,
  // and its name says so.
  const again = Boolean(title && app.run?.finishedAt && app.run.kind === scene.kind);
  const spoken = (again ? app.w.line('menu.runAgainName', title) : null) ?? name;
  // The button of the scene is a string of the label map the server answers.
  // A server with no label map leaves the control the deck's line for its name.
  const text = s >= 0 ? (app.w.label(`scenes[${s}].button`) ?? name) : null;
  if (text && control.textContent !== text.text) control.textContent = text.text;
  if (text) control.dataset.src = text.src;
  if (spoken) control.setAttribute('aria-label', spoken.text);

  // Back and Forward need a run; Replay needs a run whose outcome is decided.
  for (const [id, off] of [['step-back', !app.run], ['step-forward', !app.run], ['step-replay', !app.run?.outcome]]) {
    const button = $(id);
    if (button) button.disabled = off;
  }
  const offline = scene?.kind === OFFLINE_KIND;
  const blocked = offline && !offlineReady();
  control.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  $('run-help').hidden = !blocked;
  if (blocked) control.setAttribute('aria-describedby', 'run-help'); else control.removeAttribute('aria-describedby');

  const error = $('run-error');
  error.hidden = !app.runError;
  if (app.runError) { error.textContent = app.runError.text; error.dataset.src = app.runError.src; } else { error.textContent = ''; delete error.dataset.src; }

  const limits = $('limits');
  const run = app.run;
  const pace = run ? app.w.line('run.paced', { paceSeconds: [run.paceSeconds, from.run('paceSeconds')] }) : null;
  const c = run ? run.steps.findIndex((st) => st.detail?.verifier) : -1;
  const verifier = c >= 0 ? String(run.steps[c].detail.verifier) : null;
  const pq = verifier ? app.w.line('limit.pq', { version: [verifier.slice(verifier.lastIndexOf(' ') + 1), from.run(`steps[${c}].detail.verifier`, 'afterLastSpace')] }) : null;
  const signature = `${pace?.text ?? ''}|${pq?.text ?? ''}`;
  if (limits.dataset.signature !== signature) {
    limits.dataset.signature = signature;
    add(clear(limits),
      put('h3', 'limits-heading', app.w.word('app.limits')),
      put('p', null, pace),
      put('p', null, pq),
      put('p', null, app.w.word('limit.steps')));
  }
}

function renderFooter() {
  const host = $('footer');
  if (host.firstElementChild) return;
  add(host, put('p', null, app.w.word('footer.fictional')), put('p', null, app.w.word('footer.mock')));
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

// A replay says each step it shows, as a change of state is said, and says
// when it is over.
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
  const live = $('live');
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
  if (said.length) add(clear(live), said);
}

function scheduleTick() {
  clearTimeout(app.tickTimer);
  const wait = tickCountdowns(app);
  if (wait !== null) app.tickTimer = setTimeout(scheduleTick, wait + 4);
}

function update() {
  readWindow();
  document.body.dataset.mode = app.mode;
  document.body.dataset.view = app.view;
  document.body.dataset.size = app.size;
  document.body.dataset.tier = app.tier;
  document.body.dataset.stacked = app.stacked ? 'yes' : 'no';
  document.body.dataset.run = app.run ? (app.run.outcome ?? 'running') : 'none';

  renderTop();
  updateLeft();
  renderInvoice(app, $('invoice'));

  app.many = (app.run ? app.run.steps.length : 0) > 6;
  // The middle pane shows the flow or the trace under the invoice. The rows
  // of the flow are kept up to date while the trace shows, so a change of
  // view shows the run as it is.
  const trace = app.view === 'trace';
  const head = $('lanes-head');
  head.hidden = trace;
  $('rows').hidden = trace;
  $('flow-space').hidden = trace;
  // The variants the run's steps name (a crossing that ran the capture check
  // shows no stand-in mark), so the header follows the run shown.
  const variants = (app.run?.steps ?? []).map((s) => s.variant ?? '').join(',');
  const laneSignature = `${app.tier}|${app.full}|${app.many}|${app.labelsStamp}|${variants}`;
  if (!trace && head.dataset.signature !== laneSignature) {
    head.dataset.signature = laneSignature;
    renderLanes(app, head);
  }
  syncRows(app, $('rows'), $('flow'));
  if (!trace) measureLanes($('flow'), head);
  renderTrace(app, $('trace'));
  renderOutcomeEnd(app, $('outcome-end'));
  renderInspector(app, $('pane-inspector'));
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

function onRunControl() {
  if ($('run-control').getAttribute('aria-disabled') === 'true') return;
  runScene();
}

function onRowsClick(event) {
  const row = event.target.closest('.row');
  if (!row || !app.run) return;
  select({ kind: 'step', index: Number(row.dataset.index) });
  row.focus();
}

function onKey(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const key = event.key;
  const inScenes = $('scenes').contains(target);

  if (inScenes && (key === 'ArrowDown' || key === 'ArrowUp')) {
    event.preventDefault();
    chooseScene(app.sceneIndex + (key === 'ArrowDown' ? 1 : -1));
    $('scenes').children[app.sceneIndex]?.focus();
    return;
  }
  // A row of the trace that holds the focus takes the keys of a tree grid.
  if (traceKey(app, event)) return;
  // A focused control keeps its own Enter and Space.
  const onControl = target instanceof HTMLElement && target.closest('button, a[href]');
  if (onControl && (key === 'Enter' || key === ' ')) return;

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
  if (letter === 'o') {
    event.preventDefault();
    if (!offlineReady()) return undefined;
    const at = app.scenes.findIndex((s) => s.kind === OFFLINE_KIND);
    if (at >= 0) app.sceneIndex = at;
    return offlineCheck();
  }
  if (letter === 's') return handle() && setMode('story');
  if (letter === 'i') return handle() && setMode('inspect');
  if (letter === 't') return handle() && setView(app.view === 'trace' ? 'flow' : 'trace');
  if (letter === 'p') return handle() && startReplay();
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

  buildLeft();
  renderFooter();
  update();

  document.addEventListener('keydown', onKey);
  $('rows').addEventListener('click', onRowsClick);
  $('trace').addEventListener('click', (event) => traceClick(app, event));
  window.addEventListener('resize', update);
  window.addEventListener('hashchange', () => {
    const next = readHash();
    app.view = next.view;
    app.viewNamed = next.named;
    if (app.mode === next.mode) update(); else setMode(next.mode);
  });
  if (document.fonts?.ready) document.fonts.ready.then(update);

  document.body.dataset.ready = 'yes';
  $('run-control').focus();
}

start();
