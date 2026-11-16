// The AI2II capture check over synthetic captures made in the test (keys,
// token, signed request, response, journal, key sets and a libpcap file of
// the tests' own), the loader that compares the three files with their pins,
// and the fetch script with its network call replaced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AI2II_SOURCE, DEFAULT_AI2II_DIR, loadCapture, rawUrl } from '../src/engine/ai2ii-source.mjs';
import { CHECK_NAMES, checkCapture, parseDictionary, readPcap } from '../src/engine/capture.mjs';
import { LABELS } from '../src/engine/labels.mjs';
import { fetchAi2ii } from '../../scripts/three-party/fetch-ai2ii.mjs';
import { IAT, captureFiles, exchangePackets, sha256Hex, sourceFor, writeCapture, writePcap } from './support/capture-fixture.mjs';

const answers = (result) => Object.fromEntries(result.checks.map((c) => [c.name, c.answer]));
const allPass = Object.fromEntries(CHECK_NAMES.map((name) => [name, 'pass']));
const run = (made) => checkCapture(made.bytes, { source: sourceFor(made.bytes), files: [] });
const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'three-party-ai2ii-')));

test('the pins are the published files at the full commit, fetched from the raw host at that commit, into three-party/external/ai2ii', () => {
  assert.equal(AI2II_SOURCE.repo, 'https://github.com/apelov/IETF127-Hackathon-AI2II-WIMSE');
  assert.equal(AI2II_SOURCE.commit, '32f584a2016d7ebd0d2f5156148cc404c496a086');
  assert.deepEqual(AI2II_SOURCE.files, {
    capture: { name: 'capture_scenario1.pcap', size: 2234, sha256: '5137fd90c2236088d563eb3d89ed89a65858f07249415c3ed8a38d90edbac3a5' },
    journal: { name: 'decision-journal.jsonl', size: 316, sha256: '688cb4e4782e46f86f444c08c4d38d71c3f4b8f0f3f9429c306afd9445643a63' },
    keys: { name: 'jwks.json', size: 851, sha256: 'aea167c07199cbea380782d23e3e775daf65dc96ce0474671a9e75ee27e92aaf' },
  });
  assert.equal(rawUrl(AI2II_SOURCE, 'jwks.json'), 'https://raw.githubusercontent.com/apelov/IETF127-Hackathon-AI2II-WIMSE/32f584a2016d7ebd0d2f5156148cc404c496a086/handover/wimse_ai2ii/jwks.json');
  assert.equal(path.relative(path.resolve(import.meta.dirname, '..'), DEFAULT_AI2II_DIR), path.join('external', 'ai2ii'));
  const ignore = fs.readFileSync(path.resolve(import.meta.dirname, '..', '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('external/ai2ii/'), 'the folder is ignored by git');
});

test('a synthetic capture passes all seven checks; the result names the files, the source, the token by claims and SHA-256, and holds no token, signature or Txn-Token value', () => {
  const made = captureFiles();
  const source = sourceFor(made.bytes);
  const files = [{ name: 'capture_scenario1.pcap', size: made.bytes.capture.length, sha256: sha256Hex(made.bytes.capture) }];
  const result = checkCapture(made.bytes, { source, files });
  assert.deepEqual(result.checks.map((c) => c.name), CHECK_NAMES);
  assert.deepEqual(answers(result), allPass, JSON.stringify(result.checks.filter((c) => c.answer !== 'pass')));
  assert.equal(result.outcome, 'verified');
  assert.deepEqual([result.passed, result.total], [7, 7]);
  for (const c of result.checks) {
    assert.equal(c.claim, LABELS.capture.claims[c.name], c.name);
    assert.equal(c.reason, null, c.name);
  }
  assert.deepEqual(result.files, files);
  assert.deepEqual(result.source, { repo: source.repo, branch: source.branch, commit: source.commit, folder: source.folder });
  assert.deepEqual(result.token, { sha256: sha256Hex(Buffer.from(made.wit)), header: made.header, claims: made.claims });
  assert.deepEqual(result.exchange, { from: 'issuer.test', to: 'receiver.test', loopback: true, invoice: 'INV-9001', amount: 1234, currency: 'USD' });
  assert.deepEqual(result.txnToken, { carried: true, checked: false, sha256: sha256Hex(Buffer.from(made.txnToken)) });
  const facts = Object.fromEntries(result.checks.map((c) => [c.name, c.facts]));
  assert.equal(facts.capture.client, '127.0.0.1:54321');
  assert.equal(facts.capture.server, '127.0.0.1:5070');
  assert.deepEqual(facts.signatureCreated, { created: new Date((IAT + 5) * 1000).toISOString().replace('.000', ''), iat: new Date(IAT * 1000).toISOString().replace('.000', ''), exp: new Date((IAT + 3600) * 1000).toISOString().replace('.000', '') });
  assert.deepEqual(facts.httpSignature.covered, ['@method', '@path', '@query', 'content-type', 'content-digest', 'txn-token', 'workload-identity-token']);
  assert.equal(facts.httpSignature.sha256, sha256Hex(made.signature));
  const text = JSON.stringify(result);
  for (const secret of [made.wit, made.witSignature, made.signature.toString('base64'), made.signature.toString('hex'), made.txnToken]) {
    assert.equal(text.includes(secret), false, `the result holds ${secret.slice(0, 12)}...`);
  }
  assert.equal(result.summary, 'AI2II capture of a separate exchange, commit 01234567: 7 of 7 checks passed');
  assert.match(result.scope[0], /^A capture published by AI2II in https:\/\/github\.com\/test-owner\/test-capture at commit 01234567, of a separate loopback exchange \(issuer\.test to receiver\.test, invoice INV-9001, 1234 USD\), not a crossing minted for this payment\.$/);
  assert.deepEqual(result.scope.slice(1), [
    'The keys are trusted because jwks.json is pinned by its SHA-256.',
    "The token's times are checked against the capture's own times, not today's clock.",
    "The Txn-Token header's value is compared with the bank's answer; it is not validated as a token.",
  ]);
});

test('both byte orders, both link types and nanosecond stamps read alike; segments out of order, sent twice and across the 2^32 wrap reassemble by sequence number', () => {
  for (const file of [{ little: true, linkType: 0 }, { little: false, linkType: 0 }, { little: true, linkType: 1 }, { little: false, linkType: 1, nano: true }]) {
    const made = captureFiles({}, { file, packets: { split: 4, order: 'reverse', retransmit: true } });
    const result = run(made);
    assert.deepEqual(answers(result), allPass, `${JSON.stringify(file)}: ${JSON.stringify(result.checks.find((c) => c.answer !== 'pass'))}`);
    const pcap = readPcap(made.bytes.capture);
    assert.equal(pcap.byteOrder, file.little ? 'little-endian' : 'big-endian');
    assert.equal(pcap.link, file.linkType === 0 ? 'NULL' : 'Ethernet');
    assert.equal(pcap.resolution, file.nano ? 'nanoseconds' : 'microseconds');
  }
});

// Each case changes one thing and fails exactly one check.
const ONE_FAILS = [
  ['a body changed after it was digested and signed', { tamperBody: true }, 'contentDigest', /differs from the SHA-256 of the request body/],
  ['a key set that lists another key under the token kid', { wrongKey: true }, 'witSignature', /does not verify under key test-issuer-1 of the issuer\.test key set/],
  ['a signed Content-Digest of other bytes', { digestOver: Buffer.from('other bytes') }, 'contentDigest', /differs from the SHA-256/],
  ['a covered header changed after signing', { headerAfter: ['content-type', 'application/json; charset=utf-8'] }, 'httpSignature', /does not verify under the key in the token's cnf\.jwk/],
  ['created before iat', { created: IAT - 60 }, 'signatureCreated', /lies outside iat/],
  ['created after exp', { created: IAT + 3601 }, 'signatureCreated', /lies outside iat/],
  ['a journal line that disagrees with the response', { journal: { amount: 4321 } }, 'journal', /differs from the response in amount/],
  ['a journal line with another peer', { journal: { peer_id: 'wimse://issuer.test/agent/other' } }, 'journal', /differs from the response in peer_id/],
  ['a response whose payer is not the token sub', { response: { payer: 'wimse://issuer.test/agent/other' } }, 'response', /payer is not the token's sub/],
  ['a response that is not paid', { response: { status: 'refused' } }, 'response', /status is not paid/],
];

for (const [name, options, failing, reason] of ONE_FAILS) {
  test(`one check fails, the others pass: ${name}`, () => {
    const result = run(captureFiles(options));
    assert.deepEqual(answers(result), { ...allPass, [failing]: 'fail' });
    const check = result.checks.find((c) => c.name === failing);
    assert.match(check.reason, reason);
    assert.equal(result.outcome, 'not-verified');
    assert.equal(result.passed, 6);
    assert.equal(result.summary, `AI2II capture of a separate exchange, commit 01234567: 6 of 7 checks passed; not passed: ${failing}`);
  });
}

test('a capture that cannot be read fails the capture check with its reason, and the six checks after it do not run', () => {
  const made = captureFiles();
  const packets = exchangePackets(made);
  const cases = [
    ['link type 113', writePcap(packets, { linkType: 113 }), /^link type 113 is not read; NULL \(0\) and Ethernet \(1\) are$/],
    ['pcapng', Buffer.concat([Buffer.from([0x0a, 0x0d, 0x0d, 0x0a]), made.bytes.capture.subarray(4)]), /pcapng/],
    ['another magic number', Buffer.concat([Buffer.from('ABCD'), made.bytes.capture.subarray(4)]), /is not classic libpcap/],
    ['a record cut off', made.bytes.capture.subarray(0, made.bytes.capture.length - 7), new RegExp(`^record ${packets.length} is cut off`)],
    ['a gap in the request', writePcap(exchangePackets(made, { split: 3, drop: true })), /the client to server stream has a gap at byte/],
    ['no file at all', Buffer.alloc(10), /shorter than a libpcap file header/],
  ];
  for (const [label, capture, reason] of cases) {
    const result = checkCapture({ ...made.bytes, capture }, { source: sourceFor(made.bytes) });
    assert.equal(result.checks[0].answer, 'fail', label);
    assert.match(result.checks[0].reason, reason, label);
    for (const c of result.checks.slice(1)) {
      assert.equal(c.answer, 'not-run', `${label}: ${c.name}`);
      assert.equal(c.reason, LABELS.capture.notRun.capture);
    }
    assert.equal(result.outcome, 'not-verified');
    assert.equal(result.token, null);
  }
  // Two segments that claim the same bytes with different contents are refused.
  const twice = exchangePackets(made, { split: 2, retransmit: true });
  const copy = twice.findIndex((p, i) => i > 0 && p.segment.equals(twice[i - 1].segment));
  twice[copy] = { ...twice[copy], segment: Buffer.from(twice[copy].segment) };
  twice[copy].segment[twice[copy].segment.length - 1] ^= 0x01;
  const differing = checkCapture({ ...made.bytes, capture: writePcap(twice) }, { source: sourceFor(made.bytes) });
  assert.match(differing.checks[0].reason, /differ from those of an earlier segment/);
});

test('the structured field dictionaries of Signature-Input, Signature and Content-Digest parse as RFC 8941 sets them out', () => {
  const input = parseDictionary('wimse=("@method" "@path");created=1794766947;nonce="a\\"b";tag=tok, other=?1');
  assert.deepEqual(input.get('wimse').list.map((i) => i.value), ['@method', '@path']);
  assert.equal(input.get('wimse').params.get('created'), 1794766947);
  assert.equal(input.get('wimse').params.get('nonce'), 'a"b');
  assert.equal(input.get('wimse').params.get('tag').name, 'tok');
  assert.equal(input.get('other').value, true);
  assert.deepEqual(parseDictionary('sha-256=:AQID:').get('sha-256').value, Buffer.from([1, 2, 3]));
  for (const bad of ['wimse=("@method"', 'sha-256=:not base64!:', 'a=1,', 'Upper=1']) assert.throws(() => parseDictionary(bad), SyntaxError, bad);
});

test('the loader uses the three files only when each is there with its pinned size and SHA-256, and says which are missing or differ', () => {
  const made = captureFiles();
  const source = sourceFor(made.bytes);
  const dir = tempDir();
  try {
    const absent = loadCapture({ dir: path.join(dir, 'nothing-here'), source });
    assert.deepEqual({ use: absent.use, why: absent.why, missing: absent.missing }, { use: false, why: 'absent', missing: ['capture_scenario1.pcap', 'decision-journal.jsonl', 'jwks.json'] });
    writeCapture(dir, made.bytes, source);
    const pinned = loadCapture({ dir, source });
    assert.equal(pinned.use, true);
    assert.ok(pinned.bytes.capture.equals(made.bytes.capture) && pinned.bytes.journal.equals(made.bytes.journal) && pinned.bytes.keys.equals(made.bytes.keys));
    assert.deepEqual(pinned.files.map((f) => [f.name, f.size, f.sha256]), [['capture_scenario1.pcap', made.bytes.capture.length, sha256Hex(made.bytes.capture)], ['decision-journal.jsonl', made.bytes.journal.length, sha256Hex(made.bytes.journal)], ['jwks.json', made.bytes.keys.length, sha256Hex(made.bytes.keys)]]);
    // One file changed: not used, and named with both digests.
    const changed = Buffer.from(made.bytes.keys);
    changed[changed.length - 2] ^= 0x01;
    fs.writeFileSync(path.join(dir, 'jwks.json'), changed);
    const mismatch = loadCapture({ dir, source });
    assert.deepEqual({ use: mismatch.use, why: mismatch.why, differing: mismatch.differing }, { use: false, why: 'mismatch', differing: ['jwks.json'] });
    const row = mismatch.files.find((f) => f.name === 'jwks.json');
    assert.deepEqual([row.sha256, row.pinnedSha256], [sha256Hex(changed), sha256Hex(made.bytes.keys)]);
    // One file gone: absent, whatever the others hold.
    fs.rmSync(path.join(dir, 'decision-journal.jsonl'));
    assert.deepEqual(loadCapture({ dir, source }).missing, ['decision-journal.jsonl']);
    // The published pins against these synthetic bytes: not the published files.
    writeCapture(dir, made.bytes, source);
    assert.equal(loadCapture({ dir }).why, 'mismatch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the fetch script asks the raw host at the pinned commit for each file, keeps a file only when it matches its pin, deletes it otherwise and exits 1 naming the file and both digests, and fetches nothing a second time', async () => {
  const made = captureFiles();
  const source = sourceFor(made.bytes);
  const served = { [source.files.capture.name]: made.bytes.capture, [source.files.journal.name]: made.bytes.journal, [source.files.keys.name]: made.bytes.keys };
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return served[decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))];
  };
  const dir = path.join(tempDir(), 'ai2ii');
  const lines = { out: [], err: [] };
  const io = { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) };
  try {
    assert.equal(await fetchAi2ii({ dir, source, get, ...io }), 0);
    assert.deepEqual(asked, ['capture_scenario1.pcap', 'decision-journal.jsonl', 'jwks.json'].map((name) => `https://raw.githubusercontent.com/test-owner/test-capture/${source.commit}/handover/test/${name}`));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['capture_scenario1.pcap', 'decision-journal.jsonl', 'jwks.json'], 'no temporary file is left');
    assert.equal(loadCapture({ dir, source }).use, true);
    assert.match(lines.out[0], /^fetched capture_scenario1\.pcap: \d+ bytes, sha256 [0-9a-f]{64}, from https:\/\/raw\.githubusercontent\.com\//);
    assert.deepEqual(lines.err, []);
    // A second run keeps all three and asks for nothing.
    asked.length = 0;
    lines.out.length = 0;
    assert.equal(await fetchAi2ii({ dir, source, get, ...io }), 0);
    assert.deepEqual(asked, []);
    assert.deepEqual(lines.out.slice(0, 3).map((l) => l.split(':')[0]), ['kept capture_scenario1.pcap', 'kept decision-journal.jsonl', 'kept jwks.json']);
    // A served file that is not the pinned one is deleted and named with both digests.
    fs.rmSync(path.join(dir, 'jwks.json'));
    served['jwks.json'] = Buffer.from('{"not":"the pinned key sets"}\n');
    assert.equal(await fetchAi2ii({ dir, source, get, ...io }), 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['capture_scenario1.pcap', 'decision-journal.jsonl']);
    const refused = lines.err.find((l) => l.startsWith('refused jwks.json'));
    assert.ok(refused, lines.err.join('\n'));
    assert.ok(refused.includes(sha256Hex(served['jwks.json'])) && refused.includes(source.files.keys.sha256), refused);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
