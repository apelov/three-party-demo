#!/usr/bin/env node
// The stills of the view, taken in a browser with clicks and keys, never a
// dispatched event. Names: <scene>-<state>-<mode>-<scheme>-<width>.png for
// a still of the sequence, and <scene>-<state>-<tab>-<mode>-<scheme>-
// <width>.png for a still that names its tab (the trace, or the records).
// A still of a reader lens other than the default names the lens after the
// state: s2-stopped-finance-story-light-1440.png.
//
//   node three-party/view/stills.mjs [--out <dir>] [--pair] [--trace-pair]
//                                    [--url <address>] [--grayscale <file>]
//
// With no --url the view's development server answers from the example
// files, and the browser's clock is set to a moment of the example's own
// timeline, so the grant countdown reads what a presenter sees at that
// moment of the run. With --url (the 127.0.0.1 address of a server that is
// already up, such as `node three-party/bin/start.mjs --serve --pace 2`)
// the runs are that server's own, in its own time, with the values a real
// run writes: the stills kept in three-party/stills/ are taken that way.
// --pair takes the two stills of the stopped step in the sequence and ends
// there. --trace-pair takes the stopped step in the trace and ends there.
// --grayscale writes one more capture of the stopped step with the colour
// taken out, to the file named; it is kept out of the stills directory.
//
// The browser is the installed Google Chrome, started by the launcher the
// integration checks use (three-party/test/support/browser.mjs): its own
// sandbox on, every host name but 127.0.0.1 resolving to not-found, and an
// environment made for this one start. Before the opening still the three
// checks of a start run: the browser's command line, a page on another host
// refused by name, and in the same run the demo's page on 127.0.0.1 loading.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserStartChecks, launchBrowser } from '../test/support/browser.mjs';
import { startDevServer, asOf } from './dev-server.mjs';

const VIEW = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(VIEW, '..', 'examples');
const HEIGHTS = { 1280: 800, 1440: 900, 1920: 1080 };
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);
const WAIT_MS = 180000;

// Seconds into the example's own timeline at which each state is pictured:
// after the record of the stopped run is written, while the payment of the
// clean run is being checked, after the clean run's record is written, and
// after the clean run has finished (the offline check follows a finished run).
const MOMENTS = { stopped: 45, running: 40.5, paid: 53, afterFinish: 5 };

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const stateOfKind = (kind, finished) => fs.readdirSync(EXAMPLES)
  .filter((f) => /^state-.*\.json$/.test(f))
  .map((f) => readJson(path.join(EXAMPLES, f)))
  .find((s) => s.kind === kind && Boolean(s.finishedAt) === finished) ?? null;

function option(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

// An example directory whose clean run stays in progress: the finished clean
// example as it stood at a moment of its own timeline, and no finished state.
function examplesInProgress(moment) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-stills-'));
  const done = stateOfKind('clean', true);
  for (const f of fs.readdirSync(EXAMPLES).filter((name) => fs.statSync(path.join(EXAMPLES, name)).isFile())) {
    const state = /^state-.*\.json$/.test(f) ? readJson(path.join(EXAMPLES, f)) : null;
    if (state && state.runId === done.runId) continue;
    fs.copyFileSync(path.join(EXAMPLES, f), path.join(dir, f));
  }
  const frame = asOf(done, Date.parse(done.startedAt) + moment * 1000);
  fs.writeFileSync(path.join(dir, 'state-clean-running.json'), `${JSON.stringify(frame, null, 2)}\n`);
  return dir;
}

