# Unipost-Express

Unipost-Express parcels use enabled universal providers. There is no dedicated adapter.

Unipost-Express, Unipost-Expres SRL of Chișinău, is a Moldovan private express postal operator: a
courier for documents and parcels in Chișinău and across Moldova, which sends international
documents and parcels through partner express services.

## Numbers

Its tracking form asks for the HAWB (waybill) number after a fixed `373` label, in up to 15
characters. No public page shows a whole number, so there is no rule.

## Why there is no adapter

The home page's form posts the number back to the page, which shows the waybill's delivery status.
With no public number to check its replies against, there is no adapter.

## Links

Its tracker takes numbers only through a form that posts them, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
