# XYS Logistics

Tracks shipments of XYS Logistics (XYS, 新源晟, 新源晟（深圳）国际物流有限公司), a Shenzhen
cross-border forwarder whose site is xyslogistics.com, on its lines abroad, where a national network
such as DHL in Germany delivers. Its tracker is its own tenant of the rtb56 platform at
`szxys.rtb56.com`, which the site's tracking form asks (`OmsUrl` in its `/admin/js/setting.js`) and
where its registration link points. The request helpers are shared with
[YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `szxys.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The adapter asks only for waybills of the one layout seen, XYS, nine digits and CN, and reads
  only the entry whose `server_hawbcode` is the number asked.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- No row states an offset, so every scan keeps the wall clock the tracker gives it.
- The tracker can list a row two or three times; each is read once.
- Every row carries a code, the line's own and the milestones it writes for the flight, customs and
  the delivering network; the English wording decides the stage.
- `channel_hawbcode` is the delivering network's number. DHL is named only when its rule claims the
  number whole.
- The merchant's reference and whoever signed are never read.

## Limitations

- No delivery estimate, weight or service name, and no instants.
- Waybills of other layouts the line may issue are refused until one is seen.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as an XYS
Logistics link. The page is plain HTTP, so no portal link is published, and the canary checks
17TRACK instead.

## Testing

`XYS_LOGISTICS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/xys-logistics`, with the
number set outside the repository. The unknown-number case asks the lookup for a string outside the
line's layout, or `XYS_LOGISTICS_UNKNOWN_NUMBER` when set, and checks that the reply reads as not
found.
