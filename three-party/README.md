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
use. On the left, choose scene 1 (Normal payment) or scene 2 (Poisoned
invoice) and press the control under the list, or the R key. Once a run has
finished, scene 6 (Audit later) runs the offline check on it, with the same
control or the O key. S and I switch between the Story and Inspect modes. At
the default pace a run takes a little over one minute: 68 seconds for the
clean run and 66 for the poisoned run when this was written.

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

AI2II_SECTION

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

OFFLINE_SECTION

The verifier can be run on one record:

```sh
node three-party/src/verifier/aep-verify.mjs three-party/runs/<runId>/records/05-pay.aep --pin three-party/runs.pins/<runId>.pub.pem
```

It prints one JSON line (the file, its sha256, the verdict `pass-1-6` or
`reject`, the step that failed, and notes) and exits 0 on a pass, 1 on a
rejection, and 2 on a wrong argument or a pin it cannot read.

VERIFIER_PASS_SECTION

## A packaged copy

PACKAGE_SECTION

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
