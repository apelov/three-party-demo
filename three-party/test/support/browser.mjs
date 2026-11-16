// The browser the integration checks drive: the installed Google Chrome
// through playwright-core, headless, with its own sandbox on, started so
// that it can reach this computer and nothing else:
//
//   - every host name but 127.0.0.1 resolves to not-found, so a request to
//     another host fails before a connection is tried;
//   - background networking is off;
//   - the keychain is a mock one and the password store is the basic one, so
//     the browser asks the operating system's store for nothing;
//   - its environment is a system PATH and a home and a temp directory made
//     for this one start and removed with it.
//
// browserStartChecks proves the start before a page of the demo is driven:
// the browser's own command line shows the sandbox is on and the resolver
// rule is in force, a page on another host is refused with a name error, and
// in the same run the demo's page on 127.0.0.1 loads.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const RESOLVER_RULE = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1';
export const OUTSIDE_URL = 'http://example.com/';
export const NAME_ERROR = 'net::ERR_NAME_NOT_RESOLVED';

const ARGS = Object.freeze([RESOLVER_RULE, '--disable-background-networking', '--use-mock-keychain', '--password-store=basic']);

// Starts the browser. The answer is { browser, close }: close stops the
// browser and removes the home and temp directories made for it.
export async function launchBrowser() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-browser-home-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-browser-tmp-'));
  const remove = () => {
    for (const dir of [home, temp]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  let browser = null;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      chromiumSandbox: true,
      args: [...ARGS],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: temp },
    });
  } catch (err) {
    remove();
    assert.fail(`precondition: Google Chrome installed where playwright-core finds the chrome channel; this check needs a real browser (${String(err.message).split('\n')[0]})`);
  }
  return {
    browser,
    async close() {
      await browser.close().catch(() => {});
      remove();
    },
  };
}

// The three checks of a start, in order. demoUrl is a page of the demo on
// 127.0.0.1. The answer says what each check read; a check that does not
// hold throws, and the caller drives nothing.
export async function browserStartChecks(browser, demoUrl) {
  // 1. The browser's own command line.
  const session = await browser.newBrowserCDPSession();
  let commandLine;
  try {
    commandLine = (await session.send('Browser.getBrowserCommandLine')).arguments;
  } finally {
    await session.detach().catch(() => {});
  }
  assert.ok(Array.isArray(commandLine) && commandLine.length > 0, 'the browser gave its command line');
  assert.equal(commandLine.some((a) => a.startsWith('--no-sandbox')), false, 'the browser runs with its sandbox on');
  assert.ok(commandLine.includes(RESOLVER_RULE), 'the resolver rule is on the browser command line');

  const context = await browser.newContext();
  try {
    // 2. A page on another host is refused, by name.
    const outside = await context.newPage();
    let refusal = null;
    try {
      await outside.goto(OUTSIDE_URL, { timeout: 15000 });
    } catch (err) {
      refusal = String(err.message).split('\n')[0];
    }
    assert.ok(refusal !== null, `${OUTSIDE_URL} did not load`);
    assert.ok(refusal.includes(NAME_ERROR), `${OUTSIDE_URL} was refused with ${NAME_ERROR} (read: ${refusal})`);

    // 3. The same browser, in the same run, loads the demo's page. It is a
    // page of its own: the refused one is still showing the browser's error.
    const page = await context.newPage();
    const response = await page.goto(demoUrl, { timeout: 15000 });
    assert.ok(response !== null && response.status() === 200, `${demoUrl} loaded with status 200 (read: ${response === null ? 'no response' : response.status()})`);
    assert.equal(new URL(response.url()).hostname, '127.0.0.1');
    return {
      sandbox: 'on (no --no-sandbox on the command line)',
      resolverRule: RESOLVER_RULE,
      outside: { url: OUTSIDE_URL, refusedWith: NAME_ERROR },
      control: { url: response.url(), status: response.status() },
    };
  } finally {
    await context.close().catch(() => {});
  }
}
