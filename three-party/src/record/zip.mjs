// A ZIP writer for Action Evidence Packages: every entry stored with no
// compression, one local file header per entry, the central directory, and
// the end record. No directory entry, no extra field, no comment, no data
// descriptor and no ZIP64, so the archive is the entries and nothing else.

import zlib from 'node:zlib';

// The largest entry this writer stores: 64 MiB. A larger one is refused.
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 10; // 1.0: a stored file
const MADE_BY = (3 << 8) | VERSION_NEEDED; // host 3 (UNIX), so the mode below is read
const REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;
const EPOCH = new Date(Date.UTC(1980, 0, 1));

// The MS-DOS date and time fields, read from the UTC parts of a date.
function dosFields(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('the archive date is not a date');
  const year = date.getUTCFullYear();
  if (year < 1980 || year > 2107) throw new RangeError(`the archive date ${date.toISOString()} is outside 1980 to 2107`);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function checkEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('an archive needs one entry or more');
  if (entries.length > 0xffff) throw new RangeError('too many entries for an archive without ZIP64');
  const seen = new Set();
  for (const entry of entries) {
    const { name, data } = entry ?? {};
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new TypeError(`entry name ${JSON.stringify(name)}: a plain file name is required, with no directory part`);
    }
    if (seen.has(name)) throw new TypeError(`entry name ${name} is given twice`);
    seen.add(name);
    if (!Buffer.isBuffer(data)) throw new TypeError(`entry ${name}: the data is not a Buffer`);
    if (data.length > MAX_ENTRY_BYTES) throw new RangeError(`entry ${name} is larger than ${MAX_ENTRY_BYTES} bytes`);
  }
}

// The bytes of an archive holding the entries ({ name, data }) in the order
// given. The same entries and date give the same bytes.
export function storeZip(entries, { date = EPOCH } = {}) {
  checkEntries(entries);
  const { time, day } = dosFields(date);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'ascii');
    const crc = zlib.crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(0, 8); // method 0: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(0, 8); // general purpose flags
    header.writeUInt16LE(0, 10); // method 0: stored
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra field length
    header.writeUInt16LE(0, 32); // comment length
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(REGULAR_FILE_0644, 38);
    header.writeUInt32LE(offset, 42); // where the local header starts

    parts.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length > 0xffffffff) throw new RangeError('the archive is too large without ZIP64');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...parts, directory, end]);
}
