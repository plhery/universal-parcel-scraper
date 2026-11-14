# Elit Post

Elit Post parcels use enabled universal providers. There is no dedicated adapter.

Elit Post carries parcels and cargo from Israel to Moldova, Romania, Ukraine, the rest of Europe
and the CIS, with couriers who collect across Israel and deliver to the door. Moldova's postal
register lists an ELIT POST SRL in Chișinău; the site names the brand alone.

## Numbers

Its tracking page takes the waybill number. No public page shows a whole number or its layout, so
there is no rule.

## Why there is no adapter

The tracking page asks the site's own service for the number and shows its status log, and a
notice when the shipment met an incident. With no public number to check its replies against,
there is no adapter.

## Leads

`https://elitpost.com/api/public/tracking/{number}` answers a GET with JSON: the number, its status
`logs`, the `system` that holds the shipment and any `incident`.

## Links

The tracking page reads numbers only from its form, so no address opens one shipment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
