// What the integration tests share: the demo's listener started in the test
// process the way the command line starts it (the screens, the engine, the
// tree's own record writer, and the offline check of three-party/src/record
// behind the API), a run taken to its end over the API, and a page of the
// screens with a record of what the API answered it.

import assert from 'node:assert/strict';
import { startApi } from '../../src/engine/api.mjs';
import { offlineCheckOf } from '../../src/engine/records.mjs';
import { VIEW_DIR } from '../../src/engine/screens.mjs';
import { removeDir, request, tempRunsDir } from './engine-helpers.mjs';

// The demo's listener on a free port of 127.0.0.1, with a runs directory of
// its own and no pacing. `witness` receives the access token values the bank
// issues. stop() closes the listener and removes the runs directory and the
// pins directory beside it.
export async function startDemo({ witness = null, paceSeconds = 0 } = {}) {
  const runsDir = tempRunsDir();
  const api = await startApi({
    port: 0,
    runsDir,
    paceSeconds,
    viewDir: VIEW_DIR,
    offlineCheck: offlineCheckOf,
    runOptions: witness ? { witness } : {},
  });
  const port = api.port;
  return {
    api,
    port,
    runsDir,
    url: `http://127.0.0.1:${port}/`,
    get: (target, headers = {}) => request({ port, path: target, headers }),
    post: (target, body = null) => request({ port, method: 'POST', path: target, body, headers: body === null ? {} : { 'Content-Type': 'application/json' } }),
    async stop() {
      await api.stop();
      removeDir(runsDir);
    },
  };
}

// Starts a run over the API and reads its state until it has finished.
export async function finishedRun(demo, kind, limitMs = 30000) {
  const started = await demo.post('/api/runs', { kind });
  assert.equal(started.status, 200, started.text);
  const { runId } = started.json();
  const deadline = Date.now() + limitMs;
  for (;;) {
    const state = (await demo.get(`/api/runs/${runId}`)).json();
    if (state.finishedAt !== null) return { runId, state };
    assert.ok(Date.now() < deadline, `the ${kind} run finished within ${limitMs / 1000} seconds`);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

// Opens the screens in a browser context of their own. served maps a path
// of the run API to the text of the last answer the page got for it; outside
// lists every request that named another host (each is aborted); errors
// lists what the page threw and what its console reported as an error.
export async function openScreens(browser, url, { width = 1440, height = 900, hash = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const outside = [];
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' && u.protocol === 'http:') return route.continue();
    outside.push(u.href);
    return route.abort();
  });
  const page = await context.newPage();
  const served = new Map();
  const errors = [];
  const open = new Set();
  const reading = new Set();
  page.on('request', (req) => open.add(req));
  page.on('requestfinished', (req) => open.delete(req));
  page.on('requestfailed', (req) => open.delete(req));
  page.on('pageerror', (err) => errors.push(String(err.stack ?? err)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/')) return;
    const key = `${res.request().method()} ${u.pathname}`;
    reading.add(res);
    try {
      if (/\.aep$/.test(u.pathname)) served.set(key, await res.body()); else served.set(key, await res.text());
    } catch {
      // The page went away before the body was read.
    }
    reading.delete(res);
  });
  // Resolves when no request of the page has been open for a short while
  // and every answer seen has been read.
  const settle = async (quiet = 150) => {
    let since = Date.now();
    while (Date.now() - since < quiet) {
      if (open.size > 0 || reading.size > 0) since = Date.now();
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  };
  await page.goto(`${url}${hash}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'yes', null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, context, served, errors, outside, settle, close: () => context.close() };
}

// The run id the page shows, or null before a run.
export const shownRunId = (page) => page.evaluate(() => document.querySelector('#run-line .run-id .mono')?.textContent ?? null);

// Runs an item of the menu with a real click (a click on an item chooses it
// and runs it), and waits until the page shows a run of that kind that is
// not the run it showed before, so that nothing after this reads the
// earlier run's state. Returns the new run's id.
export async function startFromScreens(view, kind, limitMs = 30000) {
  const { page } = view;
  const previous = await shownRunId(page);
  await page.click(`.scene[data-kind="${kind}"]`);
  await page.waitForFunction(([wanted, earlier]) => {
    const id = document.querySelector('#run-line .run-id .mono')?.textContent ?? null;
    return id !== null && id !== earlier && id.startsWith(`${wanted}-`);
  }, [kind, previous], { timeout: limitMs });
  return shownRunId(page);
}

// Starts a run from the screens and waits until it has finished: its record
// row has left the pending and checking states, and the page offers the
// offline check. Returns the run id the page shows.
export async function runFromScreens(view, kind, limitMs = 30000) {
  const { page } = view;
  const runId = await startFromScreens(view, kind, limitMs);
  await page.waitForFunction(() => {
    const row = document.querySelector('#rows .row[data-step="record"]');
    return Boolean(row) && !['pending', 'running'].includes(row.dataset.status) && document.body.dataset.run !== 'running';
  }, null, { timeout: limitMs });
  // The audit is offered once the page has read the finished state.
  await page.waitForFunction(() => document.querySelector('.scene[data-kind="offline-check"]').getAttribute('aria-disabled') === 'false', null, { timeout: limitMs });
  await view.settle();
  assert.equal(await shownRunId(page), runId);
  return runId;
}

// Runs the audit from the menu with a real click and waits for its result:
// the Records tab and the offline panel of the inspector.
export async function offlineCheckFromScreens(view, limitMs = 30000) {
  const { page } = view;
  await page.click('.scene[data-kind="offline-check"]');
  await page.waitForSelector('#pane-inspector [data-panel="offline"]', { timeout: limitMs });
  await page.waitForFunction(() => document.body.dataset.tab === 'records', null, { timeout: limitMs });
  await view.settle();
}
