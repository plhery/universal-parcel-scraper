# BFT Logistik

BFT Logistik parcels use enabled universal providers. There is no dedicated adapter.

BFT Logistik is a Danish distribution company in Karlslunde for deliveries, warehousing, linehaul
and installation logistics.

## Numbers

The tracker asks for the shipment id. No public page shows one, so there is no rule.

## Why there is no adapter

The tracker is an app at `t.bftlogistik.dk` whose script reads a shipment from
`tntapi.bftlogistik.dk/api/v1/orders/anonymous/<id>`. No public shipment id is known to check its
replies against.

## Links

`t.bftlogistik.dk/#/t/<id>` opens one shipment.
Its home page is a sign-in form, so the catalog names no search page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
