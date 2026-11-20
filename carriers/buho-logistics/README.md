# Búho Logistics

Búho Logistics parcels use enabled universal providers. There is no dedicated adapter.

Búho Logistics is a Mexican fulfilment company for online shops and retailers. It keeps their
stock in its warehouses, ships orders the day they arrive through partner parcel carriers and
follows each shipment to delivery on its own tracker.

## Numbers

Its tracker follows the partner carrier's number, such as a Paquetexpress number. No number of
Búho's own is known, so there is no rule.

## Why there is no adapter

The tracker is a single-page app that posts `tracking_id` to
`api.tracking.buhologistics.com/tracking/orderstatus`. No public number is known to check its
replies against.

## Links

The tracker reads a number from its `id` parameter and searches on load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
