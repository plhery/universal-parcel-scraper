# Haihehui International

Tracks shipments of Haihehui International (HHH, 海河汇国际, 深圳市海河汇国际供应链有限公司), a
Shenzhen cross-border forwarder whose site is szhhh56.com, on its lines to the United States, where
USPS or UniUni delivers. Its tracker is its own tenant of the rtb56 platform: the "运单查询" item in
the site's menu opens `szhhh.rtb56.com/track_query.aspx`. The request helpers are shared with
[YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `szhhh.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The adapter asks only for waybills of the one layout seen, HHH, ten digits and YQ, and reads
  only the entry whose `server_hawbcode` is the number asked.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- Scans keep the wall clock the tracker gives them. The line's own rows state `+08:00`, some placed
  in the United States too, and UniUni's copies `-05:00` in Chicago and Dallas before daylight
  saving began, so no offset is trusted.
- USPS's sentence after an arrow, which names the recipient's ZIP code, goes.
- USPS's "Shipping Label Created" and UniUni's "Order received", both made after the line's
  facility dispatched the parcel, are records rather than scans and move nothing.
- `channel_hawbcode` is the delivering network's number; a USPS routing barcode gives its package
  identifier. USPS or UniUni is named only when its rule claims the number whole.
- The merchant's reference, whoever signed and the proof of delivery are never read; places lose
  their postcodes.

## Limitations

- No delivery estimate, weight or service name, and no instants.
- Waybills of other layouts the line may issue are refused until one is seen.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a Haihehui
International link. The page is plain HTTP, so no portal link is published, and the canary checks
17TRACK instead.

## Testing

`HHH_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/hhh`, with the number set outside the
repository. The unknown-number case asks the lookup for a string outside the line's layout, or
`HHH_UNKNOWN_NUMBER` when set, and checks that the reply reads as not found.
