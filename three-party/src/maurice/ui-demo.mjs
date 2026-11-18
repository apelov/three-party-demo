// Milestone 5: the presenter demo. Starts the mock bank with a live WIMSE
// authority (one session identity for the whole demo), writes the adapter
// configuration, deploys the Agent Spec project — the two slice workflows,
// the run-slice-ui wrapper and the invoice-payment-demo MiniApp — on an
// isolated test Agent, and serves the runs directory read-only so the
// presenter can download a run's evidence package (AEP records, manifest,
// offline-check.json, pin) from the browser.
//
//   node three-party/src/maurice/ui-demo.mjs                 start + deploy, then serve until Ctrl+C
//   node three-party/src/maurice/ui-demo.mjs --teardown [--purge-evidence]
//   node three-party/src/maurice/ui-demo.mjs --status
//
// After startup, open the One home (`maurice home`) and run the MiniApp
// "Invoice payment — Maurice slice" on the test Agent, or call the wrapper
// workflow directly:
//   maurice test workflow call run-slice-ui --agent-id <id> --input-file <file> --json
// with input {"kind":"clean"} or {"kind":"poisoned"}.
//
// Reset/teardown never erase evidence: run directories (the AEP packages)
// stay on disk unless --purge-evidence is given explicitly.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startBankServer, REPO_ROOT, DEFAULT_TASKS_DIR, MAURICE_DIR } from './bank-server.mjs';
import { sliceWorkflows } from './extract.mjs';
import { uiWorkflows, sliceMiniapp } from './ui.mjs';
import { createDemoIdentity, writePrivateKeyFile, wimseKeysDirOf } from './wimse.mjs';
import { compactStamp, writeJsonAtomic } from '../engine/store.mjs';
import { runCli } from './live.mjs';

export const UI_RUNS_DIR = path.join(MAURICE_DIR, 'runs', 'ui');
export const MINIAPP_ID = 'invoice-payment-demo';
const CONFIG_DIR = '_config';
const BANK_RUN = '_bank-ui';
const DEFAULT_STATIC_PORT = 7490;

const stateFile = (runsDir) => path.join(runsDir, CONFIG_DIR, 'ui-demo.json');
const readState = (runsDir) => {
  try { return JSON.parse(fs.readFileSync(stateFile(runsDir), 'utf8')); } catch { return null; }
};

// A read-only download server for the runs directory: GET only, paths kept
// inside runsDir, everything served as an attachment.
export function startEvidenceServer(runsDir, port = DEFAULT_STATIC_PORT) {
  const root = path.resolve(runsDir);
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const items = fs.readdirSync(abs).map((n) => ({ name: n, dir: fs.statSync(path.join(abs, n)).isDirectory() }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ dir: `/${rel}`, items }, null, 2));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${path.basename(abs)}"`,
        'content-length': st.size,
      });
      fs.createReadStream(abs).pipe(res);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Deploys the UI slice on a fresh isolated test Agent and starts the bank +
