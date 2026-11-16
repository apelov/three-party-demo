# Three-party demo: the contract the builds share, revision 2

This file, `labels.json` and the files under `examples/` are the contract of the Thursday version. Revision 2
adds values and fields to revision 1; no field of revision 1 is renamed or removed. The Sunday version keeps
revision 1, whose example files stand byte for byte under `examples/v1/`. The closing section `Revision 2` lists
every change. A build that needs a field this file does not define adds it under `detail` of its own step and
names the addition in its report; it never renames or removes a field defined here. This is the demo's internal
contract; it changes no published specification.

## 1. What the demo is

A fictional company's payments agent (domain A, `payments.acme-demo.test`) pays a supplier invoice at a
fictional bank (domain B, `bank.example.test`, the repository's Example Bank). Two runs, then an offline
check; revision 2 adds two run kinds and one screen (sections 3 and 8). Every run is a sequence of real local
transactions against the repository's own bank, broker and token service, paced so a run lasts one to two
minutes. Every customer, account, payee, invoice and amount is fictional, and the demo says so
(`FICTIONAL_LINE` of `src/config.mjs`, byte for byte).

Four parts, each labelled on screen and in text mode. The one source of every part and party string is
`three-party/labels.json`, a byte for byte copy of the staged label map. Its members are `revision`, `parts`,
`parties`, `timestamp` and `scenes`.

| `part` in `state.json` | part in the label map | label | stand-in | what it is |
|---|---|---|---|---|
| `ours` | `checkpoint` | `OpenA2A · ATX · AAP` | no | the ATX credential check, the short-lived scoped grant, the intent rule, the app and the glue |
| `crossing` | `crossing` | `WIMSE · AI2II` | yes | the domain A to domain B hop through the delegation chain check the repository already has, with a hop log written to a file |
| `record` | `record` | `AEP` | yes | one Action Evidence Package per action, written by our own writer in the named format, checked by our own verifier |
| `bank` | `bank` | `Supplier's bank` | no | the payment: the pay steps, answered by the bank's own payment API |

A stand-in part carries its `standInNote` where it is shown, and the timestamp line of a record carries the
note of `timestamp` in the map. A stand-in is never shown as the work of the author of the part it stands in
for. In text mode the label of a stand-in part is followed by ` (stand-in)`, and the line of a stand-in step
that ran carries the note.

On the start, run and offline-check screens and in text mode, parties are shown by role alone (`parties` of
the map): the agent, the bank, the invoice's sender, the two domains. Company names, DIDs and domains of the
fixtures appear where the screens show a file of the run as it was written (the record's raw metadata table,
and the panes of Inspect mode that show a file or a step of the run state byte for byte) and nowhere else,
under the line `Fictional test identifiers.`, because those bytes are signed and are shown as they are.

The intent check is a rule. On screen and in text it is called `Intent rule`, never a model or AI. The
fictional line, the poisoned line and `Intent rule` are unchanged from revision 1.

## 2. Directory layout (new top-level directory `three-party/`; nothing outside it changes except one
`package.json` script line added by the integration build)

```
three-party/CONTRACT.md            this file
three-party/labels.json            the label map: the one source of every part and party string (section 1)
three-party/examples/              the example files of section 6, byte for byte
three-party/examples/v1/           the example files of revision 1, byte for byte
three-party/bin/start.mjs          engine build: --text runs in the terminal; --serve starts the run API on 127.0.0.1
three-party/bin/offline-check.mjs  runs our verifier, one file, over a run's records with network denied
three-party/src/engine/            engine build
three-party/src/intent/            engine build (the rule)
three-party/src/crossing/          engine build (the stand-in hop)
three-party/src/record/            record build (writer, zip, jcs, test key)
three-party/src/verifier/aep-verify.mjs  verifier build: our verifier, one file written from the format text, steps 1 to 6
three-party/view/                  screens build
three-party/fixtures/              engine build: invoices.json; screens build: nothing (it reads examples/)
three-party/test/                  each build its own files, named engine-*.test.mjs, record-*.test.mjs, view-*.test.mjs
three-party/runs/                  run output, ignored by three-party/.gitignore (engine build writes the ignore file: `runs/`)
```

## 3. A run on disk

`three-party/runs/<runId>/` where `runId` is `<kind>-<YYYYMMDDTHHMMSSZ>`, kind `clean` or `poisoned`, and in
revision 2 also `tampered` (scene 3) or `expired` (scene 4):

