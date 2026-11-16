// Nothing typed: every text of the page is a line of the copy deck, a string
// of the label map or a value the run API served, and the page says which.
// The check walks every text node of the document, finds the element that
// names its source in data-src, and compares the text with that source.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, openView, runAndWait, census, assertCensus, docsFrom, servedText, viewFiles, grepLines, tempDir, removeTempDirs, COPY, LABELS, BUNDLED, CONTRACT_LABELS, VIEW, ROOT, CLEAN_DONE, POISONED } from './support/view-helpers.mjs';

let browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); removeTempDirs(); });

const j = (...parts) => parts.join('');

// The lines of a staged copy block: `key = value`, the value every byte
// after the leading ` = `.
function blockLines(name) {
  const deck = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
  assert.ok(deck.endsWith('\n'), name);
  return deck.slice(0, -1).split('\n');
}

// The block staged for the menu, the trace and the invoice a viewer edits
// has 68 lines. Four of them, all for the screen a later build adds, cannot
// enter the tree as they are worded: each trips a check that was here before
// the block. Two hold a word that this repository's own check on claim words
// bars in every file it tracks. One holds the letters a demo id starts with,
// which the check further down this file finds in a file of the view. One
// uses, as a verb, a word that the check on the name of the intent rule
// finds there. They are not in the deck, and not in the copy of the block
// kept beside this test, until their words or those checks are settled: the
// keys below, in the block's order.
const LEFT_OUT = ['tryit.yours', 'tryit.agentReads', 'tryit.inMemory', 'tryit.badAccount'];

// After it, the block for an offline check whose network denial was not
// measured (a platform with no method, or one the system does not let
// apply): two lines, the sentence under the heading and the value of the
// network row.
const NOT_MEASURED_BLOCK = 'copy-block-d.txt';

// After it, the block for the rebuilt screens: the sequence, the Records
// tab, the walkthrough's progress, the list of keys, the credits under the
// lanes, the sentences of what each step checked and the lines of the four
// lenses.
const SCREENS_BLOCK = 'copy-block-e.txt';

// Last, the block for the task above the sequence: the sentence that says
// what you told your AI assistant to pay, and the words before the line a
// poisoned invoice hides for the assistant.
const TASK_BLOCK = 'copy-block-f.txt';

// After it, the block for the side panel's comparison and for the crossing
// as the run state holds it: whose account each value of a differing field
// is, and why a crossing that checked the recording holds no chain.
const WHOSE_BLOCK = 'copy-block-g.txt';

