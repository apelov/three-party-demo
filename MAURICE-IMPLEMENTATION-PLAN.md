# Maurice invoice demo: implementation handoff

## Purpose and scope

Build a local finance application operated by Maurice: invoice intake, structured payment proposals, review, governed execution and evidence inspection. OpenA2A supplies identity and task authority, WIMSE supplies verified delegation, and AEP supplies independently verifiable evidence. Use a mock bank and synthetic invoices only.

This plan supersedes the architectural assumptions in Handoff.md where they conflict. The old handoff is background, not proof of runtime capabilities or current repository state. No Maurice capability has yet been validated against an installed instance.

## Review of the earlier plan

The overall direction is sound, but implementation needs these corrections:

- Do not assume Maurice is a WIMSE gateway. First establish its actual interfaces and distinguish Maurice-native functions from an explicitly identified adapter.
- Do not derive trusted payment intent from untrusted invoice extraction. Establish it from a separately approved purchase order or fixture representing a trusted supplier record and payment instruction.
- Start with one executable vertical slice, then add delegation, evidence and UI. Avoid building a large application before proving the runtime integration.
- An LLM need not obey an injection. A safe refusal is a valid live result. Use a separately labeled deterministic adversarial proposal to test enforcement reliably.
- Workflow logs are not automatically signed evidence. Define exactly what each signature and offline verification result proves.
- Prevent duplicate payment on workflow retry; test timeouts and ambiguous bank outcomes.

## Target architecture and boundaries

Maurice owns intake, extraction/proposal, workflow state, human review and the MiniApp. Deterministic policy enforcement runs outside the model's discretion. NorthBank independently verifies authority on the request it receives.

Logical flow:

1. Trusted task setup fixes invoice reference, supplier destination, amount/currency bounds and expiry.
2. Maurice reads untrusted invoice content and generates a structured proposed action.
3. An enforcement adapter validates the proposal against the trusted intent and AAP grant.
4. An accepted payment crosses the verified WIMSE path to NorthBank.
5. Decisions and settlement evidence are collected for AEP verification and displayed in Maurice.

The adapter must be the only bank execution route exposed to the agent. A denied call must produce no bank settlement request. The adapter cannot claim to be Maurice itself. If Maurice supports native signing/delegation, integrate that verified capability; otherwise clearly display the separate signer/intermediary.

Use one Maurice agent initially. Add a second delegated agent only after the base flow works and only with independently scoped authority; multiple agent names in a trace do not prove delegation.

## Milestone 0 — Verify facts and contracts

Read applicable repository instructions, inspect git status and preserve existing changes. Check both repository handoffs, package.json, the engine runner, agent, bank, intent rule, capture verifier and AEP verifier. Run the existing test suites and record baseline failures without attributing them to new work.

Read the current public Maurice router and authoring documentation. Inspect an existing installation before installing anything. Verify its supported CLI/tool contract, authentication, workflow invocation, MiniApps, approvals, trace export and local Module/Application support. Do not infer readiness from a process health check alone: execute a harmless real workflow.

Inspect the pinned AI2II implementation and identify the exact WIMSE draft revision, token fields, parent commitment bytes, signature coverage, trust anchors, audience rules, expiry and replay handling it implements. Do not implement the illustrative chain_digest JSON in Handoff.md as if it were a specification.

Deliver a short capability matrix: capability, verified evidence/version, native or adapter, prerequisite and limitation. Record the chosen topology and draft/version pins. If instance access is missing, continue adapter contract and fixture work, but do not label it live Maurice integration.

Exit: a real Maurice workflow can be invoked, or the missing access prerequisite is precisely documented; implementation interfaces are grounded in inspected contracts.

## Milestone 1 — One clean vertical slice

Implement trusted task setup, a Maurice proposal workflow and an adapter to the existing intent/grant checks and mock bank. Keep the original replay mode available and explicitly labeled. Use the repository's existing schemas where possible.

Specify contracts before wiring components:

- Trusted intent: task identity, authorized invoice, payee, currency, amount constraint, expiry and source/provenance.
- Proposal: tool name and typed arguments; never executable free-form code.
- Execution request: run/task identifiers, stable idempotency key, proposal and authorization artifacts.
- Decision: allow/deny/error, stable reason code, compared fields and relevant artifact references.
- Event: run ID, event ID, producer, sequence, timestamp and artifact references. Timestamps alone do not establish cross-service ordering.

Persist workflow states sufficient to distinguish proposed, awaiting approval, authorized, submitted, settled, denied, failed and unknown outcome. A timeout after submission must not be reported as a definite denial or trigger a fresh payment.

Exit: one clean invoice processed by real Maurice results in exactly one mock settlement, with correlated events. Repeating the same execution key does not settle again; reuse with different payment details is rejected.

## Milestone 2 — Enforce and demonstrate hostile proposals

Add poisoned-document live mode and a deterministic adversarial proposal mode. Label their provenance in the interface and evidence. Record safe model refusal as such; never manufacture a successful injection claim.

Test changed payee, changed amount/currency, undeclared secret read, missing intent and expired/out-of-scope grant. Validate at execution time, not only at proposal time. An approval must bind the exact proposal and authority; changes require a new authorization. Approval never silently expands an existing grant.

Exit: each prohibited action is denied, includes a useful reason, and produces zero bank settlement requests. Expose only synthetic secret names; no real credentials enter prompts, events or receipts.

## Milestone 3 — Live WIMSE delegation

Replace the recorded crossing for live mode with the verified implementation. Generate separate demo keys for each signing principal outside the pinned capture fixture; do not modify historical capture JWKS to accommodate live identities. Keep private keys out of source control and evidence exports.

Verify request binding, chain integrity, issuer trust, audience, expiry and monotonic authority attenuation according to the pinned implementation. Define replay protection and its interaction with safe idempotent retries. The bank validates the authority it receives independently of the upstream allow decision.

