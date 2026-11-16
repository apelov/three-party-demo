// The run API of CONTRACT.md section 7, on 127.0.0.1. JSON, no sign in: it
// is a local demo, and the listener is bound to the loopback address. Every
// request must name this listener as its Host, and a request that carries an
// Origin must come from this listener's own pages (src/http.mjs
// hostAndOriginAllowed), so another web page open in the same browser cannot
// start a run or read one.
//
//   POST /api/runs                         {"kind":"clean"|"poisoned"} -> {"runId"}
//   GET  /api/runs/<runId>                 state.json
//   GET  /api/runs/<runId>/files/<path>    a file of the run directory
//   POST /api/runs/<runId>/offline-check   offline-check.json when the offline
//                                          check wrote one; else what the check
//                                          returned (its exit status, its lines,
//                                          its notes); 501 when the caller
//                                          wired none
//   GET  /api/health                       {"ok":true,"build":<short sha>}
//   GET  /api/variants                     {"crossing":"supplied"|"fallback"}: the form of
//                                          each part with variants that a run
//                                          started now would use, by the same
//                                          check of the AI2II files a run makes
//   GET  /api/labels                       the contract's label map, three-party/labels.json;
//                                          with the screens, the screens' own
//                                          words are added to it and no value
//                                          of the map is changed
//   GET  /                                 the screens (the files of the view
//                                          directory); one line of text when
//                                          the caller gave no view directory
//
// The command line starts the API with the screens and with the offline
// check of three-party/src/record wired (bin/start.mjs). Started with
// neither, as the tests of the API alone do, it answers the one line and
// the 501.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildInfo } from '../../../src/build-info.mjs';
import { close, hostAndOriginAllowed, listen, readJson, sendJson } from '../../../src/http.mjs';
import { labelMapBytes } from './label-map.mjs';
import { LABELS } from './labels.mjs';
import { DEFAULT_PACE_SECONDS, DEFAULT_RUNS_DIR, startRun } from './run.mjs';
import { AI2II_SOURCE, DEFAULT_AI2II_DIR, loadCapture } from './ai2ii-source.mjs';
import { LABELS_FILE, SCREEN_POLICY, screenFile } from './screens.mjs';
import { RUN_ID, RUN_KINDS } from './store.mjs';

export const DEFAULT_PORT = 7390;
// Without --port the listener takes 7390, or the next free port up to this many above it.
const PORT_SEARCH = 20;
const MAX_ACTIVE_RUNS = 4;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// The body of POST /api/runs is one short JSON object.
const MAX_BODY_BYTES = 4096;

const TYPES = Object.freeze({
  '.json': 'application/json; charset=utf-8',
  '.aep': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.pem': 'text/plain; charset=utf-8',
});

// The files of keys/ a client may read: the public key and the note beside
// it. The run's private test key is never served.
const READABLE_KEY_FILES = Object.freeze(['keys/test-signer.pub.pem', 'keys/TEST-KEY.txt']);

function sendBytes(res, status, type, bytes) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(bytes);
}