// An example directory in which the stopped run has a manifest of its own.
// The example manifest is the clean run's, with five records; the stopped
// run wrote four (its payment was not reached). Its manifest is derived by
// keeping the records of the actions the stopped state names.
function examplesForStopped() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-stills-'));
  for (const f of fs.readdirSync(EXAMPLES).filter((name) => fs.statSync(path.join(EXAMPLES, name)).isFile())) fs.copyFileSync(path.join(EXAMPLES, f), path.join(dir, f));
  const stopped = stateOfKind('poisoned', true);
  const manifest = readJson(path.join(EXAMPLES, 'manifest.json'));
  const actions = stopped.steps.map((s) => s.actionFile).filter(Boolean);
  const own = { ...manifest, runId: stopped.runId, records: manifest.records.filter((r) => actions.includes(r.action)), tampered: [] };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(own, null, 2)}\n`);
  return dir;
}

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(16, 24);
  return `${head.readUInt32BE(0)}x${head.readUInt32BE(4)}`;
}

export async function takeStills({ out, url = null, pair = false, tracePair = false, grayscale = null, log = () => {} } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const chrome = await launchBrowser();
  const browser = chrome.browser;
  const temp = [];
  const written = [];
  const clean = stateOfKind('clean', true);
  const poisoned = stateOfKind('poisoned', true);
  const momentOf = (state, seconds) => new Date(Date.parse(state.startedAt) + seconds * 1000).toISOString();

  // One window on one server: the development server with the browser's
  // clock at the given moment, or the server named by --url as it is.
  async function open({ width, scheme, at = null, examples = EXAMPLES, hash = '' }) {
    const server = url ? null : await startDevServer({ examples });
    const context = await browser.newContext({ viewport: { width, height: HEIGHTS[width] }, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: 'reduce' });
    await context.route('**/*', (route) => (LOOPBACK.has(new URL(route.request().url()).hostname) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const pending = new Set();
    page.on('request', (req) => pending.add(req));
    page.on('requestfinished', (req) => pending.delete(req));
    page.on('requestfailed', (req) => pending.delete(req));
    const settle = async (quiet = 300) => {
      let since = Date.now();
      while (Date.now() - since < quiet) {
        if (pending.size > 0) since = Date.now();
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      await page.evaluate(() => document.fonts.ready);
    };
    if (!url && at) await page.clock.install({ time: new Date(at) });
    const base = (url ?? server.url).replace(/\/$/, '');
    await page.goto(`${base}/${hash}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'yes', null, { timeout: 30000 });
    await settle();
    // A still of the stills directory, or (with a file named) a capture
    // kept elsewhere, which the count of stills leaves out.
    const shot = async (name, elsewhere = null) => {
      const file = elsewhere ?? path.join(out, `${name}-${scheme}-${width}.png`);
      await settle();
      await page.mouse.move(0, 0);
      // A still pictures the screen, not where the keyboard stands.
      await page.evaluate(() => document.activeElement?.blur());
      // A still is taken of a page that fits its window: no still is written
      // of a page wider than the window it is shown in.
      const wide = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
      if (wide.page > wide.window) throw new Error(`${name ?? file}: the page is ${wide.page} px wide in a window of ${wide.window} px`);
      await page.screenshot({ path: file });
      const entry = { file, pixels: pngSize(file), bytes: fs.statSync(file).size, pageWidth: wide.page, windowWidth: wide.window };
      if (!elsewhere) written.push(entry);
      log(`${elsewhere ? file : path.basename(file)} ${entry.pixels} ${entry.bytes} bytes; page ${wide.page} px in a window of ${wide.window} px`);
    };
    const close = async () => {
      await context.close();
      if (server) await server.close();
    };
    return { page, settle, shot, close };
  }

  // A click on an item of the menu chooses it; the R key runs it.
  const runScene = async (page, kind) => {
    await page.click(`.scene[data-kind="${kind}"]`);
    await page.keyboard.press('r');
  };
  const outcomeIs = (page, outcome) => page.waitForFunction((o) => document.body.dataset.run === o, outcome, { timeout: WAIT_MS });
  const rowsSettled = (page) => page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#rows .row')];
    return rows.length > 0 && rows.every((row) => row.dataset.status !== 'pending' && row.dataset.status !== 'running');
  }, null, { timeout: WAIT_MS });
  const key = (page, name) => page.keyboard.press(name);
  // The outcome's cue: the next act it offers, there once the run has
  // finished (the audit waits for the last record).
  const cueShown = (page) => page.waitForFunction(() => document.querySelector('#outcome-end #next-action') !== null, null, { timeout: WAIT_MS });
  // The walkthrough in its order: a still of a later act is taken after the
  // normal payment, so it shows what a viewer who took the acts in order
  // sees there, the first act done and the cue the outcome gives next.
  const paidFirst = async (page) => {
    await runScene(page, 'clean');
    await outcomeIs(page, 'paid');
    await rowsSettled(page);
  };
  const stoppedNumber = (page) => page.evaluate(() => {
    const row = document.querySelector('#rows .row[data-status="blocked"]');
    return row ? Number(row.dataset.index) + 1 : 0;
  });

  // The walkthrough's opening: the parts, and the two runs to start.
  async function start(width, scheme, name, mode = null) {
    const view = await open({ width, scheme });
    try {
      if (mode) await key(view.page, mode);
      await view.shot(name);
    } finally {
      await view.close();
    }
  }

  // Scene 2 at the stopped step, that step selected: Story, then Inspect.
  async function stoppedPair(width, scheme, { story = true, inspect = true, lens = null, withGrayscale = false } = {}) {
    const view = await open({ width, scheme, at: momentOf(poisoned, MOMENTS.stopped), hash: lens ? `#story-sequence-${lens}` : '' });
    try {
      await paidFirst(view.page);
      await runScene(view.page, 'poisoned');
      await outcomeIs(view.page, 'blocked');
      await rowsSettled(view.page);
      await cueShown(view.page);
      const number = await stoppedNumber(view.page);
      if (!number) throw new Error('the stopped run shows no stopped step');
      await key(view.page, String(number));
      if (story) await view.shot(lens ? `s2-stopped-${lens}-story` : 's2-stopped-story');
      if (withGrayscale && grayscale) {
        await view.page.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; });
        await view.shot(null, path.resolve(grayscale));
        await view.page.evaluate(() => { document.documentElement.style.filter = ''; });
      }
      if (inspect) {
        await key(view.page, 'i');
        await view.shot('s2-stopped-inspect');
      }
    } finally {
      await view.close();
    }
  }

  // Scene 2 at the stopped step with the trace showing: the stopped step's
  // rows open and the mark on the call that decided.
  async function stoppedTrace(width, scheme) {
    const dir = url ? null : examplesForStopped();
    if (dir) temp.push(dir);
    const view = await open({ width, scheme, at: momentOf(poisoned, MOMENTS.stopped), examples: dir ?? EXAMPLES });
    try {
      await paidFirst(view.page);
      await runScene(view.page, 'poisoned');
      await outcomeIs(view.page, 'blocked');
      await rowsSettled(view.page);
      await cueShown(view.page);
      const number = await stoppedNumber(view.page);
      if (!number) throw new Error('the stopped run shows no stopped step');
      await key(view.page, String(number));
      await key(view.page, 't');
      await view.page.waitForSelector('#trace-body [data-decided="yes"]', { timeout: WAIT_MS });
      await view.shot('s2-stopped-trace-story');
    } finally {
      await view.close();
    }
  }

  // Scene 1 while it runs: a step being checked, the grant counting down.
  async function running(width, scheme) {
    const dir = url ? null : examplesInProgress(MOMENTS.running);
    if (dir) temp.push(dir);
    const view = await open({ width, scheme, at: url ? null : momentOf(clean, MOMENTS.running), examples: dir ?? EXAMPLES });
    try {
      await runScene(view.page, 'clean');
      await view.page.waitForFunction(() => document.body.dataset.run === 'running'
        && document.querySelector('#rows .row[data-status="running"]') !== null
        && document.querySelector('#rows .countdown[data-done="no"]') !== null, null, { timeout: WAIT_MS });
      await view.shot('s1-running-story');
    } finally {
      await view.close();
    }
  }

  // Scene 1 paid: the outcome, and the next run it offers.
  async function paid(width, scheme, name, mode = null) {
    const view = await open({ width, scheme, at: momentOf(clean, MOMENTS.paid) });
    try {
      if (mode) await key(view.page, mode);
      await runScene(view.page, 'clean');
      await outcomeIs(view.page, 'paid');
      await rowsSettled(view.page);
      await cueShown(view.page);
      await view.shot(name);
    } finally {
      await view.close();
    }
  }

  // The audit of a finished run: the Records tab, every record checked.
  async function audit(width, scheme, name, mode, kind = 'clean', outcome = 'paid') {
    const finished = kind === 'clean' ? clean : poisoned;
    const view = await open({ width, scheme, at: new Date(Date.parse(finished.finishedAt) + MOMENTS.afterFinish * 1000).toISOString() });
    try {
      if (mode) await key(view.page, mode);
      if (kind !== 'clean') await paidFirst(view.page);
      await runScene(view.page, kind);
      await outcomeIs(view.page, outcome);
      await rowsSettled(view.page);
      // The audit needs a finished run; on a server of its own time that
      // comes after the last step.
      const answered = view.page.waitForResponse((res) => /\/offline-check$/.test(new URL(res.url()).pathname), { timeout: WAIT_MS });
      const deadline = Date.now() + WAIT_MS;
      let asked = false;
      view.page.on('request', (req) => { if (/\/offline-check$/.test(new URL(req.url()).pathname)) asked = true; });
      while (!asked && Date.now() < deadline) {
        await key(view.page, 'o');
        await new Promise((resolve) => { setTimeout(resolve, 500); });
      }
      await answered;
      await view.page.waitForFunction(() => document.body.dataset.tab === 'records', null, { timeout: WAIT_MS });
      await cueShown(view.page);
      await view.shot(name);
    } finally {
      await view.close();
    }
  }

  let started = null;
  try {
    // The checks of a start, before any still: on the server named by --url,
    // or on a development server of their own.
    const control = url ? null : await startDevServer();
    try {
      started = await browserStartChecks(browser, url ?? control.url);
    } finally {
      if (control) await control.close();
    }
    log(`browser start: sandbox ${started.sandbox}; ${started.outside.url} refused with ${started.outside.refusedWith}; ${started.control.url} loaded with status ${started.control.status}`);
    if (pair) {
      await stoppedPair(1440, 'light', { withGrayscale: true });
    } else if (tracePair) {
      await stoppedTrace(1440, 'light');
    } else {
      await start(1440, 'light', 'start-story');
      await running(1440, 'light');
      await paid(1440, 'light', 's1-paid-story');
      await stoppedPair(1440, 'light', { withGrayscale: true });
      await stoppedPair(1440, 'light', { inspect: false, lens: 'finance' });
      await stoppedPair(1440, 'dark');
      await stoppedTrace(1440, 'light');
      await audit(1440, 'light', 's6-offline-inspect', 'i', 'poisoned', 'blocked');
      await audit(1440, 'dark', 's6-offline-records-story', null, 'poisoned', 'blocked');
      await stoppedPair(1920, 'light', { inspect: false });
      await start(1920, 'light', 'start-story');
      await paid(1920, 'dark', 's1-paid-story');
      await start(1280, 'light', 'start-inspect', 'i');
      await stoppedPair(1280, 'light', { story: false });
    }
  } finally {
    await chrome.close();
    for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const url = option(argv, '--url');
  if (url && !LOOPBACK.has(new URL(url).hostname)) {
    process.stderr.write('usage: node three-party/view/stills.mjs [--out <dir>] [--pair] [--trace-pair] [--url <a 127.0.0.1 address>] [--grayscale <file>]\n');
    process.exit(2);
  }
  const out = path.resolve(option(argv, '--out') ?? path.resolve(VIEW, '..', 'stills'));
  const written = await takeStills({ out, url, pair: argv.includes('--pair'), tracePair: argv.includes('--trace-pair'), grayscale: option(argv, '--grayscale'), log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`${written.length} stills written under ${out}\n`);
}