```
state.json                 rewritten after every event (section 4); the screens poll it
actions/NN-<step>.action.json   one per action step (section 5)
hops/NN-crossing.hop.json       the crossing stand-in's hop log (section 5)
grants/NN-grant.json            the grant's claims as the broker returned them (section 5); never the token value
records/NN-<step>.aep           one Action Evidence Package per action file (record build)
records/manifest.json           the records list (section 5)
records/tampered/NN-<step>.aep  one copy of a record with one byte of response.txt changed (record build), for the offline check
keys/test-signer.pem            RSA 2048 private key generated for this run (never reused, never a key in use anywhere)
keys/test-signer.pub.pem        its SPKI public key; the offline check pins it
keys/TEST-KEY.txt               one line: `Test key generated for this demo run; not a key in use anywhere.`
keys/TEST-TSA.txt               one line: `Test timestamp authority made for this demo; not a key in use anywhere.` (when the test authority is in use)
offline-check.json              the offline check's result (section 5)
```

## 4. `state.json`

Step order and ids: `credential`, `grant`, `crossing`, `intent`, `pay`, `record`; on the expired run alone,
`grant-again` and `pay-again` stand after `pay` and before `record`. Status values:
`pending`, `running`, `passed`, `blocked`, `not-reached`, `written` (the record step alone), `expired` (a grant
whose `expiresAt` passed before it was used). Outcome: `paid` or
`blocked`. Times are RFC 3339 UTC strings. Amounts are decimal strings; currency `USD`.

Step `title` values, byte for byte:
`credential` `Verify the agent's ATX credential locally`; `grant` `Issue a scoped AAP grant`;
`crossing` `Cross into the supplier's bank's trust domain`; `intent` `Apply the intent rule to each tool call`;
`pay` `Pay the invoice under the grant`; `record` `Write one signed Action Evidence Package per action`.

Top level: `runId`, `kind`, `startedAt`, `finishedAt` (null until done), `fictionalLine`,
`poisonedLine` (the exact sentence
`The poisoned invoice is modeled on what our honeypots saw; no captured traffic is replayed.`
on a poisoned run, null on a clean run), `parties` (the `parties` object of the label map, copied), `invoice`,
`agent`, `grant`, `steps`, `outcome` (null until decided), `blockedAt` (null or a step id), `reason` (null or
one sentence), `paceSeconds` (the minimum dwell per step the engine applied).