test('copy.json holds the 100 lines of the staged copy deck and, after them, the lines of the block for the menu, the trace and the invoice a viewer edits, then the two of the block for a network denial that was not measured, then the 116 of the block for the rebuilt screens, then the two of the block for the task, then the three of the block for the comparison and the crossing: each key and value byte for byte, and nothing else', () => {
  const deck = blockLines('copy-block-b.txt');
  const added = blockLines('copy-block-c.txt');
  const notMeasured = blockLines(NOT_MEASURED_BLOCK);
  const screens = blockLines(SCREENS_BLOCK);
  const task = blockLines(TASK_BLOCK);
  const whose = blockLines(WHOSE_BLOCK);
  assert.equal(deck.length, 100);
  assert.equal(added.length, 68 - LEFT_OUT.length);
  assert.equal(notMeasured.length, 2);
  assert.equal(screens.length, 116);
  assert.equal(task.length, 2);
  assert.equal(whose.length, 3);
  const lines = [...deck, ...added, ...notMeasured, ...screens, ...task, ...whose];
  const members = 100 + added.length + notMeasured.length + screens.length + task.length + whose.length;
  assert.equal(members, 287);
  for (const key of LEFT_OUT) assert.equal(Object.hasOwn(COPY, key), false, `${key} is not in the deck`);
  const keys = Object.keys(COPY);
  assert.equal(keys.length, members);
  lines.forEach((line, i) => {
    const cut = line.indexOf(' = ');
    assert.ok(cut > 0, line);
    assert.equal(keys[i], line.slice(0, cut), `line ${i + 1}: the key, in the deck's order`);
    assert.equal(COPY[keys[i]], line.slice(cut + 3), `line ${i + 1}: the value`);
  });
  // RFC 8259: one flat object, unique member names (a repeated name would
  // have been dropped by the parser and the count above would be short).
  const text = fs.readFileSync(path.join(VIEW, 'copy.json'), 'utf8');
  assert.equal((text.match(/^ {2}"/gm) ?? []).length, members, 'one member per line, none nested');
  for (const value of Object.values(COPY)) assert.equal(typeof value, 'string');
  // No key of the added block was in the deck before it.
  assert.equal(new Set(keys).size, members);
  assert.deepEqual(keys.slice(0, 100), deck.map((line) => line.slice(0, line.indexOf(' = '))));
});

test('the label map the page holds: the members of the contract\'s map from the server, the structure of the screen from the view\'s own file, and no member the brief does not name', () => {
  assert.deepEqual(Object.keys(CONTRACT_LABELS), ['revision', 'parts', 'parties', 'timestamp', 'scenes']);
  assert.deepEqual(Object.keys(BUNDLED), ['revision', 'parts', 'scenes', 'columns', 'stepColumns', 'stepFrom', 'columnWeights', 'states', 'outcomeHeadlines', 'countdown', 'keys', 'trace', 'lenses']);
  assert.deepEqual(Object.keys(LABELS).sort(), ['revision', 'parts', 'parties', 'timestamp', 'scenes', 'columns', 'stepColumns', 'stepFrom', 'columnWeights', 'states', 'outcomeHeadlines', 'countdown', 'keys', 'trace', 'lenses'].sort());
  // The structure the rebuilt screens add: the column each step's arrow
  // starts from where it is not the party's, the lanes' weights, and the
  // four lenses, each naming the inspector's three sections in its order.
  assert.deepEqual(BUNDLED.stepFrom, { record: 'checkpoint' });
  assert.deepEqual(Object.keys(BUNDLED.columnWeights), BUNDLED.columns);
  assert.deepEqual(BUNDLED.lenses.map((l) => l.id), ['security', 'finance', 'platform', 'standards']);
  for (const lens of BUNDLED.lenses) assert.deepEqual([...lens.sections].sort(), ['artifact', 'checked', 'record'], lens.id);
  // The members the menu and the trace add are those of the staged fragment,
  // value for value: four key names and the trace's settings. The fragment's
  // scene row and its two step columns belong to the screen where a viewer
  // edits an invoice, and are not here. One value is not the staged one: the
  // token for the rows that open in Story ended in a word this repository's
  // check on claim words bars, so here and in the copy of the fragment it is
  // that token without the word. The page shows it nowhere.
  const addOn = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'labels-add-on.json'), 'utf8'));
  assert.deepEqual(Object.keys(addOn.keys), ['trace', 'replay', 'back', 'forward']);
  for (const [name, value] of Object.entries(addOn.keys)) assert.equal(BUNDLED.keys[name], value, `keys.${name}`);
  assert.deepEqual(Object.keys(BUNDLED.keys), ['next', 'prev', 'mode', 'trace', 'replay', 'back', 'forward', 'run', 'audit', 'story', 'inspect', 'overview', 'digits', 'home', 'end', 'inspector', 'lens', 'help', 'close']);
  assert.deepEqual(BUNDLED.trace, addOn.trace);
  assert.deepEqual(BUNDLED.trace, { laneSeconds: 120, nestedInStory: 'decided', nestedInInspect: 'all' });
  assert.equal(BUNDLED.scenes.some((scene) => addOn.scenes.some((s) => s.id === scene.id)), false);
  for (const id of Object.keys(addOn.stepColumns)) assert.equal(Object.hasOwn(BUNDLED.stepColumns, id), false, id);
  // The view's own file carries the screens' words for a part or a scene and
  // no label, role, note or button: those come from the contract's map.
  for (const [name, part] of Object.entries(BUNDLED.parts)) assert.deepEqual(Object.keys(part).filter((k) => !['text', 'detail'].includes(k)), [], name);
  for (const scene of BUNDLED.scenes) assert.deepEqual(Object.keys(scene), ['id', 'kind', 'title', 'text', 'available']);
  for (const [name, part] of Object.entries(CONTRACT_LABELS.parts)) assert.equal(LABELS.parts[name].label, part.label, name);
  assert.deepEqual(LABELS.parties, CONTRACT_LABELS.parties);
});

