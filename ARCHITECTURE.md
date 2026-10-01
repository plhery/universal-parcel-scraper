# Architecture

The package answers one lookup. Consumers own accounts, parcel storage, polling, notifications
and decisions based on previous checks.

The browser entry point exports catalog data, detection, status classification, input validation,
result normalization and provider-order rules. It imports no Node runtime modules. The `/node`
entry point exports the adapter registry, transport, telemetry hooks and `createTracker()`.
`/places` loads its gazetteer on first use. `/data/*` exposes the generated JSON contracts.

Each carrier owns its catalog document, retrieval, pure parsers, status evidence and synthetic
fixtures. Factories receive an `AdapterEnvironment`; no framework or app imports are allowed.
Heavy browser and image dependencies load only when the relevant step runs. Packaged workers,
models and geographic data resolve against their own module, never the caller's directory.

`createTracker()` validates inputs, recognizes ambiguous numbers, tries the direct adapter,
then explicitly enabled fallbacks in the coverage order. One deadline and cancellation signal
cover the call. Returned attempts name sources and outcomes. An optional delivery-partner probe
returns an independently bound answer; adopting that answer remains the consumer's choice.

`resolveResult()` classifies stages and exposes an `instant` only for verified offset-bearing
scan clocks. Local clocks retain their original fields. More rows alone do not prove fresher
or more complete history.

The HTTP server adds bounded in-memory caching, duplicate-request sharing, provider spacing,
request limits and optional bearer authentication. It has no database. Library consumers can
use `StepRecorder` to connect their own observability; the HTTP server logs only route names,
status codes and durations.

[Provider ordering](providers/COMPARISON.md) · [Carrier corpus](CORPUS.md) · [HTTP contract](server/openapi.json).

Consumers with their own router can call `trackCarrier` from `/node`, supplying an
`AdapterRegistry`, their configured `UniversalTracker`, and a `StepRecorder`. It dispatches
one carrier lookup and normalizes the result; it leaves scheduling and provider choice to
the consumer. An adapter with `recordsSteps` reports its own lookup, so dispatch does not
wrap its telemetry a second time. `CarrierError.reason` distinguishes expected details
such as Amazon Shipping's expired history from transport failures.
