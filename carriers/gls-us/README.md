# GLS US

Tracks GLS US parcels, the network once called Golden State Overnight (GSO), through the
service behind GLS's
[US tracking page](https://gls-group.com/US/en/send-and-receive/track-a-parcel/). GLS US runs
its own system: GLS's European trackers do not know its parcels, nor it theirs.

## How it works

1. `direct`: one anonymous
   `POST https://connect.gls-us.com/api/public/tracking/TrackShipmentSummariesByTrackingNumbers`
   with `{"trackingNumbers": number, "isFreight": false}`, as the page's script sends it. It
   needs no credential, cookie or token. The number is checked before any request, the read
   stops at 1 MB and redirects are not followed.
2. `retry`: the same read once more after a network failure or a timeout, inside the budget.

The default budget is 15 seconds.

## Notes

- A number the service does not know comes back as HTTP 200 with an empty list and the
  sentence the page shows, "The search found no shipments that matched your criteria." Only
  that answer is not found. An empty list with any other message, an empty reply and a 404
  are inconclusive; a block page is a challenge.
- Only shipments filed under the whole number are read. A reply without one is a schema
  failure. A number used for several shipments gives the one with the newest scan, and two
  whose newest scans share a clock leave the answer inconclusive.
- The shipment's own status ("out for delivery", "delivered", "returned") sets the current
  stage, as on the page; its newest staged scan does when the status is one the map does not
  know, or when that scan is further along than a status that lags it. A scan wording the map
  does not know takes the shared wording rules, so a newer attempt or return is not hidden
  behind an older delivery or round, and a delivery under a newer scan neither stages is no
  longer current.
- Scan clocks are wall clocks without an offset, kept in `local_time`. They are not UTC: a
  reply archived while a parcel was out for delivery came before, in UTC, the delivery clock it
  later showed. The network spans the Pacific, Mountain and Central zones, so each scan is dated
  on its place's zone, as for other US carriers.
- The date at the end of "ARRIVAL SCAN - DELIVERY SCHED FOR" stays in the wording. The estimate
  is the reply's estimated delivery day, given only while the parcel moves.
- The recipient's company, contact and address, the signer, the shipper's reference, the
  delivery time, the proof of delivery and signature images and the delivery-route widget are
  never read.
- Providers name the network "GLS US", "GLS (US)" or "GSO (GLS US)". It is not one of bare
  "GLS"'s networks, so the European networks' shared clock and number hints stay theirs.
- Detection offers it, at low confidence, for SH and eighteen digits, the shape of the public
  sample, and recognition asks the service. The page takes any five to twenty letters and
  digits; other shapes, such as the GSO numbers in old gso.com links, are not offered, since
  runs of digits overlap other carriers' numbers.

## Limitations

- Only the scans' wordings and the shipment statuses the page's script reads are mapped.
  Exceptions, failed attempts and returns have not been seen in scans; the shared wording
  rules read them.
- Clocks outside California are dated on their place's zone without a live comparison.
- No weight, sender or delivery instant.

## Testing

`npm run test:carriers:live -- carriers/gls-us` sends a well-formed unknown number, or
`GLS_US_UNKNOWN_NUMBER`. Set `GLS_US_TRACKING_NUMBER` to read the history of an authorized real
parcel.
