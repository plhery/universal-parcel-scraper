# Veho

Veho parcels use enabled universal providers. There is no dedicated adapter.

Veho is a last-mile network in the United States that delivers e-commerce parcels for retailers
and shipping platforms. Its site is shipveho.com.

## Numbers

A Veho tracking id is `VH` and twelve letters or digits, as its API documentation and tracker
describe; `veho-1` suggests Veho for it. The tracker also takes the barcode on a sender's label
and finds the package's tracking id: one public barcode, `VEHO`, a three-letter facility code
and nine digits, gives `veho-2`. Both stay low, as no public page shows a VH tracking id. Older
tracking ids have six characters and no rule.

## Why there is no adapter

The guest page calls `getOrderByTrackingIdCWA` at
`https://esus.graph.shipveho.com/graphql`. Its authorization header carries a Firebase App Check
token obtained after an invisible reCAPTCHA Enterprise check. A rejected attestation prevents
the lookup; the page's fallback authorization marker is refused too. These authorization
failures do not establish that a parcel is missing.

An accepted guest query can return package history while denying recipient address and
consumer identity fields. Those field errors do not invalidate the returned package events;
errors on the tracking container or its required history fields must be checked separately.

The [official recipient Android app](https://play.google.com/store/apps/details?id=com.veho.consumermobile)
calls `getOrderByTrackingId` on the same service. Its guest request builder uses native Firebase
App Check with Play Integrity. Signed-in requests add a Firebase Auth token. The app therefore
also depends on accepted attestation for this guest route. Its signing certificate is published
by the official Firebase project in
[asset links](https://veho-consumer-mobile.web.app/.well-known/assetlinks.json).

## Links

The tracker opens one package from `#/trackingid/<id>`, `#/barcode/<barcode>` or
`?trackingId=<id>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
