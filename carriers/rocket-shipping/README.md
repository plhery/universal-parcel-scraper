# Rocket Shipping

Rocket Shipping parcels use enabled universal providers. There is no dedicated adapter.

Rocket Shipping is an American logistics company. It delivers big and bulky goods to homes with
two-person crews and books less-than-truckload freight with partner carriers. It gives each load
its own id and tracks it on its own page. Its site is rocketshipping.io.

## Numbers

Its load ids are digit runs, eight or nine digits long in public examples. Digit runs of these
lengths are other carriers' numbers too, and only an aggregator's examples show them, so there is
no rule.

## Why there is no adapter

Its tracking page is a script app that asks `tracking.rocketshipping.io/.netlify/functions/tracking`
for a load by its `loadId`. Its search also finds a load by purchase order, PRO or shipper
reference. A brokered load moves with a partner carrier, which differs from load to load.

## Links

`tracking.rocketshipping.io/track/<number>` opens one load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
