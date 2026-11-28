# Upela

Upela shipments use enabled universal providers. There is no dedicated adapter.

Upela, from Neuilly-sur-Seine, is a shipping service for businesses and private senders: parcels, pallets and
couriers. It books shipments with partner carriers, and its tracker finds only shipments booked through it.

## Numbers

The tracker takes Upela's shipment reference or the partner carrier's number. No public page shows an Upela
reference, so there is no rule.

## Why there is no adapter

The tracker asks `POST https://app.upela.com/widget/tracking/<number>` and links to the partner carrier's own page.
With no public number to check the tracker's replies against, there is no adapter.

## Links

`upela.com/fr/suivi.html?tracking_number=<number>` opens one shipment; the page searches on load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
