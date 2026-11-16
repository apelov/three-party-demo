#!/usr/bin/env node
// Fetches the three files of the AI2II capture that the demo's crossing step
// checks, into three-party/external/ai2ii/ (git ignores that folder):
//
//   node scripts/three-party/fetch-ai2ii.mjs [--dir <dir>]
//
// Each file comes from raw.githubusercontent.com at the pinned commit of the
// AI2II repository (three-party/src/engine/ai2ii-source.mjs holds the
// commit, the names, the sizes and the SHA-256 values). A file is written
// under a temporary name and renamed into place only when its size and
// SHA-256 equal its pin; otherwise the temporary file is deleted and the
// script exits 1, naming the file and both digests. A file already in place
// with its pinned size and SHA-256 is kept and not fetched again. The script
// calls no other host, follows no redirect and runs nothing it fetched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AI2II_SOURCE, DEFAULT_AI2II_DIR, ROLES, rawUrl } from '../../three-party/src/engine/ai2ii-source.mjs';

export const RAW_HOST = 'raw.githubusercontent.com';
const LIMIT_BYTES = 1024 * 1024;

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// One GET of a file on the raw host: its bytes on HTTP 200, an error on
// anything else.
export function httpsGet(url, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== RAW_HOST) {
      reject(new Error(`${url} is not fetched: only https://${RAW_HOST}/ is`));
      return;
    }
    const req = https.get(target, { headers: { 'user-agent': 'three-party-demo-fetch', accept: 'application/octet-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${url} answered HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > LIMIT_BYTES) req.destroy(new Error(`${url} sent more than ${LIMIT_BYTES} bytes`));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${url} did not answer within ${timeoutMs / 1000} seconds`)));
    req.on('error', reject);
  });
}

function bytesIfFile(file) {
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

function shown(dir) {
  const relative = path.relative(process.cwd(), dir);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : dir;
}

// Fetches what is missing or not pinned, and returns the exit status: 0 when
// the three pinned files are in place, 1 otherwise. get(url) returns the
// bytes at url; out and err each take one line.
export async function fetchAi2ii({
  dir = DEFAULT_AI2II_DIR,
  source = AI2II_SOURCE,
  get = httpsGet,
  out = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let missing = 0;
  for (const role of ROLES) {
    const pin = source.files[role];
    const file = path.join(dir, pin.name);
    const had = bytesIfFile(file);
    if (had && had.length === pin.size && sha256Hex(had) === pin.sha256) {
      out(`kept ${pin.name}: ${pin.size} bytes, sha256 ${pin.sha256}`);
      continue;
    }
    const url = rawUrl(source, pin.name);
    let bytes;
    try {
      bytes = await get(url);
    } catch (error) {
      missing += 1;
      err(`not fetched ${pin.name}: ${error.message}`);
      continue;
    }
    const temp = path.join(dir, `.${pin.name}.${process.pid}.part`);
    fs.writeFileSync(temp, bytes);
    const written = fs.readFileSync(temp);
    const digest = sha256Hex(written);
    if (written.length !== pin.size || digest !== pin.sha256) {
      fs.rmSync(temp, { force: true });
      missing += 1;
      err(`refused ${pin.name}: got ${written.length} bytes, sha256 ${digest}; pinned ${pin.size} bytes, sha256 ${pin.sha256}; the file was deleted`);
      continue;
    }
    fs.renameSync(temp, file);
    out(`${had ? 'replaced' : 'fetched'} ${pin.name}: ${written.length} bytes, sha256 ${digest}, from ${url}`);
  }
  if (missing) {
    err(`${missing} of ${ROLES.length} files are not in ${shown(dir)} as pinned; the crossing step falls back to the delegation chain check`);
    return 1;
  }
  out(`${shown(dir)} holds the ${ROLES.length} files of ${source.repo} at commit ${source.commit}, each as pinned`);
  return 0;
}

const USAGE = [
  'usage: node scripts/three-party/fetch-ai2ii.mjs [--dir <dir>]',
  `  fetches the AI2II capture files from https://${RAW_HOST}/ at the pinned commit`,
  '  --dir   where to put them (default three-party/external/ai2ii)',
];

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let dir = DEFAULT_AI2II_DIR;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`${USAGE.join('\n')}\n`);
      process.exit(0);
    }
    if (args[i] === '--dir' && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      dir = path.resolve(args[i + 1]);
      i += 1;
    } else {
      process.stderr.write(`${USAGE.join('\n')}\n`);
      process.exit(2);
    }
  }
  fetchAi2ii({ dir }).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
