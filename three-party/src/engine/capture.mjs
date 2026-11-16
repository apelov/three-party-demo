// The AI2II capture check. It reads one recorded WIMSE workload-to-workload
// request and its response from a classic libpcap file, with the decision
// journal line and the key sets published beside it, and checks what the
// capture itself can show. Each check has a name and answers pass, fail, or
// not-run when the input it needs could not be read.
//
// The result names the three files by SHA-256 and the Workload-Identity-Token
// by its header, its claims and the SHA-256 of its compact form. It never
// holds the token itself, the HTTP message signature or the Txn-Token value.
// Nothing here reads a clock or the network: the token's times are compared
// with the capture's own times.

import crypto from 'node:crypto';
import { LABELS, fill } from './labels.mjs';

export const CHECK_NAMES = Object.freeze(['capture', 'witSignature', 'contentDigest', 'httpSignature', 'signatureCreated', 'response', 'journal']);

class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const reasonOf = (err) => String(err?.message ?? err);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
const sha256Hex = (bytes) => sha256(bytes).toString('hex');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function json(bytes, what) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  } catch {
    return refuse(`${what} is not JSON`);
  }
}

// RFC 3339 UTC for a count of seconds since 1970.
function utc(seconds) {
  const iso = new Date(seconds * 1000).toISOString();
  return Number.isInteger(seconds) ? `${iso.slice(0, 19)}Z` : iso;
}

// ---- libpcap: the classic format, either byte order, micro or nanosecond stamps

export const LINK_TYPES = Object.freeze({ 0: 'NULL', 1: 'Ethernet' });

const MAGIC = new Map([
  [0xa1b2c3d4, { little: false, nano: false }],
  [0xd4c3b2a1, { little: true, nano: false }],
  [0xa1b23c4d, { little: false, nano: true }],
  [0x4d3cb2a1, { little: true, nano: true }],
]);

export function readPcap(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) refuse('the file is shorter than a libpcap file header (24 bytes)');
  const magic = bytes.readUInt32BE(0);
  if (magic === 0x0a0d0d0a) refuse('the file is pcapng; this check reads classic libpcap');
  const form = MAGIC.get(magic);
  if (!form) refuse(`magic number ${magic.toString(16).padStart(8, '0')} is not classic libpcap`);
  const u16 = (o) => (form.little ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o) => (form.little ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  if (u16(4) !== 2) refuse(`libpcap version ${u16(4)}.${u16(6)} is not read; version 2 is`);
  // The low 16 bits are the link type; the bits above carry the FCS length.
  const linkType = u32(20) & 0xffff;
  if (!Object.hasOwn(LINK_TYPES, linkType)) refuse(`link type ${linkType} is not read; NULL (0) and Ethernet (1) are`);
  const packets = [];
  for (let at = 24; at < bytes.length;) {
    const n = packets.length + 1;
    if (at + 16 > bytes.length) refuse(`record ${n} is cut off: ${bytes.length - at} bytes stand where its 16-byte header should be`);
    const sec = u32(at);
    const frac = u32(at + 4);
    const incl = u32(at + 8);
    const orig = u32(at + 12);
    if (at + 16 + incl > bytes.length) refuse(`record ${n} is cut off: it names ${incl} bytes and ${bytes.length - at - 16} follow`);
    if (incl < orig) refuse(`packet ${n} was captured short: ${incl} of its ${orig} bytes`);
    if (incl > orig) refuse(`packet ${n} names ${incl} captured bytes of ${orig} sent`);
    if (frac >= (form.nano ? 1e9 : 1e6)) refuse(`packet ${n} has a time fraction out of range`);
    const whole = new Date(sec * 1000).toISOString().slice(0, 19);
    packets.push({ n, at: `${whole}.${String(frac).padStart(form.nano ? 9 : 6, '0')}Z`, data: bytes.subarray(at + 16, at + 16 + incl) });
    at += 16 + incl;
  }
  return { little: form.little, byteOrder: form.little ? 'little-endian' : 'big-endian', resolution: form.nano ? 'nanoseconds' : 'microseconds', linkType, link: LINK_TYPES[linkType], packets };
}

// ---- Link layer, IP and TCP

// The address families a BSD loopback header names: IPv4, and IPv6 as Linux,
// NetBSD and OpenBSD, FreeBSD and macOS number it.
const NULL_FAMILIES = new Map([[2, 4], [10, 6], [24, 6], [28, 6], [30, 6]]);

