// One label source. three-party/labels.json is the staged label map byte for
// byte, and it is the one place under three-party/ that holds a part label,
// a party role or a stand-in note, apart from the contract that documents
// them, the example files that carry them and the tests that expect them.
// No file holds a label of contract revision 1 as a quoted string.
//
// The strings looked for are read from the map itself. The revision 1
// labels are built from fragments, so this file does not hold them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LABELS, fill } from '../src/engine/labels.mjs';
import { partCell } from '../src/engine/text.mjs';
import { THREE_PARTY, LABEL_MAP_FILE, labelMap, partAndPartyStrings } from './support/label-map-check.mjs';

const REPO = path.resolve(THREE_PARTY, '..');
const j = (...parts) => parts.join('');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The label map, by the SHA-256 of the file as it stands here: a change of a
// label, a stand-in note or a party role is a deliberate edit of this line too.
const STAGED_LABEL_MAP = '2736306b70b777bba5aaf407ca667c39e18ad1cec5f25d4bd096fa8465982eb3';
const V1_LABELS = [j('Ou', 'rs'), j('Crossing (stand-in ', 'for AI2II)'), j('Record (our writer, ', 'his format)')];

// A file is text unless a NUL byte sits in its leading 8000 bytes, the rule
// git itself uses.
function isText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

// Every text file under three-party/ that git tracks or would track: the
// tracked files and the files not ignored, so a file is read before it is
// staged too. Run output (runs/, runs.pins/) is ignored and is not a file of
// the tree. Paths are relative to the repository, with forward slashes.
function treeFiles() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'three-party'], { encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean))].filter((f) => fs.existsSync(path.join(REPO, f)) && isText(path.join(REPO, f))).sort();
}

// The forms a string takes as a whole quoted string: in double quotes (the
// JSON form too), in single quotes with and without its apostrophes escaped,
// and in backticks.
function quotedForms(text) {
  return [...new Set([`"${text}"`, JSON.stringify(text), `'${text}'`, `'${text.replaceAll("'", "\\'")}'`, `\`${text}\``])];
}

// The lines of a text that hold a needle, as file:line.
function linesHolding(file, text, needle) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(needle)) found.push(`${file}:${i + 1}`);
  });
  return found;
}

const LABEL_SOURCE_EXEMPT = (f) => f === 'three-party/labels.json' || f === 'three-party/CONTRACT.md' || f.startsWith('three-party/examples/') || f.startsWith('three-party/test/');

test('three-party/labels.json is the label map byte for byte, and no example of an earlier revision is kept', () => {
  assert.equal(sha256(LABEL_MAP_FILE), STAGED_LABEL_MAP);
  assert.equal(fs.existsSync(path.join(THREE_PARTY, 'examples', 'v1')), false);
});

