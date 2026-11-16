# Three-party demo (WIP) 

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

One agent payment, checked by three independent pieces, each checking only
its own part. A scripted payments agent pays a supplier invoice at a mock
bank: an ATX credential and an AAP grant say who the agent is and what it may
pay, a WIMSE crossing carries the request into the bank's trust domain, and
every action leaves an Action Evidence Package (AEP) that anyone can check
offline. In the second run the invoice is poisoned: the intent rule stops the
payment before it is sent, and the record of that step says why.

![The poisoned invoice run: the request crosses the credential check, the grant and the crossing, the intent rule stops the changed payment before the bank is called, and the audit then checks every record offline.](docs/poisoned-invoice.gif)

## How this came together

Built at the IETF 127 Hackathon, San Francisco, 14 to 15 November 2026, by
three teams working from each other's drafts.

## Use cases

**Finance: an agent that pays invoices.** An invoice can carry text written
for the agent rather than for people. In the poisoned run that text tells the
agent to read a secret and pay a different account. The intent rule compares
each call the agent makes with the intent declared from the invoice's own
fields, and stops the payment before the bank is called. No money moves, and
the record of that step says why.

**Platform engineering: agents wired into a pipeline.** The same pattern fits
an agent that acts through tools in CI/CD: a checkpoint between the agent and
its tools compares every tool call with a declared intent, field for field,
and blocks a call that has none. Every action leaves a signed record that a
later job can verify with one command and no network.

**Security and audit: proving what an agent did, later.** Long after a run,
an auditor can check each Action Evidence Package with nothing but the run's
public key: the exact response, the decision and its reason, signed. The
offline check does this with network access denied, and rejects a copy in
which one byte was changed.

**Standards work: three drafts in one flow.** ATX and AAP, a WIMSE crossing
between trust domains, and AEP evidence each check only their own part. The
demo shows where one hands over to the next, and every step opens to the real
artifact behind it.

## The three parts