// The IP packet a captured frame carries, or null for a frame that carries
// no IP packet (an ARP frame, say).
function ipOf(packet, pcap) {
  const d = packet.data;
  if (pcap.linkType === 0) {
    if (d.length < 4) refuse(`packet ${packet.n} is shorter than its loopback header`);
    // The family is written in the byte order of the host that captured it,
    // which is the file's own order as a rule; the other order is tried too.
    const version = NULL_FAMILIES.get(pcap.little ? d.readUInt32LE(0) : d.readUInt32BE(0))
      ?? NULL_FAMILIES.get(pcap.little ? d.readUInt32BE(0) : d.readUInt32LE(0)) ?? null;
    return version ? { version, bytes: d.subarray(4) } : null;
  }
  if (d.length < 14) refuse(`packet ${packet.n} is shorter than an Ethernet header`);
  let type = d.readUInt16BE(12);
  let offset = 14;
  if (type === 0x8100) {
    if (d.length < 18) refuse(`packet ${packet.n} is shorter than its VLAN tag`);
    type = d.readUInt16BE(16);
    offset = 18;
  }
  if (type === 0x0800) return { version: 4, bytes: d.subarray(offset) };
  if (type === 0x86dd) return { version: 6, bytes: d.subarray(offset) };
  return null;
}

