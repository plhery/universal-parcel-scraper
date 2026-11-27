# Huahai Express

Tracks shipments of Huahai (杭州花海供应链管理有限公司, Hangzhou Huahai Supply Chain Management), a
Hangzhou forwarder whose site is huahaiexpress.com, on its lines to the United States.

## How it works

The site's tracking page links to Huahai's own tenant of the Hualei (华磊) platform at
`119.45.241.73:8082`, over plain HTTP. The adapter is the platform's
([hualei.ts](../gzyl/hualei.ts)) with this carrier's host, clocks, repeats and status map:

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>`, then, when the interface holds no
   row for the number, one POST of the same `documentCode` to `trackIndex.htm`, which settles
   not-found.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

Recognition asks the same lookup: a row says Huahai holds the number.

## Notes

- The line's rows in China are on the platform's Beijing clock. From the flight's landing on, the
  line writes its rows on the destination's wall clock, which it does not name: read on Beijing's,
  a flight would land two hours after it left. Rows placed in a country rather than a town, and
  GOFO's, keep their wall clocks too, and GOFO's are then dated on GOFO's clocks as on other
  Hualei lines.
- The last mile is GOFO, UniUni or USPS, whose scans the tracker copies under Huahai's own number.
  The record names no channel or other number, so the result names no delivery carrier.
- USPS's scans arrive twice, their headline alone and with USPS's sentence after an arrow or a
  comma; the headline alone is folded into the fuller row.
- The platform's custom track rows (`CO_C_CR`) are held back as written ahead, as on every
  Hualei tenant.

## Limitations

- Rows after the landing, other than GOFO's, have no instant: the tracker gives their wall clock without its zone.

## Numbers

Huahai's waybills have `TRF` and thirteen digits, as a tracking directory's samples show. The
shape is left to the tracker, not detection.

## Links

The tracker is plain HTTP only, so the catalog's search page is the site's HTTPS tracking page,
which the canary also checks. A pasted link to the tracker's `trackIndex.htm` is read for its
number.

## Testing

Set `HUAHAI_EXPRESS_TRACKING_NUMBER` (and `HUAHAI_EXPRESS_UNKNOWN_NUMBER` for the not-found answer)
outside the repository and run `npm run test:carriers:live -- carriers/huahai-express`.
