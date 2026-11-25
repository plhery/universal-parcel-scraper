# BULONGGUOJI

Tracks shipments of BULONGGUOJI (布龙国际, 深圳市布龙国际供应链有限公司), a Shenzhen cross-border
forwarder whose site is bulonggj.com and whose US line hands parcels to USPS, on its own tenant of
the Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose
README describes the platform; this carrier keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `106.52.54.99:8082`, where the site's member login posts, then, when the interface holds no row
   for the number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`, which
   settles not-found ([hualei.ts](../gzyl/hualei.ts)). The site's own "运单查询" page shows the same
   rows through a proxy of its own.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- On the US line USPS's number is the record's transfer number, without a channel name. It is named
  only when USPS's rule claims the number whole.
- The rows the tracker copies from USPS come to the minute on the facility's clock and keep it as
  a wall clock; the line's own rows come to the second on the platform's Beijing clock. This is
  Kun Express's reading ([kun-express/parser.ts](../kun-express/parser.ts)), which also cuts USPS's
  explanation after the arrow and the place's ZIP code.
- The tracker copies one USPS scan up to twice at the same minute and place: alone, and with USPS's
  category ahead (`On the Way, Arrived at USPS Facility`) or its detail after
  (`Out for Delivery, Expected Delivery by 9:00pm`). The scan counts once, in its shorter wording.
- The warehouse's rows to the flight come from the platform's custom track product (`CO_C_CR`).
  They are named as written ahead and listed as planned steps, not kept as scans.
- The record's product name is the service name and its destination the destination country.

## Limitations

USPS's rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's BULONGGUOJI page. No detection rule claims the layout
yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`BULONGGUOJI_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/bulongguoji`, with the number
set outside the repository. The unknown-number case asks for a string in no shape the tracker
issues, or `BULONGGUOJI_UNKNOWN_NUMBER` when set.
