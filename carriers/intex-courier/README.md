# Intex Courier

Intex Courier parcels use enabled universal providers. There is no dedicated adapter.

Intex Courier, INTEXCOURIER SHPK of Tirana, is an Albanian courier for letters and parcels across
Albania, with deliveries abroad. It is unrelated to
[INTEX Paketdienst](../intex-paketdienst/README.md) in Germany. Its tracker is a white-label
E-COURIER PRO portal, the platform [Tribex Courier](../tribex-courier/README.md) and
[Elite Post](../elite-post-al/README.md) use too.

## Numbers

Its tracker finds a parcel by its track code and takes several codes at once. No public page
shows a whole code or its layout, so there is no rule.

## Why there is no adapter

The portal's own form posts the codes with a session token and a Cloudflare Turnstile check; the
tracking page on intexcourier.al sends them by GET instead. With no public code to check its
replies against, there is no adapter.

## Links

`https://app.intexcourier.al/packages/getByTrackingCode?tracking_number_list={trackingNumber}`
is the address the tracking page on intexcourier.al sends a code to. A pasted link of that
address names Intex Courier.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
