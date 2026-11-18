# The Maurice invoice slice (Milestone 1 of MAURICE-IMPLEMENTATION-PLAN.md)

One clean vertical slice: a trusted task (purchase-order fixture), a Maurice
workflow that proposes one structured payment from an untrusted invoice, an
enforcement adapter that is the agent's only bank route, and the repository's
own mock bank behind an idempotency front. The original replay demo in
`three-party/src/engine` is untouched and keeps its `supplied` / `fallback`
labels; this slice is an additional, separately labeled mode.

```
three-party/fixtures/tasks/po-DEMO-INV-2201.task.json   trusted task setup (the only source of intent)
three-party/src/maurice/contracts.mjs                    TrustedTask, Proposal, ExecutionRequest, Decision, Event
three-party/src/maurice/extract.mjs                      deterministic proposal extractor + the workflow spec
three-party/src/maurice/adapter.mjs                      enforcement adapter: propose/execute, state machine, events
three-party/src/maurice/bank-server.mjs                  mock bank (repo's startBank) + idempotency front
three-party/src/maurice/adapter-mcp.mjs                  the adapter as a STDIO MCP server for the agent
three-party/src/maurice/mcp-package/                     npx-launchable package of the MCP server
three-party/src/maurice/run-slice.mjs                    local run of the slice (no Maurice)
three-party/src/maurice/live.mjs                         live run through a real Maurice One instance
three-party/src/maurice/wimse.mjs                        live WIMSE: demo identity, WIT mint/verify, RFC 9421 sign/verify, jti store (Milestone 3)
three-party/src/maurice/aep.mjs                          the run's artifacts as AEP records + the offline check (Milestone 4)
three-party/src/maurice/ui.mjs                           the MiniApp + the run-slice-ui / verify-last-run workflows (Milestone 5)
three-party/src/maurice/ui-demo.mjs                      presenter startup/teardown: bank + WIMSE session, spec deploy, evidence download server
three-party/test/maurice-*.test.mjs                      contract, adapter, WIMSE, AEP, UI and live tests
```

## Milestone 3 — live WIMSE delegation at the bank boundary

Every payment POST the adapter makes now carries a live WIMSE authority: a
fresh WIT (`typ wit+jwt`, ES256, `cnf.jwk` naming the workload key) plus an
RFC 9421 signature over `@method @path @query content-type content-digest
txn-token workload-identity-token` with the `wimse-workload-to-workload` tag
and a `wimse-aud` parameter — the wire format of the pinned AI2II capture.
The bank server verifies it independently of the adapter's allow decision,
before the AAP grant check: WIT signature under the trusted issuer JWKS,
issuer trust, expiry, jti replay, expected `sub`, audience, content-digest
and the request signature under the workload key the WIT confirmed. The bank's
journal (`GET /v1/wimse-decisions`, file `bank/wimse-decisions.jsonl`) is an
unsigned decision log — hashes of the WIT/signature/txn only, never a value.

Each run gets a fresh demo identity (`createDemoIdentity`): private halves in
mode-0600 files under the run directory, the public JWKS as evidence. The
signer (`createWimseSigner`, producer `wimse-signer` in the events, separate
from `enforcement-adapter`) mints a fresh WIT per attempt, so a retry under
the same idempotency key stays a safe idempotent retry, while a
byte-identical replay (same jti) is refused `wimse-replay`. Rejections are
named: `wimse-token-missing`, `wimse-wit-*`, `wimse-replay`, `wimse-sub`,
`wimse-sig-*`, `wimse-digest`. Delegation-chain fixtures
(`fixtures/delegation-chain/`) are checked through the repo's own
`verifyDelegationChain`, so broken parent linkage, broadened authority and
expiry give their Table 2 outcomes. Private WIMSE keys live OUTSIDE the run
directory (`<runsDir>.wimse/<runId>/`, mode 0600, deleted when the run ends);
the run dir keeps only the public JWKS.

## Milestone 4 — evidence packages with explicit guarantees

Each slice run (local and live) now maps its artifacts onto the repository's
existing AEP format and verifier, used unextended (`three-party/src/record`,
`three-party/src/verifier`): `aep.mjs` writes one `actions/NN-<step>.action.json`
per run step — propose, each secret-read probe, execute, settlement (the bank
outcome, agent → bank domain) and, with WIMSE on, the bank's wimse-gate
decision — with the exact canonical JSON of the artifact as the signed
response body, so the task, the proposal (by SHA-256), the decision and the
bank outcome are linked into every record. `packageRun` then drives the tree's
own `recordWriter` (run test key + pin held outside the run dir in
`<runsDir>.pins/`, records + one tampered copy + `records/manifest.json`,
private key deleted after the last signature) and the offline check, which
writes `offline-check.json` with the verifier's sha256, the pin's sha256 and
the network-denial measurement.

