#!/usr/bin/env node
// A recording of the screens, for a reader who wants to see the demo before
// running it: the poisoned invoice from the start to the stop, the evidence
// at the stopped step, then the audit of the run's records.
//
//   node three-party/view/record.mjs --out <file.webm>
//
// It starts the demo itself (node three-party/bin/start.mjs --serve, on a
// free port of 127.0.0.1, two seconds per step, run directories in a
// temporary directory that is removed at the end), opens it at 1440x900 in
// the light scheme in the installed Google Chrome, and drives it by keyboard
// alone: Tab to the poisoned run and Enter, the run to its stop (held three
// seconds, the inspector showing the declared intent beside the tool call
// that differs), then O for the audit (held three seconds on the Records
// tab). The video is written by the browser as it plays; the script prints
// the file and its length. It is a script, not a check.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from '../test/support/browser.mjs';

const VIEW = path.dirname(fileURLToPath(import.meta.url));
const START = path.resolve(VIEW, '..', 'bin', 'start.mjs');
const USAGE = 'usage: node three-party/view/record.mjs --out <file.webm>';
const SIZE = { width: 1440, height: 900 };
const HOLD_MS = 3000;
const WAIT_MS = 60000;

function option(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

// Headless Chrome counts toolbars it never draws in the height of its
// window, and a video holds only what lies inside the window: a window as
// tall as the page would leave the bottom of the page out of the video
// (87 px, measured with Chrome on macOS on 2026-11-16). The window is
// measured and sized until the page inside it is exactly SIZE.
async function fitWindow(context, page) {
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  for (let tries = 0; tries < 3; tries += 1) {
    const { bounds } = await cdp.send('Browser.getWindowForTarget');
    const inner = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
    if (inner.ratio !== 1) throw new Error(`the page has a device pixel ratio of ${inner.ratio}, not 1`);
    if (inner.width === SIZE.width && inner.height === SIZE.height) return;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + SIZE.width - inner.width, height: bounds.height + SIZE.height - inner.height } });
  }
  throw new Error(`the page inside the window could not be made ${SIZE.width}x${SIZE.height}`);
}

// A port of 127.0.0.1 that nothing listens on now.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Start the demo and resolve with its address once its one line says it is up.
function startDemo(port, runsDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [START, '--serve', '--port', String(port), '--pace', '2', '--runs-dir', runsDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the demo did not start: ${said.trim()}`)); }, WAIT_MS);
    const read = (chunk) => {
      said += chunk;
      const found = /http:\/\/127\.0\.0\.1:\d+/.exec(said);
      if (found) {
        clearTimeout(timer);
        resolve({ url: found[0], stop: () => new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); }) });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the demo stopped with code ${code}: ${said.trim()}`)); });
  });
}

export async function record({ out, log = () => {} }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-record-'));
  const runsDir = path.join(work, 'runs');
  const videoDir = path.join(work, 'video');
  fs.mkdirSync(runsDir);
  const demo = await startDemo(await freePort(), runsDir);
  const chrome = await launchBrowser();
  let began = 0;
  let ended = 0;
  try {
    log(`demo at ${demo.url}`);
    // No emulated viewport: the video holds what lies inside the window, so
    // the window itself is sized to hold a page of SIZE (fitWindow below).
    const context = await chrome.browser.newContext({ viewport: null, colorScheme: 'light', reducedMotion: 'no-preference', recordVideo: { dir: videoDir, size: SIZE } });
    await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
    const page = await context.newPage();
    await fitWindow(context, page);
    began = Date.now();
    await page.goto(`${demo.url}/`);
    await page.waitForFunction(() => document.body.dataset.ready === 'yes', null, { timeout: WAIT_MS });
    await page.waitForTimeout(1500);
    // The focus starts on the run of the normal payment; Tab reaches the
    // poisoned invoice beside it.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.run === 'blocked', null, { timeout: WAIT_MS });
    await page.waitForSelector('#pane-inspector .compare-call', { timeout: WAIT_MS });
    await page.waitForTimeout(HOLD_MS);
    // The audit waits for the run to finish (its last record written): the
    // menu's audit item says when it is available.
    await page.waitForFunction(() => document.querySelector('#outcome-end #next-action') !== null
      && document.querySelector('#scenes .scene[data-kind="offline-check"]')?.getAttribute('aria-disabled') === 'false', null, { timeout: WAIT_MS });
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.body.dataset.tab === 'records' && document.querySelector('#records-tab [data-verdict-for] .verdict') !== null, null, { timeout: WAIT_MS });
    await page.waitForTimeout(HOLD_MS);
    ended = Date.now();
    const video = page.video();
    await context.close();
    const written = await video.path();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(written, out);
  } finally {
    await chrome.close();
    await demo.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { file: out, seconds: (ended - began) / 1000 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const out = option(argv, '--out');
  if (!out || !/\.webm$/.test(out)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const { file, seconds } = await record({ out: path.resolve(out), log: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(`${file} ${seconds.toFixed(1)} s\n`);
}
