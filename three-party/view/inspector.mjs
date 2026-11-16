// The right pane. It shows the selected step, field by field, from what the
// contract carries; a field the run does not carry is left out. In Story the
// fields are the summary set at the large sizes. In Inspect the summary is
// followed by the artifacts as written: the step as the run state holds it,
// and the step's files from the run API.

import { el, put, add, from, value, fieldName, at, timeEl, clear } from './dom.mjs';
import { stateOf, chip, badge, copyButton, countdown, compare, headlineOf } from './parts.mjs';
import { invoiceCard, cardInFlow, partOf, shownPart } from './flow.mjs';
import { fileUrl } from './api.mjs';
import { iconEl } from './icons.mjs';
import { OFFLINE_KIND } from './constants.mjs';

const baseId = (id) => String(id).replace(/-again$/, '');
const dirOf = (rel) => (String(rel).includes('/') ? String(rel).slice(0, String(rel).lastIndexOf('/') + 1) : '');

// ---- Small builders

function section(app, key, ...kids) {
  const body = kids.flat(3).filter(Boolean);
  if (!body.length) return null;
  return el('section', { class: 'insp-section' }, put('h3', 'insp-section-title', key ? app.w.word(key) : null), body);
}

// One row of a key and value table. The key is a copy word when the deck has
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

// A plain value of a document, under its own field name.
function plain(root, path, source, cls) {
  return row(fieldName(root, path, source), put('span', cls ?? null, value(root, path, undefined, source)));
}