test('the label source is one: outside labels.json, CONTRACT.md, examples/ and test/, no file under three-party/ holds a part or party string of the map', () => {
  const map = labelMap();
  const strings = partAndPartyStrings(map);
  assert.equal(strings.length, 13, 'four part labels, one stand-in note, the fallback crossing\'s fetch note, five party strings beside the bank\'s label, two timestamp notes');
  for (const label of ['OpenA2A · ATX · AAP', 'WIMSE · AI2II', 'AEP', "Supplier's bank", 'Payments agent', 'Supplier', "Payments agent's domain", "Supplier's bank's domain", 'Test identifiers, used by nothing outside this demo.']) {
    assert.ok(strings.includes(label), label);
  }
  const files = treeFiles().filter((f) => !LABEL_SOURCE_EXEMPT(f));
  assert.ok(files.length >= 40, `${files.length} files read`);
  for (const must of ['three-party/README.md', 'three-party/src/engine/labels.mjs', 'three-party/src/engine/text.mjs', 'three-party/view/labels.json', 'three-party/view/copy.json', 'three-party/view/flow.mjs', 'three-party/bin/start.mjs']) {
    assert.ok(files.includes(must), `${must} is among the files read`);
  }

  // The two lines of the copy deck that give text mode's cell for a stand-in
  // part: the label with the stand-in mark after it. The deck is a byte for
  // byte copy of its staged block, and the test below holds these two lines
  // to the map. They are the one place a label stands inside a longer string.
  const deckFile = 'three-party/view/copy.json';
  const cells = Object.values(map.parts).filter((part) => part.standIn).map((part) => fill(LABELS.text.standInPart, { partLabel: part.label }));
  const deckLine = (line) => cells.some((cell) => line.trim().replace(/,$/, '').endsWith(`: ${JSON.stringify(cell)}`));

  const asQuoted = [];
  const insideLonger = [];
  let deckLines = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const s of strings) {
      // A whole quoted string equal to a string of the map, in any file.
      for (const form of quotedForms(s)) asQuoted.push(...linesHolding(f, text, form).map((at) => `${at} holds ${form}`));
      // A string of the map of two words or more, anywhere in a line. (The
      // two one-word strings are the name of the record format and a common
      // noun, which the tree's prose uses; as whole quoted strings they are
      // caught above.)
      if (!s.includes(' ')) continue;
      text.split('\n').forEach((line, i) => {
        if (!line.includes(s)) return;
        if (f === deckFile && deckLine(line)) { deckLines += 1; return; }
        insideLonger.push(`${f}:${i + 1} holds ${s}`);
      });
    }
  }
  assert.deepEqual(asQuoted, [], 'no whole quoted string equals a part or party string');
  assert.deepEqual(insideLonger, [], 'no line holds a part or party string of two words or more');
  assert.equal(deckLines, 1, 'the one deck line that holds a label of two words inside its stand-in cell');
});

test('the copy deck\'s text mode cell is what text mode prints for the stand-in part of the map', () => {
  const map = labelMap();
  const deck = JSON.parse(fs.readFileSync(path.join(THREE_PARTY, 'view', 'copy.json'), 'utf8'));
  const cellOf = (name) => partCell({ partLabel: map.parts[name].label, standIn: map.parts[name].standIn });
  assert.equal(cellOf('crossing'), deck['text.partCrossing']);
  assert.equal(Object.hasOwn(deck, 'text.partRecord'), false, 'the record is not a stand-in, so the deck holds no stand-in cell for it');
  // A part that is not a stand-in prints its label alone.
  assert.equal(cellOf('checkpoint'), map.parts.checkpoint.label);
  assert.equal(cellOf('bank'), map.parts.bank.label);
  assert.deepEqual(Object.entries(map.parts).filter(([, part]) => part.standIn).map(([name]) => name), ['crossing']);
});

test('no file under three-party/ holds a label of contract revision 1 as a quoted string', () => {
  const files = treeFiles();
  assert.ok(files.includes('three-party/CONTRACT.md') && files.includes('three-party/labels.json') && files.includes('three-party/test/engine-text.test.mjs'));
  const found = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const label of V1_LABELS) for (const form of quotedForms(label)) found.push(...linesHolding(f, text, form).map((at) => `${at} holds ${form}`));
  }
  assert.deepEqual(found, []);
});

test('the check finds what it looks for: a file that holds a label as a quoted string, or a label of two words in a line, is reported', () => {
  const map = labelMap();
  const planted = [
    `const title = '${map.parts.record.label}';`,
    `const role = "${map.parties.supplier}";`,
    `const bank = 'Supplier\\'s bank';`,
    `// the lane of the ${map.parts.crossing.label} part`,
    `const old = '${V1_LABELS[0]}';`,
    'const clean = \'the name of the record format\';',
  ].join('\n');
  const quoted = (s) => quotedForms(s).flatMap((form) => linesHolding('planted.mjs', planted, form));
  assert.deepEqual(quoted(map.parts.record.label), ['planted.mjs:1']);
  assert.deepEqual(quoted(map.parties.supplier), ['planted.mjs:2']);
  assert.deepEqual(quoted(map.parts.bank.label), ['planted.mjs:3']);
  assert.deepEqual(linesHolding('planted.mjs', planted, map.parts.crossing.label), ['planted.mjs:4']);
  assert.deepEqual(quoted(V1_LABELS[0]), ['planted.mjs:5']);
  assert.deepEqual(quoted(map.parts.checkpoint.label), []);
});
