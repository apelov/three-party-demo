#!/usr/bin/env node
// The view's development server. It answers the run API of the contract
// (section 7) from the example files and serves the view's own files, so the
// screen can be built and tested before the engine is wired. It listens on
// 127.0.0.1 and nowhere else.
//
//   node three-party/view/dev-server.mjs [--port <n>] [--examples <dir>]
//                                        [--labels <file>] [--replay [--speed <n>]]
//
// Routes:
//   GET  /                              the view (and its static files)
//   GET  /api/health                    { ok, build }
//   GET  /api/variants                  { crossing }: "supplied" when the finished
//                                       clean example's crossing ran the AI2II
//                                       capture, else "fallback"
//   GET  /api/labels                    the contract's label map, three-party/labels.json,
//                                       with the words of the view's own
//                                       labels.json added, as the engine
//                                       answers it; or the file --labels names,
//                                       as it is
//   POST /api/runs                      { kind } -> { runId }; 400 for a kind with no example
//   GET  /api/runs/<id>                 the run state: a state still in progress on
//                                       the two polls after the run starts, the
//                                       finished state after
//   POST /api/runs/<id>/offline-check   the example offline check result
//   GET  /api/runs/<id>/files/<path>    the example file whose base name matches; 404 otherwise
//
// With --replay the finished example is played back on its own timeline from
// the moment the run starts (each step pending, then being checked, then in
// its final state), with every time moved to the present, so the screen can
// be watched as a run in progress. --speed plays it faster.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { labelMapBytes } from '../src/engine/label-map.mjs';

