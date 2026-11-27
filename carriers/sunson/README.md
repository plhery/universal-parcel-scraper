# Sunson Logistics

Tracks shipments of Sunson (深圳燊鑫国际物流有限公司), a Shenzhen forwarder whose site is
sunsonexpress.com, on its lines abroad such as the one to Israel.

## How it works

The site links to Sunson's own tenant of the Hualei (华磊) platform at `111.230.206.59:8082`, over
plain HTTP. The adapter is the platform's ([hualei.ts](../gzyl/hualei.ts)) with this carrier's
host and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Sunson holds the number.

## Notes

- Every row is read on the platform's Beijing clock: the order's data and the receipts at the
  line's warehouses in Shenzhen and Guangzhou are all written in China. A row dated after the
  lookup on that clock is dropped, as on every Hualei tenant.
- The rows are in Chinese, with one English row for the order's data; the adapter shows the
  Chinese ones in English.
- The line to Israel is named for HFD, its last-mile carrier, but the record holds no HFD number,
  so the result names no delivery carrier.
- The tracker keeps old records, so a number from years back still answers.

## Numbers

Sunson's numbers have `SUN` and twelve digits, as TrackShip's example shows. The rule is low and
recognition asks the tracker.

## Links

The tracker is plain HTTP only, so the catalog links no page of it. The canary takes HTTPS only,
so it checks 17TRACK.

## Testing

Set `SUNSON_TRACKING_NUMBER` (and `SUNSON_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/sunson`.
