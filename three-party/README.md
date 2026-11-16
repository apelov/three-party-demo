# Three-party demo

Every customer, account, payee and payment in this demo is fictional.

A scripted payments agent pays one supplier invoice at a mock bank on this
computer. The engine runs that payment as six steps, each a real local
transaction against the repository's own bank, token service and broker code,
paced so a viewer can follow it. It writes what happened to a run directory,
and the record writer signs one record of each action with a test key made
for that run. The screens show the run as it happens. Every listener is bound
to `127.0.0.1`, and the demo calls no other host.

There are two runs. In the clean run the invoice is what it says, and the
payment goes through. In the poisoned run the invoice hides a line of text
addressed to the agent. The agent follows it, and the intent rule stops the
run before any payment is sent. The poisoned invoice is modeled on what our
honeypots saw; no captured traffic is replayed.

After a run, the offline check runs our verifier over the run's records with
network access denied. The verifier is one file, written for this demo from
the text of the format. It applies steps 1 to 6 of the format to each record
and to a tampered copy of one of them (see "The offline check" below).

## Run it

```sh
npm ci
npm run three-party
```

```
Three-party demo, build <short sha>
Ready. Open http://127.0.0.1:7390/ in a browser.
Press Ctrl+C to stop.
```

Open the address in a browser. The port is 7390, or the next free port; the
line names the one in use. On the left, choose scene 1 (Normal payment) or
scene 2 (Poisoned invoice) and press the control under the list, or the R
key. Once a run has finished, scene 6 (Audit later) runs the offline check on
it, with the same control or the O key. S and I switch between the Story and
Inspect modes. At the default pace a run takes a little over one minute: 68
seconds for the clean run and 66 for the poisoned run when this was written.

Under that control, Back and Forward move one step at a time, as the Left and
Right arrow keys do, and Replay (the P key) walks a finished run again from
step 0. A replay runs nothing a second time: the steps after the one it
stands at show as pending, and key 0 ends it. Once a run has finished, the
control above them runs the scene again.

Beside the mode switch, Flow and Trace (the T key) choose what the middle pane
shows under the invoice: the message flow, or a trace with one row per step
(its start, the time it took, its state, and a bar on one time lane) and,
under a step, the rows of what happened inside it: the declared intent and
each tool call, each check, each record. Enter or a click on a row opens its
step in the inspector. The address keeps the mode and the view, for example
`#story-trace` or `#inspect-flow`. The trace has the shape of a distributed
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

A run prints four header lines (five on a poisoned run, which adds the line
on the poisoned invoice), one line for each of the six steps, the outcome and
the run directory. A step line reads:

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
| Cross into the supplier's bank's trust domain | `crossing`, a stand-in | the repository's delegation chain check over `fixtures/delegation-chain/dc-compact-valid-two-hop.json`, with the result written to a hop file |
| Apply the intent rule to each tool call | `checkpoint` | every argument of each tool call the agent makes is compared with the declared intent, field for field; a call with no declared intent is blocked |
| Pay the invoice under the grant | `bank` | `POST /v1/payments` on the bank's payment API with the grant; the bank's own consent check decides, and the engine reads the ledger row back |
| Write one signed Action Evidence Package per action | `record`, a stand-in | the record writer (`three-party/src/record/writer.mjs`): one package per action file, a tampered copy of one of them, and a manifest, signed with the run's test key |

The declared intent is built from the invoice's structured fields before the
agent reads the invoice body, so nothing the body says can change it. The
intent rule is a rule: it compares values for equality and nothing else.

## What is real, and what is a stand-in

The four parts, by their name in the label map and in the words of
`CONTRACT.md` section 1. The label each one shows is in
`three-party/labels.json`.

- **`checkpoint`**: the ATX credential check, the short-lived scoped grant,
  the intent rule, the app and the glue.
- **`crossing`**, a stand-in: the domain A to domain B hop through the
  delegation chain check the repository already has, with a hop log written
  to a file.
- **`record`**, a stand-in: one Action Evidence Package per action, written
  by our own writer in the named format, checked by our own verifier.
- **`bank`**: the payment, answered by the bank's own payment API.

The verifier is `three-party/src/verifier/aep-verify.mjs`: one file that
imports Node.js modules and nothing else, written for this demo from the
text of the format (`three-party/FORMAT-SOURCE.txt` names that text). It runs
steps 1 to 6 of the format's ordered verification. Steps 7 to 10 are not
run, so the timestamp entry is not checked.

Real, and run again on every run: the credential check (the Ed25519 signature
is verified; a post-quantum signature is not verified in this demo), the token
exchange, the intent rule, the payment and the bank's own decision on it, and
the signature on each record. The access token value stays in memory and is
never written to a file or to `state.json`. A request for a secret that the
intent rule stops is also put to the resolver the bank's broker is built
with, which refuses every name.

Stand-ins, and what each stands in for:

- The crossing. The chain is a fixture of two hops, checked under the clock and
  the root key the fixture carries; it is not minted for this payment. The
  check holds the chain and no request, so it runs steps 1 to 5 and 7 of
  draft-asor-wimse-agent-delegation-chain-03 section 6 and reports no action
  as permitted. The real AI2II interop piece replaces the hop file, not code.
  The lane of the crossing carries the stand-in mark. The part's note stands
  under the mark in a window of 1440 by 860 px or more during a run of six
  steps, and in the inspector whenever the crossing step is selected.
