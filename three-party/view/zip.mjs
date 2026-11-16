// A reader for the zip container of a record package: the entry names come
// from the central directory, and one entry can be read in full. Stored
// entries (method 0) are read as they are; deflated entries (method 8) are
// inflated with the browser's DecompressionStream. Anything else (another
// method, a zip64 archive, an encrypted entry, a size above the cap) is
// reported as unreadable instead of being guessed at.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRY = 1024 * 1024;
const MAX_ENTRIES = 256;

const utf8 = new TextDecoder('utf-8');

function findEnd(view) {
  const floor = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === EOCD) return i;
  }
  return -1;
}

// The entries of a zip held in a Uint8Array, or null when the bytes are not
// a zip this reader handles.
export function listZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (count === 0xffff || start === 0xffffffff || count > MAX_ENTRIES || start + size > end) return null;
  const entries = [];
  let p = start;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL) return null;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const packed = view.getUint32(p + 20, true);
    const length = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const noteLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > view.byteLength) return null;
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, packed, length, offset, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + noteLen;
  }
  return entries;
}

// The bytes of one entry, or null when it cannot be read here.
export async function readEntry(bytes, entry) {
  if (!entry || entry.encrypted || entry.length > MAX_ENTRY || entry.packed > MAX_ENTRY) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > view.byteLength || view.getUint32(at, true) !== LOCAL) return null;
  const dataAt = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (dataAt + entry.packed > view.byteLength) return null;
  const packed = bytes.subarray(dataAt, dataAt + entry.packed);
  if (entry.method === 0) return packed.slice();
  if (entry.method !== 8 || typeof DecompressionStream !== 'function') return null;
  try {
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.byteLength === entry.length ? out : null;
  } catch {
    return null;
  }
}

export function entryText(buf) {
  return buf ? utf8.decode(buf) : null;
}
