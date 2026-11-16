// The record step and the offline check: the manifest rows, the entries of a
// package read from its zip container, the verdicts once the check has run,
// the copy control, and the scene that runs the check.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, rowsOf, selectedStep, census, assertCensus, docsFrom, examplesWith, makeZip, example, removeTempDirs, COPY, LABELS, CLEAN_DONE } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const MANIFEST = example('manifest.json');
const OFFLINE = example('offline-check.json');
const offlineScene = LABELS.scenes.find((s) => s.kind === 'offline-check');

test('the offline check scene: its control is not available before a run has finished and says why; after a run it runs the check and the inspector shows the result in the deck\'s words', async () => {
  // The check follows a finished run, so the browser's clock stands after the
  // run's end: the grant has run out and the flow's text no longer changes.
  const view = await openView(browser, { clockAt: new Date(Date.parse(CLEAN_DONE.finishedAt) + 5000).toISOString() });
  const { page } = view;
  try {
    await page.click('.scene[data-kind="offline-check"]');
    let control = await page.evaluate(() => {
      const c = document.getElementById('run-control');
      return { text: c.textContent, name: c.getAttribute('aria-label'), disabled: c.getAttribute('aria-disabled'), described: c.getAttribute('aria-describedby'), help: document.getElementById('run-help').hidden ? null : document.getElementById('run-help').textContent };
    });
    assert.deepEqual(control, { text: offlineScene.button, name: COPY['button.runName'].replace('{scene}', offlineScene.title), disabled: 'true', described: 'run-help', help: COPY['help.offlineDisabled'] });
    // A press of the pointer on the control while it is not available.
    // page.click waits for an enabled control, so the pointer itself is
    // moved there and pressed.
    const box = await page.locator('#run-control').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press('r');
    await page.keyboard.press('o');
    await view.settle();
    assert.equal([...view.served.keys()].some((k) => k.includes('offline-check')), false, 'nothing is asked of the server while the control is not available');

    await runAndWait(view, 'clean', 'paid');
    await page.click('.scene[data-kind="offline-check"]');
    control = await page.evaluate(() => ({ disabled: document.getElementById('run-control').getAttribute('aria-disabled'), help: document.getElementById('run-help').hidden }));
    assert.deepEqual(control, { disabled: 'false', help: true });
    // The flow as the check must leave it: every step with its number, title,
    // state and icon. The open detail line goes with the selection.
    const flowOf = async () => (await rowsOf(page)).map(({ step, status, tone, icon, shown, word, title, number }) => ({ step, status, tone, icon, shown, word, title, number }));
    const flowBefore = await flowOf();
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
    await view.settle();
    assert.deepEqual(await flowOf(), flowBefore, 'the flow is unchanged');
    assert.equal(flowBefore.length, CLEAN_DONE.steps.length);
    assert.equal(await selectedStep(page), 0, 'the inspector holds the check, so no step is the selected one');

    const panel = await page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      const pair = (i) => { const r = host.querySelectorAll('.kv-row')[i]; return [r.querySelector('.kv-key').textContent, r.querySelector('.kv-value').innerText.replace(/\s+/g, ' ').trim()]; };
      return {
        heading: host.querySelector('#inspector-heading').textContent,
        sub: host.querySelector('.insp-head .insp-sub').textContent,
        verifier: pair(0), network: pair(1), signer: pair(2),
        rows: [...host.querySelectorAll('.record')].map((r) => ({ file: r.dataset.file, kind: r.dataset.kind, verdict: r.querySelector('.verdict span').textContent, tone: r.querySelector('.verdict').dataset.tone, flags: [...r.querySelectorAll('.record-line')[0].querySelectorAll('.record-flag')].map((f) => f.textContent), notes: [...r.querySelectorAll('.insp-note')].map((n) => n.textContent), noteLabel: r.querySelector('.record-line .record-line .record-flag')?.textContent })),
        summary: [...host.querySelectorAll('.insp-big')].map((n) => n.textContent),
        limit: host.querySelector('.insp > .insp-sub').textContent,
      };
    });
    assert.equal(panel.heading, offlineScene.title);
    assert.equal(panel.sub, COPY['offline.sub']);
    const sha16 = OFFLINE.verifier.sha256.slice(0, 16);
    assert.deepEqual(panel.verifier, [COPY['offline.verifier'], `${COPY['offline.verifierValue'].replace('{sha16}', sha16)} ${COPY['inspector.copy']}`]);
    assert.deepEqual(panel.network, [COPY['offline.network'], COPY['offline.networkValue']]);
    assert.deepEqual(panel.signer, [COPY['offline.signer'], `${COPY['offline.signerValue']} ${OFFLINE.pin}`]);
    assert.equal(panel.rows.length, OFFLINE.records.length + OFFLINE.tampered.length);
    OFFLINE.records.forEach((rec, i) => {
      assert.deepEqual(panel.rows[i], { file: rec.file, kind: 'records', verdict: COPY['offline.pass'], tone: 'ok', flags: [], notes: rec.notes, noteLabel: COPY['offline.note'] });
    });
    const bad = OFFLINE.tampered[0];
    assert.deepEqual(panel.rows[OFFLINE.records.length], { file: bad.file, kind: 'tampered', verdict: COPY['offline.reject'].replace('{n}', bad.firstFailingStep), tone: 'neutral', flags: [COPY['offline.tampered'], COPY['offline.expected']], notes: bad.notes, noteLabel: COPY['offline.note'] });
    assert.deepEqual(panel.summary, [COPY['offline.summaryPass'].replace('{pass}', OFFLINE.summary.pass), COPY['offline.summaryReject'].replace('{reject}', OFFLINE.summary.reject).replace('{expectedRejects}', OFFLINE.summary.expectedRejects)]);
    assert.equal(panel.limit, COPY['limit.steps']);

    // The record step now carries the verdict of each package.
    await page.keyboard.press('6');
    await view.settle();
    const verdicts = await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .record')].map((r) => ({ file: r.dataset.file, under: r.querySelector('[data-verdict-for] .record-flag')?.textContent ?? null, verdict: r.querySelector('.verdict span')?.textContent ?? null })));
    assert.deepEqual(verdicts.slice(0, 5), MANIFEST.records.map((rec) => ({ file: rec.file, under: COPY['inspector.stepsPassed'], verdict: COPY['offline.pass'] })));
    assert.deepEqual(verdicts[5], { file: MANIFEST.tampered[0].file, under: COPY['inspector.stepsPassed'], verdict: COPY['offline.reject'].replace('{n}', bad.firstFailingStep) });

    // The O key runs the check again and returns to its panel.
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
    assert.equal(await page.evaluate(() => document.querySelector('.scene[aria-pressed="true"]').dataset.kind), 'offline-check');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the record step before the offline check: the manifest rows with their hashes and actions, the tampered copy marked, and no verdict yet', async () => {
  const view = await openView(browser, { hash: '#inspect' });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    await page.keyboard.press('6');
    await view.settle();
    const panel = await page.evaluate(() => {
      const host = document.getElementById('pane-inspector');
      return {
        section: host.querySelector('.insp-section-title').textContent,
        keys: [...host.querySelectorAll('.kv-key')].map((k) => k.textContent),
        format: [...host.querySelectorAll('.kv-row')].find((r) => r.querySelector('.kv-key').dataset.src === 'copy:record.format').querySelector('.kv-value').textContent,
        note: host.querySelector('.insp-section > .insp-sub').textContent,
        rows: [...host.querySelectorAll('.record')].map((r) => ({ file: r.querySelector('a.record-file').textContent, href: r.querySelector('a.record-file').getAttribute('href'), sha: r.querySelector('.record-line .mono[title]').textContent, full: r.querySelector('.record-line .mono[title]').title, flags: [...r.querySelectorAll('.record-flag')].map((f) => f.textContent), verdict: r.querySelector('.verdict') !== null, entries: r.querySelector('.record-open') !== null })),
        artifacts: [...host.querySelectorAll('.artifact')].map((a) => a.dataset.file),
      };
    });
    assert.equal(panel.section, COPY['inspector.package']);
    for (const key of [COPY['record.format'], COPY['record.signer'], COPY['record.timestamp'], 'written', 'signerPublicKey', 'signerSha256', 'credentialSha256']) assert.ok(panel.keys.includes(key), key);
    const commit = /[0-9a-f]{40}/.exec(CLEAN_DONE.steps[5].detail.format)[0];
    assert.equal(panel.format, COPY['record.formatValue'].replace('{formatCommit}', commit.slice(0, 8)));
    assert.equal(panel.note, COPY['record.credentialNote']);
    assert.equal(panel.rows.length, 6);
    MANIFEST.records.forEach((rec, i) => {
      assert.deepEqual(panel.rows[i], { file: rec.file, href: `/api/runs/${CLEAN_DONE.runId}/files/${rec.file}`, sha: rec.sha256.slice(0, 16), full: rec.sha256, flags: [], verdict: false, entries: false });
    });
    assert.deepEqual(panel.rows[5].flags, [COPY['offline.tampered'], COPY['offline.expected']]);
    assert.deepEqual(panel.artifacts, ['state', CLEAN_DONE.steps[5].recordFile]);
    assertCensus(await census(page), docsFrom(view.served, CLEAN_DONE.runId));
  } finally {
    await view.close();
  }
});

