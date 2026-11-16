// The right pane. For a step: a one-line head (the step's number, its part
// and its state), the step in the words of the lens, then three sections in
// the order the lens gives: what was checked (one sentence from the run),
// the artifact (the fields the run carries, set out as a ruled list, and in
// Inspect the files as written) and the record (this step's Action Evidence
// Package and, once audited, its verdict). In Story the lens's first section
// is open; in Inspect every section is. A field the run does not carry is
// left out.

import { el, put, add, from, value, fieldName, at, timeEl, clear, camel } from './dom.mjs';
import { stateOf, chip, badge, copyButton, countdown, compare, headlineOf, partOf, shownPart, partMark, creditOf, detailOf, lensOf, lensStepLine, baseId, columnsOf } from './parts.mjs';
import { offlineOf } from './flow.mjs';
import { fileUrl } from './api.mjs';
import { iconEl } from './icons.mjs';
import { OFFLINE_KIND } from './constants.mjs';

const dirOf = (rel) => (String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/') + 1) : '');

// ---- Small builders

// One row of a key and value list. The key is a copy word when the deck has
// one for the field, and the run's own field name otherwise.
function row(key, ...values) {
  const body = values.flat(3).filter(Boolean);
  if (!key || !body.length) return null;
  return el('div', { class: 'kv-row' }, put('dt', key.src.startsWith('copy:') ? 'kv-key' : 'kv-key mono', key), el('dd', { class: 'kv-value' }, body));
}

function table(...rows) {
  const body = rows.flat(3).filter(Boolean);
  return body.length ? el('dl', { class: 'kv' }, body) : null;
}

function plain(root, path, source, cls) {
  return row(fieldName(root, path, source), put('span', cls ?? null, value(root, path, undefined, source)));
}

function moment(root, path, source) {
  return row(fieldName(root, path, source), timeEl('num', value(root, path, undefined, source)));
}

// A hash or an id: in Story the leading 16 characters with the full value in
// the title, in Inspect the full value; a copy control beside it.
function token(app, root, path, source = from.run, short = true) {
  const full = at(root, path);
  if (full === null || full === undefined || full === '') return null;
  const cut = short && app.mode === 'story' && /^[0-9a-f]{17,}$/.test(String(full));
  return [
    put('span', 'mono', value(root, path, cut ? 'hex16' : undefined, source), cut ? { title: String(full) } : null),
    copyButton(app, full, source(path).replace(/^run:/, '')),
  ];
}

// The key of a row: the deck's plain word in Story, the run's own field name in Inspect.
function keyOf(app, wordKey, root, path) {
  return (app.mode === 'story' ? app.w.word(wordKey) : null) ?? fieldName(root, path);
}

function hashRow(app, root, path, source) {
  return row(fieldName(root, path, source), token(app, root, path, source));
}

function verdictWord(app, flag, source, yesKey, noKey) {
  if (flag === null || flag === undefined) return null;
  return put('span', null, app.w.chosen(flag ? yesKey : noKey, source));
}

// A verdict: its icon and its word, in its tone.
function verdictEl(tone, icon, words, extra) {
  return words ? el('span', { class: 'verdict', data: { tone, ...extra } }, iconEl(icon), put('span', null, words)) : null;
}

// ---- Files of the run, as written (Inspect)

function artifact(app, rel, pathWords) {
  if (app.mode !== 'inspect' || !rel) return null;
  const entry = app.fileOf(rel);
  if (!entry || entry.state !== 'ready' || entry.file.kind === 'zip') return null;
  const isJson = entry.file.kind === 'json';
  return el('div', { class: 'artifact', data: { file: rel } },
    el('a', { class: 'artifact-path', href: fileUrl(app.runId, rel), src: pathWords.src, text: pathWords.text, data: { focusKey: `file:${rel}` } }),
    put('span', 'meta', app.w.label('parties.rawIdentifiersNote')),
    el('pre', { class: 'artifact-body', tabindex: '0', src: from.file(rel, '', isJson ? 'json' : undefined), text: isJson ? JSON.stringify(entry.file.value, null, 2) : entry.file.text, data: { focusKey: `body:${rel}` } }));
}

// The step as the run state holds it, under the same note on test
// identifiers as a file of the run.
function stateExcerpt(app, i) {
  if (app.mode !== 'inspect') return null;
  const detail = app.run.steps[i].detail;
  if (detail === null || detail === undefined) return null;
  return el('div', { class: 'artifact', data: { file: 'state' } },
    el('a', { class: 'artifact-path', href: `/api/runs/${encodeURIComponent(app.runId)}`, src: from.run(`steps[${i}].id`), text: String(app.run.steps[i].id), data: { focusKey: `state:${i}` } }),
    put('span', 'meta', app.w.label('parties.rawIdentifiersNote')),
    el('pre', { class: 'artifact-body', tabindex: '0', src: from.run(`steps[${i}].detail`, 'json'), text: JSON.stringify(detail, null, 2), data: { focusKey: `statebody:${i}` } }));
}

function actionArtifact(app, i) {
  const rel = app.run.steps[i].actionFile;
  return rel ? artifact(app, rel, value(app.run, `steps[${i}].actionFile`)) : null;
}

function files(...panes) {
  const body = panes.flat(3).filter(Boolean);
  return body.length ? el('div', { class: 'artifacts', data: { artifacts: 'yes' } }, body) : null;
}

// ---- Sections

// A section of the inspector: a disclosure with its heading. In Inspect it
// is open; in Story the lens's first section is open, and a section the
// reader opened or closed stays so while the selection stays.
function section(app, id, titleKey, ...kids) {
  const body = kids.flat(3).filter(Boolean);
  if (!body.length) return null;
  const chosen = app.inspectorOpen.get(id);
  // The limits stay closed until asked for, in either mode.
  const evidence = id === 'artifact' && app.selection.kind === 'step' && app.run?.steps[app.selection.index]?.status === 'blocked';
  const open = chosen ?? (id !== 'limits' && (app.sectionFirst === id || evidence || (app.mode === 'inspect' && app.run !== null)));
  const node = el('details', { class: 'insp-section', data: { section: id }, open: open ? true : null },
    el('summary', { class: 'insp-section-head', data: { focusKey: `section:${id}` } }, put('span', 'insp-section-title', app.w.word(titleKey))),
    el('div', { class: 'insp-section-body' }, body));
  node.addEventListener('toggle', () => app.inspectorOpen.set(id, node.open));
  return node;
}

// The sections in the order the lens gives.
function ordered(app, byId) {
  const order = lensOf(app).sections ?? ['checked', 'artifact', 'record'];
  const ids = [...order, ...Object.keys(byId).filter((id) => !order.includes(id))];
  return ids.map((id) => byId[id] ?? null);
}

// ---- What was checked: one sentence from the run

function checkedSentence(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const id = baseId(step.id);
  if (step.status === 'not-reached') return app.w.word('detail.notRun');
  if (step.status === 'pending' || step.status === 'running') return null;
  if (id === 'credential') {
    const version = d.verifier ? [String(d.verifier).slice(String(d.verifier).lastIndexOf(' ') + 1), from.run(`${base}.verifier`, 'afterLastSpace')] : null;
    if (!version || d.valid === null || d.valid === undefined) return null;
    return app.w.line(d.valid === true ? 'check.credentialValid' : 'check.credentialInvalid', { version });
  }
  if (id === 'grant') {
    const g = run.grant ?? {};
    const max = g.maximumIndividualAmount ?? {};
    return app.w.lineNodes('check.grant', {
      scope: [g.scope, from.run('grant.scope')],
      amount: [max.amount, from.run('grant.maximumIndividualAmount.amount')],
      currency: [max.currency, from.run('grant.maximumIndividualAmount.currency')],
      ttl: [g.ttlSeconds, from.run('grant.ttlSeconds')],
    }, ['scope']);
  }
  if (id === 'crossing') {
    if (d.capture?.used === true) return value(run, `${base}.capture.summary`);
    return app.w.line('check.crossing', {
      domainA: [app.labels.parties?.domainA, from.labels('parties.domainA')],
      domainB: [app.labels.parties?.domainB, from.labels('parties.domainB')],
      hops: [d.hops, from.run(`${base}.hops`)],
      outcome: [d.outcome, from.run(`${base}.outcome`)],
    });
  }
  if (id === 'intent') return value(run, `${base}.rule`) ?? app.w.word('intent.rule');
  if (id === 'pay') {
    return app.w.lineNodes('check.pay', {
      status: [d.httpStatus, from.run(`${base}.httpStatus`)],
      paymentId: [d.paymentId, from.run(`${base}.paymentId`)],
      amount: [d.amount, from.run(`${base}.amount`)],
      currency: [d.currency, from.run(`${base}.currency`)],
      account: [d.payeeAccount, from.run(`${base}.payeeAccount`)],
    }, ['paymentId', 'account']);
  }
  if (id === 'record') return app.w.line('check.record', { written: [d.written, from.run(`${base}.written`)] });
  return null;
}

// ---- The artifact, one builder per step of the contract

function credentialArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const algorithm = d.algorithm ? app.w.line('inspector.signature', { algorithm: [d.algorithm, from.run(`${base}.algorithm`)] }) : app.w.beforeParen('inspector.signature');
  return [
    table(
      plain(run, 'agent.credentialFile', from.run, 'mono'),
      hashRow(app, run, 'agent.credentialSha256'),
      plain(run, `${base}.verifier`, from.run, 'mono'),
      d.valid === null || d.valid === undefined ? null : row(algorithm, verdictWord(app, d.valid === true, from.run(`${base}.valid`), 'inspector.signatureValid', 'state.stopped')),
      moment(run, `${base}.notBefore`),
      moment(run, `${base}.notAfter`),
      plain(run, `${base}.postQuantumSignature`)),
    files(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function grantArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const g = run.grant;
  const max = g?.maximumIndividualAmount;
  const accounts = Array.isArray(g?.creditorAccounts) ? g.creditorAccounts : [];
  const checked = Array.isArray(d.scopeChecked) ? d.scopeChecked : [];
  const inspect = app.mode === 'inspect';
  return [
    table(
      plain(run, 'grant.scope', from.run, 'mono'),
      max ? row(fieldName(run, 'grant.maximumIndividualAmount'), put('span', 'num', app.w.line('invoice.amountValue', { amount: [max.amount, from.run('grant.maximumIndividualAmount.amount')], currency: [max.currency, from.run('grant.maximumIndividualAmount.currency')] }))) : null,
      accounts.length ? row(fieldName(run, 'grant.creditorAccounts'), el('span', { class: 'kv-list' }, accounts.map((_, n) => put('span', 'mono', value(run, `grant.creditorAccounts[${n}]`))))) : null,
      plain(run, 'grant.ttlSeconds', from.run, 'num'),
      g && step.status === 'passed' ? row(app.w.word('inspector.lifetime'), countdown(app)) : null,
      inspect ? moment(run, 'grant.issuedAt') : null,
      inspect ? moment(run, 'grant.expiresAt') : null,
      inspect ? plain(run, 'grant.tokenType') : null,
      inspect && checked.length ? row(fieldName(run, `${base}.scopeChecked`), el('span', { class: 'kv-list' }, checked.map((_, n) => put('span', 'mono', value(run, `${base}.scopeChecked[${n}]`))))) : null),
    files(stateExcerpt(app, i), d.grantFile ? artifact(app, d.grantFile, value(run, `${base}.grantFile`)) : null, actionArtifact(app, i)),
  ];
}

const ANSWERS = { pass: 'capture.pass', fail: 'capture.fail', 'not-run': 'capture.notRun' };

// The crossing over the AI2II capture: one line per check, with its answer
// and what it shows, then the check's scope, its source and the files by
// SHA-256. Every word but the answer's is the run's.
function captureArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail.capture`;
  const c = step.detail.capture;
  const states = app.labels.states ?? {};
  const checks = Array.isArray(c.checks) ? c.checks : [];
  const p = (path) => `${base}.${path}`;
  return [
    el('ul', { class: 'checks', data: { capture: 'checks' } }, checks.map((check, n) => {
      const pass = check.answer === 'pass';
      const words = app.w.chosen(ANSWERS[check.answer] ?? 'capture.fail', from.run(p(`checks[${n}].answer`))) ?? value(run, p(`checks[${n}].answer`));
      return el('li', { class: 'check', data: { captureCheck: String(n), answer: String(check.answer) } },
        verdictEl(pass ? 'ok' : check.answer === 'not-run' ? 'muted' : 'stop', pass ? states.passed?.icon : check.answer === 'not-run' ? states['not-reached']?.icon : states.blocked?.icon, words),
        put('span', 'mono check-name', value(run, p(`checks[${n}].name`))),
        put('span', 'check-claim', value(run, p(`checks[${n}].claim`))),
        check.reason ? put('span', 'check-claim', value(run, p(`checks[${n}].reason`))) : null);
    })),
    (Array.isArray(c.scope) ? c.scope : []).map((_, n) => put('p', 'insp-note', value(run, p(`scope[${n}]`)), { 'data-note': 'scope' })),
    table(
      plain(run, p('source.repo'), from.run, 'mono'),
      row(fieldName(run, p('source.commit')), token(app, run, p('source.commit'))),
      (Array.isArray(c.files) ? c.files : []).map((_, n) => row(value(run, p(`files[${n}].name`)), token(app, run, p(`files[${n}].sha256`)))),
      c.token ? row(fieldName(run, p('token.sha256')), token(app, run, p('token.sha256'))) : null),
    files(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function crossingArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  if (d.capture?.used === true) return captureArtifact(app, i, step);
  const hop = d.hopFile ? app.fileOf(d.hopFile) : null;
  const hopDoc = hop?.state === 'ready' && hop.file.kind === 'json' ? hop.file.value : null;
  const hopSource = (path, shape) => from.file(d.hopFile, path, shape);
  const { col } = partOf(app, step.id);
  const shown = shownPart(app, col);
  return [
    table(
      d.from ? row(fieldName(run, `${base}.from`), put('span', null, app.w.label('parties.domainA'))) : null,
      d.to ? row(fieldName(run, `${base}.to`), put('span', null, app.w.label('parties.domainB'))) : null,
      plain(run, `${base}.hops`, from.run, 'num'),
      plain(run, `${base}.outcome`),
      plain(run, `${base}.stepsRun`),
      plain(run, `${base}.chainFile`, from.run, 'mono'),
      hopDoc ? hashRow(app, hopDoc, 'chainSha256', hopSource) : null,
      // An AI2II capture that was there and not used: why.
      d.capture?.reason ? plain(run, `${base}.capture.reason`) : null),
    shown.part?.standIn ? put('p', 'insp-note', app.w.label(`${shown.path}.standInNote`), { 'data-note': 'stand-in' }) : null,
    shown.part?.standIn ? put('p', 'insp-note', app.w.label(`${shown.path}.missingNote`), { 'data-note': 'missing' }) : null,
    put('p', 'insp-note', detailOf(app, col), { 'data-note': 'detail' }),
    files(stateExcerpt(app, i), d.hopFile ? artifact(app, d.hopFile, value(run, `${base}.hopFile`)) : null, actionArtifact(app, i)),
  ];
}

function intentArtifact(app, i) {
  return [
    compare(app, i),
    table(plain(app.run, `steps[${i}].detail.result`, from.run, 'mono')),
    files(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function payArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const rel = step.actionFile;
  const action = rel ? app.fileOf(rel) : null;
  const doc = action?.state === 'ready' && action.file.kind === 'json' ? action.file.value : null;
  const actionSource = (path, shape) => from.file(rel, path, shape);
  const bodyRel = doc?.response?.bodyFile ? `${dirOf(rel)}${doc.response.bodyFile}` : null;
  const bodyWords = bodyRel ? { text: bodyRel, src: from.file(rel, 'response.bodyFile', 'beside') } : null;
  return [
    table(
      plain(run, `${base}.endpoint`, from.run, 'mono'),
      plain(run, `${base}.httpStatus`, from.run, 'num'),
      d.paymentId ? row(fieldName(run, `${base}.paymentId`), token(app, run, `${base}.paymentId`)) : null,
      d.amount ? row(fieldName(run, `${base}.amount`), put('span', 'num', app.w.line('invoice.amountValue', { amount: [d.amount, from.run(`${base}.amount`)], currency: [d.currency, from.run(`${base}.currency`)] }))) : null,
      plain(run, `${base}.payeeAccount`, from.run, 'mono'),
      d.recordedByBank === null || d.recordedByBank === undefined ? null : row(fieldName(run, `${base}.recordedByBank`), put('span', null, { text: String(d.recordedByBank), src: from.run(`${base}.recordedByBank`) })),
      doc?.decision ? row(fieldName(doc, 'decision', actionSource), put('span', null, app.w.chosen(`decision.${doc.decision}`, actionSource('decision')) ?? value(doc, 'decision', undefined, actionSource))) : null,
      doc?.response?.bodySha256 ? row(fieldName(doc, 'response.bodySha256', actionSource),
        token(app, doc, 'response.bodySha256', actionSource),
        bodyRel && app.mode === 'inspect' ? el('a', { class: 'record-file mono', href: fileUrl(app.runId, bodyRel), src: bodyWords.src, text: bodyWords.text, data: { focusKey: `link:${bodyRel}` } }) : null) : null),
    files(stateExcerpt(app, i), actionArtifact(app, i), bodyRel ? artifact(app, bodyRel, bodyWords) : null),
  ];
}

function recordArtifact(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const rel = step.recordFile;
  const entry = rel ? app.fileOf(rel) : null;
  const manifest = entry?.state === 'ready' && entry.file.kind === 'json' ? entry.file.value : null;
  const mSource = (path, shape) => from.file(rel, path, shape);
  const stamp = String(d.timestampEntry ?? '');
  const stampNote = stamp === '' ? null : (stamp.startsWith('stand-in') ? app.w.label('timestamp.standInNote') : app.w.label('timestamp.testAuthorityNote'));
  const commit = d.format ? [(/[0-9a-f]{40}/.exec(String(d.format)) ?? [''])[0].slice(0, 8), from.run(`${base}.format`, 'commit8')] : null;
  return [
    table(
      plain(run, `${base}.written`, from.run, 'num'),
      commit ? row(app.w.word('record.format'), put('span', null, app.w.lineNodes('record.formatValue', { formatCommit: commit }, ['formatCommit']))) : null,
      d.signer ? row(app.w.word('record.signer'), put('span', null, app.w.chosen('record.signerValue', from.run(`${base}.signer`)))) : null,
      stampNote ? row(app.w.word('record.timestamp'), put('span', null, stampNote, { 'data-note': 'timestamp' })) : null,
      manifest ? plain(manifest, 'signerPublicKey', mSource, 'mono') : null,
      manifest ? hashRow(app, manifest, 'signerSha256', mSource) : null,
      manifest ? hashRow(app, manifest, 'credentialSha256', mSource) : null),
    d.credentialCitedBy ? put('p', 'insp-note', app.w.chosen('record.credentialNote', from.run(`${base}.credentialCitedBy`))) : null,
    put('p', 'insp-note', detailOf(app, 'record'), { 'data-note': 'detail' }),
    files(stateExcerpt(app, i), rel ? artifact(app, rel, value(run, `steps[${i}].recordFile`)) : null),
  ];
}

function genericArtifact(app, i, step) {
  const base = `steps[${i}].detail`;
  const d = step.detail && typeof step.detail === 'object' ? step.detail : {};
  const simple = Object.keys(d).filter((k) => ['string', 'number', 'boolean'].includes(typeof d[k]));
  return [
    table(simple.map((k) => row(fieldName(app.run, `${base}.${k}`), put('span', null, { text: String(d[k]), src: from.run(`${base}.${k}`) })))),
    files(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

const ARTIFACTS = { credential: credentialArtifact, grant: grantArtifact, crossing: crossingArtifact, intent: intentArtifact, pay: payArtifact, record: recordArtifact };

// ---- The record of a step

// The records manifest of the run, once the record step has written it.
export function manifestOf(app) {
  const run = app.run;
  const writer = run ? run.steps.findIndex((s) => baseId(s.id) === 'record' && s.recordFile) : -1;
  if (writer < 0) return null;
  const rel = run.steps[writer].recordFile;
  const entry = app.fileOf(rel);
  const manifest = entry?.state === 'ready' && entry.file.kind === 'json' ? entry.file.value : null;
  return manifest ? { manifest, rel, source: (path, shape) => from.file(rel, path, shape) } : null;
}

// The verifier's own steps on one package, once a revision of the contract
// adds checks to a record row of the offline check: a list with each name and
// its value, as the check wrote them. A step set out as an object gives one
// row per field; a row with no checks gives no list.
export function checksOf(rec, source) {
  const checks = rec?.checks;
  if (!checks || typeof checks !== 'object') return null;
  const scalar = (v) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '';
  const named = (key) => /^[A-Za-z0-9_-]+$/.test(key);
  const pathIn = (node, base, key) => (Array.isArray(node) ? `${base}[${key}]` : `${base}.${key}`);
  const items = [];
  for (const key of Object.keys(checks).filter(named)) {
    const path = pathIn(checks, 'checks', key);
    const item = checks[key];
    const fields = scalar(item) ? [path]
      : item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).filter((f) => named(f) && scalar(item[f])).map((f) => `${path}.${f}`)
        : [];
    const rows = table(fields.map((p) => plain(rec, p, source)));
    if (rows) items.push(el('li', null, rows));
  }
  return items.length ? el('ul', { class: 'kv-list checks' }, items) : null;
}

// The verdict of the offline check on one package, in the deck's words.
export function auditVerdict(app, rec, source, tampered) {
  if (!rec) return null;
  const states = app.labels.states ?? {};
  const pass = rec.verdict === 'pass-1-6';
  const words = pass ? app.w.chosen('offline.pass', source('verdict')) : app.w.line('offline.reject', { n: [rec.firstFailingStep, source('firstFailingStep')] });
  // A tampered copy the verifier rejected is shown rejected, in the stop's
  // ink; the line beside it says that this was expected.
  const tone = pass ? (tampered ? 'warn' : 'ok') : 'stop';
  return verdictEl(tone, pass ? states.passed?.icon : states.blocked?.icon, words, { verdict: String(rec.verdict) });
}

function recordOfStep(app, i, step) {
  const run = app.run;
  if (baseId(step.id) === 'record') {
    const found = manifestOf(app);
    if (!found) return null;
    const { manifest, source } = found;
    const offline = offlineOf(app);
    const list = (kind) => (Array.isArray(manifest[kind]) ? manifest[kind] : []).map((item, n) => {
      const check = Array.isArray(offline?.[kind]) ? offline[kind].findIndex((r) => r.file === item.file) : -1;
      const cSource = (p, shape) => from.doc('offline-check', `${kind}[${check}].${p}`, shape);
      return el('div', { class: 'record', data: { file: String(item.file), kind } },
        el('a', { class: 'record-file mono', href: fileUrl(app.runId, item.file), src: source(`${kind}[${n}].file`), text: String(item.file), data: { focusKey: `link:${item.file}` } }),
        kind === 'tampered' ? put('span', 'record-flag', app.w.word('offline.tampered')) : null,
        check >= 0 ? auditVerdict(app, offline[kind][check], cSource, kind === 'tampered') : null,
        check >= 0 ? checksOf(offline[kind][check], cSource) : null);
    });
    return el('div', { class: 'records' }, list('records'), list('tampered'));
  }
  // A step not yet decided has its record to come; a step that did not run has none.
  if (step.status === 'pending' || step.status === 'running') return put('p', 'insp-note', app.w.word('insp.notSigned'));
  if (!step.actionFile && !step.recordFile) return put('p', 'insp-note', app.w.word('insp.noRecord'));
  if (!step.recordFile) return put('p', 'insp-note', app.w.word('insp.notSigned'));
  const found = manifestOf(app);
  const n = found && Array.isArray(found.manifest.records) ? found.manifest.records.findIndex((r) => r.file === step.recordFile) : -1;
  const writer = run.steps.findIndex((s) => baseId(s.id) === 'record');
  const signer = writer >= 0 ? run.steps[writer].detail?.signer : null;
  const offline = offlineOf(app);
  const check = Array.isArray(offline?.records) ? offline.records.findIndex((r) => r.file === step.recordFile) : -1;
  const cSource = (p, shape) => from.doc('offline-check', `records[${check}].${p}`, shape);
  return [
    table(
      row(app.w.word('insp.file'), el('a', { class: 'record-file mono', href: fileUrl(app.runId, step.recordFile), src: from.run(`steps[${i}].recordFile`), text: String(step.recordFile), data: { focusKey: `link:${step.recordFile}` } })),
      n >= 0 ? row(app.w.word('insp.sha'), token(app, found.manifest, `records[${n}].sha256`, found.source)) : null,
      signer ? row(app.w.word('insp.signedBy'), put('span', null, app.w.chosen('record.signerValue', from.run(`steps[${writer}].detail.signer`)))) : null,
      row(app.w.word('insp.audit'), check >= 0 ? auditVerdict(app, offline.records[check], cSource, false) : put('span', 'muted', app.w.word('insp.notAudited'))),
      // What the verifier wrote of this record beside its verdict.
      check >= 0 && Array.isArray(offline.records[check].notes)
        ? offline.records[check].notes.map((_, k) => row(app.w.word('offline.note'), put('span', 'insp-note', value(offline.records[check], `notes[${k}]`, undefined, cSource))))
        : null),
    entries(app, step.recordFile),
  ];
}

// In Inspect, the package itself: a control that lists the names of its
// entries and sets out its metadata.json, read from the zip on this page.
function entries(app, rel) {
  if (app.mode !== 'inspect') return null;
  const zip = app.zipOf(rel);
  const word = app.w.word('inspector.entries');
  if (zip?.state !== 'ready' || !word) return null;
  const open = app.openRecord === rel;
  const meta = zip.metadata && typeof zip.metadata === 'object' ? zip.metadata : null;
  const metaSource = (path, shape) => from.file(`${rel}!metadata.json`, path, shape);
  return el('div', { class: 'record', data: { file: rel, kind: 'records' } },
    el('button', { class: 'copy-btn record-open', type: 'button', src: word.src, text: word.text, 'aria-expanded': open ? 'true' : 'false', 'aria-label': `${word.text} ${rel}`, data: { focusKey: `entries:${rel}` }, on: { click: () => app.toggleRecord(rel) } }),
    open ? el('div', { class: 'entries', data: { entriesOf: rel } },
      el('ul', { class: 'kv-list' }, zip.entries.map((entry, n) => el('li', { class: 'mono', src: from.file(`${rel}!`, `entries[${n}]`), text: entry.name }))),
      meta ? [
        put('span', 'meta', app.w.label('parties.rawIdentifiersNote')),
        table(Object.keys(meta).map((key) => row(fieldName(meta, key, metaSource), put('span', 'mono', value(meta, key, undefined, metaSource))))),
      ] : null) : null);
}

// ---- The panels

function stepPanel(app, i) {
  const step = app.run.steps[i];
  const { col } = partOf(app, step.id);
  const shown = shownPart(app, col);
  const state = stateOf(app, step.status, from.run(`steps[${i}].status`));
  const build = ARTIFACTS[baseId(step.id)] ?? genericArtifact;
  const sentence = checkedSentence(app, i, step);
  app.sectionFirst = lensOf(app).sections?.[0] ?? 'checked';
  return el('div', { class: 'insp', data: { panel: step.id } },
    el('div', { class: 'insp-head', data: { tone: state.tone, status: step.status } },
      el('h2', { class: 'insp-title', id: 'inspector-heading', tabindex: '-1' },
        put('span', 'row-num', app.w.line('sect.step', { n: [String(i + 1), from.run(`steps[${i}]`, 'ordinal')] }))),
      partMark(app, col, value(app.run, `steps[${i}].partLabel`)),
      shown.part?.standIn ? badge(app) : null,
      chip(state)),
    put('p', 'insp-lens', lensStepLine(app, i)),
    ordered(app, {
      checked: section(app, 'checked', 'sect.checked', put('p', 'insp-text', sentence)),
      artifact: section(app, 'artifact', 'sect.artifact', build(app, i, step)),
      record: section(app, 'record', 'sect.record', recordOfStep(app, i, step)),
    }));
}

// The parts, each with who builds it and, where one applies, its stand-in
// note and its detail line.
function partsList(app) {
  const { cols, parts } = columnsOf(app);
  return el('div', { class: 'parts-list', data: { key: 'parts' } }, cols.filter((id) => parts[id]).map((id) => {
    const shown = shownPart(app, id);
    return el('div', { class: 'insp-part', data: { col: id } },
      el('div', { class: 'insp-part-line' }, partMark(app, id), shown.part?.standIn ? badge(app) : null),
      put('p', 'insp-note', creditOf(app, id)),
      shown.part?.standIn ? put('p', 'insp-note', app.w.label(`${shown.path}.standInNote`), { 'data-note': 'stand-in' }) : null,
      put('p', 'insp-note', detailOf(app, id), { 'data-note': 'detail' }));
  }));
}

// The limits of the demo, in one list.
function limits(app) {
  const run = app.run;
  const c = run ? run.steps.findIndex((st) => st.detail?.verifier) : -1;
  const verifier = c >= 0 ? String(run.steps[c].detail.verifier) : null;
  return [
    run ? put('p', 'insp-note', app.w.line('run.paced', { paceSeconds: [run.paceSeconds, from.run('paceSeconds')] })) : null,
    verifier ? put('p', 'insp-note', app.w.line('limit.pq', { version: [verifier.slice(verifier.lastIndexOf(' ') + 1), from.run(`steps[${c}].detail.verifier`, 'afterLastSpace')] })) : null,
    put('p', 'insp-note', app.w.word('limit.steps')),
  ];
}

function invoiceCard(app) {
  const run = app.run;
  if (!run?.invoice) return null;
  const inv = run.invoice;
  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  return el('div', { class: 'invoice-card' },
    table(
      row(app.w.word('invoice.from'), put('span', null, app.w.label('parties.supplier'))),
      row(app.w.word('invoice.amount'), put('span', 'num', app.w.line('invoice.amountValue', { amount: [inv.amount, from.run('invoice.amount')], currency: [inv.currency, from.run('invoice.currency')] }))),
      row(app.w.word('invoice.payTo'), put('span', null, app.w.lineNodes('invoice.payToValue', { account: [inv.payTo?.account, from.run('invoice.payTo.account')] }, ['account'])))),
    lines.length ? el('ul', { class: 'invoice-lines' }, lines.map((_, n) => put('li', null, value(run, `invoice.lines[${n}]`)))) : null,
    inv.hidden ? el('div', { class: 'hidden-box' },
      put('span', 'hidden-label', app.w.word('hidden.label')),
      put('p', 'hidden-text', value(run, 'invoice.hidden.text')),
      put('p', 'hidden-note insp-note', value(run, 'poisonedLine'))) : null);
}

function sceneIndexOf(app, kind) {
  return (app.labels.scenes ?? []).findIndex((s) => s.kind === kind);
}

function overviewPanel(app) {
  const run = app.run;
  const s = sceneIndexOf(app, run.kind);
  const state = headlineOf(app, run);
  app.sectionFirst = 'run';
  return el('div', { class: 'insp', data: { panel: 'overview' } },
    el('div', { class: 'insp-head', data: { tone: state.tone } },
      el('h2', { class: 'insp-title', id: 'inspector-heading', tabindex: '-1' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : value(run, 'kind'))),
      el('span', { class: 'chip', data: { tone: state.tone } }, put('span', 'chip-word', app.w.chosen(state.key, state.source)))),
    put('p', 'insp-lens', run.outcome === 'blocked' ? value(run, 'reason') : null),
    // The run's own facts: plain words in Story, the run's field names in Inspect.
    section(app, 'run', 'sect.run', table(
      row(keyOf(app, 'insp.runId', run, 'runId'), token(app, run, 'runId')),
      row(keyOf(app, 'insp.started', run, 'startedAt'), timeEl('num', value(run, 'startedAt'))),
      row(keyOf(app, 'insp.finished', run, 'finishedAt'), timeEl('num', value(run, 'finishedAt'))),
      row(keyOf(app, 'insp.credentialSha', run, 'agent.credentialSha256'), token(app, run, 'agent.credentialSha256'))),
    invoiceCard(app)),
    section(app, 'parts', 'sect.parts', partsList(app)),
    section(app, 'limits', 'app.limits', limits(app)));
}

// What the offline check returned when it wrote no result: each line and
// each note as the check wrote them, and its exit status under the name the
// answer gives it. Nothing here reads a line as a verdict on a record.
function returnedState(result, source) {
  const said = (kind, cls) => (Array.isArray(result[kind]) ? result[kind] : []).map((_, n) => put('li', cls, value(result, `${kind}[${n}]`, undefined, source)));
  const lines = [said('lines', 'mono'), said('notes', 'insp-note')].flat().filter(Boolean);
  const status = table(plain(result, 'exitCode', source, 'num'));
  if (!lines.length && !status) return null;
  return el('div', { class: 'returned', data: { returned: 'offline-check' } },
    lines.length ? el('ul', { class: 'kv-list returned-lines' }, lines) : null,
    status);
}

// The audit as a whole: the verifier, the network while it checked, the
// signer it trusted, and for each tampered copy what the verifier said of
// it; or, when the check wrote no result, what it returned.
function offlinePanel(app) {
  const result = offlineOf(app);
  if (!result) return null;
  // A check that names no verifier wrote no result: it shows what it returned.
  const named = Boolean(result.verifier);
  const s = sceneIndexOf(app, OFFLINE_KIND);
  const source = (path, shape) => from.doc('offline-check', path, shape);
  const tampered = Array.isArray(result.tampered) ? result.tampered : [];
  app.sectionFirst = 'checked';
  return el('div', { class: 'insp', data: { panel: 'offline' } },
    el('div', { class: 'insp-head', data: { tone: 'neutral' } },
      el('h2', { class: 'insp-title', id: 'inspector-heading', tabindex: '-1' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : null))),
    returnedState(result, source),
    named ? section(app, 'checked', 'sect.checked',
      put('p', 'insp-text', networkOf(result, source).denied ? app.w.chosen('audit.subDenied', networkOf(result, source).whyNot) : app.w.chosen('offline.subNotMeasured', networkOf(result, source).whyNot)),
      auditFacts(app, result, source),
      tampered.map((rec, n) => el('div', { class: 'record', data: { file: String(rec.file), kind: 'tampered' } },
        put('span', 'mono', value(result, `tampered[${n}].file`, undefined, source)),
        auditVerdict(app, rec, (p, shape) => source(`tampered[${n}].${p}`, shape), true),
        (Array.isArray(rec.notes) ? rec.notes : []).map((_, k) => put('p', 'insp-note', value(result, `tampered[${n}].notes[${k}]`, undefined, source)))))) : null,
    named ? section(app, 'limits', 'app.limits', put('p', 'insp-note', app.w.word('limit.steps')), put('p', 'insp-note', detailOf(app, 'record'), { 'data-note': 'detail' })) : null);
}

// What the audit names of itself: the verifier by SHA-256, the network while
// it checked (denied, or not measured, said plainly and never as denied),
// and the signer it trusted.
export function networkOf(result, source) {
  const hasField = typeof result.networkDenied === 'string';
  const denied = hasField ? result.networkDenied === 'yes' : String(result.network ?? '').startsWith('denied: ');
  return { denied, whyNot: source(hasField ? 'networkDenied' : 'network') };
}

export function auditFacts(app, result, source) {
  const sha = result.verifier?.sha256;
  const { denied, whyNot } = networkOf(result, source);
  return table(
    sha ? row(app.w.word('offline.verifier'),
      put('span', null, app.w.lineNodes('audit.verifierValue', { sha16: [String(sha).slice(0, 16), source('verifier.sha256', 'hex16')] }, ['sha16']), { title: String(sha) }),
      copyButton(app, sha, source('verifier.sha256').replace(/^run:/, ''))) : null,
    result.network && denied ? row(app.w.word('offline.network'), put('span', null, app.w.chosen('offline.networkValue', source('network')), { 'data-network': 'denied' })) : null,
    result.network && !denied ? row(app.w.word('offline.network'), put('span', null, app.w.chosen('offline.networkNotMeasured', whyNot), { 'data-network': 'not-measured' }), put('span', 'mono', value(result, 'network', undefined, source))) : null,
    result.pin ? row(app.w.word('offline.signer'), put('span', null, app.w.chosen('offline.signerValue', source('pin'))), put('span', 'mono', value(result, 'pin', undefined, source))) : null);
}

function startPanel(app) {
  const scene = app.scenes[app.sceneIndex];
  const s = scene ? (app.labels.scenes ?? []).indexOf(scene) : -1;
  app.sectionFirst = null;
  return el('div', { class: 'insp', data: { panel: 'start' } },
    el('div', { class: 'insp-head', data: { tone: 'neutral' } },
      el('h2', { class: 'insp-title', id: 'inspector-heading', tabindex: '-1' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : app.w.word('ui.title')))),
    put('p', 'insp-lens', s >= 0 ? app.w.label(`scenes[${s}].text`) : null),
    section(app, 'parts', 'sect.parts', partsList(app)),
    section(app, 'limits', 'app.limits', limits(app)));
}

// ---- Render

export function renderInspector(app, host) {
  const signature = [app.mode, app.size, app.lens, JSON.stringify(app.selection), app.runId, app.runStamp, app.filesStamp, app.offlineStamp, app.openRecord, app.sceneIndex, app.labelsStamp, JSON.stringify(app.variants ?? null)].join('|');
  if (host.dataset.signature === signature) return;
  const view = `${app.runId}|${JSON.stringify(app.selection)}`;
  const sameView = host.dataset.view === view;
  if (!sameView) app.inspectorOpen = new Map();
  const scroll = host.scrollTop;
  const active = host.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  host.dataset.signature = signature;
  host.dataset.view = view;

  let panel = null;
  if (!app.run) panel = startPanel(app);
  else if (app.selection.kind === 'offline') panel = offlinePanel(app) ?? overviewPanel(app);
  else if (app.selection.kind === 'step' && app.run.steps[app.selection.index]) panel = stepPanel(app, app.selection.index);
  else panel = overviewPanel(app);

  add(clear(host), panel);
  host.scrollTop = sameView ? scroll : 0;
  if (active) host.querySelector(`[data-focus-key="${CSS.escape(active)}"]`)?.focus();
  // A row inside a step of the trace, or a row of the records, opens its
  // step here with its own item marked.
  const marked = app.selection.item ? itemOf(host, app.selection) : null;
  if (marked) {
    marked.dataset.highlight = 'yes';
    const open = marked.closest('details');
    if (open) open.open = true;
    if (!sameView) marked.scrollIntoView({ block: 'nearest' });
  }
}

// The element of the pane that shows the item a row stands for.
function itemOf(host, selection) {
  const { kind, n } = selection.item;
  const nth = (selector) => host.querySelectorAll(selector)[n] ?? null;
  if (kind === 'call') return nth('.compare-call');
  if (kind === 'declared') return host.querySelector('.compare');
  if (kind === 'record') return nth('.record[data-kind="records"]') ?? host.querySelector('[data-section="record"] .kv');
  if (kind === 'records' || kind === 'tampered') return selection.kind === 'offline' ? nth(`.record[data-kind="${kind}"]`) : null;
  if (kind === 'check' && selection.kind === 'step') {
    const base = `run:steps[${selection.index}].detail`;
    return host.querySelector(`[data-src="${base}.scopeChecked[${n}]"]`) ?? host.querySelector(`[data-capture-check="${n}"]`) ?? host.querySelector(`[data-src="${base}.verifier"]`);
  }
  return null;
}

export { camel };