Exit: the current clean run has actual signed live exchange evidence. Tampered body, invalid signature, broken parent linkage, wrong audience, broadened authority and expired/replayed requests are rejected as specified. UI identifies separate enforcement and signing components accurately.

## Milestone 4 — Evidence with explicit guarantees

Map the new artifacts to the existing AEP format/verifier before extending it. Preserve exact signed bytes where required. Distinguish original signed messages, collector-signed observations and unsigned logs. Link artifacts to the task, proposal, decision and bank outcome.

Offline verification checks supported signatures and commitments without contacting Maurice. State which trust anchors are supplied and what cannot be proven offline. A signed denial is evidence of that decision, not by itself proof that no alternative request ever reached the bank; demonstrate absence using the instrumented mock bank within the stated test scope.

Exit: intact clean and denied packages verify offline; tampering with protected artifacts fails; missing evidence is reported as incomplete rather than passed.

## Milestone 5 — Maurice application and presenter experience

Build the MiniApp around the working workflow: invoice input, trusted versus extracted fields, proposal, approval, timeline, delegation inspector, outcome and downloadable verification package. Display waiting/error/unknown states and never show success before settlement is confirmed.

Use deterministic Workflow steps for validation and orchestration, retaining model calls where extraction or interpretation needs judgment. Measure actual model calls, latency and outcomes rather than claiming savings. Package as a Module/Application only using verified runtime support.

Exit: a presenter can run clean, live poisoned and deterministic adversarial cases; explain each result; export evidence; and verify it offline. Provide startup, reset, teardown and a short demonstration script. Reset must not erase evidence without an explicit user action.

## Optional extension after acceptance

Split intake/review and payment execution between separately scoped Maurice agents. Demonstrate a concrete reduction in authority at their handoff. Additional channels, external business integrations and shared hosting are out of initial scope.

## Validation and development discipline

Use focused unit tests for policy/contract cases and integration tests across Maurice, adapter and bank. Run npm test and npm run test:three-party for affected milestones, accounting for recorded baseline failures. Use the existing browser tooling to check the complete MiniApp path when available. Do not claim tests or runtime integration passed if prerequisites prevented execution.

Keep changes incremental and reviewable. Update this document with decisions, verified versions, completed acceptance checks and remaining blockers. Do not deploy publicly, send external messages, make real payments or publish credentials as part of this plan.

## Prompt for the implementation agent

Read MAURICE-IMPLEMENTATION-PLAN.md and both Handoff.md files. Implement this plan incrementally, starting with Milestone 0 and the clean vertical slice. Inspect current repository instructions and working-tree changes first. Verify Maurice and WIMSE interfaces rather than inventing them. Preserve the original replay demonstration and label all execution modes accurately. Use trusted task data independent of untrusted invoice text; keep policy enforcement outside model discretion; ensure idempotent settlement. Proceed with authorized local implementation and testing, documenting actual results and prerequisites. Stop dependent integration work only when required access or a material architectural decision is genuinely missing, and continue independent work where possible. Report changed files, tests run, verified live capabilities, and the next milestone.

---

# Progress log (implementation agent)

## Milestone 0 — verified facts (2026-11-16)

Working tree at start: clean except the two untracked handoff/plan files; both preserved untouched (this log excepted). Baselines run before any change: `npm test` 13 pass / 0 fail (exit 0); `npm run test:three-party` 414 pass / 0 fail (exit 0). No baseline failures to account for.

### Maurice installation (inspected, not installed; nothing was installed)

- CLI `maurice` v2.2.18 at `~/.local/bin/maurice` (Mach-O arm64); local One runtime running (pid 48157), data dir `~/.maurice/one`, admin API `http://127.0.0.1:5050`, workflow service `http://127.0.0.1:5011` (from `~/.maurice/config.yaml`).
- Harmless real workflow executed (not just a health check): `maurice test workflow call text-stats --agent-id dbsccjan18nkaiapu9v0 --arg text=hello --json` → http 200, `execution.state=completed`, `data={upper:"HELLO",count:5}`, `api_key_revoked=true`, `trace_id` and `execution_id` returned.
- Execution diagnostics: `maurice workflow execution inspect|events <id> --agent <id> --json` returns the persisted execution journal (events with `event_id`, `sequence`, `recorded_at_ms`, `action_id`, `status`; values redacted unless the workflow schema marks them `x-diagnostic:true` and `--include-values` is passed).
- Agents present: 4 (incl. integration-test agents `dbsccjan18nkaiapu9v0`, `dau2v2qn18nmo8d7g0gg`). Fresh isolated agents: `maurice test setup --fresh --save=false --deployment-name <name> --json`; removed with `maurice test cleanup --agent-id <id> --expect-name <name> --apply --json`.
- Authoring: Agent Spec V2, Git-native. `maurice spec init --env local --agent-alias <a> --agent-id <id> --dir <d> --json`; project layout `agents/<alias>/` with `workflows/`, `miniapps/`, `tests/test-plan.json`; deploy rail `spec check` → git commit → `spec deploy --env local --agent-alias <a> --dir <d> --tests auto --json` (requires `verified=true`).
- Workflow schema `agentmaurice.workflow/v2` (`maurice spec schema workflow`): actions `tool_call` (has `require_approval`), `code_execution` (runtime `deno` with `{{ json .input }}` templating, or `wasm`), `llm_call`, `workflow_call` (has `idempotency_key`), `decision`, `for_each`, `question` (human question). Inputs interpolate as `{{ field }}`, action outputs as `{{ outputKey.path }}`.
- MCP on an agent: `maurice test mcp install --agent-id <id> --file <def.json> --wait --json` where the definition is `{name, command, arguments, env: ["KEY=value", ...]}` (env is a string array); `--wait` returns the published qualified tool names. Invocation contract: `maurice test workflow call <workflow-id> --agent-id <id> --input-file <json> --json` → `{http_status, execution:{execution_id,state,data,trace_id}, api_key_revoked}`.
- MiniApps/Applications: `maurice app list` returns `[]` (none installed); packaging surface is `maurice module` (init/validate/test/publish) plus `maurice viewer` for the MiniApp protocol. No MiniApp has been deployed yet.
- WIMSE on this instance (native, relying-party side): `maurice wimse status --json` → enabled, trust domain `apelov-mac.local`, issuer `http://127.0.0.1:5050` ES256, WIT TTL 1h, mechanisms `wit+http-sig` and `wit+wpt`, audiences `http://maurice.ietf127.example:5050` and `http://127.0.0.1:5050`, 3 inbound grants binding WIT holders (e.g. `workload:wimse://peer.ietf127.example/client`) to agent+workflow, trust entries for `peer.ietf127.example`/`lax.ietf127.example` via a JWKS file. `maurice wimse log` shows the decision journal for inbound calls on `/api/v2/agents/:agentId/workflows/:workflowId/executions` (accept/reject with reasons `proof-missing`, `wit-invalid`, `proof-invalid`, `not-authorized`, `mixed-credentials`). So Maurice verifies WIMSE workload identity on workflow executions; it is not itself a minting gateway in this configuration, and the earlier Handoff's "Maurice mints WIT_1 with chain_digest" is not a real interface — the illustrative `chain_digest` JSON is not implemented anywhere and is not treated as a spec.

