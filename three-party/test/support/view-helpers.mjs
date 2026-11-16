// Support for the view tests: a dev server and a real browser per test file,
// a record of what the run API served, the example states and fixtures
// derived from them, and the check that reads every text of the page against
// the source its data-src names.
//
// The browser is the installed Google Chrome through the launcher of
// ./browser.mjs: its own sandbox on, every host name but 127.0.0.1 resolving
// to not-found, and an environment made for that one start. Input is real
// throughout: page.click, page.keyboard, page.mouse.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { labelMapWith } from '../../src/engine/label-map.mjs';
import { startDevServer } from '../../view/dev-server.mjs';
import { STEP_ORDER, TEXT_MODE_COMMAND } from '../../view/constants.mjs';
import { browserStartChecks, launchBrowser } from './browser.mjs';

export { startDevServer };

// Starts the browser of a test file and proves the start before a test
// drives a page: the browser's command line shows its sandbox on and the
// resolver rule in force, a page on another host is refused by name, and in
// the same run a page of the view on 127.0.0.1 loads. The answer has the two
// things the tests use: newContext, and close, which stops the browser and
// removes the home and temp directories made for it.
export async function launchChrome() {
  const chrome = await launchBrowser();
  try {
    const server = await startDevServer();
    try {
      await browserStartChecks(chrome.browser, server.url);
    } finally {
      await server.close();
    }
  } catch (err) {
    await chrome.close();
    throw err;
  }
  return { newContext: (options) => chrome.browser.newContext(options), close: () => chrome.close() };
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VIEW = path.join(ROOT, 'view');
export const EXAMPLES = path.join(ROOT, 'examples');

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const COPY = readJson(path.join(VIEW, 'copy.json'));
// The view's own label file: the structure of the screen and the screens'
// words for the parts and the scenes. It holds no part or party label.
export const BUNDLED = readJson(path.join(VIEW, 'labels.json'));
// The contract's label map, as three-party/labels.json has it.
export const CONTRACT_LABELS = readJson(path.join(ROOT, 'labels.json'));
// The label map the page holds on a server of this tree: its own file, with
// each member the server's answer carries taken from that answer.
export const LABELS = { ...BUNDLED, ...labelMapWith(BUNDLED) };
export const example = (name) => readJson(path.join(EXAMPLES, name));

export const CLEAN_RUNNING = example('state-clean-running.json');
export const CLEAN_DONE = example('state-clean-done.json');
export const POISONED = example('state-poisoned-blocked.json');

// ---- Fixture directories derived from the examples

const made = [];

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// A copy of the examples, with files left out and files added or replaced.
export function examplesWith({ omit = [], add = {} } = {}) {
  const dir = tempDir('three-party-examples-');
  // The files of the examples directory. The directory of the earlier
  // revision's examples beside them is not copied.
  for (const name of fs.readdirSync(EXAMPLES).filter((f) => fs.statSync(path.join(EXAMPLES, f)).isFile())) {
    if (!omit.includes(name)) fs.copyFileSync(path.join(EXAMPLES, name), path.join(dir, name));
  }
  for (const [name, body] of Object.entries(add)) {
    fs.writeFileSync(path.join(dir, name), Buffer.isBuffer(body) || typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
}

// The eight-step run of a later scene, derived from the finished clean run:
// grant-again after grant and pay-again after pay, each a copy of the step it
// follows under its own id and title.
export function eightStepState() {
  const state = structuredClone(CLEAN_DONE);
  const again = (id, title) => {
    const at = state.steps.findIndex((s) => s.id === id);
    state.steps.splice(at + 1, 0, { ...structuredClone(state.steps[at]), id: `${id}-again`, title });
  };
  again('grant', COPY['step.grantAgain']);
  again('pay', COPY['step.payAgain']);
  return state;
}

// A clean run part of the way through, derived from the finished clean run
// by cutting it at a step: the steps before it as they ended, that step being
// checked, the steps after it pending, and no outcome yet.
export function cutAt(stepId) {
  const state = structuredClone(CLEAN_DONE);
  const at = state.steps.findIndex((s) => s.id === stepId);
  state.steps = state.steps.map((s, i) => {
    if (i < at) return { ...s, recordFile: null };
    if (i === at) return { ...s, status: 'running', endedAt: null, detail: null, actionFile: null, recordFile: null };
    return { ...s, status: 'pending', startedAt: null, endedAt: null, detail: null, actionFile: null, recordFile: null };
  });
  const grantAt = state.steps.findIndex((s) => s.id === 'grant');
  if (at <= grantAt) state.grant = null;
  state.finishedAt = null;
  state.outcome = null;
  state.blockedAt = null;
  state.reason = null;
  return state;
}

// ---- A zip, for the record pane

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, text, deflate }]. Stored (method 0) unless deflate is set.
export function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.text, 'utf8');
    const data = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ---- A page on a dev server

