# Tiui

Tiui, run by Tiui Soluciones, S.A.P.I. de C.V. in Mexico City, delivers online shops' orders cash on
delivery with its own couriers in Mexican cities such as Mexico City, Guadalajara and Monterrey, and
offers fulfilment. Its site is tiui.mx.

## Retrieval

One GET of `https://tiuiamigo.tiui.mx/api/guia/<folio>`, the JSON service the tracking page asks,
without a session. It answers the guide with its folio, which must be the one asked, and its
movements, newest first: a status code, Tiui's wording and the instant written, in milliseconds
since 1970, which each scan keeps. An unknown folio gets a 404 whose body says the guide was not
found; another 404 is a moved route.

The reply also holds the sender, the recipient, the merchant, the comments and the delivery photos
with the courier and the place they were taken; the adapter reads none of them. Its estimated
delivery is the registration plus two days, which the tracking page does not show, so it is not
read.

## Numbers

The folio is three groups of up to four, three and six digits joined by hyphens, the first being the
merchant's. The tracker finds a folio only with its hyphens, and the groups' lengths vary, so the
digits alone do not give it back: `carrierTrackingNumber` keeps a Tiui folio's hyphens, for Tiui
alone, and the adapter refuses a folio without them. Without its hyphens a folio is a run of digits
that many carriers' rules read, so there is no detection rule: select Tiui or open its tracking link.

## Links

Tracking links carry the folio after `/rastreo/` in the tracker's address.

## Testing

`TIUI_TRACKING_NUMBER=… TIUI_UNKNOWN_NUMBER=… npm run test:carriers:live -- carriers/tiui`
