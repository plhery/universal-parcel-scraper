# WE Logistics

Tracks shipments of WE Logistics (世航国际, Shihang International, 江苏世航国际货运代理股份有限公司
上海分公司), a forwarder whose site is www.we-logistics.com, on its parcel lines abroad, such as the
one to Israel through Hong Kong. Its tracker is its own tenant of the rtb56 platform at
`shgj.rtb56.com`, where the site's tracking form and member login point. The request helpers are
shared with [YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `shgj.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The adapter asks only for waybills of the one layout seen, WEL, two letters, ten digits and YQ,
  and reads only the entry whose `server_hawbcode` is the number asked.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- The line's own rows in Shenzhen carry a code and state `+08:00`, so they get their instant. The
  rows of the line abroad, from Hong Kong to the pick-up point in Israel, state no offset and keep
  the wall clock the tracker gives them.
- `channel_hawbcode` is the number of the line abroad. The reply names no carrier for it, so the
  result gives the number without one.
- One row's wording is only its place, the line's Shenzhen headquarters (深圳总部), after the
  warehouse dispatched the parcel; it reads as in transit.
- The merchant's reference, whoever signed and the proof of delivery are never read.

## Limitations

- No delivery estimate, weight or service name, and no instants for the rows abroad.
- Waybills of other layouts the line may issue are refused until one is seen.

## Numbers

The sample comes from a tracking directory's page for the line. No detection rule claims the
layout.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a WE
Logistics link. The page is plain HTTP, so no portal link is published, and the canary checks
17TRACK instead.

## Testing

`WE_LOGISTICS_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/we-logistics`, with the
number set outside the repository. The unknown-number case asks the lookup for a string outside the
line's layout, or `WE_LOGISTICS_UNKNOWN_NUMBER` when set, and checks that the reply reads as not
found.