// Opens the view in its own browser context. served maps a path of the run
// API to the text of the last answer the page got for it.
export async function openView(browser, { width = 1440, height = 900, scheme = 'light', motion = 'reduce', hash = '', server: serverOptions = {}, clockAt = null, pauseClock = false, permissions = [] } = {}) {
  const server = await startDevServer(serverOptions);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: motion, permissions });
  const outside = [];
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' && u.protocol === 'http:') return route.continue();
    outside.push(u.href);
    return route.abort();
  });
  const page = await context.newPage();
  const served = new Map();
  const statuses = new Map();
  const errors = [];
  const open = new Set();
  page.on('request', (req) => open.add(req));
  page.on('requestfinished', (req) => open.delete(req));
  page.on('requestfailed', (req) => open.delete(req));
  // Resolves when no request of the page has been open for a short while
  // and every answer seen has been read.
  const reading = new Set();
  const settle = async (quiet = 150) => {
    let since = Date.now();
    while (Date.now() - since < quiet) {
      if (open.size > 0 || reading.size > 0) since = Date.now();
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  };
  page.on('pageerror', (err) => errors.push(String(err.stack ?? err)));
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/')) return;
    const key = `${res.request().method()} ${u.pathname}`;
    statuses.set(key, res.status());
    reading.add(res);
    try {
      if (/\.aep$/.test(u.pathname)) served.set(key, await res.body()); else served.set(key, await res.text());
    } catch {
      // The page went away before the body was read.
    }
    reading.delete(res);
  });
  if (clockAt) {
    await page.clock.install({ time: new Date(clockAt) });
    if (pauseClock) await page.clock.pauseAt(new Date(clockAt));
  }
  await page.goto(`${server.url}${hash}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'yes', null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const close = async () => {
    await context.close();
    await server.close();
  };
  return { page, context, server, served, statuses, errors, outside, settle, close };
}

export const runIs = (page, state, timeout = 20000) => page.waitForFunction((s) => document.body.dataset.run === s, state, { timeout });

// Choose a scene by its kind with a real click, and run it with the R key.
export async function runScene(page, kind) {
  await page.click(`.scene[data-kind="${kind}"]`);
  await page.keyboard.press('r');
}

// Run a scene and wait for its outcome, then for the files the panes asked
// for to arrive.
export async function runAndWait(view, kind, state) {
  await runScene(view.page, kind);
  await runIs(view.page, state);
  await view.settle();
}

export const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((row) => ({
  step: row.dataset.step,
  status: row.dataset.status,
  tone: row.dataset.tone,
  icon: row.dataset.state,
  shown: row.querySelector('.chip .icon use').getAttribute('href'),
  word: row.querySelector('.chip-word').textContent,
  title: row.querySelector('.row-title').textContent,
  number: row.querySelector('.row-num').textContent,
  detail: row.querySelector('.row-detail')?.textContent ?? null,
  current: row.getAttribute('aria-current'),
})));

export const selectedStep = (page) => page.evaluate(() => {
  const row = document.querySelector('#rows .row[aria-current="step"]');
  return row ? Number(row.dataset.index) + 1 : 0;
});

// ---- The census: every text of the page against the source it names

const at = (root, p) => {
  if (p === '' || p === undefined) return root;
  let cur = root;
  for (const part of String(p).match(/[^.[\]]+/g) ?? []) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
};

const lastPart = (p) => {
  const parts = String(p).match(/[^.[\]]+/g) ?? [];
  return parts[parts.length - 1];
};

// The shaped forms, written again here from the brief's words, apart from
// the page's own code.
const SHAPE = {
  hex16: (v) => String(v).slice(0, 16),
  afterLastSpace: (v) => String(v).split(' ').pop(),
  commit8: (v) => String(v).match(/[0-9a-f]{40}/)[0].slice(0, 8),
  time: (v) => String(v).replace('T', ' '),
  clock: (v) => String(v).split('T')[1],
  json: (v) => JSON.stringify(v, null, 2),
};

// The seconds between two times of a run, as the trace shows them: one
// decimal when either string carries a fraction of a second, whole seconds
// otherwise. Written again here, apart from the page's own code.
export const secondsApart = (start, end) => {
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return /\.\d/.test(String(start)) || /\.\d/.test(String(end)) ? seconds.toFixed(1) : String(Math.round(seconds));
};

// Every text node of the document with the element that names its source.
export const census = (page) => page.evaluate(() => {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  const seen = new Map();
  const bare = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const holder = node.parentElement?.closest('[data-src]');
    if (!holder) {
      bare.push(node.nodeValue.trim().slice(0, 80));
      continue;
    }
    if (!seen.has(holder)) seen.set(holder, { src: holder.dataset.src, text: holder.textContent, tag: holder.tagName.toLowerCase(), datetime: holder.getAttribute('datetime'), nested: holder.querySelector('[data-src]') !== null });
  }
  return { bare, items: [...seen.values()] };
});

// docs: { state, files: { rel: value }, offline, post, members: { 'rel!name': value }, entries: { rel: [names] } }
export function expectedFor(src, docs, { copy = COPY, labels = LABELS } = {}) {
  const resolve = (source) => {
    const [body, shape] = source.split('|');
    const colon = body.indexOf(':');
    const kind = body.slice(0, colon);
    const rest = body.slice(colon + 1);
    if (kind === 'labels') return { value: at(labels, rest), path: rest, shape };
    if (kind === 'const') return { value: at({ stepOrder: STEP_ORDER, textModeCommand: TEXT_MODE_COMMAND }, rest), path: rest, shape };
    // A time left on the browser clock reads as minutes and seconds; the
    // seconds since a run time, and a number the page counted on itself (the
    // rows of the trace, the step a replay stands at), read as digits.
    if (kind === 'clock') return { counted: shape === 'since' ? '\\d+' : '\\d{2,}:\\d{2}' };
    if (kind === 'view') {
      assert.ok(['rows', 'replay'].includes(rest), `a number of the page this check does not know: ${source}`);
      return { counted: '\\d+' };
    }
    assert.equal(kind, 'run', `a source this check does not know: ${source}`);
    const hash = rest.indexOf('#');
    if (hash < 0) return { value: at(docs.state, rest), path: rest, shape };
    const name = rest.slice(0, hash);
    const p = rest.slice(hash + 1);
    let doc;
    if (name === 'offline-check') doc = docs.offline;
    else if (name === 'post') doc = docs.post;
    else if (name.includes('!')) {
      const [rel, member] = name.slice('files/'.length).split('!');
      doc = member === '' ? { entries: docs.entries?.[rel] } : docs.members?.[`${rel}!${member}`];
    } else doc = docs.files?.[name.slice('files/'.length)];
    return { value: at(doc, p), path: p, shape, rel: name.startsWith('files/') ? name.slice('files/'.length) : null };
  };
  const shapeOf = (r) => {
    if (r.shape === 'ordinal') return String(Number(/\[(\d+)\]$/.exec(r.path)[1]) + 1);
    if (r.shape === 'key') {
      assert.ok(r.value !== undefined && r.value !== null, `a field name is shown for a field the document lacks: ${r.path}`);
      return lastPart(r.path);
    }
    assert.ok(r.value !== undefined && r.value !== null, `no value at ${r.path}`);
    // The start of a row of the trace: the seconds from the run's start to
    // a time of the run. How long a step took: from its start to its end.
    if (r.shape === 'sinceStart') return secondsApart(docs.state.startedAt, r.value);
    if (r.shape === 'span') return secondsApart(r.value.startedAt, r.value.endedAt);
    if (r.shape === 'beside') return `${r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/') + 1) : ''}${r.value}`;
    return r.shape ? SHAPE[r.shape](r.value) : String(r.value);
  };

  if (src.startsWith('copy:')) {
    const [head, ...fills] = src.split(';');
    const [key, shape] = head.slice('copy:'.length).split('|');
    let text = copy[key];
    assert.equal(typeof text, 'string', `no copy line ${key}`);
    if (shape === 'beforeParen') text = text.split(' (')[0];
    else assert.equal(shape, undefined, `a copy shaping this check does not know: ${shape}`);
    let pattern = null;
    let digits = null;
    for (const fill of fills) {
      const eq = fill.indexOf('=');
      const name = fill.slice(0, eq);
      const r = resolve(fill.slice(eq + 1));
      if (name === 'when') continue;
      assert.ok(text.includes(`{${name}}`), `${key} has no {${name}}`);
      if (r.counted) {
        pattern = name;
        digits = r.counted;
      } else text = text.split(`{${name}}`).join(shapeOf(r));
    }
    if (pattern) {
      const [before, after] = text.split(`{${pattern}}`);
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { matches: new RegExp(`^${esc(before)}${digits}${esc(after)}$`) };
    }
    assert.equal(/\{[A-Za-z0-9]+\}/.test(text), false, `${key} is shown with a placeholder left in: ${text}`);
    return { equals: text };
  }
  return { equals: shapeOf(resolve(src)) };
}

