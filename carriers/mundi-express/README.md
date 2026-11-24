# Mundi Express

Mundi Express parcels use enabled universal providers. There is no dedicated adapter.

Mundi Express is a Zaragoza courier for urban deliveries and dedicated direct runs, with its own
couriers. It belongs to the [GLS](../gls-es/README.md) network, and its national parcels are
tracked at GLS. Its IRIS tenant is named after the city.

## Numbers

No public page shows a Mundi Express number, so there is no rule.

## Why there is no adapter

The tracker is the company's tenant of the IRIS courier software on `zaragoza.factapp.es`. No public
number is known to check its replies against.

## Links

The company's site links the tracker over HTTP; the catalog uses its HTTPS address.
`/IRIS/Seguimiento?s=<number>` opens one shipment, so the catalog links each number there. Each IRIS
tenant keeps its own shipments, so links are read only on the company's tenant.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