// Walk the page through its states and take the census at each.
async function walk(view, kind, outcome, check) {
  const { page } = view;
  await runAndWait(view, kind, outcome);
  const runId = await page.evaluate(() => document.querySelector('.run-id .mono').textContent);
  let checked = 0;
  const stop = async (label) => {
    await view.settle();
    checked += await check(label, docsFrom(view.served, runId), runId);
  };
  for (const mode of ['s', 'i']) {
    await page.keyboard.press(mode);
    for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
      await page.keyboard.press(key);
      await stop(`${kind} ${mode} ${key}`);
    }
  }
  await page.keyboard.press('o');
  await page.waitForFunction(() => document.querySelector('#pane-inspector .insp')?.dataset.panel === 'offline');
  await stop(`${kind} offline inspect`);
  await page.keyboard.press('s');
  await stop(`${kind} offline story`);
  return { checked, runId };
}

test('every text node names its source, and each text equals that source: start, both runs, every step, the run overview and the offline check, in Story and in Inspect', async () => {
  const view = await openView(browser);
  try {
    const start = await census(view.page);
    let total = assertCensus(start, {});
    assert.ok(start.items.some((item) => item.src === 'copy:ui.lead'));
    for (const [kind, outcome] of [['clean', 'paid'], ['poisoned', 'blocked']]) {
      const { checked } = await walk(view, kind, outcome, async (label, docs) => {
        const result = await census(view.page);
        try {
          return assertCensus(result, docs);
        } catch (err) {
          err.message = `${label}: ${err.message}`;
          throw err;
        }
      });
      total += checked;
    }
    assert.ok(total > 2000, `the census read ${total} sourced texts`);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('every hash, id, DID and amount in an inspector pane is a part of what the run API served for that run', async () => {
  // An account is four digits, a hyphen and four digits; an invoice or a
  // payment is INV- or PAY- and its digits. Neither carries a word before it.
  const identifier = /(?<![A-Z0-9-])(?:\d{4}-\d{4}|(?:INV|PAY)-\d+)\b/g;
  const token = new RegExp(`[0-9a-f]{16,64}|${identifier.source}|did:web:\\S+|\\b\\d+\\.\\d{2}\\b`, 'g');
  const view = await openView(browser);
  try {
    for (const [kind, outcome] of [['clean', 'paid'], ['poisoned', 'blocked']]) {
      let tokens = 0;
      let identifiers = 0;
      await walk(view, kind, outcome, async (label, docs, runId) => {
        const text = await view.page.evaluate(() => document.getElementById('pane-inspector').innerText);
        const servedAll = servedText(view.served, runId);
        identifiers += (text.match(identifier) ?? []).length;
        for (const found of text.match(token) ?? []) {
          tokens += 1;
          assert.ok(servedAll.includes(found), `${label}: ${found} is not in what the server sent for ${runId}`);
        }
        return 0;
      });
      // Story keeps the sections it does not lead with closed, so their
      // values are read in Inspect, where every section is open. The
      // comparison shows a value once where the invoice and the tool call
      // agree, so a stopped run reads fewer than a paid one.
      assert.ok(tokens > 30, `${kind}: ${tokens} tokens read`);
      assert.ok(identifiers >= 6, `${kind}: ${identifiers} accounts and invoices read in the form the run carries them`);
    }
  } finally {
    await view.close();
  }
});

test('Story shows no fixture company name, DID or domain; Inspect shows them in the artifact panes alone', async () => {
  const names = [POISONED.invoice.from, POISONED.invoice.payTo.name, CLEAN_DONE.invoice.from, POISONED.agent.did, POISONED.agent.domain, POISONED.steps[2].detail.to, POISONED.steps[0].detail.issuer];
  const view = await openView(browser);
  try {
    for (const [kind, outcome] of [['clean', 'paid'], ['poisoned', 'blocked']]) {
      await runAndWait(view, kind, outcome);
      for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
        await view.page.keyboard.press('s');
        await view.page.keyboard.press(key);
        await view.settle();
        const story = await view.page.evaluate(() => document.body.innerText);
        for (const name of names) assert.equal(story.includes(name), false, `Story, ${kind}, key ${key}: ${name}`);
        await view.page.keyboard.press('i');
        await view.settle();
        const outside = await view.page.evaluate(() => {
          const copy = document.body.cloneNode(true);
          for (const node of copy.querySelectorAll('.artifact-body')) node.remove();
          return copy.textContent;
        });
        for (const name of names) assert.equal(outside.includes(name), false, `Inspect outside the artifact panes, ${kind}, key ${key}: ${name}`);
      }
    }
  } finally {
    await view.close();
  }
});

test('no file of the view holds a hash, a demo id or a DID', () => {
  const files = viewFiles(['.mjs', '.css', '.html', '.json']);
  assert.ok(files.length >= 13);
  assert.deepEqual(grepLines(files, new RegExp(j('[0-9a-f]{16,}|DE', 'MO-|did:', 'web:'))), []);
});

test('one source: outside labels.json and copy.json, no file of the view holds a label, a party role, a scene text, a state word or a copy value as a quoted string', () => {
  const values = new Set(Object.values(COPY));
  const collect = (node) => {
    if (typeof node === 'string') values.add(node);
    else if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === 'object') Object.values(node).forEach(collect);
  };
  for (const key of ['parts', 'parties', 'timestamp', 'keys']) collect(LABELS[key]);
  for (const scene of LABELS.scenes) for (const key of ['title', 'text', 'button', 'standInNote']) if (scene[key]) values.add(scene[key]);
  // Structure ids of the map (step ids, icon names, tones, copy keys) are
  // not words of the screen and may be named in code.
  for (const part of Object.values(LABELS.parts)) for (const id of part.steps) values.delete(id);
  // A key named as the browser names it (a digit, Home, End, Enter, Escape,
  // ?) is also what the page's key handler compares against.
  for (const name of Object.values(LABELS.keys)) if (/^(?:[0-9?]|Home|End|Enter|Escape)$/.test(name)) values.delete(name);
  const quoted = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const found = [];
  for (const file of viewFiles(['.mjs', '.css', '.html'])) {
    for (const m of file.text.matchAll(quoted)) {
      const text = m[1] ?? m[2] ?? m[3];
      if (values.has(text)) found.push(`${file.name}: ${text}`);
    }
  }
  assert.deepEqual(found, []);
  assert.ok(values.has('Passed') && values.has('AEP') && values.has('Run the normal payment') && values.has('Payments agent'));
});

test('a label map the server sends replaces the page\'s own key by key: a new checkpoint label changes the column title with no code change, and a key it lacks stays', async () => {
  const dir = tempDir('three-party-labels-');
  const file = path.join(dir, 'labels.json');
  const parts = structuredClone(LABELS.parts);
  parts.checkpoint.label = 'Checkpoint (the label of a later revision)';
  // The members a server of this tree answers, with the one label changed.
  // The structure of the screen (columns, states, keys) is not among them.
  const served = Object.fromEntries(Object.keys(CONTRACT_LABELS).map((key) => [key, LABELS[key]]));
  fs.writeFileSync(file, JSON.stringify({ ...served, parts }));
  const view = await openView(browser, { server: { labels: file } });
  try {
    const titles = await view.page.evaluate(() => [...document.querySelectorAll('#lanes-head .lane')].map((lane) => ({ col: lane.dataset.col, title: lane.querySelector('.lane-title').textContent })));
    assert.deepEqual(titles.map((t) => t.col), LABELS.columns, 'columns is not in the served map, so the page\'s own stays');
    assert.equal(titles[1].title, parts.checkpoint.label);
    assert.equal(titles[0].title, LABELS.parties.agent);
    assert.equal(titles[2].title, LABELS.parts.crossing.label);
    assert.equal(await view.page.evaluate(() => document.querySelectorAll('.scene').length), 3);
    await runAndWait(view, 'clean', 'paid');
    assert.equal(await view.page.evaluate(() => document.querySelector('#rows .row .chip-word').textContent), COPY['state.passed'], 'states is not in the served map, so the page\'s own stays');
    // The inspector shows the run's own part label for a step, whatever the map says.
    await view.page.keyboard.press('1');
    await view.settle();
    const mark = await view.page.evaluate(() => document.querySelector('#pane-inspector .insp-head .part-name').textContent);
    assert.equal(mark, CLEAN_DONE.steps[0].partLabel);
    assertCensus(await census(view.page), docsFrom(view.served, CLEAN_DONE.runId), { labels: { ...LABELS, parts } });
  } finally {
    await view.close();
  }
});

test('a server with no label route: the page holds no part or party label of its own, so no title stands over a lane; the scenes it can name are listed, the control takes the deck\'s line, and a run shows its own part labels', async () => {
  const view = await openView(browser, { server: { labels: path.join(tempDir('three-party-labels-'), 'absent.json') } });
  try {
    assert.equal(view.statuses.get('GET /api/labels'), 404);
    const start = await view.page.evaluate(() => ({
      lanes: [...document.querySelectorAll('#lanes-head .lane')].map((lane) => lane.dataset.col),
      titles: [...document.querySelectorAll('#lanes-head .lane-title')].map((t) => t.textContent),
      scenes: [...document.querySelectorAll('.scene .scene-title')].map((t) => t.textContent),
      control: document.getElementById('run-control').textContent,
    }));
    assert.deepEqual(start.lanes, BUNDLED.columns);
    assert.deepEqual(start.titles, [], 'no label is invented');
    assert.deepEqual(start.scenes, BUNDLED.scenes.filter((s) => s.available).map((s) => s.title));
    assert.equal(start.control, COPY['button.runName'].replace('{scene}', BUNDLED.scenes[0].title));
    assertCensus(await census(view.page), {}, { labels: BUNDLED });
    await runAndWait(view, 'clean', 'paid');
    const marks = [];
    for (const n of ['1', '2', '3', '4', '5', '6']) {
      await view.page.keyboard.press(n);
      marks.push(await view.page.evaluate(() => document.querySelector('#pane-inspector .insp-head .part-name').textContent));
    }
    assert.deepEqual(marks, CLEAN_DONE.steps.map((s) => s.partLabel));
    assertCensus(await census(view.page), docsFrom(view.served, CLEAN_DONE.runId), { labels: BUNDLED });
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

// ---- The trace and the step controls

test('the trace and the step controls: every text node names its source and equals it, before a run, on both runs, in Story and in Inspect, at every selection, with the offline check and through a replay; each start and each time taken is the arithmetic on the served state', async () => {
  const view = await openView(browser, { hash: '#story-trace' });
  const { page } = view;
  try {
    assert.equal(await page.evaluate(() => document.body.dataset.view), 'trace');
    let total = assertCensus(await census(page), {});
    for (const [kind, outcome] of [['clean', 'paid'], ['poisoned', 'blocked']]) {
      await runAndWait(view, kind, outcome);
      const runId = await page.evaluate(() => document.querySelector('.run-id .mono').textContent);
      const stop = async (label) => {
        await view.settle();
        try {
          total += assertCensus(await census(page), docsFrom(view.served, runId));
        } catch (err) {
          err.message = `${kind} ${label}: ${err.message}`;
          throw err;
        }
      };
      for (const mode of ['s', 'i']) {
        await page.keyboard.press(mode);
        for (const key of ['0', '1', '2', '3', '4', '5', '6']) {
          await page.keyboard.press(key);
          await stop(`${mode} ${key}`);
        }
      }
      // A row inside a step, opened from the grid: its step, with its item marked.
      await page.click('#trace-body [data-kind="call"]');
      await stop('a tool call row');
      await page.click('#trace-body [data-kind="record"]');
      await stop('a record row');
      // The offline check opens the Records tab and adds its row and its
      // records to the trace.
      await page.keyboard.press('o');
      await page.waitForFunction(() => document.body.dataset.tab === 'records');
      await stop('offline records');
      await page.keyboard.press('t');
      await page.waitForFunction(() => document.querySelector('#trace-body [data-span="offline-check"]') !== null);
      await stop('offline inspect');
      await page.keyboard.press('s');
      await stop('offline story');
      // A replay, in the trace and in the flow.
      await page.keyboard.press('p');
      await stop('replay 0');
      for (const n of [1, 2, 3, 4, 5]) {
        await page.keyboard.press('ArrowRight');
        await stop(`replay ${n}`);
        if (n === 3) {
          await page.keyboard.press('t');
          await stop('replay 3, the flow');
          await page.keyboard.press('t');
        }
      }
      await page.keyboard.press('ArrowRight');
      await stop('replay over');
      await page.keyboard.press('0');
    }
    assert.ok(total > 4500, `the census read ${total} sourced texts`);
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});

test('the sources the trace and the step controls name: a copy line for every word, the label map for each key, the run for every value, and the page\'s own count for the rows it shows and the step a replay stands at', async () => {
  const view = await openView(browser, { hash: '#inspect-trace' });
  const { page } = view;
  try {
    const src = (selector) => page.evaluate((s) => document.querySelector(s)?.dataset.src ?? null, selector);
    const text = (selector) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);
    // The controls of the menu and the switch, before a run.
    assert.deepEqual([await src('#step-back'), await src('#step-forward'), await src('#step-replay')], ['copy:menu.back', 'copy:menu.forward', 'copy:menu.replay']);
    assert.deepEqual([await src('#tab-sequence'), await src('#tab-trace'), await src('#tab-records')], ['copy:ui.tabSequence', 'copy:ui.tabTrace', 'copy:ui.tabRecords']);
    assert.equal(await src('#footer .footer-keys'), 'copy:ui.keys;next=labels:keys.next;prev=labels:keys.prev;run=labels:keys.run;audit=labels:keys.audit;help=labels:keys.help');
    assert.equal(await text('#footer .footer-keys'), COPY['ui.keys'].replace('{next}', LABELS.keys.next).replace('{prev}', LABELS.keys.prev).replace('{run}', LABELS.keys.run).replace('{audit}', LABELS.keys.audit).replace('{help}', LABELS.keys.help));
    // Every key the dialog lists is named by the label map, and said by the deck.
    const keyRows = await page.evaluate(() => [...document.querySelectorAll('#keys-dialog .kv-row')].map((row) => ({ key: row.querySelector('kbd').dataset.src, what: row.querySelector('dd').dataset.src })));
    assert.ok(keyRows.length >= 12, `${keyRows.length} keys listed`);
    for (const row of keyRows) {
      assert.match(row.key, /^labels:keys\.[a-z]+$/);
      assert.match(row.what, /^copy:keyhelp\.[a-z]+$/);
    }
    assert.equal(await src('#trace-body [data-span="grant"] .trace-title'), 'copy:step.grant', 'before a run a step is named by the deck');
    assert.equal(await src('#trace-count'), 'copy:trace.rows;count=view:rows');

    await runAndWait(view, 'poisoned', 'blocked');
    await page.waitForFunction(() => document.querySelectorAll('#trace-body [data-kind="record"]').length > 0);
    const grant = '#trace-body [data-span="grant"]';
    assert.equal(await src(`${grant} .trace-num`), 'run:steps[1]|ordinal');
    assert.equal(await src(`${grant} .trace-title`), 'run:steps[1].title');
    assert.equal(await src(`${grant} > .trace-start`), 'copy:trace.offset;seconds=run:steps[1].startedAt|sinceStart');
    assert.equal(await text(`${grant} > .trace-start`), '+10 s');
    assert.equal(await src(`${grant} > .trace-dur`), 'copy:trace.duration;seconds=run:steps[1]|span');
    assert.equal(await text(`${grant} > .trace-dur`), '2 s');
    assert.equal(await src(`${grant} .chip-word`), 'copy:state.passed;when=run:steps[1].status');
    assert.equal(await src('#trace-body [data-span="grant/check/1"] > .trace-step'), 'copy:trace.check;name=run:steps[1].detail.scopeChecked[1]');
    assert.equal(await src('#trace-body [data-span="credential/check/0"] > .trace-step'), 'copy:trace.check;name=run:steps[0].detail.verifier');
    assert.equal(await src('#trace-body [data-span="intent/declared/0"] > .trace-step'), 'copy:trace.declared');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] > .trace-step'), 'copy:trace.call;tool=run:steps[3].detail.calls[1].tool');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] > .trace-dur'), 'copy:trace.notTimed');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] .verdict > span'), 'copy:decision.blocked;when=run:steps[3].detail.calls[1].match');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] .trace-why'), 'copy:intent.differs;when=run:steps[3].detail.calls[1].fieldsDiffering[0]');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] .trace-state .mono'), 'run:steps[3].detail.calls[1].fieldsDiffering[0]');
    assert.equal(await src('#trace-body [data-span="intent/call/1"] .trace-pill'), 'copy:trace.decidedHere;when=run:blockedAt');
    assert.equal(await src('#trace-body [data-span="intent/call/0"] .trace-why'), 'copy:intent.undeclared;when=run:steps[3].detail.calls[0].declaredFor');
    assert.equal(await src('#trace-body [data-span="intent"] .trace-stop-head'), 'copy:outcome.stoppedIntent;when=run:blockedAt');
    assert.equal(await src('#trace-body [data-span="intent"] .trace-stop-text'), 'run:reason');
    assert.equal(await src('#trace-body [data-span="record/record/0"] > .trace-step'), 'copy:trace.record;file=run:files/records/manifest.json#records[0].file');
    assert.equal(await src('#trace-body [data-span="record/record/0"] .verdict > span'), 'copy:state.written;when=run:files/records/manifest.json#records[0].file');

    // The line that closes the grid says the number of rows the grid shows.
    const rows = await page.evaluate(() => document.querySelectorAll('#trace-body [role="row"]').length);
    assert.equal(await text('#trace-count'), COPY['trace.rows'].replace('{count}', String(rows)));
    await page.click('#trace-body [data-span="grant"] .trace-toggle');
    assert.equal(await text('#trace-count'), COPY['trace.rows'].replace('{count}', String(rows - 4)), 'with a step closed the count is that of the rows still shown');

    // The offline check's row and a record inside it: the check opens the
    // Records tab, and T brings the trace back.
    await page.keyboard.press('o');
    await page.waitForFunction(() => document.body.dataset.tab === 'records');
    await page.keyboard.press('t');
    await page.waitForFunction(() => document.querySelector('#trace-body [data-span="offline-check"]') !== null);
    assert.equal(await src('#trace-body [data-span="offline-check"] .trace-title'), 'copy:trace.offlineRow');
    assert.equal(await src('#trace-body [data-span="offline-check"] > .trace-start'), 'run:offline-check#at|clock');
    assert.equal(await src('#trace-body [data-span="offline-check/records/0"] > .trace-step'), 'copy:trace.record;file=run:offline-check#records[0].file');
    assert.equal(await src('#trace-body [data-span="offline-check/records/0"] .verdict > span'), 'copy:offline.pass;when=run:offline-check#records[0].verdict');
    assert.equal(await src('#trace-body [data-span="offline-check/tampered/0"] .verdict > span'), 'copy:offline.reject;n=run:offline-check#tampered[0].firstFailingStep');

    // A replay: the banner names the run and the step it stands at, and a
    // row not yet shown is pending by the replay, not by the run.
    // (The focus is on a row of the grid here, where Right and Left are the
    // grid's own keys: the step controls drive the replay.)
    await page.keyboard.press('p');
    await page.click('#step-forward');
    assert.equal(await src('#outcome-end [data-outcome-part="replay"]'), 'copy:menu.replaying;runId=run:runId;n=view:replay');
    assert.equal(await src('#trace-body [data-span="pay"] .chip-word'), 'copy:state.pending;when=view:replay');
    assert.equal(await src('#trace-body [data-span="credential"] .chip-word'), 'copy:state.passed;when=run:steps[0].status');
    assert.equal(await src('#rows .row[data-step="pay"] .chip-word'), 'copy:state.pending;when=view:replay', 'the rows of the flow say the same');
    for (let i = 0; i < 5; i += 1) await page.click('#step-forward');
    assert.equal(await src('#outcome-end [data-outcome-part="replay"]'), 'copy:menu.replayDone');
    assert.deepEqual(view.errors, []);
  } finally {
    await view.close();
  }
});