The three evidence kinds stay distinguishable: the original wire signatures
(WIT / RFC 9421) are never stored, only their SHA-256 (in the `wimse-signer`
events and the bank journal); the AEP records are the collector-signed
observations, signed by the run's test key; `events.jsonl` and
`bank/wimse-decisions.jsonl` are unsigned logs, the latter labeled
"unsigned decision log, not signed evidence".

Offline verification checks the supported signatures and commitments without
contacting Maurice, under the pin and the verifier file as trust anchors. It
cannot prove format steps 7–10 (the verifier's notes say so), nor that no
alternative request ever reached the bank — absence of settlement is shown
only by the instrumented mock bank's ledger within the test scope. Intact
clean and denied packages verify offline (exit 0; the tampered copy is
expectedly rejected); a tampered or removed record fails (exit 4); a missing
pin or manifest is an error (exit 1), never a pass.

## Milestone 5 — the MiniApp presenter (Maurice version)

The slice is deployable as a real MiniApp (`agentmaurice.miniapp/v2`) in the
same Agent Spec project as the workflows: `agents/slice/miniapps/invoice-payment-demo.json`
(built by `ui.mjs`). Two buttons run the cases through the wrapper workflow
`run-slice-ui` (input `{kind: clean|poisoned}` — a code step builds the run
inputs deterministically, calls `invoice-payment` synchronously, then packages
evidence; no model call anywhere), and a third button runs `verify-last-run`,
which packages and offline-checks the newest `ui-*` run (this is how a denied
run gets its package, since a refusal ends the wrapper as a business failure).
The adapter's MCP server gained `evidence_package_v1`, which signs the run's
actions as AEP records and runs the offline check in-process, deriving the
decisions from the run's own records.

The panels bind to the run state: trusted-vs-extracted comparison table, event
timeline, decision and outcome (success only ever bound to
`run.execution.state=settled`), WIMSE gate counts, the AEP records with hashes,
the offline-check verdict, and the run directory to download the package from.
Measured start/end times are in the output — latency is measured, not claimed.

Run it:

```sh
node three-party/src/maurice/ui-demo.mjs        # start: bank + WIMSE session, deploy verified, serve runs/ read-only
maurice home                                    # open the One home, run the "Invoice payment — Maurice slice" MiniApp
# or drive the viewer protocol directly:
maurice viewer connect --deployment <agentId>
maurice viewer open invoice-payment-demo --deployment <agentId> --recipe-server http://127.0.0.1:5011 --json
maurice viewer submit <instanceId> run-clean --recipe-server http://127.0.0.1:5011 --expected-state-version 1 --json
maurice viewer show <instanceId> --recipe-server http://127.0.0.1:5011 --json
node three-party/src/maurice/ui-demo.mjs --teardown          # keeps evidence; add --purge-evidence only to delete it
```

Reset/teardown never erase evidence: run directories (the AEP packages) stay
under `three-party/runs/ui/` unless `--purge-evidence` is given explicitly.

Run it locally (no Maurice needed), clean or poisoned:

```sh
node three-party/src/maurice/run-slice.mjs --kind clean
node three-party/src/maurice/run-slice.mjs --kind poisoned
```

The poisoned run follows the invoice's hidden `Assistant:` line deterministically (the labeled deterministic adversarial proposal: changed payee plus a secret-read request). Every prohibited action is denied by the adapter — at proposal time and again at execution time — and the mock bank settles nothing. The run's `meta.json`, `state.json` and every event carry the mode label (`clean` / `poisoned-document`), and only the synthetic secret name is ever recorded, never a value.

Run it against a real local Maurice One (requires the `maurice` binary and a
running instance; the test is skipped otherwise):

```sh
MAURICE_LIVE=1 PATH="$HOME/.local/bin:$PATH" node --test --test-force-exit three-party/test/maurice-live.test.mjs
```

Execution modes and their labels: `local` (run-slice.mjs drives the adapter
directly, no Maurice), `live` (live.mjs drives a deployed workflow through the
CLI; the adapter MCP server identifies itself as "enforcement-adapter
(separate from Maurice)"), and the original replay demo (`npm run three-party`),
which labels the AI2II capture crossing `supplied` and its stand-in `fallback`.
Kinds: `clean` settles exactly once (idempotency key; a repeated key never
settles again, a repeated key with different details is rejected, a timeout is
`unknown`, never a denial); `poisoned` is denied everywhere with zero bank
settlement requests.
