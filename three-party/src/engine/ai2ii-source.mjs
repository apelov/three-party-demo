// The AI2II capture the crossing step checks when it is on this computer:
// the repository and commit it was published at, its three files by name,
// size and SHA-256, and the folder they are fetched into. The tree holds no
// file of it; scripts/three-party/fetch-ai2ii.mjs fetches them into that
// folder, which git ignores. Node built-ins only, and no network: this module
// reads the folder and hashes what it finds.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AI2II_SOURCE = Object.freeze({
  repo: 'https://github.com/apelov/IETF127-Hackathon-AI2II-WIMSE',
  branch: 'feature/opena2a-wimse-aep',
  commit: '32f584a2016d7ebd0d2f5156148cc404c496a086',
  folder: 'handover/wimse_ai2ii',
  // By the role each file plays in the check.
  files: Object.freeze({
    capture: Object.freeze({ name: 'capture_scenario1.pcap', size: 2234, sha256: '5137fd90c2236088d563eb3d89ed89a65858f07249415c3ed8a38d90edbac3a5' }),
    journal: Object.freeze({ name: 'decision-journal.jsonl', size: 316, sha256: '688cb4e4782e46f86f444c08c4d38d71c3f4b8f0f3f9429c306afd9445643a63' }),
    keys: Object.freeze({ name: 'jwks.json', size: 851, sha256: 'aea167c07199cbea380782d23e3e775daf65dc96ce0474671a9e75ee27e92aaf' }),
  }),
});

export const ROLES = Object.freeze(['capture', 'journal', 'keys']);

export const DEFAULT_AI2II_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'external', 'ai2ii');

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The address a file of the source is served at: GitHub's raw host, at the
// pinned commit, never a branch.
export function rawUrl(source, name) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(source.repo);
  if (!m) throw new Error(`not a GitHub repository address: ${source.repo}`);
  if (!/^[0-9a-f]{40}$/.test(source.commit)) throw new Error(`not a full commit id: ${source.commit}`);
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${source.commit}/${source.folder}/${encodeURIComponent(name)}`;
}

// Reads the three files from the folder and compares each with its pin.
//   { use: true, bytes: { capture, journal, keys }, files }
//   { use: false, why: 'absent', missing: [names], files }
//   { use: false, why: 'mismatch', differing: [names], files }
// files lists each file in role order: { role, name, size, sha256,
// pinnedSize, pinnedSha256 }, size and sha256 null for a file not there. A
// path that is not a regular file counts as not there.
export function loadCapture({ dir = DEFAULT_AI2II_DIR, source = AI2II_SOURCE } = {}) {
  const bytes = {};
  const files = ROLES.map((role) => {
    const pin = source.files[role];
    let found = null;
    try {
      const file = path.join(dir, pin.name);
      if (fs.statSync(file).isFile()) found = fs.readFileSync(file);
    } catch {
      found = null;
    }
    bytes[role] = found;
    return { role, name: pin.name, size: found ? found.length : null, sha256: found ? sha256Hex(found) : null, pinnedSize: pin.size, pinnedSha256: pin.sha256 };
  });
  const missing = files.filter((f) => f.sha256 === null).map((f) => f.name);
  if (missing.length) return { use: false, why: 'absent', missing, files };
  const differing = files.filter((f) => f.size !== f.pinnedSize || f.sha256 !== f.pinnedSha256).map((f) => f.name);
  if (differing.length) return { use: false, why: 'mismatch', differing, files };
  return { use: true, bytes, files };
}
