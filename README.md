# Three-party demo

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Every customer, account, payee and payment in this demo is fictional.

A scripted payments agent pays one supplier invoice at a mock bank on your
computer. The payment runs as six steps, and each action leaves a signed
record. After a run, a verifier checks those records with network access
denied.

There are two runs:

- **Normal payment.** The invoice is what it says, and the payment goes through.
- **Poisoned invoice.** The invoice hides a line of text addressed to the
  agent. The agent follows it, and the intent rule stops the run before any
  payment is sent.

## Run it

Requirements: macOS, git, Node.js 22.12.0 or later and a browser. Checked on macOS 26.4 arm64 with Node.js 24.21.0, 2026-11-15.

```sh
git clone https://github.com/opena2a-org/three-party-demo
cd three-party-demo
npm ci
npm run three-party
```

```text
Three-party demo, build <short sha>
Ready. Open http://127.0.0.1:7390/ in a browser.
Press Ctrl+C to stop.
```

Open the address. On the left, choose scene 1 (Normal payment) or scene 2
(Poisoned invoice) and press the control under the list. A run takes a little
over one minute. Once a run has finished, scene 6 (Audit later) runs the
offline check on its records.

The same two runs in a terminal, with no browser:

```sh
node three-party/bin/start.mjs --text --offline-check
```

## The screens

The pictures below are taken from the example files in `three-party/examples/`,
not from a live run.

The normal payment, paid:

![The normal payment after its six steps: the credential check, the grant, the crossing, the intent rule, the payment and the records, ending paid.](three-party/stills/s1-paid-story-light-1440.png)

The poisoned invoice, stopped by the intent rule before the payment:

![The poisoned invoice run: the intent rule stops the run at the tool call that differs from the declared intent, and no payment is sent.](three-party/stills/s2-stopped-story-light-1440.png)

The offline check of a run's records:

![The offline check: the verifier, the network state and the trusted signer, and each record shown passing steps 1 to 6 of the format.](three-party/stills/s6-offline-inspect-light-1440.png)

## The six steps

| Step | What runs |
|---|---|
| Verify the agent's ATX credential locally | the credential's Ed25519 signature is checked under a pinned test issuer key |
| Issue a scoped AAP grant | a grant resolver checks the credential and the policy; the bank's token service returns an access token that lives 60 seconds |
| Cross into the supplier's bank's trust domain | a stand-in: a delegation chain check over a fixture of two hops |
| Apply the intent rule to each tool call | every argument of each tool call is compared with the declared intent, field for field |
| Pay the invoice under the grant | the mock bank's payment API decides, and the ledger row is read back |
| Write one signed record per action | a stand-in: our own writer, in the Action Evidence Package format, signed with a test key made for the run |

The declared intent is built from the invoice's structured fields before the
agent reads the invoice body. The intent rule is a rule: it compares values
for equality and nothing else.

## What is real, and what is a stand-in

Real, and run again on every run: the credential check, the token exchange,
the intent rule, the payment and the bank's decision on it, and the signature
on each record.

Stand-ins. The crossing and the record carry a stand-in mark on the screens:

- **The crossing.** The delegation chain is a fixture, not minted for this
  payment. It stands in for the interop piece of another party's
  specification.
- **The record.** The packages are written by our own writer and checked by
  our own verifier, which runs steps 1 to 6 of the format. Steps 7 to 10 are
  not run. The signer is a test key, and the timestamp entry is a stand-in:
  there is no timestamp authority.
- **The agent.** It is scripted. No language model is called.
- **The bank.** It is a mock bank that runs inside the demo on your computer.

## More

- [`three-party/README.md`](three-party/README.md): every command and option,
  the run directory, the offline check and its exit codes.
- [`three-party/CONTRACT.md`](three-party/CONTRACT.md): the fields of every
  file a run writes.
- `src/bank/`: the mock bank, token service and broker the engine starts.

## Tests

```sh
npm run test:three-party
npm test
```

Checked with Node.js 24.21.0. The first suite drives the screens in a browser
and takes several minutes.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