**Agent credential and grant: ATX and AAP, OpenA2A.** The payments agent
carries an [ATX](https://github.com/opena2a-org/atx-spec) credential, verified
locally under a pinned issuer key. A grant resolver built on
[AAP](https://datatracker.ietf.org/doc/draft-fane-opena2a-aap/)
(draft-fane-opena2a-aap-03) checks the credential against the grant policy,
and the bank's token service exchanges the result for an access token that
lives 60 seconds. The intent rule then compares every tool call with the
intent declared from the invoice's structured fields.

**Crossing between domains: WIMSE, by way of AI2II.** The crossing is the
WIMSE agent delegation chain
([draft-asor-wimse-agent-delegation-chain-03](https://datatracker.ietf.org/doc/draft-asor-wimse-agent-delegation-chain/),
by Rafael Asor) as exercised by
[AI2II](https://github.com/apelov/IETF127-Hackathon-AI2II-WIMSE) (Alexander
Pelov, IMT Atlantique, with Ivaylo Petrov). AI2II's capture of a cross-domain
payment request carries a WIMSE workload identity token and an RFC 9421
request signature. With its files fetched, the crossing step checks that
capture; without them, an OpenA2A check of a two-hop chain fixture runs in its
place, marked as a stand-in.

**Evidence: AEP, Tyche Institute.** Every action leaves an Action Evidence
Package
([draft-sokolov-rats-aep-composition](https://datatracker.ietf.org/doc/draft-sokolov-rats-aep-composition/),
by Anton Sokolov, Tyche Institute): a ZIP archive that holds the exact
response bytes, the action's metadata, their canonical form, its hash and a
signature. Anyone with the run's public key can check a package offline, with
no service to ask. The format and its reference verifier are in
[eatf-verifier](https://github.com/tyche-institute/eatf-verifier); the demo's
offline check runs an OpenA2A verifier written from that format.

## What is real and what isn't yet

- **The records** are written in the AEP format, as its
  [format page](https://github.com/tyche-institute/eatf-verifier/blob/main/docs/aep-format.md)
  gives it (`three-party/FORMAT-SOURCE.txt` names the text by its SHA-256),
  and checked by an OpenA2A verifier for steps 1 to 6 of the format's ordered
  verification. Steps 7 to 10 are not run.
- **The AEP reference verifier** has not yet been run on these records.
- **The timestamp entry** of each package is a placeholder: there is no
  timestamp authority.
- **The signer** is a test key made for each run. Its private half never
  reaches a file and is deleted once the run's last record is signed.
- **The crossing**, once AI2II's files are fetched, checks a capture AI2II
  published of a separate loopback exchange (harbor.example to
  northbank.example), not a crossing made for this payment. Without the
  files, an OpenA2A check of a two-hop delegation chain fixture runs in its
  place, and the screens mark it as a stand-in.
- **The agent** is scripted. No language model is called.
- **The bank** is a local mock that runs inside the demo on your computer.

Real, and run again on every run: the credential check, the token exchange,
the intent rule, the bank's decision on the payment, and the signature on
every record.

## Run it

Requirements: git, Node.js 22.12.0 or later and a browser, on macOS, Linux or
Windows. Checked on macOS 26.4 (Apple silicon) with Node.js 22.20.0 and
24.21.0, and on Debian 12 in Docker with Node.js 22.12.0 and 22.23.5; not yet
run on Windows.

```sh
git clone https://github.com/opena2a-org/three-party-demo
cd three-party-demo
npm ci
node scripts/three-party/fetch-ai2ii.mjs
npm run three-party
```

`node scripts/three-party/fetch-ai2ii.mjs` is optional. It downloads the
three files AI2II published at commit 32f584a (a packet capture, a decision
journal and a key set) into `three-party/external/ai2ii/`, which git ignores,
and checks each one against its pinned SHA-256. AI2II's repository has no
license yet, so the files are fetched, not copied into this one. Without them
the crossing runs as a stand-in.

```text
Three-party demo, build <short sha>
Ready. Open http://127.0.0.1:7390/ in a browser.
Press Ctrl+C to stop.
```

Open the address and press **Run the normal payment**. A run takes a little
over one minute; when it is paid, press **Run the poisoned invoice**. Once a
run has finished, **Audit the records** checks its records offline. **View
as** chooses what each step's panel leads with (for a security lead, finance,
a platform engineer or a standards engineer), and **Inspect** opens every
field.

The same two runs in a terminal, with no browser:

```sh
node three-party/bin/start.mjs --text --offline-check
```

The offline check denies the verifier network access with the method of the
operating system, and says on screen whether it could:

| Operating system | How the verifier's network access is denied |
|---|---|
| macOS | `sandbox-exec` with a profile that denies the network |
| Linux | a new user and network namespace (`unshare`), or `bwrap` where `unshare` is not allowed |
| Windows | no method that works without administrator rights; the check says "not measured" and still checks every record |

Inside a container that forbids namespaces (Docker's default profile, for
example), Linux reports "not measured" in the same way.

## The screens

The pictures are taken from runs of the demo itself, with AI2II's files
fetched: `node three-party/view/stills.mjs --url <address>` against a demo
started with `node three-party/bin/start.mjs --serve --pace 2`.

The normal payment, paid:

![The normal payment after its six steps: the credential check, the grant, the crossing, the intent rule, the payment and the records, ending paid.](three-party/stills/s1-paid-story-light-1440.png)

The poisoned invoice, stopped by the intent rule before the payment:

![The poisoned invoice run: the intent rule stops the run at the tool call that differs from the declared intent, and no payment is sent.](three-party/stills/s2-stopped-story-light-1440.png)

The offline check of a run's records:

![The offline check of the poisoned run's records: the verifier, the network state and the trusted signer; four records pass steps 1 to 6 of the format and the tampered copy is rejected at step 3.](three-party/stills/s6-offline-inspect-light-1440.png)

## What is in the repository

- [`three-party/README.md`](three-party/README.md): the detailed reference.
  The six steps, every command and option, the run directory, the offline
  check and its exit codes, the labels and the tests.
- [`three-party/CONTRACT.md`](three-party/CONTRACT.md): the fields of every
  file a run writes.
- `src/bank/`: the mock bank, its token service and its broker.
- `vendor/secretless-ai-0.23.1-unreleased.g0b25f7451f41.tgz`: an unreleased
  build of OpenA2A's [secretless-ai](https://github.com/opena2a-org/secretless-ai)
  at commit 0b25f7451f41. The mock bank runs its AAP broker and no other part
  of it; `vendor/VENDORED.md` gives its SHA-256 and the rebuild command.

## Tests

```sh
npm run test:three-party
npm test
```

`npm run test:three-party` checks the engine, the records, the verifier, the
crossing and the screens. It drives the screens in the installed Google
Chrome, which it needs, and takes several minutes. `npm test` checks the
vendored secretless-ai build, and that nothing in the installed tree runs at
install time.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