function moment(root, path, source) {
  return row(fieldName(root, path, source), timeEl(null, value(root, path, undefined, source)));
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

function hashRow(app, root, path, source) {
  return row(fieldName(root, path, source), token(app, root, path, source));
}

// A word for true and another for false, from the copy deck.
function verdictWord(app, flag, source, yesKey, noKey) {
  if (flag === null || flag === undefined) return null;
  return put('span', null, app.w.chosen(flag ? yesKey : noKey, source));
}

// ---- Artifacts (Inspect)

// A file of the run, as written: its path as a link to the same route, the
// note on test identifiers, and the bytes (JSON set out, text as it is).
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
// identifiers as a file of the run: the issuer of the credential and the two
// domains of the crossing are shown here as the run wrote them.
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

function artifacts(...panes) {
  const body = panes.flat(3).filter(Boolean);
  return body.length ? el('div', { class: 'insp-section', data: { artifacts: 'yes' } }, body) : null;
}

// ---- Heading and part

function heading(app, i, step) {
  const state = stateOf(app, step.status, from.run(`steps[${i}].status`));
  return el('div', { class: 'insp-head', data: { tone: state.tone, status: step.status } },
    el('h2', { class: 'insp-title', id: 'inspector-heading' },
      el('span', { class: 'row-num', src: from.run(`steps[${i}]`, 'ordinal'), text: String(i + 1) }),
      put('span', null, value(app.run, `steps[${i}].title`))),
    chip(state));
}

// The part a step belongs to, by the run's own label; for a stand-in part,
// the badge, its note and its detail line; the part's legend where the lane
// header has no room for it.
function partBlock(app, i, step) {
  const { col } = partOf(app, step.id);
  // The part as this run used it: the variant a step names, else the part.
  const { part, path } = shownPart(app, col);
  const standIn = Boolean(part?.standIn);
  const note = standIn ? (app.w.label(`${path}.standInNote`) ?? value(app.run, `steps[${i}].detail.standIn`)) : null;
  return el('div', { class: 'insp-part' },
    el('div', { class: 'insp-part-line' }, put('span', 'insp-part-label', value(app.run, `steps[${i}].partLabel`)), standIn ? badge(app) : null),
    part && app.tier !== 'wide' ? put('p', 'insp-note', app.w.label(`parts.${col}.text`)) : null,
    standIn ? put('p', 'insp-note', note, { 'data-note': 'stand-in' }) : null,
    standIn ? put('p', 'insp-note', app.w.label(`${path}.fetchNote`), { 'data-note': 'fetch' }) : null,
    standIn ? put('p', 'insp-note', app.w.label(`parts.${col}.detail`)) : null);
}

// ---- The panels, one per step of the contract

function credentialPanel(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const algorithm = d.algorithm ? app.w.line('inspector.signature', { algorithm: [d.algorithm, from.run(`${base}.algorithm`)] }) : app.w.beforeParen('inspector.signature');
  const version = d.verifier ? [String(d.verifier).slice(String(d.verifier).lastIndexOf(' ') + 1), from.run(`${base}.verifier`, 'afterLastSpace')] : null;
  return [
    section(app, 'inspector.credential',
      put('p', 'insp-text insp-big', app.w.label('parties.agent')),
      table(
        plain(run, 'agent.credentialFile', from.run, 'mono'),
        hashRow(app, run, 'agent.credentialSha256'),
        plain(run, `${base}.verifier`),
        d.valid === null || d.valid === undefined ? null : row(algorithm, verdictWord(app, d.valid === true, from.run(`${base}.valid`), 'inspector.signatureValid', 'state.stopped')),
        moment(run, `${base}.notBefore`),
        moment(run, `${base}.notAfter`)),
      version ? put('p', 'insp-sub', app.w.line('limit.pq', { version })) : null),
    artifacts(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function grantPanel(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  const g = run.grant;
  const max = g?.maximumIndividualAmount;
  const accounts = Array.isArray(g?.creditorAccounts) ? g.creditorAccounts : [];
  const checked = Array.isArray(d.scopeChecked) ? d.scopeChecked : [];
  const grantFile = d.grantFile ? artifact(app, d.grantFile, value(run, `${base}.grantFile`)) : null;
  return [
    section(app, 'inspector.grant',
      table(
        plain(run, 'grant.scope', from.run, 'mono'),
        plain(run, 'grant.tokenType'),
        plain(run, 'grant.ttlSeconds', from.run, 'num'),
        g && step.status === 'passed' ? row(app.w.word('inspector.lifetime'), countdown(app)) : null,
        moment(run, 'grant.issuedAt'),
        moment(run, 'grant.expiresAt'),
        max ? row(fieldName(run, 'grant.maximumIndividualAmount'), put('span', 'num', app.w.line('invoice.amountValue', { amount: [max.amount, from.run('grant.maximumIndividualAmount.amount')], currency: [max.currency, from.run('grant.maximumIndividualAmount.currency')] }))) : null,
        accounts.length ? row(fieldName(run, 'grant.creditorAccounts'), el('span', { class: 'kv-list' }, accounts.map((_, n) => put('span', 'mono', value(run, `grant.creditorAccounts[${n}]`))))) : null,
        d.inScope === null || d.inScope === undefined ? null : row(fieldName(run, `${base}.inScope`), verdictWord(app, d.inScope === true, from.run(`${base}.inScope`), 'state.passed', 'state.stopped')),
        checked.length ? row(fieldName(run, `${base}.scopeChecked`), el('span', { class: 'kv-list' }, checked.map((_, n) => put('span', 'mono', value(run, `${base}.scopeChecked[${n}]`))))) : null,
        plain(run, `${base}.expiresInSeconds`, from.run, 'num'))),
    artifacts(stateExcerpt(app, i), grantFile, actionArtifact(app, i)),
  ];
}

// The crossing over the AI2II capture: one line per check (its answer, its
// name and what it shows), the check's own summary and scope, then the
// source, the files and the token by SHA-256. Every word is the run's.
function capturePanel(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail.capture`;
  const c = step.detail.capture;
  const states = app.labels.states ?? {};
  const checks = Array.isArray(c.checks) ? c.checks : [];
  const at = (path) => `${base}.${path}`;
  return [
    section(app, null,
      put('p', 'insp-text', value(run, at('summary'))),
      el('ul', { class: 'kv-list checks', data: { capture: 'checks' } }, checks.map((check, n) => {
        const pass = check.answer === 'pass';
        return el('li', { class: 'record-line', data: { captureCheck: String(n), answer: String(check.answer) } },
          el('span', { class: 'verdict', data: { tone: pass ? 'ok' : 'stop' } }, iconEl(pass ? states.passed?.icon : states.blocked?.icon), put('span', null, value(run, at(`checks[${n}].answer`)))),
          put('span', 'mono', value(run, at(`checks[${n}].name`))),
          put('span', 'insp-note', value(run, at(`checks[${n}].claim`))),
          check.reason ? put('span', 'insp-note', value(run, at(`checks[${n}].reason`))) : null);
      })),
      (Array.isArray(c.scope) ? c.scope : []).map((_, n) => put('p', 'insp-sub', value(run, at(`scope[${n}]`)), { 'data-note': 'scope' })),
      table(
        plain(run, at('source.repo'), from.run, 'mono'),
        row(fieldName(run, at('source.commit')), token(app, run, at('source.commit'))),
        (Array.isArray(c.files) ? c.files : []).map((_, n) => row(value(run, at(`files[${n}].name`)), token(app, run, at(`files[${n}].sha256`)))),
        c.token ? row(fieldName(run, at('token.sha256')), token(app, run, at('token.sha256'))) : null)),
    artifacts(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function crossingPanel(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  const d = step.detail ?? {};
  if (d.capture?.used === true) return capturePanel(app, i, step);
  const hop = d.hopFile ? app.fileOf(d.hopFile) : null;
  const hopDoc = hop?.state === 'ready' && hop.file.kind === 'json' ? hop.file.value : null;
  const hopSource = (path, shape) => from.file(d.hopFile, path, shape);
  return [
    section(app, null,
      table(
        d.from ? row(fieldName(run, `${base}.from`), put('span', null, app.w.label('parties.domainA'))) : null,
        d.to ? row(fieldName(run, `${base}.to`), put('span', null, app.w.label('parties.domainB'))) : null,
        plain(run, `${base}.hops`, from.run, 'num'),
        plain(run, `${base}.outcome`),
        plain(run, `${base}.stepsRun`),
        plain(run, `${base}.chainFile`, from.run, 'mono'),
        hopDoc ? hashRow(app, hopDoc, 'chainSha256', hopSource) : null,
        // An AI2II capture that was there and not used: why.
        d.capture?.reason ? plain(run, `${base}.capture.reason`) : null)),
    artifacts(stateExcerpt(app, i), d.hopFile ? artifact(app, d.hopFile, value(run, `${base}.hopFile`)) : null, actionArtifact(app, i)),
  ];
}

function intentPanel(app, i, step) {
  const run = app.run;
  const base = `steps[${i}].detail`;
  return [
    section(app, 'intent.heading',
      put('p', 'insp-text', app.w.word('intent.rule')),
      compare(app, i),
      table(plain(run, `${base}.result`))),
    artifacts(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

function payPanel(app, i, step) {
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
    section(app, null,
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
          bodyRel ? el('a', { class: 'record-file mono', href: fileUrl(app.runId, bodyRel), src: bodyWords.src, text: bodyWords.text, data: { focusKey: `link:${bodyRel}` } }) : null) : null)),
    artifacts(stateExcerpt(app, i), actionArtifact(app, i), bodyRel ? artifact(app, bodyRel, bodyWords) : null),
  ];
}

// The verdict of the offline check on one package, in the deck's words.
function verdict(app, rec, source, tampered) {
  if (!rec) return null;
  const pass = rec.verdict === 'pass-1-6';
  const words = pass ? app.w.chosen('offline.pass', source('verdict')) : app.w.line('offline.reject', { n: [rec.firstFailingStep, source('firstFailingStep')] });
  const states = app.labels.states ?? {};
  const tone = pass ? (tampered ? 'warn' : 'ok') : (tampered ? 'neutral' : 'stop');
  const notes = Array.isArray(rec.notes) ? rec.notes : [];
  return [
    // A file the verifier gave no answer on has no step to name. It gets no
    // verdict word, and its notes say what happened.
    words ? el('span', { class: 'verdict', data: { tone, verdict: String(rec.verdict) } }, iconEl(pass ? states.passed?.icon : states.blocked?.icon), put('span', null, words)) : null,
    notes.map((_, n) => el('div', { class: 'record-line' }, put('span', 'record-flag', app.w.word('offline.note')), put('span', 'insp-note', { text: String(rec.notes[n]), src: source(`notes[${n}]`) }))),
    checksOf(rec, source),
  ];
}

// The verifier's own steps on one package, once a revision of the contract
// adds checks to a record row of the offline check: a list with each name and
// its value, as the check wrote them. A step set out as an object gives one
// row per field; a row with no checks (contract v1) gives no list.
function checksOf(rec, source) {
  const checks = rec.checks;
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
  return items.length ? el('div', { class: 'record-line' }, el('ul', { class: 'kv-list checks' }, items)) : null;
}

function offlineFor(app) {
  return app.offline && app.offline.runId === app.runId ? app.offline.result : null;
}

// One package of the manifest: its file as a link, its hash, the action it
// records, its verdict once the offline check has run, and its entries once
// they are open.
function recordRow(app, manifest, kind, n, mSource) {
  const item = manifest[kind][n];
  const path = `${kind}[${n}]`;
  const tampered = kind === 'tampered';
  const offline = offlineFor(app);
  const checkIndex = offline && Array.isArray(offline[kind]) ? offline[kind].findIndex((r) => r.file === item.file) : -1;
  const check = checkIndex >= 0 ? offline[kind][checkIndex] : null;
  const checkSource = (p, shape) => from.doc('offline-check', `${kind}[${checkIndex}].${p}`, shape);
  const zip = app.zipOf(item.file);
  const open = app.openRecord === item.file && zip?.state === 'ready';
  const entriesWord = app.w.word('inspector.entries');
  return el('div', { class: 'record', data: { file: item.file, kind } },
    el('div', { class: 'record-line' },
      el('a', { class: 'record-file mono', href: fileUrl(app.runId, item.file), src: mSource(`${path}.file`), text: String(item.file), data: { focusKey: `link:${item.file}` } }),
      tampered ? [put('span', 'record-flag', app.w.word('offline.tampered')), put('span', 'record-flag', app.w.word('offline.expected'))] : null),
    el('div', { class: 'record-line' },
      put('span', 'mono', value(manifest, `${path}.sha256`, 'hex16', mSource), { title: String(item.sha256) }),
      copyButton(app, item.sha256, mSource(`${path}.sha256`).replace(/^run:/, ''))),
    item.action ? el('div', { class: 'record-line' }, put('span', 'mono meta', value(manifest, `${path}.action`, undefined, mSource))) : null,
    item.changed ? el('div', { class: 'record-line' }, put('span', 'insp-note', value(manifest, `${path}.changed`, undefined, mSource))) : null,
    check ? el('div', { class: 'record-line', data: { verdictFor: item.file } }, put('span', 'record-flag', app.w.word('inspector.stepsPassed')), verdict(app, check, checkSource, tampered)) : null,
    zip?.state === 'ready' && entriesWord ? el('button', { class: 'copy-btn record-open', type: 'button', src: entriesWord.src, text: entriesWord.text, 'aria-expanded': open ? 'true' : 'false', 'aria-label': `${entriesWord.text} ${item.file}`, data: { focusKey: `entries:${item.file}` }, on: { click: () => app.toggleRecord(item.file) } }) : null,
    open ? entriesBlock(app, item.file, zip) : null);
}

function entriesBlock(app, rel, zip) {
  const meta = zip.metadata && typeof zip.metadata === 'object' ? zip.metadata : null;
  const metaSource = (path, shape) => from.file(`${rel}!metadata.json`, path, shape);
  return el('div', { class: 'insp-section', data: { entriesOf: rel } },
    el('ul', { class: 'kv-list' }, zip.entries.map((entry, n) => el('li', { class: 'mono', src: from.file(`${rel}!`, `entries[${n}]`), text: entry.name }))),
    meta ? [
      put('span', 'meta', app.w.label('parties.rawIdentifiersNote')),
      table(Object.keys(meta).map((key) => row(fieldName(meta, key, metaSource), put('span', 'mono', value(meta, key, undefined, metaSource))))),
    ] : null);
}

function recordPanel(app, i, step) {
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
  const records = manifest && Array.isArray(manifest.records) ? manifest.records : [];
  const tampered = manifest && Array.isArray(manifest.tampered) ? manifest.tampered : [];
  return [
    section(app, 'inspector.package',
      table(
        plain(run, `${base}.written`, from.run, 'num'),
        commit ? row(app.w.word('record.format'), put('span', null, app.w.lineNodes('record.formatValue', { formatCommit: commit }, ['formatCommit']))) : null,
        d.signer ? row(app.w.word('record.signer'), put('span', null, app.w.chosen('record.signerValue', from.run(`${base}.signer`)))) : null,
        stampNote ? row(app.w.word('record.timestamp'), badge(app), put('span', null, stampNote, { 'data-note': 'timestamp' })) : null),
      d.credentialCitedBy ? put('p', 'insp-sub', app.w.chosen('record.credentialNote', from.run(`${base}.credentialCitedBy`))) : null),
    manifest ? section(app, null,
      table(
        plain(manifest, 'signerPublicKey', mSource, 'mono'),
        hashRow(app, manifest, 'signerSha256', mSource),
        hashRow(app, manifest, 'credentialSha256', mSource)),
      el('div', { class: 'records' },
        records.map((_, n) => recordRow(app, manifest, 'records', n, mSource)),
        tampered.map((_, n) => recordRow(app, manifest, 'tampered', n, mSource)))) : null,
    artifacts(stateExcerpt(app, i), rel ? artifact(app, rel, value(run, `steps[${i}].recordFile`)) : null),
  ];
}

function genericPanel(app, i, step) {
  const base = `steps[${i}].detail`;
  const d = step.detail && typeof step.detail === 'object' ? step.detail : {};
  const simple = Object.keys(d).filter((k) => ['string', 'number', 'boolean'].includes(typeof d[k]));
  return [
    section(app, null, table(simple.map((k) => row(fieldName(app.run, `${base}.${k}`), put('span', null, { text: String(d[k]), src: from.run(`${base}.${k}`) }))))),
    artifacts(stateExcerpt(app, i), actionArtifact(app, i)),
  ];
}

const PANELS = { credential: credentialPanel, grant: grantPanel, crossing: crossingPanel, intent: intentPanel, pay: payPanel, record: recordPanel };

function stepPanel(app, i) {
  const step = app.run.steps[i];
  const panel = PANELS[baseId(step.id)] ?? genericPanel;
  return el('div', { class: 'insp', data: { panel: step.id } }, heading(app, i, step), partBlock(app, i, step), panel(app, i, step));
}

// ---- The run as a whole (key 0), the offline check, the start state

// The parts of the demo with their legends and stand-in notes: the key of
// the lane header, at a size the header has no room for.
function partsKey(app) {
  const parts = app.labels.parts ?? {};
  const cols = (app.labels.columns ?? []).filter((id) => parts[id]);
  return el('div', { class: 'insp-section', data: { key: 'parts' } }, cols.map((id) => {
    const { part, path } = shownPart(app, id);
    return el('div', { class: 'insp-part' },
      el('div', { class: 'insp-part-line' }, put('span', 'insp-part-label', app.w.label(`${path}.label`)), part.standIn ? badge(app) : null),
      put('p', 'insp-note', app.w.label(`parts.${id}.text`)),
      part.standIn ? put('p', 'insp-note', app.w.label(`${path}.standInNote`)) : null);
  }));
}

function sceneIndexOf(app, kind) {
  return (app.labels.scenes ?? []).findIndex((s) => s.kind === kind);
}

function overviewPanel(app) {
  const run = app.run;
  const s = sceneIndexOf(app, run.kind);
  const state = headlineOf(app, run);
  return el('div', { class: 'insp', data: { panel: 'overview' } },
    el('div', { class: 'insp-head', data: { tone: 'neutral' } },
      el('h2', { class: 'insp-title', id: 'inspector-heading' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : value(run, 'kind'))),
      put('p', 'insp-sub', app.w.chosen(state.key, state.source))),
    section(app, null, table(
      row(fieldName(run, 'runId'), token(app, run, 'runId')),
      plain(run, 'kind'),
      moment(run, 'startedAt'),
      moment(run, 'finishedAt'))),
    section(app, null, invoiceCard(app, !cardInFlow(app))),
    section(app, null,
      put('p', 'insp-text insp-big', app.w.label('parties.agent')),
      table(hashRow(app, run, 'agent.credentialSha256'))),
    partsKey(app));
}

// What the offline check returned when its answer is its own state: each
// line and each note as the check wrote it, and its exit status under the
// name the answer gives it. Nothing here reads a line as a verdict on a
// record. An answer with none of the three gives nothing.
function returnedState(result, source) {
  const said = (kind, cls) => (Array.isArray(result[kind]) ? result[kind] : []).map((_, n) => put('li', cls, value(result, `${kind}[${n}]`, undefined, source)));
  const lines = [said('lines', 'mono'), said('notes', 'insp-note')].flat().filter(Boolean);
  const status = table(plain(result, 'exitCode', source, 'num'));
  if (!lines.length && !status) return null;
  return el('div', { class: 'insp-section', data: { returned: 'offline-check' } },
    lines.length ? el('ul', { class: 'kv-list returned' }, lines) : null,
    status);
}

function offlinePanel(app) {
  const result = offlineFor(app);
  if (!result) return null;
  const s = sceneIndexOf(app, OFFLINE_KIND);
  const source = (path, shape) => from.doc('offline-check', path, shape);
  const sha = result.verifier?.sha256;
  // The two sentences that speak of the verifier stand when the answer
  // names one. A check that ran no verifier shows what it returned instead.
  const named = Boolean(result.verifier);
  const rows = (kind) => (Array.isArray(result[kind]) ? result[kind] : []).map((rec, n) => el('div', { class: 'record', data: { file: String(rec.file), kind } },
    el('div', { class: 'record-line' },
      put('span', 'mono', value(result, `${kind}[${n}].file`, undefined, source)),
      kind === 'tampered' ? [put('span', 'record-flag', app.w.word('offline.tampered')), put('span', 'record-flag', app.w.word('offline.expected'))] : null),
    el('div', { class: 'record-line', data: { verdictFor: String(rec.file) } }, verdict(app, rec, (p, shape) => source(`${kind}[${n}].${p}`, shape), kind === 'tampered'))));
  return el('div', { class: 'insp', data: { panel: 'offline' } },
    el('div', { class: 'insp-head', data: { tone: 'neutral' } },
      el('h2', { class: 'insp-title', id: 'inspector-heading' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : null)),
      named ? put('p', 'insp-sub', app.w.word('offline.sub')) : null),
    returnedState(result, source),
    section(app, null, table(
      sha ? row(app.w.word('offline.verifier'),
        put('span', null, app.w.lineNodes('offline.verifierValue', { sha16: [String(sha).slice(0, 16), source('verifier.sha256', 'hex16')] }, ['sha16']), { title: String(sha) }),
        copyButton(app, sha, source('verifier.sha256').replace(/^run:/, ''))) : null,
      result.network ? row(app.w.word('offline.network'), put('span', null, app.w.chosen('offline.networkValue', source('network')))) : null,
      result.pin ? row(app.w.word('offline.signer'), put('span', null, app.w.chosen('offline.signerValue', source('pin'))), put('span', 'mono', value(result, 'pin', undefined, source))) : null)),
    el('div', { class: 'records' }, rows('records'), rows('tampered')),
    result.summary ? section(app, null,
      put('p', 'insp-text insp-big', app.w.line('offline.summaryPass', { pass: [result.summary.pass, source('summary.pass')] })),
      put('p', 'insp-text insp-big', app.w.line('offline.summaryReject', { reject: [result.summary.reject, source('summary.reject')], expectedRejects: [result.summary.expectedRejects, source('summary.expectedRejects')] }))) : null,
    named ? put('p', 'insp-sub', app.w.word('limit.steps')) : null);
}

function startPanel(app) {
  const scene = app.scenes[app.sceneIndex];
  const s = scene ? (app.labels.scenes ?? []).indexOf(scene) : -1;
  return el('div', { class: 'insp', data: { panel: 'start' } },
    el('div', { class: 'insp-head', data: { tone: 'neutral' } },
      el('h2', { class: 'insp-title', id: 'inspector-heading' }, put('span', null, s >= 0 ? app.w.label(`scenes[${s}].title`) : app.w.word('app.title'))),
      s >= 0 ? put('p', 'insp-sub', app.w.label(`scenes[${s}].text`)) : null),
    partsKey(app));
}

// ---- Render

export function renderInspector(app, host) {
  const signature = [app.mode, app.size, app.tier, JSON.stringify(app.selection), app.runId, app.runStamp, app.filesStamp, app.offlineStamp, app.openRecord, app.sceneIndex, app.labelsStamp].join('|');
  if (host.dataset.signature === signature) return;
  const sameView = host.dataset.view === `${app.runId}|${JSON.stringify(app.selection)}`;
  const scroll = host.scrollTop;
  const active = host.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  host.dataset.signature = signature;
  host.dataset.view = `${app.runId}|${JSON.stringify(app.selection)}`;

  let panel = null;
  if (!app.run) panel = startPanel(app);
  else if (app.selection.kind === 'offline') panel = offlinePanel(app) ?? overviewPanel(app);
  else if (app.selection.kind === 'step' && app.run.steps[app.selection.index]) panel = stepPanel(app, app.selection.index);
  else panel = overviewPanel(app);

  add(clear(host), panel);
  host.scrollTop = sameView ? scroll : 0;
  if (active) host.querySelector(`[data-focus-key="${CSS.escape(active)}"]`)?.focus();
  // A row inside a step of the trace opens its step here with its own item
  // marked: the tool call in the comparison, the record in the list.
  const marked = app.selection.item ? itemOf(host, app.selection) : null;
  if (marked) {
    marked.dataset.highlight = 'yes';
    if (!sameView) marked.scrollIntoView({ block: 'nearest' });
  }
}

// The element of the pane that shows the item a row of the trace stands for.
function itemOf(host, selection) {
  const { kind, n } = selection.item;
  const nth = (selector) => host.querySelectorAll(selector)[n] ?? null;
  if (kind === 'call') return nth('.compare-call');
  if (kind === 'declared') return host.querySelector('.compare');
  if (kind === 'record') return nth('.record[data-kind="records"]');
  if (kind === 'records' || kind === 'tampered') return selection.kind === 'offline' ? nth(`.record[data-kind="${kind}"]`) : null;
  if (kind === 'check' && selection.kind === 'step') {
    const base = `run:steps[${selection.index}].detail`;
    return host.querySelector(`[data-src="${base}.scopeChecked[${n}]"]`) ?? host.querySelector(`[data-src="${base}.verifier"]`)
      ?? host.querySelector(`[data-capture-check="${n}"]`);
  }
  return null;
}
