# Keke International

Tracks shipments of Keke International (科科国际物流, 浙江科科国际物流有限公司), a Yiwu
cross-border forwarder whose site is www.kkfba.com, on its line to Australia, where Team Global
Express delivers. Its tracker is its own tenant of the rtb56 platform at `ywkk.rtb56.com`, where
the site's login and registration links point. The request helpers are shared with
[YYPOST](../yypost/README.md).

## How it works

1. `direct`: one GET to `webservice/Service.ashx` on `ywkk.rtb56.com` (`method=track`, `param` the
   JSON of the query, `key` the Base64 of that text's MD5 in hexadecimal), which answers JSONP with
   one entry per parcel and its scans, newest first. An unknown number gets `success` 0 and "No
   query to track information", the only not-found.
2. `retry`: the same request once more after it fails to reach the tracker or hangs.

The webservice needs no slider, session, cookie or account, and answers plain HTTP only.

## Notes

- The lookup finds a parcel by the line's own waybill (`server_hawbcode`, KK and eight digits), by
  the merchant's reference (`shipper_hawbcode`) and by the delivering network's number
  (`channel_hawbcode`), all with the same entry. The adapter reads the entry whose waybill or
  delivering network's number is the whole number asked, never the reference. Asked by the
  delivering network's number, the result gives the line's waybill as its canonical number; asked
  by the waybill, it gives the delivering network's number.
- The public sample is Team Global Express's number, so the adapter accepts any number of eight to
  forty letters and digits, not only the line's layout.
- The request names no referring page: [JTHQ](../jthq/README.md)'s tenant of the platform answers
  `null` to a request that does. `null` reads as indeterminate.
- Scans keep the wall clock the tracker gives them. The line's own rows state `+08:00`; Team Global
  Express's copies state `+10:00`, its record placed in China too, so the offset follows the
  network's clock rather than the place, and no offset is trusted.
- Team Global Express's feed lists a category beside each scan at the same clock and place
  ("Delivered" beside "Successful delivery"); the category goes when its scan is there.
- Team Global Express's "Electronic billing transfer" and "Shipment created", made after the line's
  facility dispatched the parcel, are records rather than scans and move nothing.
- Team Global Express is named only when its own rule claims the number whole; it has none, so its
  number is kept without a carrier.
- The merchant's reference, whoever signed and the proof of delivery are never read.

## Limitations

- No delivery estimate, weight or service name, and no instants.

## Numbers

The sample comes from a tracking directory's Keke International page and is Team Global Express's
number, twelve digits, a shape many carriers share. No detection rule claims either number.

## Links

`track_query.aspx` on the tracker's host, with the number in `track_number`, reads as a Keke
International link. The page is plain HTTP, so no portal link is published, and the canary checks
17TRACK instead.

## Testing

`KEKE_INTERNATIONAL_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/keke-international`,
with the number set outside the repository. The unknown-number case asks the lookup for a string no
tenant holds, or `KEKE_INTERNATIONAL_UNKNOWN_NUMBER` when set, and checks that the reply reads as not
found.