// A file of the view, with the policy that keeps the page to this origin.
// A HEAD request gets the headers of the file and no body.
function sendScreen(req, res, { file, type }) {
  const bytes = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': SCREEN_POLICY,
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

// The file a request path names inside a run directory, or null: every
// segment a plain name (no empty segment, no dot segment, no name that
// starts with a dot, no backslash), the file a regular file whose resolved
// path is still inside the run directory, and not a private key.
export function fileInRun(runDir, relative) {
  const segments = relative.split('/');
  if (segments.length === 0 || segments.some((s) => s === '' || s.startsWith('.') || /[\\\0]/.test(s))) return null;
  const rel = segments.join('/');
  if (segments[0] === 'keys' && !READABLE_KEY_FILES.includes(rel)) return null;
  const file = path.join(runDir, ...segments);
  let real;
  let root;
  try {
    real = fs.realpathSync(file);
    root = fs.realpathSync(runDir);
  } catch {
    return null;
  }
  if (!real.startsWith(`${root}${path.sep}`)) return null;
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return real;
}

// Starts the API. With `port` the listener takes that port or fails; with
// none it takes DEFAULT_PORT or the next free loopback port above it.
// `offlineCheck`, when the caller passes one, is called with a run directory
// and returns the object the offline check route answers. `viewDir`, when
// the caller passes one, is the directory of the screens: its files are
// served from `/` on, and its words are added to the label map that
// /api/labels answers. `build` is the short
// sha /api/health names; left out, it is the commit of the git clone, or null.
// `runOptions` are passed to every run the API starts (the tests use it).
export async function startApi({ port = null, runsDir = DEFAULT_RUNS_DIR, paceSeconds = DEFAULT_PACE_SECONDS, offlineCheck = null, viewDir = null, build = buildInfo().sha7, runOptions = {} } = {}) {
  const active = new Map();
  let boundPort = null;

  const runDirOf = (runId) => (RUN_ID.test(runId) && fs.existsSync(path.join(runsDir, runId, 'state.json')) ? path.join(runsDir, runId) : null);

  const route = async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const p = url.pathname;
    const get = req.method === 'GET';
    const post = req.method === 'POST';

    if (p === '/' && viewDir === null) {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      return sendBytes(res, 200, 'text/plain; charset=utf-8', Buffer.from(`${LABELS.cli.rootText}\n`, 'utf8'));
    }
    if (viewDir !== null && !p.startsWith('/api/')) {
      if (!get && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      // A browser asks for a page's icon by itself. The view has none, and
      // the answer says so with no body, which a browser does not report.
      if (p === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      const screen = screenFile(viewDir, p);
      if (!screen) return sendJson(res, 404, { error: 'not found' });
      return sendScreen(req, res, screen);
    }
    if (p === '/api/labels') {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      // The contract's label map. With the screens, their own words for the
      // parts and the scenes are added from the view's file.
      const words = viewDir === null ? null : JSON.parse(fs.readFileSync(path.join(viewDir, LABELS_FILE), 'utf8'));
      return sendBytes(res, 200, TYPES['.json'], labelMapBytes(words));
    }
    if (p === '/api/health') {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, { ok: true, build });
    }
    if (p === '/api/variants') {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      // The crossing a run started now would use: the AI2II capture when its
      // three files are there and match their pins, else the fallback. The
      // same check a run makes, with the same options, at each request.
      const capture = loadCapture({ dir: runOptions.ai2iiDir ?? DEFAULT_AI2II_DIR, source: runOptions.ai2iiSource ?? AI2II_SOURCE });
      return sendJson(res, 200, { crossing: capture.use ? 'supplied' : 'fallback' });
    }
    if (p === '/api/runs') {
      if (!post) return sendJson(res, 405, { error: 'method not allowed' });
      // A body that states a length above the limit is refused before it is
      // read. One that runs past the limit without stating its length is cut
      // off by readJson, which ends the connection.
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return sendJson(res, 413, { error: 'the body is too large' });
      let body;
      try {
        body = await readJson(req, MAX_BODY_BYTES);
      } catch {
        return sendJson(res, 400, { error: 'the body is not JSON' });
      }
      const kind = body?.kind;
      if (!RUN_KINDS.includes(kind)) return sendJson(res, 400, { error: 'kind must be clean or poisoned' });
      if (active.size >= MAX_ACTIVE_RUNS) return sendJson(res, 429, { error: 'too many runs in progress' });
      const run = await startRun({ ...runOptions, kind, paceSeconds, runsDir });
      active.set(run.runId, run);
      run.done.finally(() => active.delete(run.runId));
      return sendJson(res, 200, { runId: run.runId });
    }

    const m = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return sendJson(res, 404, { error: 'not found' });
    const runDir = runDirOf(m[1]);
    if (!runDir) return sendJson(res, 404, { error: 'no such run' });
    const rest = m[2];

    if (rest === undefined) {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      return sendBytes(res, 200, TYPES['.json'], fs.readFileSync(path.join(runDir, 'state.json')));
    }
    if (rest === 'offline-check') {
      if (!post) return sendJson(res, 405, { error: 'method not allowed' });
      if (!offlineCheck) return sendJson(res, 501, { error: 'offline check not wired' });
      // The answer is what the wired check gives, whatever the check's exit
      // status: the result it wrote, or the state it ended in when it wrote
      // none. Both answer 200, not an error.
      return sendJson(res, 200, await offlineCheck(runDir));
    }
    if (rest.startsWith('files/')) {
      if (!get) return sendJson(res, 405, { error: 'method not allowed' });
      let relative;
      try {
        relative = decodeURIComponent(rest.slice('files/'.length));
      } catch {
        return sendJson(res, 400, { error: 'the file path is not readable' });
      }
      const file = fileInRun(runDir, relative);
      if (!file) return sendJson(res, 404, { error: 'no such file' });
      return sendBytes(res, 200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
    }
    return sendJson(res, 404, { error: 'not found' });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const origins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
      if (!hostAndOriginAllowed(req, { port: boundPort, origins })) {
        sendJson(res, 403, { error: 'request refused' });
        return;
      }
      await route(req, res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'the request could not be answered' });
      else res.destroy();
    }
  });

  if (port !== null) {
    boundPort = await listen(server, port);
  } else {
    for (let candidate = DEFAULT_PORT; boundPort === null; candidate += 1) {
      try {
        boundPort = await listen(server, candidate);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || candidate >= DEFAULT_PORT + PORT_SEARCH) throw err;
      }
    }
  }

  return {
    port: boundPort,
    address: server.address().address,
    build,
    activeRuns: () => [...active.keys()],
    // Waits for the runs in progress to end.
    idle: () => Promise.all([...active.values()].map((run) => run.done)),
    async stop() {
      await Promise.all([...active.values()].map((run) => run.abort()));
      await close(server);
    },
  };
}
