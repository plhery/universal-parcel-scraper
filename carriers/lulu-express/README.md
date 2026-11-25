# luluExpress

Tracks shipments of luluExpress (噜噜快跑, 深圳市噜噜快跑国际供应链有限公司), a Shenzhen
cross-border forwarder whose site is luluexpress.net, on its line to the United States, which USPS
delivers. Its tracker is its own tenant of the rtb56 platform: the "物流查询" link in the site's
header opens `szcxsd.rtb56.com/track_query.aspx`. The request helpers are shared with
[YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `szcxsd.rtb56.com` (`method=track`, `param`
   the JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP
   with one entry per number and its scans, newest first. An unknown number gets `success` 0 and
   "No query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The lookup finds a parcel by its waybill, the merchant's reference or the delivering network's
  number, each whole, never by a part of one. Waybills run in a dense sequence, so a made-up
  number of the same shape can name someone's parcel. The adapter asks only for luluExpress
  waybills and reads only the entry whose `server_hawbcode` is the number asked; an entry found
  under another of its numbers is a changed reply.
- The request names no referring page. [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does; this tenant answers the same with a `Referer` or without one.
  `null` reads as indeterminate.
- Every scan states an offset: luluExpress's own `+08:00`, at the destination too, and USPS's
  copies their own place's. The adapter keeps them.
- USPS's scans come copied, its delivery with the sentence USPS writes after its status, which
  repeats the clock and names the recipient's town and ZIP code. The adapter drops the sentence.
- `channel_hawbcode` is the delivering network's number. A USPS routing barcode is kept without
  the recipient's ZIP code, and the number is named as USPS's only when USPS's rule claims it whole.
- The merchant's reference, whoever signed and the proof of delivery are never read; places lose
  their postcodes.

## Limitations

- No delivery estimate, weight or service name.
- USPS numbers whose layout other networks share, as on the line seen, are kept without naming
  USPS.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a luluExpress
link. The page opens its empty search form whatever number the address names, and is plain HTTP,
so no portal link is published, and the canary checks 17TRACK instead.

## Testing

`LULU_EXPRESS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/lulu-express`, with the
number set outside the repository. The unknown-number case asks the lookup for a string outside
luluExpress's layout, or `LULU_EXPRESS_UNKNOWN_NUMBER` when set, and checks that the reply reads as
not found.
