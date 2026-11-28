# Pickwings

Pickwings shipments use enabled universal providers. There is no dedicated adapter.

Pickwings, from Baar, books parcel, pallet and part-load transports with vetted Swiss transport partners under its
own shipment numbers.

## Numbers

The tracking form's placeholder is two, four, four and five digits joined by hyphens. No public page shows one of
its numbers, so there is no rule.

## Why there is no adapter

The tracker asks for the shipment number, the delivery postcode and a reCAPTCHA, then calls Pickwings' public
tracking API. With no public number to check the tracker's replies against, there is no adapter.

## Links

The lookup needs the delivery postcode and a reCAPTCHA, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