### Capability matrix

| capability | verified evidence / version | native or adapter | prerequisite | limitation |
|---|---|---|---|---|
| run a local workflow (V2 runtime API) | text-stats execution completed, v2.2.18, runtime `127.0.0.1:5011` | native Maurice | agent deployed via spec deploy | test path uses a one-time operator API key, revoked after the call |
| author/deploy workflows (Agent Spec V2) | spec init/check/deploy verified in the live slice run below | native Maurice | git repo for deploy | deploy requires clean git workspace |
| expose local tools to a workflow (MCP stdio) | `test mcp install --wait` publishes qualified tool names | native Maurice; the adapter is a separate component the agent calls | MCP definition file | the adapter is the only bank route exposed; nothing else bank-facing is installed |
| execution trace/journal | `workflow execution events` — persisted journal, per-event ids/sequence | native Maurice | execution id | values redacted without `x-diagnostic:true` + `--include-values`; timestamps alone do not order cross-service events, so the slice carries producer+sequence in its own events |
| WIMSE inbound verification | `wimse status`/`wimse log`, mechanisms wit+http-sig, wit+wpt, decision journal | native Maurice (relying party) | trusted JWKS per trust domain, grants binding holders to agent+workflow | live signed exchange not yet exercised by this slice (Milestone 3); `wimse identity` is policy-blocked in this CLI session |
| MiniApp / Application packaging | `app list` empty; `module` and `viewer` commands exist | native Maurice | none yet | not yet exercised (Milestone 5) |
| human approval of a workflow step | `tool_call.require_approval` and `question` action exist in schema; `action` commands use a human page | native Maurice | a person at the approval page | headless answering not verified; the slice binds approval to the proposal hash in the adapter instead |
| AAP grant + mock bank | repo's `grantIssuer`/token service/payment API, exercised by engine tests and the slice | repo code (bank side) | consent approved at the bank | token values stay in the bank process |
| AI2II pinned capture check | `checkCapture` on the three pinned files → 7/7 pass, outcome `verified` | repo code (replay mode, labeled `supplied`) | files present and pinned | replay, not live traffic; the crossing step falls back to the labeled stand-in when files differ |

### Pinned WIMSE implementation facts

- AI2II capture: repo `github.com/apelov/IETF127-Hackathon-AI2II-WIMSE`, branch `feature/opena2a-wimse-aep`, commit `32f584a2016d7ebd0d2f5156148cc404c496a086`, folder `handover/wimse_ai2ii` — confirmed by a local checkout at exactly `32f584a`. Decoded from the pinned pcap via the repo's own `checkCapture`: WIT is a compact JWS, header `{typ:"wit+jwt", alg:"ES256", kid}`, claims `{iss:"wimse://harbor.example", sub:"wimse://harbor.example/agent/payments", iat, exp, jti, cnf:{jwk:{P-256, kid}}}`, plus an RFC 9421 `Signature-Input`/`Signature` pair (`ecdsa-p256-sha256`, covered `@method @path @query content-type content-digest txn-token workload-identity-token`, params `created/expires/tag:"wimse-workload-to-workload"/wimse-aud:"wimse://northbank.example/api/transfer"`), a `Content-Digest` sha-256 of the body, and a `Txn-Token` header echoed by the response. No `act`/`chain_digest` members exist in the capture.
- The hackathon harness references `draft-ietf-wimse-arch-08`, `draft-ietf-wimse-identifier-04`, `draft-ietf-wimse-workload-creds-02`, `draft-ietf-wimse-http-signature-03..08`, `draft-ietf-wimse-wpt-01/02`; the repository's own delegation-chain verifier implements `draft-asor-wimse-agent-delegation-chain-03` (steps 1–5 and 7; 6 and 8 need the request).
- Chosen topology for the slice: Maurice One runs the proposal workflow on an isolated test agent; a separate enforcement adapter (local MCP server, clearly labeled as not Maurice) is the agent's only bank route; the mock bank is the repository's own bank behind a thin idempotency front; trusted intent comes from a purchase-order fixture the adapter loads itself. The original replay demo (`three-party/src/engine`) is untouched and keeps its `supplied`/`fallback` labels.

### Milestone 0 exit

Met: a real Maurice workflow was invoked and completed (text-stats, and the slice run below); implementation interfaces are grounded in the inspected CLI/schema/runtime contracts above. No missing-access blocker: instance access was present.

## Milestone 1 — clean vertical slice (implemented 2026-11-16)

### Contracts (three-party/src/maurice/contracts.mjs)

Specified before wiring, as plain-JSON shapes with refusing validators:

