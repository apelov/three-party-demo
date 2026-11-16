// A synthetic capture of the shape the AI2II capture check reads, made for
// the tests: keys generated here, a Workload-Identity-Token, a request signed
// as RFC 9421 section 2.5 builds the signature base, its response, the
// journal line, the key sets, and a classic libpcap file written by the
// writer below. No byte of the published capture is used, and its names and
// values are the tests' own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const b64u = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const p256 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), alg: 'ES256', kid });

export const ISSUER_HOST = 'issuer.test';
export const AUDIENCE = 'wimse://receiver.test/api/transfer';
export const IAT = 1794700000;

// The three files and what went into them. Each option changes one thing,
// so a test can make exactly one check fail:
//   tamperBody      the body is changed after it was digested and signed
//   wrongKey        the key set lists another key under the token's kid
//   digestOver      Content-Digest (signed) is the digest of these bytes, not of the body
//   headerAfter     a covered header is changed after signing: [name, value]
//   created         the signature's created time (default IAT + 5)
//   journal         members that replace those of the journal line
//   response        members that replace those of the response body
export function buildFiles(options = {}) {
  const issuer = p256();
  const workload = p256();
  const issuerJwk = jwkOf(issuer, 'test-issuer-1');
  const workloadJwk = jwkOf(workload, 'test-workload-1');
  const iat = IAT;
  const exp = iat + 3600;
  const iss = `wimse://${ISSUER_HOST}`;
  const sub = `wimse://${ISSUER_HOST}/agent/payer`;
  const header = { alg: 'ES256', kid: issuerJwk.kid, typ: 'wit+jwt' };
  const claims = { iss, sub, iat, exp, jti: 'test-jti-0001', cnf: { jwk: workloadJwk } };
  const signingInput = `${b64u(header)}.${b64u(claims)}`;
  const witSignature = crypto.sign('sha256', Buffer.from(signingInput), { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' });
  const wit = `${signingInput}.${witSignature.toString('base64url')}`;

  const txnToken = 'txn-test-0001';
  const bodyText = JSON.stringify({ invoice: 'INV-9001', amount: 1234, currency: 'USD', to: 'payee-test-a', ref: txnToken });
  const digestOver = options.digestOver ?? Buffer.from(bodyText);
  const digest = `sha-256=:${crypto.createHash('sha256').update(digestOver).digest('base64')}:`;
  const created = options.created ?? iat + 5;
  const params = `("@method" "@path" "@query" "content-type" "content-digest" "txn-token" "workload-identity-token");created=${created};expires=${created + 60};nonce="test-nonce-1";tag="wimse-workload-to-workload";wimse-aud="${AUDIENCE}"`;
  const covered = { 'content-type': 'application/json', 'content-digest': digest, 'txn-token': txnToken, 'workload-identity-token': wit };
  const base = [
    '"@method": POST',
    '"@path": /api/transfer',
    '"@query": ?',
    ...Object.entries(covered).map(([name, value]) => `"${name}": ${value}`),
    `"@signature-params": ${params}`,
  ].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(base), { key: workload.privateKey, dsaEncoding: 'ieee-p1363' });
  const sent = { ...covered };
  if (options.headerAfter) sent[options.headerAfter[0]] = options.headerAfter[1];
  const body = options.tamperBody ? bodyText.replace('payee-test-a', 'payee-test-b') : bodyText;
  const request = Buffer.from([
    'POST /api/transfer HTTP/1.1',
    `Txn-Token: ${sent['txn-token']}`,
    'Host: 127.0.0.1:5070',
    `Workload-Identity-Token: ${sent['workload-identity-token']}`,
    `Content-Type: ${sent['content-type']}`,
    `Content-Digest: ${sent['content-digest']}`,
    `Signature-Input: wimse=${params}`,
    `Signature: wimse=:${signature.toString('base64')}:`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));

  const paid = { status: 'paid', txn: txnToken, invoice: 'INV-9001', amount: 1234, currency: 'USD', settled_at: '2026-11-14T12:00:05Z', receipt: 'rcpt-test-0001', payer: sub, ...(options.response ?? {}) };
  const responseBody = JSON.stringify(paid, null, 2);
  const response = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`);
  const entry = { case: 'test', status: 200, decision: 'settled', txn: paid.txn, invoice: paid.invoice, amount: paid.amount, peer_id: sub, settled_at: paid.settled_at, receipt: paid.receipt, ...(options.journal ?? {}) };
  const journal = Buffer.from(`${JSON.stringify(entry)}\n`);

  const other = jwkOf(p256(), issuerJwk.kid);
  const sets = {
    [ISSUER_HOST]: { keys: [options.wrongKey ? other : issuerJwk] },
    'receiver.test': { keys: [jwkOf(p256(), 'test-receiver-1')] },
  };
  const keys = Buffer.from(`${JSON.stringify(sets, null, 2)}\n`);
  return { request, response, journal, keys, wit, witSignature: witSignature.toString('base64url'), signature, txnToken, sub, iss, claims, header };
}

// ---- A classic libpcap writer

function ipv4(src, dst, segment) {
  const h = Buffer.alloc(20);
  h[0] = 0x45;
  h.writeUInt16BE(20 + segment.length, 2);
  h.writeUInt16BE(0x4000, 6);
  h[8] = 64;
  h[9] = 6;
  Buffer.from(src.split('.').map(Number)).copy(h, 12);
  Buffer.from(dst.split('.').map(Number)).copy(h, 16);
  let sum = 0;
  for (let i = 0; i < 20; i += 2) sum += h.readUInt16BE(i);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  h.writeUInt16BE(~sum & 0xffff, 10);
  return Buffer.concat([h, segment]);
}

const FLAGS = { FIN: 0x01, SYN: 0x02, PSH: 0x08, ACK: 0x10 };

function tcp(sport, dport, seq, ack, flags, payload) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt32BE(seq >>> 0, 4);
  h.writeUInt32BE(ack >>> 0, 8);
  h[12] = 5 << 4;
  h[13] = flags.reduce((all, f) => all | FLAGS[f], 0);
  h.writeUInt16BE(65535, 14);
  return Buffer.concat([h, payload]);
}

function framed(linkType, little, ip) {
  if (linkType === 1) {
    const eth = Buffer.alloc(14);
    eth.writeUInt16BE(0x0800, 12);
    return Buffer.concat([eth, ip]);
  }
  const family = Buffer.alloc(4);
  if (little) family.writeUInt32LE(2, 0); else family.writeUInt32BE(2, 0);
  return Buffer.concat([family, ip]);
}

// The packets of one exchange on loopback: the handshake, the request in
// `split` segments, the response, and the client's FIN. Sequence numbers
// start at isn values near 2^32, so the count wraps inside the request.
//   order: 'reverse' sends the request segments last first
//   retransmit: the first request segment is sent twice
//   drop: the second request segment is left out
export function exchangePackets(files, { split = 1, order = 'forward', retransmit = false, drop = false, clientIsn = 0xfffffe00, serverIsn = 2000 } = {}) {
  const c = { ip: '127.0.0.1', port: 54321 };
  const s = { ip: '127.0.0.1', port: 5070 };
  const out = [];
  const add = (from, to, seq, ack, flags, payload = Buffer.alloc(0)) => out.push({ from, to, segment: tcp(from.port, to.port, seq, ack, flags, payload) });
  const cSeq = (clientIsn + 1) >>> 0;
  const sSeq = (serverIsn + 1) >>> 0;
  add(c, s, clientIsn, 0, ['SYN']);
  add(s, c, serverIsn, cSeq, ['SYN', 'ACK']);
  add(c, s, cSeq, sSeq, ['ACK']);
  const size = Math.ceil(files.request.length / split);
  let pieces = [];
  for (let at = 0; at < files.request.length; at += size) pieces.push({ at, data: files.request.subarray(at, at + size) });
  if (drop) pieces = pieces.filter((_, i) => i !== 1);
  if (retransmit) pieces.splice(1, 0, pieces[0]);
  if (order === 'reverse') pieces.reverse();
  for (const p of pieces) add(c, s, cSeq + p.at, sSeq, ['PSH', 'ACK'], p.data);
  const cEnd = (cSeq + files.request.length) >>> 0;
  add(s, c, sSeq, cEnd, ['ACK']);
  add(s, c, sSeq, cEnd, ['PSH', 'ACK'], files.response);
  const sEnd = (sSeq + files.response.length) >>> 0;
  add(c, s, cEnd, sEnd, ['FIN', 'ACK']);
  add(s, c, sEnd, (cEnd + 1) >>> 0, ['ACK']);
  return out;
}

export function writePcap(packets, { little = true, nano = false, linkType = 0, magic = null, startSec = IAT } = {}) {
  const head = Buffer.alloc(24);
  const u16 = (v, o) => (little ? head.writeUInt16LE(v, o) : head.writeUInt16BE(v, o));
  const u32 = (v, o) => (little ? head.writeUInt32LE(v >>> 0, o) : head.writeUInt32BE(v >>> 0, o));
  u32(magic ?? (nano ? 0xa1b23c4d : 0xa1b2c3d4), 0);
  u16(2, 4);
  u16(4, 6);
  u32(65535, 16);
  u32(linkType, 20);
  const records = packets.map((p, i) => {
    const data = framed(linkType, little, ipv4(p.from.ip, p.to.ip, p.segment));
    const r = Buffer.alloc(16);
    const w = (v, o) => (little ? r.writeUInt32LE(v >>> 0, o) : r.writeUInt32BE(v >>> 0, o));
    w(startSec, 0);
    w(nano ? 1000000 * i : 1000 * i, 4);
    w(data.length, 8);
    w(data.length, 12);
    return Buffer.concat([r, data]);
  });
  return Buffer.concat([head, ...records]);
}

// The three files, by role, from one call: the capture as a pcap.
export function captureFiles(options = {}, pcap = {}) {
  const files = buildFiles(options);
  const capture = writePcap(exchangePackets(files, pcap.packets ?? {}), pcap.file ?? {});
  return { ...files, bytes: { capture, journal: files.journal, keys: files.keys } };
}

// A source of the shape AI2II_SOURCE has, with the names, sizes and SHA-256
// of the given bytes as its pins.
export function sourceFor(bytes, names = { capture: 'capture_scenario1.pcap', journal: 'decision-journal.jsonl', keys: 'jwks.json' }) {
  const pin = (role) => ({ name: names[role], size: bytes[role].length, sha256: sha256Hex(bytes[role]) });
  return {
    repo: 'https://github.com/test-owner/test-capture',
    branch: 'test-branch',
    commit: '0123456789abcdef0123456789abcdef01234567',
    folder: 'handover/test',
    files: { capture: pin('capture'), journal: pin('journal'), keys: pin('keys') },
  };
}

// Writes the three files into dir under the names of a source.
export function writeCapture(dir, bytes, source) {
  fs.mkdirSync(dir, { recursive: true });
  for (const role of ['capture', 'journal', 'keys']) fs.writeFileSync(path.join(dir, source.files[role].name), bytes[role]);
  return dir;
}
