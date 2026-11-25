# Xinshu Logistics

Tracks shipments of Xinshu Logistics (新树物流, XS Express, 深圳市新树国际物流科技有限公司), a Shenzhen
cross-border forwarder whose site is xs-exp.com and whose US line hands parcels to USPS, on its own
tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host, its
clocks and its status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `tms.xs-exp.com:8082`, the address of the site's "运单查询" and "新树查询" links, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking page
   `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only. No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The line's own numbers are XSECN, digits and YQ. On the US line USPS's number takes the record's
  tracking number, without a channel name. It is named only when USPS's rule claims the number
  whole.
- The rows the tracker copies from USPS come to the minute on the facility's clock and keep it as
  a wall clock; the line's own rows come to the second on the platform's Beijing clock. This is
  Kun Express's reading ([kun-express/parser.ts](../kun-express/parser.ts)).
- USPS's copies end with their place in full, while the place field can hold the town alone: the
  wording ends where the place starts, and the place keeps its state without its ZIP code.
- The line's own rows lead with the country's name (`China,Departed from sorting center`), which
  goes.
- The record's product name is the service name and its destination the destination country.

## Limitations

USPS's rows keep their wall clock without an instant. No delivery estimate or weight.

## Numbers

The sample comes from a tracking directory's Xin Shu Logistics page. No detection rule claims the
layout yet.

## Links

The tracker's `trackIndex.htm?documentCode=` opens one number. Since the tracker is plain HTTP, no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`XS_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/xs-express`, with the number
set outside the repository. The unknown-number case asks for a string in no shape the tracker
issues, or `XS_EXPRESS_UNKNOWN_NUMBER` when set.