const VIEW = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(VIEW, '..', 'examples');
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const NOT_SERVED = new Set(['dev-server.mjs', 'stills.mjs', 'record.mjs']);
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function buildSha() {
  try {
    return execFileSync('git', ['-C', VIEW, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': POLICY,
  });
  res.end(body);
}

const sendJson = (res, status, value) => send(res, status, TYPES['.json'], typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`);

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(size <= limit ? Buffer.concat(chunks).toString('utf8') : null));
    req.on('error', () => resolve(null));
  });
}

// Every RFC 3339 string in a value, passed through fn.
function mapTimes(value, fn) {
  if (typeof value === 'string') return RFC3339.test(value) ? fn(value) : value;
  if (Array.isArray(value)) return value.map((v) => mapTimes(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapTimes(v, fn)]));
  return value;
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The finished example as it stood at a moment of its own timeline.
export function asOf(final, moment) {
  const reached = (t) => Boolean(t) && Date.parse(t) <= moment;
  const stopper = final.blockedAt ? final.steps.find((s) => s.id === final.blockedAt) : null;
  const stopSeen = Boolean(stopper) && reached(stopper.endedAt);
  const writer = final.steps.find((s) => s.status === 'written');
  const written = writer ? reached(writer.endedAt) : reached(final.finishedAt);
  const payer = final.steps.find((s) => s.detail && s.detail.paymentId);
  const out = structuredClone(final);
  out.steps = final.steps.map((s) => {
    if (!s.startedAt) return stopSeen ? s : { ...s, status: 'pending' };
    if (!reached(s.startedAt)) return { ...s, status: 'pending', startedAt: null, endedAt: null, detail: null, actionFile: null, recordFile: null };
    if (!reached(s.endedAt)) return { ...s, status: 'running', endedAt: null, detail: null, actionFile: null, recordFile: null };
    return { ...s, recordFile: s.status === 'written' || written ? s.recordFile : null };
  });
  if (!final.grant || !reached(final.grant.issuedAt)) out.grant = null;
  const done = reached(final.finishedAt);
  if (!done) out.finishedAt = null;
  const decided = done || (final.outcome === 'blocked' ? stopSeen : Boolean(payer) && reached(payer.endedAt));
  if (!decided) {
    out.outcome = null;
    out.blockedAt = null;
    out.reason = null;
  }
  return out;
}

export async function startDevServer({ port = 0, examples = EXAMPLES, labels = null, replay = false, speed = 1 } = {}) {
  const build = buildSha();
  const exampleNames = fs.readdirSync(examples).filter((f) => fs.statSync(path.join(examples, f)).isFile());
  const readExample = (name) => fs.readFileSync(path.join(examples, name));

  // The runs this server can answer for: the example states, by run id. A
  // state with no finishedAt is a run in progress; the other is the finished run.
  const runs = new Map();
  for (const name of exampleNames.filter((f) => /^state-.*\.json$/.test(f)).sort()) {
    const state = JSON.parse(readExample(name).toString('utf8'));
    if (typeof state.runId !== 'string') continue;
    const run = runs.get(state.runId) ?? { kind: state.kind, running: null, final: null, polls: 0, startedMs: null };
    if (state.finishedAt) run.final = { name, state }; else run.running = { name, state };
    runs.set(state.runId, run);
  }
  const idOfKind = (kind) => [...runs].find(([, run]) => run.kind === kind)?.[0] ?? null;

  // In a replay, the present moment on the example's own timeline, and the
  // example's times moved to the present.
  const moved = (run, value) => {
    if (!replay || run.startedMs === null || !run.final) return value;
    const t0 = Date.parse(run.final.state.startedAt);
    return mapTimes(value, (t) => iso(run.startedMs + (Date.parse(t) - t0) / speed));
  };

  function runState(run) {
    if (replay && run.final) {
      if (run.startedMs === null) run.startedMs = Date.now();
      const t0 = Date.parse(run.final.state.startedAt);
      const frame = asOf(run.final.state, t0 + (Date.now() - run.startedMs) * speed);
      if (speed !== 1 && frame.grant) frame.grant = { ...frame.grant, ttlSeconds: Math.max(1, Math.round(frame.grant.ttlSeconds / speed)) };
      return `${JSON.stringify(moved(run, frame), null, 2)}\n`;
    }
    run.polls += 1;
    const pick = run.running && run.polls <= 2 ? run.running : (run.final ?? run.running);
    return readExample(pick.name);
  }

  // The example whose base name matches the path asked for: the same base
  // name, or the base name led by the singular of its directory
  // (actions/05-pay.action.json is action-05-pay.action.json).
  function exampleFor(rel) {
    const base = path.posix.basename(rel);
    const dir = path.posix.basename(path.posix.dirname(rel));
    const candidates = [base, `${dir.replace(/s$/, '')}-${base}`];
    return candidates.find((name) => exampleNames.includes(name) && !/^state-/.test(name)) ?? null;
  }

  function staticFile(urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath).replace(/^\/+/, '');
    } catch {
      return null;
    }
    if (rel.includes('\0') || rel.split('/').some((part) => part === '..' || part === '')) return null;
    if (NOT_SERVED.has(rel) || !TYPES[path.extname(rel)]) return null;
    const full = path.join(VIEW, rel);
    if (!full.startsWith(VIEW + path.sep)) return null;
    try {
      return fs.statSync(full).isFile() ? { full, type: TYPES[path.extname(rel)] } : null;
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const boundPort = server.address().port;
    const host = String(req.headers.host ?? '');
    if (host !== `${HOST}:${boundPort}` && host !== `localhost:${boundPort}`) return sendJson(res, 403, { error: 'this server answers on 127.0.0.1 alone' });
    const url = new URL(req.url, `http://${HOST}:${boundPort}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'api') {
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, build });
      // The crossing a run would use, as the examples have it: supplied when
      // the finished clean example's crossing ran the AI2II capture.
      if (req.method === 'GET' && url.pathname === '/api/variants') {
        const done = runs.get(idOfKind('clean'))?.final?.state ?? null;
        const crossing = done?.steps?.find((st) => st.id === 'crossing');
        return sendJson(res, 200, { crossing: crossing?.variant === 'supplied' ? 'supplied' : 'fallback' });
      }
      if (req.method === 'GET' && url.pathname === '/api/labels') {
        try {
          // With no file named: the contract's label map and the view's own
          // words for the parts and the scenes, as the engine answers.
          if (labels === null) return sendJson(res, 200, labelMapBytes(JSON.parse(fs.readFileSync(path.join(VIEW, 'labels.json'), 'utf8'))));
          return sendJson(res, 200, fs.readFileSync(labels));
        } catch {
          return sendJson(res, 404, { error: 'no label map here' });
        }
      }
      if (parts[1] === 'runs') {
        if (req.method === 'POST' && parts.length === 2) {
          let kind;
          try {
            kind = JSON.parse((await readBody(req)) ?? 'null')?.kind;
          } catch {
            kind = undefined;
          }
          const id = typeof kind === 'string' ? idOfKind(kind) : null;
          if (!id) return sendJson(res, 400, { error: `${typeof kind === 'string' ? kind : 'a request with no kind'} is not a run kind of this build` });
          const run = runs.get(id);
          run.polls = 0;
          run.startedMs = Date.now();
          return sendJson(res, 200, { runId: id });
        }
        let id;
        try {
          id = decodeURIComponent(parts[2] ?? '');
        } catch {
          id = '';
        }
        const run = runs.get(id);
        if (!run) return sendJson(res, 404, { error: 'no such run here' });
        if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, runState(run));
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'offline-check') {
          if (!exampleNames.includes('offline-check.json')) return sendJson(res, 501, { error: 'offline check not wired' });
          const body = readExample('offline-check.json');
          return sendJson(res, 200, replay ? `${JSON.stringify(moved(run, JSON.parse(body.toString('utf8'))), null, 2)}\n` : body);
        }
        if (req.method === 'GET' && parts[3] === 'files' && parts.length > 4) {
          let rel;
          try {
            rel = parts.slice(4).map(decodeURIComponent).join('/');
          } catch {
            rel = '';
          }
          const name = rel && !rel.split('/').includes('..') ? exampleFor(rel) : null;
          if (!name) return sendJson(res, 404, { error: 'no such file among the examples' });
          const body = readExample(name);
          if (/\.json$/.test(name)) return sendJson(res, 200, replay ? `${JSON.stringify(moved(run, JSON.parse(body.toString('utf8'))), null, 2)}\n` : body);
          return send(res, 200, /\.aep$/.test(name) ? 'application/zip' : TYPES['.txt'], body);
        }
      }
      return sendJson(res, 404, { error: 'no such route' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const file = staticFile(url.pathname);
    if (!file) return send(res, 404, TYPES['.txt'], 'not found\n');
    return send(res, 200, file.type, req.method === 'HEAD' ? '' : fs.readFileSync(file.full));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  return {
    port: server.address().port,
    url: `http://${HOST}:${server.address().port}/`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const port = Number(option(argv, '--port') ?? process.env.PORT ?? 0);
  const speed = Number(option(argv, '--speed') ?? 1);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !(speed > 0)) {
    process.stderr.write('usage: node three-party/view/dev-server.mjs [--port <n>] [--examples <dir>] [--labels <file>] [--replay [--speed <n>]]\n');
    process.exit(2);
  }
  const server = await startDevServer({
    port,
    examples: option(argv, '--examples') ? path.resolve(option(argv, '--examples')) : undefined,
    labels: option(argv, '--labels') ? path.resolve(option(argv, '--labels')) : undefined,
    replay: argv.includes('--replay'),
    speed,
  });
  process.stdout.write(`Ready. Open ${server.url} in a browser.\n`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
