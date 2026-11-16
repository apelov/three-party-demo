# Three-party demo: the contract of a run, revision 3

This file, `labels.json` and the files under `examples/` define what a run writes and what the screens and text
mode read. It is the demo's own contract and changes no published specification. A field is added rather than
renamed; the closing section lists what revision 3 changed.

## 1. What the demo is

A payments agent (domain A, `payments.acme-demo.test`) pays a supplier invoice at a mock bank (domain B,
`bank.example.test`, the repository's Example Bank). Two runs, then an offline check. Every run is a sequence of
real local transactions against the repository's own bank, broker and token service, paced so a run lasts one to
two minutes.

Four parts, each labelled on screen and in text mode. The one source of every part and party string is
`three-party/labels.json`. Its members are `revision`, `parts`, `parties`, `timestamp` and `scenes`.

| `part` in `state.json` and in the label map | label | stand-in | what runs |
|---|---|---|---|
| `checkpoint` | `OpenA2A · ATX · AAP` | no | the ATX credential check, the short-lived scoped AAP grant and the intent rule |
| `crossing` | `WIMSE · AI2II` | when AI2II's files are absent | the AI2II capture check (variant `supplied`), or the OpenA2A delegation chain check over a fixture (variant `fallback`, a stand-in) |
| `record` | `AEP` | no | one Action Evidence Package per action, written by the OpenA2A record writer and checked by the OpenA2A verifier for steps 1 to 6 of the format |
| `bank` | `Supplier's bank` | no | the payment, answered by the mock bank's own payment API |

The crossing has two variants under `parts.crossing.variants`: `supplied` (no stand-in mark, no note) and
`fallback` (the stand-in mark, its `standInNote`, and a `fetchNote` that says where AI2II's capture comes from
and how it is fetched). A stand-in part carries its `standInNote` where it is shown. In text mode the label of
a stand-in part is followed by ` (stand-in)`, and the line of a stand-in step that ran carries the note. The
timestamp line of a record carries the note of `timestamp` in the map. A stand-in is never shown as the work of
the author of the part it stands in for.

On the screens and in text mode, parties are shown by role alone (`parties` of the map): the agent, the bank,
the invoice's sender, the two domains. Company names, DIDs and domains of the fixtures appear where the screens
show a file of the run as it was written (a record's raw metadata, and the panes that show a file or a step of
the run state byte for byte), under the map's `rawIdentifiersNote`, because those bytes are signed and are
shown as they are.

The intent check is a rule. On screen and in text it is called `Intent rule`, never a model or AI.

## 2. Directory layout

```
three-party/CONTRACT.md            this file
three-party/labels.json            the label map: the one source of every part and party string (section 1)
three-party/examples/              the example files of section 6
three-party/bin/start.mjs          the demo: the screens and the run API on 127.0.0.1, or --text in the terminal
three-party/bin/offline-check.mjs  runs the OpenA2A verifier over a run's records with network access denied
three-party/src/engine/            the engine: the runs, the label map, text mode, the AI2II capture check, the run API
three-party/src/intent/            the intent rule
three-party/src/crossing/          the delegation chain check's hop
three-party/src/record/            the record writer, ZIP, JCS, the test key and the offline check
three-party/src/verifier/aep-verify.mjs  the OpenA2A verifier: one file written from the format text, steps 1 to 6
three-party/view/                  the screens
three-party/fixtures/              invoices.json
three-party/test/                  the tests, named engine-, record-, verifier-, view- and integration-
three-party/runs/                  run output, ignored by git
three-party/external/ai2ii/        AI2II's three files once fetched, ignored by git
scripts/three-party/fetch-ai2ii.mjs  fetches AI2II's three files at a pinned commit and checks each SHA-256
```

## 3. A run on disk

`three-party/runs/<runId>/` where `runId` is `<kind>-<YYYYMMDDTHHMMSSZ>` and `kind` is `clean` or `poisoned`:

```
state.json                      rewritten after every event (section 4); the screens poll it
actions/NN-<step>.action.json   one per action step (section 5)
actions/NN-<step>.response.txt  the exact bytes that step got back; the action file names its SHA-256
hops/NN-crossing.hop.json       the delegation chain check's hop log, on a fallback crossing only (section 5)
records/NN-<step>.aep           one Action Evidence Package per action file
records/manifest.json           the records list (section 5)
records/tampered/NN-<step>.aep  one copy of a record with one byte of response.txt changed, for the offline check
keys/test-signer.pub.pem        the SPKI public half of the run's test key
keys/TEST-KEY.txt               one line: `Test key generated for this demo run; not a key in use anywhere.`
offline-check.json              the offline check's result (section 5), once the check has run
```

The private half of the test key is made when the run starts, stays in the memory of the process, reaches no
file and is deleted once the last record is signed. The public half is also captured at the start as the run's
pin, outside the run directory: `three-party/runs.pins/<runId>.pub.pem`.

## 4. `state.json`

Step order and ids: `credential`, `grant`, `crossing`, `intent`, `pay`, `record`. Status values: `pending`,
`running`, `passed`, `blocked`, `not-reached`, `written` (the record step alone). Outcome: `paid` or `blocked`.
Times are RFC 3339 UTC strings. Amounts are decimal strings; currency `USD`.

Step `title` values, byte for byte:
`credential` `Verify the agent's ATX credential locally`; `grant` `Issue a scoped AAP grant`;
`crossing` `Cross into the supplier's bank's trust domain`; `intent` `Apply the intent rule to each tool call`;
`pay` `Pay the invoice under the grant`; `record` `Write one signed Action Evidence Package per action`.

Top level: `runId`, `kind`, `startedAt`, `finishedAt` (null until done), `poisonedLine` (the exact sentence
`The poisoned invoice is modeled on what OpenA2A honeypots saw; no captured traffic is replayed.` on a poisoned
run, null on a clean run), `parties` (the `parties` object of the label map, copied), `invoice`, `agent`, `grant`,
`steps`, `outcome` (null until decided), `blockedAt` (null or a step id), `reason` (null or one sentence),
`paceSeconds` (the minimum dwell per step the engine applied).

`agent`: `did`, `role` (`payments-agent`), `credentialFile`, `credentialSha256` (hex of the credential file's
exact bytes), `domain`.

`grant`: null until minted, then `issuedAt`, `expiresAt`, `ttlSeconds` (60, the repository's
`GRANT_TTL_SECONDS`), `scope` (`payment:billpay`), `maximumIndividualAmount`, `creditorAccounts`, `tokenType`
(`Bearer`); never the token value.

Each step: `id`, `part` (`checkpoint` | `crossing` | `record` | `bank`), `partLabel`, `standIn` (bool),
`standInNote` (string or null), `title`, `status`, `startedAt`, `endedAt`, `detail` (per step, below),
`actionFile` (relative path or null), `recordFile` (relative path or null), `variant` (`supplied` or `fallback`
on the crossing step, null on the others). `partLabel`, `standIn` and `standInNote` come from the part of the
label map whose `steps` list holds the step id, and on the crossing step from its variant.

`detail` per step:
- `credential`: `verifier` (`@opena2a/atx-verify 0.3.0`), `valid` (bool), `issuer`, `notBefore`, `notAfter`,
  `postQuantumSignature` (`not verified in this demo`).
- `grant`: `expiresInSeconds`, `inScope` (bool), `scopeChecked` (the array of names checked).
- `crossing`, variant `fallback`: `from`, `to`, `chainFile` (`fixtures/delegation-chain/dc-compact-valid-two-hop.json`),
  `hops` (2), `outcome` (the chain check's outcome name), `stepsRun` (`1 to 5 and 7 of
  draft-asor-wimse-agent-delegation-chain-03 section 6`), `standIn` (`Stand-in for the AI2II capture check, which
  runs here once its files are fetched`), `hopFile`. When AI2II's files were present but did not match their
  pins, `capture` (`{used: false, why, reason, files}`) names each file and both digests.
- `crossing`, variant `supplied`: `from`, `to`, `outcome` (`verified`), `chainFile`, `hops`, `standIn` and
  `hopFile` null, and `capture`: `{used: true, check, source: {repo, branch, commit, folder}, files: [{name,
  size, sha256}], exchange, token, signature, txnToken: {carried, checked, sha256}, checks: [{name, answer,
  why}], passed, total, outcome, summary, scope}`. The seven checks are `capture`, `witSignature`,
  `contentDigest`, `httpSignature`, `signatureCreated`, `response` and `journal`. No token value, signature value
  or Txn-Token value is written; the token's claims and SHA-256 are.
- `intent`: `rule` (`Every argument of a tool call must equal the same field of the declared intent. A call
  with no declared intent is blocked.`), `declared` (object), `calls` (array of `{tool, args, declaredFor,
  match, fieldsDiffering}`), `result` (`match` | `mismatch` | `undeclared-call`).
- `pay`: `endpoint`, `httpStatus`, `paymentId` (or null), `amount`, `currency`, `payeeAccount`,
  `recordedByBank` (bool).
- `record`: `written` (count), `format` (`docs/aep-format.md in eatf-verifier, text SHA-256
  cdf6954ab0fbd4f9c272821ee4379063dc9d396511459fef6c398a6df75827a5, steps 1 to 6`), `signer` (`test key
  generated for this run`), `credentialCitedBy` (`sha256 over the credential's exact bytes`), `timestampEntry`
  (`stand-in: no timestamp authority`).

## 5. The files of a run

Action file (`actions/NN-<step>.action.json`): `runId`, `seq` (1-based), `step`, `kind`, `at`, `actor`
(`did`, `role`, `credentialSha256`), `domainFrom`, `domainTo`, `declaredIntent` (object or null),
`toolCall` (`{tool, args}` or null), `decision` (`allowed` | `blocked` | `observed`), `reason`,
`response` (`{status, bodySha256, bodyFile}`; `bodyFile` is the exact response bytes saved beside the
action file as `NN-<step>.response.txt`, the record's `response.txt`).

Hop file (`hops/NN-crossing.hop.json`, fallback crossing only): `runId`, `seq`, `at`, `from`, `to`,
`chainFile`, `chainSha256`, `hops`, `outcome`, `stepsRun`, `standIn`.

Records manifest (`records/manifest.json`): `runId`, `format`, `signerPublicKey` (`keys/test-signer.pub.pem`),
`signerSha256` (hex of the public key file's bytes), `credentialSha256`, `records` (array of
`{file, sha256, action}`), `tampered` (array of `{file, sha256, changed}`).

Record metadata (`metadata.json` inside each package; the profile form of the format's step 3 is used,
so `canonical.bin` = `response.txt` || LF || JCS(metadata)): `profile` (`opena2a-three-party-demo/1`),
`runId`, `seq`, `step`, `kind`, `at`, `decision`, `reason`, `actor_did`, `credential_sha256`,
`domain_from`, `domain_to`, `writer` (`OpenA2A writer, AEP format`), `timestamp_entry`
(`stand-in: no timestamp authority`). Strings and integers, nothing else, so JCS is the sorted, unspaced
serialization.

Offline check output (`offline-check.json`): `runId`, `at` (RFC 3339 UTC), `verifier` (`{entry, sha256, source}`:
`entry` `three-party/src/verifier/aep-verify.mjs`, `sha256` the hex of that file's bytes as run, `source`
`written for this demo from the format text, steps 1 to 6`), `pin` (the path of the pin file the check read,
from the directory that holds the run directory, for example `.pins/<runId>.pub.pem`), `pinSha256` (hex of
the pin file's bytes), `network` (the method and both readings of the network control, below), `records`
(array of `{file, sha256, verdict, firstFailingStep, notes}` with verdict `pass-1-6` or `reject`), `tampered`
(same shape), `summary` (`{pass, reject, expectedRejects}`), `networkDenied` (`yes` or `not measured`).

The network control. The check starts a listener of its own on 127.0.0.1 and runs one probe twice: with no
method, where it must reach that listener (`CONNECTED`), and under the method of the platform, where the connect
must fail with a reading that method gives and the listener must accept nothing. The tools are looked for at
fixed paths (`/usr/bin`, then `/bin`), never through `PATH`, and the methods work for a user with no privileges:

| platform | method | reading under it | `network` when the control shows the denial |
|---|---|---|---|
| macOS | `sandbox-exec` with the profile `(version 1) (allow default) (deny network*)` | `EPERM` | `denied: sandbox-exec profile (version 1) (allow default) (deny network*); control: CONNECTED outside, EPERM inside` |
| Linux | `unshare --user --map-root-user --net` (util-linux): a new user and network namespace whose loopback is down | `ENETUNREACH` | `denied: unshare --user --map-root-user --net; control: CONNECTED outside, ENETUNREACH inside` |
| Linux, where unshare cannot make the namespace | `bwrap --unshare-user --unshare-net --ro-bind / / --die-with-parent`: a new namespace whose own loopback is up, with nothing listening | `ECONNREFUSED` | `denied: bwrap --unshare-user --unshare-net --ro-bind / / --die-with-parent; control: CONNECTED outside, ECONNREFUSED inside` |
| Windows | none: Windows Firewall does not filter loopback traffic, and an AppContainer launch is not reachable from Node.js built-ins | | |

The sandbox accepts `EPERM` alone. A new network namespace accepts `ENETUNREACH` and `ECONNREFUSED`, as each says
the host's loopback is out of reach; any other reading is not a denial. The first method whose control is decided
ends the search, with one of three outcomes:

- Denied: `networkDenied` is `yes`, and the verifier runs under that method.
- Not measured (no method on the platform, no method that could be applied here, for example under Docker's
  default seccomp profile or a restriction on user namespaces, or a probe that did not reach the listener with no
  method): the verifier still runs, with an empty environment and no method. `network` is `not measured:` and the
  reason, then, for each method tried, `; <method>; control: <reading> outside, <reading> inside`, and
  `networkDenied` is `not measured`.
- Not denied (under the method the probe still reached the listener): that contradicts the method, the verifier
  does not run, and nothing is written.

The exit status: `0` every record passed steps 1 to 6, every tampered copy was rejected, and the disk and the
manifest agree, whether the denial was shown or not measured (the result says which); `4` the verifier ran and the
result is not that; `1` an error; `3` not denied. The result is written on `0` and `4` alone. A result with no
`networkDenied` member was written only when the control showed the denial, and its `network` begins with
`denied:`.

## 6. Example files (under `examples/`; the screens render from these, and the engine writes files of these shapes)

- `state-clean-running.json`: a clean run at the grant step (credential passed, grant running).
- `state-clean-done.json`: a clean run finished, outcome paid, all six steps passed or written.
- `state-poisoned-blocked.json`: a poisoned run blocked at `intent` with two calls (an undeclared
  `secrets.read` call and a pay call whose payee differs), `pay` not reached, records written.
- `action-05-pay.action.json`, `hop-03-crossing.hop.json`, `manifest.json`, `offline-check.json`.

## 7. The run API

All on `127.0.0.1`, JSON, no auth (local demo). `POST /api/runs` body `{"kind":"clean"}` returns
`{"runId"}` and starts the run; `GET /api/runs/<runId>` returns `state.json`; `GET
/api/runs/<runId>/files/<relative path under the run directory>` returns the file (JSON as
`application/json`, `.aep` as `application/zip`, text as `text/plain`); `POST
/api/runs/<runId>/offline-check` runs the offline check and returns `offline-check.json`; `GET /api/health`
returns `{"ok":true,"build":<short sha>}`.

`GET /api/labels` returns `three-party/labels.json`: every member, each value as the file has it. A listener
that also serves the screens adds the screens' own words to that answer and changes no value of the file. These
added members are held in `three-party/view/labels.json`; they are not part or party strings.

## 8. Scenes and words

The scenes are the `scenes` list of the label map. This build runs scene 1 (normal payment), scene 2 (poisoned
invoice) and scene 6 (the audit of a run's records). Scenes 3 (tampered agent), 4 (expired grant) and 5 (what
the bank received) are named in the map and are not built; the screens do not list them. Motion explains a
change of state and nothing else; with reduced motion asked for, nothing animates. No person's name appears on
any screen.

## Revision 3

What revision 3 changed in revision 2:

- The state member `fictionalLine` is removed, with its line on the screens and in text mode.
- The `part` id of the first part is `checkpoint`, the name the label map gives it.
- The record part is no longer a stand-in: the records are written in the AEP format and checked by the OpenA2A
  verifier for steps 1 to 6. The timestamp entry is still a placeholder, and the map's `timestamp` note says so.
- The crossing gains the variants `supplied` and `fallback`, the step member `variant`, and `detail.capture`.
- The verifier follows the current text of the format, named in `three-party/FORMAT-SOURCE.txt` by its SHA-256.
- The offline check denies the network on Linux as well as macOS, and says so when it cannot measure the denial.
- The example files of revision 1 are removed. Items revision 2 planned and this build does not have (a grant
  claims file, grant members in the record metadata, a test timestamp authority, the tampered and expired runs,
  and the route of scene 5) are no longer described here.
