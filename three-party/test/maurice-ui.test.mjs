// Milestone 5, offline half: the MiniApp and the wrapper workflow are
// schema-shaped, internally consistent and honest about states — and the
// adapter's MCP server actually publishes the evidence_package_v1 tool.
// The live half (deploy + run clean/poisoned through the MiniApp workflow)
// is maurice-ui-live.test.mjs under MAURICE_LIVE=1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceWorkflows } from '../src/maurice/extract.mjs';
import { uiWorkflows, sliceMiniapp } from '../src/maurice/ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = {
  proposeTool: 'enforcement-adapter__proposals_create_v1',
  executeTool: 'enforcement-adapter__payments_execute_v1',
  secretReadTool: 'enforcement-adapter__secrets_read_v1',
  packageTool: 'enforcement-adapter__evidence_package_v1',
};
const ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const COMPONENT_TYPES = ['section', 'card', 'tabs', 'accordion', 'separator', 'text', 'stat', 'metric', 'kpi_grid', 'badge_row', 'callout', 'empty_state', 'steps', 'table', 'list', 'chart', 'button', 'action_bar', 'filter_bar'];

const walk = (node, fn, trail = []) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, fn, [...trail, i]));
  if (node && typeof node === 'object') {
    fn(node, trail);
    for (const [k, v] of Object.entries(node)) if (k === 'children' || k === 'actions' || k === 'layout' || k === 'items') walk(v, fn, [...trail, k]);
  }
};

test('the MiniApp is schema-shaped: ids, events reference the wrapper workflow, triggers name declared events, component types are in the catalogue', () => {
  const app = sliceMiniapp();
  assert.equal(app.$schema, 'agentmaurice.miniapp/v2');
  assert.equal(app.schema_version, 2);
  assert.equal(app.kind, 'miniapp');
  assert.match(app.miniapp_id, ID_RE);
  assert.ok(Array.isArray(app.events) && app.events.length === 3);
  const wfIds = Object.keys({ ...sliceWorkflows(TOOLS), ...uiWorkflows(TOOLS) }).map((f) => f.replace(/\.json$/, ''));
  const eventIds = new Set(app.events.map((e) => e.event_id));
  assert.ok(eventIds.has('run-clean') && eventIds.has('run-poisoned') && eventIds.has('verify-evidence'));
  for (const ev of app.events) {
    assert.match(ev.event_id, ID_RE);
    assert.equal(ev.trigger, 'action.click');
    assert.ok(wfIds.includes(ev.workflow.workflow_id), `event ${ev.event_id} references deployed workflow ${ev.workflow.workflow_id}`);
    assert.ok(['run', 'verify'].includes(ev.result_to_state));
    if (ev.event_id.startsWith('run-')) assert.ok(['clean', 'poisoned'].includes(ev.workflow.input.kind));
  }
  // every on_click names a declared event_id
  const clicks = [];
  walk(app.ui.configuration.layout, (node) => {
    if (node.on_click) clicks.push(node.on_click);
    assert.ok(COMPONENT_TYPES.includes(node.type), `component type ${node.type} is in the catalogue`);
  });
  assert.deepEqual(clicks.sort(), [...eventIds].sort());
  // state bindings only reference declared state (run, status)
  const statePaths = [];
  walk(app.ui.configuration.layout, (node) => {
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object' && typeof v.state === 'string') statePaths.push(v.state);
    }
  });
  for (const p of statePaths) {
    assert.ok(p === 'status' || p.startsWith('run.') || p.startsWith('verify.'), `binding ${p} is under the declared state`);
  }
  // honesty: no static success claim anywhere; outcomes bind to execution state
  let hasOutcomeBinding = false;
  walk(app.ui.configuration.layout, (node) => {
    if (node.tone === 'success') throw new Error('no static success callout is allowed');
    if (node.value?.state === 'run.execution.state') hasOutcomeBinding = true;
  });
  assert.ok(hasOutcomeBinding, 'the outcome panel binds to run.execution.state (success only after settlement is confirmed)');
  assert.ok(statePaths.includes('run.execution.paymentId'));
  assert.ok(statePaths.includes('run.evidence.check.exitCode'), 'the offline-check verdict is on screen');
  assert.ok(statePaths.includes('run.evidence.runDir'), 'the downloadable package location is on screen');
});

