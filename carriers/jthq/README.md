# JTHQ

Tracks shipments of JTHQ (极通环球, 深圳市极通环球供应链有限公司), a Shenzhen cross-border
forwarder whose site is jito-scm.com, on its lines to Canada, Mexico, Colombia and the United
States. Its tracker is its own tenant of the rtb56 platform; the request helpers are shared with
[YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `jthq.rtb56.com` (`method=track`, `param`
   the JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP
   with one entry per number and its scans, newest first. An unknown number gets `success` 0 and
   "No query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice is the route. The tracking page the site links, `track_query.aspx`, settles a
search by an ASP.NET postback behind the platform's slider; the webservice needs no slider,
session, cookie or account. It answers plain HTTP only.

## Notes

- The request names no referring page: the webservice answers `null` to any request with a
  `Referer`, the tracking page's included, for a parcel and an unknown number alike. `null` reads
  as indeterminate.
- Every scan states its offset: JTHQ's own `+08:00`, even at the destination airport, and the
  delivering network's its place's. The adapter keeps them.
- `channel_hawbcode` is the delivering network's number. On the line to Canada it is Canada Post's
  sixteen-digit number, named as Canada Post's when its GS1 check digit holds; elsewhere it is named
  only when USPS's rule claims it whole. A USPS routing barcode is kept without the recipient's ZIP
  code that opens it.
- The scans carry codes, digits alone among Canada Post's, so the map reads the wording. Canada
  Post's departure names a code after it, and USPS's round its delivery window: the map reads
  either as an ellipsis.
- The merchant's reference, whoever signed and the proof of delivery are never read; places lose
  their postcodes.

## Limitations

No delivery estimate, weight or service name. The Mexico and Colombia lines' delivering networks
are not named, only their numbers.

## Numbers

The samples come from a tracking directory's JTHQ page. No detection rule claims JTHQ's layout
yet.

## Links

`track_query.aspx?track_number=` on the tracker's host reads as a JTHQ link. The page opens its
empty search form whatever number the address names, and is plain HTTP, so no portal link is
published, and the canary checks 17TRACK instead.

## Testing

`JTHQ_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/jthq`, with the number set outside
the repository. The unknown-number case asks for an invented number, or `JTHQ_UNKNOWN_NUMBER` when
set.
