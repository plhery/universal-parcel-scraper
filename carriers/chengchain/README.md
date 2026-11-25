# Chengchuang Supply Chain

Tracks shipments of Chengchuang Supply Chain (ChengChain, 诚创供应链, 浙江诚创供应链有限公司), a
Zhejiang cross-border forwarder whose site is ccscm56.com, on its line to the United States. Its
tracker is its own tenant of the rtb56 platform: the "运单查询" item in the site's menu opens
`zjcc.rtb56.com/track_query.aspx`, and its "客户登录" item leads to the same host. The request
helpers are shared with [YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `zjcc.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The lookup finds a parcel by its waybill or the merchant's reference, each whole. The adapter
  asks only for waybills of the one layout seen, CC, ten digits and GY, and reads only the entry
  whose `server_hawbcode` is the number asked.
- The request names no referring page. [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does; this tenant answers the same with a `Referer` or without one.
  `null` reads as indeterminate.
- Scans keep the wall clock the tracker gives them. Some rows state `+08:00`, those placed in the
  United States too, and the others no offset, so no offset is trusted.
- Two rows without an offset carry GOFO's wording for its label, with no number for it on the
  sample. "Label Cancelled" reads as GOFO's map reads it, an exception. "Shipping Label Created",
  written after the line's facility dispatched the parcel, and the line's later record of the
  parcel's data move nothing.
- "The local carrier is delivering urgently" repeats for days among transit rows, so it is not a
  delivery round.
- `channel_hawbcode` is kept as the delivering network's number once the line gives one, without
  naming the network.
- The merchant's reference, whoever signed and the proof of delivery are never read; places lose
  their postcodes.

## Limitations

- No delivery estimate, weight or service name, and no instants.
- Waybills of other layouts the line may issue are refused until one is seen.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a
Chengchuang Supply Chain link. The page opens its empty search form whatever number the address
names, and is plain HTTP, so no portal link is published, and the canary checks 17TRACK instead.

## Testing

`CHENGCHAIN_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/chengchain`, with the number
set outside the repository. The unknown-number case asks the lookup for a string outside the
line's layout, or `CHENGCHAIN_UNKNOWN_NUMBER` when set, and checks that the reply reads as not
found.
