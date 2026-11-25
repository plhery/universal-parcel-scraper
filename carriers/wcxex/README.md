# WCXEX

Tracks shipments of WCXEX (伟成国际, Weicheng International, 浙江伟成国际货运代理有限公司), a Yiwu
forwarder whose site is www.wcxex.com, on its line to the United States, where USPS or SpeedX
delivers. Its tracker is its own tenant of the rtb56 platform at `wc.kjeclub.com`, which the site's
tracking page asks (`OmsUrl` in its `/admin/js/setting.js`) and where its registration link points.
The request helpers are shared with [YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `wc.kjeclub.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per number and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The adapter asks only for waybills of the one layout seen, WX, a digit, a letter and twelve
  digits, and reads only the entry whose `server_hawbcode` is the number asked.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- The line's own rows state `+08:00`, each with its `track_code`, and get their instant, at its US
  gateways too: on that clock the flights from Hong Kong take the 16 to 18 hours of a cargo routing.
- `+08:00` is the platform's own zone. On a row without a code, such as USPS's copies at Los
  Angeles, it is a label rather than an offset USPS stated, so the row keeps its wall clock, which
  the app reads in its place's zone. The platform keeps USPS's own offset on other tenants' copies,
  and the Los Angeles rows were copied in one batch after the delivery. USPS's other copies here
  state `America/New_York` whatever their place, and SpeedX's state their place's offset without a
  sign; neither reads as an offset, so those rows keep their wall clocks too.
- The tracker copies the delivering network's scans, some with the line's code `PU`; the English
  wording decides the stage.
- SpeedX's "Shipping Label Created", made while the parcel was still at the line's Shanghai
  warehouse, is a record rather than a scan and moves nothing.
- `channel_hawbcode` is the delivering network's number. SpeedX is named only when its rule claims
  the number whole; a reply without a number names no carrier.
- The merchant's reference, whoever signed and the proof of delivery are never read.

## Limitations

- No delivery estimate, weight or service name, and no instants for the delivering network's
  copies that state no signed offset.
- Waybills of other layouts the line may issue are refused until one is seen.

## Numbers

The samples come from a tracking directory's page for the line and from the tracking box of the
carrier's own site. No detection rule claims the layout.

## Links

`track.html` on www.wcxex.com, with the number in `c`, and `track_query.aspx` on the tracker's
host, with the number in `track_number`, read as WCXEX links. Both pages are plain HTTP, so no
portal link is published, and the canary checks 17TRACK instead.

## Testing

`WCXEX_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/wcxex`, with the number set outside
the repository. The unknown-number case asks the lookup for a string outside the line's layout, or
`WCXEX_UNKNOWN_NUMBER` when set, and checks that the reply reads as not found.
