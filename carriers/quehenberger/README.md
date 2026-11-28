# Quehenberger Logistics

Quehenberger Logistics shipments use enabled universal providers. There is no dedicated adapter.

Quehenberger Logistics, from Straßwalchen near Salzburg and part of the Geis group, carries road freight and runs
warehouses in Austria and Central and Eastern Europe.

## Numbers

The tracker takes a shipment number, a barcode or a reference. No public page shows one, so there is no rule.

## Why there is no adapter

The site's "Sendungsverfolgung" box sends the number to the customer portal's lookup. With no public number to check the tracker's replies against, there is no adapter.

## Links

The box opens `ccp.quehenberger.com/dw/request/QTrack/getShipmentInformation?id=51&GENERIC=<number>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
