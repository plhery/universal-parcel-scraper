# CTC Supply Chain

Tracks shipments of CTC Supply Chain (赤兔猫供应链, 深圳市赤兔猫供应链有限公司), a Shenzhen
cross-border forwarder whose site is szctc.com (szctc.cn redirects there), on its lines to the
United States. It is not the Taiwanese [CTC Express](../ctc-express/README.md). Its tracker is its own
tenant of the rtb56 platform: the tracking box on the site's home page opens
`szctc.rtb56.com/track_query.aspx`, and the header's login and sign-up buttons lead to the same host.
The request helpers are shared with [YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `szctc.rtb56.com` (`method=track`, `param`
   the JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP
   with one entry per number and its scans, newest first. An unknown number gets `success` 0 and
   "No query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The lookup finds a parcel by its waybill, the merchant's reference or the delivering network's
  number, each whole. The adapter asks only for CTC waybills and reads only the entry whose
  `server_hawbcode` is the number asked.
- The request names no referring page. [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does; this tenant answers the same with a `Referer` or without one.
  `null` reads as indeterminate.
- Every scan states its offset, following its place: CTC's own and the air line's in China
  `+08:00`, those in the United States their own. The adapter keeps them.
- `channel_hawbcode` is the delivering network's number, named as GOFO's when GOFO's rule claims it
  whole. GOFO's scans come copied with the support line GOFO appends to some of them, which the
  adapter drops as GOFO's own page does, and its map reads them as GOFO's: any "Delivery Exception"
  reason is a failed attempt, and "Hold for Instructions Requested" an exception.
- The air line's "Parcel Data Received", hours after CTC's facility took the parcel in, moves
  nothing.
- The merchant's reference, whoever signed and the proof of delivery are never read; places lose
  their postcodes.

## Limitations

No delivery estimate, weight or service name.

## Links

`track_query.aspx` on the tracker's host, with the number in `nums` as the site's tracking box
writes it, or in `track_number`, reads as a CTC Supply Chain link. The page opens its empty search
form whatever number the address names, and is plain HTTP, so no portal link is published, and the
canary checks 17TRACK instead.

## Testing

`SZCTC_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/szctc`, with the number set outside
the repository. The unknown-number case asks the lookup for a string outside CTC's layout, or
`SZCTC_UNKNOWN_NUMBER` when set, and checks that the reply reads as not found.
