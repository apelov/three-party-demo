# The trace view's row model: where each field comes from, and its OpenTelemetry neighbour

The view derives one row per step of `state.json` and nested rows from what the
step's `detail`, the manifest and `offline-check.json` already carry. Nothing is typed; a field the run does not carry is
left out, never invented. The OpenTelemetry column names the field of `Span`, `Span.Event` or `Status` in
`opentelemetry/proto/trace/v1/trace.proto` (read 2026-11-15 at raw.githubusercontent.com/open-telemetry/opentelemetry-proto)
that carries the same thing; the JSON form of those names is lowerCamelCase (OTLP specification, JSON Protobuf Encoding,
read 2026-11-15 at opentelemetry.io/docs/specs/otlp/). The row model is internal to the view and is not an OTLP document:
`traceId` and `spanId` are the run's and the step's string ids, not byte arrays; times stay the records' RFC 3339 strings,
not `fixed64` nanoseconds; attributes are the contract's objects, not `KeyValue` lists. So the screen says `trace.shape`
("Shaped like a distributed trace ... Not an OpenTelemetry export.") and claims no compatibility.

| row field | source in the run (contract v1 path) | OpenTelemetry field | note |
|---|---|---|---|
| `traceId` | `runId` | `Span.trace_id` (`traceId`, hex) | a string id, kept as the run id |
| `spanId` | `steps[].id`; nested rows `<step id>/<kind>/<n>` | `Span.span_id` (`spanId`) | string ids |
| `parentSpanId` | null for a step; the step id for a nested row | `Span.parent_span_id` (`parentSpanId`) | |
| `name` | `steps[].title`; nested: `calls[].tool`, a `scopeChecked[]` name, a manifest `records[].file`, an offline `records[].file` | `Span.name` (`name`) | shown through `trace.call`, `trace.check`, `trace.record` |
| `startTime` | `steps[].startedAt` | `Span.start_time_unix_nano` (`startTimeUnixNano`) | RFC 3339 string kept; the name differs on purpose because the type differs |
| `endTime` | `steps[].endedAt` (null while running) | `Span.end_time_unix_nano` (`endTimeUnixNano`) | as above |
| `status.code` | `steps[].status`: `passed`, `written` give `STATUS_CODE_OK`; `blocked` gives `STATUS_CODE_ERROR`; `pending`, `running`, `not-reached`, `expired` give `STATUS_CODE_UNSET` | `Status.code` (`STATUS_CODE_UNSET` 0, `STATUS_CODE_OK` 1, `STATUS_CODE_ERROR` 2) | the state word shown is still the map's (`labels.states`), never the code |
| `status.message` | `reason`, on the step whose id equals `blockedAt` | `Status.message` | the run's own sentence, never reworded |
| `attributes` | `steps[].detail` (the object as written) | `Span.attributes` | the inspector shows them; the trace row shows none inline |
| `events` | `steps[].detail.events[]` when a later contract revision carries them (`{name, at, attributes}`) | `Span.events[]` (`Event.name`, `Event.time_unix_nano` as `timeUnixNano`, `Event.attributes`) | the one additive field this ruling recommends for the contract; until it exists, nested rows are untimed |
| `resource` | `steps[].part`, `steps[].partLabel` | `Resource.attributes` (`service.name`) in OTLP | shown as the step's column, never named `service.name` |
| `kind` | not carried | `Span.kind` | left out |
| `links` | not carried | `Span.links` | left out |

Derived by the view (not in the records, computed from the fields above and the browser clock):

| derived | from | shown as |
|---|---|---|
| offset | `startTime` minus the run's `startedAt`, seconds | `trace.offset` |
| duration | `endTime` minus `startTime`, seconds (one decimal when the strings carry fractions, else whole) | `trace.duration`; `trace.soFar` with the browser clock while `endTime` is null; `trace.notTimed` when `startTime` is null |
| decided here | the nested call row of the `blockedAt` step whose `match` is false, earliest by order | `trace.decidedHere` |
| lane bar | offset and duration over `labels.trace.laneSeconds` while live; over the run's length once `finishedAt` is set | a bar in the Time column; none for `pending`, `not-reached` and untimed rows |

Nested rows per step, from what contract v1 carries (untimed unless `events[]` exist):

| step | nested rows | state cell |
|---|---|---|
| credential | one `trace.check` with `{name}` = `detail.verifier` | none (the step's row carries the state) |
| grant | one `trace.check` per name in `detail.scopeChecked[]` | none (per-check results are not carried) |
| crossing | none in v1 (hops is a count; no per-hop record) | |
| intent | `trace.declared`, then one `trace.call` per `detail.calls[]` with `{tool}` | `decision.allowed` when `match` is true; `decision.blocked` when false, with `intent.undeclared` when `declaredFor` is null, else `intent.differs` and the leading `fieldsDiffering` name |
| pay | none in v1 (the bank's answer is in `detail` and the action file) | |
| record | one `trace.record` per `records/manifest.json` `records[]` with `{file}` | `state.written` |
| offline check (scene 6) | one top row `trace.offlineRow` with `at` as its start, then one `trace.record` per `records[]` and `tampered[]` | `offline.pass` or `offline.reject` with `{n}` |

This copy differs from the staged field map in four phrases, changed for the repository's own checks on words: the note on `events` named a role, and the line on the call that decided and the line on the intent step used an ordinal the checks bar, the second of them twice.
