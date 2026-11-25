# Huayutong

Tracks shipments of Huayutong (HYT, 华羽通, 深圳市华羽通国际供应链有限公司), a Shenzhen
cross-border forwarder whose site is www.huayutong56.com, on its lines to Europe. Its tracker is its
own tenant of the rtb56 platform at `szhyt.rtb56.com`, which the site's tracking form asks (`OmsUrl`
in its `/admin/js/setting.js`) and where its login and registration links point. The request helpers
are shared with [YYPOST](../yypost/README.md). It is not [HYTD Express](../hytd/README.md) (浩源拓达).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `szhyt.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The site and the tracker write the name 华羽通; the tracker's title gives the company's full name.
- The adapter asks only for waybills of the one layout seen, JCY, ten digits and DH, and reads only
  the entry whose `server_hawbcode` is the number asked.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- Scans keep the wall clock the tracker gives them. Every row states `+08:00`, those placed in
  Britain too, where the courier's rounds would then come before dawn, so no offset is trusted.
- The missed delivery that leaves the parcel at a post office or access point reads as ready for
  pickup.
- `channel_hawbcode` is kept as the delivering network's number once the line gives one, without
  naming the network.
- The merchant's reference, whoever signed and the proof of delivery are never read.

## Limitations

- No delivery estimate, weight or service name, and no instants.
- Waybills of other layouts the line may issue are refused until one is seen.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a Huayutong
link. The page is plain HTTP, so no portal link is published, and the canary checks 17TRACK instead.

## Testing

`HUAYUTONG_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/huayutong`, with the number set
outside the repository. The unknown-number case asks the lookup for a string outside the line's
layout, or `HUAYUTONG_UNKNOWN_NUMBER` when set, and checks that the reply reads as not found.
