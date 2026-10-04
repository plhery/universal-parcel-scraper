# Architecture

One lookup goes in and one timeline comes out. The package answers a question about a single
parcel and keeps nothing afterwards. Accounts, parcel storage, polling, notifications and any
decision based on an earlier check belong to whoever calls it.

<img src="docs/assets/how-it-works.svg" width="840" alt="An input is detected offline and fetched by the carrier's dedicated adapter, or by a fallback the caller enabled when that finds no history. Each scan's wording is filed under a stage, and the result is one timeline.">

## Where things live

- `core/` holds what every carrier shares: detection, the catalog, the result and status
  model, the error kinds, the step runner and the transports.
- `carriers/<id>/` is one carrier, complete.
- `providers/` holds the universal fallbacks and the rules that order them.
- `facade/` is `createTracker()`. `cli/` and `server/` are thin layers over it.
- `places/` turns the free-text location of a scan into coordinates.
- `generated/` and the catalog in `data/` come out of `npm run generate`. Edit the carrier
  folders, not those files.

## Entry points

- `universal-parcel-scraper` is safe for browsers. It exports catalog data, detection, status
  classification, input validation, result normalization and the provider-order rules, and it
  imports no Node runtime modules.
- `universal-parcel-scraper/node` adds the adapter registry, the transports, the telemetry
  hooks and `createTracker()`.
- `universal-parcel-scraper/places` loads its gazetteer on first use.
  [Its README](places/README.md) explains how a place is chosen.
- `universal-parcel-scraper/data/*` exposes the generated JSON contracts.
- `universal-parcel-scraper/app` holds helpers shaped for the parcel app this package was
  extracted from: its parcel view, the carrier-name hints for provider results, the
  result-clock helpers its sync uses, carrier scan-identity policies and the country a scan's
  location names. It imports no Node runtime modules and is outside the semver contract.

## Carrier folders

Each carrier owns its catalog document, retrieval, pure parsers, status evidence and
synthetic fixtures, next to a README on how its site is read. Nothing about a carrier lives
outside its folder except the files `npm run generate` derives from it.

An adapter is built by a factory that receives an `AdapterEnvironment`. That environment is
its only way to the network, and no framework or app import is allowed. The registry creates
one adapter per process, on first use, so a carrier that fails to load cannot take the others
down with it.

Every adapter passes the caller's signal and budget into each request it makes. An adapter
that names a client uses the host's `userAgent`, and one whose carrier only answers a browser
keeps its own. `testing/adapterContext.test.ts` holds both by driving every registered adapter
and provider against a transport that never answers. `testing/adapterContextSource.test.ts`
checks that each later request and wait takes the signal too. Lookups that need the local
Chromium share one browser, and each waits its turn inside its own budget.

Browser and image dependencies load only when the step that needs them runs. Packaged
workers, models and geographic data resolve against their own module, never the caller's
working directory.

An adapter declares its steps, for example `direct` then `trawl`.
[runSteps](core/runner/index.ts) runs them in order under one time budget. A later step runs
after a challenge, a transport failure or an inconclusive answer, and never after a definite
one.

## A lookup

`createTracker()` validates the input. A number whose shape fits several carriers is settled
by asking the ones that can recognize it cheaply. The tracker then tries the carrier's
dedicated adapter, and after that the fallbacks the caller enabled, in the coverage order.
One deadline and one cancellation signal cover the whole call. The answer lists every
attempt with its source and outcome.

A failure's kind says what a retry can change. `invalid_input` is a number the carrier does
not issue and `schema` is a reply that was not the expected shape, so neither is worth
repeating at once.

When a result names a delivery partner, the tracker also asks that partner's adapter. Its
answer comes back separately, checked against the number on its own. Adopting it is the
consumer's choice.

Consumers with their own router can call `trackCarrier` from `/node` with an
`AdapterRegistry`, their configured `UniversalTracker` and a `StepRecorder`. It dispatches one
carrier lookup and normalizes the result, and leaves scheduling and provider choice to the
caller. An adapter with `recordsSteps` reports its own lookup, so dispatch does not wrap its
telemetry a second time. `CarrierError.reason` separates expected details, such as Amazon
Shipping's expired history, from transport failures.

## Status model

Every scan ends up with one stage from [stages.json](data/stages.json), and `stage_source`
says how it got there:

- A stage the adapter declared from the carrier's own codes wins.
- A scan without one goes through the shared wording classifier in
  [core/status](core/status/wording.ts).
- A scan no rule matches takes the caller's fallback.

Each carrier's `statuses.json` records the codes and wordings seen from that carrier and the
stage each one means. [CORPUS.md](CORPUS.md) describes those records.

`resolveResult()` exposes an `instant` only for a scan clock with a verified UTC offset.
Local clocks keep their original fields. More rows alone do not prove a fresher or more
complete history.

## Fallback providers

The universal providers answer when no dedicated adapter can. Commercial ones run only when
the caller names them, and UPU is the default. `universalPlan()` orders the eligible providers
from recorded evidence. [providers/COMPARISON.md](providers/COMPARISON.md) explains the
order and [providers/COVERAGE.md](providers/COVERAGE.md) holds the evidence.

## HTTP server

The server adds bounded in-memory caching, duplicate-request sharing, provider spacing,
request limits and optional bearer authentication. It has no database.

A failed lookup is held too, for at least `failureCacheMs` and longer when the upstream or
the carrier's own after-failure interval asks for it. `Retry-After` says when the server will
ask again. A lookup run on a caller's own `budgetMs` is never held. Limits count the socket
address unless `trustedProxies` says how many proxies append to `X-Forwarded-For`.

Its logs carry route names, status codes and durations only. Library consumers connect their
own observability through `StepRecorder`. The routes are in [openapi.json](server/openapi.json).