test('a package the server holds: its Entries control lists the names of the zip\'s central directory and sets out metadata.json, read through a stored and a deflated entry', async () => {
  const metadata = { profile: 'opena2a-three-party-demo/1', runId: CLEAN_DONE.runId, seq: 5, step: 'pay', kind: 'clean', at: CLEAN_DONE.steps[4].endedAt, decision: 'allowed', reason: 'the tool call equals the declared intent field for field', actor_did: CLEAN_DONE.agent.did, credential_sha256: CLEAN_DONE.agent.credentialSha256, domain_from: CLEAN_DONE.agent.domain, domain_to: CLEAN_DONE.steps[2].detail.to, writer: 'our writer, AEP format', timestamp_entry: CLEAN_DONE.steps[5].detail.timestampEntry };
  const names = ['response.txt', 'metadata.json', 'canonical.bin', 'hash.sha256'];
  for (const deflate of [true, false]) {
    const zip = makeZip([
      { name: names[0], text: '{"paymentId":"x"}\n' },
      { name: names[1], text: JSON.stringify(metadata), deflate },
      { name: names[2], text: 'bytes of the canonical form\n', deflate: true },
      { name: names[3], text: 'a digest\n' },
    ]);
    const view = await openView(browser, { hash: '#inspect', server: { examples: examplesWith({ add: { '05-pay.aep': zip } }) } });
    const { page } = view;
    try {
      await runAndWait(view, 'clean', 'paid');
      await page.keyboard.press('6');
      await view.settle();
      const rel = 'records/05-pay.aep';
      const open = await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .record')].filter((r) => r.querySelector('.record-open')).map((r) => r.dataset.file));
      assert.deepEqual(open, [rel, 'records/tampered/05-pay.aep'], 'the packages the server holds have an Entries control; the others have none');
      const button = page.locator(`.record[data-file="${rel}"] .record-open`);
      assert.equal(await button.textContent(), COPY['inspector.entries']);
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      await button.click();
      const shown = await page.evaluate((file) => {
        const block = document.querySelector(`[data-entries-of="${file}"]`);
        return { expanded: document.querySelector(`.record[data-file="${file}"] .record-open`).getAttribute('aria-expanded'), entries: [...block.querySelectorAll('li')].map((li) => li.textContent), caption: block.querySelector('.meta').textContent, table: Object.fromEntries([...block.querySelectorAll('.kv-row')].map((r) => [r.querySelector('.kv-key').textContent, r.querySelector('.kv-value').textContent])), focused: document.activeElement.classList.contains('record-open') };
      }, rel);
      assert.equal(shown.expanded, 'true');
      assert.deepEqual(shown.entries, names, 'in the order of the central directory');
      assert.equal(shown.caption, LABELS.parties.rawIdentifiersNote);
      assert.deepEqual(shown.table, Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])));
      assert.equal(shown.focused, true, 'the control keeps the focus when the pane is drawn again');
      assertCensus(await census(page), docsFrom(view.served, CLEAN_DONE.runId, { entries: { [rel]: names }, members: { [`${rel}!metadata.json`]: metadata } }));
      await button.click();
      assert.equal(await page.evaluate((file) => document.querySelector(`[data-entries-of="${file}"]`), rel), null, 'a second press closes it');
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});