- The record. The packages are written by our own writer in the named format.
  The signer is a test key generated for the run, not a key in use anywhere,
  and the timestamp entry is a stand-in: there is no timestamp authority. The
  record's label is a stand-in label until the format is confirmed. Its lane
  carries the mark and, in the same windows, the note that says so. The
  inspector of the record step carries both, and the note on the timestamp
  line.
- The payments agent is scripted. No language model is called. It follows a
  hidden line that starts with `Assistant:`, the way a language model can
  follow text planted in its input.
- The supplier's bank is the repository's mock bank, started inside the engine
  process. The customer's consent is put on file there when a run starts; the
  bank checks the agent's credential before it records it.
- The two trust domains, `payments.acme-demo.test` and `bank.example.test`,
  are names for the two sides. Both sides run on this computer.

## The run directory

A run writes `three-party/runs/<runId>/`, where `<runId>` is `clean-` or
`poisoned-` and the UTC second the run started. The directory is ignored by
git.

```
state.json                      the run so far, rewritten whole after every status change
actions/NN-<step>.action.json   one per step that ran: who, what, the decision and its reason
actions/NN-<step>.response.txt  what that step got back; the action file names its sha256
hops/03-crossing.hop.json       the crossing stand-in's hop log
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

The screens (scene 6), the run API and `--text --offline-check` run the same
check with that pin. In this order it looks for a private key in the run
directory, shows that its sandbox profile denies the network (a probe reaches
the check's own listener on `127.0.0.1` outside the sandbox and is refused
under it), and runs the verifier under that profile, with an empty
environment, once for each record file: the files under `records/` and
`records/tampered/`, and the files `records/manifest.json` names. For a clean
run it prints:

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
(`CONTRACT.md` section 5) and ends with exit status 0. The tampered copy has
one byte of its response changed, so the form step 3 rebuilds from the
response and the metadata no longer equals `canonical.bin`. A poisoned run
has four records, and its check prints `result: 4 passed steps 1 to 6, 1
rejected (1 expected)`. The screens show the same result: `Passed steps 1 to
6` on each record, `Rejected at step 3` on the tampered copy, and the counts.

| Exit status | Meaning |
|---|---|
| 0 | every record passed steps 1 to 6, every tampered copy was rejected, and the disk and the manifest name the same files with the same hashes; the result is written |
| 4 | the verifier ran and the result is not that; the result is written, and standard error names each difference |
| 1 | an error: a wrong argument, a directory that is not a run, a private key in the run directory, no pin; nothing is written |
| 3 | the network denial was not shown; nothing is checked and nothing is written |

The verifier can be run on one record:

```sh
node three-party/src/verifier/aep-verify.mjs three-party/runs/<runId>/records/05-pay.aep --pin three-party/runs.pins/<runId>.pub.pem
```

It prints one JSON line (the file, its sha256, the verdict `pass-1-6` or
`reject`, the step that failed, and notes) and exits 0 on a pass, 1 on a
rejection, and 2 on a wrong argument or a pin it cannot read.

What a pass says: the package is a ZIP archive that holds the seven required
entries; its metadata is a JSON object; `canonical.bin` is the response, a
line feed and the RFC 8785 form of the metadata; `hash.sha256` is the SHA-256
of `canonical.bin`; `public_key.pem` is the pin, byte for byte; and
`signature.sig` verifies over `canonical.bin` as RSASSA-PKCS1-v1_5 with
SHA-256 under that key. The pin is the public half of a test key made for
the run, so a pass says the record is one that key signed, and nothing about
a key in use anywhere. Steps 7 to 10 of the format are not run: the receipt,
the second signature and the timestamp are not checked.

The network control uses the sandbox command of macOS. Where that command
cannot apply a profile, for example when the demo itself runs inside a
sandbox, the check prints `network denied: not measured` and ends with 3.

## The package for another Mac

```sh
scripts/three-party/package.sh --out <directory>
```

It exports the commit that is checked out into a temporary directory,
installs there the dependencies the demo runs on, and writes a tarball with
its sha256, a git bundle of the branch with its sha256, and `ONE-COMMAND.txt`,
which holds the one command to run on the other Mac and what it needs. The
packaged copy has no git directory; it names its commit from
`three-party/BUILD.txt`, which the script writes. The tarball leaves two
things out of the export: `three-party/stills/`, pictures taken from the
example files and not from a run, and git's ignore files. Nothing is pushed
or copied anywhere else.

`scripts/three-party/browser-proof.mjs` drives the screens of a running demo
in a real browser, both runs and the offline check, and writes down the time
each run took and what the offline check screen showed.

## Labels and roles

Every part label, party role, stand-in note and scene button is in one file,
`three-party/labels.json`, a byte for byte copy of the staged label map. The
engine writes each step's `partLabel`, `standIn` and `standInNote` into
`state.json` from it, and copies its `parties` there. Text mode prints them
from that state. The listener answers `GET /api/labels` with the map, and the
screens take the lane titles, the legend, the stand-in notes, the party roles
and the buttons from that answer.

Outside the contract, the examples and the tests, no other file under
`three-party/` holds a part label, a party role or a stand-in note:
`three-party/test/integration-label-source.test.mjs` reads every file and
checks it. The copy deck holds two labels inside the two cells text mode
prints for the stand-in parts; the same test compares those cells with the
map.

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
part to its own contract. The files named `integration-` run the parts together: runs
over the API with the record writer, the command line, the screens on the
engine in a real browser, and the package script.
