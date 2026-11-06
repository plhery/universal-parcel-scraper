# Moran Transportation

Moran Transportation parcels use enabled universal providers. There is no dedicated adapter.

Moran Transportation Corporation is a less-than-truckload carrier in Elk Grove Village, Illinois.
It runs next-day service across Illinois, Indiana, Minnesota and Wisconsin and cartage around
Chicago. Its site is moranltl.com.

## Numbers

The only public example is ten digits, from an aggregator. Ten-digit runs are other carriers'
numbers too, so there is no rule.

## Why there is no adapter

Its tracker is hosted by Carrier Logistics, whose open XML trace
[Dohrn Transfer](../dohrn-transfer/README.md)'s adapter reads.
Its site's form posts the number to the tracker's entry page.

## Links

The tracker's shipment page opens a PRO number from its `wpro1` parameter, and its entry page
from `pronum`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
