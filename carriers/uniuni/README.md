# UniUni

Tracks individual parcels recognized by the official anonymous tracking page.

## How it works

One bounded GET uses the site's fixed public web configuration. No browser,
account or session bootstrap is needed. The response must identify one matching
parcel; master shipments with multiple pieces remain inconclusive.

## Notes

Corrected per-scan seconds provide instants. The older numeric clock field
encodes local wall time and is excluded. Missing corrected seconds retain local
clocks in provider order without advancing freshness. Impossible local dates retain
their original text. Current status comes from
the latest actual scan. The legacy estimate field is excluded because the
current page uses a separate service with an explicit enabled flag. That
optional estimate service is not queried. Detailed delivery prose, addresses,
coordinates, operators and proof images are excluded.

After a handover, a partner courier's scans arrive without UniUni's English
summary, as does a Uni Store drop-off, which also has no status code. Their own
short scan text is kept as the description; they carry local clocks only. The
parcel's country, the United States or Canada, is the destination.
Detection claims the `UUS`, `UUSC`, `4C…US` and `U9999` formats and suggests
UniUni for other `U` and fifteen-digit references, which Canadian parcels carry.
Cross-border shippers' references of two letters, two digits, `CAA0`, a letter
and nine digits only suggest UniUni: Intelcom's tracker accepts them too.
Recognition looks them up at UniUni, whose tracker lists a reference it does not
know as invalid.

## Estimate endpoint lead

The [official tracking client](https://www.uniuni.com/tracking/) also posts to
`https://sj.uniexpress.ca/version2/orders/edd_information` with a `tnos` array
and its public website key. It needs no account or browser session. The reply
identifies each parcel by `tno`, with `edd_enabled` and `delivery_estimate`;
an enabled record can still have no estimate.

This adapter does not query that service. An estimate must match the parcel,
have an enabled flag and retain its date or time-window precision without an
invented offset. Its failure must leave tracking history usable, and a completed
delivery or return must suppress the estimate.

## Live test

Set `UNIUNI_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/uniuni/adapter.live.test.ts`.
Optionally set `UNIUNI_UNKNOWN_NUMBER` to check an absent parcel.