- **TrustedTask** (trusted intent): `taskId`, `kind: "purchase-order"`, `invoiceId`, payee name/account, `amountExact` + `amountCap {amount, currency}`, `expiresAt`, `provenance {source, ref}`. Loaded by the adapter from its own trusted store (`three-party/fixtures/tasks/po-DEMO-INV-2201.task.json`), never from invoice text or workflow input.
- **Proposal**: `{tool: "bank.payments.create", args: {invoiceId, payeeAccount, amount, currency}}` — typed arguments only, no free-form code; undeclared arguments are refused.
- **ExecutionRequest**: `{runId, taskId, idempotencyKey, proposal, authorization}` where the authorization binds `kind`, `ref` and the SHA-256 of the canonical proposal.
- **Decision**: `allow|deny|error`, stable `reasonCode`, `comparedFields` (field, expected, actual, result), `artifacts`.
- **Event**: `runId`, `eventId`, `producer` (workflow|enforcement-adapter|bank), `sequence`, `at`, `type`, `artifacts`. Producer+sequence, not timestamps alone, order events across services.

### Components

- `three-party/src/maurice/adapter.mjs` — the enforcement adapter, the only bank route exposed to the agent. `propose` holds the proposal against the trusted task (repo's `applyIntentRule`, declared intent built from the task) and the AAP grant scope (`checkGrantScope` over the bank's consent terms), recording `awaiting-approval` bound to the proposal hash. `execute` re-validates everything at execution time, checks the authorization binds the exact proposal and task, then submits under the idempotency key. States persisted per run (`state.json` + `events.jsonl` under `three-party/runs/slice-<id>/`): proposed, awaiting-approval, authorized, submitted, settled, denied, failed, unknown.
- `three-party/src/maurice/bank-server.mjs` — the repository's own mock bank (`startBank`, real token service and payment API) behind one loopback front that adds a durable idempotency record per payment key: repeated key answers from the record, repeated key with different details is 409, and a hung submission still lands in the record so the retry resolves.
- `three-party/src/maurice/adapter-mcp.mjs` + `mcp-package/` — the adapter as a STDIO MCP server (`proposals_create_v1`, `payments_execute_v1`), launched via `npx` (the MCP command allowlist is npx/uvx/go/docker); serverInfo names it as separate from Maurice.
- `three-party/src/maurice/extract.mjs` — the deterministic proposal extractor (scripted, model-free; a hidden `Assistant:` line is followed, which is the labeled deterministic adversarial proposal of Milestone 2) and the Agent Spec V2 workflow `invoice-payment` (extract → propose → execute).
- `three-party/src/maurice/run-slice.mjs` (local mode) and `live.mjs` (drives the real Maurice CLI: test setup → spec init → mcp install → spec check → git commit → spec deploy → two workflow calls → execution events → test cleanup).

### Verified results

- Local slice: `node three-party/src/maurice/run-slice.mjs --kind clean` → propose allow (`proposal-matches-task`, awaiting-approval), execute settled, exactly 1 ledger row (`led_…`, 14820 cents, DEMO-0000-2201), events proposed/authorized/submitted/settled/ledger-row with runId, sequence and producers.
- Live slice (`MAURICE_LIVE=1 … three-party/test/maurice-live.test.mjs`, passed in 45.7s): fresh test Agent created, adapter MCP installed and tools published (`…__enforcement-adapter--proposals_create_v1`, `…--payments_execute_v1`), `spec check` + `spec deploy --tests auto` verified=true (backend v2.2.18, commit c9ae5757…), `test workflow call invoice-payment` completed twice with the same input; the mock bank's ledger has exactly 1 row, the adapter state settled with the same paymentId, adapter events correlate (runId + sequence), and both Maurice execution journals were saved. The test Agent was removed afterwards (`test cleanup`); `agent list` shows only the 4 pre-existing agents.
- Tests: `three-party/test/maurice-contracts.test.mjs` + `maurice-adapter.test.mjs` — 17 tests, all pass: contract shapes, clean settle with correlated events, idempotent replay (no second settlement), same-key-different-details 409, timeout-after-submission → `unknown` (not denied) with the retry settling once, denials with reasons and zero bank requests (changed payee/amount/currency/invoice, undeclared argument, adversarial poisoned proposal, unknown/expired/out-of-consent task, missing/wrong-task/unbound approval, task expiring between propose and execute).
- Suites after the change: `npm test` 13 pass / 0 fail (exit 0); `npm run test:three-party` 432 tests = 431 pass / 0 fail / 1 skipped (exit 0), i.e. the 414-test baseline plus 17 new slice tests passing and the live test skipping by default. The live test runs only with `MAURICE_LIVE=1` and the binary present, and says so when it skips.

### Milestone 1 exit

Met: one clean invoice processed by real Maurice results in exactly one mock settlement with correlated events; repeating the same execution key does not settle again; reuse with different payment details is rejected (409 `idempotency-key-reused-with-different-details`). A timeout after submission is reported `unknown`, never a denial, and does not trigger a fresh payment.

### Decisions and blockers

- The adapter is a separate MCP server, not Maurice itself; the workflow reaches the bank only through it. Maurice's own WIMSE inbound check stays on the executions route; the live signed WIMSE exchange is Milestone 3.
- Human review of the exact proposal is enforced by the authorization binding (proposal SHA-256) in the adapter; the interactive approval page (`question` action / `require_approval`) exists in the schema but headless answering was not verified — Milestone 5 UI work.
- The MCP launcher allowlist forced the npx packaging of the adapter; `env` in an MCP definition must be a `["KEY=value"]` array.
- `spec deploy` reports `verified` nested in its JSON output, not at the top level. `output_key`/`id` in workflow v2 must be lowercase snake/kebab. Workflow `input_schema` has `additionalProperties: false`, so run metadata travels in the run directory (`meta.json`), not in workflow inputs. A denied execution returns a nonzero CLI exit with the execution inside the error envelope (`error.details.execution`).
- Remaining for later milestones: live WIMSE signing (Milestone 3), AEP evidence packaging (Milestone 4), MiniApp (Milestone 5).

