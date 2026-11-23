# Parts Express

Parts Express parcels use enabled universal providers. There is no dedicated adapter.

Parts Express is a carrier in Vianen for day, night and same-day distribution of parts, tyres and
fragile goods across the Benelux.

## Numbers

The tracker takes the barcode with the delivery postcode. No public page shows a barcode, so there
is no rule.

## Why there is no adapter

The tracker is an app at `tnt.partsexpress.nl` that opens a shipment at
`#/orderdetail/<barcode>/<postcode>` and reads it from `/api/order/`. No public barcode is known to
check its replies against.

## Links

A link needs the delivery postcode as well as the barcode, so the catalog sends people to the
home page, which asks for both.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
