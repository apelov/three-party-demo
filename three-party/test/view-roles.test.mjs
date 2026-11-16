// Labels by specification name, parties as roles, and stand-ins said where
// they appear, on the three main screens (start, run, offline check) of both
// runs. What a screen shows for a part or a party is a string of the label
// map the server answers; the company names, DIDs and domains of the
// fixtures show where a file of the run is shown as it was written, under
// the map's note on test identifiers, and nowhere else.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, openView, runAndWait, examplesWith, makeZip, removeTempDirs, COPY, LABELS, CONTRACT_LABELS, CLEAN_DONE, POISONED } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

// The five words the brief names, and the identifiers the example runs
// themselves carry.
const FIXTURE_WORDS = ['Northwind', 'Lakeside', 'acme', 'Example Bank', 'example.test'];
const identifiersOf = (state) => [state.invoice.from, state.invoice.payTo.name, state.agent.did, state.agent.domain, state.steps[2].detail.from, state.steps[2].detail.to, state.steps[0].detail.issuer];
const NAMES = [...new Set([...FIXTURE_WORDS, ...identifiersOf(CLEAN_DONE), ...identifiersOf(POISONED)])];

const RUNS = [['clean', 'paid', CLEAN_DONE], ['poisoned', 'blocked', POISONED]];

// The text a viewer reads, and the same text with the panes that show the
// run as written taken out: the body of each artifact pane and the metadata
// table of an open record.
const rendered = (page) => page.evaluate(() => document.body.innerText);
const outsideRaw = (page) => page.evaluate(() => {
  const copy = document.body.cloneNode(true);
  for (const node of copy.querySelectorAll('.artifact-body, [data-entries-of] .kv')) node.remove();
  return copy.textContent;
});
const hitsIn = (text) => NAMES.filter((name) => text.includes(name));

const legend = (page) => page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-key="parts"] .insp-part')].map((part) => ({
  label: part.querySelector('.insp-part-label')?.textContent ?? null,
  badge: part.querySelector('.badge')?.textContent ?? null,
  lines: [...part.querySelectorAll('.insp-note')].map((n) => n.textContent),
})));

