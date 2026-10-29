# XGS

XGS parcels use enabled universal providers. There is no dedicated adapter.

XGS (Xpress Global Systems) is a US less-than-truckload carrier specialised in flooring, based in
Chattanooga, Tennessee. Its site is xgsi.com.

## Numbers

Its probill numbers are seven or eight digits, lengths many carriers share, so there is no rule.

## Why there is no adapter

Its tracker reads an open JSON lookup that answers a probill, a bill of lading or a purchase
order, but it gives the current status only, with the signer's name and the delivery ZIP code,
which an adapter would have to leave out; no real public probill has been found.

## Links

The site opens a probill from `#track-shipment=` in its address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
