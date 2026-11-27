# Tongxi Supply Chain

Tracks shipments of TongXi (桐溪供应链, 深圳市桐溪供应链管理有限公司), a Shenzhen forwarder whose
site is tongxiwl.com, on its lines into Europe.

## How it works

The site links TongXi's own tenant of the Hualei (华磊) platform at `1.14.133.93:8082`, over plain
HTTP. The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts)) with this carrier's host,
clocks and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says TongXi holds the number.

## Notes

- The line's rows, in China, at the airports and through customs, and its "Parcel in transit"
  every two days, are on the platform's Beijing clock: read on Madrid's, the arrival at the origin
  airport, the first-mile departure and the customs departure would come before the platform wrote
  them.
- The delivery carrier's rows, its step and its sentence to the recipient ("Out for Delivery Your
  shipment is out for delivery"), keep their wall clock in the destination country: read on
  Beijing's, its courier would have gone out for delivery and failed an attempt in the middle of
  the night in Spain. The record does not say whose clock, so the rows have no instant.
- The line writes the destination country as the place of its own rows from the origin airport on
  ("Spain,ESP"). A place that is only a country is left out of them, with the "of" it leaves
  closing "Departed from customs of".
- The record names no delivery carrier and no other number, so the result names none.
- The platform's custom track rows (`CO_C_CR`) are held back as written ahead, as on every Hualei
  tenant.

## Numbers

TongXi's numbers have `TX` and sixteen digits, as TrackShip's example shows. No other carrier's
rule or sample takes the shape, so `tongxi-1` offers it at low confidence and recognition asks the
tracker.

## Links

The tracker is plain HTTP only, so the catalog links no page of it, and the canary checks 17TRACK.
A pasted link to the tracker's `trackIndex.htm` is read for its number.

## Testing

Set `TONGXI_TRACKING_NUMBER` (and `TONGXI_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/tongxi`.
