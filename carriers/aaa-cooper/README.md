# AAA Cooper

Tracks AAA Cooper Transportation's less-than-truckload freight in the United States by PRO
number through its server-rendered results page. The host supplies a fetcher routed through
the Americas; the adapter owns no proxy credentials.

Midwest Motor Express and DHE Transportation ship under the AAA Cooper brand and tracker
([Trucking Dive](https://www.truckingdive.com/news/aaa-cooper-transportation-act-rebrand-mme-dhe-unify/803126/)),
so their names are aliases here.

The page reads an eight-digit PRO. For a nine-digit PRO, the adapter validates its Luhn check
digit before requesting the first eight digits. These numeric shapes overlap other carriers,
so the caller names AAA Cooper or supplies one of its tracking links.

## Retrieval

An ordinary lookup needs one GET to
`https://www.aaacooper.com/pwb/Transit/ProTrackResults.aspx?ProNum={PRO}`. A connection failure
can retry once within the lookup budget. The returned shipment must name the requested PRO.
The page's explicit missing-shipment notice means not found; its processing notice means a
listed shipment without history. Other notices and refusals retain their failure kinds.

A visible Telerik image challenge enables bounded CPU OCR recovery. The adapter keeps the
lookup's cookie jar and complete native form state, reads the declared script-manager
resource, and submits only when the original image and two uncropped threshold transforms
agree on six digits. It allows two fresh puzzles and never retries a POST after a network
failure. Forms, cookies and images stay in memory.

The worker uses the package's licensed text model through optional `sharp` and
`onnxruntime-web` dependencies. Assets resolve against their module. Recovery honors the
form's minimum-time protection, cancellation and the remaining lookup budget, including
worker cleanup. Unsupported markup, unreadable images and refused verification remain
challenges.

## Scope

The adapter reads shipment status and dated tracing rows. Scans retain local wall clocks;
the terminals span several time zones. Estimated delivery, signatures, freight documents
and account features are outside its scope.

## Live test

Set private `AAA_COOPER_TRACKING_NUMBER` and `AAA_COOPER_PROXY_URL` (a US proxy), then run
`npm run test:carriers:live -- carriers/aaa-cooper/adapter.live.test.ts`.
