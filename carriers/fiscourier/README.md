# Fiscourier

Fiscourier parcels use enabled universal providers. There is no dedicated adapter.

Fiscourier is a Madrid courier with its own delivery fleet in the Comunidad de Madrid, and
storage and fulfilment. Its national deliveries go through the [TIPSA](../tipsa/README.md)
network.

## Numbers

No public page shows a Fiscourier number, so there is no rule.

## Why there is no adapter

The tracker is the company's tenant of the IRIS courier software on `fiscourier.factapp.es`. No
public number is known to check its replies against.

## Links

`/IRIS/Seguimiento?s=<number>` opens one shipment, so the catalog links each number there. Each IRIS
tenant keeps its own shipments, so links are read only on the company's tenant.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
