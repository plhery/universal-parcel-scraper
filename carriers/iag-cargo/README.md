# IAG Cargo

IAG Cargo carries the freight of British Airways, Iberia and Aer Lingus on master air waybills with their IATA
prefixes 125, 075 and 053. Enter the whole waybill, with or without its dash.

## How it works

1. `direct`: `GET https://api.tracking.iagcargo.com/tracking/<prefix>-<serial>`, the request the
   [tracker](https://ui.tracking.iagcargo.com/en) page makes, with no account, token or key. The reply names the
   waybill it answers, which must be the one asked for.

## Notes

- The serial alone is refused: the three airlines number their serials separately, so it does not name one waybill.
- The service needs the dash between prefix and serial and refuses a waybill without it with HTTP 400. It answers
  every unknown waybill, whatever its prefix, with HTTP 404 and the text "There was no AWB found with the following
  number: <waybill>.", which is read as not found only when it names the waybill asked for. IAG Cargo drops
  waybills a few months after their flights, so older public waybills come back this way.
- Each station along the route lists its milestones. Times ending in `Z` are kept as instants; a time without a
  zone is the station's wall clock and stays in `local_time`. Stations keep the route's order, since wall clocks
  cannot be compared across stations.
- A milestone not reached yet, or dated by a scheduled or estimated time, is a planned event, under the tracker's
  heading for it; a planned arrival takes its arrival time. Entries the tracker marks as duplicated are left out.
- The wording comes from the tracker's own translations. The booking and a cancellation come from the shipment
  status. An offload or a short shipment becomes its own event and keeps the stage before it, as does a transfer
  manifest; a delivery notice or a delivery away from the waybill's destination is a step on the way.
- A delivery of part of the pieces delivers the waybill only once the delivered pieces reach its total.
- A refusal (HTTP 403 or a verification page), any other 404 or 400, or an unreadable reply is a changed service,
  never a missing waybill.

## Limitations

- The fixtures for tracked waybills are synthetic, shaped as the tracker's page reads the reply: every public
  waybill found had already left the tracker.
- Origin and destination names, pieces, weights and the journey map are not kept.
- The tracker opens a waybill only with the dash the number may be typed without, so the catalog links to the
  track page.

## Testing

`IAG_CARGO_TRACKING_NUMBER=… IAG_CARGO_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/iag-cargo`