test('the start screen: the legend names the parts by specification name and the bank by role, each stand-in with its mark and its note, and the lanes carry the same labels', async () => {
  const view = await openView(browser);
  try {
    const parts = await legend(view.page);
    assert.deepEqual(parts.map((p) => p.label), ['OpenA2A · ATX · AAP', 'WIMSE · AI2II', "Supplier's bank", 'AEP']);
    assert.deepEqual(parts.map((p) => p.badge), [null, COPY['marker.standIn'], null, COPY['marker.standIn']]);
    assert.deepEqual(parts[1].lines, [LABELS.parts.crossing.text, 'Stand-in: our delegation-chain check runs here until the AI2II part is supplied.']);
    assert.deepEqual(parts[3].lines, [LABELS.parts.record.text, 'Our writer, in the AEP format. Stand-in label until the format is confirmed.']);
    assert.deepEqual(parts[0].lines, [LABELS.parts.checkpoint.text]);
    assert.deepEqual(parts[2].lines, [], 'the bank has no line of its own');
    // Each label, note and mark is the contract map's, by the source the element names.
    const sources = await view.page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-key="parts"] [data-src]')].map((n) => [n.dataset.src, n.textContent]));
    for (const [name, part] of Object.entries(CONTRACT_LABELS.parts)) {
      assert.ok(sources.some(([src, text]) => src === `labels:parts.${name}.label` && text === part.label), `${name}: the label`);
      if (part.standIn) assert.ok(sources.some(([src, text]) => src === `labels:parts.${name}.standInNote` && text === part.standInNote), `${name}: the note`);
    }
    const lanes = await view.page.evaluate(() => [...document.querySelectorAll('#lanes-head .lane')].map((lane) => lane.querySelector('.lane-title').textContent));
    assert.deepEqual(lanes, ['Payments agent', 'OpenA2A · ATX · AAP', 'WIMSE · AI2II', "Supplier's bank", 'AEP']);
    // The run control reads the button the map gives the chosen scene.
    assert.equal(await view.page.evaluate(() => document.getElementById('run-control').textContent), CONTRACT_LABELS.scenes.find((s) => s.kind === 'clean').button);
    await view.page.click('.scene[data-kind="poisoned"]');
    assert.equal(await view.page.evaluate(() => document.getElementById('run-control').textContent), CONTRACT_LABELS.scenes.find((s) => s.kind === 'poisoned').button);
    assert.deepEqual(hitsIn(await rendered(view.page)), []);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('parties as roles: on the start, run and offline check screens of both runs, in Story and in Inspect, the rendered text names no company, DID or domain of the fixtures outside the panes that show the run as written', async () => {
  for (const [kind, outcome] of RUNS) {
    const view = await openView(browser);
    const { page } = view;
    try {
      let screens = 0;
      // In Story the whole rendered text is read. In Inspect the panes that
      // show the run as written are taken out and the rest is read.
      const check = async (label) => {
        await view.settle();
        const mode = await page.evaluate(() => document.body.dataset.mode);
        if (mode === 'story') assert.deepEqual(hitsIn(await rendered(page)), [], `${label}: the rendered text`);
        assert.deepEqual(hitsIn(await outsideRaw(page)), [], `${label}: outside the panes that show the run as written`);
        screens += 1;
        return mode;
      };
      assert.equal(await check(`${kind}, start`), 'story');
      await runAndWait(view, kind, outcome);
      for (const [key, mode] of [['s', 'story'], ['i', 'inspect']]) {
        await page.keyboard.press(key);
        for (const step of ['0', '1', '2', '3', '4', '5', '6']) {
          await page.keyboard.press(step);
          assert.equal(await check(`${kind}, run, ${mode}, key ${step}`), mode);
        }
      }
      await page.keyboard.press('o');
      await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
      assert.equal(await check(`${kind}, offline check, Inspect`), 'inspect');
      await page.keyboard.press('s');
      assert.equal(await check(`${kind}, offline check, Story`), 'story');
      assert.equal(screens, 1 + 14 + 2);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});

test('the roles a run shows: the agent\'s lane and credential, the bank\'s lane, the invoice\'s sender, and the two domains of the crossing, each a string of the label map', async () => {
  for (const [kind, outcome, state] of RUNS) {
    const view = await openView(browser, { hash: '#inspect' });
    const { page } = view;
    try {
      await runAndWait(view, kind, outcome);
      // The run overview: the invoice card names its sender by role, and the agent by role.
      await page.keyboard.press('0');
      await view.settle();
      const overview = await page.evaluate(() => {
        const card = document.querySelector('#pane-inspector .invoice-card');
        const fields = Object.fromEntries([...card.querySelectorAll('.invoice-field')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
        return { fields, sender: card.querySelector('.invoice-field dd [data-src]').dataset.src, agent: document.querySelector('#pane-inspector .insp-big').textContent };
      });
      assert.equal(overview.fields[COPY['invoice.from']], 'Supplier');
      assert.equal(overview.sender, 'labels:parties.supplier');
      assert.equal(overview.fields[COPY['invoice.payTo']], COPY['invoice.payToValue'].replace('{account}', state.invoice.payTo.account));
      assert.equal(overview.agent, 'Payments agent');
      assert.equal(overview.fields[COPY['invoice.from']].includes(state.invoice.from), false);

      // The crossing: its row line and its inspector name the two domains by role.
      await page.keyboard.press('3');
      await view.settle();
      const crossing = await page.evaluate(() => ({
        line: document.querySelector('#rows .row[data-step="crossing"] .row-detail').textContent,
        rows: Object.fromEntries([...document.querySelectorAll('#pane-inspector .insp-section:not([data-artifacts]) .kv-row')].map((r) => [r.querySelector('.kv-key').textContent, r.querySelector('.kv-value').textContent])),
      }));
      assert.equal(crossing.line, "From Payments agent's domain to Supplier's bank's domain: 2 hops, chain valid");
      assert.equal(crossing.rows.from, "Payments agent's domain");
      assert.equal(crossing.rows.to, "Supplier's bank's domain");

      // The credential step: the agent by role, and no issuer row in the summary.
      await page.keyboard.press('1');
      await view.settle();
      const credential = await page.evaluate(() => ({
        agent: document.querySelector('#pane-inspector .insp-big').textContent,
        keys: [...document.querySelectorAll('#pane-inspector .insp-section:not([data-artifacts]) .kv-key')].map((k) => k.textContent),
        excerpt: document.querySelector('#pane-inspector .artifact[data-file="state"] .artifact-body').textContent,
      }));
      assert.equal(credential.agent, 'Payments agent');
      assert.equal(credential.keys.includes('issuer'), false, 'the issuer is a test identifier: it is not a row of the summary');
      assert.ok(credential.excerpt.includes(`"issuer": "${state.steps[0].detail.issuer}"`), 'and it is in the step as the run state holds it');

      // The rows: each carries the part label the run gives it, which is the map's.
      const labels = await page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((row) => [row.dataset.step, row.querySelector('.track-label').textContent]));
      assert.deepEqual(labels, [['credential', 'OpenA2A · ATX · AAP'], ['grant', 'OpenA2A · ATX · AAP'], ['crossing', 'WIMSE · AI2II'], ['intent', 'OpenA2A · ATX · AAP'], ['pay', "Supplier's bank"], ['record', 'AEP']]);
      assert.deepEqual(view.errors, []);
    } finally {
      await view.close();
    }
  }
});

test('the test identifiers show where the run is shown as written, under the map\'s note: every artifact pane of Inspect, and the metadata table of a record', async () => {
  const metadata = { profile: 'opena2a-three-party-demo/1', runId: CLEAN_DONE.runId, seq: 5, step: 'pay', kind: 'clean', actor_did: CLEAN_DONE.agent.did, domain_from: CLEAN_DONE.agent.domain, domain_to: CLEAN_DONE.steps[2].detail.to };
  const zip = makeZip([{ name: 'response.txt', text: '{"paymentId":"x"}\n' }, { name: 'metadata.json', text: JSON.stringify(metadata) }]);
  const view = await openView(browser, { hash: '#inspect', server: { examples: examplesWith({ add: { '05-pay.aep': zip } }) } });
  const { page } = view;
  try {
    await runAndWait(view, 'clean', 'paid');
    // The panes each step shows on the example files: the step as the run
    // state holds it, and the files of the step that are among the examples.
    const expected = {
      1: ['state'], 2: ['state'], 3: ['state', 'hops/03-crossing.hop.json'], 4: ['state'],
      5: ['state', 'actions/05-pay.action.json'], 6: ['state', 'records/manifest.json'],
    };
    const holding = [];
    for (const key of ['1', '2', '3', '4', '5', '6']) {
      await page.keyboard.press(key);
      await view.settle();
      const seen = await page.evaluate(() => [...document.querySelectorAll('#pane-inspector .artifact')].map((pane) => ({
        file: pane.dataset.file,
        note: pane.querySelector(':scope > .meta')?.textContent ?? null,
        noteSrc: pane.querySelector(':scope > .meta')?.dataset.src ?? null,
        noteBeforeBody: Boolean(pane.querySelector(':scope > .meta') && (pane.querySelector(':scope > .meta').compareDocumentPosition(pane.querySelector('.artifact-body')) & Node.DOCUMENT_POSITION_FOLLOWING)),
        body: pane.querySelector('.artifact-body').textContent,
      })));
      assert.deepEqual(seen.map((pane) => pane.file), expected[key], `key ${key}: the panes that show the run as written`);
      for (const pane of seen) {
        assert.equal(pane.note, 'Fictional test identifiers.', `key ${key}, ${pane.file}`);
        assert.equal(pane.noteSrc, 'labels:parties.rawIdentifiersNote');
        assert.equal(pane.noteBeforeBody, true, 'the note stands over the bytes');
        if (hitsIn(pane.body).length) holding.push(`${key} ${pane.file}`);
      }
    }
    // The panes that hold an identifier of the fixtures, so the note has
    // something to stand over: the issuer of the credential, the two domains
    // of the crossing in the state and in the hop file, and the agent's DID
    // and domain in the pay action.
    assert.deepEqual(holding, ['1 state', '3 state', '3 hops/03-crossing.hop.json', '5 actions/05-pay.action.json']);

    // The record's metadata table, once a package is open.
    await page.locator('.record[data-file="records/05-pay.aep"] .record-open').click();
    const table = await page.evaluate(() => {
      const block = document.querySelector('[data-entries-of="records/05-pay.aep"]');
      return { note: block.querySelector('.meta').textContent, text: block.querySelector('.kv').textContent };
    });
    assert.equal(table.note, 'Fictional test identifiers.');
    for (const value of [metadata.actor_did, metadata.domain_from, metadata.domain_to]) assert.ok(table.text.includes(value), value);
    assert.deepEqual(hitsIn(await outsideRaw(page)), [], 'and nowhere else on the screen');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('stand-ins said where they appear, on both runs: the crossing row and the record row each carry the mark and their part\'s note, and the timestamp line carries its note', async () => {
  const crossingNote = 'Stand-in: our delegation-chain check runs here until the AI2II part is supplied.';
  const recordNote = 'Our writer, in the AEP format. Stand-in label until the format is confirmed.';
  const timestampNote = 'Stand-in: no timestamp authority.';
  const selected = (page) => page.evaluate(() => {
    const part = document.querySelector('#pane-inspector .insp-part');
    const stamp = document.querySelector('#pane-inspector [data-note="timestamp"]');
    const shown = (node) => Boolean(node) && node.getBoundingClientRect().height > 0;
    return {
      step: document.querySelector('#rows .row[aria-current="step"]')?.dataset.step ?? null,
      label: part.querySelector('.insp-part-label').textContent,
      badge: part.querySelector('.badge')?.textContent ?? null,
      note: part.querySelector('[data-note="stand-in"]')?.textContent ?? null,
      noteShown: shown(part.querySelector('[data-note="stand-in"]')),
      stamp: stamp ? { note: stamp.textContent, badge: stamp.closest('.kv-row').querySelector('.badge')?.textContent ?? null, shown: shown(stamp) } : null,
    };
  });
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    for (const [kind, outcome] of RUNS) {
      const view = await openView(browser, { width, height });
      const { page } = view;
      try {
        await runAndWait(view, kind, outcome);
        const at = `${width} ${kind}`;
        // The lanes: the mark on the two stand-in lanes at every size, and
        // the note under it where the window has the height for it.
        const lanes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#lanes-head .lane')].map((lane) => [lane.dataset.col, { badge: lane.querySelector('.badge')?.textContent ?? null, note: lane.querySelector('.lane-note')?.textContent ?? null }])));
        assert.deepEqual(Object.entries(lanes).filter(([, l]) => l.badge !== null).map(([col]) => col), ['crossing', 'record'], at);
        assert.equal(lanes.crossing.badge, COPY['marker.standIn']);
        if (width >= 1440) {
          assert.equal(lanes.crossing.note, crossingNote, at);
          assert.equal(lanes.record.note, recordNote, at);
        }
        // The crossing row, chosen with a click.
        await page.click('#rows .row[data-step="crossing"]');
        const crossing = await selected(page);
        assert.deepEqual({ step: crossing.step, label: crossing.label, badge: crossing.badge, note: crossing.note, noteShown: crossing.noteShown }, { step: 'crossing', label: 'WIMSE · AI2II', badge: COPY['marker.standIn'], note: crossingNote, noteShown: true }, at);
        // The record row: its part's note, and the note on the timestamp line.
        await page.click('#rows .row[data-step="record"]');
        const record = await selected(page);
        assert.deepEqual({ step: record.step, label: record.label, badge: record.badge, note: record.note, noteShown: record.noteShown }, { step: 'record', label: 'AEP', badge: COPY['marker.standIn'], note: recordNote, noteShown: true }, at);
        assert.deepEqual(record.stamp, { note: timestampNote, badge: COPY['marker.standIn'], shown: true }, at);
        // A step of a part that is not a stand-in carries no mark and no note.
        await page.click('#rows .row[data-step="grant"]');
        const grant = await selected(page);
        assert.deepEqual({ badge: grant.badge, note: grant.note, stamp: grant.stamp }, { badge: null, note: null, stamp: null }, at);
        assert.deepEqual(view.errors, []);
      } finally {
        await view.close();
      }
    }
  }
  // The three notes are the map's own.
  assert.equal(CONTRACT_LABELS.parts.crossing.standInNote, crossingNote);
  assert.equal(CONTRACT_LABELS.parts.record.standInNote, recordNote);
  assert.equal(CONTRACT_LABELS.timestamp.standInNote, timestampNote);
});
