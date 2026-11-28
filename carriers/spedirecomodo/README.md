# SpedireComodo

SpedireComodo shipments use enabled universal providers. There is no dedicated adapter.

SpedireComodo, run by METAXY in Milan, is a shipping service for businesses and private senders. It books shipments with partner couriers, and its tracker finds a shipment by its own code or the courier's waybill.

## Numbers

Its search page describes its order number as seven digits and a letter. No public page shows one, so there is no
rule.

## Why there is no adapter

The search is a plain GET form. With no public number to check the tracker's replies against, there is no adapter.

## Links

`spedirecomodo.it/Tracking/Track?trackingNumber=<number>` opens one shipment; the search form writes that address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