function ipv6Text(b) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  let best = { at: -1, length: 0 };
  let run = { at: -1, length: 0 };
  groups.forEach((g, i) => {
    if (g !== '0') { run = { at: -1, length: 0 }; return; }
    run = run.at < 0 ? { at: i, length: 1 } : { at: run.at, length: run.length + 1 };
    if (run.length > best.length) best = { ...run };
  });
  if (best.length < 2) return groups.join(':');
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.length).join(':')}`;
}

// The TCP segment an IP packet carries, or null for a packet of another protocol.
function tcpOf(packet, ip) {
  const b = ip.bytes;
  let src;
  let dst;
  let segment;
  if (ip.version === 4) {
    if (b.length < 20 || b[0] >> 4 !== 4) refuse(`packet ${packet.n} does not hold an IPv4 header`);
    const ihl = (b[0] & 0x0f) * 4;
    const total = b.readUInt16BE(2);
    if (ihl < 20 || total < ihl || total > b.length) refuse(`packet ${packet.n}: its IPv4 lengths do not fit it (header ${ihl}, total ${total}, captured ${b.length})`);
    const fragment = b.readUInt16BE(6);
    if ((fragment & 0x2000) !== 0 || (fragment & 0x1fff) !== 0) refuse(`packet ${packet.n} is an IPv4 fragment; fragments are not reassembled`);
    if (b[9] !== 6) return null;
    src = [...b.subarray(12, 16)].join('.');
    dst = [...b.subarray(16, 20)].join('.');
    segment = b.subarray(ihl, total);
  } else {
    if (b.length < 40 || b[0] >> 4 !== 6) refuse(`packet ${packet.n} does not hold an IPv6 header`);
    const length = b.readUInt16BE(4);
    const next = b[6];
    if (40 + length > b.length) refuse(`packet ${packet.n}: its IPv6 payload length ${length} does not fit it`);
    if ([0, 43, 44, 50, 51, 60].includes(next)) refuse(`packet ${packet.n} carries IPv6 extension headers, which are not read`);
    if (next !== 6) return null;
    src = ipv6Text(b.subarray(8, 24));
    dst = ipv6Text(b.subarray(24, 40));
    segment = b.subarray(40, 40 + length);
  }
  if (segment.length < 20) refuse(`packet ${packet.n}: its TCP header is cut off`);
  const offset = (segment[12] >> 4) * 4;
  if (offset < 20 || offset > segment.length) refuse(`packet ${packet.n}: its TCP data offset ${offset} does not fit the segment`);
  const flags = segment[13];
  return {
    n: packet.n,
    at: packet.at,
    src: { ip: src, port: segment.readUInt16BE(0) },
    dst: { ip: dst, port: segment.readUInt16BE(2) },
    seq: segment.readUInt32BE(4),
    syn: (flags & 0x02) !== 0,
    fin: (flags & 0x01) !== 0,
    ack: (flags & 0x10) !== 0,
    payload: segment.subarray(offset),
  };
}

const endpoint = (e) => (e.ip.includes(':') ? `[${e.ip}]:${e.port}` : `${e.ip}:${e.port}`);
const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip);

// The bytes one side sent, in sequence order from the byte after its SYN.
// A segment sent again must carry the same bytes; a byte no segment carries
// is a gap, and so is data after the FIN.
function stream(segments, opener, direction) {
  const start = (opener.seq + 1) >>> 0;
  const pieces = [];
  let finAt = null;
  for (const s of segments) {
    if (s.syn) {
      if (s.seq !== opener.seq) refuse(`packet ${s.n}: the ${direction} side opens the connection a second time`);
      if (s.payload.length) refuse(`packet ${s.n}: a SYN that carries data is not read`);
      continue;
    }
    // The signed distance in sequence space, so the count wraps at 2^32.
    let offset = (s.seq - start) | 0;
    let data = s.payload;
    if (offset < 0) {
      data = data.subarray(Math.min(data.length, -offset));
      offset = 0;
    }
    if (s.fin) {
      const end = offset + data.length;
      if (finAt !== null && finAt !== end) refuse(`packet ${s.n}: the ${direction} side ends its stream at two places`);
      finAt = end;
    }
    if (data.length) pieces.push({ n: s.n, offset, data });
  }
  const length = pieces.reduce((max, p) => Math.max(max, p.offset + p.data.length), 0);
  if (finAt !== null && finAt < length) refuse(`the ${direction} stream carries data after its FIN`);
  const end = finAt ?? length;
  const out = Buffer.alloc(end);
  const filled = new Uint8Array(end);
  for (const p of pieces.sort((a, b) => a.offset - b.offset || a.n - b.n)) {
    for (let i = 0; i < p.data.length; i += 1) {
      const at = p.offset + i;
      if (!filled[at]) {
        out[at] = p.data[i];
        filled[at] = 1;
      } else if (out[at] !== p.data[i]) {
        refuse(`packet ${p.n}: its bytes at offset ${at} of the ${direction} stream differ from those of an earlier segment`);
      }
    }
  }
  const gap = filled.indexOf(0);
  if (gap >= 0) refuse(`the ${direction} stream has a gap at byte ${gap}`);
  return out;
}

// The one TCP connection of a capture, each direction reassembled.
export function readConnection(pcap) {
  const segments = [];
  let ignored = 0;
  for (const packet of pcap.packets) {
    const ip = ipOf(packet, pcap);
    const segment = ip ? tcpOf(packet, ip) : null;
    if (segment) segments.push(segment);
    else ignored += 1;
  }
  const pairs = new Set(segments.map((s) => [endpoint(s.src), endpoint(s.dst)].sort().join(' ')));
  if (pairs.size === 0) refuse('the capture holds no TCP segment');
  if (pairs.size > 1) refuse(`the capture holds ${pairs.size} TCP connections; this check reads one`);
  const opener = segments.find((s) => s.syn && !s.ack);
  if (!opener) refuse('the SYN that opens the connection is not in the capture');
  const client = endpoint(opener.src);
  const server = endpoint(opener.dst);
  const answer = segments.find((s) => s.syn && s.ack && endpoint(s.src) === server);
  if (!answer) refuse("the server's SYN-ACK is not in the capture");
  return {
    client,
    server,
    loopback: isLoopback(opener.src.ip) && isLoopback(opener.dst.ip),
    segments: segments.length,
    ignored,
    firstAt: segments[0].at,
    lastAt: segments.at(-1).at,
    up: stream(segments.filter((s) => endpoint(s.src) === client), opener, 'client to server'),
    down: stream(segments.filter((s) => endpoint(s.src) === server), answer, 'server to client'),
  };
}

// ---- HTTP/1.1

function splitHead(bytes, what) {
  const end = bytes.indexOf('\r\n\r\n');
  if (end < 0) refuse(`the ${what} has no complete head`);
  const lines = bytes.subarray(0, end).toString('latin1').split('\r\n');
  const headers = [];
  for (const line of lines.slice(1)) {
    if (/^[ \t]/.test(line)) refuse(`the ${what} folds a header line; folded lines are not read`);
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):(.*)$/.exec(line);
    if (!m) refuse(`the ${what} has a header line that is not a name and a value`);
    headers.push([m[1].toLowerCase(), m[2].replace(/^[ \t]+|[ \t]+$/g, '')]);
  }
  return { start: lines[0], headers, rest: bytes.subarray(end + 4) };
}

// A field's value as RFC 9110 combines repeated lines, or null when absent.
function fieldOf(headers, name) {
  const values = headers.filter(([n]) => n === name).map(([, v]) => v);
  return values.length ? values.join(', ') : null;
}

function bodyOf(headers, rest, what, toEnd) {
  if (fieldOf(headers, 'transfer-encoding') !== null) refuse(`the ${what} uses Transfer-Encoding, which is not read`);
  const lengths = headers.filter(([n]) => n === 'content-length').map(([, v]) => v);
  if (new Set(lengths).size > 1) refuse(`the ${what} carries two Content-Length values`);
  if (lengths.length) {
    if (!/^[0-9]+$/.test(lengths[0])) refuse(`the ${what} carries a Content-Length that is not a number`);
    const n = Number(lengths[0]);
    if (rest.length < n) refuse(`the ${what} body is ${rest.length} bytes where Content-Length says ${n}`);
    if (rest.length > n) refuse(`the ${what} is followed by ${rest.length - n} more bytes; one message is read`);
    return rest.subarray(0, n);
  }
  if (!toEnd && rest.length) refuse(`the ${what} carries a body with no Content-Length`);
  return rest;
}

export function readExchange(up, down) {
  const req = splitHead(up, 'request');
  const line = /^([A-Z]+) (\/\S*) HTTP\/1\.1$/.exec(req.start);
  if (!line) refuse('the request line is not a method, an origin-form target and HTTP/1.1');
  const target = line[2];
  const q = target.indexOf('?');
  const request = {
    method: line[1],
    target,
    path: q < 0 ? target : target.slice(0, q),
    query: q < 0 ? null : target.slice(q + 1),
    headers: req.headers,
    body: bodyOf(req.headers, req.rest, 'request', false),
  };
  const res = splitHead(down, 'response');
  const status = /^HTTP\/1\.1 ([0-9]{3})(?: (.*))?$/.exec(res.start);
  if (!status) refuse('the status line is not HTTP/1.1 and a status code');
  return { request, response: { status: Number(status[1]), headers: res.headers, body: bodyOf(res.headers, res.rest, 'response', true) } };
}

// ---- Structured Field Values (RFC 8941): dictionaries, inner lists, items

export class Token {
  constructor(name) { this.name = name; }
}

const KEY = /[a-z*][a-z0-9_\-.*]*/y;
const TOKEN = /[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/y;
const NUMBER = /-?[0-9]{1,15}(?:\.[0-9]{1,3})?/y;

function take(p, pattern, what) {
  pattern.lastIndex = p.i;
  const m = pattern.exec(p.s);
  if (!m) throw new SyntaxError(`${what} expected at ${p.i}`);
  p.i += m[0].length;
  return m[0];
}

function bareItem(p) {
  const c = p.s[p.i];
  if (c === '"') {
    let out = '';
    for (p.i += 1; p.i < p.s.length; p.i += 1) {
      const ch = p.s[p.i];
      if (ch === '\\') {
        const next = p.s[p.i + 1];
        if (next !== '"' && next !== '\\') throw new SyntaxError(`a bad escape at ${p.i}`);
        out += next;
        p.i += 1;
      } else if (ch === '"') {
        p.i += 1;
        return out;
      } else if (ch < ' ' || ch > '~') {
        throw new SyntaxError(`a character a string cannot hold at ${p.i}`);
      } else {
        out += ch;
      }
    }
    throw new SyntaxError('a string with no end');
  }
  if (c === ':') {
    const end = p.s.indexOf(':', p.i + 1);
    if (end < 0) throw new SyntaxError('a byte sequence with no end');
    const text = p.s.slice(p.i + 1, end);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new SyntaxError('a byte sequence that is not base64');
    p.i = end + 1;
    return Buffer.from(text, 'base64');
  }
  if (c === '?') {
    const v = p.s[p.i + 1];
    if (v !== '0' && v !== '1') throw new SyntaxError(`a bad boolean at ${p.i}`);
    p.i += 2;
    return v === '1';
  }
  if (c === '-' || (c >= '0' && c <= '9')) return Number(take(p, NUMBER, 'a number'));
  return new Token(take(p, TOKEN, 'an item'));
}

function parameters(p) {
  const out = new Map();
  while (p.s[p.i] === ';') {
    p.i += 1;
    while (p.s[p.i] === ' ') p.i += 1;
    const key = take(p, KEY, 'a parameter name');
    let value = true;
    if (p.s[p.i] === '=') {
      p.i += 1;
      value = bareItem(p);
    }
    out.set(key, value);
  }
  return out;
}

function itemOrInnerList(p) {
  if (p.s[p.i] !== '(') return { value: bareItem(p), params: parameters(p) };
  p.i += 1;
  const list = [];
  for (;;) {
    while (p.s[p.i] === ' ') p.i += 1;
    if (p.s[p.i] === ')') {
      p.i += 1;
      return { list, params: parameters(p) };
    }
    list.push({ value: bareItem(p), params: parameters(p) });
    if (p.s[p.i] !== ' ' && p.s[p.i] !== ')') throw new SyntaxError(`an inner list breaks off at ${p.i}`);
  }
}

export function parseDictionary(text) {
  const p = { s: String(text), i: 0 };
  const out = new Map();
  while (p.s[p.i] === ' ') p.i += 1;
  if (p.i >= p.s.length) return out;
  for (;;) {
    const key = take(p, KEY, 'a dictionary key');
    if (p.s[p.i] === '=') {
      p.i += 1;
      out.set(key, itemOrInnerList(p));
    } else {
      out.set(key, { value: true, params: parameters(p) });
    }
    while (p.s[p.i] === ' ' || p.s[p.i] === '\t') p.i += 1;
    if (p.i >= p.s.length) return out;
    if (p.s[p.i] !== ',') throw new SyntaxError(`a comma expected at ${p.i}`);
    p.i += 1;
    while (p.s[p.i] === ' ' || p.s[p.i] === '\t') p.i += 1;
    if (p.i >= p.s.length) throw new SyntaxError('a dictionary that ends in a comma');
  }
}

function serializeBare(v) {
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  if (Buffer.isBuffer(v)) return `:${v.toString('base64')}:`;
  if (v instanceof Token) return v.name;
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function serializeParams(params) {
  return [...params].map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join('');
}

// An inner list with its parameters, as RFC 9421 puts it on the
// @signature-params line.
export function serializeInnerList(member) {
  return `(${member.list.map((item) => `${serializeBare(item.value)}${serializeParams(item.params)}`).join(' ')})${serializeParams(member.params)}`;
}

// ---- The HTTP message signature base (RFC 9421 section 2.5)

function componentValue(name, request) {
  if (name === '@method') return request.method;
  if (name === '@path') return request.path;
  if (name === '@query') return request.query === null ? '?' : `?${request.query}`;
  if (name === '@request-target') return request.target;
  if (name === '@authority') {
    const host = fieldOf(request.headers, 'host');
    if (host === null) refuse('@authority is covered and the request carries no Host header');
    return host.toLowerCase();
  }
  if (name.startsWith('@')) refuse(`the derived component ${name} is not read`);
  if (name !== name.toLowerCase()) refuse(`the covered field ${name} is not in lower case`);
  const value = fieldOf(request.headers, name);
  if (value === null) refuse(`the covered field ${name} is not in the request`);
  return value;
}

export function signatureBase(request, member) {
  const lines = member.list.map((item) => {
    if (typeof item.value !== 'string') refuse('a covered component is not a string');
    if (item.params.size) refuse(`the component ${item.value} carries parameters, which are not read`);
    return `${serializeBare(item.value)}: ${componentValue(item.value, request)}`;
  });
  const names = member.list.map((item) => item.value);
  if (new Set(names).size !== names.length) refuse('a component is covered twice');
  return Buffer.from([...lines, `"@signature-params": ${serializeInnerList(member)}`].join('\n'), 'latin1');
}

// ---- Keys and the token

function p256Key(jwk, what) {
  if (!isObject(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') refuse(`${what} is not an EC P-256 public key`);
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') refuse(`${what} is marked for ${jwk.alg}, not ES256`);
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
}

function verifyP256(key, data, signature, what) {
  if (signature.length !== 64) refuse(`${what} is ${signature.length} bytes, not the 64 of an ES256 signature`);
  return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function readToken(text) {
  const parts = text.split('.');
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) refuse('the Workload-Identity-Token is not a compact JWS of three base64url parts');
  const header = json(Buffer.from(parts[0], 'base64url'), 'the token header');
  const claims = json(Buffer.from(parts[1], 'base64url'), 'the token claims');
  if (!isObject(header) || !isObject(claims)) refuse('the token header and claims are not JSON objects');
  return {
    header,
    claims,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    signature: Buffer.from(parts[2], 'base64url'),
    sha256: sha256Hex(Buffer.from(text, 'ascii')),
  };
}

function hostOf(uri, what) {
  try {
    const { host } = new URL(uri);
    if (host) return host;
  } catch {
    // refused below
  }
  return refuse(`${what} is not a URI with a host`);
}

// ---- The check

// bytes: { capture, journal, keys }, the three files. source: where they
// were published ({ repo, branch, commit, folder }). files: the files as the
// loader found them ({ name, size, sha256 } each), carried into the result.
export function checkCapture(bytes, { source, files = [] } = {}) {
  const words = LABELS.capture;
  const results = new Map();
  const answer = (name, value, reason = null, facts = null) => {
    results.set(name, { name, answer: value, claim: words.claims[name], reason, facts });
  };
  const attempt = (name, run) => {
    try {
      run();
    } catch (err) {
      answer(name, 'fail', reasonOf(err), results.get(name)?.facts ?? null);
    }
  };
  const notRun = (names, why) => names.forEach((name) => { if (!results.has(name)) answer(name, 'not-run', why); });

  // The capture: one TCP connection, both directions, one HTTP exchange.
  let pcap = null;
  let connection = null;
  let exchange = null;
  attempt('capture', () => {
    pcap = readPcap(bytes.capture);
    connection = readConnection(pcap);
    exchange = readExchange(connection.up, connection.down);
    answer('capture', 'pass', null, {
      link: pcap.link,
      byteOrder: pcap.byteOrder,
      packets: pcap.packets.length,
      client: connection.client,
      server: connection.server,
      loopback: connection.loopback,
      request: `${exchange.request.method} ${exchange.request.target}`,
      status: exchange.response.status,
      requestBytes: connection.up.length,
      responseBytes: connection.down.length,
      capturedFrom: connection.firstAt,
      capturedTo: connection.lastAt,
    });
  });
  if (!exchange) {
    notRun(CHECK_NAMES, words.notRun.capture);
    return resultOf({ source, files, results, exchange: null, token: null, signature: null });
  }
  const request = exchange.request;

  // The token, under the key its kid names in the key set of its iss host.
  let token = null;
  attempt('witSignature', () => {
    const lines = request.headers.filter(([n]) => n === 'workload-identity-token');
    if (lines.length !== 1) refuse(`the request carries ${lines.length} Workload-Identity-Token headers; one is read`);
    token = readToken(lines[0][1]);
    const { header, claims } = token;
    const host = typeof claims.iss === 'string' ? hostOf(claims.iss, 'the token iss') : refuse('the token carries no iss');
    const facts = { typ: header.typ ?? null, alg: header.alg ?? null, kid: header.kid ?? null, keySet: host };
    answer('witSignature', 'fail', null, facts);
    if (header.typ !== 'wit+jwt') refuse(`the token typ is ${JSON.stringify(header.typ ?? null)}, not wit+jwt`);
    if (header.alg !== 'ES256') refuse(`the token alg is ${JSON.stringify(header.alg ?? null)}, not ES256`);
    if (header.crit !== undefined) refuse('the token header names crit members, which are not read');
    if (typeof header.kid !== 'string') refuse('the token header carries no kid');
    const sets = json(bytes.keys, 'jwks.json');
    const keys = isObject(sets) && isObject(sets[host]) && Array.isArray(sets[host].keys) ? sets[host].keys : refuse(`jwks.json holds no key set for ${host}`);
    const matching = keys.filter((k) => isObject(k) && k.kid === header.kid);
    if (matching.length !== 1) refuse(`the ${host} key set holds ${matching.length} keys with kid ${header.kid}; one is read`);
    if (!verifyP256(p256Key(matching[0], `key ${header.kid}`), token.signingInput, token.signature, 'the token signature')) {
      refuse(`the token signature does not verify under key ${header.kid} of the ${host} key set`);
    }
    answer('witSignature', 'pass', null, facts);
  });

  // The digest of the body.
  attempt('contentDigest', () => {
    const value = fieldOf(request.headers, 'content-digest');
    if (value === null) refuse('the request carries no Content-Digest header');
    const facts = { algorithm: 'sha-256', bodyBytes: request.body.length };
    answer('contentDigest', 'fail', null, facts);
    const digest = parseDictionary(value).get('sha-256');
    if (!digest || !Buffer.isBuffer(digest.value)) refuse('Content-Digest carries no sha-256 byte sequence');
    if (!digest.value.equals(sha256(request.body))) refuse('the sha-256 value differs from the SHA-256 of the request body');
    answer('contentDigest', 'pass', null, facts);
  });

  // The HTTP message signature, under the key the token confirms.
  let signature = null;
  const jwk = token && isObject(token.claims.cnf) ? token.claims.cnf.jwk : null;
  attempt('httpSignature', () => {
    const input = fieldOf(request.headers, 'signature-input');
    const sig = fieldOf(request.headers, 'signature');
    if (input === null) refuse('the request carries no Signature-Input header');
    if (sig === null) refuse('the request carries no Signature header');
    const inputs = parseDictionary(input);
    const label = inputs.size === 1 ? [...inputs.keys()][0] : inputs.has('wimse') ? 'wimse' : refuse('Signature-Input names several signatures and none is wimse');
    const member = inputs.get(label);
    if (!member.list) refuse(`Signature-Input ${label} is not an inner list`);
    const params = member.params;
    const text = (name) => { const v = params.get(name); return typeof v === 'string' ? v : null; };
    signature = {
      label,
      covered: member.list.map((item) => (typeof item.value === 'string' ? item.value : null)),
      alg: 'ecdsa-p256-sha256',
      key: isObject(jwk) && typeof jwk.kid === 'string' ? jwk.kid : null,
      created: Number.isInteger(params.get('created')) ? params.get('created') : null,
      expires: Number.isInteger(params.get('expires')) ? params.get('expires') : null,
      tag: text('tag'),
      audience: text('wimse-aud'),
      sha256: null,
    };
    answer('httpSignature', 'fail', null, signature);
    const value = parseDictionary(sig).get(label);
    if (!value || !Buffer.isBuffer(value.value)) refuse(`Signature carries no byte sequence for ${label}`);
    signature.sha256 = sha256Hex(value.value);
    if (params.has('alg') && params.get('alg') !== 'ecdsa-p256-sha256') refuse(`the signature alg ${params.get('alg')} is not read`);
    if (!token) {
      answer('httpSignature', 'not-run', words.notRun.token, signature);
      return;
    }
    const key = p256Key(jwk, "the token's cnf.jwk");
    if (!verifyP256(key, signatureBase(request, member), value.value, 'the signature')) {
      refuse("the signature does not verify under the key in the token's cnf.jwk over the signature base");
    }
    answer('httpSignature', 'pass', null, signature);
  });

  // The signature's created time, inside the token's own window.
  if (!token || !signature) {
    notRun(['signatureCreated'], token ? words.notRun.signatureInput : words.notRun.token);
  } else {
    attempt('signatureCreated', () => {
      const { iat, exp } = token.claims;
      if (signature.created === null) refuse('Signature-Input carries no integer created');
      if (!Number.isFinite(iat) || !Number.isFinite(exp)) refuse('the token carries no numeric iat and exp');
      const facts = { created: utc(signature.created), iat: utc(iat), exp: utc(exp) };
      answer('signatureCreated', 'fail', null, facts);
      if (signature.created < iat || signature.created > exp) refuse(`created ${facts.created} lies outside iat ${facts.iat} to exp ${facts.exp}`);
      answer('signatureCreated', 'pass', null, facts);
    });
  }

  // The response, and the journal line beside it.
  let paid = null;
  const sub = token && typeof token.claims.sub === 'string' ? token.claims.sub : null;
  const requestBody = (() => {
    try {
      const body = json(request.body, 'the request body');
      return isObject(body) ? body : null;
    } catch {
      return null;
    }
  })();
  if (!token) {
    notRun(['response', 'journal'], words.notRun.token);
  } else {
    attempt('response', () => {
      const res = exchange.response;
      const body = json(res.body, 'the response body');
      if (!isObject(body)) refuse('the response body is not a JSON object');
      paid = body;
      const facts = { status: res.status, invoice: body.invoice ?? null, amount: body.amount ?? null, currency: body.currency ?? null, settledAt: body.settled_at ?? null };
      answer('response', 'fail', null, facts);
      if (!requestBody) refuse('the request body is not a JSON object');
      const txn = fieldOf(request.headers, 'txn-token');
      const differ = [];
      if (res.status !== 200) differ.push(`the status code is ${res.status}`);
      if (body.status !== 'paid') differ.push('status is not paid');
      if (txn === null || body.txn !== txn) differ.push("txn is not the request's Txn-Token");
      if (body.invoice !== requestBody.invoice) differ.push("invoice is not the request's");
      if (body.amount !== requestBody.amount) differ.push("amount is not the request's");
      if (sub === null || body.payer !== sub) differ.push("payer is not the token's sub");
      if (typeof body.receipt !== 'string' || body.receipt === '') differ.push('it carries no receipt');
      if (typeof body.settled_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(body.settled_at)) differ.push('it carries no settled_at time');
      if (differ.length) refuse(differ.join('; '));
      answer('response', 'pass', null, facts);
    });
    if (!paid) {
      notRun(['journal'], words.notRun.response);
    } else {
      attempt('journal', () => {
        const lines = bytes.journal.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
        if (lines.at(-1) === '') lines.pop();
        const facts = { lines: lines.length, compared: ['txn', 'invoice', 'amount', 'settled_at', 'receipt', 'peer_id'] };
        answer('journal', 'fail', null, facts);
        if (lines.length !== 1 || lines[0].trim() === '') refuse(`the journal holds ${lines.length} lines; one is read`);
        const entry = json(lines[0], 'the journal line');
        if (!isObject(entry)) refuse('the journal line is not a JSON object');
        const differ = ['txn', 'invoice', 'amount', 'settled_at', 'receipt'].filter((k) => entry[k] !== paid[k]);
        if (sub === null || entry.peer_id !== sub) differ.push('peer_id');
        if (differ.length) refuse(`the journal line differs from the response in ${differ.join(', ')}`);
        answer('journal', 'pass', null, facts);
      });
    }
  }

  const hostOrNull = (uri) => {
    try {
      return typeof uri === 'string' ? new URL(uri).host || null : null;
    } catch {
      return null;
    }
  };
  return resultOf({
    source,
    files,
    results,
    exchange: {
      from: hostOrNull(token?.claims.iss),
      to: hostOrNull(signature?.audience),
      loopback: connection.loopback,
      invoice: requestBody?.invoice ?? null,
      amount: requestBody?.amount ?? null,
      currency: requestBody?.currency ?? null,
    },
    token: token ? { sha256: token.sha256, header: token.header, claims: token.claims } : null,
    signature,
    txnToken: fieldOf(request.headers, 'txn-token'),
  });
}

function resultOf({ source, files, results, exchange, token, signature, txnToken = null }) {
  const words = LABELS.capture;
  const checks = CHECK_NAMES.map((name) => results.get(name));
  const passed = checks.filter((c) => c.answer === 'pass').length;
  const failed = checks.filter((c) => c.answer !== 'pass').map((c) => c.name);
  const commit8 = String(source?.commit ?? '').slice(0, 8);
  const full = exchange && exchange.from && exchange.to && exchange.invoice !== null && exchange.amount !== null && exchange.currency !== null;
  return {
    check: words.name,
    source: { repo: source?.repo ?? null, branch: source?.branch ?? null, commit: source?.commit ?? null, folder: source?.folder ?? null },
    files: files.map(({ name, size, sha256: digest }) => ({ name, size, sha256: digest })),
    exchange,
    token,
    signature,
    txnToken: { carried: txnToken !== null, checked: false, sha256: txnToken === null ? null : sha256Hex(Buffer.from(txnToken, 'latin1')) },
    checks,
    passed,
    total: checks.length,
    outcome: failed.length === 0 ? 'verified' : 'not-verified',
    summary: failed.length === 0
      ? fill(words.summary, { commit8, passed, total: checks.length })
      : fill(words.summaryFailed, { commit8, passed, total: checks.length, failed: failed.join(', ') }),
    scope: [
      full
        ? fill(words.scope.published, { commit8, repo: source.repo, kind: exchange.loopback ? words.scope.loopback : words.scope.exchange, from: exchange.from, to: exchange.to, invoice: exchange.invoice, amount: exchange.amount, currency: exchange.currency })
        : fill(words.scope.publishedBare, { commit8, repo: source?.repo ?? '' }),
      words.scope.keys,
      words.scope.times,
      words.scope.txnToken,
    ],
  };
}