`agent`: `did`, `role` (`payments-agent`), `credentialFile`, `credentialSha256` (hex of the credential
file's exact bytes), `domain`.

`grant`: null until minted, then `issuedAt`, `expiresAt`, `ttlSeconds` (60, the repository's
`GRANT_TTL_SECONDS`), `scope` (`payment:billpay`), `maximumIndividualAmount`, `creditorAccounts`,
`tokenType` (`Bearer`); never the token value.

Each step: `id`, `part` (`ours` | `crossing` | `record` | `bank`), `partLabel`, `standIn` (bool),
`standInNote` (string or null), `title`, `status`, `startedAt`, `endedAt`, `detail` (per step, below),
`actionFile` (relative path or null), `recordFile` (relative path or null). `partLabel`, `standIn` and
`standInNote` are the `label`, `standIn` and `standInNote` of the part of the label map whose `steps` list
holds the step id. The `part` ids of revision 1 stay as they are; the pay steps take the value `bank`.

`detail` per step:
- `credential`: `verifier` (`@opena2a/atx-verify 0.3.0`), `valid` (bool), `issuer`, `notBefore`, `notAfter`, `postQuantumSignature` (`not verified in this demo`); on the tampered run, and on every run once scene 3 is wired, `buildCheck` (`{credentialContentHash, measuredHash, match, changedFile}`, `changedFile` null when nothing was changed).
- `grant` and `grant-again`: `expiresInSeconds`, `inScope` (bool), `scopeChecked` (the array of names checked); once the grant claims file is written, `grantId` and `grantFile` (its relative path).
- `crossing`: `from`, `to`, `chainFile` (`fixtures/delegation-chain/dc-compact-valid-two-hop.json`), `hops` (2), `outcome` (the chain check's outcome name), `stepsRun` (`1 to 5 and 7 of draft-asor-wimse-agent-delegation-chain-03 section 6`), `standIn` (`AI2II interop: stand-in; the real piece replaces the hop file, not code`), `hopFile`.
- `intent`: `rule` (`Every argument of a tool call must equal the same field of the declared intent. A call with no declared intent is blocked.`), `declared` (object), `calls` (array of `{tool, args, declaredFor, match, fieldsDiffering}`), `result` (`match` | `mismatch` | `undeclared-call`).
- `pay` and `pay-again`: `endpoint`, `httpStatus`, `paymentId` (or null), `amount`, `currency`, `payeeAccount`, `recordedByBank` (bool).
- `record`: `written` (count), `format` (`docs/aep-format.md in eatf-verifier, text SHA-256 cdf6954ab0fbd4f9c272821ee4379063dc9d396511459fef6c398a6df75827a5, steps 1 to 6`), `signer` (`test key generated for this run`), `credentialCitedBy` (`sha256 over the credential's exact bytes`), `timestampEntry` (`stand-in: no timestamp authority`).

## 5. The files of a run

Action file (`actions/NN-<step>.action.json`): `runId`, `seq` (1-based), `step`, `kind`, `at`, `actor`
(`did`, `role`, `credentialSha256`), `domainFrom`, `domainTo`, `declaredIntent` (object or null),
`toolCall` (`{tool, args}` or null), `decision` (`allowed` | `blocked` | `observed`), `reason`,
`response` (`{status, bodySha256, bodyFile}`; `bodyFile` is the exact response bytes saved beside the
action file as `NN-<step>.response.txt`, the record's `response.txt`).

Hop file (`hops/NN-crossing.hop.json`): `runId`, `seq`, `at`, `from`, `to`, `chainFile`,
`chainSha256`, `hops`, `outcome`, `stepsRun`, `standIn`.

Grant claims file (`grants/NN-grant.json`): the RFC 8785 (JCS) bytes of the grant's claims as the broker
returned them: its id, scope, issuedAt, expiresAt, maximumIndividualAmount, creditorAccounts. Never the token
value.

Records manifest (`records/manifest.json`): `runId`, `format`, `signerPublicKey` (`keys/test-signer.pub.pem`),
`signerSha256` (hex of the public key file's bytes), `credentialSha256`, `records` (array of
`{file, sha256, action}`), `tampered` (array of `{file, sha256, changed}`).

Record metadata (`metadata.json` inside each package; the profile form of the format's step 3 is used,
so `canonical.bin` = `response.txt` || LF || JCS(metadata)): `profile` (`opena2a-three-party-demo/1`),
`runId`, `seq`, `step`, `kind`, `at`, `decision`, `reason`, `actor_did`, `credential_sha256`,
`domain_from`, `domain_to`, `writer` (`our writer, AEP format`), `timestamp_entry`
(`stand-in: no timestamp authority`). Strings and integers, nothing else, so JCS is the sorted, unspaced
serialization. Revision 2 adds four members, strings, once the grant claims file is written: `grant_id`,
`grant_sha256` (lowercase hex of SHA-256 over the exact bytes of the grant claims file), `grant_scope`,
`grant_expires_at`. `timestamp_entry` takes `test timestamp authority made for this demo` once the test
authority writes `timestamp.tsr`; until then it stays `stand-in: no timestamp authority`.

Offline check output (`offline-check.json`): `runId`, `at` (RFC 3339 UTC), `verifier` (`{entry, sha256, source}`:
`entry` `three-party/src/verifier/aep-verify.mjs`, `sha256` the hex of that file's bytes as run, `source`
`written for this demo from the format text, steps 1 to 6`), `pin` (the path of the pin file the check read,
from the directory that holds the run directory, for example `.pins/<runId>.pub.pem`), `pinSha256` (hex of
the pin file's bytes), `network`
(`denied: sandbox-exec profile (version 1) (allow default) (deny network*); control: CONNECTED outside, EPERM inside`),
`records` (array of `{file, sha256, verdict, firstFailingStep, notes}` with verdict `pass-1-6` or `reject`),
`tampered` (same shape), `summary` (`{pass, reject, expectedRejects}`).

Revision 2 adds checks after the verifier's steps 1 to 6, per record: `credentialCited` (metadata
`credential_sha256` equals SHA-256 of the run's credential file), `grantCited` (`grant_sha256` equals SHA-256
of the saved grant claims file, and the action time lies inside the grant's window, except a refused action
whose reason is the expiry), and, once the test authority is in use, `timestampChecked` (the AEP format's
step 9 against the pinned test authority certificate, with `genTime`). Each record row of `offline-check.json`
gains `checks` (an object of these names to `pass` | `reject` | `not-run`).

## 6. Example files (under `examples/`, byte for byte; the screens build renders from these; the engine
and record builds must produce files of these shapes)

- `state-clean-running.json`: a clean run at the grant step (credential passed, grant running).
- `state-clean-done.json`: a clean run finished, outcome paid, all six steps passed or written.
- `state-poisoned-blocked.json`: a poisoned run blocked at `intent` with two calls (an undeclared
  `secrets.read` call and a pay call whose payee differs), `pay` not reached, records written.
- `action-05-pay.action.json`, `hop-03-crossing.hop.json`, `manifest.json`, `offline-check.json`.

The three state files carry the values and fields of revision 2. `examples/v1/` holds the seven files as
revision 1 had them, byte for byte.

## 7. The run API (engine build serves it; the screens build is its one client)

All on `127.0.0.1`, JSON, no auth (local demo). `POST /api/runs` body `{"kind":"clean"}` returns
`{"runId"}` and starts the run; `GET /api/runs/<runId>` returns `state.json`; `GET
/api/runs/<runId>/files/<relative path under the run directory>` returns the file (JSON as
`application/json`, `.aep` as `application/zip`, text as `text/plain`); `POST
/api/runs/<runId>/offline-check` runs the offline check and returns `offline-check.json` (the
integration build wires the record build's check here; until then the engine answers 501 with
`{"error":"offline check not wired"}`); `GET /api/health` returns `{"ok":true,"build":<short sha>}`.
The screens build's dev server answers the same routes from `examples/`.

`GET /api/labels` returns `three-party/labels.json`: every member, each value as the file has it. A listener
that also serves the screens adds the screens' own words to that answer and changes no value of the file:
on each part `text` (and `detail` on the crossing), and on each scene `title`, `text` and `available` (false
for a scene the build does not run yet). These added members are words of the screens, held in
`three-party/view/labels.json`; they are not part or party strings.

`GET /api/runs/<runId>/received` (scene 5, a screen and not a run) returns, for a finished clean run,
`{runId, from, to, hopFile, chainFile, stepsRun, outcome, standIn: true, standInNote}` read from that run's
hop file.

## 8. Scenes, stills and words

The scenes are the `scenes` list of the label map, in its order: 1 normal payment, 2 poisoned invoice and
6 audit later (must); 3 tampered agent and 4 expired grant (should); 5 what the bank received (a stand-in
screen). Screens follow the label map and the calm look: no decorative animation, and motion where it explains
a change of state and nowhere else (the grant countdown bar, a step row's change of state, the stopped tile);
nothing moves when the page loads, and with reduced motion asked for nothing animates. No person's name
appears on any screen.

## Revision 2

What revision 2 changes in revision 1, section by section. Nothing of revision 1 is renamed or removed.

- Opening paragraph. Revision 1 said this file and the examples are copied byte for byte into each of three
  build branches and that the integration build checks the copies. Revision 2 has one tree: the paragraph now
  names `labels.json`, the revisions and `examples/v1/`.
- Section 1, labels. The label column of revision 1 is replaced. Revision 1 had three parts with the labels
  `Ours`, `Crossing (stand-in for AI2II)` and `Record (our writer, his format)`. Revision 2 has four parts whose
  labels come from `three-party/labels.json`: `OpenA2A · ATX · AAP` (`ours`), `WIMSE · AI2II` (`crossing`), `AEP`
  (`record`) and `Supplier's bank` (the added part `bank`, which takes the pay steps from `ours`).
- Section 1, stand-ins. Added: a stand-in part carries its `standInNote`, the timestamp line carries the note of
  `timestamp`, and text mode marks a stand-in part with ` (stand-in)` after its label.
- Section 1, parties. Added: parties are shown by role alone, and the identifiers of the fixtures appear under
  `Fictional test identifiers.` where a file of the run is shown as written, and nowhere else.
- Section 2. Added to the layout: `three-party/labels.json` and `three-party/examples/v1/`.
- Section 3. Added run kinds `tampered` and `expired`; added `grants/NN-grant.json` and `keys/TEST-TSA.txt`.
- Section 4. Added step ids `grant-again` and `pay-again`; added status `expired`; added the top-level member
  `parties`; added the step members `standIn` and `standInNote`; added the `part` value `bank`; `partLabel` now
  comes from the label map; added `detail.buildCheck` on `credential`, and `detail.grantId` and
  `detail.grantFile` on `grant` and `grant-again`.
- Section 5. Added the grant claims file; added the record metadata members `grant_id`, `grant_sha256`,
  `grant_scope` and `grant_expires_at`, and the second value of `timestamp_entry`; added the offline check's
  `credentialCited`, `grantCited` and `timestampChecked`, and `checks` on each record row.
- Section 6. The three state examples carry revision 2; the seven files of revision 1 are kept under
  `examples/v1/`.
- Section 7. Added `GET /api/labels` and `GET /api/runs/<runId>/received`. The members a listener with the
  screens adds to the label map answer (`text`, `detail`, `title`, `available`) are named there.
- Section 8. New: the scenes, the calm look and the rule on names.
