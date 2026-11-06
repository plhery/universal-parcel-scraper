# SkladUSA

Public guest history for SkladUSA's own system references, covering Ukrainian sellers'
shipments through consolidation and delivery abroad. Partner numbers and account API
placeholders are outside the adapter's input scope.

## Retrieval

A bounded guest GET opens the lowercase whole reference at `/en/tracking/{trackingNumber}/`.
A fresh cookie jar retains the guest session and language choice through same-reference
redirects to the default Ukrainian route. Both English and Ukrainian layouts are parsed.
It needs no account or secondary input. The exact response route, canonical link,
matching desktop/mobile result headings and one desktop history table bind the result.
These conditional headings are not an independent shipment object; the adapter exposes
explicit lookups without adding HTTP recognition or widening detection.

The responsive mobile history is checked for agreement but is not emitted twice.
Every source row is validated before deduplication and the output cap. Unknown wording
becomes a generic update with partial coverage, leaving enabled providers available.
The empty-history notice cannot distinguish an unknown item from unavailable or expired
history, so it remains indeterminate. Refusals, unexpected redirects and malformed replies
stay distinct. Redirect count and total bytes are bounded. One network-only retry restarts
the guest session within the caller's deadline.

## Meaning and clocks

Creation and preparation do not establish custody. Facility movement and last-mile scans
have separate stages; a delivery followed by further movement cannot close the journey.
Carrier names inside scan prose do not establish a delivery partner or a usable handoff
reference. Arbitrary location tails, recipient details and proof fields are omitted.

Scan clocks retain their displayed minute wall time. International facility clocks do not
establish a single zone, so the adapter supplies no inferred instant, delivery instant or
estimate. No account API is needed for this public read.

## Testing

Set `SKLADUSA_TRACKING_NUMBER` and optionally `SKLADUSA_UNKNOWN_NUMBER` outside the
repository, then run `npm run test:carriers:live -- carriers/skladusa`.
