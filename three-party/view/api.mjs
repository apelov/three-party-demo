// The run API of the contract, section 7, as this page uses it. A 404 or a
// 501 on a file, on the label map or on the offline check means the thing is
// absent in this build: the caller leaves the element out. It is never shown
// as an error page.

const ABSENT = new Set([404, 501]);

const seg = (s) => encodeURIComponent(s);
const runUrl = (id) => `/api/runs/${seg(id)}`;
export const fileUrl = (id, rel) => `${runUrl(id)}/files/${String(rel).split('/').map(seg).join('/')}`;

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Let go of an answer this page will not read. A body left unread keeps its
// connection busy, and the browser allows a handful per host: a few of them
// would hold up every later request.
async function release(res) {
  try {
    await res.body?.cancel();
  } catch {
    // Already read or already closed.
  }
  return null;
}

// Start a run. Resolves to { runId } or, when the server refuses, to
// { error } holding the server's own words.
export async function startRun(kind) {
  let res;
  try {
    res = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
  } catch {
    return { error: null };
  }
  const body = await readJson(res);
  if (res.ok && body && typeof body.runId === 'string') return { runId: body.runId };
  return { error: body && typeof body.error === 'string' ? body.error : null };
}

// The run state, or null when it cannot be read right now.
export async function getRun(id) {
  try {
    const res = await fetch(runUrl(id), { cache: 'no-store' });
    return res.ok ? await readJson(res) : release(res);
  } catch {
    return null;
  }
}

// The label map the server holds, or null when it serves none.
export async function getLabels() {
  try {
    const res = await fetch('/api/labels', { cache: 'no-store' });
    return res.ok ? await readJson(res) : release(res);
  } catch {
    return null;
  }
}

// Run the offline check. Resolves to its result, or null when the server
// does not offer it.
export async function runOfflineCheck(id) {
  try {
    const res = await fetch(`${runUrl(id)}/offline-check`, { method: 'POST' });
    if (ABSENT.has(res.status) || !res.ok) return release(res);
    return await readJson(res);
  } catch {
    return null;
  }
}

// A file of the run: { kind: 'json', value, text } for JSON, { kind: 'text',
// text } for text, { kind: 'zip', bytes } for a package, or null when absent.
export async function getFile(id, rel) {
  let res;
  try {
    res = await fetch(fileUrl(id, rel), { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return release(res);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (type === 'application/zip' || /\.aep$/.test(rel)) return { kind: 'zip', bytes: new Uint8Array(await res.arrayBuffer()) };
  const text = await res.text();
  if (type === 'application/json' || /\.json$/.test(rel)) {
    try {
      return { kind: 'json', value: JSON.parse(text), text };
    } catch {
      return { kind: 'text', text };
    }
  }
  return { kind: 'text', text };
}
