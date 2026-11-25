# Bright East International

Tracks shipments of Bright East International (皓东国际, HDGJ, 深圳市皓东国际供应链有限公司), a
Shenzhen cross-border forwarder whose site is www.haodonggj.com and whose US line flies parcels
through Hong Kong for USPS to deliver, on its own tenant of the Hualei (华磊) forwarder platform.
The client is shared with [GZYL](../gzyl/README.md), whose README describes the platform; this
carrier keeps its host, its clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `134.175.244.145:8082`, the address the site's member login form posts to, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)). The site's own
   tracking links open 17TRACK and Track718.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or browser
is needed.

## Notes

- The record's transfer number is USPS's, without a channel name. It is named only when USPS's
  rule claims the number whole.
- The rows the tracker copies from USPS come to the minute on the facility's clock and keep it as
  a wall clock; the forwarder's own rows come to the second on the platform's Beijing clock. USPS's
  explanation after an arrow and the places' ZIP codes go. This is Kun Express's reading
  ([kun-express/parser.ts](../kun-express/parser.ts)).
- The forwarder writes some rows with the country's code ahead of the wording and no place
  (`US,Customs clearance completed`); the code becomes the place.
- The rows from the warehouse to Hong Kong come from the platform's custom track product
  (`CO_C_CR`). They are named as written ahead and listed as planned steps, not kept as scans, as
  is the landing in the United States when the forwarder writes it hours before its clock.
- The record's product name is the service name and its destination the destination country.

## Limitations

USPS's rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's HDGJ page. No detection rule claims the layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`HDGJ_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/hdgj`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `HDGJ_UNKNOWN_NUMBER` when
set.