// Assert the whole census. Returns the number of sourced texts checked.
export function assertCensus(result, docs, options) {
  assert.deepEqual(result.bare, [], 'a text of the page names no source');
  for (const item of result.items) {
    assert.equal(item.nested, false, `a sourced element holds another sourced element: ${item.src}`);
    const want = expectedFor(item.src, docs, options);
    if (want.matches) assert.match(item.text, want.matches, item.src);
    else assert.equal(item.text, want.equals, item.src);
    if (item.tag === 'time') assert.equal(item.datetime, String(at(docs.state, item.src.slice('run:'.length).split('|')[0])), `the datetime of ${item.src}`);
  }
  return result.items.length;
}

// The documents the page was served, from the record openView keeps.
export function docsFrom(served, runId, extra = {}) {
  const docs = { state: null, files: {}, offline: null, post: null, ...extra };
  const base = `/api/runs/${runId}`;
  for (const [key, body] of served) {
    const [method, pathname] = key.split(' ');
    if (method === 'POST' && pathname === '/api/runs') docs.post = JSON.parse(body);
    else if (method === 'GET' && pathname === base) docs.state = JSON.parse(body);
    else if (method === 'POST' && pathname === `${base}/offline-check`) docs.offline = JSON.parse(body);
    else if (method === 'GET' && pathname.startsWith(`${base}/files/`) && typeof body === 'string') {
      const rel = decodeURIComponent(pathname.slice(`${base}/files/`.length));
      try {
        docs.files[rel] = JSON.parse(body);
      } catch {
        docs.files[rel] = body;
      }
    }
  }
  return docs;
}

// Every answer of the run API for a run, as one text.
export function servedText(served, runId) {
  return [...served].filter(([key]) => key.includes(`/api/runs/${runId}`) || key === 'POST /api/runs').map(([, body]) => (typeof body === 'string' ? body : '')).join('\n');
}

// ---- Contrast, by WCAG 2.2 (relative luminance, linearised at 0.04045)

export function luminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  assert.ok(m, `not a six digit colour: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- Files of the view, for the checks over its source

export function viewFiles(extensions) {
  return fs.readdirSync(VIEW).filter((f) => extensions.includes(path.extname(f))).sort().map((f) => ({ name: f, file: path.join(VIEW, f), text: fs.readFileSync(path.join(VIEW, f), 'utf8') }));
}

// The lines of files that match a pattern, as grep would print them.
export function grepLines(files, pattern) {
  const out = [];
  for (const f of files) {
    f.text.split('\n').forEach((line, i) => {
      if (pattern.test(line)) out.push({ name: f.name, line: i + 1, text: line });
    });
  }
  return out;
}
