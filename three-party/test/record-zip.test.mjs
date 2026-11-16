// The store-method ZIP writer, read back by /usr/bin/unzip, a tool that is
// not the writer under test.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { MAX_ENTRY_BYTES, storeZip } from '../src/record/zip.mjs';
import { listEntries, readEntry, removeTempDirs, tempDir, UNZIP } from './record-support.mjs';

after(removeTempDirs);

const HAS_UNZIP = fs.existsSync(UNZIP) ? {} : { skip: `needs ${UNZIP}` };
const ENTRIES = [
  { name: 'response.txt', data: Buffer.from('{"status":"ok"}\n') },
  { name: 'empty.bin', data: Buffer.alloc(0) },
  { name: 'random.bin', data: crypto.randomBytes(70000) },
  { name: 'zeros.bin', data: Buffer.alloc(4096) },
];

function saved(bytes) {
  const file = path.join(tempDir(), 'archive.zip');
  fs.writeFileSync(file, bytes);
  return file;
}

test('a store-method archive: unzip lists the entries in the order given, finds no error, and returns each entry byte for byte', HAS_UNZIP, () => {
  const file = saved(storeZip(ENTRIES, { date: new Date('2026-11-15T12:00:41Z') }));
  assert.deepEqual(listEntries(file), ENTRIES.map(({ name, data }) => ({ length: data.length, name })));
  const tested = spawnSync(UNZIP, ['-t', file], { encoding: 'utf8' });
  assert.equal(tested.status, 0, tested.stdout);
  assert.match(tested.stdout, /No errors detected/);
  for (const { name, data } of ENTRIES) assert.ok(readEntry(file, name).equals(data), name);
  // The date fields carry the UTC parts of the date given.
  const listing = execFileSync(UNZIP, ['-l', file], { encoding: 'utf8' });
  assert.equal(listing.split('\n').filter((line) => /11-15-2026 12:00/.test(line)).length, ENTRIES.length);
});

test('every entry is stored with no compression: method 0 and equal sizes in both headers, the CRC-32 of the data, no directory entry, no extra field, no comment', () => {
  const bytes = storeZip(ENTRIES);
  // The end record is the last 22 bytes when there is no comment.
  const end = bytes.subarray(bytes.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(8), ENTRIES.length);
  assert.equal(end.readUInt16LE(10), ENTRIES.length);
  assert.equal(end.readUInt16LE(20), 0, 'no archive comment');
  let at = end.readUInt32LE(16);
  assert.equal(at + end.readUInt32LE(12), bytes.length - 22, 'the central directory ends where the end record starts');
  for (const { name, data } of ENTRIES) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50, name);
    assert.equal(bytes.readUInt16LE(at + 8), 0, `${name}: no flag`);
    assert.equal(bytes.readUInt16LE(at + 10), 0, `${name}: stored`);
    assert.equal(bytes.readUInt32LE(at + 16), zlib.crc32(data) >>> 0, `${name}: CRC-32`);
    assert.equal(bytes.readUInt32LE(at + 20), data.length, `${name}: compressed size`);
    assert.equal(bytes.readUInt32LE(at + 24), data.length, `${name}: size`);
    assert.equal(bytes.readUInt16LE(at + 30), 0, `${name}: no extra field`);
    assert.equal(bytes.readUInt16LE(at + 32), 0, `${name}: no comment`);
    const nameLength = bytes.readUInt16LE(at + 28);
    assert.equal(bytes.subarray(at + 46, at + 46 + nameLength).toString('ascii'), name);
    assert.equal(name.endsWith('/'), false, 'no directory entry');
    // The local header says the same, and the data follows it unchanged.
    const local = bytes.readUInt32LE(at + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, name);
    assert.equal(bytes.readUInt16LE(local + 6), 0, `${name}: no flag, so no data descriptor`);
    assert.equal(bytes.readUInt16LE(local + 8), 0, `${name}: stored`);
    assert.equal(bytes.readUInt32LE(local + 14), zlib.crc32(data) >>> 0);
    assert.equal(bytes.readUInt32LE(local + 18), data.length);
    assert.equal(bytes.readUInt32LE(local + 22), data.length);
    assert.equal(bytes.readUInt16LE(local + 28), 0, `${name}: no extra field`);
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26);
    assert.ok(bytes.subarray(dataAt, dataAt + data.length).equals(data), `${name}: the data is the bytes given`);
    at += 46 + nameLength;
  }
  assert.equal(at, bytes.length - 22, 'the central directory holds these entries and no other');
});

test('the same entries and date give the same bytes, and another date changes the date fields alone', () => {
  const date = new Date('2026-11-15T12:00:41Z');
  const one = storeZip(ENTRIES, { date });
  assert.ok(one.equals(storeZip(ENTRIES.map((entry) => ({ ...entry })), { date: new Date(date.getTime()) })));
  const other = storeZip(ENTRIES, { date: new Date('2026-11-16T08:30:00Z') });
  assert.equal(other.length, one.length);
  const differing = [];
  for (let i = 0; i < one.length; i += 1) if (one[i] !== other[i]) differing.push(i);
  // Four date and time bytes in each local header and each central header.
  assert.ok(differing.length > 0 && differing.length <= ENTRIES.length * 8, String(differing.length));
});

test('the writer refuses a repeated name, a directory, a path, an empty name, data that is not a Buffer, an entry above the limit, an empty list and a date outside the ZIP range', () => {
  const data = Buffer.from('x');
  assert.throws(() => storeZip([{ name: 'a.txt', data }, { name: 'a.txt', data }]), /entry name a\.txt is given twice/);
  assert.throws(() => storeZip([{ name: 'dir/', data }]), /a plain file name is required/);
  assert.throws(() => storeZip([{ name: 'dir/a.txt', data }]), /a plain file name is required/);
  assert.throws(() => storeZip([{ name: '../a.txt', data }]), /a plain file name is required/);
  assert.throws(() => storeZip([{ name: '', data }]), /a plain file name is required/);
  assert.throws(() => storeZip([{ name: 'a.txt', data: 'x' }]), /the data is not a Buffer/);
  assert.throws(() => storeZip([{ name: 'a.txt', data: { length: 1 } }]), /the data is not a Buffer/);
  assert.equal(MAX_ENTRY_BYTES, 64 * 1024 * 1024, 'the limit is 64 MiB');
  assert.throws(() => storeZip([{ name: 'a.txt', data: Buffer.alloc(MAX_ENTRY_BYTES + 1) }]), /entry a\.txt is larger than 67108864 bytes/);
  assert.throws(() => storeZip([]), /an archive needs one entry or more/);
  assert.throws(() => storeZip([{ name: 'a.txt', data }], { date: new Date('1979-12-31T23:59:59Z') }), /outside 1980 to 2107/);
  assert.throws(() => storeZip([{ name: 'a.txt', data }], { date: new Date('not a date') }), /the archive date is not a date/);
});
