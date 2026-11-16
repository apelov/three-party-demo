# Three-party demo: reference

This is the detailed reference for the demo. The top-level
[README](../README.md) introduces it: the three parts, who built each, and
what is real and what isn't yet. Every listener the demo starts is bound to
`127.0.0.1`, and a run calls no other host.

## Commands

```sh
npm ci
node scripts/three-party/fetch-ai2ii.mjs   # optional, see "The crossing" below
npm run three-party
```

`npm run three-party` prints a build line, then the address to open, then how
to stop. The port is 7390, or the next free port; the line names the one in
use. On the left, choose 1 (Normal payment) or 2 (Poisoned invoice) and press
the control under the list, or the R key; the buttons in the middle pane and
under a finished run start the next run too. Once a run has finished, 3 (Audit
the records) runs the offline check on it, with the same control or the O key.
S and I switch between the Story and Inspect modes, and View as chooses what
each step's panel leads with: for a security lead, finance, a platform
engineer or a standards engineer. At
the default pace a run takes a little over one minute: 68 seconds for the
clean run and 66 for the poisoned run when this was written.

Under that control, Back and Forward move one step at a time, as the Left and
Right arrow keys do, and Replay (the P key) walks a finished run again from
step 0. A replay runs nothing a second time: the steps after the one it
stands at show as pending, and key 0 ends it. Once a run has finished, the
control above them runs the scene again.

The tabs over the middle pane choose what it shows under the invoice:
Sequence, the six steps across the five parts; Records, the run's records and
their audit; and Trace (T switches between Sequence and Trace), a trace with
one row per step (its start, the time it took, its state, and a bar on one
time lane) and,
under a step, the rows of what happened inside it: the declared intent and
each tool call, each check, each record. Enter or a click on a row opens its
step in the inspector. The address keeps the mode, the tab and the view as
reader, for example `#story-trace`, `#inspect-records` or
`#story-sequence-finance`. The trace has the shape of a distributed
trace and is not an OpenTelemetry export; `three-party/test/fixtures/trace-field-map.md`
lists each field of a row and where the run carries it.

The same two runs in a terminal, with no browser:

```sh
node three-party/bin/start.mjs --text
node three-party/bin/start.mjs --text --offline-check
```

`--text` prints one line per step as it happens, then the outcome and the run
directory. It runs the clean run, then the poisoned run, and exits 0 when the
clean run ends paid and the poisoned run ends stopped by the intent rule.
With `--offline-check` it also runs the offline check after each run and
prints each line the check returned and its exit status; the exit code of the
command still says how the runs ended.

A run prints its header lines (one more on a poisoned run, the line on the
poisoned invoice), one line for each of the six steps, the outcome and the run
directory. A step line reads:

```
[hhmmss] part label | step title | state word | detail
```

The part label is the one `three-party/labels.json` gives the part the step
belongs to. The label of a stand-in part is followed by ` (stand-in)`, and
the line of a stand-in step that ran ends with that part's stand-in note. The
line of a written record also ends with the note on its timestamp entry. The
parties go by role: no line names a company, a DID or a domain of the
fixtures.

`three-party/test/fixtures/text-mode-both.txt` holds what the command printed
for the two runs when this was written. A test runs the command again and
compares its lines with that file, with the times, the payment id, the run
directories and the pace set aside.

| Command | What it starts |
|---|---|
| `node three-party/bin/start.mjs` | the demo: the screens and the run API on `127.0.0.1`. It takes no option |
| `node three-party/bin/start.mjs --serve` | the same listener, with `--port`, `--pace` and `--runs-dir`; it prints one line |
| `node three-party/bin/start.mjs --text` | the runs in the terminal, with `--run`, `--offline-check`, `--pace` and `--runs-dir` |

