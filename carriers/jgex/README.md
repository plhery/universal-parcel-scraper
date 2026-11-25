# JGEX

Tracks shipments of JGEX (锦鸽国际物流, 上海锦鸽国际货运代理有限公司), a Shanghai cross-border
forwarder whose site is www.jgex.net and whose lines carry parcels to the United States, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `www.jgex.net:8082`, the host the site's login, registration and price forms post to, then,
   when the interface holds no row for the number, one POST of the same `documentCode` to the
   tracking page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The rows the tracker copies from USPS come to the minute on the facility's clock and keep it as
  a wall clock, a midnight one as its day alone; the line's own rows come to the second on the
  platform's Beijing clock. Places lose their ZIP code. This is Kun Express's reading
  ([kun-express/parser.ts](../kun-express/parser.ts)).
- The rows from Shanghai's warehouse to the first US facility come from the platform's custom
  track product (`CO_C_CR`), written in one batch days ahead of their clocks. They are named as
  written ahead and listed as planned steps, not kept as scans. [status.ts](status.ts) still maps
  them.
- The warehouse's Chinese rows are shown in English.
- The record's product name is the service name and its destination the destination country.

## Limitations

The record does not give USPS's number, so the parcel is not handed to USPS. USPS's rows keep their
wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's JGEX page. No detection rule claims JGEX's layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`JGEX_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/jgex`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `JGEX_UNKNOWN_NUMBER` when
set.