// evidence server. Returns a handle with the identifiers and a cleanup
// function. cleanup({ purgeEvidence }) removes the test Agent and the
// session WIMSE keys; run directories (evidence) are kept unless purgeEvidence.
export async function deployUiSlice({
  mauriceBin = 'maurice',
  repoRoot = REPO_ROOT,
  tasksDir = DEFAULT_TASKS_DIR,
  runsDir = UI_RUNS_DIR,
  deploymentName = `maurice-ui-demo-${Date.now().toString(36)}`,
  staticPort = DEFAULT_STATIC_PORT,
  clock = () => new Date(),
} = {}) {
  fs.mkdirSync(path.join(runsDir, CONFIG_DIR), { recursive: true });

  // One session WIMSE identity for the whole demo: private keys outside the
  // runs dir, the bank trusts the public JWKS; every payment still carries a
  // fresh WIT (fresh jti) per attempt.
  const iss = 'https://slice-issuer.example';
  const sub = 'wimse://slice.local/agent/ui-demo';
  const identity = createDemoIdentity({ iss, sub });
  const keysDir = wimseKeysDirOf(runsDir, 'ui-session');
  writePrivateKeyFile(path.join(keysDir, 'issuer.key.json'), identity.issuer);
  writePrivateKeyFile(path.join(keysDir, 'workload.key.json'), identity.workload);

  const server = await startBankServer({
    repoRoot, clock, runDir: path.join(runsDir, BANK_RUN),
    wimse: { jwks: identity.jwks, trustedIssuers: identity.trustedIssuers, expectedSub: sub },
  });

  const configPath = path.join(runsDir, CONFIG_DIR, 'adapter-config.json');
  writeJsonAtomic(configPath, {
    repoRoot, tasksDir, runsDir, bankUrl: server.url,
    wimse: { identityDir: keysDir, iss, sub },
  });

  const evidence = await startEvidenceServer(runsDir, staticPort);

  const steps = [];
  const note = (name, ok, detail = null) => { steps.push({ name, ok, detail }); };
  let agentId = null;
  let agentName = null;
  const specDir = path.join(runsDir, CONFIG_DIR, `spec-${compactStamp(clock())}`);
  try {
    let r = await runCli(mauriceBin, ['test', 'setup', '--fresh', '--save=false', '--deployment-name', deploymentName, '--json']);
    if (r.code !== 0 || !r.json?.agent_id) throw new Error(`test setup failed: ${r.stdout} ${r.stderr}`);
    agentId = r.json.agent_id;
    agentName = r.json.agent_name ?? r.json.name ?? null;
    note('test setup', true, agentId);

    r = await runCli(mauriceBin, ['spec', 'init', '--env', 'local', '--agent-alias', 'slice', '--agent-id', agentId, '--dir', specDir, '--json']);
    if (r.code !== 0) throw new Error(`spec init failed: ${r.stdout} ${r.stderr}`);

    const mcpDef = {
      name: 'enforcement-adapter',
      command: 'npx',
      arguments: ['-y', path.join(repoRoot, 'three-party', 'src', 'maurice', 'mcp-package')],
      env: [`ADAPTER_CONFIG=${configPath}`],
    };
    const mcpDir = path.join(specDir, '.mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const mcpDefPath = path.join(mcpDir, 'enforcement-adapter.json');
    writeJsonAtomic(mcpDefPath, mcpDef);
    r = await runCli(mauriceBin, ['test', 'mcp', 'install', '--agent-id', agentId, '--file', mcpDefPath, '--wait', '--json'], { timeoutMs: 240000 });
    if (r.code !== 0) throw new Error(`mcp install failed: ${r.stdout} ${r.stderr}`);
    const names = r.json?.tools ?? r.json?.published_tools ?? [];
    const toolName = (frag) => (Array.isArray(names) ? names : []).map((t) => (typeof t === 'string' ? t : t.name)).find((n) => n && n.includes(frag));
    const tools = {
      proposeTool: toolName('proposals_create_v1'),
      executeTool: toolName('payments_execute_v1'),
      secretReadTool: toolName('secrets_read_v1'),
      packageTool: toolName('evidence_package_v1'),
    };
    if (!tools.proposeTool || !tools.executeTool || !tools.secretReadTool || !tools.packageTool) throw new Error(`the adapter's tools did not publish: ${JSON.stringify(names)}`);
    note('mcp install', true, tools);

    const workflows = { ...sliceWorkflows(tools), ...uiWorkflows(tools, { repoRoot }) };
    const workflowsDir = path.join(specDir, 'agents', 'slice', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    for (const [name, wf] of Object.entries(workflows)) writeJsonAtomic(path.join(workflowsDir, name), wf);
    const miniappsDir = path.join(specDir, 'agents', 'slice', 'miniapps');
    fs.mkdirSync(miniappsDir, { recursive: true });
    writeJsonAtomic(path.join(miniappsDir, `${MINIAPP_ID}.json`), sliceMiniapp());

    r = await runCli(mauriceBin, ['spec', 'check', '--env', 'local', '--agent-alias', 'slice', '--dir', specDir, '--json']);
    if (r.code !== 0) throw new Error(`spec check failed: ${r.stdout} ${r.stderr}`);
    note('spec check (workflows + miniapp)', true);

    await runCli('git', ['init'], { cwd: specDir });
    await runCli('git', ['add', '-A'], { cwd: specDir });
    await runCli('git', ['-c', 'user.email=slice@demo.local', '-c', 'user.name=slice', 'commit', '-m', 'invoice-payment slice + MiniApp (ui demo)'], { cwd: specDir });

    r = await runCli(mauriceBin, ['spec', 'deploy', '--env', 'local', '--agent-alias', 'slice', '--dir', specDir, '--tests', 'auto', '--json'], { timeoutMs: 240000 });
    const verified = (v) => (v && typeof v === 'object' ? (v.verified === true || Object.values(v).some(verified)) : false);
    if (r.code !== 0 || !verified(r.json)) throw new Error(`spec deploy failed or unverified: ${r.stdout} ${r.stderr}`);
    note('spec deploy (verified)', true);

    writeJsonAtomic(stateFile(runsDir), {
      agentId, agentName, deploymentName, specDir, bankUrl: server.url,
      evidenceUrl: evidence.url, runsDir, miniappId: MINIAPP_ID, wimse: { iss, sub }, startedAt: clock().toISOString(),
    });

    return {
      agentId, agentName, specDir, runsDir, bankUrl: server.url, evidenceUrl: evidence.url,
      miniappId: MINIAPP_ID, tools, steps, configPath,
      async cleanup({ purgeEvidence = false } = {}) {
        if (agentId) await runCli(mauriceBin, ['test', 'cleanup', '--agent-id', agentId, ...(agentName ? ['--expect-name', agentName] : []), '--apply', '--json'], { timeoutMs: 180000 });
        await server.stop().catch(() => {});
        evidence.server.close();
        fs.rmSync(keysDir, { recursive: true, force: true });
        try { fs.rmSync(`${path.resolve(runsDir)}.wimse`, { recursive: true, force: true }); } catch { /* gone */ }
        if (purgeEvidence) fs.rmSync(runsDir, { recursive: true, force: true });
        try { fs.rmSync(stateFile(runsDir), { force: true }); } catch { /* gone */ }
      },
    };
  } catch (err) {
    err.agentId = agentId;
    err.specDir = specDir;
    await server.stop().catch(() => {});
    evidence.server.close();
    throw err;
  }
}

// CLI entry: start (default), --status, --teardown [--purge-evidence].
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const mode = args.includes('--teardown') ? 'teardown' : (args.includes('--status') ? 'status' : 'start');
  const purge = args.includes('--purge-evidence');
  const runsDir = UI_RUNS_DIR;
  const mauriceBin = 'maurice';
  if (mode === 'status') {
    const st = readState(runsDir);
    console.log(JSON.stringify(st ?? { running: false }, null, 2));
    process.exit(st ? 0 : 1);
  }
  if (mode === 'teardown') {
    const st = readState(runsDir);
    if (!st?.agentId) { console.error('no saved demo state; nothing to tear down'); process.exit(1); }
    const c = spawnSync(mauriceBin, ['test', 'cleanup', '--agent-id', st.agentId, ...(st.agentName ? ['--expect-name', st.agentName] : []), '--apply', '--json'], { encoding: 'utf8' });
    console.log(c.stdout || c.stderr);
    fs.rmSync(`${path.resolve(runsDir)}.wimse`, { recursive: true, force: true });
    if (purge) { fs.rmSync(runsDir, { recursive: true, force: true }); console.log('evidence purged (--purge-evidence)'); }
    else console.log(`run evidence kept under ${runsDir} (pass --purge-evidence to remove it)`);
    try { fs.rmSync(stateFile(runsDir), { force: true }); } catch { /* gone */ }
    process.exit(c.status ?? 0);
  }
  // start
  const handle = await deployUiSlice({ mauriceBin, runsDir });
  console.log(JSON.stringify({
    deployed: true,
    agentId: handle.agentId,
    miniappId: handle.miniappId,
    bankUrl: handle.bankUrl,
    evidenceDownloadUrl: `${handle.evidenceUrl}/`,
    runsDir,
    open: 'run `maurice home` and open the MiniApp "Invoice payment — Maurice slice" on this Agent; or call the workflow: maurice test workflow call run-slice-ui --agent-id ' + handle.agentId + ' --input-file <file with {"kind":"clean"}> --json',
    teardown: `node ${process.argv[1]} --teardown   (add --purge-evidence only to delete the evidence too)`,
    steps: handle.steps,
  }, null, 2));
  const shutdown = async () => {
    console.log('shutting down: test agent cleanup; run evidence kept');
    await handle.cleanup({ purgeEvidence: false });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