test('bytes that are not a zip, and a zip this reader does not handle, leave the entries out', async () => {
  const { listZip, readEntry } = await import('../view/zip.mjs');
  assert.equal(listZip(new Uint8Array(Buffer.from('not a zip at all, just some text that is long enough'))), null);
  assert.equal(listZip(new Uint8Array(4)), null);
  const good = new Uint8Array(makeZip([{ name: 'a.txt', text: 'alpha' }, { name: 'b.txt', text: 'beta beta beta', deflate: true }]));
  const entries = listZip(good);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.length]), [['a.txt', 0, 5], ['b.txt', 8, 14]]);
  assert.equal(Buffer.from(await readEntry(good, entries[0])).toString(), 'alpha');
  assert.equal(Buffer.from(await readEntry(good, entries[1])).toString(), 'beta beta beta');
  // A directory cut short, an entry that claims more than the file holds, a method this reader does not know.
  assert.equal(listZip(good.subarray(0, good.length - 30)), null);
  assert.equal(await readEntry(good, { ...entries[0], packed: 5000 }), null);
  assert.equal(await readEntry(good, { ...entries[0], method: 12 }), null);
  assert.equal(await readEntry(good, { ...entries[0], encrypted: true }), null);
  assert.equal(await readEntry(good, { ...entries[1], length: 99 }), null, 'an entry that inflates to another length than it claims');

  const view = await openView(browser, { hash: '#inspect', server: { examples: examplesWith({ add: { '05-pay.aep': 'this is not a zip' } }) } });
  try {
    await runAndWait(view, 'clean', 'paid');
    await view.page.keyboard.press('6');
    await view.settle();
    assert.equal(await view.page.evaluate(() => document.querySelectorAll('#pane-inspector .record-open').length), 0);
    assert.equal(await view.page.evaluate(() => document.querySelectorAll('#pane-inspector .record').length), 6, 'the manifest rows stay');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a server that does not offer the offline check, or files, leaves those elements out and shows no error', async () => {
  const view = await openView(browser, { hash: '#inspect', server: { examples: examplesWith({ omit: ['offline-check.json', 'manifest.json', 'hop-03-crossing.hop.json', 'action-05-pay.action.json'] }) } });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    // Inspect does not follow the run, so the record step is chosen by its key.
    await page.keyboard.press('6');
    await view.settle();
    assert.equal(await page.evaluate(() => document.querySelector('#pane-inspector .insp').dataset.panel), 'record');
    await page.keyboard.press('o');
    await view.settle();
    assert.equal(view.statuses.get(`POST /api/runs/${CLEAN_DONE.runId}/offline-check`), 501);
    assert.equal(await page.evaluate(() => document.querySelector('#pane-inspector .insp').dataset.panel), 'record', 'the inspector stays on the step');
    for (const key of ['3', '5', '6']) {
      await page.keyboard.press(key);
      await view.settle();
      const seen = await page.evaluate(() => ({ artifacts: [...document.querySelectorAll('#pane-inspector .artifact')].map((a) => a.dataset.file), records: document.querySelectorAll('#pane-inspector .record').length, error: document.getElementById('run-error').hidden, body: document.body.innerText }));
      assert.deepEqual(seen.artifacts, ['state'], `key ${key}: the step as the state holds it, and no file`);
      assert.equal(seen.records, 0);
      assert.equal(seen.error, true);
      assert.equal(/404|501|not found|error/i.test(seen.body), false, `key ${key}: an absence is not shown as an error`);
    }
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('a later revision that adds checks to a record row of the offline check: each name is listed with its value, in the offline pane and on the record step, and a row with no checks shows no list', async () => {
  // A fixture of a later revision, in the two forms a list of names and
  // values can take: a map of names to values, and a list of objects.
  const later = structuredClone(OFFLINE);
  later.records[0].checks = { 'check-a': 'pass', 'check-b': 'pass' };
  later.records[1].checks = [{ name: 'check-a', value: 'pass', step: 1 }, { name: 'check-b', value: 'pass', step: 2 }];
  const asMap = [[['check-a', 'pass']], [['check-b', 'pass']]];
  const asList = [[['name', 'check-a'], ['value', 'pass'], ['step', '1']], [['name', 'check-b'], ['value', 'pass'], ['step', '2']]];
  const view = await openView(browser, { hash: '#inspect', clockAt: new Date(Date.parse(CLEAN_DONE.finishedAt) + 5000).toISOString(), server: { examples: examplesWith({ add: { 'offline-check.json': later } }) } });
  const { page } = view;
  const listed = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#pane-inspector .record')].map((r) => [r.dataset.file, [...r.querySelectorAll('.checks > li')].map((li) => [...li.querySelectorAll('.kv-row')].map((row) => [row.querySelector('.kv-key').textContent, row.querySelector('.kv-value').textContent]))])));
  const expect = (lists, where) => {
    assert.deepEqual(lists[later.records[0].file], asMap, `${where}: a map of names to values`);
    assert.deepEqual(lists[later.records[1].file], asList, `${where}: a list of objects, a row per field`);
    for (const rec of [...later.records.slice(2), ...later.tampered]) assert.deepEqual(lists[rec.file], [], `${where}: ${rec.file} has no checks and no list`);
  };
  try {
    await runAndWait(view, 'clean', 'paid');
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
    await view.settle();
    expect(await listed(), 'the offline pane');
    assertCensus(await census(page), docsFrom(view.served, CLEAN_DONE.runId));

    await page.keyboard.press('6');
    await view.settle();
    expect(await listed(), 'the record step');
    assertCensus(await census(page), docsFrom(view.served, CLEAN_DONE.runId));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the list widens nothing');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the copy control: beside every hash and id, named for its value; a press puts the full value on the clipboard and the control reads Copied for two seconds', async () => {
  const view = await openView(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    await page.keyboard.press('1');
    await view.settle();
    const sha = CLEAN_DONE.agent.credentialSha256;
    const shown = await page.evaluate(() => {
      const value = document.querySelector('#pane-inspector .kv-value .mono[title]');
      const button = value.parentElement.querySelector('.copy-btn');
      return { text: value.textContent, title: value.title, button: button.textContent, name: button.getAttribute('aria-label') };
    });
    assert.deepEqual(shown, { text: sha.slice(0, 16), title: sha, button: COPY['inspector.copy'], name: `${COPY['inspector.copy']} agent.credentialSha256` }, 'Story shows 16 characters, with the full value in the title');
    await page.click('#pane-inspector .kv-value .copy-btn');
    await page.waitForFunction((word) => document.querySelector('#pane-inspector .kv-value .copy-btn').textContent === word, COPY['inspector.copied']);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sha);
    await page.waitForFunction((word) => document.querySelector('#pane-inspector .kv-value .copy-btn').textContent === word, COPY['inspector.copy'], { timeout: 4000 });

    await page.keyboard.press('i');
    const full = await page.evaluate(() => document.querySelector('#pane-inspector .kv-value .mono').textContent);
    assert.equal(full, 'fixtures/agents/billpay-agent.atx.json');
    const inspect = await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .kv-row')].map((r) => [r.querySelector('.kv-key').textContent, r.querySelector('.kv-value .mono')?.textContent]).find(([k]) => k === 'credentialSha256'));
    assert.equal(inspect[1], sha, 'Inspect shows the full value');

    // The run id in the top bar has one too.
    await page.click('.run-id .copy-btn');
    await page.waitForFunction((word) => document.querySelector('.run-id .copy-btn').textContent === word, COPY['inspector.copied']);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), CLEAN_DONE.runId);
  } finally {
    await view.close();
  }
});
