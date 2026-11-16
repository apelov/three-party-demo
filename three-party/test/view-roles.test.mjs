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
  col: part.dataset.col,
  label: part.querySelector('.part-name')?.textContent ?? null,
  badge: part.querySelector('.badge')?.textContent ?? null,
  lines: [...part.querySelectorAll('.insp-note')].map((n) => n.textContent),
})));

const label = (name) => CONTRACT_LABELS.parts[name].label;

test('the start screen: the orientation and the inspector name the parts by specification name and the bank and the agent by role, the stand-in with its mark and its note, and the lanes carry the same labels', async () => {
  const view = await openView(browser);
  try {
    const orient = await view.page.evaluate(() => [...document.querySelectorAll('#orient .orient-part')].map((p) => ({ col: p.dataset.col, label: p.querySelector('.lane-title').textContent, badge: p.querySelector('.badge')?.textContent ?? null, credit: p.querySelector('.orient-credit').textContent })));
    assert.deepEqual(orient.map((p) => [p.col, p.label]), [['checkpoint', label('checkpoint')], ['crossing', label('crossing')], ['record', label('record')]]);
    assert.deepEqual(orient.map((p) => p.badge), [null, COPY['marker.standIn'], null], 'the stand-in carries its mark where its credit would be');
    assert.deepEqual([orient[0].credit, orient[2].credit], [COPY['credit.checkpoint'], COPY['credit.record']]);

    const parts = await legend(view.page);
    assert.deepEqual(parts.map((p) => p.label), [label('checkpoint'), label('crossing'), label('bank'), label('record')]);
    assert.deepEqual(parts.map((p) => p.badge), [null, COPY['marker.standIn'], null, null]);
    assert.deepEqual(parts[0].lines, [COPY['credit.checkpoint']]);
    assert.deepEqual(parts[1].lines, [CONTRACT_LABELS.parts.crossing.standInNote, LABELS.parts.crossing.detail], 'the stand-in: its note in full and the line on what it covers, and no credit');
    assert.deepEqual(parts[2].lines, [COPY['credit.bank']]);
    assert.deepEqual(parts[3].lines, [COPY['credit.record'], LABELS.parts.record.detail], 'the record part: who made the format, and what the verifier checks of it');
    // Each label and note is the contract map's, by the source the element names.
    const sources = await view.page.evaluate(() => [...document.querySelectorAll('#pane-inspector [data-key="parts"] [data-src]')].map((n) => [n.dataset.src, n.textContent]));
    for (const [name, part] of Object.entries(CONTRACT_LABELS.parts)) {
      assert.ok(sources.some(([src, text]) => src === `labels:parts.${name}.label` && text === part.label), `${name}: the label`);
      if (part.standIn) assert.ok(sources.some(([src, text]) => src === `labels:parts.${name}.standInNote` && text === part.standInNote), `${name}: the note`);
    }
    const lanes = await view.page.evaluate(() => [...document.querySelectorAll('#lanes-head .lane')].map((lane) => lane.querySelector('.lane-title').textContent));
    assert.deepEqual(lanes, [CONTRACT_LABELS.parties.agent, label('checkpoint'), label('crossing'), label('bank'), label('record')]);
    // The run control reads the button the map gives the chosen item.
    assert.equal(await view.page.evaluate(() => document.getElementById('run-control').textContent), CONTRACT_LABELS.scenes.find((s) => s.kind === 'clean').button);
    await view.page.focus('.scene[data-kind="clean"]');
    await view.page.keyboard.press('ArrowDown');
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

test('the roles a run shows: the agent\'s and the bank\'s lanes, the invoice\'s sender, the two domains of the crossing and each step\'s part, each a string of the label map', async () => {
  for (const [kind, outcome, state] of RUNS) {
    const view = await openView(browser, { hash: '#inspect' });
    const { page } = view;
    try {
      await runAndWait(view, kind, outcome);
      const lanes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#lanes-head .lane')].map((l) => [l.dataset.col, l.querySelector('.lane-title').textContent])));
      assert.equal(lanes.agent, CONTRACT_LABELS.parties.agent);
      assert.equal(lanes.bank, label('bank'));
      // The run overview: the invoice card names its sender by role.
      await page.keyboard.press('0');
      await view.settle();
      const overview = await page.evaluate(() => {
        const card = document.querySelector('#pane-inspector .invoice-card');
        const fields = Object.fromEntries([...card.querySelectorAll('.kv-row')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
        return { fields, sender: card.querySelector('.kv-row dd [data-src]').dataset.src };
      });
      assert.equal(overview.fields[COPY['invoice.from']], CONTRACT_LABELS.parties.supplier);
      assert.equal(overview.sender, 'labels:parties.supplier');
      assert.equal(overview.fields[COPY['invoice.payTo']], COPY['invoice.payToValue'].replace('{account}', state.invoice.payTo.account));
      assert.equal(overview.fields[COPY['invoice.from']].includes(state.invoice.from), false);

      // The crossing: its row line and its inspector name the two domains by role.
      await page.keyboard.press('3');
      await view.settle();
      const crossing = await page.evaluate(() => ({
        line: document.querySelector('#rows .row[data-step="crossing"] .row-detail').textContent,
        rows: Object.fromEntries([...document.querySelectorAll('#pane-inspector [data-section="artifact"] .kv-row')].map((r) => [r.querySelector('.kv-key').textContent, r.querySelector('.kv-value').textContent])),
      }));
      assert.equal(crossing.line, COPY['detail.crossing'].replace('{domainA}', CONTRACT_LABELS.parties.domainA).replace('{domainB}', CONTRACT_LABELS.parties.domainB).replace('{hops}', state.steps[2].detail.hops).replace('{outcome}', state.steps[2].detail.outcome));
      assert.equal(crossing.rows.from, CONTRACT_LABELS.parties.domainA);
      assert.equal(crossing.rows.to, CONTRACT_LABELS.parties.domainB);

      // The credential step: no issuer row in its list; the issuer stands in
      // the step as the run state holds it.
      await page.keyboard.press('1');
      await view.settle();
      const credential = await page.evaluate(() => ({
        keys: [...document.querySelectorAll('#pane-inspector [data-section="artifact"] .kv-key')].map((k) => k.textContent),
        excerpt: document.querySelector('#pane-inspector .artifact[data-file="state"] .artifact-body').textContent,
      }));
      assert.equal(credential.keys.includes('issuer'), false, 'the issuer is a test identifier: it is not a row of the list');
      assert.ok(credential.excerpt.includes(`"issuer": "${state.steps[0].detail.issuer}"`), 'and it is in the step as the run state holds it');

      // Each step's part, by the label the run gives it, which is the map's.
      const marks = [];
      for (const n of ['1', '2', '3', '4', '5', '6']) {
        await page.keyboard.press(n);
        marks.push(await page.evaluate(() => document.querySelector('#pane-inspector .insp-head .part-name').textContent));
      }
      assert.deepEqual(marks, state.steps.map((s) => s.partLabel));
      assert.deepEqual(marks, [label('checkpoint'), label('checkpoint'), label('crossing'), label('checkpoint'), label('bank'), label('record')]);
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
        assert.equal(pane.note, CONTRACT_LABELS.parties.rawIdentifiersNote, `key ${key}, ${pane.file}`);
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

    // The record's metadata table, once the package of the payment is open
    // in its step's record section.
    await page.keyboard.press('5');
    await page.locator('.record[data-file="records/05-pay.aep"] .record-open').click();
    const table = await page.evaluate(() => {
      const block = document.querySelector('[data-entries-of="records/05-pay.aep"]');
      return { note: block.querySelector('.meta').textContent, text: block.querySelector('.kv').textContent };
    });
    assert.equal(table.note, CONTRACT_LABELS.parties.rawIdentifiersNote);
    for (const value of [metadata.actor_did, metadata.domain_from, metadata.domain_to]) assert.ok(table.text.includes(value), value);
    assert.deepEqual(hitsIn(await outsideRaw(page)), [], 'and nowhere else on the screen');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('stand-ins said where they appear, on both runs: the crossing carries the mark on its lane and in the inspector, with its note in the step\'s artifact; the record part is no stand-in, and its timestamp line and detail carry their notes', async () => {
  const crossingNote = CONTRACT_LABELS.parts.crossing.standInNote;
  const timestampNote = CONTRACT_LABELS.timestamp.standInNote;
  const selected = (page) => page.evaluate(() => {
    const host = document.getElementById('pane-inspector');
    const shown = (node) => Boolean(node) && node.getBoundingClientRect().height > 0;
    const stamp = host.querySelector('[data-note="timestamp"]');
    return {
      step: document.querySelector('#rows .row[aria-current="step"]')?.dataset.step ?? null,
      label: host.querySelector('.insp-head .part-name').textContent,
      badge: host.querySelector('.insp-head .badge')?.textContent ?? null,
      note: host.querySelector('[data-note="stand-in"]')?.textContent ?? null,
      noteShown: shown(host.querySelector('[data-note="stand-in"]')),
      detail: host.querySelector('[data-section="artifact"] [data-note="detail"]')?.textContent ?? null,
      stamp: stamp ? { note: stamp.textContent, shown: shown(stamp) } : null,
    };
  });
  // In Story the artifact section opens when asked for.
  const openArtifact = (page) => page.evaluate(() => { const s = document.querySelector('#pane-inspector [data-section="artifact"]'); if (s && !s.open) s.querySelector('summary').click(); });
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    for (const [kind, outcome] of RUNS) {
      const view = await openView(browser, { width, height });
      const { page } = view;
      try {
        await runAndWait(view, kind, outcome);
        const at = `${width} ${kind}`;
        const lanes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#lanes-head .lane')].map((lane) => [lane.dataset.col, { badge: lane.querySelector('.badge')?.textContent ?? null, tip: lane.querySelector('.lane-credit').getAttribute('title') }])));
        assert.deepEqual(Object.entries(lanes).filter(([, l]) => l.badge !== null).map(([col]) => col), ['crossing'], `${at}: the one stand-in lane`);
        assert.equal(lanes.crossing.badge, COPY['marker.standIn']);
        assert.equal(lanes.crossing.tip, crossingNote, `${at}: its note as the mark's tooltip`);
        // The crossing row, chosen with a click.
        await page.click('#rows .row[data-step="crossing"]');
        await openArtifact(page);
        const crossing = await selected(page);
        assert.deepEqual({ step: crossing.step, label: crossing.label, badge: crossing.badge, note: crossing.note, noteShown: crossing.noteShown, detail: crossing.detail }, { step: 'crossing', label: label('crossing'), badge: COPY['marker.standIn'], note: crossingNote, noteShown: true, detail: LABELS.parts.crossing.detail }, at);
        // The record row: no mark; the note on the timestamp line, and the
        // line on what the verifier checks of the format.
        await page.click('#rows .row[data-step="record"]');
        await openArtifact(page);
        const record = await selected(page);
        assert.deepEqual({ step: record.step, label: record.label, badge: record.badge, note: record.note, detail: record.detail }, { step: 'record', label: label('record'), badge: null, note: null, detail: LABELS.parts.record.detail }, at);
        assert.deepEqual(record.stamp, { note: timestampNote, shown: true }, at);
        // A step of a part that is not a stand-in carries no mark and no note.
        await page.click('#rows .row[data-step="grant"]');
        await openArtifact(page);
        const grant = await selected(page);
        assert.deepEqual({ badge: grant.badge, note: grant.note, stamp: grant.stamp }, { badge: null, note: null, stamp: null }, at);
        assert.deepEqual(view.errors, []);
      } finally {
        await view.close();
      }
    }
  }
});
