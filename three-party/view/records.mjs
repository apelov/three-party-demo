// The middle pane's Records tab: the run's Action Evidence Packages, one
// ruled row each (the file, its SHA-256, the step it records and, once the
// offline audit has run, its verdict), the tampered copy below them, and the
// audit's own facts: the verifier, the network while it checked, the
// signer it trusted. Before the audit the one action is to run it.

import { el, put, add, from, value, clear } from './dom.mjs';
import { copyButton } from './parts.mjs';
import { offlineOf } from './flow.mjs';
import { manifestOf, auditVerdict, checksOf } from './inspector.mjs';
import { fileUrl } from './api.mjs';

function stepOfRecord(app, item) {
  const run = app.run;
  const i = run.steps.findIndex((s) => (item.action && s.actionFile === item.action) || s.recordFile === item.file);
  return i;
}

export function renderRecords(app, host, actions) {
  const run = app.run;
  const found = run ? manifestOf(app) : null;
  const offline = offlineOf(app);
  const signature = [app.runId ?? 'none', app.runStamp, app.filesStamp, app.offlineStamp, app.mode, app.labelsStamp, actions.auditReady() ? 'ready' : 'no', JSON.stringify(app.selection)].join('|');
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const held = host.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  clear(host);
  if (!run) {
    add(host, put('p', 'records-empty', app.w.word('audit.noRun')));
    return;
  }
  if (!found) {
    add(host, put('p', 'records-empty', app.w.word('audit.notYet')));
    return;
  }
  const { manifest, source } = found;
  const oSource = (path, shape) => from.doc('offline-check', path, shape);

  // The head: the audit's count once it has run, else the action that runs it.
  const head = el('div', { class: 'records-head' });
  if (offline?.summary) {
    add(head,
      put('p', 'records-count', app.w.line('offline.summaryPass', { pass: [offline.summary.pass, oSource('summary.pass')] })),
      put('p', 'records-count', app.w.line('offline.summaryReject', { reject: [offline.summary.reject, oSource('summary.reject')], expectedRejects: [offline.summary.expectedRejects, oSource('summary.expectedRejects')] })));
  } else {
    add(head, put('p', 'records-count muted', app.w.word('insp.notAudited')),
      actions.auditReady() ? el('button', { class: 'btn btn-primary', type: 'button', id: 'records-audit', src: from.copy('ui.audit'), text: app.w.word('ui.audit')?.text, on: { click: actions.audit } }) : null);
  }

  // The ledger.
  const headRow = el('div', { class: 'ledger-row ledger-head', role: 'row' },
    ['audit.colFile', 'audit.colSha', 'audit.colAudit'].map((key) => put('span', 'ledger-col', app.w.word(key), { role: 'columnheader' })));
  const rows = [];
  for (const kind of ['records', 'tampered']) {
    (Array.isArray(manifest[kind]) ? manifest[kind] : []).forEach((item, n) => {
      const tampered = kind === 'tampered';
      const i = tampered ? -1 : stepOfRecord(app, item);
      const check = Array.isArray(offline?.[kind]) ? offline[kind].findIndex((r) => r.file === item.file) : -1;
      const cSource = (p, shape) => oSource(`${kind}[${check}].${p}`, shape);
      const selection = tampered ? { kind: 'offline', item: { kind: 'tampered', n } } : i >= 0 ? { kind: 'step', index: i, item: { kind: 'record', n: 0 } } : null;
      const selected = selection && JSON.stringify(app.selection) === JSON.stringify(selection);
      rows.push(el('div', { class: 'ledger-row record', role: 'row', data: { file: String(item.file), kind, selected: selected ? 'yes' : 'no' } },
        el('span', { class: 'ledger-cell ledger-file', role: 'gridcell' },
          el('a', { class: 'record-file mono', href: fileUrl(app.runId, item.file), src: source(`${kind}[${n}].file`), text: String(item.file), data: { focusKey: `link:${item.file}` } }),
          tampered
            ? put('span', 'record-flag', app.w.word('offline.tampered'))
            : i >= 0 ? el('button', { class: 'ledger-step', type: 'button', data: { focusKey: `step:${item.file}` }, on: { click: () => actions.choose(selection) } },
              el('span', { class: 'num', src: from.run(`steps[${i}]`, 'ordinal'), text: String(i + 1) }),
              put('span', 'ledger-step-title', value(run, `steps[${i}].title`))) : null),
        el('span', { class: 'ledger-cell', role: 'gridcell' },
          put('span', 'mono', value(manifest, `${kind}[${n}].sha256`, 'hex16', source), { title: String(item.sha256) }),
          copyButton(app, item.sha256, source(`${kind}[${n}].sha256`).replace(/^run:/, ''))),
        el('span', { class: 'ledger-cell', role: 'gridcell', data: { verdictFor: String(item.file) } },
          check >= 0 ? auditVerdict(app, offline[kind][check], cSource, tampered) : put('span', 'muted', app.w.word('insp.notAudited')),
          tampered && check >= 0 ? put('span', 'record-flag', app.w.word('offline.expected')) : null,
          check >= 0 ? checksOf(offline[kind][check], cSource) : null)));
    });
  }

  add(host,
    head,
    el('div', { class: 'ledger', role: 'grid', 'aria-readonly': 'true' }, headRow, rows),
    el('details', { class: 'records-limits' },
      el('summary', null, put('span', null, app.w.word('app.limits'))),
      put('p', 'insp-note', app.w.word('limit.steps')),
      put('p', 'insp-note', app.w.label('parts.record.detail'))));
  if (held) host.querySelector(`[data-focus-key="${CSS.escape(held)}"]`)?.focus();
}