| Option | Meaning |
|---|---|
| `--run clean\|poisoned\|both` | which run `--text` makes (default `both`) |
| `--offline-check` | with `--text`: run the offline check after each run and print what it returned |
| `--pace <seconds>` | the wait after each step, 0 to 15 (default 8). The grant lives 60 seconds, and a longer pace would let it expire before the payment. |
| `--port <n>` | the port for `--serve`; the demo stops if it is in use |
| `--runs-dir <dir>` | where run directories are written (default `three-party/runs`) |

The listener answers the run API of `CONTRACT.md` section 7. `POST /api/runs`
with `{"kind":"clean"}` or `{"kind":"poisoned"}` starts a run and returns its
id; `GET /api/runs/<runId>` returns its `state.json`; `POST
/api/runs/<runId>/offline-check` runs the offline check and returns the
result it wrote, `offline-check.json`. When the check wrote no result, the
route returns the check's exit status, its lines and its notes.

## The six steps

| Step | Part, by its name in `labels.json` | What runs |
|---|---|---|
| Verify the agent's ATX credential locally | `checkpoint` | `LocalAtxVerifier` of `@opena2a/atx-verify` over the exact bytes of `fixtures/agents/billpay-agent.atx.json`, under the pinned test issuer key |
| Issue a scoped AAP grant | `checkpoint` | the reference grant resolver checks the credential and the grant policy, signs a broker token and exchanges it at the bank's token service for an access token that lives 60 seconds |
| Cross into the supplier's bank's trust domain | `crossing` | the check of AI2II's capture when its files are fetched, otherwise the delegation chain check over a fixture, a stand-in (see "The crossing") |
| Apply the intent rule to each tool call | `checkpoint` | every argument of each tool call the agent makes is compared with the declared intent, field for field; a call with no declared intent is blocked |
| Pay the invoice under the grant | `bank` | `POST /v1/payments` on the bank's payment API with the grant; the bank's own consent check decides, and the engine reads the ledger row back |
| Write one signed Action Evidence Package per action | `record` | the OpenA2A record writer (`three-party/src/record/writer.mjs`): one package per action file, a tampered copy of one of them, and a manifest, signed with the run's test key |

The declared intent is built from the invoice's structured fields before the
agent reads the invoice body, so nothing the body says can change it. The
intent rule is a rule: it compares values for equality and nothing else.

## What runs in each part

The four parts, by their name in the label map and in the words of
`CONTRACT.md` section 1. The label each one shows is in
`three-party/labels.json`.

- **`checkpoint`**: the ATX credential check (the Ed25519 signature is
  verified; a post-quantum signature is not verified in this demo), the
  short-lived scoped grant, the intent rule, the app and the glue. The access
  token value stays in memory and is never written to a file or to
  `state.json`. A request for a secret that the intent rule stops is also put
  to the resolver the bank's broker is built with, which refuses every name.
- **`crossing`**: the domain A to domain B hop. See "The crossing".
- **`record`**: one Action Evidence Package per action, written by the
  OpenA2A record writer in the AEP format and checked by the OpenA2A verifier,
  `three-party/src/verifier/aep-verify.mjs`: one file that imports Node.js
  modules and nothing else, written for this demo from the text of the format
  (`three-party/FORMAT-SOURCE.txt` names that text by its SHA-256). It runs
  steps 1 to 6 of the format's ordered verification. Steps 7 to 10 are not
  run, so the timestamp entry is not checked. The signer is a test key
  generated for the run, not a key in use anywhere, and the timestamp entry
  is a placeholder: there is no timestamp authority. The inspector of the
  record step carries the note on the timestamp line.
- **`bank`**: the payment, answered by the bank's own payment API. The bank
  is the repository's mock bank, started inside the engine process. The
  customer's consent is put on file there when a run starts; the bank checks
  the agent's credential before it records it.

The payments agent is scripted. No language model is called. It follows a
hidden line that starts with `Assistant:`, the way a language model can
follow text planted in its input. The poisoned invoice is written for this
demo, modeled on what OpenA2A honeypots saw; no captured traffic is replayed.
The two trust domains, `payments.acme-demo.test` and `bank.example.test`, are
names for the two sides. Both sides run on this computer.