test('the wrapper workflow run-slice-ui: kind input, deterministic prepare (no model call), sync call of invoice-payment, evidence packaging step', () => {
  const all = { ...sliceWorkflows(TOOLS), ...uiWorkflows(TOOLS) };
  const ui = all['run-slice-ui.json'];
  assert.equal(ui.workflow_id, 'run-slice-ui');
  assert.deepEqual(ui.input_schema.properties.kind.enum, ['clean', 'poisoned']);
  assert.equal(ui.input_schema.additionalProperties, false);
  const kinds = ui.actions.map((a) => a.type);
  assert.deepEqual(kinds, ['code_execution', 'workflow_call', 'tool_call', 'code_execution']);
  assert.ok(!ui.actions.some((a) => a.type === 'llm_call'), 'no model call anywhere in the wrapper');
  assert.ok(!all['invoice-payment.json'].actions.some((a) => a.type === 'llm_call'), 'no model call in the slice workflow either');
  const run = ui.actions[1];
  assert.equal(run.workflow_id, 'invoice-payment');
  assert.equal(run.execution, 'sync');
  assert.deepEqual(Object.keys(run.input).sort(), ['idempotencyKey', 'invoiceText', 'runId', 'taskId']);
  const pkg = ui.actions[2];
  assert.equal(pkg.tool, TOOLS.packageTool);
  assert.deepEqual(Object.keys(pkg.params).sort(), ['kind', 'runId', 'taskId'], 'scalars only: object refs stringify in tool params, the tool reads the run dir');
  // measured latency, not claimed: startedAt/endedAt in the output
  assert.equal(ui.output.startedAt, '{{ prepared.startedAt }}');
  assert.equal(ui.output.endedAt, '{{ timing.endedAt }}');
  assert.equal(ui.output.evidence, '{{ evidence }}');
  // the embedded invoices are the repo's synthetic fixtures, by kind
  const prep = ui.actions[0].code;
  assert.match(prep, /invoices = \{/);
  assert.match(prep, /DEMO-INV-2201/);
  assert.match(prep, /Assistant:/, 'the poisoned case carries the labeled hidden line');
});

test('verify-last-run workflow: packages the newest ui-* run through evidence_package_v1 (how a denied run gets its package)', () => {
  const all = { ...sliceWorkflows(TOOLS), ...uiWorkflows(TOOLS) };
  const v = all['verify-last-run.json'];
  assert.equal(v.workflow_id, 'verify-last-run');
  assert.ok(!v.actions.some((a) => a.type === 'llm_call'));
  assert.equal(v.actions[0].tool, TOOLS.packageTool);
  assert.deepEqual(v.actions[0].params, { runId: '{{ runId }}' });
  assert.equal(v.output.packagedRunId, '{{ evidence.runId }}');
  const app = sliceMiniapp();
  const ev = app.events.find((e) => e.event_id === 'verify-evidence');
  assert.equal(ev.workflow.workflow_id, 'verify-last-run');
  assert.deepEqual(ev.workflow.input, { runId: 'latest' });
  assert.equal(ev.result_to_state, 'verify');
});

test('the adapter MCP server publishes evidence_package_v1 over stdio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-mcp-'));
  const configPath = path.join(dir, 'adapter-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ repoRoot: path.resolve(HERE, '..', '..'), tasksDir: path.join(HERE, '..', 'fixtures', 'tasks'), runsDir: dir, bankUrl: 'http://127.0.0.1:1' }));
  const child = spawn(process.execPath, [path.join(HERE, '..', 'src', 'maurice', 'adapter-mcp.mjs')], {
    env: { ...process.env, ADAPTER_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const lines = [];
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      let at;
      while ((at = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, at)); buf = buf.slice(at + 1); }
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await new Promise((resolve) => {
      const t = setInterval(() => { if (lines.some((l) => l.includes('"tools"'))) { clearInterval(t); resolve(); } }, 50);
      setTimeout(() => { clearInterval(t); resolve(); }, 5000);
    });
    const list = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.result?.tools);
    assert.ok(list, 'tools/list answered');
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['proposals_create_v1', 'secrets_read_v1', 'payments_execute_v1', 'evidence_package_v1']) {
      assert.ok(names.includes(n), `tool ${n} is published`);
    }
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
