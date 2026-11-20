# Benben International

Tracks shipments of Benben International (犇犇国际), a Chinese forwarder whose site is
bbgjwl.cn, on its own tenant of the Hualei (华磊) forwarder platform. Its US lines fly parcels
from China to the United States; the tracker copies the destination's scans into its own
record. The client is shared with [GZYL](../gzyl/README.md), whose README describes the
platform.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `119.29.253.160:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- [status.ts](status.ts) maps the warehouse's receipt (`ARRIVAL`), whose wording "Arrive at the
  delivery point" means where the shipper hands the parcel over, and its departure (`SHIPMENT`).
  The other English rows go through the shared rules.
- Rows keep their wall clocks: they come from the warehouse, the airports and the destination.
- Rows written well before their own clocks, such as the flight's, are named as written ahead
  rather than kept as scans.
- The record's product name is the service name. Records name no channel or transfer number, so
  no delivering carrier is handed over. The tracker also finds a parcel by the shipper's
  reference, and then names the BEN number.

## Limitations

The delivering carrier and its number are never shown. No delivery estimate or weight.

## Numbers

The only public number is a directory's sample: BEN, eight digits and BEN. One sample is too few
to tell the series from other carriers' numbers, so no rule claims it and the adapter answers
explicit selection. The sample and its source are in [`numbers.json`](numbers.json).

## Links

The tracking page is plain HTTP on a bare address, so no portal link is published, and the
canary checks 17TRACK.

## Testing

`BENBEN_TRACKING_NUMBER=BEN25250914BEN BENBEN_UNKNOWN_NUMBER=BEN00000000BEN npm run test:carriers:live -- carriers/benben`