## The crossing

The crossing step has two forms, and each step in `state.json` names the one that
ran in its `variant` member.

**With AI2II's files.** `node scripts/three-party/fetch-ai2ii.mjs [--dir <dir>]`
downloads `capture_scenario1.pcap`, `decision-journal.jsonl` and `jwks.json` from
[AI2II's repository](https://github.com/apelov/IETF127-Hackathon-AI2II-WIMSE) at
commit `32f584a2016d7ebd0d2f5156148cc404c496a086` (branch
`feature/opena2a-wimse-aep`, folder `handover/wimse_ai2ii/`) into
`three-party/external/ai2ii/`, which git ignores. It checks each file's size and
SHA-256 against its pin, keeps a file only on a match, makes no other network
call, and exits 1 naming the file and both digests on a mismatch. A file already
in place with its pinned size and digest is not fetched again.

When the three files are there and match their pins, the crossing runs the AI2II
capture check (`three-party/src/engine/capture.mjs`, Node.js built-ins only):

| Check | What it verifies |
|---|---|
| `capture` | a classic libpcap file of one TCP connection; each direction reassembles by sequence number, with no gap, into one HTTP/1.1 request and its response |
| `witSignature` | the Workload-Identity-Token is an ES256 JWS of type `wit+jwt`, and its signature verifies under the key its `kid` names in `jwks.json`, in the key set of its `iss` host |
| `contentDigest` | the `Content-Digest` header is the SHA-256 of the request body |
| `httpSignature` | the RFC 9421 signature verifies under the key in the token's `cnf.jwk`, over every component `Signature-Input` lists and its parameters |
| `signatureCreated` | the signature's `created` time lies within the token's `iat` to `exp` |
| `response` | the response is 200 with status paid; its txn, invoice, amount and payer are the request's `Txn-Token`, invoice and amount and the token's `sub` |
| `journal` | the decision journal's one line agrees with the response and names the token's `sub` as its peer |

What that proves, and what it does not. The capture is a separate loopback
exchange that AI2II published (harbor.example to northbank.example, invoice 4471,
4200 USD), not a crossing minted for this payment. The keys are trusted because
`jwks.json` is pinned by its SHA-256. The token's times are checked against the
capture's own times, not today's clock. The `Txn-Token` value is compared with
the bank's answer and is not validated as a token, and the signature's
`expires`, `wimse-aud` and `tag` parameters are not checked. No token, signature
or `Txn-Token` value is written to the run directory; the token's claims and
its SHA-256 are.

**Without them**, or with files that do not match their pins, the crossing runs
the delegation chain check the repository already has, over
`fixtures/delegation-chain/dc-compact-valid-two-hop.json`, under the clock and
the root key the fixture carries, and writes a hop file. The check holds the
chain and no request, so it runs steps 1 to 5 and 7 of
draft-asor-wimse-agent-delegation-chain-03 section 6 and reports no action as
permitted. The chain is not minted for this payment. The crossing's lane
carries the stand-in mark, and its note names AI2II's repository and the fetch
command.

## The run directory

A run writes `three-party/runs/<runId>/`, where `<runId>` is `clean-` or
`poisoned-` and the UTC second the run started. The directory is ignored by
git.

```
state.json                      the run so far, rewritten whole after every status change
actions/NN-<step>.action.json   one per step that ran: who, what, the decision and its reason
actions/NN-<step>.response.txt  what that step got back; the action file names its sha256
hops/03-crossing.hop.json       the crossing's hop log
records/NN-<step>.aep           one signed package per action file
records/tampered/NN-<step>.aep  a copy of one package with one byte of its response changed
records/manifest.json           the records, the tampered copy and the signer's public key, each by its sha256
keys/test-signer.pub.pem        the public half of the run's test key
keys/TEST-KEY.txt               the note that it is a test key, and when its private half was deleted
offline-check.json              the result of the offline check, once the check has run on the run
```

The response file of the pay step holds the exact bytes the bank answered. The
one of the grant step holds the token service's answer with the token value
taken out. A step that makes no request (the credential check, the crossing,
the intent rule) saves its check's own result as JSON.

A clean run leaves five action files and five records; a poisoned run leaves
four of each, the fourth the blocked intent action, and no payment.
`state.json` is written under a temporary name and renamed into place, so a
reader gets the state before a change or after it and never part of one.
`CONTRACT.md` sections 3 to 5 define every field, and `examples/` holds a file
of each shape.

The test key of a run is made when the run starts. Its private half stays in
the memory of the process and reaches no file; the writer deletes it once the
last record is signed, and a run that stops before its record step gives it
up on the way out. The public half is also captured, when the run starts, as
the run's pin, outside the run directory:

```
three-party/runs.pins/<runId>.pub.pem
```

For another runs directory the pins directory is that directory's path with
`.pins` added. It is ignored by git as well.

## The offline check

```sh
node three-party/bin/offline-check.mjs three-party/runs/<runId> --pin three-party/runs.pins/<runId>.pub.pem
```

The screens (the audit), the run API and `--text --offline-check` run the same
check with that pin. In this order it looks for a private key in the run
directory, measures whether the network is denied (below), and runs the
verifier with an empty environment, once for each record file: the files under
`records/` and `records/tampered/`, and the files `records/manifest.json` names.
For a clean run on macOS it printed:

```
private key: absent
network denied: yes
verifier: aep-verify.mjs sha256 <sha256 of the verifier file>
pin: sha256 <sha256 of the pin> (the public key captured when the run started, held outside the run directory)
records/01-credential.aep: pass-1-6
records/02-grant.aep: pass-1-6
records/03-crossing.aep: pass-1-6
records/04-intent.aep: pass-1-6
records/05-pay.aep: pass-1-6
records/tampered/05-pay.aep: rejected at step 3
result: 5 passed steps 1 to 6, 1 rejected (1 expected)
written: offline-check.json
```

It writes the result to `offline-check.json` in the run directory
(`CONTRACT.md` section 5). The tampered copy has one byte of its response
changed, so the form step 3 rebuilds from the response and the metadata no
longer equals `canonical.bin`. A poisoned run has four records, and its check
prints `result: 4 passed steps 1 to 6, 1 rejected (1 expected)`.

How the network is denied. The check starts a listener of its own on
`127.0.0.1` and runs one probe twice: with no method, where it must connect, and
under the method of the operating system, where it must be refused.

| Operating system | Method | What the check prints |
|---|---|---|
| macOS | `sandbox-exec` with the profile `(version 1) (allow default) (deny network*)` | `network denied: yes` |
| Linux | a new user and network namespace with `unshare --user --map-root-user --net`, or `bwrap --unshare-user --unshare-net` where `unshare` cannot make one | `network denied: yes` |
| Windows | none: no method works there without administrator rights | `network denied: not measured (no method that works without administrator rights is used on Windows)` |

Where no method can be applied (a container whose profile forbids namespaces,
or a process that is already sandboxed), the check prints `network denied: not
measured (<reason>)`, still checks every record, and writes the result with
`networkDenied: "not measured"`. It never prints `yes` without the probe having
been refused.

| Exit status | Meaning |
|---|---|
| 0 | every record passed steps 1 to 6, every tampered copy was rejected, and the disk and the manifest name the same files with the same hashes; the result is written and says whether the network denial was shown or not measured |
| 4 | the verifier ran and the result is not that; the result is written, and standard error names each difference |
| 1 | an error: a wrong argument, a directory that is not a run, a private key in the run directory, no pin; nothing is written |
| 3 | the method was applied and the probe still reached the network; nothing is checked and nothing is written |

The verifier can be run on one record:

```sh
node three-party/src/verifier/aep-verify.mjs three-party/runs/<runId>/records/05-pay.aep --pin three-party/runs.pins/<runId>.pub.pem
```

It prints one JSON line (the file, its sha256, the verdict `pass-1-6` or
`reject`, the step that failed, and notes) and exits 0 on a pass, 1 on a
rejection, and 2 on a wrong argument or a pin it cannot read.

What a pass says: the package is a ZIP archive inside the format's limits (64
MiB, 32 entries, 16 MiB for one entry, 32 MiB expanded) whose entry names are
unique and hold no `/`, `\` or NUL, and it holds the seven required entries; its
metadata is UTF-8 JSON with no byte order mark, no member name repeated within
an object and no nesting deeper than 64, inside the format's canonicalization
domain; `canonical.bin` is the response, a line feed and the RFC 8785 form of the
metadata; `hash.sha256` is the SHA-256 of `canonical.bin`; `public_key.pem` is one
PEM block labelled `PUBLIC KEY` that holds an RSA key, and its DER equals the
pin's DER; and `signature.sig` verifies over `canonical.bin` as RSASSA-PKCS1-v1_5
with SHA-256 under that key. The pin is the public half of a test key made for
the run, so a pass says the record is one that key signed, and nothing about a
key in use anywhere. Steps 7 to 10 of the format are not run: the receipt, the
second signature and the timestamp are not checked.
`three-party/FORMAT-SOURCE.txt` names the format text the verifier was written
from, by its SHA-256; no code of the format's reference verifier is used.

## A packaged copy

```sh
scripts/three-party/package.sh --out <directory>
```

It exports the commit that is checked out into a temporary directory, installs
there the dependencies the demo runs on, and writes a tarball with its SHA-256,
a git bundle of the branch with its SHA-256, and `ONE-COMMAND.txt`, which holds
the one command to run on the other computer and what that computer needs:
Node.js 22.12 or later, a browser, and tar and a POSIX shell for that command
(Git Bash or WSL on Windows); no login, no network. The packaged copy has no git
directory; it names its commit from `three-party/BUILD.txt`, which the script
writes. The tarball leaves two things out of the export: `three-party/stills/`,
pictures taken from the example files and not from a run, and git's ignore
files. Nothing is pushed or copied anywhere else. The script itself needs bash.

`scripts/three-party/browser-proof.mjs` drives the screens of a running demo
in a real browser, both runs and the offline check, and writes down the time
each run took and what the offline check screen showed.

## Labels and roles

Every part label, party role, stand-in note and scene button is in one file,
`three-party/labels.json`. The engine writes each step's `partLabel`,
`standIn` and `standInNote` into `state.json` from it, and copies its
`parties` there. Text mode prints them from that state. The listener answers
`GET /api/labels` with the map, and the screens take the lane titles, the
legend, the stand-in notes, the party roles and the buttons from that answer.

Outside the contract, the examples and the tests, no other file under
`three-party/` holds a part label, a party role or a stand-in note:
`three-party/test/integration-label-source.test.mjs` reads every file and
checks it. The copy deck holds the label of a stand-in part inside the cell
text mode prints for it; the same test compares that cell with the map.

The parties go by role on the screens and in text mode: the payments agent,
the supplier's bank, the supplier and the two domains. The company names, the
DIDs and the domains of the fixtures are shown where a file of the run is
shown as it was written, which is in the panes of Inspect mode and in the
metadata table of a record, under the map's note on test identifiers.

The other words of the screens are in `three-party/view/copy.json`. The
structure of the screen and the screens' own lines for the parts and the
scenes are in `three-party/view/labels.json`, which holds no label; the
listener adds those lines to its answer. The engine's other words are in
`three-party/src/engine/labels.mjs`.

The label map names six scenes. This build runs scenes 1, 2 and 6. Scenes 3,
4 and 5 are marked not available in `three-party/view/labels.json`, and the
page does not list them.

## Tests

```sh
npm run test:three-party
```

The files named `engine-`, `record-`, `verifier-` and `view-` each hold one
part to its own contract. The files named `integration-` run the parts
together: runs over the API with the record writer, the command line, the
screens on the engine in a real browser, and the package script.
