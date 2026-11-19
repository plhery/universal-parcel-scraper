# JCH

Tracks shipments of JCH (浙江金岂供应链管理有限公司, Zhejiang JCH Supply Chain Management), a
Zhejiang forwarder whose site is jch-exp.com, on its lines to the United States and Canada.

## How it works

The site's tracking form posts to JCH's own tenant of the Hualei (华磊) platform at
`www.jch-exp.com:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, clocks and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says JCH holds the number.

## Notes

- The line's rows in China carry no place or its "Transit Center" and are read on Beijing's
  clock. Rows placed at an airport or a town abroad keep their place's wall clock: a flight that
  leaves at a Beijing clock lands at Incheon on Seoul's and in Toronto or Los Angeles on theirs.
- A record keeps JCH's own number in its invoice field and the delivery carrier's in its tracking
  number, with no channel named. On the line to the United States that is SpeedX's number, which
  SpeedX's own rule claims whole, so the result names SpeedX with it.
- The platform imports the line's scans in batches, so a scan can reach the tracker hours after
  a universal provider shows it. A not-found leaves the enabled universal providers to answer.

## Limitations

- The delivery carrier on the line to Canada is not named: its number has a Canada Post shape
  that its scans do not bear out.

## Numbers

JCH's references have `JCHSG` and thirteen digits, as ParcelPanel's sample shows. JCH also books
parcels with [JS Express](../js-express/README.md) under them, and then only JS Express's lookup
knows the number, so both rules are low and the tracker that knows it decides.

## Links

The tracker is plain HTTP only, so the catalog links no page of it. The canary takes HTTPS only,
so it checks 17TRACK, which the site links to.

## Testing

Set `JCH_TRACKING_NUMBER` (and `JCH_UNKNOWN_NUMBER` for the not-found answer) outside the
repository and run `npm run test:carriers:live -- carriers/jch`.