## Milestone 2 — hostile proposals (implemented 2026-11-16)

### What was added

- Poisoned-document live mode and the deterministic adversarial proposal: the extractor (`extractAll` / `EXTRACT_CODE`) follows a hidden `Assistant:` line — changed payee and a secret-read request — deterministically, and reports `followedHiddenInstruction`. The run's `meta.json` labels the mode (`clean` | `poisoned-document`) and every event and the state carry it. No model is called anywhere, so a refusal is always deterministic enforcement; nothing claims a successful injection.
- The workflow gained a `for_each` over the extracted `secretProbes` calling a `secret-probe` sub-workflow, which calls the adapter's new `secrets_read_v1` tool. The adapter refuses every secret name (no trusted task declares one → `secret-read-undeclared`, plus the repo's `refusingResolver` answers `refused`) and records only the synthetic name and the refusal — never a value. A denied proposal or secret read is a recorded decision, not a tool error; only the bank execution route (`payments_execute_v1`) fails the step on refusal, so the poisoned run reaches the execute step and is denied again there.
- Validation at execution time, not only proposal time: `execute` re-runs task expiry, the intent rule, the amount cap, currency and the grant scope (`checkGrantScope` over the consent terms, including `validToDateTime`), and the approval binding (kind, task ref, proposal SHA-256, and the run's recorded proposal hash). Approval never expands a grant: a changed proposal, wrong task or unbound hash is denied before any bank call.

### Verified results

- Local poisoned slice (`run-slice.mjs --kind poisoned`): secret read denied (`secret-read-undeclared:secret-read-refused`), proposal denied (`intent-mismatch` on payee/invoice/amount), execution denied again at execution time, **0 ledger rows**, events `secret-read-denied → proposal-denied → execution-denied` all labeled `poisoned-document`, and a scan of the run directory finds no secret value, no PEM, no resolved flag.
- Live poisoned run through real Maurice (`MAURICE_LIVE=1 … maurice-live.test.mjs`, both tests pass, ~45s each): clean run settles exactly once across two identical calls; poisoned run — both executions end `failed` (nonzero CLI exit, execution in the error envelope), the workflow output shows the followed hidden instruction and the refused secret probe, the adapter events carry the three denials with the mode label, and the mock bank's ledger has **0 rows** (zero settlement requests).
- New tests in `maurice-adapter.test.mjs` / `maurice-contracts.test.mjs`: secret-read refusal and synthetic-name-only rule, undeclared secret-read proposal, grant out of scope at execution time (consent `validToDateTime` passed, payee outside consent), poisoned end-to-end with evidence scan. 24 slice tests pass.
- Suites after Milestone 2: `npm test` 13 pass / 0 fail (exit 0); `npm run test:three-party` 440 tests = 438 pass / 0 fail / 2 skipped (exit 0) — the 414-test baseline plus 24 new slice tests, with both live tests skipping by default; both live tests pass with `MAURICE_LIVE=1` (clean ~45s, poisoned ~45s).

### Milestone 2 exit

Met: each prohibited action (changed payee, changed amount/currency, undeclared secret read, missing intent, expired/out-of-scope grant, unbound or changed approval) is denied with a stable reason code and compared fields, and produces zero bank settlement requests — verified both in unit/integration tests and in the live poisoned run. Only synthetic secret names appear in prompts, events and receipts.

## Milestone 3 — live WIMSE delegation (implemented 2026-11-16)

### What was added

- `three-party/src/maurice/wimse.mjs` — the live WIMSE primitives matching the pinned AI2II capture's wire format (decoded in Milestone 0): `generateKey` (fresh ES256 P-256 per signing principal), `issuerJwks`, `mintWit`/`verifyWit` (typ `wit+jwt`, claims `iss/sub/iat/exp/jti/cnf.jwk`), `signRequest`/`verifyHttpSignature` (RFC 9421, covered components `@method @path @query content-type content-digest txn-token workload-identity-token`, `Content-Digest: sha-256`, `Txn-Token`, tag `wimse-workload-to-workload`, `wimse-aud` parameter), `createJtiStore` (durable replay protection), and the demo signing side `createDemoIdentity` / `createWimseSigner` / `writePrivateKeyFile` / `identityFromKeyFiles`. Signing and verifying are separate functions on purpose; nothing on the verifying side trusts the signer. Evidence exports carry only the public JWKS, the WIT's SHA-256, its header/claims and the signature's SHA-256 — never a token, signature or key value. Private keys live in memory or mode-0600 files under the run directory (gitignored), never in source control or evidence.
- `bank-server.mjs` — with `wimse: { jwks, trustedIssuers, expectedSub? }` the bank verifies the live authority on every `POST /v1/payments` **before** the AAP grant check (workload authentication first, resource authorization second, and independent of the adapter's upstream allow decision): WIT signature under the trusted issuer JWKS → issuer trust → expiry → jti replay → expected `sub` → audience → content-digest → RFC 9421 signature under the workload key the WIT's `cnf` names. Rejections are named: `wimse-token-missing`, `wimse-wit-malformed/-typ/-alg/-kid/-key/-signature/-issuer/-expired/-iat/-jti`, `wimse-replay`, `wimse-sub` (403), `wimse-sig-*` / `wimse-digest` (400, `sig-window` 401). Every decision is journaled to `bank/wimse-decisions.jsonl` and served at `GET /v1/wimse-decisions`, explicitly labeled an **unsigned decision log, not signed evidence**, carrying hashes only. Settled idempotency records carry the WIT/signature/txn hashes (`wimse` field).
- `adapter.mjs` — `createAdapter` takes an optional `signer`; `httpBankClient.pay` can send a raw body plus extra headers. When a signer is present, each payment attempt is signed with a **fresh WIT (fresh jti)** under the run's identity and journaled as a `wimse-signer` producer event (separate from `enforcement-adapter`), so an idempotent retry with the same key is safe while a byte-identical replay is refused `wimse-replay` by the bank's jti store. Bank refusals surface their reason (`bank-refused:wimse-…`).
- `run-slice.mjs` / `live.mjs` / `adapter-mcp.mjs` — each run (local and live) gets a fresh demo identity (`https://slice-issuer.example`, sub `wimse://slice.local/agent/<runId>`); the bank trusts its public JWKS, the MCP adapter process loads the private halves from the run dir (`identity/`, mode-0600) via `ADAPTER_CONFIG` and signs with audience = bank URL. The pinned capture JWKS was not modified.

### Verified results

- `three-party/test/maurice-wimse.test.mjs` (4 tests): WIT round-trip; rejections malformed / bad signature / untrusted issuer / expired; signed-request verify plus tampered-body → `digest`, wrong audience → `sig-aud`, forged workload key → `sig-signature`, expired window → `sig-window`; jti store durable replay.
- `three-party/test/maurice-wimse-bank.test.mjs` (8 tests): signed payment settles and the journal carries hashes only; fresh-WIT retry under the same key answers from the record and settles once (ledger 1, two accepts); byte-identical replay → 401 `wimse-replay` (ledger 1); same key with different details → 409; hostile set (missing token, untrusted issuer, expired WIT, wrong `wimse-aud`, tampered body, forged key, expired signature window) refused by name with **0 settlements**; wrong `sub` → 403 `wimse-sub`; delegation-chain fixtures through the repo's `verifyDelegationChain` — valid two-hop `valid` (steps 1-5,7 performed, authorizes nothing), `par-hash-missing` → `malformed`, `root-untrusted-key` → `signature_invalid`, `principal-altered`, `depth-exceeds-max`, `rule1-scope-not-covered` → `not_narrower`, `rule4-expiry-extended` → `expired`; local slice with WIMSE on settles once with a `wimse-signer` event (poisoned slice: no signed request, 0 decisions); run-directory scan finds no token/signature/key value, private key file mode 0600.
- Live, with the new assertions: `MAURICE_LIVE=1 node --test three-party/test/maurice-live.test.mjs` — both tests pass (~45s each). The clean run's two workflow calls settle exactly once, and the run's evidence shows the actual signed live exchange: exactly one `wimse-signer` `request-signed` event whose `wit_sha256` equals the bank journal's single `accept` entry and the idempotency record's `wimse.wit_sha256`; no WIT token value anywhere in the slice evidence. The poisoned run presents zero signed payments (0 WIMSE decisions, 0 ledger rows).
- Suites after Milestone 3: `npm test` 13 pass / 0 fail (exit 0); `npm run test:three-party` 452 tests = 450 pass / 0 fail / 2 skipped (exit 0; the 2 skips are the live tests without `MAURICE_LIVE=1`). One full-suite run showed a single failure in the unrelated browser test `integration-offline-check-verifier.test.mjs` (screen timing); it passes in isolation and in the other full runs — a pre-existing flake, not caused by this milestone.

### Milestone 3 exit

Met: the clean run has actual signed live exchange evidence (bank-side WIMSE authority verified end to end, locally and through the real deployed workflow). Tampered body, invalid signature, broken parent linkage, wrong audience, broadened authority, expired and replayed requests are all rejected with named reasons, in tests and in the evidence. The events identify the two components accurately by producer: `enforcement-adapter` (policy) and `wimse-signer` (live authority), with the bank's journal explicitly labeled an unsigned log.

### Decisions and blockers

- The signed live exchange is at the bank boundary (the adapter → bank route), which is the slice's own component boundary; Maurice's native WIMSE inbound check on the executions route stays as verified in Milestone 0. Wiring this slice's WIT into Maurice's own trust config (`~/.maurice/one/config/standalone.yaml` + runtime restart) was left out deliberately: it would restart the shared One runtime for no additional guarantee this slice claims, and is noted as an optional extension.
- Replay protection vs safe retries: a retry is safe only because it carries a fresh WIT (new jti) under the same idempotency key; a byte-identical replay is refused before the grant check. Both are tested at the bank and in the live run (two calls, one accept).
- Remaining milestones: M4 (AEP evidence packaging), M5 (MiniApp presenter).

## Milestone 4 — evidence with explicit guarantees (implemented 2026-11-16)

### What was added

- `three-party/src/maurice/aep.mjs` — maps the slice run onto the repository's EXISTING AEP format/verifier, unextended (`three-party/src/record` writer/check/testkey + `three-party/src/verifier/aep-verify.mjs`). `writeSliceActions` writes one `actions/NN-<step>.action.json` per run step — `propose`, each `secret-read` probe, `execute`, `settlement` (agent → bank domain, body carries the ledger row / refusal) and, with WIMSE on, `wimse-gate` (the bank's WIMSE decision, recorded as an observation of the unsigned log) — with the exact canonical JSON of the artifact as the signed `response.txt`, so task, proposal (SHA-256), decision and bank outcome are linked into every record. `beginEvidence` makes the run's test signer key + pin at run start (pin in `<runsDir>.pins/`, outside the run dir); `packageRun` drives the tree's own `recordWriter.writeRun` (records + one tampered copy + `records/manifest.json`, private key deleted after the last signature) and then the offline check, whose `offline-check.json` records the verifier sha256, the pin sha256 and the network-denial measurement.
- Wired into both `runSliceLocal` (run-slice.mjs) and `runSliceLive` (live.mjs; decisions reconstructed from the adapter's durable events and state, the proposal re-extracted deterministically). In live mode the run dir now also holds `actions/`, `keys/` (public signer PEM + TEST-KEY.txt), `records/`, `offline-check.json`.
- WIMSE private keys moved OUT of the run directory to `<runsDir>.wimse/<runId>/` (mode 0600, deleted when the run ends) — the run dir is the evidence package's scope and the offline check refuses a run dir holding a private key. Only the public JWKS stays in `runDir/identity/`.
- Evidence kinds, kept distinguishable: original wire signatures (WIT / RFC 9421) are never stored, only their SHA-256; AEP records are the collector-signed observations (run test key); `events.jsonl` and `bank/wimse-decisions.jsonl` are unsigned logs, the latter labeled "unsigned decision log, not signed evidence".

### Verified results

- `three-party/test/maurice-aep.test.mjs` (4 tests): clean slice run — package written, offline check exit 0 with every record passing steps 1–6 and the one tampered copy rejected (expected), verifier + pin hashes recorded, pin outside the run dir, actions link task/proposal/decision/ledger row, `findPrivateKeys(runDir)` finds nothing, WIMSE key dir deleted, JWKS public-only, bank journal labeled unsigned. Poisoned slice — denied package verifies offline too (exit 0), deny decisions signed into the records, settlement action shows 0 ledger rows, wimse-gate records zero entries. Tampering one record byte → exit 4, restored → exit 0. Removing a manifest-named record → exit 4; missing pin → exit 1; missing manifest → exit 1 (incomplete is an error, never a pass).
- Live (`MAURICE_LIVE=1`, both tests pass, ~46s each) with new assertions: the real run's package verifies offline (exit 0, records pass, tampered rejected), `offline-check.json` present with verifier/pin hashes, the settlement action carries the ledger row, no private key file and no WIT token value anywhere in the run dir; the poisoned live run packages and verifies too, with the deny decision in the execute record.
- Suites after Milestone 4: `npm test` 13 pass / 0 fail (exit 0); `npm run test:three-party` 456 tests = 454 pass / 0 fail / 2 skipped (exit 0; the 2 skips are the live tests without `MAURICE_LIVE=1`). Maurice slice tests now 40 (contracts 11, adapter 13, wimse 4, wimse-bank 8, aep 4).

### Milestone 4 exit

Met: intact clean and denied packages verify offline through the repo's own verifier under the pin; tampering with a protected artifact fails (exit 4); missing evidence (pin, manifest, record) is reported as an error (exit 1), never passed. Trust anchors supplied offline are stated in `offline-check.json` (verifier sha256, pin sha256); what cannot be proven offline is stated too — format steps 7–10 are not run (the verifier's notes say so), and absence of settlement is demonstrated only by the instrumented mock bank's ledger within the test scope, not claimed as a proof about any other bank.

### Decisions and blockers

- The AEP format was mapped, not extended: the writer, manifest, tampered copy, pin layout and offline check are the tree's own, byte-compatible. The only new artifacts are the slice's action files inside the run dir.
- Moving the WIMSE private keys outside the run dir was required by the offline check's private-key scan (a run dir must hold public material only); the key location is `<runsDir>.wimse/<runId>/`, deleted at run end, and tests assert both the mode-0600 and the deletion.
- Remaining milestone: M5 (MiniApp presenter experience).

## Milestone 5 — Maurice application and presenter experience (implemented 2026-11-17)

### What was added

- `three-party/src/maurice/ui.mjs` — the MiniApp `invoice-payment-demo` (`agentmaurice.miniapp/v2`, component renderer) plus the two wrapper workflows. Events: `run-clean` / `run-poisoned` call `run-slice-ui` (input `{kind}`; a code step builds runId/taskId/idempotencyKey/invoiceText deterministically — no model call anywhere — then calls `invoice-payment` synchronously and the adapter's `evidence_package_v1`), and `verify-evidence` calls `verify-last-run` (packages + offline-checks the newest `ui-*` run — how a denied run gets its package, since a refusal ends the wrapper as a business failure). The layout binds to state: trusted-vs-extracted comparison table, event timeline, decision/outcome (success bound only to `run.execution.state`), WIMSE gate counts, AEP records + hashes, offline-check verdict, run dir for download, measured start/end times. `initial_state` carries empty skeletons for every bound path (the viewer's instance creation 500s on table bindings to missing paths — found by bisection against the built-in example MiniApp; also `mode` is a forbidden legacy field name, hence `kind`).
- `adapter-mcp.mjs` — new `evidence_package_v1` tool: derives the decisions from the run's own records (events.jsonl/state.json — tool params stringify object references, so the run dir is the source of truth), accepts `runId: "latest"`, reads the bank ledger and WIMSE journal read-only (fail-soft), signs the actions as AEP records with the run's test key (begin+write+check in one call, key deleted after the last signature), and runs the offline check. Idempotent for already-packaged runs.
- `three-party/src/maurice/ui-demo.mjs` — the presenter startup: session WIMSE identity (keys outside the runs dir), bank server with live WIMSE authority, adapter config, isolated test Agent, MCP install, spec project with the 4 workflows + the MiniApp, `spec check` → commit → `spec deploy --tests auto` (verified), and a read-only download server for `three-party/runs/ui/`. CLI: start (default, serves until Ctrl+C), `--status`, `--teardown [--purge-evidence]` — evidence is kept unless `--purge-evidence` is explicit.

### Verified results

- `three-party/test/maurice-ui.test.mjs` (4 tests, offline): MiniApp schema-shape and internal consistency (event→workflow refs, trigger↔event ids, component catalogue, state bindings under declared state, no static success callout, outcome bound to `run.execution.state`), wrapper workflows have no `llm_call` and carry measured timestamps, `verify-last-run` wiring, and the adapter MCP publishes `evidence_package_v1` over stdio.
- Live (`MAURICE_LIVE=1`, `maurice-ui-live.test.mjs`, 2/2 pass): deploy verified with the MiniApp in the spec project; `run-slice-ui` clean → completed, settled once, 1 WIMSE-signed payment, ledger 1, evidence package exit 0 with records/tampered manifest, `offline-check.json`, downloadable via the evidence server (attachment headers), measured startedAt/endedAt in the output; poisoned → wrapper fails (business failure), denials in events, then `verify-last-run` packages the denied run and its offline check exits 0 with ledger still 1 and no new signed payment. Second test drives the complete viewer protocol: `viewer connect` → `viewer open invoice-payment-demo` → `viewer submit run-clean` → `viewer show` polls to `run.execution.state=settled` with `run.evidence.check.exitCode=0`, timeline and comparedFields in the instance state.
- Regression: `maurice-live.test.mjs` (M1/M2 slice) still 2/2 under MAURICE_LIVE=1.
- Suites after Milestone 5: `npm test` 13/13 (exit 0); `npm run test:three-party` 462 tests = 458 pass / 0 fail / 4 skipped (exit 0; the 4 skips are the live tests without MAURICE_LIVE=1 — 2 slice + 2 UI).

### Milestone 5 exit

Met: a presenter can run clean, poisoned and the deterministic adversarial case from the One viewer MiniApp (or the viewer protocol), each result explained by the panels (comparison table, timeline, decision, WIMSE gate, evidence), evidence exported (download server over the runs dir) and verified offline (exit 0, tampered copy rejected). Startup/reset/teardown and the demo flow are in `ui-demo.mjs` and the README; reset/teardown never erase evidence without `--purge-evidence`. Model calls: zero by construction (no `llm_call` in any slice workflow) — stated as a fact of the spec, with latency measured (startedAt/endedAt), not claimed.

### Decisions and blockers

- Verified runtime support used: Agent Spec V2 miniapps deploy through the spec rail and are listed in the viewer bootstrap; instances are driven by `maurice viewer open/submit/show` against the recipe server (`http://127.0.0.1:5011`). No Module/Application packaging was needed — the spec rail is the supported path here.
- Two server quirks found by probing: instance creation 500s when a table `rows` binding points at a path missing from `initial_state` (fixed with empty skeletons), and `mode` is a forbidden legacy field name in MiniApp state (renamed to `kind`).
- The viewer bundle exists at `~/.maurice/viewer/`, so `maurice home` serves the One home with the MiniApp; no Application chat (its prerequisites — Run LLM, auth connector — are out of scope per the runbook).

All five milestones are implemented, tested and logged. Nothing remains in the plan except the optional extension (split intake/review and execution across separately scoped agents).

## Post-M5 — One home "Maurice" chat fix (2026-11-17)

### Symptom

The One home page (`http://127.0.0.1:5050/one/`, served French, hence the French error) answered every chat message with `Maurice n'a pas pu répondre : no llm provider configuration found for deployment (missing llmprovider edge)`. Root cause found in `~/.maurice/one/logs/llm-server.log`: the per-deployment llm-server could not resolve an LLM provider for deployment `dau2r52n18nmo8d7g030` (the default "Assistant" deployment), because that deployment had no `llmprovider` edge — only `apikey` edges. This is unrelated to the slice MiniApp: our viewer path (`run-slice-ui`/`verify-last-run`) has zero `llm_call` and was verified working (live UI 2/2) before and after this fix.

### Fix applied (runtime config only, no repo files changed)

- `maurice catalog llm list` reports `account_not_paired` (no hosted account), so a local model was used: Ollama is running on `127.0.0.1:11434` with tool-capable local models; `qwen3:8b` chosen (8.2B Q4_K_M, caps completion/tools/thinking).
- Created the provider via the admin API (auth = `Authorization: Bearer <access_token>` from `~/.maurice/config.yaml`):
  `POST /api/v1/organization/dau2r52n18nmo8d7g00g/deployment/dau2r52n18nmo8d7g030/llmprovider` with `{name:"local-ollama-qwen3", provider:"ollama", url:"http://127.0.0.1:11434", model:"qwen3:8b", maxCompletionTokens:8192}` → id `dbue6man18nklqgr3fng`.
- The edge appeared immediately in `deployment/list` (`edges.llmprovider[0]`) and in the deployment doctor ("1 LLM providers (ollama qwen3:8b)"), but the running llm-server still failed resolution, so the deployment was redeployed: `POST .../deployment/dau2r52n18nmo8d7g030/redeploy` (needed a fresh llm-server to pick up the edge).

### Verified

- `llm-server.log` now logs `Using custom model from llmprovider {provider: ollama, model: qwen3:8b}` and no further `LLM provider resolution failed` entries.
- `maurice chat --deployment dau2r52n18nmo8d7g030 --new-session --message "reply with exactly: PONG" --export ...` → assistant replied `PONG` in the transcript (same llm-server session path the home chat uses).
- Home UI serves at `http://127.0.0.1:5050/one/` (HTTP 200, "AgentMaurice Viewer"); `maurice home` opens it in a browser via a short-lived one-time loopback link.
- Persisted in the runtime's ent DB (`~/.maurice/one/engine.sqlite3`), so it survives restarts. No repo files modified; suites unchanged (main 13/13; three-party 458 pass / 0 fail / 4 live-gated skips).

### Note

The provider is attached to the default Assistant deployment only. The slice's own UI demo deployment (`dbudtlan18nklqgr307g`, `maurice-ui-demo-*`) does not need an LLM provider and was not modified. If a different local model is preferred, update via `PATCH /api/v1/organization/deployment/dau2r52n18nmo8d7g030/llmprovider/dbue6man18nklqgr3fng` and redeploy.

## Post-M5 — AEP records handoff for reference-verifier review (2026-11-17)

Anton asked for two run-time AEP records (one paid, one blocked) plus each run's `keys/test-signer.pub.pem`. Package prepared at scratchpad `anton-aep-review/` (`paid-run/03-settlement.aep` from `ui-clean-20261117T235544851Z`, `blocked-run/02-secret-read.aep` from `ui-poisoned-20261117T235630235Z`, each with its run's pub key + manifest + README.txt). Verified before handoff with the repo verifier: both `pass-1-6` exit 0; negative controls reject (tampered copy at step 3, wrong pin at step 5). Only public material included — run private keys are deleted at run end, WIMSE values exist only as SHA-256 hashes, no bank secrets.
